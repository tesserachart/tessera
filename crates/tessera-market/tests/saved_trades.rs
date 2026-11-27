use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use futures::StreamExt;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::ManualClock;
use tessera_core::health::ProviderHealth;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Aggressor, AggressorSource, Quote, Trade};
use tessera_core::origin::Origin;
use tessera_core::session::SessionCalendar;
use tessera_core::settle::{settle, settle_async};
use tessera_core::time::{NANOS_PER_MINUTE, NANOS_PER_SEC, local_to_timestamp};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicSizing};
use tessera_market::hub::{FILL_WAIT, MarketHub, PumpKey, REFUSED_AGAIN, Read};
use tessera_market::io::{BigTradeTier, BigTradesOutput, GetBigTradesInput};
use tessera_market::orderflow::tools::GetBigTrades;
use tessera_market::saved::{Contract, SavedTrades};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket, TradesRequest,
};
use tessera_protocol::topics::names;
use tessera_store::ticks::{Span, TickRow, TickStore};
use tessera_tools::{Tool, ToolCtx};
use tokio::sync::{broadcast, watch};

const _: () = assert!(
    tessera_core::settle::STALL.as_nanos() > FILL_WAIT.as_nanos(),
    "a read that waits out the hub's fill wait has not stalled"
);

const EVERY: i64 = 15 * NANOS_PER_SEC;
const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;
const SOURCE: &str = "replays";

fn nq() -> InstrumentId {
    InstrumentId::new("NQZ6.CME").unwrap()
}

fn date(m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, m, d).unwrap()
}

fn at(m: u32, d: u32, h: u32, min: u32) -> i64 {
    local_to_timestamp(CAL.tz(), date(m, d), h, min).0
}

fn session(m: u32, d: u32) -> Span {
    let s = CAL.session(date(m, d)).unwrap();
    Span::new(s.open.0, s.close.0)
}

fn contract() -> Contract {
    Contract::new(SOURCE, &nq())
}

fn print(t: i64, aggressor_source: AggressorSource) -> Trade {
    let k = t / EVERY;
    Trade {
        instrument: nq(),
        ts: Timestamp(t),
        price: Price(
            Decimal::from(24_000) + Decimal::from_str("0.25").unwrap() * Decimal::from(k % 40),
        ),
        size: Qty::from(1 + k % 5),
        aggressor: if k % 2 == 0 {
            Aggressor::Buy
        } else {
            Aggressor::Sell
        },
        aggressor_source,
        order_key: None,
        source: None,
    }
}

fn truth(span: Span) -> Vec<Trade> {
    let first = span.start + (EVERY - span.start.rem_euclid(EVERY)) % EVERY;
    (first..span.end)
        .step_by(EVERY as usize)
        .filter(|t| CAL.is_open(Timestamp(*t)))
        .map(|t| print(t, AggressorSource::ReplayMapped))
        .collect()
}

fn seen(trades: &[Trade]) -> Vec<(i64, String, String, Aggressor)> {
    trades
        .iter()
        .map(|t| {
            (
                t.ts.0,
                t.price.0.normalize().to_string(),
                t.size.0.normalize().to_string(),
                t.aggressor,
            )
        })
        .collect()
}

struct Replays {
    mock: MockMarket,
    now: Mutex<Timestamp>,
    live: broadcast::Sender<Trade>,
    open: watch::Sender<bool>,
    held_before: watch::Sender<Option<i64>>,
    asked: Mutex<Vec<Span>>,
    asked_for: Mutex<Vec<InstrumentId>>,
    in_flight: AtomicUsize,
    most_in_flight: AtomicUsize,
    refuse_before: Mutex<Option<i64>>,
    serving: watch::Sender<bool>,
}

