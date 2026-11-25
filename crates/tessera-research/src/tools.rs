use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::{Origin, Timestamp};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{Tool, ToolCtx, ToolError, ToolMeta};
use ts_rs::TS;

use crate::budget::ResearchBudget;
use crate::evaluate::{FillCase, GateResult, Gates, PlaceboResult, Verdict};
use crate::experiment::ExperimentState;
use crate::levels::LevelCoverage;
use crate::replay::{StudyTradesInput, replay_study};
use crate::study::{Execution, Strategy, Studies, Study, StudyData, StudyRun, StudySignal};

fn failed(e: String) -> ToolError {
    if e.starts_with("no study")
        || e.starts_with("no run")
        || e.starts_with("There is no level history")
        || e.starts_with("No session")
    {
        ToolError::not_found(e)
    } else if e.contains("ledger could not") {
        ToolError::internal(e)
    } else {
        ToolError::invalid_input(e)
    }
}

/// `research.save_study` input: a new study (no id) or a change to one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveStudyInput {
    /// The study changed; none registers a new one.
    #[serde(default)]
    pub id: Option<String>,
    /// Its name.
    pub name: String,
    /// The family its research budget counts in; defaults to the rule and the instrument.
    #[serde(default)]
    pub family: Option<String>,
    /// What is expected and why, before any outcome.
    pub hypothesis: String,
    /// What is known already, what would limit the result.
    #[serde(default)]
    pub notes: Option<String>,
    /// The history.
    pub data: StudyData,
    /// The rules: a built-in rule, or JavaScript.
    pub strategy: Strategy,
    /// How it trades (contracts, costs, bracket, fill cases).
    #[serde(default)]
    pub execution: Option<Execution>,
    /// What it must pass.
    #[serde(default)]
    pub gates: Option<Gates>,
    /// Placebo runs (default 100; 0 for none).
    #[serde(default)]
    pub placebo_runs: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyIdInput {
    /// The study.
    pub id: String,
}

/// `research.get_run` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunIdInput {
    /// The run.
    pub run_id: String,
}

/// `research.archive_run` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveRunInput {
    /// The run.
    pub run_id: String,
    /// True archives it; false brings it back to the list.
    pub archived: bool,
}

/// `research.list_runs` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunList {
    /// Every run of every study, newest first, archived ones included and marked.
    pub runs: Vec<RunDigest>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoInput {}

/// `research.list_studies` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StudyList {
    /// Every study, most recently changed first.
    pub studies: Vec<Study>,
    /// Every family's research budget.
    pub budgets: Vec<ResearchBudget>,
}

/// One fill case of a run, in brief.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CaseDigest {
    /// The fill case.
    pub case: FillCase,
    /// Development: trades, win rate, mean trade, net.
    pub development: SplitDigest,
    /// Later sessions, the same.
    pub later: SplitDigest,
    /// Each gate.
    pub gates: Vec<GateResult>,
}

/// A split in brief.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SplitDigest {
    /// Sessions.
    pub sessions: u32,
    /// Trades.
    pub trades: u32,
    /// Win rate.
    pub win_rate: Option<f64>,
    /// Its Wilson 95% interval.
    pub win_rate_ci: Option<(f64, f64)>,
    /// Mean trade.
    pub avg_trade: Option<f64>,
    /// Its 5-session block 95% interval.
    pub avg_trade_ci: Option<(f64, f64)>,
    /// Net P&L.
    pub net_pnl: f64,
    /// Deepest drawdown.
    pub max_drawdown: f64,
    /// Stop and target exits found on bars, not prints: approximate fills.
    pub approximate_exits: u32,
}

/// `research.run_study` output: what the run measured, in brief (`research.get_run` has the
/// trades and curves).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunDigest {
    /// The run's id.
    pub run_id: String,
    /// The study it ran.
    pub study_id: String,
    /// The study's generation it ran.
    pub generation: u32,
    /// When it ran.
    #[ts(type = "number")]
    pub at: Timestamp,
    /// Who ran it: the user, or the analyst chat (its session).
    pub origin: Option<Origin>,
    /// When it was archived (none: in the list).
    #[ts(type = "number | null")]
    pub archived_at: Option<Timestamp>,
    /// Run on a draft: exploratory, not evidence.
    pub exploratory: bool,
    /// The study's manifest hash it ran (none: exploratory, on a draft).
    pub manifest_hash: Option<String>,
    /// The verdict on this history.
    pub verdict: Verdict,
    /// Why, in one sentence.
    pub reason: String,
    /// Sessions read.
    pub sessions: u32,
    /// The first later session.
    pub later_from_session: u32,
    /// Each fill case.
    pub cases: Vec<CaseDigest>,
    /// The base case against its placebo.
    pub placebo: Option<PlaceboResult>,
    /// The family's research budget after this run: every trial counts.
    pub budget: ResearchBudget,
    /// What the level inputs covered: each input's dates, the sessions used and those left out.
    pub levels: Option<LevelCoverage>,
}

