pub mod bigs;
pub mod depth;
pub mod depth_history;
mod disk;
mod gaps;
mod past;
pub mod tape;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use tessera_core::health::{HealthStatus, ProviderHealth};
use tessera_core::instrument::{ContractSpec, Instrument};
use tessera_core::market::AggressorSource;
use tessera_core::market::{BookSnapshot, DataSource, FootprintBar, Quote, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_HOUR, NANOS_PER_MICRO, NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Price, Timeframe, Timestamp};
use tessera_host::{EventBus, PumpGuard, Pumps, TopicKey};
use tessera_protocol::compact::{CompactBar, CompactLevel, CompactTrade};
use tessera_protocol::topics::names;
use tessera_store::ticks::{Span, TickRow};
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use crate::aggregate::{FootprintBuilder, FootprintChanges, bar_range};
use crate::follow::{Followed, follow, follow_marked, silent_for};
use crate::history::Read as BarRead;
use crate::io::{
    BarUpdate, BigTrade, CompactFootprint, DepthKind, DepthUpdate, FootprintUpdate, TradesUpdate,
};
use crate::orderflow::bars::FootprintCache;
use crate::orderflow::big_trades::{BigTradeModel, Grouping};
use crate::provider::{BarsRequest, MarketDataProvider, MarketError, TradesRequest};
use crate::router::{MarketRouter, source_of};
use crate::saved::{self, Contract, SavedTrades};
use depth::View;
use depth_history::{DepthArchive, DepthColumn, DepthRecorder, MINUTE_NS};
use disk::{Disk, FillStep, Reach, Saving, Shown};
pub use gaps::Gaps;
pub(crate) use gaps::session_parts as session_time;
use past::Past;
use tape::{Print, TAPE_MAX, Tape};

pub const CONFLATION: Duration = Duration::from_millis(25);
const TRADE_BATCH: usize = 4096;
pub const TRADE_INTERVAL: Duration = CONFLATION;
const TRADE_FANOUT: usize = 1024;
pub const DEPTH_INTERVAL: Duration = CONFLATION;
pub const DEPTH_HEARTBEAT: Duration = Duration::from_secs(1);
pub const FOOTPRINT_INTERVAL: Duration = CONFLATION;
pub const RECORDING_LINGER: Duration = Duration::from_secs(10 * 60);
pub const AGENT_LINGER: Duration = Duration::from_secs(60);
pub const MAX_AGENT_FEEDS: usize = 4;
pub const MAX_RECORDED: usize = 32;
pub const RECORDING_BUDGET: usize = 128 << 20;
pub const TRADES_SNAPSHOT: usize = 200;
pub const CHUNK: i64 = NANOS_PER_HOUR;
pub const CHUNK_PRINTS: usize = 250_000;
const MIN_CHUNK: i64 = NANOS_PER_SEC;
pub const FILL_WAIT: Duration = Duration::from_secs(1);
pub const SERVED_RETRY: Duration = Duration::from_millis(500);
pub const SERVED_RETRIES: u32 = 4;
const SERVED_AGAIN: tessera_core::backoff::Backoff =
    tessera_core::backoff::Backoff::new(Duration::from_secs(1), Duration::from_secs(8));
pub const FILL_SPAN: i64 = 30 * NANOS_PER_MINUTE;
pub const REFUSED_AGAIN: Duration = Duration::from_secs(60);
pub const REFUSED_AGAIN_MAX: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum PumpKey {
    Quotes(InstrumentId),
    Trades(InstrumentId),
    Bars(InstrumentId, Timeframe),
    Book(InstrumentId),
    Depth(InstrumentId, u32),
    Footprint(InstrumentId, Timeframe, u32),
}

