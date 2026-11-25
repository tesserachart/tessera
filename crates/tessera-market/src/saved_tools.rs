use std::sync::Arc;

use async_trait::async_trait;
use chrono::{NaiveDate, TimeZone};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_host::{Cards, RuntimeModule, TsExports};
use tessera_protocol::cards::{
    Card, CardAction, CardBody, CoverageDay, CoverageDownload, DataCoverage, Held as Kept,
};
use tessera_protocol::tools::RiskTier;
use tessera_store::ticks::TickKey;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use ts_rs::TS;

use crate::estimate::{EstimatePullInput, PullEstimate, SizeEstimate};
use crate::export::{ExportError, ExportTradesInput, ExportTradesOutput, export_trades};
use crate::market_error;
use crate::metered::{HistoryMeter, HistoryPulled};
use crate::pull::{
    DayStatus, PullCurrent, PullDay, PullError, PullProgress, PullRequest, PullState, PullSummary,
    Pulls, Scope, pull_id,
};
use crate::saved::SavedTrades;

/// `market.saved_trades` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedTradesInput {}

/// The prints saved of one dated contract from one connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedContractInfo {
    /// The connection that served them.
    pub source: String,
    /// The dated contract (`NQZ6.CME`).
    pub instrument: String,
    /// Trade dates with something saved.
    pub days: u32,
    /// Prints saved.
    #[ts(type = "number")]
    pub prints: u64,
    /// Their compressed size, in bytes.
    #[ts(type = "number")]
    pub bytes: u64,
    /// The oldest trade date saved.
    #[ts(type = "string | null")]
    pub first: Option<NaiveDate>,
    /// The newest trade date saved.
    #[ts(type = "string | null")]
    pub last: Option<NaiveDate>,
}

/// `market.saved_trades` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedTradesOutput {
    /// The tick store file (`<data dir>/ticks/ticks.db`).
    pub path: Option<String>,
    /// What it takes on disk, in bytes (with its write-ahead log).
    #[ts(type = "number")]
    pub disk_bytes: u64,
    /// How many sessions of each contract are kept (setting `market.savedTradeSessions`).
    pub keep_sessions: u32,
    /// Every saved contract.
    pub contracts: Vec<SavedContractInfo>,
    /// What each connection's history service sent: requests and bytes today, this week and in
    /// all, so a login's data allowance can be watched.
    pub pulled: Vec<HistoryPulled>,
}

/// `market.list_pulls` input. Every field is optional: `{}` lists the newest pulls compactly.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ListPullsInput {
    /// Only the pull with this id.
    #[serde(default)]
    pub id: Option<String>,
    /// Only the pulls of this instrument, in any case: a root (`NQ`) also takes its dated
    /// contracts (`NQZ6`).
    #[serde(default)]
    pub instrument: Option<String>,
    /// Only the pulls in this state.
    #[serde(default)]
    pub state: Option<PullState>,
    /// Most pulls listed, newest first (default 10).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Which of each pull's days to list: `open` (the default: the days still waiting, failing
    /// or not all sent, while its progress counts every day) or `all`.
    #[serde(default)]
    pub days: Option<PullDays>,
}

/// Which of a pull's days `market.list_pulls` lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullDays {
    /// The days still waiting, failing or not all sent.
    #[default]
    Open,
    /// Every trading day of the range, oldest first.
    All,
}

const DEFAULT_PULLS_LISTED: usize = 10;

impl ListPullsInput {
    fn takes(&self, p: &PullSummary) -> bool {
        let instrument = self.instrument.as_deref().map(str::trim);
        self.id.as_deref().is_none_or(|id| p.id == id)
            && self.state.is_none_or(|s| p.state == s)
            && instrument.is_none_or(|i| {
                p.request
                    .instrument
                    .to_ascii_uppercase()
                    .starts_with(&i.to_ascii_uppercase())
            })
    }

    fn list(&self, every: Vec<PullSummary>) -> ListPullsOutput {
        let limit = self
            .limit
            .map_or(DEFAULT_PULLS_LISTED, |n| (n as usize).max(1));
        let matched: Vec<PullSummary> = every.into_iter().filter(|p| self.takes(p)).collect();
        let omitted = u32::try_from(matched.len().saturating_sub(limit)).unwrap_or(u32::MAX);
        let all_days = self.days.unwrap_or_default() == PullDays::All;
        let pulls = matched
            .into_iter()
            .take(limit)
            .map(|mut p| {
                if !all_days {
                    p.days.retain(|d| d.status.open());
                }
                p
            })
            .collect();
        ListPullsOutput { pulls, omitted }
    }
}

