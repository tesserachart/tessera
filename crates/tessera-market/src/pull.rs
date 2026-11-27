use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use chrono::NaiveDate;
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::backoff::Backoff;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_DAY, NANOS_PER_MINUTE};
use tessera_core::{InstrumentId, SharedClock, Timeframe, Timestamp};
use tessera_protocol::cards::Held;
pub use tessera_protocol::cards::PullState;
use tessera_store::ticks::Span;
use ts_rs::TS;

use crate::history::Read;
use crate::metered::HistoryMeter;
use crate::provider::{BarsRequest, MarketDataProvider, MarketError, exchange_contract};
use crate::roll::{front_on, fronts_since};
use crate::router::MarketRouter;
use crate::saved::{self, Contract, SavedTrades};

pub const PULL_CHUNK: i64 = 30 * NANOS_PER_MINUTE;
pub const MAX_PULL_DAYS: i64 = 800;
pub const SERVED_RETRY: std::time::Duration = std::time::Duration::from_secs(2);
pub const AUTO_SETTING: &str = "market.autoDownload";
pub const RETRY_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
const RETRY: Backoff = Backoff::new(Duration::from_secs(60), Duration::from_secs(60 * 60));
const DEFAULT_LOOKBACK_DAYS: i64 = 400;

/// Which part of each trading day to keep: the regular session or the whole session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Regular trading hours: 09:30 to 16:00 New York for CME equity-index futures (13:00 on
    /// early-close days).
    Rth,
    /// The whole trading session: for CME Globex, 18:00 New York the evening before to 17:00.
    Session,
}

impl Scope {
    fn word(self) -> &'static str {
        match self {
            Scope::Rth => "rth",
            Scope::Session => "session",
        }
    }
}

/// A date-range pull: every trading day from `from` to `to` (trade dates, inclusive).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullRequest {
    /// A dated contract (`NQZ6`, `NQZ6.CME`) or a futures root (`NQ`). A root follows the roll:
    /// each day comes from the contract that was the front month that day.
    pub instrument: String,
    /// First trade date, `YYYY-MM-DD`.
    #[ts(type = "string")]
    pub from: NaiveDate,
    /// Last trade date, `YYYY-MM-DD` (inclusive). Days after today are left out.
    #[ts(type = "string")]
    pub to: NaiveDate,
    /// `rth` for regular trading hours, `session` for the whole session.
    pub scope: Scope,
}

/// What happened to one trading day of a pull.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DayStatus {
    /// Not fetched yet.
    Waiting,
    /// Failed before; the resume asks it once more.
    Retry {
        /// Attempts so far.
        tries: u32,
    },
    /// Fetched and saved. `prints` counts the prints this pull fetched (a day partly saved
    /// before fetched only what was missing).
    Saved {
        /// Prints fetched.
        #[ts(type = "number")]
        prints: u64,
    },
    /// Already on disk whole: nothing was asked.
    AlreadySaved,
    /// The connection answered, with no prints at all.
    NoTrades,
    /// Older than the connection keeps history for: nothing was asked.
    OutOfReach,
    /// Asked, but the connection has not sent all of it yet (its newest sessions reach its
    /// history late). With market.autoDownload on it is asked again on its own; resume asks it
    /// again at once.
    Later {
        /// Attempts so far.
        tries: u32,
        /// When it was last asked.
        #[ts(type = "number")]
        at: Timestamp,
    },
    /// The connection did not answer (after its retries). With market.autoDownload on it is
    /// asked again on its own, less often each time; resume asks it again at once.
    Failed {
        /// Why.
        reason: String,
        /// Attempts so far.
        tries: u32,
        /// When it was last asked.
        #[serde(default)]
        #[ts(type = "number | null")]
        at: Option<Timestamp>,
    },
}

impl DayStatus {
    fn pending(&self) -> Option<u32> {
        match self {
            DayStatus::Waiting => Some(0),
            DayStatus::Retry { tries } => Some(*tries),
            _ => None,
        }
    }

    fn due(&self, now: Timestamp) -> Option<u32> {
        let (tries, at) = match self {
            DayStatus::Later { tries, at } => (*tries, *at),
            DayStatus::Failed {
                tries,
                at: Some(at),
                ..
            } => (*tries, *at),
            _ => return None,
        };
        let wait = i64::try_from(RETRY.delay(tries).as_nanos()).unwrap_or(i64::MAX);
        (now.0 - at.0 >= wait).then_some(tries)
    }

    pub fn open(&self) -> bool {
        !self.answered() && *self != DayStatus::OutOfReach
    }

    pub fn answered(&self) -> bool {
        matches!(
            self,
            DayStatus::Saved { .. } | DayStatus::AlreadySaved | DayStatus::NoTrades
        )
    }
}

/// One trading day of a pull.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullDay {
    /// The trade date.
    #[ts(type = "string")]
    pub date: NaiveDate,
    /// The dated contract fetched for it.
    pub contract: InstrumentId,
    /// The connection it is fetched from.
    pub source: String,
    /// What happened.
    pub status: DayStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangePull {
    pub id: String,
    pub request: PullRequest,
    pub calendar: SessionCalendar,
    pub state: PullState,
    pub created: Timestamp,
    pub days: Vec<PullDay>,
    #[serde(default)]
    pub auto: bool,
}

