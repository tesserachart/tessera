use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use rust_decimal::Decimal;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::ManualClock;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::{AssetClass, ContractSpec, ExchangeContract, Instrument};
use tessera_core::market::{Aggressor, AggressorSource, Bar, BookSnapshot, Quote, Trade};
use tessera_core::time::{NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicSizing};
use tessera_market::aggregate::{FootprintBuilder, TradeBarBuilder, aggregate};
use tessera_market::hub::{MarketHub, PumpKey};
use tessera_market::io::{CompactFootprint, EarlierBars, FootprintUpdate};
use tessera_market::replay::Replays;
use tessera_market::saved::{Contract, SavedTrades};
use tessera_market::{
    BarArchive, BarCache, BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError,
    MarketRouter, MarketStream, MockConfig, MockMarket, OrderBookEvent, TradesRequest,
};
use tessera_protocol::topics::names;
use tessera_store::bars::{BarStore, SeriesKey, Span as BarSpan};
use tessera_store::ticks::{Span, TickRow, TickStore};
use tokio::sync::{broadcast, mpsc};

const LIVE: &str = "rithmic-test";

fn nq() -> InstrumentId {
    InstrumentId::new("NQZ6.CME").unwrap()
}

fn at(s: &str) -> Timestamp {
    Timestamp::parse(s).unwrap()
}

fn mock() -> MockMarket {
    let clock = Arc::new(ManualClock::new(at(tessera_market::mock::FROZEN_AT)));
    let mut cfg = MockConfig::new(clock);
    cfg.intraday_sessions = 3;
    cfg.daily_sessions = 5;
    MockMarket::new(cfg)
}

struct Day {
    replays: Arc<Replays>,
    router: Arc<MarketRouter>,
    contract: Contract,
    spec: ContractSpec,
    span: Span,
    saved: Vec<TickRow>,
}

impl Day {
    async fn open(&self, start: Timestamp, speed: u32, playing: bool) -> InstrumentId {
        let date = self.spec.sessions.trade_date(Timestamp(self.span.start));
        self.replays
            .open(
                &self.router,
                self.contract.clone(),
                date,
                Some(start),
                speed,
                playing,
            )
            .await
            .unwrap()
            .instrument
    }

    fn saved_trades(&self, id: &InstrumentId) -> Vec<Trade> {
        self.saved.iter().map(|r| r.trade(id, None)).collect()
    }

    async fn bars(&self, id: &InstrumentId, tf: Timeframe) -> Vec<Bar> {
        self.router
            .get_bars(BarsRequest::latest(id.clone(), tf, 10_000))
            .await
            .unwrap()
            .bars
    }

    fn played(&self, tf: Timeframe, before: Timestamp) -> Vec<Bar> {
        let mut b = TradeBarBuilder::new(tf, self.spec.sessions);
        let mut out: Vec<Bar> = self
            .saved
            .iter()
            .filter(|p| p.t < before.0)
            .filter_map(|p| b.push(Timestamp(p.t), p.price, p.size, p.aggressor))
            .collect();
        out.extend(b.current().copied());
        out
    }

    async fn earlier(&self, id: &InstrumentId) -> EarlierBars {
        self.replays.state(id).unwrap().earlier
    }
}

async fn saved_day(router: Arc<MarketRouter>, prints: &[Trade], span: Span) -> Day {
    saved_days(router, &[], prints, span).await
}

async fn saved_days(
    router: Arc<MarketRouter>,
    earlier: &[(&[Trade], Span)],
    prints: &[Trade],
    span: Span,
) -> Day {
    let (instrument, spec) = mock().spec(&nq()).await.unwrap();
    let saved = SavedTrades::new(Arc::new(TickStore::open_in_memory().unwrap()));
    let contract = Contract::new(LIVE, &nq());
    saved.remember_contract(LIVE, &instrument, &spec);
    for (prints, span) in earlier.iter().copied().chain([(prints, span)]) {
        let rows: Vec<TickRow> = prints.iter().map(TickRow::of).collect();
        saved
            .save_now(&contract, spec.sessions, &rows, span)
            .unwrap();
    }
    let back = saved
        .store()
        .read(contract.key(), span.start, span.end)
        .unwrap();
    let replays = Replays::new(saved);
    router.set_replays(Arc::clone(&replays));
    Day {
        replays,
        router,
        contract,
        spec,
        span,
        saved: back,
    }
}

