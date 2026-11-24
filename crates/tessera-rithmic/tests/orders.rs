use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use chrono::{Days, NaiveDate};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rithmic_rs::prost::Message as _;
use rithmic_rs::rti::{
    AccountPnLPositionUpdate, ExchangeOrderNotification, InstrumentPnLPositionUpdate,
    RequestBracketOrder, RequestCancelOrder, RequestLogin, RequestModifyOrder, RequestNewOrder,
    RequestOcoOrder, RequestReferenceData, RequestReplayExecutions, RequestShowFillHistory,
    RequestUpdateStopBracketLevel, ResponseAccountList, ResponseAccountRmsInfo,
    ResponseAccountRmsUpdates, ResponseBracketOrder, ResponseCancelOrder, ResponseHeartbeat,
    ResponseLogin, ResponseLoginInfo, ResponseLogout, ResponseModifyOrder, ResponseNewOrder,
    ResponseOcoOrder, ResponsePnLPositionSnapshot, ResponsePnLPositionUpdates,
    ResponseReferenceData, ResponseReplayExecutions, ResponseShowFillHistory,
    ResponseShowOrderHistory, ResponseShowOrders, ResponseSubscribeForOrderUpdates,
    ResponseSubscribeToBracketUpdates, ResponseTradeRoutes, ResponseUpdateStopBracketLevel,
    RithmicOrderNotification,
};
use rust_decimal::Decimal;
use tessera_broker::protect::manager::STALE_AFTER;
use tessera_broker::protect::{BreakevenAsk, ProtectionManager, ProtectionMode, RULE_GAP, Touch};
use tessera_broker::{
    BrokerError, BrokerEvent, BrokerProvider, GuardedBroker, OrderChanges, SendRefused,
};
use tessera_core::accounts::Environment;
use tessera_core::health::ConnectionPhase as Phase;
use tessera_core::health::HealthStatus;
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::instrument::{ContractMonth, ExchangeContract};
use tessera_core::money::{Price, Qty};
use tessera_core::orders::{
    Bracket, BreakevenRule, CheckSeverity, Order, OrderRequest, OrderRole, OrderStatus, OrderType,
    Side, TimeInForce, TrailRule,
};
use tessera_core::session::SessionCalendar;
use tessera_core::settle::{settle, settle_async};
use tessera_core::time::Timestamp;
use tessera_market::MarketDataProvider;
use tessera_rithmic::{RithmicBroker, RithmicLogin, RithmicMarket, RithmicOptions, symbols};
use tessera_tools::MemoryObserver;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

const ACCOUNT: &str = "TEST-000001-01";
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

type StopLevel = (Option<i32>, Option<i32>);

#[derive(Clone, Debug)]
struct Held {
    basket: String,
    tag: String,
    symbol: String,
    qty: i32,
    price: Option<f64>,
    trigger: Option<f64>,
    price_type: i32,
    side: i32,
    status: &'static str,
    filled: i32,
    original: Option<String>,
}

impl Held {
    fn notification(&self) -> RithmicOrderNotification {
        msg!(RithmicOrderNotification {
            template_id: 351,
            fcm_id: Some(FCM.into()),
            ib_id: Some(IB.into()),
            account_id: Some(ACCOUNT.into()),
            basket_id: Some(self.basket.clone()),
            original_basket_id: self.original.clone(),
            user_tag: Some(self.tag.clone()).filter(|t| !t.is_empty()),
            symbol: Some(self.symbol.clone()),
            exchange: Some("CME".into()),
            quantity: Some(self.qty),
            price: self.price,
            trigger_price: self.trigger,
            price_type: Some(self.price_type),
            transaction_type: Some(self.side),
            duration: Some(1),
            status: Some(self.status.into()),
            completion_reason: (self.status == "complete").then(|| "Cancelled".to_owned()),
            total_fill_size: (self.filled > 0).then_some(self.filled),
            total_unfilled_size: (self.filled > 0).then_some(self.qty - self.filled),
        })
    }
}

#[derive(Clone)]
struct Gateway {
    url: String,
    orders: Arc<Mutex<Vec<i32>>>,
    drop_next: Arc<AtomicBool>,
    anonymous_legs: Arc<AtomicBool>,
    stop_levels: Arc<Mutex<Vec<StopLevel>>>,
    book: Arc<Mutex<Vec<Held>>>,
    baskets: Arc<AtomicU32>,
    order_logins: Arc<AtomicU32>,
    net: Arc<Mutex<i32>>,
    shown: Arc<Mutex<i32>>,
    pnl_held: Arc<AtomicBool>,
    flat_unsaid: Arc<AtomicBool>,
    oco: Arc<Mutex<Vec<Vec<String>>>>,
    refuse_oco: Arc<AtomicBool>,
    echo_later: Arc<AtomicBool>,
    pnl: tokio::sync::broadcast::Sender<Message>,
    fills: tokio::sync::broadcast::Sender<(String, Option<i32>)>,
    past: Arc<Mutex<Vec<Past>>>,
    asked: Arc<Mutex<Vec<Asked>>>,
    in_flight: Arc<AtomicU32>,
    most_in_flight: Arc<AtomicU32>,
    created: Arc<Mutex<Option<i64>>>,
    pnl_snapshots: Arc<AtomicU32>,
}

#[derive(Clone, Debug)]
struct Past {
    id: String,
    secs: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Asked {
    Replay { from: i64, to: i64 },
    History { first: NaiveDate, last: NaiveDate },
}

fn trade_date(secs: i64) -> NaiveDate {
    SessionCalendar::CmeGlobex.trade_date(Timestamp::from_secs(secs))
}

fn from_yyyymmdd(v: Option<i32>) -> NaiveDate {
    let v = v.unwrap_or_default();
    NaiveDate::from_ymd_opt(v / 10_000, (v / 100 % 100) as u32, (v % 100) as u32).unwrap()
}

impl Gateway {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gw = Self {
            url: format!("ws://{}", listener.local_addr().unwrap()),
            orders: Arc::default(),
            drop_next: Arc::default(),
            anonymous_legs: Arc::default(),
            stop_levels: Arc::default(),
            book: Arc::default(),
            baskets: Arc::default(),
            order_logins: Arc::default(),
            net: Arc::default(),
            shown: Arc::default(),
            pnl_held: Arc::default(),
            flat_unsaid: Arc::default(),
            oco: Arc::default(),
            refuse_oco: Arc::default(),
            echo_later: Arc::default(),
            pnl: tokio::sync::broadcast::channel(64).0,
            fills: tokio::sync::broadcast::channel(64).0,
            past: Arc::default(),
            asked: Arc::default(),
            in_flight: Arc::default(),
            most_in_flight: Arc::default(),
            created: Arc::default(),
            pnl_snapshots: Arc::default(),
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

    fn filled_before(&self, id: &str, secs: i64) {
        self.past.lock().push(Past {
            id: id.into(),
            secs,
        });
    }

    fn asked(&self) -> Vec<Asked> {
        self.asked.lock().clone()
    }

    fn history_asked(&self) -> Vec<(NaiveDate, NaiveDate)> {
        self.asked()
            .into_iter()
            .filter_map(|a| match a {
                Asked::History { first, last } => Some((first, last)),
                Asked::Replay { .. } => None,
            })
            .collect()
    }

    fn replays(&self) -> Vec<(i64, i64)> {
        self.asked()
            .into_iter()
            .filter_map(|a| match a {
                Asked::Replay { from, to } => Some((from, to)),
                Asked::History { .. } => None,
            })
            .collect()
    }

    fn replayed(&self, um: Vec<String>, r: &RequestReplayExecutions) -> Vec<Message> {
        let (from, to) = (
            i64::from(r.start_index.unwrap_or_default()),
            i64::from(r.finish_index.unwrap_or_default()),
        );
        self.asked.lock().push(Asked::Replay { from, to });
        let mut out: Vec<Message> = self
            .past
            .lock()
            .iter()
            .filter(|p| (from..=to).contains(&p.secs))
            .map(|p| {
                frame(&msg!(ExchangeOrderNotification {
                    template_id: 352,
                    is_snapshot: Some(true),
                    notify_type: Some(5),
                    fcm_id: Some(FCM.into()),
                    ib_id: Some(IB.into()),
                    account_id: Some(ACCOUNT.into()),
                    fill_id: Some(p.id.clone()),
                    symbol: Some("MNQZ6".into()),
                    exchange: Some("CME".into()),
                    transaction_type: Some(1),
                    fill_price: Some(20_000.0),
                    fill_size: Some(1),
                    source_ssboe: i32::try_from(p.secs).ok(),
                }))
            })
            .collect();
        out.push(frame(&msg!(ResponseReplayExecutions {
            template_id: 3507,
            user_msg: um,
            rp_code: ok(),
        })));
        out
    }

    fn fill_history(&self, um: Vec<String>, r: &RequestShowFillHistory) -> Vec<Message> {
        assert_eq!(r.index_format.as_deref(), Some("trade_date"));
        let (first, last) = (from_yyyymmdd(r.start_index), from_yyyymmdd(r.finish_index));
        self.asked.lock().push(Asked::History { first, last });
        let mut out: Vec<Message> = self
            .past
            .lock()
            .iter()
            .filter(|p| (first..=last).contains(&trade_date(p.secs)))
            .map(|p| {
                frame(&msg!(ResponseShowFillHistory {
                    template_id: 3513,
                    user_msg: um.clone(),
                    rq_handler_rp_code: ok(),
                    fcm_id: Some(FCM.into()),
                    ib_id: Some(IB.into()),
                    account_id: Some(ACCOUNT.into()),
                    fill_id: Some(p.id.clone()),
                    symbol: Some("MNQZ6".into()),
                    exchange: Some("CME".into()),
                    transaction_type: Some("BUY".into()),
                    fill_price: Some(20_000.0),
                    fill_size: Some(1),
                    source_ssboe: i32::try_from(p.secs).ok(),
                }))
            })
            .collect();
        let empty = out.is_empty();
        out.push(frame(&msg!(ResponseShowFillHistory {
            template_id: 3513,
            user_msg: um,
            rp_code: if empty {
                vec!["7".into(), "no data".into()]
            } else {
                ok()
            },
        })));
        out
    }

    fn answer_later(&self, frames: Vec<Message>, later: &mpsc::UnboundedSender<Vec<Message>>) {
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_in_flight.fetch_max(now, Ordering::SeqCst);
        let later = later.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = later.send(frames);
        });
    }