impl From<&StudyRun> for RunDigest {
    fn from(r: &StudyRun) -> Self {
        let split = |s: &crate::evaluate::SplitResult| SplitDigest {
            sessions: s.sessions,
            trades: s.metrics.trades,
            win_rate: s.metrics.win_rate,
            win_rate_ci: s.metrics.win_rate_ci,
            avg_trade: s.metrics.avg_trade,
            avg_trade_ci: s.mean_ci_block5,
            net_pnl: s.metrics.net_pnl,
            max_drawdown: s.metrics.max_drawdown,
            approximate_exits: s.metrics.approximate_exits,
        };
        Self {
            run_id: r.id.clone(),
            study_id: r.study_id.clone(),
            generation: r.generation,
            at: r.at,
            origin: r.origin.clone(),
            archived_at: r.archived_at,
            exploratory: r.exploratory,
            manifest_hash: r.manifest_hash.clone(),
            verdict: r.evaluation.verdict,
            reason: r.evaluation.reason.clone(),
            sessions: r.evaluation.sessions,
            later_from_session: r.evaluation.later_from_session,
            cases: r
                .evaluation
                .cases
                .iter()
                .map(|c| CaseDigest {
                    case: c.case.clone(),
                    development: split(&c.development),
                    later: split(&c.later),
                    gates: c.gates.clone(),
                })
                .collect(),
            placebo: r.evaluation.placebo.clone(),
            budget: r.budget.clone(),
            levels: r.levels.clone(),
        }
    }
}

/// `research.get_study` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StudyDetail {
    /// The study.
    pub study: Study,
    /// Its runs, newest first, in brief.
    pub runs: Vec<RunDigest>,
}

/// `research.delete_study` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    /// Whether it existed.
    pub deleted: bool,
}

const INPUTS: &str = "Market-intelligence levels as inputs: data.levels names them from the level history, vendor.level or vendor.package.level (acme.major_long_gamma is Acme State's Major Long Gamma; acme.zero_gamma Classic's Zero Gamma), @INSTRUMENT to read another instrument's (acme.major_long_gamma@NDX: NDX prices, not the study's); intel.list_level_history shows what history exists and its dates. A JavaScript strategy reads bars.levels[name] (the value standing at each bar's open: one arriving mid-bar is first seen by the next bar; NaN before the first value and where the vendor marks it not applicable) and bars.levelsAsOf[name] (its vendor time, Unix seconds, to check it is today's). Only sessions every input covers are run; the run's levels field says each input's dates and the sessions left out. With no history the run is refused and says since when history is recorded: never run on made-up values. Rules strategies ignore levels. A time-of-day window: data.window {start:'09:30', end:'11:30', timeZone?:'America/New_York'} keeps the study flat outside it (positions open and close inside); the strategy still sees every bar, and bars.time (UTC seconds) or session.clock(t, 'America/New_York') can shape entries further.";

const LEDGER: &str = "Studies are Tessera's research ledger: register the hypothesis, data, rules, execution and gates before any outcome; freeze (hashes everything that decides the outcome; a frozen study is never edited, a change opens its next generation); run (reads closed bars, splits sessions into development and later, runs every fill case, judges frozen gates with 5/20-session block-bootstrap intervals and a placebo of the same trades at random bars). Verdicts measure this history only: qualified, lead or rejected. Every run counts toward its family's research budget; report it with any result. A run on a draft is exploratory, not evidence. Present results as measured statistics, separate from the hypothesis and from your interpretation; never as a promise.";

struct ListStudies(Arc<Studies>);

#[async_trait]
impl Tool for ListStudies {
    type Input = NoInput;
    type Output = StudyList;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.list_studies", "List research studies", RiskTier::Read)
            .description(format!("Every study in the research ledger with its state, generation and latest verdict, and every family's research budget. {LEDGER}"))
            .activity("Reading the research ledger")
    }

    async fn call(&self, _ctx: &ToolCtx, _input: NoInput) -> Result<StudyList, ToolError> {
        Ok(StudyList {
            studies: self.0.list().map_err(failed)?,
            budgets: self.0.budgets().map_err(failed)?,
        })
    }
}

