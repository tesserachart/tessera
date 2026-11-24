mod support;

use std::sync::Arc;
use std::time::Duration;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::{Map, Value, json};
use tessera_core::clock::{Clock, ManualClock};
use tessera_core::market::{Aggressor, AggressorSource, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicSizing};
use tessera_indicators::io::{ComputeInput, SeriesUpdate};
use tessera_indicators::{
    BarKind, CATALOG_TOPIC, Grid, IndicatorsModule, IndicatorsService, SERIES_TOPIC, builtin_series,
};
use tessera_market::hub::MarketHub;
use tessera_market::io::SessionFilter;
use tessera_market::mock::MOCK_PROVIDER_ID;
use tessera_market::saved::{Contract, SavedTrades};
use tessera_market::{MarketDataProvider, MarketRouter, MockConfig, MockMarket, TradesRequest};
use tessera_protocol::layers::LayerKind;
use tessera_protocol::topics::names;
use tessera_store::Store;
use tessera_store::ticks::{Span, TickRow, TickStore};

const WINDOW_NS: i64 = 900_000_000_000;
const WINDOW_LIMIT: usize = 100_000;

fn now() -> Timestamp {
    Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap()
}

struct World {
    svc: Arc<IndicatorsService>,
    market: Arc<MarketRouter>,
    module: IndicatorsModule,
    clock: Arc<ManualClock>,
    mock: MockMarket,
}

fn world(hub: bool) -> World {
    let clock = Arc::new(ManualClock::new(now()));
    let mut cfg = MockConfig::new(Arc::clone(&clock) as _);
    cfg.intraday_sessions = 2;
    cfg.daily_sessions = 5;
    let mock = MockMarket::new(cfg);
    let market = MarketRouter::new();
    market.add(Arc::new(mock.clone())).unwrap();
    let bus = Arc::new(EventBus::new());
    for t in [
        names::MARKET_TRADES,
        names::MARKET_DEPTH,
        names::MARKET_FOOTPRINT,
        names::MARKET_BARS,
        SERIES_TOPIC,
    ] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    bus.register(CATALOG_TOPIC, TopicSizing::SNAPSHOT).unwrap();
    let hub = hub.then(|| {
        let h = MarketHub::new(Arc::clone(&market), Arc::clone(&bus));
        h.set_linger(Duration::ZERO);
        h
    });
    let svc = IndicatorsService::load(
        Store::open_in_memory().unwrap(),
        Arc::clone(&market),
        hub,
        bus,
        Arc::clone(&clock) as _,
    )
    .unwrap();
    let module = IndicatorsModule::new(Arc::clone(&svc));
    World {
        svc,
        market,
        module,
        clock,
        mock,
    }
}

fn ask(indicator: &str, inputs: Value, limit: u32) -> ComputeInput {
    ComputeInput {
        indicator: indicator.into(),
        version: None,
        inputs: Some(inputs.as_object().unwrap().clone()),
        instrument: "NQ".into(),
        tf: Timeframe::M5,
        from: None,
        to: None,
        limit: Some(limit),
        tail: None,
        session: None,
    }
}

async fn measured_from_prints(
    w: &World,
    out: &tessera_indicators::io::IndicatorSeries,
    opens_before: bool,
) {
    let id = w.market.resolve("NQ").await.unwrap();
    let (_, spec) = w.market.spec(&id).await.unwrap();
    let calendar = spec.sessions;
    let session = calendar.session(calendar.trade_date(out.time[0])).unwrap();
    if opens_before {
        assert!(session.open < out.time[0], "the bars start after the open");
    }
    assert_eq!(
        out.computed_from,
        Some(session.open),
        "measured from the session's open"
    );
    let n = out.time.len();
    let last_end = Timestamp(out.time[n - 1].0 + Timeframe::M5.nanos());
    let mut prints = Vec::new();
    let mut from = session.open;
    while from < last_end {
        let to = Timestamp((from.0 + WINDOW_NS).min(last_end.0));
        let window = w
            .market
            .get_trades(TradesRequest {
                instrument: id.clone(),
                from: Some(from),
                to: Some(to),
                limit: Some(WINDOW_LIMIT),
            })
            .await
            .unwrap();
        assert!(window.len() < WINDOW_LIMIT, "every window is read whole");
        prints.extend(window);
        from = to;
    }
    assert!(prints.len() > 1000, "the mock printed the session");
    let plot = |key: &str| {
        out.plots
            .iter()
            .find(|p| p.key == key)
            .unwrap_or_else(|| panic!("no {key}"))
            .values
            .clone()
    };
    let vwap = plot("vwap");
    for (i, t) in out.time.iter().enumerate() {
        let end = t.0 + Timeframe::M5.nanos();
        let (mut v, mut pv) = (0.0, 0.0);
        for p in prints.iter().filter(|p| p.ts.0 < end) {
            let (price, size) = (p.price.to_f64(), p.size.to_f64());
            v += size;
            pv += price * size;
        }
        let want = pv / v;
        let got = vwap[i].unwrap();
        assert!((got - want).abs() < 1e-6, "bar {i} at {t}: {got} vs {want}");
    }
}

