use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rithmic_rs::prost::Message as _;
use rithmic_rs::rti::{
    ForcedLogout, LastTrade, RequestLogin, RequestTickBarReplay, ResponseHeartbeat, ResponseLogin,
    ResponseLogout, ResponseMarketDataUpdate, ResponseReferenceData, ResponseTickBarReplay,
};
use tessera_core::health::ConnectionPhase as Phase;
use tessera_core::settle::{settle, settle_async};
use tessera_core::time::{NANOS_PER_MICRO, NANOS_PER_SEC, Timestamp};
use tessera_market::hub::{Gaps, History, MarketHub, PumpKey};
use tessera_market::saved::SavedTrades;
use tessera_market::{MarketDataProvider, MarketRouter};
use tessera_rithmic::{RithmicLogin, RithmicMarket, RithmicOptions, symbols};
use tessera_store::ticks::TickStore;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::tungstenite::Message;

const SESSION_OPEN_PLUS_TEN_MINUTES: i64 = 1_791_411_000;
const TICKER_PLANT: i32 = 1;
const ES: (&str, &str) = ("ESZ6", "CME");

fn frame(m: &impl rithmic_rs::prost::Message) -> Message {
    let body = m.encode_to_vec();
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    Message::Binary(out.into())
}

#[derive(Clone, Copy, Debug)]
struct Print {
    secs: i64,
    usecs: i64,
    price: f64,
    bought: bool,
}

impl Print {
    fn nth(k: i64) -> Self {
        Self {
            secs: SESSION_OPEN_PLUS_TEN_MINUTES + k,
            usecs: (k * 7_919) % 1_000_000,
            price: 7_000.0 + 0.25 * (k % 4) as f64,
            bought: k % 3 != 0,
        }
    }

    fn ts(self) -> Timestamp {
        Timestamp(self.secs * NANOS_PER_SEC + self.usecs * NANOS_PER_MICRO)
    }

    fn live(self) -> Message {
        let mut t = LastTrade::default();
        t.template_id = 150;
        t.symbol = Some(ES.0.into());
        t.exchange = Some(ES.1.into());
        t.presence_bits = Some(1);
        t.trade_price = Some(self.price);
        t.trade_size = Some(2);
        t.aggressor = Some(if self.bought { 1 } else { 2 });
        t.source_ssboe = Some(i32::try_from(self.secs).unwrap());
        t.source_usecs = Some(i32::try_from(self.usecs).unwrap());
        t.source_nsecs = Some(i32::try_from(self.usecs * 1_000).unwrap());
        frame(&t)
    }

    fn replayed(self, req: &RequestTickBarReplay) -> Message {
        let mut r = ResponseTickBarReplay::default();
        r.template_id = 207;
        r.user_msg = req.user_msg.clone();
        r.rq_handler_rp_code = vec!["0".into()];
        r.symbol = req.symbol.clone();
        r.exchange = req.exchange.clone();
        r.volume = Some(2);
        r.bid_volume = Some(if self.bought { 2 } else { 0 });
        r.ask_volume = Some(if self.bought { 0 } else { 2 });
        r.close_price = Some(self.price);
        r.data_bar_ssboe = vec![
            req.start_index.unwrap_or(0),
            i32::try_from(self.secs).unwrap(),
        ];
        r.data_bar_usecs = vec![0, i32::try_from(self.usecs).unwrap()];
        frame(&r)
    }
}

#[derive(Default)]
struct Tape {
    happened: Vec<Print>,
    logins: BTreeMap<i32, usize>,
    streaming: usize,
    open: usize,
}

struct Gateway {
    url: String,
    tape: Arc<Mutex<Tape>>,
    prints: broadcast::Sender<Message>,
    forced: broadcast::Sender<()>,
    logins_held: watch::Sender<bool>,
}

enum Asked {
    Login(i32),
    Logout,
    Heartbeat,
    MarketData { subscribe: bool },
    Reference,
    Replay(RequestTickBarReplay),
    Other,
}

