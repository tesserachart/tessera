use std::sync::Arc;

use rust_decimal::prelude::ToPrimitive;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tessera_core::clock::Clock;
use tessera_core::hash::hash_json;
use tessera_core::ids::CallId;
use tessera_core::initial_balance::{MINUTES_SETTING, minutes_setting};
use tessera_core::instrument::ContractSpec;
use tessera_core::session::SessionCalendar;
use tessera_core::{InstrumentId, Origin, Timeframe, Timestamp};
use tessera_market::saved::{Contract, SavedTrades};
use tessera_market::{BarsRequest, MarketDataProvider, MarketRouter};
use tessera_store::{Docs, Store, StoreError};
use ts_rs::TS;

use crate::backtest::{BacktestConfig, BarPaths, Bars, ExitReason, Signals, backtest};
use crate::budget::ResearchBudget;
use crate::evaluate::{EvalSpec, Evaluation, FillCase, Gates, Verdict, evaluate};
use crate::experiment::ExperimentState;
use crate::levels::{self, LevelColumn, LevelCoverage, TimeWindow};
use crate::rules::Rule;

const STUDIES: &str = "research.study";
const RUNS: &str = "research.run";
const BUDGETS: &str = "research.budget";
pub const MAX_BARS: usize = 200_000;
const SIGNAL_BARS: usize = 5_000;

/// How a study's strategy decides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Strategy {
    /// A built-in rule.
    Rules {
        /// The rule and its parameters.
        rule: Rule,
    },
    /// JavaScript run by Tessera's own engine (every platform): `export function positions(bars,
    /// inputs)` returns a target position per bar (NaN for no change), or `{ position,
    /// stopDistance, targetDistance }` with a trade's bracket in price from its fill, decided on
    /// the bar that decides the trade. Each decision acts at the next bar's open.
    Script {
        /// The code.
        code: String,
        /// Values for the inputs it declares (`export const strategy = { inputs }`); the rest
        /// take their defaults.
        #[serde(default)]
        #[ts(type = "Record<string, number | string | boolean>")]
        inputs: serde_json::Map<String, serde_json::Value>,
        /// Free parameters, for the research budget: at least the inputs it declares.
        #[serde(default, rename = "freeParameters")]
        free_parameters: u32,
    },
}

/// How a study trades.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    /// Contracts per trade.
    #[serde(default = "one")]
    pub qty: f64,
    /// Commission per contract per side.
    #[serde(default = "fee")]
    pub commission_per_contract: f64,
    /// A protective stop, in ticks from each fill.
    #[serde(default)]
    pub stop_ticks: Option<f64>,
    /// A target, in ticks from each fill.
    #[serde(default)]
    pub target_ticks: Option<f64>,
    /// The fill cases, the base case first.
    #[serde(default = "fill_cases")]
    pub fill_cases: Vec<FillCase>,
}

fn one() -> f64 {
    1.0
}
fn fee() -> f64 {
    1.0
}
fn fill_cases() -> Vec<FillCase> {
    vec![
        FillCase {
            name: "base".into(),
            slippage_ticks: 1.0,
        },
        FillCase {
            name: "stressed".into(),
            slippage_ticks: 2.0,
        },
    ]
}

impl Default for Execution {
    fn default() -> Self {
        Self {
            qty: 1.0,
            commission_per_contract: 1.0,
            stop_ticks: None,
            target_ticks: None,
            fill_cases: fill_cases(),
        }
    }
}

/// The history a study reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StudyData {
    /// The instrument.
    pub instrument: InstrumentId,
    /// The bars' timeframe.
    pub tf: Timeframe,
    /// From (inclusive); none: as far back as the connection serves.
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// To (inclusive); none: now.
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Regular hours only.
    #[serde(default)]
    pub rth_only: bool,
    /// Share of sessions that are development; the rest are the later sessions.
    #[serde(default = "half")]
    pub development_share: f64,
    /// Market-intelligence levels the strategy reads, from the level history: `vendor.level` or
    /// `vendor.package.level` (`acme.major_long_gamma`, `acme.state.major_long_gamma`), with
    /// `@INSTRUMENT` to read another instrument's (`acme.zero_gamma@NDX`). A JavaScript strategy
    /// gets each as `bars.levels[name]` (the value standing at each bar's open, NaN before the
    /// first and where not applicable) and its vendor time as `bars.levelsAsOf[name]`; only
    /// sessions every input covers are run. `tessera.ib.high`, `.low`, `.mid`, `.high50`,
    /// `.low50`, `.high100` and `.low100` are the session's initial balance, the same values the
    /// chart draws (window: setting chart.initialBalanceMinutes from the RTH open), measured from
    /// the study's own bars and standing from the bar after the window ends.
    #[serde(default)]
    pub levels: Vec<String>,
    /// Trade only inside this daily window (`{start: "09:30", end: "11:30"}`, New York unless
    /// `timeZone` says otherwise): flat outside it.
    #[serde(default)]
    pub window: Option<TimeWindow>,
}

