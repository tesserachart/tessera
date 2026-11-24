use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use rithmic_rs::prost::Message as _;
use rithmic_rs::rti::{
    ForcedLogout, RequestLogin, RequestMarketDataUpdate, ResponseHeartbeat, ResponseLogin,
    ResponseLogout, ResponseMarketDataUpdate,
};
use tessera_core::health::{ConnectionPhase as Phase, HealthStatus};
use tessera_core::settle::settle;
use tessera_core::timeframe::Timeframe;
use tessera_market::{BarsRequest, MarketDataProvider};
use tessera_rithmic::session::HISTORY_REFUSED;
use tessera_rithmic::{RithmicLogin, RithmicMarket, RithmicOptions, symbols};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const HEARTBEAT_SECS: f64 = 1.0;
const HISTORY_PLANT: i32 = 3;

#[derive(Default)]
struct Rules {
    asked: AtomicU64,
    refuse_history: AtomicBool,
    history_logout_forced: AtomicBool,
    subscribes: AtomicU64,
    unsubscribes: AtomicU64,
    unanswered_subscribes: AtomicU64,
    unsubscribes_held: AtomicBool,
}

struct Gateway {
    url: String,
    open: Arc<AtomicUsize>,
    logins: Arc<AtomicU64>,
    heartbeats: Arc<AtomicU64>,
    rules: Arc<Rules>,
    logins_held: tokio::sync::watch::Sender<bool>,
    drops: tokio::sync::broadcast::Sender<()>,
}

#[derive(Debug, PartialEq)]
struct Held {
    sessions: usize,
    logins: u64,
    heartbeats: u64,
}

fn frame(m: &impl rithmic_rs::prost::Message) -> Message {
    let body = m.encode_to_vec();
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    Message::Binary(out.into())
}

