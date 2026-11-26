use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine as _;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_broker::BrokerModule;
use tessera_broker::protect::ProtectionMode;
use tessera_cloud::{
    CloudError, FeedbackContextItem, FeedbackReport, FeedbackScreenshot, FiledIssue,
};
use tessera_core::accounts::Environment;
use tessera_core::ids::OrderId;
use tessera_core::limits::LockKind;
use tessera_core::{Origin, SharedClock};
use tessera_host::{ModuleHost, RuntimeModule, TsExports};
use tessera_protocol::tools::{RiskTier, ToolCallRecord, ToolCallStatus};
use tessera_store::Store;
use tessera_tools::{RateLimit, RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use tokio::task::JoinHandle;
use ts_rs::TS;

use crate::modules::account::AccountService;

pub mod errors;
mod outbox;
mod redact;

pub use errors::RecentErrors;
pub use outbox::{Outbox, Queued};
pub use redact::Scrubber;

const EVENTS_KEPT: usize = 50;

const EVENTS_SCANNED: u32 = 600;

const ERRORS_KEPT: usize = 30;

const SEND_WAIT: Duration = Duration::from_secs(20);

const WRITE_UP_WAIT: Duration = Duration::from_secs(120);

const DELIVERY_TICK: Duration = Duration::from_secs(15);

const MAX_SCREENSHOT_BYTES: usize = 8 * 1024 * 1024;

const MAX_TEXT: usize = 8_000;
const MAX_TITLE: usize = 200;
const MAX_STEPS: usize = 20;
const MAX_STEP: usize = 500;
const MAX_LONG: usize = 2_000;
const MAX_ITEMS: usize = 20;
const MAX_LABEL: usize = 60;
const MAX_VALUE: usize = 500;
const MAX_DETAIL: usize = 40_000;

/// What a report is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackKind {
    /// Something does not work.
    Bug,
    /// Something to add or change.
    Idea,
    /// Anything else.
    Other,
}

impl FeedbackKind {
    fn as_str(self) -> &'static str {
        match self {
            FeedbackKind::Bug => "bug",
            FeedbackKind::Idea => "idea",
            FeedbackKind::Other => "other",
        }
    }
}

/// One fact attached to a report, shown to the user before it is sent; each can be removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackItem {
    /// Stable key (`app`, `system`, `broker`, `account`, `protect`, `chart`, `orders`, `errors`).
    pub key: String,
    /// What the window calls it.
    pub label: String,
    /// The fact in a line.
    pub value: String,
    /// The long form (event lines, error lines), or null.
    #[serde(default)]
    pub detail: Option<String>,
}

/// Where a report goes from here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackDelivery {
    /// Signed in to Tessera Cloud: sent now, or queued while Cloud is out of reach.
    Cloud,
    /// Accounts are on but nobody is signed in: kept until a sign-in.
    SignedOut,
    /// This build has no Tessera Cloud: kept on this computer only.
    Off,
}

/// The window that asks, as it knows itself.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackApp {
    /// The app's version (`0.2.0`).
    pub version: String,
    /// The commit the window was built from, short, or null.
    #[serde(default)]
    pub commit: Option<String>,
    /// `desktop` (the Tauri app) or `browser`.
    #[serde(default)]
    pub shell: Option<String>,
}

/// `feedback.context` input: what the window shows now.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackContextInput {
    /// The window's own build.
    #[serde(default)]
    pub app: FeedbackApp,
    /// The focused chart's instrument, or null.
    #[serde(default)]
    pub instrument: Option<String>,
    /// The focused chart's timeframe (`5m`), or null.
    #[serde(default)]
    pub timeframe: Option<String>,
    /// The account the focused chart trades, or null for the first account.
    #[serde(default)]
    pub account_id: Option<String>,
}

/// The user's own agent, ready to write a report up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackWriter {
    /// Provider id (`codex`, `claude-code`).
    pub provider: String,
    /// Its name.
    pub name: String,
}

/// `feedback.context` output: the facts a report would carry, already redacted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackContextOutput {
    /// The facts, in order.
    pub items: Vec<FeedbackItem>,
    /// Where a report goes.
    pub delivery: FeedbackDelivery,
    /// The agent that can write it up, or null when none is connected.
    pub writer: Option<FeedbackWriter>,
    /// Reports still waiting to go.
    pub queued: u32,
}

/// A picture of the window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackScreenshotInput {
    /// `image/png` or `image/jpeg`.
    #[serde(rename = "type")]
    pub mime_type: String,
    /// The image, base64.
    pub data: String,
}