fn half() -> f64 {
    0.5
}

/// A study, as registered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Study {
    /// Id.
    pub id: String,
    /// Its name.
    pub name: String,
    /// The family its research budget counts in (`ema-cross/NQ`).
    pub family: String,
    /// What is expected and why, registered before any outcome.
    pub hypothesis: String,
    /// What is known already and what would limit the result.
    #[serde(default)]
    pub notes: Option<String>,
    /// The history.
    pub data: StudyData,
    /// The rules.
    pub strategy: Strategy,
    /// How it trades.
    #[serde(default)]
    pub execution: Execution,
    /// What it must pass.
    #[serde(default)]
    pub gates: Gates,
    /// Placebo runs (0: none).
    #[serde(default = "placebo")]
    pub placebo_runs: u32,
    /// Its lifecycle state.
    pub state: ExperimentState,
    /// Generation (bumped when a frozen study is changed).
    pub generation: u32,
    /// The hash of what was frozen.
    pub manifest_hash: Option<String>,
    /// When it was frozen.
    #[ts(type = "number | null")]
    pub frozen_at: Option<Timestamp>,
    /// The latest run's verdict.
    #[serde(default)]
    pub last_verdict: Option<Verdict>,
    /// Who registered it: the user, or the analyst chat (its session) that asked for it.
    #[serde(default)]
    pub origin: Option<Origin>,
}

fn placebo() -> u32 {
    100
}

impl Study {
    fn free_parameters(&self) -> u32 {
        match &self.strategy {
            Strategy::Rules { rule } => rule.free_parameters(),
            Strategy::Script {
                free_parameters, ..
            } => *free_parameters,
        }
    }

    fn manifest(&self) -> serde_json::Value {
        json!({
            "hypothesis": self.hypothesis,
            "data": self.data,
            "strategy": self.strategy,
            "execution": self.execution,
            "gates": self.gates,
            "placeboRuns": self.placebo_runs,
            "generation": self.generation,
        })
    }

    fn draft(mut self) -> Self {
        self.state = ExperimentState::Draft;
        self.generation = 1;
        self.manifest_hash = None;
        self.frozen_at = None;
        self.last_verdict = None;
        self
    }

    fn revise(&self, mut next: Study) -> Study {
        next.generation = self.generation;
        next.origin = self.origin.clone().or(next.origin);
        if self.state != ExperimentState::Draft {
            if self.manifest() == next.manifest()
                && self.name == next.name
                && self.notes == next.notes
            {
                return self.clone();
            }
            next.generation = self.generation + 1;
        }
        next.last_verdict = if self.state == ExperimentState::Draft {
            self.last_verdict
        } else {
            None
        };
        next.state = ExperimentState::Draft;
        next.manifest_hash = None;
        next.frozen_at = None;
        next
    }

    fn freeze(&mut self, now: Timestamp) -> Result<(), String> {
        if self.state != ExperimentState::Draft {
            return Ok(());
        }
        self.validate()?;
        self.manifest_hash = Some(hash_json(&self.manifest()));
        self.frozen_at = Some(now);
        self.state = ExperimentState::Frozen;
        self.last_verdict = None;
        Ok(())
    }

    fn record(&mut self, ran: &Study, verdict: Verdict) {
        if self.generation != ran.generation || self.manifest() != ran.manifest() {
            return;
        }
        if self.state != ExperimentState::Draft {
            self.state = ExperimentState::Recorded;
        }
        self.last_verdict = Some(verdict);
    }

    fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("a study needs a name".into());
        }
        if self.hypothesis.trim().is_empty() {
            return Err("a study registers its hypothesis before it runs".into());
        }
        if let Strategy::Rules { rule } = &self.strategy {
            rule.validate()?;
        }
        if let Strategy::Script { code, .. } = &self.strategy
            && code.trim().is_empty()
        {
            return Err("the strategy's code is empty".into());
        }
        if self.execution.fill_cases.is_empty() {
            return Err("a study needs at least one fill case".into());
        }
        if self.execution.qty.is_nan() || self.execution.qty <= 0.0 {
            return Err("a trade needs at least one contract".into());
        }
        levels::check(&self.data.levels, self.data.window.as_ref(), self.data.tf)?;
        Ok(())
    }
}

/// A run, as stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StudyRun {
    /// Id.
    pub id: String,
    /// The study.
    pub study_id: String,
    /// The study's generation it ran.
    pub generation: u32,
    /// The study's manifest hash (none: exploratory, on a draft).
    pub manifest_hash: Option<String>,
    /// Run on a draft: not evidence.
    pub exploratory: bool,
    /// When it ran.
    #[ts(type = "number")]
    pub at: Timestamp,
    /// The data actually read.
    #[ts(type = "number")]
    pub from: Timestamp,
    /// Its last bar.
    #[ts(type = "number")]
    pub to: Timestamp,
    /// The research budget of its family after it.
    pub budget: ResearchBudget,
    /// The measurements.
    pub evaluation: Evaluation,
    /// What its level inputs covered, and the sessions left out for lack of them.
    #[serde(default)]
    pub levels: Option<LevelCoverage>,
    /// Who ran it: the user, or the analyst chat (its session).
    #[serde(default)]
    pub origin: Option<Origin>,
    /// When it was archived: kept, but out of the Research list until restored.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub archived_at: Option<Timestamp>,
}