/// `market.list_pulls` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListPullsOutput {
    /// The pulls asked for that are not released, newest first.
    pub pulls: Vec<PullSummary>,
    /// Pulls that matched past the limit, left out.
    #[serde(default, skip_serializing_if = "is_zero")]
    #[ts(as = "Option<u32>", optional)]
    pub omitted: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Names one date-range pull.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullIdInput {
    /// The pull's id, as `market.list_pulls` lists it.
    pub id: String,
}

/// `market.release_pull` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePullOutput {
    /// The pull released.
    pub id: String,
}

pub struct SavedTradesModule {
    pulls: Option<Arc<Pulls>>,
    cards: Option<Arc<Cards>>,
}

impl std::fmt::Debug for SavedTradesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SavedTradesModule")
            .field("pulls", &self.pulls)
            .finish()
    }
}

impl SavedTradesModule {
    pub fn new(pulls: Option<Arc<Pulls>>) -> Self {
        Self { pulls, cards: None }
    }

    #[must_use]
    pub fn with_cards(mut self, cards: Arc<Cards>) -> Self {
        self.cards = Some(cards);
        self
    }
}

impl RuntimeModule for SavedTradesModule {
    fn name(&self) -> &'static str {
        "saved_trades"
    }

    fn start(&self, _host: &tessera_host::ModuleHost) -> Vec<tokio::task::JoinHandle<()>> {
        let (Some(pulls), Some(cards)) = (self.pulls.clone(), self.cards.clone()) else {
            return Vec::new();
        };
        let mut changes = pulls.changes();
        vec![tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                let now = tessera_core::Timestamp::now();
                let seen = Seen {
                    auto: pulls.auto(),
                    today: today_of(now),
                    names: &|source| pulls.connection_name(source),
                };
                for p in pulls.list() {
                    let Some(mut card) = cards.get(&format!("card-{}", p.id)) else {
                        continue;
                    };
                    let again = DataCoverageInput {
                        instrument: p.request.instrument.clone(),
                        from: Some(p.request.from),
                        to: Some(p.request.to),
                        scope: Some(p.request.scope),
                    };
                    let before = card.clone();
                    follow(&mut card, &p.request, Some(&p), &again, &seen);
                    if card != before {
                        card.updated_at = now;
                        cards.show(card);
                    }
                }
                tokio::time::sleep(CARD_EVERY).await;
            }
        })]
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        let p = || Held(self.pulls.clone());
        r.register(ListSaved(p()))?;
        r.register(StartPull(p()))?;
        r.register(ListPulls(p()))?;
        r.register(CancelPull(p()))?;
        r.register(ResumePull(p()))?;
        r.register(ReleasePull(p()))?;
        r.register(ExportTrades(p()))?;
        r.register(Coverage(p(), self.cards.clone()))?;
        r.register(Estimate(p()))?;
        Ok(())
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-market (saved trades)")
        .tool::<SavedTradesInput, SavedTradesOutput>("market.saved_trades")
        .tool::<PullRequest, PullSummary>("market.pull_trades")
        .tool::<DataCoverageInput, DataCoverageOutput>("market.data_coverage")
        .tool::<EstimatePullInput, PullEstimate>("market.estimate_pull")
        .tool::<ListPullsInput, ListPullsOutput>("market.list_pulls")
        .tool::<PullIdInput, PullSummary>("market.cancel_pull")
        .tool::<PullIdInput, PullSummary>("market.resume_pull")
        .tool::<PullIdInput, ReleasePullOutput>("market.release_pull")
        .tool::<ExportTradesInput, ExportTradesOutput>("market.export_trades")
        .ty::<Scope>()
        .ty::<PullState>()
        .ty::<PullDays>()
        .ty::<DayStatus>()
        .ty::<PullDay>()
        .ty::<PullProgress>()
        .ty::<PullCurrent>()
        .ty::<SizeEstimate>()
        .ty::<HistoryPulled>()
}