#[tokio::test]
async fn the_session_vwap_is_the_one_the_sessions_prints_work_out_to() {
    let w = world(true);
    let out = w
        .svc
        .compute(ask("vwap", json!({"band1": true, "mult1": 2.0}), 30))
        .await
        .unwrap();
    assert_eq!(out.time.len(), 30);
    measured_from_prints(&w, &out, true).await;
}

#[tokio::test]
async fn without_prints_the_session_vwap_weighs_bar_typical_prices() {
    let w = world(false);
    let out = w.svc.compute(ask("vwap", json!({}), 12)).await.unwrap();
    assert_eq!(out.time.len(), 12);
    assert!(out.plots[0].values.iter().all(Option::is_some));
    let id = w.market.resolve("NQ").await.unwrap();
    let from = out.computed_from.unwrap();
    let bars = w
        .market
        .get_bars(tessera_market::BarsRequest {
            instrument: id,
            tf: Timeframe::M5,
            from: Some(from),
            to: None,
            limit: None,
            rth_only: false,
        })
        .await
        .unwrap()
        .bars;
    let (mut v, mut pv) = (0.0, 0.0);
    let mut want = Vec::new();
    for b in &bars {
        let typical = (b.h.to_f64() + b.l.to_f64() + b.c.to_f64()) / 3.0;
        v += b.v.to_f64();
        pv += typical * b.v.to_f64();
        want.push(pv / v);
    }
    let got: Vec<f64> = out.plots[0].values.iter().map(|x| x.unwrap()).collect();
    let tail = &want[want.len() - 12..];
    for (g, t) in got.iter().zip(tail) {
        assert!((g - t).abs() < 1e-9, "{g} vs {t}");
    }
}

#[tokio::test]
async fn print_bar_series_follow_the_bars_market_get_print_bars_builds() {
    let w = world(true);
    let kind = json!({"kind": "tick", "size": 200});
    let hub = MarketHub::new(Arc::clone(&w.market), Arc::new(EventBus::new()));
    let id = w.market.resolve("NQ").await.unwrap();
    let read = tessera_market::orderflow::tools::print_bars(
        &hub,
        &id,
        serde_json::from_value(kind.clone()).unwrap(),
        2,
        now(),
    )
    .await
    .unwrap();
    assert!(read.bars.len() > 50, "{} bars", read.bars.len());
    let series = support::series(&w.module);
    let sub = series
        .subscribe(json!({"indicator": "delta", "inputs": {"reset": "chart"}, "instrument": "NQ", "tf": "1m", "printBars": kind}))
        .await
        .unwrap();
    let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    let times: Vec<i64> = read
        .bars
        .iter()
        .map(|(b, _)| (b.t.0 as f64 / 1e6).round() as i64)
        .collect();
    let held = support::times_ms(&snap);
    assert_eq!(held, times[times.len() - held.len()..], "the same bars");
    let delta = support::column(&snap, "delta");
    let skip = times.len() - held.len();
    for (i, d) in delta.iter().enumerate() {
        let (b, _) = &read.bars[skip + i];
        let want = 2.0 * b.bv.unwrap().to_f64() - b.v.to_f64();
        assert_eq!(*d, want, "bar {i}: delta is its buyers less its sellers");
    }
    let sma = series
        .subscribe(json!({"indicator": "sma", "instrument": "NQ", "tf": "1m", "printBars": kind}))
        .await
        .unwrap();
    let snap: SeriesUpdate = serde_json::from_str(sma.snapshot[0].get()).unwrap();
    let grid = Grid {
        calendar: SessionCalendar::CmeEquityIndex,
        bars: BarKind::Print(serde_json::from_value(kind).unwrap()),
        session: SessionFilter::All,
    };
    let plain: Vec<_> = read.bars.iter().map(|(b, _)| *b).collect();
    let want = builtin_series(LayerKind::Sma, &Map::new(), &plain, grid).unwrap();
    let ma = support::column(&snap, "ma");
    let want = &want[0].1[want[0].1.len() - ma.len()..];
    assert_eq!(
        ma.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
        want.iter().map(|x| x.to_bits()).collect::<Vec<_>>()
    );
}