impl Replays {
    fn new(now: i64) -> Arc<Self> {
        let clock = Arc::new(ManualClock::new(Timestamp(now)));
        let mut cfg = MockConfig::new(clock);
        cfg.intraday_sessions = 1;
        cfg.daily_sessions = 1;
        Arc::new(Self {
            mock: MockMarket::new(cfg),
            now: Mutex::new(Timestamp(now)),
            live: broadcast::channel(4096).0,
            open: watch::channel(true).0,
            held_before: watch::channel(None).0,
            asked: Mutex::new(Vec::new()),
            asked_for: Mutex::new(Vec::new()),
            in_flight: AtomicUsize::new(0),
            most_in_flight: AtomicUsize::new(0),
            refuse_before: Mutex::new(None),
            serving: watch::channel(true).0,
        })
    }

    fn asked(&self) -> Vec<Span> {
        self.asked.lock().clone()
    }
}

#[async_trait]
impl MarketDataProvider for Replays {
    fn id(&self) -> &str {
        SOURCE
    }
    fn display_name(&self) -> &str {
        "Replays"
    }
    fn capabilities(&self) -> MarketCapabilities {
        self.mock.capabilities()
    }
    fn health(&self) -> ProviderHealth {
        self.mock.health()
    }
    fn prices_flowing(&self) -> bool {
        *self.serving.borrow()
    }
    async fn search(
        &self,
        q: &str,
        a: Option<AssetClass>,
        n: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.mock.search(q, a, n).await
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.mock.resolve(input).await
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.mock.spec(i).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.mock.get_bars(req).await
    }
    async fn replay_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let _ = self.open.subscribe().wait_for(|o| *o).await;
        if !*self.serving.borrow() {
            return Err(MarketError::Unavailable("logged out".into()));
        }
        let span = Span::new(req.from.unwrap().0, req.to.unwrap().0);
        self.asked.lock().push(span);
        self.asked_for.lock().push(req.instrument.clone());
        let n = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_in_flight.fetch_max(n, Ordering::SeqCst);
        let _ = self
            .held_before
            .subscribe()
            .wait_for(|h| h.is_none_or(|t| span.start >= t))
            .await;
        tokio::time::sleep(Duration::from_millis(5)).await;
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        if self.refuse_before.lock().is_some_and(|r| span.start < r) {
            return Err(MarketError::InvalidRequest(
                "older than the replay keeps".into(),
            ));
        }
        Ok(truth(span))
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        let mut q = self.mock.quote(i).await?;
        q.ts = *self.now.lock();
        Ok(q)
    }
    fn subscribe_quotes(&self, i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.mock.subscribe_quotes(i)
    }
    fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        let rx = self.live.subscribe();
        Ok(futures::stream::unfold(rx, |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(t) => return Some((t, rx)),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
        .boxed())
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.mock.subscribe_bars(i, tf)
    }
}

fn hub(fake: &Arc<Replays>, saved: &Arc<SavedTrades>) -> Arc<MarketHub> {
    let router = MarketRouter::new();
    router.add(fake.clone()).unwrap();
    let bus = Arc::new(EventBus::new());
    for t in [names::MARKET_TRADES, names::MARKET_FOOTPRINT] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    let hub = MarketHub::new(router, bus);
    hub.set_linger(Duration::ZERO);
    hub.set_saved_trades(Arc::clone(saved));
    hub
}

fn saved_in(dir: &tempfile::TempDir) -> Arc<SavedTrades> {
    SavedTrades::new(Arc::new(TickStore::open_in_dir(dir.path()).unwrap()))
}

fn seed(saved: &SavedTrades, spans: &[Span]) {
    for s in spans {
        let rows: Vec<TickRow> = truth(*s).iter().map(TickRow::of).collect();
        saved.save_now(&contract(), CAL, &rows, *s).unwrap();
    }
}

fn days(saved: &SavedTrades) -> Vec<NaiveDate> {
    saved
        .store()
        .days(contract().key())
        .unwrap()
        .iter()
        .map(|d| d.trade_date)
        .collect()
}

async fn settled(hub: &MarketHub, fake: &Replays) {
    let now = *fake.now.lock();
    let open = CAL.last_sessions(Timestamp(now.0 - 1), 1)[0].open;
    settle_async(
        "the session read",
        || async move {
            let read = hub.history(&nq(), Some(open), None, Some(1)).await.unwrap();
            (read.filling, fake.asked().len())
        },
        |(filling, _)| !filling,
    )
    .await;
}