fn asked(bytes: &[u8]) -> Option<(Asked, Vec<String>)> {
    let body = bytes.get(4..)?;
    // Every request carries `template_id` and `user_msg` under the same tags.
    let head = RequestLogin::decode(body).ok()?;
    let user_msg = head.user_msg.clone();
    let what = match head.template_id {
        10 => Asked::Login(head.infra_type.unwrap_or(0)),
        12 => Asked::Logout,
        18 => Asked::Heartbeat,
        100 => {
            let r = rithmic_rs::rti::RequestMarketDataUpdate::decode(body).ok()?;
            Asked::MarketData {
                subscribe: r.request == Some(1),
            }
        }
        14 => Asked::Reference,
        206 => Asked::Replay(RequestTickBarReplay::decode(body).ok()?),
        _ => Asked::Other,
    };
    Some((what, user_msg))
}

fn reference(user_msg: Vec<String>) -> Message {
    let mut r = ResponseReferenceData::default();
    r.template_id = 15;
    r.user_msg = user_msg;
    r.rp_code = vec!["0".into()];
    r.symbol = Some(ES.0.into());
    r.exchange = Some(ES.1.into());
    r.trading_symbol = Some(ES.0.into());
    r.trading_exchange = Some(ES.1.into());
    r.product_code = Some("ES".into());
    r.symbol_name = Some("E-mini S&P 500 Dec 2026".into());
    r.expiration_date = Some("20261218".into());
    r.currency = Some("USD".into());
    r.min_qprice_change = Some(0.25);
    r.single_point_value = Some(50.0);
    r.min_qprice_change_precision = Some(2);
    frame(&r)
}

fn replay_answer(tape: &Tape, req: &RequestTickBarReplay) -> Vec<Message> {
    let (from, to) = (
        i64::from(req.start_index.unwrap_or(0)),
        i64::from(req.finish_index.unwrap_or(0)),
    );
    let mut out: Vec<Message> = tape
        .happened
        .iter()
        .filter(|p| p.secs >= from && p.secs <= to)
        .map(|p| p.replayed(req))
        .collect();
    let mut end = ResponseTickBarReplay::default();
    end.template_id = 207;
    end.user_msg = req.user_msg.clone();
    end.rp_code = vec!["0".into()];
    out.push(frame(&end));
    out
}

fn ok(template_id: i32, user_msg: Vec<String>) -> Message {
    match template_id {
        11 => {
            let mut r = ResponseLogin::default();
            r.template_id = 11;
            r.user_msg = user_msg;
            r.rp_code = vec!["0".into()];
            r.heartbeat_interval = Some(60.0);
            r.unique_user_id = Some("u".into());
            frame(&r)
        }
        13 => {
            let mut r = ResponseLogout::default();
            r.template_id = 13;
            r.user_msg = user_msg;
            r.rp_code = vec!["0".into()];
            frame(&r)
        }
        19 => {
            let mut r = ResponseHeartbeat::default();
            r.template_id = 19;
            r.user_msg = user_msg;
            r.rp_code = vec!["0".into()];
            frame(&r)
        }
        _ => {
            let mut r = ResponseMarketDataUpdate::default();
            r.template_id = 101;
            r.user_msg = user_msg;
            r.rp_code = vec!["0".into()];
            frame(&r)
        }
    }
}