/// `research.study_signal` output: where a study's strategy stands on the latest closed bars.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StudySignal {
    /// The study.
    pub study_id: String,
    /// Its name.
    pub name: String,
    /// Its generation.
    pub generation: u32,
    /// What was frozen (none: a draft).
    pub manifest_hash: Option<String>,
    /// The instrument it trades.
    pub instrument: InstrumentId,
    /// Its bars' timeframe.
    pub tf: Timeframe,
    /// The open of the last closed bar it read.
    #[ts(type = "number")]
    pub bar_at: Timestamp,
    /// The position its backtest holds after that bar, stops and targets included, in contracts:
    /// positive long, negative short, 0 flat.
    pub position: f64,
    /// The open of the bar it entered that position at, or of the bar that decided a change for
    /// the next bar; none: flat.
    #[ts(type = "number | null")]
    pub decided_at: Option<Timestamp>,
    /// The stop, in price from the fill (the strategy's own, else the execution's stop ticks).
    pub stop_distance: Option<f64>,
    /// The target, in price from the fill.
    pub target_distance: Option<f64>,
    /// It set that position again on the last bar: after a stop or target closes a trade it enters
    /// again at the next bar's open, as its backtest does. False: it stays out after a stop or
    /// target until its position changes.
    pub reenters: bool,
    /// The latest sessions have no values of its level inputs yet: it holds nothing until they do.
    pub levels_missing: bool,
    /// When the next bar closes, the earliest the position can change.
    #[ts(type = "number")]
    pub next_at: Timestamp,
}

struct Decided {
    provider: Arc<dyn MarketDataProvider>,
    spec: ContractSpec,
    latest: Option<i64>,
    frame: Frame,
    coverage: Option<LevelCoverage>,
    signals: Signals,
}

fn config_of(study: &Study, spec: &ContractSpec) -> BacktestConfig {
    let tick = spec.tick_size.0.to_f64().unwrap_or(0.0);
    let tick_value = spec.tick_value.amount.to_f64().unwrap_or(0.0);
    BacktestConfig {
        tick,
        point_value: if tick > 0.0 { tick_value / tick } else { 0.0 },
        commission_per_contract: study.execution.commission_per_contract,
        slippage_ticks: 0.0,
        stop_ticks: study.execution.stop_ticks,
        target_ticks: study.execution.target_ticks,
        initial_equity: 100_000.0,
    }
}

fn flat_signal(study: &Study, bar_at: i64, levels_missing: bool) -> StudySignal {
    StudySignal {
        study_id: study.id.clone(),
        name: study.name.clone(),
        generation: study.generation,
        manifest_hash: study.manifest_hash.clone(),
        instrument: study.data.instrument.clone(),
        tf: study.data.tf,
        bar_at: Timestamp(bar_at),
        position: 0.0,
        decided_at: None,
        stop_distance: None,
        target_distance: None,
        reenters: false,
        levels_missing,
        next_at: Timestamp(bar_at + 2 * study.data.tf.nanos()),
    }
}

pub fn standing_signal(
    study: &Study,
    bars: &Bars,
    s: &Signals,
    cfg: &BacktestConfig,
) -> Result<StudySignal, String> {
    let Some(last) = bars.len().checked_sub(1) else {
        return Err("no closed bars to decide on".into());
    };
    let run = backtest(bars, s, &BarPaths::default(), cfg)?;
    let held = run
        .trades
        .last()
        .filter(|t| t.exit == ExitReason::EndOfData && t.exit_time == bars.time[last]);
    let have = held.map_or(0.0, |t| t.qty);
    let asserted = s.position[last].is_finite();
    let want = s.position[last].round();
    let mut out = flat_signal(study, bars.time[last], false);
    if asserted && want != have {
        let on_ticks = |d: f64| (d / cfg.tick).round().max(1.0) * cfg.tick;
        let ticks = |t: Option<f64>| t.filter(|t| *t > 0.0).map(|t| t * cfg.tick);
        out.position = want;
        if want != 0.0 {
            out.decided_at = Some(Timestamp(bars.time[last]));
            out.stop_distance = Signals::distance(&s.stop_distance, last)
                .map(on_ticks)
                .or_else(|| ticks(cfg.stop_ticks));
            out.target_distance = Signals::distance(&s.target_distance, last)
                .map(on_ticks)
                .or_else(|| ticks(cfg.target_ticks));
        }
    } else if let Some(t) = held {
        out.position = t.qty;
        out.decided_at = Some(Timestamp(t.entry_time));
        let on_tick = |p: f64| ((t.entry_price - p).abs() / cfg.tick).round() * cfg.tick;
        out.stop_distance = t.stop.map(on_tick);
        out.target_distance = t.target.map(on_tick);
    }
    out.reenters = out.position != 0.0 && asserted;
    Ok(out)
}