impl RangePull {
    fn protected(&self) -> HashMap<Contract, BTreeSet<NaiveDate>> {
        let mut out: HashMap<Contract, BTreeSet<NaiveDate>> = HashMap::new();
        for d in &self.days {
            out.entry(Contract::new(&d.source, &d.contract))
                .or_default()
                .insert(d.date);
        }
        out
    }

    fn resume(&mut self) {
        self.state = PullState::Running;
        for d in &mut self.days {
            if let DayStatus::Failed { tries, .. } | DayStatus::Later { tries, .. } = d.status {
                d.status = DayStatus::Retry { tries };
            }
        }
    }

    fn add_days(&mut self, planned: Vec<PullDay>) -> bool {
        let known: BTreeSet<NaiveDate> = self.days.iter().map(|d| d.date).collect();
        let before = self.days.len();
        self.days
            .extend(planned.into_iter().filter(|d| !known.contains(&d.date)));
        self.days.sort_by_key(|d| d.date);
        self.days.len() > before
    }

    fn retry_due(&mut self, now: Timestamp) -> bool {
        let mut any = false;
        for d in &mut self.days {
            if let Some(tries) = d.status.due(now) {
                d.status = DayStatus::Retry { tries };
                any = true;
            }
        }
        any
    }

    fn has_unplanned_day(&self, now: Timestamp) -> bool {
        let Some(last) = self.days.last().map(|d| d.date) else {
            return false;
        };
        let to = self.request.to.min(self.calendar.trade_date(now));
        let Some(next) = last.succ_opt() else {
            return false;
        };
        next <= to
            && self
                .calendar
                .sessions_between(next, to)
                .into_iter()
                .any(|s| ended(self.calendar, s.trade_date, self.request.scope, now))
    }

    fn next_day(&self) -> Option<usize> {
        self.days.iter().rposition(|d| d.status.pending().is_some())
    }
}

/// Counts of a pull's days by what happened to them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    /// Trading days in the range.
    pub days: u32,
    /// Fetched and saved.
    pub saved: u32,
    /// Already on disk whole.
    pub already_saved: u32,
    /// Answered with no prints.
    pub no_trades: u32,
    /// Older than the connection keeps.
    pub out_of_reach: u32,
    /// Failed (asked again later).
    pub failed: u32,
    /// Not all sent by the connection yet (asked again later).
    pub later: u32,
    /// Still to fetch.
    pub waiting: u32,
    /// Prints fetched so far.
    #[ts(type = "number")]
    pub prints: u64,
}

/// The day being fetched right now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullCurrent {
    /// Its trade date.
    #[ts(type = "string")]
    pub date: NaiveDate,
    /// Half-hour pieces answered so far.
    pub pieces_done: u32,
    /// Half-hour pieces the day needs (only the parts not already saved).
    pub pieces: u32,
    /// The connection the day waits for while it does not serve the contract yet (it has not
    /// connected since the app started, or it is connecting). Waiting is not a try.
    pub waiting_for: Option<String>,
    /// Why the connection cannot answer now, in a few plain words (`the connection was taken by
    /// another login`); none while it is only not connected yet.
    pub waiting_why: Option<String>,
}

/// A date-range pull and its progress.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullSummary {
    /// The pull's id (`NQ-2026-07-21-2026-10-20-rth`).
    pub id: String,
    /// What was asked.
    pub request: PullRequest,
    /// Where it stands.
    pub state: PullState,
    /// Its days counted by what happened to them.
    pub progress: PullProgress,
    /// The day being fetched now, if any.
    pub current: Option<PullCurrent>,
    /// Seconds left at the pace of the pieces fetched so far (none until one is in).
    #[ts(type = "number | null")]
    pub eta_seconds: Option<u64>,
    /// Every trading day of the range, oldest first.
    pub days: Vec<PullDay>,
    /// Started by Tessera itself (setting market.autoDownload) because something needed these
    /// days, not by a request.
    pub auto: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoverageDay {
    pub date: NaiveDate,
    pub contract: InstrumentId,
    pub prints: Held,
    pub bars: Held,
    pub out_of_reach: bool,
    pub source: String,
}