#[derive(Debug, PartialEq)]
struct Pulling {
    filling: bool,
    gaps: Vec<Span>,
    prints: usize,
    asked: usize,
}

async fn pulled(hub: &MarketHub, fake: &Replays, span: Span) -> (Vec<Trade>, Read) {
    let last = Mutex::new(None);
    let kept = &last;
    settle_async(
        "the pull",
        || async move {
            let (got, r) = read(hub, span).await;
            let seen = Pulling {
                filling: r.filling,
                gaps: r.gaps.spans().to_vec(),
                prints: got.len(),
                asked: fake.asked().len(),
            };
            *kept.lock() = Some((got, r));
            seen
        },
        |p| !p.filling,
    )
    .await;
    last.into_inner().expect("a read")
}

async fn read(hub: &MarketHub, span: Span) -> (Vec<Trade>, Read) {
    let mut got = Vec::new();
    let r = hub
        .each_print(&nq(), Timestamp(span.start), Timestamp(span.end), |t| {
            got.push(t.clone());
        })
        .await
        .unwrap();
    (got, r)
}

async fn closed_chart(hub: &MarketHub) {
    tokio::time::sleep(Duration::from_millis(50)).await;
    tokio::task::yield_now().await;
    assert_eq!(hub.pump_count(), 0, "the chart's feeds ended");
}

#[tokio::test(start_paused = true)]
async fn a_recordings_live_prints_are_saved_per_trade_date_and_read_back_identical() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let fake = Replays::new(at(10, 2, 14, 42));
    let hub = hub(&fake, &saved);
    let chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;

    let live = |t: i64, k: i64| Trade {
        size: Qty::from(1 + k),
        order_key: Some(k as u32),
        aggressor_source: AggressorSource::Exchange,
        ..print(t, AggressorSource::Exchange)
    };
    let friday = at(10, 2, 14, 42) + 31 * NANOS_PER_SEC;
    let monday = at(10, 2, 18, 0) + NANOS_PER_SEC;
    let batches = [
        vec![
            live(friday, 0),
            live(friday + 1_000, 1),
            live(friday + 2_000, 2),
        ],
        vec![live(friday + 2_000, 3), live(friday + 9_000, 4)],
        vec![live(monday, 5), live(monday, 6), live(monday + 4_000, 7)],
    ];
    for b in &batches {
        for t in b {
            fake.live.send(t.clone()).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    drop(chart);
    closed_chart(&hub).await;
    saved.settle();

    let pushed: Vec<TickRow> = batches.iter().flatten().map(TickRow::of).collect();
    let store = saved.store();
    let got = store
        .read(contract().key(), friday, monday + 4_000 + 1)
        .unwrap();
    assert_eq!(got, pushed, "every field of every print, in order");
    let by_day: Vec<(NaiveDate, u64)> = store
        .days(contract().key())
        .unwrap()
        .iter()
        .filter(|d| d.trade_date >= date(10, 2))
        .map(|d| (d.trade_date, d.prints))
        .collect();
    let session_before = truth(Span::new(session(10, 2).start, friday)).len() as u64;
    assert_eq!(
        by_day,
        vec![(date(10, 2), session_before + 5), (date(10, 5), 3)],
        "the session read before the recording and the recording, by trade date"
    );
    assert!(
        store
            .missing(contract().key(), session(10, 2).start, monday + 4_001)
            .unwrap()
            .iter()
            .all(|h| !CAL.is_open(Timestamp(h.start))),
        "known whole from the session's open through the last print"
    );
    assert!(
        saved.contract(&contract()).is_some(),
        "kept for offline replay"
    );
}

#[tokio::test(start_paused = true)]
async fn a_watched_market_records_and_saves_its_prints_with_no_chart_open() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let fake = Replays::new(at(10, 2, 14, 42));
    let hub = hub(&fake, &saved);
    assert_eq!(hub.keep_recording(&[nq()]), vec![nq()]);
    tokio::time::sleep(Duration::from_millis(10)).await;

    let t0 = at(10, 2, 14, 42) + 31 * NANOS_PER_SEC;
    let live: Vec<Trade> = (0..4)
        .map(|k| Trade {
            order_key: Some(k as u32),
            ..print(t0 + k * 1_000, AggressorSource::Exchange)
        })
        .collect();
    for t in &live {
        fake.live.send(t.clone()).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(hub.pump_count() > 0, "it records while watched");

    assert!(hub.keep_recording(&[]).is_empty());
    closed_chart(&hub).await;
    saved.settle();
    let got = saved
        .store()
        .read(contract().key(), t0, t0 + 4_000)
        .unwrap();
    assert_eq!(
        got,
        live.iter().map(TickRow::of).collect::<Vec<_>>(),
        "every print with its aggressor side"
    );
}

#[tokio::test(start_paused = true)]
async fn a_session_saved_whole_opens_after_a_restart_with_no_request() {
    let dir = tempfile::tempdir().unwrap();
    let evening = at(10, 2, 17, 30);
    let day = session(10, 2);
    {
        let saved = saved_in(&dir);
        let fake = Replays::new(evening);
        let hub = hub(&fake, &saved);
        let chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
        settled(&hub, &fake).await;
        let (got, r) = read(&hub, day).await;
        assert_eq!(seen(&got), seen(&truth(day)));
        assert_eq!((r.gaps.spans(), r.filling), (&[][..], false));
        assert_eq!(fake.asked().len(), 46, "23 hours in half hours");
        drop(chart);
        closed_chart(&hub).await;
        saved.settle();
    }

    let saved = saved_in(&dir);
    let fake = Replays::new(evening);
    let hub = hub(&fake, &saved);
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;
    let (got, r) = read(&hub, day).await;
    assert_eq!(seen(&got), seen(&truth(day)));
    assert_eq!((r.gaps.spans(), r.filling), (&[][..], false));
    assert_eq!(
        fake.asked(),
        Vec::<Span>::new(),
        "nothing asked of the connection"
    );
}

#[tokio::test(start_paused = true)]
async fn a_market_quiet_since_it_reconnected_replays_through_the_print_its_quote_shows() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let last_print = at(10, 2, 14, 42);
    let fake = Replays::new(last_print);
    let hub = hub(&fake, &saved);
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;

    let through_the_quote = Span::new(session(10, 2).start, last_print + 1);
    let (got, r) = read(&hub, through_the_quote).await;
    assert_eq!(
        got.last().map(|t| t.ts.0),
        Some(last_print),
        "the print the quote was taken from"
    );
    assert_eq!(seen(&got), seen(&truth(through_the_quote)));
    assert_eq!((r.gaps.spans(), r.filling), (&[][..], false));
}

