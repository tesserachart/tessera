use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use rust_decimal::Decimal;
use tessera_broker::orders::OrdersService;
use tessera_broker::orders::io::AccountScopeInput;
use tessera_broker::{BrokerEvent, BrokerProvider, GuardedBroker};
use tessera_core::SystemClock;
use tessera_core::accounts::{Environment, TradingAccount, mask_account_number};
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::instrument::InstrumentId;
use tessera_core::money::{Price, Qty};
use tessera_core::orders::{Order, OrderRequest, OrderStatus, OrderType, Side, TimeInForce};
use tessera_core::time::Timestamp;
use tessera_market::MarketDataProvider;
use tessera_rithmic::firms::firm_of;
use tessera_rithmic::templates::PAPER_SYSTEMS;
use tessera_rithmic::{RithmicBroker, RithmicLogin, RithmicMarket, RithmicOptions};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Look,
    FarLimitAndCancel,
    RoundTrip,
}

struct Args {
    mode: Mode,
    enable: bool,
    account: Option<String>,
    symbol: String,
}

fn args() -> Result<Args, String> {
    let mut a = Args {
        mode: Mode::Look,
        enable: false,
        account: None,
        symbol: "MNQ".into(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mode = match arg.as_str() {
            "--far-limit-and-cancel" => Mode::FarLimitAndCancel,
            "--round-trip" => Mode::RoundTrip,
            "--enable-for-this-run" => {
                a.enable = true;
                continue;
            }
            "--account" => {
                a.account = Some(it.next().ok_or("--account needs a value")?);
                continue;
            }
            "--symbol" => {
                a.symbol = it.next().ok_or("--symbol needs a value")?;
                continue;
            }
            other => return Err(format!("unknown argument {other:?}")),
        };
        if a.mode != Mode::Look {
            return Err("give one mode at most".into());
        }
        a.mode = mode;
    }
    Ok(a)
}

fn tradeable(system: &str, a: &TradingAccount) -> bool {
    if firm_of(system).is_some() {
        a.environment == Environment::Eval
    } else {
        PAPER_SYSTEMS.contains(&system) && a.environment == Environment::Sim
    }
}

fn masked(a: &TradingAccount) -> String {
    mask_account_number(&a.display_name)
}

fn show_order(o: &Order) -> String {
    format!(
        "{} {:?} {} {} {:?} limit {:?} stop {:?} · {:?} · filled {} · {}{}",
        o.id,
        o.role,
        if o.request.side == Side::Buy {
            "BUY"
        } else {
            "SELL"
        },
        o.request.qty,
        o.request.order_type,
        o.request.limit_price.map(|p| p.0),
        o.request.stop_price.map(|p| p.0),
        o.status,
        o.filled_qty,
        o.broker_order_id.as_deref().unwrap_or("-"),
        o.reason
            .as_deref()
            .map(|r| format!(" · {r}"))
            .unwrap_or_default(),
    )
}

fn print_events(broker: &RithmicBroker) -> tokio::task::JoinHandle<()> {
    let mut events = broker.events();
    tokio::spawn(async move {
        while let Some(e) = events.next().await {
            let at = Timestamp::now().to_rfc3339();
            match e {
                BrokerEvent::Order(o) => println!("[{at}] order    {}", show_order(&o)),
                BrokerEvent::Fill(f) => println!(
                    "[{at}] fill     {} {:?} {} @ {} · order {:?}",
                    f.instrument,
                    f.side,
                    f.qty,
                    f.price.0,
                    f.order_id.as_ref().map(OrderId::as_str),
                ),
                BrokerEvent::Position(p) => println!(
                    "[{at}] position {} {} @ {} · open P&L {:?}",
                    p.instrument,
                    p.qty,
                    p.avg_price,
                    p.unrealized_pnl.map(|m| m.amount)
                ),
                BrokerEvent::Account(s) => println!(
                    "[{at}] account  net liq {} · day {} · open {}",
                    s.net_liq.amount, s.day_pnl.amount, s.open_pnl.amount
                ),
                BrokerEvent::Disconnected { reason } => println!("[{at}] disconnected: {reason}"),
            }
        }
    })
}

async fn wait_order(
    broker: &RithmicBroker,
    id: &OrderId,
    secs: u64,
    done: impl Fn(&Order) -> bool,
) -> Option<Order> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let now = broker.order_of(id);
        if now.as_ref().is_some_and(&done) || tokio::time::Instant::now() >= deadline {
            return now;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn last_price(market: &RithmicMarket, id: &InstrumentId) -> Option<Decimal> {
    let mut quotes = market.subscribe_quotes(std::slice::from_ref(id)).ok()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return None,
            q = quotes.next() => match q {
                Some(q) => if let Some(p) = q.last.or(q.bid) { return Some(p.0) },
                None => return None,
            },
        }
    }
}

