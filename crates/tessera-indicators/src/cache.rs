use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tessera_core::clock::SharedClock;
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_host::{ByteLru, Weigh};
use tessera_market::candles::{CandlesAsk, candles};
use tessera_market::history::{BarsWritten, CHART_MAX_BARS, Read, settle_edge};
use tessera_market::hub::MarketHub;
use tessera_market::io::SessionFilter;
use tessera_market::orderflow::flow::{FlowRead, Sides};
use tessera_market::orderflow::tools::{MAX_BAR_PRINTS, print_bars};
use tessera_market::{MarketRouter, market_error};
use tessera_protocol::compact::CompactBar;
use tessera_tools::ToolError;
use tokio::sync::{Notify, Semaphore, broadcast};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::frame::{
    Asked, BarKind, Flow, FlowAsk, Frame, Grid, Minutes, MinutesAsk, Opening, Period, Published,
    Reached, ReadMark, Span, StudyKey, Values, WatchKey,
};
use crate::studies::{Needs, Pulls, Study};

pub(crate) const INDICATOR_CACHE_BYTES: usize = 64 << 20;
pub(crate) const MAX_FRAME_BARS: usize = CHART_MAX_BARS;
pub(crate) const DEFAULT_BARS: usize = 1_500;

pub(crate) const PRINT_BAR_SESSIONS: u32 = 2;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct FrameKey {
    pub instrument: InstrumentId,
    pub bars: BarKind,
    pub session: SessionFilter,
}

impl FrameKey {
    pub fn tf(&self) -> Option<Timeframe> {
        match self.bars {
            BarKind::Time(tf) => Some(tf),
            BarKind::Print(_) => None,
        }
    }

    fn kept_as(&self) -> Option<Timeframe> {
        let tf = self.tf()?;
        match tf.unit() {
            tessera_core::timeframe::TimeUnit::Second => Some(Timeframe::S1),
            _ => tf.base(),
        }
    }
}

pub(crate) struct FrameCell {
    pub key: FrameKey,
    frame: Arc<tokio::sync::Mutex<Frame>>,
    bytes: AtomicUsize,
    followers: AtomicUsize,
    behind: AtomicBool,
    pub wake: Notify,
}

impl Weigh for FrameCell {
    fn weight(&self) -> usize {
        self.bytes.load(Ordering::Relaxed)
    }
}

impl FrameCell {
    pub fn followed(self: &Arc<Self>) -> Following {
        self.followers.fetch_add(1, Ordering::Relaxed);
        Following(Arc::clone(self))
    }

    pub fn is_followed(&self) -> bool {
        self.followers.load(Ordering::Relaxed) > 0
    }
}

pub(crate) struct Following(Arc<FrameCell>);

impl Drop for Following {
    fn drop(&mut self) {
        self.0.followers.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Clone)]
pub(crate) struct Resolved {
    pub key: StudyKey,
    pub study: Arc<dyn Study>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reach {
    From(i64),
    Newest(usize),
}

impl Reach {
    fn held_by(self, f: &Frame) -> bool {
        let rows = f.rows();
        let (first, n, reached) = (rows.first(), rows.len(), f.reached());
        n >= MAX_FRAME_BARS
            || match self {
                Reach::From(t) => {
                    first.is_some_and(|f| f <= t) || reached.is_some_and(|r| r.covers(t))
                }
                Reach::Newest(count) => n >= count || reached == Some(Reached::Everything),
            }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Want {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: usize,
}

impl Want {
    fn reach(&self) -> Reach {
        self.from.map_or(Reach::Newest(self.limit), Reach::From)
    }

    fn rows(&self, f: &Frame) -> std::ops::Range<usize> {
        let rows = f.rows();
        let end = self
            .to
            .map_or(rows.len(), |t| rows.at_or_after(t.saturating_add(1)));
        let start = self.from.map_or(0, |t| rows.at_or_after(t));
        start.max(end.saturating_sub(self.limit))..end.max(start)
    }

    fn anchor(&self, f: &Frame, period: Period) -> Option<i64> {
        let range = self.rows(f);
        let first = f.rows().iter().nth(range.start)?.t;
        f.grid()
            .period_open(first, period)
            .filter(|open| *open < first)
    }

    fn covered_by(&self, f: &Frame, period: Period) -> bool {
        let rows = f.rows();
        let (Some(first), reached) = (rows.first(), f.reached()) else {
            return false;
        };
        let holds = |t: i64| first <= t || reached.is_some_and(|r| r.covers(t));
        let wanted = match self.from {
            Some(t) => holds(t),
            None => self.rows(f).len() >= self.limit || reached == Some(Reached::Everything),
        };
        wanted && self.anchor(f, period).is_none_or(holds)
    }
}

pub(crate) struct Watcher {
    pub watch: WatchKey,
    pub asked: Asked,
    pub from: Option<i64>,
    pub catch_up: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lead {
    None,
    PeriodOpen,
}

pub(crate) struct Watching {
    pub snapshot: Published,
    pub provider: String,
    pub guard: WatchGuard,
}

pub(crate) struct WatchGuard {
    cell: Arc<FrameCell>,
    watch: WatchKey,
}

impl WatchGuard {
    pub fn cell(&self) -> Arc<FrameCell> {
        Arc::clone(&self.cell)
    }
}

impl Drop for WatchGuard {
    fn drop(&mut self) {
        let (cell, watch) = (Arc::clone(&self.cell), self.watch.clone());
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move { cell.frame.lock().await.unwatch(&watch) });
            }
            Err(_) => cell.frame.blocking_lock().unwatch(&watch),
        }
    }
}

pub(crate) type Publish = Arc<dyn Fn(&FrameKey, &str, &Published) + Send + Sync>;

pub(crate) struct IndicatorCache {
    router: Arc<MarketRouter>,
    hub: Option<Arc<MarketHub>>,
    clock: SharedClock,
    frames: Mutex<ByteLru<FrameKey, Arc<FrameCell>>>,
    runs: Arc<Semaphore>,
    publish: Publish,
    flow_budget: std::sync::atomic::AtomicU64,
}

impl std::fmt::Debug for IndicatorCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndicatorCache")
            .field("frames", &*self.frames.lock())
            .finish_non_exhaustive()
    }
}

fn pulls_of(study: &Resolved) -> Pulls {
    match study.study.needs() {
        Needs::Flow(p) => p,
        Needs::Bars => Pulls::No,
    }
}