fn one_a_second(from: Timestamp, seconds: i64) -> Vec<Trade> {
    (0..seconds)
        .map(|k| Trade {
            instrument: nq(),
            ts: Timestamp(from.0 + k * NANOS_PER_SEC),
            price: Price::from(Decimal::new(2_100_000 + (k % 7) * 25, 2)),
            size: Qty::from(1 + k % 3),
            aggressor: if k % 2 == 0 {
                Aggressor::Buy
            } else {
                Aggressor::Sell
            },
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        })
        .collect()
}

async fn mock_prints(from: Timestamp, to: Timestamp) -> Vec<Trade> {
    mock()
        .get_trades(TradesRequest {
            instrument: nq(),
            from: Some(from),
            to: Some(to),
            limit: Some(usize::MAX),
        })
        .await
        .unwrap()
}

fn collect<T: Send + 'static>(mut s: MarketStream<T>) -> mpsc::UnboundedReceiver<T> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(x) = s.next().await {
            if tx.send(x).is_err() {
                return;
            }
        }
    });
    rx
}

fn drain<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> Vec<T> {
    let mut out = Vec::new();
    while let Ok(x) = rx.try_recv() {
        out.push(x);
    }
    out
}

async fn wall(seconds: f64) {
    tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
}

fn hub(router: &Arc<MarketRouter>) -> (Arc<MarketHub>, Arc<EventBus>) {
    let bus = Arc::new(EventBus::new());
    for t in [
        names::MARKET_QUOTES,
        names::MARKET_TRADES,
        names::MARKET_BARS,
        names::MARKET_DEPTH,
        names::MARKET_FOOTPRINT,
    ] {
        bus.register(t, TopicSizing::MARKET).unwrap();
    }
    let hub = MarketHub::new(Arc::clone(router), Arc::clone(&bus));
    hub.set_linger(Duration::ZERO);
    (hub, bus)
}

fn events<T: serde::de::DeserializeOwned>(
    rx: &mut broadcast::Receiver<Arc<tessera_host::BusEvent>>,
) -> Vec<T> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(serde_json::from_str(e.data.get()).unwrap());
    }
    out
}

#[tokio::test(start_paused = true)]
async fn playback_follows_the_clock_at_its_speed_holds_on_pause_and_jumps() {
    let from = at("2026-10-01T09:30:00-04:00");
    let span = Span::new(from.0, from.0 + 600 * NANOS_PER_SEC);
    let day = saved_day(MarketRouter::new(), &one_a_second(from, 600), span).await;
    let id = day.open(from, 1, true).await;
    assert_eq!(
        id.as_str(),
        "NQZ6-R1.CME",
        "the desk reads a replay by its id"
    );
    let saved = day.saved_trades(&id);
    let mut rx = collect(
        day.router
            .subscribe_trades(std::slice::from_ref(&id))
            .unwrap(),
    );

    wall(10.5).await;
    let played: Vec<Trade> = drain(&mut rx)
        .into_iter()
        .map(|mut t| {
            t.source = None;
            t
        })
        .collect();
    assert_eq!(
        played,
        saved[..11],
        "ten and a half seconds play eleven prints, in order"
    );

    let paused = day.replays.control(&id, Some(false), None).unwrap();
    assert_eq!(
        paused.cursor,
        Timestamp(from.0 + 10 * NANOS_PER_SEC + NANOS_PER_SEC / 2)
    );
    wall(30.0).await;
    assert!(drain(&mut rx).is_empty(), "a paused replay plays nothing");
    assert_eq!(day.replays.state(&id).unwrap().cursor, paused.cursor);

    day.replays.control(&id, Some(true), Some(5)).unwrap();
    wall(2.0).await;
    let times: Vec<i64> = drain(&mut rx).iter().map(|t| t.ts.0).collect();
    let expected: Vec<i64> = saved[11..21].iter().map(|t| t.ts.0).collect();
    assert_eq!(times, expected, "two seconds at 5x play ten more");

    let jumped = day
        .replays
        .jump(
            &id,
            Timestamp(from.0 + 300 * NANOS_PER_SEC + NANOS_PER_SEC / 2),
        )
        .unwrap();
    assert_ne!(
        jumped.instrument, id,
        "a jump continues under a new instrument"
    );
    assert!(day.router.route(&id).is_err(), "the old replay closed");
    assert_eq!(
        jumped.cursor,
        Timestamp(from.0 + 300 * NANOS_PER_SEC + NANOS_PER_SEC / 2)
    );
    assert!((jumped.playing, jumped.speed) == (true, 5));
    let held = day
        .router
        .get_trades(TradesRequest {
            instrument: jumped.instrument.clone(),
            from: None,
            to: None,
            limit: None,
        })
        .await
        .unwrap();
    assert_eq!(held.len(), 301, "history answers up to the clock");
    assert_eq!(held.last().unwrap().ts, saved[300].ts);
}

