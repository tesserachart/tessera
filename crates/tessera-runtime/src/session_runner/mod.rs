pub mod issues;
pub mod tools;
pub mod words;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::NaiveDate;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tessera_agent::AgentService;
use tessera_core::accounts::Environment;
use tessera_core::ids::SessionId;
use tessera_core::limits::LimitsSetting;
use tessera_core::{Origin, SharedClock, Timestamp};
use tessera_protocol::agent::{
    AgentSendOutput, AgentStartSessionInput, SessionRunnerSetting, TradingDay, TradingPhase,
    TradingSessionStatus, WakeAtOutput,
};
use tessera_protocol::cards::{
    Card, CardAction, CardBody, SessionIssue, SessionTrade, TradingSessionReport,
};
use tessera_protocol::tools::SessionMode;
use tessera_research::StudySignal;
use tessera_research::experiment::ExperimentState;
use tessera_research::tools::StudyDetail;
use tessera_store::Store;
use tessera_tools::{InvokeRequest, Invoker, ToolError};

use crate::settings::SettingsService;
use issues::IssueFiler;
use words::{Account, CALENDAR};

pub const SETTING: &str = "agent.sessionRunner";
const DAY_KEY: &str = "agent.session_runner.day";
pub const INSTRUCTIONS_DEFAULT: &str = "~/.config/tessera/analyst-instructions.md";
const INSTRUCTIONS_MAX: usize = 20_000;
const WRAP_BEFORE_CLOSE: i64 = 10 * 60 * 1_000_000_000;
const TURN_GRACE: i64 = 2 * 60 * 1_000_000_000;
const PATIENCE: i64 = 5 * 60 * 1_000_000_000;
const WAKES_MAX: usize = 24;
const SIGNAL_RETRY: i64 = 60 * 1_000_000_000;
pub const TICK: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Day {
    date: NaiveDate,
    phase: TradingPhase,
    account_id: String,
    account_name: String,
    environment: Environment,
    opens_at: Timestamp,
    closes_at: Timestamp,
    session_id: Option<SessionId>,
    started_at: Option<Timestamp>,
    closing_at: Option<Timestamp>,
    #[serde(default)]
    wrap_from: Option<Timestamp>,
    #[serde(default)]
    wakes: Vec<String>,
    #[serde(default)]
    alarms: Vec<Alarm>,
    #[serde(default)]
    trouble: Vec<SessionIssue>,
    note: Option<String>,
    #[serde(default)]
    study: Option<Following>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Following {
    id: String,
    name: String,
    #[serde(default)]
    manifest_hash: Option<String>,
    #[serde(default)]
    instrument: String,
    #[serde(default)]
    dropped: bool,
    position: f64,
    next_at: Timestamp,
    #[serde(default)]
    failing: bool,
}

enum Read {
    Signal(StudySignal),
    Changed,
    Failed(String),
}

struct Ready {
    account: Option<Account>,
    instructions: Option<String>,
    study: Option<StudyDetail>,
}

impl Day {
    fn view(&self) -> TradingDay {
        TradingDay {
            date: self.date.to_string(),
            opens_at: self.opens_at,
            closes_at: self.closes_at,
            phase: self.phase,
            session_id: self.session_id.clone(),
            account_id: self.account_id.clone(),
            started_at: self.started_at,
            note: self.note.clone(),
            study_id: self
                .study
                .as_ref()
                .filter(|f| !f.dropped)
                .map(|f| f.id.clone()),
        }
    }

    fn account(&self) -> Account {
        Account {
            id: self.account_id.clone(),
            name: self.account_name.clone(),
            environment: self.environment,
            limits: None,
        }
    }

    fn hours(&self) -> Hours {
        Hours::new(self.date, self.opens_at, self.closes_at)
    }

    fn is(&self, h: &Hours) -> bool {
        self.date == h.date && self.opens_at == h.open
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Alarm {
    at: Timestamp,
    note: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Hours {
    date: NaiveDate,
    open: Timestamp,
    wrap: Timestamp,
    close: Timestamp,
}

impl Hours {
    fn new(date: NaiveDate, open: Timestamp, close: Timestamp) -> Self {
        Hours {
            date,
            open,
            wrap: Timestamp((close.0 - WRAP_BEFORE_CLOSE).max(open.0)),
            close,
        }
    }
}

fn stretches(date: NaiveDate) -> Vec<Hours> {
    CALENDAR.session(date).map_or_else(Vec::new, |s| {
        s.segments
            .iter()
            .map(|w| Hours::new(date, w.start, w.end))
            .collect()
    })
}

fn startable(now: Timestamp) -> Option<Hours> {
    stretches(CALENDAR.trade_date(now))
        .into_iter()
        .find(|h| now >= h.open && now < h.wrap)
}

fn next_open(now: Timestamp) -> Option<Timestamp> {
    let mut date = CALENDAR.trade_date(now);
    for _ in 0..14 {
        if let Some(h) = stretches(date).into_iter().find(|h| now < h.wrap) {
            return Some(h.open.max(now));
        }
        date = CALENDAR.next_trade_date(date);
    }
    None
}

fn expand(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var("HOME")) {
        (Some(rest), Ok(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(path),
    }
}

fn instructions_path(s: &SessionRunnerSetting) -> PathBuf {
    expand(
        s.instructions_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or(INSTRUCTIONS_DEFAULT),
    )
}

async fn read_instructions(path: PathBuf) -> Result<String, String> {
    let shown = path.display().to_string();
    let text = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("The instructions file {shown} cannot be read: {e}"))?;
    if text.trim().is_empty() {
        return Err(format!("The instructions file {shown} is empty"));
    }
    Ok(text.chars().take(INSTRUCTIONS_MAX).collect())
}

pub struct SessionRunner {
    agents: Arc<AgentService>,
    settings: Arc<SettingsService>,
    store: Store,
    clock: SharedClock,
    issues: Arc<dyn IssueFiler>,
    invoker: OnceLock<Arc<Invoker>>,
    day: Mutex<Option<Day>>,
    waiting: Mutex<Option<(Timestamp, Timestamp)>>,
    one: tokio::sync::Mutex<()>,
    telemetry: OnceLock<crate::telemetry::Telemetry>,
}

#[derive(Debug, Default)]
struct Missing(Vec<(String, bool)>);

impl Missing {
    fn needs(&mut self, words: impl Into<String>) {
        self.0.push((words.into(), false));
    }

    fn waits_on(&mut self, words: impl Into<String>) {
        self.0.push((words.into(), true));
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn only_waits(&self) -> bool {
        self.0.iter().all(|(_, w)| *w)
    }

    fn words(&self) -> Vec<String> {
        self.0.iter().map(|(w, _)| w.clone()).collect()
    }
}

impl std::fmt::Debug for SessionRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionRunner")
            .field("day", &*self.day.lock())
            .finish_non_exhaustive()
    }
}

impl SessionRunner {
    pub fn new(
        agents: Arc<AgentService>,
        settings: Arc<SettingsService>,
        store: Store,
        clock: SharedClock,
        issues: Arc<dyn IssueFiler>,
    ) -> Arc<Self> {
        let day = store
            .settings()
            .get(DAY_KEY)
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok());
        Arc::new(Self {
            agents,
            settings,
            store,
            clock,
            issues,
            invoker: OnceLock::new(),
            day: Mutex::new(day),
            waiting: Mutex::new(None),
            one: tokio::sync::Mutex::new(()),
            telemetry: OnceLock::new(),
        })
    }

    pub fn set_telemetry(&self, telemetry: crate::telemetry::Telemetry) {
        let _ = self.telemetry.set(telemetry);
    }

    pub fn attach_invoker(&self, invoker: Arc<Invoker>) {
        let _ = self.invoker.set(invoker);
    }

    pub fn spawn(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(TICK);
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                iv.tick().await;
                let Some(me) = me.upgrade() else { return };
                me.tick().await;
            }
        })
    }

    fn setting(&self) -> SessionRunnerSetting {
        self.settings
            .value(SETTING)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    fn save(&self, day: Day) {
        if let Ok(v) = serde_json::to_value(&day)
            && let Err(e) = self.store.settings().set(DAY_KEY, &v, self.clock.now())
        {
            tracing::warn!(error = %e, "the trading session's day is not kept");
        }
        *self.day.lock() = Some(day);
    }

    pub fn wakes_itself(&self, session: &str) -> bool {
        self.day.lock().as_ref().is_some_and(|d| {
            matches!(d.phase, TradingPhase::Trading | TradingPhase::Closing)
                && d.session_id.as_ref().is_some_and(|s| s.as_str() == session)
        })
    }

    pub async fn wake(&self, session: &str, text: &str) -> Result<(), String> {
        let trading = self.day.lock().as_ref().is_some_and(|d| {
            d.session_id.as_ref().is_some_and(|s| s.as_str() == session)
                && d.phase == TradingPhase::Trading
        });
        if !trading {
            return Err("the trading session is closing out".into());
        }
        let out = self.say(&SessionId::new(session), text).await?;
        if let Some(id) = out.queued_id {
            let mut guard = self.day.lock();
            if let Some(d) = guard.as_mut() {
                d.wakes.push(id);
                let day = d.clone();
                drop(guard);
                self.save(day);
            }
        }
        Ok(())
    }

    pub fn wake_at(
        &self,
        session: Option<&SessionId>,
        at: Timestamp,
        note: &str,
    ) -> Result<WakeAtOutput, ToolError> {
        let now = self.clock.now();
        let mut guard = self.day.lock();
        let Some(d) = guard.as_mut().filter(|d| {
            d.phase == TradingPhase::Trading
                && session.is_some_and(|s| d.session_id.as_ref() == Some(s))
        }) else {
            return Err(ToolError::invalid_input(
                "Only the analyst of a running trading session sets a wake, for its own session",
            ));
        };
        let wrap = d.hours().wrap;
        if at >= wrap {
            return Err(ToolError::invalid_input(format!(
                "The session closes out at {}: a wake goes before then",
                words::moment(wrap)
            )));
        }
        if note.trim().is_empty() {
            return Err(ToolError::invalid_input(
                "Say what the wake is for in its note",
            ));
        }
        if d.alarms.len() >= WAKES_MAX {
            return Err(ToolError::invalid_input(format!(
                "The session has {WAKES_MAX} wakes set already"
            )));
        }
        let at = at.max(now);
        d.alarms.push(Alarm {
            at,
            note: note.trim().to_owned(),
        });
        d.alarms.sort_by_key(|a| a.at);
        let out = WakeAtOutput {
            at,
            wakes: d.alarms.iter().map(|a| a.at).collect(),
        };
        let day = d.clone();
        drop(guard);
        self.save(day);
        Ok(out)
    }

    async fn ring(&self, sid: &SessionId, now: Timestamp) {
        let due = {
            let mut guard = self.day.lock();
            let Some(d) = guard.as_mut() else { return };
            let due: Vec<Alarm> = d.alarms.iter().filter(|a| a.at <= now).cloned().collect();
            if due.is_empty() {
                return;
            }
            d.alarms.retain(|a| a.at > now);
            let day = d.clone();
            drop(guard);
            self.save(day);
            due
        };
        for a in due {
            if let Err(e) = self.wake(sid.as_str(), &words::woken(now, &a.note)).await {
                self.trouble(runner_words("A wake did not reach the analyst", &e));
            }
        }
    }

    async fn resume_held_queue(&self, sid: &SessionId) {
        let held = self
            .store
            .sessions()
            .get(sid.as_str())
            .ok()
            .flatten()
            .is_some_and(|s| s.queue_held);
        if held
            && !self.agents.answering(sid)
            && let Err(e) = self.agents.resume_queue(sid).await
        {
            self.trouble(runner_words(
                "The session's queue could not resume",
                &e.message,
            ));
        }
    }

    fn drop_queued_wakes(&self, sid: &SessionId, d: &mut Day) {
        for id in std::mem::take(&mut d.wakes) {
            let _ = self.agents.remove_queued(sid, &id);
        }
    }

    fn trouble(&self, issue: SessionIssue) {
        let mut guard = self.day.lock();
        if let Some(d) = guard.as_mut()
            && !d.trouble.iter().any(|t| t.title == issue.title)
        {
            d.trouble.push(issue);
            let day = d.clone();
            drop(guard);
            self.save(day);
        }
    }

    async fn say(&self, sid: &SessionId, text: &str) -> Result<AgentSendOutput, String> {
        self.agents
            .set_mode(sid, SessionMode::FullAccess)
            .map_err(|e| e.message)?;
        self.agents
            .send(sid, text, None, None)
            .await
            .map_err(|e| e.message)
    }

    async fn call(&self, tool: &str, input: Value) -> Result<Value, String> {
        let inv = self
            .invoker
            .get()
            .ok_or_else(|| "Tessera is still starting".to_owned())?;
        let r = inv
            .invoke(InvokeRequest::new(tool, input, Origin::User))
            .await;
        match (r.ok, r.output, r.error) {
            (true, Some(v), _) => Ok(v),
            (true, None, _) => Ok(Value::Null),
            (false, _, Some(e)) => Err(e.message),
            (false, _, None) => Err(format!("{tool} did not run")),
        }
    }

    async fn account(&self, id: &str) -> Result<Account, String> {
        let out = self.call("portfolio.get_accounts", json!({})).await?;
        let a = out["accounts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|a| a["account"]["id"] == id)
            .ok_or_else(|| format!("Account {id} is not connected"))?;
        Ok(Account {
            id: id.to_owned(),
            name: a["account"]["displayName"]
                .as_str()
                .unwrap_or(id)
                .to_owned(),
            environment: serde_json::from_value(a["account"]["environment"].clone())
                .map_err(|e| format!("account {id}: {e}"))?,
            limits: a
                .get("limits")
                .filter(|l| !l.is_null())
                .and_then(|l| serde_json::from_value(l.clone()).ok()),
        })
    }

    async fn study(&self, s: &SessionRunnerSetting, missing: &mut Missing) -> Option<StudyDetail> {
        let id = s
            .study_id
            .as_deref()
            .map(str::trim)
            .filter(|i| !i.is_empty())?;
        let detail = match self.call("research.get_study", json!({"id": id})).await {
            Ok(v) => serde_json::from_value::<StudyDetail>(v).ok(),
            Err(_) => None,
        };
        let Some(detail) = detail else {
            missing.needs("The study the sessions trade is no longer in Research: pick another, or trade without one");
            return None;
        };
        if detail.study.state == ExperimentState::Draft {
            missing.needs(format!(
                "Freeze the study {} in Research: a session trades a frozen study",
                detail.study.name
            ));
        }
        Some(detail)
    }

    async fn missing(&self, s: &SessionRunnerSetting) -> (Missing, Ready) {
        let mut missing = Missing::default();
        let provider = s.provider.as_deref().filter(|p| !p.trim().is_empty());
        match provider {
            None => missing.needs("Pick the model it runs on"),
            Some(p) => {
                let info = self.agents.providers_info(false).await;
                match info.providers.iter().find(|i| i.id == p) {
                    None => missing.needs(format!("{p} is not a provider Tessera knows")),
                    Some(i) if !i.enabled => {
                        missing
                            .waits_on(format!("Turn on {} in Settings › Analyst › Models", i.name));
                    }
                    Some(i) if i.status != tessera_core::health::HealthStatus::Ok => {
                        missing.waits_on(format!(
                            "{} is not ready: {}",
                            i.name,
                            i.message
                                .as_deref()
                                .unwrap_or("check it in Settings › Analyst › Models")
                        ));
                    }
                    Some(_) => {}
                }
            }
        }
        let account = match s.account_id.as_deref().filter(|a| !a.trim().is_empty()) {
            None => {
                missing.needs("Pick the account it trades");
                None
            }
            Some(id) => match self.account(id).await {
                Ok(a) => Some(a),
                Err(e) => {
                    missing.waits_on(e);
                    None
                }
            },
        };
        if let Some(a) = &account {
            for words in self.unguarded(a) {
                missing.needs(words);
            }
        }
        let study = self.study(s, &mut missing).await;
        let instructions = match read_instructions(instructions_path(s)).await {
            Ok(t) => Some(t),
            Err(_) if study.is_some() => None,
            Err(e) => {
                missing.needs(e);
                None
            }
        };
        (
            missing,
            Ready {
                account,
                instructions,
                study,
            },
        )
    }

    fn unguarded(&self, a: &Account) -> Vec<String> {
        let l = a.limits.as_ref();
        let mut need = Vec::new();
        if l.and_then(|l| l.daily_loss_limit.as_ref()).is_none() {
            need.push("a daily loss limit");
        }
        if l.and_then(|l| l.max_position_qty).is_none() {
            need.push("a max position");
        }
        if l.and_then(|l| l.max_risk_per_trade.as_ref()).is_none() {
            need.push("a max risk per trade");
        }
        let mut out = Vec::new();
        if !need.is_empty() {
            out.push(format!(
                "Set {} for {} in Settings › Trading and risk",
                need.join(", "),
                a.name
            ));
        }
        let firm_rules = self
            .settings
            .value("risk.limits")
            .is_some_and(|v| LimitsSetting::from_value(&v).use_firm_limits);
        if matches!(a.environment, Environment::Eval | Environment::Funded) && !firm_rules {
            out.push(
                "Turn on Use my firm’s limits in Settings › Trading and risk, so the firm's trailing drawdown holds its orders too"
                    .into(),
            );
        }
        out
    }

    pub async fn status(&self) -> TradingSessionStatus {
        let s = self.setting();
        let path = instructions_path(&s);
        let chars = read_instructions(path.clone())
            .await
            .ok()
            .and_then(|t| u32::try_from(t.chars().count()).ok());
        let (missing, _) = self.missing(&s).await;
        let now = self.clock.now();
        TradingSessionStatus {
            instructions_path: path.display().to_string(),
            instructions_chars: chars,
            missing: missing.words(),
            day: self.day.lock().as_ref().map(Day::view),
            next_start: s.enabled.then(|| next_open(now)).flatten(),
            setting: s,
        }
    }

    pub async fn start_now(&self) -> Result<TradingSessionStatus, ToolError> {
        {
            let _one = self.one.lock().await;
            let s = self.setting();
            if !s.enabled {
                return Err(ToolError::invalid_input(
                    "Trading sessions are off: turn them on first",
                ));
            }
            let now = self.clock.now();
            let h = startable(now).ok_or_else(|| {
                ToolError::invalid_input(
                    "The market is closed: a session starts while it is open, up to ten minutes before its next break",
                )
            })?;
            if self.day.lock().as_ref().is_some_and(|d| {
                d.is(&h) && matches!(d.phase, TradingPhase::Trading | TradingPhase::Closing)
            }) {
                return Err(ToolError::conflict("This session is already running"));
            }
            if let Err(why) = self.start(&s, h, now, false).await {
                return Err(ToolError::unavailable(why));
            }
        }
        Ok(self.status().await)
    }

    pub async fn tick(&self) {
        let _one = self.one.lock().await;
        let now = self.clock.now();
        let s = self.setting();
        let day = self.day.lock().clone();
        if let Some(d) =
            day.filter(|d| matches!(d.phase, TradingPhase::Trading | TradingPhase::Closing))
        {
            self.carry_on(d, &s, now).await;
            return;
        }
        if !s.enabled {
            return;
        }
        let Some(h) = startable(now) else {
            return;
        };
        if self.day.lock().as_ref().is_some_and(|d| d.is(&h)) {
            return;
        }
        if let Err(why) = self.start(&s, h, now, true).await {
            tracing::warn!(why, "the trading session did not start");
        }
    }

    async fn carry_on(&self, d: Day, s: &SessionRunnerSetting, now: Timestamp) {
        let Some(sid) = d.session_id.clone() else {
            return;
        };
        let h = d.hours();
        let answering = self.agents.answering(&sid);
        match d.phase {
            _ if now >= h.close && answering => {
                let _ = self.agents.interrupt(&sid).await;
                let mut d = d;
                d.note = Some(
                    "The analyst was still answering at the close: Tessera stopped it.".into(),
                );
                self.finish(d).await;
            }
            _ if now >= h.close => self.finish(d).await,
            TradingPhase::Trading if now >= h.wrap || !s.enabled => {
                let mut d = d;
                self.drop_queued_wakes(&sid, &mut d);
                if answering {
                    let from = *d.wrap_from.get_or_insert(now);
                    if now.0 >= from.0 + TURN_GRACE {
                        let _ = self.agents.interrupt(&sid).await;
                    }
                    self.save(d);
                    return;
                }
                let text = words::closing(now.min(h.close), h.close, &d.account());
                match self.say(&sid, &text).await {
                    Ok(_) => {
                        d.phase = TradingPhase::Closing;
                        d.closing_at = Some(now);
                        self.save(d);
                    }
                    Err(e) => {
                        d.trouble.push(runner_words(
                            "The close-out message did not reach the analyst",
                            &e,
                        ));
                        self.finish(d).await;
                    }
                }
            }
            TradingPhase::Trading => {
                self.resume_held_queue(&sid).await;
                self.ring(&sid, now).await;
                self.follow(&sid, now).await;
            }
            TradingPhase::Closing if !answering => self.finish(d).await,
            _ => {}
        }
    }

    async fn start(
        &self,
        s: &SessionRunnerSetting,
        h: Hours,
        now: Timestamp,
        patient: bool,
    ) -> Result<(), String> {
        let (missing, ready) = self.missing(s).await;
        let Ready {
            account,
            instructions,
            study,
        } = ready;
        let (Some(account), true) = (&account, missing.is_empty()) else {
            let why = missing.words().join(". ");
            if patient && missing.only_waits() && self.still_patient(&h, now) {
                return Err(why);
            }
            self.skip(h, s, account.as_ref(), &why).await;
            return Err(why);
        };
        let account = account.clone();
        let signal = match &study {
            None => None,
            Some(d) => match self.signal(&d.study.id).await {
                Ok(sig) => Some(sig),
                Err(e) => {
                    let why = format!("The study {}'s signal could not be read: {e}", d.study.name);
                    if !(patient && self.still_patient(&h, now)) {
                        self.skip(h, s, Some(&account), &why).await;
                    }
                    return Err(why);
                }
            },
        };
        let provider = s.provider.clone().unwrap_or_default();
        let title = format!("{} · {}", words::day_words(h.date), account.name);
        let session = self
            .agents
            .start_session(AgentStartSessionInput {
                preset: "Trader".into(),
                provider,
                model: s.model.clone().filter(|m| !m.trim().is_empty()),
                effort: s.effort.clone().filter(|e| !e.trim().is_empty()),
                mode: Some(SessionMode::FullAccess),
                title: Some(title),
            })
            .await;
        let session = match session {
            Ok(x) => x,
            Err(e) => {
                let why = format!("The analyst could not start: {}", e.message);
                self.skip(h, s, Some(&account), &why).await;
                return Err(why);
            }
        };
        let day = Day {
            date: h.date,
            phase: TradingPhase::Trading,
            account_id: account.id.clone(),
            account_name: account.name.clone(),
            environment: account.environment,
            opens_at: h.open,
            closes_at: h.close,
            session_id: Some(session.id.clone()),
            started_at: Some(now),
            closing_at: None,
            wrap_from: None,
            wakes: Vec::new(),
            alarms: Vec::new(),
            trouble: Vec::new(),
            note: None,
            study: study
                .as_ref()
                .zip(signal.as_ref())
                .map(|(d, sig)| Following {
                    id: d.study.id.clone(),
                    name: d.study.name.clone(),
                    manifest_hash: d.study.manifest_hash.clone(),
                    instrument: words::root(d.study.data.instrument.symbol()).to_owned(),
                    dropped: false,
                    position: sig.position,
                    next_at: sig.next_at.max(Timestamp(now.0 + SIGNAL_RETRY)),
                    failing: false,
                }),
        };
        self.save(day.clone());
        let path = instructions_path(s).display().to_string();
        let traded = study
            .as_ref()
            .zip(signal.as_ref())
            .map(|(d, signal)| words::Traded {
                study: &d.study,
                latest: d
                    .runs
                    .iter()
                    .find(|r| !r.exploratory && r.manifest_hash == d.study.manifest_hash),
                signal,
            });
        let text = words::opening(
            h.date,
            now,
            h.wrap,
            h.close,
            &account,
            instructions.as_deref().map(|t| (path.as_str(), t)),
            traded.as_ref(),
        );
        if let Err(e) = self.say(&session.id, &text).await {
            let mut d = day;
            d.trouble.push(runner_words(
                "The session's first message did not reach the analyst",
                &e,
            ));
            self.finish(d).await;
            return Err(e);
        }
        tracing::info!(session = %session.id, account = %account.name, "trading session started");
        Ok(())
    }

    fn still_patient(&self, h: &Hours, now: Timestamp) -> bool {
        let mut w = self.waiting.lock();
        let since = match *w {
            Some((open, since)) if open == h.open => since,
            _ => {
                *w = Some((h.open, now));
                now
            }
        };
        now.0 < since.0 + PATIENCE
    }

    async fn skip(&self, h: Hours, s: &SessionRunnerSetting, account: Option<&Account>, why: &str) {
        let id = s.account_id.clone().unwrap_or_default();
        let (name, environment) = account.map_or((id.clone(), Environment::Paper), |a| {
            (a.name.clone(), a.environment)
        });
        let day = Day {
            date: h.date,
            phase: TradingPhase::Skipped,
            account_id: id.clone(),
            account_name: name.clone(),
            environment,
            opens_at: h.open,
            closes_at: h.close,
            session_id: None,
            started_at: None,
            closing_at: None,
            wrap_from: None,
            wakes: Vec::new(),
            alarms: Vec::new(),
            trouble: Vec::new(),
            note: Some(why.to_owned()),
            study: None,
        };
        self.save(day);
        let now = self.clock.now();
        let mut report = TradingSessionReport {
            date: h.date.to_string(),
            account_id: id,
            account_name: name,
            environment,
            started_at: now,
            ended_at: now,
            trades: Vec::new(),
            net_pnl: 0.0,
            log: format!("The session did not start: {why}."),
            issues: vec![runner_words("The trading session did not start", why)],
        };
        self.file(&mut report, "none", s).await;
        self.write_journal(&report, &h).await;
    }

    async fn finish(&self, mut d: Day) {
        let now = self.clock.now();
        let s = self.setting();
        if let Err(e) = self
            .call("orders.flatten", json!({"accountId": d.account_id}))
            .await
        {
            d.trouble.push(runner_words(
                "Flattening the account at the close failed",
                &e,
            ));
        }
        if let Some(sid) = d.session_id.clone() {
            self.drop_queued_wakes(&sid, &mut d);
            self.pause_alerts(&sid, &mut d).await;
        }
        let trades = self.trades(&d).await;
        if let Some(f) = d.study.clone() {
            self.file_under_study(&f, &trades, &mut d).await;
        }
        let events = d
            .session_id
            .as_ref()
            .and_then(|sid| {
                self.store
                    .agent_events()
                    .list(sid.as_str(), 0, u32::MAX)
                    .ok()
            })
            .unwrap_or_default();
        let log = d
            .closing_at
            .and_then(|at| words::last_answer(&events, at))
            .unwrap_or_default();
        let mut issues = words::failures(&events);
        issues.extend(words::frictions(&log));
        issues.extend(d.trouble.iter().cloned());
        let mut body = words::log_body(&log);
        if body.is_empty() {
            body = "The analyst wrote no log.".into();
        }
        if let Some(n) = &d.note {
            body = format!("{body}\n\n{n}");
        }
        if let Some(f) = &d.study {
            body = format!("{}\n\n{body}", words::traded_line(&f.name));
        }
        let net = trades.iter().map(|t| t.net_pnl).sum();
        let mut report = TradingSessionReport {
            date: d.date.to_string(),
            account_id: d.account_id.clone(),
            account_name: d.account_name.clone(),
            environment: d.environment,
            started_at: d.started_at.unwrap_or(now),
            ended_at: now,
            trades,
            net_pnl: net,
            log: body,
            issues,
        };
        let session = d
            .session_id
            .as_ref()
            .map_or("none", SessionId::as_str)
            .to_owned();
        self.file(&mut report, &session, &s).await;
        if let Some(sid) = &d.session_id {
            let card = Card {
                id: format!("card-session-{}", sid.as_str()),
                body: CardBody::TradingSession(report.clone()),
                actions: vec![CardAction {
                    label: "Open the day in the journal".into(),
                    tool: "ui.show_area".into(),
                    input: json!({"area": "journal", "journal": {"section": "days", "date": report.date}}),
                    primary: false,
                }],
                updated_at: now,
            };
            if let Err(e) = self.agents.post_card(sid, card) {
                tracing::warn!(error = %e.message, "the session's report is not in its conversation");
            }
        }
        self.write_journal(&report, &d.hours()).await;
        if let Some(t) = self.telemetry.get() {
            t.trading_session_ended(report.issues.len());
        }
        d.phase = TradingPhase::Done;
        self.save(d);
        tracing::info!(
            session,
            trades = report.trades.len(),
            issues = report.issues.len(),
            "trading session reported"
        );
    }

    async fn signal(&self, id: &str) -> Result<StudySignal, String> {
        let v = self
            .call("research.study_signal", json!({"id": id}))
            .await?;
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    async fn study_changed(&self, f: &Following) -> bool {
        let Ok(v) = self.call("research.get_study", json!({"id": f.id})).await else {
            return false;
        };
        serde_json::from_value::<StudyDetail>(v)
            .is_ok_and(|d| d.study.manifest_hash != f.manifest_hash)
    }

    async fn follow(&self, sid: &SessionId, now: Timestamp) {
        let Some(f) = self
            .day
            .lock()
            .as_ref()
            .and_then(|d| d.study.clone())
            .filter(|f| !f.dropped && now >= f.next_at)
        else {
            return;
        };
        let read = match self.signal(&f.id).await {
            Ok(sig) if sig.manifest_hash != f.manifest_hash => Read::Changed,
            Ok(sig) => Read::Signal(sig),
            Err(_) if self.study_changed(&f).await => Read::Changed,
            Err(e) => Read::Failed(e),
        };
        let mut next = f.clone();
        match &read {
            Read::Changed => next.dropped = true,
            Read::Signal(sig) => {
                next.position = sig.position;
                next.next_at = sig.next_at.max(Timestamp(now.0 + SIGNAL_RETRY));
                next.failing = false;
            }
            Read::Failed(_) => {
                next.next_at = Timestamp(now.0 + SIGNAL_RETRY);
                next.failing = true;
            }
        }
        {
            let mut guard = self.day.lock();
            let Some(d) = guard.as_mut() else { return };
            d.study = Some(next);
            let day = d.clone();
            drop(guard);
            self.save(day);
        }
        let (text, failed) = match read {
            Read::Changed => (
                words::study_changed(&f.name),
                "The change of the study did not reach the analyst",
            ),
            Read::Signal(sig) if sig.position != f.position => (
                words::signal_changed(&sig, f.position),
                "A change of the study's signal did not reach the analyst",
            ),
            Read::Signal(_) => return,
            Read::Failed(e) => {
                if !f.failing {
                    self.trouble(runner_words("The study's signal could not be read", &e));
                }
                return;
            }
        };
        if let Err(e) = self.wake(sid.as_str(), &text).await {
            self.trouble(runner_words(failed, &e));
        }
    }

    async fn file_under_study(&self, f: &Following, trades: &[SessionTrade], d: &mut Day) {
        if trades.is_empty() {
            return;
        }
        let setup = match self.setup_of(f).await {
            Ok(id) => id,
            Err(e) => {
                d.trouble.push(runner_words(
                    "The session's trades could not be filed under the study's setup",
                    &e,
                ));
                return;
            }
        };
        let ids: Vec<&str> = trades
            .iter()
            .filter(|t| f.instrument.is_empty() || words::root(&t.symbol) == f.instrument)
            .map(|t| t.id.as_str())
            .collect();
        if ids.is_empty() {
            return;
        }
        if let Err(e) = self
            .call("journal.bulk_update", json!({"ids": ids, "setupId": setup}))
            .await
        {
            d.trouble.push(runner_words(
                "The session's trades could not be filed under the study's setup",
                &e,
            ));
        }
    }

    async fn setup_of(&self, f: &Following) -> Result<String, String> {
        let catalog = self.call("journal.get_catalog", json!({})).await?;
        let linked = catalog["setups"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["studyId"].as_str() == Some(f.id.as_str()))
            .and_then(|s| s["id"].as_str());
        if let Some(id) = linked {
            return Ok(id.to_owned());
        }
        let made = self
            .call(
                "journal.save_setup",
                json!({
                    "name": f.name,
                    "description": format!("The Research study {} ({}), traded by the analyst.", f.name, f.id),
                    "studyId": f.id,
                }),
            )
            .await?;
        made["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "journal.save_setup returned no id".to_owned())
    }

    async fn pause_alerts(&self, sid: &SessionId, d: &mut Day) {
        let Ok(list) = self.call("alerts.list", json!({"status": "active"})).await else {
            return;
        };
        for a in list["alerts"].as_array().into_iter().flatten() {
            if a["sessionId"].as_str() != Some(sid.as_str()) {
                continue;
            }
            let Some(id) = a["id"].as_str() else { continue };
            if let Err(e) = self.call("alerts.pause", json!({"id": id})).await {
                d.trouble.push(runner_words(
                    "An alert of the session could not be paused at the close",
                    &e,
                ));
            }
        }
    }

    async fn trades(&self, d: &Day) -> Vec<SessionTrade> {
        let since = d.started_at.unwrap_or(Timestamp(0));
        let input = json!({
            "filter": {"accounts": [d.account_id], "from": d.date.to_string(), "to": d.date.to_string()},
            "sort": "opened",
            "ascending": true,
            "limit": 500,
        });
        let mut trades = Vec::new();
        for attempt in 0..20 {
            let Ok(out) = self.call("journal.list_trades", input.clone()).await else {
                return Vec::new();
            };
            trades = out["trades"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| {
                    serde_json::from_value::<tessera_journal::model::JournalTrade>(t.clone()).ok()
                })
                .filter(|t| t.opened_at >= since)
                .collect::<Vec<_>>();
            let open = trades
                .iter()
                .any(|t| t.status == tessera_journal::model::TradeStatus::Open);
            if !open || attempt == 19 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        trades
            .into_iter()
            .map(|t| SessionTrade {
                id: t.id,
                symbol: t.symbol,
                side: t.side,
                qty: t.qty,
                entry_price: t.entry_price,
                exit_price: t.exit_price,
                price_decimals: t.price_decimals,
                net_pnl: t.net_pnl,
                r_multiple: t.r_multiple,
                opened_at: t.opened_at,
                closed_at: t.closed_at,
            })
            .collect()
    }

    async fn file(
        &self,
        report: &mut TradingSessionReport,
        session: &str,
        s: &SessionRunnerSetting,
    ) {
        let repo = s
            .issues_repo
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty());
        let issues = std::mem::take(&mut report.issues);
        let mut filed = Vec::with_capacity(issues.len());
        for mut i in issues {
            match repo {
                None => {
                    i.not_filed =
                        Some("no repository is set in Settings › Analyst › Trading sessions".into())
                }
                Some(repo) => {
                    let body = words::issue_body(&i, report, session);
                    match self.issues.file(repo, &words::issue_title(&i), &body).await {
                        Ok(url) => i.url = Some(url),
                        Err(e) => {
                            tracing::warn!(error = %e, "a session issue was not filed");
                            i.not_filed = Some(e);
                        }
                    }
                }
            }
            filed.push(i);
        }
        report.issues = filed;
    }

    async fn write_journal(&self, report: &TradingSessionReport, h: &Hours) {
        let date = report.date.clone();
        let content = match self.call("journal.get_day", json!({"date": date})).await {
            Ok(day) => day["content"].as_str().unwrap_or_default().to_owned(),
            Err(e) => {
                tracing::warn!(error = %e, "the journal's day could not be read");
                return;
            }
        };
        let later = stretches(h.date)
            .first()
            .is_some_and(|first| first.open != h.open);
        let heading = words::journal_heading(&report.account_name, later.then_some(h.open));
        let content = words::with_section(
            &content,
            &heading,
            &words::journal_section(&heading, report),
        );
        if let Err(e) = self
            .call(
                "journal.save_day",
                json!({"date": date, "content": content}),
            )
            .await
        {
            tracing::warn!(error = %e, "the session is not in the journal's day");
        }
    }
}

fn runner_words(title: &str, detail: &str) -> SessionIssue {
    words::runner_issue(title, detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn a_session_starts_at_the_sunday_reopen() {
        assert_eq!(startable(at("2026-10-25T17:59:00-04:00")), None);
        assert_eq!(
            next_open(at("2026-10-24T12:00:00-04:00")),
            Some(at("2026-10-25T18:00:00-04:00"))
        );
        let h = startable(at("2026-10-25T18:00:00-04:00")).unwrap();
        assert_eq!(h.date, day(2026, 10, 26));
        assert_eq!(h.open, at("2026-10-25T18:00:00-04:00"));
        assert_eq!(h.wrap, at("2026-10-26T16:50:00-04:00"));
        assert_eq!(h.close, at("2026-10-26T17:00:00-04:00"));
    }

    #[test]
    fn a_session_runs_across_midnight_and_wraps_before_the_daily_break() {
        let evening = startable(at("2026-10-26T18:00:00-04:00")).unwrap();
        assert_eq!(evening.date, day(2026, 10, 27));
        for t in [
            "2026-10-26T23:59:00-04:00",
            "2026-10-27T00:00:00-04:00",
            "2026-10-27T03:00:00-04:00",
            "2026-10-27T09:30:00-04:00",
            "2026-10-27T16:49:59-04:00",
        ] {
            assert_eq!(startable(at(t)), Some(evening), "{t}");
        }
        assert_eq!(evening.wrap, at("2026-10-27T16:50:00-04:00"));
        assert_eq!(evening.close, at("2026-10-27T17:00:00-04:00"));
        for t in ["2026-10-27T16:50:00-04:00", "2026-10-27T17:30:00-04:00"] {
            assert_eq!(startable(at(t)), None, "{t}");
            assert_eq!(
                next_open(at(t)),
                Some(at("2026-10-27T18:00:00-04:00")),
                "{t}"
            );
        }
        let now = at("2026-10-27T11:00:00-04:00");
        assert_eq!(next_open(now), Some(now));
    }

    #[test]
    fn the_weekend_is_skipped() {
        let friday = startable(at("2026-10-23T10:00:00-04:00")).unwrap();
        assert_eq!(friday.date, day(2026, 10, 23));
        assert_eq!(friday.close, at("2026-10-23T17:00:00-04:00"));
        for t in [
            "2026-10-23T16:55:00-04:00",
            "2026-10-23T18:30:00-04:00",
            "2026-10-24T12:00:00-04:00",
            "2026-10-25T12:00:00-04:00",
        ] {
            assert_eq!(startable(at(t)), None, "{t}");
            assert_eq!(
                next_open(at(t)),
                Some(at("2026-10-25T18:00:00-04:00")),
                "{t}"
            );
        }
    }

    #[test]
    fn holidays_and_early_closes_come_from_the_calendar() {
        let friday = stretches(day(2026, 11, 27));
        assert_eq!(
            friday,
            [
                Hours::new(
                    day(2026, 11, 27),
                    at("2026-11-25T18:00:00-05:00"),
                    at("2026-11-26T13:00:00-05:00"),
                ),
                Hours::new(
                    day(2026, 11, 27),
                    at("2026-11-26T18:00:00-05:00"),
                    at("2026-11-27T13:15:00-05:00"),
                ),
            ]
        );
        assert_eq!(friday[0].wrap, at("2026-11-26T12:50:00-05:00"));
        assert_eq!(friday[1].wrap, at("2026-11-27T13:05:00-05:00"));
        assert_eq!(startable(at("2026-11-26T08:00:00-05:00")), Some(friday[0]));
        assert_eq!(startable(at("2026-11-26T12:55:00-05:00")), None);
        assert_eq!(
            next_open(at("2026-11-26T12:55:00-05:00")),
            Some(at("2026-11-26T18:00:00-05:00"))
        );
        assert_eq!(startable(at("2026-11-27T09:00:00-05:00")), Some(friday[1]));
        assert_eq!(
            next_open(at("2026-11-27T13:10:00-05:00")),
            Some(at("2026-11-29T18:00:00-05:00"))
        );
        assert_eq!(stretches(day(2026, 12, 25)), []);
        assert_eq!(
            next_open(at("2026-12-24T13:10:00-05:00")),
            Some(at("2026-12-27T18:00:00-05:00"))
        );
    }
}