fn pinned(cell: &Arc<FrameCell>) -> bool {
    Arc::strong_count(cell) > 1
}

impl IndicatorCache {
    pub fn new(
        router: Arc<MarketRouter>,
        hub: Option<Arc<MarketHub>>,
        clock: SharedClock,
        runs: Arc<Semaphore>,
        budget: usize,
        publish: Publish,
    ) -> Arc<Self> {
        Arc::new(Self {
            router,
            hub,
            clock,
            frames: Mutex::new(ByteLru::pinning(budget, pinned)),
            runs,
            publish,
            flow_budget: std::sync::atomic::AtomicU64::new(MAX_BAR_PRINTS),
        })
    }

    pub fn hub(&self) -> Option<&Arc<MarketHub>> {
        self.hub.as_ref()
    }

    pub fn router(&self) -> &Arc<MarketRouter> {
        &self.router
    }

    pub fn cell(&self, key: &FrameKey, grid: Grid) -> Arc<FrameCell> {
        let mut frames = self.frames.lock();
        if let Some(c) = frames.get(key) {
            return Arc::clone(c);
        }
        let cell = Arc::new(FrameCell {
            key: key.clone(),
            frame: Arc::new(tokio::sync::Mutex::new(Frame::new(grid))),
            bytes: AtomicUsize::new(0),
            followers: AtomicUsize::new(0),
            behind: AtomicBool::new(false),
            wake: Notify::new(),
        });
        let evicted = frames.insert(key.clone(), Arc::clone(&cell));
        drop(frames);
        drop(evicted);
        cell
    }

    fn release(&self, cell: Arc<FrameCell>) {
        let key = cell.key.clone();
        drop(cell);
        let evicted = self.frames.lock().resize(&key);
        drop(evicted);
    }

    fn find(&self, key: &FrameKey) -> Option<Arc<FrameCell>> {
        self.frames.lock().get(key).cloned()
    }