#[derive(Clone)]
struct Held(Option<Arc<Pulls>>);

impl Held {
    fn get(&self) -> Result<&Arc<Pulls>, ToolError> {
        self.0.as_ref().ok_or_else(|| {
            ToolError::unavailable("this runtime saves no trades: it keeps its data in memory")
        })
    }

    fn saved(&self) -> Result<Arc<SavedTrades>, ToolError> {
        Ok(Arc::clone(self.get()?.saved()))
    }
}

fn pull_error(e: PullError) -> ToolError {
    match e {
        PullError::Invalid(s) => ToolError::invalid_input(s),
        PullError::NotFound(id) => {
            ToolError::not_found(format!("no pull {id}; market.list_pulls lists them"))
        }
        PullError::Market(e) => market_error(e),
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ToolError> + Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ToolError::internal(e.to_string()))?
}

fn list_saved(saved: &SavedTrades, meter: &HistoryMeter) -> Result<SavedTradesOutput, ToolError> {
    let store = saved.store();
    let err = |e: tessera_store::StoreError| ToolError::internal(format!("the tick store: {e}"));
    let mut contracts = Vec::new();
    for c in store.contracts().map_err(err)? {
        let days = store
            .days(TickKey {
                source: &c.source,
                instrument: &c.instrument,
            })
            .map_err(err)?;
        contracts.push(SavedContractInfo {
            days: c.days as u32,
            prints: c.prints,
            bytes: c.bytes,
            first: days.first().map(|d| d.trade_date),
            last: days.last().map(|d| d.trade_date),
            source: c.source,
            instrument: c.instrument,
        });
    }
    Ok(SavedTradesOutput {
        path: store.path().map(|p| p.display().to_string()),
        disk_bytes: store.disk_bytes().map_err(err)?,
        keep_sessions: saved.keep() as u32,
        contracts,
        pulled: meter.pulled().map_err(err)?,
    })
}

struct ListSaved(Held);

#[async_trait]
impl Tool for ListSaved {
    type Input = SavedTradesInput;
    type Output = SavedTradesOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.saved_trades", "List saved trades", RiskTier::Read)
            .description("The prints saved on this machine (the tick store): per connection and dated contract, how many trade dates, prints and bytes, and the oldest and newest date; the store's size on disk; and how many sessions of each contract are kept (setting market.savedTradeSessions; older days are deleted, except the days of a pull not yet released). A day saved whole is never asked of the connection again.")
            .activity("Listed saved trades")
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: SavedTradesInput,
    ) -> Result<SavedTradesOutput, ToolError> {
        let saved = self.0.saved()?;
        let meter = Arc::clone(self.0.get()?.meter());
        blocking(move || list_saved(&saved, &meter)).await
    }

    fn summarize(&self, out: &SavedTradesOutput) -> Option<String> {
        Some(format!(
            "{} contracts · {} bytes",
            out.contracts.len(),
            out.disk_bytes
        ))
    }
}

struct StartPull(Held);

#[async_trait]
impl Tool for StartPull {
    type Input = PullRequest;
    type Output = PullSummary;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.pull_trades", "Pull trades for a date range", RiskTier::Modify)
            .description("Fetches every print of a date range through the data connection and saves it on this machine, one trading day at a time, newest day first, so charts, footprints, replay and market.export_trades read those days from disk. Weekends and exchange holidays are left out; a day already saved whole asks nothing; a day saved in part asks only what is missing; a day older than the connection keeps is skipped. One request is in flight at a time and the charts' own requests go first. It returns at once: follow it with market.list_pulls (etaSeconds: the time left at the pace so far), and the market.data_coverage card of the same range shows its progress, time left and Cancel. With market.autoDownload on (the default), the days a study, a backtest or market.data_coverage needs download on their own: never ask the user to download them, and call this only for a range the user asks for. With it off (a metered feed), tell the user which days it will fetch and about how long (market.estimate_pull gives the size and the time) before calling it. The same request again resumes the same pull. It survives a restart, and its days are kept past the market.savedTradeSessions limit until market.release_pull.")
            .activity("Started a trade pull")
            .idempotent(true)
    }

    async fn call(&self, _ctx: &ToolCtx, input: PullRequest) -> Result<PullSummary, ToolError> {
        self.0.get()?.start(input).await.map_err(pull_error)
    }

    fn summarize(&self, out: &PullSummary) -> Option<String> {
        Some(format!("{} · {} trading days", out.id, out.progress.days))
    }
}