#[derive(Clone, Debug, Default)]
pub struct Frame {
    pub bars: Bars,
    pub volume: Vec<f64>,
    pub buy_volume: Vec<f64>,
    pub session: Vec<u32>,
    pub session_dates: Vec<String>,
    pub levels: Vec<LevelColumn>,
}

fn readable<T: serde::de::DeserializeOwned>(docs: Vec<tessera_store::Document>) -> Vec<T> {
    docs.into_iter()
        .filter_map(|d| match serde_json::from_value(d.body) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!(id = %d.id, error = %e, "a research ledger entry could not be read and is left out");
                None
            }
        })
        .collect()
}

pub struct Studies {
    store: Store,
    market: Arc<MarketRouter>,
    clock: Arc<dyn Clock>,
    prints: Option<Arc<SavedTrades>>,
}

impl std::fmt::Debug for Studies {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Studies").finish_non_exhaustive()
    }
}

fn store_err(e: StoreError) -> String {
    format!("the research ledger could not be read or written: {e}")
}

enum Refused {
    Ledger(StoreError),
    Study(String),
}

impl From<StoreError> for Refused {
    fn from(e: StoreError) -> Self {
        Refused::Ledger(e)
    }
}

impl From<Refused> for String {
    fn from(r: Refused) -> Self {
        match r {
            Refused::Ledger(e) => store_err(e),
            Refused::Study(why) => why,
        }
    }
}

impl Studies {
    pub fn new(store: Store, market: Arc<MarketRouter>, clock: Arc<dyn Clock>) -> Self {
        let studies = Self {
            store,
            market,
            clock,
            prints: None,
        };
        if let Err(e) = studies.port_unrunnable_strategies() {
            tracing::warn!(error = %e, "studies written for an earlier engine were left as they were");
        }
        studies
    }

    #[must_use]
    pub fn with_prints(mut self, prints: Arc<SavedTrades>) -> Self {
        self.prints = Some(prints);
        self
    }

    fn port_unrunnable_strategies(&self) -> Result<(), String> {
        let repo = self.store.documents(STUDIES);
        for doc in repo.list(None, 500).map_err(store_err)? {
            let mut body = doc.body;
            if body["strategy"]["kind"] != "python" {
                continue;
            }
            let old = body["strategy"]["code"].as_str().unwrap_or_default();
            body["strategy"] = json!({
                "kind": "script",
                "code": rewrite_note(old),
                "freeParameters": body["strategy"]["freeParameters"],
            });
            let mut study: Study = serde_json::from_value(body).map_err(|e| e.to_string())?;
            if study.state != ExperimentState::Draft {
                study.generation += 1;
                study.state = ExperimentState::Draft;
                study.manifest_hash = None;
                study.frozen_at = None;
                study.last_verdict = None;
            }
            self.put(&study)?;
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Study>, String> {
        Ok(readable(
            self.store
                .documents(STUDIES)
                .list(None, 500)
                .map_err(store_err)?,
        ))
    }

    fn studies(&self) -> Docs<'_, Study> {
        self.store.docs(STUDIES)
    }

    pub fn get(&self, id: &str) -> Result<Study, String> {
        self.studies()
            .get(id)
            .map_err(store_err)?
            .ok_or_else(|| format!("no study {id}"))
    }

    fn put(&self, s: &Study) -> Result<(), String> {
        self.studies()
            .put(&s.id, None, s, self.clock.now())
            .map_err(store_err)
    }

    pub async fn save(&self, mut study: Study) -> Result<Study, String> {
        study.data.instrument = self
            .market
            .resolve(study.data.instrument.as_str())
            .await
            .map_err(|e| e.to_string())?;
        if study.id.is_empty() {
            study.id = format!("study-{}", CallId::generate().0);
        }
        if study.family.trim().is_empty() {
            study.family = default_family(&study);
        }
        study.validate()?;
        if let Strategy::Script {
            code,
            free_parameters,
            ..
        } = &mut study.strategy
        {
            let source = code.clone();
            let declared =
                tokio::task::spawn_blocking(move || tessera_script::describe_strategy(&source))
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| format!("the strategy's code: {e}"))?;
            *free_parameters = (*free_parameters).max(declared.len() as u32);
        }
        let next = study.clone();
        let revised = self
            .studies()
            .change(&study.id, self.clock.now(), |prev| {
                *prev = prev.revise(next);
                Ok::<_, StoreError>(prev.clone())
            })
            .map_err(store_err)?;
        match revised {
            Some(s) => Ok(s),
            None => {
                let s = study.draft();
                self.put(&s)?;
                Ok(s)
            }
        }
    }

