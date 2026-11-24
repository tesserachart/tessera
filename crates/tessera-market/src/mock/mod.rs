pub mod book;
pub mod generate;
pub mod model;

use std::collections::{HashMap, HashSet, VecDeque};
use std::num::NonZeroU32;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use futures::StreamExt;
use parking_lot::{Mutex, RwLock, RwLockReadGuard};
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::catalog::Catalog;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::{
    AssetClass, ContractMonth, ContractSpec, ExchangeContract, Instrument, prev_quarterly,
};
use tessera_core::market::{
    Aggressor, AggressorSource, Bar, BookSnapshot, DataSource, DepthLevel, Quote, SessionStats,
    Trade,
};
use tessera_core::money::decimal_from_f64;
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_MICRO, NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Price, Qty, SharedClock, Timeframe, Timestamp};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use crate::aggregate::{TradeBarBuilder, aggregate};
use crate::provider::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream, TradesRequest,
    exchange_contract,
};
use crate::rng::{SplitMix, hash3};
use crate::roll::MAX_EARLIER_CONTRACTS;
use book::{Book, BookParams, Fill, RestingLevel, TickInput};
use generate::{
    BarSpan, DriverBar, DriverPath, DriverVol, InstrumentMap, RawBar, ScenarioBar, TapePrint,
    expected_minute_volume, generate_driver, instrument_bar, minute_index, minute_shock,
    minute_tape, price_scale, profile_stream, round_qty,
};
use model::{DRIVERS, DriverId, PROFILES, Profile, VolumeNorm, driver};

pub const DEFAULT_SEED: u64 = 20_261_002;

pub const FROZEN_AT: &str = "2026-10-02T14:42:30-04:00";

pub const BOOK_DEPTH: usize = 40;

const STREAM_BOOK: u64 = 0xB00C;

pub const TRADES_MAX: usize = 50_000;

const LIVE_TAPE_MAX: usize = 100_000;

pub trait Scenario: Send + Sync {
    fn apply(&self, driver: DriverId, bars: &mut [ScenarioBar]);
}

#[derive(Clone)]
pub struct MockConfig {
    pub seed: u64,
    pub clock: SharedClock,
    pub intraday_sessions: usize,
    pub daily_sessions: usize,
    pub tick_interval: Duration,
    pub live_volume: f64,
    pub keeps_trade_history: bool,
    pub refuses_replays: bool,
    pub scenario: Option<Arc<dyn Scenario>>,
}

impl MockConfig {
    pub fn new(clock: SharedClock) -> Self {
        Self {
            seed: DEFAULT_SEED,
            clock,
            intraday_sessions: 20,
            daily_sessions: 500,
            tick_interval: Duration::from_millis(250),
            live_volume: 1.0,
            keeps_trade_history: true,
            refuses_replays: false,
            scenario: None,
        }
    }
}

impl std::fmt::Debug for MockConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockConfig")
            .field("seed", &self.seed)
            .field("intraday_sessions", &self.intraday_sessions)
            .field("daily_sessions", &self.daily_sessions)
            .field("tick_interval", &self.tick_interval)
            .field("live_volume", &self.live_volume)
            .field("keeps_trade_history", &self.keeps_trade_history)
            .field("refuses_replays", &self.refuses_replays)
            .field("scenario", &self.scenario.is_some())
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarketEvent {
    Quote(Quote),
    Trade(Trade),
    Bar1m {
        instrument: InstrumentId,
        bar: Bar,
        closed: bool,
    },
    Book(Arc<BookSnapshot>),
}

impl MarketEvent {
    pub fn instrument(&self) -> &InstrumentId {
        match self {
            MarketEvent::Quote(q) => &q.instrument,
            MarketEvent::Trade(t) => &t.instrument,
            MarketEvent::Bar1m { instrument, .. } => instrument,
            MarketEvent::Book(b) => &b.instrument,
        }
    }
}

struct Series {
    id: InstrumentId,
    profile: Profile,
    stream: u64,
    calendar: SessionCalendar,
    rth_only: bool,
    tick: Decimal,
    tick_f: f64,
    qty_decimals: u32,
    scale: f64,
    norm: VolumeNorm,
    minutes: Vec<RawBar>,
    daily: Vec<RawBar>,
    book: Option<Book>,
    ticked: bool,
    last_print: i64,
    depth_subs: Arc<AtomicUsize>,
    tape: VecDeque<TapePrint>,
    tape_dropped: i64,
    last_size: Option<f64>,
}

fn price_of(tick: Decimal, ticks: i64) -> Price {
    let mut d = Decimal::from(ticks) * tick;
    d.rescale(tick.scale());
    Price(d)
}

fn qty_of(qty_decimals: u32, v: f64) -> Qty {
    let d = decimal_from_f64(round_qty(v, qty_decimals)).unwrap_or_default();
    Qty(d.round_dp(qty_decimals).normalize())
}

struct Tapes {
    id: InstrumentId,
    stream: u64,
    tick: Decimal,
    qty_decimals: u32,
    trade_size: f64,
    tape_dropped: i64,
    minutes: Vec<RawBar>,
    live: Vec<TapePrint>,
}

impl Tapes {
    fn prints(&self, seed: u64, b: &RawBar) -> Vec<Trade> {
        let trade = |p: &TapePrint| Trade {
            instrument: self.id.clone(),
            ts: Timestamp(p.t),
            price: price_of(self.tick, p.ticks),
            size: qty_of(self.qty_decimals, p.size),
            aggressor: p.aggressor,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: Some(mock_source()),
        };
        if b.live && self.tape_dropped < b.t {
            let a = self.live.partition_point(|p| p.t < b.t);
            let z = self.live.partition_point(|p| p.t < b.t + NANOS_PER_MINUTE);
            self.live[a..z].iter().map(trade).collect()
        } else {
            minute_tape(seed, self.stream, b, self.trade_size, self.qty_decimals)
                .iter()
                .map(trade)
                .collect()
        }
    }
}