/// `feedback.send` input: a report as the user wrote it and the facts they kept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackSendInput {
    /// What it is about.
    pub kind: FeedbackKind,
    /// A title, or null to take the first line of the text.
    #[serde(default)]
    pub title: Option<String>,
    /// The user's own words (up to 8000 characters).
    pub text: String,
    /// Steps to reproduce.
    #[serde(default)]
    pub steps: Vec<String>,
    /// What should have happened.
    #[serde(default)]
    pub expected: Option<String>,
    /// What happened.
    #[serde(default)]
    pub actual: Option<String>,
    /// The title, steps, expected and actual came from the user's agent (feedback.write_up).
    #[serde(default)]
    pub written_up: bool,
    /// The facts the user kept (from feedback.context); redacted again before they go.
    #[serde(default)]
    pub context: Vec<FeedbackItem>,
    /// The window's picture, when the user attached it.
    #[serde(default)]
    pub screenshot: Option<FeedbackScreenshotInput>,
    /// The window's build.
    #[serde(default)]
    pub app: FeedbackApp,
}

/// Whether a report went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackStatus {
    /// Filed with the Tessera team.
    Sent,
    /// Kept on this computer; it goes by itself once Tessera Cloud can take it.
    Queued,
}

/// The issue a report became.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackIssue {
    /// Its number.
    #[ts(type = "number")]
    pub number: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSendOutput {
    /// The report's id (`fb-…`), the same in the team's issue.
    pub id: String,
    /// Sent or queued.
    pub status: FeedbackStatus,
    /// The issue, once sent.
    pub issue: Option<FeedbackIssue>,
    /// Where it goes.
    pub delivery: FeedbackDelivery,
    /// Why it is queued, in a line, or null.
    pub reason: Option<String>,
}

/// `feedback.write_up` input: the user's note and the facts they kept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackWriteUpInput {
    /// What it is about.
    pub kind: FeedbackKind,
    /// The user's note.
    pub text: String,
    /// The facts the user kept.
    #[serde(default)]
    pub context: Vec<FeedbackItem>,
}

/// `feedback.write_up` output: a draft the user edits before sending.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackWriteUpOutput {
    /// A title.
    pub title: String,
    /// Steps to reproduce.
    pub steps: Vec<String>,
    /// What should have happened.
    pub expected: String,
    /// What happened.
    pub actual: String,
    /// The agent that wrote it.
    pub writer: FeedbackWriter,
}

#[async_trait]
pub trait FeedbackSink: Send + Sync + 'static {
    fn delivery(&self) -> FeedbackDelivery;

    async fn file(&self, report: &FeedbackReport) -> Result<FiledIssue, CloudError>;
}

pub struct CloudSink(pub Arc<AccountService>);

#[async_trait]
impl FeedbackSink for CloudSink {
    fn delivery(&self) -> FeedbackDelivery {
        if !self.0.enabled() {
            FeedbackDelivery::Off
        } else if self.0.signed_in() {
            FeedbackDelivery::Cloud
        } else {
            FeedbackDelivery::SignedOut
        }
    }

