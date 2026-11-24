mod support;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::{Clock, ManualClock};
use tessera_core::health::ProviderHealth;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Bar, Quote, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::settle::{STALL, settle};
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_core::{InstrumentId, Origin, Price, Qty, Timeframe, Timestamp};
use tessera_host::{EventBus, KeyFilter, TopicSizing};
use tessera_indicators::io::{Replaces, SeriesUpdate};
use tessera_indicators::{
    BarKind, CATALOG_TOPIC, Grid, IndicatorsModule, IndicatorsService, SERIES_TOPIC, builtin_series,
};
use tessera_market::aggregate::aggregate;
use tessera_market::history::{BarCache, Read};
use tessera_market::io::SessionFilter;
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket,
};
use tessera_protocol::layers::LayerKind;
use tessera_protocol::topics::names;
use tessera_store::Store;
use tessera_store::bars::BarStore;
use tessera_tools::{ToolCtx, ToolRegistry};

const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;

fn et(s: &str) -> Timestamp {
    Timestamp::parse(s).unwrap()
}

fn noon() -> Timestamp {
    et("2026-10-07T12:00:00-04:00")
}

struct Fake {
    id: &'static str,
    offset: i64,
    mock: MockMarket,
    clock: Arc<ManualClock>,
    revised: Mutex<Vec<(Timestamp, Timestamp)>>,
    log: Mutex<Vec<BarsRequest>>,
    answer: Mutex<Answer>,
    gate: tokio::sync::RwLock<()>,
    waiting: std::sync::atomic::AtomicUsize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    Bars,
    Nothing,
    Failure,
}

