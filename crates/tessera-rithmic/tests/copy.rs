use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rithmic_rs::prost::Message as _;
use rithmic_rs::rti::{
    AccountPnLPositionUpdate, ExchangeOrderNotification, InstrumentPnLPositionUpdate, RequestLogin,
    RequestNewOrder, RequestReferenceData, ResponseAccountList, ResponseAccountRmsInfo,
    ResponseAccountRmsUpdates, ResponseHeartbeat, ResponseLogin, ResponseLoginInfo, ResponseLogout,
    ResponseNewOrder, ResponsePnLPositionSnapshot, ResponsePnLPositionUpdates,
    ResponseReferenceData, ResponseReplayExecutions, ResponseShowFillHistory,
    ResponseShowOrderHistory, ResponseShowOrders, ResponseSubscribeForOrderUpdates,
    ResponseSubscribeToBracketUpdates, ResponseTradeRoutes, RithmicOrderNotification,
};
use rust_decimal::Decimal;
use tessera_broker::copy::io::{
    CopyCreateInput, CopyResyncInput, CopyStatusInput, CopyUpdateInput,
};
use tessera_broker::copy::{CopyFollower, CopyOutcome, SyncState};
use tessera_broker::orders::OrdersService;
use tessera_broker::orders::io::{LockAccountInput, OrderInput};
use tessera_broker::{BrokerProvider, BrokerRouter, GuardedBroker};
use tessera_core::clock::SystemClock;
use tessera_core::ids::AccountId;
use tessera_core::limits::LockSpan;
use tessera_core::money::Qty;
use tessera_core::orders::{OrderType, Side};
use tessera_core::settle::{settle, settle_async};
use tessera_core::{Origin, SharedClock, Timestamp};
use tessera_market::{MarketDataProvider, MarketRouter};
use tessera_rithmic::{RithmicBroker, RithmicLogin, RithmicMarket, RithmicOptions, symbols};
use tessera_tools::ToolCtx;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const FCM: &str = "TestFcm";
const IB: &str = "TestIb";

fn frame(m: &impl rithmic_rs::prost::Message) -> Message {
    let body = m.encode_to_vec();
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    Message::Binary(out.into())
}

/// rithmic-rs message structs are `#[non_exhaustive]`, so tests build them from `Default`.
macro_rules! msg {
    ($ty:ident { $($field:ident: $value:expr),* $(,)? }) => {{
        let mut m = $ty::default();
        $(m.$field = $value;)*
        m
    }};
}

