use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::{Clock, ManualClock};
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{AggressorSource, Quote, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::settle::settle;
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicSizing};
use tessera_market::hub::{MarketHub, PumpKey};
use tessera_market::io::{DepthKind, DepthUpdate, FootprintUpdate, TradesUpdate};
use tessera_market::orderflow::big_trades::{
    Contract, Grouping, MIN_NOTIONAL, ModelBuilder, ModelCoverage,
};
use tessera_market::{
    BarSeries, BarsRequest, BookSide, LiveBar, MarketDataProvider, MarketError, MarketRouter,
    MarketStream, MockConfig, MockMarket, OrderBookEvent,
};
use tessera_protocol::topics::names;
use tokio::sync::{broadcast, mpsc};

fn now() -> Timestamp {
    Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap()
}

fn id(s: &str) -> InstrumentId {
    InstrumentId::new(s).unwrap()
}

struct Desk {
    market: MockMarket,
    clock: Arc<ManualClock>,
    hub: Arc<MarketHub>,
    bus: Arc<EventBus>,
}

fn desk(seed: u64) -> Desk {
    desk_at(seed, now())
}

fn desk_at(seed: u64, at: Timestamp) -> Desk {
    let clock = Arc::new(ManualClock::new(at));
    let mut cfg = MockConfig::new(clock.clone());
    cfg.seed = seed;
    cfg.intraday_sessions = 3;
    cfg.daily_sessions = 20;
    let market = MockMarket::new(cfg);
    let router = MarketRouter::new();
    router.add(Arc::new(market.clone())).unwrap();
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
    let hub = MarketHub::new(router, Arc::clone(&bus));
    hub.set_linger(Duration::ZERO);
    Desk {
        market,
        clock,
        hub,
        bus,
    }
}

impl Desk {
    async fn run(&self, ticks: usize) {
        for _ in 0..ticks {
            self.clock.advance(NANOS_PER_SEC / 4);
            self.market.advance(self.clock.now());
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
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
}

#[derive(Default)]
struct Ladder {
    bids: BTreeMap<i64, f64>,
    asks: BTreeMap<i64, f64>,
}

fn cents(p: f64) -> i64 {
    (p * 100.0).round() as i64
}

impl Ladder {
    fn apply(&mut self, u: &DepthUpdate) {
        if u.kind == DepthKind::Snapshot {
            self.bids.clear();
            self.asks.clear();
        }
        for (side, levels) in [(&mut self.bids, &u.bids), (&mut self.asks, &u.asks)] {
            for l in levels {
                if l.1 > 0.0 {
                    side.insert(cents(l.0), l.1);
                } else {
                    side.remove(&cents(l.0));
                }
            }
        }
        let n = u.levels as usize;
        while self.bids.len() > n {
            self.bids.pop_first();
        }
        while self.asks.len() > n {
            self.asks.pop_last();
        }
    }

    fn of(u: &DepthUpdate) -> Self {
        let mut l = Self::default();
        l.apply(u);
        l
    }
}

#[tokio::test(start_paused = true)]
async fn depth_sends_a_snapshot_then_deltas_that_rebuild_the_book() {
    let d = desk(41);
    let es = id("ESZ6.CME");
    let (mut rx, _) = d.bus.subscribe(names::MARKET_DEPTH).unwrap();
    let view = d.hub.acquire(PumpKey::Depth(es.clone(), 10)).unwrap();
    d.run(40).await;
    let updates: Vec<DepthUpdate> = Desk::events(&mut rx);
    assert!(updates.len() > 20, "{} updates", updates.len());
    assert_eq!(updates[0].kind, DepthKind::Snapshot);
    assert_eq!(updates[0].bids.len(), 10);
    assert!(updates[0].bids[0].2.is_some(), "order counts ride along");
    assert!(updates[1..].iter().all(|u| u.kind == DepthKind::Delta));
    assert!(updates.windows(2).all(|w| w[1].seq == w[0].seq + 1));
    let mean = updates[1..]
        .iter()
        .map(|u| u.bids.len() + u.asks.len())
        .sum::<usize>()
        / (updates.len() - 1);
    assert!(mean < 20, "deltas average {mean} levels");
    let mut ladder = Ladder::default();
    for u in &updates {
        ladder.apply(u);
    }
    let snap = d.hub.depth_snapshot(&es, 10).unwrap();
    assert_eq!(snap.seq, updates.last().unwrap().seq);
    let fresh = Ladder::of(&snap);
    assert_eq!(ladder.bids, fresh.bids);
    assert_eq!(ladder.asks, fresh.asks);
    assert_eq!(ladder.bids.len(), 10);
    let book = d.market.book(&es, 10).unwrap().unwrap();
    assert_eq!(cents(snap.bids[0].0), cents(book.bids[0].price.to_f64()));
    drop(view);
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(d.hub.pump_count(), 0, "the view and its book feed stop");
}

#[tokio::test(start_paused = true)]
async fn trades_are_numbered_and_history_has_no_gap_or_overlap() {
    let d = desk(43);
    let nq = id("NQZ6.CME");
    let (mut rx, _) = d.bus.subscribe(names::MARKET_TRADES).unwrap();
    let feed = d.hub.acquire(PumpKey::Trades(nq.clone())).unwrap();
    d.run(4 * 20).await;
    let batches: Vec<TradesUpdate> = Desk::events(&mut rx);
    assert!(!batches.is_empty());
    for w in batches.windows(2) {
        assert_eq!(
            w[1].seq,
            w[0].seq + w[1].trades.len() as u64,
            "no lost prints"
        );
    }
    assert!(
        batches
            .iter()
            .all(|b| b.aggressor_source == Some(AggressorSource::Exchange))
    );
    let streamed: Vec<_> = batches.iter().flat_map(|b| b.trades.clone()).collect();
    let h = d.hub.history(&nq, None, None, Some(50)).await.unwrap();
    assert_eq!(h.seq, batches.last().unwrap().seq);
    let recent: Vec<_> = h
        .trades
        .iter()
        .map(tessera_protocol::compact::CompactTrade::from)
        .collect();
    assert_eq!(recent, streamed[streamed.len() - 50..]);
    let t1442 = Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap();
    let minute = d
        .hub
        .history(
            &nq,
            Some(t1442),
            Some(t1442.add_nanos(60 * NANOS_PER_SEC)),
            None,
        )
        .await
        .unwrap();
    let bar = d
        .market
        .get_bars(BarsRequest {
            instrument: nq.clone(),
            tf: Timeframe::M1,
            from: Some(t1442),
            to: Some(t1442),
            limit: None,
            rth_only: false,
        })
        .await
        .unwrap()
        .bars[0];
    let v = minute.trades.iter().fold(Qty::ZERO, |a, t| a + t.size);
    assert_eq!(v, bar.v);
    assert!(minute.trades.windows(2).all(|w| w[0].ts <= w[1].ts));
    drop(feed);
}

async fn known_from(hub: &MarketHub, id: &InstrumentId) -> Option<Timestamp> {
    let newest = hub.history(id, None, None, Some(1)).await.unwrap().trades[0].ts;
    let hour_before = Timestamp(newest.0 - 3_600 * NANOS_PER_SEC);
    let h = hub
        .history(id, Some(hour_before), None, None)
        .await
        .unwrap();
    h.gaps.spans().last().map(|g| Timestamp(g.end))
}

#[tokio::test(start_paused = true)]
async fn reading_history_records_nothing() {
    let d = desk(44);
    let es = id("ESZ6.CME");
    let feed = d.hub.acquire(PumpKey::Trades(es.clone())).unwrap();
    d.run(8).await;
    for s in ["NQZ6.CME", "QQQ", "NVDA", "AAPL", "BTC-USD.COINBASE"] {
        let h = d.hub.history(&id(s), None, None, Some(20)).await.unwrap();
        assert_eq!(h.trades.len(), 20, "{s}");
        assert!(h.gaps.is_empty(), "the mock keeps history");
        assert!(
            d.hub
                .depth_history(&id(s), 0, i64::MAX)
                .await
                .columns
                .is_empty()
        );
    }
    let stats = d.hub.recording_stats();
    assert_eq!(stats.instruments, 1, "{stats:?}");
    assert!(stats.prints > 0);
    drop(feed);
}

#[tokio::test(start_paused = true)]
async fn footprints_seed_the_forming_bar_and_add_up_to_bars() {
    let d = desk(47);
    let nq = id("NQZ6.CME");
    let (mut rx, _) = d.bus.subscribe(names::MARKET_FOOTPRINT).unwrap();
    let one = d
        .hub
        .acquire(PumpKey::Footprint(nq.clone(), Timeframe::M1, 1))
        .unwrap();
    let four = d
        .hub
        .acquire(PumpKey::Footprint(nq.clone(), Timeframe::M1, 4))
        .unwrap();
    d.run(4 * 100).await;
    let updates: Vec<FootprintUpdate> = Desk::events(&mut rx);
    let forming = updates.iter().filter(|u| !u.closed).count();
    assert!(forming < 2 * 4 * 100 + 10, "{forming} forming updates");
    let bars = d
        .market
        .get_bars(BarsRequest {
            instrument: nq.clone(),
            tf: Timeframe::M1,
            from: Some(Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap()),
            to: Some(Timestamp::parse("2026-10-02T14:43:00-04:00").unwrap()),
            limit: None,
            rth_only: false,
        })
        .await
        .unwrap()
        .bars;
    for (row, rows) in [("0.25", 1), ("1", 4)] {
        let row = Price::from_str(row).unwrap();
        for bar in &bars {
            let fp = updates
                .iter()
                .find(|u| u.closed && u.bar.t == bar.t && u.bar.row == row)
                .unwrap_or_else(|| panic!("{} closed at {rows} ticks", bar.t));
            assert_eq!(fp.bar.volume, bar.v, "{} rows of {rows}", bar.t);
            let bv = bar.bv.unwrap();
            assert_eq!(fp.bar.delta, bv + bv - bar.v, "{}", bar.t);
            let sum: f64 = fp.bar.cells.iter().map(|c| c.1 + c.2).sum();
            assert_eq!(sum, fp.bar.volume.to_f64());
            assert!(fp.bar.cells.windows(2).all(|w| w[0].0 < w[1].0));
            assert!(fp.bar.poc.is_some());
            let (hi, lo) = (fp.bar.delta_high.unwrap(), fp.bar.delta_low.unwrap());
            assert!(hi >= fp.bar.delta.max(Qty::ZERO) && lo <= fp.bar.delta.min(Qty::ZERO));
            assert!(fp.seq.is_some());
            assert_eq!(fp.bar.aggressor_source, AggressorSource::Exchange);
            if rows == 1 {
                assert_eq!(fp.bar.cells[0].0, bar.l.to_f64(), "the low traded");
                assert!(
                    fp.bar
                        .cells
                        .iter()
                        .all(|c| c.0 >= bar.l.to_f64() && c.0 <= bar.h.to_f64())
                );
            }
            assert_eq!(fp.source.provider, "mock");
        }
    }
    let snap = d.hub.footprint_snapshot(&nq, Timeframe::M1, 1).unwrap();
    assert!(!snap.closed && !snap.partial);
    assert_eq!(
        snap.bar.t,
        Timestamp::parse("2026-10-02T14:44:00-04:00").unwrap()
    );
    let one_tick = Price::from_str("0.25").unwrap();
    let stream: Vec<&FootprintUpdate> = updates
        .iter()
        .filter(|u| u.bar.row == one_tick && u.bar.t == snap.bar.t)
        .collect();
    assert!(!stream[0].partial, "a bar opens whole");
    let partials: Vec<_> = stream.iter().filter(|u| u.partial).collect();
    assert!(partials.len() > 10, "{} partial updates", partials.len());
    let mut merged: BTreeMap<i64, (f64, f64)> = BTreeMap::new();
    for u in &stream {
        for c in &u.bar.cells {
            let e = merged.entry(cents(c.0)).or_default();
            *e = (e.0.max(c.1), e.1.max(c.2));
        }
    }
    let whole: BTreeMap<i64, (f64, f64)> = snap
        .bar
        .cells
        .iter()
        .map(|c| (cents(c.0), (c.1, c.2)))
        .collect();
    assert_eq!(merged, whole);
    assert_eq!(stream.last().unwrap().bar.volume, snap.bar.volume);
    assert_eq!(stream.last().unwrap().bar.poc, snap.bar.poc);
    assert_eq!(stream.last().unwrap().bar.delta_high, snap.bar.delta_high);
    assert_eq!(stream.last().unwrap().bar.delta_low, snap.bar.delta_low);
    assert!(stream.windows(2).all(|w| w[0].seq <= w[1].seq));
    assert_eq!(snap.seq, stream.last().unwrap().seq);
    let rows: usize = partials.iter().map(|u| u.bar.cells.len()).sum();
    assert!(
        rows < partials.len() * whole.len() / 2,
        "partials carry what changed: {rows} rows in {} updates of a {}-row bar",
        partials.len(),
        whole.len()
    );
    drop((one, four));
}

#[tokio::test(start_paused = true)]
async fn a_daily_footprint_starts_with_its_whole_session() {
    let d = desk(48);
    let nq = id("NQZ6.CME");
    let fp = d
        .hub
        .acquire(PumpKey::Footprint(nq.clone(), Timeframe::D1, 8))
        .unwrap();
    let snap = settle(
        "the forming day",
        || d.hub.footprint_snapshot(&nq, Timeframe::D1, 8),
        Option::is_some,
    )
    .await
    .expect("the forming day");
    let day = d
        .market
        .get_bars(BarsRequest::latest(nq.clone(), Timeframe::D1, 1))
        .await
        .unwrap()
        .bars[0];
    assert_eq!(snap.bar.t, day.t);
    assert_eq!(snap.bar.volume, day.v);
    drop(fp);
}

struct OrderFeed {
    spec: (Instrument, ContractSpec),
    events: parking_lot::Mutex<Option<mpsc::UnboundedReceiver<OrderBookEvent>>>,
}

#[async_trait]
impl MarketDataProvider for OrderFeed {
    fn id(&self) -> &str {
        "order-feed"
    }
    fn display_name(&self) -> &str {
        "Order feed"
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: vec![],
            live_timeframes: vec![],
            quotes: false,
            trades: false,
            depth_levels: Some(50),
            footprint: false,
            asset_classes: vec![AssetClass::Future],
            max_intraday_history_days: None,
            max_daily_history_days: None,
            realtime: true,
            aggressor_source: None,
        }
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.id().into(),
            kind: ProviderKind::MarketData,
            display_name: self.display_name().into(),
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
        Ok(vec![self.spec.0.clone()])
    }
    async fn resolve(&self, _: &str) -> Result<InstrumentId, MarketError> {
        Ok(self.spec.0.id.clone())
    }
    async fn spec(&self, _: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        Ok(self.spec.clone())
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        Err(MarketError::Unsupported(format!("{}", req.instrument)))
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        Err(MarketError::Unsupported(i.to_string()))
    }
    fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Err(MarketError::Unsupported("quotes".into()))
    }
    fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        Err(MarketError::Unsupported("trades".into()))
    }
    fn subscribe_bars(
        &self,
        _: &InstrumentId,
        _: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        Err(MarketError::Unsupported("bars".into()))
    }
    fn subscribe_order_book(
        &self,
        _: &InstrumentId,
    ) -> Result<MarketStream<OrderBookEvent>, MarketError> {
        let rx = self
            .events
            .lock()
            .take()
            .ok_or_else(|| MarketError::Unavailable("one subscriber".into()))?;
        Ok(tokio_stream::wrappers::UnboundedReceiverStream::new(rx).boxed())
    }
}