struct Estimate(Held);

#[async_trait]
impl Tool for Estimate {
    type Input = EstimatePullInput;
    type Output = PullEstimate;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.estimate_pull", "Estimate a trade pull", RiskTier::Read)
            .description("How much disk and how much time the prints still missing from a date range would take, before market.pull_trades is called. The range defaults to the last seven days of the market's own calendar (days whose hours have not ended are left out); a root (NQ) follows the roll, each day its front month. It counts the days of the range, the days already saved whole and the days older than the connection keeps (a pull asks nothing for them). The volume still to fetch comes from the connection's 1-minute bars, the only thing this asks of it, and is scaled by the bytes and prints per contract of the same market's prints already saved from the same connection (size is null while none are saved). seconds is the prints to fetch at the pace this connection's downloads have kept since the runtime started (null until one has answered). The answer's request, dates filled in, is what market.pull_trades takes to start the download, and estimating again while it runs gives what is left. With market.autoDownload off, tell the user the size and the time before you pull; when size or seconds is null, say it is not known yet and why instead of guessing.")
            .activity("Estimated a trade pull")
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: EstimatePullInput,
    ) -> Result<PullEstimate, ToolError> {
        self.0.get()?.estimate(input).await.map_err(pull_error)
    }

    fn summarize(&self, out: &PullEstimate) -> Option<String> {
        Some(format!(
            "{} · {} days · {} saved",
            out.id, out.days, out.saved
        ))
    }
}

struct ListPulls(Held);

#[async_trait]
impl Tool for ListPulls {
    type Input = ListPullsInput;
    type Output = ListPullsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.list_pulls", "List trade pulls", RiskTier::Read)
            .description("The date-range pulls (market.pull_trades) not yet released, newest first: each one's request, state (running, cancelled, done), the day being fetched and how many of its half-hour pieces are in, the days counted by what happened (saved, already saved, no trades, out of reach, not all sent yet, failed, waiting) with the prints fetched, its open days (waiting, failing or not all sent) with their contract and status, and whether Tessera started it on its own (auto). Filter with id, instrument (`NQ` takes its dated contracts too) or state; limit (default 10) caps the list and omitted counts what it left out; days: all lists every day of each pull. With market.autoDownload on, a day not all sent yet or failed is asked again on its own, and a day whose session ends joins its pull.")
            .activity("Listed trade pulls")
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ListPullsInput,
    ) -> Result<ListPullsOutput, ToolError> {
        Ok(input.list(self.0.get()?.list()))
    }

    fn summarize(&self, out: &ListPullsOutput) -> Option<String> {
        Some(format!("{} pulls", out.pulls.len()))
    }
}

struct CancelPull(Held);

#[async_trait]
impl Tool for CancelPull {
    type Input = PullIdInput;
    type Output = PullSummary;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.cancel_pull", "Cancel a trade pull", RiskTier::Modify)
            .description("Stops a running pull after the request in flight; what it fetched stays saved and its days stay kept. market.resume_pull carries on where it stopped.")
            .activity("Cancelled a trade pull")
            .idempotent(true)
    }

    async fn call(&self, _ctx: &ToolCtx, input: PullIdInput) -> Result<PullSummary, ToolError> {
        self.0.get()?.cancel(&input.id).await.map_err(pull_error)
    }
}

struct ResumePull(Held);

#[async_trait]
impl Tool for ResumePull {
    type Input = PullIdInput;
    type Output = PullSummary;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.resume_pull", "Resume a trade pull", RiskTier::Modify)
            .description("Carries on a cancelled or finished pull: the days still waiting, and at once each day that failed or was not all sent. Days already saved ask nothing.")
            .activity("Resumed a trade pull")
            .idempotent(true)
    }

    async fn call(&self, _ctx: &ToolCtx, input: PullIdInput) -> Result<PullSummary, ToolError> {
        self.0.get()?.resume(&input.id).await.map_err(pull_error)
    }
}

struct ReleasePull(Held);

