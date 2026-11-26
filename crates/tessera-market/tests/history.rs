use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::ManualClock;
use tessera_core::health::ProviderHealth;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Bar, Quote, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::settle::settle;
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_market::aggregate::aggregate;
use tessera_market::history::{
    BarCache, BarsWritten, FILL_SESSIONS_PER_REQUEST, HistoryKept, Read, SETTLE, fill_sessions,
};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket,
};
use tessera_store::bars::{BarStore, SeriesKey, Span};

const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;

const REFUSAL: &str = "Rithmic refused the bar replay: permission denied (code 13)";

fn et(s: &str) -> Timestamp {
    Timestamp::parse(s).unwrap()
}

struct Fake {
    mock: MockMarket,
    clock: Arc<ManualClock>,
    begins: Timestamp,
    refuses_before: Option<Timestamp>,
    namesake_days: Vec<Bar>,
    ends: Mutex<Option<Timestamp>>,
    delay: Duration,
    log: Mutex<Vec<BarsRequest>>,
}

impl Fake {
    fn new(clock: &Arc<ManualClock>) -> Self {
        let mut cfg = MockConfig::new(Arc::clone(clock) as _);
        cfg.intraday_sessions = 1;
        cfg.daily_sessions = 1;
        Self {
            mock: MockMarket::new(cfg),
            clock: Arc::clone(clock),
            begins: et("2025-01-01T00:00:00Z"),
            refuses_before: None,
            namesake_days: Vec::new(),
            ends: Mutex::new(None),
            delay: Duration::ZERO,
            log: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<BarsRequest> {
        self.log.lock().clone()
    }

    fn forget(&self) {
        self.log.lock().clear();
    }

    fn minute(t: i64, forming: bool) -> Bar {
        let i = t / NANOS_PER_MINUTE;
        let q = Decimal::new(25, 2);
        let o = Decimal::from(20_000 + (i % 97)) + q * Decimal::from(i % 4);
        let c = o + q * Decimal::from((i % 5) - 2);
        let mut b = Bar {
            t: Timestamp(t),
            o: Price(o),
            h: Price(o.max(c) + q),
            l: Price(o.min(c) - q),
            c: Price(c),
            v: Qty::from(10 + i % 50),
            bv: Some(Qty::from(5 + i % 5)),
        };
        if forming {
            b.v = Qty::from(1);
            b.bv = Some(Qty::from(1));
        }
        b
    }

    fn minutes(&self, from: Timestamp, to: Timestamp) -> Vec<Bar> {
        let now = self.clock_now();
        let current = CAL.bucket_start(now, Timeframe::M1);
        let ends = *self.ends.lock();
        let mut out = Vec::new();
        let from = from.max(self.begins);
        if from > to {
            return out;
        }
        for s in CAL.sessions_between(CAL.trade_date(from), CAL.trade_date(to)) {
            for t in s.minutes() {
                if t < from
                    || t > to
                    || t < self.begins
                    || t > current
                    || ends.is_some_and(|e| t >= e)
                {
                    continue;
                }
                out.push(Self::minute(t.0, t == current));
            }
        }
        out
    }

    fn clock_now(&self) -> Timestamp {
        use tessera_core::clock::Clock;
        self.clock.now()
    }
}

#[async_trait]
impl MarketDataProvider for Fake {
    fn id(&self) -> &str {
        "fake"
    }
    fn display_name(&self) -> &str {
        "Fake"
    }
    fn capabilities(&self) -> MarketCapabilities {
        let mut c = self.mock.capabilities();
        c.max_intraday_history_days = Some(400);
        c.max_daily_history_days = Some(4_000);
        c
    }
    fn health(&self) -> ProviderHealth {
        self.mock.health()
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
        let (i, mut s) = self.mock.spec(i).await?;
        s.sessions = CAL;
        Ok((i, s))
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.log.lock().push(req.clone());
        if let (Some(f), Some(t)) = (req.from, req.to)
            && f > t
        {
            return Err(MarketError::InvalidRequest("from is after to".into()));
        }
        if let (Some(from), Some(refused)) = (req.from, self.refuses_before)
            && from < refused
        {
            return Err(MarketError::Unsupported(REFUSAL.into()));
        }
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        let now = self.clock_now();
        let to = req.to.unwrap_or(now).min(now);
        let n = req.limit.unwrap_or(500);
        let mut span = n as i64 * req.tf.nanos() * 3 + 5 * 86_400_000_000_000;
        let mut bars = loop {
            let from = req.from.unwrap_or(Timestamp(to.0 - span));
            let lo = CAL.bucket_start(from, req.tf);
            let mut bars = self.minutes(
                lo,
                to.max(CAL.bucket_start(to, req.tf))
                    .add_nanos(req.tf.nanos() - 1),
            );
            if req.tf != Timeframe::M1 {
                bars = aggregate(&bars, req.tf, CAL);
            }
            if req.tf == Timeframe::D1 {
                bars.extend(self.namesake_days.iter().filter(|b| b.t >= lo));
                bars.sort_by_key(|b| b.t);
            }
            bars.retain(|b| req.from.is_none_or(|f| b.t >= f) && req.to.is_none_or(|t| b.t <= t));
            if req.from.is_some() || bars.len() >= n || span > 60 * 86_400_000_000_000 {
                break bars;
            }
            span *= 3;
        };
        if let Some(n) = req.limit
            && bars.len() > n
        {
            bars.drain(..bars.len() - n);
        }
        Ok(BarSeries {
            instrument: req.instrument,
            tf: req.tf,
            last_bar_open: false,
            bars,
        })
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        self.mock.quote(i).await
    }
    fn subscribe_quotes(&self, i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.mock.subscribe_quotes(i)
    }
    fn subscribe_trades(&self, i: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.mock.subscribe_trades(i)
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.mock.subscribe_bars(i, tf)
    }
}

struct Desk {
    clock: Arc<ManualClock>,
    fake: Arc<Fake>,
    conn: Arc<dyn MarketDataProvider>,
    router: Arc<MarketRouter>,
    store: Arc<BarStore>,
    cache: Arc<BarCache>,
    id: InstrumentId,
}

fn noon() -> Timestamp {
    et("2026-10-07T12:00:00-04:00")
}

async fn desk_with(f: impl FnOnce(&mut Fake)) -> Desk {
    let clock = Arc::new(ManualClock::new(noon()));
    let mut fake = Fake::new(&clock);
    f(&mut fake);
    let fake = Arc::new(fake);
    let conn: Arc<dyn MarketDataProvider> = Arc::clone(&fake) as _;
    let router = MarketRouter::new();
    router.add(Arc::clone(&conn)).unwrap();
    let store = Arc::new(BarStore::open_in_memory().unwrap());
    let cache = BarCache::new(Arc::clone(&store) as _, Arc::clone(&clock) as _);
    cache.set_fill_pause(Duration::from_millis(1));
    router.set_bar_cache(Arc::clone(&cache));
    let id = router.resolve("NQ").await.unwrap();
    Desk {
        clock,
        fake,
        conn,
        router,
        store,
        cache,
        id,
    }
}

async fn desk() -> Desk {
    desk_with(|_| {}).await
}

impl Desk {
    fn key(&self) -> SeriesKey<'_> {
        SeriesKey {
            source: "fake",
            instrument: self.id.as_str(),
            series: "1m",
        }
    }

    fn latest(&self, tf: Timeframe, limit: usize) -> BarsRequest {
        BarsRequest::latest(self.id.clone(), tf, limit)
    }

    async fn read(&self, req: BarsRequest, read: Read) -> BarSeries {
        self.router.bars_from(&self.conn, req, read).await.unwrap()
    }

    fn settled(&self) -> Timestamp {
        use tessera_core::clock::Clock;
        Timestamp(CAL.bucket_start(self.clock.now(), Timeframe::M1).0 - SETTLE)
    }
}

#[tokio::test]
async fn a_read_that_needs_only_bar_opens_reuses_the_forming_minutes_for_a_few_seconds() {
    let d = desk().await;
    let cold = d.read(d.latest(Timeframe::M1, 300), Read::Recent).await;
    d.fake.forget();
    let again = d.read(d.latest(Timeframe::M1, 300), Read::Recent).await;
    assert_eq!(again, cold);
    assert_eq!(
        d.fake.requests(),
        vec![],
        "the forming minutes were just read"
    );
    let fresh = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(fresh, cold);
    let asked = d.fake.requests();
    assert_eq!(
        asked.len(),
        1,
        "a chart's own read always asks for the forming minutes"
    );
    assert_eq!(asked[0].from, Some(d.settled()));
}

#[tokio::test]
async fn reads_at_once_share_one_ask_for_the_forming_minutes() {
    let d = desk_with(|f| f.delay = Duration::from_millis(50)).await;
    d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    d.fake.forget();
    let reads = (0..6).map(|_| d.read(d.latest(Timeframe::M1, 300), Read::Through));
    let answers = futures::future::join_all(reads).await;
    assert!(answers.windows(2).all(|w| w[0] == w[1]));
    let asked = d.fake.requests();
    assert_eq!(asked.len(), 1, "{asked:?}");
    assert_eq!(asked[0].from, Some(d.settled()));
}

#[tokio::test]
async fn kept_minutes_are_served_and_only_the_tail_is_asked_again() {
    let d = desk().await;
    let cold = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(cold.bars.len(), 300);
    assert_eq!(cold.bars.last().unwrap().t, noon());
    assert!(cold.last_bar_open);
    let asked = d.fake.requests();
    assert_eq!(asked.len(), 2, "{asked:?}");
    assert_eq!(asked[0].tf, Timeframe::M1);
    assert_eq!(asked[0].to, Some(Timestamp(d.settled().0 - 1)));
    assert_eq!(asked[1].from, Some(d.settled()));
    assert_eq!(asked[1].to, None);
    let kept = d.store.covered(d.key()).unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].end, d.settled().0);

    d.fake.forget();
    let warm = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(warm, cold);
    let asked = d.fake.requests();
    assert_eq!(asked.len(), 1, "{asked:?}");
    assert_eq!(asked[0].from, Some(d.settled()));

    d.fake.forget();
    let before = d.settled();
    d.clock.advance(30 * NANOS_PER_MINUTE);
    let later = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(
        later.bars.last().unwrap().t,
        noon().add_nanos(30 * NANOS_PER_MINUTE)
    );
    let asked = d.fake.requests();
    assert_eq!(asked.len(), 2, "{asked:?}");
    assert_eq!(asked[0].from, Some(before));
    assert_eq!(asked[0].to, Some(Timestamp(d.settled().0 - 1)));
    assert_eq!(asked[1].from, Some(d.settled()));
    assert_eq!(d.store.covered(d.key()).unwrap().len(), 1);
}