    pub fn freeze(&self, id: &str) -> Result<Study, String> {
        let now = self.clock.now();
        self.studies()
            .change(id, now, |s| {
                s.freeze(now).map_err(Refused::Study)?;
                Ok::<_, Refused>(s.clone())
            })?
            .ok_or_else(|| format!("no study {id}"))
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        self.store
            .documents(RUNS)
            .delete_children(id)
            .map_err(store_err)?;
        self.store.documents(STUDIES).delete(id).map_err(store_err)
    }

    pub fn runs(&self, id: &str) -> Result<Vec<StudyRun>, String> {
        let mut runs: Vec<StudyRun> = readable(
            self.store
                .documents(RUNS)
                .list(Some(id), 200)
                .map_err(store_err)?,
        );
        runs.sort_by_key(|r| std::cmp::Reverse(r.at));
        Ok(runs)
    }

    pub fn all_runs(&self) -> Result<Vec<StudyRun>, String> {
        let mut runs: Vec<StudyRun> = readable(
            self.store
                .documents(RUNS)
                .list(None, 1_000)
                .map_err(store_err)?,
        );
        runs.sort_by_key(|r| std::cmp::Reverse(r.at));
        Ok(runs)
    }

    pub fn archive_run(&self, run_id: &str, archived: bool) -> Result<StudyRun, String> {
        let now = self.clock.now();
        self.store
            .docs::<StudyRun>(RUNS)
            .change(run_id, now, |r| {
                r.archived_at = archived.then_some(r.archived_at.unwrap_or(now));
                Ok::<_, StoreError>(r.clone())
            })
            .map_err(store_err)?
            .ok_or_else(|| format!("no run {run_id}"))
    }

    pub fn delete_run(&self, run_id: &str) -> Result<bool, String> {
        self.store.documents(RUNS).delete(run_id).map_err(store_err)
    }

    pub fn run_of(&self, run_id: &str) -> Result<StudyRun, String> {
        let d = self
            .store
            .documents(RUNS)
            .get(run_id)
            .map_err(store_err)?
            .ok_or_else(|| format!("no run {run_id}"))?;
        serde_json::from_value(d.body).map_err(|e| e.to_string())
    }

    pub fn budgets(&self) -> Result<Vec<ResearchBudget>, String> {
        self.store
            .documents(BUDGETS)
            .list(None, 500)
            .map_err(store_err)?
            .into_iter()
            .map(|d| serde_json::from_value(d.body).map_err(|e| e.to_string()))
            .collect()
    }

    fn count_trial(&self, s: &Study) -> Result<ResearchBudget, String> {
        let repo = self.store.documents(BUDGETS);
        let mut b: ResearchBudget = repo
            .get(&s.family)
            .map_err(store_err)?
            .and_then(|d| serde_json::from_value(d.body).ok())
            .unwrap_or_else(|| ResearchBudget::new(s.family.clone(), s.free_parameters()));
        b.record_trials(1);
        b.free_parameters = b.free_parameters.max(s.free_parameters());
        repo.put(
            &s.family,
            None,
            &serde_json::to_value(&b).map_err(|e| e.to_string())?,
            self.clock.now(),
        )
        .map_err(store_err)?;
        Ok(b)
    }