    async fn locked<T: Send + 'static>(
        &self,
        cell: &Arc<FrameCell>,
        f: impl FnOnce(&mut Frame) -> T + Send + 'static,
    ) -> T {
        let permit = Arc::clone(&self.runs).acquire_owned().await.ok();
        let mut frame = Arc::clone(&cell.frame).lock_owned().await;
        let weighed = Arc::clone(cell);
        let out = tokio::task::spawn_blocking(move || {
            let out = f(&mut frame);
            weighed.bytes.store(frame.bytes(), Ordering::Relaxed);
            drop(frame);
            drop(permit);
            out
        })
        .await;
        let evicted = self.frames.lock().resize(&cell.key);
        drop(evicted);
        match out {
            Ok(out) => out,
            Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
            Err(_) => std::future::pending().await,
        }
    }

    async fn edit(&self, cell: &Arc<FrameCell>, f: impl FnOnce(&mut Frame) + Send + 'static) {
        let publish = Arc::clone(&self.publish);
        let key = cell.key.clone();
        let now = Instant::now();
        self.locked(cell, move |frame| {
            f(frame);
            let out = frame.advance(now);
            let provider = frame.source().unwrap_or_default().to_owned();
            for p in &out {
                publish(&key, &provider, p);
            }
        })
        .await;
    }

    pub async fn advance(&self, cell: &Arc<FrameCell>) {
        self.edit(cell, |_| {}).await;
    }

    pub async fn next_due(&self, cell: &Arc<FrameCell>) -> Option<Instant> {
        cell.frame.lock().await.next_due()
    }

    pub async fn wants_flow(&self, cell: &Arc<FrameCell>) -> bool {
        cell.frame.lock().await.wants_flow().is_some()
    }

    pub async fn flow_filling(&self, cell: &Arc<FrameCell>) -> bool {
        cell.frame.lock().await.flow_filling()
    }

    fn flow_budget(&self) -> u64 {
        self.flow_budget.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    fn set_flow_budget(&self, prints: u64) {
        self.flow_budget.store(prints, Ordering::Relaxed);
    }

    fn now(&self) -> Timestamp {
        self.clock.now()
    }

    async fn bars(
        &self,
        key: &FrameKey,
        from: Option<i64>,
        to: Option<i64>,
        limit: usize,
    ) -> Result<(String, Vec<CompactBar>), ToolError> {
        let Some(tf) = key.tf() else {
            return Err(ToolError::internal("print bars are built, not read"));
        };
        let ask = CandlesAsk {
            instrument: key.instrument.clone(),
            tf,
            from: from.map(Timestamp),
            to: to.map(Timestamp),
            limit,
            session: key.session,
            front_months: tf.is_session(),
        };
        let got = candles(&self.router, ask, Read::Through, self.now())
            .await
            .map_err(market_error)?;
        let bars = got.series.bars.iter().map(CompactBar::from).collect();
        Ok((got.provider.id().to_owned(), bars))
    }

    fn settled_to(&self, grid: Grid) -> Option<i64> {
        let BarKind::Time(tf) = grid.bars else {
            return None;
        };
        let edge = settle_edge(grid.calendar, tf, self.now());
        Some(grid.calendar.bucket_start(edge, tf).0)
    }

    async fn route(&self, cell: &Arc<FrameCell>) -> Result<String, ToolError> {
        Ok(self
            .router
            .route_async(&cell.key.instrument)
            .await
            .map_err(market_error)?
            .id()
            .to_owned())
    }

    pub async fn rebuild(&self, cell: &Arc<FrameCell>) -> Result<(), ToolError> {
        let BarKind::Print(kind) = cell.key.bars else {
            return Ok(());
        };
        let hub = self
            .hub
            .clone()
            .ok_or_else(|| ToolError::unsupported("print bars need the market hub"))?;
        let provider = self.route(cell).await?;
        let mark = {
            let mut f = cell.frame.lock().await;
            if f.source() != Some(provider.as_str()) {
                f.reset(provider);
            }
            f.mark()
        };
        let read = print_bars(
            &hub,
            &cell.key.instrument,
            kind,
            PRINT_BAR_SESSIONS,
            self.now(),
        )
        .await?;
        let bars: Vec<CompactBar> = read.bars.iter().map(|(b, _)| CompactBar::from(b)).collect();
        let flows: Vec<Flow> = read.bars.iter().map(|(_, f)| Flow::of(*f)).collect();
        let first_opens_session = !read.cut && read.gaps.is_empty();
        self.edit(cell, move |f| {
            if f.holds(&mark) {
                f.put_built(&bars, &flows, first_opens_session);
                f.reached_to(Reached::Everything);
            }
        })
        .await;
        Ok(())
    }

    pub async fn refresh(&self, cell: &Arc<FrameCell>, tail: bool) -> Result<(), ToolError> {
        let owed = cell.behind.swap(false, Ordering::AcqRel);
        let out = self.caught_up(cell, tail || owed).await;
        if out.is_err() && owed {
            cell.behind.store(true, Ordering::Release);
        }
        out
    }

    async fn caught_up(&self, cell: &Arc<FrameCell>, tail: bool) -> Result<(), ToolError> {
        let provider = self.route(cell).await?;
        let (moved_from, empty, settled_to, stale, grid, mark) = {
            let mut f = cell.frame.lock().await;
            let moved_from = (f.source() != Some(provider.as_str())).then(|| {
                let first = f.rows().first();
                f.reset(provider);
                first
            });
            (
                moved_from,
                f.rows().is_empty(),
                f.settled_to(),
                f.stale().to_vec(),
                f.grid(),
                f.mark(),
            )
        };
        if matches!(cell.key.bars, BarKind::Print(_)) {
            return if tail || moved_from.is_some() {
                self.rebuild(cell).await
            } else {
                Ok(())
            };
        }
        if let Some(first) = moved_from {
            if let Some(first) = first {
                self.reach_to(cell, Reach::From(first)).await?;
            }
            return Ok(());
        }
        if empty {
            return Ok(());
        }
        if tail && let Some(from) = settled_to {
            let (_, bars) = self
                .bars(&cell.key, Some(from), None, MAX_FRAME_BARS)
                .await?;
            let settled = self.settled_to(grid);
            let read = mark.clone();
            self.edit(cell, move |f| {
                f.put_read(Span::new(from, i64::MAX), &bars, &read);
                if f.holds(&read)
                    && let Some(s) = settled
                {
                    f.settle(s);
                }
                f.trim(MAX_FRAME_BARS);
            })
            .await;
            self.reread_flow(cell, from).await;
        }
        for span in stale {
            let (_, bars) = self
                .bars(&cell.key, Some(span.from), Some(span.to), MAX_FRAME_BARS)
                .await?;
            let read = mark.clone();
            self.edit(cell, move |f| {
                if f.holds(&read) {
                    f.put_read(span, &bars, &read);
                    f.reread(span);
                }
            })
            .await;
        }
        Ok(())
    }

    async fn reread_flow(&self, cell: &Arc<FrameCell>, from: i64) {
        let (Some(hub), Some(tf)) = (self.hub.clone(), cell.key.tf()) else {
            return;
        };
        let (ask, mark) = {
            let f = cell.frame.lock().await;
            (f.provisional_flow(from), f.mark())
        };
        if let Some(ask) = ask {
            self.reread_pages(cell, &hub, tf, ask, mark).await;
        }
    }

    async fn reread_pages(
        &self,
        cell: &Arc<FrameCell>,
        hub: &MarketHub,
        tf: Timeframe,
        mut ask: FlowAsk,
        mark: ReadMark,
    ) {
        loop {
            let Ok(read) = hub
                .bar_flows(
                    &cell.key.instrument,
                    tf,
                    &ask.opens,
                    ask.pulls,
                    self.flow_budget(),
                    self.now(),
                )
                .await
            else {
                return;
            };
            let older = FlowAsk {
                opens: ask.opens[..read.unread].to_vec(),
                ..ask.clone()
            };
            let mark_now = mark.clone();
            self.edit(cell, move |f| {
                if f.holds(&mark_now) {
                    f.put_flow_tail(&ask, &read);
                }
            })
            .await;
            if older.opens.is_empty() {
                return;
            }
            ask = older;
        }
    }

    async fn reach_to(
        &self,
        cell: &Arc<FrameCell>,
        reach: Reach,
    ) -> Result<Option<i64>, ToolError> {
        let (first, n, held, grid, mark) = {
            let f = cell.frame.lock().await;
            (
                f.rows().first(),
                f.rows().len(),
                reach.held_by(&f),
                f.grid(),
                f.mark(),
            )
        };
        if matches!(cell.key.bars, BarKind::Print(_)) {
            if first.is_none() {
                self.rebuild(cell).await?;
            }
            return Ok(cell.frame.lock().await.rows().first());
        }
        if held {
            return Ok(first);
        }
        let room = MAX_FRAME_BARS.saturating_sub(n);
        let (from, limit) = match reach {
            Reach::From(t) => (Some(t), room),
            Reach::Newest(count) => (None, (count - n).min(room)),
        };
        let to = first.map(|t| t - 1);
        let (_, bars) = self.bars(&cell.key, from, to, limit).await?;
        let reached_to = match (bars.first(), from) {
            (None, _) if first.is_none() => None,
            (None, Some(t)) => Some(Reached::Since(t)),
            (None, None) => None,
            (Some(_), Some(t)) if bars.len() < limit => Some(Reached::Since(t)),
            (Some(_), None) if bars.len() < limit => Some(Reached::Everything),
            (Some(b), _) => Some(Reached::Since(b.0)),
        };
        let span = Span::new(from.unwrap_or(i64::MIN), to.unwrap_or(i64::MAX));
        let settled = (first.is_none() && !bars.is_empty())
            .then(|| self.settled_to(grid))
            .flatten();
        self.edit(cell, move |f| {
            if !f.holds(&mark) {
                return;
            }
            f.put_read(span, &bars, &mark);
            if let Some(r) = reached_to {
                f.reached_to(r);
            }
            if let Some(s) = settled {
                f.settle(s);
            }
        })
        .await;
        Ok(cell.frame.lock().await.rows().first())
    }

    pub async fn reach(
        &self,
        key: &FrameKey,
        grid: Grid,
        from: i64,
    ) -> Result<Option<i64>, ToolError> {
        let cell = self.cell(key, grid);
        self.refresh(&cell, !cell.is_followed()).await?;
        let first = self.reach_to(&cell, Reach::From(from)).await;
        if first.is_ok() {
            self.settle_flow(&cell, from, None).await;
            self.serve_from(&cell, from).await;
        }
        self.release(cell);
        first.map(|t| t.map(|t| t.max(from)))
    }

    async fn serve_from(&self, cell: &Arc<FrameCell>, from: i64) {
        let publish = Arc::clone(&self.publish);
        let key = cell.key.clone();
        let now = Instant::now();
        self.locked(cell, move |frame| {
            let mut out = frame.advance(now);
            out.extend(frame.serve_from(from));
            let provider = frame.source().unwrap_or_default().to_owned();
            for p in &out {
                publish(&key, &provider, p);
            }
        })
        .await;
    }

    async fn read_flows(
        &self,
        hub: &MarketHub,
        instrument: &InstrumentId,
        tf: Timeframe,
        asks: Vec<FlowAsk>,
    ) -> Vec<(FlowAsk, FlowRead)> {
        let mut reads = Vec::new();
        for mut ask in asks {
            loop {
                let read = hub
                    .bar_flows(
                        instrument,
                        tf,
                        &ask.opens,
                        ask.pulls,
                        self.flow_budget(),
                        self.now(),
                    )
                    .await;
                let read = match read {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::debug!(error = %e.message, "indicators: order flow unread");
                        break;
                    }
                };
                let older = ask.opens[..read.unread].to_vec();
                reads.push((ask.clone(), read));
                if older.is_empty() {
                    break;
                }
                ask.opens = older;
            }
        }
        reads
    }

    pub async fn settle_flow(&self, cell: &Arc<FrameCell>, from: i64, pulls: Option<Pulls>) {
        let (Some(hub), Some(tf)) = (self.hub.clone(), cell.key.tf()) else {
            return;
        };
        let (asks, mark) = {
            let f = cell.frame.lock().await;
            let Some(pulls) = pulls.or_else(|| f.wants_flow()) else {
                return;
            };
            let from = match f.rows().first() {
                Some(first) if from > first => {
                    f.grid().session_open(from).map_or(from, |o| o.min(from))
                }
                _ => from,
            };
            (f.flow_asks(from, pulls), f.mark())
        };
        if asks.is_empty() {
            return;
        }
        let reads = self.read_flows(&hub, &cell.key.instrument, tf, asks).await;
        self.edit(cell, move |f| {
            if f.holds(&mark) {
                f.put_flow_reads(&reads);
            }
        })
        .await;
    }

    async fn read_minutes(
        &self,
        instrument: &InstrumentId,
        asks: Vec<MinutesAsk>,
    ) -> Vec<(MinutesAsk, Minutes)> {
        let now = self.now();
        let mut reads = Vec::with_capacity(asks.len());
        for ask in asks {
            let wanted = CandlesAsk {
                instrument: instrument.clone(),
                tf: Timeframe::M1,
                from: Some(Timestamp(ask.start)),
                to: Some(Timestamp(ask.end)),
                limit: ((ask.end - ask.start) / NANOS_PER_MINUTE) as usize + 1,
                session: SessionFilter::All,
                front_months: false,
            };
            let read = if ask.recent {
                Read::Through
            } else {
                Read::Kept
            };
            match candles(&self.router, wanted, read, now).await {
                Ok(got) => {
                    let bars = got
                        .series
                        .bars
                        .into_iter()
                        .filter(|b| b.t.0 >= ask.start && b.t.0 < ask.end)
                        .collect();
                    reads.push((
                        ask,
                        Minutes {
                            end: ask.end,
                            through: now.0.min(ask.end),
                            bars,
                        },
                    ));
                }
                Err(e) => {
                    tracing::debug!(error = %e, "indicators: an opening window was not read");
                }
            }
        }
        reads
    }

    pub async fn settle_opening(&self, cell: &Arc<FrameCell>, also: Option<Opening>) {
        let (asks, mark) = {
            let f = cell.frame.lock().await;
            (f.opening_asks(self.now().0, also), f.mark())
        };
        if asks.is_empty() {
            return;
        }
        let reads = self.read_minutes(&cell.key.instrument, asks).await;
        self.edit(cell, move |f| {
            if f.holds(&mark) {
                f.put_minutes(reads);
            }
        })
        .await;
    }

    pub async fn refill(&self, cell: &Arc<FrameCell>) {
        cell.frame.lock().await.refill_unknown();
        self.settle_flow(cell, i64::MIN, None).await;
    }

    pub async fn flow_tail(&self, cell: &Arc<FrameCell>) {
        let (Some(hub), Some(tf)) = (self.hub.clone(), cell.key.tf()) else {
            return;
        };
        let (ask, mark) = {
            let f = cell.frame.lock().await;
            (f.flow_tail(), f.mark())
        };
        if let Some(ask) = ask {
            self.reread_pages(cell, &hub, tf, ask, mark).await;
        }
    }

    pub async fn lagged(&self, cell: &Arc<FrameCell>) {
        cell.frame.lock().await.mark_stale(Span::everything());
        if let Err(e) = self.refresh(cell, true).await {
            tracing::debug!(error = %e.message, "indicators: the series could not catch up");
        }
    }

    pub async fn on_bar(&self, cell: &Arc<FrameCell>, bar: CompactBar, closed: bool) {
        self.edit(cell, move |f| {
            f.upsert(&bar, closed);
            f.trim(MAX_FRAME_BARS);
        })
        .await;
    }

    pub async fn on_flow(&self, cell: &Arc<FrameCell>, t: i64, sides: Sides) {
        self.edit(cell, move |f| {
            f.put_live_flow(t, sides);
        })
        .await;
    }

    pub async fn watched_custom(&self, cell: &Arc<FrameCell>) -> Vec<(WatchKey, Asked)> {
        cell.frame.lock().await.watched_custom()
    }

    pub async fn rebind(&self, cell: &Arc<FrameCell>, watch: WatchKey, study: Resolved) {
        self.edit(cell, move |f| f.rebind(&watch, &study.key, &study.study))
            .await;
    }

    pub async fn watch(
        &self,
        key: &FrameKey,
        grid: Grid,
        study: Resolved,
        watcher: Watcher,
    ) -> Result<Watching, ToolError> {
        let Watcher {
            watch,
            asked,
            from,
            catch_up,
        } = watcher;
        let cell = self.cell(key, grid);
        let reach = from.map_or(Reach::Newest(DEFAULT_BARS), Reach::From);
        let lead = from.and_then(|t| {
            study
                .study
                .period()
                .and_then(|p| grid.period_open(t, p))
                .filter(|open| *open < t)
        });
        let warm = {
            let f = cell.frame.lock().await;
            f.source().is_some()
                && !f.rows().is_empty()
                && (matches!(cell.key.bars, BarKind::Print(_))
                    || (reach.held_by(&f) && lead.is_none_or(|t| Reach::From(t).held_by(&f))))
        };
        if warm && catch_up {
            cell.behind.store(true, Ordering::Release);
        } else if !warm {
            self.refresh(&cell, catch_up).await?;
            self.reach_to(&cell, reach).await?;
            if let Some(open) = lead {
                self.reach_to(&cell, Reach::From(open)).await?;
            }
        }
        let start = {
            let mut f = cell.frame.lock().await;
            f.watch(&watch, asked, &study.key, &study.study);
            let n = f.rows().len();
            from.or_else(|| (n > 0).then(|| f.rows().time(n.saturating_sub(DEFAULT_BARS))))
        };
        if study.study.needs().reads_flow()
            && let Some(start) = lead.or(start)
        {
            self.settle_flow(&cell, start, Some(pulls_of(&study))).await;
        }
        if study.study.opening().is_some() {
            self.settle_opening(&cell, None).await;
        }
        let w = watch.clone();
        let publish = Arc::clone(&self.publish);
        let frame_key = cell.key.clone();
        let (provider, snapshot) = self
            .locked(&cell, move |f| {
                let n = f.rows().len();
                let start =
                    from.or_else(|| (n > 0).then(|| f.rows().time(n.saturating_sub(DEFAULT_BARS))));
                let provider = f.source().unwrap_or_default().to_owned();
                let snapshot = f.snapshot(&w, start).map(|s| {
                    for p in &s.others {
                        publish(&frame_key, &provider, p);
                    }
                    s.this
                });
                (provider, snapshot)
            })
            .await;
        let guard = WatchGuard { cell, watch };
        let snapshot = snapshot.ok_or_else(|| ToolError::internal("the series did not start"))?;
        Ok(Watching {
            snapshot,
            provider,
            guard,
        })
    }

    pub async fn read(
        &self,
        key: &FrameKey,
        grid: Grid,
        study: Resolved,
        want: Want,
    ) -> Result<(String, Values), ToolError> {
        let cell = match self.find(key) {
            Some(cell) => {
                self.refresh(&cell, !cell.is_followed()).await?;
                cell
            }
            None => {
                let cell = self.cell(key, grid);
                self.refresh(&cell, true).await?;
                self.reach_to(&cell, want.reach()).await?;
                let anchor = want.anchor(
                    &*cell.frame.lock().await,
                    study.study.period().unwrap_or_default(),
                );
                if let Some(open) = anchor {
                    self.reach_to(&cell, Reach::From(open)).await?;
                }
                cell
            }
        };
        let (covered, first) = {
            let f = cell.frame.lock().await;
            let range = want.rows(&f);
            (
                want.covered_by(&f, study.study.period().unwrap_or_default()),
                (range.start < range.end).then(|| f.rows().time(range.start)),
            )
        };
        if !covered {
            return self
                .transient(key, grid, study, want, Lead::PeriodOpen)
                .await;
        }
        if study.study.needs().reads_flow()
            && let Some(first) = first
        {
            self.settle_flow(&cell, first, Some(pulls_of(&study))).await;
        }
        if let Some(opening) = study.study.opening() {
            self.settle_opening(&cell, Some(opening)).await;
        }
        let out = self
            .locked(&cell, move |f| {
                f.attach(&study.key, &study.study);
                let range = want.rows(f);
                let provider = f.source().unwrap_or_default().to_owned();
                f.values(&study.key, range).map(|v| (provider, v))
            })
            .await;
        self.release(cell);
        out.ok_or_else(|| ToolError::internal("the indicator did not compute"))
    }

    pub async fn transient(
        &self,
        key: &FrameKey,
        grid: Grid,
        study: Resolved,
        want: Want,
        lead: Lead,
    ) -> Result<(String, Values), ToolError> {
        let (provider, mut bars) = self.bars(key, want.from, want.to, want.limit).await?;
        if lead == Lead::PeriodOpen
            && let Some(first) = bars.first().map(|b| b.0)
            && let Some(open) = grid
                .period_open(first, study.study.period().unwrap_or_default())
                .filter(|open| *open < first)
        {
            let (_, mut lead) = self
                .bars(key, Some(open), Some(first - 1), MAX_FRAME_BARS)
                .await?;
            lead.append(&mut bars);
            bars = lead;
        }
        let mut frame = Frame::new(grid);
        frame.reset(provider.clone());
        frame.put_bars(Span::everything(), &bars);
        if study.study.needs().reads_flow()
            && let Some(hub) = &self.hub
            && let Some(tf) = key.tf()
        {
            let asks = frame.flow_asks(i64::MIN, pulls_of(&study));
            let reads = self.read_flows(hub, &key.instrument, tf, asks).await;
            frame.put_flow_reads(&reads);
        }
        if let Some(opening) = study.study.opening() {
            let asks = frame.opening_asks(self.now().0, Some(opening));
            let reads = self.read_minutes(&key.instrument, asks).await;
            frame.put_minutes(reads);
        }
        let permit = Arc::clone(&self.runs).acquire_owned().await.ok();
        let out = tokio::task::spawn_blocking(move || {
            frame.attach(&study.key, &study.study);
            let range = want.rows(&frame);
            let out = frame.values(&study.key, range);
            drop(permit);
            out
        })
        .await;
        match out {
            Ok(Some(v)) => Ok((provider, v)),
            Ok(None) => Err(ToolError::internal("the indicator did not compute")),
            Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
            Err(_) => std::future::pending().await,
        }
    }

    pub fn spawn_written_listener(self: &Arc<Self>) -> Option<JoinHandle<()>> {
        let mut rx = self.router.bar_cache()?.written();
        let rt = tokio::runtime::Handle::try_current().ok()?;
        let me: Weak<Self> = Arc::downgrade(self);
        Some(rt.spawn(async move {
            loop {
                let ev = rx.recv().await;
                let Some(cache) = me.upgrade() else {
                    return;
                };
                match ev {
                    Ok(w) => cache.written(Some(&w)).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => cache.written(None).await,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }))
    }

    async fn written(&self, w: Option<&BarsWritten>) {
        let cells: Vec<Arc<FrameCell>> = self
            .frames
            .lock()
            .values()
            .filter(|c| {
                w.is_none_or(|w| {
                    c.key.instrument == w.instrument && c.key.kept_as() == Some(w.base)
                })
            })
            .cloned()
            .collect();
        for cell in cells {
            {
                let mut f = cell.frame.lock().await;
                let span = match w {
                    None => Span::everything(),
                    Some(w) if f.source() == Some(w.source.as_str()) => {
                        let Some(tf) = cell.key.tf() else {
                            continue;
                        };
                        let cal = f.grid().calendar;
                        Span::new(
                            cal.bucket_start(w.from, tf).0,
                            cal.bucket_start(Timestamp(w.to.0 - 1), tf).0,
                        )
                    }
                    Some(_) => continue,
                };
                f.mark_stale(span);
            }
            cell.wake.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, json};
    use tessera_core::clock::ManualClock;
    use tessera_market::{MarketDataProvider, MockConfig, MockMarket};
    use tessera_protocol::layers::LayerKind;

    use super::*;
    use crate::frame::StudyId;
    use crate::studies::native;

    const MARKETS: [&str; 4] = ["NQ", "ES", "MNQ", "MES"];

    fn sma() -> Resolved {
        let inputs: Map<String, serde_json::Value> = json!({"length": 20, "source": "close"})
            .as_object()
            .unwrap()
            .clone();
        Resolved {
            key: StudyKey {
                id: StudyId::Builtin(LayerKind::Sma),
                params: "sma 20".into(),
            },
            study: native(LayerKind::Sma, &inputs).unwrap(),
        }
    }

    struct World {
        cache: Arc<IndicatorCache>,
        ids: Vec<InstrumentId>,
    }

    async fn world(budget: usize) -> World {
        let now = Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap();
        let clock = Arc::new(ManualClock::new(now));
        let mut cfg = MockConfig::new(Arc::clone(&clock) as _);
        cfg.intraday_sessions = 4;
        cfg.daily_sessions = 10;
        let router = MarketRouter::new();
        router.add(Arc::new(MockMarket::new(cfg))).unwrap();
        let mut ids = Vec::new();
        for m in MARKETS {
            ids.push(router.resolve(m).await.unwrap());
        }
        let cache = IndicatorCache::new(
            router,
            None,
            clock,
            Arc::new(Semaphore::new(2)),
            budget,
            Arc::new(|_, _, _| {}),
        );
        World { cache, ids }
    }

    fn key(id: &InstrumentId) -> FrameKey {
        FrameKey {
            instrument: id.clone(),
            bars: BarKind::Time(Timeframe::M5),
            session: SessionFilter::All,
        }
    }

    impl World {
        fn grid(&self) -> Grid {
            Grid {
                calendar: tessera_core::session::SessionCalendar::CmeEquityIndex,
                bars: BarKind::Time(Timeframe::M5),
                session: SessionFilter::All,
            }
        }

        async fn read(&self, n: usize) -> Vec<u64> {
            let want = Want {
                from: None,
                to: None,
                limit: 300,
            };
            let (_, v) = self
                .cache
                .read(&key(&self.ids[n]), self.grid(), sma(), want)
                .await
                .unwrap();
            v.columns[0].1.iter().map(|x| x.to_bits()).collect()
        }

        fn holds(&self, n: usize) -> bool {
            self.cache.frames.lock().contains(&key(&self.ids[n]))
        }
    }

    #[tokio::test]
    async fn the_least_recently_used_idle_frames_go_and_followed_ones_stay() {
        let probe = world(usize::MAX).await;
        probe.read(0).await;
        let one = probe.cache.frames.lock().bytes();
        assert!(one > 0);

        let w = world(one * 3 / 2).await;
        let first = w.read(0).await;
        w.read(1).await;
        assert!(!w.holds(0), "past the budget, the least recently used goes");
        assert!(w.holds(1));

        let shown = w.cache.cell(&key(&w.ids[1]), w.grid());
        w.read(2).await;
        assert!(w.holds(1) && w.holds(2), "a followed frame is not counted");
        w.read(3).await;
        assert!(w.holds(1), "a followed frame is never evicted");
        assert!(!w.holds(2) && w.holds(3));
        assert!(w.cache.frames.lock().bytes() <= one * 3 / 2 + one);
        drop(shown);

        assert_eq!(
            w.read(0).await,
            first,
            "read again, the values are computed again, the same"
        );
    }

    #[tokio::test]
    async fn every_interval_reads_the_opening_levels_one_minute_bars_measure() {
        let w = world(INDICATOR_CACHE_BYTES).await;
        let id = &w.ids[0];
        let on = |tf: Timeframe| {
            let key = FrameKey {
                instrument: id.clone(),
                bars: BarKind::Time(tf),
                session: SessionFilter::All,
            };
            let grid = Grid {
                calendar: tessera_core::session::SessionCalendar::CmeEquityIndex,
                bars: BarKind::Time(tf),
                session: SessionFilter::All,
            };
            (key, grid)
        };
        let want = Want {
            from: None,
            to: None,
            limit: 20_000,
        };
        let read = |tf: Timeframe| {
            let (key, grid) = on(tf);
            let cache = Arc::clone(&w.cache);
            async move {
                cache
                    .read(&key, grid, built_in(LayerKind::OpeningRange), want)
                    .await
                    .unwrap()
                    .1
            }
        };
        let column =
            |v: &Values, k: &str| v.columns.iter().find(|(c, _)| c == k).unwrap().1.clone();
        let minutes = read(Timeframe::M1).await;
        let closing: std::collections::BTreeMap<_, _> = {
            let cal = tessera_core::session::SessionCalendar::CmeEquityIndex;
            let mut last = std::collections::BTreeMap::new();
            for (i, t) in minutes.time.iter().enumerate() {
                let row: Vec<u64> = ["orHigh", "orLow", "ibHigh", "ibLow", "up100"]
                    .iter()
                    .map(|k| column(&minutes, k)[i].to_bits())
                    .collect();
                last.insert(cal.trade_date(Timestamp(*t)), row);
            }
            last
        };
        let measured = closing
            .values()
            .filter(|row| !f64::from_bits(row[4]).is_nan())
            .count();
        assert!(measured >= 2, "the mock's sessions measure a balance");
        for tf in [Timeframe::M30, Timeframe::H1, Timeframe::H4, Timeframe::D1] {
            let v = read(tf).await;
            let cal = tessera_core::session::SessionCalendar::CmeEquityIndex;
            let i = v.time.len() - 1;
            let date = cal.trade_date(Timestamp(v.time[i]));
            let row: Vec<u64> = ["orHigh", "orLow", "ibHigh", "ibLow", "up100"]
                .iter()
                .map(|k| column(&v, k)[i].to_bits())
                .collect();
            assert_eq!(
                Some(&row),
                closing.get(&date),
                "{tf}: the session's last bar"
            );
            let drawn = v
                .time
                .iter()
                .enumerate()
                .filter(|(k, _)| !column(&v, "ibHigh")[*k].is_nan());
            assert!(drawn.count() > 0, "{tf} draws its levels");
        }
    }

    fn built_in(kind: LayerKind) -> Resolved {
        let inputs = Map::new();
        Resolved {
            key: StudyKey {
                id: StudyId::Builtin(kind),
                params: kind.as_str().into(),
            },
            study: native(kind, &inputs).unwrap(),
        }
    }

    struct Hubbed {
        cache: Arc<IndicatorCache>,
        mock: MockMarket,
        id: InstrumentId,
        key: FrameKey,
        grid: Grid,
    }

    async fn hubbed() -> Hubbed {
        use tessera_host::{EventBus, TopicSizing};
        use tessera_protocol::topics::names;

        let now = Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap();
        let clock = Arc::new(ManualClock::new(now));
        let mut cfg = MockConfig::new(Arc::clone(&clock) as _);
        cfg.intraday_sessions = 2;
        cfg.daily_sessions = 5;
        let mock = MockMarket::new(cfg);
        let router = MarketRouter::new();
        router.add(Arc::new(mock.clone())).unwrap();
        let bus = Arc::new(EventBus::new());
        for t in [
            names::MARKET_TRADES,
            names::MARKET_DEPTH,
            names::MARKET_FOOTPRINT,
        ] {
            bus.register(t, TopicSizing::MARKET).unwrap();
        }
        let hub = MarketHub::new(Arc::clone(&router), bus);
        hub.set_linger(std::time::Duration::ZERO);
        let cache = IndicatorCache::new(
            Arc::clone(&router),
            Some(hub),
            clock,
            Arc::new(Semaphore::new(2)),
            INDICATOR_CACHE_BYTES,
            Arc::new(|_, _, _| {}),
        );
        let id = router.resolve("NQ").await.unwrap();
        let calendar = mock.spec(&id).await.unwrap().1.sessions;
        let key = FrameKey {
            instrument: id.clone(),
            bars: BarKind::Time(Timeframe::M5),
            session: SessionFilter::All,
        };
        let grid = Grid {
            calendar,
            bars: BarKind::Time(Timeframe::M5),
            session: SessionFilter::All,
        };
        Hubbed {
            cache,
            mock,
            id,
            key,
            grid,
        }
    }

    fn assert_same_values(cached: &Values, whole: &Values, at: usize) {
        assert_eq!(cached.time[..], whole.time[at..]);
        for ((k, a), (_, b)) in cached.columns.iter().zip(&whole.columns) {
            let differs = a
                .iter()
                .zip(&b[at..])
                .position(|(x, y)| x.to_bits() != y.to_bits());
            assert_eq!(a.len(), b.len() - at, "{k}");
            if let Some(i) = differs {
                panic!(
                    "{k} at bar {i} is {} where a frame read whole has {}",
                    a[i],
                    b[at + i]
                );
            }
        }
    }

    async fn assert_measured_from_every_print(
        h: &Hubbed,
        open: i64,
        delta: &Values,
        vwap: &Values,
    ) -> usize {
        use tessera_core::market::Aggressor;

        let last_end = delta.time[delta.time.len() - 1] + Timeframe::M5.nanos();
        let mut prints = Vec::new();
        let mut at = open;
        while at < last_end {
            let end = (at + 900_000_000_000).min(last_end);
            let window = h
                .mock
                .get_trades(tessera_market::TradesRequest {
                    instrument: h.id.clone(),
                    from: Some(Timestamp(at)),
                    to: Some(Timestamp(end)),
                    limit: Some(100_000),
                })
                .await
                .unwrap();
            assert!(window.len() < 100_000);
            prints.extend(window);
            at = end;
        }
        let column =
            |v: &Values, k: &str| v.columns.iter().find(|(c, _)| c == k).unwrap().1.clone();
        let (cvd, mid) = (column(delta, "close"), column(vwap, "vwap"));
        for (i, t) in delta.time.iter().enumerate() {
            let end = t + Timeframe::M5.nanos();
            let (mut total, mut v, mut pv) = (0.0, 0.0, 0.0);
            for p in prints.iter().filter(|p| p.ts.0 < end) {
                let size = p.size.to_f64();
                total += match p.aggressor {
                    Aggressor::Buy => size,
                    Aggressor::Sell => -size,
                    Aggressor::Unknown => 0.0,
                };
                v += size;
                pv += p.price.to_f64() * size;
            }
            assert_eq!(
                cvd[i], total,
                "bar {i}: the CVD of every print since the open"
            );
            assert!(
                (mid[i] - pv / v).abs() < 1e-6,
                "bar {i}: {} vs {}",
                mid[i],
                pv / v
            );
        }
        prints.len()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_watch_dropped_away_from_the_runtime_while_its_frame_is_busy_is_still_let_go() {
        let h = hubbed().await;
        let watch = WatchKey("cvd".into());
        let watching = h
            .cache
            .watch(
                &h.key,
                h.grid,
                built_in(LayerKind::Delta),
                Watcher {
                    watch: watch.clone(),
                    asked: Asked {
                        indicator: "delta".into(),
                        tf: Timeframe::M5,
                        version: None,
                        inputs: Map::new(),
                    },
                    from: None,
                    catch_up: true,
                },
            )
            .await
            .unwrap();
        let cell = watching.guard.cell();
        assert!(cell.frame.lock().await.is_watched(&watch));
        let busy = cell.frame.lock().await;
        let dropped = std::thread::spawn(move || drop(watching));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(busy);
        tokio::task::spawn_blocking(move || dropped.join().unwrap())
            .await
            .unwrap();
        assert!(!cell.frame.lock().await.is_watched(&watch));
    }

    #[tokio::test]
    async fn a_session_reached_back_over_its_open_is_read_from_its_open() {
        let h = hubbed().await;
        let now = Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap();
        let session = h
            .grid
            .calendar
            .session(h.grid.calendar.trade_date(now))
            .unwrap();
        let mid = session.open.0 + 150 * 60_000_000_000;
        let watching = h
            .cache
            .watch(
                &h.key,
                h.grid,
                built_in(LayerKind::Delta),
                Watcher {
                    watch: WatchKey("cvd".into()),
                    asked: Asked {
                        indicator: "delta".into(),
                        tf: Timeframe::M5,
                        version: None,
                        inputs: Map::new(),
                    },
                    from: Some(mid),
                    catch_up: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            watching.snapshot.change.time.first(),
            Some(&mid),
            "opened mid-session"
        );
        let cell = watching.guard.cell();
        h.cache.settle_flow(&cell, i64::MIN, None).await;
        let before = session.open.0 - 120 * 60_000_000_000;
        h.cache.reach(&h.key, h.grid, before).await.unwrap();
        h.cache.settle_flow(&cell, i64::MIN, None).await;
        let read = |h: &Hubbed, from: i64| {
            let want = Want {
                from: Some(from),
                to: None,
                limit: 2_000,
            };
            let (cache, key, grid) = (Arc::clone(&h.cache), h.key.clone(), h.grid);
            async move {
                let (_, delta) = cache
                    .read(&key, grid, built_in(LayerKind::Delta), want)
                    .await
                    .unwrap();
                let (_, vwap) = cache
                    .read(&key, grid, built_in(LayerKind::Vwap), want)
                    .await
                    .unwrap();
                (delta, vwap)
            }
        };
        let (delta, vwap) = read(&h, session.open.0).await;
        assert_eq!(delta.time[0], session.open.0);
        assert_measured_from_every_print(&h, session.open.0, &delta, &vwap).await;
        let fresh = hubbed().await;
        let (whole_delta, whole_vwap) = read(&fresh, before).await;
        let at = whole_delta
            .time
            .iter()
            .position(|t| *t == session.open.0)
            .unwrap();
        assert_same_values(&delta, &whole_delta, at);
        assert_same_values(&vwap, &whole_vwap, at);
        assert!(
            cell.frame
                .lock()
                .await
                .rows()
                .iter()
                .all(|r| r.flow.known())
        );
    }

    #[tokio::test]
    async fn a_bar_a_correction_puts_inside_a_session_already_read_is_read() {
        let h = hubbed().await;
        let now = Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap();
        let session = h
            .grid
            .calendar
            .session(h.grid.calendar.trade_date(now))
            .unwrap();
        let before = session.open.0 - 120 * 60_000_000_000;
        let watching = h
            .cache
            .watch(
                &h.key,
                h.grid,
                built_in(LayerKind::Delta),
                Watcher {
                    watch: WatchKey("cvd".into()),
                    asked: Asked {
                        indicator: "delta".into(),
                        tf: Timeframe::M5,
                        version: None,
                        inputs: Map::new(),
                    },
                    from: Some(before),
                    catch_up: true,
                },
            )
            .await
            .unwrap();
        let cell = watching.guard.cell();
        h.cache.settle_flow(&cell, i64::MIN, None).await;
        let gone = session.open.0 + 150 * 60_000_000_000;
        let source = {
            let mut f = cell.frame.lock().await;
            assert!(f.rows().find(gone).is_ok());
            f.put_bars(Span::new(gone, gone), &[]);
            assert!(
                f.flow_asks(i64::MIN, Pulls::Sessions(5)).is_empty(),
                "the session was read before the correction"
            );
            f.source().unwrap().to_owned()
        };
        h.cache
            .written(Some(&BarsWritten {
                source,
                instrument: h.id.clone(),
                base: Timeframe::M1,
                from: Timestamp(gone),
                to: Timestamp(gone + Timeframe::M5.nanos()),
            }))
            .await;
        h.cache.refresh(&cell, false).await.unwrap();
        assert!(
            cell.frame.lock().await.rows().find(gone).is_ok(),
            "the correction put the bar back"
        );
        h.cache.settle_flow(&cell, i64::MIN, None).await;
        let read = |h: &Hubbed| {
            let want = Want {
                from: Some(session.open.0),
                to: None,
                limit: 2_000,
            };
            let (cache, key, grid) = (Arc::clone(&h.cache), h.key.clone(), h.grid);
            async move {
                let (_, delta) = cache
                    .read(&key, grid, built_in(LayerKind::Delta), want)
                    .await
                    .unwrap();
                let (_, vwap) = cache
                    .read(&key, grid, built_in(LayerKind::Vwap), want)
                    .await
                    .unwrap();
                (delta, vwap)
            }
        };
        let (delta, vwap) = read(&h).await;
        let fresh = hubbed().await;
        let (whole_delta, whole_vwap) = read(&fresh).await;
        assert_same_values(&delta, &whole_delta, 0);
        assert_same_values(&vwap, &whole_vwap, 0);
        assert_eq!(delta.time[0], session.open.0);
        assert_measured_from_every_print(&h, session.open.0, &delta, &vwap).await;
        assert!(
            cell.frame
                .lock()
                .await
                .rows()
                .iter()
                .all(|r| r.flow.known())
        );
    }

    #[tokio::test]
    async fn a_session_with_more_prints_than_one_read_takes_is_read_whole() {
        let h = hubbed().await;
        h.cache.set_flow_budget(20_000);
        let want = Want {
            from: None,
            to: None,
            limit: 60,
        };
        let (_, delta) = h
            .cache
            .read(&h.key, h.grid, built_in(LayerKind::Delta), want)
            .await
            .unwrap();
        let (_, vwap) = h
            .cache
            .read(&h.key, h.grid, built_in(LayerKind::Vwap), want)
            .await
            .unwrap();
        let calendar = h.grid.calendar;
        let session = calendar
            .session(calendar.trade_date(Timestamp(delta.time[0])))
            .unwrap();
        assert!(session.open.0 < delta.time[0]);
        let prints = assert_measured_from_every_print(&h, session.open.0, &delta, &vwap).await;
        assert!(prints > 100_000, "more prints than five reads take");
        let cell = h.cache.find(&h.key).unwrap();
        assert!(
            cell.frame
                .lock()
                .await
                .rows()
                .iter()
                .all(|r| r.flow.known())
        );
    }
}