#[tokio::test]
async fn timeframes_are_aggregated_from_kept_minutes_as_the_connection_does() {
    let d = desk().await;
    for (tf, n) in [
        (Timeframe::M5, 400),
        (Timeframe::M1, 50),
        (Timeframe::H1, 30),
    ] {
        let through = d.read(d.latest(tf, n), Read::Through).await;
        let native = d.conn.get_bars(d.latest(tf, n)).await.unwrap();
        assert_eq!(through.bars, native.bars, "{tf}");
        assert_eq!(through.bars.len(), n);
    }
    let first = d
        .read(d.latest(Timeframe::M5, 400), Read::Through)
        .await
        .bars[0]
        .t;
    let mut page = d.latest(Timeframe::M5, 200);
    page.to = Some(Timestamp(first.0 - 1));
    let older = d.read(page.clone(), Read::Through).await;
    let native = d.conn.get_bars(page).await.unwrap();
    assert_eq!(older.bars, native.bars);
    assert_eq!(older.bars.len(), 200);
    assert!(older.bars.last().unwrap().t < first);
    assert!(!older.last_bar_open);
}

#[tokio::test]
async fn a_read_ending_on_the_last_settled_bar_is_whole_on_every_timeframe() {
    let d = desk().await;
    for tf in [Timeframe::M1, Timeframe::M5, Timeframe::M15, Timeframe::H1] {
        let last = CAL.bucket_start(Timestamp(d.settled().0 - 1), tf);
        let req = BarsRequest {
            from: Some(Timestamp(last.0 - 3 * tf.nanos())),
            to: Some(last),
            ..d.latest(tf, 10)
        };
        d.fake.forget();
        let got = d
            .router
            .bars_from(&d.conn, req.clone(), Read::Through)
            .await
            .unwrap_or_else(|e| panic!("{tf}: {e}"));
        for asked in d.fake.requests() {
            assert!(
                asked.from.zip(asked.to).is_none_or(|(f, t)| f <= t),
                "{tf}: asked {asked:?}"
            );
        }
        let native = d.conn.get_bars(req).await.unwrap();
        assert_eq!(got.bars, native.bars, "{tf}");
        assert_eq!(got.bars.last().map(|b| b.t), Some(last), "{tf}");
    }
}