#[tokio::test(start_paused = true)]
async fn a_partly_saved_session_asks_only_the_span_it_misses() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let day = session(10, 2);
    let (noon, gap_end) = (at(10, 2, 12, 0), at(10, 2, 12, 45));
    seed(
        &saved,
        &[Span::new(day.start, noon), Span::new(gap_end, day.end)],
    );

    let fake = Replays::new(at(10, 2, 17, 30));
    let hub = hub(&fake, &saved);
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;
    assert_eq!(
        fake.asked(),
        vec![
            Span::new(at(10, 2, 12, 15), gap_end),
            Span::new(noon, at(10, 2, 12, 15)),
        ],
        "the missing 45 minutes, newest half hour first"
    );
    let (got, r) = read(&hub, day).await;
    assert_eq!(seen(&got), seen(&truth(day)));
    assert!(r.gaps.is_empty());
    saved.settle();
    assert!(
        saved
            .store()
            .missing(contract().key(), day.start, day.end)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test(start_paused = true)]
async fn a_studied_instrument_fills_its_session_before_a_watched_market_or_a_download() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let fake = Replays::new(at(10, 2, 17, 30));
    let hub = hub(&fake, &saved);
    let es = InstrumentId::new("ESZ6.CME").unwrap();
    assert_eq!(
        hub.keep_recording(std::slice::from_ref(&es)),
        vec![es.clone()]
    );
    settle(
        "the watched market's first request",
        || fake.asked().len(),
        |n| *n > 0,
    )
    .await;
    let _footprint = hub
        .acquire(PumpKey::Footprint(nq(), Timeframe::M1, 1))
        .unwrap();
    settle(
        "the study's first request",
        || fake.asked_for.lock().contains(&nq()),
        |asked| *asked,
    )
    .await;
    let (router, feed) = (Arc::clone(hub.router()), Arc::clone(&fake));
    let download = tokio::spawn(async move {
        router.foreground().idle().await;
        feed.asked_for.lock().iter().filter(|i| **i == nq()).count()
    });
    settled(&hub, &fake).await;
    let asked = fake.asked_for.lock().clone();
    let charted: Vec<usize> = (0..asked.len()).filter(|&k| asked[k] == nq()).collect();
    assert!(
        charted.len() > 30,
        "the session is asked in half hours: {}",
        charted.len()
    );
    let (first, last) = (charted[0], charted[charted.len() - 1]);
    assert_eq!(
        last - first + 1,
        charted.len(),
        "the watched market asks nothing while the studied session fills: {asked:?}"
    );
    assert_eq!(
        download.await.unwrap(),
        charted.len(),
        "a download gets the line once the studied session is in, not between its requests"
    );
}