struct GetStudy(Arc<Studies>);

#[async_trait]
impl Tool for GetStudy {
    type Input = StudyIdInput;
    type Output = StudyDetail;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.get_study", "Get a research study", RiskTier::Read)
            .description("One study as registered (hypothesis, data, strategy with its code, execution, gates) and its runs in brief, newest first.")
            .activity("Reading a study")
    }

    async fn call(&self, _ctx: &ToolCtx, input: StudyIdInput) -> Result<StudyDetail, ToolError> {
        Ok(StudyDetail {
            study: self.0.get(&input.id).map_err(failed)?,
            runs: self
                .0
                .runs(&input.id)
                .map_err(failed)?
                .iter()
                .map(RunDigest::from)
                .collect(),
        })
    }
}

struct SaveStudy(Arc<Studies>);

#[async_trait]
impl Tool for SaveStudy {
    type Input = SaveStudyInput;
    type Output = Study;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.save_study", "Register or change a study", RiskTier::Modify)
            .description(format!("Registers a new study (no id) or changes a draft. Changing a frozen study opens its next generation as a draft. Strategy: {{kind: 'rules', rule: {{rule: 'ema_cross', fast, slow, sides}} | {{rule: 'breakout', lookback, holdBars, sides}} | {{rule: 'rsi_reversion', length, lower, upper, holdBars, sides}}}} or {{kind: 'script', code, inputs?, freeParameters?}}: JavaScript (an ES module) run by Tessera's own engine on every platform, the same engine and the same ta and session helpers as custom indicators (indicators.* are for charts; studies and backtests are only these research tools). The code exports function positions(bars, inputs) returning one target position per bar in contracts (NaN: no change; 0: flat), or {{position, stopDistance, targetDistance}} where a trade's stop and target are in price from its fill, set on the bar that decides the trade (NaN: the execution's stopTicks and targetTicks). Every decision acts at the next bar's open; never read past bar i to decide bar i. bars holds Float64Arrays: time (UTC seconds), open, high, low, close, volume, hl2, hlc3, ohlc4, day (yyyymmdd trade date), session (the session's ordinal), buyVolume, sellVolume and delta when the market reports aggressor sides, and the level inputs. export const strategy = {{inputs: {{minutes: 15, mult: {{type: 'number', default: 2, min: 0.5}}}}}} declares inputs as an indicator does; the study's inputs set their values, and each declared input counts as a free parameter. An opening-range breakout: track the 9:30–9:45 high and low per day with session.clock(bars.time[i], 'America/New_York'), set position[i] = ±1 on the first close outside it and targetDistance[i] = 2 * (high − low), and 0 on a close back through the midpoint; data.window {{start: '09:30', end: '12:00'}} makes it flat by noon. Execution defaults: 1 contract, $1 a side, base 1 adverse tick and stressed 2. Gates default: later trades ≥ 100, later mean trade's interval above zero, each half of the later sessions positive, development positive. {INPUTS} For a question such as 'does max long gamma matter from 9:30 to 11:30': write the hypothesis first (what you expect the level to do to price, and why), then the data (instrument, timeframe, levels, window), the rules that test it, and run it; report what was measured apart from the hypothesis and from your reading of it. {LEDGER}"))
            .activity("Registering a study")
    }

    async fn call(&self, ctx: &ToolCtx, i: SaveStudyInput) -> Result<Study, ToolError> {
        let study = Study {
            id: i.id.unwrap_or_default(),
            name: i.name,
            family: i.family.unwrap_or_default(),
            hypothesis: i.hypothesis,
            notes: i.notes,
            data: i.data,
            strategy: i.strategy,
            execution: i.execution.unwrap_or_default(),
            gates: i.gates.unwrap_or_default(),
            placebo_runs: i.placebo_runs.unwrap_or(100),
            state: ExperimentState::Draft,
            generation: 1,
            manifest_hash: None,
            frozen_at: None,
            last_verdict: None,
            origin: Some(ctx.origin.clone()),
        };
        self.0.save(study).await.map_err(failed)
    }

    fn summarize(&self, out: &Study) -> Option<String> {
        Some(format!("{} · generation {}", out.name, out.generation))
    }
}

struct FreezeStudy(Arc<Studies>);