#[tokio::test]
async fn only_the_holes_are_fetched() {
    let d = desk().await;
    let range = |from: &str, to: &str| BarsRequest {
        instrument: d.id.clone(),
        tf: Timeframe::M1,
        from: Some(et(from)),
        to: Some(Timestamp(et(to).0 - 1)),
        limit: None,
        rth_only: false,
    };
    d.read(
        range("2026-10-05T09:00:00-04:00", "2026-10-05T11:00:00-04:00"),
        Read::Through,
    )
    .await;
    d.read(
        range("2026-10-07T09:00:00-04:00", "2026-10-07T10:00:00-04:00"),
        Read::Through,
    )
    .await;
    d.fake.forget();
    let all = d
        .read(
            range("2026-10-05T10:00:00-04:00", "2026-10-07T09:30:00-04:00"),
            Read::Through,
        )
        .await;
    let asked: Vec<(Timestamp, Timestamp)> = d
        .fake
        .requests()
        .iter()
        .map(|r| (r.from.unwrap(), Timestamp(r.to.unwrap().0 + 1)))
        .collect();
    assert_eq!(
        asked,
        [(
            et("2026-10-05T11:00:00-04:00"),
            et("2026-10-07T09:00:00-04:00")
        )]
    );
    let want = d.fake.minutes(
        et("2026-10-05T10:00:00-04:00"),
        Timestamp(et("2026-10-07T09:30:00-04:00").0 - 1),
    );
    assert_eq!(all.bars, want);
}