impl Gateway {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let open = Arc::new(AtomicUsize::new(0));
        let logins = Arc::new(AtomicU64::new(0));
        let heartbeats = Arc::new(AtomicU64::new(0));
        let (logins_held, _) = tokio::sync::watch::channel(false);
        let (drops, _) = tokio::sync::broadcast::channel(4);
        let rules = Arc::new(Rules::default());
        let (o, l, b, h, x, r) = (
            Arc::clone(&open),
            Arc::clone(&logins),
            Arc::clone(&heartbeats),
            logins_held.clone(),
            drops.clone(),
            Arc::clone(&rules),
        );
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let (o, l, b, r) = (
                    Arc::clone(&o),
                    Arc::clone(&l),
                    Arc::clone(&b),
                    Arc::clone(&r),
                );
                let mut held = h.subscribe();
                let mut infra = None;
                let mut dropped = x.subscribe();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    o.fetch_add(1, Ordering::SeqCst);
                    loop {
                        let next = tokio::select! {
                            m = ws.next() => m,
                            _ = dropped.recv() => None,
                        };
                        let Some(Ok(msg)) = next else {
                            break;
                        };
                        let Message::Binary(bytes) = msg else {
                            continue;
                        };
                        // Every request carries `template_id` and `user_msg` under the same tags.
                        let Ok(req) = RequestLogin::decode(&bytes[4..]) else {
                            continue;
                        };
                        let user_msg = req.user_msg.clone();
                        let reply = match req.template_id {
                            10 => {
                                infra = req.infra_type;
                                r.asked.fetch_add(1, Ordering::SeqCst);
                                if held.wait_for(|held| !*held).await.is_err() {
                                    break;
                                }
                                let refused = infra == Some(HISTORY_PLANT)
                                    && r.refuse_history.load(Ordering::SeqCst);
                                let mut r = ResponseLogin::default();
                                r.template_id = 11;
                                r.user_msg = user_msg;
                                if refused {
                                    r.rp_code = vec!["13".into(), "permission denied".into()];
                                } else {
                                    l.fetch_add(1, Ordering::SeqCst);
                                    r.rp_code = vec!["0".into()];
                                    r.heartbeat_interval = Some(HEARTBEAT_SECS);
                                    r.unique_user_id = Some("u".into());
                                }
                                frame(&r)
                            }
                            12 if infra == Some(HISTORY_PLANT)
                                && r.history_logout_forced.load(Ordering::SeqCst) =>
                            {
                                let mut f = ForcedLogout::default();
                                f.template_id = 77;
                                let _ = ws.send(frame(&f)).await;
                                break;
                            }
                            12 => {
                                let mut r = ResponseLogout::default();
                                r.template_id = 13;
                                r.user_msg = user_msg;
                                r.rp_code = vec!["0".into()];
                                frame(&r)
                            }
                            100 => {
                                let Ok(req) = RequestMarketDataUpdate::decode(&bytes[4..]) else {
                                    continue;
                                };
                                if req.request == Some(2) {
                                    r.unsubscribes.fetch_add(1, Ordering::SeqCst);
                                    while r.unsubscribes_held.load(Ordering::SeqCst) {
                                        tokio::time::sleep(Duration::from_millis(10)).await;
                                    }
                                } else {
                                    r.subscribes.fetch_add(1, Ordering::SeqCst);
                                    if r.unanswered_subscribes
                                        .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                                            n.checked_sub(1)
                                        })
                                        .is_ok()
                                    {
                                        continue;
                                    }
                                }
                                let mut r = ResponseMarketDataUpdate::default();
                                r.template_id = 101;
                                r.user_msg = user_msg;
                                r.rp_code = vec!["0".into()];
                                frame(&r)
                            }
                            18 => {
                                b.fetch_add(1, Ordering::SeqCst);
                                let mut r = ResponseHeartbeat::default();
                                r.template_id = 19;
                                r.user_msg = user_msg;
                                r.rp_code = vec!["0".into()];
                                frame(&r)
                            }
                            _ => continue,
                        };
                        if ws.send(reply).await.is_err() {
                            break;
                        }
                    }
                    o.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        Self {
            url,
            open,
            logins,
            heartbeats,
            rules,
            logins_held,
            drops,
        }
    }

    fn hold_logins(&self, held: bool) {
        self.logins_held.send_replace(held);
    }

    fn drop_sessions(&self) {
        let _ = self.drops.send(());
    }

    fn logins_asked(&self) -> u64 {
        self.rules.asked.load(Ordering::SeqCst)
    }

    fn held(&self) -> Held {
        Held {
            sessions: self.open.load(Ordering::SeqCst),
            logins: self.logins.load(Ordering::SeqCst),
            heartbeats: self.heartbeats.load(Ordering::SeqCst),
        }
    }

    async fn settles_at(&self, n: usize) -> Held {
        settle(
            &format!("the gateway holding {n} sessions"),
            || self.held(),
            |h| h.sessions == n,
        )
        .await
    }

    fn market(&self) -> Arc<RithmicMarket> {
        self.market_timing_out_after(Duration::from_secs(5))
    }

    fn subscribes(&self) -> u64 {
        self.rules.subscribes.load(Ordering::SeqCst)
    }

    fn market_timing_out_after(&self, connect_timeout: Duration) -> Arc<RithmicMarket> {
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: self.url.clone(),
        };
        let mut opts = RithmicOptions::for_system("Rithmic Test");
        opts.connect_timeout = connect_timeout;
        opts.request_timeout = Duration::from_millis(500);
        opts.linger = Duration::from_millis(100);
        RithmicMarket::new(login, opts).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_reconnects_leave_one_session() {
    let gw = Gateway::start().await;
    let market = gw.market();
    market.reconnect().await.unwrap();
    gw.settles_at(1).await;

    let (a, b) = tokio::join!(market.reconnect(), market.reconnect());
    assert!(a.is_ok() && b.is_ok());
    market.reconnect().await.unwrap();
    assert_eq!(market.phase(), Phase::Live);
    assert_eq!(gw.settles_at(1).await.logins, 4);

    market.shutdown().await;
    gw.settles_at(0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_history_plant_goes_with_a_reconnect() {
    let gw = Gateway::start().await;
    let market = gw.market();
    market.reconnect().await.unwrap();
    let id = symbols::instrument_id("ESZ6", "CME");
    let r = market
        .get_bars(BarsRequest::latest(id, Timeframe::M1, 10))
        .await;
    assert!(r.is_err());
    gw.settles_at(2).await;
    market.reconnect().await.unwrap();
    gw.settles_at(1).await;
    market.shutdown().await;
    gw.settles_at(0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_start_cancelled_mid_login_leaves_no_session() {
    let gw = Gateway::start().await;
    gw.hold_logins(true);
    let market = gw.market();
    let m = Arc::clone(&market);
    let start = tokio::spawn(async move { m.reconnect().await });
    gw.settles_at(1).await;
    start.abort();
    let _ = start.await;
    gw.hold_logins(false);
    gw.settles_at(0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stop_during_a_login_wins() {
    let gw = Gateway::start().await;
    gw.hold_logins(true);
    let market = gw.market();
    let m = Arc::clone(&market);
    let start = tokio::spawn(async move { m.reconnect().await });
    gw.settles_at(1).await;
    market.shutdown().await;
    assert!(start.await.unwrap().is_err());
    assert_eq!(market.phase(), Phase::Stopped);
    gw.hold_logins(false);
    gw.settles_at(0).await;
    assert_eq!(market.phase(), Phase::Stopped);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_live_session_that_hears_no_trades_keeps_its_prices_flowing() {
    let gw = Gateway::start().await;
    let market = gw.market();
    market.reconnect().await.unwrap();
    let quiet = settle(
        "three heartbeats with no trade between them",
        || (gw.held().heartbeats, market.phase()),
        |(beats, _)| *beats >= 3,
    )
    .await;
    assert_eq!(quiet.1, Phase::Live);
    assert!(market.prices_flowing());
    market.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prices_flow_only_while_the_session_is_live() {
    let gw = Gateway::start().await;
    let market = gw.market();
    market.reconnect().await.unwrap();
    assert_eq!(market.phase(), Phase::Live);
    assert!(market.prices_flowing());

    gw.hold_logins(true);
    gw.drop_sessions();
    settle(
        "the session reconnecting",
        || market.phase(),
        |p| matches!(p, Phase::Reconnecting { .. }),
    )
    .await;
    assert!(!market.prices_flowing());

    market.shutdown().await;
    assert_eq!(market.phase(), Phase::Stopped);
    assert!(!market.prices_flowing());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_history_login_leaves_the_prices_live_and_market_orders_open() {
    let gw = Gateway::start().await;
    gw.rules.refuse_history.store(true, Ordering::SeqCst);
    let market = gw.market();
    market.reconnect().await.unwrap();
    let id = symbols::instrument_id("ESZ6", "CME");

    let refused = market
        .get_bars(BarsRequest::latest(id.clone(), Timeframe::M1, 10))
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(market.phase(), Phase::Live);
    assert!(market.prices_flowing());
    assert!(
        market.prices_down_for(&id).is_none(),
        "a market order is not refused for no live prices"
    );
    assert!(refused.contains("refused the history login"), "{refused}");
    let health = market.health();
    assert_eq!(
        (health.status, health.connection, health.message.as_deref()),
        (
            HealthStatus::Degraded,
            Some(Phase::Live),
            Some(HISTORY_REFUSED)
        )
    );

    let asked = gw.logins_asked();
    assert!(
        market
            .get_bars(BarsRequest::latest(id.clone(), Timeframe::M1, 10))
            .await
            .is_err()
    );
    assert_eq!(
        gw.logins_asked(),
        asked,
        "no login is asked again until a reconnect"
    );

    gw.rules.refuse_history.store(false, Ordering::SeqCst);
    market.reconnect().await.unwrap();
    assert_eq!(market.health().status, HealthStatus::Ok);
    market.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stop_while_a_reconnect_logs_in_stays_stopped() {
    let gw = Gateway::start().await;
    let market = gw.market_timing_out_after(Duration::from_millis(500));
    market.reconnect().await.unwrap();
    let asked = gw.logins_asked();

    gw.hold_logins(true);
    gw.drop_sessions();
    settle(
        "a reconnect logging in",
        || (market.phase(), gw.logins_asked()),
        |(p, n)| matches!(p, Phase::Reconnecting { .. }) && *n > asked,
    )
    .await;
    market.shutdown().await;
    assert_eq!(market.phase(), Phase::Stopped);

    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        market.phase(),
        Phase::Stopped,
        "the login that timed out after the stop does not bring Reconnecting back"
    );
    let health = market.health();
    assert_eq!(
        (health.status, health.connection),
        (HealthStatus::Disconnected, Some(Phase::Stopped))
    );
    gw.hold_logins(false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forced_logout_from_the_history_plant_after_a_stop_logs_nothing_in() {
    let gw = Gateway::start().await;
    gw.rules.history_logout_forced.store(true, Ordering::SeqCst);
    let market = gw.market();
    market.reconnect().await.unwrap();
    let id = symbols::instrument_id("ESZ6", "CME");
    let _ = market
        .get_bars(BarsRequest::latest(id, Timeframe::M1, 10))
        .await;
    gw.settles_at(2).await;
    let logins = gw.held().logins;

    market.shutdown().await;
    gw.settles_at(0).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(market.phase(), Phase::Stopped);
    assert_eq!(
        (gw.held().sessions, gw.held().logins),
        (0, logins),
        "no login after the stop"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_subscribe_rithmic_did_not_answer_is_tried_again() {
    let gw = Gateway::start().await;
    gw.rules.unanswered_subscribes.store(1, Ordering::SeqCst);
    let market = gw.market();
    market.reconnect().await.unwrap();
    let id = symbols::instrument_id("ESZ6", "CME");
    let _quotes = market.subscribe_quotes(std::slice::from_ref(&id)).unwrap();
    let asked = settle(
        "the market data is asked for again",
        || gw.subscribes(),
        |n| *n >= 4,
    )
    .await;
    assert_eq!(asked, 4, "asked once more, then held");
    market.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chart_opened_again_while_its_feed_is_let_go_gets_its_feed_back() {
    let gw = Gateway::start().await;
    let market = gw.market();
    market.reconnect().await.unwrap();
    let id = symbols::instrument_id("ESZ6", "CME");
    let quotes = market.subscribe_quotes(std::slice::from_ref(&id)).unwrap();
    settle("the feed is asked for", || gw.subscribes(), |n| *n == 2).await;

    gw.rules.unsubscribes_held.store(true, Ordering::SeqCst);
    drop(quotes);
    settle(
        "the feed is let go",
        || gw.rules.unsubscribes.load(Ordering::SeqCst),
        |n| *n >= 1,
    )
    .await;
    let _again = market.subscribe_quotes(std::slice::from_ref(&id)).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    gw.rules.unsubscribes_held.store(false, Ordering::SeqCst);
    settle(
        "the feed is asked for again",
        || gw.subscribes(),
        |n| *n >= 4,
    )
    .await;
    market.shutdown().await;
}