    async fn file(&self, report: &FeedbackReport) -> Result<FiledIssue, CloudError> {
        self.0.file_feedback(report).await
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteUpPick {
    pub writer: FeedbackWriter,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[async_trait]
pub trait WriteUpAgent: Send + Sync + 'static {
    fn picks(&self) -> Vec<WriteUpPick>;

    async fn answer(
        &self,
        pick: &WriteUpPick,
        instructions: &str,
        text: String,
    ) -> Result<String, ToolError>;
}

#[async_trait]
impl WriteUpAgent for tessera_agent::AgentService {
    fn picks(&self) -> Vec<WriteUpPick> {
        let providers = self.providers();
        self.working_picks()
            .into_iter()
            .map(|p| {
                let name = providers
                    .iter()
                    .find(|x| x.id() == p.provider)
                    .map_or_else(|| p.provider.clone(), |x| x.name().to_owned());
                WriteUpPick {
                    writer: FeedbackWriter {
                        provider: p.provider,
                        name,
                    },
                    model: p.model,
                    effort: p.effort,
                }
            })
            .collect()
    }

    async fn answer(
        &self,
        pick: &WriteUpPick,
        instructions: &str,
        text: String,
    ) -> Result<String, ToolError> {
        let pick = tessera_agent::ModelPick {
            provider: pick.writer.provider.clone(),
            model: pick.model.clone(),
            effort: pick.effort.clone(),
        };
        self.answer_once(&pick, instructions, text, WRITE_UP_WAIT)
            .await
            .map(|a| a.text)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockFact {
    pub kind: LockKind,
    pub until: tessera_core::Timestamp,
}

pub fn lock_words(lock: LockFact) -> String {
    let until = lock.until.to_datetime().format("%Y-%m-%d %H:%MZ");
    match lock.kind {
        LockKind::DailyLoss => {
            format!("Daily loss limit reached: entries refused until {until}; exits work")
        }
        LockKind::Manual => format!(
            "Locked by the trader: entries refused until {until}; exits, stops and targets work"
        ),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    pub app: FeedbackApp,
    pub system: String,
    pub broker: Option<String>,
    pub account: Option<Environment>,
    pub protect: Option<ProtectionMode>,
    pub lock: Option<LockFact>,
    pub instrument: Option<String>,
    pub timeframe: Option<String>,
    pub private: Vec<String>,
}

pub fn broker_words(broker_id: &str) -> String {
    let id = broker_id.to_ascii_lowercase();
    if id.contains("paper") {
        "Paper".into()
    } else if id.starts_with("rithmic") {
        "Rithmic".into()
    } else if id.starts_with("mock") || id.contains("fake") {
        "Test connection".into()
    } else {
        "Other".into()
    }
}

pub fn account_words(e: Environment) -> &'static str {
    match e {
        Environment::Paper => "Paper",
        Environment::Sim => "Broker simulation",
        Environment::Eval => "Evaluation",
        Environment::Funded => "Funded",
        Environment::Live => "Live",
    }
}

fn protect_words(m: ProtectionMode) -> &'static str {
    match m {
        ProtectionMode::PerEntry => "Per entry: each entry keeps its own stop and target",
        ProtectionMode::Grow => "Grow: one stop and one target for the whole position",
    }
}

fn root(s: &str) -> String {
    s.split(['.', ' ', ':'])
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase()
}

fn is_month(rest: &str) -> bool {
    let mut c = rest.chars();
    matches!(
        c.next(),
        Some('F' | 'G' | 'H' | 'J' | 'K' | 'M' | 'N' | 'Q' | 'U' | 'V' | 'X' | 'Z')
    ) && {
        let digits: String = c.collect();
        (1..=2).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
    }
}

pub fn same_market(a: &str, b: &str) -> bool {
    let (a, b) = (root(a), root(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let (long, short) = if a.len() > b.len() { (a, b) } else { (b, a) };
    long.strip_prefix(short.as_str()).is_some_and(is_month)
}

fn who(o: &Origin) -> &'static str {
    match o {
        Origin::User => "trader",
        Origin::Agent { .. } => "analyst",
        Origin::External { .. } => "mcp client",
    }
}

fn status_word(s: ToolCallStatus) -> String {
    match serde_json::to_value(s) {
        Ok(Value::String(w)) => w,
        _ => "unknown".into(),
    }
}

fn text_of(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(true) => Some(key.to_owned()),
        _ => None,
    }
}

pub fn instrument_of(r: &ToolCallRecord, order: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    text_of(&r.input, "instrument")
        .or_else(|| text_of(&r.input, "orderId").and_then(|id| order(&id)))
}

pub fn event_line(r: &ToolCallRecord, instrument: Option<&str>) -> String {
    let mut words = vec![
        r.started_at
            .to_datetime()
            .format("%Y-%m-%d %H:%M:%S%.3fZ")
            .to_string(),
        r.tool.clone(),
        who(&r.origin).to_owned(),
        status_word(r.status),
    ];
    for key in [
        "side",
        "qty",
        "orderType",
        "limitPrice",
        "stopPrice",
        "tif",
        "reduceOnly",
        "mode",
    ] {
        if let Some(v) = text_of(&r.input, key) {
            words.push(match key.strip_suffix("Price") {
                Some(kind) => format!("{kind}={v}"),
                None => v,
            });
        }
    }
    if let Some(steps) = r.input.get("steps").and_then(Value::as_array) {
        words.push(format!("{} steps", steps.len()));
    }
    if let Some(i) = instrument {
        words.push(i.to_owned());
    }
    let mut line = words.join("  ");
    if let Some(s) = r.summary.as_deref().filter(|s| !s.is_empty()) {
        line.push_str(" — ");
        line.push_str(s);
    }
    if let Some(e) = &r.error {
        line.push_str(&format!(" — refused: {}", e.message));
    }
    line
}

pub fn order_events(
    records: &[ToolCallRecord],
    focus: Option<&str>,
    order: &dyn Fn(&str) -> Option<String>,
) -> Vec<String> {
    let mut lines: Vec<String> = records
        .iter()
        .filter(|r| r.status != ToolCallStatus::PendingApproval)
        .filter_map(|r| {
            let inst = instrument_of(r, order);
            match (focus, inst.as_deref()) {
                (Some(f), Some(i)) if same_market(f, i) => Some(event_line(r, Some(i))),
                (Some(_), _) => None,
                (None, i) => Some(event_line(r, i)),
            }
        })
        .take(EVENTS_KEPT)
        .collect();
    lines.reverse();
    lines
}

fn item(key: &str, label: &str, value: impl Into<String>, detail: Option<String>) -> FeedbackItem {
    FeedbackItem {
        key: key.into(),
        label: label.into(),
        value: value.into(),
        detail,
    }
}

pub fn items(facts: &Facts, events: &[String], errors: &[String]) -> Vec<FeedbackItem> {
    let app = &facts.app;
    let mut build = format!(
        "Tessera {}",
        if app.version.is_empty() {
            crate::VERSION
        } else {
            &app.version
        }
    );
    if let Some(c) = app.commit.as_deref().filter(|c| !c.is_empty()) {
        build.push_str(&format!(" ({c})"));
    }
    if !app.version.is_empty() && app.version != crate::VERSION {
        build.push_str(&format!(" · runtime {}", crate::VERSION));
    }
    let mut system = facts.system.clone();
    if let Some(shell) = app.shell.as_deref() {
        system.push_str(match shell {
            "desktop" => " · desktop app",
            "browser" => " · browser",
            _ => "",
        });
    }
    let mut out = vec![
        item("app", "App", build, None),
        item("system", "System", system, None),
    ];
    if let Some(b) = &facts.broker {
        out.push(item("broker", "Broker", b.clone(), None));
    }
    if let Some(a) = facts.account {
        out.push(item("account", "Account kind", account_words(a), None));
    }
    if let Some(m) = facts.protect {
        out.push(item("protect", "Protect mode", protect_words(m), None));
    }
    if let Some(l) = facts.lock {
        out.push(item("lock", "Trading lock", lock_words(l), None));
    }
    if let Some(i) = &facts.instrument {
        let chart = match &facts.timeframe {
            Some(tf) => format!("{i} · {tf}"),
            None => i.clone(),
        };
        out.push(item("chart", "Chart", chart, None));
    }
    let scope = facts
        .instrument
        .as_deref()
        .map_or_else(String::new, |i| format!(" on {i}"));
    out.push(item(
        "orders",
        "Order and protect events",
        match events.len() {
            0 => format!("None{scope}"),
            1 => format!("The last one{scope}"),
            n => format!("The last {n}{scope}"),
        },
        (!events.is_empty()).then(|| events.join("\n")),
    ));
    out.push(item(
        "errors",
        "Runtime errors",
        match errors.len() {
            0 => "None since Tessera started".to_owned(),
            1 => "1 since Tessera started".to_owned(),
            n => format!("The last {n} since Tessera started"),
        },
        (!errors.is_empty()).then(|| errors.join("\n")),
    ));
    out
}

fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn clean_item(i: &FeedbackItem, s: &Scrubber) -> Option<FeedbackItem> {
    let key = i.key.trim().to_ascii_lowercase();
    let ok = key.len() <= 40
        && key.starts_with(|c: char| c.is_ascii_lowercase())
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.'));
    ok.then(|| FeedbackItem {
        key,
        label: clip(&s.scrub(&i.label), MAX_LABEL),
        value: clip(&s.scrub(&i.value), MAX_VALUE),
        detail: i
            .detail
            .as_deref()
            .map(|d| clip(&s.scrub(d), MAX_DETAIL))
            .filter(|d| !d.is_empty()),
    })
}

pub fn report_id() -> String {
    let hex = uuid::Uuid::now_v7().simple().to_string();
    format!("fb-{}", &hex[hex.len() - 12..])
}

fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    clip(line, 80)
}

pub fn build_report(
    input: &FeedbackSendInput,
    id: String,
    created_at: String,
    s: &Scrubber,
) -> Result<FeedbackReport, ToolError> {
    let text = s.scrub(input.text.trim());
    if text.chars().count() > MAX_TEXT {
        return Err(ToolError::invalid_input(
            "the report is longer than 8000 characters",
        ));
    }
    let title = input
        .title
        .as_deref()
        .map(|t| clip(&s.scrub(t), MAX_TITLE))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| first_line(&text));
    if title.is_empty() {
        return Err(ToolError::invalid_input("the report is empty"));
    }
    let screenshot = match &input.screenshot {
        None => None,
        Some(shot) => {
            if !matches!(shot.mime_type.as_str(), "image/png" | "image/jpeg") {
                return Err(ToolError::invalid_input(
                    "the screenshot is not a PNG or JPEG",
                ));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(shot.data.as_bytes())
                .map_err(|_| ToolError::invalid_input("the screenshot is not base64"))?;
            if bytes.len() > MAX_SCREENSHOT_BYTES {
                return Err(ToolError::invalid_input(
                    "the screenshot is larger than 8 MB",
                ));
            }
            Some(FeedbackScreenshot {
                mime_type: shot.mime_type.clone(),
                data: shot.data.clone(),
            })
        }
    };
    let long = |v: &Option<String>| {
        v.as_deref()
            .map(|t| clip(&s.scrub(t), MAX_LONG))
            .filter(|t| !t.is_empty())
    };
    Ok(FeedbackReport {
        id,
        kind: input.kind.as_str().to_owned(),
        title,
        text,
        steps: input
            .steps
            .iter()
            .map(|t| clip(&s.scrub(t), MAX_STEP))
            .filter(|t| !t.is_empty())
            .take(MAX_STEPS)
            .collect(),
        expected: long(&input.expected),
        actual: long(&input.actual),
        written_up: input.written_up,
        context: input
            .context
            .iter()
            .filter_map(|i| clean_item(i, s))
            .take(MAX_ITEMS)
            .map(|i| FeedbackContextItem {
                key: i.key,
                label: i.label,
                value: i.value,
                detail: i.detail,
            })
            .collect(),
        screenshot,
        app_version: clip(
            if input.app.version.is_empty() {
                crate::VERSION
            } else {
                &input.app.version
            },
            64,
        ),
        created_at,
    })
}

const WRITE_UP_INSTRUCTIONS: &str = "You write up a trader's feedback about Tessera, a trading app, for its team. \
You get the trader's note and facts Tessera attached (its version, the account kind, the protect mode, the focused \
chart, the latest order and protect events, recent runtime errors). Do not call any tool. Use only the note and the \
facts; do not invent events, prices or numbers, and never write account numbers, names, hosts or credentials. Answer \
with one JSON object and nothing else: {\"title\": a short title (under 80 characters), \"steps\": an array of short \
steps to reproduce, \"expected\": what the trader expected, \"actual\": what happened}. For an idea, steps are how the \
trader would use it, expected is what they want and actual is what Tessera does today. Write plainly, in the \
trader's language.";

pub fn write_up_prompt(input: &FeedbackWriteUpInput, s: &Scrubber) -> String {
    let mut out = format!(
        "Kind: {}\n\nThe trader's note:\n{}\n\nFacts Tessera attached:\n",
        input.kind.as_str(),
        s.scrub(input.text.trim())
    );
    for i in input.context.iter().filter_map(|i| clean_item(i, s)) {
        out.push_str(&format!("- {}: {}\n", i.label, i.value));
        if let Some(d) = i.detail {
            let d: String = d.chars().take(6_000).collect();
            out.push_str(&format!("```text\n{d}\n```\n"));
        }
    }
    out
}

#[derive(Deserialize)]
struct Drafted {
    #[serde(default)]
    title: String,
    #[serde(default)]
    steps: Vec<Value>,
    #[serde(default)]
    expected: Value,
    #[serde(default)]
    actual: Value,
}

fn words_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Array(a) => a.iter().map(words_of).collect::<Vec<_>>().join(" "),
        other => other.to_string(),
    }
}