#[tokio::test(start_paused = true)]
async fn each_older_session_a_reach_completes_is_announced_before_the_reach_ends() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let today = session(10, 2);
    seed(&saved, &[today]);
    let fake = Replays::new(at(10, 2, 17, 30));
    let hub = hub(&fake, &saved);
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;
    let mut filled = hub.prints_filled(&nq()).unwrap();
    filled.mark_unchanged();
    fake.held_before.send_replace(Some(session(10, 1).start));

    let (_, r) = read(&hub, Span::new(session(9, 30).start, today.end)).await;
    assert!(r.filling, "the older sessions are being pulled");
    settle(
        "Thursday announced",
        || filled.has_changed().unwrap_or(false),
        |changed| *changed,
    )
    .await;
    assert!(hub.pulling(&nq()), "Wednesday is still being pulled");
    let (got, r) = read(&hub, session(10, 1)).await;
    assert!(r.gaps.is_empty());
    assert_eq!(seen(&got), seen(&truth(session(10, 1))));
    fake.held_before.send_replace(None);
}

#[tokio::test(start_paused = true)]
async fn scrolling_back_past_the_saved_days_pulls_older_sessions_one_request_at_a_time() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let today = session(10, 2);
    seed(&saved, &[today]);
    let fake = Replays::new(at(10, 2, 17, 30));
    let hub = hub(&fake, &saved);
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;
    assert!(fake.asked().is_empty(), "today is on disk");

    fake.open.send_replace(false);
    let back = Span::new(session(9, 30).start, today.end);
    let (got, r) = read(&hub, back).await;
    assert_eq!(
        r.gaps.spans(),
        &[session(9, 30), session(10, 1)],
        "the sessions before what is saved, never the closed hours between them"
    );
    assert!(r.filling, "the older sessions are being pulled");
    assert_eq!(seen(&got), seen(&truth(today)), "the read did not wait");

    fake.open.send_replace(true);
    let (got, r) = pulled(&hub, &fake, back).await;
    assert!(r.gaps.is_empty());
    assert_eq!(seen(&got), seen(&truth(back)));

    let mut want = Vec::new();
    for d in [session(10, 1), session(9, 30)] {
        let mut end = d.end;
        while end > d.start {
            want.push(Span::new(end - 30 * NANOS_PER_MINUTE, end));
            end -= 30 * NANOS_PER_MINUTE;
        }
    }
    assert_eq!(fake.asked(), want, "each half hour once, newest first");
    assert_eq!(fake.most_in_flight.load(Ordering::SeqCst), 1);

    saved.settle();
    assert_eq!(days(&saved), vec![date(9, 30), date(10, 1), date(10, 2)]);
    let _ = read(&hub, back).await;
    assert_eq!(fake.asked().len(), want.len(), "a second read asks nothing");
}