#[tokio::test(start_paused = true)]
async fn a_replay_that_reaches_the_end_of_its_day_stops_playing() {
    let from = at("2026-10-01T09:30:00-04:00");
    let span = Span::new(from.0, from.0 + 600 * NANOS_PER_SEC);
    let day = saved_day(MarketRouter::new(), &one_a_second(from, 600), span).await;
    let id = day
        .open(Timestamp(span.end - 5 * NANOS_PER_SEC), 1, true)
        .await;
    assert!(day.replays.state(&id).unwrap().playing);
    wall(6.0).await;
    let ended = day.replays.state(&id).unwrap();
    assert_eq!(ended.cursor, Timestamp(span.end));
    assert!(!ended.playing, "the day is over");
    let back = day
        .replays
        .jump(&id, Timestamp(span.end - 60 * NANOS_PER_SEC))
        .unwrap();
    assert!(!back.playing, "a jump back waits for play");
    let again = day
        .replays
        .control(&back.instrument, Some(true), None)
        .unwrap();
    assert!(again.playing);
}

#[tokio::test(start_paused = true)]
async fn a_footprint_through_the_hub_equals_one_built_from_the_saved_prints() {
    let from = at("2026-10-01T09:30:00-04:00");
    let to = at("2026-10-01T09:45:00-04:00");
    let prints = mock_prints(from, to).await;
    let day = saved_day(MarketRouter::new(), &prints, Span::new(from.0, to.0)).await;
    assert!(day.router.providers().is_empty(), "no connection at all");
    let (hub, bus) = hub(&day.router);
    let id = day.open(from, 60, false).await;
    let (mut rx, _) = bus.subscribe(names::MARKET_FOOTPRINT).unwrap();
    let _fp = hub
        .acquire(PumpKey::Footprint(id.clone(), Timeframe::M1, 1))
        .unwrap();
    wall(1.0).await;
    day.replays.control(&id, Some(true), None).unwrap();
    wall(20.0).await;

    let built = FootprintBuilder::new(Timeframe::M1, day.spec.sessions, day.spec.tick_size)
        .build(&day.saved_trades(&id));
    let closed: Vec<CompactFootprint> = events::<FootprintUpdate>(&mut rx)
        .into_iter()
        .filter(|u| u.closed)
        .map(|u| u.bar)
        .collect();
    assert_eq!(closed.len(), 14, "fifteen minutes close fourteen bars");
    let expected: Vec<CompactFootprint> = built[..14].iter().map(CompactFootprint::from).collect();
    assert_eq!(closed, expected);
}

#[tokio::test(start_paused = true)]
async fn jumping_back_leaves_no_later_print_in_what_the_hub_holds() {
    let from = at("2026-10-01T09:30:00-04:00");
    let span = Span::new(from.0, from.0 + 600 * NANOS_PER_SEC);
    let day = saved_day(MarketRouter::new(), &one_a_second(from, 600), span).await;
    let (hub, _bus) = hub(&day.router);
    let id = day.open(from, 60, true).await;
    let first = hub.acquire(PumpKey::Trades(id.clone())).unwrap();
    wall(5.0).await;
    let before = hub.history(&id, None, None, None).await.unwrap().trades;
    assert!(before.len() > 290, "five minutes played: {}", before.len());
    let back = Timestamp(from.0 + 60 * NANOS_PER_SEC + NANOS_PER_SEC / 2);
    let jumped = day.replays.jump(&id, back).unwrap();
    day.replays
        .control(&jumped.instrument, Some(false), None)
        .unwrap();
    drop(first);
    let _second = hub
        .acquire(PumpKey::Trades(jumped.instrument.clone()))
        .unwrap();
    wall(1.0).await;
    let held = hub
        .history(&jumped.instrument, None, None, None)
        .await
        .unwrap()
        .trades;
    assert_eq!(held.len(), 61, "the prints before the new clock, no more");
    assert!(held.iter().all(|t| t.ts < back));
}

