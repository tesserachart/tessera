use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rithmic_rs::prost::Message as _;
use rithmic_rs::rti::{
    RequestLogin, RequestTickBarReplay, ResponseHeartbeat, ResponseLogin, ResponseLogout,
    ResponseTickBarReplay,
};
use tessera_core::market::{Aggressor, AggressorSource};
use tessera_core::time::{NANOS_PER_MICRO, NANOS_PER_SEC, Timestamp};
use tessera_market::{MarketDataProvider, TradesRequest};
use tessera_rithmic::history::{MAX_ROWS_PER_PAGE, TICK_PAUSE};
use tessera_rithmic::{RithmicLogin, RithmicMarket, RithmicOptions, symbols};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const PRINTS_PER_SEC: i64 = 100;
const START: i64 = 1_791_388_000;
const REPLY_TAKES: Duration = Duration::from_millis(40);

fn frame(m: &impl rithmic_rs::prost::Message) -> Message {
    let body = m.encode_to_vec();
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    Message::Binary(out.into())
}

fn print_at(k: i64) -> (i64, i64, bool) {
    let secs = START + k / PRINTS_PER_SEC;
    let usecs = (k % PRINTS_PER_SEC) * 10_000 + 7;
    (secs, usecs, k % 3 == 0)
}

#[derive(Default)]
struct Seen {
    asked: Vec<(Instant, i32, i32, Option<i32>)>,
    answered: Vec<Instant>,
    most_in_flight: usize,
}

struct Gateway {
    url: String,
    seen: Arc<Mutex<Seen>>,
}

impl Gateway {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Seen>> = Arc::default();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let (s, f) = (Arc::clone(&seen), Arc::clone(&in_flight));
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let (seen, in_flight) = (Arc::clone(&s), Arc::clone(&f));
                tokio::spawn(async move {
                    let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    let (mut out, mut inbox) = ws.split();
                    let (jobs, mut todo) = mpsc::unbounded_channel::<Vec<u8>>();
                    let replier = {
                        let (seen, in_flight) = (Arc::clone(&seen), Arc::clone(&in_flight));
                        tokio::spawn(async move {
                            while let Some(bytes) = todo.recv().await {
                                if let Some(req) = replay_of(&bytes) {
                                    tokio::time::sleep(REPLY_TAKES).await;
                                    let (rows, end) = ticks(&req);
                                    for r in rows {
                                        if out.send(r).await.is_err() {
                                            return;
                                        }
                                    }
                                    in_flight.fetch_sub(1, Ordering::SeqCst);
                                    seen.lock().answered.push(Instant::now());
                                    if out.send(end).await.is_err() {
                                        return;
                                    }
                                    continue;
                                }
                                let Ok(req) = RequestLogin::decode(&bytes[4..]) else {
                                    continue;
                                };
                                let user_msg = req.user_msg.clone();
                                let replies = match req.template_id {
                                    10 => {
                                        let mut r = ResponseLogin::default();
                                        r.template_id = 11;
                                        r.user_msg = user_msg;
                                        r.rp_code = vec!["0".into()];
                                        r.heartbeat_interval = Some(60.0);
                                        r.unique_user_id = Some("u".into());
                                        vec![frame(&r)]
                                    }
                                    12 => {
                                        let mut r = ResponseLogout::default();
                                        r.template_id = 13;
                                        r.user_msg = user_msg;
                                        r.rp_code = vec!["0".into()];
                                        vec![frame(&r)]
                                    }
                                    18 => {
                                        let mut r = ResponseHeartbeat::default();
                                        r.template_id = 19;
                                        r.user_msg = user_msg;
                                        r.rp_code = vec!["0".into()];
                                        vec![frame(&r)]
                                    }
                                    _ => continue,
                                };
                                for r in replies {
                                    if out.send(r).await.is_err() {
                                        return;
                                    }
                                }
                            }
                        })
                    };
                    while let Some(Ok(msg)) = inbox.next().await {
                        let Message::Binary(bytes) = msg else {
                            continue;
                        };
                        if let Some(req) = replay_of(&bytes) {
                            let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                            let mut s = seen.lock();
                            s.most_in_flight = s.most_in_flight.max(now);
                            s.asked.push((
                                Instant::now(),
                                req.start_index.unwrap_or(0),
                                req.finish_index.unwrap_or(0),
                                req.user_max_count,
                            ));
                        }
                        if jobs.send(bytes.to_vec()).is_err() {
                            break;
                        }
                    }
                    replier.abort();
                });
            }
        });
        Self { url, seen }
    }

    fn market(&self) -> Arc<RithmicMarket> {
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: self.url.clone(),
        };
        let mut opts = RithmicOptions::for_system("Rithmic Test");
        opts.connect_timeout = Duration::from_secs(5);
        RithmicMarket::new(login, opts).unwrap()
    }
}

