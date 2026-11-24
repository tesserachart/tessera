use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tessera_host::{RuntimeModule, TsExports};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RateLimit, RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use ts_rs::TS;

use std::collections::BTreeMap;

use crate::telemetry::{RemoteSettings, SurveyKind, Telemetry, WindowEvent};

/// `telemetry.status` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryStatusInput {}

/// `telemetry.status` output: whether this build can send crash reports and usage analytics. What the user lets it
/// send is the `telemetry.consent` setting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatusOutput {
    /// This build has a PostHog project to send to; without one it sends nothing and asks nothing.
    pub available: bool,
}

/// `telemetry.config` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryConfigInput {}

/// `telemetry.config` output: what the Tessera team's PostHog project says for this install or person. Empty while
/// the user does not share usage analytics: no flag, no recording, no survey.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryConfigOutput {
    /// The user shared usage analytics when this was asked, so the project was asked: false means everything below is empty because
    /// nothing may be asked yet.
    pub asked: bool,
    /// Each feature flag by key: on or off, or the variant this person gets.
    #[ts(type = "Record<string, boolean | string>")]
    pub flags: BTreeMap<String, Value>,
    /// Session replay as the project sets it, or null to record nothing.
    pub replay: Option<TelemetryReplay>,
    /// The surveys this person may be asked now.
    pub surveys: Vec<TelemetrySurvey>,
}

/// How the project records sessions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryReplay {
    /// The share of sessions recorded (0 to 1), or null for all.
    pub sample_rate: Option<f64>,
    /// Sessions shorter than this many milliseconds are not kept.
    #[ts(type = "number | null")]
    pub minimum_duration_ms: Option<u64>,
}

/// A survey the team wrote in PostHog.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySurvey {
    /// PostHog's id for it.
    pub id: String,
    /// Its name in PostHog.
    pub name: String,
    /// Its questions, in order.
    pub questions: Vec<TelemetrySurveyQuestion>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySurveyQuestion {
    /// PostHog's id for it.
    pub id: String,
    /// `open` (words) or `single_choice` (one of `choices`).
    pub kind: TelemetrySurveyKind,
    /// The question.
    pub question: String,
    /// A line under it.
    pub description: Option<String>,
    /// The answers to choose from (`single_choice`).
    pub choices: Vec<String>,
    /// It may be left blank.
    pub optional: bool,
}

/// What a survey question takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TelemetrySurveyKind {
    Open,
    SingleChoice,
}

impl From<RemoteSettings> for TelemetryConfigOutput {
    fn from(r: RemoteSettings) -> Self {
        Self {
            asked: r.asked,
            flags: r.flags,
            replay: r.replay.map(|p| TelemetryReplay {
                sample_rate: p.sample_rate,
                minimum_duration_ms: p.minimum_duration_ms,
            }),
            surveys: r
                .surveys
                .into_iter()
                .map(|s| TelemetrySurvey {
                    id: s.id,
                    name: s.name,
                    questions: s
                        .questions
                        .into_iter()
                        .map(|q| TelemetrySurveyQuestion {
                            id: q.id,
                            kind: match q.kind {
                                SurveyKind::Open => TelemetrySurveyKind::Open,
                                SurveyKind::SingleChoice => TelemetrySurveyKind::SingleChoice,
                            },
                            question: q.question,
                            description: q.description,
                            choices: q.choices,
                            optional: q.optional,
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

/// One event the window captured, as its analytics library shaped it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryWindowEvent {
    /// Its name (`$exception`, `area opened`).
    pub event: String,
    /// Its properties.
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub properties: Map<String, Value>,
    /// When it happened (RFC 3339).
    #[serde(default)]
    pub timestamp: Option<String>,
}

/// `telemetry.capture` input: events the window captured, to send through the runtime.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryCaptureInput {
    /// The events, at most 50 a call.
    pub events: Vec<TelemetryWindowEvent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryCaptureOutput {
    /// How many it sent: crash reports while they are on, everything else only while the user shares usage analytics.
    pub sent: u32,
}

pub struct TelemetryModule(Telemetry);

impl TelemetryModule {
    pub fn new(telemetry: Telemetry) -> Self {
        Self(telemetry)
    }
}

impl std::fmt::Debug for TelemetryModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelemetryModule").finish_non_exhaustive()
    }
}

impl RuntimeModule for TelemetryModule {
    fn name(&self) -> &'static str {
        "telemetry"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(Status(self.0.clone()))?;
        r.register(Config(self.0.clone()))?;
        r.register(Capture(self.0.clone()))?;
        Ok(())
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (telemetry)")
        .tool::<TelemetryStatusInput, TelemetryStatusOutput>("telemetry.status")
        .tool::<TelemetryConfigInput, TelemetryConfigOutput>("telemetry.config")
        .tool::<TelemetryCaptureInput, TelemetryCaptureOutput>("telemetry.capture")
}

const CAPTURE_RATE: RateLimit = RateLimit::new(2.0, 20);

struct Status(Telemetry);

#[async_trait]
impl Tool for Status {
    type Input = TelemetryStatusInput;
    type Output = TelemetryStatusOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("telemetry.status", "Read the sharing status", RiskTier::Read)
            .description("Whether this build can send crash reports and usage analytics to the Tessera team (through PostHog). Problem reports go through feedback.send, not PostHog. What the user lets it send is the telemetry.consent setting, the user's alone.")
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: TelemetryStatusInput,
    ) -> Result<TelemetryStatusOutput, ToolError> {
        Ok(TelemetryStatusOutput {
            available: self.0.available(),
        })
    }
}

struct Config(Telemetry);

#[async_trait]
impl Tool for Config {
    type Input = TelemetryConfigInput;
    type Output = TelemetryConfigOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("telemetry.config", "Read the team's flags and surveys", RiskTier::Read)
            .description("The Tessera team's feature flags, session replay setting and surveys for this install, from its PostHog project. Asked only while the user shares usage analytics (telemetry.consent usage); empty otherwise.")
            .user_only()
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: TelemetryConfigInput,
    ) -> Result<TelemetryConfigOutput, ToolError> {
        Ok(self.0.remote_settings().await.into())
    }
}

struct Capture(Telemetry);

#[async_trait]
impl Tool for Capture {
    type Input = TelemetryCaptureInput;
    type Output = TelemetryCaptureOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("telemetry.capture", "Send window events", RiskTier::Modify)
            .description("The window's usage events, errors and session recording (every number and private text masked by the window), sent to the Tessera team through PostHog as telemetry.consent allows: errors ($exception) as anonymous crash reports while crashes is on, everything else only while usage is true; the rest is dropped. Every token, password, key, account id and login is taken out first.")
            .user_only()
            .quiet()
            .rate_limit(CAPTURE_RATE)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: TelemetryCaptureInput,
    ) -> Result<TelemetryCaptureOutput, ToolError> {
        let events = input
            .events
            .into_iter()
            .map(|e| WindowEvent {
                event: e.event,
                properties: e.properties,
                timestamp: e
                    .timestamp
                    .as_deref()
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .map(|t| t.with_timezone(&chrono::Utc)),
            })
            .collect();
        let sent = self.0.window(events).unwrap_or(0);
        Ok(TelemetryCaptureOutput {
            sent: u32::try_from(sent).unwrap_or(u32::MAX),
        })
    }
}