#[derive(Default)]
struct Counted {
    calls: AtomicUsize,
    spec: Option<(Instrument, ContractSpec)>,
}

impl Counted {
    fn ask(&self) {
        self.calls.fetch_add(1, Ordering::SeqCst);
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

fn refused<T>(what: &str) -> Result<T, MarketError> {
    Err(MarketError::Unavailable(format!("counted {what}")))
}

#[async_trait]
impl MarketDataProvider for Counted {
    fn id(&self) -> &str {
        LIVE
    }
    fn display_name(&self) -> &str {
        LIVE
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: Timeframe::PRESETS.to_vec(),
            live_timeframes: Timeframe::PRESETS.to_vec(),
            quotes: true,
            trades: true,
            depth_levels: Some(10),
            footprint: false,
            asset_classes: vec![AssetClass::Future],
            max_intraday_history_days: None,
            max_daily_history_days: None,
            realtime: true,
            aggressor_source: Some(AggressorSource::Exchange),
        }
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: LIVE.into(),
            kind: ProviderKind::MarketData,
            display_name: LIVE.into(),
            status: HealthStatus::Ok,
            latency_ms: None,
            last_message_at: None,
            message: None,
            connection: None,
            accounts: None,
            checked_at: Timestamp(0),
        }
    }
    async fn search(
        &self,
        _: &str,
        _: Option<AssetClass>,
        _: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.ask();
        refused("search")
    }
    async fn resolve(&self, _: &str) -> Result<InstrumentId, MarketError> {
        self.ask();
        refused("resolve")
    }
    async fn spec(&self, _: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.ask();
        self.spec.clone().map_or_else(|| refused("spec"), Ok)
    }
    async fn get_bars(&self, _: BarsRequest) -> Result<BarSeries, MarketError> {
        self.ask();
        refused("get_bars")
    }
    async fn quote(&self, _: &InstrumentId) -> Result<Quote, MarketError> {
        self.ask();
        refused("quote")
    }
    fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.ask();
        refused("subscribe_quotes")
    }
    fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.ask();
        refused("subscribe_trades")
    }
    fn subscribe_bars(
        &self,
        _: &InstrumentId,
        _: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.ask();
        refused("subscribe_bars")
    }
    async fn contract_for(&self, _: &ExchangeContract) -> Result<Option<Instrument>, MarketError> {
        self.ask();
        refused("contract_for")
    }
    fn subscribe_depth(
        &self,
        _: &InstrumentId,
        _: u32,
    ) -> Result<MarketStream<BookSnapshot>, MarketError> {
        self.ask();
        refused("subscribe_depth")
    }
    fn subscribe_order_book(
        &self,
        _: &InstrumentId,
    ) -> Result<MarketStream<OrderBookEvent>, MarketError> {
        self.ask();
        refused("subscribe_order_book")
    }
    async fn get_trades(&self, _: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        self.ask();
        refused("get_trades")
    }
    async fn replay_trades(&self, _: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        self.ask();
        refused("replay_trades")
    }
}

#[derive(Debug, Default)]
struct Archive {
    writes: AtomicUsize,
}

impl BarArchive for Archive {
    fn write(
        &self,
        _: SeriesKey<'_>,
        _: &[tessera_core::market::Bar],
        _: &dyn Fn(Timestamp) -> i64,
        _: Option<BarSpan>,
    ) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn read(
        &self,
        _: SeriesKey<'_>,
        _: i64,
        _: i64,
    ) -> Result<Vec<tessera_core::market::Bar>, String> {
        Ok(Vec::new())
    }
    fn covered(&self, _: SeriesKey<'_>) -> Result<Vec<BarSpan>, String> {
        Ok(Vec::new())
    }
    fn forget_before(&self, _: SeriesKey<'_>, _: i64) -> Result<usize, String> {
        Ok(0)
    }
}