impl Series {
    fn map(&self, seed: u64) -> InstrumentMap<'_> {
        InstrumentMap {
            seed,
            profile: &self.profile,
            stream: self.stream,
            calendar: self.calendar,
            norm: &self.norm,
            tick: self.tick_f,
            scale: self.scale,
        }
    }

    fn price(&self, ticks: i64) -> Price {
        price_of(self.tick, ticks)
    }

    fn qty(&self, v: f64) -> Qty {
        qty_of(self.qty_decimals, v)
    }

    fn tapes(series: RwLockReadGuard<'_, Self>, start: usize, end: usize) -> Tapes {
        let minutes = series.minutes[start..end].to_vec();
        let live = match (minutes.iter().find(|b| b.live), minutes.last()) {
            (Some(first), Some(last)) => {
                let a = series.tape.partition_point(|p| p.t < first.t);
                let z = series
                    .tape
                    .partition_point(|p| p.t < last.t + NANOS_PER_MINUTE);
                series.tape.range(a..z).copied().collect()
            }
            _ => Vec::new(),
        };
        Tapes {
            id: series.id.clone(),
            stream: series.stream,
            tick: series.tick,
            qty_decimals: series.qty_decimals,
            trade_size: series.profile.trade_size,
            tape_dropped: series.tape_dropped,
            minutes,
            live,
        }
    }

    fn bar(&self, r: &RawBar) -> Bar {
        Bar {
            t: Timestamp(r.t),
            o: self.price(r.o),
            h: self.price(r.h),
            l: self.price(r.l),
            c: self.price(r.c),
            v: self.qty(r.v),
            bv: (!self.profile.index).then(|| self.qty(r.bv)),
        }
    }

    fn daily_until(&self, last_trade: Timestamp) -> Vec<Bar> {
        let end = self.minutes.partition_point(|b| b.t < last_trade.0);
        let minutes: Vec<Bar> = self.minutes[..end].iter().map(|b| self.bar(b)).collect();
        let mut bars: Vec<Bar> = self.daily.iter().map(|b| self.bar(b)).collect();
        bars.extend(aggregate(&minutes, Timeframe::D1, self.calendar));
        let expiry = self.calendar.trade_date(last_trade);
        bars.retain(|b| self.calendar.trade_date(b.t) <= expiry);
        bars
    }

    fn is_open(&self, t: Timestamp) -> bool {
        if self.rth_only {
            self.calendar.is_rth(t)
        } else {
            self.calendar.is_open(t)
        }
    }

    fn last_ticks(&self) -> Option<i64> {
        self.minutes.last().map(|b| b.c)
    }

    fn session_stats(&self) -> Option<SessionStats> {
        let last = self.minutes.last()?;
        let date = self.calendar.trade_date(Timestamp(last.t));
        let session = self.calendar.session(date)?;
        let start = self.minutes.partition_point(|b| b.t < session.open.0);
        let today = &self.minutes[start..];
        let open = today.first().map(|b| self.price(b.o));
        let high = today.iter().map(|b| b.h).max().map(|t| self.price(t));
        let low = today.iter().map(|b| b.l).min().map(|t| self.price(t));
        let volume = self.qty(today.iter().map(|b| b.v).sum());
        let prev_date = self.calendar.prev_trade_date(date);
        Some(SessionStats {
            trade_date: date,
            open,
            high,
            low,
            prev_close: self.settlement_proxy_close(prev_date),
            volume: Some(volume),
        })
    }

    fn settlement_proxy_close(&self, prev_date: NaiveDate) -> Option<Price> {
        let last_rth_bar = self.calendar.session(prev_date).and_then(|ps| {
            let cutoff = ps.rth.map_or(ps.close, |w| w.end);
            let idx = self.minutes.partition_point(|b| b.t < cutoff.0);
            let bar = self.minutes[..idx].last()?;
            (bar.t >= ps.open.0).then(|| self.price(bar.c))
        });
        last_rth_bar.or_else(|| {
            let d = self
                .daily
                .last()
                .filter(|b| self.calendar.trade_date(Timestamp(b.t)) <= prev_date)?;
            Some(self.price(d.c))
        })
    }

    fn quote(&self, ts: Timestamp) -> Quote {
        let last = self.last_ticks();
        let bid = self.book.as_ref().and_then(Book::best_bid);
        let ask = self.book.as_ref().and_then(Book::best_ask);
        Quote {
            instrument: self.id.clone(),
            ts,
            bid: bid.map(|b| self.price(b.ticks)),
            bid_size: bid.map(|b| self.qty(b.size)),
            ask: ask.map(|a| self.price(a.ticks)),
            ask_size: ask.map(|a| self.qty(a.size)),
            last: last.map(|t| self.price(t)),
            last_size: self.last_size.map(|s| self.qty(s)),
            session: self.session_stats(),
            source: Some(mock_source()),
        }
    }

    fn book_snapshot(&self, ts: Timestamp, levels: usize) -> Option<BookSnapshot> {
        let book = self.book.as_ref()?;
        let side = |l: Vec<RestingLevel>| -> Vec<DepthLevel> {
            l.into_iter()
                .map(|l| DepthLevel {
                    price: self.price(l.ticks),
                    size: self.qty(l.size),
                    orders: Some(l.orders),
                })
                .collect()
        };
        Some(BookSnapshot {
            instrument: self.id.clone(),
            ts,
            bids: side(book.bids(levels)),
            asks: side(book.asks(levels)),
        })
    }
}

const BURST_CHILD_GAP_NS: i64 = 300 * NANOS_PER_MICRO;

fn print_times(fills: &[Fill], from: i64, now: i64) -> Vec<Timestamp> {
    let slots = fills
        .iter()
        .filter(|f| f.burst_child.is_none())
        .map(|f| f.order)
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        .max(1) as i64;
    let span = (now - from).max(0);
    let mut slot = 0i64;
    let mut seen: Option<u32> = None;
    fills
        .iter()
        .map(|f| {
            if f.burst_child.is_none() && seen != Some(f.order) {
                slot += 1;
            }
            seen = Some(f.order);
            Timestamp(
                (from
                    + span * slot / slots
                    + i64::from(f.burst_child.map_or(0, NonZeroU32::get)) * BURST_CHILD_GAP_NS)
                    .min(now),
            )
        })
        .collect()
}

fn book_params(p: &Profile) -> BookParams {
    let step = p.book_step.max(1);
    BookParams {
        step,
        spread: ((p.spread_ticks + step - 1) / step).max(1),
        depth: BOOK_DEPTH,
        size: p.book_size,
        print_size: p.trade_size,
        rounds: p.book_rounds,
        qty_decimals: p.qty_decimals,
    }
}

struct DepthSub(Arc<AtomicUsize>);

impl DepthSub {
    fn new(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::Relaxed);
        Self(Arc::clone(count))
    }
}