fn request(
    account: &AccountId,
    instrument: &InstrumentId,
    side: Side,
    order_type: OrderType,
    limit: Option<Decimal>,
    tag: &str,
) -> OrderRequest {
    OrderRequest {
        account_id: account.clone(),
        instrument: instrument.clone(),
        side,
        qty: Qty::from(1),
        order_type,
        limit_price: limit.map(Price),
        stop_price: None,
        tif: TimeInForce::Day,
        bracket: None,
        client_order_id: Some(tag.to_owned()),
        reduce_only: false,
    }
}

async fn submit(
    guarded: &GuardedBroker<dyn BrokerProvider>,
    r: OrderRequest,
) -> Result<Order, Box<dyn std::error::Error>> {
    println!("sending: {}", r.restatement());
    match guarded.submit(r, None).await {
        Ok(o) => {
            println!("accepted: {}", show_order(&o));
            Ok(o)
        }
        Err(e) => {
            println!("NOT CONFIRMED OR REFUSED: {e}");
            println!("Nothing is sent again. Check the firm's platform for this order.");
            Err(e.into())
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = match args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();

    let login = RithmicLogin::from_default_file()?;
    let system = login.system_name.clone();
    if firm_of(&system).is_none() && !PAPER_SYSTEMS.contains(&system.as_str()) {
        eprintln!(
            "refused: {system:?} is not a prop firm's simulated system or a Rithmic paper system; \
             this development tool sends only to simulated accounts"
        );
        std::process::exit(3);
    }
    println!("mode {:?} on {system}", args.mode);
    if args.mode == Mode::Look {
        println!("no mode given: nothing will be placed");
    }

    let opts = RithmicOptions::for_system(&system);
    let market = RithmicMarket::connect(login, opts).await?;
    let broker = RithmicBroker::connect(&market).await?;
    let printer = print_events(&broker);
    let result = run(&args, &system, &market, &broker).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    println!("templates sent: {:?}", broker.template_counts());
    printer.abort();
    broker.shutdown().await;
    market.shutdown().await;
    result
}

async fn run(
    args: &Args,
    system: &str,
    market: &Arc<RithmicMarket>,
    broker: &RithmicBroker,
) -> Result<(), Box<dyn std::error::Error>> {
    let accounts = broker.accounts().await?;
    for a in &accounts {
        println!(
            "account {} · {:?} · id {}{}",
            masked(a),
            a.environment,
            a.id,
            if tradeable(system, a) {
                ""
            } else {
                " · never takes orders"
            }
        );
    }
    let candidates: Vec<&TradingAccount> = accounts
        .iter()
        .filter(|a| tradeable(system, a))
        .filter(|a| {
            args.account
                .as_deref()
                .is_none_or(|t| a.id.as_str() == t || a.display_name.ends_with(t))
        })
        .collect();
    let account = match candidates.as_slice() {
        [one] => (*one).clone(),
        [] => {
            println!("refused: no evaluation account matches; nothing is placed");
            std::process::exit(4);
        }
        _ => {
            println!("refused: more than one evaluation account; name one with --account");
            std::process::exit(4);
        }
    };
    println!(
        "account for this run: {} ({})",
        masked(&account),
        account.id
    );

    let id = market.resolve(&args.symbol).await?;
    let (_, spec) = market.spec(&id).await?;
    let tick = spec.tick_size.0;
    println!(
        "contract {id}: tick {tick} = {} {}",
        spec.tick_value.amount, spec.currency
    );

    let guarded: GuardedBroker<dyn BrokerProvider> =
        GuardedBroker::new(Arc::new(broker.clone()) as Arc<dyn BrokerProvider>);
    if args.enable {
        if PAPER_SYSTEMS.contains(&system) {
            broker.set_paper_routing(true);
        } else {
            broker.set_account_order_entry(&account.id, true)?;
            guarded.set_account_order_entry(broker.id(), &account.id, true);
        }
        println!("order entry ON for {} for this run", masked(&account));
    } else {
        println!(
            "order entry is OFF for {} (pass --enable-for-this-run to turn it on for this run)",
            masked(&account)
        );
    }

    let probe = request(
        &account.id,
        &id,
        Side::Buy,
        OrderType::Limit,
        Some(tick),
        "smoke-probe",
    );
    match guarded.route(&probe.account_id).await {
        Ok(_) => println!("send path: open for this account"),
        Err(e) => println!("send path: refused ({e})"),
    }

    match args.mode {
        Mode::Look => {
            println!(
                "--far-limit-and-cancel would buy 1 {id} limit at least 5% under the last price \
                 and cancel it at once; --round-trip would buy 1 at market and flatten"
            );
            Ok(())
        }
        Mode::FarLimitAndCancel => {
            let Some(last) = last_price(market, &id).await else {
                println!("no price for {id} within 15s: nothing is placed");
                return Ok(());
            };
            let price = (last * Decimal::new(95, 2) / tick).floor() * tick;
            println!("last {last}; limit {price} ({}% under)", {
                ((Decimal::ONE - price / last) * Decimal::ONE_HUNDRED).round_dp(2)
            });
            let tag = format!("smoke-far-{}", Timestamp::now().nanos());
            let o = submit(
                &guarded,
                request(
                    &account.id,
                    &id,
                    Side::Buy,
                    OrderType::Limit,
                    Some(price),
                    &tag,
                ),
            )
            .await?;
            let now = wait_order(broker, &o.id, 10, |x| {
                x.status == OrderStatus::Working || !x.status.is_open()
            })
            .await;
            println!(
                "before cancel: {}",
                now.as_ref().map_or("not seen".into(), show_order)
            );
            println!("cancelling {}", o.id);
            match guarded.cancel(&account.id, &o.id).await {
                Ok(c) => println!("cancel sent: {}", show_order(&c)),
                Err(e) => println!("CANCEL NOT CONFIRMED: {e}. Check the firm's platform."),
            }
            let end = wait_order(broker, &o.id, 15, |x| !x.status.is_open()).await;
            println!(
                "final: {}",
                end.as_ref().map_or("not seen".into(), show_order)
            );
            if end.is_none_or(|x| x.status.is_open()) {
                println!("THE ORDER MAY STILL BE WORKING: check the firm's platform.");
            }
            Ok(())
        }
        Mode::RoundTrip => {
            let tag = format!("smoke-rt-{}", Timestamp::now().nanos());
            let o = submit(
                &guarded,
                request(&account.id, &id, Side::Buy, OrderType::Market, None, &tag),
            )
            .await?;
            let filled = wait_order(broker, &o.id, 15, |x| !x.status.is_open()).await;
            println!(
                "entry: {}",
                filled.as_ref().map_or("not seen".into(), show_order)
            );
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while tokio::time::Instant::now() < deadline
                && !broker
                    .positions(&account.id)
                    .await?
                    .iter()
                    .any(|p| p.instrument == id && !p.qty.is_zero())
            {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            println!("flattening {id} through the orders service");
            let service = OrdersService::new(
                Arc::new(guarded),
                Arc::clone(market) as Arc<dyn MarketDataProvider>,
                Arc::new(SystemClock),
            );
            match service
                .flatten(&AccountScopeInput {
                    account_id: account.id.to_string(),
                    instrument: Some(id.to_string()),
                })
                .await
            {
                Ok(out) => println!(
                    "flatten: flat {} · {} cancelled · {} closing",
                    out.flat,
                    out.cancelled.len(),
                    out.closing.len()
                ),
                Err(e) => println!("FLATTEN FAILED: {e}. Check the firm's platform."),
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                let open: Vec<_> = broker
                    .positions(&account.id)
                    .await?
                    .into_iter()
                    .filter(|p| p.instrument == id && !p.qty.is_zero())
                    .collect();
                if open.is_empty() {
                    println!("flat on {id}");
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    println!(
                        "STILL OPEN: {} {id}. Check the firm's platform.",
                        open[0].qty
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Ok(())
        }
    }
}