#[tokio::test(start_paused = true)]
async fn a_whole_replay_asks_the_live_connection_nothing_and_keeps_no_bars() {
    let from = at("2026-10-01T09:30:00-04:00");
    let to = at("2026-10-01T09:40:00-04:00");
    let prints = mock_prints(from, to).await;
    let live = Arc::new(Counted {
        spec: Some(mock().spec(&nq()).await.unwrap()),
        ..Counted::default()
    });
    let router = MarketRouter::new();
    router
        .add(Arc::clone(&live) as Arc<dyn MarketDataProvider>)
        .unwrap();
    let archive = Arc::new(Archive::default());
    let clock = Arc::new(ManualClock::new(at(tessera_market::mock::FROZEN_AT)));
    let cache = BarCache::new(Arc::clone(&archive) as _, clock as _);
    router.set_bar_cache(Arc::clone(&cache));
    let day = saved_day(router, &prints, Span::new(from.0, to.0)).await;
    let (hub, bus) = hub(&day.router);
    let id = day.open(from, 60, true).await;
    assert_eq!(day.router.resolve(id.as_str()).await.unwrap(), id);
    let _pumps = [
        PumpKey::Quotes(id.clone()),
        PumpKey::Trades(id.clone()),
        PumpKey::Bars(id.clone(), Timeframe::M1),
        PumpKey::Footprint(id.clone(), Timeframe::M5, 4),
    ]
    .map(|k| hub.acquire(k).unwrap());
    let publish: tessera_market::history::Publish = Arc::new(|_| {});
    let _fill = cache.fill(&day.router, &id, Timeframe::M1, publish);
    let (mut bars, _) = bus.subscribe(names::MARKET_BARS).unwrap();
    wall(12.0).await;
    let live_bars: Vec<tessera_market::io::BarUpdate> = events(&mut bars);
    assert!(
        live_bars.iter().any(|b| b.closed),
        "bars close as the replay plays"
    );
    let read = day
        .router
        .get_bars(BarsRequest {
            from: Some(from),
            to: Some(to),
            ..BarsRequest::latest(id.clone(), Timeframe::M1, 100)
        })
        .await
        .unwrap();
    assert_eq!(read.bars.len(), 10, "ten minutes of bars, from disk");
    let history = hub
        .history(&id, Some(from), None, None)
        .await
        .unwrap()
        .trades;
    assert_eq!(history.len(), day.saved.len());
    day.router.quote(&id).await.unwrap();
    day.replays.close(&id);

    assert_eq!(live.calls(), 0, "the live connection was asked nothing");
    assert_eq!(
        archive.writes.load(Ordering::SeqCst),
        0,
        "no replay bar is kept"
    );
    day.router.spec(&nq()).await.unwrap();
    assert_eq!(live.calls(), 1, "a live read is counted");
}

fn kept(router: &Arc<MarketRouter>) -> Arc<BarStore> {
    let store = Arc::new(BarStore::open_in_memory().unwrap());
    let clock = Arc::new(ManualClock::new(at(tessera_market::mock::FROZEN_AT)));
    router.set_bar_cache(BarCache::new(Arc::clone(&store) as _, clock as _));
    store
}

async fn keep(store: &BarStore, tf: Timeframe, from: Timestamp, to: Timestamp) -> Vec<Bar> {
    let m = mock();
    let (_, spec) = m.spec(&nq()).await.unwrap();
    let cal = spec.sessions;
    let bars: Vec<Bar> = m
        .get_bars(BarsRequest {
            from: Some(from),
            to: Some(to),
            ..BarsRequest::latest(nq(), tf, usize::MAX)
        })
        .await
        .unwrap()
        .bars
        .into_iter()
        .filter(|b| b.t >= from && b.t < to)
        .collect();
    assert!(!bars.is_empty(), "the mock serves {tf:?} bars from {from}");
    let id = nq();
    let series = tf.to_string();
    let key = SeriesKey {
        source: LIVE,
        instrument: id.as_str(),
        series: &series,
    };
    let block = |t: Timestamp| {
        use chrono::Datelike;
        let d = cal.trade_date(t);
        i64::from(d.year()) * 10_000 + i64::from(d.month() * 100 + d.day())
    };
    store
        .write(key, &bars, block, Some(BarSpan::new(from.0, to.0)))
        .unwrap();
    bars
}

fn split(bars: &[Bar], at: Timestamp) -> (Vec<Bar>, Vec<Bar>) {
    bars.iter().partition(|b| b.t < at)
}