fn written_spans(
    rx: &mut tokio::sync::broadcast::Receiver<BarsWritten>,
) -> Vec<(Timestamp, Timestamp)> {
    let mut out = Vec::new();
    while let Ok(w) = rx.try_recv() {
        assert_eq!((w.source.as_str(), w.base), ("fake", Timeframe::M1));
        out.push((w.from, w.to));
    }
    out
}

#[tokio::test]
async fn bars_written_is_sent_once_per_stored_span() {
    let d = desk().await;
    let mut written = d.cache.written();
    let asked_spans = |d: &Desk| -> Vec<(Timestamp, Timestamp)> {
        d.fake
            .requests()
            .iter()
            .filter_map(|r| Some((r.from?, Timestamp(r.to?.0 + 1))))
            .collect()
    };
    d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    let stored = written_spans(&mut written);
    assert_eq!(stored.len(), 1, "{stored:?}");
    assert_eq!(stored, asked_spans(&d), "the hole the connection answered");
    assert_eq!(stored[0].1, d.settled(), "the tail is not stored");

    d.fake.forget();
    d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    d.read(d.latest(Timeframe::M5, 50), Read::Kept).await;
    assert_eq!(
        written_spans(&mut written),
        [],
        "kept bars and the tail write nothing"
    );

    let first = d.store.covered(d.key()).unwrap()[0].start;
    let mut page = d.latest(Timeframe::M1, 200);
    page.to = Some(Timestamp(first - 1));
    d.read(page, Read::Through).await;
    let stored = written_spans(&mut written);
    assert_eq!(stored.len(), 1, "{stored:?}");
    assert_eq!(
        stored[0].1,
        Timestamp(first),
        "a scroll-back page is one span"
    );

    d.fake.forget();
    d.clock.advance(30 * NANOS_PER_MINUTE);
    d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    let stored = written_spans(&mut written);
    let asked: Vec<_> = asked_spans(&d)
        .into_iter()
        .filter(|(_, to)| *to <= d.settled())
        .collect();
    assert_eq!(stored, asked, "the minutes that settled meanwhile, once");
}

#[tokio::test]
async fn a_cold_read_too_large_for_minutes_is_passed_on_as_asked() {
    let d = desk().await;
    let out = d.read(d.latest(Timeframe::M15, 1_500), Read::Through).await;
    assert_eq!(out.bars.len(), 1_500);
    let asked = d.fake.requests();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].tf, Timeframe::M15);
    assert_eq!(d.store.covered(d.key()).unwrap(), []);
    d.fake.forget();
    let _ = d.read(d.latest(Timeframe::S1, 10), Read::Through).await;
    assert_eq!(d.fake.requests()[0].tf, Timeframe::S1);
}