impl Drop for DepthSub {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

struct DriverState {
    path: DriverPath,
    vol: DriverVol,
    logp: f64,
    last_covered_minute: i64,
}

struct LiveState {
    last_tick: Timestamp,
    rng: SplitMix,
}

struct Expired {
    instrument: Instrument,
    spec: ContractSpec,
    front: InstrumentId,
    last_trade: Timestamp,
}

fn expired_contracts(
    catalog: &Catalog,
    series: &HashMap<InstrumentId, Arc<RwLock<Series>>>,
) -> HashMap<InstrumentId, Expired> {
    let mut out = HashMap::new();
    for product in catalog.products() {
        let Some(front) = catalog.front_contract(&product.root) else {
            continue;
        };
        let Some(first) = series.get(&front.instrument.id).and_then(|s| {
            let s = s.read();
            s.daily.first().or(s.minutes.first()).map(|b| b.t)
        }) else {
            continue;
        };
        let Some(mut month) = exchange_contract(&front.instrument).and_then(|c| c.expiry) else {
            continue;
        };
        for _ in 0..MAX_EARLIER_CONTRACTS {
            let (year, m) = prev_quarterly(month.year, month.month);
            month = ContractMonth { year, month: m };
            let (mut instrument, spec) = product.contract(year, m, false);
            let Some(last_trade) = spec.last_trade.filter(|t| t.0 > first) else {
                break;
            };
            instrument.tradable = false;
            out.insert(
                instrument.id.clone(),
                Expired {
                    instrument,
                    spec,
                    front: front.instrument.id.clone(),
                    last_trade,
                },
            );
        }
    }
    out
}

struct Inner {
    config: MockConfig,
    catalog: Catalog,
    history_end: Timestamp,
    drivers: RwLock<HashMap<DriverId, DriverState>>,
    series: HashMap<InstrumentId, Arc<RwLock<Series>>>,
    expired: HashMap<InstrumentId, Expired>,
    order: Vec<InstrumentId>,
    events: broadcast::Sender<MarketEvent>,
    live: Mutex<LiveState>,
    last_event: AtomicI64,
    outage: AtomicBool,
    logging_in: AtomicBool,
    prints_served: AtomicUsize,
}

#[derive(Clone)]
pub struct MockMarket {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for MockMarket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockMarket")
            .field("config", &self.inner.config)
            .field("history_end", &self.inner.history_end)
            .field("instruments", &self.inner.order)
            .finish()
    }
}

fn to_scenario(bars: &[DriverBar]) -> Vec<ScenarioBar> {
    bars.iter()
        .map(|b| ScenarioBar {
            t: Timestamp(b.t),
            o: b.log_open.exp(),
            h: b.log_high.exp(),
            l: b.log_low.exp(),
            c: b.log_close.exp(),
        })
        .collect()
}

fn from_scenario(bars: &mut [DriverBar], edited: &[ScenarioBar]) {
    for (b, e) in bars.iter_mut().zip(edited) {
        let (o, c) = (e.o.max(1e-9).ln(), e.c.max(1e-9).ln());
        b.log_high = e.h.max(1e-9).ln().max(o).max(c);
        b.log_low = e.l.max(1e-9).ln().min(o).min(c);
        b.log_open = o;
        b.log_close = c;
    }
}

impl MockMarket {
    pub fn new(config: MockConfig) -> Self {
        let now = config.clock.now();
        let seed = config.seed;
        let reference_date = SessionCalendar::UsEquities.trade_date(now);
        let catalog = Catalog::seed(reference_date);

        let mut paths: HashMap<DriverId, DriverPath> = HashMap::new();
        for spec in DRIVERS {
            let market = spec.beta.and_then(|(m, _)| paths.get(&m));
            let mut path = generate_driver(
                seed,
                &spec,
                now,
                config.intraday_sessions,
                config.daily_sessions,
                market,
            );
            if let Some(sc) = &config.scenario {
                let mut sb = to_scenario(&path.minutes);
                sc.apply(spec.id, &mut sb);
                from_scenario(&mut path.minutes, &sb);
            }
            paths.insert(spec.id, path);
        }

        let mut series = HashMap::new();
        let mut order = Vec::new();
        for profile in PROFILES {
            let Some(id) = resolve_profile(&catalog, profile.key) else {
                continue;
            };
            let Some(spec) = catalog.spec(&id) else {
                continue;
            };
            let path = &paths[&profile.driver];
            let calendar = spec.sessions;
            let rth_only = profile.rth_only || driver(profile.driver).rth_only;
            let norm = VolumeNorm::measure(calendar, rth_only);
            let tick = spec.tick_size.0;
            let tick_f = tick.to_f64().unwrap_or(0.01);
            let stream = profile_stream(profile.key);
            let in_scope = |i: usize, b: &DriverBar| {
                !rth_only
                    || path.session_at(i).map_or_else(
                        || calendar.is_rth(Timestamp(b.t)),
                        |s| s.is_rth_at(Timestamp(b.t)),
                    )
            };
            let anchor_log = path
                .minutes
                .iter()
                .enumerate()
                .rev()
                .find(|(i, b)| in_scope(*i, b))
                .map_or(0.0, |(_, b)| b.log_close);
            let scale = price_scale(&profile, anchor_log);
            let map = InstrumentMap {
                seed,
                profile: &profile,
                stream,
                calendar,
                norm: &norm,
                tick: tick_f,
                scale,
            };
            let minutes: Vec<RawBar> = path
                .minutes
                .iter()
                .enumerate()
                .filter(|(i, b)| in_scope(*i, b))
                .map(|(i, b)| instrument_bar(&map, path.session_at(i), b, BarSpan::Minute))
                .collect();
            let daily: Vec<RawBar> = path
                .daily
                .iter()
                .map(|b| instrument_bar(&map, None, b, BarSpan::Session))
                .collect();
            let book = (!profile.index).then(|| {
                let mut b = Book::new(
                    book_params(&profile),
                    hash3(seed, stream, STREAM_BOOK as i64),
                );
                if let Some(last) = minutes.last() {
                    b.reset(last.c, now.0);
                }
                b
            });
            order.push(id.clone());
            series.insert(
                id.clone(),
                Arc::new(RwLock::new(Series {
                    id,
                    profile,
                    stream,
                    calendar,
                    rth_only,
                    tick,
                    tick_f,
                    qty_decimals: profile.qty_decimals,
                    scale,
                    norm,
                    minutes,
                    daily,
                    book,
                    ticked: false,
                    last_print: now.0,
                    depth_subs: Arc::new(AtomicUsize::new(0)),
                    tape: VecDeque::new(),
                    tape_dropped: i64::MIN,
                    last_size: None,
                })),
            );
        }

        let drivers = paths
            .into_iter()
            .map(|(id, path)| {
                let vol = DriverVol::of(driver(id));
                let logp = path
                    .minutes
                    .last()
                    .map_or(driver(id).anchor.ln(), |b| b.log_close);
                (
                    id,
                    DriverState {
                        path,
                        vol,
                        logp,
                        last_covered_minute: minute_index(now.0) - 1,
                    },
                )
            })
            .collect();

        let expired = expired_contracts(&catalog, &series);
        let (events, _) = broadcast::channel(16_384);
        Self {
            inner: Arc::new(Inner {
                live: Mutex::new(LiveState {
                    last_tick: now,
                    rng: SplitMix::new(seed ^ 0x11FE_D00D),
                }),
                config,
                catalog,
                history_end: now,
                drivers: RwLock::new(drivers),
                series,
                expired,
                order,
                events,
                last_event: AtomicI64::new(now.0),
                outage: AtomicBool::new(false),
                logging_in: AtomicBool::new(false),
                prints_served: AtomicUsize::new(0),
            }),
        }
    }