#[tokio::test(start_paused = true)]
async fn an_order_by_order_feed_serves_depth() {
    let d = desk(59);
    let es = id("ESZ6.CME");
    let spec = d.market.spec(&es).await.unwrap();
    let (tx, events) = mpsc::unbounded_channel();
    let router = MarketRouter::new();
    router
        .add(Arc::new(OrderFeed {
            spec,
            events: parking_lot::Mutex::new(Some(events)),
        }))
        .unwrap();
    let hub = MarketHub::new(router, Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut rx, _) = d.bus.subscribe(names::MARKET_DEPTH).unwrap();
    let _view = hub.acquire(PumpKey::Depth(es.clone(), 5)).unwrap();

    let p = |cents: i64| Price(rust_decimal::Decimal::new(cents, 2));
    let add = |order: &str, side, cents, size: i64| OrderBookEvent::Add {
        ts: Timestamp(1),
        order: order.into(),
        side,
        price: p(cents),
        size: Qty::from(size),
    };
    tx.send(OrderBookEvent::Clear { ts: Timestamp(0) }).unwrap();
    for (i, cents) in (0..8).map(|i| (i, 500_000 - 25 * i)) {
        tx.send(add(&format!("b{i}"), BookSide::Bid, cents, 2 + i))
            .unwrap();
        tx.send(add(&format!("c{i}"), BookSide::Bid, cents, 1))
            .unwrap();
        tx.send(add(
            &format!("a{i}"),
            BookSide::Ask,
            cents + 25 * (i + 1),
            3,
        ))
        .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        Desk::events::<DepthUpdate>(&mut rx).is_empty(),
        "nothing until the image is complete"
    );
    tx.send(OrderBookEvent::Synced { ts: Timestamp(2) })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let first: Vec<DepthUpdate> = Desk::events(&mut rx);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].kind, DepthKind::Snapshot);
    assert_eq!(first[0].bids.len(), 5);
    assert_eq!(
        first[0].bids[0],
        tessera_protocol::compact::CompactLevel(5000.0, 3.0, Some(2))
    );
    assert_eq!(first[0].source.provider, "order-feed");
    tx.send(OrderBookEvent::Remove {
        ts: Timestamp(3),
        order: "b0".into(),
        side: BookSide::Bid,
    })
    .unwrap();
    tx.send(OrderBookEvent::Remove {
        ts: Timestamp(3),
        order: "c0".into(),
        side: BookSide::Bid,
    })
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let next: Vec<DepthUpdate> = Desk::events(&mut rx);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].kind, DepthKind::Delta);
    assert_eq!(next[0].seq, 2);
    let mut ladder = Ladder::of(&first[0]);
    ladder.apply(&next[0]);
    assert_eq!(ladder.bids.len(), 5);
    assert_eq!(ladder.bids.last_key_value(), Some((&499_975, &4.0)));
    assert_eq!(ladder.bids.first_key_value(), Some((&499_875, &8.0)));
}

const WEDNESDAY_10AM_NEW_YORK: i64 = 1_790_776_800 * NANOS_PER_SEC;

struct PrintPerMs {
    spec: (Instrument, ContractSpec),
}

#[async_trait]
impl MarketDataProvider for PrintPerMs {
    fn id(&self) -> &str {
        "per-print"
    }
    fn display_name(&self) -> &str {
        "Per print"
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: vec![],
            live_timeframes: vec![],
            quotes: false,
            trades: true,
            depth_levels: None,
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
            provider_id: self.id().into(),
            kind: ProviderKind::MarketData,
            display_name: self.display_name().into(),
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
        Ok(vec![self.spec.0.clone()])
    }
    async fn resolve(&self, _: &str) -> Result<InstrumentId, MarketError> {
        Ok(self.spec.0.id.clone())
    }
    async fn spec(&self, _: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        Ok(self.spec.clone())
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        Err(MarketError::Unsupported(format!("{}", req.instrument)))
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        Err(MarketError::Unsupported(i.to_string()))
    }
    fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Err(MarketError::Unsupported("quotes".into()))
    }
    fn subscribe_trades(&self, ids: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        let id = ids[0].clone();
        let mut n = 0i64;
        let every = tokio::time::interval(Duration::from_millis(1));
        Ok(tokio_stream::wrappers::IntervalStream::new(every)
            .map(move |_| {
                n += 1;
                Trade {
                    instrument: id.clone(),
                    ts: Timestamp(WEDNESDAY_10AM_NEW_YORK + n * 1_000_000),
                    price: Price::from(100),
                    size: Qty::from(1),
                    aggressor: tessera_core::market::Aggressor::Buy,
                    aggressor_source: AggressorSource::Exchange,
                    order_key: None,
                    source: None,
                }
            })
            .boxed())
    }
    fn subscribe_bars(
        &self,
        _: &InstrumentId,
        _: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        Ok(futures::stream::pending().boxed())
    }
}