#[tokio::test]
async fn cached_only_reads_never_ask_the_connection() {
    let d = desk().await;
    let none = d.read(d.latest(Timeframe::M5, 100), Read::Kept).await;
    assert!(none.bars.is_empty());
    assert!(d.fake.requests().is_empty());
    let through = d.read(d.latest(Timeframe::M5, 100), Read::Through).await;
    d.fake.forget();
    let kept = d.read(d.latest(Timeframe::M5, 100), Read::Kept).await;
    assert!(d.fake.requests().is_empty());
    let settled_bucket = CAL.bucket_start(d.settled(), Timeframe::M5);
    assert_eq!(kept.bars.last().unwrap().t, settled_bucket);
    let n = kept.bars.len();
    assert!(n >= 99, "{n}");
    let whole = |s: &BarSeries| -> Vec<Bar> {
        s.bars
            .iter()
            .filter(|b| b.t < settled_bucket && b.t >= through.bars[0].t)
            .copied()
            .collect()
    };
    assert_eq!(whole(&kept), whole(&through));
    assert!(whole(&kept).len() > 90);
    let mut old = d.latest(Timeframe::M5, 100);
    old.to = Some(et("2026-09-01T12:00:00-04:00"));
    assert!(d.read(old, Read::Kept).await.bars.is_empty());
    let run = d.store.covered(d.key()).unwrap()[0];
    let mut page = d.latest(Timeframe::M5, 1_000);
    page.to = Some(Timestamp(kept.bars[0].t.0 - 1));
    let older = d.read(page, Read::Kept).await;
    assert!(!older.bars.is_empty());
    assert!(older.bars[0].t.0 >= run.start);
    assert!(older.bars.last().unwrap().t < kept.bars[0].t);
    let mut before = d.latest(Timeframe::M5, 100);
    before.to = Some(Timestamp(run.start - 1));
    assert!(d.read(before, Read::Kept).await.bars.is_empty());
    assert!(d.fake.requests().is_empty());
}

#[tokio::test]
async fn daily_bars_are_kept_apart() {
    let d = desk().await;
    let cold = d.read(d.latest(Timeframe::D1, 20), Read::Through).await;
    assert_eq!(cold.bars.len(), 20);
    d.fake.forget();
    let warm = d.read(d.latest(Timeframe::D1, 20), Read::Through).await;
    assert_eq!(warm, cold);
    let asked = d.fake.requests();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].tf, Timeframe::D1);
    assert_eq!(asked[0].from, Some(et("2026-10-06T00:00:00-04:00")));
    let daily = SeriesKey {
        series: "1D",
        ..d.key()
    };
    assert_eq!(d.store.covered(daily).unwrap().len(), 1);
}

fn collect() -> (
    tessera_market::history::Publish,
    Arc<Mutex<Vec<HistoryKept>>>,
) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = Arc::clone(&seen);
    (Arc::new(move |k| s.lock().push(k)), seen)
}

async fn fill_ends(d: &Desk, seen: &Mutex<Vec<HistoryKept>>, past: impl Fn(&HistoryKept) -> bool) {
    settle(
        "the fill",
        || (seen.lock().last().cloned(), d.fake.requests().len()),
        |(last, _)| last.as_ref().is_some_and(|k| !k.filling && past(k)),
    )
    .await;
}