impl PumpKey {
    fn recorded(&self) -> Option<&InstrumentId> {
        match self {
            Self::Trades(id) | Self::Book(id) | Self::Depth(id, _) | Self::Footprint(id, _, _) => {
                Some(id)
            }
            Self::Quotes(_) | Self::Bars(..) => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asker {
    User,
    Agent,
}

pub fn footprint_key(id: &InstrumentId, tf: Timeframe, row_ticks: u32) -> String {
    format!("{id} {tf} {row_ticks}")
}

struct Flow {
    tape: Mutex<Tape>,
    past: Mutex<Past>,
    filled: watch::Sender<u64>,
    depth: Mutex<DepthRecorder>,
    trades: broadcast::Sender<Arc<Printed>>,
    book: watch::Sender<BookState>,
    last_used_tick: AtomicU64,
    began: Mutex<Option<tokio::time::Instant>>,
    user: AtomicBool,
    bigs: Mutex<bigs::LiveBigs>,
    saving: Mutex<Option<Saving>>,
    shown: Mutex<Shown>,
    reach: Mutex<Reach>,
    pulls_waiting: AtomicUsize,
}

impl Flow {
    fn bytes(&self) -> usize {
        self.tape.lock().bytes() + self.past.lock().bytes() + self.depth.lock().bytes()
    }

    fn is_empty(&self) -> bool {
        self.tape.lock().is_empty() && self.past.lock().len() == 0 && self.depth.lock().is_empty()
    }

    fn held(&self) -> Option<past::Known> {
        let t = self.tape.lock();
        t.is_recording().then(|| self.past.lock().known(&t.cut()))
    }

    fn pulling(&self) -> bool {
        self.pulls_waiting.load(Ordering::Relaxed) > 0 || self.reach.lock().is_pulling()
    }

    fn filling(&self) -> bool {
        self.pulling() || self.held().is_some_and(|k| k.loading)
    }

    fn recording(&self, generation: u64) -> bool {
        let t = self.tape.lock();
        t.generation() == generation && t.is_recording()
    }

    fn begin_segment(&self, source: DataSource) -> u64 {
        let mut t = self.tape.lock();
        if t.is_recording() {
            self.past
                .lock()
                .end_segment(t.generation(), t.segment_prints());
        }
        t.begin(source)
    }

    fn end_segment(&self, generation: u64) {
        let ended = {
            let mut t = self.tape.lock();
            let ended = (t.generation() == generation && t.is_recording()).then(|| {
                self.past.lock().end_segment(generation, t.segment_prints());
                self.saving.lock().take()
            });
            t.end(generation);
            ended.flatten()
        };
        if let Some(s) = ended {
            s.end();
        }
    }

    fn start_saving(&self, disk: Disk) {
        if let Some(previous) = self.saving.lock().replace(Saving::new(disk)) {
            previous.end();
        }
    }

    fn show(self: &Arc<Self>) -> OnDrop<impl FnMut() + use<>> {
        self.shown.lock().open();
        let flow = Arc::clone(self);
        OnDrop(move || {
            let released = flow.shown.lock().close();
            drop(released);
        })
    }

    fn is_idle(self: &Arc<Self>) -> bool {
        Arc::strong_count(self) == 1
    }

    fn new(id: &InstrumentId) -> Self {
        Self {
            tape: Mutex::new(Tape::new(id.clone(), TAPE_MAX)),
            past: Mutex::new(Past::default()),
            filled: watch::channel(0).0,
            depth: Mutex::new(DepthRecorder::default()),
            trades: broadcast::channel(TRADE_FANOUT).0,
            book: watch::channel(BookState::Unseen).0,
            last_used_tick: AtomicU64::new(0),
            began: Mutex::new(None),
            user: AtomicBool::new(false),
            bigs: Mutex::new(bigs::LiveBigs::default()),
            saving: Mutex::new(None),
            shown: Mutex::default(),
            reach: Mutex::default(),
            pulls_waiting: AtomicUsize::new(0),
        }
    }
}

#[derive(Clone)]
struct Booked {
    book: Arc<BookSnapshot>,
    source: DataSource,
    opening: u64,
}

#[derive(Clone)]
enum BookState {
    Unseen,
    Known(Booked),
    Lost {
        ts: Timestamp,
        source: DataSource,
        opening: u64,
    },
}

struct Printed {
    seq: u64,
    segment: u64,
    source: DataSource,
    trades: Vec<Trade>,
}

#[derive(Clone)]
enum Latest {
    Depth(Arc<(View, u64, Timestamp)>),
    Forming(Arc<Forming>),
}

struct Forming {
    instrument: InstrumentId,
    tf: Timeframe,
    source: Mutex<DataSource>,
    builder: Mutex<FootprintBuilder>,
    seq: AtomicU64,
}

impl Forming {
    fn update(&self, bar: &FootprintBar, closed: bool) -> FootprintUpdate {
        FootprintUpdate {
            instrument: self.instrument.clone(),
            tf: self.tf,
            bar: CompactFootprint::from(bar),
            closed,
            partial: false,
            seq: Some(self.seq.load(Ordering::Relaxed)),
            source: self.source.lock().clone(),
        }
    }

    fn changes(&self, c: &FootprintChanges) -> FootprintUpdate {
        FootprintUpdate {
            instrument: self.instrument.clone(),
            tf: self.tf,
            bar: CompactFootprint::of_changes(c),
            closed: false,
            partial: true,
            seq: Some(self.seq.load(Ordering::Relaxed)),
            source: self.source.lock().clone(),
        }
    }
}

type LatestMap = Arc<Mutex<HashMap<PumpKey, LatestSlot>>>;

#[derive(Clone)]
struct LatestSlot {
    generation: u64,
    latest: Latest,
}

/// tokio drops an aborted task's future later, after a newer pump of the same key may have started.
fn forget_latest(latest: &LatestMap, key: PumpKey, generation: u64) -> OnDrop<impl FnMut()> {
    let latest = Arc::clone(latest);
    OnDrop(move || {
        let mut l = latest.lock();
        if l.get(&key)
            .is_some_and(|slot| slot.generation == generation)
        {
            l.remove(&key);
        }
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct History {
    pub trades: Vec<Trade>,
    pub seq: u64,
    pub gaps: Gaps,
    pub filling: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Read {
    pub prints: u64,
    pub seq: u64,
    pub aggressor_source: Option<AggressorSource>,
    pub gaps: Gaps,
    pub filling: bool,
}

struct Held {
    trades: Vec<Trade>,
    seq: u64,
    unknown_before: Option<Timestamp>,
    loading: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecordingStats {
    pub instruments: usize,
    pub prints: usize,
    pub tape_bytes: usize,
    pub columns: usize,
    pub book_bytes: usize,
}

struct Archiver {
    archive: Option<Arc<dyn DepthArchive>>,
    provider: String,
    id: InstrumentId,
    calendar: Option<tessera_core::session::SessionCalendar>,
    pruned: Option<chrono::NaiveDate>,
}

impl Archiver {
    fn flush_all(&mut self, flow: &Flow) {
        self.flush_before(flow, i64::MAX);
    }

    fn flush_before(&mut self, flow: &Flow, now: i64) {
        let Some(archive) = &self.archive else { return };
        let minutes = flow.depth.lock().take_minutes(now);
        let Some(&(newest, _)) = minutes.last() else {
            return;
        };
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let prune = self.calendar.and_then(|c| {
            let date = c.trade_date(Timestamp(newest));
            if self.pruned == Some(date) {
                return None;
            }
            self.pruned = Some(date);
            let sessions = c.last_sessions(Timestamp(newest), depth_history::ARCHIVE_SESSIONS);
            sessions.first().map(|s| s.open.0)
        });
        let (archive, provider, id) = (Arc::clone(archive), self.provider.clone(), self.id.clone());
        rt.spawn_blocking(move || {
            for (minute, blob) in minutes {
                if let Err(e) = archive.put(&provider, &id, minute, &blob) {
                    tracing::warn!(%id, error = %e, "a depth minute was not archived");
                }
            }
            if let Some(before) = prune
                && let Err(e) = archive.prune(&provider, &id, before)
            {
                tracing::warn!(%id, error = %e, "old depth minutes were not pruned");
            }
        });
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DepthSpan {
    pub columns: Vec<DepthColumn>,
    pub recorded_from: Option<i64>,
    pub recording: bool,
    pub end: i64,
    pub tick: Option<Decimal>,
}

enum Prep {
    None,
    Feed(MarketPumpGuard),
    Recording(Lingering),
}

struct OnDrop<F: FnMut()>(F);

impl<F: FnMut()> Drop for OnDrop<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

pub struct MarketHub {
    router: Arc<MarketRouter>,
    bus: Arc<EventBus>,
    pumps: Pumps<PumpKey>,
    flows: Mutex<HashMap<InstrumentId, Arc<Flow>>>,
    latest: LatestMap,
    use_ticks: AtomicU64,
    pump_generations: AtomicU64,
    linger_ms: AtomicU64,
    agent_linger_ms: AtomicU64,
    parked: Arc<Parked>,
    closed_bars: FootprintCache,
    models: Mutex<ModelMap>,
    me: Weak<MarketHub>,
    archive: Mutex<Option<Arc<dyn DepthArchive>>>,
    saved: Mutex<Option<Arc<SavedTrades>>>,
    kept: Mutex<HashMap<InstrumentId, MarketPumpGuard>>,
    live: Arc<Liveness>,
}

#[derive(Default)]
struct Liveness {
    heard: Mutex<HashMap<InstrumentId, (tokio::time::Instant, SessionCalendar)>>,
    filling: Mutex<HashMap<String, usize>>,
}

impl Liveness {
    fn heard(&self, id: &InstrumentId, calendar: SessionCalendar) {
        self.heard
            .lock()
            .insert(id.clone(), (tokio::time::Instant::now(), calendar));
    }

    fn marking_fill(&self, provider: &str) -> bool {
        self.filling.lock().get(provider).copied().unwrap_or(0) > 0
    }

    fn begin_fill(&self, provider: &str) {
        *self.filling.lock().entry(provider.to_owned()).or_default() += 1;
    }

    fn end_fill(&self, provider: &str) {
        if let Some(count) = self.filling.lock().get_mut(provider) {
            *count = count.saturating_sub(1);
        }
    }
}

struct FillMark {
    live: Arc<Liveness>,
    provider: String,
}

impl FillMark {
    fn new(live: &Arc<Liveness>, provider: String) -> Self {
        live.begin_fill(&provider);
        Self {
            live: Arc::clone(live),
            provider,
        }
    }
}

impl Drop for FillMark {
    fn drop(&mut self) {
        self.live.end_fill(&self.provider);
    }
}

type ModelMap = HashMap<ModelKey, KeptModel>;

#[derive(Clone, PartialEq, Eq, Hash)]
struct ModelKey {
    provider: String,
    instrument: InstrumentId,
    date: chrono::NaiveDate,
    grouping: Grouping,
}

struct KeptModel {
    model: Arc<BigTradeModel>,
    stale_at: Option<tokio::time::Instant>,
}

#[derive(Default)]
struct Parked {
    held: Mutex<ParkedState>,
}

#[derive(Default)]
struct ParkedState {
    last_ticket: u64,
    feeds: VecDeque<ParkedFeed>,
}

struct ParkedFeed {
    ticket: u64,
    key: PumpKey,
    _guard: MarketPumpGuard,
}

impl ParkedState {
    #[must_use]
    fn admit(&mut self, key: PumpKey, guard: MarketPumpGuard) -> (u64, Vec<ParkedFeed>) {
        self.last_ticket += 1;
        let ticket = self.last_ticket;
        let mut evicted = Vec::new();
        if let Some(i) = self.feeds.iter().position(|f| f.key == key) {
            evicted.extend(self.feeds.remove(i));
        }
        self.feeds.push_back(ParkedFeed {
            ticket,
            key,
            _guard: guard,
        });
        while self.feeds.len() > MAX_AGENT_FEEDS {
            evicted.extend(self.feeds.pop_front());
        }
        (ticket, evicted)
    }

    #[must_use]
    fn take(&mut self, ticket: u64) -> Option<ParkedFeed> {
        let i = self.feeds.iter().position(|f| f.ticket == ticket)?;
        self.feeds.remove(i)
    }
}

impl Parked {
    fn park(self: &Arc<Self>, key: PumpKey, guard: MarketPumpGuard, linger: Duration) {
        let (ticket, evicted) = self.held.lock().admit(key, guard);
        drop(evicted);
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            self.release(ticket);
            return;
        };
        let parked = Arc::downgrade(self);
        rt.spawn(async move {
            tokio::time::sleep(linger).await;
            if let Some(p) = Weak::upgrade(&parked) {
                p.release(ticket);
            }
        });
    }

    fn release(&self, ticket: u64) {
        let released = self.held.lock().take(ticket);
        drop(released);
    }

    fn len(&self) -> usize {
        self.held.lock().feeds.len()
    }
}

impl std::fmt::Debug for MarketHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MarketHub")
            .field("pumps", &self.pumps.len())
            .field("recorded", &self.flows.lock().len())
            .finish_non_exhaustive()
    }
}

pub type MarketPumpGuard = PumpGuard<PumpKey>;

pub struct Lingering {
    guard: Option<MarketPumpGuard>,
    linger: Duration,
    parked: Option<(Arc<Parked>, PumpKey)>,
}

impl std::fmt::Debug for Lingering {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lingering")
            .field("guard", &self.guard)
            .field("linger", &self.linger)
            .finish()
    }
}

impl Drop for Lingering {
    fn drop(&mut self) {
        let Some(guard) = self.guard.take() else {
            return;
        };
        if self.linger.is_zero() {
            return;
        }
        if let Some((parked, key)) = self.parked.take() {
            parked.park(key, guard, self.linger);
            return;
        }
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let linger = self.linger;
            rt.spawn(async move {
                tokio::time::sleep(linger).await;
                drop(guard);
            });
        }
    }
}

fn compact(levels: &[tessera_core::market::DepthLevel]) -> Vec<CompactLevel> {
    levels.iter().map(CompactLevel::from).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pulls {
    Never,
    Since(Timestamp),
}

impl Pulls {
    pub const ALWAYS: Self = Self::Since(Timestamp(i64::MIN));

    pub fn since(floor: Option<Timestamp>) -> Self {
        floor.map_or(Self::Never, Self::Since)
    }

    fn within(self, span: Span) -> Option<Span> {
        match self {
            Self::Never => None,
            Self::Since(floor) => {
                let s = Span::new(span.start.max(floor.0), span.end);
                (!s.is_empty()).then_some(s)
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Reading<'a> {
    router: &'a Arc<MarketRouter>,
    saved: Option<&'a Arc<SavedTrades>>,
    pulls: Pulls,
}

impl Reading<'_> {
    async fn disk(&self, id: &InstrumentId) -> Option<Disk> {
        disk_of(self.router, self.saved?, id).await
    }
}

async fn disk_of(
    router: &MarketRouter,
    saved: &Arc<SavedTrades>,
    id: &InstrumentId,
) -> Option<Disk> {
    let p = router.route(id).ok()?;
    if p.keeps_trade_history() {
        return None;
    }
    let source = source_of(p.as_ref());
    let (_, spec) = router.spec(id).await.ok()?;
    Some(Disk {
        saved: Arc::clone(saved),
        contract: Contract::new(&source.provider, id),
        calendar: spec.sessions,
    })
}

async fn calendar_of(router: &MarketRouter, id: &InstrumentId) -> Option<SessionCalendar> {
    router.spec(id).await.ok().map(|(_, spec)| spec.sessions)
}

async fn unknown_below(
    router: &MarketRouter,
    id: &InstrumentId,
    lo: Option<Timestamp>,
    to: Option<Timestamp>,
    held: Held,
) -> History {
    let hole = held.unknown_before.and_then(|p| {
        let hi = match to.map_or(p, |t| t.min(p)) {
            Timestamp(i64::MAX) => held.trades.last()?.ts.add_nanos(1),
            hi => hi,
        };
        let lo = lo
            .or_else(|| held.trades.first().map(|t| t.ts))
            .unwrap_or(hi);
        (lo < hi).then(|| Span::new(lo.0, hi.0))
    });
    let gaps = match hole {
        Some(h) => Gaps::in_session(calendar_of(router, id).await, [h]),
        None => Gaps::default(),
    };
    let reaches_past_what_is_held = lo.is_none() && held.trades.is_empty();
    History {
        trades: held.trades,
        seq: held.seq,
        filling: held.loading && (!gaps.is_empty() || reaches_past_what_is_held),
        gaps,
    }
}

async fn with_saved(
    reading: Reading<'_>,
    flow: Option<&Arc<Flow>>,
    req: &TradesRequest,
    held: Held,
) -> History {
    let Some(p) = held.unknown_before else {
        return History {
            trades: held.trades,
            seq: held.seq,
            gaps: Gaps::default(),
            filling: false,
        };
    };
    let Some(disk) = reading
        .disk(&req.instrument)
        .await
        .filter(|_| req.limit.is_none_or(|l| held.trades.len() < l))
    else {
        return unknown_below(reading.router, &req.instrument, req.from, req.to, held).await;
    };
    let ceiling = if p.0 == i64::MAX {
        flow.and_then(|f| f.tape.lock().last_ts())
            .map_or_else(Timestamp::now, |t| t.add_nanos(1))
            .0
    } else {
        p.0
    };
    let before = req.to.map_or(ceiling, |t| t.0.min(ceiling));
    let reach = flow.map(|f| f.reach.lock().clone());
    let read = {
        let (d, from, limit) = (disk.clone(), req.from.map(|f| f.0), req.limit);
        let wanted = limit.map(|l| l - held.trades.len());
        tokio::task::spawn_blocking(move || d.stored(from, before, wanted)).await
    };
    let stored = match read {
        Ok(Ok(stored)) => stored,
        Ok(Err(e)) => {
            tracing::warn!(id = %req.instrument, error = %e, "saved trades were not read");
            return unknown_below(reading.router, &req.instrument, req.from, req.to, held).await;
        }
        Err(_) => {
            return unknown_below(reading.router, &req.instrument, req.from, req.to, held).await;
        }
    };
    let on_disk = |t: &Trade| stored.covered.iter().any(|c| c.contains(t.ts.0));
    let (below, above): (Vec<Trade>, Vec<Trade>) = held.trades.into_iter().partition(|t| t.ts < p);
    let source = disk.source();
    let mut trades: Vec<Trade> = below
        .into_iter()
        .filter(|t| !on_disk(t))
        .chain(
            stored
                .rows
                .iter()
                .map(|r| r.trade(&req.instrument, Some(&source))),
        )
        .collect();
    trades.sort_by_key(|t| t.ts);
    trades.extend(above);
    if let Some(l) = req.limit
        && trades.len() > l
    {
        trades.drain(..trades.len() - l);
    }
    let gaps = stored.gaps;
    let mut pulling = false;
    if let (Some(flow), Some(reach)) = (flow, reach) {
        let shown = {
            let mut s = flow.shown.lock();
            s.pin(&disk, stored.scanned);
            s.is_shown()
        };
        let pulled = reading.pulls.within(stored.scanned);
        let askable: Vec<Span> = gaps
            .spans()
            .iter()
            .flat_map(|g| disk::unrefused(&stored.refused, *g))
            .collect();
        let held_back = askable.len() != gaps.spans().len()
            || askable.iter().zip(gaps.spans()).any(|(a, g)| a != g);
        let work = shown
            && !held.loading
            && pulled.is_some_and(|p| reach.next(disk.calendar, &askable, p).is_some());
        let want_from = pulled.map_or(stored.scanned.start, |p| p.start);
        let wanted = {
            let mut r = flow.reach.lock();
            r.hold_back(held_back);
            r.want(Span::new(want_from, ceiling), work)
        };
        if wanted.start {
            disk::spawn_reach(
                flow,
                Arc::clone(reading.router),
                disk,
                req.instrument.clone(),
            );
        }
        pulling = wanted.loading;
    }
    let reaches_past_what_is_held =
        req.from.is_none() && req.limit.is_some_and(|l| trades.len() < l);
    History {
        filling: (!gaps.is_empty() || reaches_past_what_is_held) && (held.loading || pulling),
        trades,
        seq: held.seq,
        gaps,
    }
}

async fn history(
    reading: Reading<'_>,
    flow: Option<&Arc<Flow>>,
    id: &InstrumentId,
    from: Option<Timestamp>,
    to: Option<Timestamp>,
    limit: Option<usize>,
) -> Result<History, MarketError> {
    let router = reading.router;
    let req = TradesRequest {
        instrument: id.clone(),
        from,
        to,
        limit,
    };
    if to.is_none()
        && let Some(flow) = flow
    {
        let settling = {
            let t = flow.tape.lock();
            t.is_recording() && t.complete_since().is_none()
        };
        let began = *flow.began.lock();
        if let Some(began) = began.filter(|_| settling) {
            tokio::time::sleep_until(began + 2 * TRADE_INTERVAL).await;
        }
    }
    if let Some(flow) = flow.filter(|f| f.past.lock().is_active()) {
        let held = recorded(flow, id, from, to, limit);
        return Ok(with_saved(reading, Some(flow), &req, held).await);
    }
    if flow.is_none() && reading.saved.is_some() && !router.route(id)?.keeps_trade_history() {
        let nothing = Held {
            trades: Vec::new(),
            seq: 0,
            unknown_before: Some(to.unwrap_or(Timestamp(i64::MAX))),
            loading: false,
        };
        return Ok(with_saved(reading, None, &req, nothing).await);
    }
    let (seq0, since, recent) = match flow {
        Some(flow) => {
            let t = flow.tape.lock();
            let since = t.complete_since();
            (t.count(), since, t.read_segment(from.max(since), to, limit))
        }
        None => (0, None, Vec::new()),
    };
    let covered = since.is_some_and(|s| from.is_some_and(|f| f >= s))
        || limit.is_some_and(|l| recent.len() >= l);
    let mut out = Vec::new();
    let mut unknown_before = None;
    if !covered {
        let older_to = match since {
            Some(s) => Some(to.map_or(s, |t| t.min(s))),
            None => to,
        };
        let want = limit.map(|l| l - recent.len());
        let req = TradesRequest {
            to: older_to,
            limit: want,
            ..req
        };
        out = match router.get_trades(req).await {
            Ok(t) => t,
            Err(MarketError::Unsupported(_) | MarketError::Unavailable(_)) => {
                unknown_before = Some(older_to.unwrap_or(Timestamp(i64::MAX)));
                flow.map_or_else(Vec::new, |f| f.tape.lock().read(0, from, older_to, want))
            }
            Err(e) => return Err(e),
        };
    }
    let (seq, extra) = match flow {
        Some(flow) => {
            let t = flow.tape.lock();
            (t.count(), t.read(seq0, from, to, None))
        }
        None => (0, Vec::new()),
    };
    let last = out.last().map(|t| t.ts);
    out.extend(recent);
    out.extend(recorded_meanwhile_not_answered(extra, since, last));
    if let Some(l) = limit
        && out.len() > l
    {
        out.drain(..out.len() - l);
    }
    let held = Held {
        trades: out,
        seq,
        unknown_before,
        loading: false,
    };
    Ok(unknown_below(router, id, from, to, held).await)
}

fn recorded(
    flow: &Flow,
    id: &InstrumentId,
    from: Option<Timestamp>,
    to: Option<Timestamp>,
    limit: Option<usize>,
) -> Held {
    let (seq, recent, slices, known, recorded, source) = {
        let t = flow.tape.lock();
        let (slices, known) = {
            let p = flow.past.lock();
            let cut = t.cut();
            (p.slices(&cut), p.known(&cut))
        };
        (
            t.count(),
            t.read_segment(from, to, limit),
            slices,
            known,
            t.aggressor_source(),
            t.source().cloned(),
        )
    };
    let want = limit.map(|l| l.saturating_sub(recent.len()));
    let mut trades = if want == Some(0) {
        Vec::new()
    } else {
        past::trades_of(&slices, from, to, want, id, recorded, source.as_ref())
    };
    trades.extend(recent);
    let unknown_before = match known.from {
        Some(k) => from.is_none_or(|f| f < k).then_some(k),
        None => Some(to.unwrap_or(Timestamp(i64::MAX))),
    };
    Held {
        trades,
        seq,
        unknown_before,
        loading: known.loading,
    }
}

fn recorded_meanwhile_not_answered(
    meanwhile: Vec<Trade>,
    whole_since: Option<Timestamp>,
    answer_last: Option<Timestamp>,
) -> impl Iterator<Item = Trade> {
    let answer_may_hold_them = whole_since.is_none();
    meanwhile
        .into_iter()
        .filter(move |t| !answer_may_hold_them || answer_last.is_none_or(|l| t.ts > l))
}

async fn each_print(
    reading: Reading<'_>,
    flow: Option<&Arc<Flow>>,
    id: &InstrumentId,
    from: Timestamp,
    to: Timestamp,
    open_end: bool,
    mut f: impl FnMut(&Trade),
) -> Result<Read, MarketError> {
    let mut read = Read::default();
    let (mut t, mut step) = (from, CHUNK);
    while t < to || (open_end && t == from) {
        let end = Timestamp(t.0.saturating_add(step));
        let last = end >= to;
        let chunk_to = match (last, open_end) {
            (true, true) => None,
            (true, false) => Some(to),
            (false, _) => Some(end),
        };
        let h = history(reading, flow, id, Some(t), chunk_to, Some(CHUNK_PRINTS)).await?;
        if h.trades.len() >= CHUNK_PRINTS {
            if step <= MIN_CHUNK {
                return Err(MarketError::Unavailable(format!(
                    "more than {CHUNK_PRINTS} prints of {id} within a second at {t}"
                )));
            }
            step = (step / 2).max(MIN_CHUNK);
            continue;
        }
        for p in &h.trades {
            f(p);
        }
        read.prints += h.trades.len() as u64;
        read.seq = h.seq;
        if let Some(p) = h.trades.last() {
            read.aggressor_source = Some(p.aggressor_source);
        }
        let chunk = Span::new(t.0, chunk_to.map_or(i64::MAX, |c| c.0));
        read.gaps = std::mem::take(&mut read.gaps).merged(h.gaps.within(chunk));
        read.filling |= h.filling;
        if last {
            break;
        }
        t = end;
        step = (step * 2).min(CHUNK);
    }
    Ok(read)
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn start_fill(
    router: &Arc<MarketRouter>,
    saved: Option<&Arc<SavedTrades>>,
    flow: &Arc<Flow>,
    id: &InstrumentId,
    generation: u64,
) -> Option<AbortOnDrop> {
    {
        let mut past = flow.past.lock();
        if !past.is_active() {
            return None;
        }
        past.start_fill(generation);
    }
    let (router, weak, id) = (Arc::clone(router), Arc::downgrade(flow), id.clone());
    let saved = saved.cloned();
    let mut rx = Some(flow.trades.subscribe());
    Some(AbortOnDrop(tokio::spawn(async move {
        until_serving(&router, &id).await;
        let filled = once_served(&router, &id, || {
            let rx = rx
                .take()
                .or_else(|| weak.upgrade().map(|f| f.trades.subscribe()));
            let (router, weak, id, saved) = (&router, &weak, &id, &saved);
            async move {
                let rx = rx.ok_or_else(|| {
                    MarketError::InvalidRequest(format!("{id} is no longer recorded"))
                })?;
                let disk = match saved {
                    Some(saved) => disk_of(router, saved, id).await,
                    None => None,
                };
                fill_session(router, disk.as_ref(), weak, rx, id, generation).await
            }
        })
        .await;
        if let Err(e) = filled {
            tracing::info!(%id, error = %e, "the session before the recording was not replayed");
        }
        if let Some(f) = weak.upgrade() {
            f.past.lock().end_fill(generation);
            f.filled.send_modify(|n| *n += 1);
        }
    })))
}

fn serving(router: &MarketRouter, id: &InstrumentId) -> bool {
    router.route(id).is_ok_and(|p| p.prices_flowing())
}

async fn until_serving(router: &MarketRouter, id: &InstrumentId) {
    let mut changes = router.changes();
    while !serving(router, id) {
        tokio::select! {
            () = tokio::time::sleep(SERVED_RETRY) => {}
            _ = changes.changed() => {}
        }
    }
}

async fn once_served<T, F, Fut>(
    router: &MarketRouter,
    id: &InstrumentId,
    mut ask: F,
) -> Result<T, MarketError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, MarketError>>,
{
    let mut failed_while_serving = 0;
    loop {
        match ask().await {
            Err(MarketError::Unavailable(why)) if !serving(router, id) => {
                tracing::debug!(%id, %why, "waiting for the connection to log in");
                until_serving(router, id).await;
            }
            Err(MarketError::Unavailable(why)) if failed_while_serving < SERVED_RETRIES => {
                failed_while_serving += 1;
                tracing::debug!(%id, %why, "asking again shortly");
                tokio::time::sleep(SERVED_AGAIN.delay(failed_while_serving)).await;
            }
            other => return other,
        }
    }
}

async fn spec_once_served(
    router: &MarketRouter,
    id: &InstrumentId,
) -> Option<(Instrument, ContractSpec)> {
    once_served(router, id, || router.spec(id)).await.ok()
}

async fn fill_session(
    router: &MarketRouter,
    disk: Option<&Disk>,
    flow: &Weak<Flow>,
    mut rx: broadcast::Receiver<Arc<Printed>>,
    id: &InstrumentId,
    generation: u64,
) -> Result<(), MarketError> {
    let (_, spec) = router.spec(id).await?;
    let first = |flow: &Weak<Flow>| {
        let f = flow.upgrade()?;
        let t = f.tape.lock();
        if t.generation() == generation {
            t.cut().first
        } else {
            None
        }
    };
    let deadline = tokio::time::Instant::now() + FILL_WAIT;
    let mut first_print = first(flow);
    while first_print.is_none() {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Ok(_) | Err(broadcast::error::RecvError::Lagged(_))) => first_print = first(flow),
            Ok(Err(broadcast::error::RecvError::Closed)) | Err(_) => break,
        }
    }
    drop(rx);
    let join_at = match first_print {
        Some(t) => Timestamp(t),
        None => router
            .quote(id)
            .await
            .map_or_else(|_| Timestamp::now(), |q| just_after(q.ts)),
    };
    let Some(session) = spec
        .sessions
        .last_sessions(Timestamp(join_at.0.saturating_sub(1)), 1)
        .pop()
    else {
        return Ok(());
    };
    let join_at = join_at.min(session.close).0;
    let join_at = join_at - join_at.rem_euclid(NANOS_PER_MICRO);
    loop {
        let gap = {
            let Some(f) = flow.upgrade().filter(|f| f.recording(generation)) else {
                return Ok(());
            };
            f.past.lock().next_gap(generation, session.open.0, join_at)
        };
        let Some((floor, to)) = gap else {
            return Ok(());
        };
        let (span, rows) = fill_step(router, disk, id, floor, to, Timestamp(join_at)).await?;
        let Some(f) = flow.upgrade() else {
            return Ok(());
        };
        let prints: Vec<Print> = rows.iter().map(Print::of_row).collect();
        f.past.lock().commit(generation, span.start, &prints);
    }
}

fn just_after(ts: Timestamp) -> Timestamp {
    Timestamp(ts.0.saturating_add(NANOS_PER_MICRO))
}

async fn fill_step(
    router: &MarketRouter,
    disk: Option<&Disk>,
    id: &InstrumentId,
    floor: i64,
    to: i64,
    now: Timestamp,
) -> Result<(Span, Vec<TickRow>), MarketError> {
    let Some(disk) = disk else {
        let span = Span::new(floor.max(to - FILL_SPAN), to);
        return Ok((span, saved::ask(router, id, span).await?));
    };
    let d = disk.clone();
    let step = tokio::task::spawn_blocking(move || d.fill_step(floor, to))
        .await
        .map_err(|e| MarketError::Unavailable(format!("saved trades were not read: {e}")))?
        .map_err(|e| MarketError::Unavailable(format!("saved trades were not read: {e}")))?;
    let span = match step {
        FillStep::Saved(span, rows) => return Ok((span, rows)),
        FillStep::Ask(span) => span,
    };
    let d = disk.clone();
    let refused = tokio::task::spawn_blocking(move || d.refused(span))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    if disk::unrefused(&refused, span).is_empty() {
        return Err(MarketError::Unsupported(format!(
            "the connection refused the prints of {id} from {} earlier this session",
            Timestamp(span.start)
        )));
    }
    let rows = {
        let _foreground = router.foreground().enter();
        match saved::ask(router, id, span).await {
            Ok(rows) => rows,
            Err(e) => {
                if matches!(e, MarketError::Unsupported(_)) {
                    disk.remember_refused(span);
                }
                return Err(e);
            }
        }
    };
    let (d, c) = (disk.clone(), disk.contract.clone());
    let kept = tokio::task::spawn_blocking(move || {
        let kept = d.saved.save_answer(&c, d.calendar, &rows, span, now);
        (rows, kept)
    })
    .await
    .map_err(|e| MarketError::Unavailable(format!("replayed trades were not saved: {e}")))?;
    if let Err(e) = &kept.1 {
        tracing::warn!(%id, error = %e, "replayed trades were not saved");
    }
    Ok((span, kept.0))
}

fn splice_archived(
    mut archived: Vec<DepthColumn>,
    memory: Vec<DepthColumn>,
    from: i64,
) -> Vec<DepthColumn> {
    let holding_at_from = archived.partition_point(|c| c.t <= from).saturating_sub(1);
    archived.drain(..holding_at_from);
    let Some(last_archived) = archived.last().map(|c| c.t) else {
        return memory;
    };
    archived.extend(memory.into_iter().filter(|c| c.t > last_archived));
    archived
}

async fn bars_since(
    router: &MarketRouter,
    id: &InstrumentId,
    tf: Timeframe,
    from: Timestamp,
    source: DataSource,
) -> Vec<BarUpdate> {
    let req = BarsRequest {
        instrument: id.clone(),
        tf,
        from: Some(from),
        to: None,
        limit: None,
        rth_only: false,
    };
    let read = match router.route(id) {
        Ok(conn) => router.bars_from(&conn, req, BarRead::Through).await,
        Err(e) => Err(e),
    };
    let series = match read {
        Ok(series) => series,
        Err(e) => {
            tracing::warn!(%id, %tf, error = %e, "the bars missed while the feed was down were not read");
            return Vec::new();
        }
    };
    let forming = series
        .last_bar_open
        .then(|| series.bars.len().saturating_sub(1));
    series
        .bars
        .iter()
        .enumerate()
        .filter(|(_, b)| b.t >= from)
        .map(|(i, b)| BarUpdate {
            instrument: id.clone(),
            tf,
            bar: CompactBar::from(b),
            closed: forming != Some(i),
            source: source.clone(),
        })
        .collect()
}

fn publish_trades(
    bus: &EventBus,
    flow: &Flow,
    id: &InstrumentId,
    source: &DataSource,
    batch: Vec<Trade>,
) {
    if batch.is_empty() {
        return;
    }
    let (seq, segment, aggressor_source) = {
        let mut t = flow.tape.lock();
        let mut gone = Vec::new();
        let seq = t.push(&batch, &mut gone);
        if !gone.is_empty() {
            flow.past.lock().absorb(t.generation(), gone);
        }
        (seq, t.generation(), t.aggressor_source())
    };
    if let Some(s) = flow.saving.lock().as_mut() {
        s.push(&batch);
    }
    let first = seq + 1 - batch.len() as u64;
    let big_trades = flow.bigs.lock().on_prints(&batch, first);
    let update = TradesUpdate {
        instrument: id.clone(),
        seq,
        trades: batch.iter().map(CompactTrade::from).collect(),
        aggressor_source,
        source: source.clone(),
        big_trades: (!big_trades.is_empty()).then_some(big_trades),
        segment: Some(segment),
    };
    let _ = flow.trades.send(Arc::new(Printed {
        seq,
        segment,
        source: source.clone(),
        trades: batch,
    }));
    bus.publish(
        names::MARKET_TRADES,
        TopicKey::Instrument(id.clone()),
        &update,
    );
}

fn publish_bigs(
    bus: &EventBus,
    flow: &Flow,
    id: &InstrumentId,
    source: &DataSource,
    big_trades: Vec<BigTrade>,
) {
    if big_trades.is_empty() {
        return;
    }
    let (seq, aggressor_source, segment) = {
        let t = flow.tape.lock();
        (t.count(), t.aggressor_source(), t.generation())
    };
    let update = TradesUpdate {
        instrument: id.clone(),
        seq,
        trades: Vec::new(),
        aggressor_source,
        source: source.clone(),
        big_trades: Some(big_trades),
        segment: Some(segment),
    };
    bus.publish(
        names::MARKET_TRADES,
        TopicKey::Instrument(id.clone()),
        &update,
    );
}

impl MarketHub {
    pub fn new(router: Arc<MarketRouter>, bus: Arc<EventBus>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            router,
            bus,
            pumps: Pumps::new(),
            flows: Mutex::new(HashMap::new()),
            latest: Arc::new(Mutex::new(HashMap::new())),
            use_ticks: AtomicU64::new(0),
            pump_generations: AtomicU64::new(0),
            linger_ms: AtomicU64::new(RECORDING_LINGER.as_millis() as u64),
            agent_linger_ms: AtomicU64::new(AGENT_LINGER.as_millis() as u64),
            parked: Arc::default(),
            closed_bars: FootprintCache::default(),
            models: Mutex::new(HashMap::new()),
            me: me.clone(),
            archive: Mutex::new(None),
            saved: Mutex::new(None),
            kept: Mutex::new(HashMap::new()),
            live: Arc::default(),
        })
    }

    pub fn health(&self, p: &dyn MarketDataProvider) -> ProviderHealth {
        let mut health = p.health();
        if health.status == HealthStatus::Ok {
            if let Some(quiet) = self.quiet_for(&health.provider_id, health.checked_at) {
                health.status = HealthStatus::Degraded;
                health.message = Some(format!(
                    "No data for {} seconds. Reconnecting.",
                    quiet.as_secs()
                ));
            } else if self.live.marking_fill(&health.provider_id) {
                health.status = HealthStatus::Degraded;
                health.message = Some("Reconnected. Filling the gap.".to_owned());
            }
        }
        health
    }

    pub fn begin_fill(&self, provider: &str) {
        self.live.begin_fill(provider);
    }

    pub fn end_fill(&self, provider: &str) {
        self.live.end_fill(provider);
    }

    fn quiet_for(&self, provider: &str, now: Timestamp) -> Option<Duration> {
        let heard = self.live.heard.lock();
        let mut longest: Option<Duration> = None;
        for (id, (at, calendar)) in heard.iter() {
            let Some(quiet) = silent_for(at.elapsed(), calendar.open_for(now)) else {
                continue;
            };
            let Some(routed) = self.router.route(id).ok() else {
                continue;
            };
            if source_of(routed.as_ref()).provider != provider {
                continue;
            }
            if longest.is_none_or(|held| quiet > held) {
                longest = Some(quiet);
            }
        }
        longest
    }

    pub fn keep_recording(&self, wanted: &[InstrumentId]) -> Vec<InstrumentId> {
        let mut kept = self.kept.lock();
        kept.retain(|id, _| wanted.contains(id));
        for id in wanted {
            if kept.contains_key(id) {
                continue;
            }
            match self.acquire(PumpKey::Trades(id.clone())) {
                Ok(guard) => {
                    kept.insert(id.clone(), guard);
                }
                Err(e) => tracing::debug!(instrument = %id, error = %e, "not recording"),
            }
        }
        let mut recording: Vec<InstrumentId> = kept.keys().cloned().collect();
        recording.sort();
        recording
    }

    pub fn router(&self) -> &Arc<MarketRouter> {
        &self.router
    }

    pub fn bus(&self) -> &Arc<EventBus> {
        &self.bus
    }

    pub fn prints_filled(&self, id: &InstrumentId) -> Option<watch::Receiver<u64>> {
        self.flows.lock().get(id).map(|f| f.filled.subscribe())
    }

    pub fn pulling(&self, id: &InstrumentId) -> bool {
        let flow = self.flows.lock().get(id).cloned();
        flow.is_some_and(|f| f.filling())
    }

    pub fn refused(&self, id: &InstrumentId) -> bool {
        let flow = self.flows.lock().get(id).cloned();
        flow.is_some_and(|f| f.reach.lock().is_refused())
    }

    pub fn closed_bars(&self) -> &FootprintCache {
        &self.closed_bars
    }

    pub fn set_depth_archive(&self, archive: Arc<dyn DepthArchive>) {
        *self.archive.lock() = Some(archive);
    }

    pub fn set_saved_trades(&self, saved: Arc<SavedTrades>) {
        *self.saved.lock() = Some(saved);
    }

    pub fn saved_trades(&self) -> Option<Arc<SavedTrades>> {
        self.saved.lock().clone()
    }

    pub async fn depth_history(&self, id: &InstrumentId, from: i64, to: i64) -> DepthSpan {
        let flow = self.recorded(id);
        let (mut columns, first, tick, recording, held) = match &flow {
            Some(f) => {
                let d = f.depth.lock();
                (
                    d.columns(from, to),
                    d.first(),
                    d.tick(),
                    d.is_recording(),
                    d.held_until(),
                )
            }
            None => (Vec::new(), None, None, false, None),
        };
        let archive = self.archive.lock().clone();
        let provider = self.source(id).ok().map(|s| s.provider);
        let mut recorded_from = first;
        if let (Some(archive), Some(provider)) = (archive, provider) {
            let until = first.unwrap_or(to).min(to);
            let minute_before_from = from.div_euclid(MINUTE_NS) * MINUTE_NS - MINUTE_NS;
            if minute_before_from < until {
                let id = id.clone();
                let got = tokio::task::spawn_blocking(move || {
                    let first = archive.first(&provider, &id).ok().flatten().and_then(|m| {
                        let got = archive.get(&provider, &id, m, m + 1).ok()?;
                        let (m, blob) = got.first()?;
                        depth_history::decode_minute(*m, blob).first().map(|c| c.t)
                    });
                    (
                        first,
                        archive.get(&provider, &id, minute_before_from, until),
                    )
                })
                .await;
                if let Ok((archived_first, Ok(minutes))) = got {
                    let archived = minutes
                        .iter()
                        .flat_map(|(m, blob)| depth_history::decode_minute(*m, blob))
                        .filter(|c| c.t < until)
                        .collect();
                    columns = splice_archived(archived, columns, from);
                    recorded_from = match (recorded_from, archived_first) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                }
            }
        }
        let end = if recording {
            held.unwrap_or(to)
        } else {
            columns
                .last()
                .map_or(i64::MIN, |c| c.t + depth_history::COLUMN_NS)
        };
        DepthSpan {
            columns,
            recorded_from,
            recording,
            end,
            tick,
        }
    }

    pub fn big_trade_model(
        &self,
        provider: &str,
        id: &InstrumentId,
        date: chrono::NaiveDate,
        grouping: Grouping,
    ) -> Option<Arc<BigTradeModel>> {
        let key = ModelKey {
            provider: provider.to_owned(),
            instrument: id.clone(),
            date,
            grouping,
        };
        let model = {
            let kept = self.models.lock();
            let k = kept.get(&key)?;
            k.stale_at
                .is_none_or(|d| tokio::time::Instant::now() < d)
                .then(|| Arc::clone(&k.model))?
        };
        let pulled = model.pulling && !self.flows.lock().get(id).is_some_and(|f| f.pulling());
        (!pulled).then_some(model)
    }

    pub fn keep_big_trade_model(
        &self,
        provider: &str,
        id: &InstrumentId,
        date: chrono::NaiveDate,
        grouping: Grouping,
        model: Arc<BigTradeModel>,
        ttl: Option<Duration>,
    ) {
        let key = ModelKey {
            provider: provider.to_owned(),
            instrument: id.clone(),
            date,
            grouping,
        };
        let mut kept = self.models.lock();
        kept.remove(&key);
        if kept.len() >= MAX_RECORDED * 2
            && let Some(oldest) = kept.keys().min_by_key(|k| k.date).cloned()
        {
            kept.remove(&oldest);
        }
        let stale_at = ttl.map(|t| tokio::time::Instant::now() + t);
        kept.insert(key, KeptModel { model, stale_at });
    }

    pub fn pump_count(&self) -> usize {
        self.pumps.len()
    }

    pub fn set_linger(&self, linger: Duration) {
        self.linger_ms
            .store(linger.as_millis() as u64, Ordering::Relaxed);
        self.set_agent_linger(linger);
    }

    pub fn set_agent_linger(&self, linger: Duration) {
        self.agent_linger_ms
            .store(linger.as_millis() as u64, Ordering::Relaxed);
    }

    pub fn agent_feeds(&self) -> usize {
        self.parked.len()
    }

    pub fn acquire(&self, key: PumpKey) -> Result<MarketPumpGuard, MarketError> {
        self.acquire_as(key, Asker::User)
    }

    pub fn acquire_as(&self, key: PumpKey, asker: Asker) -> Result<MarketPumpGuard, MarketError> {
        let guard = self.acquire_pump(key.clone(), asker)?;
        if asker == Asker::User
            && let Some(id) = key.recorded()
            && let Some(f) = self.flows.lock().get(id)
        {
            f.user.store(true, Ordering::Relaxed);
        }
        Ok(guard)
    }

    fn acquire_pump(&self, key: PumpKey, asker: Asker) -> Result<MarketPumpGuard, MarketError> {
        let mut prep = match &key {
            PumpKey::Depth(id, _) => {
                Prep::Feed(self.acquire_pump(PumpKey::Book(id.clone()), asker)?)
            }
            PumpKey::Footprint(id, _, _) => {
                let provider = self.router.route(id)?;
                if !provider.capabilities().order_flow() {
                    return Err(MarketError::Unsupported(format!(
                        "{} offers no footprint for {id}",
                        provider.id()
                    )));
                }
                Prep::Feed(self.acquire_pump(PumpKey::Trades(id.clone()), asker)?)
            }
            PumpKey::Bars(id, _) => match self.router.route(id) {
                Ok(p) if !p.keeps_trade_history() && p.capabilities().order_flow() => self
                    .linger_as(PumpKey::Trades(id.clone()), asker)
                    .map_or(Prep::None, Prep::Recording),
                _ => Prep::None,
            },
            _ => Prep::None,
        };
        let start_key = key.clone();
        let guard = self
            .pumps
            .acquire(key, || self.spawn_pump(&start_key, &mut prep, asker));
        drop(prep);
        guard
    }

    pub fn linger(&self, key: PumpKey) -> Result<Lingering, MarketError> {
        self.linger_as(key, Asker::User)
    }

    pub fn linger_as(&self, key: PumpKey, asker: Asker) -> Result<Lingering, MarketError> {
        let guard = self.acquire_as(key.clone(), asker)?;
        let (linger, parked) = match asker {
            Asker::User => (&self.linger_ms, None),
            Asker::Agent => (&self.agent_linger_ms, Some((Arc::clone(&self.parked), key))),
        };
        Ok(Lingering {
            guard: Some(guard),
            linger: Duration::from_millis(linger.load(Ordering::Relaxed)),
            parked,
        })
    }

    fn record(&self, id: &InstrumentId, asker: Asker) -> Arc<Flow> {
        let by_user = asker == Asker::User;
        let mut flows = self.flows.lock();
        let tick = self.use_ticks.fetch_add(1, Ordering::Relaxed);
        if let Some(f) = flows.get(id) {
            f.last_used_tick.store(tick, Ordering::Relaxed);
            if by_user {
                f.user.store(true, Ordering::Relaxed);
            }
            return Arc::clone(f);
        }
        flows.retain(|_, f| !(f.is_idle() && f.is_empty()));
        loop {
            let bytes: usize = flows.values().map(|f| f.bytes()).sum();
            if flows.len() < MAX_RECORDED && bytes <= RECORDING_BUDGET {
                break;
            }
            let Some(lru) = flows
                .iter()
                .filter(|(_, f)| f.is_idle() && (by_user || !f.user.load(Ordering::Relaxed)))
                .min_by_key(|(_, f)| {
                    (
                        f.user.load(Ordering::Relaxed),
                        f.last_used_tick.load(Ordering::Relaxed),
                    )
                })
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            flows.remove(&lru);
        }
        let f = Arc::new(Flow::new(id));
        f.last_used_tick.store(tick, Ordering::Relaxed);
        f.user.store(by_user, Ordering::Relaxed);
        flows.insert(id.clone(), Arc::clone(&f));
        f
    }

    fn recorded(&self, id: &InstrumentId) -> Option<Arc<Flow>> {
        let flows = self.flows.lock();
        let f = flows.get(id)?;
        f.last_used_tick.store(
            self.use_ticks.fetch_add(1, Ordering::Relaxed),
            Ordering::Relaxed,
        );
        Some(Arc::clone(f))
    }

    fn source(&self, id: &InstrumentId) -> Result<DataSource, MarketError> {
        self.router.route(id).map(|p| source_of(p.as_ref()))
    }

    pub async fn history(
        &self,
        id: &InstrumentId,
        from: Option<Timestamp>,
        to: Option<Timestamp>,
        limit: Option<usize>,
    ) -> Result<History, MarketError> {
        let flow = self.recorded(id);
        let saved = self.saved_trades();
        let reading = Reading {
            router: &self.router,
            saved: saved.as_ref(),
            pulls: Pulls::ALWAYS,
        };
        history(reading, flow.as_ref(), id, from, to, limit).await
    }

    pub async fn each_print(
        &self,
        id: &InstrumentId,
        from: Timestamp,
        to: Timestamp,
        f: impl FnMut(&Trade),
    ) -> Result<Read, MarketError> {
        self.read_prints(id, from, to, Pulls::ALWAYS, f).await
    }

    pub async fn pull_missing(&self, id: &InstrumentId, from: Timestamp, to: Timestamp) -> bool {
        let (Some(flow), Some(saved)) = (self.recorded(id), self.saved_trades()) else {
            return false;
        };
        let Some(disk) = disk_of(&self.router, &saved, id).await else {
            return false;
        };
        let want = Span::new(from.0, to.0);
        disk::pull_after_session_read(&flow, Arc::clone(&self.router), disk, id.clone(), want).await
    }

    pub async fn each_held_print(
        &self,
        id: &InstrumentId,
        from: Timestamp,
        to: Timestamp,
        f: impl FnMut(&Trade),
    ) -> Result<Read, MarketError> {
        self.read_prints(id, from, to, Pulls::Never, f).await
    }

    pub(crate) async fn read_prints(
        &self,
        id: &InstrumentId,
        from: Timestamp,
        to: Timestamp,
        pulls: Pulls,
        f: impl FnMut(&Trade),
    ) -> Result<Read, MarketError> {
        let flow = self.recorded(id);
        let saved = self.saved_trades();
        let reading = Reading {
            router: &self.router,
            saved: saved.as_ref(),
            pulls,
        };
        each_print(reading, flow.as_ref(), id, from, to, false, f).await
    }

    pub async fn trades_snapshot(&self, id: &InstrumentId) -> Result<TradesUpdate, MarketError> {
        let h = self.history(id, None, None, Some(TRADES_SNAPSHOT)).await?;
        let aggressor_source = self
            .recorded(id)
            .and_then(|f| f.tape.lock().aggressor_source())
            .or_else(|| h.trades.last().map(|t| t.aggressor_source));
        let big_trades = self
            .recorded(id)
            .map(|f| f.bigs.lock().recent())
            .unwrap_or_default();
        Ok(TradesUpdate {
            instrument: id.clone(),
            seq: h.seq,
            trades: h.trades.iter().map(CompactTrade::from).collect(),
            aggressor_source,
            source: self.source(id)?,
            big_trades: (!big_trades.is_empty()).then_some(big_trades),
            segment: self.recorded(id).map(|f| f.tape.lock().generation()),
        })
    }

    pub fn depth_snapshot(&self, id: &InstrumentId, levels: u32) -> Option<DepthUpdate> {
        let key = PumpKey::Depth(id.clone(), levels);
        let Some(Latest::Depth(v)) = self.latest.lock().get(&key).map(|slot| slot.latest.clone())
        else {
            return None;
        };
        let (view, seq, ts) = v.as_ref();
        Some(DepthUpdate {
            instrument: id.clone(),
            ts: *ts,
            seq: *seq,
            kind: DepthKind::Snapshot,
            levels,
            bids: compact(&view.bids),
            asks: compact(&view.asks),
            source: self.source(id).ok()?,
        })
    }

    pub fn footprint_snapshot(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        row_ticks: u32,
    ) -> Option<FootprintUpdate> {
        let key = PumpKey::Footprint(id.clone(), tf, row_ticks);
        let latest = self.latest.lock().get(&key).map(|slot| slot.latest.clone());
        match latest? {
            Latest::Forming(f) => {
                let bar = f.builder.lock().current()?;
                Some(f.update(&bar, false))
            }
            Latest::Depth(_) => None,
        }
    }

    pub async fn book_now(&self, id: &InstrumentId, wait: Duration) -> Option<Arc<BookSnapshot>> {
        let mut rx = self.recorded(id)?.book.subscribe();
        let known = |b: &BookState| match b {
            BookState::Known(b) => Some(Arc::clone(&b.book)),
            BookState::Unseen | BookState::Lost { .. } => None,
        };
        if let Some(b) = known(&rx.borrow_and_update()) {
            return Some(b);
        }
        let first = async {
            while rx.changed().await.is_ok() {
                if let Some(b) = known(&rx.borrow_and_update()) {
                    return Some(b);
                }
            }
            None
        };
        tokio::time::timeout(wait, first).await.ok().flatten()
    }

    pub fn recording_stats(&self) -> RecordingStats {
        let flows = self.flows.lock();
        let mut s = RecordingStats {
            instruments: flows.len(),
            ..RecordingStats::default()
        };
        for f in flows.values() {
            let tape = f.tape.lock();
            s.prints += tape.count().min(TAPE_MAX as u64) as usize;
            s.tape_bytes += tape.bytes();
            let d = f.depth.lock();
            s.columns += d.len();
            s.book_bytes += d.bytes();
        }
        s
    }

    fn spawn_pump(
        &self,
        key: &PumpKey,
        prep: &mut Prep,
        asker: Asker,
    ) -> Result<JoinHandle<()>, MarketError> {
        let bus = Arc::clone(&self.bus);
        let router = &self.router;
        Ok(match key {
            PumpKey::Quotes(id) => {
                let ids = vec![id.clone()];
                let mut s = follow(router, id, move |r, _| r.subscribe_quotes(&ids))?;
                let (router, id, live) = (Arc::clone(router), id.clone(), Arc::clone(&self.live));
                tokio::spawn(async move {
                    let calendar = router.spec(&id).await.ok().map(|(_, spec)| spec.sessions);
                    let publish = |q: &Quote| {
                        bus.publish(names::MARKET_QUOTES, TopicKey::Instrument(id.clone()), q);
                    };
                    let mut served = serving(&router, &id);
                    loop {
                        tokio::select! {
                            q = s.next() => match q {
                                Some(q) => {
                                    if let Some(calendar) = calendar {
                                        live.heard(&id, calendar);
                                    }
                                    publish(&q);
                                }
                                None => break,
                            },
                            () = until_serving(&router, &id), if !served => {
                                served = true;
                                if let Ok(q) = router.quote(&id).await {
                                    publish(&q);
                                }
                            }
                        }
                    }
                })
            }
            PumpKey::Bars(id, tf) => {
                let (id, tf) = (id.clone(), *tf);
                let at = id.clone();
                let mut s = follow_marked(router, &id, move |r, source| {
                    Ok(r.subscribe_bars(&at, tf)?
                        .map(move |lb| BarUpdate {
                            instrument: lb.instrument,
                            tf: lb.tf,
                            bar: CompactBar::from(&lb.bar),
                            closed: lb.closed,
                            source: source.clone(),
                        })
                        .boxed())
                })?;
                let recording = match std::mem::replace(prep, Prep::None) {
                    Prep::Recording(r) => Some(r),
                    other => {
                        *prep = other;
                        None
                    }
                };
                let router = Arc::clone(router);
                let live = Arc::clone(&self.live);
                tokio::spawn(async move {
                    let _recording = recording;
                    let calendar = router.spec(&id).await.ok().map(|(_, spec)| spec.sessions);
                    let mut last: Option<i64> = None;
                    while let Some(followed) = s.next().await {
                        let updates = match (followed, last) {
                            (Followed::Item(update), _) => {
                                if let Some(calendar) = calendar {
                                    live.heard(&id, calendar);
                                }
                                vec![update]
                            }
                            (Followed::Reopened(source), Some(from)) => {
                                let _filling = FillMark::new(&live, source.provider.clone());
                                bars_since(&router, &id, tf, Timestamp(from), source).await
                            }
                            (Followed::Lost | Followed::Reopened(_), _) => continue,
                        };
                        for update in updates {
                            last = Some(update.bar.0);
                            bus.publish(
                                names::MARKET_BARS,
                                TopicKey::Bars(id.clone(), tf),
                                &update,
                            );
                        }
                    }
                })
            }
            PumpKey::Trades(id) => self.spawn_trades(id, asker)?,
            PumpKey::Book(id) => self.spawn_book(id, asker)?,
            PumpKey::Depth(id, levels) => self.spawn_depth(id, *levels, prep, asker)?,
            PumpKey::Footprint(id, tf, rows) => match prep {
                Prep::Feed(_) => self.spawn_footprint(id, *tf, *rows, prep, asker)?,
                Prep::None | Prep::Recording(_) => {
                    return Err(MarketError::Unavailable(format!(
                        "no footprint source for {id}"
                    )));
                }
            },
        })
    }

    fn spawn_trades(&self, id: &InstrumentId, asker: Asker) -> Result<JoinHandle<()>, MarketError> {
        let mut source = self.source(id)?;
        let replays = !self.router.route(id)?.keeps_trade_history();
        let ids = vec![id.clone()];
        let mut s = tokio_stream::StreamExt::chunks_timeout(
            follow_marked(&self.router, id, move |r, _| r.subscribe_trades(&ids))?,
            TRADE_BATCH,
            TRADE_INTERVAL,
        )
        .boxed();
        let flow = self.record(id, asker);
        if replays {
            flow.past.lock().activate();
        }
        let generation = Arc::new(AtomicU64::new(flow.begin_segment(source.clone())));
        *flow.began.lock() = Some(tokio::time::Instant::now());
        let bus = Arc::clone(&self.bus);
        let id = id.clone();
        let (router, me, live) = (
            Arc::clone(&self.router),
            self.me.clone(),
            Arc::clone(&self.live),
        );
        let saved = self.saved_trades().filter(|_| replays);
        let mut _fill = start_fill(
            &router,
            saved.as_ref(),
            &flow,
            &id,
            generation.load(Ordering::Relaxed),
        );
        let shown = flow.show();
        Ok(tokio::spawn(async move {
            let _shown = shown;
            let (ending, segment) = (Arc::clone(&flow), Arc::clone(&generation));
            let _end = OnDrop(move || ending.end_segment(segment.load(Ordering::Relaxed)));
            let mut spec = router.spec(&id).await.ok();
            let start_bigs = |(instrument, spec): &(Instrument, ContractSpec)| {
                let contract = crate::orderflow::tools::contract_of(instrument, spec);
                flow.bigs.lock().start(contract);
            };
            if let Some(found) = &spec {
                start_bigs(found);
            }
            let start_saving = |source: &DataSource, spec: Option<&(Instrument, ContractSpec)>| {
                let (Some(saved), Some((instrument, spec))) = (&saved, spec) else {
                    return;
                };
                flow.start_saving(Disk {
                    saved: Arc::clone(saved),
                    contract: Contract::new(&source.provider, &id),
                    calendar: spec.sessions,
                });
                let (saved, provider) = (Arc::clone(saved), source.provider.clone());
                let (instrument, spec) = (instrument.clone(), spec.clone());
                tokio::task::spawn_blocking(move || {
                    saved.remember_contract(&provider, &instrument, &spec);
                });
            };
            start_saving(&source, spec.as_ref());
            let mut awaiting_spec = spec.is_none();
            let late_spec = spec_once_served(&router, &id);
            tokio::pin!(late_spec);
            let mut clock = tokio::time::interval(bigs::CLOCK_EVERY);
            clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    fed = s.next() => {
                        let Some(fed) = fed else { break };
                        let mut batch = Vec::with_capacity(fed.len());
                        for f in fed {
                            match f {
                                Followed::Item(t) => {
                                    if let Some((_, contract)) = &spec {
                                        live.heard(&id, contract.sessions);
                                    }
                                    batch.push(t);
                                }
                                Followed::Lost => {
                                    publish_trades(&bus, &flow, &id, &source, std::mem::take(&mut batch));
                                    flow.end_segment(generation.load(Ordering::Relaxed));
                                    _fill = None;
                                    flow.bigs.lock().restart();
                                }
                                Followed::Reopened(src) => {
                                    publish_trades(&bus, &flow, &id, &source, std::mem::take(&mut batch));
                                    flow.end_segment(generation.load(Ordering::Relaxed));
                                    let began = flow.begin_segment(src.clone());
                                    generation.store(began, Ordering::Relaxed);
                                    start_saving(&src, spec.as_ref());
                                    flow.reach.lock().reopen();
                                    _fill = start_fill(&router, saved.as_ref(), &flow, &id, began);
                                    flow.bigs.lock().restart();
                                    *flow.began.lock() = Some(tokio::time::Instant::now());
                                    source = src;
                                }
                            }
                        }
                        publish_trades(&bus, &flow, &id, &source, batch);
                    }
                    found = &mut late_spec, if awaiting_spec => {
                        awaiting_spec = false;
                        if let Some(found) = &found {
                            start_bigs(found);
                            start_saving(&source, Some(found));
                        }
                        spec = found;
                    }
                    _ = clock.tick() => {
                        let bigs = flow.bigs.lock().on_clock();
                        publish_bigs(&bus, &flow, &id, &source, bigs);
                        if let Some(s) = flow.saving.lock().as_mut() {
                            s.flush();
                        }
                    }
                }
                let wanted = flow.bigs.lock().wants_model(tokio::time::Instant::now());
                if let (Some(at), Some(hub)) = (wanted, me.upgrade()) {
                    let (flow, id) = (Arc::clone(&flow), id.clone());
                    tokio::spawn(async move {
                        let m = crate::orderflow::tools::big_trade_model(
                            &hub,
                            &id,
                            at,
                            Grouping::default(),
                        )
                        .await;
                        flow.bigs.lock().set_model(m);
                    });
                }
            }
        }))
    }

    fn spawn_book(&self, id: &InstrumentId, asker: Asker) -> Result<JoinHandle<()>, MarketError> {
        let mut source = self.source(id)?;
        let at = id.clone();
        let mut s = follow_marked(&self.router, id, move |r, _| {
            let p = r.route(&at)?;
            let Some(depth) = p.capabilities().depth_levels else {
                return Err(MarketError::Unsupported(format!(
                    "{} offers no depth for {at}",
                    p.id()
                )));
            };
            r.subscribe_depth(&at, depth.min(depth_history::LEVELS as u32))
        })?;
        let flow = self.record(id, asker);
        let archive = self.archive.lock().clone();
        flow.depth.lock().set_archived(archive.is_some());
        let archiver = Arc::new(Mutex::new(Archiver {
            archive,
            provider: source.provider.clone(),
            id: id.clone(),
            calendar: None,
            pruned: None,
        }));
        let (router, id) = (Arc::clone(&self.router), id.clone());
        Ok(tokio::spawn(async move {
            let ending = Arc::clone(&flow);
            let _end = OnDrop(move || {
                ending.book.send_replace(BookState::Unseen);
            });
            let generation = Arc::new(AtomicU64::new(flow.depth.lock().begin()));
            let seen: Arc<Mutex<Option<(Timestamp, tokio::time::Instant)>>> = Arc::default();
            let stop = {
                let (flow, seen, generation, archiver) = (
                    Arc::clone(&flow),
                    Arc::clone(&seen),
                    Arc::clone(&generation),
                    Arc::clone(&archiver),
                );
                move |floor: Option<Timestamp>| {
                    let held = seen.lock().take().map(|(ts, when)| {
                        ts.add_nanos(i64::try_from(when.elapsed().as_nanos()).unwrap_or(i64::MAX))
                    });
                    let at = held.max(floor);
                    flow.depth.lock().end(
                        generation.load(Ordering::Relaxed),
                        at.map_or(i64::MIN, |t| t.0),
                    );
                    archiver.lock().flush_all(&flow);
                    at
                }
            };
            let recording = OnDrop({
                let stop = stop.clone();
                move || {
                    stop(None);
                }
            });
            if let Ok((_, spec)) = router.spec(&id).await {
                flow.depth.lock().set_tick(spec.tick_size.0);
                archiver.lock().calendar = Some(spec.sessions);
            }
            let mut opening = 0u64;
            let mut lost = false;
            let lose = |floor: Option<Timestamp>, source: &DataSource, opening: u64| {
                let at = stop(floor);
                flow.book.send_if_modified(|held| {
                    let BookState::Known(known) = held else {
                        return false;
                    };
                    *held = BookState::Lost {
                        ts: at.unwrap_or(known.book.ts),
                        source: source.clone(),
                        opening,
                    };
                    true
                });
            };
            while let Some(b) = s.next().await {
                match b {
                    Followed::Item(b) if b.bids.is_empty() && b.asks.is_empty() => {
                        if !std::mem::replace(&mut lost, true) {
                            lose(Some(b.ts), &source, opening);
                        }
                    }
                    Followed::Item(b) => {
                        if std::mem::take(&mut lost) {
                            generation.store(flow.depth.lock().begin(), Ordering::Relaxed);
                            opening += 1;
                        }
                        let b = Arc::new(b);
                        *seen.lock() = Some((b.ts, tokio::time::Instant::now()));
                        flow.book.send_replace(BookState::Known(Booked {
                            book: Arc::clone(&b),
                            source: source.clone(),
                            opening,
                        }));
                        flow.depth.lock().on_book(&b);
                        archiver.lock().flush_before(&flow, b.ts.0);
                    }
                    Followed::Lost => {
                        if !std::mem::replace(&mut lost, true) {
                            lose(None, &source, opening);
                        }
                    }
                    Followed::Reopened(src) => {
                        if !std::mem::replace(&mut lost, true) {
                            lose(None, &source, opening);
                        }
                        archiver.lock().provider = src.provider.clone();
                        source = src;
                    }
                }
            }
            drop(recording);
        }))
    }

    fn spawn_depth(
        &self,
        id: &InstrumentId,
        levels: u32,
        prep: &mut Prep,
        asker: Asker,
    ) -> Result<JoinHandle<()>, MarketError> {
        let Prep::Feed(feed) = std::mem::replace(prep, Prep::None) else {
            return Err(MarketError::Unavailable(format!("no book feed for {id}")));
        };
        let mut rx = self.record(id, asker).book.subscribe();
        rx.mark_changed();
        let key = PumpKey::Depth(id.clone(), levels);
        let latest = Arc::clone(&self.latest);
        latest.lock().remove(&key);
        let generation = self.pump_generations.fetch_add(1, Ordering::Relaxed);
        let (bus, id) = (Arc::clone(&self.bus), id.clone());
        Ok(tokio::spawn(async move {
            let _feed = feed;
            let _forget = forget_latest(&latest, key.clone(), generation);
            let n = levels as usize;
            let mut view: Option<View> = None;
            let mut opening = None;
            let mut seq = 0u64;
            let mut held: Option<(Timestamp, DataSource)> = None;
            let mut beat = tokio::time::Instant::now() + DEPTH_HEARTBEAT;
            loop {
                let standing = view
                    .as_ref()
                    .is_some_and(|v| !(v.bids.is_empty() && v.asks.is_empty()));
                tokio::select! {
                    r = rx.changed() => if r.is_err() { break },
                    () = tokio::time::sleep_until(beat), if standing => {
                        if let Some((ts, source)) = &held {
                            let update = DepthUpdate {
                                instrument: id.clone(),
                                ts: *ts,
                                seq,
                                kind: DepthKind::Heartbeat,
                                levels,
                                bids: Vec::new(),
                                asks: Vec::new(),
                                source: source.clone(),
                            };
                            bus.publish(
                                names::MARKET_DEPTH,
                                TopicKey::Depth(id.clone(), levels),
                                &update,
                            );
                        }
                        beat = tokio::time::Instant::now() + DEPTH_HEARTBEAT;
                        continue;
                    }
                }
                let (next, ts, source, from) = match rx.borrow_and_update().clone() {
                    BookState::Unseen => continue,
                    BookState::Known(b) => (View::of(&b.book, n), b.book.ts, b.source, b.opening),
                    BookState::Lost {
                        ts,
                        source,
                        opening,
                    } => (View::default(), ts, source, opening),
                };
                if opening.replace(from) != Some(from) {
                    view = None;
                }
                let (kind, bids, asks) = match &view {
                    Some(v) if *v == next => continue,
                    Some(v) => (
                        DepthKind::Delta,
                        depth::diff(&v.bids, &next.bids),
                        depth::diff(&v.asks, &next.asks),
                    ),
                    None => (
                        DepthKind::Snapshot,
                        compact(&next.bids),
                        compact(&next.asks),
                    ),
                };
                seq += 1;
                latest.lock().insert(
                    key.clone(),
                    LatestSlot {
                        generation,
                        latest: Latest::Depth(Arc::new((next.clone(), seq, ts))),
                    },
                );
                let update = DepthUpdate {
                    instrument: id.clone(),
                    ts,
                    seq,
                    kind,
                    levels,
                    bids,
                    asks,
                    source: source.clone(),
                };
                bus.publish(
                    names::MARKET_DEPTH,
                    TopicKey::Depth(id.clone(), levels),
                    &update,
                );
                view = Some(next);
                held = Some((ts, source));
                tokio::time::sleep(DEPTH_INTERVAL).await;
                beat = tokio::time::Instant::now() + DEPTH_HEARTBEAT - DEPTH_INTERVAL;
            }
        }))
    }

    fn spawn_footprint(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        row_ticks: u32,
        prep: &mut Prep,
        asker: Asker,
    ) -> Result<JoinHandle<()>, MarketError> {
        let source = self.source(id)?;
        let Prep::Feed(feed) = std::mem::replace(prep, Prep::None) else {
            return Err(MarketError::Unavailable(format!("no trade feed for {id}")));
        };
        let flow = self.record(id, asker);
        let mut rx = flow.trades.subscribe();
        let mut filled = flow.filled.subscribe();
        let mut segment = flow.tape.lock().generation();
        let key = PumpKey::Footprint(id.clone(), tf, row_ticks);
        let latest = Arc::clone(&self.latest);
        latest.lock().remove(&key);
        let generation = self.pump_generations.fetch_add(1, Ordering::Relaxed);
        let (bus, router, id) = (Arc::clone(&self.bus), Arc::clone(&self.router), id.clone());
        let saved = self.saved_trades();
        Ok(tokio::spawn(async move {
            let _feed = feed;
            let _forget = forget_latest(&latest, key.clone(), generation);
            let Some((_, spec)) = spec_once_served(&router, &id).await else {
                return;
            };
            let row = Price(spec.tick_size.0 * Decimal::from(row_ticks.max(1)));
            let topic_key = TopicKey::Id(footprint_key(&id, tf, row_ticks));
            let forming = Arc::new(Forming {
                instrument: id.clone(),
                tf,
                source: Mutex::new(source),
                builder: Mutex::new(FootprintBuilder::new(tf, spec.sessions, row)),
                seq: AtomicU64::new(0),
            });
            let publish = |u: &FootprintUpdate| {
                bus.publish(names::MARKET_FOOTPRINT, topic_key.clone(), u);
            };
            let rebuild = async |from: Option<Timestamp>| {
                let mut b = FootprintBuilder::new(tf, spec.sessions, row);
                let last = flow.tape.lock().last_ts();
                let quoted = router.quote(&id).await.ok().map(|q| q.ts);
                let now = last.max(quoted).unwrap_or_else(Timestamp::now);
                let key = from.unwrap_or_else(|| spec.sessions.bucket_start(now, tf));
                let start = bar_range(spec.sessions, tf, key).0;
                let mut closed = Vec::new();
                let reading = Reading {
                    router: &router,
                    saved: saved.as_ref(),
                    pulls: Pulls::ALWAYS,
                };
                let read = each_print(reading, Some(&flow), &id, start, now, true, |t| {
                    closed.extend(b.push(t));
                })
                .await;
                let partial = read.as_ref().map_or(true, |r| !r.gaps.is_empty());
                (b, read.map_or(0, |r| r.seq), closed, partial)
            };
            let (b, mut seen, _, mut partial) = rebuild(None).await;
            *forming.builder.lock() = b;
            forming.seq.store(seen, Ordering::Relaxed);
            latest.lock().insert(
                key.clone(),
                LatestSlot {
                    generation,
                    latest: Latest::Forming(Arc::clone(&forming)),
                },
            );
            let mut sent: Option<Timestamp> = None;
            let mut dirty = true;
            let mut next = tokio::time::Instant::now();
            loop {
                let mut again = false;
                tokio::select! {
                    r = rx.recv() => match r {
                        Ok(batch) if batch.segment == segment => {
                            if batch.seq <= seen {
                                continue;
                            }
                            let mut closed = Vec::new();
                            {
                                let mut b = forming.builder.lock();
                                for t in &batch.trades {
                                    closed.extend(b.push(t));
                                }
                            }
                            seen = batch.seq;
                            forming.seq.store(seen, Ordering::Relaxed);
                            for c in &closed {
                                publish(&forming.update(c, true));
                            }
                            dirty = true;
                        }
                        r @ (Ok(_) | Err(broadcast::error::RecvError::Lagged(_))) => {
                            if let Ok(batch) = r {
                                segment = batch.segment;
                                *forming.source.lock() = batch.source.clone();
                            }
                            again = true;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    Ok(()) = filled.changed() => again = partial,
                    () = tokio::time::sleep_until(next), if dirty => {
                        let update = {
                            let mut b = forming.builder.lock();
                            let t = b.current_t();
                            if t.is_some() && t != sent {
                                sent = t;
                                b.take_changes();
                                b.current().map(|bar| forming.update(&bar, false))
                            } else {
                                b.take_changes().map(|c| forming.changes(&c))
                            }
                        };
                        if let Some(u) = update {
                            publish(&u);
                        }
                        dirty = false;
                        next = tokio::time::Instant::now() + FOOTPRINT_INTERVAL;
                    }
                }
                if again {
                    let from = forming.builder.lock().current_t();
                    let (b, s, closed, p) = rebuild(from).await;
                    *forming.builder.lock() = b;
                    seen = s;
                    partial = p;
                    forming.seq.store(seen, Ordering::Relaxed);
                    for c in &closed {
                        publish(&forming.update(c, true));
                    }
                    sent = None;
                    dirty = true;
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::Qty;
    use tessera_core::market::Aggressor;

    fn print(t: i64) -> Trade {
        Trade {
            instrument: InstrumentId::new("ESZ6.CME").unwrap(),
            ts: Timestamp(t),
            price: Price(Decimal::from(6000)),
            size: Qty::from(1),
            aggressor: Aggressor::Buy,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        }
    }

    fn times(prints: impl Iterator<Item = Trade>) -> Vec<i64> {
        prints.map(|t| t.ts.0).collect()
    }

    #[test]
    fn a_new_pump_keeps_the_prints_of_the_one_it_replaced_whose_cleanup_comes_late() {
        let id = InstrumentId::new("ESZ6.CME").unwrap();
        let flow = Flow::new(&id);
        flow.past.lock().activate();
        let source = DataSource {
            provider: "rithmic".into(),
        };
        let old = flow.begin_segment(source.clone());
        let mut recorded = Vec::new();
        flow.tape
            .lock()
            .push(&[print(1_000), print(2_000)], &mut recorded);
        let new = flow.begin_segment(source);
        flow.end_segment(old);
        assert_ne!(old, new);
        assert_eq!(
            flow.past.lock().len(),
            2,
            "the old segment's prints are kept"
        );
        assert!(flow.recording(new), "the new pump records on");
    }

    fn column(t: i64) -> DepthColumn {
        DepthColumn {
            t,
            ended: false,
            cells: Vec::new(),
        }
    }

    fn column_times(columns: &[DepthColumn]) -> Vec<i64> {
        columns.iter().map(|c| c.t).collect()
    }

    #[test]
    fn archived_depth_starts_at_the_column_holding_at_from_and_memory_follows_it() {
        let archived = || vec![column(10), column(20), column(30)];
        let memory = || vec![column(30), column(40)];
        let spliced = |from| column_times(&splice_archived(archived(), memory(), from));
        assert_eq!(spliced(25), [20, 30, 40]);
        assert_eq!(spliced(20), [20, 30, 40]);
        assert_eq!(spliced(5), [10, 20, 30, 40]);
        assert_eq!(
            column_times(&splice_archived(Vec::new(), memory(), 25)),
            [30, 40]
        );
    }

    #[test]
    fn prints_recorded_during_a_read_skip_only_what_the_answer_may_hold() {
        let meanwhile = || vec![print(9), print(10), print(11)];
        assert_eq!(
            times(recorded_meanwhile_not_answered(
                meanwhile(),
                None,
                Some(Timestamp(10))
            )),
            [11]
        );
        assert_eq!(
            times(recorded_meanwhile_not_answered(meanwhile(), None, None)),
            [9, 10, 11]
        );
        assert_eq!(
            times(recorded_meanwhile_not_answered(
                meanwhile(),
                Some(Timestamp(5)),
                Some(Timestamp(10))
            )),
            [9, 10, 11]
        );
    }
}