pub fn read_write_up(answer: &str, s: &Scrubber) -> Option<(String, Vec<String>, String, String)> {
    let start = answer.find('{')?;
    let end = answer.rfind('}')?;
    let d: Drafted = serde_json::from_str(answer.get(start..=end)?).ok()?;
    let title = clip(&s.scrub(&d.title), MAX_TITLE);
    if title.is_empty() {
        return None;
    }
    let steps = d
        .steps
        .iter()
        .map(|v| clip(&s.scrub(&words_of(v)), MAX_STEP))
        .filter(|t| !t.is_empty())
        .take(MAX_STEPS)
        .collect();
    Some((
        title,
        steps,
        clip(&s.scrub(&words_of(&d.expected)), MAX_LONG),
        clip(&s.scrub(&words_of(&d.actual)), MAX_LONG),
    ))
}

fn os_words() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let release = os_release().map(|r| format!(" {r}")).unwrap_or_default();
    format!("{os}{release} · {}", std::env::consts::ARCH)
}

fn os_release() -> Option<String> {
    if cfg!(target_os = "linux") {
        let text = std::fs::read_to_string("/etc/os-release").ok()?;
        text.lines()
            .find_map(|l| l.strip_prefix("PRETTY_NAME="))
            .map(|v| v.trim_matches('"').to_owned())
    } else if cfg!(target_os = "macos") {
        let out = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|v| !v.is_empty())
    } else {
        None
    }
}