#[async_trait]
impl Tool for ReleasePull {
    type Input = PullIdInput;
    type Output = ReleasePullOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.release_pull", "Release a trade pull", RiskTier::Modify)
            .description("Stops and forgets a pull. Its saved days are no longer kept past the market.savedTradeSessions limit: days older than the newest that many sessions of a contract are deleted, and their disk space given back, before this returns.")
            .activity("Released a trade pull")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: PullIdInput,
    ) -> Result<ReleasePullOutput, ToolError> {
        let pulls = self.0.get()?;
        pulls.release(&input.id).await.map_err(pull_error)?;
        let saved = Arc::clone(pulls.saved());
        tokio::task::spawn_blocking(move || saved.prune_all())
            .await
            .map_err(|e| ToolError::internal(e.to_string()))?
            .map_err(|e| ToolError::internal(format!("old saved trades were not pruned: {e}")))?;
        Ok(ReleasePullOutput { id: input.id })
    }
}

struct ExportTrades(Held);

#[async_trait]
impl Tool for ExportTrades {
    type Input = ExportTradesInput;
    type Output = ExportTradesOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.export_trades", "Export saved trades to CSV", RiskTier::Modify)
            .description("Writes the saved prints of a date range to CSV files in a folder (an absolute path), one file per trade date named <ROOT>-<YYYY-MM-DD>.csv (NQ-2026-10-01.csv), with the header ts_ns,price,size,side: UTC nanoseconds, price, size, and 1 buyer aggressed, -1 seller aggressed, 0 unknown, in time order. rth writes 09:30 to 16:00 New York, session the whole session. It reads only what is saved and asks the connection nothing: pull missing days first with market.pull_trades. The answer lists each file with its prints and whether the day is saved whole, and the trading days with nothing saved. The same export runs with the app closed: tessera-runtime ticks export.")
            .activity("Exported saved trades")
            .idempotent(true)
            .timeout_ms(600_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ExportTradesInput,
    ) -> Result<ExportTradesOutput, ToolError> {
        if !std::path::Path::new(input.dir.trim()).is_absolute() {
            return Err(ToolError::invalid_input(format!(
                "dir must be an absolute path: {}",
                input.dir
            )));
        }
        let saved = self.0.saved()?;
        blocking(move || {
            export_trades(saved.store(), &input).map_err(|e| match e {
                ExportError::Invalid(s) => ToolError::invalid_input(s),
                other => ToolError::internal(other.to_string()),
            })
        })
        .await
    }

    fn summarize(&self, out: &ExportTradesOutput) -> Option<String> {
        Some(format!("{} files · {}", out.files.len(), out.dir))
    }
}

const COVERAGE_DAYS: i64 = 27;
const CARD_EVERY: std::time::Duration = std::time::Duration::from_millis(500);

/// `market.data_coverage` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct DataCoverageInput {
    /// A futures root (`NQ`: each day is the contract that was the front month that day) or a
    /// dated contract (`NQZ6`).
    pub instrument: String,
    /// First trade date, `YYYY-MM-DD` (default: four weeks before `to`).
    #[serde(default)]
    #[ts(optional, type = "string")]
    pub from: Option<NaiveDate>,
    /// Last trade date (default: today).
    #[serde(default)]
    #[ts(optional, type = "string")]
    pub to: Option<NaiveDate>,
    /// `rth` (default) for regular trading hours, `session` for the whole session.
    #[serde(default)]
    pub scope: Option<Scope>,
}

/// `market.data_coverage` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DataCoverageOutput {
    /// The card the chat shows, every trading day with its prints and bars.
    pub card: Card,
    /// Trading days in the span that have ended.
    pub days: u32,
    /// Days whose prints are all saved.
    pub prints_saved: u32,
    /// Days with no prints or only some of them saved, oldest first (`YYYY-MM-DD`).
    pub prints_missing: Vec<String>,
    /// Days with no 1-minute bars or only some of them saved, oldest first.
    pub bars_missing: Vec<String>,
    /// The missing days are downloading in the background now; the card shows their progress.
    pub downloading: bool,
}

struct Coverage(Held, Option<Arc<Cards>>);

fn coverage_request(input: &DataCoverageInput, today: NaiveDate) -> PullRequest {
    let to = input.to.unwrap_or(today);
    PullRequest {
        instrument: input.instrument.trim().to_owned(),
        from: input
            .from
            .unwrap_or_else(|| to - chrono::Duration::days(COVERAGE_DAYS)),
        to,
        scope: input.scope.unwrap_or(Scope::Rth),
    }
}

