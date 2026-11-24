use std::collections::HashMap;
use std::ops::Range;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use futures::StreamExt;
use parking_lot::{Mutex, RwLock};
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Aggressor, AggressorSource, Bar, Quote, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_DAY, NANOS_PER_MINUTE};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_store::bars::{Span as BarSpan, holes};
use tessera_store::ticks::{Span, TickKey, TickRow, TickStore};
use tokio::sync::watch;
use tokio::time::Instant;
use tracing::warn;

use crate::aggregate::{TradeBarBuilder, aggregate};
use crate::history::{BarCache, finish, trading_minutes};
use crate::io::{EarlierBars, ReplayState, SavedContractDays, SavedDayInfo};
use crate::provider::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream, TradesRequest,
};
use crate::router::MarketRouter;
use crate::saved::{Contract, DayPin, SavedTrades};

pub mod tools;

pub const SOURCE: &str = "replay";
pub const MAX_SPEED: u32 = 600;
const FRAME: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Head {
    at: i64,
    since: Instant,
    speed: u32,
    playing: bool,
    end: i64,
}

impl Head {
    fn cursor(&self, now: Instant) -> i64 {
        if !self.playing {
            return self.at;
        }
        let ran = now.saturating_duration_since(self.since).as_nanos();
        let moved = i64::try_from(ran.saturating_mul(u128::from(self.speed))).unwrap_or(i64::MAX);
        self.at.saturating_add(moved).min(self.end)
    }

    fn due(&self, t: i64) -> Instant {
        let ahead = u64::try_from(t.saturating_sub(self.at)).unwrap_or(0) / u64::from(self.speed);
        self.since + Duration::from_nanos(ahead)
    }

    fn playing_at(&self, now: Instant) -> bool {
        self.playing && self.cursor(now) < self.end
    }

    fn rebased(self, now: Instant) -> Self {
        Self {
            at: self.cursor(now),
            since: now,
            ..self
        }
    }
}

struct Day {
    contract: Contract,
    date: NaiveDate,
    instrument: Instrument,
    spec: ContractSpec,
    span: Span,
    prints: Vec<TickRow>,
    bar_cache: Option<Arc<BarCache>>,
    kept_minutes: Vec<Bar>,
    earlier: EarlierBars,
    _pin: DayPin,
}

impl Day {
    fn before(&self, t: i64) -> usize {
        self.prints.partition_point(|p| p.t < t)
    }

    fn first_in_bucket(&self, tf: Timeframe, t: Timestamp) -> usize {
        let cal = self.spec.sessions;
        let bucket = cal.bucket_start(t, tf);
        self.prints
            .partition_point(|p| cal.bucket_start(Timestamp(p.t), tf) < bucket)
    }

    fn opens(&self) -> i64 {
        trade_date_open(self.spec.sessions, self.date, self.span.start)
    }

    fn kept_minutes_before(&self, cursor: i64) -> &[Bar] {
        &self.kept_minutes[..self
            .kept_minutes
            .partition_point(|m| m.t.0 + NANOS_PER_MINUTE <= cursor)]
    }

    fn played(&self, tf: Timeframe, range: Range<usize>) -> Vec<Bar> {
        let mut builder = TradeBarBuilder::new(tf, self.spec.sessions);
        let mut out: Vec<Bar> = self.prints[range]
            .iter()
            .filter_map(|p| builder.push(Timestamp(p.t), p.price, p.size, p.aggressor))
            .collect();
        out.extend(builder.current().copied());
        out
    }

    async fn kept_before(&self, req: &BarsRequest) -> Vec<Bar> {
        let Some(cache) = &self.bar_cache else {
            return Vec::new();
        };
        let req = BarsRequest {
            instrument: self.contract.instrument.clone(),
            ..req.clone()
        };
        let before = Timestamp(self.opens());
        cache
            .kept_before(&self.contract.source, &self.spec, &req, before)
            .await
            .unwrap_or_else(|e| {
                warn!(error = %e, contract = %self.contract.instrument, "the bar store failed; the replay shows its own day");
                Vec::new()
            })
    }

