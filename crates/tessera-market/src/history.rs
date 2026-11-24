use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tessera_core::backoff::Backoff;
use tessera_core::clock::SharedClock;
use tessera_core::instrument::ContractSpec;
use tessera_core::market::Bar;
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_DAY, NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::timeframe::TimeUnit;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_store::bars::{BarStore, SeriesKey, Span, holes};
use tokio::sync::{Notify, broadcast};
use tracing::{debug, info, warn};

use crate::aggregate::aggregate;
use crate::provider::{BarSeries, BarsRequest, MarketDataProvider, MarketError};
use crate::router::MarketRouter;

pub const SETTLE: i64 = 2 * NANOS_PER_MINUTE;

pub const FOREGROUND_MINUTES: i64 = 12_000;

pub const FOREGROUND_CHUNK_MINUTES: i64 = 9_000;

pub const FOREGROUND_SECONDS: i64 = 54_000;

pub const FOREGROUND_CHUNK_SECONDS: i64 = 9_000;

pub const FILL_SESSIONS_PER_REQUEST: usize = 3;

pub const FILL_EMPTY_STOP: u32 = 2;

pub const FILL_PAUSE: Duration = Duration::from_millis(250);

pub const FILL_BACKOFF: Backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));

pub const MAX_WIDENINGS: usize = 3;

pub const CHART_MAX_BARS: usize = 50_000;

pub const TAIL_FRESH: Duration = Duration::from_secs(5);

pub const UNTRUSTED_EMPTY_WITHIN_NS: i64 = 14 * NANOS_PER_DAY;

pub fn fill_sessions(tf: Timeframe) -> usize {
    if tf.base() != Some(Timeframe::M1) {
        return 0;
    }
    match tf.minutes() {
        ..5 => 30,
        5..15 => 120,
        _ => 250,
    }
}

