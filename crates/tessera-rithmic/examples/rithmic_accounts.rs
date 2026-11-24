use std::time::Duration;

use futures::StreamExt;
use tessera_broker::{BrokerEvent, BrokerProvider};
use tessera_core::accounts::mask_account_number;
use tessera_core::money::{Price, Qty};
use tessera_core::orders::{OrderRequest, OrderType, Side, TimeInForce};
use tessera_core::time::Timestamp;
use tessera_rithmic::{RithmicBroker, RithmicLogin, RithmicMarket, RithmicOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();

    let login = RithmicLogin::from_default_file()?;
    let opts = RithmicOptions::for_system(&login.system_name);
    println!("logging in to {} as app Tessera", login.system_name);
    let market = RithmicMarket::connect(login, opts).await?;
    let started = std::time::Instant::now();
    let broker = RithmicBroker::connect(&market).await?;
    println!(
        "broker {} on {} ({:?}) in {:.1}s, health {:?}, read-only {}",
        broker.id(),
        broker.system().name,
        broker.system().environment,
        started.elapsed().as_secs_f64(),
        broker.health().status,
        broker.capabilities().read_only,
    );

    let accounts = broker.accounts().await?;
    println!("{} account(s)", accounts.len());
    for a in &accounts {
        println!(
            "\n{} · {:?} · id {}",
            mask_account_number(&a.display_name),
            a.environment,
            a.id
        );
        match broker.summary(&a.id).await {
            Ok(s) => println!(
                "  balance {} · net liq {} · open {} · day {} (realized {}, fees {}) · buying power {}",
                s.balance.amount,
                s.net_liq.amount,
                s.open_pnl.amount,
                s.day_pnl.amount,
                s.realized_today.amount,
                s.fees_today.amount,
                s.buying_power.amount
            ),
            Err(e) => println!("  summary: {e}"),
        }
        match broker.risk(&a.id).await? {
            Some(r) => println!(
                "  risk: drawdown threshold {:?} · room {:?} · high-water {:?} · daily limit {:?} · left {:?} · locked {}",
                r.trailing_threshold.map(|m| m.amount),
                r.trailing_room.map(|m| m.amount),
                r.high_water_mark.map(|m| m.amount),
                r.daily_loss_limit.map(|m| m.amount),
                r.daily_loss_remaining.map(|m| m.amount),
                r.locked
            ),
            None => println!("  risk: none enforced"),
        }
        if let Some(rms) = broker.rms(&a.id) {
            println!(
                "  RMS: status {:?} · {:?} · {:?} · threshold {:?} · max-min balance {:?} · min balance {:?} · loss limit {:?} · buy/sell limit {:?}/{:?} · max order {:?}",
                rms.status,
                rms.algorithm,
                rms.auto_liquidate_criteria,
                rms.auto_liquidate_threshold,
                rms.auto_liquidate_max_min_account_balance,
                rms.min_account_balance,
                rms.loss_limit,
                rms.buy_limit,
                rms.sell_limit,
                rms.max_order_quantity
            );
        }
        let positions = broker.positions(&a.id).await?;
        let orders = broker.orders(&a.id).await?;
        let day_ago = Timestamp(Timestamp::now().nanos() - 86_400 * 1_000_000_000);
        let fills = broker.fills(&a.id, day_ago).await?;
        println!(
            "  {} open position(s) · {} order(s) · {} fill(s) in the last 24h",
            positions.len(),
            orders.len(),
            fills.len()
        );
        for p in &positions {
            println!(
                "    {} {} @ {} · open P&L {:?}",
                p.instrument,
                p.qty,
                p.avg_price,
                p.unrealized_pnl.map(|m| m.amount)
            );
        }

        let probe = OrderRequest {
            account_id: a.id.clone(),
            instrument: tessera_core::instrument::InstrumentId::from_parts(
                "MESZ6",
                Some("CME-RITHMIC"),
            ),
            side: Side::Buy,
            qty: Qty::from(1),
            order_type: OrderType::Limit,
            limit_price: Price::from_f64(1.0),
            stop_price: None,
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only: false,
        };
        let preview = broker.preview(&probe).await?;
        for c in &preview.checks {
            println!(
                "  preview check {} ({:?}): {}",
                c.code, c.severity, c.message
            );
        }
    }

    println!("\nwatching account updates for {seconds}s");
    let mut events = broker.events();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    let (mut acct, mut pos, mut ord, mut fil) = (0, 0, 0, 0);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            Some(e) = events.next() => match e {
                BrokerEvent::Account(_) => acct += 1,
                BrokerEvent::Position(_) => pos += 1,
                BrokerEvent::Order(_) => ord += 1,
                BrokerEvent::Fill(_) => fil += 1,
                BrokerEvent::Disconnected { reason } => println!("disconnected: {reason}"),
            },
        }
    }
    println!("{acct} account, {pos} position, {ord} order and {fil} fill update(s)");
    println!("templates sent: {:?}", broker.template_counts());

    broker.shutdown().await;
    market.shutdown().await;
    Ok(())
}