impl Gateway {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let tape: Arc<Mutex<Tape>> = Arc::default();
        let (prints, _) = broadcast::channel(4_096);
        let (forced, _) = broadcast::channel(4);
        let (logins_held, _) = watch::channel(false);
        let (t, p, f, h) = (
            Arc::clone(&tape),
            prints.clone(),
            forced.clone(),
            logins_held.clone(),
        );
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (tape, mut prints, mut forced, mut held) =
                    (Arc::clone(&t), p.subscribe(), f.subscribe(), h.subscribe());
                tokio::spawn(async move {
                    let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    tape.lock().open += 1;
                    let (mut out, mut inbox) = ws.split();
                    let mut streaming = false;
                    loop {
                        let replies = tokio::select! {
                            m = inbox.next() => {
                                let Some(Ok(Message::Binary(bytes))) = m else { break };
                                let Some((what, user_msg)) = asked(&bytes) else { continue };
                                match what {
                                    Asked::Login(infra) => {
                                        *tape.lock().logins.entry(infra).or_default() += 1;
                                        if held.wait_for(|held| !*held).await.is_err() {
                                            break;
                                        }
                                        vec![ok(11, user_msg)]
                                    }
                                    Asked::Logout => vec![ok(13, user_msg)],
                                    Asked::Heartbeat => vec![ok(19, user_msg)],
                                    Asked::MarketData { subscribe } => {
                                        if subscribe && !streaming {
                                            streaming = true;
                                            tape.lock().streaming += 1;
                                        }
                                        vec![ok(101, user_msg)]
                                    }
                                    Asked::Reference => vec![reference(user_msg)],
                                    Asked::Replay(req) => replay_answer(&tape.lock(), &req),
                                    Asked::Other => continue,
                                }
                            }
                            p = prints.recv(), if streaming => match p {
                                Ok(m) => vec![m],
                                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(broadcast::error::RecvError::Closed) => break,
                            },
                            _ = forced.recv() => {
                                let mut f = ForcedLogout::default();
                                f.template_id = 77;
                                let _ = out.send(frame(&f)).await;
                                break;
                            }
                        };
                        for r in replies {
                            if out.send(r).await.is_err() {
                                break;
                            }
                        }
                    }
                    let _ = out.close().await;
                    let mut t = tape.lock();
                    t.open -= 1;
                    if streaming {
                        t.streaming -= 1;
                    }
                });
            }
        });
        Self {
            url,
            tape,
            prints,
            forced,
            logins_held,
        }
    }

    fn market(&self, clash_window: Duration) -> Arc<RithmicMarket> {
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: self.url.clone(),
        };
        let mut opts = RithmicOptions::for_system("Rithmic Test");
        opts.connect_timeout = Duration::from_secs(5);
        opts.request_timeout = Duration::from_millis(500);
        opts.clash_window = clash_window;
        RithmicMarket::new(login, opts).unwrap()
    }

    fn trade(&self, ks: std::ops::Range<i64>) {
        for k in ks {
            let p = Print::nth(k);
            self.tape.lock().happened.push(p);
            let _ = self.prints.send(p.live());
        }
    }

    fn another_session_logs_in(&self) {
        let _ = self.forced.send(());
    }

    fn hold_logins(&self, held: bool) {
        self.logins_held.send_replace(held);
    }

    fn ticker_logins(&self) -> usize {
        self.tape
            .lock()
            .logins
            .get(&TICKER_PLANT)
            .copied()
            .unwrap_or(0)
    }

    fn link(&self, market: &RithmicMarket) -> Link {
        let ticker_logins = self.ticker_logins();
        let tape = self.tape.lock();
        Link {
            phase: market.phase(),
            ticker_logins,
            streaming: tape.streaming,
            open: tape.open,
        }
    }

    async fn settles(
        &self,
        what: &str,
        market: &RithmicMarket,
        done: impl Fn(&Link) -> bool,
    ) -> Link {
        settle(what, || self.link(market), done).await
    }
}

#[derive(Debug, PartialEq)]
struct Link {
    phase: Phase,
    ticker_logins: usize,
    streaming: usize,
    open: usize,
}

#[derive(Debug, PartialEq)]
struct Held {
    prints: Vec<Range<i64>>,
    strays: Vec<Timestamp>,
    gaps: Gaps,
    filling: bool,
}

impl Held {
    fn of(h: History) -> Self {
        let mut prints: Vec<Range<i64>> = Vec::new();
        let mut strays = Vec::new();
        for t in &h.trades {
            let k = t.ts.0.div_euclid(NANOS_PER_SEC) - SESSION_OPEN_PLUS_TEN_MINUTES;
            if Print::nth(k).ts() != t.ts {
                strays.push(t.ts);
                continue;
            }
            match prints.last_mut() {
                Some(run) if run.end == k => run.end += 1,
                _ => prints.push(k..k + 1),
            }
        }
        Self {
            prints,
            strays,
            gaps: h.gaps,
            filling: h.filling,
        }
    }

    fn whole(prints: Range<i64>) -> Self {
        Self {
            prints: vec![prints],
            strays: Vec::new(),
            gaps: Gaps::default(),
            filling: false,
        }
    }

    fn ends_settled_at(&self, last: i64) -> bool {
        !self.filling
            && self.strays.is_empty()
            && self.prints.last().is_some_and(|r| r.end == last + 1)
    }
}

struct Desk {
    hub: Arc<MarketHub>,
    id: tessera_core::InstrumentId,
}