const STORED_EVERY: i64 = 15 * 1_000_000_000;
const MINUTE: i64 = 60 * 1_000_000_000;

fn stored_at(m: u32, d: u32, h: u32, min: u32) -> i64 {
    let cal = SessionCalendar::CmeEquityIndex;
    let date = NaiveDate::from_ymd_opt(2026, m, d).unwrap();
    tessera_core::time::local_to_timestamp(cal.tz(), date, h, min).0
}

fn stored_session(m: u32, d: u32) -> Span {
    let cal = SessionCalendar::CmeEquityIndex;
    let s = cal
        .session(NaiveDate::from_ymd_opt(2026, m, d).unwrap())
        .unwrap();
    Span::new(s.open.0, s.close.0)
}

fn stored_days() -> Vec<Span> {
    let wed = stored_session(9, 30);
    vec![
        stored_session(9, 29),
        Span::new(wed.start, stored_at(9, 30, 10, 10)),
        Span::new(stored_at(9, 30, 11, 20), wed.end),
        stored_session(10, 2),
    ]
}

fn stored_print(t: i64) -> (i64, f64) {
    let k = t / STORED_EVERY;
    let size = (1 + k % 5) as f64;
    (t, if k % 2 == 0 { size } else { -size })
}

fn stored_truth(s: Span) -> Vec<(i64, f64)> {
    let cal = SessionCalendar::CmeEquityIndex;
    let first = s.start + (STORED_EVERY - s.start.rem_euclid(STORED_EVERY)) % STORED_EVERY;
    (first..s.end)
        .step_by(STORED_EVERY as usize)
        .filter(|t| cal.is_open(Timestamp(*t)))
        .map(stored_print)
        .collect()
}

fn closed_saturday() -> (Arc<EventBus>, IndicatorsModule) {
    let clock = Arc::new(ManualClock::new(Timestamp(stored_at(10, 3, 12, 0))));
    let mut cfg = MockConfig::new(Arc::clone(&clock) as _);
    cfg.intraday_sessions = 6;
    cfg.daily_sessions = 5;
    cfg.keeps_trade_history = false;
    cfg.refuses_replays = true;
    let router = MarketRouter::new();
    router.add(Arc::new(MockMarket::new(cfg))).unwrap();
    let bus = Arc::new(EventBus::new());
    for t in [
        names::MARKET_TRADES,
        names::MARKET_DEPTH,
        names::MARKET_FOOTPRINT,
        names::MARKET_BARS,
        SERIES_TOPIC,
    ] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    bus.register(CATALOG_TOPIC, TopicSizing::SNAPSHOT).unwrap();
    let saved = SavedTrades::new(Arc::new(TickStore::open_in_memory().unwrap()));
    let nq = InstrumentId::new("NQZ6.CME").unwrap();
    let contract = Contract::new(MOCK_PROVIDER_ID, &nq);
    for s in stored_days() {
        let rows: Vec<TickRow> = stored_truth(s)
            .into_iter()
            .map(|(t, signed)| {
                let k = t / STORED_EVERY;
                TickRow::of(&Trade {
                    instrument: nq.clone(),
                    ts: Timestamp(t),
                    price: Price(
                        Decimal::from(24_000) + Decimal::new(25, 2) * Decimal::from(k % 40),
                    ),
                    size: Qty::from(signed.abs() as i64),
                    aggressor: if signed > 0.0 {
                        Aggressor::Buy
                    } else {
                        Aggressor::Sell
                    },
                    aggressor_source: AggressorSource::Exchange,
                    order_key: None,
                    source: None,
                })
            })
            .collect();
        saved
            .save_now(&contract, SessionCalendar::CmeEquityIndex, &rows, s)
            .unwrap();
    }
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&bus));
    hub.set_linger(Duration::ZERO);
    hub.set_saved_trades(saved);
    let svc = IndicatorsService::load(
        Store::open_in_memory().unwrap(),
        router,
        Some(hub),
        Arc::clone(&bus),
        clock as _,
    )
    .unwrap();
    (bus, IndicatorsModule::new(svc))
}