    async fn bars(&self, req: &BarsRequest, cursor: i64) -> Vec<Bar> {
        let cal = self.spec.sessions;
        let first = req.from.map_or(0, |f| self.first_in_bucket(req.tf, f));
        let upto = self.before(cursor).max(first);
        let raw = match req.tf.base() {
            None => self.played(req.tf, first..upto),
            Some(Timeframe::D1) => {
                let mut today = self.kept_minutes_before(cursor).to_vec();
                today.extend(self.played(Timeframe::M1, first..upto));
                today.sort_by_key(|b| b.t);
                let mut raw = self.kept_before(req).await;
                raw.extend(aggregate(&today, Timeframe::D1, cal));
                raw
            }
            _ => {
                let mut raw = self.kept_before(req).await;
                raw.extend_from_slice(self.kept_minutes_before(cursor));
                raw.extend(self.played(Timeframe::M1, first..upto));
                raw
            }
        };
        finish(raw, cal, req)
    }

    fn trades(&self, id: &InstrumentId, range: Range<usize>) -> Vec<Trade> {
        self.prints[range]
            .iter()
            .map(|p| p.trade(id, None))
            .collect()
    }

    fn playback(
        self: Arc<Self>,
        id: InstrumentId,
        head: watch::Receiver<Head>,
        next: usize,
    ) -> MarketStream<Vec<Trade>> {
        futures::stream::unfold(
            (self, id, head, next),
            |(day, id, mut head, next)| async move {
                loop {
                    let h = *head.borrow_and_update();
                    let now = Instant::now();
                    let upto = day.before(h.cursor(now)).max(next);
                    if upto > next {
                        let batch = day.trades(&id, next..upto);
                        return Some((batch, (day, id, head, upto)));
                    }
                    let wake = day
                        .prints
                        .get(next)
                        .filter(|_| h.playing)
                        .map(|p| h.due(p.t).max(now + FRAME));
                    match wake {
                        Some(at) => tokio::select! {
                            r = head.changed() => r.ok()?,
                            () = tokio::time::sleep_until(at) => {}
                        },
                        None => head.changed().await.ok()?,
                    }
                }
            },
        )
        .boxed()
    }
}

struct LiveBars {
    day: Arc<Day>,
    builder: TradeBarBuilder,
    next_kept: usize,
}

impl LiveBars {
    fn new(day: Arc<Day>, tf: Timeframe, cursor: i64) -> Self {
        let cal = day.spec.sessions;
        let forming = cal.bucket_start(Timestamp(cursor), tf);
        let next_kept = day
            .kept_minutes
            .partition_point(|m| cal.bucket_start(m.t, tf) < forming);
        let prints = day.first_in_bucket(tf, forming)..day.before(cursor);
        let mut live = Self {
            builder: TradeBarBuilder::new(tf, cal),
            next_kept,
            day: Arc::clone(&day),
        };
        for p in &day.prints[prints] {
            live.push(Timestamp(p.t), p.price, p.size, p.aggressor);
        }
        live.kept_until(cursor);
        live
    }

    fn kept_until(&mut self, t: i64) -> Vec<Bar> {
        let mut closed = Vec::new();
        while let Some(m) = self
            .day
            .kept_minutes
            .get(self.next_kept)
            .filter(|m| m.t.0 + NANOS_PER_MINUTE <= t)
        {
            closed.extend(self.builder.push_bar(m));
            self.next_kept += 1;
        }
        closed
    }

    fn push(&mut self, t: Timestamp, price: Price, size: Qty, aggressor: Aggressor) -> Vec<Bar> {
        let mut closed = self.kept_until(t.0);
        closed.extend(self.builder.push(t, price, size, aggressor));
        closed
    }
}

struct Replay {
    instrument: Instrument,
    spec: ContractSpec,
    day: Arc<Day>,
    head: watch::Sender<Head>,
}

impl Replay {
    fn id(&self) -> &InstrumentId {
        &self.instrument.id
    }

    fn cursor(&self) -> i64 {
        self.head.borrow().cursor(Instant::now())
    }

    fn state(&self) -> ReplayState {
        let h = *self.head.borrow();
        let now = Instant::now();
        ReplayState {
            instrument: self.id().clone(),
            contract: self.day.contract.instrument.clone(),
            source: self.day.contract.source.clone(),
            trade_date: self.day.date,
            from: Timestamp(self.day.span.start),
            to: Timestamp(self.day.span.end),
            cursor: Timestamp(h.cursor(now)),
            playing: h.playing_at(now),
            speed: h.speed,
            earlier: self.day.earlier.clone(),
        }
    }