    async fn decide(&self, study: &Study, latest_bars: Option<usize>) -> Result<Decided, String> {
        let d = &study.data;
        let provider = self
            .market
            .route_async(&d.instrument)
            .await
            .map_err(|e| e.to_string())?;
        let (_, spec) = provider
            .spec(&d.instrument)
            .await
            .map_err(|e| e.to_string())?;
        let (from, to, limit) = match latest_bars {
            Some(n) => (None, None, n),
            None => (d.from, d.to, MAX_BARS),
        };
        let series = provider
            .get_bars(BarsRequest {
                instrument: d.instrument.clone(),
                tf: d.tf,
                from,
                to,
                limit: Some(limit),
                rth_only: d.rth_only,
            })
            .await
            .map_err(|e| e.to_string())?;
        let mut bars = series.bars;
        if series.last_bar_open {
            bars.pop();
        }
        let latest = bars.last().map(|b| b.t.0);
        let mut frame = frame_of(&bars, spec.sessions);
        let mut coverage = None;
        let (balance, history): (Vec<String>, Vec<String>) = d
            .levels
            .iter()
            .cloned()
            .partition(|n| levels::is_initial_balance(n));
        if !history.is_empty() {
            let mut instruments = vec![d.instrument.to_string()];
            instruments.extend(spec.root.clone());
            let (f, c) = levels::prepare(&self.store, &history, &instruments, frame, d.tf)?;
            frame = f;
            coverage = Some(c);
        }
        if !balance.is_empty() {
            let setting = self.store.settings().get(MINUTES_SETTING).ok().flatten();
            let minutes = minutes_setting(setting.as_ref());
            let (columns, inputs) = levels::initial_balance_columns(
                &balance,
                &frame,
                spec.sessions,
                d.tf,
                minutes,
                d.instrument.as_str(),
            )?;
            frame.levels.extend(columns);
            let sessions = frame.session_dates.len() as u32;
            let c = coverage.get_or_insert_with(|| LevelCoverage {
                inputs: Vec::new(),
                sessions_read: sessions,
                sessions_used: sessions,
                used_from: frame.session_dates.first().cloned(),
                used_to: frame.session_dates.last().cloned(),
                excluded_dates: Vec::new(),
            });
            c.inputs.extend(inputs);
        }
        if frame.bars.len() < 50 {
            return Err(format!(
                "only {} closed bars of {} at {} in that range; widen the dates",
                frame.bars.len(),
                d.instrument,
                d.tf
            ));
        }
        if latest_bars.is_none()
            && let Some(c) = &coverage
            && c.sessions_used < 4
        {
            return Err(format!(
                "only {} of {} sessions ({} to {}) have history of every level input; a study needs at least 4. Import or backfill more history, or let recording run longer",
                c.sessions_used,
                c.sessions_read,
                c.used_from.as_deref().unwrap_or("?"),
                c.used_to.as_deref().unwrap_or("?")
            ));
        }
        let mut signals = match &study.strategy {
            Strategy::Rules { rule } => {
                Signals::positions(rule.targets(&frame.bars, study.execution.qty))
            }
            Strategy::Script { code, inputs, .. } => {
                script_signals(code, inputs, &frame, spec.sessions).await?
            }
        };
        if let Some(w) = &d.window {
            w.parse()?.flatten(&frame.bars.time, &mut signals.position);
        }
        Ok(Decided {
            provider,
            spec,
            latest,
            frame,
            coverage,
            signals,
        })
    }

    pub async fn signal(&self, id: &str) -> Result<StudySignal, String> {
        let study = self.get(id)?;
        study.validate()?;
        let Decided {
            spec,
            latest,
            frame,
            signals,
            ..
        } = self.decide(&study, Some(SIGNAL_BARS)).await?;
        let decided_to = frame.bars.time.last().copied();
        if let Some(latest) = latest
            && decided_to != Some(latest)
        {
            return Ok(flat_signal(&study, latest, true));
        }
        standing_signal(&study, &frame.bars, &signals, &config_of(&study, &spec))
    }

    pub async fn run(&self, id: &str, origin: Origin) -> Result<StudyRun, String> {
        let study = self.get(id)?;
        study.validate()?;
        let d = &study.data;
        let Decided {
            provider,
            spec,
            frame,
            coverage,
            signals,
            ..
        } = self.decide(&study, None).await?;
        let config = config_of(&study, &spec);
        let seed = study.manifest_hash.as_deref().map_or(1, |h| {
            u64::from_str_radix(&h[..h.len().min(15)], 16).unwrap_or(1)
        });
        let paths = match &self.prints {
            Some(saved) => {
                let contract = Contract::new(provider.id(), &d.instrument);
                bar_paths(Arc::clone(saved), contract, &frame.bars, d.tf).await
            }
            None => BarPaths::default(),
        };
        let spec = EvalSpec {
            config: &config,
            paths: &paths,
            cases: &study.execution.fill_cases,
            gates: &study.gates,
            development_share: d.development_share,
            placebo_runs: study.placebo_runs.min(500),
            seed,
        };
        let evaluation = evaluate(&frame.bars, &frame.session, &signals, &spec)?;
        let budget = self.count_trial(&study)?;
        let now = self.clock.now();
        let run = StudyRun {
            id: format!("run-{}", CallId::generate().0),
            study_id: study.id.clone(),
            generation: study.generation,
            manifest_hash: study.manifest_hash.clone(),
            exploratory: study.state == ExperimentState::Draft,
            at: now,
            from: Timestamp(frame.bars.time[0]),
            to: Timestamp(*frame.bars.time.last().unwrap_or(&0)),
            budget,
            evaluation,
            levels: coverage,
            origin: Some(origin),
            archived_at: None,
        };
        self.store
            .documents(RUNS)
            .put(
                &run.id,
                Some(&study.id),
                &serde_json::to_value(&run).map_err(|e| e.to_string())?,
                now,
            )
            .map_err(store_err)?;
        let verdict = run.evaluation.verdict;
        let recorded = self
            .studies()
            .change(&study.id, now, |s| {
                s.record(&study, verdict);
                Ok::<_, StoreError>(())
            })
            .map_err(store_err)?;
        if recorded.is_none() {
            self.store
                .documents(RUNS)
                .delete(&run.id)
                .map_err(store_err)?;
            return Err(format!("no study {id}"));
        }
        Ok(run)
    }
}