fn cvd_of_stored_days(times_ms: &[i64]) -> Vec<Option<f64>> {
    let cal = SessionCalendar::CmeEquityIndex;
    let prints: Vec<(i64, f64)> = stored_days().into_iter().flat_map(stored_truth).collect();
    let mut running = 0.0;
    let mut day = None;
    times_ms
        .iter()
        .map(|ms| {
            let t = ms * 1_000_000;
            let today = cal.trade_date(Timestamp(t));
            if day != Some(today) {
                day = Some(today);
                running = 0.0;
            }
            let whole = stored_days()
                .iter()
                .any(|s| s.start <= t && t + MINUTE <= s.end);
            if !whole {
                return None;
            }
            running += prints
                .iter()
                .filter(|(p, _)| *p >= t && *p < t + MINUTE)
                .map(|(_, d)| d)
                .sum::<f64>();
            Some(running)
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn cvd_counts_every_stored_session_with_the_market_closed() {
    let (bus, module) = closed_saturday();
    let mut rx = support::subscribe_bus(&bus);
    let from = stored_session(9, 29).start;
    let began = std::time::Instant::now();
    let sub = support::series(&module)
        .subscribe(
            json!({"indicator": "delta", "instrument": "NQZ6.CME", "tf": "1m", "from": from}),
        )
        .await
        .unwrap();
    eprintln!(
        "cold 1m CVD subscribe over four stored sessions: {:?}",
        began.elapsed()
    );
    let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    let times = support::times_ms(&snap);
    assert_eq!(
        times[0],
        from / 1_000_000,
        "the snapshot starts at Tuesday's open"
    );
    let got: Vec<Option<f64>> = support::column(&snap, "close")
        .into_iter()
        .map(|v| (!v.is_nan()).then_some(v))
        .collect();
    let want = cvd_of_stored_days(&times);
    let known = want.iter().filter(|v| v.is_some()).count();
    assert!(
        known > 3 * 1_300,
        "three stored sessions of minutes, {known}"
    );
    assert_eq!(
        got, want,
        "every stored session counted from its first known bar, nothing where nothing is stored"
    );
    let opens = support::column(&snap, "open");
    for s in [
        stored_session(9, 29),
        stored_session(9, 30),
        stored_session(10, 2),
    ] {
        let first = times
            .iter()
            .position(|t| *t == s.start / 1_000_000)
            .unwrap();
        assert_eq!(opens[first], 0.0, "each session starts from zero");
    }

    let tessera_host::KeyFilter::Id(key) = sub.filter.clone() else {
        panic!("an id filter")
    };
    let later = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let next = support::next(&mut rx, &key).await;
            let same = support::times_ms(&next).iter().all(|t| {
                let i = times.iter().position(|s| s == t).unwrap();
                support::column(&next, "close")
                    .iter()
                    .zip(std::iter::once(got[i]))
                    .all(|(a, b)| b.map_or(a.is_nan(), |b| *a == b))
            });
            assert!(same, "the first snapshot was whole: {next:?}");
            if next.loaded.is_some_and(|l| l.refused) {
                return next.loaded;
            }
        }
    })
    .await;
    assert_eq!(
        later.ok().flatten(),
        Some(tessera_market::io::PrintsLoaded {
            sessions: 2,
            held: 1,
            refused: true
        }),
        "Thursday is not stored and the replay refuses it"
    );
}

struct Replaying {
    m: MockMarket,
    open: tokio::sync::watch::Sender<bool>,
}