    fn playback_from(&self, next: usize) -> MarketStream<Vec<Trade>> {
        Arc::clone(&self.day).playback(self.id().clone(), self.head.subscribe(), next)
    }

    fn playback(&self) -> MarketStream<Vec<Trade>> {
        self.playback_from(self.day.before(self.cursor()))
    }
}

pub struct Replays {
    saved: Arc<SavedTrades>,
    open: RwLock<HashMap<InstrumentId, Arc<Replay>>>,
    days: Mutex<HashMap<(Contract, NaiveDate), Weak<Day>>>,
    serial: AtomicU32,
}

impl std::fmt::Debug for Replays {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Replays")
            .field("open", &self.open.read().len())
            .finish_non_exhaustive()
    }
}

fn speed(asked: u32) -> u32 {
    asked.clamp(1, MAX_SPEED)
}

fn unavailable(e: impl std::fmt::Display) -> MarketError {
    MarketError::Unavailable(e.to_string())
}

impl Replays {
    pub fn new(saved: Arc<SavedTrades>) -> Arc<Self> {
        Arc::new(Self {
            saved,
            open: RwLock::default(),
            days: Mutex::default(),
            serial: AtomicU32::new(0),
        })
    }

    pub fn owns(&self, id: &InstrumentId) -> bool {
        self.open.read().contains_key(id)
    }

    fn get(&self, id: &InstrumentId) -> Result<Arc<Replay>, MarketError> {
        self.open
            .read()
            .get(id)
            .cloned()
            .ok_or_else(|| MarketError::UnknownInstrument(format!("{id} is no open replay")))
    }

    pub fn saved_days(&self) -> tessera_store::Result<Vec<SavedContractDays>> {
        let store = self.saved.store();
        let mut out = Vec::new();
        for c in store.contracts()? {
            let Ok(instrument) = InstrumentId::new(&c.instrument) else {
                continue;
            };
            let contract = Contract::new(&c.source, &instrument);
            let days = store
                .days(contract.key())?
                .into_iter()
                .filter_map(|d| {
                    Some(SavedDayInfo {
                        trade_date: d.trade_date,
                        from: Timestamp(d.covered.first()?.start),
                        to: Timestamp(d.covered.last()?.end),
                        prints: d.prints,
                    })
                })
                .collect();
            out.push(SavedContractDays {
                instrument,
                source: c.source,
                days,
            });
        }
        Ok(out)
    }

    pub async fn open(
        self: &Arc<Self>,
        router: &MarketRouter,
        contract: Contract,
        date: NaiveDate,
        at: Option<Timestamp>,
        speed_asked: u32,
        playing: bool,
    ) -> Result<ReplayState, MarketError> {
        let day = self.day(router, contract, date).await?;
        let start = at.map_or_else(|| default_start(&day), |t| t.0);
        let replay = self.start(day, start, speed(speed_asked), playing)?;
        Ok(replay.state())
    }

    async fn day(
        self: &Arc<Self>,
        router: &MarketRouter,
        contract: Contract,
        date: NaiveDate,
    ) -> Result<Arc<Day>, MarketError> {
        let key = (contract.clone(), date);
        if let Some(day) = self.days.lock().get(&key).and_then(Weak::upgrade) {
            return Ok(day);
        }
        let pin = self.saved.pin(&contract, date);
        let saved = Arc::clone(&self.saved);
        let read = tokio::task::spawn_blocking(move || -> Result<_, MarketError> {
            let store = saved.store();
            let covered = store
                .days(contract.key())
                .map_err(unavailable)?
                .into_iter()
                .find(|d| d.trade_date == date)
                .map(|d| d.covered)
                .unwrap_or_default();
            let (Some(first), Some(last)) = (covered.first(), covered.last()) else {
                return Err(MarketError::InvalidRequest(format!(
                    "no saved trades of {} on {date}",
                    contract.instrument
                )));
            };
            let span = Span::new(first.start, last.end);
            let prints = store
                .read(contract.key(), span.start, span.end)
                .map_err(unavailable)?;
            let described = saved.contract(&contract);
            Ok((contract, described, span, covered, prints))
        });
        let (contract, described, span, covered, prints) = read.await.map_err(unavailable)??;
        let (instrument, spec) = match described {
            Some(d) => d,
            None => {
                let (i, s) = router.spec(&contract.instrument).await?;
                let (saved, source) = (Arc::clone(&self.saved), contract.source.clone());
                let (ri, rs) = (i.clone(), s.clone());
                drop(tokio::task::spawn_blocking(move || {
                    saved.remember_contract(&source, &ri, &rs);
                }));
                (i, s)
            }
        };
        let bar_cache = router.bar_cache();
        let (kept_minutes, earlier) = match &bar_cache {
            Some(cache) => kept_for_day(cache, &contract, spec.sessions, date, &covered).await,
            None => (Vec::new(), EarlierBars::Missing),
        };
        let day = Arc::new(Day {
            contract,
            date,
            instrument,
            spec,
            span,
            prints,
            bar_cache,
            kept_minutes,
            earlier,
            _pin: pin,
        });
        let mut days = self.days.lock();
        days.retain(|_, d| d.strong_count() > 0);
        days.insert(key, Arc::downgrade(&day));
        Ok(day)
    }