#[derive(Clone)]
pub struct Trading {
    pub broker: Arc<BrokerModule>,
}

impl Trading {
    async fn facts(&self, input: &FeedbackContextInput) -> Facts {
        let service = self.broker.service();
        let accounts = service.accounts().await.unwrap_or_default();
        let mut private = Vec::new();
        for a in accounts
            .iter()
            .filter(|a| a.account.environment != Environment::Paper)
        {
            let acc = &a.account;
            private.push(acc.id.to_string());
            private.push(acc.display_name.clone());
            if let Some((_, native)) = acc.id.as_str().split_once(':') {
                private.push(native.to_owned());
            }
            if let Some(m) = &acc.external_ref_masked {
                private.push(m.clone());
            }
        }
        let focused = input
            .account_id
            .as_deref()
            .and_then(|id| accounts.iter().find(|a| a.account.id.as_str() == id))
            .or_else(|| accounts.first());
        let lock = focused
            .and_then(|a| service.lock_of(&a.account.id))
            .map(|l| LockFact {
                kind: l.kind(),
                until: l.until,
            });
        Facts {
            app: input.app.clone(),
            system: os_words(),
            broker: focused.map(|a| broker_words(a.account.broker_id.as_str())),
            account: focused.map(|a| a.account.environment),
            protect: Some(self.broker.protection().mode()),
            lock,
            instrument: input.instrument.clone().filter(|i| !i.trim().is_empty()),
            timeframe: input.timeframe.clone().filter(|t| !t.trim().is_empty()),
            private,
        }
    }