impl Desk {
    fn open(market: &Arc<RithmicMarket>) -> (Self, tessera_market::hub::MarketPumpGuard) {
        let router = MarketRouter::new();
        router
            .add(Arc::clone(market) as Arc<dyn MarketDataProvider>)
            .unwrap();
        let hub = MarketHub::new(router, Arc::new(tessera_host::EventBus::new()));
        hub.set_saved_trades(SavedTrades::new(Arc::new(
            TickStore::open_in_memory().unwrap(),
        )));
        let id = symbols::instrument_id(ES.0, ES.1);
        let recording = hub.acquire(PumpKey::Trades(id.clone())).unwrap();
        (Self { hub, id }, recording)
    }

    async fn held(&self) -> Held {
        let from = Print::nth(0).ts();
        Held::of(
            self.hub
                .history(&self.id, Some(from), None, None)
                .await
                .unwrap(),
        )
    }

    async fn settled_through(&self, last: i64) -> Held {
        settle_async(
            &format!("the read settling through print {last}"),
            || self.held(),
            |h| h.ends_settled_at(last),
        )
        .await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forced_logout_logs_in_once_more_and_replays_the_gap_until_the_ticks_are_whole() {
    let gw = Gateway::start().await;
    let market = gw.market(Duration::from_secs(600));
    market.reconnect().await.unwrap();
    let (desk, _recording) = Desk::open(&market);
    gw.settles("the ticker streaming ES", &market, |l| l.streaming == 1)
        .await;

    gw.trade(0..20);
    assert_eq!(desk.settled_through(19).await, Held::whole(0..20));

    gw.hold_logins(true);
    gw.another_session_logs_in();
    gw.settles("the session logging in again on its own", &market, |l| {
        matches!(l.phase, Phase::Reconnecting { .. }) && l.streaming == 0
    })
    .await;
    assert!(!market.prices_flowing());
    gw.trade(20..50);
    assert_eq!(
        desk.held().await,
        Held::whole(0..20),
        "nothing is made up while logged out, and the read ends at the last print held"
    );

    gw.hold_logins(false);
    let live = gw
        .settles("the session live again and streaming ES", &market, |l| {
            l.phase == Phase::Live && l.streaming == 1
        })
        .await;
    gw.trade(50..60);

    assert_eq!(
        desk.settled_through(59).await,
        Held::whole(0..60),
        "every print once, in order, across the logout"
    );
    assert_eq!(
        gw.ticker_logins(),
        live.ticker_logins,
        "no login once live again"
    );
    market.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_forced_logout_after_logging_in_again_stays_down_and_says_who_took_over() {
    let gw = Gateway::start().await;
    let market = gw.market(Duration::from_secs(600));
    market.reconnect().await.unwrap();
    assert_eq!(gw.ticker_logins(), 1);

    gw.another_session_logs_in();
    gw.settles("logged in once more", &market, |l| {
        l.ticker_logins == 2 && l.phase == Phase::Live
    })
    .await;

    gw.another_session_logs_in();
    let down = gw
        .settles("taken over with every plant logged out", &market, |l| {
            l.phase == Phase::TakenOver && l.open == 0
        })
        .await;
    assert_eq!(down.ticker_logins, 2, "no login fights the other session");
    assert!(!market.prices_flowing());
    let health = market.health();
    assert_eq!(
        (health.status, health.connection),
        (
            tessera_core::health::HealthStatus::Down,
            Some(Phase::TakenOver)
        )
    );

    market.reconnect().await.unwrap();
    assert_eq!(
        market.phase(),
        Phase::Live,
        "the user's reconnect is obeyed"
    );
    assert_eq!(gw.ticker_logins(), 3);
    market.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forced_logout_past_the_clash_window_gets_its_own_one_more_login() {
    let gw = Gateway::start().await;
    let market = gw.market(Duration::ZERO);
    market.reconnect().await.unwrap();

    gw.another_session_logs_in();
    gw.settles("logged in once more", &market, |l| {
        l.ticker_logins == 2 && l.phase == Phase::Live
    })
    .await;

    gw.another_session_logs_in();
    gw.settles("logged in once more again", &market, |l| {
        l.ticker_logins == 3 && l.phase == Phase::Live
    })
    .await;
    market.shutdown().await;
}