fn held(want: &[Span], missing: &[Span]) -> Held {
    let len = |s: &[Span]| s.iter().map(|w| w.end - w.start).sum::<i64>();
    match len(missing) {
        0 => Held::Saved,
        m if m >= len(want) => Held::Missing,
        _ => Held::Partial,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PullError {
    #[error("{0}")]
    Invalid(String),
    #[error("no pull {0}")]
    NotFound(String),
    #[error(transparent)]
    Market(#[from] MarketError),
}

pub fn pull_id(req: &PullRequest) -> String {
    format!(
        "{}-{}-{}-{}",
        req.instrument.trim().to_ascii_uppercase(),
        req.from,
        req.to,
        req.scope.word()
    )
}

fn ended(calendar: SessionCalendar, date: NaiveDate, scope: Scope, now: Timestamp) -> bool {
    day_spans(calendar, date, scope)
        .last()
        .is_some_and(|w| w.end <= now.0)
}

pub fn day_spans(calendar: SessionCalendar, date: NaiveDate, scope: Scope) -> Vec<Span> {
    let Some(s) = calendar.session(date) else {
        return Vec::new();
    };
    let windows = match scope {
        Scope::Rth => s.rth.into_iter().collect(),
        Scope::Session => s.segments,
    };
    windows
        .into_iter()
        .map(|w| Span::new(w.start.0, w.end.0))
        .filter(|s| !s.is_empty())
        .collect()
}

fn pieces(holes: &[Span]) -> Vec<Span> {
    let mut out = Vec::new();
    for h in holes {
        let mut at = h.start;
        while at < h.end {
            let end = (at + PULL_CHUNK).min(h.end);
            out.push(Span::new(at, end));
            at = end;
        }
    }
    out
}

fn check_range(req: &PullRequest) -> Result<(), PullError> {
    if req.from > req.to {
        return Err(PullError::Invalid(format!(
            "from {} is after to {}",
            req.from, req.to
        )));
    }
    if (req.to - req.from).num_days() > MAX_PULL_DAYS {
        return Err(PullError::Invalid(format!(
            "a pull spans at most {MAX_PULL_DAYS} days"
        )));
    }
    Ok(())
}

pub struct Market {
    pub id: InstrumentId,
    pub conn: Arc<dyn MarketDataProvider>,
    pub instrument: Instrument,
    pub spec: ContractSpec,
}

impl Market {
    pub fn calendar(&self) -> SessionCalendar {
        self.spec.sessions
    }
}

pub async fn market_of(router: &MarketRouter, input: &str) -> Result<Market, PullError> {
    let id = router.resolve(input).await?;
    let conn = router.route_async(&id).await?;
    let (instrument, spec) = conn.spec(&id).await?;
    if spec.asset_class == AssetClass::Index {
        return Err(PullError::Invalid(format!(
            "{id} is an index: it does not trade"
        )));
    }
    Ok(Market {
        id,
        conn,
        instrument,
        spec,
    })
}

pub async fn plan(
    router: &MarketRouter,
    saved: &Arc<SavedTrades>,
    req: &PullRequest,
    now: Timestamp,
) -> Result<RangePull, PullError> {
    check_range(req)?;
    let market = market_of(router, &req.instrument).await?;
    plan_on(router, saved, &market, req, now).await
}

pub async fn plan_on(
    router: &MarketRouter,
    saved: &Arc<SavedTrades>,
    market: &Market,
    req: &PullRequest,
    now: Timestamp,
) -> Result<RangePull, PullError> {
    check_range(req)?;
    let Market {
        id,
        conn,
        instrument,
        spec,
    } = market;
    let calendar = spec.sessions;
    let today = calendar.trade_date(now);
    let is_root = exchange_contract(instrument)
        .is_some_and(|c| c.expiry.is_some() && req.instrument.trim().eq_ignore_ascii_case(&c.root));
    let runs = if is_root {
        fronts_since(router, conn, instrument, spec, req.from, today).await
    } else {
        vec![crate::roll::FrontRun {
            instrument: id.clone(),
            since: None,
        }]
    };
    let mut specs = Vec::new();
    for r in &runs {
        if let Ok(found) = conn.spec(&r.instrument).await {
            specs.push(found);
        }
    }
    let (keeper, source) = (Arc::clone(saved), conn.id().to_owned());
    let _ = tokio::task::spawn_blocking(move || {
        for (i, s) in &specs {
            keeper.remember_contract(&source, i, s);
        }
    })
    .await;
    let lookback = conn
        .capabilities()
        .max_intraday_history_days
        .map_or(DEFAULT_LOOKBACK_DAYS, i64::from);
    let reach = now.0 - (lookback - 1) * NANOS_PER_DAY;
    let days: Vec<PullDay> = calendar
        .sessions_between(req.from, req.to.min(today))
        .into_iter()
        .filter(|s| ended(calendar, s.trade_date, req.scope, now))
        .filter_map(|s| {
            let contract = front_on(&runs, s.trade_date)?.clone();
            Some(PullDay {
                date: s.trade_date,
                contract,
                source: conn.id().to_owned(),
                status: if s.open.0 < reach {
                    DayStatus::OutOfReach
                } else {
                    DayStatus::Waiting
                },
            })
        })
        .collect();
    if days.is_empty() {
        return Err(PullError::Invalid(format!(
            "no trading day of {} between {} and {} has ended",
            req.instrument, req.from, req.to
        )));
    }
    Ok(RangePull {
        id: pull_id(req),
        request: req.clone(),
        calendar,
        state: PullState::Running,
        created: now,
        days,
        auto: false,
    })
}

struct Work {
    saved: Arc<SavedTrades>,
    router: Arc<MarketRouter>,
    clock: SharedClock,
    jobs: Mutex<BTreeMap<String, RangePull>>,
    current: Mutex<Option<(String, PullCurrent)>>,
    paced: Mutex<HashMap<String, Pace>>,
    changed: tokio::sync::watch::Sender<u64>,
    wake: tokio::sync::Notify,
    disk: tokio::sync::Mutex<()>,
    auto: std::sync::atomic::AtomicBool,
}

#[derive(Clone, Copy, Debug)]
struct Pace {
    since: std::time::Instant,
    pieces: u32,
}

pub struct Pulls {
    work: Arc<Work>,
    meter: Arc<HistoryMeter>,
    runner: tokio::task::JoinHandle<()>,
    metering: tokio::task::JoinHandle<()>,
}

impl std::fmt::Debug for Pulls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pulls")
            .field("pulls", &self.work.jobs.lock().len())
            .finish_non_exhaustive()
    }
}

impl Drop for Pulls {
    fn drop(&mut self) {
        self.runner.abort();
        self.metering.abort();
    }
}

impl Pulls {
    pub async fn open(
        saved: Arc<SavedTrades>,
        router: Arc<MarketRouter>,
        clock: SharedClock,
    ) -> tessera_store::Result<Arc<Self>> {
        let store = Arc::clone(saved.store());
        let kept = tokio::task::spawn_blocking(move || store.pulls())
            .await
            .map_err(|e| tessera_store::StoreError::Invalid(e.to_string()))??;
        let mut jobs = BTreeMap::new();
        let mut resumed = Vec::new();
        for (id, body) in kept {
            match serde_json::from_str::<RangePull>(&body) {
                Ok(mut pull) => {
                    if pull.state == PullState::Running {
                        pull.resume();
                        resumed.push(id.clone());
                    }
                    saved.protect(&pull.id, pull.protected());
                    jobs.insert(id, pull);
                }
                Err(e) => tracing::warn!(pull = %id, error = %e, "a saved pull is unreadable"),
            }
        }
        let meter = HistoryMeter::new(
            Arc::clone(&router),
            Arc::clone(saved.store()),
            Arc::clone(&clock),
        );
        let work = Arc::new(Work {
            saved,
            router,
            clock,
            jobs: Mutex::new(jobs),
            current: Mutex::new(None),
            paced: Mutex::new(HashMap::new()),
            changed: tokio::sync::watch::channel(0).0,
            wake: tokio::sync::Notify::new(),
            disk: tokio::sync::Mutex::new(()),
            auto: std::sync::atomic::AtomicBool::new(true),
        });
        for id in resumed {
            work.persist(&id).await;
        }
        let runner = tokio::spawn(run(Arc::clone(&work)));
        let metering = meter.spawn();
        Ok(Arc::new(Self {
            work,
            meter,
            runner,
            metering,
        }))
    }

    pub fn meter(&self) -> &Arc<HistoryMeter> {
        &self.meter
    }

    pub fn saved(&self) -> &Arc<SavedTrades> {
        &self.work.saved
    }

    pub fn changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.work.changed.subscribe()
    }

    pub fn auto(&self) -> bool {
        self.work.auto.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn set_auto(&self, on: bool) {
        self.work
            .auto
            .store(on, std::sync::atomic::Ordering::Relaxed);
        self.work.wake.notify_one();
        self.work.bump();
    }

    pub fn connection_name(&self, source: &str) -> String {
        self.work.router.get(source).map_or_else(
            || "the connection".to_owned(),
            |c| c.display_name().to_owned(),
        )
    }

    pub async fn fill(&self, req: &PullRequest, days: &[CoverageDay]) -> Option<PullSummary> {
        if !self.auto() {
            return None;
        }
        let wanted: Vec<NaiveDate> = days
            .iter()
            .filter(|d| !d.out_of_reach && (d.prints != Held::Saved || d.bars != Held::Saved))
            .map(|d| d.date)
            .collect();
        if wanted.is_empty() {
            return None;
        }
        let id = pull_id(req);
        let known = self.work.jobs.lock().get(&id).map(|p| {
            (
                p.state,
                p.days.iter().map(|d| d.date).collect::<BTreeSet<_>>(),
            )
        });
        match known {
            Some((PullState::Cancelled, _)) => return None,
            Some((_, planned)) if wanted.iter().all(|d| planned.contains(d)) => return None,
            _ => {}
        }
        match self.start_as(req.clone(), true).await {
            Ok(s) => Some(s),
            Err(e) => {
                tracing::warn!(pull = %id, error = %e, "missing days were not downloaded");
                None
            }
        }
    }

    pub async fn retry_due(&self) {
        self.work.retry_due().await;
        self.work.wake.notify_one();
    }

    pub async fn coverage(&self, req: &PullRequest) -> Result<Vec<CoverageDay>, PullError> {
        let planned = plan(
            &self.work.router,
            &self.work.saved,
            req,
            self.work.clock.now(),
        )
        .await?;
        let mut minutes: HashMap<(String, InstrumentId), Vec<Span>> = HashMap::new();
        if let Some(bars) = self.work.router.bar_cache() {
            for d in &planned.days {
                if let std::collections::hash_map::Entry::Vacant(slot) =
                    minutes.entry((d.source.clone(), d.contract.clone()))
                {
                    slot.insert(bars.minutes_covered(&d.source, &d.contract).await);
                }
            }
        }
        let store = Arc::clone(self.work.saved.store());
        let (scope, calendar) = (req.scope, planned.calendar);
        tokio::task::spawn_blocking(move || {
            planned
                .days
                .iter()
                .map(|d| {
                    let spans = day_spans(calendar, d.date, scope);
                    let contract = Contract::new(&d.source, &d.contract);
                    let unsaved: Vec<Span> = spans
                        .iter()
                        .flat_map(|w| {
                            store
                                .missing(contract.key(), w.start, w.end)
                                .unwrap_or_else(|_| vec![*w])
                        })
                        .collect();
                    let covered = minutes
                        .get(&(d.source.clone(), d.contract.clone()))
                        .map_or(&[][..], Vec::as_slice);
                    let unbarred: Vec<Span> = spans
                        .iter()
                        .flat_map(|w| tessera_store::ticks::holes(covered, *w))
                        .collect();
                    CoverageDay {
                        date: d.date,
                        contract: d.contract.clone(),
                        prints: held(&spans, &unsaved),
                        bars: held(&spans, &unbarred),
                        out_of_reach: d.status == DayStatus::OutOfReach,
                        source: d.source.clone(),
                    }
                })
                .collect()
        })
        .await
        .map_err(|e| PullError::Invalid(e.to_string()))
    }

    pub async fn estimate(
        &self,
        input: crate::estimate::EstimatePullInput,
    ) -> Result<crate::estimate::PullEstimate, PullError> {
        crate::estimate::estimate(
            &self.work.router,
            &self.work.saved,
            self.work.clock.now(),
            input,
        )
        .await
    }

    pub async fn start(&self, req: PullRequest) -> Result<PullSummary, PullError> {
        self.start_as(req, false).await
    }

    async fn start_as(&self, req: PullRequest, auto: bool) -> Result<PullSummary, PullError> {
        let planned = plan(
            &self.work.router,
            &self.work.saved,
            &req,
            self.work.clock.now(),
        )
        .await?;
        let id = planned.id.clone();
        let protect = {
            let mut jobs = self.work.jobs.lock();
            let pull = jobs.entry(id.clone()).or_insert_with(|| RangePull {
                auto,
                ..planned.clone()
            });
            pull.add_days(planned.days);
            pull.protected()
        };
        self.work.saved.protect(&id, protect);
        self.resume(&id).await
    }

    pub async fn resume(&self, id: &str) -> Result<PullSummary, PullError> {
        self.work
            .jobs
            .lock()
            .get_mut(id)
            .ok_or_else(|| PullError::NotFound(id.to_owned()))?
            .resume();
        self.work.paced.lock().remove(id);
        self.work.persist(id).await;
        self.work.wake.notify_one();
        self.work.bump();
        self.summary(id)
    }

    pub async fn cancel(&self, id: &str) -> Result<PullSummary, PullError> {
        {
            let mut jobs = self.work.jobs.lock();
            let pull = jobs
                .get_mut(id)
                .ok_or_else(|| PullError::NotFound(id.to_owned()))?;
            if pull.state == PullState::Running {
                pull.state = PullState::Cancelled;
            }
        }
        self.work.paced.lock().remove(id);
        self.work.persist(id).await;
        self.work.bump();
        self.summary(id)
    }

    pub async fn release(&self, id: &str) -> Result<(), PullError> {
        if self.work.jobs.lock().remove(id).is_none() {
            return Err(PullError::NotFound(id.to_owned()));
        }
        self.work.saved.unprotect(id);
        self.work.paced.lock().remove(id);
        self.work.persist(id).await;
        self.work.bump();
        Ok(())
    }

    pub fn list(&self) -> Vec<PullSummary> {
        let jobs = self.work.jobs.lock();
        let current = self.work.current.lock().clone();
        let paced = self.work.paced.lock().clone();
        let mut out: Vec<PullSummary> = jobs
            .values()
            .map(|p| summarize(p, current.as_ref(), paced.get(&p.id)))
            .collect();
        out.sort_by_key(|s| std::cmp::Reverse(jobs[&s.id].created));
        out
    }

    pub fn summary(&self, id: &str) -> Result<PullSummary, PullError> {
        let jobs = self.work.jobs.lock();
        let pull = jobs
            .get(id)
            .ok_or_else(|| PullError::NotFound(id.to_owned()))?;
        Ok(summarize(
            pull,
            self.work.current.lock().as_ref(),
            self.work.paced.lock().get(id),
        ))
    }

    pub async fn settle(&self) {
        loop {
            let busy = self
                .work
                .jobs
                .lock()
                .values()
                .any(|p| p.state == PullState::Running);
            if !busy {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
}

fn eta(pull: &RangePull, current: Option<&PullCurrent>, pace: Option<&Pace>) -> Option<u64> {
    let pace = pace.filter(|p| p.pieces > 0)?;
    let per_piece = pace.since.elapsed().as_secs_f64() / f64::from(pace.pieces);
    let per_day = current.map_or(1, |c| c.pieces.max(1));
    let waiting = pull
        .days
        .iter()
        .filter(|d| d.status.pending().is_some() && current.is_none_or(|c| c.date != d.date))
        .count() as u32;
    let left = current.map_or(0, |c| c.pieces.saturating_sub(c.pieces_done)) + waiting * per_day;
    Some((f64::from(left) * per_piece).round() as u64)
}

fn summarize(
    pull: &RangePull,
    current: Option<&(String, PullCurrent)>,
    pace: Option<&Pace>,
) -> PullSummary {
    let mut p = PullProgress {
        days: pull.days.len() as u32,
        ..PullProgress::default()
    };
    for d in &pull.days {
        match &d.status {
            DayStatus::Waiting | DayStatus::Retry { .. } => p.waiting += 1,
            DayStatus::Saved { prints } => {
                p.saved += 1;
                p.prints += prints;
            }
            DayStatus::AlreadySaved => p.already_saved += 1,
            DayStatus::NoTrades => p.no_trades += 1,
            DayStatus::OutOfReach => p.out_of_reach += 1,
            DayStatus::Failed { .. } => p.failed += 1,
            DayStatus::Later { .. } => p.later += 1,
        }
    }
    let current = current
        .filter(|(id, _)| *id == pull.id && pull.state == PullState::Running)
        .map(|(_, c)| c.clone());
    PullSummary {
        id: pull.id.clone(),
        request: pull.request.clone(),
        state: pull.state,
        progress: p,
        eta_seconds: (pull.state == PullState::Running)
            .then(|| eta(pull, current.as_ref(), pace))
            .flatten(),
        current,
        days: pull.days.clone(),
        auto: pull.auto,
    }
}

enum Served {
    Yes,
    Stopped,
    Elsewhere(String),
}

struct Waiting {
    on: String,
    why: Option<String>,
}

struct DayJob {
    pull: String,
    day: PullDay,
    tries: u32,
    calendar: SessionCalendar,
    scope: Scope,
}

impl Work {
    fn next(&self) -> (Option<DayJob>, Vec<String>) {
        let mut jobs = self.jobs.lock();
        let mut running: Vec<&mut RangePull> = jobs
            .values_mut()
            .filter(|p| p.state == PullState::Running)
            .collect();
        running.sort_by_key(|p| p.created);
        let mut done = Vec::new();
        for pull in running {
            match pull.next_day() {
                Some(index) => {
                    let day = pull.days[index].clone();
                    return (
                        Some(DayJob {
                            pull: pull.id.clone(),
                            tries: day.status.pending().unwrap_or(0),
                            day,
                            calendar: pull.calendar,
                            scope: pull.request.scope,
                        }),
                        done,
                    );
                }
                None => {
                    pull.state = PullState::Done;
                    done.push(pull.id.clone());
                }
            }
        }
        (None, done)
    }

    fn running(&self, id: &str) -> bool {
        self.jobs
            .lock()
            .get(id)
            .is_some_and(|p| p.state == PullState::Running)
    }

    fn bump(&self) {
        self.changed.send_modify(|n| *n += 1);
    }

    fn finish(&self, job: &DayJob, status: DayStatus) {
        *self.current.lock() = None;
        if let Some(day) = self
            .jobs
            .lock()
            .get_mut(&job.pull)
            .and_then(|p| p.days.iter_mut().find(|d| d.date == job.day.date))
            .filter(|d| d.status.pending().is_some())
        {
            day.status = status;
        }
        self.bump();
    }

    fn progress(&self, job: &DayJob, pieces_done: usize, pieces: usize) {
        {
            let mut paced = self.paced.lock();
            let pace = paced.entry(job.pull.clone()).or_insert(Pace {
                since: std::time::Instant::now(),
                pieces: 0,
            });
            if pieces_done > 0 {
                pace.pieces += 1;
            }
        }
        self.show(job, pieces_done, pieces, None);
    }

    fn show(&self, job: &DayJob, pieces_done: usize, pieces: usize, waiting: Option<Waiting>) {
        let (waiting_for, waiting_why) = waiting.map_or((None, None), |w| (Some(w.on), w.why));
        let next = PullCurrent {
            date: job.day.date,
            pieces_done: pieces_done as u32,
            pieces: pieces as u32,
            waiting_for,
            waiting_why,
        };
        {
            let mut current = self.current.lock();
            if current
                .as_ref()
                .is_some_and(|(id, c)| *id == job.pull && *c == next)
            {
                return;
            }
            *current = Some((job.pull.clone(), next));
        }
        self.bump();
    }

    fn blocked(&self, job: &DayJob) -> Option<String> {
        self.router
            .get(&job.day.source)
            .and_then(|c| c.history_blocked())
    }

    async fn retry_due(&self) {
        if !self.auto.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let now = self.clock.now();
        let mut woke = Vec::new();
        let mut grow = Vec::new();
        for pull in self
            .jobs
            .lock()
            .values_mut()
            .filter(|p| p.state != PullState::Cancelled)
        {
            if pull.retry_due(now) {
                pull.state = PullState::Running;
                woke.push(pull.id.clone());
            }
            if pull.has_unplanned_day(now) {
                grow.push(pull.request.clone());
            }
        }
        for req in grow {
            let Ok(planned) = plan(&self.router, &self.saved, &req, now).await else {
                continue;
            };
            let protect = {
                let mut jobs = self.jobs.lock();
                let Some(pull) = jobs.get_mut(&planned.id) else {
                    continue;
                };
                if pull.state == PullState::Cancelled || !pull.add_days(planned.days) {
                    continue;
                }
                pull.state = PullState::Running;
                pull.protected()
            };
            self.saved.protect(&planned.id, protect);
            woke.push(planned.id);
        }
        if woke.is_empty() {
            return;
        }
        {
            let mut paced = self.paced.lock();
            for id in &woke {
                paced.remove(id);
            }
        }
        for id in &woke {
            self.persist(id).await;
        }
        self.bump();
    }

    async fn served(&self, job: &DayJob, pieces_done: usize, pieces: usize) -> Served {
        let mut changes = self.router.changes();
        let mut waited = false;
        loop {
            if !self.running(&job.pull) {
                return Served::Stopped;
            }
            let present = self.router.get(&job.day.source).is_some();
            let route = if present {
                self.router.route_async(&job.day.contract).await.ok()
            } else {
                None
            };
            match route {
                Some(conn) if conn.id() == job.day.source => {
                    if let Some(why) = conn.history_blocked() {
                        waited = true;
                        let on = conn.display_name().to_owned();
                        self.show(
                            job,
                            pieces_done,
                            pieces,
                            Some(Waiting { on, why: Some(why) }),
                        );
                        let _ = tokio::time::timeout(SERVED_RETRY, changes.changed()).await;
                        continue;
                    }
                    if waited {
                        self.progress(job, pieces_done, pieces);
                    }
                    return Served::Yes;
                }
                Some(conn) => {
                    return Served::Elsewhere(format!(
                        "{} now comes from {}, not {}",
                        job.day.contract,
                        conn.id(),
                        job.day.source
                    ));
                }
                None => {
                    waited = true;
                    let on = job.day.source.clone();
                    self.show(job, pieces_done, pieces, Some(Waiting { on, why: None }));
                    let _ = tokio::time::timeout(SERVED_RETRY, changes.changed()).await;
                }
            }
        }
    }

    async fn persist(&self, id: &str) {
        let _one = self.disk.lock().await;
        let body = self
            .jobs
            .lock()
            .get(id)
            .map(|p| serde_json::to_string(p).map(|b| (b, p.created)));
        let store = Arc::clone(self.saved.store());
        let id = id.to_owned();
        let now = self.clock.now().0;
        let wrote = tokio::task::spawn_blocking(move || match body {
            Some(Ok((body, _))) => store.put_pull(&id, &body, now),
            Some(Err(e)) => Err(tessera_store::StoreError::Invalid(e.to_string())),
            None => store.delete_pull(&id).map(|_| ()),
        })
        .await;
        match wrote {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "a pull was not kept on disk"),
            Err(e) => tracing::warn!(error = %e, "a pull was not kept on disk"),
        }
    }

    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&SavedTrades) -> tessera_store::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let saved = Arc::clone(&self.saved);
        match tokio::task::spawn_blocking(move || f(&saved)).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(e.to_string()),
            Err(e) => Err(e.to_string()),
        }
    }

    async fn holes(&self, contract: &Contract, spans: &[Span]) -> Result<Vec<Span>, String> {
        let (key, asked) = (contract.clone(), spans.to_vec());
        self.blocking(move |s| {
            let mut out = Vec::new();
            for span in asked {
                out.extend(s.store().missing(key.key(), span.start, span.end)?);
            }
            Ok(out)
        })
        .await
    }

    async fn keep_minutes(&self, job: &DayJob, spans: &[Span]) -> bool {
        let (Some(bars), Some(first), Some(last)) =
            (self.router.bar_cache(), spans.first(), spans.last())
        else {
            return true;
        };
        let covered = bars
            .minutes_covered(&job.day.source, &job.day.contract)
            .await;
        if spans
            .iter()
            .all(|w| tessera_store::ticks::holes(&covered, *w).is_empty())
        {
            return true;
        }
        match self.served(job, 0, 0).await {
            Served::Yes => {}
            Served::Stopped => return false,
            Served::Elsewhere(_) => return true,
        }
        let read = async {
            let conn = self.router.route_async(&job.day.contract).await?;
            let req = BarsRequest {
                instrument: job.day.contract.clone(),
                tf: Timeframe::M1,
                from: Some(Timestamp(first.start)),
                to: Some(Timestamp(last.end - 1)),
                limit: None,
                rth_only: false,
            };
            bars.get_bars(&conn, req, Read::Through).await
        };
        if let Err(e) = read.await {
            tracing::warn!(date = %job.day.date, instrument = %job.day.contract, error = %e, "the minutes of a pulled day were not kept");
        }
        true
    }

    async fn fetch_day(&self, job: &DayJob) -> Option<DayStatus> {
        let failed = |reason: String| {
            Some(DayStatus::Failed {
                reason,
                tries: job.tries + 1,
                at: Some(self.clock.now()),
            })
        };
        let contract = Contract::new(&job.day.source, &job.day.contract);
        let spans = day_spans(job.calendar, job.day.date, job.scope);
        let holes = match self.holes(&contract, &spans).await {
            Ok(h) => h,
            Err(e) => return failed(e),
        };
        self.router.foreground().idle().await;
        if !self.keep_minutes(job, &spans).await {
            return None;
        }
        if holes.is_empty() {
            return Some(DayStatus::AlreadySaved);
        }
        let mut had_some = holes != spans;
        let pieces = pieces(&holes);
        self.progress(job, 0, pieces.len());
        let mut fetched = 0u64;
        let mut n = 0;
        while let Some(piece) = pieces.get(n) {
            self.router.foreground().idle().await;
            if !self.running(&job.pull) {
                return None;
            }
            match self.served(job, n, pieces.len()).await {
                Served::Yes => {}
                Served::Stopped => return None,
                Served::Elsewhere(why) => return failed(why),
            }
            let unsaved = match self.holes(&contract, &[*piece]).await {
                Ok(h) => h,
                Err(e) => return failed(e),
            };
            had_some |= unsaved != [*piece];
            let (Some(first), Some(last)) = (unsaved.first(), unsaved.last()) else {
                n += 1;
                self.progress(job, n, pieces.len());
                continue;
            };
            let ask = Span::new(first.start, last.end);
            let rows = match saved::ask(&self.router, &job.day.contract, ask).await {
                Ok(rows) => rows,
                Err(_) if self.blocked(job).is_some() => continue,
                Err(e) => return failed(e.to_string()),
            };
            fetched += rows.len() as u64;
            let (c, cal, span, now) = (contract.clone(), job.calendar, ask, self.clock.now());
            if let Err(e) = self
                .blocking(move |s| s.save_answer(&c, cal, &rows, span, now))
                .await
            {
                return failed(e);
            }
            n += 1;
            self.progress(job, n, pieces.len());
        }
        match self.holes(&contract, &spans).await {
            Ok(left) if !left.is_empty() => {
                return Some(DayStatus::Later {
                    tries: job.tries + 1,
                    at: self.clock.now(),
                });
            }
            Ok(_) => {}
            Err(e) => return failed(e),
        }
        Some(if fetched == 0 && !had_some {
            DayStatus::NoTrades
        } else {
            DayStatus::Saved { prints: fetched }
        })
    }
}