fn ok() -> Vec<String> {
    vec!["0".into()]
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Took {
    account: String,
    side: i32,
    qty: i32,
}

type Waiting = (String, String, RequestNewOrder);

#[derive(Clone)]
struct Gateway {
    url: String,
    accounts: Arc<Vec<&'static str>>,
    took: Arc<Mutex<Vec<Took>>>,
    baskets: Arc<AtomicU32>,
    pnl: tokio::sync::broadcast::Sender<Message>,
    fills: tokio::sync::broadcast::Sender<Message>,
    net: Arc<Mutex<std::collections::HashMap<String, i32>>>,
    held: Arc<Mutex<Option<Vec<Waiting>>>>,
    slow: Arc<Mutex<Option<String>>>,
}

impl Gateway {
    async fn start(accounts: Vec<&'static str>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gw = Self {
            url: format!("ws://{}", listener.local_addr().unwrap()),
            accounts: Arc::new(accounts),
            took: Arc::default(),
            baskets: Arc::default(),
            pnl: tokio::sync::broadcast::channel(64).0,
            fills: tokio::sync::broadcast::channel(64).0,
            net: Arc::default(),
            held: Arc::default(),
            slow: Arc::default(),
        };
        let me = gw.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let me = me.clone();
                tokio::spawn(async move { me.serve(tcp).await });
            }
        });
        gw
    }

    fn took(&self) -> Vec<Took> {
        self.took.lock().clone()
    }

    fn took_by(&self, account: &str) -> usize {
        self.took().iter().filter(|t| t.account == account).count()
    }

    fn hold_fills_of(&self, account: &str) {
        *self.held.lock() = Some(Vec::new());
        *self.slow.lock() = Some(account.to_owned());
    }

    fn release(&self) {
        let waiting = self.held.lock().take().unwrap_or_default();
        *self.slow.lock() = None;
        for (account, basket, r) in waiting {
            let (frames, pnl) = self.filled(&account, &basket, &r);
            for f in frames {
                let _ = self.fills.send(f);
            }
            let _ = self.pnl.send(pnl);
        }
    }

    fn filled(&self, account: &str, basket: &str, r: &RequestNewOrder) -> (Vec<Message>, Message) {
        let side = r.transaction_type.unwrap_or(1);
        let qty = r.quantity.unwrap_or(0);
        let fill = frame(&msg!(ExchangeOrderNotification {
            template_id: 352,
            notify_type: Some(5),
            fcm_id: Some(FCM.into()),
            ib_id: Some(IB.into()),
            account_id: Some(account.to_owned()),
            basket_id: Some(basket.to_owned()),
            fill_id: Some(format!("F-{basket}")),
            symbol: r.symbol.clone(),
            exchange: Some("CME".into()),
            transaction_type: Some(side),
            fill_price: Some(20_000.0),
            fill_size: Some(qty),
            source_ssboe: Some(1_791_390_000),
        }));
        let mut done = self.notification(account, basket, r);
        done.status = Some("complete".into());
        done.completion_reason = Some("Fill".into());
        done.total_fill_size = Some(qty);
        done.total_unfilled_size = Some(0);
        done.avg_fill_price = Some(20_000.0);
        let net = {
            let mut n = self.net.lock();
            let e = n.entry(account.to_owned()).or_default();
            *e += if side == 1 { qty } else { -qty };
            *e
        };
        let pnl = frame(&msg!(InstrumentPnLPositionUpdate {
            template_id: 450,
            fcm_id: Some(FCM.into()),
            ib_id: Some(IB.into()),
            account_id: Some(account.to_owned()),
            symbol: r.symbol.clone(),
            exchange: Some("CME".into()),
            net_quantity: Some(net),
            avg_open_fill_price: Some(20_000.0),
            ssboe: Some(1_791_390_000),
        }));
        (vec![fill, frame(&done)], pnl)
    }

    fn notification(
        &self,
        account: &str,
        basket: &str,
        r: &RequestNewOrder,
    ) -> RithmicOrderNotification {
        msg!(RithmicOrderNotification {
            template_id: 351,
            fcm_id: Some(FCM.into()),
            ib_id: Some(IB.into()),
            account_id: Some(account.into()),
            basket_id: Some(basket.into()),
            user_tag: r.user_tag.clone(),
            symbol: r.symbol.clone(),
            exchange: Some("CME".into()),
            quantity: r.quantity,
            price: r.price,
            trigger_price: r.trigger_price,
            price_type: r.price_type,
            transaction_type: r.transaction_type,
            duration: Some(1),
            status: Some("open".into()),
        })
    }

    async fn serve(&self, tcp: tokio::net::TcpStream) {
        let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
            return;
        };
        let mut pushes = self.pnl.subscribe();
        let mut pnl = false;
        let mut fills = self.fills.subscribe();
        let mut orders = false;
        loop {
            let m = tokio::select! {
                m = ws.next() => m,
                p = pushes.recv(), if pnl => {
                    if let Ok(p) = p
                        && ws.send(p).await.is_err()
                    {
                        return;
                    }
                    continue;
                }
                f = fills.recv(), if orders => {
                    if let Ok(f) = f
                        && ws.send(f).await.is_err()
                    {
                        return;
                    }
                    continue;
                }
            };
            let Some(Ok(m)) = m else { return };
            let Message::Binary(bytes) = m else { continue };
            let body = &bytes[4..];
            let Ok(head) = RequestLogin::decode(body) else {
                continue;
            };
            let um = head.user_msg.clone();
            let mut out: Vec<Message> = Vec::new();
            match head.template_id {
                10 => out.push(frame(&msg!(ResponseLogin {
                    template_id: 11,
                    user_msg: um,
                    rp_code: ok(),
                    heartbeat_interval: Some(60.0),
                    unique_user_id: Some("u".into()),
                }))),
                12 => out.push(frame(&msg!(ResponseLogout {
                    template_id: 13,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                18 => out.push(frame(&msg!(ResponseHeartbeat {
                    template_id: 19,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                14 if RequestReferenceData::decode(body)
                    .is_ok_and(|r| r.symbol.as_deref() != Some("MNQZ6")) =>
                {
                    out.push(frame(&msg!(ResponseReferenceData {
                        template_id: 15,
                        user_msg: um,
                        rp_code: vec!["7".into(), "no data".into()],
                    })));
                }
                14 => out.push(frame(&msg!(ResponseReferenceData {
                    template_id: 15,
                    user_msg: um,
                    rp_code: ok(),
                    symbol: Some("MNQZ6".into()),
                    exchange: Some("CME".into()),
                    product_code: Some("MNQ".into()),
                    min_qprice_change: Some(0.25),
                    single_point_value: Some(2.0),
                }))),
                300 => out.push(frame(&msg!(ResponseLoginInfo {
                    template_id: 301,
                    user_msg: um,
                    rp_code: ok(),
                    fcm_id: Some(FCM.into()),
                    ib_id: Some(IB.into()),
                    user_type: Some(3),
                }))),
                310 => {
                    out.push(frame(&msg!(ResponseTradeRoutes {
                        template_id: 311,
                        user_msg: um.clone(),
                        rq_handler_rp_code: ok(),
                        fcm_id: Some(FCM.into()),
                        ib_id: Some(IB.into()),
                        exchange: Some("CME".into()),
                        trade_route: Some("simulator".into()),
                        status: Some("UP".into()),
                        is_default: Some(true),
                    })));
                    out.push(frame(&msg!(ResponseTradeRoutes {
                        template_id: 311,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                }
                302 => {
                    for a in self.accounts.iter() {
                        out.push(frame(&msg!(ResponseAccountList {
                            template_id: 303,
                            user_msg: um.clone(),
                            rq_handler_rp_code: ok(),
                            fcm_id: Some(FCM.into()),
                            ib_id: Some(IB.into()),
                            account_id: Some((*a).into()),
                            account_name: Some(format!("{a} (Sample)")),
                            account_currency: Some("USD".into()),
                        })));
                    }
                    out.push(frame(&msg!(ResponseAccountList {
                        template_id: 303,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                }
                304 => {
                    for a in self.accounts.iter() {
                        out.push(frame(&msg!(ResponseAccountRmsInfo {
                            template_id: 305,
                            user_msg: um.clone(),
                            rq_handler_rp_code: ok(),
                            account_id: Some((*a).into()),
                            status: Some("active".into()),
                            max_order_quantity: Some(10),
                        })));
                    }
                    out.push(frame(&msg!(ResponseAccountRmsInfo {
                        template_id: 305,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                }
                3508 => out.push(frame(&msg!(ResponseAccountRmsUpdates {
                    template_id: 3509,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                308 => {
                    orders = true;
                    out.push(frame(&msg!(ResponseSubscribeForOrderUpdates {
                        template_id: 309,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                }
                336 => out.push(frame(&msg!(ResponseSubscribeToBracketUpdates {
                    template_id: 337,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                320 => out.push(frame(&msg!(ResponseShowOrders {
                    template_id: 321,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                322 => out.push(frame(&msg!(ResponseShowOrderHistory {
                    template_id: 323,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                3512 => out.push(frame(&msg!(ResponseShowFillHistory {
                    template_id: 3513,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                3506 => out.push(frame(&msg!(ResponseReplayExecutions {
                    template_id: 3507,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                402 => {
                    out.push(frame(&msg!(ResponsePnLPositionSnapshot {
                        template_id: 403,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                    for a in self.accounts.iter() {
                        out.push(frame(&msg!(AccountPnLPositionUpdate {
                            template_id: 451,
                            is_snapshot: Some(true),
                            fcm_id: Some(FCM.into()),
                            ib_id: Some(IB.into()),
                            account_id: Some((*a).into()),
                            account_balance: Some("25000.00".into()),
                            cash_on_hand: Some("25000.00".into()),
                            open_position_pnl: Some("0.00".into()),
                            day_pnl: Some("0.00".into()),
                        })));
                    }
                }
                400 => {
                    pnl = true;
                    out.push(frame(&msg!(ResponsePnLPositionUpdates {
                        template_id: 401,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                }
                312 => {
                    let r = RequestNewOrder::decode(body).unwrap();
                    let account = r.account_id.clone().unwrap_or_default();
                    let side = r.transaction_type.unwrap_or(1);
                    let qty = r.quantity.unwrap_or(0);
                    self.took.lock().push(Took {
                        account: account.clone(),
                        side,
                        qty,
                    });
                    let slow = self.slow.lock().as_deref() == Some(account.as_str());
                    if slow {
                        tokio::time::sleep(Duration::from_millis(600)).await;
                    }
                    if !self.accounts.contains(&account.as_str()) {
                        out.push(frame(&msg!(ResponseNewOrder {
                            template_id: 313,
                            user_msg: um,
                            rp_code: vec!["3".into(), "unknown account".into()],
                        })));
                    } else {
                        let basket =
                            format!("B{}", self.baskets.fetch_add(1, Ordering::SeqCst) + 1);
                        out.push(frame(&msg!(ResponseNewOrder {
                            template_id: 313,
                            user_msg: um.clone(),
                            rq_handler_rp_code: ok(),
                            user_tag: r.user_tag.clone(),
                            basket_id: Some(basket.clone()),
                        })));
                        out.push(frame(&msg!(ResponseNewOrder {
                            template_id: 313,
                            user_msg: um,
                            rp_code: ok(),
                        })));
                        let open = self.notification(&account, &basket, &r);
                        out.push(frame(&open));
                        if r.price_type == Some(2) {
                            let held = slow && self.held.lock().is_some();
                            if held {
                                if let Some(waiting) = self.held.lock().as_mut() {
                                    waiting.push((account, basket, r));
                                }
                            } else {
                                let (frames, pnl) = self.filled(&account, &basket, &r);
                                out.extend(frames);
                                let _ = self.pnl.send(pnl);
                            }
                        }
                    }
                }
                _ => continue,
            }
            for m in out {
                if ws.send(m).await.is_err() {
                    return;
                }
            }
        }
    }
}

async fn login(gw: &Gateway, id: &str) -> (Arc<RithmicMarket>, RithmicBroker) {
    let login = RithmicLogin {
        user: format!("nobody-{id}"),
        password: "unused".into(),
        system_name: "Apex".into(),
        gateway_url: gw.url.clone(),
    };
    let mut opts = RithmicOptions::for_system("Apex");
    opts.provider_id = id.into();
    opts.display_name = format!("Apex · Rithmic ({id})");
    opts.connect_timeout = Duration::from_secs(5);
    opts.request_timeout = Duration::from_secs(2);
    let market = RithmicMarket::new(login, opts).unwrap();
    market.reconnect().await.unwrap();
    let broker = RithmicBroker::connect(&market).await.unwrap();
    (market, broker)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_order_on_the_leader_sends_one_order_per_follower_through_its_own_login() {
    let first = Gateway::start(vec!["TEST-000001-01", "TEST-000001-02"]).await;
    let second = Gateway::start(vec!["TEST-000002-01", "TEST-000002-02"]).await;
    let (market_a, broker_a) = login(&first, "rithmic-apex-a").await;
    let (market_b, broker_b) = login(&second, "rithmic-apex-b").await;
    let markets = MarketRouter::new();
    markets
        .add(Arc::clone(&market_a) as Arc<dyn MarketDataProvider>)
        .unwrap();
    markets
        .add(Arc::clone(&market_b) as Arc<dyn MarketDataProvider>)
        .unwrap();
    let brokers = BrokerRouter::new();
    brokers
        .add(Arc::new(broker_a.clone()) as Arc<dyn BrokerProvider>)
        .unwrap();
    brokers
        .add(Arc::new(broker_b.clone()) as Arc<dyn BrokerProvider>)
        .unwrap();
    let guarded = Arc::new(GuardedBroker::new(
        Arc::clone(&brokers) as Arc<dyn BrokerProvider>
    ));
    let service = Arc::new(OrdersService::new(
        Arc::clone(&guarded),
        Arc::clone(&markets) as Arc<dyn MarketDataProvider>,
        Arc::new(SystemClock) as SharedClock,
    ));
    let ids = |b: &RithmicBroker| {
        futures::FutureExt::now_or_never(b.accounts())
            .and_then(Result::ok)
            .unwrap_or_default()
            .into_iter()
            .map(|a| a.id)
            .collect::<Vec<AccountId>>()
    };
    let (a, b) = (ids(&broker_a), ids(&broker_b));
    assert_eq!((a.len(), b.len()), (2, 2));
    let (leader, beside, elsewhere, off) = (&a[0], &a[1], &b[0], &b[1]);
    for (broker, account) in [
        (&broker_a, leader),
        (&broker_a, beside),
        (&broker_b, elsewhere),
    ] {
        broker.set_account_order_entry(account, true).unwrap();
        guarded.set_account_order_entry(broker.id(), account, true);
    }
    let create = |followers: Vec<CopyFollower>| CopyCreateInput {
        name: Some("Evals".into()),
        leader_id: leader.to_string(),
        followers,
        enabled: Some(true),
    };
    let ctx = ToolCtx::new(Origin::User, Timestamp(0));
    let e = service
        .copy_create(&ctx, &create(vec![CopyFollower::new(off.as_str())]))
        .await
        .unwrap_err();
    assert!(e.message.contains("cannot follow"), "{}", e.message);
    service
        .copy_create(
            &ctx,
            &create(vec![
                CopyFollower::new(beside.as_str()),
                CopyFollower::new(elsewhere.as_str()).times(2.into()),
            ]),
        )
        .await
        .unwrap();
    let out = service
        .submit_copying(
            &ctx,
            "orders.submit",
            &OrderInput {
                account_id: leader.to_string(),
                instrument: symbols::instrument_id("MNQZ6", "CME").to_string(),
                side: Side::Buy,
                qty: Qty::from(1),
                order_type: OrderType::Market,
                limit_price: None,
                stop_price: None,
                tif: None,
                bracket: None,
                reduce_only: None,
                client_order_id: None,
            },
            None,
            None,
        )
        .await
        .unwrap();
    let copies = out.copies.expect("copied");
    assert_eq!(copies.copied(), 2, "{copies:?}");
    let (mut on_first, on_second) = settle(
        "the leader's order and both copies at Rithmic",
        || (first.took(), second.took()),
        |(a, b)| a.len() >= 2 && !b.is_empty(),
    )
    .await;
    on_first.sort_by(|x, y| x.account.cmp(&y.account));
    assert_eq!(
        on_first,
        vec![
            Took {
                account: "TEST-000001-01".into(),
                side: 1,
                qty: 1
            },
            Took {
                account: "TEST-000001-02".into(),
                side: 1,
                qty: 1
            },
        ]
    );
    assert_eq!(
        on_second,
        vec![Took {
            account: "TEST-000002-01".into(),
            side: 1,
            qty: 2
        }]
    );
    broker_a.shutdown().await;
    broker_b.shutdown().await;
    market_a.shutdown().await;
    market_b.shutdown().await;
}

async fn net_of(broker: &RithmicBroker, account: &AccountId) -> Decimal {
    broker
        .positions(account)
        .await
        .unwrap_or_default()
        .iter()
        .map(|p| p.qty.0)
        .sum()
}

async fn holds(broker: &RithmicBroker, account: &AccountId, want: i64) {
    settle_async(
        &format!("{account} holding {want}"),
        || net_of(broker, account),
        |net| *net == Decimal::from(want),
    )
    .await;
}

async fn becomes(service: &OrdersService, follower: &AccountId, want: SyncState) {
    settle_async(
        &format!("{follower} {want:?}"),
        || async {
            service
                .copy_status(&CopyStatusInput::default())
                .await
                .unwrap()
                .groups
                .iter()
                .flat_map(|g| &g.followers)
                .find(|f| &f.account_id == follower)
                .map(|f| f.state)
        },
        |state| *state == Some(want),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resync_sends_nothing_while_an_order_to_the_contract_has_not_filled() {
    let gw = Gateway::start(vec!["TEST-000003-01", "TEST-000003-02"]).await;
    let (market, broker) = login(&gw, "rithmic-apex-c").await;
    let markets = MarketRouter::new();
    markets
        .add(Arc::clone(&market) as Arc<dyn MarketDataProvider>)
        .unwrap();
    let brokers = BrokerRouter::new();
    brokers
        .add(Arc::new(broker.clone()) as Arc<dyn BrokerProvider>)
        .unwrap();
    let guarded = Arc::new(GuardedBroker::new(
        Arc::clone(&brokers) as Arc<dyn BrokerProvider>
    ));
    let service = Arc::new(OrdersService::new(
        Arc::clone(&guarded),
        Arc::clone(&markets) as Arc<dyn MarketDataProvider>,
        Arc::new(SystemClock) as SharedClock,
    ));
    let accounts = broker.accounts().await.unwrap();
    let named = |raw: &str| {
        accounts
            .iter()
            .find(|a| a.display_name.starts_with(raw))
            .map(|a| a.id.clone())
            .unwrap_or_else(|| panic!("no {raw} in {accounts:?}"))
    };
    let f = "TEST-000003-02";
    let (leader, follower) = (&named("TEST-000003-01"), &named(f));
    for account in [leader, follower] {
        broker.set_account_order_entry(account, true).unwrap();
        guarded.set_account_order_entry(broker.id(), account, true);
    }
    let ctx = ToolCtx::new(Origin::User, Timestamp(0));
    let id = service
        .copy_create(
            &ctx,
            &CopyCreateInput {
                name: Some("Evals".into()),
                leader_id: leader.to_string(),
                followers: vec![CopyFollower::new(follower.as_str()).paused()],
                enabled: Some(true),
            },
        )
        .await
        .unwrap()
        .group
        .id;
    let followers = |paused: bool| CopyUpdateInput {
        group_id: id.clone(),
        name: None,
        leader_id: None,
        followers: Some(vec![if paused {
            CopyFollower::new(follower.as_str()).paused()
        } else {
            CopyFollower::new(follower.as_str())
        }]),
    };
    let buy = |qty: i64| OrderInput {
        account_id: leader.to_string(),
        instrument: symbols::instrument_id("MNQZ6", "CME").to_string(),
        side: Side::Buy,
        qty: Qty::from(qty),
        order_type: OrderType::Market,
        limit_price: None,
        stop_price: None,
        tif: None,
        bracket: None,
        reduce_only: None,
        client_order_id: None,
    };
    let resync = CopyResyncInput {
        group_id: id.clone(),
        account_id: None,
    };

    service
        .submit_copying(&ctx, "orders.submit", &buy(1), None, None)
        .await
        .unwrap();
    holds(&broker, leader, 1).await;
    service.copy_update(&ctx, &followers(false)).await.unwrap();
    becomes(&service, follower, SyncState::OutOfSync).await;
    gw.hold_fills_of(f);
    let (a, b) = tokio::join!(
        service.copy_resync(&ctx, &resync),
        service.copy_resync(&ctx, &resync)
    );
    let mut outcomes: Vec<CopyOutcome> = [a.unwrap(), b.unwrap()]
        .iter()
        .flat_map(|o| o.report.results.iter().map(|r| r.outcome))
        .collect();
    outcomes.sort_by_key(|o| format!("{o:?}"));
    assert_eq!(outcomes, [CopyOutcome::Copied, CopyOutcome::Nothing]);
    assert_eq!(
        gw.took_by(f),
        1,
        "two resyncs at once send once: {:?}",
        gw.took()
    );
    let again = service.copy_resync(&ctx, &resync).await.unwrap();
    assert_eq!(
        again.report.results[0].text,
        "an order is on its way there; resync once it fills"
    );
    assert_eq!(gw.took_by(f), 1, "{:?}", gw.took());
    gw.release();
    holds(&broker, follower, 1).await;

    service.copy_update(&ctx, &followers(true)).await.unwrap();
    service
        .submit_copying(&ctx, "orders.submit", &buy(1), None, None)
        .await
        .unwrap();
    holds(&broker, leader, 2).await;
    assert_eq!(
        net_of(&broker, follower).await,
        Decimal::from(1),
        "at its size, not double: the leader's later position came after every report on it"
    );
    assert_eq!(gw.took_by(f), 1, "{:?}", gw.took());
    service.copy_update(&ctx, &followers(false)).await.unwrap();
    becomes(&service, follower, SyncState::OutOfSync).await;
    gw.hold_fills_of(f);
    let racing = async {
        settle(
            "the add's copy on its way to the follower",
            || gw.took_by(f),
            |n| *n == 2,
        )
        .await;
        service.copy_resync(&ctx, &resync).await
    };
    let add = buy(1);
    let (added, resynced) = tokio::join!(
        service.submit_copying(&ctx, "orders.submit", &add, None, None),
        racing
    );
    assert_eq!(added.unwrap().copies.unwrap().copied(), 1);
    let resynced = resynced.unwrap();
    assert_eq!(
        resynced.report.results[0].text, "an order is on its way there; resync once it fills",
        "{resynced:?}"
    );
    assert_eq!(gw.took_by(f), 2, "{:?}", gw.took());
    gw.release();
    holds(&broker, follower, 2).await;
    let last = service.copy_resync(&ctx, &resync).await.unwrap();
    assert_eq!(
        last.report.results[0].outcome,
        CopyOutcome::Copied,
        "{last:?}"
    );
    holds(&broker, follower, 3).await;
    assert_eq!(
        gw.took_by(f),
        3,
        "no order left to take it over: {:?}",
        gw.took()
    );
    assert_eq!(
        net_of(&broker, follower).await,
        net_of(&broker, leader).await,
        "at its size, not over it"
    );
    broker.shutdown().await;
    market.shutdown().await;
}

fn market_order(account: &AccountId, side: Side, qty: i64) -> OrderInput {
    OrderInput {
        account_id: account.to_string(),
        instrument: symbols::instrument_id("MNQZ6", "CME").to_string(),
        side,
        qty: Qty::from(qty),
        order_type: OrderType::Market,
        limit_price: None,
        stop_price: None,
        tif: None,
        bracket: None,
        reduce_only: None,
        client_order_id: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_locked_follower_is_skipped_and_a_locked_leader_copies_only_its_exits() {
    let gw = Gateway::start(vec!["TEST-000003-01", "TEST-000003-02", "TEST-000003-03"]).await;
    let (market, broker) = login(&gw, "rithmic-apex-c").await;
    let markets = MarketRouter::new();
    markets
        .add(Arc::clone(&market) as Arc<dyn MarketDataProvider>)
        .unwrap();
    let brokers = BrokerRouter::new();
    brokers
        .add(Arc::new(broker.clone()) as Arc<dyn BrokerProvider>)
        .unwrap();
    let guarded = Arc::new(GuardedBroker::new(
        Arc::clone(&brokers) as Arc<dyn BrokerProvider>
    ));
    let service = Arc::new(OrdersService::new(
        Arc::clone(&guarded),
        Arc::clone(&markets) as Arc<dyn MarketDataProvider>,
        Arc::new(SystemClock) as SharedClock,
    ));
    let ids: Vec<AccountId> = broker
        .accounts()
        .await
        .unwrap()
        .into_iter()
        .map(|a| a.id)
        .collect();
    let (leader, locked, open) = (&ids[0], &ids[1], &ids[2]);
    for account in &ids {
        broker.set_account_order_entry(account, true).unwrap();
        guarded.set_account_order_entry(broker.id(), account, true);
    }
    let ctx = ToolCtx::new(Origin::User, Timestamp(0));
    service
        .copy_create(
            &ctx,
            &CopyCreateInput {
                name: Some("Evals".into()),
                leader_id: leader.to_string(),
                followers: vec![
                    CopyFollower::new(locked.as_str()),
                    CopyFollower::new(open.as_str()),
                ],
                enabled: Some(true),
            },
        )
        .await
        .unwrap();
    let lock = |account: &AccountId| LockAccountInput {
        account_id: account.to_string(),
        span: LockSpan::Minutes { minutes: 30 },
        instrument: None,
    };
    let out = service.lock_account(&ctx, &lock(locked)).await.unwrap();
    assert_eq!(
        out.copy.as_deref(),
        Some(
            "It follows in Evals: while it is locked the leader's entries skip it, and each skip \
             says so. Exits are still copied."
        )
    );

    let out = service
        .submit_copying(
            &ctx,
            "orders.submit",
            &market_order(leader, Side::Buy, 1),
            None,
            None,
        )
        .await
        .unwrap();
    let copies = out.copies.expect("copied");
    let skipped = copies
        .results
        .iter()
        .find(|r| &r.account_id == locked)
        .unwrap();
    assert_eq!(skipped.outcome, CopyOutcome::Skipped, "{copies:?}");
    assert!(
        skipped
            .text
            .starts_with("Trading on this account is locked since "),
        "the skip says why: {}",
        skipped.text
    );
    assert_eq!(copies.copied(), 1, "{copies:?}");
    holds(&broker, open, 1).await;
    holds(&broker, leader, 1).await;
    assert_eq!(
        gw.took_by("TEST-000003-02"),
        0,
        "nothing reached Rithmic for it"
    );

    let out = service.lock_account(&ctx, &lock(leader)).await.unwrap();
    assert_eq!(
        out.copy.as_deref(),
        Some(
            "It leads Evals: while it is locked the group copies no entries. Exits are still copied."
        )
    );
    let sent = gw.took().len();
    let e = service
        .submit_copying(
            &ctx,
            "orders.submit",
            &market_order(leader, Side::Buy, 1),
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(
        e.message
            .contains("Trading on this account is locked since "),
        "{}",
        e.message
    );
    assert_eq!(e.details.unwrap()["code"], "account_locked");
    assert_eq!(gw.took().len(), sent, "no entry left for Rithmic");

    let out = service
        .submit_copying(
            &ctx,
            "orders.submit",
            &market_order(leader, Side::Sell, 1),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(out.copies.expect("the exit is copied").copied(), 1);
    assert_eq!(
        gw.took()[sent..],
        [
            Took {
                account: "TEST-000003-01".into(),
                side: 2,
                qty: 1
            },
            Took {
                account: "TEST-000003-03".into(),
                side: 2,
                qty: 1
            },
        ],
        "after the refused entry, only the exits reached Rithmic"
    );
    holds(&broker, leader, 0).await;
    holds(&broker, open, 0).await;
    broker.shutdown().await;
    market.shutdown().await;
}