#[tokio::test(start_paused = true)]
async fn a_chart_records_its_instruments_prints() {
    let d = desk(62);
    let es = id("ESZ6.CME");
    let spec = d.market.spec(&es).await.unwrap();
    let router = MarketRouter::new();
    router.add(Arc::new(PrintPerMs { spec })).unwrap();
    let hub = MarketHub::new(router, Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let chart = hub
        .acquire(PumpKey::Bars(es.clone(), Timeframe::M1))
        .unwrap();
    assert_eq!(hub.pump_count(), 2, "the chart and its prints");
    tokio::time::sleep(Duration::from_secs(1)).await;
    let h = hub.history(&es, None, None, None).await.unwrap();
    assert!(h.trades.len() >= 900, "{} prints recorded", h.trades.len());
    assert_eq!(known_from(&hub, &es).await, Some(h.trades[0].ts));
    drop(chart);
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(hub.pump_count(), 0, "closing the chart stops the recording");
    let kept = hub.history(&es, None, None, None).await.unwrap();
    assert!(kept.trades.len() >= h.trades.len());

    hub.set_linger(Duration::from_secs(60));
    let chart = hub
        .acquire(PumpKey::Bars(es.clone(), Timeframe::M1))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let since = known_from(&hub, &es).await;
    drop(chart);
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(hub.pump_count(), 1, "the prints keep recording a while");
    let back = hub
        .acquire(PumpKey::Bars(es.clone(), Timeframe::M1))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(known_from(&hub, &es).await, since, "no break while away");
    drop(back);
    tokio::time::sleep(Duration::from_secs(61)).await;
    assert_eq!(hub.pump_count(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_long_recording_keeps_every_print_it_recorded_past_the_tapes_reach() {
    use tessera_market::hub::tape::TAPE_MAX;
    let d = desk(64);
    let es = id("ESZ6.CME");
    let spec = d.market.spec(&es).await.unwrap();
    let router = MarketRouter::new();
    router.add(Arc::new(PrintPerMs { spec })).unwrap();
    let hub = MarketHub::new(router, Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let chart = hub
        .acquire(PumpKey::Bars(es.clone(), Timeframe::M1))
        .unwrap();
    tokio::time::sleep(Duration::from_secs(150)).await;
    let h = hub.history(&es, None, None, None).await.unwrap();
    assert!(
        h.trades.len() > TAPE_MAX * 14 / 10,
        "{} prints",
        h.trades.len()
    );
    assert_eq!(
        known_from(&hub, &es).await,
        Some(h.trades[0].ts),
        "known from the first print recorded"
    );
    assert!(!h.filling, "this connection replays nothing");
    assert!(
        h.trades
            .windows(2)
            .all(|w| w[1].ts.0 - w[0].ts.0 == 1_000_000),
        "every print, none twice"
    );
    let early = hub
        .history(&es, Some(h.trades[10].ts), Some(h.trades[20].ts), None)
        .await
        .unwrap();
    assert_eq!(early.trades, h.trades[10..20]);
    assert!(early.gaps.is_empty());
    drop(chart);
}

#[tokio::test(start_paused = true)]
async fn a_mock_market_chart_records_nothing() {
    let d = desk(63);
    let es = id("ESZ6.CME");
    let chart = d.hub.acquire(PumpKey::Bars(es, Timeframe::M1)).unwrap();
    assert_eq!(d.hub.pump_count(), 1);
    drop(chart);
}

#[tokio::test(start_paused = true)]
async fn a_print_per_message_feed_is_batched() {
    let d = desk(61);
    let es = id("ESZ6.CME");
    let spec = d.market.spec(&es).await.unwrap();
    let router = MarketRouter::new();
    router.add(Arc::new(PrintPerMs { spec })).unwrap();
    let hub = MarketHub::new(router, Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut rx, _) = d.bus.subscribe(names::MARKET_TRADES).unwrap();
    let feed = hub.acquire(PumpKey::Trades(es.clone())).unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let batches: Vec<TradesUpdate> = Desk::events(&mut rx);
    assert!(
        (70..=81).contains(&batches.len()),
        "{} batches in 2 s",
        batches.len()
    );
    let prints: usize = batches.iter().map(|b| b.trades.len()).sum();
    assert!(prints >= 1900, "{prints} prints");
    for w in batches.windows(2) {
        assert_eq!(w[1].seq, w[0].seq + w[1].trades.len() as u64);
    }
    drop(feed);
}

struct Watchlist {
    spec: (Instrument, ContractSpec),
}

#[async_trait]
impl MarketDataProvider for Watchlist {
    fn id(&self) -> &str {
        "watchlist"
    }
    fn display_name(&self) -> &str {
        "Watchlist"
    }
    fn capabilities(&self) -> MarketCapabilities {
        PrintPerMs {
            spec: self.spec.clone(),
        }
        .capabilities()
    }
    fn health(&self) -> ProviderHealth {
        PrintPerMs {
            spec: self.spec.clone(),
        }
        .health()
    }
    async fn search(
        &self,
        _: &str,
        _: Option<AssetClass>,
        _: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        Ok(vec![])
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        InstrumentId::new(input).map_err(|e| MarketError::UnknownInstrument(e.to_string()))
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        let (mut instrument, spec) = self.spec.clone();
        instrument.id = i.clone();
        Ok((instrument, spec))
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        Err(MarketError::Unsupported(format!("{}", req.instrument)))
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        Err(MarketError::Unsupported(i.to_string()))
    }
    fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Err(MarketError::Unsupported("quotes".into()))
    }
    fn subscribe_trades(&self, ids: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        let id = ids[0].clone();
        let every = tokio::time::interval(Duration::from_millis(100));
        Ok(tokio_stream::wrappers::IntervalStream::new(every)
            .map(move |_| Trade {
                instrument: id.clone(),
                ts: Timestamp::now(),
                price: Price::from(100),
                size: Qty::from(1),
                aggressor: tessera_core::market::Aggressor::Sell,
                aggressor_source: AggressorSource::Exchange,
                order_key: None,
                source: None,
            })
            .boxed())
    }
    fn subscribe_bars(
        &self,
        _: &InstrumentId,
        _: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        Err(MarketError::Unsupported("bars".into()))
    }
}

#[tokio::test(start_paused = true)]
async fn an_agent_scan_never_pushes_out_what_the_user_recorded() {
    use tessera_core::ids::SessionId;
    use tessera_core::origin::Origin;
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_market::hub::{AGENT_LINGER, MAX_AGENT_FEEDS, MAX_RECORDED};
    use tessera_tools::{ToolCtx, ToolRegistry};

    let d = desk(62);
    let spec = d.market.spec(&id("ESZ6.CME")).await.unwrap();
    let router = MarketRouter::new();
    router.add(Arc::new(Watchlist { spec })).unwrap();
    let module = MarketModule::new(router, Arc::clone(&d.bus));
    let hub = module.hub();
    hub.set_linger(Duration::ZERO);
    hub.set_agent_linger(AGENT_LINGER);
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let trades = r.get("market.get_trades").unwrap();

    let nq = id("NQZ6.CME");
    let tape = hub.linger(PumpKey::Trades(nq.clone())).unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    drop(tape);
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(hub.pump_count(), 0);
    let recorded = hub
        .history(&nq, None, None, None)
        .await
        .unwrap()
        .trades
        .len();
    assert!(recorded >= 19, "{recorded} prints recorded");

    let agent = ToolCtx::new(
        Origin::Agent {
            session_id: SessionId::new("S1"),
            provider: "test".into(),
        },
        now(),
    );
    for i in 0..40 {
        let input = serde_json::json!({"instrument": format!("S{i:02}"), "limit": 10});
        trades.call_json(&agent, input).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(hub.agent_feeds() <= MAX_AGENT_FEEDS);
        assert!(
            hub.pump_count() <= MAX_AGENT_FEEDS,
            "{} feeds",
            hub.pump_count()
        );
        let stats = hub.recording_stats();
        assert!(stats.instruments <= MAX_RECORDED, "{stats:?}");
    }
    assert_eq!(hub.agent_feeds(), MAX_AGENT_FEEDS);
    let h = hub.history(&nq, None, None, None).await.unwrap();
    assert_eq!(
        h.trades.len(),
        recorded,
        "the user's tape survived the scan"
    );
    tokio::time::sleep(AGENT_LINGER + Duration::from_secs(1)).await;
    assert_eq!(hub.agent_feeds(), 0);
    assert_eq!(hub.pump_count(), 0);
}

struct Login {
    id: &'static str,
    spec: (Instrument, ContractSpec),
    bid: i64,
    at: Timestamp,
    drop: Option<(Duration, Duration)>,
    down: bool,
}

impl Login {
    fn new(id: &'static str, spec: (Instrument, ContractSpec), bid: i64, at: Timestamp) -> Self {
        Self {
            id,
            spec,
            bid,
            at,
            drop: None,
            down: false,
        }
    }

    fn up(&self) -> Result<(), MarketError> {
        if self.down {
            return Err(MarketError::Unavailable(format!(
                "{} is connecting",
                self.id
            )));
        }
        Ok(())
    }
}

#[async_trait]
impl MarketDataProvider for Login {
    fn id(&self) -> &str {
        self.id
    }
    fn display_name(&self) -> &str {
        self.id
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: vec![],
            live_timeframes: vec![],
            quotes: false,
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
            provider_id: self.id.into(),
            kind: ProviderKind::MarketData,
            display_name: self.id.into(),
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
        Ok(vec![self.spec.0.clone()])
    }
    async fn resolve(&self, _: &str) -> Result<InstrumentId, MarketError> {
        Ok(self.spec.0.id.clone())
    }
    async fn spec(&self, _: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.up()?;
        Ok(self.spec.clone())
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        Err(MarketError::Unsupported(format!("{}", req.instrument)))
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        Err(MarketError::Unsupported(i.to_string()))
    }
    fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Err(MarketError::Unsupported("quotes".into()))
    }
    fn subscribe_trades(&self, ids: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.up()?;
        let id = ids[0].clone();
        let mut n = 0i64;
        let every = tokio::time::interval(Duration::from_millis(10));
        let price = Price::from(self.bid);
        let at = self.at;
        Ok(tokio_stream::wrappers::IntervalStream::new(every)
            .map(move |_| {
                n += 1;
                Trade {
                    instrument: id.clone(),
                    ts: at.add_nanos(n * 10_000_000),
                    price,
                    size: Qty::from(1),
                    aggressor: tessera_core::market::Aggressor::Sell,
                    aggressor_source: AggressorSource::Exchange,
                    order_key: None,
                    source: None,
                }
            })
            .boxed())
    }
    fn subscribe_bars(
        &self,
        _: &InstrumentId,
        _: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        Err(MarketError::Unsupported("bars".into()))
    }
    fn subscribe_order_book(
        &self,
        _: &InstrumentId,
    ) -> Result<MarketStream<OrderBookEvent>, MarketError> {
        self.up()?;
        let image = |ts: Timestamp, bid: i64| {
            let order = |side, price: i64| OrderBookEvent::Add {
                ts,
                order: format!("{price}"),
                side,
                price: Price::from(price),
                size: Qty::from(5),
            };
            vec![
                OrderBookEvent::Clear { ts },
                order(BookSide::Bid, bid),
                order(BookSide::Ask, bid + 1),
                OrderBookEvent::Synced { ts },
            ]
        };
        let first = futures::stream::iter(image(self.at, self.bid));
        let Some((gone, back)) = self.drop else {
            return Ok(first.chain(futures::stream::pending()).boxed());
        };
        let dropped = self.at.add_nanos(gone.as_nanos() as i64);
        let again = dropped.add_nanos(back.as_nanos() as i64);
        let bid = self.bid + 1;
        let later = |after: Duration, events: Vec<OrderBookEvent>| {
            futures::stream::once(tokio::time::sleep(after))
                .flat_map(move |()| futures::stream::iter(events.clone()))
        };
        Ok(first
            .chain(later(gone, vec![OrderBookEvent::Clear { ts: dropped }]))
            .chain(later(back, image(again, bid)))
            .chain(futures::stream::pending())
            .boxed())
    }
}

#[tokio::test(start_paused = true)]
async fn open_order_flow_follows_a_connection_removed_and_added_again() {
    let d = desk(67);
    let es = id("ESZ6.CME");
    let spec = d.market.spec(&es).await.unwrap();
    let router = MarketRouter::new();
    router
        .add(Arc::new(Login::new("first", spec.clone(), 100, now())))
        .unwrap();
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut trades, _) = d.bus.subscribe(names::MARKET_TRADES).unwrap();
    let (mut depth, _) = d.bus.subscribe(names::MARKET_DEPTH).unwrap();
    let (mut footprints, _) = d.bus.subscribe(names::MARKET_FOOTPRINT).unwrap();
    let _tape = hub.acquire(PumpKey::Trades(es.clone())).unwrap();
    let _view = hub.acquire(PumpKey::Depth(es.clone(), 5)).unwrap();
    let _fp = hub
        .acquire(PumpKey::Footprint(es.clone(), Timeframe::M1, 1))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    let before: Vec<TradesUpdate> = Desk::events(&mut trades);
    assert!(!before.is_empty());
    assert!(before.iter().all(|u| u.source.provider == "first"));
    let views: Vec<DepthUpdate> = Desk::events(&mut depth);
    assert_eq!(views[0].kind, DepthKind::Snapshot);
    assert_eq!(views[0].source.provider, "first");
    let fps: Vec<FootprintUpdate> = Desk::events(&mut footprints);
    assert!(fps.iter().all(|u| u.source.provider == "first"));
    let pumps = hub.pump_count();

    router.remove("first");
    router
        .add(Arc::new(Login::new(
            "again",
            spec,
            200,
            now().add_nanos(60 * NANOS_PER_SEC),
        )))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after: Vec<TradesUpdate> = Desk::events(&mut trades);
    let last = after
        .last()
        .expect("prints from the connection added again");
    assert_eq!(last.source.provider, "again");
    assert_eq!(last.trades[0].1, 200.0);
    assert!(after[0].seq > before.last().unwrap().seq);
    let views: Vec<DepthUpdate> = Desk::events(&mut depth);
    let fresh = views
        .iter()
        .find(|u| u.source.provider == "again")
        .expect("a view of the new connection's book");
    assert_eq!(fresh.kind, DepthKind::Snapshot, "a new book starts over");
    assert_eq!(fresh.bids[0].0, 200.0);
    let fps: Vec<FootprintUpdate> = Desk::events(&mut footprints);
    assert_eq!(fps.last().unwrap().source.provider, "again");
    assert_eq!(hub.pump_count(), pumps);
    let h = hub.history(&es, None, None, Some(5)).await.unwrap();
    assert!(h.trades.iter().all(|t| t.price == Price::from(200)));
    tokio::time::sleep(Duration::from_secs(1)).await;
    let span = hub.depth_history(&es, 0, i64::MAX).await;
    assert!(span.recording);
    let gap = span
        .columns
        .iter()
        .position(|c| c.ended)
        .expect("an end column where the first book stopped");
    assert!(gap > 0, "{}", span.columns.len());
}

#[tokio::test(start_paused = true)]
async fn a_removed_login_stops_the_recordings_at_once() {
    let d = desk(71);
    let es = id("ESZ6.CME");
    let spec = d.market.spec(&es).await.unwrap();
    let router = MarketRouter::new();
    router
        .add(Arc::new(Login::new("first", spec.clone(), 100, now())))
        .unwrap();
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut depth, _) = d.bus.subscribe(names::MARKET_DEPTH).unwrap();
    let _tape = hub.acquire(PumpKey::Trades(es.clone())).unwrap();
    let _view = hub.acquire(PumpKey::Depth(es.clone(), 5)).unwrap();
    let _fp = hub
        .acquire(PumpKey::Footprint(es.clone(), Timeframe::M1, 1))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    let first = hub.history(&es, None, None, None).await.unwrap().trades[0].ts;
    assert_eq!(
        known_from(&hub, &es).await,
        Some(first),
        "no trade history: whole from the first print"
    );
    assert!(hub.book_now(&es, Duration::ZERO).await.is_some());
    let _: Vec<DepthUpdate> = Desk::events(&mut depth);

    let mut down = Login::new("down", spec.clone(), 0, now());
    down.down = true;
    router.add(Arc::new(down)).unwrap();
    router.remove("first");
    tokio::time::sleep(Duration::from_secs(5)).await;
    let h = hub.history(&es, None, None, None).await.unwrap();
    assert!(!h.trades.is_empty(), "what was recorded stays readable");
    let last = h.trades.last().unwrap().ts;
    assert_eq!(
        known_from(&hub, &es).await,
        Some(last.add_nanos(1)),
        "nothing is known whole once the recording stops"
    );
    let span = hub.depth_history(&es, 0, i64::MAX).await;
    assert!(!span.recording);
    let end = span.columns.last().unwrap();
    assert!(end.ended && end.cells.is_empty());
    let removed = now().add_nanos(1_200_000_000);
    assert!(
        end.t >= removed.0 - 50_000_000 && end.t <= removed.0 + 50_000_000,
        "end column at {} for a removal at {removed}",
        end.t
    );
    let views: Vec<DepthUpdate> = Desk::events(&mut depth);
    let mut ladder = Ladder::default();
    ladder.bids.insert(cents(100.0), 5.0);
    ladder.asks.insert(cents(101.0), 5.0);
    for v in &views {
        ladder.apply(v);
    }
    assert!(!views.is_empty() && ladder.bids.is_empty() && ladder.asks.is_empty());
    assert!(
        hub.book_now(&es, Duration::from_millis(200))
            .await
            .is_none()
    );

    router.remove("down");
    router
        .add(Arc::new(Login::new(
            "first",
            spec,
            200,
            now().add_nanos(60 * NANOS_PER_SEC),
        )))
        .unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let book = hub
        .book_now(&es, Duration::ZERO)
        .await
        .expect("the new book");
    assert_eq!(book.bids[0].price, Price::from(200));
    assert!(
        known_from(&hub, &es).await.is_some_and(|t| t.0 > end.t),
        "whole from the new segment"
    );
    let span = hub.depth_history(&es, 0, i64::MAX).await;
    assert!(span.recording);
    assert_eq!(span.columns.iter().filter(|c| c.ended).count(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_book_its_connection_drops_is_unknown_until_the_next_image() {
    let d = desk(73);
    let es = id("ESZ6.CME");
    let spec = d.market.spec(&es).await.unwrap();
    let router = MarketRouter::new();
    let mut login = Login::new("first", spec, 100, now());
    login.drop = Some((Duration::from_secs(2), Duration::from_secs(3)));
    router.add(Arc::new(login)).unwrap();
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut depth, _) = d.bus.subscribe(names::MARKET_DEPTH).unwrap();
    let _view = hub.acquire(PumpKey::Depth(es.clone(), 5)).unwrap();
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(hub.book_now(&es, Duration::ZERO).await.is_some());

    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        hub.book_now(&es, Duration::from_millis(100))
            .await
            .is_none()
    );
    let span = hub.depth_history(&es, 0, i64::MAX).await;
    assert!(!span.recording);
    let dropped = now().add_nanos(2 * NANOS_PER_SEC);
    let end = span.columns.last().unwrap();
    assert!(end.ended && end.cells.is_empty());
    assert!(
        end.t >= dropped.0 && end.t <= dropped.0 + 50_000_000,
        "{}",
        end.t
    );
    let views: Vec<DepthUpdate> = Desk::events(&mut depth);
    let last = views.last().unwrap();
    assert!(
        last.kind == DepthKind::Delta && last.bids.iter().chain(&last.asks).all(|l| l.1 == 0.0),
        "the ladder empties"
    );

    tokio::time::sleep(Duration::from_secs(3)).await;
    let book = hub
        .book_now(&es, Duration::ZERO)
        .await
        .expect("the new image");
    assert_eq!(book.bids[0].price, Price::from(101));
    let views: Vec<DepthUpdate> = Desk::events(&mut depth);
    assert_eq!(views[0].kind, DepthKind::Snapshot);
    assert_eq!(views[0].bids[0].0, 101.0);
    let to = now().add_nanos(7 * NANOS_PER_SEC).0;
    let span = hub.depth_history(&es, now().0, to).await;
    assert!(span.recording);
    let ordinary_empty = span
        .columns
        .iter()
        .filter(|c| !c.ended && c.cells.is_empty())
        .count();
    assert_eq!(
        ordinary_empty, 0,
        "the drop is not a book with nothing resting"
    );
    let from = span.columns[0].t;
    let (_, covered) =
        tessera_market::hub::depth_history::level_stats(&span.columns, span.end, from, to);
    let back = now().add_nanos(5 * NANOS_PER_SEC).0;
    let recorded = (dropped.0 - from) + (span.end - back);
    assert!(
        (covered - recorded).abs() <= 600_000_000,
        "covered {covered} of a recorded {recorded}"
    );
}

fn image(n: i64, size: i64, ts: i64) -> Vec<OrderBookEvent> {
    let p = |cents: i64| Price(rust_decimal::Decimal::new(cents, 2));
    let mut out = vec![OrderBookEvent::Clear { ts: Timestamp(ts) }];
    for i in 0..n {
        for (side, cents, tag) in [
            (BookSide::Bid, 500_000 - 25 * (i % 400), "b"),
            (BookSide::Ask, 500_025 + 25 * (i % 400), "a"),
        ] {
            out.push(OrderBookEvent::Add {
                ts: Timestamp(ts),
                order: format!("{tag}{i}"),
                side,
                price: p(cents),
                size: Qty::from(size + i % 3),
            });
        }
    }
    out.push(OrderBookEvent::Synced { ts: Timestamp(ts) });
    out
}

#[tokio::test(start_paused = true)]
async fn depth_is_conflated_beats_while_unchanged_and_takes_a_resent_image_whole() {
    let d = desk(77);
    let es = id("ESZ6.CME");
    let spec = d.market.spec(&es).await.unwrap();
    let (tx, events) = mpsc::unbounded_channel();
    let router = MarketRouter::new();
    router
        .add(Arc::new(OrderFeed {
            spec,
            events: parking_lot::Mutex::new(Some(events)),
        }))
        .unwrap();
    let hub = MarketHub::new(router, Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut rx, _) = d.bus.subscribe(names::MARKET_DEPTH).unwrap();
    let _view = hub.acquire(PumpKey::Depth(es.clone(), 10)).unwrap();
    let emptied = |u: &DepthUpdate| {
        u.kind == DepthKind::Delta
            && !u.bids.is_empty()
            && u.bids.iter().chain(&u.asks).all(|l| l.1 == 0.0)
    };

    for e in image(3_000, 2, 1) {
        tx.send(e).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let first: Vec<DepthUpdate> = Desk::events(&mut rx);
    assert_eq!(first.len(), 1, "{first:?}");
    assert_eq!(first[0].kind, DepthKind::Snapshot);
    assert_eq!(first[0].seq, 1);

    for e in image(3_000, 5, 2) {
        tx.send(e).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let resent: Vec<DepthUpdate> = Desk::events(&mut rx);
    assert_eq!(resent.len(), 1, "one delta: {resent:?}");
    assert_eq!(resent[0].kind, DepthKind::Delta);
    assert!(!emptied(&resent[0]));
    assert!(resent[0].bids.iter().all(|l| l.1 > 0.0));
    let span = hub.depth_history(&es, 0, i64::MAX).await;
    assert!(span.recording, "the recording never stopped");
    assert!(span.columns.iter().all(|c| !c.ended), "no end column");

    let p = |cents: i64| Price(rust_decimal::Decimal::new(cents, 2));
    for ms in 0..1_000i64 {
        for k in 0..5 {
            let i = (ms * 5 + k) % 10;
            tx.send(OrderBookEvent::Modify {
                ts: Timestamp(10 + ms),
                order: format!("b{i}"),
                side: BookSide::Bid,
                price: p(500_000 - 25 * i),
                size: Qty::from(1 + (ms + k) % 7),
            })
            .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    tokio::time::sleep(Duration::from_millis(30)).await;
    let burst: Vec<DepthUpdate> = Desk::events(&mut rx);
    assert!(
        (30..=41).contains(&burst.len()),
        "{} updates for 5,000 order events in a second",
        burst.len()
    );
    assert!(burst.iter().all(|u| u.kind == DepthKind::Delta));
    assert!(burst.windows(2).all(|w| w[1].seq == w[0].seq + 1));
    let seq = burst.last().unwrap().seq;

    tokio::time::sleep(Duration::from_millis(3_100)).await;
    let beats: Vec<DepthUpdate> = Desk::events(&mut rx);
    assert_eq!(beats.len(), 3, "{beats:?}");
    assert!(beats.iter().all(|u| u.kind == DepthKind::Heartbeat
        && u.seq == seq
        && u.bids.is_empty()
        && u.asks.is_empty()));

    tx.send(OrderBookEvent::Clear {
        ts: Timestamp(5_000),
    })
    .unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let gone: Vec<DepthUpdate> = Desk::events(&mut rx);
    assert_eq!(gone.len(), 1, "{gone:?}");
    assert!(emptied(&gone[0]));
    assert!(!hub.depth_history(&es, 0, i64::MAX).await.recording);
}

#[derive(Debug, Default)]
struct MemoryArchive(parking_lot::Mutex<BTreeMap<(String, String, i64), Vec<u8>>>);

impl tessera_market::hub::depth_history::DepthArchive for MemoryArchive {
    fn put(&self, p: &str, i: &InstrumentId, minute: i64, columns: &[u8]) -> Result<(), String> {
        self.0
            .lock()
            .entry((p.into(), i.to_string(), minute))
            .or_default()
            .extend_from_slice(columns);
        Ok(())
    }
    fn get(
        &self,
        p: &str,
        i: &InstrumentId,
        from: i64,
        to: i64,
    ) -> Result<Vec<(i64, Vec<u8>)>, String> {
        Ok(self
            .0
            .lock()
            .iter()
            .filter(|((pp, ii, m), _)| pp == p && *ii == i.to_string() && *m >= from && *m < to)
            .map(|((_, _, m), d)| (*m, d.clone()))
            .collect())
    }
    fn first(&self, p: &str, i: &InstrumentId) -> Result<Option<i64>, String> {
        Ok(self
            .0
            .lock()
            .keys()
            .filter(|(pp, ii, _)| pp == p && *ii == i.to_string())
            .map(|k| k.2)
            .min())
    }
    fn prune(&self, p: &str, i: &InstrumentId, before: i64) -> Result<(), String> {
        self.0
            .lock()
            .retain(|(pp, ii, m), _| !(pp == p && *ii == i.to_string() && *m < before));
        Ok(())
    }
}

#[tokio::test(start_paused = true)]
async fn the_depth_recorder_keeps_one_second_means_and_archives_whole_minutes() {
    use tessera_host::RuntimeModule;
    use tessera_market::MarketModule;
    use tessera_market::io::DepthHistoryOutput;
    use tessera_tools::{ToolCtx, ToolRegistry};

    let d = desk(83);
    let es = id("ESZ6.CME");
    let archive = Arc::new(MemoryArchive::default());
    d.hub.set_depth_archive(Arc::clone(&archive) as _);
    let started = d.clock.now();
    let view = d.hub.acquire(PumpKey::Depth(es.clone(), 10)).unwrap();
    d.run(4 * 150).await;
    let now = d.clock.now();
    let span = d.hub.depth_history(&es, started.0, now.0).await;
    assert!(span.recording);
    assert!(span.columns.len() > 100, "{} columns", span.columns.len());
    assert!(span.columns.windows(2).all(|w| w[0].t < w[1].t));
    assert!(
        span.columns
            .iter()
            .all(|c| c.t % NANOS_PER_SEC == 0 && !c.ended)
    );
    let first = span.columns[0].t;
    assert!(first >= started.0 - NANOS_PER_SEC && first <= started.0 + NANOS_PER_SEC);
    let stats = d.hub.recording_stats();
    assert!(stats.columns > 0 && stats.book_bytes > 0, "{stats:?}");
    let book = d.market.book(&es, 1).unwrap().unwrap();
    let tick = |p: Price| (p.to_f64() / 0.25).round() as i64;
    let last = span.columns.last().unwrap();
    assert!(
        last.cells
            .iter()
            .any(|c| c.bid && (c.tick - tick(book.bids[0].price)).abs() <= 8)
    );
    assert!(last.cells.iter().all(|c| c.mean >= 0.0));

    let router = MarketRouter::new();
    router.add(Arc::new(d.market.clone())).unwrap();
    let module = MarketModule::new(router, Arc::clone(&d.bus));
    let mut r = ToolRegistry::new();
    module.register_tools(&mut r).unwrap();
    let tool = r.get("market.get_depth_history").unwrap();
    let user = ToolCtx::new(tessera_core::origin::Origin::User, d.clock.now());
    tool.call_json(&user, serde_json::json!({"instrument": "ES"}))
        .await
        .unwrap();
    let from = d.clock.now();
    d.run(4 * 20).await;
    let agent = ToolCtx::new(
        tessera_core::origin::Origin::Agent {
            session_id: tessera_core::ids::SessionId::new("S1"),
            provider: "test".into(),
        },
        d.clock.now(),
    );
    let levels: DepthHistoryOutput = serde_json::from_value(
        tool.call_json(&agent, serde_json::json!({"instrument": "ES", "top": 5}))
            .await
            .unwrap()
            .value,
    )
    .unwrap();
    assert_eq!(levels.bids.len(), 5);
    assert_eq!(levels.asks.len(), 5);
    assert!(levels.recorded_from.unwrap() >= from);
    assert!(levels.recorded_ms >= 19_000, "{}", levels.recorded_ms);
    assert!(
        levels
            .bids
            .windows(2)
            .all(|w| w[0].mean_size >= w[1].mean_size)
    );
    assert!(
        levels
            .bids
            .iter()
            .all(|l| l.max_size >= l.mean_size && l.presence <= 1.0)
    );
    assert!(
        levels
            .asks
            .iter()
            .all(|a| levels.bids.iter().all(|b| a.price > b.price))
    );

    drop(view);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let end = d.clock.now().0 + 60 * NANOS_PER_SEC;
    let span = d.hub.depth_history(&es, started.0, end).await;
    assert!(!span.recording);
    assert!(span.columns.last().unwrap().ended);
    let minutes = archive.0.lock().len();
    assert!(minutes >= 3, "{minutes} minutes archived");
    let router = MarketRouter::new();
    router.add(Arc::new(d.market.clone())).unwrap();
    let fresh = MarketHub::new(router, Arc::clone(&d.bus));
    fresh.set_depth_archive(Arc::clone(&archive) as _);
    let again = fresh.depth_history(&es, started.0, end).await;
    assert_eq!(again.recorded_from, Some(first));
    assert_eq!(again.columns, span.columns);
}

#[tokio::test(start_paused = true)]
async fn live_big_trades_are_the_ones_the_tool_finds() {
    use std::collections::BTreeMap;
    use tessera_core::origin::Origin;
    use tessera_market::io::{BigTrade, BigTradeTier, GetBigTradesInput};
    use tessera_market::orderflow::tools::GetBigTrades;
    use tessera_tools::{Tool, ToolCtx};

    let d = desk(47);
    let es = id("ESZ6.CME");
    let (mut rx, _) = d.bus.subscribe(names::MARKET_TRADES).unwrap();
    let feed = d.hub.acquire(PumpKey::Trades(es.clone())).unwrap();
    let start = d.clock.now();
    d.run(4 * 60 * 8).await;
    let batches: Vec<TradesUpdate> = Desk::events(&mut rx);
    let mut streamed: BTreeMap<u64, BigTrade> = BTreeMap::new();
    for b in &batches {
        for t in b.big_trades.iter().flatten() {
            let seq = t.seq.expect("live events are numbered");
            assert!(seq <= b.seq);
            assert!(
                streamed.insert(seq, t.clone()).is_none(),
                "each is streamed once"
            );
        }
    }
    assert!(!streamed.is_empty(), "the mock prints big trades");
    let from = Timestamp(start.0 + 10 * NANOS_PER_SEC);
    let to = Timestamp(d.clock.now().0 - 5 * NANOS_PER_SEC);
    let out = GetBigTrades(Arc::clone(&d.hub))
        .call(
            &ToolCtx::new(Origin::User, d.clock.now()),
            GetBigTradesInput {
                instrument: "ES".into(),
                from: Some(from),
                to: Some(to),
                tiers: None,
                min_size: None,
                max_size: None,
                join_orders: None,
                reach_limit: None,
                limit: Some(5000),
                days_to_load: None,
            },
        )
        .await
        .unwrap();
    let live: Vec<(Timestamp, Qty, Option<BigTradeTier>)> = streamed
        .values()
        .filter(|t| t.t >= from && t.t < to)
        .map(|t| (t.t, t.size, t.tier))
        .collect();
    let found: Vec<(Timestamp, Qty, Option<BigTradeTier>)> =
        out.trades.iter().map(|t| (t.t, t.size, t.tier)).collect();
    assert_eq!(
        live, found,
        "the stream sends what Auto shows, tiered alike"
    );
    assert!(out.rule.cuts.is_some() && live.iter().all(|t| t.2.is_some()));
    eprintln!(
        "mock ES live 8 min: {} events, {} big; tiers {:?}",
        out.orders, out.count, out.tiers
    );
    let snap = d.hub.trades_snapshot(&es).await.unwrap();
    assert_eq!(snap.big_trades.unwrap().len(), streamed.len());
    drop(feed);
}

#[tokio::test(start_paused = true)]
#[ignore = "a measurement, not a check"]
async fn measure_big_trades_on_the_mock_market() {
    use tessera_core::origin::Origin;
    use tessera_market::io::{BigTradeTier, GetBigTradesInput};
    use tessera_market::orderflow::tools::GetBigTrades;
    use tessera_tools::{Tool, ToolCtx};

    let d = desk(53);
    let ids = ["ESZ6.CME", "NQZ6.CME", "NVDA"];
    let mut guards = Vec::new();
    for s in ids {
        guards.push(d.hub.acquire(PumpKey::Trades(id(s))).unwrap());
    }
    let start = d.clock.now();
    d.run(4 * 60 * 30).await;
    let tool = GetBigTrades(Arc::clone(&d.hub));
    let from = Timestamp(start.0 + 10 * NANOS_PER_SEC);
    let to = Timestamp(d.clock.now().0 - 5 * NANOS_PER_SEC);
    let hours = (to.0 - from.0) as f64 / 3.6e12;
    let ask = |s: &str, tiers: Option<Vec<BigTradeTier>>, min: Option<i64>| GetBigTradesInput {
        instrument: s.into(),
        from: Some(from),
        to: Some(to),
        tiers,
        min_size: min.map(Qty::from),
        max_size: None,
        join_orders: None,
        reach_limit: None,
        limit: Some(5000),
        days_to_load: None,
    };
    for s in ids {
        let ctx = ToolCtx::new(Origin::User, d.clock.now());
        let all = tool.call(&ctx, ask(s, None, None)).await.unwrap();
        let mut line = format!(
            "{s}: {} events ({:.0}/h); floor {}, size now {}\n  auto: {} big ({:.0}/h): {:?}\n  cuts: {:?}",
            all.orders,
            all.orders as f64 / hours,
            all.rule.floor,
            all.rule.size_now,
            all.count,
            f64::from(all.count) / hours,
            all.tiers,
            all.rule.cuts,
        );
        for tier in [BigTradeTier::High, BigTradeTier::Medium] {
            let out = tool
                .call(&ctx, ask(s, Some(vec![tier]), None))
                .await
                .unwrap();
            line += &format!(
                "\n  {tier:?} only: {} big ({:.2}% of events, {:.0}/h), size now {}",
                out.count,
                100.0 * f64::from(out.count) / out.orders as f64,
                f64::from(out.count) / hours,
                out.rule.size_now
            );
        }
        let manual = tool.call(&ctx, ask(s, None, Some(0))).await.unwrap();
        line += &format!(
            "\n  manual at the default {}: {} big ({:.0}/h)",
            manual.rule.min_size.unwrap_or_default(),
            manual.count,
            f64::from(manual.count) / hours
        );
        eprintln!("{line}");
    }
    drop(guards);
}

struct SlowQuotes {
    spec: (Instrument, ContractSpec),
    delay: Duration,
}

#[async_trait]
impl MarketDataProvider for SlowQuotes {
    fn id(&self) -> &str {
        "slow-quotes"
    }
    fn display_name(&self) -> &str {
        "Slow quotes"
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            quotes: true,
            ..Watchlist {
                spec: self.spec.clone(),
            }
            .capabilities()
        }
    }
    fn health(&self) -> ProviderHealth {
        Watchlist {
            spec: self.spec.clone(),
        }
        .health()
    }
    async fn search(
        &self,
        _: &str,
        _: Option<AssetClass>,
        _: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        Ok(vec![])
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        InstrumentId::new(input).map_err(|e| MarketError::UnknownInstrument(e.to_string()))
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        let (mut instrument, spec) = self.spec.clone();
        instrument.id = i.clone();
        Ok((instrument, spec))
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        Err(MarketError::Unsupported(format!("{}", req.instrument)))
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        tokio::time::sleep(self.delay).await;
        if i.as_str() == "QUIET" {
            return Err(MarketError::Unavailable(format!("no quote for {i} yet")));
        }
        Ok(Quote {
            instrument: i.clone(),
            ts: Timestamp(1),
            bid: Some(Price::from(100)),
            bid_size: Some(Qty::from(1)),
            ask: Some(Price::from(101)),
            ask_size: Some(Qty::from(1)),
            last: Some(Price::from(100)),
            last_size: Some(Qty::from(1)),
            session: None,
            source: None,
        })
    }
    fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Ok(futures::stream::pending().boxed())
    }
    fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        Err(MarketError::Unsupported("trades".into()))
    }
    fn subscribe_bars(
        &self,
        _: &InstrumentId,
        _: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        Err(MarketError::Unsupported("bars".into()))
    }
}

fn quotes_topic(d: &Desk, router: Arc<MarketRouter>) -> Arc<dyn tessera_host::TopicHandler> {
    use tessera_host::{ModuleContext, ModuleHost, RuntimeModule};
    use tessera_market::MarketModule;
    use tessera_tools::{Extensions, Invoker, InvokerConfig, NullObserver, ToolRegistry};

    let module = MarketModule::new(router, Arc::clone(&d.bus));
    let clock: tessera_core::SharedClock = d.clock.clone();
    let host = ModuleHost {
        ctx: ModuleContext {
            bus: Arc::clone(&d.bus),
            clock: clock.clone(),
            services: Extensions::new(),
        },
        invoker: Arc::new(Invoker::new(
            Arc::new(ToolRegistry::new()),
            Arc::new(NullObserver),
            clock,
            InvokerConfig::default(),
        )),
    };
    module
        .topics(&host)
        .into_iter()
        .find(|t| t.name() == names::MARKET_QUOTES)
        .unwrap()
}

#[tokio::test]
async fn quotes_asked_before_a_market_connection_is_added_are_refused_as_unavailable_then_served() {
    use tessera_protocol::rpc::codes;

    let d = desk(89);
    let router = MarketRouter::new();
    let quotes = quotes_topic(&d, Arc::clone(&router));
    let asked = serde_json::json!({ "instruments": ["ESZ6.CME"] });

    let Err(refused) = quotes.subscribe(asked.clone()).await else {
        panic!("quotes were served with no market connection");
    };
    assert_eq!(refused.code, codes::UNAVAILABLE, "{}", refused.message);
    assert!(
        refused
            .message
            .contains("no market-data connection is configured")
    );

    router.add(Arc::new(d.market.clone())).unwrap();
    let sub = quotes.subscribe(asked).await.unwrap();
    let quote: Quote = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    assert!(quote.instrument.as_str().starts_with("ESZ6"));
    assert!(quote.bid.is_some() && quote.ask.is_some(), "{quote:?}");
}

#[tokio::test(start_paused = true)]
async fn quotes_followed_while_the_connection_logs_in_show_its_quote_once_it_is_in() {
    let d = desk(89);
    let es = id("ESZ6.CME");
    d.market.set_logging_in(true);
    let (mut rx, _) = d.bus.subscribe(names::MARKET_QUOTES).unwrap();
    let _quotes = d.hub.acquire(PumpKey::Quotes(es.clone())).unwrap();
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(rx.try_recv().is_err(), "no quote while it logs in");

    d.market.set_logging_in(false);
    let q: Quote = settle(
        "a quote once the connection is in",
        || {
            rx.try_recv()
                .ok()
                .map(|ev| serde_json::from_str::<Quote>(ev.data.get()).unwrap())
        },
        Option::is_some,
    )
    .await
    .expect("a quote once the connection is in");
    assert_eq!(q.instrument, es);
    assert!(q.bid.is_some() && q.ask.is_some(), "{q:?}");
}

#[tokio::test]
async fn quotes_of_an_instrument_no_connection_lists_stay_refused_as_invalid() {
    use tessera_protocol::rpc::codes;

    let d = desk(89);
    let router = MarketRouter::new();
    router.add(Arc::new(d.market.clone())).unwrap();
    let quotes = quotes_topic(&d, router);
    let Err(refused) = quotes
        .subscribe(serde_json::json!({ "instruments": ["NOSUCH"] }))
        .await
    else {
        panic!("an unknown instrument was quoted");
    };
    assert_eq!(refused.code, codes::INVALID_PARAMS, "{}", refused.message);
}

#[tokio::test(start_paused = true)]
async fn quotes_are_followed_at_once_when_the_connection_is_slow_to_quote() {
    use tessera_market::module::QUOTE_SNAPSHOT_WAIT;

    let d = desk(89);
    let spec = d.market.spec(&id("ESZ6.CME")).await.unwrap();
    let router = MarketRouter::new();
    router
        .add(Arc::new(SlowQuotes {
            spec,
            delay: Duration::from_secs(20),
        }))
        .unwrap();
    let quotes = quotes_topic(&d, router);

    let asked = tokio::time::Instant::now();
    let sub = quotes
        .subscribe(serde_json::json!({ "instruments": ["ESZ6", "NQZ6"] }))
        .await
        .unwrap();
    let took = asked.elapsed();
    assert!(
        took <= QUOTE_SNAPSHOT_WAIT + Duration::from_millis(100),
        "the subscription waited {took:?} for quotes the stream will bring"
    );
    assert!(sub.snapshot.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_quotes_snapshot_waits_for_the_slowest_instrument_not_all_of_them_in_turn() {
    let d = desk(89);
    let spec = d.market.spec(&id("ESZ6.CME")).await.unwrap();
    let delay = Duration::from_secs(1);
    let router = MarketRouter::new();
    router.add(Arc::new(SlowQuotes { spec, delay })).unwrap();
    let quotes = quotes_topic(&d, router);
    let listed = [
        "ESZ6", "NQZ6", "YMZ6", "RTYZ6", "CLZ6", "QUIET", "MCLZ6", "NGZ6", "GCZ6", "SIZ6", "HGZ6",
        "ZBZ6", "6EZ6",
    ];

    let asked = tokio::time::Instant::now();
    let sub = quotes
        .subscribe(serde_json::json!({ "instruments": listed }))
        .await
        .unwrap();
    let took = asked.elapsed();

    let snapshot: Vec<String> = sub
        .snapshot
        .iter()
        .map(|raw| {
            serde_json::from_str::<Quote>(raw.get())
                .unwrap()
                .instrument
                .to_string()
        })
        .collect();
    let quoted: Vec<&str> = listed.into_iter().filter(|s| *s != "QUIET").collect();
    assert_eq!(
        snapshot, quoted,
        "listed order, without the one with no quote"
    );
    assert!(
        took < 2 * delay,
        "{} quotes of {delay:?} each arrived after {took:?}",
        listed.len()
    );
}

#[tokio::test]
async fn keeping_a_days_big_trade_model_leaves_the_instruments_other_days_served() {
    let hub = desk(1).hub;
    let nq = id("NQZ6.CME");
    let first = chrono::NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
    let day = |n: u64| first + chrono::Days::new(n);
    let keep = |n: u64| {
        let contract = Contract {
            tick: Price::from_f64(0.25).unwrap(),
            lot: 1.0,
            floor: Qty::from(8),
            multiplier: 20.0,
            min_notional: MIN_NOTIONAL,
        };
        let model = ModelBuilder::new(SessionCalendar::CmeEquityIndex, contract)
            .build(day(n), ModelCoverage::default());
        hub.keep_big_trade_model(
            "mock",
            &nq,
            day(n),
            Grouping::default(),
            Arc::new(model),
            None,
        );
    };
    let served = |days: std::ops::RangeInclusive<u64>| -> Vec<u64> {
        days.filter(|n| {
            hub.big_trade_model("mock", &nq, day(*n), Grouping::default())
                .is_some_and(|m| m.date == day(*n))
        })
        .collect()
    };

    for n in (61..=70).rev() {
        keep(n);
    }
    keep(70);
    assert_eq!(
        served(61..=70),
        (61..=70).collect::<Vec<_>>(),
        "today's model kept again leaves yesterday's and the rest of the ten-day walk served"
    );

    for n in 7..=60 {
        keep(n);
    }
    keep(71);
    assert_eq!(
        served(7..=71),
        (8..=71).collect::<Vec<_>>(),
        "past the cap of 64 the oldest day goes, and only it"
    );
}

#[derive(Clone)]
struct Drops {
    market: MockMarket,
    clock: Arc<ManualClock>,
    up: Arc<tokio::sync::watch::Sender<bool>>,
    quiet: Arc<tokio::sync::watch::Sender<bool>>,
    opened: Arc<std::sync::atomic::AtomicUsize>,
}

impl Drops {
    fn new(market: MockMarket, clock: Arc<ManualClock>) -> Self {
        Self {
            market,
            clock,
            up: Arc::new(tokio::sync::watch::channel(true).0),
            quiet: Arc::new(tokio::sync::watch::channel(false).0),
            opened: Arc::default(),
        }
    }

    fn streams_opened(&self) -> usize {
        self.opened.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn set_up(&self, up: bool) {
        self.market.set_outage(!up);
        self.up.send_replace(up);
    }

    fn silence(&self, silent: bool) {
        self.quiet.send_replace(silent);
    }

    fn live<T: Send + 'static>(
        &self,
        stream: MarketStream<T>,
        since: Timestamp,
        at: impl Fn(&T) -> Timestamp + Send + 'static,
    ) -> Result<MarketStream<T>, MarketError> {
        if !*self.up.borrow() {
            return Err(MarketError::Unavailable("the feed is down".into()));
        }
        self.opened
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut up = self.up.subscribe();
        let quiet = self.quiet.subscribe();
        let dropped = async move {
            let _ = up.wait_for(|up| !up).await;
        };
        Ok(stream
            .take_until(dropped)
            .filter_map(move |x| {
                let out = (!*quiet.borrow() && at(&x) >= since).then_some(x);
                futures::future::ready(out)
            })
            .boxed())
    }
}

fn minute_of(t: Timestamp) -> Timestamp {
    Timestamp(t.0 - t.0.rem_euclid(tessera_core::time::NANOS_PER_MINUTE))
}

#[async_trait]
impl MarketDataProvider for Drops {
    fn id(&self) -> &str {
        "drops"
    }
    fn display_name(&self) -> &str {
        "Drops"
    }
    fn capabilities(&self) -> MarketCapabilities {
        self.market.capabilities()
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.id().to_owned(),
            ..self.market.health()
        }
    }
    async fn search(
        &self,
        q: &str,
        class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.market.search(q, class, limit).await
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.market.resolve(input).await
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.market.spec(i).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.market.get_bars(req).await
    }
    async fn get_trades(
        &self,
        req: tessera_market::TradesRequest,
    ) -> Result<Vec<Trade>, MarketError> {
        self.market.get_trades(req).await
    }
    fn keeps_trade_history(&self) -> bool {
        true
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        self.market.quote(i).await
    }
    fn subscribe_quotes(&self, ids: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.live(self.market.subscribe_quotes(ids)?, self.clock.now(), |q| {
            q.ts
        })
    }
    fn subscribe_trades(&self, ids: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.live(self.market.subscribe_trades(ids)?, self.clock.now(), |t| {
            t.ts
        })
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.live(
            self.market.subscribe_bars(i, tf)?,
            minute_of(self.clock.now()),
            |b| b.bar.t,
        )
    }
}

#[tokio::test(start_paused = true)]
async fn the_daily_break_is_a_closed_market_not_a_lost_connection() {
    let d = desk_at(73, Timestamp::parse("2026-11-05T16:58:00-05:00").unwrap());
    let nq = id("NQZ6.CME");
    let drops = Drops::new(d.market.clone(), Arc::clone(&d.clock));
    let router = MarketRouter::new();
    router.add(Arc::new(drops.clone())).unwrap();
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut trades, _) = d.bus.subscribe(names::MARKET_TRADES).unwrap();
    let _quotes = hub.acquire(PumpKey::Quotes(nq.clone())).unwrap();
    let _bars = hub
        .acquire(PumpKey::Bars(nq.clone(), Timeframe::M1))
        .unwrap();
    let _tape = hub.acquire(PumpKey::Trades(nq.clone())).unwrap();
    let run = async |seconds: usize| {
        for _ in 0..seconds {
            d.clock.advance(NANOS_PER_SEC);
            d.market.advance(d.clock.now());
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    let said = |h: ProviderHealth| (h.status, h.message);
    let fine = || said(drops.health());

    run(125).await;
    let opened = drops.streams_opened();
    let _: Vec<TradesUpdate> = Desk::events(&mut trades);

    run(5 * 60).await;
    assert_eq!(
        said(hub.health(&drops)),
        fine(),
        "17:05 ET: the break is no reason to call the connection lost"
    );
    run(54 * 60).await;
    assert_eq!(
        drops.streams_opened(),
        opened,
        "no stream is dropped and opened again over the break"
    );
    let during: Vec<TradesUpdate> = Desk::events(&mut trades);
    assert!(
        during.iter().all(|u| u.trades.is_empty()),
        "nothing is replayed into the break"
    );

    drops.silence(true);
    run(80).await;
    assert_eq!(
        said(hub.health(&drops)),
        fine(),
        "18:00:15 ET: fifteen quiet seconds after the reopen are not an hour without data"
    );
    drops.silence(false);
    run(120).await;
    let reopened: Vec<TradesUpdate> = Desk::events(&mut trades);
    assert!(
        reopened.iter().any(|u| !u.trades.is_empty()),
        "prints flow again once Globex reopens at 18:00"
    );
    assert_eq!(said(hub.health(&drops)), fine());

    drops.silence(true);
    run(40).await;
    assert_eq!(
        hub.health(&drops).status,
        HealthStatus::Degraded,
        "with the market open, silence is still a lost connection"
    );
}

#[tokio::test(start_paused = true)]
async fn a_socket_that_goes_silent_without_closing_is_lost_at_once_and_its_hole_fills_once_data_flows()
 {
    let d = desk(73);
    let nq = id("NQZ6.CME");
    let drops = Drops::new(d.market.clone(), Arc::clone(&d.clock));
    let router = MarketRouter::new();
    router.add(Arc::new(drops.clone())).unwrap();
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut bars, _) = d.bus.subscribe(names::MARKET_BARS).unwrap();
    let _bars = hub
        .acquire(PumpKey::Bars(nq.clone(), Timeframe::M1))
        .unwrap();
    let _tape = hub.acquire(PumpKey::Trades(nq.clone())).unwrap();
    let run = async |seconds: usize| {
        for _ in 0..seconds {
            d.clock.advance(NANOS_PER_SEC);
            d.market.advance(d.clock.now());
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };

    run(150).await;
    assert_eq!(
        hub.health(&drops).status,
        HealthStatus::Ok,
        "live while the feed ticks"
    );

    let dropped_at = minute_of(d.clock.now());
    drops.silence(true);
    for _ in 0..6 * 60 {
        d.clock.advance(NANOS_PER_SEC);
        d.market.advance(d.clock.now());
    }
    tokio::time::sleep(Duration::from_secs(31)).await;
    let lost = hub.health(&drops);
    assert_eq!(
        lost.status,
        HealthStatus::Degraded,
        "silence is a lost connection"
    );
    assert!(
        lost.message
            .as_deref()
            .unwrap_or_default()
            .contains("No data"),
        "{:?}",
        lost.message
    );

    drops.silence(false);
    d.clock.advance(NANOS_PER_SEC);
    d.market.advance(d.clock.now());
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        hub.health(&drops).status,
        HealthStatus::Ok,
        "data flowing again clears the lost connection"
    );
    hub.begin_fill("drops");
    let lining = hub.health(&drops);
    assert_eq!(
        lining.status,
        HealthStatus::Degraded,
        "the connection stays lost while the hole is filled"
    );
    assert!(
        lining
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("Filling"),
        "{:?}",
        lining.message
    );
    hub.end_fill("drops");
    assert_eq!(
        hub.health(&drops).status,
        HealthStatus::Ok,
        "restored once the hole is filled"
    );

    run(150).await;
    let back_at = minute_of(d.clock.now());
    let sent: Vec<tessera_market::io::BarUpdate> = Desk::events(&mut bars);
    let times: Vec<i64> = sent.iter().map(|u| u.bar.0).collect();
    assert!(
        times.windows(2).all(|w| w[0] <= w[1]),
        "every bar after the wake comes after the bars before it: {times:?}"
    );
    let minutes: std::collections::BTreeSet<i64> = times.iter().copied().collect();
    let minute = tessera_core::time::NANOS_PER_MINUTE;
    let first = *minutes.first().unwrap();
    let last = *minutes.last().unwrap();
    let missing: Vec<i64> = (0..=(last - first) / minute)
        .map(|k| first + k * minute)
        .filter(|t| !minutes.contains(t))
        .collect();
    assert!(first < dropped_at.0 && last >= back_at.0, "{first} {last}");
    assert!(missing.is_empty(), "no minute is missing: {missing:?}");
}

#[tokio::test(start_paused = true)]
async fn a_feed_that_drops_and_comes_back_fills_its_hole_in_bars_footprints_and_prints() {
    let d = desk(73);
    let nq = id("NQZ6.CME");
    let drops = Drops::new(d.market.clone(), Arc::clone(&d.clock));
    let router = MarketRouter::new();
    router.add(Arc::new(drops.clone())).unwrap();
    let hub = MarketHub::new(Arc::clone(&router), Arc::clone(&d.bus));
    hub.set_linger(Duration::ZERO);
    let (mut bars, _) = d.bus.subscribe(names::MARKET_BARS).unwrap();
    let (mut footprints, _) = d.bus.subscribe(names::MARKET_FOOTPRINT).unwrap();
    let _bars = hub
        .acquire(PumpKey::Bars(nq.clone(), Timeframe::M1))
        .unwrap();
    let _tape = hub.acquire(PumpKey::Trades(nq.clone())).unwrap();
    let _fp = hub
        .acquire(PumpKey::Footprint(nq.clone(), Timeframe::M1, 1))
        .unwrap();
    let run = async |seconds: usize| {
        for _ in 0..seconds {
            d.clock.advance(NANOS_PER_SEC);
            d.market.advance(d.clock.now());
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };

    run(150).await;
    let dropped_at = minute_of(d.clock.now());
    drops.set_up(false);
    tokio::time::sleep(Duration::from_secs(1)).await;
    d.clock.advance(6 * 60 * NANOS_PER_SEC);
    tokio::time::sleep(Duration::from_secs(5)).await;
    drops.set_up(true);
    run(150).await;
    let back_at = minute_of(d.clock.now());

    let sent: Vec<tessera_market::io::BarUpdate> = Desk::events(&mut bars);
    let times: Vec<i64> = sent.iter().map(|u| u.bar.0).collect();
    assert!(
        times.windows(2).all(|w| w[0] <= w[1]),
        "every bar comes after the bars before it, so none is dropped as stale or doubled: {times:?}"
    );
    let minutes: std::collections::BTreeSet<i64> = times.iter().copied().collect();
    let minute = tessera_core::time::NANOS_PER_MINUTE;
    let first = *minutes.first().unwrap();
    let last = *minutes.last().unwrap();
    let missing: Vec<i64> = (0..=(last - first) / minute)
        .map(|k| first + k * minute)
        .filter(|t| !minutes.contains(t))
        .collect();
    assert!(first < dropped_at.0 && last >= back_at.0, "{first} {last}");
    assert!(missing.is_empty(), "no minute is missing: {missing:?}");
    let history = d
        .market
        .get_bars(BarsRequest {
            instrument: nq.clone(),
            tf: Timeframe::M1,
            from: Some(dropped_at),
            to: Some(back_at),
            limit: None,
            rth_only: false,
        })
        .await
        .unwrap();
    for b in history.bars.iter().filter(|b| b.t < back_at) {
        let held = sent.iter().rev().find(|u| u.bar.0 == b.t.0).unwrap();
        assert_eq!(
            held.bar,
            tessera_protocol::compact::CompactBar::from(b),
            "the hole's bars are the history's"
        );
        assert!(held.closed);
    }

    let fps: Vec<FootprintUpdate> = Desk::events(&mut footprints);
    let closed: std::collections::BTreeSet<i64> =
        fps.iter().filter(|u| u.closed).map(|u| u.bar.t.0).collect();
    let hole: Vec<i64> = (dropped_at.0..back_at.0).step_by(minute as usize).collect();
    assert!(
        hole.iter().all(|t| closed.contains(t)),
        "every minute of the hole has its footprint: {hole:?} in {closed:?}"
    );

    let prints = hub
        .history(&nq, Some(dropped_at), Some(back_at), None)
        .await
        .unwrap()
        .trades;
    assert!(
        prints.windows(2).all(|w| w[0].ts <= w[1].ts),
        "prints read once each, in order"
    );
    let printed: std::collections::BTreeSet<i64> =
        prints.iter().map(|t| minute_of(t.ts).0).collect();
    assert!(
        hole.iter().all(|t| printed.contains(t)),
        "big trades read prints through the hole: {hole:?} in {printed:?}"
    );
}