#[tokio::test(start_paused = true)]
async fn the_pull_stops_where_the_connection_refuses_and_stops_filling() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let today = session(10, 2);
    seed(&saved, &[today]);
    let fake = Replays::new(at(10, 2, 17, 30));
    *fake.refuse_before.lock() = Some(at(10, 1, 12, 0));
    let hub = hub(&fake, &saved);
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;

    let back = Span::new(session(9, 30).start, today.end);
    let (_, r) = pulled(&hub, &fake, back).await;
    assert_eq!(
        r.gaps.spans(),
        &[
            session(9, 30),
            Span::new(session(10, 1).start, at(10, 1, 12, 0))
        ],
        "what the connection refused stays a gap"
    );
    let asked = fake.asked();
    assert_eq!(
        asked.last(),
        Some(&Span::new(at(10, 1, 11, 30), at(10, 1, 12, 0))),
        "the first refusal ends the pull"
    );
    let _ = read(&hub, back).await;
    assert_eq!(
        fake.asked().len(),
        asked.len(),
        "a refused span is not asked again at once"
    );
}

#[tokio::test(start_paused = true)]
async fn a_span_the_connection_refused_is_asked_again_after_a_wait_and_fills() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let today = session(10, 2);
    let (lost, back_at) = (at(10, 2, 11, 59), at(10, 2, 12, 0));
    seed(
        &saved,
        &[Span::new(today.start, lost), Span::new(back_at, today.end)],
    );
    let fake = Replays::new(at(10, 2, 17, 30));
    *fake.refuse_before.lock() = Some(today.end);
    let hub = hub(&fake, &saved);
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;

    let (_, r) = pulled(&hub, &fake, today).await;
    assert_eq!(
        r.gaps.spans(),
        &[Span::new(lost, back_at)],
        "a minute missing"
    );
    let refused = fake.asked().len();
    assert!(refused > 0, "the minute was asked for");

    *fake.refuse_before.lock() = None;
    tokio::time::sleep(REFUSED_AGAIN / 2).await;
    let (_, r) = pulled(&hub, &fake, today).await;
    assert_eq!(r.gaps.spans(), &[Span::new(lost, back_at)]);
    assert_eq!(fake.asked().len(), refused, "not before the wait is over");

    tokio::time::sleep(REFUSED_AGAIN / 2).await;
    let (_, again) = read(&hub, today).await;
    assert!(
        again.filling,
        "a read after the wait asks the connection again"
    );
    let (got, r) = pulled(&hub, &fake, today).await;
    assert!(r.gaps.is_empty(), "{:?}", r.gaps.spans());
    assert_eq!(
        seen(&got),
        seen(&truth(today)),
        "every print of the day once"
    );
    assert_eq!(fake.asked().len(), refused + 1);
}

#[tokio::test(start_paused = true)]
async fn a_pull_that_meets_a_dropped_connection_waits_for_it_and_fills_every_gap() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let today = session(10, 2);
    seed(&saved, &[today]);
    let fake = Replays::new(at(10, 2, 17, 30));
    let hub = hub(&fake, &saved);
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;

    fake.serving.send_replace(false);
    let back = Span::new(session(10, 1).start, today.end);
    let (_, down) = read(&hub, back).await;
    assert!(
        down.filling,
        "a gap the connection may yet fill keeps the desk asking"
    );
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let (_, r) = read(&hub, back).await;
        assert!(r.filling, "a logged-out connection refuses nothing");
    }

    fake.serving.send_replace(true);
    let (got, r) = pulled(&hub, &fake, back).await;
    assert!(r.gaps.is_empty(), "{:?}", r.gaps.spans());
    assert_eq!(
        got.iter().map(|t| t.ts).collect::<Vec<_>>(),
        truth(back).iter().map(|t| t.ts).collect::<Vec<_>>(),
        "every print of both sessions once"
    );
}