#[async_trait]
impl Tool for FreezeStudy {
    type Input = StudyIdInput;
    type Output = Study;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.freeze_study", "Freeze a study", RiskTier::Modify)
            .description("Freezes a draft before its evidence run: everything that decides its outcome is hashed and can no longer change (a change opens the next generation). Runs on a frozen study are evidence; runs on a draft are exploratory.")
            .activity("Freezing a study")
    }

    async fn call(&self, _ctx: &ToolCtx, input: StudyIdInput) -> Result<Study, ToolError> {
        self.0.freeze(&input.id).map_err(failed)
    }
}

struct RunStudy(Arc<Studies>);

#[async_trait]
impl Tool for RunStudy {
    type Input = StudyIdInput;
    type Output = RunDigest;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.run_study", "Run a study", RiskTier::Modify)
            .description(format!("Runs a study over its history and stores the run, on every platform; returns the measurements in brief (research.get_run has every trade and the curves), and with level inputs what they covered. Counts one trial toward the family's research budget. Stops and targets resolve on the session's saved prints when it has them (market.data_coverage shows which days do), so the order of the two in a bar and the fill are what traded; on a session without saved prints they resolve on the bar's high and low, and each such trade is marked approximate and counted in approximateExits: say how many results rest on approximate fills. A study whose levels have no history is refused with what exists and since when: say so to the user plainly, never substitute other data. {LEDGER}"))
            .activity("Running a study")
            .timeout_ms(180_000)
    }

    async fn call(&self, ctx: &ToolCtx, input: StudyIdInput) -> Result<RunDigest, ToolError> {
        let run = self
            .0
            .run(&input.id, ctx.origin.clone())
            .await
            .map_err(failed)?;
        Ok(RunDigest::from(&run))
    }

    fn summarize(&self, out: &RunDigest) -> Option<String> {
        Some(format!("{:?}: {}", out.verdict, out.reason))
    }
}

struct GetRun(Arc<Studies>);

#[async_trait]
impl Tool for GetRun {
    type Input = RunIdInput;
    type Output = StudyRun;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.get_run", "Get a study's run", RiskTier::Read)
            .description("One run in full: every fill case's development and later measurements, gates, equity curve and trades, the placebo, the verdict and the research budget at the time.")
            .activity("Reading a run")
    }

    async fn call(&self, _ctx: &ToolCtx, input: RunIdInput) -> Result<StudyRun, ToolError> {
        self.0.run_of(&input.run_id).map_err(failed)
    }
}

struct ListRuns(Arc<Studies>);

#[async_trait]
impl Tool for ListRuns {
    type Input = NoInput;
    type Output = RunList;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.list_runs", "List research runs", RiskTier::Read)
            .description("Every run of every study, newest first, in brief: its study, when it ran, who ran it (the user or an analyst chat's session), whether it is archived, its verdict and each fill case's development and later measurements. research.get_run has a run's trades and curves.")
            .activity("Reading the research runs")
    }

    async fn call(&self, _ctx: &ToolCtx, _input: NoInput) -> Result<RunList, ToolError> {
        Ok(RunList {
            runs: self
                .0
                .all_runs()
                .map_err(failed)?
                .iter()
                .map(RunDigest::from)
                .collect(),
        })
    }
}

struct ArchiveRun(Arc<Studies>);

#[async_trait]
impl Tool for ArchiveRun {
    type Input = ArchiveRunInput;
    type Output = RunDigest;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.archive_run", "Archive a research run", RiskTier::Modify)
            .description("Archives a run (archived: true), keeping it and its trial but taking it out of the Research list, or brings it back (archived: false).")
            .activity("Archiving a run")
    }

    async fn call(&self, _ctx: &ToolCtx, input: ArchiveRunInput) -> Result<RunDigest, ToolError> {
        let run = self
            .0
            .archive_run(&input.run_id, input.archived)
            .map_err(failed)?;
        Ok(RunDigest::from(&run))
    }
}

struct DeleteRun(Arc<Studies>);

#[async_trait]
impl Tool for DeleteRun {
    type Input = RunIdInput;
    type Output = Deleted;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.delete_run", "Delete a research run", RiskTier::Modify)
            .description("Removes one run from the ledger; its study stays. Its trial stays counted in the family's research budget.")
            .activity("Deleting a run")
    }

    async fn call(&self, _ctx: &ToolCtx, input: RunIdInput) -> Result<Deleted, ToolError> {
        Ok(Deleted {
            deleted: self.0.delete_run(&input.run_id).map_err(failed)?,
        })
    }
}

struct SignalOf(Arc<Studies>);