    fn next_basket(&self) -> String {
        format!("B{}", self.baskets.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn filled(&self, side: i32, qty: i32) {
        *self.net.lock() += if side == 1 { qty } else { -qty };
        if !self.pnl_held.load(Ordering::SeqCst) {
            self.report_position();
        }
    }

    fn hold_pnl(&self) {
        self.pnl_held.store(true, Ordering::SeqCst);
    }

    fn release_pnl(&self) {
        self.pnl_held.store(false, Ordering::SeqCst);
        self.report_position();
    }

    fn net(&self) -> i32 {
        *self.net.lock()
    }

    fn report_day_pnl(&self, day: &str) {
        let _ = self.pnl.send(frame(&msg!(AccountPnLPositionUpdate {
            template_id: 451,
            fcm_id: Some(FCM.into()),
            ib_id: Some(IB.into()),
            account_id: Some(ACCOUNT.into()),
            account_balance: Some("25000.00".into()),
            cash_on_hand: Some("25000.00".into()),
            open_position_pnl: Some("0.00".into()),
            day_pnl: Some(day.into()),
        })));
    }

    fn leave_flat_unsaid(&self) {
        self.flat_unsaid.store(true, Ordering::SeqCst);
    }

    fn report_position(&self) {
        let net = *self.net.lock();
        *self.shown.lock() = net;
        let _ = self.pnl.send(self.position_frame(net, false));
    }

    fn position_frame(&self, net: i32, snapshot: bool) -> Message {
        let said = net != 0 || !self.flat_unsaid.load(Ordering::SeqCst);
        frame(&msg!(InstrumentPnLPositionUpdate {
            template_id: 450,
            is_snapshot: snapshot.then_some(true),
            fcm_id: Some(FCM.into()),
            ib_id: Some(IB.into()),
            account_id: Some(ACCOUNT.into()),
            symbol: Some("MNQZ6".into()),
            exchange: Some("CME".into()),
            net_quantity: said.then_some(net),
            avg_open_fill_price: said.then_some(20_000.0),
            day_closed_pnl: Some(0.0),
            ssboe: Some(1_791_390_000),
        }))
    }

    fn working(&self, basket: &str) -> bool {
        self.book
            .lock()
            .iter()
            .any(|h| h.basket == basket && h.status == "open")
    }

    fn oco_siblings_cancelled(&self, basket: &str) -> Vec<Message> {
        let siblings: Vec<String> = self
            .oco
            .lock()
            .iter()
            .filter(|g| g.iter().any(|b| b == basket))
            .flatten()
            .filter(|b| *b != basket)
            .cloned()
            .collect();
        let mut book = self.book.lock();
        book.iter_mut()
            .filter(|h| siblings.contains(&h.basket) && h.status == "open")
            .map(|h| {
                h.status = "complete";
                frame(&h.notification())
            })
            .collect()
    }

    fn fill_open(&self, basket: &str) {
        let _ = self.fills.send((basket.to_owned(), None));
    }

    fn fill_while_away(&self, basket: &str) {
        self.fill_frames(basket, None);
    }

    fn fill_some(&self, basket: &str, qty: i32) {
        let _ = self.fills.send((basket.to_owned(), Some(qty)));
    }

    fn fill_frames(&self, basket: &str, qty: Option<i32>) -> Vec<Message> {
        let (held, size) = {
            let mut book = self.book.lock();
            let Some(h) = book
                .iter_mut()
                .find(|h| h.basket == basket && h.status == "open")
            else {
                return Vec::new();
            };
            let size = qty.unwrap_or(h.qty - h.filled).min(h.qty - h.filled);
            h.filled += size;
            if h.filled == h.qty {
                h.status = "complete";
            }
            (h.clone(), size)
        };
        let mut filled = held.notification();
        if held.status == "complete" {
            filled.completion_reason = Some("Fill".into());
        }
        let px = held.price.or(held.trigger).unwrap_or(20_000.0);
        filled.avg_fill_price = Some(px);
        self.filled(held.side, size);
        let siblings = if held.status == "complete" {
            self.oco_siblings_cancelled(&held.basket)
        } else {
            Vec::new()
        };
        let mut out = vec![
            frame(&msg!(ExchangeOrderNotification {
                template_id: 352,
                notify_type: Some(5),
                fcm_id: Some(FCM.into()),
                ib_id: Some(IB.into()),
                account_id: Some(ACCOUNT.into()),
                basket_id: Some(held.basket.clone()),
                fill_id: Some(format!("F-{}-{}", held.basket, held.filled)),
                symbol: Some(held.symbol.clone()),
                exchange: Some("CME".into()),
                transaction_type: Some(held.side),
                fill_price: Some(px),
                fill_size: Some(size),
                source_ssboe: Some(1_791_390_000),
            })),
            frame(&filled),
        ];
        out.extend(siblings);
        out
    }

    async fn serve(&self, tcp: tokio::net::TcpStream) {
        let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
            return;
        };
        let mut pushes = self.pnl.subscribe();
        let mut fills = self.fills.subscribe();
        let mut pnl = false;
        let mut orders = false;
        let (later_tx, mut later) = mpsc::unbounded_channel::<Vec<Message>>();
        loop {
            let m = tokio::select! {
                m = ws.next() => m,
                Some(frames) = later.recv() => {
                    self.in_flight.fetch_sub(1, Ordering::SeqCst);
                    for f in frames {
                        if ws.send(f).await.is_err() {
                            return;
                        }
                    }
                    continue;
                }
                p = pushes.recv(), if pnl => {
                    if let Ok(p) = p
                        && ws.send(p).await.is_err()
                    {
                        return;
                    }
                    continue;
                }
                f = fills.recv(), if orders => {
                    if let Ok((basket, qty)) = f {
                        for m in self.fill_frames(&basket, qty) {
                            if ws.send(m).await.is_err() {
                                return;
                            }
                        }
                    }
                    continue;
                }
            };
            let Some(Ok(m)) = m else { return };
            let Message::Binary(bytes) = m else { continue };
            let body = &bytes[4..];
            // Every request carries `template_id` and `user_msg` under the same tags.
            let Ok(head) = RequestLogin::decode(body) else {
                continue;
            };
            let um = head.user_msg.clone();
            let mut out: Vec<Message> = Vec::new();
            match head.template_id {
                10 => {
                    if head.infra_type == Some(2) {
                        self.order_logins.fetch_add(1, Ordering::SeqCst);
                        orders = true;
                    }
                    out.push(frame(&msg!(ResponseLogin {
                        template_id: 11,
                        user_msg: um,
                        rp_code: ok(),
                        heartbeat_interval: Some(60.0),
                        unique_user_id: Some("u".into()),
                    })));
                }
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
                    out.push(frame(&msg!(ResponseAccountList {
                        template_id: 303,
                        user_msg: um.clone(),
                        rq_handler_rp_code: ok(),
                        fcm_id: Some(FCM.into()),
                        ib_id: Some(IB.into()),
                        account_id: Some(ACCOUNT.into()),
                        account_name: Some("TEST-000001 (Sample)".into()),
                        account_currency: Some("USD".into()),
                        account_creation_ssboe: self
                            .created
                            .lock()
                            .and_then(|c| i32::try_from(c).ok()),
                    })));
                    out.push(frame(&msg!(ResponseAccountList {
                        template_id: 303,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                }
                304 => {
                    out.push(frame(&msg!(ResponseAccountRmsInfo {
                        template_id: 305,
                        user_msg: um.clone(),
                        rq_handler_rp_code: ok(),
                        account_id: Some(ACCOUNT.into()),
                        status: Some("active".into()),
                        max_order_quantity: Some(10),
                        buy_limit: Some(4),
                        sell_limit: Some(4),
                    })));
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
                308 => out.push(frame(&msg!(ResponseSubscribeForOrderUpdates {
                    template_id: 309,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                336 => out.push(frame(&msg!(ResponseSubscribeToBracketUpdates {
                    template_id: 337,
                    user_msg: um,
                    rp_code: ok(),
                }))),
                320 | 322 => {
                    let working = head.template_id == 320;
                    out.push(if working {
                        frame(&msg!(ResponseShowOrders {
                            template_id: 321,
                            user_msg: um,
                            rp_code: ok(),
                        }))
                    } else {
                        frame(&msg!(ResponseShowOrderHistory {
                            template_id: 323,
                            user_msg: um,
                            rp_code: ok(),
                        }))
                    });
                    for h in self.book.lock().iter() {
                        if !working || h.status == "open" {
                            out.push(frame(&h.notification()));
                        }
                    }
                }
                3512 => {
                    let r = RequestShowFillHistory::decode(body).unwrap();
                    self.answer_later(self.fill_history(um, &r), &later_tx);
                    continue;
                }
                3506 => {
                    let r = RequestReplayExecutions::decode(body).unwrap();
                    out.extend(self.replayed(um, &r));
                }
                402 => {
                    self.pnl_snapshots.fetch_add(1, Ordering::SeqCst);
                    out.push(frame(&msg!(ResponsePnLPositionSnapshot {
                        template_id: 403,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                    out.push(self.position_frame(*self.shown.lock(), true));
                    out.push(frame(&msg!(AccountPnLPositionUpdate {
                        template_id: 451,
                        is_snapshot: Some(true),
                        fcm_id: Some(FCM.into()),
                        ib_id: Some(IB.into()),
                        account_id: Some(ACCOUNT.into()),
                        account_balance: Some("25000.00".into()),
                        cash_on_hand: Some("25000.00".into()),
                        open_position_pnl: Some("0.00".into()),
                        day_pnl: Some("0.00".into()),
                    })));
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
                    self.orders.lock().push(312);
                    let r = RequestNewOrder::decode(body).unwrap();
                    let held = Held {
                        basket: self.next_basket(),
                        tag: r.user_tag.clone().unwrap_or_default(),
                        symbol: r.symbol.clone().unwrap_or_default(),
                        qty: r.quantity.unwrap_or(0),
                        price: r.price,
                        trigger: r.trigger_price,
                        price_type: r.price_type.unwrap_or(1),
                        side: r.transaction_type.unwrap_or(1),
                        status: "open",
                        filled: 0,
                        original: None,
                    };
                    if r.account_id.as_deref() != Some(ACCOUNT) {
                        out.push(frame(&msg!(ResponseNewOrder {
                            template_id: 313,
                            user_msg: um,
                            rp_code: vec!["3".into(), "unknown account".into()],
                        })));
                    } else if held.qty > 5 {
                        out.push(frame(&msg!(ResponseNewOrder {
                            template_id: 313,
                            user_msg: um,
                            rp_code: vec![
                                "5".into(),
                                "Order rejected: max order quantity exceeded".into(),
                            ],
                        })));
                    } else if self.drop_next.swap(false, Ordering::SeqCst) {
                        self.book.lock().push(held);
                        return;
                    } else {
                        out.push(frame(&msg!(ResponseNewOrder {
                            template_id: 313,
                            user_msg: um.clone(),
                            rq_handler_rp_code: ok(),
                            user_tag: r.user_tag.clone(),
                            basket_id: Some(held.basket.clone()),
                        })));
                        out.push(frame(&msg!(ResponseNewOrder {
                            template_id: 313,
                            user_msg: um,
                            rp_code: ok(),
                        })));
                        out.push(frame(&held.notification()));
                        if held.price_type == 2 {
                            out.push(frame(&msg!(ExchangeOrderNotification {
                                template_id: 352,
                                notify_type: Some(5),
                                fcm_id: Some(FCM.into()),
                                ib_id: Some(IB.into()),
                                account_id: Some(ACCOUNT.into()),
                                basket_id: Some(held.basket.clone()),
                                fill_id: Some(format!("F-{}", held.basket)),
                                symbol: Some(held.symbol.clone()),
                                exchange: Some("CME".into()),
                                transaction_type: Some(held.side),
                                fill_price: Some(20_000.0),
                                fill_size: Some(held.qty),
                                source_ssboe: Some(1_791_390_000),
                            })));
                            let mut filled = held.notification();
                            filled.status = Some("complete".into());
                            filled.completion_reason = Some("Fill".into());
                            filled.total_fill_size = Some(held.qty);
                            filled.total_unfilled_size = Some(0);
                            filled.avg_fill_price = Some(20_000.0);
                            out.push(frame(&filled));
                            self.filled(held.side, held.qty);
                            self.book.lock().push(Held {
                                status: "complete",
                                filled: held.qty,
                                ..held
                            });
                        } else {
                            self.book.lock().push(held);
                        }
                    }
                }
                314 => {
                    self.orders.lock().push(314);
                    let r = RequestModifyOrder::decode(body).unwrap();
                    let basket = r.basket_id.clone().unwrap_or_default();
                    out.push(frame(&msg!(ResponseModifyOrder {
                        template_id: 315,
                        user_msg: um.clone(),
                        rq_handler_rp_code: ok(),
                        basket_id: Some(basket.clone()),
                    })));
                    out.push(frame(&msg!(ResponseModifyOrder {
                        template_id: 315,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                    if let Some(h) = self.book.lock().iter_mut().find(|h| h.basket == basket) {
                        h.price = r.price;
                        h.trigger = r.trigger_price;
                        h.qty = r.quantity.unwrap_or(h.qty);
                        if !self.echo_later.load(Ordering::SeqCst) {
                            out.push(frame(&h.notification()));
                        }
                    }
                }
                316 => {
                    self.orders.lock().push(316);
                    let r = RequestCancelOrder::decode(body).unwrap();
                    let basket = r.basket_id.clone().unwrap_or_default();
                    out.push(frame(&msg!(ResponseCancelOrder {
                        template_id: 317,
                        user_msg: um.clone(),
                        rq_handler_rp_code: ok(),
                        basket_id: Some(basket.clone()),
                    })));
                    out.push(frame(&msg!(ResponseCancelOrder {
                        template_id: 317,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                    if let Some(h) = self.book.lock().iter_mut().find(|h| h.basket == basket) {
                        h.status = "complete";
                        out.push(frame(&h.notification()));
                    }
                }
                330 => {
                    self.orders.lock().push(330);
                    let r = RequestBracketOrder::decode(body).unwrap();
                    let entry = Held {
                        basket: self.next_basket(),
                        tag: r.user_tag.clone().unwrap_or_default(),
                        symbol: r.symbol.clone().unwrap_or_default(),
                        qty: r.quantity.unwrap_or(0),
                        price: r.price,
                        trigger: None,
                        price_type: r.price_type.unwrap_or(1),
                        side: r.transaction_type.unwrap_or(1),
                        status: "open",
                        filled: 0,
                        original: None,
                    };
                    out.push(frame(&msg!(ResponseBracketOrder {
                        template_id: 331,
                        user_msg: um.clone(),
                        rq_handler_rp_code: ok(),
                        user_tag: r.user_tag.clone(),
                        basket_id: Some(entry.basket.clone()),
                    })));
                    out.push(frame(&msg!(ResponseBracketOrder {
                        template_id: 331,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                    out.push(frame(&entry.notification()));
                    if entry.price.is_some_and(|p| p < 19_500.0) {
                        self.book.lock().push(entry);
                        for m in out {
                            if ws.send(m).await.is_err() {
                                return;
                            }
                        }
                        continue;
                    }
                    let fill = entry.price.unwrap_or(20_000.0);
                    let tick = 0.25;
                    out.push(frame(&msg!(ExchangeOrderNotification {
                        template_id: 352,
                        notify_type: Some(5),
                        fcm_id: Some(FCM.into()),
                        ib_id: Some(IB.into()),
                        account_id: Some(ACCOUNT.into()),
                        basket_id: Some(entry.basket.clone()),
                        fill_id: Some(format!("F-{}", entry.basket)),
                        symbol: Some(entry.symbol.clone()),
                        exchange: Some("CME".into()),
                        transaction_type: Some(entry.side),
                        fill_price: Some(fill),
                        fill_size: Some(entry.qty),
                        source_ssboe: Some(1_791_390_000),
                    })));
                    let mut filled = entry.notification();
                    filled.status = Some("complete".into());
                    filled.completion_reason = Some("Fill".into());
                    filled.total_fill_size = Some(entry.qty);
                    filled.total_unfilled_size = Some(0);
                    filled.avg_fill_price = Some(fill);
                    out.push(frame(&filled));
                    let exit = if entry.side == 1 { 2 } else { 1 };
                    let sign = if entry.side == 1 { 1.0 } else { -1.0 };
                    let target_ticks = f64::from(r.target_ticks.first().copied().unwrap_or(0));
                    let stop_ticks = f64::from(r.stop_ticks.first().copied().unwrap_or(0));
                    let anonymous = self.anonymous_legs.load(Ordering::SeqCst);
                    let original = (!anonymous).then(|| entry.basket.clone());
                    let target = Held {
                        basket: format!("{}-T", entry.basket),
                        tag: if anonymous {
                            String::new()
                        } else {
                            entry.tag.clone()
                        },
                        price: Some(fill + sign * target_ticks * tick),
                        price_type: 1,
                        side: exit,
                        original: original.clone(),
                        ..entry.clone()
                    };
                    let stop = Held {
                        basket: format!("{}-S", entry.basket),
                        tag: String::new(),
                        price: None,
                        trigger: Some(fill - sign * stop_ticks * tick),
                        price_type: 4,
                        side: exit,
                        original,
                        ..entry.clone()
                    };
                    let (t, s) = (target.notification(), stop.notification());
                    if target_ticks > 0.0 {
                        out.push(frame(&t));
                    }
                    if stop_ticks > 0.0 {
                        out.push(frame(&s));
                    }
                    self.filled(entry.side, entry.qty);
                    let mut book = self.book.lock();
                    book.push(Held {
                        status: "complete",
                        filled: entry.qty,
                        ..entry
                    });
                    book.push(target);
                    book.push(stop);
                }
                328 if self.refuse_oco.load(Ordering::SeqCst) => {
                    self.orders.lock().push(328);
                    out.push(frame(&msg!(ResponseOcoOrder {
                        template_id: 329,
                        user_msg: um,
                        rp_code: vec!["5".into(), "OCO orders are not permitted".into()],
                    })));
                }
                328 => {
                    self.orders.lock().push(328);
                    let r = RequestOcoOrder::decode(body).unwrap();
                    let lost = self.drop_next.swap(false, Ordering::SeqCst);
                    let some = |v: Option<&f64>| v.copied().filter(|p| *p > 0.0);
                    let legs: Vec<Held> = (0..r.symbol.len())
                        .map(|i| Held {
                            basket: self.next_basket(),
                            tag: r.user_tag.get(i).cloned().unwrap_or_default(),
                            symbol: r.symbol[i].clone(),
                            qty: r.quantity.get(i).copied().unwrap_or(0),
                            price: some(r.price.get(i)),
                            trigger: some(r.trigger_price.get(i)),
                            price_type: r.price_type.get(i).copied().unwrap_or(1),
                            side: r.transaction_type.get(i).copied().unwrap_or(1),
                            status: "open",
                            filled: 0,
                            original: None,
                        })
                        .collect();
                    out.push(frame(&msg!(ResponseOcoOrder {
                        template_id: 329,
                        user_msg: um.clone(),
                        rq_handler_rp_code: ok(),
                        user_tag: r.user_tag.clone(),
                        basket_id: legs.iter().map(|l| l.basket.clone()).collect(),
                    })));
                    out.push(frame(&msg!(ResponseOcoOrder {
                        template_id: 329,
                        user_msg: um,
                        rp_code: ok(),
                    })));
                    self.oco
                        .lock()
                        .push(legs.iter().map(|l| l.basket.clone()).collect());
                    if lost {
                        self.book.lock().extend(legs);
                        return;
                    }
                    for l in legs {
                        out.push(frame(&l.notification()));
                        self.book.lock().push(l);
                    }
                }
                334 => {
                    self.orders.lock().push(334);
                    let r = RequestUpdateStopBracketLevel::decode(body).unwrap();
                    self.stop_levels.lock().push((r.level, r.stop_ticks));
                    // Rithmic refuses an adjustment that does not name its level.
                    let answer = if r.level.is_some() {
                        ok()
                    } else {
                        vec!["3".into(), "level field is not received".into()]
                    };
                    out.push(frame(&msg!(ResponseUpdateStopBracketLevel {
                        template_id: 335,
                        user_msg: um,
                        rp_code: answer,
                    })));
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

struct Desk {
    market: Arc<RithmicMarket>,
    broker: RithmicBroker,
    guarded: Arc<GuardedBroker<dyn BrokerProvider>>,
    account: AccountId,
}

async fn desk(gw: &Gateway) -> Desk {
    let login = RithmicLogin {
        user: "nobody".into(),
        password: "unused".into(),
        system_name: "Apex".into(),
        gateway_url: gw.url.clone(),
    };
    let mut opts = RithmicOptions::for_system("Apex");
    opts.connect_timeout = Duration::from_secs(5);
    opts.request_timeout = Duration::from_secs(2);
    let market = RithmicMarket::new(login, opts).unwrap();
    market.reconnect().await.unwrap();
    let id = symbols::instrument_id("MNQZ6", "CME");
    let (_, spec) = market.spec(&id).await.unwrap();
    assert_eq!(spec.tick_size, Price(Decimal::new(25, 2)));
    let broker = RithmicBroker::connect(&market).await.unwrap();
    let accounts = broker.accounts().await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].environment, Environment::Eval);
    let account = accounts[0].id.clone();
    let guarded = Arc::new(GuardedBroker::new(
        Arc::new(broker.clone()) as Arc<dyn BrokerProvider>
    ));
    Desk {
        market,
        broker,
        guarded,
        account,
    }
}

impl Desk {
    fn turn_on(&self) {
        self.broker
            .set_account_order_entry(&self.account, true)
            .unwrap();
        self.guarded
            .set_account_order_entry(self.broker.id(), &self.account, true);
    }

    fn limit(&self, side: Side, qty: i64, price: &str, tag: &str) -> OrderRequest {
        OrderRequest {
            account_id: self.account.clone(),
            instrument: symbols::instrument_id("MNQZ6", "CME"),
            side,
            qty: Qty::from(qty),
            order_type: OrderType::Limit,
            limit_price: Some(Price(price.parse().unwrap())),
            stop_price: None,
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: Some(tag.into()),
            reduce_only: false,
        }
    }

    fn market(&self, side: Side, qty: i64, tag: &str) -> OrderRequest {
        OrderRequest {
            order_type: OrderType::Market,
            limit_price: None,
            ..self.limit(side, qty, "20000", tag)
        }
    }

    fn exit(&self, side: Side, qty: i64, tag: &str) -> OrderRequest {
        OrderRequest {
            reduce_only: true,
            ..self.market(side, qty, tag)
        }
    }

    async fn filled(&self, r: OrderRequest) -> Order {
        let o = self.submit(r).await.unwrap();
        self.status_settles(&o.id, OrderStatus::Filled).await
    }

    async fn submit(&self, r: OrderRequest) -> Result<Order, BrokerError> {
        self.guarded.submit(r, None).await
    }

    async fn order_settles(
        &self,
        what: &str,
        id: &OrderId,
        done: impl Fn(&Order) -> bool,
    ) -> Order {
        settle(
            what,
            || self.broker.order_of(id),
            |o| o.as_ref().is_some_and(&done),
        )
        .await
        .unwrap()
    }

    async fn status_settles(&self, id: &OrderId, want: OrderStatus) -> Order {
        self.order_settles(&format!("{id} {want:?}"), id, |o| o.status == want)
            .await
    }

    async fn position(&self) -> Option<Qty> {
        self.broker
            .positions(&self.account)
            .await
            .unwrap()
            .first()
            .map(|p| p.qty)
    }

    async fn position_settles(&self, qty: Option<i64>) {
        settle_async(
            &format!("the position reading {qty:?}"),
            || self.position(),
            |q| *q == qty.map(Qty::from),
        )
        .await;
    }

    async fn shutdown(self) {
        self.broker.shutdown().await;
        self.market.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_evaluation_account_turned_on_submits_modifies_and_cancels() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    let dec = ContractMonth::parse("2026-12");
    let mnq = d
        .market
        .contract_for(&ExchangeContract::new("CME", "MNQ", dec))
        .await
        .unwrap()
        .expect("the firm lists MNQ Dec 2026");
    assert_eq!(mnq.id.as_str(), "MNQZ6.CME-RITHMIC");
    let march = ExchangeContract::new("CME", "MNQ", ContractMonth::parse("2027-03"));
    assert_eq!(d.market.contract_for(&march).await.unwrap(), None);
    let undated = ExchangeContract::new("NASDAQ", "QQQ", None);
    assert_eq!(d.market.contract_for(&undated).await.unwrap(), None);

    let r = d.submit(d.limit(Side::Buy, 1, "19000", "t-1")).await;
    assert!(
        matches!(r, Err(BrokerError::Refused(SendRefused::OrderEntryOff))),
        "{r:?}"
    );
    assert!(gw.orders.lock().is_empty());

    d.turn_on();
    let o = d
        .submit(d.limit(Side::Buy, 1, "19000", "t-1"))
        .await
        .unwrap();
    assert_eq!(o.broker_order_id.as_deref(), Some("B1"));
    assert_eq!(o.environment, Environment::Eval);
    assert_eq!(o.request.client_order_id.as_deref(), Some("t-1"));
    d.status_settles(&o.id, OrderStatus::Working).await;
    let again = d
        .submit(d.limit(Side::Buy, 1, "19000", "t-1"))
        .await
        .unwrap();
    assert_eq!(again.id, o.id);
    assert_eq!(*gw.orders.lock(), [312]);

    let changes = OrderChanges {
        limit_price: Some(Price(Decimal::new(1_899_925, 2))),
        ..OrderChanges::default()
    };
    d.guarded.modify(&d.account, &o.id, changes).await.unwrap();
    d.order_settles("the limit moved to 18,999.25", &o.id, |x| {
        x.request.limit_price == Some(Price(Decimal::new(1_899_925, 2)))
    })
    .await;

    let c = d.guarded.cancel(&d.account, &o.id).await.unwrap();
    assert!(
        matches!(
            c.status,
            OrderStatus::PendingCancel | OrderStatus::Cancelled
        ),
        "{:?}",
        c.status
    );
    d.status_settles(&o.id, OrderStatus::Cancelled).await;
    assert_eq!(*gw.orders.lock(), [312, 314, 316]);

    let r = d.submit(d.limit(Side::Sell, 6, "21000", "t-2")).await;
    assert_eq!(
        r,
        Err(BrokerError::Rejected(
            "Rithmic refused it: Order rejected: max order quantity exceeded.".into()
        ))
    );
    assert_eq!(d.broker.health().status, HealthStatus::Ok);

    d.broker.set_account_order_entry(&d.account, false).unwrap();
    d.guarded
        .set_account_order_entry(d.broker.id(), &d.account, false);
    assert!(
        d.submit(d.limit(Side::Buy, 1, "19000", "t-3"))
            .await
            .is_err()
    );
    assert_eq!(*gw.orders.lock(), [312, 314, 316, 312]);
    let counts = d.broker.template_counts();
    assert_eq!(counts.get(&312), Some(&2));
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bracket_goes_out_native_and_its_legs_come_back_under_the_entry() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let mut events = d.broker.events();
    let mut r = d.limit(Side::Buy, 2, "20000", "br-1");
    r.bracket = Some(Bracket {
        stop_loss: Some(Price(Decimal::new(19_990, 0))),
        take_profit: Some(Price(Decimal::new(2_002_025, 2))),
        ..Bracket::default()
    });
    let entry = d.submit(r).await.unwrap();
    assert_eq!(*gw.orders.lock(), [330]);

    let (stop, target) = legs_placed(&d, &entry.id).await;
    assert_eq!(stop.id.as_str(), format!("{}-sl", entry.id));
    assert_eq!(target.id.as_str(), format!("{}-tp", entry.id));
    assert_eq!(stop.broker_order_id.as_deref(), Some("B1-S"));
    assert_eq!(
        stop.request.stop_price,
        Some(Price(Decimal::new(19_990, 0)))
    );
    assert_eq!(
        target.request.limit_price,
        Some(Price(Decimal::new(2_002_025, 2)))
    );
    assert!(stop.request.reduce_only && target.request.reduce_only);
    assert_eq!(stop.request.side, Side::Sell);
    d.status_settles(&entry.id, OrderStatus::Filled).await;
    gw.fill_open(&basket_of(&d, &target.id));
    let mut heard = Vec::new();
    let fills = settle(
        "the target's fill, sent after every frame of the entry",
        || {
            while let Some(Some(e)) = futures::FutureExt::now_or_never(events.next()) {
                if let BrokerEvent::Fill(f) = e {
                    heard.push((f.order_id, f.side));
                }
            }
            heard.clone()
        },
        |f| f.iter().any(|(_, side)| *side == Side::Sell),
    )
    .await;
    assert_eq!(
        fills,
        [
            (Some(entry.id.clone()), Side::Buy),
            (Some(target.id.clone()), Side::Sell)
        ],
        "the entry filled once"
    );
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resting_brackets_entry_cancels_first_and_its_held_legs_go_with_it() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let mut r = d.limit(Side::Buy, 1, "19000", "rest-1");
    r.bracket = Some(Bracket {
        stop_loss: Some(Price(Decimal::new(18_990, 0))),
        take_profit: Some(Price(Decimal::new(19_020, 0))),
        ..Bracket::default()
    });
    let entry = d.submit(r).await.unwrap();
    let held = || {
        d.broker
            .orders(&d.account)
            .now_or_never_orders()
            .into_iter()
            .filter(|o| o.parent_id.as_ref() == Some(&entry.id))
            .collect::<Vec<_>>()
    };
    assert_eq!(held().len(), 2);
    assert!(held().iter().all(|o| o.status == OrderStatus::Held));

    d.guarded.cancel(&d.account, &entry.id).await.unwrap();
    for leg in held() {
        if !leg.status.is_open() {
            continue;
        }
        let c = d.guarded.cancel(&d.account, &leg.id).await;
        assert!(
            c.as_ref().is_ok_and(|o| o.status == OrderStatus::Cancelled),
            "{c:?}"
        );
    }
    d.status_settles(&entry.id, OrderStatus::Cancelled).await;
    assert!(held().iter().all(|o| o.status == OrderStatus::Cancelled));
    assert_eq!(*gw.orders.lock(), [330, 316]);
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_order_lost_with_its_connection_is_never_sent_again() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    gw.drop_next.store(true, Ordering::SeqCst);
    let logins = gw.order_logins.load(Ordering::SeqCst);

    let r = d.submit(d.limit(Side::Buy, 1, "19000", "lost-1")).await;
    let Err(BrokerError::Unavailable(why)) = &r else {
        panic!("an order in doubt: {r:?}")
    };
    assert!(why.contains("will not send it again"), "{why}");
    let plant = || {
        (
            d.broker.health().status,
            gw.order_logins.load(Ordering::SeqCst),
        )
    };
    settle("the order plant degraded or back", plant, |(health, n)| {
        *health == HealthStatus::Degraded || *n > logins
    })
    .await;
    settle("the order plant logging in again", plant, |(_, n)| {
        *n > logins
    })
    .await;
    let found = || {
        d.broker
            .orders(&d.account)
            .now_or_never_orders()
            .into_iter()
            .find(|o| o.request.client_order_id.as_deref() == Some("lost-1"))
    };
    settle("the order found again", found, Option::is_some).await;
    settle(
        "the order plant live and healthy",
        || (d.broker.phase(), d.broker.health().status),
        |s| *s == (Phase::Live, HealthStatus::Ok),
    )
    .await;
    let again = d
        .submit(d.limit(Side::Buy, 1, "19000", "lost-1"))
        .await
        .unwrap();
    assert_eq!(again.id, found().unwrap().id);
    assert_eq!(*gw.orders.lock(), [312], "written exactly once");
    d.shutdown().await;
}

trait NowOrNever {
    fn now_or_never_orders(self) -> Vec<Order>;
}

impl<F: std::future::Future<Output = Result<Vec<Order>, BrokerError>>> NowOrNever for F {
    fn now_or_never_orders(self) -> Vec<Order> {
        futures::FutureExt::now_or_never(self)
            .and_then(Result::ok)
            .unwrap_or_default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_leg_that_names_neither_its_entry_nor_its_tag_is_its_brackets_stop_and_moves_past_the_entry()
 {
    let gw = Gateway::start().await;
    gw.anonymous_legs.store(true, Ordering::SeqCst);
    let d = desk(&gw).await;
    d.turn_on();
    let mut r = d.limit(Side::Buy, 1, "20000", "anon-1");
    r.bracket = Some(Bracket {
        stop_loss: Some(Price(Decimal::new(19_990, 0))),
        take_profit: None,
        ..Bracket::default()
    });
    let entry = d.submit(r).await.unwrap();
    let open = || {
        d.broker
            .orders(&d.account)
            .now_or_never_orders()
            .into_iter()
            .filter(|o| o.status.is_open())
            .collect::<Vec<_>>()
    };
    let open_now = settle("the stop Rithmic placed as B1-S", open, |all| {
        all.iter()
            .any(|o| o.role == OrderRole::StopLoss && o.broker_order_id.as_deref() == Some("B1-S"))
    })
    .await;
    assert_eq!(open_now.len(), 1, "{open_now:?}");
    let stop = &open_now[0];
    assert_eq!(stop.id.as_str(), format!("{}-sl", entry.id));
    assert_eq!(stop.parent_id.as_ref(), Some(&entry.id));
    assert!(stop.request.reduce_only);

    let changes = OrderChanges {
        stop_price: Some(Price(Decimal::new(20_005, 0))),
        ..OrderChanges::default()
    };
    d.guarded
        .modify(&d.account, &stop.id, changes)
        .await
        .unwrap();
    d.order_settles("the stop moved past the entry to 20,005", &stop.id, |o| {
        o.request.stop_price == Some(Price(Decimal::new(20_005, 0)))
    })
    .await;
    assert_eq!(*gw.orders.lock(), [330, 314]);
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resting_brackets_stop_moves_by_its_level() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let mut r = d.limit(Side::Buy, 1, "19000", "level-1");
    r.bracket = Some(Bracket {
        stop_loss: Some(Price(Decimal::new(18_990, 0))),
        take_profit: None,
        ..Bracket::default()
    });
    let entry = d.submit(r).await.unwrap();
    let stop = OrderId::new(format!("{}-sl", entry.id));
    for (to, ticks) in [(18_995, 20), (18_992, 32)] {
        let changes = OrderChanges {
            stop_price: Some(Price(Decimal::new(to, 0))),
            ..OrderChanges::default()
        };
        let moved = d.guarded.modify(&d.account, &stop, changes).await.unwrap();
        assert_eq!(moved.request.stop_price, Some(Price(Decimal::new(to, 0))));
        assert_eq!(
            gw.stop_levels.lock().last().copied().unwrap().1,
            Some(ticks)
        );
    }
    assert_eq!(
        *gw.stop_levels.lock(),
        [(Some(40), Some(20)), (Some(20), Some(32))]
    );
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resting_brackets_entry_moved_carries_its_held_legs_and_their_levels_count_from_it() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let mut r = d.limit(Side::Buy, 1, "19000", "carry-1");
    r.bracket = Some(Bracket {
        stop_loss: Some(Price(Decimal::new(18_990, 0))),
        take_profit: Some(Price(Decimal::new(19_020, 0))),
        ..Bracket::default()
    });
    let entry = d.submit(r).await.unwrap();
    let changes = OrderChanges {
        limit_price: Some(Price(Decimal::new(19_005, 0))),
        ..OrderChanges::default()
    };
    d.guarded
        .modify(&d.account, &entry.id, changes)
        .await
        .unwrap();
    let stop = OrderId::new(format!("{}-sl", entry.id));
    let target = OrderId::new(format!("{}-tp", entry.id));
    settle(
        "the held legs carried with their entry",
        || {
            (
                d.broker.order_of(&stop).and_then(|o| o.request.stop_price),
                d.broker
                    .order_of(&target)
                    .and_then(|o| o.request.limit_price),
            )
        },
        |legs| {
            *legs
                == (
                    Some(Price(Decimal::new(18_995, 0))),
                    Some(Price(Decimal::new(19_025, 0))),
                )
        },
    )
    .await;

    let changes = OrderChanges {
        stop_price: Some(Price(Decimal::new(18_997, 0))),
        ..OrderChanges::default()
    };
    d.guarded.modify(&d.account, &stop, changes).await.unwrap();
    assert_eq!(
        *gw.stop_levels.lock(),
        [(Some(40), Some(32))],
        "8 points under the entry it rests at"
    );
    d.shutdown().await;
}

#[tokio::test]
async fn a_resting_brackets_entry_moved_past_its_target_carries_its_held_legs_the_same_distance() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let mut r = d.limit(Side::Buy, 1, "19000", "carry-past");
    r.bracket = Some(Bracket {
        stop_loss: Some(Price(Decimal::new(18_990, 0))),
        take_profit: Some(Price(Decimal::new(19_020, 0))),
        ..Bracket::default()
    });
    let entry = d.submit(r).await.unwrap();
    let changes = OrderChanges {
        limit_price: Some(Price(Decimal::new(19_030, 0))),
        ..OrderChanges::default()
    };
    d.guarded
        .modify(&d.account, &entry.id, changes)
        .await
        .unwrap();
    let stop = OrderId::new(format!("{}-sl", entry.id));
    let target = OrderId::new(format!("{}-tp", entry.id));
    settle(
        "the held legs carried with their entry",
        || {
            (
                d.broker.order_of(&stop).and_then(|o| o.request.stop_price),
                d.broker
                    .order_of(&target)
                    .and_then(|o| o.request.limit_price),
            )
        },
        |legs| {
            *legs
                == (
                    Some(Price(Decimal::new(19_020, 0))),
                    Some(Price(Decimal::new(19_050, 0))),
                )
        },
    )
    .await;
    d.shutdown().await;
}

fn placed_legs(d: &Desk, entry: &OrderId) -> Option<(Order, Order)> {
    let all = d.broker.orders(&d.account).now_or_never_orders();
    let leg = |role| {
        all.iter()
            .find(|o| {
                o.role == role
                    && o.parent_id.as_ref() == Some(entry)
                    && o.broker_order_id.is_some()
                    && o.status == OrderStatus::Working
            })
            .cloned()
    };
    Some((leg(OrderRole::StopLoss)?, leg(OrderRole::TakeProfit)?))
}

async fn legs_placed(d: &Desk, entry: &OrderId) -> (Order, Order) {
    settle(
        "the bracket's legs placed",
        || placed_legs(d, entry),
        Option::is_some,
    )
    .await
    .unwrap()
}

fn mnq_bracket() -> Option<Bracket> {
    Some(Bracket {
        stop_loss: Some(Price(Decimal::new(19_990, 0))),
        take_profit: Some(Price(Decimal::new(2_002_025, 2))),
        ..Bracket::default()
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_placed_legs_quantity_shrinks_by_a_modify_and_never_grows_past_the_position() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let mut r = d.limit(Side::Buy, 2, "20000", "qty-1");
    r.bracket = mnq_bracket();
    let entry = d.submit(r).await.unwrap();
    let (stop, _) = legs_placed(&d, &entry.id).await;
    d.position_settles(Some(2)).await;
    assert_eq!(stop.request.qty, Qty::from(2));
    let (desk, stop) = (&d, &stop);
    let resize = |qty: i64| async move {
        let d = desk;
        let changes = OrderChanges {
            qty: Some(Qty::from(qty)),
            ..OrderChanges::default()
        };
        d.guarded.modify(&d.account, &stop.id, changes).await
    };
    let r = resize(3).await;
    assert!(matches!(r, Err(BrokerError::Rejected(_))), "{r:?}");
    assert_eq!(
        *gw.orders.lock(),
        [330],
        "a stop over the position is never sent"
    );
    resize(1).await.unwrap();
    d.order_settles("the stop shrunk to 1 where it was", &stop.id, |o| {
        o.request.qty == Qty::from(1)
            && o.request.stop_price == Some(Price(Decimal::new(19_990, 0)))
    })
    .await;
    assert_eq!(*gw.orders.lock(), [330, 314]);
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn in_grow_mode_an_add_goes_without_legs_and_the_bracket_grows_to_the_position() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let manager = ProtectionManager::new(
        Arc::clone(&d.guarded),
        Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
    );
    manager.set_mode(ProtectionMode::Grow);
    let tasks = manager.start();
    let mut r = d.limit(Side::Buy, 2, "20000", "grow-1");
    r.bracket = mnq_bracket();
    let shaped = manager.shape(&r).await;
    assert_eq!(shaped.send.bracket, r.bracket, "flat: its own legs");
    let entry = d.submit(shaped.send).await.unwrap();
    legs_placed(&d, &entry.id).await;
    d.position_settles(Some(2)).await;
    let add = OrderRequest {
        order_type: OrderType::Market,
        limit_price: None,
        bracket: mnq_bracket(),
        ..d.limit(Side::Buy, 1, "20000", "grow-2")
    };
    let shaped = manager.shape(&add).await;
    assert!(shaped.send.bracket.is_none(), "an add goes without legs");
    assert_eq!(shaped.intent, mnq_bracket());
    let sent = d.submit(shaped.send).await.unwrap();
    manager.remember(&sent, shaped.intent.unwrap());
    let (stop, target) = settle(
        "the bracket grown to the position of 3",
        || placed_legs(&d, &entry.id),
        |legs| {
            legs.as_ref().is_some_and(|(s, t)| {
                s.request.qty == Qty::from(3) && t.request.qty == Qty::from(3)
            })
        },
    )
    .await
    .unwrap();
    assert_eq!(
        stop.request.stop_price,
        Some(Price(Decimal::new(19_990, 0)))
    );
    assert_eq!(
        target.request.limit_price,
        Some(Price(Decimal::new(2_002_025, 2)))
    );
    assert_eq!(*gw.orders.lock(), [330, 312, 314, 314]);
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_filled_adds_legs_go_as_one_oco_group_under_it() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let add = OrderRequest {
        order_type: OrderType::Market,
        limit_price: None,
        ..d.limit(Side::Buy, 2, "20000", "oco-1")
    };
    let add = d.submit(add).await.unwrap();
    d.status_settles(&add.id, OrderStatus::Filled).await;
    let b = mnq_bracket().unwrap();
    let legs = d
        .guarded
        .attach(&d.account, &add.id, b, Qty::from(2))
        .await
        .unwrap();
    assert_eq!(legs.len(), 2);
    assert_eq!(*gw.orders.lock(), [312, 328]);
    let (stop, target) = legs_placed(&d, &add.id).await;
    assert_eq!(stop.request.stop_price, b.stop_loss);
    assert_eq!(target.request.limit_price, b.take_profit);
    assert!(stop.request.reduce_only && target.request.side == Side::Sell);
    assert_eq!(stop.request.qty, Qty::from(2));
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn breakeven_moves_the_positions_stop_by_a_modify() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let manager = ProtectionManager::new(
        Arc::clone(&d.guarded),
        Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
    );
    let mut r = d.limit(Side::Buy, 2, "20000", "be-1");
    r.bracket = mnq_bracket();
    let entry = d.submit(r).await.unwrap();
    let (stop, _) = legs_placed(&d, &entry.id).await;
    d.position_settles(Some(2)).await;
    let instrument = symbols::instrument_id("MNQZ6", "CME");
    let (_, spec) = d.market.spec(&instrument).await.unwrap();
    let at = |bid: &str, ask: &str| BreakevenAsk {
        spec: spec.clone(),
        offset_ticks: Some(4),
        touch: Touch {
            bid: Some(Price(bid.parse().unwrap())),
            ask: Some(Price(ask.parse().unwrap())),
            last: Some(Price(bid.parse().unwrap())),
        },
    };
    let e = manager
        .breakeven(&d.account, &instrument, &at("20000.75", "20001"), true)
        .await
        .unwrap_err();
    assert_eq!(
        e,
        BrokerError::Rejected(
            "Price hasn't passed breakeven (20,001.00, the entry + 4 ticks) yet; the stop stays \
             at 19,990.00."
                .into()
        )
    );
    assert_eq!(*gw.orders.lock(), [330]);
    let done = manager
        .breakeven(&d.account, &instrument, &at("20010", "20010.25"), true)
        .await
        .unwrap();
    assert_eq!(done.plan.price, Price(Decimal::new(2_000_100, 2)));
    d.order_settles("the stop at breakeven, 20,001", &stop.id, |o| {
        o.request.stop_price == Some(Price(Decimal::new(20_001, 0)))
    })
    .await;
    assert_eq!(*gw.orders.lock(), [330, 314]);
    d.shutdown().await;
}

fn px(s: &str) -> Price {
    Price(s.parse().unwrap())
}

fn ruled_request(d: &Desk, tag: &str) -> OrderRequest {
    let mut r = d.limit(Side::Buy, 2, "20000", tag);
    r.bracket = Some(Bracket {
        breakeven: Some(BreakevenRule {
            trigger_ticks: 8,
            offset_ticks: 1,
        }),
        trail: Some(TrailRule {
            distance_ticks: 12,
            trigger_ticks: 20,
            step_ticks: 2,
        }),
        ..mnq_bracket().unwrap()
    });
    r
}

#[derive(Debug, PartialEq)]
struct RuledStop {
    moves: usize,
    stop: Option<Price>,
    resting: Option<f64>,
    sent: Vec<i32>,
}

impl RuledStop {
    fn landed(&self) -> bool {
        self.stop.map(|p| p.to_f64()) == self.resting
    }
}

struct Ruled<'a> {
    d: &'a Desk,
    gw: &'a Gateway,
    manager: Arc<ProtectionManager>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    audit: Arc<MemoryObserver>,
    stop: Order,
    instrument: tessera_core::InstrumentId,
    spec: tessera_core::instrument::ContractSpec,
}

impl<'a> Ruled<'a> {
    async fn place(d: &'a Desk, gw: &'a Gateway, r: OrderRequest) -> Self {
        let manager = ProtectionManager::new(
            Arc::clone(&d.guarded),
            Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
        );
        let audit = Arc::new(MemoryObserver::default());
        manager.set_audit(Arc::clone(&audit) as Arc<dyn tessera_tools::ToolObserver>);
        let tasks = manager.start();
        let entry = d.submit(r).await.unwrap();
        let (stop, _) = legs_placed(d, &entry.id).await;
        let instrument = symbols::instrument_id("MNQZ6", "CME");
        let (_, spec) = d.market.spec(&instrument).await.unwrap();
        settle(
            "the stop's rules watched",
            || manager.rule_instruments(),
            |watched| *watched == [instrument.clone()],
        )
        .await;
        Self {
            d,
            gw,
            manager,
            tasks,
            audit,
            stop,
            instrument,
            spec,
        }
    }

    fn trade(&self, price: &str) {
        self.manager
            .on_trade(&self.instrument, &self.spec, px(price));
    }

    fn now(&self) -> RuledStop {
        let basket = self.stop.broker_order_id.as_deref();
        RuledStop {
            moves: self
                .audit
                .finished
                .lock()
                .iter()
                .filter(|r| r.input["mode"] == "rules")
                .count(),
            stop: self
                .d
                .broker
                .order_of(&self.stop.id)
                .and_then(|o| o.request.stop_price),
            resting: self
                .gw
                .book
                .lock()
                .iter()
                .find(|h| Some(h.basket.as_str()) == basket)
                .and_then(|h| h.trigger),
            sent: self.gw.orders.lock().clone(),
        }
    }

    async fn moved(&self, what: &str, moves: usize) -> RuledStop {
        settle(what, || self.now(), |s| s.moves >= moves && s.landed()).await
    }

    fn finish(self) {
        for t in self.tasks {
            t.abort();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tessera_moves_a_rithmic_stop_to_breakeven_and_then_trails_it_by_modifies() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let r = ruled_request(&d, "rules-1");
    let preview = d.broker.preview(&r).await.unwrap();
    assert!(preview.passes(), "{:?}", preview.checks);
    assert!(
        preview
            .checks
            .iter()
            .any(|c| c.code == "stop_rules_held" && c.severity == CheckSeverity::Info)
    );
    let ruled = Ruled::place(&d, &gw, r).await;
    let rules = ruled.stop.stop_rules.expect("the stop carries its rules");
    assert_eq!(rules.entry_price, Some(px("20000")));
    assert_eq!(rules.trail.map(|t| t.step_ticks), Some(2));

    ruled.trade("20002");
    assert_eq!(
        ruled.moved("breakeven: the entry + 1 tick", 1).await,
        RuledStop {
            moves: 1,
            stop: Some(px("20000.25")),
            resting: Some(20_000.25),
            sent: vec![330, 314],
        }
    );

    tokio::time::sleep(RULE_GAP).await;
    ruled.trade("20004.75");
    ruled.trade("20006");
    assert_eq!(
        ruled
            .moved(
                "under the trail's 20 ticks nothing moves; at 24 the stop trails toward 12 ticks \
                 behind 20,006 in whole 2-tick steps",
                2
            )
            .await,
        RuledStop {
            moves: 2,
            stop: Some(px("20002.75")),
            resting: Some(20_002.75),
            sent: vec![330, 314, 314],
        }
    );

    tokio::time::sleep(RULE_GAP).await;
    ruled.trade("20003");
    ruled.trade("20007");
    assert_eq!(
        ruled
            .moved(
                "only tighter: 20,003 leaves the stop and 20,007 trails it one step on",
                3
            )
            .await,
        RuledStop {
            moves: 3,
            stop: Some(px("20003.75")),
            resting: Some(20_003.75),
            sent: vec![330, 314, 314, 314],
        }
    );
    ruled.finish();
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rithmic_stop_stays_seven_ticks_up_and_trails_past_breakeven_at_twenty() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let ruled = Ruled::place(&d, &gw, ruled_request(&d, "rules-2")).await;
    ruled.trade("20001.75");
    ruled.trade("20005");
    assert_eq!(
        ruled
            .moved(
                "7 ticks up nothing moves, so 20 ticks up finds the stop free and trails it past \
                 breakeven",
                1
            )
            .await,
        RuledStop {
            moves: 1,
            stop: Some(px("20002")),
            resting: Some(20_002.0),
            sent: vec![330, 314],
        }
    );
    ruled.finish();
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_mnq_order_over_the_reported_buy_limit_goes_and_rithmics_own_refusal_reaches_the_trader()
{
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let five = d.limit(Side::Buy, 5, "19000", "cap-1");
    let p = d.broker.preview(&five).await.unwrap();
    assert!(p.passes(), "{:?}", p.checks);
    assert!(
        p.checks.iter().any(|c| c.code == "max_position"
            && c.message
                .starts_with("Rithmic reports an account buy limit of 4;")),
        "{:?}",
        p.checks
    );
    let o = d.submit(five).await.unwrap();
    assert!(o.status.is_open(), "{o:?}");
    let six = d.limit(Side::Buy, 6, "19000", "cap-2");
    assert!(d.broker.preview(&six).await.unwrap().passes());
    assert_eq!(
        d.submit(six).await,
        Err(BrokerError::Rejected(
            "Rithmic refused it: Order rejected: max order quantity exceeded.".into()
        ))
    );
    assert!(
        d.broker
            .orders(&d.account)
            .await
            .unwrap()
            .iter()
            .all(|o| o.request.qty != Qty::from(6)),
        "nothing of the refused order is shown as sent"
    );
    assert_eq!(*gw.orders.lock(), [312, 312]);
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reverse_closes_then_enters_the_other_side_in_two_orders_the_firm_takes() {
    use tessera_broker::orders::OrdersService;
    use tessera_broker::orders::io::ReverseInput;
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let entry = OrderRequest {
        order_type: OrderType::Market,
        limit_price: None,
        ..d.limit(Side::Buy, 3, "20000", "rev-1")
    };
    let entry = d.submit(entry).await.unwrap();
    d.status_settles(&entry.id, OrderStatus::Filled).await;
    let b = mnq_bracket().unwrap();
    d.guarded
        .attach(&d.account, &entry.id, b, Qty::from(3))
        .await
        .unwrap();
    let (stop, target) = legs_placed(&d, &entry.id).await;
    settle("Rithmic holding 3 long", || gw.net(), |n| *n == 3).await;
    let service = OrdersService::new(
        Arc::clone(&d.guarded),
        Arc::clone(&d.market) as Arc<dyn MarketDataProvider>,
        Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
    );
    let instrument = symbols::instrument_id("MNQZ6", "CME");
    let out = service
        .reverse(
            &ReverseInput {
                account_id: d.account.to_string(),
                instrument: instrument.to_string(),
                bracket: None,
            },
            None,
        )
        .await
        .unwrap();
    assert!(
        out.summary.starts_with("Reversed long 3 MNQZ6 to short 3"),
        "{}",
        out.summary
    );
    settle("Rithmic holding 3 short", || gw.net(), |n| *n == -3).await;
    let sent = gw.orders.lock().clone();
    assert_eq!(sent, [312, 328, 316, 316, 312, 312], "{sent:?}");
    for leg in [&stop.id, &target.id] {
        d.status_settles(leg, OrderStatus::Cancelled).await;
    }
    assert!(out.closing.request.reduce_only);
    assert_eq!(out.closing.request.qty, Qty::from(3));
    assert_eq!(
        (out.entry.request.side, out.entry.request.qty),
        (Side::Sell, Qty::from(3))
    );
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_moved_stop_that_fills_leaves_no_working_target() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let mut r = d.limit(Side::Buy, 1, "20000", "trail-1");
    r.bracket = mnq_bracket();
    let entry = d.submit(r).await.unwrap();
    let (stop, target) = legs_placed(&d, &entry.id).await;
    d.position_settles(Some(1)).await;
    let changes = OrderChanges {
        stop_price: Some(Price(Decimal::new(19_995, 0))),
        ..OrderChanges::default()
    };
    d.guarded
        .modify(&d.account, &stop.id, changes)
        .await
        .unwrap();
    let basket = d
        .broker
        .order_of(&stop.id)
        .and_then(|o| o.broker_order_id)
        .expect("the stop Rithmic placed");
    gw.fill_open(&basket);
    d.status_settles(&stop.id, OrderStatus::Filled).await;
    d.position_settles(None).await;
    assert_eq!(
        d.broker.order_of(&target.id).map(|o| o.status),
        Some(OrderStatus::Working),
        "the mock leaves the target, as a firm that dropped OCO after the stop moved"
    );
    let manager = ProtectionManager::new(
        Arc::clone(&d.guarded),
        Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
    );
    manager.set_mode(ProtectionMode::PerEntry);
    let tasks = manager.start();
    let mut notes = manager.notes();
    d.order_settles("the leftover target closed", &target.id, |o| {
        !o.status.is_open()
    })
    .await;
    assert_eq!(
        first_note(&mut notes, |n| n.text).await,
        "Cancelled the target: the position is flat"
    );
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_moved_stop_fill_cancels_its_target_while_protection_is_running() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let manager = ProtectionManager::new(
        Arc::clone(&d.guarded),
        Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
    );
    manager.set_mode(ProtectionMode::PerEntry);
    let tasks = manager.start();
    let mut notes = manager.notes();
    let mut r = d.limit(Side::Buy, 1, "20000", "trail-run");
    r.bracket = mnq_bracket();
    let entry = d.submit(r).await.unwrap();
    let (stop, target) = legs_placed(&d, &entry.id).await;
    d.position_settles(Some(1)).await;
    let changes = OrderChanges {
        stop_price: Some(Price(Decimal::new(19_995, 0))),
        ..OrderChanges::default()
    };
    d.guarded
        .modify(&d.account, &stop.id, changes)
        .await
        .unwrap();
    let basket = d
        .broker
        .order_of(&stop.id)
        .and_then(|o| o.broker_order_id)
        .expect("the stop Rithmic placed");
    gw.fill_open(&basket);
    d.order_settles("the leftover target closed", &target.id, |o| {
        !o.status.is_open()
    })
    .await;
    assert_eq!(
        first_note(&mut notes, |n| n.text).await,
        "Cancelled the target: the position is flat"
    );
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

fn protect(
    d: &Desk,
    mode: ProtectionMode,
) -> (Arc<ProtectionManager>, Vec<tokio::task::JoinHandle<()>>) {
    let manager = ProtectionManager::new(
        Arc::clone(&d.guarded),
        Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
    );
    manager.set_mode(mode);
    let tasks = manager.start();
    (manager, tasks)
}

fn left(d: &Desk, id: &OrderId) -> Option<Qty> {
    d.broker
        .order_of(id)
        .filter(|o| o.status.is_open())
        .map(|o| o.remaining())
}

fn basket_of(d: &Desk, id: &OrderId) -> String {
    d.broker
        .order_of(id)
        .and_then(|o| o.broker_order_id)
        .expect("an order Rithmic placed")
}

async fn first_note<T: Clone>(
    notes: &mut broadcast::Receiver<T>,
    text: impl Fn(T) -> String,
) -> String {
    let mut heard: Vec<String> = Vec::new();
    settle(
        "a protection note",
        || {
            while let Ok(n) = notes.try_recv() {
                heard.push(text(n));
            }
            heard.clone()
        },
        |said| !said.is_empty(),
    )
    .await
    .remove(0)
}

#[derive(Debug, PartialEq)]
struct Closing {
    position: Option<Qty>,
    stop: Option<Qty>,
    target: Option<Qty>,
}

impl Closing {
    const FLAT: Self = Self {
        position: None,
        stop: None,
        target: None,
    };

    async fn now(d: &Desk, [stop, target]: [&OrderId; 2]) -> Self {
        Self {
            position: d.position().await,
            stop: left(d, stop),
            target: left(d, target),
        }
    }
}

async fn flat_with_no_working_leg(d: &Desk, legs: [&OrderId; 2]) {
    settle_async(
        "flat with no working leg",
        || Closing::now(d, legs),
        |c| *c == Closing::FLAT,
    )
    .await;
}

struct ByHand {
    manager: Arc<ProtectionManager>,
    events: Mutex<futures::stream::BoxStream<'static, BrokerEvent>>,
    observed: Mutex<tokio::time::Instant>,
}

impl ByHand {
    fn new(d: &Desk, mode: ProtectionMode) -> Self {
        let manager = ProtectionManager::new(
            Arc::clone(&d.guarded),
            Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
        );
        manager.set_mode(mode);
        Self {
            manager,
            events: Mutex::new(d.broker.events()),
            observed: Mutex::new(tokio::time::Instant::now()),
        }
    }

    fn observe(&self) {
        let mut events = self.events.lock();
        while let Some(Some(e)) = futures::FutureExt::now_or_never(events.next()) {
            self.manager.observe(&e);
            *self.observed.lock() = tokio::time::Instant::now();
        }
    }

    async fn turn(&self) {
        self.observe();
        self.manager.run_due().await;
    }

    async fn turn_after_quiet(&self, quiet: Duration) {
        self.observe();
        let since = *self.observed.lock();
        tokio::time::sleep_until(since + quiet).await;
        self.turn().await;
    }
}

async fn native_bracket_of_two(d: &Desk, tag: &str) -> (Order, Order) {
    let mut r = d.limit(Side::Buy, 2, "20000", tag);
    r.bracket = mnq_bracket();
    let entry = d.submit(r).await.unwrap();
    let legs = legs_placed(d, &entry.id).await;
    d.position_settles(Some(2)).await;
    legs
}

async fn attached_oco_of_two(d: &Desk, tag: &str) -> (Order, Order) {
    let add = OrderRequest {
        order_type: OrderType::Market,
        limit_price: None,
        ..d.limit(Side::Buy, 2, "20000", tag)
    };
    let add = d.submit(add).await.unwrap();
    d.status_settles(&add.id, OrderStatus::Filled).await;
    d.position_settles(Some(2)).await;
    let b = mnq_bracket().unwrap();
    d.guarded
        .attach(&d.account, &add.id, b, Qty::from(2))
        .await
        .unwrap();
    legs_placed(d, &add.id).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_native_brackets_target_filled_in_part_shrinks_its_stop_and_the_stop_closes_flat() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let (_manager, tasks) = protect(&d, ProtectionMode::PerEntry);
    let (stop, target) = native_bracket_of_two(&d, "part-tp").await;
    gw.hold_pnl();
    gw.fill_some(&basket_of(&d, &target.id), 1);
    settle(
        "the stop shrunk to what its pair left",
        || left(&d, &stop.id),
        |q| *q == Some(Qty::from(1)),
    )
    .await;
    assert_eq!(left(&d, &target.id), Some(Qty::from(1)));
    assert_eq!(
        d.position().await,
        Some(Qty::from(1)),
        "the position counts the fill before the PnL plant shows it"
    );
    gw.release_pnl();
    gw.fill_open(&basket_of(&d, &stop.id));
    flat_with_no_working_leg(&d, [&stop.id, &target.id]).await;
    assert_eq!(gw.net(), 0, "the stop closed the rest and opened nothing");
    assert_eq!(*gw.orders.lock(), [330, 314, 316]);
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bracket_whose_legs_name_neither_entry_nor_tag_still_shrinks_its_stop_to_a_part_filled_target()
 {
    let gw = Gateway::start().await;
    gw.anonymous_legs.store(true, Ordering::SeqCst);
    let d = desk(&gw).await;
    d.turn_on();
    let (_manager, tasks) = protect(&d, ProtectionMode::PerEntry);
    let (stop, target) = native_bracket_of_two(&d, "part-anon").await;
    gw.hold_pnl();
    gw.fill_some(&basket_of(&d, &target.id), 1);
    settle(
        "the stop shrunk to what its pair left",
        || left(&d, &stop.id),
        |q| *q == Some(Qty::from(1)),
    )
    .await;
    gw.release_pnl();
    gw.fill_open(&basket_of(&d, &stop.id));
    flat_with_no_working_leg(&d, [&stop.id, &target.id]).await;
    assert_eq!(gw.net(), 0);
    assert_eq!(*gw.orders.lock(), [330, 314, 316]);
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_native_brackets_stop_filled_in_part_shrinks_its_target_and_the_target_closes_flat() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let (_manager, tasks) = protect(&d, ProtectionMode::PerEntry);
    let (stop, target) = native_bracket_of_two(&d, "part-sl").await;
    gw.hold_pnl();
    gw.fill_some(&basket_of(&d, &stop.id), 1);
    settle(
        "the target shrunk to what its pair left",
        || left(&d, &target.id),
        |q| *q == Some(Qty::from(1)),
    )
    .await;
    assert_eq!(left(&d, &stop.id), Some(Qty::from(1)));
    gw.release_pnl();
    gw.fill_open(&basket_of(&d, &target.id));
    flat_with_no_working_leg(&d, [&stop.id, &target.id]).await;
    assert_eq!(gw.net(), 0);
    assert_eq!(*gw.orders.lock(), [330, 314, 316]);
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn in_grow_mode_a_native_brackets_stop_stays_at_what_its_target_left_while_the_pnl_lags() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let hand = ByHand::new(&d, ProtectionMode::Grow);
    let mut notes = hand.manager.notes();
    let (stop, target) = native_bracket_of_two(&d, "part-grow").await;
    let legs = [&stop.id, &target.id];
    gw.hold_pnl();
    gw.fill_some(&basket_of(&d, &target.id), 1);
    let (by_hand, desk) = (&hand, &d);
    settle_async(
        "the stop shrunk to what its target left",
        || async move {
            by_hand.turn().await;
            Closing::now(desk, legs).await
        },
        |c| c.stop == Some(Qty::from(1)),
    )
    .await;
    assert_eq!(
        first_note(&mut notes, |n| n.text).await,
        "Shrank the stop to 1 as its pair filled in part"
    );
    hand.turn_after_quiet(STALE_AFTER).await;
    assert_eq!(
        Closing::now(&d, legs).await,
        Closing {
            position: Some(Qty::from(1)),
            stop: Some(Qty::from(1)),
            target: Some(Qty::from(1)),
        },
        "the position reads what the fills left once its reading is stale"
    );
    assert_eq!(*gw.orders.lock(), [330, 314], "nothing grew the legs back");
    assert!(notes.try_recv().is_err(), "nothing grew the legs back");
    gw.release_pnl();
    gw.fill_open(&basket_of(&d, &stop.id));
    settle_async(
        "flat with no working leg",
        || async move {
            by_hand.turn().await;
            Closing::now(desk, legs).await
        },
        |c| *c == Closing::FLAT,
    )
    .await;
    assert_eq!(gw.net(), 0);
    assert_eq!(*gw.orders.lock(), [330, 314, 316]);
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_attached_oco_target_filled_in_part_shrinks_its_stop_and_the_stop_closes_flat() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let (_manager, tasks) = protect(&d, ProtectionMode::PerEntry);
    let (stop, target) = attached_oco_of_two(&d, "part-oco").await;
    gw.hold_pnl();
    gw.fill_some(&basket_of(&d, &target.id), 1);
    settle(
        "the stop shrunk to what its pair left",
        || left(&d, &stop.id),
        |q| *q == Some(Qty::from(1)),
    )
    .await;
    assert_eq!(left(&d, &target.id), Some(Qty::from(1)));
    gw.release_pnl();
    gw.fill_open(&basket_of(&d, &stop.id));
    flat_with_no_working_leg(&d, [&stop.id, &target.id]).await;
    assert_eq!(gw.net(), 0);
    assert_eq!(
        *gw.orders.lock(),
        [312, 328, 314],
        "Rithmic cancels the group's other leg itself"
    );
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_attached_oco_stop_filled_in_part_shrinks_its_target_and_the_target_closes_flat() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let (_manager, tasks) = protect(&d, ProtectionMode::PerEntry);
    let (stop, target) = attached_oco_of_two(&d, "part-oco-sl").await;
    gw.hold_pnl();
    gw.fill_some(&basket_of(&d, &stop.id), 1);
    settle(
        "the target shrunk to what its pair left",
        || left(&d, &target.id),
        |q| *q == Some(Qty::from(1)),
    )
    .await;
    assert_eq!(left(&d, &stop.id), Some(Qty::from(1)));
    gw.release_pnl();
    gw.fill_open(&basket_of(&d, &target.id));
    flat_with_no_working_leg(&d, [&stop.id, &target.id]).await;
    assert_eq!(gw.net(), 0);
    assert_eq!(
        *gw.orders.lock(),
        [312, 328, 314],
        "Rithmic cancels the group's other leg itself"
    );
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_exit_sent_while_the_pnl_still_shows_the_closed_position_opens_nothing() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    d.filled(d.market(Side::Buy, 1, "in")).await;
    d.position_settles(Some(1)).await;
    gw.hold_pnl();
    d.filled(d.market(Side::Sell, 1, "out")).await;
    assert_eq!(gw.net(), 0);
    let r = d.submit(d.exit(Side::Sell, 1, "late-close")).await;
    assert!(matches!(r, Err(BrokerError::Rejected(_))), "{r:?}");
    assert_eq!(gw.net(), 0, "the exit opened nothing");
    assert_eq!(
        d.position().await,
        None,
        "the sell shows before the P&L does"
    );
    gw.release_pnl();
    d.position_settles(None).await;
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_exit_larger_than_what_is_left_closes_only_what_is_left() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    d.filled(d.market(Side::Buy, 2, "in")).await;
    d.position_settles(Some(2)).await;
    gw.hold_pnl();
    d.filled(d.market(Side::Sell, 1, "part")).await;
    let closed = d.filled(d.exit(Side::Sell, 2, "rest")).await;
    assert_eq!(closed.request.qty, Qty::from(1));
    assert_eq!(gw.net(), 0, "flat, not short");
    gw.release_pnl();
    d.position_settles(None).await;
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_position_reads_flat_when_rithmic_leaves_out_the_flat_quantity() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    gw.leave_flat_unsaid();
    d.filled(d.market(Side::Buy, 1, "in")).await;
    d.position_settles(Some(1)).await;
    d.filled(d.market(Side::Sell, 1, "out")).await;
    d.position_settles(None).await;
    let r = d.submit(d.exit(Side::Sell, 1, "late-close")).await;
    assert!(matches!(r, Err(BrokerError::Rejected(_))), "{r:?}");
    assert_eq!(gw.net(), 0);
    d.filled(d.market(Side::Buy, 2, "again")).await;
    d.position_settles(Some(2)).await;
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exits_are_sized_from_the_fills_and_never_ask_rithmic_for_another_pnl_snapshot() {
    use tessera_broker::orders::io::AccountScopeInput;
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    assert_eq!(gw.pnl_snapshots.load(Ordering::SeqCst), 1, "one at login");

    d.filled(d.market(Side::Buy, 3, "in")).await;
    d.position_settles(Some(3)).await;
    gw.hold_pnl();
    let part = d.filled(d.exit(Side::Sell, 1, "part")).await;
    assert_eq!(part.request.qty, Qty::from(1));
    let rest = d.filled(d.exit(Side::Sell, 5, "rest")).await;
    assert_eq!(
        rest.request.qty,
        Qty::from(2),
        "sized from the fills the P&L has not shown"
    );
    let r = d.submit(d.exit(Side::Sell, 1, "late")).await;
    assert!(matches!(r, Err(BrokerError::Rejected(_))), "{r:?}");
    assert_eq!(gw.net(), 0, "flat, not short");
    gw.release_pnl();
    d.position_settles(None).await;

    d.filled(d.market(Side::Buy, 1, "again")).await;
    d.position_settles(Some(1)).await;
    let out = service(&d)
        .flatten(&AccountScopeInput {
            account_id: d.account.to_string(),
            instrument: None,
        })
        .await
        .unwrap();
    assert!(out.flat, "{out:?}");
    assert_eq!(gw.net(), 0);

    assert_eq!(
        gw.pnl_snapshots.load(Ordering::SeqCst),
        1,
        "exits read the position Tessera already holds; Rithmic sends updates"
    );
    d.shutdown().await;
}

fn service(d: &Desk) -> tessera_broker::orders::OrdersService {
    tessera_broker::orders::OrdersService::new(
        Arc::clone(&d.guarded),
        Arc::clone(&d.market) as Arc<dyn MarketDataProvider>,
        Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_flatten_after_the_trader_got_out_while_the_pnl_lags_sends_nothing() {
    use tessera_broker::orders::io::AccountScopeInput;
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    d.filled(d.market(Side::Buy, 1, "in")).await;
    d.position_settles(Some(1)).await;
    gw.hold_pnl();
    d.filled(d.market(Side::Sell, 1, "out")).await;
    let out = service(&d)
        .flatten(&AccountScopeInput {
            account_id: d.account.to_string(),
            instrument: None,
        })
        .await
        .unwrap();
    assert!(out.closing.is_empty(), "{:?}", out.closing);
    assert!(out.flat);
    assert_eq!(gw.net(), 0);
    assert_eq!(*gw.orders.lock(), [312, 312]);
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_loss_lockout_flattens_once_from_a_fresh_read_and_never_sells_a_closed_position() {
    use tessera_broker::orders::LossWatch;
    use tessera_core::limits::{LimitsSetting, RiskLimits};
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let clock = Arc::new(tessera_core::clock::ManualClock::new(
        tessera_core::time::Timestamp::now(),
    ));
    let svc = tessera_broker::orders::OrdersService::new(
        Arc::clone(&d.guarded),
        Arc::clone(&d.market) as Arc<dyn MarketDataProvider>,
        Arc::clone(&clock) as tessera_core::SharedClock,
    );
    svc.set_limits(LimitsSetting {
        every: RiskLimits {
            daily_loss_limit: Some(500.0),
            ..RiskLimits::default()
        },
        ..LimitsSetting::default()
    });
    d.filled(d.market(Side::Buy, 1, "in")).await;
    d.position_settles(Some(1)).await;
    gw.hold_pnl();
    d.filled(d.market(Side::Sell, 1, "out")).await;
    gw.report_day_pnl("-600.00");
    let _ = settle_async(
        "the day's loss reported",
        || async { d.broker.summary(&d.account).await.map(|s| s.day_pnl.amount) },
        |pnl| pnl.as_ref().is_ok_and(|p| *p == Decimal::new(-600, 0)),
    )
    .await;
    let LossWatch::Held { flat, fresh, .. } = svc.watch_loss_limit(&d.account).await else {
        panic!("over the $500 limit");
    };
    assert!(fresh);
    assert!(flat.is_none(), "flat already: nothing to flatten");
    assert_eq!(gw.net(), 0);
    for _ in 0..3 {
        clock.advance(11 * tessera_core::time::NANOS_PER_SEC);
        let _ = svc.watch_loss_limit(&d.account).await;
    }
    assert_eq!(gw.net(), 0, "the lockout opened nothing");
    assert_eq!(
        *gw.orders.lock(),
        [312, 312],
        "two orders, both the trader's"
    );
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_loss_lockout_closes_an_open_position_once_and_then_leaves_the_account_alone() {
    use tessera_broker::orders::LossWatch;
    use tessera_core::limits::{LimitsSetting, RiskLimits};
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let clock = Arc::new(tessera_core::clock::ManualClock::new(
        tessera_core::time::Timestamp::now(),
    ));
    let svc = tessera_broker::orders::OrdersService::new(
        Arc::clone(&d.guarded),
        Arc::clone(&d.market) as Arc<dyn MarketDataProvider>,
        Arc::clone(&clock) as tessera_core::SharedClock,
    );
    svc.set_limits(LimitsSetting {
        every: RiskLimits {
            daily_loss_limit: Some(500.0),
            ..RiskLimits::default()
        },
        ..LimitsSetting::default()
    });
    d.filled(d.market(Side::Buy, 1, "in")).await;
    d.position_settles(Some(1)).await;
    gw.hold_pnl();
    gw.report_day_pnl("-600.00");
    let _ = settle_async(
        "the day's loss reported",
        || async { d.broker.summary(&d.account).await.map(|s| s.day_pnl.amount) },
        |pnl| pnl.as_ref().is_ok_and(|p| *p == Decimal::new(-600, 0)),
    )
    .await;
    let LossWatch::Held { flat, .. } = svc.watch_loss_limit(&d.account).await else {
        panic!("over the $500 limit");
    };
    let flat = flat.expect("flattened at once");
    assert!(flat.result.is_ok(), "{:?}", flat.result);
    settle("Rithmic flat", || gw.net(), |n| *n == 0).await;
    let elsewhere = d
        .submit(d.limit(Side::Buy, 1, "19000", "r-trader"))
        .await
        .unwrap();
    d.status_settles(&elsewhere.id, OrderStatus::Working).await;
    for _ in 0..3 {
        clock.advance(11 * tessera_core::time::NANOS_PER_SEC);
        let LossWatch::Held { flat, .. } = svc.watch_loss_limit(&d.account).await else {
            panic!("still locked");
        };
        assert!(flat.is_none(), "one flatten per lock");
    }
    assert_eq!(gw.net(), 0, "the lockout opened nothing");
    assert_eq!(
        *gw.orders.lock(),
        [312, 312, 312],
        "an order placed after the flatten is left alone"
    );
    d.shutdown().await;
}

fn resting_exit(d: &Desk, order_type: OrderType, price: &str, tag: &str) -> OrderRequest {
    let at = Some(Price(price.parse().unwrap()));
    OrderRequest {
        order_type,
        limit_price: (order_type == OrderType::Limit).then_some(at).flatten(),
        stop_price: (order_type == OrderType::Stop).then_some(at).flatten(),
        reduce_only: true,
        ..d.limit(Side::Sell, 1, "20000", tag)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_positions_stop_and_target_go_to_rithmic_as_one_group_that_outlives_the_app() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    d.filled(d.market(Side::Buy, 1, "in")).await;
    d.position_settles(Some(1)).await;
    let stop = d
        .submit(resting_exit(&d, OrderType::Stop, "19990", "chart-sl"))
        .await
        .unwrap();
    d.status_settles(&stop.id, OrderStatus::Working).await;
    let target = d
        .submit(resting_exit(&d, OrderType::Limit, "20020", "chart-tp"))
        .await
        .unwrap();
    let target = d.status_settles(&target.id, OrderStatus::Working).await;
    assert_eq!(target.request.limit_price, Some(px("20020")));
    let working: Vec<Order> = d
        .broker
        .orders(&d.account)
        .await
        .unwrap()
        .into_iter()
        .filter(|o| o.status.is_open())
        .collect();
    assert_eq!(working.len(), 2, "{working:?}");
    let stop_now = working
        .iter()
        .find(|o| o.request.order_type == OrderType::Stop)
        .expect("the stop still works");
    assert_eq!(stop_now.request.stop_price, Some(px("19990")));
    assert!(working.iter().all(|o| o.request.reduce_only));
    let stop_basket = basket_of(&d, &stop_now.id);
    let target_basket = basket_of(&d, &target.id);
    assert_eq!(
        *gw.orders.lock(),
        [312, 312, 316, 328],
        "the lone stop is cancelled and goes out again with its target as one group"
    );
    d.shutdown().await;
    gw.fill_while_away(&target_basket);
    settle("the target filled at Rithmic", || gw.net(), |n| *n == 0).await;
    settle(
        "Rithmic cancelled the stop itself",
        || gw.working(&stop_basket),
        |w| !w,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stop_cancelled_to_be_linked_goes_back_alone_when_rithmic_refuses_the_group() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    d.filled(d.market(Side::Buy, 1, "in")).await;
    d.position_settles(Some(1)).await;
    let stop = d
        .submit(resting_exit(&d, OrderType::Stop, "19990", "chart-sl"))
        .await
        .unwrap();
    d.status_settles(&stop.id, OrderStatus::Working).await;
    gw.refuse_oco.store(true, Ordering::SeqCst);
    let r = d
        .submit(resting_exit(&d, OrderType::Limit, "20020", "chart-tp"))
        .await;
    assert!(matches!(r, Err(BrokerError::Rejected(_))), "{r:?}");
    assert_eq!(*gw.orders.lock(), [312, 312, 316, 328, 312]);
    settle(
        "a stop works at Rithmic again",
        || {
            gw.book
                .lock()
                .iter()
                .filter(|h| h.status == "open" && h.trigger == Some(19_990.0))
                .count()
        },
        |n| *n == 1,
    )
    .await;
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_brackets_legs_come_back_as_its_exits_after_a_restart() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let (stop, target) = native_bracket_of_two(&d, "restart").await;
    d.broker.shutdown().await;
    let again = RithmicBroker::connect(&d.market).await.unwrap();
    let back = settle_async(
        "the bracket's legs back",
        || async {
            again
                .orders(&d.account)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|o| o.status.is_open())
                .collect::<Vec<Order>>()
        },
        |v| v.len() == 2,
    )
    .await;
    let leg = |role: OrderRole| {
        back.iter()
            .find(|o| o.role == role)
            .unwrap_or_else(|| panic!("no {role:?} among {back:?}"))
    };
    let (sl, tp) = (leg(OrderRole::StopLoss), leg(OrderRole::TakeProfit));
    assert_eq!(sl.request.stop_price, stop.request.stop_price);
    assert_eq!(tp.request.limit_price, target.request.limit_price);
    assert!(sl.request.reduce_only && tp.request.reduce_only);
    assert!(sl.parent_id.is_some());
    assert_eq!(sl.parent_id, tp.parent_id, "one bracket");
    let guarded = Arc::new(GuardedBroker::new(
        Arc::new(again.clone()) as Arc<dyn BrokerProvider>
    ));
    guarded.set_account_order_entry(again.id(), &d.account, true);
    let manager = ProtectionManager::new(
        Arc::clone(&guarded),
        Arc::new(tessera_core::clock::SystemClock) as tessera_core::SharedClock,
    );
    let tasks = manager.start();
    let close = d.market(Side::Sell, 2, "closed-by-hand");
    guarded.submit(close, None).await.unwrap();
    settle("Rithmic flat", || gw.net(), |n| *n == 0).await;
    for id in [&sl.id, &tp.id] {
        settle_async(
            &format!("{id} cancelled: the position is flat"),
            || async { again.order_of(id).map(|o| o.status) },
            |s| *s == Some(OrderStatus::Cancelled),
        )
        .await;
    }
    assert_eq!(gw.net(), 0);
    for t in tasks {
        t.abort();
    }
    again.shutdown().await;
    d.market.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chart_stop_shrinks_when_its_target_fills_in_part_and_then_closes_flat() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let (_manager, tasks) = protect(&d, ProtectionMode::PerEntry);
    d.filled(d.market(Side::Buy, 2, "in")).await;
    d.position_settles(Some(2)).await;
    let two = |r: OrderRequest| OrderRequest {
        qty: Qty::from(2),
        ..r
    };
    let stop = d
        .submit(two(resting_exit(&d, OrderType::Stop, "19990", "p-sl")))
        .await
        .unwrap();
    d.status_settles(&stop.id, OrderStatus::Working).await;
    let target = d
        .submit(two(resting_exit(&d, OrderType::Limit, "20020", "p-tp")))
        .await
        .unwrap();
    d.status_settles(&target.id, OrderStatus::Working).await;
    let stop = d
        .broker
        .orders(&d.account)
        .await
        .unwrap()
        .into_iter()
        .find(|o| o.status.is_open() && o.request.order_type == OrderType::Stop)
        .expect("the stop works");
    gw.fill_some(&basket_of(&d, &target.id), 1);
    settle(
        "the stop shrunk to what the target left",
        || left(&d, &stop.id),
        |q| *q == Some(Qty::from(1)),
    )
    .await;
    gw.fill_open(&basket_of(&d, &stop.id));
    settle("flat", || gw.net(), |n| *n == 0).await;
    flat_with_no_working_leg(&d, [&stop.id, &target.id]).await;
    assert_eq!(gw.net(), 0, "the stop closed the rest and opened nothing");
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_filled_brackets_legs_survive_a_position_update_that_never_comes() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let (_manager, tasks) = protect(&d, ProtectionMode::PerEntry);
    gw.hold_pnl();
    let mut r = d.limit(Side::Buy, 2, "20000", "no-pnl");
    r.bracket = mnq_bracket();
    let entry = d.submit(r).await.unwrap();
    let (stop, target) = legs_placed(&d, &entry.id).await;
    tokio::time::sleep(STALE_AFTER * 2).await;
    assert_eq!(left(&d, &stop.id), Some(Qty::from(2)));
    assert_eq!(left(&d, &target.id), Some(Qty::from(2)));
    assert_eq!(*gw.orders.lock(), [330], "nothing cancelled");
    for t in tasks {
        t.abort();
    }
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resize_and_a_trailing_move_at_the_same_moment_both_land() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    d.filled(d.market(Side::Buy, 2, "in")).await;
    d.position_settles(Some(2)).await;
    let stop = d
        .submit(OrderRequest {
            qty: Qty::from(2),
            ..resting_exit(&d, OrderType::Stop, "19990", "trail")
        })
        .await
        .unwrap();
    d.status_settles(&stop.id, OrderStatus::Working).await;
    let basket = basket_of(&d, &stop.id);
    gw.echo_later.store(true, Ordering::SeqCst);
    let change = |changes: OrderChanges| {
        let (guarded, account, id) = (Arc::clone(&d.guarded), d.account.clone(), stop.id.clone());
        tokio::spawn(async move { guarded.modify(&account, &id, changes).await })
    };
    let resize = change(OrderChanges {
        qty: Some(Qty::from(1)),
        ..OrderChanges::default()
    });
    let trail = change(OrderChanges {
        stop_price: Some(px("19995")),
        ..OrderChanges::default()
    });
    resize.await.unwrap().unwrap();
    trail.await.unwrap().unwrap();
    let held = gw
        .book
        .lock()
        .iter()
        .find(|h| h.basket == basket)
        .map(|h| (h.qty, h.trigger))
        .unwrap();
    assert_eq!(held, (1, Some(19_995.0)), "neither change undid the other");
    assert_eq!(*gw.orders.lock(), [312, 312, 314, 314]);
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adds_legs_lost_with_their_reply_are_never_sent_twice() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let add = d.filled(d.market(Side::Buy, 2, "add")).await;
    d.position_settles(Some(2)).await;
    let b = mnq_bracket().unwrap();
    let attach = || async { d.guarded.attach(&d.account, &add.id, b, Qty::from(2)).await };
    let logins = gw.order_logins.load(Ordering::SeqCst);
    gw.drop_next.store(true, Ordering::SeqCst);
    let r = attach().await;
    assert!(matches!(r, Err(BrokerError::Unavailable(_))), "{r:?}");
    settle(
        "the order plant logging in again",
        || gw.order_logins.load(Ordering::SeqCst),
        |n| *n > logins,
    )
    .await;
    let _ = attach().await;
    settle(
        "the legs Rithmic kept show",
        || {
            futures::FutureExt::now_or_never(d.broker.orders(&d.account))
                .and_then(Result::ok)
                .unwrap_or_default()
                .iter()
                .filter(|o| o.status.is_open() && o.request.reduce_only)
                .count()
        },
        |n| *n == 2,
    )
    .await;
    let again = attach().await.unwrap();
    assert_eq!(again.len(), 2, "the legs Rithmic has");
    assert_eq!(*gw.orders.lock(), [312, 328], "sent once");
    d.shutdown().await;
}

const DAY: i64 = 86_400;

fn now_secs() -> i64 {
    Timestamp::now().secs()
}

fn ids(fills: &[tessera_core::orders::Fill]) -> Vec<String> {
    let mut v: Vec<String> = fills
        .iter()
        .filter_map(|f| f.broker_fill_id.clone())
        .collect();
    v.sort();
    v
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ninety_two_day_read_replays_today_once_and_asks_older_days_in_serial_thirty_day_windows()
{
    let gw = Gateway::start().await;
    let now = now_secs();
    let since = now - 92 * DAY;
    let first = trade_date(since);
    let today = trade_date(now);
    let at_close = |d: NaiveDate| SessionCalendar::CmeGlobex.trade_date_end(d).secs() - 3_600;
    gw.filled_before("too-old", since - 5 * DAY);
    gw.filled_before("first-day", since + 1);
    gw.filled_before("window-end", at_close(first + Days::new(29)));
    gw.filled_before("next-window", at_close(first + Days::new(30)));
    gw.filled_before(
        "yesterday",
        at_close(SessionCalendar::CmeGlobex.prev_trade_date(today)),
    );
    gw.filled_before("today", now - 1);
    let d = desk(&gw).await;
    assert_eq!(gw.replays().len(), 1, "login replays today once");
    assert!(gw.history_asked().is_empty(), "login asks no history");

    let fills = d
        .broker
        .fills(&d.account, Timestamp::from_secs(since))
        .await
        .unwrap();
    assert_eq!(
        ids(&fills),
        [
            "first-day",
            "next-window",
            "today",
            "window-end",
            "yesterday"
        ]
    );

    let (from, to) = gw.replays()[0];
    assert_eq!(trade_date(from + 1), today);
    assert!(
        trade_date(from - 1) < today,
        "the replay starts at the session's open"
    );
    assert!(to >= now);
    let windows = gw.history_asked();
    assert!((1..=4).contains(&windows.len()), "{windows:?}");
    assert_eq!(windows[0].0, first);
    assert_eq!(windows.last().unwrap().1, today.pred_opt().unwrap());
    for (a, b) in &windows {
        assert!(a <= b && (*b - *a).num_days() < 30, "{a}..{b}");
    }
    for pair in windows.windows(2) {
        assert_eq!(
            pair[0].1.succ_opt().unwrap(),
            pair[1].0,
            "oldest first, no gap"
        );
    }
    assert_eq!(
        gw.most_in_flight.load(Ordering::SeqCst),
        1,
        "one request at a time"
    );

    let asked = gw.asked();
    d.broker
        .fills(&d.account, Timestamp::from_secs(since))
        .await
        .unwrap();
    d.broker
        .fills(&d.account, Timestamp::from_secs(now - DAY))
        .await
        .unwrap();
    assert_eq!(gw.asked(), asked, "what is held is never asked again");
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_empty_history_is_an_empty_answer_and_is_not_asked_again() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    let since = Timestamp::from_secs(now_secs() - 10 * DAY);
    assert!(d.broker.fills(&d.account, since).await.unwrap().is_empty());
    assert!(!gw.history_asked().is_empty());
    let asked = gw.asked();
    assert!(d.broker.fills(&d.account, since).await.unwrap().is_empty());
    assert!(
        d.broker
            .fills(&d.account, Timestamp::now())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(gw.asked(), asked);
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nothing_from_before_the_account_was_created_is_asked_for() {
    let gw = Gateway::start().await;
    let created = now_secs() - 40 * DAY;
    *gw.created.lock() = Some(created);
    let d = desk(&gw).await;
    d.broker.fills(&d.account, Timestamp(0)).await.unwrap();
    let windows = gw.history_asked();
    assert_eq!(windows.len(), 2, "{windows:?}");
    assert_eq!(windows[0].0, trade_date(created));
    d.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fill_made_while_the_connection_was_down_comes_back_from_the_replay() {
    let gw = Gateway::start().await;
    let d = desk(&gw).await;
    d.turn_on();
    let session = Timestamp::from_secs(gw.replays()[0].0);
    assert!(
        d.broker
            .fills(&d.account, session)
            .await
            .unwrap()
            .is_empty()
    );

    gw.filled_before("while-away", now_secs());
    gw.drop_next.store(true, Ordering::SeqCst);
    let logins = gw.order_logins.load(Ordering::SeqCst);
    let lost = d.submit(d.limit(Side::Buy, 1, "19000", "away")).await;
    assert!(lost.is_err(), "{lost:?}");
    settle(
        "the order plant logged in again and live",
        || (gw.order_logins.load(Ordering::SeqCst), d.broker.phase()),
        |(n, phase)| *n > logins && *phase == Phase::Live,
    )
    .await;
    settle_async(
        "the fill made while away",
        || async {
            ids(&d
                .broker
                .fills(&d.account, session)
                .await
                .unwrap_or_default())
        },
        |ids| ids == &["while-away"],
    )
    .await;
    assert_eq!(gw.replays().len(), 2, "one replay per login");
    assert!(
        gw.history_asked().is_empty(),
        "today never comes from fill history"
    );
    d.shutdown().await;
}