async fn run(work: Arc<Work>) {
    loop {
        let (job, done) = work.next();
        if !done.is_empty() {
            work.bump();
        }
        for id in done {
            work.persist(&id).await;
        }
        let Some(job) = job else {
            let _ = tokio::time::timeout(RETRY_EVERY, work.wake.notified()).await;
            work.retry_due().await;
            continue;
        };
        match work.fetch_day(&job).await {
            Some(status) => {
                if let DayStatus::Failed { reason, .. } = &status {
                    tracing::warn!(pull = %job.pull, date = %job.day.date, %reason, "a pulled day failed");
                }
                work.finish(&job, status);
            }
            None => *work.current.lock() = None,
        }
        work.persist(&job.pull).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, m, d).unwrap()
    }

    #[test]
    fn a_session_day_is_its_globex_hours_and_an_rth_day_its_cash_hours() {
        let cal = SessionCalendar::CmeEquityIndex;
        let rth = day_spans(cal, date(10, 1), Scope::Rth);
        assert_eq!(rth.len(), 1);
        assert_eq!(rth[0].end - rth[0].start, 390 * NANOS_PER_MINUTE);
        let session = day_spans(cal, date(10, 1), Scope::Session);
        assert_eq!(
            session.iter().map(|s| s.end - s.start).sum::<i64>(),
            23 * 60 * NANOS_PER_MINUTE
        );
        assert!(day_spans(cal, date(10, 3), Scope::Session).is_empty());
    }

    #[test]
    fn holes_are_asked_in_half_hours() {
        let p = pieces(&[
            Span::new(0, PULL_CHUNK * 2 + 5),
            Span::new(PULL_CHUNK * 9, PULL_CHUNK * 10),
        ]);
        assert_eq!(
            p,
            vec![
                Span::new(0, PULL_CHUNK),
                Span::new(PULL_CHUNK, PULL_CHUNK * 2),
                Span::new(PULL_CHUNK * 2, PULL_CHUNK * 2 + 5),
                Span::new(PULL_CHUNK * 9, PULL_CHUNK * 10),
            ]
        );
    }
}