    fn order_instrument(&self, id: &str) -> Option<String> {
        self.broker
            .service()
            .order(&OrderId::new(id))
            .map(|o| o.request.instrument.to_string())
    }
}

pub struct FeedbackService {
    outbox: Outbox,
    sink: Arc<dyn FeedbackSink>,
    agent: Option<Arc<dyn WriteUpAgent>>,
    trading: Option<Trading>,
    store: Store,
    clock: SharedClock,
    delivering: tokio::sync::Mutex<()>,
    private: parking_lot::Mutex<Vec<String>>,
}

impl std::fmt::Debug for FeedbackService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FeedbackService")
            .field("outbox", &self.outbox)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Attempt {
    Sent(FiledIssue),
    Waiting(String),
    Refused(String),
}

impl FeedbackService {
    pub fn new(
        dir: Option<std::path::PathBuf>,
        sink: Arc<dyn FeedbackSink>,
        agent: Option<Arc<dyn WriteUpAgent>>,
        trading: Option<Trading>,
        store: Store,
        clock: SharedClock,
    ) -> Arc<Self> {
        Arc::new(Self {
            outbox: Outbox::open(dir),
            sink,
            agent,
            trading,
            store,
            clock,
            delivering: tokio::sync::Mutex::new(()),
            private: parking_lot::Mutex::new(Vec::new()),
        })
    }

    fn scrubber(&self) -> Scrubber {
        Scrubber::new(self.private.lock().clone())
    }

    fn remember_private(&self, words: Vec<String>) {
        let mut p = self.private.lock();
        for w in words {
            if !p.contains(&w) {
                p.push(w);
            }
        }
    }

    pub fn outbox(&self) -> &Outbox {
        &self.outbox
    }