struct Seen<'a> {
    auto: bool,
    today: NaiveDate,
    names: &'a (dyn Fn(&str) -> String + Sync),
}

fn today_of(now: tessera_core::Timestamp) -> NaiveDate {
    chrono_tz::America::New_York
        .timestamp_nanos(now.0)
        .date_naive()
}

fn older_than(name: &str) -> String {
    format!("older than {name} keeps")
}

fn coverage_card(
    input: &DataCoverageInput,
    req: &PullRequest,
    days: &[crate::pull::CoverageDay],
    pull: Option<&PullSummary>,
    now: tessera_core::Timestamp,
    seen: &Seen<'_>,
) -> Card {
    let scope = serde_json::to_value(req.scope)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let again = DataCoverageInput {
        from: Some(req.from),
        to: Some(req.to),
        scope: Some(req.scope),
        ..input.clone()
    };
    let mut card = Card {
        id: format!("card-{}", pull_id(req)),
        body: CardBody::DataCoverage(DataCoverage {
            symbol: req.instrument.to_ascii_uppercase(),
            scope,
            from: req.from.to_string(),
            to: req.to.to_string(),
            days: days
                .iter()
                .map(|d| CoverageDay {
                    date: d.date.to_string(),
                    contract: d.contract.to_string(),
                    prints: d.prints,
                    bars: d.bars,
                    out_of_reach: d.out_of_reach,
                    note: (d.out_of_reach && d.prints != Kept::Saved)
                        .then(|| older_than(&(seen.names)(&d.source))),
                })
                .collect(),
            download: None,
        }),
        actions: Vec::new(),
        updated_at: now,
    };
    follow(&mut card, req, pull, &again, seen);
    card
}

fn day_note(d: &PullDay, seen: &Seen<'_>) -> Option<String> {
    let name = || (seen.names)(&d.source);
    match &d.status {
        DayStatus::OutOfReach => Some(older_than(&name())),
        DayStatus::Later { .. } if d.date >= seen.today => {
            Some("today's session is still open".into())
        }
        DayStatus::Later { .. } => Some(format!("{} has not sent all of it yet", name())),
        DayStatus::Failed { .. } if seen.auto => {
            Some(format!("{} did not send it; trying again", name()))
        }
        DayStatus::Failed { .. } => Some(format!("{} did not send it", name())),
        _ => None,
    }
}

fn follow(
    card: &mut Card,
    req: &PullRequest,
    pull: Option<&PullSummary>,
    again: &DataCoverageInput,
    seen: &Seen<'_>,
) {
    let CardBody::DataCoverage(body) = &mut card.body else {
        return;
    };
    if let Some(p) = pull {
        let (mut fetching, mut fetched) = (0, 0);
        for d in &p.days {
            let Some(day) = body.days.iter_mut().find(|c| c.date == d.date.to_string()) else {
                continue;
            };
            if d.status.answered() {
                day.prints = Kept::Saved;
            }
            match d.status {
                DayStatus::Saved { .. } | DayStatus::NoTrades => {
                    fetching += 1;
                    fetched += 1;
                }
                DayStatus::Later { .. } | DayStatus::Failed { .. } => fetching += 1,
                DayStatus::Waiting | DayStatus::Retry { .. } if day.prints != Kept::Saved => {
                    fetching += 1;
                }
                DayStatus::OutOfReach => day.out_of_reach = true,
                _ => {}
            }
            day.note = if day.prints == Kept::Saved {
                None
            } else {
                day_note(d, seen).or_else(|| day.note.take())
            };
        }
        let g = &p.progress;
        body.download = Some(CoverageDownload {
            pull_id: p.id.clone(),
            state: p.state,
            days: g.days,
            done: g.saved + g.already_saved + g.no_trades,
            failed: g.failed,
            out_of_reach: g.out_of_reach,
            current: p.current.as_ref().map(|c| c.date.to_string()),
            pieces_done: p.current.as_ref().map_or(0, |c| c.pieces_done),
            pieces: p.current.as_ref().map_or(0, |c| c.pieces),
            eta_seconds: p.eta_seconds,
            waiting_for: p.current.as_ref().and_then(|c| {
                c.waiting_for.as_deref().map(|on| match c.waiting_why {
                    Some(_) => on.to_owned(),
                    None => (seen.names)(on),
                })
            }),
            waiting_why: p.current.as_ref().and_then(|c| c.waiting_why.clone()),
            fetching,
            fetched,
            later: g.later,
            auto: p.auto,
        });
    }
    let missing = body
        .days
        .iter()
        .filter(|d| d.prints != Kept::Saved && !d.out_of_reach)
        .count();
    let mut actions = Vec::new();
    match pull.map(|p| p.state) {
        Some(PullState::Running) => actions.push(CardAction {
            label: "Cancel".into(),
            tool: "market.cancel_pull".into(),
            input: serde_json::json!({"id": pull_id(req)}),
            primary: false,
        }),
        Some(PullState::Cancelled) if missing > 0 => actions.push(CardAction {
            label: "Resume".into(),
            tool: "market.resume_pull".into(),
            input: serde_json::json!({"id": pull_id(req)}),
            primary: true,
        }),
        _ if missing > 0 && (!seen.auto || pull.is_none()) => actions.push(CardAction {
            label: if missing == 1 {
                "Download 1 day".into()
            } else {
                format!("Download {missing} days")
            },
            tool: "market.pull_trades".into(),
            input: serde_json::to_value(req).unwrap_or_default(),
            primary: true,
        }),
        _ => {}
    }
    actions.push(CardAction {
        label: "Check again".into(),
        tool: "market.data_coverage".into(),
        input: serde_json::to_value(again).unwrap_or_default(),
        primary: false,
    });
    card.actions = actions;
}