#[async_trait::async_trait]
impl MarketDataProvider for Replaying {
    fn id(&self) -> &str {
        "replaying"
    }
    fn display_name(&self) -> &str {
        "Replaying"
    }
    fn capabilities(&self) -> tessera_core::capabilities::MarketCapabilities {
        self.m.capabilities()
    }
    fn health(&self) -> tessera_core::health::ProviderHealth {
        self.m.health()
    }
    async fn search(
        &self,
        q: &str,
        a: Option<tessera_core::instrument::AssetClass>,
        n: usize,
    ) -> Result<Vec<tessera_core::instrument::Instrument>, tessera_market::MarketError> {
        self.m.search(q, a, n).await
    }
    async fn resolve(
        &self,
        input: &str,
    ) -> Result<tessera_core::InstrumentId, tessera_market::MarketError> {
        self.m.resolve(input).await
    }
    async fn spec(
        &self,
        i: &tessera_core::InstrumentId,
    ) -> Result<
        (
            tessera_core::instrument::Instrument,
            tessera_core::instrument::ContractSpec,
        ),
        tessera_market::MarketError,
    > {
        self.m.spec(i).await
    }
    async fn get_bars(
        &self,
        req: tessera_market::BarsRequest,
    ) -> Result<tessera_market::BarSeries, tessera_market::MarketError> {
        self.m.get_bars(req).await
    }
    async fn replay_trades(
        &self,
        req: TradesRequest,
    ) -> Result<Vec<tessera_core::market::Trade>, tessera_market::MarketError> {
        let mut open = self.open.subscribe();
        let _ = open.wait_for(|o| *o).await;
        let mut prints = self.m.get_trades(req).await?;
        for t in &mut prints {
            t.aggressor_source = tessera_core::market::AggressorSource::ReplayMapped;
            t.order_key = None;
        }
        Ok(prints)
    }
    async fn quote(
        &self,
        i: &tessera_core::InstrumentId,
    ) -> Result<tessera_core::market::Quote, tessera_market::MarketError> {
        self.m.quote(i).await
    }
    fn subscribe_quotes(
        &self,
        i: &[tessera_core::InstrumentId],
    ) -> Result<
        tessera_market::MarketStream<tessera_core::market::Quote>,
        tessera_market::MarketError,
    > {
        self.m.subscribe_quotes(i)
    }
    fn subscribe_trades(
        &self,
        i: &[tessera_core::InstrumentId],
    ) -> Result<
        tessera_market::MarketStream<tessera_core::market::Trade>,
        tessera_market::MarketError,
    > {
        self.m.subscribe_trades(i)
    }
    fn subscribe_bars(
        &self,
        i: &tessera_core::InstrumentId,
        tf: Timeframe,
    ) -> Result<tessera_market::MarketStream<tessera_market::LiveBar>, tessera_market::MarketError>
    {
        self.m.subscribe_bars(i, tf)
    }
}