fn replay_of(bytes: &[u8]) -> Option<RequestTickBarReplay> {
    RequestTickBarReplay::decode(bytes.get(4..)?)
        .ok()
        .filter(|r| r.template_id == 206)
}

fn ticks(req: &RequestTickBarReplay) -> (Vec<Message>, Message) {
    let (from, to) = (
        i64::from(req.start_index.unwrap_or(0)),
        i64::from(req.finish_index.unwrap_or(0)),
    );
    let first = (from - START).max(0) * PRINTS_PER_SEC;
    let end = (to + 1 - START).max(0) * PRINTS_PER_SEC;
    let cap = req.user_max_count.map_or(MAX_ROWS_PER_PAGE, |c| c as usize);
    let rows: Vec<Message> = (first..end)
        .take(cap)
        .map(|k| {
            let (secs, usecs, bought) = print_at(k);
            let mut r = ResponseTickBarReplay::default();
            r.template_id = 207;
            r.user_msg = req.user_msg.clone();
            r.rq_handler_rp_code = vec!["0".into()];
            r.symbol = req.symbol.clone();
            r.exchange = req.exchange.clone();
            r.volume = Some(2);
            r.bid_volume = Some(if bought { 2 } else { 0 });
            r.ask_volume = Some(if bought { 0 } else { 2 });
            r.close_price = Some(7_745.25);
            r.data_bar_ssboe = vec![i32::try_from(from).unwrap(), i32::try_from(secs).unwrap()];
            r.data_bar_usecs = vec![0, i32::try_from(usecs).unwrap()];
            frame(&r)
        })
        .collect();
    let mut end = ResponseTickBarReplay::default();
    end.template_id = 207;
    end.user_msg = req.user_msg.clone();
    end.rp_code = vec!["0".into()];
    (rows, frame(&end))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tick_replays_go_one_at_a_time_paced_and_return_every_print_once() {
    let gw = Gateway::start().await;
    let market = gw.market();
    market.reconnect().await.unwrap();
    let span = 300;
    let ask = |symbol: &str| TradesRequest {
        instrument: symbols::instrument_id(symbol, "CME"),
        from: Some(Timestamp::from_secs(START)),
        to: Some(Timestamp::from_secs(START + span)),
        limit: None,
    };
    let (es, nq) = tokio::join!(
        market.replay_trades(ask("ESZ6")),
        market.replay_trades(ask("NQZ6"))
    );
    let want: Vec<(Timestamp, Aggressor)> = (0..span * PRINTS_PER_SEC)
        .map(|k| {
            let (secs, usecs, bought) = print_at(k);
            (
                Timestamp(secs * NANOS_PER_SEC + usecs * NANOS_PER_MICRO),
                if bought {
                    Aggressor::Buy
                } else {
                    Aggressor::Sell
                },
            )
        })
        .collect();
    for got in [es.unwrap(), nq.unwrap()] {
        assert_eq!(
            got.iter().map(|t| (t.ts, t.aggressor)).collect::<Vec<_>>(),
            want,
            "every print of the span once, oldest first"
        );
        assert!(
            got.iter()
                .all(|t| t.aggressor_source == AggressorSource::ReplayMapped)
        );
    }

    {
        let seen = gw.seen.lock();
        assert_eq!(seen.most_in_flight, 1, "never two replays at once");
        assert!(
            seen.asked.iter().any(|a| a.2 - a.1 >= 100),
            "the first page asked more than the cap and was asked again in halves"
        );
        assert!(
            seen.asked
                .iter()
                .all(|a| a.3 == Some(MAX_ROWS_PER_PAGE as i32))
        );
        assert_eq!(seen.answered.len(), seen.asked.len());
        for (i, (asked_at, ..)) in seen.asked.iter().enumerate().skip(1) {
            let rest = asked_at.duration_since(seen.answered[i - 1]);
            assert!(
                rest >= TICK_PAUSE,
                "page {i} was asked {rest:?} after the one before was answered"
            );
        }
    }
    market.shutdown().await;
}