pub trait BarArchive: Send + Sync + std::fmt::Debug + 'static {
    fn write(
        &self,
        key: SeriesKey<'_>,
        bars: &[Bar],
        block_of: &dyn Fn(Timestamp) -> i64,
        covered: Option<Span>,
    ) -> Result<(), String>;
    fn read(&self, key: SeriesKey<'_>, from: i64, to: i64) -> Result<Vec<Bar>, String>;
    fn covered(&self, key: SeriesKey<'_>) -> Result<Vec<Span>, String>;
    fn forget_before(&self, key: SeriesKey<'_>, t: i64) -> Result<usize, String>;
}

impl BarArchive for BarStore {
    fn write(
        &self,
        key: SeriesKey<'_>,
        bars: &[Bar],
        block_of: &dyn Fn(Timestamp) -> i64,
        covered: Option<Span>,
    ) -> Result<(), String> {
        BarStore::write(self, key, bars, block_of, covered).map_err(|e| e.to_string())
    }

    fn read(&self, key: SeriesKey<'_>, from: i64, to: i64) -> Result<Vec<Bar>, String> {
        BarStore::read(self, key, from, to).map_err(|e| e.to_string())
    }

    fn covered(&self, key: SeriesKey<'_>) -> Result<Vec<Span>, String> {
        BarStore::covered(self, key).map_err(|e| e.to_string())
    }

    fn forget_before(&self, key: SeriesKey<'_>, t: i64) -> Result<usize, String> {
        BarStore::forget_before(self, key, t).map_err(|e| e.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Read {
    Through,
    Recent,
    Kept,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryKept {
    pub instrument: InstrumentId,
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    pub filling: bool,
}

pub type Publish = Arc<dyn Fn(HistoryKept) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BarsWritten {
    pub source: String,
    pub instrument: InstrumentId,
    pub base: Timeframe,
    pub from: Timestamp,
    pub to: Timestamp,
}

const WRITTEN_FANOUT: usize = 256;

pub fn settle_edge(cal: SessionCalendar, tf: Timeframe, now: Timestamp) -> Timestamp {
    match Base::of(tf) {
        Some(base) => Timestamp(base.settled_before(cal, now)),
        None => Timestamp(now.0 - SETTLE),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Base {
    Second,
    Minute,
    Daily,
}

impl Base {
    fn of(tf: Timeframe) -> Option<Self> {
        if tf.unit() == TimeUnit::Second {
            return Some(Self::Second);
        }
        match tf.base()? {
            Timeframe::D1 => Some(Self::Daily),
            _ => Some(Self::Minute),
        }
    }

    fn tf(self) -> Timeframe {
        match self {
            Self::Second => Timeframe::S1,
            Self::Minute => Timeframe::M1,
            Self::Daily => Timeframe::D1,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Second => "1s",
            Self::Minute => "1m",
            Self::Daily => "1D",
        }
    }

    fn intraday(self) -> bool {
        self != Self::Daily
    }

    fn block(self, cal: SessionCalendar, t: Timestamp) -> i64 {
        use chrono::Datelike;
        let d = cal.trade_date(t);
        match self {
            Self::Second | Self::Minute => {
                i64::from(d.year()) * 10_000 + i64::from(d.month() * 100 + d.day())
            }
            Self::Daily => i64::from(d.year()),
        }
    }

    fn settled_before(self, cal: SessionCalendar, now: Timestamp) -> i64 {
        match self {
            Self::Second | Self::Minute => cal.bucket_start(now, Timeframe::M1).0 - SETTLE,
            Self::Daily => label_time(cal, cal.prev_trade_date(cal.trade_date(now))).0,
        }
    }

    fn foreground_reach(self, cal: SessionCalendar, missing: &[Span]) -> bool {
        let minutes: i64 = missing.iter().map(|h| trading_minutes(cal, *h)).sum();
        match self {
            Self::Second => minutes * 60 <= FOREGROUND_SECONDS,
            Self::Minute => minutes <= FOREGROUND_MINUTES,
            Self::Daily => true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Series {
    source: String,
    instrument: InstrumentId,
    base: Base,
    earliest: i64,
}

impl Series {
    fn any_time(source: &str, instrument: &InstrumentId, base: Base) -> Self {
        Self {
            source: source.to_owned(),
            instrument: instrument.clone(),
            base,
            earliest: i64::MIN,
        }
    }

    fn own(&self, bars: &mut Vec<Bar>) {
        bars.retain(|b| b.t.0 >= self.earliest);
    }

    fn key(&self) -> SeriesKey<'_> {
        SeriesKey {
            source: &self.source,
            instrument: self.instrument.as_str(),
            series: self.base.name(),
        }
    }
}

fn label_time(cal: SessionCalendar, day: chrono::NaiveDate) -> Timestamp {
    tessera_core::time::local_to_timestamp(cal.tz(), day, 0, 0)
}

#[derive(Debug, Default)]
pub struct Gate {
    busy: AtomicUsize,
    idle: Notify,
}

impl Gate {
    pub fn enter(&self) -> GateGuard<'_> {
        self.busy.fetch_add(1, Ordering::SeqCst);
        GateGuard(self)
    }

    pub fn busy(&self) -> usize {
        self.busy.load(Ordering::SeqCst)
    }

    pub async fn idle(&self) {
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.busy() == 0 {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Debug)]
pub struct GateGuard<'a>(&'a Gate);

impl Drop for GateGuard<'_> {
    fn drop(&mut self) {
        if self.0.busy.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

#[derive(Clone, Debug)]
struct Tail {
    kept_before: i64,
    at: tokio::time::Instant,
    bars: Vec<Bar>,
}

#[derive(Debug, Default)]
struct Fill {
    wants: HashMap<u64, usize>,
    wake: Arc<Notify>,
    run: Option<u64>,
    filling: bool,
}

pub struct BarCache {
    archive: Arc<dyn BarArchive>,
    clock: SharedClock,
    locks: Mutex<HashMap<Series, Arc<tokio::sync::Mutex<()>>>>,
    tails: Mutex<HashMap<Series, Tail>>,
    tail_locks: Mutex<HashMap<Series, Arc<tokio::sync::Mutex<()>>>>,
    fills: Mutex<HashMap<InstrumentId, Fill>>,
    purged: Mutex<HashSet<Series>>,
    next_want: AtomicU64,
    fill_pause_ms: AtomicU64,
    written: broadcast::Sender<BarsWritten>,
}

impl std::fmt::Debug for BarCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BarCache")
            .field("archive", &self.archive)
            .finish_non_exhaustive()
    }
}

impl BarCache {
    pub fn new(archive: Arc<dyn BarArchive>, clock: SharedClock) -> Arc<Self> {
        Arc::new(Self {
            archive,
            clock,
            locks: Mutex::new(HashMap::new()),
            tails: Mutex::new(HashMap::new()),
            tail_locks: Mutex::new(HashMap::new()),
            fills: Mutex::new(HashMap::new()),
            purged: Mutex::new(HashSet::new()),
            next_want: AtomicU64::new(1),
            fill_pause_ms: AtomicU64::new(FILL_PAUSE.as_millis() as u64),
            written: broadcast::channel(WRITTEN_FANOUT).0,
        })
    }

    pub fn written(&self) -> broadcast::Receiver<BarsWritten> {
        self.written.subscribe()
    }

    pub fn set_fill_pause(&self, pause: Duration) {
        self.fill_pause_ms
            .store(pause.as_millis() as u64, Ordering::Relaxed);
    }

    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&dyn BarArchive) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let archive = Arc::clone(&self.archive);
        tokio::task::spawn_blocking(move || f(archive.as_ref()))
            .await
            .map_err(|e| format!("the bar store failed: {e}"))?
    }

    async fn covered(&self, s: &Series) -> Result<Vec<Span>, String> {
        let s = s.clone();
        self.blocking(move |a| a.covered(s.key())).await
    }

    async fn read(&self, s: &Series, from: i64, to: i64) -> Result<Vec<Bar>, String> {
        let s = s.clone();
        self.blocking(move |a| a.read(s.key(), from.max(s.earliest), to))
            .await
    }

    fn earliest(&self, spec: &ContractSpec) -> i64 {
        use chrono::Datelike;
        let year = self.clock.now().to_datetime().year();
        spec.earliest_bar(year).map_or(i64::MIN, |t| t.0)
    }

    async fn purge(&self, s: &Series) -> Result<(), String> {
        if s.earliest == i64::MIN || self.purged.lock().contains(s) {
            return Ok(());
        }
        let series = s.clone();
        let gone = self
            .blocking(move |a| a.forget_before(series.key(), series.earliest))
            .await?;
        if gone > 0 {
            info!(
                instrument = %s.instrument,
                series = s.base.name(),
                bars = gone,
                before = %Timestamp(s.earliest),
                "the bar store held bars from before the contract could trade; they are gone"
            );
        }
        self.purged.lock().insert(s.clone());
        Ok(())
    }

    async fn keep(
        &self,
        s: &Series,
        cal: SessionCalendar,
        bars: Vec<Bar>,
        known: Option<Span>,
    ) -> Result<(), String> {
        let s = s.clone();
        self.blocking(move |a| {
            let base = s.base;
            a.write(s.key(), &bars, &|t| base.block(cal, t), known)
        })
        .await
    }

    fn lock(&self, s: &Series) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(self.locks.lock().entry(s.clone()).or_default())
    }

    fn tail_lock(&self, s: &Series) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(self.tail_locks.lock().entry(s.clone()).or_default())
    }

    pub async fn get_bars(
        &self,
        conn: &Arc<dyn MarketDataProvider>,
        req: BarsRequest,
        read: Read,
    ) -> Result<BarSeries, MarketError> {
        let Some(base) =
            Base::of(req.tf).filter(|b| conn.capabilities().history_timeframes.contains(&b.tf()))
        else {
            return match read {
                Read::Through | Read::Recent => conn.get_bars(req).await,
                Read::Kept => Ok(empty(&req)),
            };
        };
        if let (Some(f), Some(t)) = (req.from, req.to)
            && f > t
        {
            return Err(MarketError::InvalidRequest("from is after to".into()));
        }
        let (_, spec) = conn.spec(&req.instrument).await?;
        let cal = spec.sessions;
        let series = Series {
            earliest: self.earliest(&spec),
            ..Series::any_time(conn.id(), &req.instrument, base)
        };
        let now = self.clock.now();
        let plan = Plan::new(
            cal,
            base,
            &req,
            now,
            lookback(conn.as_ref(), base),
            series.earliest,
            read,
        );
        let passed = |mut got: BarSeries| {
            series.own(&mut got.bars);
            got
        };
        let out = match self.purge(&series).await {
            Err(e) => Err(Failure::Store(e)),
            Ok(()) => match read {
                Read::Kept => self.kept(&series, cal, &req, &plan).await,
                Read::Through | Read::Recent => {
                    self.through(conn, &series, cal, &req, &plan, now).await
                }
            },
        };
        match out {
            Ok(Some(bars)) => Ok(BarSeries {
                last_bar_open: last_open(cal, req.tf, &bars, now),
                instrument: req.instrument,
                tf: req.tf,
                bars,
            }),
            Ok(None) => match read {
                Read::Through | Read::Recent => conn.get_bars(req).await.map(passed),
                Read::Kept => Ok(empty(&req)),
            },
            Err(Failure::Market(e)) => Err(e),
            Err(Failure::Store(e)) => {
                warn!(error = %e, instrument = %req.instrument, "the bar store failed; asking the connection");
                match read {
                    Read::Through | Read::Recent => conn.get_bars(req).await.map(passed),
                    Read::Kept => Ok(empty(&req)),
                }
            }
        }
    }

    async fn kept(
        &self,
        s: &Series,
        cal: SessionCalendar,
        req: &BarsRequest,
        plan: &Plan,
    ) -> Result<Option<Vec<Bar>>, Failure> {
        let covered = self.covered(s).await.map_err(Failure::Store)?;
        let run = match req.to {
            Some(_) => covered
                .iter()
                .find(|c| c.contains(plan.opens_before.min(plan.kept_before) - 1))
                .copied(),
            None => covered.last().copied(),
        };
        let Some(run) = run else {
            return Ok(None);
        };
        let end = run.end.min(plan.opens_before);
        let start = match req.from {
            Some(_) => plan.first_open,
            None => reach_start(cal, s.base, req.tf, end, plan.limit),
        }
        .max(run.start);
        if start >= end {
            return Ok(None);
        }
        let raw = self.read(s, start, end).await.map_err(Failure::Store)?;
        let mut bars = finish(raw, cal, req);
        if bars
            .first()
            .is_some_and(|b| b.t.0 < run.start && s.base.intraday())
        {
            bars.remove(0);
        }
        Ok(Some(bars))
    }

    async fn through(
        &self,
        conn: &Arc<dyn MarketDataProvider>,
        s: &Series,
        cal: SessionCalendar,
        req: &BarsRequest,
        plan: &Plan,
        now: Timestamp,
    ) -> Result<Option<Vec<Bar>>, Failure> {
        if plan.first_open >= plan.kept_before {
            return Ok(None);
        }
        if req.from.is_some_and(|f| f.0 < plan.history_begins) {
            return Ok(None);
        }
        let kept_end = plan.opens_before.min(plan.kept_before);
        let floor = (plan.history_begins + NANOS_PER_DAY).max(s.earliest);
        let mut tail_bars: Option<Vec<Bar>> = None;
        let mut found: Option<Vec<Bar>> = None;
        let mut start = plan.first_open;
        let mut asked: Vec<Span> = Vec::new();
        for round in 0..=MAX_WIDENINGS {
            let want = Span::new(start, kept_end);
            let missing = self.missing(s, &asked, want).await?;
            if !s.base.foreground_reach(cal, &missing) {
                debug!(instrument = %s.instrument, "a cold read: the connection answers as asked");
                return Ok(None);
            }
            if !missing.is_empty() {
                let lock = self.lock(s);
                let _one = lock.lock().await;
                for hole in self.missing(s, &asked, want).await? {
                    for chunk in chunks(s.base, hole) {
                        match self.fetch(conn, s, cal, chunk).await {
                            Ok(_) => {}
                            Err(Failure::Market(MarketError::Unsupported(why))) => {
                                info!(instrument = %s.instrument, %why, "older bars were refused; answering with the bars found");
                                return Ok(found);
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    asked.push(hole);
                }
            }
            let tail = match tail_bars.take() {
                Some(t) => t,
                None => self.tail(conn, s, req, plan, now).await?,
            };
            let mut raw = self
                .read(s, start, kept_end)
                .await
                .map_err(Failure::Store)?;
            raw.extend(tail.iter().copied());
            let bars = finish(raw, cal, req);
            if req.from.is_some() || bars.len() >= plan.limit || start <= floor {
                return Ok(Some(bars));
            }
            tail_bars = Some(tail);
            found = Some(bars);
            if round == MAX_WIDENINGS {
                break;
            }
            let least = match s.base {
                Base::Second => FOREGROUND_CHUNK_SECONDS * NANOS_PER_SEC,
                Base::Minute | Base::Daily => NANOS_PER_DAY,
            };
            let span = (kept_end - start).max(least).saturating_mul(3);
            start = cal
                .bucket_start(Timestamp(kept_end.saturating_sub(span)), req.tf)
                .0
                .max(floor);
        }
        debug!(instrument = %s.instrument, "too few bars for the reach: the connection answers as asked");
        Ok(None)
    }

    async fn tail(
        &self,
        conn: &Arc<dyn MarketDataProvider>,
        s: &Series,
        req: &BarsRequest,
        plan: &Plan,
        now: Timestamp,
    ) -> Result<Vec<Bar>, Failure> {
        if plan.opens_before <= plan.kept_before {
            return Ok(Vec::new());
        }
        let to = req.to.filter(|t| *t < now);
        let live = to.is_none();
        let waited_from = tokio::time::Instant::now();
        let fetching = live.then(|| self.tail_lock(s));
        let _one = match &fetching {
            Some(l) => Some(l.lock().await),
            None => None,
        };
        let kept = live
            .then(|| self.tails.lock().get(s).cloned())
            .flatten()
            .filter(|t| {
                let fresh = match plan.read {
                    Read::Recent => t.at.elapsed() < TAIL_FRESH,
                    Read::Through | Read::Kept => t.at >= waited_from,
                };
                t.kept_before == plan.kept_before && fresh
            });
        let bars = match kept {
            Some(t) => t.bars,
            None => {
                let tail = conn
                    .get_bars(BarsRequest {
                        instrument: s.instrument.clone(),
                        tf: s.base.tf(),
                        from: Some(Timestamp(plan.kept_before)),
                        to,
                        limit: None,
                        rth_only: false,
                    })
                    .await
                    .map_err(Failure::Market)?;
                if live {
                    self.tails.lock().insert(
                        s.clone(),
                        Tail {
                            kept_before: plan.kept_before,
                            at: tokio::time::Instant::now(),
                            bars: tail.bars.clone(),
                        },
                    );
                }
                tail.bars
            }
        };
        Ok(bars
            .into_iter()
            .filter(|b| b.t.0 >= plan.kept_before.max(s.earliest))
            .collect())
    }

    async fn missing(&self, s: &Series, asked: &[Span], want: Span) -> Result<Vec<Span>, Failure> {
        let mut known = self.covered(s).await.map_err(Failure::Store)?;
        known.extend_from_slice(asked);
        known.sort();
        Ok(holes(&known, want))
    }

    async fn fetch(
        &self,
        conn: &Arc<dyn MarketDataProvider>,
        s: &Series,
        cal: SessionCalendar,
        span: Span,
    ) -> Result<usize, Failure> {
        let got = conn
            .get_bars(BarsRequest {
                instrument: s.instrument.clone(),
                tf: s.base.tf(),
                from: Some(Timestamp(span.start)),
                to: Some(Timestamp(span.end - 1)),
                limit: None,
                rth_only: false,
            })
            .await
            .map_err(Failure::Market)?;
        let mut bars: Vec<Bar> = got
            .bars
            .into_iter()
            .filter(|b| span.contains(b.t.0))
            .collect();
        s.own(&mut bars);
        let n = bars.len();
        let known = known(
            cal,
            s.base,
            span,
            bars.iter().map(|b| b.t).max(),
            self.clock.now(),
        );
        self.keep(s, cal, bars, known)
            .await
            .map_err(Failure::Store)?;
        let _ = self.written.send(BarsWritten {
            source: s.source.clone(),
            instrument: s.instrument.clone(),
            base: s.base.tf(),
            from: Timestamp(span.start),
            to: Timestamp(span.end),
        });
        Ok(n)
    }

    pub async fn minutes_covered(&self, source: &str, instrument: &InstrumentId) -> Vec<Span> {
        let s = Series::any_time(source, instrument, Base::Minute);
        self.covered(&s).await.unwrap_or_default()
    }

    pub async fn kept_minutes(
        &self,
        source: &str,
        instrument: &InstrumentId,
        from: Timestamp,
        to: Timestamp,
    ) -> Result<Vec<Bar>, String> {
        let s = Series::any_time(source, instrument, Base::Minute);
        self.read(&s, from.0, to.0).await
    }

    pub async fn kept_before(
        &self,
        source: &str,
        spec: &ContractSpec,
        req: &BarsRequest,
        before: Timestamp,
    ) -> Result<Vec<Bar>, String> {
        let Some(base) = Base::of(req.tf) else {
            return Ok(Vec::new());
        };
        let cal = spec.sessions;
        let before = match base {
            Base::Second | Base::Minute => before.0,
            Base::Daily => cal.bucket_start(before, Timeframe::D1).0,
        };
        let mut end = req
            .to
            .map_or(before, |to| opens_before(cal, base, req.tf, to).min(before));
        let s = Series {
            earliest: self.earliest(spec),
            ..Series::any_time(source, &req.instrument, base)
        };
        self.purge(&s).await?;
        for _ in 0..=MAX_WIDENINGS {
            let start = match req.from {
                Some(f) => cal.bucket_start(f, req.tf).0,
                None => reach_start(cal, base, req.tf, end, limit_of(req)),
            };
            let bars = self.read(&s, start, end).await?;
            if !bars.is_empty() || req.from.is_some() {
                return Ok(bars);
            }
            let covered = self.covered(&s).await?;
            match covered
                .iter()
                .filter(|c| c.start < start)
                .map(|c| c.end.min(start))
                .max()
            {
                Some(stored_end) => end = stored_end,
                None => return Ok(bars),
            }
        }
        Ok(Vec::new())
    }

    pub async fn kept_now(&self, router: &MarketRouter, instrument: &InstrumentId) -> HistoryKept {
        let filling = self.fills.lock().get(instrument).is_some_and(|f| f.filling);
        let mut out = HistoryKept {
            instrument: instrument.clone(),
            from: None,
            to: None,
            filling,
        };
        let Ok(conn) = router.route_async(instrument).await else {
            return out;
        };
        let s = Series::any_time(conn.id(), instrument, Base::Minute);
        if let Ok(covered) = self.covered(&s).await
            && let Some(last) = covered.last()
        {
            out.from = Some(Timestamp(last.start));
            out.to = Some(Timestamp(last.end));
        }
        out
    }

    pub fn fill(
        self: &Arc<Self>,
        router: &Arc<MarketRouter>,
        instrument: &InstrumentId,
        tf: Timeframe,
        publish: Publish,
    ) -> Option<FillGuard> {
        let sessions = fill_sessions(tf);
        if sessions == 0 {
            return None;
        }
        let id = self.next_want.fetch_add(1, Ordering::Relaxed);
        let start = {
            let mut fills = self.fills.lock();
            let f = fills.entry(instrument.clone()).or_default();
            f.wants.insert(id, sessions);
            f.wake.notify_one();
            f.filling = true;
            match f.run {
                Some(_) => None,
                None => {
                    f.run = Some(id);
                    Some(id)
                }
            }
        };
        if let Some(run) = start {
            let me = Arc::clone(self);
            let router = Arc::downgrade(router);
            let instrument = instrument.clone();
            tokio::spawn(async move { me.run_fill(router, instrument, run, publish).await });
        }
        Some(FillGuard {
            cache: Arc::downgrade(self),
            instrument: instrument.clone(),
            id,
        })
    }

    fn wanted(&self, instrument: &InstrumentId, run: u64) -> Option<(usize, Arc<Notify>)> {
        let mut fills = self.fills.lock();
        let f = fills.get_mut(instrument).filter(|f| f.run == Some(run))?;
        match f.wants.values().max() {
            Some(n) => Some((*n, Arc::clone(&f.wake))),
            None => {
                fills.remove(instrument);
                None
            }
        }
    }

    fn set_filling(&self, instrument: &InstrumentId, filling: bool) {
        if let Some(f) = self.fills.lock().get_mut(instrument) {
            f.filling = filling;
        }
    }

    async fn run_fill(
        self: Arc<Self>,
        router: Weak<MarketRouter>,
        id: InstrumentId,
        fill_run: u64,
        publish: Publish,
    ) {
        let mut failures = 0u32;
        let mut run = FillRun::default();
        loop {
            let Some((sessions, wake)) = self.wanted(&id, fill_run) else {
                return;
            };
            let Some(r) = router.upgrade() else {
                return;
            };
            let step = self.fill_step(&r, &id, sessions, &mut run).await;
            drop(r);
            match step {
                Ok(Step::Fetched) => {
                    failures = 0;
                    publish(self.kept_now_filling(&router, &id, true).await);
                    let pause = self.fill_pause_ms.load(Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_millis(pause)).await;
                }
                Ok(Step::Done) => {
                    self.set_filling(&id, false);
                    publish(self.kept_now_filling(&router, &id, false).await);
                    let notified = wake.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    match self.wanted(&id, fill_run) {
                        None => return,
                        Some((n, _)) if n == sessions => notified.await,
                        Some(_) => {}
                    }
                    self.set_filling(&id, true);
                }
                Err(e) => {
                    debug!(instrument = %id, error = %e, "background history fill: waiting before trying again");
                    failures += 1;
                    tokio::select! {
                        () = tokio::time::sleep(FILL_BACKOFF.delay(failures)) => {}
                        () = wake.notified() => {}
                    }
                }
            }
        }
    }

    async fn kept_now_filling(
        &self,
        router: &Weak<MarketRouter>,
        id: &InstrumentId,
        filling: bool,
    ) -> HistoryKept {
        let mut kept = match router.upgrade() {
            Some(r) => self.kept_now(&r, id).await,
            None => HistoryKept {
                instrument: id.clone(),
                from: None,
                to: None,
                filling,
            },
        };
        kept.filling = filling;
        kept
    }

    async fn fill_step(
        &self,
        router: &MarketRouter,
        id: &InstrumentId,
        sessions: usize,
        run: &mut FillRun,
    ) -> Result<Step, String> {
        let conn = router.route_async(id).await.map_err(|e| e.to_string())?;
        if !conn.cache_bars()
            || !conn
                .capabilities()
                .history_timeframes
                .contains(&Timeframe::M1)
        {
            return Ok(Step::Done);
        }
        let (_, spec) = conn.spec(id).await.map_err(|e| e.to_string())?;
        let cal = spec.sessions;
        let s = Series {
            earliest: self.earliest(&spec),
            ..Series::any_time(conn.id(), id, Base::Minute)
        };
        self.purge(&s).await?;
        if run.source != s.source {
            *run = FillRun {
                source: s.source.clone(),
                ..FillRun::default()
            };
        }
        router.foreground().idle().await;
        let lock = self.lock(&s);
        let _one = lock.lock().await;
        let now = self.clock.now();
        let settled = Base::Minute.settled_before(cal, now);
        let mut start = cal
            .last_sessions(now, sessions)
            .first()
            .map_or(settled, |x| x.open.0);
        let earliest = now.0 - lookback(conn.as_ref(), Base::Minute) * NANOS_PER_DAY;
        start = start.max(earliest + NANOS_PER_DAY).max(s.earliest);
        if let Some(f) = run.floor {
            start = start.max(f);
        }
        let mut known = self.covered(&s).await?;
        known.extend(run.asked.iter().copied());
        known.sort();
        let missing = holes(&known, Span::new(start, settled));
        let Some(hole) = missing.last().copied() else {
            return Ok(Step::Done);
        };
        let back = cal.last_sessions(Timestamp(hole.end - 1), FILL_SESSIONS_PER_REQUEST);
        let chunk = Span::new(
            back.first()
                .map_or(hole.start, |x| x.open.0)
                .max(hole.start),
            hole.end,
        );
        let found = match self.fetch(&conn, &s, cal, chunk).await {
            Ok(n) => n,
            Err(Failure::Market(MarketError::Unsupported(why))) => {
                info!(instrument = %id, from = %Timestamp(chunk.start), %why, "background history fill: the connection refused older bars");
                run.floor = Some(chunk.end);
                return Ok(Step::Done);
            }
            Err(Failure::Market(e)) => return Err(e.to_string()),
            Err(Failure::Store(e)) => return Err(e),
        };
        debug!(instrument = %id, from = %Timestamp(chunk.start), to = %Timestamp(chunk.end), found, "background history fill");
        run.asked.push(chunk);
        if found == 0 && chunk.end <= now.0 - UNTRUSTED_EMPTY_WITHIN_NS {
            run.empty_run += 1;
            if run.empty_run >= FILL_EMPTY_STOP {
                info!(instrument = %id, from = %Timestamp(chunk.start), "background history fill: the connection has no older bars");
                run.floor = Some(chunk.start);
            }
        } else if found > 0 {
            run.empty_run = 0;
        }
        Ok(Step::Fetched)
    }
}

#[derive(Debug)]
pub struct FillGuard {
    cache: Weak<BarCache>,
    instrument: InstrumentId,
    id: u64,
}

impl Drop for FillGuard {
    fn drop(&mut self) {
        if let Some(c) = self.cache.upgrade()
            && let Some(f) = c.fills.lock().get_mut(&self.instrument)
        {
            f.wants.remove(&self.id);
            f.wake.notify_one();
        }
    }
}

enum Step {
    Fetched,
    Done,
}

#[derive(Debug, Default)]
struct FillRun {
    source: String,
    floor: Option<i64>,
    empty_run: u32,
    asked: Vec<Span>,
}

fn known(
    cal: SessionCalendar,
    base: Base,
    span: Span,
    last: Option<Timestamp>,
    now: Timestamp,
) -> Option<Span> {
    let step = match base {
        Base::Second => NANOS_PER_SEC,
        Base::Minute => NANOS_PER_MINUTE,
        Base::Daily => 1,
    };
    let after = last
        .map_or(span.start, |t| (t.0 + step).max(span.start))
        .min(span.end);
    let trailing = Span::new(after.max(now.0 - UNTRUSTED_EMPTY_WITHIN_NS), span.end);
    let end = if trailing.is_empty() || !trades_in(cal, base, trailing) {
        span.end
    } else {
        trailing.start
    };
    let k = Span::new(span.start, end);
    (!k.is_empty()).then_some(k)
}

fn trades_in(cal: SessionCalendar, base: Base, span: Span) -> bool {
    match base {
        Base::Second | Base::Minute => trading_minutes(cal, span) > 0,
        Base::Daily => {
            let first = cal.trade_date(Timestamp(span.start));
            let last = cal.trade_date(Timestamp(span.end - 1));
            cal.sessions_between(first, last).iter().any(|x| {
                let label = label_time(cal, x.trade_date).0;
                span.contains(label)
            })
        }
    }
}

enum Failure {
    Market(MarketError),
    Store(String),
}

#[derive(Debug)]
struct Plan {
    first_open: i64,
    opens_before: i64,
    kept_before: i64,
    history_begins: i64,
    limit: usize,
    read: Read,
}

impl Plan {
    fn new(
        cal: SessionCalendar,
        base: Base,
        req: &BarsRequest,
        now: Timestamp,
        lookback_days: i64,
        earliest: i64,
        read: Read,
    ) -> Self {
        let to = req.to.map_or(now, |t| t.min(now));
        let opens_before = opens_before(cal, base, req.tf, to);
        let limit = limit_of(req);
        let history_begins = now.0 - lookback_days * NANOS_PER_DAY;
        let first_open = match req.from {
            Some(f) => cal.bucket_start(f, req.tf).0,
            None => reach_start(cal, base, req.tf, opens_before, limit)
                .max(history_begins + NANOS_PER_DAY),
        }
        .max(earliest);
        Self {
            first_open,
            opens_before,
            kept_before: base.settled_before(cal, now),
            history_begins,
            limit,
            read,
        }
    }
}

fn opens_before(cal: SessionCalendar, base: Base, tf: Timeframe, to: Timestamp) -> i64 {
    match base {
        Base::Second | Base::Minute => cal.bucket_start(to, tf).0 + tf.nanos(),
        Base::Daily => {
            let (_, last) = cal.session_group(cal.trade_date(to), tf.sessions());
            label_time(cal, last).0 + 1
        }
    }
}

fn limit_of(req: &BarsRequest) -> usize {
    req.limit
        .unwrap_or(crate::module::DEFAULT_BARS as usize)
        .max(1)
}

fn lookback(conn: &dyn MarketDataProvider, base: Base) -> i64 {
    let caps = conn.capabilities();
    let days = match base {
        Base::Second | Base::Minute => caps.max_intraday_history_days,
        Base::Daily => caps.max_daily_history_days,
    };
    i64::from(days.unwrap_or(400))
}

fn reach_start(cal: SessionCalendar, base: Base, tf: Timeframe, end: i64, limit: usize) -> i64 {
    if base == Base::Second {
        return seconds_reach_start(cal, tf, end, limit);
    }
    let mut need = match base {
        Base::Daily => limit as i64 * i64::from(tf.sessions().max(1)) + 1,
        Base::Second | Base::Minute => limit as i64 + 1,
    };
    let mut day = cal.trade_date(Timestamp(end - 1));
    for _ in 0..20_000 {
        if let Some(s) = cal.session(day)
            && s.open.0 < end
        {
            need -= match base {
                Base::Daily => 1,
                Base::Second | Base::Minute => {
                    let per = tf.nanos().max(1);
                    s.segments
                        .iter()
                        .map(|seg| {
                            let len = (seg.end.0.min(end) - seg.start.0).max(0);
                            (len + per - 1) / per
                        })
                        .sum()
                }
            };
            if need <= 0 {
                return match base {
                    Base::Second | Base::Minute => s.open.0,
                    Base::Daily => label_time(cal, day).0,
                };
            }
        }
        day -= chrono::Duration::days(1);
    }
    i64::MIN / 2
}

fn seconds_reach_start(cal: SessionCalendar, tf: Timeframe, end: i64, limit: usize) -> i64 {
    let per = tf.nanos().max(1);
    let mut need = limit as i64 + 1;
    let mut day = cal.trade_date(Timestamp(end - 1));
    for _ in 0..20_000 {
        if let Some(s) = cal.session(day) {
            for seg in s.segments.iter().rev() {
                let hi = seg.end.0.min(end);
                let bars = ((hi - seg.start.0).max(0) + per - 1) / per;
                if bars >= need {
                    return cal.bucket_start(Timestamp(hi - need * per), tf).0;
                }
                need -= bars;
            }
        }
        day -= chrono::Duration::days(1);
    }
    i64::MIN / 2
}

pub(crate) fn trading_minutes(cal: SessionCalendar, span: Span) -> i64 {
    if span.is_empty() {
        return 0;
    }
    let first = cal.trade_date(Timestamp(span.start));
    let last = cal.trade_date(Timestamp(span.end - 1));
    cal.sessions_between(first, last)
        .iter()
        .flat_map(|s| s.segments.iter())
        .map(|seg| {
            (seg.end.0.min(span.end) - seg.start.0.max(span.start)).max(0) / NANOS_PER_MINUTE
        })
        .sum()
}

fn chunks(base: Base, hole: Span) -> Vec<Span> {
    let step = match base {
        Base::Second => FOREGROUND_CHUNK_SECONDS * NANOS_PER_SEC,
        Base::Minute => FOREGROUND_CHUNK_MINUTES * NANOS_PER_MINUTE,
        Base::Daily => i64::MAX,
    };
    let mut out = Vec::new();
    let mut at = hole.start;
    while at < hole.end {
        let end = hole.end.min(at.saturating_add(step));
        out.push(Span::new(at, end));
        at = end;
    }
    out
}

pub(crate) fn finish(mut bars: Vec<Bar>, cal: SessionCalendar, req: &BarsRequest) -> Vec<Bar> {
    bars.sort_by_key(|b| b.t);
    let mut one: Vec<Bar> = Vec::with_capacity(bars.len());
    for b in bars {
        match one.last_mut() {
            Some(last) if last.t == b.t => *last = b,
            _ => one.push(b),
        }
    }
    if req.rth_only && !req.tf.is_session() {
        one.retain(|b| cal.is_rth(b.t));
    }
    let mut out = if req.tf.base() == Some(req.tf) {
        one
    } else {
        aggregate(&one, req.tf, cal)
    };
    out.retain(|b| req.from.is_none_or(|f| b.t >= f) && req.to.is_none_or(|t| b.t <= t));
    if let Some(n) = req.limit
        && out.len() > n
    {
        out.drain(..out.len() - n);
    }
    out
}

fn last_open(cal: SessionCalendar, tf: Timeframe, bars: &[Bar], now: Timestamp) -> bool {
    bars.last().is_some_and(|b| {
        let (_, close) = cal.bucket_span(b.t, tf);
        close > now
    })
}

fn empty(req: &BarsRequest) -> BarSeries {
    BarSeries {
        instrument: req.instrument.clone(),
        tf: req.tf,
        bars: Vec::new(),
        last_bar_open: false,
    }
}

#[cfg(test)]
mod tests {
    use tessera_core::settle::settle;

    use super::*;

    fn et(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    #[test]
    fn a_reach_holds_the_bars_asked_for() {
        let cal = SessionCalendar::CmeEquityIndex;
        let end = et("2026-10-07T12:00:00-04:00").0;
        let start = reach_start(cal, Base::Minute, Timeframe::M1, end, 100);
        assert_eq!(Timestamp(start), et("2026-10-06T18:00:00-04:00"));
        let start = reach_start(cal, Base::Minute, Timeframe::M1, end, 1_500);
        assert_eq!(Timestamp(start), et("2026-10-05T18:00:00-04:00"));
        let monday = et("2026-10-05T10:00:00-04:00").0;
        let start = reach_start(cal, Base::Minute, Timeframe::M5, monday, 600);
        assert_eq!(Timestamp(start), et("2026-09-30T18:00:00-04:00"));
        let start = reach_start(cal, Base::Daily, Timeframe::D1, end, 3);
        assert_eq!(Timestamp(start), et("2026-10-02T00:00:00-04:00"));
    }

    #[test]
    fn trading_minutes_skip_the_weekend_and_the_daily_halt() {
        let cal = SessionCalendar::CmeEquityIndex;
        let fri = et("2026-10-02T16:00:00-04:00").0;
        let mon = et("2026-10-05T10:00:00-04:00").0;
        assert_eq!(trading_minutes(cal, Span::new(fri, mon)), 60 + 16 * 60);
    }

    #[test]
    fn holes_are_fetched_in_pages() {
        let m = NANOS_PER_MINUTE;
        let c = chunks(Base::Minute, Span::new(0, 20_000 * m));
        assert_eq!(c.len(), 3);
        assert_eq!(c[0], Span::new(0, 9_000 * m));
        assert_eq!(c[2].end, 20_000 * m);
        assert_eq!(chunks(Base::Daily, Span::new(0, 10)), [Span::new(0, 10)]);
    }

    #[test]
    fn a_fill_run_that_was_replaced_stops_and_leaves_the_new_one_filling() {
        let cache = BarCache::new(
            Arc::new(tessera_store::bars::BarStore::open_in_memory().unwrap()),
            Arc::new(tessera_core::clock::SystemClock),
        );
        let id = InstrumentId::new("NQZ6.CME").unwrap();
        cache.fills.lock().insert(
            id.clone(),
            Fill {
                wants: HashMap::from([(7, 3)]),
                run: Some(7),
                ..Fill::default()
            },
        );
        assert!(cache.wanted(&id, 1).is_none(), "the replaced run stops");
        assert!(cache.fills.lock().contains_key(&id));
        assert_eq!(cache.wanted(&id, 7).map(|(n, _)| n), Some(3));
        cache.fills.lock().get_mut(&id).unwrap().wants.clear();
        assert!(cache.wanted(&id, 7).is_none());
        assert!(cache.fills.lock().is_empty(), "the last want gone ends it");
    }

    #[tokio::test]
    async fn the_gate_opens_when_the_last_foreground_read_ends() {
        let gate = Arc::new(Gate::default());
        let a = gate.enter();
        let b = gate.enter();
        let g = Arc::clone(&gate);
        let waiting = tokio::spawn(async move { g.idle().await });
        tokio::task::yield_now().await;
        drop(a);
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(b);
        settle("the gate", || waiting.is_finished(), |done| *done).await;
        waiting.await.unwrap();
        gate.idle().await;
    }
}