fn default_family(s: &Study) -> String {
    let kind = match &s.strategy {
        Strategy::Rules { rule } => match rule {
            Rule::EmaCross { .. } => "ema-cross",
            Rule::Breakout { .. } => "breakout",
            Rule::RsiReversion { .. } => "rsi-reversion",
        },
        Strategy::Script { .. } => "script",
    };
    format!("{kind}/{}", s.data.instrument.symbol())
}

fn rewrite_note(python: &str) -> String {
    format!(
        "/*\n{}\n*/\nexport function positions() {{\n  throw new Error('These rules were written in Python, which Tessera no longer runs: rewrite them in JavaScript as positions(bars, inputs). The Python is kept above.');\n}}\n",
        python.replace("*/", "* /")
    )
}

async fn bar_paths(
    saved: Arc<SavedTrades>,
    contract: Contract,
    bars: &Bars,
    tf: Timeframe,
) -> BarPaths {
    let (times, width) = (bars.time.clone(), tf.nanos());
    let read = tokio::task::spawn_blocking(move || {
        let (Some(first), Some(last)) = (times.first(), times.last()) else {
            return BarPaths::default();
        };
        let store = saved.store();
        let key = contract.key();
        let Ok(covered) = store.covered(key, *first, last + width) else {
            return BarPaths::default();
        };
        let whole = |from: i64, to: i64| covered.iter().any(|c| c.start <= from && to <= c.end);
        let mut out = vec![None; times.len()];
        let mut i = 0;
        for c in &covered {
            let Ok(rows) = store.read(key, c.start, c.end) else {
                continue;
            };
            let mut at = 0;
            while i < times.len() && times[i] < c.end {
                let (from, to) = (times[i], times[i] + width);
                if whole(from, to) {
                    while at < rows.len() && rows[at].t < from {
                        at += 1;
                    }
                    let end = at + rows[at..].partition_point(|r| r.t < to);
                    out[i] = Some(BarPaths::path(
                        rows[at..end]
                            .iter()
                            .map(|r| r.price.0.to_f64().unwrap_or(f64::NAN)),
                    ));
                    at = end;
                }
                if to > c.end {
                    break;
                }
                i += 1;
            }
        }
        BarPaths(out)
    });
    read.await.unwrap_or_default()
}