#[tokio::test(start_paused = true)]
async fn a_replay_shows_every_bar_kept_before_its_start_and_later_ones_only_as_it_plays_them() {
    let start = at("2026-10-01T09:30:00-04:00");
    let end = at("2026-10-01T10:00:00-04:00");
    let router = MarketRouter::new();
    let store = kept(&router);
    let minutes = keep(
        &store,
        Timeframe::M1,
        at("2026-09-29T18:00:00-04:00"),
        at("2026-10-01T12:00:00-04:00"),
    )
    .await;
    let prints = mock_prints(start, end).await;
    let day = saved_day(router, &prints, Span::new(start.0, end.0)).await;
    let cal = day.spec.sessions;
    let (before, _) = split(&minutes, start);
    let kept_five = aggregate(&before, Timeframe::M5, cal);
    assert!(kept_five.len() > 400, "two sessions of five-minute bars");

    let id = day.open(start, 1, false).await;
    assert_eq!(
        day.bars(&id, Timeframe::M5).await,
        kept_five,
        "every kept bar before the start, none of the kept bars from it on"
    );
    assert_eq!(day.bars(&id, Timeframe::M1).await, before);
    assert_eq!(day.earlier(&id).await, EarlierBars::Whole);

    let later = Timestamp(start.0 + 17 * NANOS_PER_MINUTE);
    let jumped = day.replays.jump(&id, later).unwrap().instrument;
    let (old, played) = split(&day.bars(&jumped, Timeframe::M5).await, start);
    assert_eq!(
        old, kept_five,
        "the bars before the start stay as they were"
    );
    assert_eq!(
        played,
        day.played(Timeframe::M5, later),
        "from the start on, the bars the replay played and nothing past its clock"
    );
}

#[tokio::test(start_paused = true)]
async fn a_replay_from_a_trading_day_open_shows_the_days_before_and_none_of_its_own() {
    let open = at("2026-09-30T18:00:00-04:00");
    let end = at("2026-09-30T18:30:00-04:00");
    let router = MarketRouter::new();
    let store = kept(&router);
    let minutes = keep(
        &store,
        Timeframe::M1,
        at("2026-09-29T18:00:00-04:00"),
        at("2026-10-01T12:00:00-04:00"),
    )
    .await;
    let daily = keep(
        &store,
        Timeframe::D1,
        at("2026-09-27T00:00:00-04:00"),
        at("2026-10-02T00:00:00-04:00"),
    )
    .await;
    let prints = mock_prints(open, end).await;
    let day = saved_day(router, &prints, Span::new(open.0, end.0)).await;
    let cal = day.spec.sessions;
    let own_day = cal.bucket_start(open, Timeframe::D1);
    assert!(
        daily.iter().any(|b| b.t == own_day),
        "the store holds the replayed day's own daily bar"
    );

    let id = day.open(open, 1, false).await;
    let (before, _) = split(&minutes, open);
    assert_eq!(
        day.bars(&id, Timeframe::M15).await,
        aggregate(&before, Timeframe::M15, cal),
        "the whole trading day before, up to its close"
    );
    let (days_before, _) = split(&daily, own_day);
    assert_eq!(day.bars(&id, Timeframe::D1).await, days_before);

    let later = Timestamp(open.0 + 20 * NANOS_PER_MINUTE);
    let jumped = day.replays.jump(&id, later).unwrap().instrument;
    let (old, played) = split(&day.bars(&jumped, Timeframe::D1).await, own_day);
    assert_eq!(old, days_before);
    assert_eq!(
        played,
        day.played(Timeframe::D1, later),
        "the day's own bar holds only what the replay played"
    );

    let mut live = collect(day.router.subscribe_bars(&jumped, Timeframe::D1).unwrap());
    day.replays.control(&jumped, Some(true), Some(60)).unwrap();
    wall(5.0).await;
    day.replays.control(&jumped, Some(false), None).unwrap();
    wall(1.0).await;
    let cursor = day.replays.state(&jumped).unwrap().cursor;
    assert_eq!(
        drain(&mut live).last().map(|b| b.bar),
        day.played(Timeframe::D1, cursor).last().copied(),
        "the live daily bar holds the day from its open, before midnight too"
    );
}