#[async_trait]
impl Tool for Coverage {
    type Input = DataCoverageInput;
    type Output = DataCoverageOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.data_coverage", "Check saved data", RiskTier::Read)
            .description("Which trading days of a market have their prints (every trade with its aggressor side) and their 1-minute bars saved on this machine, day by day: saved, partial or missing, with a plain reason (note) for a day that cannot be saved whole yet. A root (NQ) follows the roll, each day its front month. Shows the user a card in the chat with every day, and with a download's progress and time left while one runs. Before a study, a backtest or any order-flow question over past sessions, call this. With market.autoDownload on (the default), calling it starts downloading the missing days the connection keeps, through its tick replay, a few minutes per day (downloading true): never ask the user to download anything; say the data is filling in and what is still missing meanwhile, and that a day older than the connection keeps cannot be had. With it off (a metered feed), tell the user which days are missing and what that leaves out, and download only once they say so: the card's Download button, or market.pull_trades with the same instrument, from, to and scope; the card then follows that download.")
            .activity("Checked saved data")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: DataCoverageInput,
    ) -> Result<DataCoverageOutput, ToolError> {
        let today = chrono_tz::America::New_York
            .timestamp_nanos(ctx.now.0)
            .date_naive();
        let req = coverage_request(&input, today);
        let pulls = self.0.get()?;
        let days = pulls.coverage(&req).await.map_err(pull_error)?;
        let pull = match pulls.fill(&req, &days).await {
            Some(started) => Some(started),
            None => pulls.summary(&pull_id(&req)).ok(),
        };
        let seen = Seen {
            auto: pulls.auto(),
            today,
            names: &|source| pulls.connection_name(source),
        };
        let card = coverage_card(&input, &req, &days, pull.as_ref(), ctx.now, &seen);
        let card = match &self.1 {
            Some(cards) => cards.show(card),
            None => card,
        };
        let missing = |f: fn(&crate::pull::CoverageDay) -> Kept| -> Vec<String> {
            days.iter()
                .filter(|d| f(d) != Kept::Saved)
                .map(|d| d.date.to_string())
                .collect()
        };
        Ok(DataCoverageOutput {
            downloading: pull.as_ref().is_some_and(|p| p.state == PullState::Running),
            days: days.len() as u32,
            prints_saved: days.iter().filter(|d| d.prints == Kept::Saved).count() as u32,
            prints_missing: missing(|d| d.prints),
            bars_missing: missing(|d| d.bars),
            card,
        })
    }

    fn summarize(&self, out: &DataCoverageOutput) -> Option<String> {
        Some(format!(
            "prints {} of {} days · bars missing {}",
            out.prints_saved,
            out.days,
            out.bars_missing.len()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pull(instrument: &str, from: &str, state: &str, days: &[&str]) -> PullSummary {
        let days: Vec<_> = days
            .iter()
            .enumerate()
            .map(|(k, kind)| {
                let status = match *kind {
                    "saved" => json!({"kind": kind, "prints": 1}),
                    "retry" => json!({"kind": kind, "tries": 1}),
                    "later" => json!({"kind": kind, "tries": 1, "at": 0}),
                    "failed" => json!({"kind": kind, "tries": 1, "reason": "timed out"}),
                    _ => json!({"kind": kind}),
                };
                json!({"date": format!("2026-09-{:02}", k + 1), "contract": format!("{instrument}Z6.CME"),
                       "source": "mock", "status": status})
            })
            .collect();
        serde_json::from_value(json!({
            "id": format!("{instrument}-{from}"),
            "request": {"instrument": instrument, "from": from, "to": from, "scope": "rth"},
            "state": state,
            "progress": {"days": days.len(), "saved": 0, "alreadySaved": 0, "noTrades": 0,
                         "outOfReach": 0, "failed": 0, "later": 0, "waiting": 0, "prints": 0},
            "current": null,
            "etaSeconds": null,
            "days": days,
            "auto": false,
        }))
        .unwrap()
    }

    fn ask(v: serde_json::Value) -> ListPullsInput {
        serde_json::from_value(v).unwrap()
    }

    fn ids(out: &ListPullsOutput) -> Vec<&str> {
        out.pulls.iter().map(|p| p.id.as_str()).collect()
    }

    #[test]
    fn a_bare_list_is_the_newest_ten_with_only_their_open_days() {
        let every: Vec<_> = (0..12)
            .map(|k| {
                pull(
                    "NQ",
                    &format!("2026-08-{:02}", 20 - k),
                    "done",
                    &[
                        "saved",
                        "already_saved",
                        "no_trades",
                        "out_of_reach",
                        "failed",
                        "later",
                        "waiting",
                        "retry",
                    ],
                )
            })
            .collect();
        let out = ask(json!({})).list(every.clone());
        assert_eq!(out.pulls.len(), 10);
        assert_eq!(out.omitted, 2);
        assert_eq!(out.pulls[0].id, every[0].id);
        let kinds: Vec<_> = out.pulls[0]
            .days
            .iter()
            .map(|d| serde_json::to_value(&d.status).unwrap()["kind"].clone())
            .collect();
        assert_eq!(
            kinds,
            [
                json!("failed"),
                json!("later"),
                json!("waiting"),
                json!("retry")
            ]
        );
        assert_eq!(
            out.pulls[0].progress.days, 8,
            "the progress still counts every day"
        );
        let all = ask(json!({"days": "all", "limit": 50})).list(every);
        assert_eq!((all.pulls.len(), all.omitted), (12, 0));
        assert_eq!(all.pulls[0].days.len(), 8);
        assert!(
            !serde_json::to_string(&all).unwrap().contains("omitted"),
            "nothing left out, nothing said"
        );
    }

    #[test]
    fn pulls_filter_by_id_instrument_and_state() {
        let every = vec![
            pull("NQZ6", "2026-09-03", "running", &[]),
            pull("ES", "2026-09-02", "done", &[]),
            pull("MNQ", "2026-09-01", "cancelled", &[]),
        ];
        assert_eq!(
            ids(&ask(json!({"instrument": "nq"})).list(every.clone())),
            ["NQZ6-2026-09-03"]
        );
        assert_eq!(
            ids(&ask(json!({"state": "done"})).list(every.clone())),
            ["ES-2026-09-02"]
        );
        assert_eq!(
            ids(&ask(json!({"id": "MNQ-2026-09-01"})).list(every.clone())),
            ["MNQ-2026-09-01"]
        );
        assert_eq!(
            ids(&ask(json!({"limit": 1})).list(every.clone())),
            ["NQZ6-2026-09-03"]
        );
        assert!(
            ask(json!({"instrument": "CL"}))
                .list(every)
                .pulls
                .is_empty()
        );
        assert!(serde_json::from_value::<ListPullsInput>(json!({"nope": 1})).is_err());
    }
}