    fn start(
        &self,
        day: Arc<Day>,
        at: i64,
        speed: u32,
        playing: bool,
    ) -> Result<Arc<Replay>, MarketError> {
        let n = self.serial.fetch_add(1, Ordering::Relaxed) + 1;
        let (instrument, spec) = replay_instrument(&day, n)?;
        let head = Head {
            at: at.clamp(day.span.start, day.span.end),
            since: Instant::now(),
            speed,
            playing,
            end: day.span.end,
        };
        let replay = Arc::new(Replay {
            instrument,
            spec,
            day,
            head: watch::channel(head).0,
        });
        self.open
            .write()
            .insert(replay.id().clone(), Arc::clone(&replay));
        Ok(replay)
    }

    pub fn control(
        &self,
        id: &InstrumentId,
        playing: Option<bool>,
        speed_asked: Option<u32>,
    ) -> Result<ReplayState, MarketError> {
        let r = self.get(id)?;
        let now = Instant::now();
        r.head.send_modify(|h| {
            let was = h.playing_at(now);
            *h = h.rebased(now);
            h.playing = playing.unwrap_or(was);
            h.speed = speed_asked.map_or(h.speed, speed);
        });
        Ok(r.state())
    }

    pub fn jump(&self, id: &InstrumentId, to: Timestamp) -> Result<ReplayState, MarketError> {
        let old = self.get(id)?;
        let h = *old.head.borrow();
        let new = self.start(
            Arc::clone(&old.day),
            to.0,
            h.speed,
            h.playing_at(Instant::now()),
        )?;
        self.close(id);
        Ok(new.state())
    }

    pub fn state(&self, id: &InstrumentId) -> Result<ReplayState, MarketError> {
        Ok(self.get(id)?.state())
    }

    pub fn states(&self) -> Vec<ReplayState> {
        let mut out: Vec<ReplayState> = self.open.read().values().map(|r| r.state()).collect();
        out.sort_by(|a, b| a.instrument.cmp(&b.instrument));
        out
    }

    pub fn close(&self, id: &InstrumentId) -> bool {
        self.open.write().remove(id).is_some()
    }
}

fn trade_date_open(cal: SessionCalendar, date: NaiveDate, first_print: i64) -> i64 {
    let first_minute = cal.bucket_start(Timestamp(first_print), Timeframe::M1).0;
    cal.session(date)
        .map_or(first_minute, |s| s.open.0)
        .min(first_minute)
}

fn outside(covered: &[Span], m: &Bar) -> bool {
    let end = m.t.0 + NANOS_PER_MINUTE;
    covered.iter().all(|c| c.end <= m.t.0 || c.start >= end)
}

async fn kept_for_day(
    cache: &BarCache,
    contract: &Contract,
    cal: SessionCalendar,
    date: NaiveDate,
    covered: &[Span],
) -> (Vec<Bar>, EarlierBars) {
    let (Some(first), Some(last)) = (covered.first(), covered.last()) else {
        return (Vec::new(), EarlierBars::Missing);
    };
    let opens = Timestamp(trade_date_open(cal, date, first.start));
    let minutes = cache
        .kept_minutes(&contract.source, &contract.instrument, opens, Timestamp(last.end))
        .await
        .unwrap_or_else(|e| {
            warn!(error = %e, contract = %contract.instrument, "the bar store failed; the replay shows its own day");
            Vec::new()
        });
    let kept_minutes = minutes
        .into_iter()
        .filter(|m| outside(covered, m))
        .collect();
    let stored = cache
        .minutes_covered(&contract.source, &contract.instrument)
        .await;
    (kept_minutes, earlier_bars(cal, date, first.start, &stored))
}