#[tokio::test(start_paused = true)]
async fn a_replay_starting_inside_a_bar_opens_it_with_the_minutes_kept_before_its_first_print() {
    let start = at("2026-10-01T13:07:30-04:00");
    let end = at("2026-10-01T13:30:00-04:00");
    let router = MarketRouter::new();
    let store = kept(&router);
    let minutes = keep(
        &store,
        Timeframe::M1,
        at("2026-09-30T18:00:00-04:00"),
        at("2026-10-01T14:00:00-04:00"),
    )
    .await;
    let prints = mock_prints(start, end).await;
    let day = saved_day(router, &prints, Span::new(start.0, end.0)).await;
    let cal = day.spec.sessions;
    let lead: Vec<Bar> = minutes
        .iter()
        .filter(|b| b.t.0 + NANOS_PER_MINUTE <= start.0)
        .copied()
        .collect();
    let kept_quarters = aggregate(&lead, Timeframe::M15, cal);
    let opening = *kept_quarters.last().unwrap();
    assert_eq!(opening.t, at("2026-10-01T13:00:00-04:00"));

    let id = day.open(start, 1, false).await;
    assert_eq!(day.bars(&id, Timeframe::M15).await, kept_quarters);

    let mut live = collect(day.router.subscribe_bars(&id, Timeframe::M15).unwrap());
    day.replays.control(&id, Some(true), None).unwrap();
    wall(20.0).await;
    day.replays.control(&id, Some(false), None).unwrap();
    wall(1.0).await;
    let cursor = day.replays.state(&id).unwrap().cursor;
    let streamed = drain(&mut live).last().unwrap().bar;
    let mut expected = opening;
    expected.merge(&day.played(Timeframe::M15, cursor)[0]);
    assert_eq!(
        streamed, expected,
        "the live bar carries on from the kept minutes"
    );
    assert_eq!(day.bars(&id, Timeframe::M15).await.last(), Some(&expected));
}

#[tokio::test(start_paused = true)]
async fn a_replay_says_where_the_bars_kept_before_it_stop() {
    let start = at("2026-10-01T09:30:00-04:00");
    let end = at("2026-10-01T09:40:00-04:00");
    let prints = mock_prints(start, end).await;
    let bare = saved_day(MarketRouter::new(), &prints, Span::new(start.0, end.0)).await;
    let id = bare.open(start, 1, false).await;
    assert_eq!(bare.earlier(&id).await, EarlierBars::Missing);
    assert_eq!(
        bare.bars(&id, Timeframe::M5).await,
        Vec::new(),
        "nothing kept, nothing played"
    );

    let stop = at("2026-09-30T12:00:00-04:00");
    let router = MarketRouter::new();
    keep(
        &kept(&router),
        Timeframe::M1,
        at("2026-09-29T18:00:00-04:00"),
        stop,
    )
    .await;
    let stopped = saved_day(router, &prints, Span::new(start.0, end.0)).await;
    let id = stopped.open(start, 1, false).await;
    assert_eq!(
        stopped.earlier(&id).await,
        EarlierBars::Gap {
            from: stop,
            to: start
        }
    );

    let resumed = at("2026-10-01T08:00:00-04:00");
    let router = MarketRouter::new();
    keep(
        &kept(&router),
        Timeframe::M1,
        resumed,
        at("2026-10-01T12:00:00-04:00"),
    )
    .await;
    let morning = saved_day(router, &prints, Span::new(start.0, end.0)).await;
    let id = morning.open(start, 1, false).await;
    assert_eq!(
        morning.earlier(&id).await,
        EarlierBars::Gap {
            from: at("2026-09-29T18:00:00-04:00"),
            to: resumed
        },
        "the morning alone leaves the trading day before it unsaved"
    );
}

fn minutes_of(prints: &[Trade], cal: tessera_core::session::SessionCalendar) -> Vec<Bar> {
    let mut b = TradeBarBuilder::new(Timeframe::M1, cal);
    let mut out: Vec<Bar> = prints
        .iter()
        .filter_map(|p| b.push(p.ts, p.price, p.size, p.aggressor))
        .collect();
    out.extend(b.current().copied());
    out
}