#[tokio::test(start_paused = true)]
async fn a_pull_lands_in_one_series_update() {
    let clock = Arc::new(ManualClock::new(now()));
    let mut cfg = MockConfig::new(Arc::clone(&clock) as _);
    cfg.intraday_sessions = 2;
    cfg.daily_sessions = 5;
    let mock = MockMarket::new(cfg);
    let replaying = Arc::new(Replaying {
        m: mock.clone(),
        open: tokio::sync::watch::channel(false).0,
    });
    let router = MarketRouter::new();
    router
        .add(Arc::clone(&replaying) as Arc<dyn MarketDataProvider>)
        .unwrap();
    let bus = Arc::new(EventBus::new());
    for t in [
        names::MARKET_TRADES,
        names::MARKET_DEPTH,
        names::MARKET_FOOTPRINT,
        names::MARKET_BARS,
        SERIES_TOPIC,
    ] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    bus.register(CATALOG_TOPIC, TopicSizing::SNAPSHOT).unwrap();
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&bus));
    hub.set_linger(Duration::ZERO);
    let svc = IndicatorsService::load(
        Store::open_in_memory().unwrap(),
        Arc::clone(&router),
        Some(hub),
        Arc::clone(&bus),
        Arc::clone(&clock) as _,
    )
    .unwrap();
    let module = IndicatorsModule::new(Arc::clone(&svc));
    let mut rx = support::subscribe_bus(&bus);
    let sub = support::series(&module)
        .subscribe(json!({"indicator": "delta", "instrument": "NQZ6.CME", "tf": "5m"}))
        .await
        .unwrap();
    let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    let tessera_host::KeyFilter::Id(key) = sub.filter.clone() else {
        panic!("an id filter")
    };
    let times = support::times_ms(&snap);
    let calendar = SessionCalendar::CmeEquityIndex;
    let open_ms = calendar.session(calendar.trade_date(now())).unwrap().open.0 / 1_000_000;
    let open_row = times
        .iter()
        .position(|t| *t == open_ms)
        .expect("the session's open is held");
    assert!(
        support::column(&snap, "close")[open_row].is_nan(),
        "before its prints are read back, the session is not counted"
    );

    replaying.open.send_replace(true);
    let filled = support::next(&mut rx, &key).await;
    let at = support::times_ms(&filled)
        .iter()
        .position(|x| *x == open_ms)
        .unwrap();
    assert_eq!(
        support::column(&filled, "open")[at],
        0.0,
        "counted from the session's open"
    );

    let truth = world(true);
    let whole = truth
        .svc
        .compute(ComputeInput {
            instrument: "NQZ6.CME".into(),
            ..ask("delta", json!({}), 200)
        })
        .await
        .unwrap();
    let cvd = whole.plots.iter().find(|p| p.key == "cvd").unwrap();
    let got_t = support::times_ms(&filled);
    let got = support::column(&filled, "close");
    for (t, v) in whole.time.iter().zip(&cvd.values) {
        if let Some(i) = got_t.iter().position(|x| *x == t.0 / 1_000_000)
            && i + 1 < got_t.len()
        {
            assert_eq!(
                Some(got[i]),
                *v,
                "bar {t}: the CVD of the whole session's prints"
            );
        }
    }
    let later = tokio::time::timeout(Duration::from_secs(30), support::next(&mut rx, &key)).await;
    assert!(later.is_err(), "the pull landed in one update: {later:?}");
}

#[tokio::test]
async fn an_idle_series_measures_its_new_bars_from_their_prints() {
    let w = world(true);
    let vwap = ask("vwap", json!({}), 30);
    let earlier = w.svc.compute(vwap.clone()).await.unwrap();
    measured_from_prints(&w, &earlier, true).await;
    for _ in 0..12 * 12 {
        w.clock.advance(5 * 1_000_000_000);
        w.mock.advance(w.clock.now());
    }
    let later = w.svc.compute(vwap).await.unwrap();
    assert!(later.time[29] > earlier.time[29], "new bars came");
    measured_from_prints(&w, &later, true).await;
}

#[tokio::test]
async fn print_bars_cut_at_their_cap_start_no_session() {
    let w = world(true);
    let kind = json!({"kind": "tick", "size": 20});
    let hub = MarketHub::new(Arc::clone(&w.market), Arc::new(EventBus::new()));
    let id = w.market.resolve("NQ").await.unwrap();
    let read = tessera_market::orderflow::tools::print_bars(
        &hub,
        &id,
        serde_json::from_value(kind.clone()).unwrap(),
        2,
        now(),
    )
    .await
    .unwrap();
    assert!(read.cut, "more prints than the bars kept");
    let sub = support::series(&w.module)
        .subscribe(json!({"indicator": "delta", "instrument": "NQ", "tf": "1m", "printBars": kind, "from": 0}))
        .await
        .unwrap();
    let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    let cvd = support::column(&snap, "close");
    let calendar = SessionCalendar::CmeEquityIndex;
    let day = |ms: i64| calendar.trade_date(Timestamp(ms * 1_000_000));
    let times = support::times_ms(&snap);
    let cut_session = times
        .iter()
        .take_while(|t| day(**t) == day(times[0]))
        .count();
    assert!(cut_session > 0 && cut_session < times.len());
    assert!(
        cvd[..cut_session].iter().all(|v| v.is_nan()),
        "the session the cap cut into is not counted"
    );
    assert!(cvd[cut_session..].iter().any(|v| !v.is_nan()));
}