    pub async fn context(&self, input: &FeedbackContextInput) -> FeedbackContextOutput {
        let facts = match &self.trading {
            Some(t) => t.facts(input).await,
            None => Facts {
                app: input.app.clone(),
                system: os_words(),
                instrument: input.instrument.clone(),
                timeframe: input.timeframe.clone(),
                ..Facts::default()
            },
        };
        self.remember_private(facts.private.clone());
        if let Some(a) = input.account_id.clone() {
            self.remember_private(vec![a]);
        }
        let records = self
            .store
            .tool_calls()
            .recent_of(&tessera_journal::activity::ORDER_TOOLS, EVENTS_SCANNED)
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "the order events could not be read for a report");
                Vec::new()
            });
        let trading = self.trading.clone();
        let order = move |id: &str| trading.as_ref().and_then(|t| t.order_instrument(id));
        let events = order_events(&records, facts.instrument.as_deref(), &order);
        let errors: Vec<String> = errors::recent(ERRORS_KEPT)
            .iter()
            .map(errors::RecentError::line)
            .collect();
        let s = self.scrubber();
        let items = items(&facts, &events, &errors)
            .iter()
            .filter_map(|i| clean_item(i, &s))
            .collect();
        FeedbackContextOutput {
            items,
            delivery: self.sink.delivery(),
            writer: self
                .agent
                .as_ref()
                .and_then(|a| a.picks().into_iter().next())
                .map(|p| p.writer),
            queued: u32::try_from(self.outbox.list().len()).unwrap_or(u32::MAX),
        }
    }

    pub async fn send(
        self: &Arc<Self>,
        input: &FeedbackSendInput,
    ) -> Result<FeedbackSendOutput, ToolError> {
        let report = build_report(
            input,
            report_id(),
            self.clock.now().to_rfc3339(),
            &self.scrubber(),
        )?;
        let id = report.id.clone();
        self.outbox
            .put(report)
            .map_err(|e| ToolError::internal(format!("the report could not be kept: {e}")))?;
        tracing::info!(report = %id, "feedback report queued");
        let me = Arc::clone(self);
        let one = id.clone();
        let attempt = tokio::spawn(async move { me.deliver_one(&one).await });
        let delivery = self.sink.delivery();
        let waited = tokio::time::timeout(SEND_WAIT, attempt).await;
        let (status, issue, reason) = match waited {
            Ok(Ok(Attempt::Sent(issue))) => (
                FeedbackStatus::Sent,
                Some(FeedbackIssue {
                    number: issue.number,
                }),
                None,
            ),
            Ok(Ok(Attempt::Refused(why))) => {
                return Err(ToolError::rejected(format!(
                    "Tessera Cloud refused the report ({why}); it is kept on this computer"
                )));
            }
            Ok(Ok(Attempt::Waiting(why))) => (FeedbackStatus::Queued, None, Some(why)),
            Ok(Err(_)) | Err(_) => (
                FeedbackStatus::Queued,
                None,
                Some("Tessera Cloud is slow to answer; it keeps trying".to_owned()),
            ),
        };
        Ok(FeedbackSendOutput {
            id,
            status,
            issue,
            delivery,
            reason,
        })
    }

    fn waiting_words(&self) -> Option<String> {
        match self.sink.delivery() {
            FeedbackDelivery::Cloud => None,
            FeedbackDelivery::SignedOut => {
                Some("Not signed in to Tessera: it goes once you sign in".to_owned())
            }
            FeedbackDelivery::Off => {
                Some("This build has no Tessera Cloud: it stays on this computer".to_owned())
            }
        }
    }

    async fn deliver_one(&self, id: &str) -> Attempt {
        if let Some(why) = self.waiting_words() {
            return Attempt::Waiting(why);
        }
        let _one_at_a_time = self.delivering.lock().await;
        let Some(q) = self.outbox.get(id) else {
            return Attempt::Waiting("already sent".to_owned());
        };
        self.attempt(&q).await
    }

    async fn attempt(&self, q: &Queued) -> Attempt {
        let id = q.report.id.as_str();
        match self.sink.file(&q.report).await {
            Ok(issue) => {
                tracing::info!(report = %id, issue = issue.number, "feedback report filed");
                self.outbox.sent(id);
                Attempt::Sent(issue)
            }
            Err(e) if e.is_final() => {
                let why = e.to_string();
                self.outbox.refused(id, &why);
                Attempt::Refused(why)
            }
            Err(e) => {
                let why = if e.needs_sign_in() {
                    "Not signed in to Tessera: it goes once you sign in".to_owned()
                } else if e.is_unreachable() {
                    "Tessera Cloud can’t be reached: it goes once it can".to_owned()
                } else {
                    format!("{e}: it is tried again")
                };
                tracing::info!(report = %id, error = %e, "feedback report not sent yet");
                self.outbox.failed(id, e.to_string(), Instant::now());
                Attempt::Waiting(why)
            }
        }
    }

    pub async fn deliver_due(&self) -> usize {
        if self.waiting_words().is_some() {
            return 0;
        }
        let _one_at_a_time = self.delivering.lock().await;
        let mut sent = 0;
        for q in self.outbox.due(Instant::now()) {
            match self.attempt(&q).await {
                Attempt::Sent(_) => sent += 1,
                Attempt::Waiting(_) => break,
                Attempt::Refused(_) => {}
            }
        }
        sent
    }

    pub fn queued(&self) -> Vec<FeedbackQueued> {
        self.outbox
            .list()
            .into_iter()
            .map(|q| FeedbackQueued {
                id: q.report.id,
                kind: q.report.kind,
                title: q.report.title,
                created_at: q.report.created_at,
                attempts: q.attempts,
                last_error: q.last_error,
            })
            .collect()
    }

    pub async fn write_up(
        &self,
        input: &FeedbackWriteUpInput,
    ) -> Result<FeedbackWriteUpOutput, ToolError> {
        let no_agent = || {
            ToolError::unavailable(
                "no agent is connected: the user connects one in Settings › Analyst",
            )
        };
        let agent = self.agent.as_ref().ok_or_else(no_agent)?;
        let picks = agent.picks();
        if picks.is_empty() {
            return Err(no_agent());
        }
        if input.text.trim().is_empty() {
            return Err(ToolError::invalid_input("write a note first"));
        }
        let s = self.scrubber();
        let prompt = write_up_prompt(input, &s);
        let mut failure = no_agent();
        for pick in picks {
            let read = match agent
                .answer(&pick, WRITE_UP_INSTRUCTIONS, prompt.clone())
                .await
            {
                Ok(answer) => read_write_up(&answer, &s).ok_or_else(|| {
                    ToolError::unavailable(format!(
                        "{} answered something that is not a write-up",
                        pick.writer.name
                    ))
                }),
                Err(e) => Err(e),
            };
            match read {
                Ok((title, steps, expected, actual)) => {
                    return Ok(FeedbackWriteUpOutput {
                        title,
                        steps,
                        expected,
                        actual,
                        writer: pick.writer,
                    });
                }
                Err(e) => {
                    tracing::warn!(
                        provider = %pick.writer.provider,
                        model = pick.model.as_deref().unwrap_or("its default"),
                        error = %e.message,
                        "feedback write-up failed; trying the next model"
                    );
                    failure = e;
                }
            }
        }
        Err(failure)
    }
}

/// A report still waiting to go.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackQueued {
    /// Its id.
    pub id: String,
    /// `bug`, `idea` or `other`.
    pub kind: String,
    /// Its title.
    pub title: String,
    /// When it was written (RFC 3339).
    pub created_at: String,
    /// How many times Tessera tried to send it.
    pub attempts: u32,
    /// Why the last try did not go through, or null.
    pub last_error: Option<String>,
}