#[tokio::test(start_paused = true)]
async fn a_hole_in_the_saved_day_shows_the_minutes_stored_for_it() {
    let open = at("2026-09-30T18:00:00-04:00");
    let hole = (
        at("2026-09-30T19:00:00-04:00"),
        at("2026-10-01T09:30:00-04:00"),
    );
    let end = at("2026-10-01T10:00:00-04:00");
    let router = MarketRouter::new();
    let store = kept(&router);
    let minutes = keep(
        &store,
        Timeframe::M1,
        at("2026-09-29T18:00:00-04:00"),
        at("2026-10-01T12:00:00-04:00"),
    )
    .await;
    let evening = mock_prints(open, hole.0).await;
    let morning = mock_prints(hole.1, end).await;
    let day = saved_days(
        router,
        &[(&evening, Span::new(open.0, hole.0.0))],
        &morning,
        Span::new(hole.1.0, end.0),
    )
    .await;
    let cal = day.spec.sessions;
    let stored_in = |from: Timestamp, to: Timestamp| -> Vec<Bar> {
        minutes
            .iter()
            .filter(|b| b.t >= from && b.t < to)
            .copied()
            .collect()
    };
    let mut expected = stored_in(Timestamp(0), open);
    expected.extend(minutes_of(&evening, cal));
    expected.extend(stored_in(hole.0, hole.1));

    let id = day.open(hole.1, 1, false).await;
    assert_eq!(
        day.bars(&id, Timeframe::M15).await,
        aggregate(&expected, Timeframe::M15, cal),
        "the stored minutes fill the hole between the saved prints"
    );

    let before_hole = Timestamp(hole.0.0 - 5 * NANOS_PER_MINUTE);
    let jumped = day.replays.jump(&id, before_hole).unwrap().instrument;
    let mut live = collect(day.router.subscribe_bars(&jumped, Timeframe::M15).unwrap());
    day.replays.control(&jumped, Some(true), Some(600)).unwrap();
    wall(120.0).await;
    let closed: Vec<Bar> = drain(&mut live)
        .into_iter()
        .filter(|b| b.closed && b.bar.t >= hole.0 && b.bar.t < hole.1)
        .map(|b| b.bar)
        .collect();
    assert_eq!(
        closed,
        aggregate(&stored_in(hole.0, hole.1), Timeframe::M15, cal),
        "playing past the hole closes its bars from the stored minutes"
    );
}

#[tokio::test(start_paused = true)]
async fn a_replay_reads_the_prints_saved_on_days_before_its_own() {
    let (start, end) = (
        at("2026-10-01T09:30:00-04:00"),
        at("2026-10-01T09:40:00-04:00"),
    );
    let (before_start, before_end) = (
        at("2026-09-30T09:30:00-04:00"),
        at("2026-09-30T09:40:00-04:00"),
    );
    let earlier = mock_prints(before_start, before_end).await;
    let prints = mock_prints(start, end).await;
    let day = saved_days(
        MarketRouter::new(),
        &[(&earlier, Span::new(before_start.0, before_end.0))],
        &prints,
        Span::new(start.0, end.0),
    )
    .await;
    let id = day.open(start, 1, false).await;
    let read = |id: InstrumentId| {
        let router = Arc::clone(&day.router);
        async move {
            router
                .get_trades(TradesRequest {
                    instrument: id,
                    from: Some(before_start),
                    to: None,
                    limit: None,
                })
                .await
                .unwrap()
        }
    };
    let held = read(id.clone()).await;
    assert_eq!(
        held.len(),
        earlier.len(),
        "the earlier day, none of its own"
    );
    assert!(held.iter().all(|t| t.ts < before_end && t.instrument == id));

    let later = Timestamp(start.0 + 5 * NANOS_PER_MINUTE);
    let jumped = day.replays.jump(&id, later).unwrap().instrument;
    let held = read(jumped).await;
    let played = prints.iter().filter(|t| t.ts < later).count();
    assert_eq!(held.len(), earlier.len() + played);
    assert!(held.iter().all(|t| t.ts < later));
}

#[tokio::test(start_paused = true)]
async fn a_bar_read_from_past_the_clock_answers_no_bar() {
    let start = at("2026-10-01T09:30:00-04:00");
    let end = at("2026-10-01T09:40:00-04:00");
    let prints = mock_prints(start, end).await;
    let day = saved_day(MarketRouter::new(), &prints, Span::new(start.0, end.0)).await;
    let id = day.open(start, 1, false).await;
    let read = day
        .router
        .get_bars(BarsRequest {
            from: Some(Timestamp(start.0 + 5 * NANOS_PER_MINUTE)),
            ..BarsRequest::latest(id, Timeframe::M1, 100)
        })
        .await
        .unwrap();
    assert_eq!(read.bars, Vec::new());
}