async fn script_signals(
    code: &str,
    inputs: &serde_json::Map<String, serde_json::Value>,
    frame: &Frame,
    calendar: SessionCalendar,
) -> Result<Signals, String> {
    let b = &frame.bars;
    let bars = tessera_script::BarArrays {
        time: b.time.iter().map(|t| *t as f64 / 1e9).collect(),
        open: b.open.clone(),
        high: b.high.clone(),
        low: b.low.clone(),
        close: b.close.clone(),
        volume: frame.volume.clone(),
        buy_volume: frame
            .buy_volume
            .iter()
            .any(|v| v.is_finite())
            .then(|| frame.buy_volume.clone()),
        calendar,
    };
    let columns = tessera_script::StudyColumns {
        session: frame.session.iter().map(|s| f64::from(*s)).collect(),
        levels: frame
            .levels
            .iter()
            .map(|l| (l.name.clone(), l.values.clone(), l.as_of.clone()))
            .collect(),
    };
    let (code, inputs) = (code.to_owned(), inputs.clone());
    let d = tokio::task::spawn_blocking(move || {
        tessera_script::run_strategy(
            &code,
            &bars,
            &columns,
            &inputs,
            tessera_script::Limits::STUDY,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("the strategy's code: {e}"))?;
    Ok(Signals {
        position: d.position,
        stop_distance: d.stop_distance,
        target_distance: d.target_distance,
    })
}

pub fn frame_of(bars: &[tessera_core::market::Bar], calendar: SessionCalendar) -> Frame {
    let f = |p: tessera_core::money::Price| p.0.to_f64().unwrap_or(f64::NAN);
    let mut out = Frame::default();
    let mut last = None;
    let mut ordinal = 0u32;
    for b in bars {
        let date = calendar.trade_date(b.t);
        if let Some(prev) = last
            && prev != date
        {
            ordinal += 1;
        }
        if last != Some(date) {
            out.session_dates.push(date.format("%Y-%m-%d").to_string());
        }
        last = Some(date);
        out.bars.time.push(b.t.0);
        out.bars.open.push(f(b.o));
        out.bars.high.push(f(b.h));
        out.bars.low.push(f(b.l));
        out.bars.close.push(f(b.c));
        out.volume.push(b.v.0.to_f64().unwrap_or(0.0));
        out.buy_volume
            .push(b.bv.map_or(f64::NAN, |q| q.0.to_f64().unwrap_or(f64::NAN)));
        out.session.push(ordinal);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn study(stop_ticks: Option<f64>) -> Study {
        Study {
            id: "study-1".into(),
            name: "Drift".into(),
            family: "script/NQ".into(),
            hypothesis: "NQ drifts".into(),
            notes: None,
            data: StudyData {
                instrument: InstrumentId::new("NQZ6.CME").unwrap(),
                tf: Timeframe::M1,
                from: None,
                to: None,
                rth_only: false,
                development_share: 0.5,
                levels: Vec::new(),
                window: None,
            },
            strategy: Strategy::Script {
                code: String::new(),
                inputs: serde_json::Map::new(),
                free_parameters: 0,
            },
            execution: Execution {
                stop_ticks,
                ..Execution::default()
            },
            gates: Gates::default(),
            placebo_runs: 0,
            state: ExperimentState::Frozen,
            generation: 1,
            manifest_hash: None,
            frozen_at: None,
            last_verdict: None,
            origin: None,
        }
    }

    const MIN: i64 = 60_000_000_000;

    fn bars(closes: &[f64]) -> Bars {
        let mut b = Bars::default();
        for (i, c) in closes.iter().enumerate() {
            b.time.push(i as i64 * MIN);
            b.open.push(*c);
            b.high.push(*c);
            b.low.push(*c);
            b.close.push(*c);
        }
        b
    }

    fn cfg(stop_ticks: Option<f64>) -> BacktestConfig {
        BacktestConfig {
            tick: 0.25,
            point_value: 20.0,
            commission_per_contract: 1.0,
            slippage_ticks: 0.0,
            stop_ticks,
            target_ticks: None,
            initial_equity: 100_000.0,
        }
    }

    const NAN: f64 = f64::NAN;

    #[test]
    fn the_signal_is_the_trade_its_backtest_holds_after_the_last_bar() {
        let s = Signals {
            position: vec![-1.0, 1.0, NAN, NAN, NAN, NAN],
            stop_distance: vec![NAN, 12.5, NAN, NAN, NAN, NAN],
            target_distance: vec![NAN; 6],
        };
        let sig =
            standing_signal(&study(Some(40.0)), &bars(&[100.0; 6]), &s, &cfg(Some(40.0))).unwrap();
        assert_eq!(sig.position, 1.0);
        assert_eq!(
            sig.decided_at,
            Some(Timestamp(2 * MIN)),
            "entered at the next bar's open"
        );
        assert_eq!(sig.stop_distance, Some(12.5));
        assert_eq!(sig.target_distance, None);
        assert_eq!(sig.bar_at, Timestamp(5 * MIN));
        assert_eq!(sig.next_at, Timestamp(7 * MIN));
        assert!(
            !sig.reenters,
            "a position set once is not entered again after a stop"
        );
    }

    #[test]
    fn a_stop_that_hit_leaves_a_study_that_set_its_position_once_flat() {
        let s = Signals::positions(vec![1.0, NAN, NAN, NAN, NAN]);
        let sig = standing_signal(
            &study(Some(40.0)),
            &bars(&[100.0, 100.0, 80.0, 80.0, 80.0]),
            &s,
            &cfg(Some(40.0)),
        )
        .unwrap();
        assert_eq!(sig.position, 0.0);
        assert_eq!(sig.stop_distance, None);
    }

    #[test]
    fn a_rule_that_sets_its_position_every_bar_enters_again_after_a_stop() {
        let s = Signals::positions(vec![1.0, 1.0, 1.0, 1.0]);
        let sig = standing_signal(
            &study(Some(40.0)),
            &bars(&[100.0, 100.0, 80.0, 80.0]),
            &s,
            &cfg(Some(40.0)),
        )
        .unwrap();
        assert_eq!(sig.position, 1.0);
        assert!(sig.reenters);
        assert_eq!(
            sig.decided_at,
            Some(Timestamp(3 * MIN)),
            "entered again at the bar after the stop"
        );
        assert_eq!(sig.stop_distance, Some(10.0));
    }

    #[test]
    fn a_study_that_never_traded_or_wants_a_fraction_is_flat() {
        let never = Signals::positions(vec![NAN; 3]);
        let sig = standing_signal(
            &study(Some(40.0)),
            &bars(&[100.0; 3]),
            &never,
            &cfg(Some(40.0)),
        )
        .unwrap();
        assert_eq!(sig.position, 0.0);
        assert_eq!(sig.decided_at, None);
        let fraction = Signals::positions(vec![0.4; 3]);
        let sig = standing_signal(&study(None), &bars(&[100.0; 3]), &fraction, &cfg(None)).unwrap();
        assert_eq!(sig.position, 0.0, "the backtest rounds 0.4 to flat");
    }

    #[test]
    fn a_held_short_reads_its_entry_and_stop() {
        let s = Signals::positions(vec![0.0, -2.0, -2.0]);
        let sig =
            standing_signal(&study(Some(40.0)), &bars(&[100.0; 3]), &s, &cfg(Some(40.0))).unwrap();
        assert_eq!(sig.position, -2.0);
        assert_eq!(sig.decided_at, Some(Timestamp(2 * MIN)));
        assert_eq!(sig.stop_distance, Some(10.0));
        assert!(sig.reenters);
    }
}