#[async_trait]
impl Tool for SignalOf {
    type Input = StudyIdInput;
    type Output = StudySignal;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.study_signal", "A study's signal now", RiskTier::Read)
            .description("Runs a study's strategy, as registered, on the latest closed bars of its instrument and timeframe (its levels and window too) and returns the position it holds after the last one: contracts, positive long and negative short, 0 flat, with the bar that set it and its stop and target in price from the fill. This is what the study would hold now; it measures nothing and promises nothing. A trading session that trades a study is woken whenever this changes.")
            .activity("Reading a study's signal")
            .timeout_ms(60_000)
    }

    async fn call(&self, _ctx: &ToolCtx, input: StudyIdInput) -> Result<StudySignal, ToolError> {
        self.0.signal(&input.id).await.map_err(failed)
    }

    fn summarize(&self, out: &StudySignal) -> Option<String> {
        Some(format!("{}: {}", out.name, out.position))
    }
}

struct StudyTrades(Arc<Studies>);

#[async_trait]
impl Tool for StudyTrades {
    type Input = StudyTradesInput;
    type Output = Study;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.study_trades", "Study journaled trades", RiskTier::Modify)
            .description(format!("Registers a draft study that replays closed trades on bars, so Research measures them as it measures any strategy: development and later sessions, fill cases, gates, and the placebo of the same trades at random bars. Pass trades from journal.list_trades (a setup's, a tag's, any filter's). The most traded instrument is studied; each trade enters at the open of the bar its entry fell in and exits at the open of the bar its exit fell in, and the study's notes name what was left out. Returns the study: run it with research.run_study. {LEDGER}"))
            .activity("Registering a study of trades")
    }

    async fn call(&self, ctx: &ToolCtx, input: StudyTradesInput) -> Result<Study, ToolError> {
        let mut study = replay_study(&input).map_err(failed)?;
        study.origin = Some(ctx.origin.clone());
        self.0.save(study).await.map_err(failed)
    }

    fn summarize(&self, out: &Study) -> Option<String> {
        Some(out.name.clone())
    }
}

struct DeleteStudy(Arc<Studies>);

#[async_trait]
impl Tool for DeleteStudy {
    type Input = StudyIdInput;
    type Output = Deleted;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("research.delete_study", "Delete a study", RiskTier::Modify)
            .description("Removes a study and its runs from the ledger. Its trials stay counted in the family's research budget.")
            .activity("Deleting a study")
    }

    async fn call(&self, _ctx: &ToolCtx, input: StudyIdInput) -> Result<Deleted, ToolError> {
        Ok(Deleted {
            deleted: self.0.delete(&input.id).map_err(failed)?,
        })
    }
}

pub fn register(
    r: &mut tessera_tools::ToolRegistry,
    studies: &Arc<Studies>,
) -> Result<(), tessera_tools::RegistryError> {
    r.register(ListStudies(Arc::clone(studies)))?;
    r.register(GetStudy(Arc::clone(studies)))?;
    r.register(SaveStudy(Arc::clone(studies)))?;
    r.register(FreezeStudy(Arc::clone(studies)))?;
    r.register(RunStudy(Arc::clone(studies)))?;
    r.register(GetRun(Arc::clone(studies)))?;
    r.register(ListRuns(Arc::clone(studies)))?;
    r.register(ArchiveRun(Arc::clone(studies)))?;
    r.register(DeleteRun(Arc::clone(studies)))?;
    r.register(SignalOf(Arc::clone(studies)))?;
    r.register(StudyTrades(Arc::clone(studies)))?;
    r.register(DeleteStudy(Arc::clone(studies)))
}

pub fn ts_exports(t: tessera_host::TsExports) -> tessera_host::TsExports {
    t.tool::<NoInput, StudyList>("research.list_studies")
        .tool::<StudyIdInput, StudyDetail>("research.get_study")
        .tool::<SaveStudyInput, Study>("research.save_study")
        .tool::<StudyIdInput, Study>("research.freeze_study")
        .tool::<StudyIdInput, RunDigest>("research.run_study")
        .tool::<RunIdInput, StudyRun>("research.get_run")
        .tool::<NoInput, RunList>("research.list_runs")
        .tool::<ArchiveRunInput, RunDigest>("research.archive_run")
        .tool::<RunIdInput, Deleted>("research.delete_run")
        .tool::<StudyIdInput, StudySignal>("research.study_signal")
        .tool::<StudyTradesInput, Study>("research.study_trades")
        .tool::<StudyIdInput, Deleted>("research.delete_study")
}