fn earlier_bars(
    cal: SessionCalendar,
    date: NaiveDate,
    first_print: i64,
    stored: &[BarSpan],
) -> EarlierBars {
    if !stored.iter().any(|s| s.start < first_print) {
        return EarlierBars::Missing;
    }
    let from = cal
        .session(cal.prev_trade_date(date))
        .map_or(first_print, |s| s.open.0)
        .min(first_print);
    match holes(stored, BarSpan::new(from, first_print))
        .into_iter()
        .rfind(|h| trading_minutes(cal, *h) > 0)
    {
        None => EarlierBars::Whole,
        Some(gap) => EarlierBars::Gap {
            from: Timestamp(gap.start),
            to: Timestamp(gap.end),
        },
    }
}

fn saved_before(
    store: &TickStore,
    key: TickKey<'_>,
    from: i64,
    to: i64,
    room: usize,
) -> tessera_store::Result<Vec<TickRow>> {
    let mut pages = Vec::new();
    let (mut at, mut held) = (to, 0);
    while at > from && held < room {
        let lo = from.max(at.saturating_sub(NANOS_PER_DAY));
        let page = store.read(key, lo, at)?;
        held += page.len();
        pages.push(page);
        at = lo;
    }
    let mut rows: Vec<TickRow> = pages.into_iter().rev().flatten().collect();
    rows.drain(..rows.len().saturating_sub(room));
    Ok(rows)
}

fn default_start(day: &Day) -> i64 {
    day.spec
        .sessions
        .session(day.date)
        .and_then(|s| s.rth)
        .map(|w| w.start.0)
        .filter(|t| day.span.contains(*t))
        .unwrap_or(day.span.start)
}

fn replay_instrument(day: &Day, n: u32) -> Result<(Instrument, ContractSpec), MarketError> {
    let live = &day.instrument;
    let symbol = format!("{}-R{n}", live.id.symbol());
    let id = InstrumentId::new(match live.id.venue() {
        Some(v) => format!("{symbol}.{v}"),
        None => symbol.clone(),
    })
    .map_err(|e| MarketError::InvalidRequest(e.to_string()))?;
    let instrument = Instrument {
        id: id.clone(),
        symbol,
        name: format!("{} replay of {}", live.symbol, day.date),
        is_front: false,
        tradable: false,
        ..live.clone()
    };
    let spec = ContractSpec {
        instrument: id,
        ..day.spec.clone()
    };
    Ok((instrument, spec))
}

#[async_trait]
impl MarketDataProvider for Replays {
    fn id(&self) -> &str {
        SOURCE
    }