impl Fake {
    fn new(id: &'static str, offset: i64, clock: &Arc<ManualClock>) -> Arc<Self> {
        let mut cfg = MockConfig::new(Arc::clone(clock) as _);
        cfg.intraday_sessions = 1;
        cfg.daily_sessions = 1;
        Arc::new(Self {
            id,
            offset,
            mock: MockMarket::new(cfg),
            clock: Arc::clone(clock),
            revised: Mutex::new(Vec::new()),
            log: Mutex::new(Vec::new()),
            answer: Mutex::new(Answer::Bars),
            gate: tokio::sync::RwLock::new(()),
            waiting: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn minute(&self, t: i64, forming: bool) -> Bar {
        let i = t / NANOS_PER_MINUTE;
        let q = Decimal::new(25, 2);
        let o = Decimal::from(20_000 + self.offset + (i % 97)) + q * Decimal::from(i % 4);
        let mut c = o + q * Decimal::from((i % 5) - 2);
        let revised = self
            .revised
            .lock()
            .iter()
            .any(|(from, to)| t >= from.0 && t < to.0);
        if revised {
            c += Decimal::from(7);
        }
        Bar {
            t: Timestamp(t),
            o: Price(o),
            h: Price(o.max(c) + q),
            l: Price(o.min(c) - q),
            c: Price(c),
            v: Qty::from(if forming { 1 } else { 10 + i % 50 }),
            bv: None,
        }
    }

    fn revise(&self, from: Timestamp, to: Timestamp) {
        self.revised.lock().push((from, to));
    }

    fn requests(&self) -> Vec<BarsRequest> {
        self.log.lock().clone()
    }

    fn forget(&self) {
        self.log.lock().clear();
    }

    async fn hold(&self) -> tokio::sync::RwLockWriteGuard<'_, ()> {
        self.gate.write().await
    }

    async fn a_read_waits(&self) {
        settle(
            "a read reached the gate",
            || self.waiting.load(std::sync::atomic::Ordering::SeqCst),
            |waiting| *waiting > 0,
        )
        .await;
    }

    fn minutes(&self, from: Timestamp, to: Timestamp) -> Vec<Bar> {
        let now = self.clock.now();
        let current = CAL.bucket_start(now, Timeframe::M1);
        let mut out = Vec::new();
        for s in CAL.sessions_between(CAL.trade_date(from), CAL.trade_date(to)) {
            for t in s.minutes() {
                if t < from || t > to || t > current {
                    continue;
                }
                out.push(self.minute(t.0, t == current));
            }
        }
        out
    }
}

#[async_trait]
impl MarketDataProvider for Fake {
    fn id(&self) -> &str {
        self.id
    }
    fn display_name(&self) -> &str {
        self.id
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
        self.waiting
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _open = self.gate.read().await;
        self.waiting
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.log.lock().push(req.clone());
        match *self.answer.lock() {
            Answer::Bars => {}
            Answer::Nothing => {
                return Ok(BarSeries {
                    instrument: req.instrument,
                    tf: req.tf,
                    last_bar_open: false,
                    bars: Vec::new(),
                });
            }
            Answer::Failure => {
                return Err(MarketError::Unavailable("the connection dropped".into()));
            }
        }
        let now = self.clock.now();
        let to = req.to.unwrap_or(now).min(now);
        let n = req.limit.unwrap_or(500);
        let mut span = n as i64 * req.tf.nanos() * 3 + 5 * 86_400_000_000_000;
        let mut bars = loop {
            let from = req.from.unwrap_or(Timestamp(to.0 - span));
            let lo = CAL.bucket_start(from, req.tf);
            let hi = to
                .max(CAL.bucket_start(to, req.tf))
                .add_nanos(req.tf.nanos() - 1);
            let mut bars = self.minutes(lo, hi);
            if req.rth_only {
                bars.retain(|b| CAL.is_rth(b.t));
            }
            if req.tf != Timeframe::M1 {
                bars = aggregate(&bars, req.tf, CAL);
            }
            bars.retain(|b| req.from.is_none_or(|f| b.t >= f) && req.to.is_none_or(|t| b.t <= t));
            if req.from.is_some() || bars.len() >= n || span > 200 * 86_400_000_000_000 {
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

struct World {
    clock: Arc<ManualClock>,
    fakes: Vec<Arc<Fake>>,
    router: Arc<MarketRouter>,
    bus: Arc<EventBus>,
    series: Arc<dyn tessera_host::TopicHandler>,
    tools: ToolRegistry,
    id: InstrumentId,
}

async fn world(offsets: &[(&'static str, i64)]) -> World {
    let clock = Arc::new(ManualClock::new(noon()));
    let fakes: Vec<Arc<Fake>> = offsets
        .iter()
        .map(|(id, offset)| Fake::new(id, *offset, &clock))
        .collect();
    let router = MarketRouter::new();
    for f in &fakes {
        router
            .add(Arc::clone(f) as Arc<dyn MarketDataProvider>)
            .unwrap();
    }
    let store = Arc::new(BarStore::open_in_memory().unwrap());
    let cache = BarCache::new(store as _, Arc::clone(&clock) as _);
    router.set_bar_cache(cache);
    let bus = Arc::new(EventBus::new());
    for t in [names::MARKET_BARS, names::MARKET_FOOTPRINT, SERIES_TOPIC] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    bus.register(CATALOG_TOPIC, TopicSizing::SNAPSHOT).unwrap();
    let svc = IndicatorsService::load(
        Store::open_in_memory().unwrap(),
        Arc::clone(&router),
        None,
        Arc::clone(&bus),
        Arc::clone(&clock) as _,
    )
    .unwrap();
    let module = IndicatorsModule::new(svc);
    let mut tools = ToolRegistry::new();
    tessera_host::RuntimeModule::register_tools(&module, &mut tools).unwrap();
    let id = router.resolve("NQ").await.unwrap();
    World {
        clock,
        fakes,
        router,
        bus,
        series: support::series(&module),
        tools,
        id,
    }
}

impl World {
    fn now(&self) -> Timestamp {
        self.clock.now()
    }

    async fn bars(
        &self,
        tf: Timeframe,
        from: Option<Timestamp>,
        limit: usize,
        rth: bool,
    ) -> Vec<Bar> {
        let conn = self.router.route_async(&self.id).await.unwrap();
        let req = BarsRequest {
            instrument: self.id.clone(),
            tf,
            from,
            to: None,
            limit: Some(limit),
            rth_only: rth,
        };
        self.router
            .bars_from(&conn, req, Read::Through)
            .await
            .unwrap()
            .bars
    }

    async fn subscribe(&self, params: Value) -> (tessera_host::Subscribed, SeriesUpdate, String) {
        let sub = self.series.subscribe(params).await.unwrap();
        let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
        let KeyFilter::Id(key) = sub.filter.clone() else {
            panic!("an id filter")
        };
        (sub, snap, key)
    }

    async fn call(&self, name: &str, input: Value) -> Value {
        self.tools
            .get(name)
            .unwrap()
            .call_json(&ToolCtx::new(Origin::User, self.now()), input)
            .await
            .unwrap()
            .value
    }
}

fn grid(tf: Timeframe, session: SessionFilter) -> Grid {
    Grid {
        calendar: CAL,
        bars: BarKind::Time(tf),
        session,
    }
}

fn recomputed(kind: &str, inputs: Value, bars: &[Bar], grid: Grid) -> Vec<(String, Vec<f64>)> {
    builtin_series(
        LayerKind::parse(kind).unwrap(),
        inputs.as_object().unwrap(),
        bars,
        grid,
    )
    .unwrap()
}

fn bits(v: &[f64]) -> Vec<u64> {
    v.iter().map(|x| x.to_bits()).collect()
}

fn times(bars: &[Bar]) -> Vec<i64> {
    bars.iter().map(|b| b.t.0 / 1_000_000).collect()
}

fn same_values(u: &SeriesUpdate, want: &[(String, Vec<f64>)], what: &str) {
    for (key, values) in want {
        assert_eq!(
            bits(&support::column(u, key)),
            bits(values),
            "{what}: {key}"
        );
    }
}

fn running_tasks() -> usize {
    tokio::runtime::Handle::current()
        .metrics()
        .num_alive_tasks()
}

async fn wound_down(running: usize) {
    settle("the closed subscription winds down", running_tasks, |now| {
        *now <= running
    })
    .await;
}

#[tokio::test]
async fn params_have_their_own_entries() {
    let w = world(&[("fake", 0)]).await;
    let (_a, a, ka) = w
        .subscribe(
            json!({"indicator": "sma", "inputs": {"length": 20}, "instrument": "NQ", "tf": "5m"}),
        )
        .await;
    let (_b, b, kb) = w
        .subscribe(
            json!({"indicator": "sma", "inputs": {"length": 50}, "instrument": "NQ", "tf": "5m"}),
        )
        .await;
    assert_ne!(ka, kb);
    let bars = w.bars(Timeframe::M5, None, 1_500, false).await;
    assert_eq!(support::times_ms(&a), times(&bars));
    let g = grid(Timeframe::M5, SessionFilter::All);
    same_values(
        &a,
        &recomputed("sma", json!({"length": 20}), &bars, g),
        "sma 20",
    );
    same_values(
        &b,
        &recomputed("sma", json!({"length": 50}), &bars, g),
        "sma 50",
    );
    assert_ne!(
        bits(&support::column(&a, "ma")),
        bits(&support::column(&b, "ma"))
    );

    let (_c, c, kc) = w
        .subscribe(json!({"indicator": "sma", "inputs": {"source": "close", "length": 20}, "instrument": "NQ", "tf": "5m"}))
        .await;
    let (_d, d, kd) = w
        .subscribe(json!({"indicator": "sma", "instrument": "NQ", "tf": "5m"}))
        .await;
    assert_eq!(
        (kc.as_str(), kd.as_str()),
        (ka.as_str(), ka.as_str()),
        "the same study"
    );
    assert_eq!(
        (c.compute_ms.to_bits(), d.compute_ms.to_bits()),
        (a.compute_ms.to_bits(), a.compute_ms.to_bits()),
        "not computed again"
    );
    assert_eq!(
        bits(&support::column(&c, "ma")),
        bits(&support::column(&a, "ma"))
    );
}

#[tokio::test]
async fn a_weekly_vwap_followed_from_midweek_is_measured_from_the_weeks_first_session() {
    let w = world(&[("fake", 0)]).await;
    let monday = chrono::NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
    let week_open = CAL.session(monday).unwrap().open;
    let from = et("2026-10-07T04:00:00-04:00");
    let week = json!({"period": "week"});
    let (_sub, snap, _) = w
        .subscribe(json!({"indicator": "vwap", "inputs": week, "instrument": "NQ", "tf": "5m", "from": from.0}))
        .await;
    assert_eq!(support::times_ms(&snap)[0], from.0 / 1_000_000);
    let bars = w.bars(Timeframe::M5, Some(week_open), 50_000, false).await;
    let skip = bars.iter().position(|b| b.t == from).unwrap();
    let whole = recomputed("vwap", week, &bars, grid(Timeframe::M5, SessionFilter::All));
    let served: Vec<(String, Vec<f64>)> = whole
        .into_iter()
        .map(|(k, v)| (k, v[skip..].to_vec()))
        .collect();
    let mid = &served.iter().find(|(k, _)| k == "vwap").unwrap().1;
    assert!(mid.iter().all(|x| !x.is_nan()), "the week's start is read");
    same_values(&snap, &served, "from Monday's open");
    let session = recomputed(
        "vwap",
        json!({}),
        &bars[skip..],
        grid(Timeframe::M5, SessionFilter::All),
    );
    assert_ne!(
        bits(&support::column(&snap, "vwap")),
        bits(&session[0].1),
        "not the session's"
    );
}

#[tokio::test]
async fn the_session_filter_is_its_own_series() {
    let w = world(&[("fake", 0)]).await;
    let (_all, all, k_all) = w
        .subscribe(json!({"indicator": "vwap", "instrument": "NQ", "tf": "5m"}))
        .await;
    let (_rth, rth, k_rth) = w
        .subscribe(json!({"indicator": "vwap", "instrument": "NQ", "tf": "5m", "session": "rth"}))
        .await;
    assert_ne!(k_all, k_rth);
    let bars = w.bars(Timeframe::M5, None, 1_500, true).await;
    assert!(bars.iter().all(|b| CAL.is_rth(b.t)));
    assert_eq!(
        support::times_ms(&rth),
        times(&bars),
        "regular-hours bars only"
    );
    same_values(
        &rth,
        &recomputed(
            "vwap",
            json!({}),
            &bars,
            grid(Timeframe::M5, SessionFilter::Rth),
        ),
        "rth",
    );
    let all_bars = w.bars(Timeframe::M5, None, 1_500, false).await;
    same_values(
        &all,
        &recomputed(
            "vwap",
            json!({}),
            &all_bars,
            grid(Timeframe::M5, SessionFilter::All),
        ),
        "all hours",
    );
    let at = |u: &SeriesUpdate, t: i64| {
        let i = support::times_ms(u).iter().position(|x| *x == t).unwrap();
        support::column(u, "vwap")[i]
    };
    let t = *support::times_ms(&rth).last().unwrap();
    assert_ne!(
        at(&rth, t),
        at(&all, t),
        "the overnight session is left out"
    );
}

#[tokio::test]
async fn a_correction_in_bars_db_reaches_followed_and_idle_series() {
    let w = world(&[("fake", 0)]).await;
    let fake = &w.fakes[0];
    let sma = json!({"length": 5});
    let mut rx = support::subscribe_bus(&w.bus);
    let (_sub, snap, key) = w
        .subscribe(json!({"indicator": "sma", "inputs": sma, "instrument": "NQ", "tf": "1m"}))
        .await;
    let idle =
        json!({"indicator": "sma", "inputs": sma, "instrument": "NQ", "tf": "5m", "limit": 300});
    w.call("indicators.compute", idle.clone()).await;
    let held = support::times_ms(&snap);
    let minute = |ms: i64| Timestamp(ms * 1_000_000);
    let corrected = minute(held[held.len() - 2]);
    fake.revise(corrected, Timestamp(corrected.0 + NANOS_PER_MINUTE));

    w.clock.advance(NANOS_PER_MINUTE);
    w.bars(Timeframe::M1, None, 50, false).await;

    w.clock.advance(9 * NANOS_PER_MINUTE);
    w.bars(Timeframe::M1, None, 50, false).await;
    let u = support::next(&mut rx, &key).await;
    assert_eq!(
        u.rev,
        snap.rev + 1,
        "nothing changed a minute on, nothing was sent"
    );
    let Replaces::Span { from, to } = u.replaces else {
        panic!("a span")
    };
    assert_eq!(from, corrected, "from the corrected bar");
    assert_eq!(to, minute(*held.last().unwrap()));
    let bars: Vec<Bar> = w
        .bars(Timeframe::M1, Some(minute(held[0])), 50_000, false)
        .await
        .into_iter()
        .filter(|b| b.t <= to)
        .collect();
    let want = recomputed(
        "sma",
        sma.clone(),
        &bars,
        grid(Timeframe::M1, SessionFilter::All),
    );
    let at = bars.iter().position(|b| b.t == corrected).unwrap();
    let tail: Vec<(String, Vec<f64>)> = want
        .iter()
        .map(|(k, v)| (k.clone(), v[at..].to_vec()))
        .collect();
    same_values(&u, &tail, "the corrected values");

    fake.forget();
    let read = w.call("indicators.compute", idle).await;
    let unsettled = CAL.bucket_start(
        Timestamp(CAL.bucket_start(w.now(), Timeframe::M1).0 - 2 * NANOS_PER_MINUTE),
        Timeframe::M1,
    );
    let asked = fake.requests();
    assert!(
        asked.iter().all(|r| r.from.is_some_and(|f| f >= unsettled)),
        "only the minutes still settling are asked of the connection: {asked:?}"
    );
    let from = Timestamp(read["computedFrom"].as_i64().unwrap());
    let bars = w.bars(Timeframe::M5, Some(from), 50_000, false).await;
    let want = recomputed("sma", sma, &bars, grid(Timeframe::M5, SessionFilter::All));
    let got: Vec<u64> = read["plots"][0]["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap_or(f64::NAN).to_bits())
        .collect();
    assert_eq!(
        got,
        bits(&want[0].1[want[0].1.len() - 300..]),
        "the idle series is corrected on its next read"
    );
}

#[tokio::test]
async fn a_data_source_change_replaces_everything() {
    let w = world(&[("fake-a", 0), ("fake-b", 100)]).await;
    let mut rx = support::subscribe_bus(&w.bus);
    let (_sub, snap, key) = w
        .subscribe(json!({"indicator": "ema", "instrument": "NQ", "tf": "5m"}))
        .await;
    let first = snap.provider.clone();
    let gone = w.router.remove(&first).unwrap();
    let u = loop {
        let u = support::next(&mut rx, &key).await;
        if u.provider != first {
            break u;
        }
    };
    assert_eq!(u.replaces, Replaces::All);
    assert_ne!(u.provider, gone.id());
    let bars = w.bars(Timeframe::M5, None, 1_500, false).await;
    assert_eq!(support::times_ms(&u), times(&bars));
    same_values(
        &u,
        &recomputed(
            "ema",
            json!({}),
            &bars,
            grid(Timeframe::M5, SessionFilter::All),
        ),
        "the new connection's bars",
    );
}

#[tokio::test]
async fn reopen_is_a_hit() {
    let w = world(&[("fake", 0)]).await;
    let params = json!({"indicator": "rsi", "instrument": "NQ", "tf": "5m"});
    let running = running_tasks();
    let (sub, first, _) = w.subscribe(params.clone()).await;
    drop(sub);
    wound_down(running).await;
    w.fakes[0].forget();
    let (_sub, again, _) = w.subscribe(params).await;
    assert_eq!(again.time, first.time);
    assert_eq!(
        bits(&support::column(&again, "rsi")),
        bits(&support::column(&first, "rsi"))
    );
    let settled = CAL.bucket_start(
        Timestamp(CAL.bucket_start(w.now(), Timeframe::M1).0 - 2 * NANOS_PER_MINUTE),
        Timeframe::M5,
    );
    let asked = settle(
        "the tail is caught up after the snapshot",
        || w.fakes[0].requests(),
        |asked| !asked.is_empty(),
    )
    .await;
    assert!(
        asked.iter().all(|r| r.from.is_some_and(|f| f >= settled)),
        "only the unsettled tail is asked again: {asked:?}"
    );
}

#[tokio::test]
async fn a_warm_series_answers_at_once_and_its_catch_up_follows_as_a_span() {
    let w = world(&[("fake", 0)]).await;
    let params = json!({"indicator": "ema", "instrument": "NQ", "tf": "1m"});
    let running = running_tasks();
    let (sub, first, _) = w.subscribe(params.clone()).await;
    drop(sub);
    wound_down(running).await;
    w.clock.advance(3 * NANOS_PER_MINUTE);
    let mut rx = support::subscribe_bus(&w.bus);
    let gate = w.fakes[0].hold().await;
    let (_sub, snap, key) = tokio::time::timeout(STALL, w.subscribe(params))
        .await
        .expect("the snapshot does not wait for a read");
    assert_eq!(snap.time, first.time, "the frame as it was held");
    drop(gate);
    let u = support::next(&mut rx, &key).await;
    assert_eq!(u.rev, snap.rev + 1);
    let Replaces::Span { from, to } = u.replaces else {
        panic!("a span")
    };
    let held = support::times_ms(&snap);
    assert!(to.0 / 1_000_000 >= *held.last().unwrap());
    let at = held.partition_point(|t| *t < from.0 / 1_000_000);
    let mut time = held[..at].to_vec();
    time.extend(support::times_ms(&u));
    let bars = w
        .bars(
            Timeframe::M1,
            Some(Timestamp(time[0] * 1_000_000)),
            50_000,
            false,
        )
        .await;
    assert_eq!(time, times(&bars), "the minutes since, appended");
    for (k, want) in recomputed(
        "ema",
        json!({}),
        &bars,
        grid(Timeframe::M1, SessionFilter::All),
    ) {
        let mut got = support::column(&snap, &k)[..at].to_vec();
        got.extend(support::column(&u, &k));
        assert_eq!(bits(&got), bits(&want), "{k} as a full recompute");
    }
}

#[tokio::test]
async fn a_study_subscribed_while_its_frame_reads_is_answered_without_waiting_for_the_read() {
    let w = world(&[("fake", 0)]).await;
    let ema = json!({"indicator": "ema", "instrument": "NQ", "tf": "1m"});
    let sma = json!({"indicator": "sma", "instrument": "NQ", "tf": "1m"});
    let running = running_tasks();
    let (sub, _, _) = w.subscribe(ema.clone()).await;
    drop(sub);
    wound_down(running).await;
    w.clock.advance(3 * NANOS_PER_MINUTE);
    let mut rx = support::subscribe_bus(&w.bus);
    let gate = w.fakes[0].hold().await;
    let (_first, _, _) = w.subscribe(sma).await;
    w.fakes[0].a_read_waits().await;
    let (_second, snap, key) = tokio::time::timeout(Duration::from_secs(60), w.subscribe(ema))
        .await
        .expect("the snapshot does not wait for the frame's read, which stays held");
    assert!(w.fakes[0].waiting.load(std::sync::atomic::Ordering::SeqCst) > 0);
    drop(gate);
    let u = support::next(&mut rx, &key).await;
    assert_eq!(u.rev, snap.rev + 1);
    let Replaces::Span { from, .. } = u.replaces else {
        panic!("a span")
    };
    let held = support::times_ms(&snap);
    let at = held.partition_point(|t| *t < from.0 / 1_000_000);
    let mut time = held[..at].to_vec();
    time.extend(support::times_ms(&u));
    let bars = w
        .bars(
            Timeframe::M1,
            Some(Timestamp(time[0] * 1_000_000)),
            50_000,
            false,
        )
        .await;
    assert_eq!(time, times(&bars), "the minutes since, appended");
    for (k, want) in recomputed(
        "ema",
        json!({}),
        &bars,
        grid(Timeframe::M1, SessionFilter::All),
    ) {
        let mut got = support::column(&snap, &k)[..at].to_vec();
        got.extend(support::column(&u, &k));
        assert_eq!(bits(&got), bits(&want), "{k} as a full recompute");
    }
}

struct Held {
    time: Vec<i64>,
    columns: Vec<(String, Vec<f64>)>,
}

impl Held {
    fn of(u: &SeriesUpdate, keys: &[String]) -> Self {
        Self {
            time: support::times_ms(u),
            columns: keys
                .iter()
                .map(|k| (k.clone(), support::column(u, k)))
                .collect(),
        }
    }

    fn apply(&mut self, u: &SeriesUpdate) {
        let (from, to) = match u.replaces {
            Replaces::All => (i64::MIN, i64::MAX),
            Replaces::Span { from, to } => (from.0 / 1_000_000, to.0 / 1_000_000),
        };
        let start = self.time.partition_point(|t| *t < from);
        let end = self.time.partition_point(|t| *t <= to);
        let time = support::times_ms(u);
        self.time.splice(start..end, time.iter().copied());
        for (k, col) in &mut self.columns {
            col.splice(start..end, support::column(u, k));
        }
    }
}

#[tokio::test]
async fn a_reach_sends_a_later_subscriber_the_rows_it_never_had() {
    let w = world(&[("fake", 0)]).await;
    let bars = w.bars(Timeframe::M1, None, 1_500, false).await;
    let (deep, recent) = (bars[0].t.0, bars[1_000].t.0);
    let ema = |from: i64| json!({"indicator": "ema", "instrument": "NQ", "tf": "1m", "from": from});
    let (_a, _, key) = w.subscribe(ema(deep)).await;
    let mut rx = support::subscribe_bus(&w.bus);
    let (_b, snap, b_key) = w.subscribe(ema(recent)).await;
    assert_eq!(key, b_key, "one series, two subscribers");
    assert_eq!(support::times_ms(&snap)[0], recent / 1_000_000);
    let g = grid(Timeframe::M1, SessionFilter::All);
    let keys: Vec<String> = recomputed("ema", json!({}), &bars, g)
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    let mut held = Held::of(&snap, &keys);
    let mut rev = snap.rev;
    let deeper = Timestamp(deep - 500 * NANOS_PER_MINUTE);
    for (from, what) in [(Timestamp(deep), "held"), (deeper, "read")] {
        let reached = w
            .call(
                "indicators.reach",
                json!({"instrument": "NQ", "tf": "1m", "from": from}),
            )
            .await;
        let reached = Timestamp(reached["from"].as_i64().unwrap());
        while held.time[0] > reached.0 / 1_000_000 {
            let u = tokio::time::timeout(STALL, support::next(&mut rx, &key))
                .await
                .unwrap_or_else(|_| panic!("{what}: the rows from the reached bar arrive"));
            assert_eq!(u.rev, rev + 1, "{what}: in order");
            rev = u.rev;
            held.apply(&u);
        }
        let all = w.bars(Timeframe::M1, Some(reached), 50_000, false).await;
        assert_eq!(
            held.time,
            times(&all),
            "{what}: every bar from the reached one"
        );
        for ((k, got), (_, want)) in held
            .columns
            .iter()
            .zip(recomputed("ema", json!({}), &all, g))
        {
            assert_eq!(bits(got), bits(&want), "{what}: {k} as a full recompute");
        }
    }
}

#[tokio::test]
async fn reach_is_idempotent_and_clamps_at_50_000_bars() {
    let w = world(&[("fake", 0)]).await;
    let mut rx = support::subscribe_bus(&w.bus);
    let (_sub, snap, key) = w
        .subscribe(
            json!({"indicator": "sma", "inputs": {"length": 3}, "instrument": "NQ", "tf": "1m"}),
        )
        .await;
    let first = Timestamp(support::times_ms(&snap)[0] * 1_000_000);
    let target = Timestamp(first.0 - 3_000 * NANOS_PER_MINUTE);
    let reach = json!({"instrument": "NQ", "tf": "1m", "from": target.0});
    let out = w.call("indicators.reach", reach.clone()).await;
    let reached = out["from"].as_i64().unwrap();
    assert!(reached >= target.0 && reached < first.0, "{reached}");
    let u = support::next(&mut rx, &key).await;
    let warm_up_end = Timestamp(support::times_ms(&snap)[1] * 1_000_000);
    assert_eq!(
        u.replaces,
        Replaces::Span {
            from: Timestamp(reached),
            to: warm_up_end
        },
        "the new bars and the old warm-up"
    );

    w.fakes[0].forget();
    let again = w.call("indicators.reach", reach).await;
    assert_eq!(again["from"].as_i64(), Some(reached));
    assert!(
        w.fakes[0].requests().is_empty(),
        "asked again: nothing is read"
    );

    let far = json!({"instrument": "NQ", "tf": "1m", "from": first.0 - 200_000 * NANOS_PER_MINUTE});
    let out = w.call("indicators.reach", far).await;
    let grown = support::next(&mut rx, &key).await;
    assert_eq!(
        grown.rev,
        u.rev + 1,
        "nothing changed when asked again, nothing was sent"
    );
    let held = w.bars(Timeframe::M1, None, 50_000, false).await;
    assert_eq!(held.len(), 50_000);
    assert_eq!(
        out["from"].as_i64(),
        Some(held[0].t.0),
        "the newest 50,000 bars"
    );
}

#[tokio::test]
async fn a_correction_is_read_again_after_a_read_that_failed() {
    let w = world(&[("fake", 0)]).await;
    let fake = &w.fakes[0];
    let sma = json!({"length": 4});
    let ask =
        json!({"indicator": "sma", "inputs": sma, "instrument": "NQ", "tf": "15m", "limit": 1500});
    let first = w.call("indicators.compute", ask.clone()).await;
    let from = Timestamp(first["computedFrom"].as_i64().unwrap());
    let fixed = Timestamp(first["time"][300].as_i64().unwrap() + 14 * NANOS_PER_MINUTE);
    fake.revise(fixed, Timestamp(fixed.0 + NANOS_PER_MINUTE));
    let conn = w.router.route_async(&w.id).await.unwrap();
    w.router
        .bars_from(
            &conn,
            BarsRequest {
                instrument: w.id.clone(),
                tf: Timeframe::M1,
                from: Some(Timestamp(fixed.0 - 60 * NANOS_PER_MINUTE)),
                to: Some(Timestamp(fixed.0 + 60 * NANOS_PER_MINUTE)),
                limit: None,
                rth_only: false,
            },
            Read::Through,
        )
        .await
        .unwrap();
    tokio::task::yield_now().await;
    *fake.answer.lock() = Answer::Failure;
    let failed = w
        .tools
        .get("indicators.compute")
        .unwrap()
        .call_json(&ToolCtx::new(Origin::User, w.now()), ask.clone())
        .await;
    assert!(failed.is_err(), "the connection is down");
    *fake.answer.lock() = Answer::Bars;
    let read = w.call("indicators.compute", ask).await;
    let bars = w.bars(Timeframe::M15, Some(from), 50_000, false).await;
    let want = recomputed("sma", sma, &bars, grid(Timeframe::M15, SessionFilter::All));
    let got: Vec<u64> = read["plots"][0]["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap_or(f64::NAN).to_bits())
        .collect();
    let n = got.len();
    let before: Vec<u64> = first["plots"][0]["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap_or(f64::NAN).to_bits())
        .collect();
    assert_ne!(before, got, "the corrected bar moves the average");
    assert_eq!(
        got,
        bits(&want[0].1[want[0].1.len() - n..]),
        "the corrected bar counts once the connection answers again"
    );
}

#[tokio::test]
async fn an_empty_first_answer_does_not_end_the_history() {
    let w = world(&[("fake", 0)]).await;
    let params = json!({"indicator": "ema", "instrument": "NQ", "tf": "5m"});
    *w.fakes[0].answer.lock() = Answer::Nothing;
    let running = running_tasks();
    let (sub, empty, _) = w.subscribe(params.clone()).await;
    assert!(
        support::times_ms(&empty).is_empty(),
        "the connection had nothing yet"
    );
    drop(sub);
    wound_down(running).await;
    *w.fakes[0].answer.lock() = Answer::Bars;
    let (_sub, snap, _) = w.subscribe(params).await;
    let bars = w.bars(Timeframe::M5, None, 1_500, false).await;
    assert_eq!(
        support::times_ms(&snap),
        times(&bars),
        "the history is read once it comes"
    );
}