#[tokio::test(start_paused = true)]
async fn a_day_on_screen_outlives_the_prune_until_its_chart_closes() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let sessions = [(9, 28), (9, 29), (9, 30), (10, 1), (10, 2)].map(|(m, d)| session(m, d));
    seed(&saved, &sessions);
    saved.set_keep(2);

    let fake = Replays::new(at(10, 2, 17, 30));
    let hub = hub(&fake, &saved);
    let chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;
    let (got, r) = read(&hub, sessions[1]).await;
    assert_eq!(seen(&got), seen(&truth(sessions[1])));
    assert!(r.gaps.is_empty());

    assert_eq!(
        saved.prune(&contract()).unwrap(),
        vec![date(9, 28), date(9, 30)]
    );
    assert_eq!(days(&saved), vec![date(9, 29), date(10, 1), date(10, 2)]);

    drop(chart);
    closed_chart(&hub).await;
    assert_eq!(saved.prune(&contract()).unwrap(), vec![date(9, 29)]);
    assert_eq!(
        days(&saved),
        vec![date(10, 1), date(10, 2)],
        "the current session and the one before stay"
    );
    assert!(fake.asked().is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_live_tape_never_waits_for_the_disk() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let fake = Replays::new(at(10, 2, 14, 42));
    fake.open.send_replace(false);
    let hub = hub(&fake, &saved);
    let chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;

    let held = saved.hold_writes();
    let first = at(10, 2, 14, 42) + 31 * NANOS_PER_SEC;
    let mut pushed = 0;
    for second in 0..40 {
        for k in 0..25 {
            let t = first + second * NANOS_PER_SEC + k * 1_000_000;
            fake.live.send(print(t, AggressorSource::Exchange)).unwrap();
            pushed += 1;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let h = hub.history(&nq(), None, None, Some(pushed)).await.unwrap();
    assert_eq!(h.trades.len(), pushed, "the tape took every print");
    assert!(
        saved
            .store()
            .read(contract().key(), first, i64::MAX)
            .unwrap()
            .is_empty(),
        "while the writer was held, the tape wrote nothing itself"
    );
    drop(held);
    drop(chart);
    closed_chart(&hub).await;
    saved.settle();
    let got = saved
        .store()
        .read(contract().key(), first, i64::MAX)
        .unwrap();
    assert_eq!(
        got.len(),
        pushed,
        "and once the disk was free, all of them were"
    );
}

async fn big_trades(tool: &GetBigTrades, from: i64, to: i64) -> BigTradesOutput {
    tool.call(
        &ToolCtx::new(Origin::User, Timestamp(to)),
        GetBigTradesInput {
            instrument: "NQZ6.CME".into(),
            from: Some(Timestamp(from)),
            to: Some(Timestamp(to)),
            tiers: None,
            min_size: None,
            max_size: None,
            join_orders: None,
            reach_limit: None,
            limit: None,
            days_to_load: None,
        },
    )
    .await
    .unwrap()
}

#[tokio::test(start_paused = true)]
async fn on_a_fresh_install_the_first_chart_scores_big_trades_against_five_pulled_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let now = at(10, 4, 18, 30);
    let fake = Replays::new(now);
    let hub = hub(&fake, &saved);
    let tool = GetBigTrades(Arc::clone(&hub));
    let ask = |at: i64| big_trades(&tool, now - 30 * NANOS_PER_MINUTE, at);
    let today = session(10, 5);
    let trailing = [(9, 28), (9, 29), (9, 30), (10, 1), (10, 2)].map(|(m, d)| session(m, d));
    fake.open.send_replace(false);
    fake.held_before.send_replace(Some(today.start));
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    ask(now).await;
    tokio::time::sleep(FILL_WAIT + Duration::from_secs(1)).await;
    fake.open.send_replace(true);
    settled(&hub, &fake).await;

    let big = now + NANOS_PER_SEC;
    fake.live
        .send(Trade {
            size: Qty::from(60),
            aggressor: Aggressor::Buy,
            aggressor_source: AggressorSource::Exchange,
            ..print(big, AggressorSource::Exchange)
        })
        .unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let later = now + 2 * NANOS_PER_SEC;
    let pulling = ask(later).await;
    assert_eq!(
        (pulling.filling, pulling.gaps.as_slice()),
        (true, &[][..]),
        "while the sessions are pulled the prints are whole and the answer says ask again"
    );
    assert!(
        pulling.rule.model_sessions < 5,
        "the scores rest on less until they land"
    );
    assert_eq!(
        hub.trades_snapshot(&nq()).await.unwrap().big_trades,
        None,
        "the live stream holds a big trade until it can score it"
    );

    fake.held_before.send_replace(None);
    let whole_on_disk = |s: &Span| {
        saved
            .store()
            .missing(contract().key(), s.start, s.end)
            .unwrap()
            .iter()
            .all(|h| !CAL.is_open(Timestamp(h.start)))
    };
    settle(
        "the model's five trailing sessions pulled and saved",
        || {
            let whole: Vec<bool> = trailing.iter().map(whole_on_disk).collect();
            (whole, fake.asked().len())
        },
        |(whole, _)| whole.iter().all(|w| *w),
    )
    .await;
    let scored = ask(later).await;
    let found: Vec<(Timestamp, Qty, Option<BigTradeTier>)> = scored
        .trades
        .iter()
        .map(|t| (t.t, t.size, t.tier))
        .collect();
    assert_eq!(
        found,
        vec![(Timestamp(big), Qty::from(60), Some(BigTradeTier::High))],
        "the 60 lot alone is big, and High: no event of the five sessions cleared the floors, so the cuts start at the floor"
    );
    assert_eq!(
        (scored.filling, scored.rule.model_sessions),
        (false, 5),
        "with no wait for a cache to lapse, the model read five whole sessions"
    );
    tokio::time::sleep(Duration::from_secs(6)).await;
    let live = hub.trades_snapshot(&nq()).await.unwrap().big_trades;
    assert_eq!(
        live.unwrap_or_default()
            .iter()
            .map(|t| (t.t, t.tier))
            .collect::<Vec<_>>(),
        vec![(Timestamp(big), Some(BigTradeTier::High))],
        "the live stream sends it once scored, as High"
    );

    assert_eq!(
        fake.most_in_flight.load(Ordering::SeqCst),
        1,
        "the session read and the model's pull never asked at once"
    );
    let strays: Vec<Span> = fake
        .asked()
        .into_iter()
        .filter(|a| {
            !trailing
                .iter()
                .chain([&today])
                .any(|s| s.start <= a.start && a.end <= s.end)
        })
        .collect();
    assert_eq!(
        strays,
        Vec::<Span>::new(),
        "asked only today's session and the five the model reads"
    );
}

#[tokio::test(start_paused = true)]
async fn auto_cuts_never_take_todays_prints_while_the_trailing_sessions_are_missing() {
    let dir = tempfile::tempdir().unwrap();
    let saved = saved_in(&dir);
    let now = at(10, 5, 12, 0);
    let fake = Replays::new(now);
    let hub = hub(&fake, &saved);
    let tool = GetBigTrades(Arc::clone(&hub));
    fake.held_before.send_replace(Some(session(10, 5).start));
    let _chart = hub.acquire(PumpKey::Trades(nq())).unwrap();
    settled(&hub, &fake).await;
    let held_today = read(&hub, Span::new(session(10, 5).start, now)).await.0;
    assert!(
        held_today.len() > 4000,
        "the recording holds today's eighteen hours of prints"
    );

    let burst = now + NANOS_PER_SEC;
    fake.live
        .send(Trade {
            size: Qty::from(60),
            aggressor: Aggressor::Buy,
            aggressor_source: AggressorSource::Exchange,
            ..print(burst, AggressorSource::Exchange)
        })
        .unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let out = big_trades(&tool, now - 30 * NANOS_PER_MINUTE, now + 2 * NANOS_PER_SEC).await;
    assert_eq!(
        out.rule.cuts, None,
        "with none of the five trailing sessions held the model is still sizing; today's prints never size it"
    );
    assert_eq!((out.rule.model_sessions, out.rule.model_orders), (0, 0));
    assert_eq!(
        (out.trades.len(), out.count),
        (0, 0),
        "Auto shows nothing while the model is still sizing, the 60 lot over the floors included"
    );
    assert!(out.filling, "the trailing sessions are still being pulled");
}