async fn requested(d: &Desk, done: impl Fn(usize) -> bool) {
    settle(
        "the background requests",
        || d.fake.requests().len(),
        |n| done(*n),
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn the_background_fill_reaches_its_depth_in_small_requests_and_stops() {
    let d = desk().await;
    let (publish, seen) = collect();
    let guard = d
        .cache
        .fill(&d.router, &d.id, Timeframe::M1, publish)
        .unwrap();
    fill_ends(&d, &seen, |_| true).await;
    let sessions = fill_sessions(Timeframe::M1);
    let want = CAL.last_sessions(noon(), sessions)[0].open;
    let kept = d.store.covered(d.key()).unwrap();
    assert_eq!(kept, [Span::new(want.0, d.settled().0)]);
    let asked = d.fake.requests();
    assert_eq!(asked.len(), sessions.div_ceil(FILL_SESSIONS_PER_REQUEST));
    for w in asked.windows(2) {
        assert!(w[1].from.unwrap() < w[0].from.unwrap());
    }
    for r in &asked {
        assert_eq!(r.tf, Timeframe::M1);
        let rows = d.fake.minutes(r.from.unwrap(), r.to.unwrap()).len();
        assert!(rows < 9_000, "{rows}");
        let wall = (r.to.unwrap().0 - r.from.unwrap().0) / NANOS_PER_MINUTE;
        assert!(wall < 9_000, "{wall}");
    }
    let froms: Vec<Timestamp> = seen.lock().iter().filter_map(|k| k.from).collect();
    assert!(froms.windows(2).all(|w| w[1] <= w[0]));
    assert_eq!(*froms.last().unwrap(), want);
    let n = d.fake.requests().len();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(d.fake.requests().len(), n);
    let (publish, seen5) = collect();
    let deeper = d
        .cache
        .fill(&d.router, &d.id, Timeframe::M5, publish)
        .unwrap();
    fill_ends(&d, &seen, |k| k.from.is_some_and(|f| f < want)).await;
    assert!(seen5.lock().is_empty(), "the first chart's fill publishes");
    drop(deeper);
    drop(guard);
    d.fake.forget();
    let kept = d.read(d.latest(Timeframe::M1, 40_000), Read::Kept).await;
    assert_eq!(kept.bars.len(), 40_000);
    assert!(d.fake.requests().is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_fill_lets_foreground_reads_go_first() {
    let d = desk_with(|f| f.delay = Duration::from_millis(500)).await;
    let (publish, _seen) = collect();
    let _guard = d
        .cache
        .fill(&d.router, &d.id, Timeframe::M1, publish)
        .unwrap();
    requested(&d, |n| n == 1).await;
    let mut page = d.latest(Timeframe::M5, 200);
    page.to = Some(et("2026-09-04T12:00:00-04:00"));
    let fg = {
        let router = Arc::clone(&d.router);
        let conn = Arc::clone(&d.conn);
        tokio::spawn(async move { router.bars_from(&conn, page, Read::Through).await })
    };
    let out = fg.await.unwrap().unwrap();
    assert_eq!(out.bars.len(), 200);
    let asked = d.fake.requests();
    assert!(asked.len() >= 2);
    assert!(
        asked[1].to.unwrap() < et("2026-09-04T12:05:00-04:00"),
        "{:?}",
        asked[1]
    );
    assert!(asked[1].from.unwrap() < et("2026-09-04T00:00:00-04:00"));
}

#[tokio::test(start_paused = true)]
async fn the_fill_stops_when_the_chart_leaves() {
    let d = desk_with(|f| f.delay = Duration::from_millis(200)).await;
    let (publish, _seen) = collect();
    let guard = d
        .cache
        .fill(&d.router, &d.id, Timeframe::M5, publish)
        .unwrap();
    requested(&d, |n| n >= 2).await;
    drop(guard);
    tokio::time::sleep(Duration::from_millis(400)).await;
    let n = d.fake.requests().len();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(d.fake.requests().len(), n);
    assert!(n < fill_sessions(Timeframe::M5) / FILL_SESSIONS_PER_REQUEST);
}

#[tokio::test]
async fn the_fill_stops_where_the_connection_has_no_older_bars() {
    let listed = et("2026-09-16T18:00:00-04:00");
    let d = desk_with(|f| f.begins = listed).await;
    let (publish, seen) = collect();
    let _guard = d
        .cache
        .fill(&d.router, &d.id, Timeframe::M5, publish)
        .unwrap();
    fill_ends(&d, &seen, |_| true).await;
    let asked = d.fake.requests();
    let oldest = asked.iter().map(|r| r.from.unwrap()).min().unwrap();
    assert!(oldest < listed);
    assert!(
        oldest > Timestamp(listed.0 - 12 * 86_400_000_000_000),
        "{oldest}"
    );
    assert!(asked.len() < fill_sessions(Timeframe::M5) / FILL_SESSIONS_PER_REQUEST);
}

#[tokio::test]
async fn a_recent_stretch_the_connection_has_no_bars_for_is_asked_again() {
    let lag = et("2026-10-01T17:00:00-04:00");
    let d = desk().await;
    *d.fake.ends.lock() = Some(lag);
    let first = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(first.bars.len(), 300);
    assert!(first.bars.last().unwrap().t < lag);
    assert!(
        d.fake.requests().iter().all(|r| r.from.is_some()),
        "{:?}",
        d.fake.requests()
    );
    d.fake.forget();
    let again = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(again.bars, first.bars);
    assert!(
        d.fake
            .requests()
            .iter()
            .all(|r| r.from.unwrap().0 >= lag.0 - NANOS_PER_MINUTE)
    );
    let kept = d.store.covered(d.key()).unwrap();
    assert!(kept.iter().all(|k| k.end <= lag.0), "{kept:?}");
    *d.fake.ends.lock() = None;
    let later = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(later.bars.last().unwrap().t, noon());
    assert_eq!(later.bars.len(), 300);
    *d.fake.ends.lock() = Some(lag);
    let d2 = desk_with(|f| *f.ends.get_mut() = Some(lag)).await;
    let (publish, seen) = collect();
    let _g = d2
        .cache
        .fill(&d2.router, &d2.id, Timeframe::M1, publish)
        .unwrap();
    fill_ends(&d2, &seen, |_| true).await;
    let asked = d2.fake.requests();
    let mut froms: Vec<Timestamp> = asked.iter().map(|r| r.from.unwrap()).collect();
    froms.dedup();
    assert_eq!(froms.len(), asked.len(), "a span asked twice: {asked:?}");
    let kept = d2.store.covered(d2.key()).unwrap();
    assert_eq!(kept.last().unwrap().end, lag.0);
}

#[tokio::test]
async fn an_empty_weekend_is_known() {
    let d = desk().await;
    d.clock.set(et("2026-10-10T12:00:00-04:00"));
    let out = d.read(d.latest(Timeframe::M1, 100), Read::Through).await;
    assert_eq!(out.bars.last().unwrap().t, et("2026-10-09T16:59:00-04:00"));
    let kept = d.store.covered(d.key()).unwrap();
    assert_eq!(kept.last().unwrap().end, d.settled().0);
}

fn refusing_before(refused: Timestamp, begins: Timestamp) -> impl FnOnce(&mut Fake) {
    move |f| {
        f.begins = begins;
        f.refuses_before = Some(refused);
    }
}

#[tokio::test]
async fn older_bars_refused_while_reaching_back_leave_the_bars_found() {
    let begins = et("2026-10-07T10:00:00-04:00");
    let refused = Timestamp(begins.0 - 86_400_000_000_000);
    let d = desk_with(refusing_before(refused, begins)).await;
    let out = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(out.bars.first().unwrap().t, begins);
    assert_eq!(out.bars.last().unwrap().t, noon());
    let asked = d.fake.requests();
    assert_eq!(
        asked
            .iter()
            .filter(|r| r.from.is_some_and(|f| f < refused))
            .count(),
        1,
        "{asked:?}"
    );
}

#[tokio::test]
async fn a_first_reach_refused_is_answered_by_the_connection_as_asked() {
    let refused = et("2026-10-07T10:00:00-04:00");
    let d = desk_with(refusing_before(refused, refused)).await;
    let out = d.read(d.latest(Timeframe::M1, 300), Read::Through).await;
    assert_eq!(out.bars.first().unwrap().t, refused);
    assert_eq!(out.bars.last().unwrap().t, noon());
    assert!(d.fake.requests().last().unwrap().from.is_none());
}

#[tokio::test(start_paused = true)]
async fn the_fill_stops_where_the_connection_refuses_older_bars_and_never_asks_again() {
    let refused = et("2026-10-01T18:00:00-04:00");
    let d = desk_with(refusing_before(refused, refused)).await;
    let (publish, seen) = collect();
    let _guard = d
        .cache
        .fill(&d.router, &d.id, Timeframe::M1, publish)
        .unwrap();
    fill_ends(&d, &seen, |_| true).await;
    let n = d.fake.requests().len();
    tokio::time::sleep(Duration::from_secs(600)).await;
    let asked = d.fake.requests();
    assert_eq!(asked.len(), n, "{asked:?}");
    assert_eq!(
        asked
            .iter()
            .filter(|r| r.from.is_some_and(|f| f < refused))
            .count(),
        1
    );
    assert!(n < fill_sessions(Timeframe::M1) / FILL_SESSIONS_PER_REQUEST);
}

fn namesake_days(from: &str, to: &str) -> Vec<Bar> {
    let (from, to) = (et(from), et(to));
    CAL.sessions_between(CAL.trade_date(from), CAL.trade_date(to))
        .iter()
        .map(|x| {
            let t = tessera_core::time::local_to_timestamp(CAL.tz(), x.trade_date, 0, 0);
            Bar::flat(t, Price::from(2_100), Qty::from(1_000))
        })
        .collect()
}

fn decade_old_namesake(f: &mut Fake) {
    f.begins = et("2026-06-01T00:00:00Z");
    f.namesake_days = namesake_days("2015-12-01T12:00:00-05:00", "2016-12-16T12:00:00-05:00");
}

fn first_own_day() -> Timestamp {
    et("2017-01-01T00:00:00-05:00")
}

fn foreign(bars: &[Bar]) -> Vec<Bar> {
    bars.iter()
        .filter(|b| b.t < first_own_day() || b.c < Price::from(10_000))
        .copied()
        .collect()
}

impl Desk {
    fn daily(&self) -> SeriesKey<'_> {
        SeriesKey {
            series: "1D",
            ..self.key()
        }
    }
}

#[tokio::test]
async fn a_long_daily_pull_keeps_only_the_contracts_own_bars_not_its_namesakes_a_decade_before() {
    let d = desk_with(decade_old_namesake).await;
    let chart = d.read(d.latest(Timeframe::D1, 3_000), Read::Through).await;
    assert!(
        d.fake
            .requests()
            .iter()
            .all(|r| r.from.is_none_or(|f| f >= first_own_day())),
        "{:?}",
        d.fake.requests()
    );
    assert!(chart.bars.len() > 50, "{}", chart.bars.len());
    assert_eq!(foreign(&chart.bars), []);
    let kept = d.store.read(d.daily(), i64::MIN, i64::MAX).unwrap();
    assert!(!kept.is_empty());
    assert_eq!(foreign(&kept), []);
    assert!(
        d.store
            .covered(d.daily())
            .unwrap()
            .iter()
            .all(|c| c.start >= first_own_day().0)
    );
    let studies = d.read(d.latest(Timeframe::D1, 3_000), Read::Kept).await;
    assert_eq!(studies.bars, chart.bars[..studies.bars.len()]);
    assert_eq!(foreign(&studies.bars), []);
}

#[tokio::test]
async fn another_contracts_bars_already_kept_are_cleared_from_the_store_and_the_chart() {
    let d = desk_with(decade_old_namesake).await;
    let junk = d.fake.namesake_days.clone();
    let day = |t: Timestamp| i64::from(chrono::Datelike::year(&CAL.trade_date(t)));
    d.store
        .write(
            d.daily(),
            &junk,
            day,
            Some(Span::new(junk[0].t.0, junk[junk.len() - 1].t.0 + 1)),
        )
        .unwrap();
    let minute_junk: Vec<Bar> = junk
        .iter()
        .map(|b| Bar {
            t: b.t.add_nanos(10 * 60 * NANOS_PER_MINUTE),
            ..*b
        })
        .collect();
    d.store
        .write(d.key(), &minute_junk, |t| t.0 / 86_400_000_000_000, None)
        .unwrap();

    let studies = d.read(d.latest(Timeframe::D1, 3_000), Read::Kept).await;
    assert_eq!(foreign(&studies.bars), []);
    assert_eq!(
        foreign(&d.store.read(d.daily(), i64::MIN, i64::MAX).unwrap()),
        []
    );

    let chart = d.read(d.latest(Timeframe::D1, 3_000), Read::Through).await;
    assert!(chart.bars.len() > 50, "{}", chart.bars.len());
    assert_eq!(foreign(&chart.bars), []);
    let _ = d.read(d.latest(Timeframe::M1, 100), Read::Through).await;
    assert_eq!(
        foreign(&d.store.read(d.key(), i64::MIN, i64::MAX).unwrap()),
        []
    );
    assert!(
        d.store
            .covered(d.daily())
            .unwrap()
            .iter()
            .all(|c| c.start >= first_own_day().0)
    );
}