    fn display_name(&self) -> &str {
        "Replay"
    }

    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: Timeframe::PRESETS.to_vec(),
            live_timeframes: Timeframe::PRESETS.to_vec(),
            quotes: true,
            trades: true,
            depth_levels: None,
            footprint: false,
            asset_classes: vec![
                AssetClass::Future,
                AssetClass::Equity,
                AssetClass::Etf,
                AssetClass::Crypto,
            ],
            max_intraday_history_days: None,
            max_daily_history_days: None,
            realtime: false,
            aggressor_source: Some(AggressorSource::Exchange),
        }
    }

    fn health(&self) -> ProviderHealth {
        let now = Timestamp::now();
        ProviderHealth {
            provider_id: SOURCE.to_owned(),
            kind: ProviderKind::MarketData,
            display_name: self.display_name().to_owned(),
            status: HealthStatus::Ok,
            latency_ms: None,
            last_message_at: None,
            message: Some(format!("{} open", self.open.read().len())),
            connection: None,
            accounts: None,
            checked_at: now,
        }
    }

    fn keeps_trade_history(&self) -> bool {
        true
    }

    fn cache_bars(&self) -> bool {
        false
    }

    async fn search(
        &self,
        query: &str,
        _asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        let q = query.trim().to_ascii_uppercase();
        let mut out: Vec<Instrument> = self
            .open
            .read()
            .values()
            .filter(|r| r.id().as_str().contains(&q))
            .map(|r| r.instrument.clone())
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out.truncate(limit);
        Ok(out)
    }

    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        InstrumentId::new(input)
            .ok()
            .filter(|id| self.owns(id))
            .ok_or_else(|| MarketError::UnknownInstrument(input.to_owned()))
    }

    async fn spec(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(Instrument, ContractSpec), MarketError> {
        let r = self.get(instrument)?;
        Ok((r.instrument.clone(), r.spec.clone()))
    }

    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        let r = self.get(&req.instrument)?;
        let cal = r.spec.sessions;
        let cursor = r.cursor();
        let day = &r.day;
        let bars = day.bars(&req, cursor).await;
        let forming = cal.bucket_start(Timestamp(cursor), req.tf);
        let last_bar_open = cursor < day.span.end && bars.last().is_some_and(|b| b.t == forming);
        Ok(BarSeries {
            instrument: req.instrument,
            tf: req.tf,
            bars,
            last_bar_open,
        })
    }

    async fn quote(&self, instrument: &InstrumentId) -> Result<Quote, MarketError> {
        let r = self.get(instrument)?;
        let cursor = r.cursor();
        let last = r.day.before(cursor).checked_sub(1).map(|i| r.day.prints[i]);
        Ok(quote_of(instrument, cursor, last.as_ref()))
    }

    fn subscribe_quotes(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Quote>, MarketError> {
        let mut streams = Vec::new();
        for id in instruments {
            let id = id.clone();
            let s = self.get(&id)?.playback().filter_map(move |batch| {
                let q = batch
                    .last()
                    .map(|t| quote_of(&id, t.ts.0, Some(&TickRow::of(t))));
                futures::future::ready(q)
            });
            streams.push(s.boxed());
        }
        Ok(futures::stream::select_all(streams).boxed())
    }

    fn subscribe_trades(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Trade>, MarketError> {
        let mut streams = Vec::new();
        for id in instruments {
            streams.push(self.get(id)?.playback().flat_map(futures::stream::iter));
        }
        Ok(futures::stream::select_all(streams).boxed())
    }

    fn subscribe_bars(
        &self,
        instrument: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        let r = self.get(instrument)?;
        let cursor = r.cursor();
        let next = r.day.before(cursor);
        let builder = LiveBars::new(Arc::clone(&r.day), tf, cursor);
        let id = instrument.clone();
        Ok(r.playback_from(next)
            .scan(builder, move |b, batch| {
                let live = |bar, closed| LiveBar {
                    instrument: id.clone(),
                    tf,
                    bar,
                    closed,
                };
                let mut out = Vec::new();
                for t in &batch {
                    for closed in b.push(t.ts, t.price, t.size, t.aggressor) {
                        out.push(live(closed, true));
                    }
                }
                out.extend(b.builder.current().map(|bar| live(*bar, false)));
                futures::future::ready(Some(out))
            })
            .flat_map(futures::stream::iter)
            .boxed())
    }

    async fn get_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let r = self.get(&req.instrument)?;
        let cursor = r.cursor();
        let to = req.to.map_or(cursor, |t| t.0.min(cursor));
        let end = r.day.before(to);
        let start = req.from.map_or(0, |t| r.day.before(t.0)).min(end);
        let start = req
            .limit
            .map_or(start, |l| start.max(end.saturating_sub(l)));
        let own = r.day.trades(r.id(), start..end);
        let room = req
            .limit
            .map_or(usize::MAX, |l| l.saturating_sub(own.len()));
        let Some(from) = req.from.filter(|f| f.0 < r.day.span.start && room > 0) else {
            return Ok(own);
        };
        let (saved, key) = (Arc::clone(&self.saved), r.day.contract.clone());
        let earlier_to = to.min(r.day.span.start);
        let rows = tokio::task::spawn_blocking(move || {
            saved_before(saved.store(), key.key(), from.0, earlier_to, room)
        })
        .await
        .map_err(unavailable)?
        .map_err(unavailable)?;
        let mut out: Vec<Trade> = rows.iter().map(|p| p.trade(r.id(), None)).collect();
        out.extend(own);
        Ok(out)
    }

    async fn replay_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        self.get_trades(req).await
    }
}

fn quote_of(instrument: &InstrumentId, cursor: i64, last: Option<&TickRow>) -> Quote {
    Quote {
        instrument: instrument.clone(),
        ts: Timestamp(cursor),
        bid: None,
        bid_size: None,
        ask: None,
        ask_size: None,
        last: last.map(|p| p.price),
        last_size: last.map(|p| p.size),
        session: None,
        source: None,
    }
}