    pub fn catalog(&self) -> &Catalog {
        &self.inner.catalog
    }

    pub fn instruments(&self) -> &[InstrumentId] {
        &self.inner.order
    }

    pub fn history_end(&self) -> Timestamp {
        self.inner.history_end
    }

    pub fn prints_served(&self) -> usize {
        self.inner.prints_served.load(Ordering::Relaxed)
    }

    pub fn events(&self) -> broadcast::Receiver<MarketEvent> {
        self.inner.events.subscribe()
    }

    pub fn start(&self) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(me.inner.config.tick_interval);
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                iv.tick().await;
                let now = me.inner.config.clock.now();
                me.advance(now);
            }
        })
    }

    pub fn book(
        &self,
        instrument: &InstrumentId,
        levels: usize,
    ) -> Result<Option<BookSnapshot>, MarketError> {
        let s = self.series(instrument)?.read();
        let ts = Timestamp(self.inner.last_event.load(Ordering::Relaxed));
        Ok(s.book_snapshot(ts, levels.min(BOOK_DEPTH)))
    }

    pub fn minute_tapes(
        &self,
        instrument: &InstrumentId,
        from: Timestamp,
        to: Timestamp,
    ) -> Result<Vec<Vec<Trade>>, MarketError> {
        let s = self.series(instrument)?.read();
        let start = s.minutes.partition_point(|b| b.t < from.0);
        let end = s.minutes.partition_point(|b| b.t < to.0);
        let tapes = Series::tapes(s, start, end);
        let seed = self.inner.config.seed;
        Ok(tapes
            .minutes
            .iter()
            .map(|b| tapes.prints(seed, b))
            .collect())
    }

    pub fn trades(&self, req: &TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let from = req.from.map_or(i64::MIN, |t| t.0);
        let to = req.to.map_or(i64::MAX, |t| t.0);
        let s = self.series(&req.instrument)?.read();
        if s.profile.index {
            return Err(MarketError::Unsupported(format!(
                "{} is an index: it does not trade",
                req.instrument
            )));
        }
        let start = s
            .minutes
            .partition_point(|b| b.t + NANOS_PER_MINUTE <= from);
        let end = s.minutes.partition_point(|b| b.t < to);
        let tapes = Series::tapes(s, start, end);
        let seed = self.inner.config.seed;
        let limit = req.limit.unwrap_or(TRADES_MAX);
        let mut chunks: Vec<Vec<Trade>> = Vec::new();
        let mut n = 0;
        for b in tapes.minutes.iter().rev() {
            let mut prints = tapes.prints(seed, b);
            prints.retain(|t| t.ts.0 >= from && t.ts.0 < to);
            n += prints.len();
            chunks.push(prints);
            if n >= limit {
                break;
            }
        }
        let mut out: Vec<Trade> = chunks.into_iter().rev().flatten().collect();
        if out.len() > limit {
            out.drain(..out.len() - limit);
        }
        self.inner
            .prints_served
            .fetch_add(out.len(), Ordering::Relaxed);
        Ok(out)
    }

    async fn recorded_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        if let (Some(f), Some(t)) = (req.from, req.to)
            && f > t
        {
            return Err(MarketError::InvalidRequest("from is after to".into()));
        }
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.trades(&req))
            .await
            .map_err(|e| MarketError::Unavailable(format!("trade history failed: {e}")))?
    }

    fn series(&self, id: &InstrumentId) -> Result<&Arc<RwLock<Series>>, MarketError> {
        self.inner
            .series
            .get(id)
            .ok_or_else(|| MarketError::UnknownInstrument(id.to_string()))
    }

    fn publish(&self, e: MarketEvent, now: Timestamp) {
        self.inner.last_event.store(now.0, Ordering::Relaxed);
        let _ = self.inner.events.send(e);
    }

    pub fn set_outage(&self, down: bool) {
        self.inner.outage.store(down, Ordering::Relaxed);
    }

    fn in_outage(&self) -> bool {
        self.inner.outage.load(Ordering::Relaxed)
    }

    pub fn set_logging_in(&self, logging_in: bool) {
        self.inner.logging_in.store(logging_in, Ordering::Relaxed);
    }

    fn logging_in(&self) -> bool {
        self.inner.logging_in.load(Ordering::Relaxed)
    }

    fn logged_in(&self) -> Result<(), MarketError> {
        if self.logging_in() {
            return Err(MarketError::Unavailable(LOGGING_IN.into()));
        }
        Ok(())
    }

    pub fn advance(&self, now: Timestamp) {
        if self.in_outage() || self.logging_in() {
            return;
        }
        let mut live = self.inner.live.lock();
        if now <= live.last_tick {
            return;
        }
        let dt = ((now.0 - live.last_tick.0) as f64 / NANOS_PER_SEC as f64).min(5.0);
        let seed = self.inner.config.seed;
        let now_minute = minute_index(now.0);

        let mut tick_shocks: HashMap<DriverId, f64> = HashMap::new();
        let mut tick_returns: HashMap<DriverId, f64> = HashMap::new();
        {
            let mut drivers = self.inner.drivers.write();
            for spec in DRIVERS {
                let Some(st) = drivers.get_mut(&spec.id) else {
                    continue;
                };
                for m in (st.last_covered_minute + 1)..now_minute {
                    let t = Timestamp(m * NANOS_PER_MINUTE);
                    let open = if spec.rth_only {
                        spec.calendar.is_rth(t)
                    } else {
                        spec.calendar.is_open(t)
                    };
                    if open {
                        let sigma = st.vol.minute_sigma(seed, &spec, None, t);
                        let r = sigma * minute_shock(seed, &spec, m);
                        let o = st.logp;
                        st.logp += r;
                        st.path.minutes.push(DriverBar {
                            t: t.0,
                            log_open: o,
                            log_high: o.max(st.logp) + 0.25 * sigma,
                            log_low: o.min(st.logp) - 0.25 * sigma,
                            log_close: st.logp,
                            z: r / sigma.max(1e-12),
                        });
                    }
                }
                st.last_covered_minute = st.last_covered_minute.max(now_minute - 1);
                let open = if spec.rth_only {
                    spec.calendar.is_rth(now)
                } else {
                    spec.calendar.is_open(now)
                };
                if !open {
                    continue;
                }
                let sigma = st.vol.minute_sigma(seed, &spec, None, now);
                let own = live.rng.normal();
                let z = match spec.corr {
                    Some((other, rho)) => {
                        let zo = tick_shocks.get(&other).copied().unwrap_or(0.0);
                        rho * zo + (1.0 - rho * rho).sqrt() * own
                    }
                    None => own,
                };
                tick_shocks.insert(spec.id, z);
                let mut r = sigma * (dt / 60.0).sqrt() * z;
                if let Some((m, beta)) = spec.beta {
                    r += beta * tick_returns.get(&m).copied().unwrap_or(0.0);
                }
                st.logp += r;
                st.last_covered_minute = now_minute;
                tick_returns.insert(spec.id, r);
            }
        }

        let drivers = self.inner.drivers.read();
        for id in &self.inner.order {
            let Some(series) = self.inner.series.get(id) else {
                continue;
            };
            let mut s = series.write();
            let Some(st) = drivers.get(&s.profile.driver) else {
                continue;
            };
            let last_t = s.minutes.last().map_or(i64::MIN, |b| b.t);
            let catch_from = st.path.minutes.partition_point(|b| b.t <= last_t);
            let catch: Vec<DriverBar> = st.path.minutes[catch_from..]
                .iter()
                .filter(|b| b.t < now_minute * NANOS_PER_MINUTE)
                .filter(|b| !s.rth_only || s.calendar.is_rth(Timestamp(b.t)))
                .copied()
                .collect();
            for b in &catch {
                let raw = instrument_bar(&s.map(seed), None, b, BarSpan::Minute);
                let bar = s.bar(&raw);
                s.minutes.push(raw);
                self.publish(
                    MarketEvent::Bar1m {
                        instrument: id.clone(),
                        bar,
                        closed: true,
                    },
                    now,
                );
            }
            if !s.is_open(now) {
                continue;
            }
            if !catch.is_empty()
                && let (Some(last), Some(book)) = (s.last_ticks(), s.book.as_mut())
            {
                book.reset(last, now.0);
            }
            let driver_return = tick_returns.get(&s.profile.driver).copied().unwrap_or(0.0);
            self.tick_instrument(&mut s, st, now, dt, driver_return);
        }
        live.last_tick = now;
    }

    fn tick_instrument(
        &self,
        s: &mut Series,
        st: &DriverState,
        now: Timestamp,
        dt: f64,
        driver_return: f64,
    ) {
        let minute_t = minute_index(now.0) * NANOS_PER_MINUTE;
        let mid = ((st.logp.exp() * s.scale) / s.tick_f).round() as i64;

        let needs_new = s.minutes.last().is_none_or(|b| b.t < minute_t);
        if needs_new {
            if let Some(prev) = s.minutes.last().copied()
                && prev.t + NANOS_PER_MINUTE == minute_t
            {
                let bar = s.bar(&prev);
                self.publish(
                    MarketEvent::Bar1m {
                        instrument: s.id.clone(),
                        bar,
                        closed: true,
                    },
                    now,
                );
            }
            let open = s.last_ticks().unwrap_or(mid);
            s.minutes.push(RawBar::open_at(minute_t, open));
        }

        let mut prints: Vec<Trade> = Vec::new();
        if s.profile.index {
            if let Some(bar) = s.minutes.last_mut() {
                bar.c = mid;
                bar.h = bar.h.max(mid);
                bar.l = bar.l.min(mid);
            }
        } else if let Some(mut book) = s.book.take() {
            let sigma_tick = st.vol.sigma_base.max(1e-9) * (dt / 60.0).sqrt();
            let z = (driver_return / sigma_tick).clamp(-4.0, 4.0);
            let expected = expected_minute_volume(&s.profile, s.calendar, None, &s.norm, now)
                * self.inner.config.live_volume
                * dt
                / 60.0;
            let fills = book.tick(TickInput {
                now: now.0,
                dt,
                target_ticks: mid,
                budget: expected * (0.7 + 0.45 * z.abs()),
                p_buy: 0.5 + 0.35 * z.tanh(),
            });
            let from = s.last_print.max(now.0 - (dt * 1e9) as i64).max(minute_t);
            for (f, ts) in fills.iter().zip(print_times(&fills, from, now.0)) {
                if let Some(bar) = s.minutes.last_mut() {
                    bar.c = f.ticks;
                    bar.h = bar.h.max(f.ticks);
                    bar.l = bar.l.min(f.ticks);
                    bar.v = round_qty(bar.v + f.size, s.qty_decimals);
                    if f.aggressor == Aggressor::Buy {
                        bar.bv = round_qty(bar.bv + f.size, s.qty_decimals);
                    }
                }
                s.last_size = Some(f.size);
                if s.tape.len() >= LIVE_TAPE_MAX
                    && let Some(gone) = s.tape.pop_front()
                {
                    s.tape_dropped = gone.t;
                }
                s.tape.push_back(TapePrint {
                    t: ts.0,
                    ticks: f.ticks,
                    size: f.size,
                    aggressor: f.aggressor,
                });
                prints.push(Trade {
                    instrument: s.id.clone(),
                    ts,
                    price: s.price(f.ticks),
                    size: s.qty(f.size),
                    aggressor: f.aggressor,
                    aggressor_source: AggressorSource::Exchange,
                    order_key: None,
                    source: Some(mock_source()),
                });
            }
            if !fills.is_empty() {
                s.last_print = now.0;
            }
            s.book = Some(book);
        }
        s.ticked = true;
        for t in prints {
            self.publish(MarketEvent::Trade(t), now);
        }
        self.publish(MarketEvent::Quote(s.quote(now)), now);
        if s.depth_subs.load(Ordering::Relaxed) > 0
            && let Some(book) = s.book_snapshot(now, BOOK_DEPTH)
        {
            self.publish(MarketEvent::Book(Arc::new(book)), now);
        }
        if let Some(raw) = s.minutes.last().copied() {
            let bar = s.bar(&raw);
            self.publish(
                MarketEvent::Bar1m {
                    instrument: s.id.clone(),
                    bar,
                    closed: false,
                },
                now,
            );
        }
    }

    fn start_index(series: &Series, req: &BarsRequest) -> usize {
        let raw = &series.minutes;
        if req.tf.is_session() || raw.is_empty() {
            return 0;
        }
        let mut start = req
            .from
            .map_or(0, |from| raw.partition_point(|b| b.t < from.0));
        if let (None, None, Some(limit)) = (req.from, req.to, req.limit) {
            let factor = if req.rth_only { 8 } else { 2 };
            let bars_nanos = (limit as u64 + 1) * req.tf.nanos() as u64;
            let need = bars_nanos.div_ceil(NANOS_PER_MINUTE as u64) as usize * factor;
            start = start.max(raw.len().saturating_sub(need));
        }
        let bucket = |i: usize| series.calendar.bucket_start(Timestamp(raw[i].t), req.tf);
        while start > 0 && start < raw.len() && bucket(start) == bucket(start - 1) {
            start -= 1;
        }
        start
    }

    fn expired_bars(&self, e: &Expired, req: &BarsRequest) -> Result<BarSeries, MarketError> {
        if !req.tf.is_session() {
            return Err(MarketError::Unsupported(format!(
                "the mock keeps only daily bars of the expired {}",
                req.instrument
            )));
        }
        let front = self.series(&e.front)?.read();
        let mut bars = aggregate(&front.daily_until(e.last_trade), req.tf, front.calendar);
        drop(front);
        bars.retain(|b| req.from.is_none_or(|f| b.t >= f) && req.to.is_none_or(|t| b.t <= t));
        if let Some(limit) = req.limit
            && bars.len() > limit
        {
            bars.drain(..bars.len() - limit);
        }
        Ok(BarSeries {
            instrument: req.instrument.clone(),
            tf: req.tf,
            bars,
            last_bar_open: false,
        })
    }

    fn bars(&self, req: &BarsRequest) -> Result<BarSeries, MarketError> {
        if req.tf.base().is_none() {
            return self.print_built_bars(req);
        }
        let series = self.series(&req.instrument)?.read();
        let start = Self::start_index(&series, req);
        let result = Self::bars_from(&series, req, start)?;
        if start > 0 && req.limit.is_some_and(|l| result.len() < l) {
            return self.finish(&series, req, Self::bars_from(&series, req, 0)?);
        }
        self.finish(&series, req, result)
    }

    fn bars_from(
        series: &Series,
        req: &BarsRequest,
        start: usize,
    ) -> Result<Vec<Bar>, MarketError> {
        let minutes: Vec<Bar> = series.minutes[start..]
            .iter()
            .filter(|b| !req.rth_only || series.calendar.is_rth(Timestamp(b.t)))
            .map(|b| series.bar(b))
            .collect();
        let mut bars = match req.tf.base() {
            None => {
                return Err(MarketError::Unsupported(
                    "seconds bars are built from prints".into(),
                ));
            }
            Some(Timeframe::M1) if req.tf == Timeframe::M1 => minutes,
            Some(Timeframe::D1) => {
                let mut d: Vec<Bar> = series.daily.iter().map(|b| series.bar(b)).collect();
                d.extend(aggregate(&minutes, Timeframe::D1, series.calendar));
                if req.tf == Timeframe::D1 {
                    d
                } else {
                    aggregate(&d, req.tf, series.calendar)
                }
            }
            Some(_) => aggregate(&minutes, req.tf, series.calendar),
        };
        if let Some(from) = req.from {
            bars.retain(|b| b.t >= from);
        }
        if let Some(to) = req.to {
            bars.retain(|b| b.t <= to);
        }
        if let Some(limit) = req.limit
            && bars.len() > limit
        {
            bars.drain(..bars.len() - limit);
        }
        Ok(bars)
    }

    fn print_built_bars(&self, req: &BarsRequest) -> Result<BarSeries, MarketError> {
        let lock = self.series(&req.instrument)?;
        let series = lock.read();
        if series.profile.index {
            return Err(MarketError::Unsupported(format!(
                "{} is an index: it does not trade, so it has no seconds bars",
                req.instrument
            )));
        }
        let calendar = series.calendar;
        let start = Self::start_index(&series, req);
        let end = req.to.map_or(series.minutes.len(), |to| {
            series.minutes.partition_point(|b| b.t <= to.0)
        });
        let tapes = Series::tapes(series, start, end.max(start));
        let seed = self.inner.config.seed;
        let mut builder = TradeBarBuilder::new(req.tf, calendar);
        let mut bars: Vec<Bar> = Vec::new();
        for minute in &tapes.minutes {
            if req.rth_only && !calendar.is_rth(Timestamp(minute.t)) {
                continue;
            }
            for t in tapes.prints(seed, minute) {
                bars.extend(builder.push(t.ts, t.price, t.size, t.aggressor));
            }
        }
        bars.extend(builder.current().copied());
        bars.retain(|b| req.from.is_none_or(|f| b.t >= f) && req.to.is_none_or(|t| b.t <= t));
        if let Some(limit) = req.limit
            && bars.len() > limit
        {
            bars.drain(..bars.len() - limit);
        }
        self.finish(&lock.read(), req, bars)
    }

    fn finish(
        &self,
        series: &Series,
        req: &BarsRequest,
        bars: Vec<Bar>,
    ) -> Result<BarSeries, MarketError> {
        let now = self.inner.config.clock.now();
        let last_bar_open = bars.last().is_some_and(|b| {
            let (_, close) = series.calendar.bucket_span(b.t, req.tf);
            series.is_open(now) && now < close
        });
        Ok(BarSeries {
            instrument: req.instrument.clone(),
            tf: req.tf,
            bars,
            last_bar_open,
        })
    }

    fn broadcast_stream(&self) -> BroadcastStream<MarketEvent> {
        BroadcastStream::new(self.inner.events.subscribe())
    }
}