/// `feedback.outbox` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackOutboxInput {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackOutboxOutput {
    /// Reports waiting to go, oldest first.
    pub queued: Vec<FeedbackQueued>,
    /// Where they go.
    pub delivery: FeedbackDelivery,
}

pub struct FeedbackModule(pub Arc<FeedbackService>);

impl std::fmt::Debug for FeedbackModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FeedbackModule").finish_non_exhaustive()
    }
}

impl RuntimeModule for FeedbackModule {
    fn name(&self) -> &'static str {
        "feedback"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(ContextTool(Arc::clone(&self.0)))?;
        r.register(SendTool(Arc::clone(&self.0)))?;
        r.register(OutboxTool(Arc::clone(&self.0)))?;
        r.register(WriteUp(Arc::clone(&self.0)))?;
        Ok(())
    }

    fn start(&self, _host: &ModuleHost) -> Vec<JoinHandle<()>> {
        let service = Arc::downgrade(&self.0);
        vec![tokio::spawn(async move {
            loop {
                let Some(s) = service.upgrade() else { return };
                s.deliver_due().await;
                drop(s);
                tokio::time::sleep(DELIVERY_TICK).await;
            }
        })]
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (feedback)")
        .tool::<FeedbackContextInput, FeedbackContextOutput>("feedback.context")
        .tool::<FeedbackSendInput, FeedbackSendOutput>("feedback.send")
        .tool::<FeedbackOutboxInput, FeedbackOutboxOutput>("feedback.outbox")
        .tool::<FeedbackWriteUpInput, FeedbackWriteUpOutput>("feedback.write_up")
}

const SEND_RATE: RateLimit = RateLimit::new(0.1, 3);

const WRITE_UP_RATE: RateLimit = RateLimit::new(0.1, 3);

struct ContextTool(Arc<FeedbackService>);

#[async_trait]
impl Tool for ContextTool {
    type Input = FeedbackContextInput;
    type Output = FeedbackContextOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("feedback.context", "Read what a report would carry", RiskTier::Read)
            .description("The facts Tessera attaches to a feedback report, redacted, for the user to look over and remove: the app's version and commit, the system, the focused account's broker and kind (never its number), the protect mode, the focused chart, the latest order and protect events on its instrument, and recent runtime errors. Also where a report would go and whether the user's agent can write one up.")
            .user_only()
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: FeedbackContextInput,
    ) -> Result<FeedbackContextOutput, ToolError> {
        Ok(self.0.context(&input).await)
    }
}

struct SendTool(Arc<FeedbackService>);

#[async_trait]
impl Tool for SendTool {
    type Input = FeedbackSendInput;
    type Output = FeedbackSendOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("feedback.send", "Send feedback", RiskTier::Modify)
            .description("Sends the user's feedback report (bug, idea or other) to the Tessera team through Tessera Cloud, where it becomes an issue labelled feedback. Every string is redacted again first: no credentials, account numbers, hosts or tokens. Offline or signed out, it is kept and sent by itself later; the answer carries its id either way.")
            .user_only()
            .rate_limit(SEND_RATE)
            .redact(&["screenshot"])
            .timeout_ms(30_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: FeedbackSendInput,
    ) -> Result<FeedbackSendOutput, ToolError> {
        self.0.send(&input).await
    }
}

struct OutboxTool(Arc<FeedbackService>);

#[async_trait]
impl Tool for OutboxTool {
    type Input = FeedbackOutboxInput;
    type Output = FeedbackOutboxOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "feedback.outbox",
            "Read the reports waiting to go",
            RiskTier::Read,
        )
        .description("The user's feedback reports still waiting to be sent, and where they go.")
        .user_only()
        .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: FeedbackOutboxInput,
    ) -> Result<FeedbackOutboxOutput, ToolError> {
        self.0.outbox().wake(Instant::now());
        Ok(FeedbackOutboxOutput {
            queued: self.0.queued(),
            delivery: self.0.sink.delivery(),
        })
    }
}

struct WriteUp(Arc<FeedbackService>);

#[async_trait]
impl Tool for WriteUp {
    type Input = FeedbackWriteUpInput;
    type Output = FeedbackWriteUpOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("feedback.write_up", "Write up feedback", RiskTier::Read)
            .description("Has the user's own connected agent turn their feedback note and the facts they kept into a title, steps, expected and actual, from this session. It calls no tools and sends nothing: the user edits the draft and sends it.")
            .user_only()
            .rate_limit(WRITE_UP_RATE)
            .timeout_ms(130_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: FeedbackWriteUpInput,
    ) -> Result<FeedbackWriteUpOutput, ToolError> {
        self.0.write_up(&input).await
    }
}

#[cfg(test)]
mod tests;