fn resolve_profile(catalog: &Catalog, key: &str) -> Option<InstrumentId> {
    match key.split_once('@') {
        Some((root, which)) => {
            let front = catalog.front_contract(root)?;
            if which == "0" {
                return Some(front.instrument.id.clone());
            }
            catalog
                .entries()
                .filter(|e| e.instrument.root.as_deref() == Some(root) && !e.instrument.is_front)
                .map(|e| e.instrument.id.clone())
                .next()
        }
        None => catalog.resolve(key),
    }
}

pub const MOCK_PROVIDER_ID: &str = "mock";

const LOGGING_IN: &str = "connecting to the mock market";

fn mock_source() -> DataSource {
    DataSource {
        provider: MOCK_PROVIDER_ID.to_owned(),
    }
}

#[async_trait]
impl MarketDataProvider for MockMarket {
    fn id(&self) -> &str {
        MOCK_PROVIDER_ID
    }

    fn display_name(&self) -> &str {
        "Mock market"
    }

    fn keeps_trade_history(&self) -> bool {
        self.inner.config.keeps_trade_history
    }

    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: Timeframe::PRESETS.to_vec(),
            live_timeframes: Timeframe::PRESETS.to_vec(),
            quotes: true,
            trades: true,
            depth_levels: Some(BOOK_DEPTH as u32),
            footprint: false,
            asset_classes: vec![
                AssetClass::Equity,
                AssetClass::Etf,
                AssetClass::Index,
                AssetClass::Future,
                AssetClass::Crypto,
            ],
            max_intraday_history_days: Some(self.inner.config.intraday_sessions as u32),
            max_daily_history_days: Some(
                (self.inner.config.daily_sessions + self.inner.config.intraday_sessions) as u32,
            ),
            realtime: true,
            aggressor_source: Some(AggressorSource::Exchange),
        }
    }

    fn health(&self) -> ProviderHealth {
        let now = self.inner.config.clock.now();
        let last = Timestamp(self.inner.last_event.load(Ordering::Relaxed));
        let (status, message) = if self.logging_in() {
            (HealthStatus::Unknown, LOGGING_IN.to_owned())
        } else if self.in_outage() {
            (
                HealthStatus::Degraded,
                "Connection lost (simulated outage). Reconnecting.".to_owned(),
            )
        } else {
            (
                HealthStatus::Ok,
                format!("deterministic (seed {})", self.inner.config.seed),
            )
        };
        ProviderHealth {
            provider_id: self.id().to_owned(),
            kind: ProviderKind::MarketData,
            display_name: self.display_name().to_owned(),
            status,
            latency_ms: Some(0.0),
            last_message_at: Some(last),
            message: Some(message),
            connection: None,
            accounts: None,
            checked_at: now,
        }
    }

    fn prices_flowing(&self) -> bool {
        !self.in_outage() && !self.logging_in()
    }

    async fn search(
        &self,
        query: &str,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        Ok(self
            .inner
            .catalog
            .search(query, asset_class, limit)
            .into_iter()
            .filter(|i| self.inner.series.contains_key(&i.id))
            .cloned()
            .collect())
    }

    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.logged_in()?;
        self.inner
            .catalog
            .resolve(input)
            .filter(|id| self.inner.series.contains_key(id))
            .ok_or_else(|| MarketError::UnknownInstrument(input.to_owned()))
    }

    async fn contract_for(
        &self,
        want: &ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        self.logged_in()?;
        let listed = self
            .inner
            .catalog
            .entries()
            .map(|e| &e.instrument)
            .filter(|i| self.inner.series.contains_key(&i.id));
        let expired = self.inner.expired.values().map(|e| &e.instrument);
        Ok(listed
            .chain(expired)
            .find(|i| exchange_contract(i).as_ref() == Some(want))
            .cloned())
    }

    async fn spec(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(Instrument, ContractSpec), MarketError> {
        self.logged_in()?;
        if let Some(e) = self.inner.expired.get(instrument) {
            return Ok((e.instrument.clone(), e.spec.clone()));
        }
        let e = self
            .inner
            .catalog
            .get(instrument)
            .ok_or_else(|| MarketError::UnknownInstrument(instrument.to_string()))?;
        Ok((e.instrument.clone(), e.spec.clone()))
    }

    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.logged_in()?;
        if let (Some(f), Some(t)) = (req.from, req.to)
            && f > t
        {
            return Err(MarketError::InvalidRequest("from is after to".into()));
        }
        match self.inner.expired.get(&req.instrument) {
            Some(e) => self.expired_bars(e, &req),
            None if req.tf.base().is_none() => {
                let me = self.clone();
                tokio::task::spawn_blocking(move || me.bars(&req))
                    .await
                    .map_err(|e| MarketError::Unavailable(format!("seconds bars failed: {e}")))?
            }
            None => self.bars(&req),
        }
    }

    async fn get_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        self.logged_in()?;
        if !self.keeps_trade_history() {
            return Err(MarketError::Unsupported(format!(
                "{} keeps no trade history for {}",
                self.id(),
                req.instrument
            )));
        }
        self.recorded_trades(req).await
    }

    async fn replay_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        self.logged_in()?;
        if self.inner.config.refuses_replays {
            return Err(MarketError::Unsupported(format!(
                "the mock market refused the tick replay of {}",
                req.instrument
            )));
        }
        self.recorded_trades(req).await
    }

    async fn quote(&self, instrument: &InstrumentId) -> Result<Quote, MarketError> {
        self.logged_in()?;
        let s = self.series(instrument)?.read();
        let ts = if s.ticked {
            Timestamp(self.inner.last_event.load(Ordering::Relaxed))
        } else {
            s.minutes.last().map_or(self.inner.history_end, |b| {
                Timestamp(b.t + NANOS_PER_MINUTE)
            })
        };
        Ok(s.quote(ts))
    }

    fn subscribe_quotes(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Quote>, MarketError> {
        for i in instruments {
            self.series(i)?;
        }
        let set: HashSet<InstrumentId> = instruments.iter().cloned().collect();
        Ok(self
            .broadcast_stream()
            .filter_map(move |e| {
                let out = match e {
                    Ok(MarketEvent::Quote(q)) if set.contains(&q.instrument) => Some(q),
                    _ => None,
                };
                async move { out }
            })
            .boxed())
    }

    fn subscribe_trades(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Trade>, MarketError> {
        for i in instruments {
            self.series(i)?;
        }
        let set: HashSet<InstrumentId> = instruments.iter().cloned().collect();
        Ok(self
            .broadcast_stream()
            .filter_map(move |e| {
                let out = match e {
                    Ok(MarketEvent::Trade(t)) if set.contains(&t.instrument) => Some(t),
                    _ => None,
                };
                async move { out }
            })
            .boxed())
    }

    fn subscribe_bars(
        &self,
        instrument: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        let series = Arc::clone(self.series(instrument)?);
        let id = instrument.clone();
        let calendar = series.read().calendar;
        let stream = self.broadcast_stream();
        match tf {
            Timeframe::M1 => Ok(stream
                .filter_map(move |e| {
                    let out = match e {
                        Ok(MarketEvent::Bar1m {
                            instrument,
                            bar,
                            closed,
                        }) if instrument == id => Some(LiveBar {
                            instrument,
                            tf,
                            bar,
                            closed,
                        }),
                        _ => None,
                    };
                    async move { out }
                })
                .boxed()),
            _ if tf.base().is_none() => Ok(stream
                .scan(TradeBarBuilder::new(tf, calendar), move |builder, e| {
                    let mut out = Vec::new();
                    if let Ok(MarketEvent::Trade(t)) = e
                        && t.instrument == id
                    {
                        if let Some(closed) = builder.push(t.ts, t.price, t.size, t.aggressor) {
                            out.push(LiveBar {
                                instrument: id.clone(),
                                tf,
                                bar: closed,
                                closed: true,
                            });
                        }
                        if let Some(cur) = builder.current() {
                            out.push(LiveBar {
                                instrument: id.clone(),
                                tf,
                                bar: *cur,
                                closed: false,
                            });
                        }
                    }
                    futures::future::ready(Some(out))
                })
                .flat_map(futures::stream::iter)
                .boxed()),
            _ => Ok(stream
                .scan(None::<Bar>, move |last, e| {
                    let mut out = Vec::new();
                    if let Ok(MarketEvent::Bar1m {
                        instrument, bar, ..
                    }) = e
                        && instrument == id
                    {
                        let bucket = calendar.bucket_start(bar.t, tf);
                        let s = series.read();
                        let start = s.minutes.partition_point(|b| b.t < bucket.0);
                        let minutes: Vec<Bar> = s.minutes[start..]
                            .iter()
                            .filter(|b| b.t <= bar.t.0)
                            .map(|b| s.bar(b))
                            .collect();
                        drop(s);
                        if let Some(agg) = aggregate(&minutes, tf, calendar).pop() {
                            if let Some(prev) = last.take()
                                && prev.t != agg.t
                            {
                                out.push(LiveBar {
                                    instrument: id.clone(),
                                    tf,
                                    bar: prev,
                                    closed: true,
                                });
                            }
                            out.push(LiveBar {
                                instrument: id.clone(),
                                tf,
                                bar: agg,
                                closed: false,
                            });
                            *last = Some(agg);
                        }
                    }
                    futures::future::ready(Some(out))
                })
                .flat_map(futures::stream::iter)
                .boxed()),
        }
    }

    fn subscribe_depth(
        &self,
        instrument: &InstrumentId,
        levels: u32,
    ) -> Result<MarketStream<BookSnapshot>, MarketError> {
        let series = self.series(instrument)?;
        let levels = (levels as usize).clamp(1, BOOK_DEPTH);
        let (first, guard) = {
            let s = series.read();
            if s.book.is_none() {
                return Err(MarketError::Unsupported(format!(
                    "{instrument} is an index: it has no book"
                )));
            }
            let ts = Timestamp(self.inner.last_event.load(Ordering::Relaxed));
            (s.book_snapshot(ts, levels), DepthSub::new(&s.depth_subs))
        };
        let id = instrument.clone();
        let live = self.broadcast_stream().filter_map(move |e| {
            let _alive = &guard;
            let out = match e {
                Ok(MarketEvent::Book(b)) if b.instrument == id => {
                    let mut b = Arc::unwrap_or_clone(b);
                    b.bids.truncate(levels);
                    b.asks.truncate(levels);
                    Some(b)
                }
                _ => None,
            };
            async move { out }
        });
        Ok(futures::stream::iter(first).chain(live).boxed())
    }
}

pub fn parse_seed(s: &str) -> Option<u64> {
    let s = s.trim();
    match s.strip_prefix("0x") {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => u64::from_str(s).ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::Clock;
    use tessera_core::clock::ManualClock;

    #[test]
    fn prints_share_their_orders_time_and_burst_children_follow_their_parent() {
        let fill = |order, burst_child| Fill {
            ticks: 100,
            size: 1.0,
            aggressor: Aggressor::Buy,
            order,
            burst_child: NonZeroU32::new(burst_child),
        };
        let sweep_then_child_then_order = [fill(0, 0), fill(0, 0), fill(1, 1), fill(2, 0)];
        let times: Vec<i64> = print_times(&sweep_then_child_then_order, 0, 3_000_000)
            .iter()
            .map(|t| t.0)
            .collect();
        assert_eq!(times, [1_500_000, 1_500_000, 1_800_000, 3_000_000]);
    }

    fn market(at: &str) -> (MockMarket, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::new(Timestamp::parse(at).unwrap()));
        let mut cfg = MockConfig::new(clock.clone());
        cfg.intraday_sessions = 2;
        cfg.daily_sessions = 3;
        (MockMarket::new(cfg), clock)
    }

    fn nq_bars(m: &MockMarket) -> usize {
        m.inner.drivers.read()[&DriverId::Nq].path.minutes.len()
    }

    #[test]
    fn continuous_ticking_never_adds_catch_up_shocks() {
        let (m, clock) = market(FROZEN_AT);
        let before = nq_bars(&m);
        for _ in 0..(4 * 180) {
            clock.advance(NANOS_PER_SEC / 4);
            m.advance(clock.now());
        }
        assert_eq!(nq_bars(&m), before, "ticked minutes are not regenerated");
        clock.advance(5 * NANOS_PER_MINUTE);
        m.advance(clock.now());
        assert_eq!(nq_bars(&m), before + 4);
        m.advance(clock.now().add_nanos(NANOS_PER_SEC / 4));
        assert_eq!(nq_bars(&m), before + 4);
    }

    #[test]
    fn closed_minutes_are_scanned_once() {
        let (m, clock) = market("2026-10-03T12:00:00-04:00");
        let before = nq_bars(&m);
        for _ in 0..20 {
            clock.advance(NANOS_PER_SEC / 4);
            m.advance(clock.now());
        }
        let st = &m.inner.drivers.read()[&DriverId::Nq];
        assert_eq!(st.path.minutes.len(), before);
        assert_eq!(st.last_covered_minute, minute_index(clock.now().0) - 1);
    }
}
