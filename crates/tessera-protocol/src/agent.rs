use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::ids::{ApprovalId, CallId, DraftId, SessionId};
use tessera_core::{Origin, Timestamp};
use ts_rs::TS;

use crate::tools::{
    ApprovalKind, ApprovalStatus, RiskTier, SessionMode, ToolErrorInfo, ToolOutcome,
};

/// Epistemic type of a result block. Research is presented as measured statistics vs current
/// observations vs hypotheses vs model interpretation — never as guaranteed outcomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Epistemic {
    /// Tool outputs.
    Measured,
    /// Current market state.
    Observed,
    /// Pre-registered hypothesis.
    Hypothesis,
    /// The model's prose.
    Interpretation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    pub kind: Epistemic,
    pub title: Option<String>,
    pub text: String,
    pub source_call_id: Option<CallId>,
    pub rows: Vec<(String, String)>,
}

/// One step of an agent plan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    /// Step text.
    pub text: String,
    /// Status.
    pub status: PlanStepStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    /// Not started.
    Pending,
    InProgress,
    Done,
    /// Failed or skipped.
    Failed,
}

/// Coarse state for the transcript status line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Idle,
    /// Reasoning.
    Thinking,
    RunningTool,
    /// Writing the answer.
    Writing,
}

/// How a turn ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnEnd {
    /// Finished normally.
    Completed,
    /// Stopped by the user.
    Interrupted,
    Failed,
    /// Stopped by a loop guard.
    LoopGuard,
}

/// What an attachment on a user message is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    /// A picture the analyst sees (PNG, JPEG, GIF or WebP), uploaded with `agent.upload_attachment`.
    Image,
    /// A file the analyst reads (text, or a PDF for Claude Code), uploaded with `agent.upload_attachment`.
    File,
    ChartSnapshot,
    /// Workspace context.
    Context,
}

/// A file or context attachment on a user message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Kind.
    pub kind: AttachmentKind,
    /// Display label (an image's or a file's name).
    pub label: String,
    /// Blob reference (sha256) or URI, for a chart snapshot or context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference: Option<String>,
    /// The upload's id (`att_…`), for an image or a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    /// Media type (`image/png`, `text/csv`, `application/pdf`), for an image or a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mime_type: Option<String>,
    /// Size in bytes, for an image or a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub size_bytes: Option<u64>,
}

pub const ATTACHMENT_MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const ATTACHMENT_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub const ATTACHMENT_MAX_PER_MESSAGE: usize = 100;
pub const ATTACHMENT_MAX_IMAGE_BYTES_PER_MESSAGE: u64 = 80 * 1024 * 1024;
pub const ATTACHMENT_MAX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// `agent.upload_attachment` input (user only): an image or a file for the composer, whole or a piece at a
/// time. The first piece names it (`name`, `mimeType`, `sizeBytes`) and starts at 0; each next piece gives the
/// `uploadId` the first answered and starts where the last ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentUploadAttachmentInput {
    /// File name (`chart.png`, `notes.md`).
    pub name: String,
    /// Media type as the file says (`image/png`; empty when unknown).
    pub mime_type: String,
    /// The whole file's size in bytes.
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// This piece, base64.
    pub data_base64: String,
    /// The upload this piece continues; none for the first piece.
    #[serde(default)]
    pub upload_id: Option<String>,
    /// Where this piece starts in the file (0, the default, for the first).
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub offset: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentUploadAttachmentOutput {
    /// The upload (the next piece's `uploadId`; the attachment's id once whole).
    pub upload_id: String,
    /// Bytes received so far.
    #[ts(type = "number")]
    pub received: u64,
    /// The attachment to send with `agent.send`, once every byte arrived.
    pub attachment: Option<Attachment>,
}

/// `agent.get_attachment` and `agent.discard_attachment` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAttachmentIdInput {
    /// The attachment (`att_…`).
    pub id: String,
}

/// `agent.get_attachment` output: the attachment and its bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachmentData {
    /// The attachment.
    pub attachment: Attachment,
    /// Its bytes, base64.
    pub data_base64: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiscardAttachmentOutput {
    /// False when there was no such unsent upload (one sent with a message stays with it).
    pub discarded: bool,
}

pub const MAX_SUGGESTIONS: usize = 4;

/// A follow-up chip: a label and the real tool call it makes when the user picks it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// Chip text (`Backtest this setup`).
    pub label: String,
    /// Dotted tool name the chip invokes.
    pub tool: String,
    /// The tool input, valid against the tool's input schema.
    pub input: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum AgentEvent {
    UserMessage {
        text: String,
        attachments: Vec<Attachment>,
    },
    #[serde(rename_all = "camelCase")]
    AssistantDelta {
        message_id: String,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    AssistantMessage {
        message_id: String,
        text: String,
        blocks: Vec<ContentBlock>,
    },
    #[serde(rename_all = "camelCase")]
    ReasoningSummary {
        text: String,
        duration_ms: Option<f64>,
    },
    Plan {
        steps: Vec<PlanStep>,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallStarted {
        call_id: CallId,
        tool: String,
        risk: RiskTier,
        args: Value,
        title: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallFinished {
        call_id: CallId,
        tool: String,
        risk: RiskTier,
        outcome: ToolOutcome,
        result_summary: Option<String>,
        artifact_refs: Vec<String>,
        duration_ms: f64,
        error: Option<ToolErrorInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        result: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ApprovalRequested {
        approval_id: ApprovalId,
        draft_id: Option<DraftId>,
        tool: String,
        kind: ApprovalKind,
    },
    #[serde(rename_all = "camelCase")]
    ApprovalResolved {
        approval_id: ApprovalId,
        status: ApprovalStatus,
    },
    #[serde(rename_all = "camelCase")]
    Artifact {
        artifact_id: String,
        kind: String,
        title: String,
        data: Option<Value>,
    },
    #[serde(rename_all = "camelCase")]
    Status {
        state: AgentState,
        text: Option<String>,
        step: Option<u32>,
        total_steps: Option<u32>,
    },
    Error {
        code: String,
        message: String,
        retryable: bool,
    },
    #[serde(rename_all = "camelCase")]
    TurnStarted {
        turn_id: String,
    },
    #[serde(rename_all = "camelCase")]
    TurnFinished {
        turn_id: String,
        end: TurnEnd,
        duration_ms: f64,
        tool_calls: u32,
    },
    Card {
        card: crate::cards::Card,
    },
    Suggestions {
        items: Vec<Suggestion>,
    },
}

impl AgentEvent {
    pub fn type_name(&self) -> &'static str {
        match self {
            AgentEvent::UserMessage { .. } => "user_message",
            AgentEvent::AssistantDelta { .. } => "assistant_delta",
            AgentEvent::AssistantMessage { .. } => "assistant_message",
            AgentEvent::ReasoningSummary { .. } => "reasoning_summary",
            AgentEvent::Plan { .. } => "plan",
            AgentEvent::ToolCallStarted { .. } => "tool_call_started",
            AgentEvent::ToolCallFinished { .. } => "tool_call_finished",
            AgentEvent::ApprovalRequested { .. } => "approval_requested",
            AgentEvent::ApprovalResolved { .. } => "approval_resolved",
            AgentEvent::Artifact { .. } => "artifact",
            AgentEvent::Status { .. } => "status",
            AgentEvent::Error { .. } => "error",
            AgentEvent::TurnStarted { .. } => "turn_started",
            AgentEvent::TurnFinished { .. } => "turn_finished",
            AgentEvent::Card { .. } => "card",
            AgentEvent::Suggestions { .. } => "suggestions",
        }
    }

    pub fn suggestions(items: impl IntoIterator<Item = Suggestion>) -> Self {
        AgentEvent::Suggestions {
            items: items.into_iter().take(MAX_SUGGESTIONS).collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub session_id: SessionId,
    #[ts(type = "number")]
    pub seq: u64,
    pub ts: Timestamp,
    pub turn_id: Option<String>,
    pub event: AgentEvent,
}

/// Run state of an agent session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionStatus {
    /// No turn running.
    Idle,
    /// A turn is running.
    Running,
    /// Waiting for the user (approval or question).
    NeedsYou,
}

/// Summary of an agent session (`agent.sessions` topic, sidebar rows).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    /// Id (`S15`).
    pub id: SessionId,
    /// Title.
    pub title: String,
    /// Preset (`Trader`, `Quant`, `Risk`, `Researcher`, custom).
    pub preset: String,
    /// Provider id (`codex`, `claude-code`, `local`, `mcp`).
    pub provider: String,
    /// Model id as the provider names it (the provider's default when none).
    pub model: Option<String>,
    /// Reasoning effort, for a model that has one (`low` … `max`); the model's default when none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    /// The provider's own conversation (a Claude Code session, a Codex thread), resumed after a
    /// restart so the conversation carries on where it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread: Option<String>,
    /// Mode.
    pub mode: SessionMode,
    /// Status.
    pub status: AgentSessionStatus,
    /// Origin that drives the session (agent or external MCP client).
    pub origin: Origin,
    /// Source attribution (`Claude Desktop · MCP`).
    pub source_label: Option<String>,
    /// Created.
    pub created_at: Timestamp,
    /// Last activity.
    pub updated_at: Timestamp,
    /// Messages waiting for the running turn to end, oldest first: each starts its own turn, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<QueuedMessage>>")]
    pub queue: Vec<QueuedMessage>,
    /// The queue waits for the user: Stop, a turn that failed or a restart held it, and nothing in it is sent until
    /// `agent.resume_queue`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(optional, as = "Option<bool>")]
    pub queue_held: bool,
}

/// A message sent while the session's turn ran, waiting for it to end.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    /// Id within the session's queue.
    pub id: String,
    /// Message text.
    pub text: String,
    /// Its attachments, as `agent.send` took them.
    pub attachments: Vec<Attachment>,
    /// When it was queued.
    pub queued_at: Timestamp,
}

/// How `agent.send` delivers a message while the session's turn runs. An idle session starts a turn either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// Into the running turn, which reads it at its next step. A provider that cannot take a message mid-run queues
    /// it instead.
    Steer,
    /// Into the session's queue, sent as its own turn once the running turn and the messages before it are done.
    Queue,
}

/// What `agent.send` did with the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Delivered {
    /// It started a turn.
    Turn,
    /// It went into the running turn.
    Steered,
    /// It waits in the session's queue.
    Queued,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum AgentSessionsEvent {
    Snapshot {
        sessions: Vec<AgentSessionSummary>,
    },
    Upsert {
        session: Box<AgentSessionSummary>,
    },
    #[serde(rename_all = "camelCase")]
    Removed {
        session_id: SessionId,
    },
}

/// `agent.start_session` input (user only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentStartSessionInput {
    /// Preset (`Trader`, `Quant`, `Risk`, `Researcher`, or a custom preset's name).
    pub preset: String,
    /// Provider id (`codex`, `claude-code`, `local`).
    pub provider: String,
    /// Model id as the provider names it; the provider's default when omitted.
    #[serde(default)]
    pub model: Option<String>,
    /// Reasoning effort (one of the model's); the model's default when omitted.
    #[serde(default)]
    pub effort: Option<String>,
    /// Session mode; the `agent.defaultMode` setting when omitted.
    #[serde(default)]
    pub mode: Option<SessionMode>,
    /// Title; derived from the first message when omitted.
    #[serde(default)]
    pub title: Option<String>,
}

/// Output of `agent.start_session` and `agent.set_mode`: the session after the change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionOutput {
    /// The session.
    pub session: AgentSessionSummary,
}

/// `agent.send` input (user only): starts a turn with the user's message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentSendInput {
    /// Session.
    pub session_id: SessionId,
    /// Message text.
    pub text: String,
    /// Attachments: images and files uploaded with `agent.upload_attachment` (at most 100, their images 80 MiB
    /// together); none when omitted.
    #[serde(default)]
    #[ts(optional, as = "Option<Vec<Attachment>>")]
    pub attachments: Vec<Attachment>,
    /// The model to answer with, from this turn on (one of the session provider's); unchanged
    /// when omitted.
    #[serde(default)]
    pub model: Option<String>,
    /// Its reasoning effort, from this turn on; unchanged when omitted.
    #[serde(default)]
    pub effort: Option<String>,
    /// While a turn runs: `steer` puts the message into it, `queue` sends it as its own turn once the turn is done.
    /// `queue` when omitted. An idle session starts a turn either way.
    #[serde(default)]
    pub delivery: Option<Delivery>,
}

/// `agent.send` output. The turn's events stream on `agent.session`; the queue is on the session's summary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendOutput {
    /// Session.
    pub session_id: SessionId,
    /// What happened to the message.
    pub delivered: Delivered,
    /// The turn it started or went into; none when queued.
    pub turn_id: Option<String>,
    /// Its id in the session's queue, when queued.
    pub queued_id: Option<String>,
    /// Why a message sent to steer was queued instead, in words for the user.
    pub notice: Option<String>,
}

/// `agent.edit_queued` input (user only): new words for a message waiting in the session's queue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEditQueuedInput {
    /// Session.
    pub session_id: SessionId,
    /// The queued message.
    pub queued_id: String,
    /// Its new text; its attachments stay.
    pub text: String,
}

/// `agent.remove_queued` input (user only): takes a message out of the session's queue unsent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRemoveQueuedInput {
    /// Session.
    pub session_id: SessionId,
    /// The queued message.
    pub queued_id: String,
}

/// `agent.resume_queue` input (user only): sends a held queue on, its first message now when no turn runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResumeQueueInput {
    /// Session.
    pub session_id: SessionId,
}

/// `agent.interrupt` input (user only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInterruptInput {
    /// Session.
    pub session_id: SessionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentInterruptOutput {
    /// Session.
    pub session_id: SessionId,
    /// False when no turn was running.
    pub interrupted: bool,
}

/// `agent.set_model` input (user only): the model (and effort) the session's next turns use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AgentSetModelInput {
    /// Session.
    pub session_id: SessionId,
    /// Model id (one of the session provider's); unchanged when omitted.
    #[serde(default)]
    pub model: Option<String>,
    /// Reasoning effort (one of the model's); the model's default when omitted with a new model.
    #[serde(default)]
    pub effort: Option<String>,
}

/// `agent.rename_session` input (user only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRenameSessionInput {
    /// Session.
    pub session_id: SessionId,
    /// New title.
    pub title: String,
}

/// `agent.delete_session` input (user only): the session, its transcript and its provider
/// conversation's link go; a running turn is stopped first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDeleteSessionInput {
    /// Session.
    pub session_id: SessionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeleteSessionOutput {
    /// Session.
    pub session_id: SessionId,
    /// False when there was no such session.
    pub deleted: bool,
}

/// `agent.list_providers` input: `{}` lists each provider as last checked; `{"recheck": true}` checks every provider
/// the user turned on again first (Settings › Analyst's Check again). A provider that is off is never checked.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentListProvidersInput {
    /// Check every provider that is on again before listing them (its CLI's version and sign-in).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recheck: Option<bool>,
}

/// A reasoning-effort level a model offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentEffort {
    /// Id as the provider names it (`medium`, `xhigh`).
    pub id: String,
    /// Label (`Extra high`).
    pub label: String,
}

/// A model a provider offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    /// Id as the provider names it (`claude-opus-5-5`, `gpt-6-astra`).
    pub id: String,
    /// Label (`Claude Opus 5.5`).
    pub label: String,
    /// One line on what it is for, when the provider says.
    pub description: Option<String>,
    /// Its reasoning-effort levels, lowest first; empty when it has none.
    pub efforts: Vec<AgentEffort>,
    /// The effort it uses when none is picked.
    pub default_effort: Option<String>,
}

/// An agent provider (the user's own Codex or Claude Code), its state and its models.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInfo {
    /// Provider id (`codex`, `claude-code`).
    pub id: String,
    /// Display name (`Codex`, `Claude Code`).
    pub name: String,
    /// Turned on by the user (`agent.providers`). Off, Tessera never runs or checks its CLI: it lists as `disabled`
    /// with no version, account, home or models.
    pub enabled: bool,
    /// Installed and signed in (`ok`), signed out (`disconnected`), missing or failing (`down`), being checked
    /// (`unknown`), or off (`disabled`).
    pub status: tessera_core::health::HealthStatus,
    /// The account (`Claude · Max`) when signed in, else what is wrong (`Not signed in`).
    pub message: Option<String>,
    /// Its models, the default first.
    pub models: Vec<AgentModel>,
    /// The model a new session uses when none is picked.
    pub default_model: Option<String>,
    /// The CLI's version as it reports it (`2.1.3`); none until it ran, or when it does not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
    /// The home the CLI runs on (its sign-in and settings): the provider's `configDir` in `agent.providers`, else
    /// `TESSERA_CODEX_HOME` / `TESSERA_CLAUDE_CONFIG_DIR` when set, else the CLI's default spelled out
    /// (`/home/me/.codex`, `/home/me/.claude`). None while it is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub config_home: Option<String>,
    /// When Tessera last checked it (its version and sign-in); none while it is off or before its first check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checked_at: Option<Timestamp>,
    /// It reads a PDF attached to a message (Claude Code). Every provider reads images and text files.
    #[serde(default)]
    pub reads_pdfs: bool,
}

/// `agent.list_providers` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvidersOutput {
    /// Every provider this runtime can run, connected or not.
    pub providers: Vec<AgentProviderInfo>,
}

/// `agent.sign_in` input: starts signing a provider that is on in to the user's account (one already running is
/// replaced); with `code`, hands the running sign-in the code its page showed instead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSignInInput {
    /// Provider id (`codex`, `claude-code`).
    pub provider: String,
    /// The code the sign-in page showed, for a sign-in that `takesCode`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<String>,
}

/// `agent.sign_in` output. The provider reads as signed in by itself once the user finished on the page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSignInOutput {
    /// Provider id.
    pub provider: String,
    /// The page the sign-in started on; none when a code was handed over.
    pub page: Option<AgentSignInPage>,
}

/// `agent.install` input: installs a provider that is on but not installed, with its vendor's own installer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInstallInput {
    /// Provider id (`claude-code`).
    pub provider: String,
}

/// `agent.install` output, once the installer finished and the provider was checked again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallOutput {
    /// Provider id.
    pub provider: String,
}

/// The page a sign-in is finished on, in the user's browser.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSignInPage {
    /// The page.
    pub url: String,
    /// The CLI opened it in the browser itself; else the app opens it.
    pub opened: bool,
    /// It can end on a code the user pastes back (`agent.sign_in` with `code`), for when the browser did not hand
    /// the sign-in back by itself.
    pub takes_code: bool,
}

/// `agent.list_sessions` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentListSessionsInput {}

/// `agent.list_sessions` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsOutput {
    /// Every session, the most recently active first.
    pub sessions: Vec<AgentSessionSummary>,
}

/// `agent.get_transcript` input: a session's conversation, a page at a time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentGetTranscriptInput {
    /// Session (`agent.list_sessions`).
    pub session_id: SessionId,
    /// Entries after this position (0, the default: from the start; a page's `lastSeq` for the next page).
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub after_seq: Option<u64>,
    /// At most this many entries (default 100, at most 500).
    #[serde(default)]
    #[ts(optional)]
    pub limit: Option<u32>,
}

/// What a transcript entry is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRole {
    /// The user's message.
    User,
    /// The analyst's answer.
    Assistant,
    /// A tool call the analyst made, with its outcome and one-line summary.
    Tool,
    /// An approval the analyst asked for, or how the user resolved it.
    Approval,
    /// An error the turn ended on.
    Error,
}

/// One entry of a transcript as `agent.get_transcript` reads it: messages in full, tool calls by name, outcome
/// and summary (never their raw answers).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptEntry {
    /// Position in the session's log.
    #[ts(type = "number")]
    pub seq: u64,
    /// When.
    pub ts: Timestamp,
    /// What it is.
    pub role: TranscriptRole,
    /// The message, the tool's one-line summary, or what happened.
    pub text: String,
    /// The tool, for a tool call or an approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool: Option<String>,
    /// How a tool call ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outcome: Option<ToolOutcome>,
}

/// `agent.get_transcript` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptOutput {
    /// The session.
    pub session: AgentSessionSummary,
    /// Its entries in order.
    pub entries: Vec<AgentTranscriptEntry>,
    /// The last log position this page read (pass it as `afterSeq` for the next page).
    #[ts(type = "number")]
    pub last_seq: u64,
    /// More of the log follows.
    pub more: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSearchSessionsInput {
    /// Plain words, all of which a message must hold.
    pub query: String,
    /// At most this many hits (default 20, at most 100).
    #[serde(default)]
    #[ts(optional)]
    pub limit: Option<u32>,
}

/// A message `agent.search_sessions` found.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSearchHit {
    /// Session.
    pub session_id: SessionId,
    /// The session's title (empty when the session is gone).
    pub title: String,
    /// The message's position in the session's log (`agent.get_transcript` from just before it).
    #[ts(type = "number")]
    pub seq: u64,
    /// The words around the match, each match in `[` `]`.
    pub snippet: String,
}

/// `agent.search_sessions` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSearchOutput {
    /// The best matches first.
    pub hits: Vec<AgentSearchHit>,
}

/// `agent.set_mode` input (user only). Only the user changes a session's mode: an agent can never
/// widen its own permissions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSetModeInput {
    /// Session.
    pub session_id: SessionId,
    /// New mode.
    pub mode: SessionMode,
}

/// The value of `agent.sessionRunner`: the analyst trades every session on its own, on one account
/// (Settings › Analyst › Trading sessions). The user's alone.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default)]
#[ts(optional_fields)]
pub struct SessionRunnerSetting {
    /// On: a session starts whenever the CME market opens (its trading calendar: the reopen after
    /// the daily break or the weekend), or when Tessera starts while it is open, and runs to the
    /// market's next break. The standing instructions decide when and what it trades.
    pub enabled: bool,
    /// The account it trades.
    pub account_id: Option<String>,
    /// The provider it runs on (`codex`, `claude-code`).
    pub provider: Option<String>,
    /// Its model; the provider's default when none.
    pub model: Option<String>,
    /// Its reasoning effort; the model's default when none.
    pub effort: Option<String>,
    /// The file the user's standing instructions are read from at each start, outside Tessera's
    /// data (default `~/.config/tessera/analyst-instructions.md`).
    pub instructions_path: Option<String>,
    /// The GitHub repository (`owner/name`) every failure and friction is filed in, through the
    /// user's own `gh` login; none: nothing is filed.
    pub issues_repo: Option<String>,
    /// The frozen Research study it trades (`research.get_study`): Tessera reads its signal at
    /// each close of its bars and wakes the analyst when it changes, and its trades go in the
    /// journal under a setup linked to it. With a study the instructions file is optional.
    pub study_id: Option<String>,
}

/// Where a trading session stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TradingPhase {
    /// The analyst trades.
    Trading,
    /// It was asked to close out and write its log.
    Closing,
    /// Over, and reported.
    Done,
    /// It could not start (why is in the note).
    Skipped,
}

/// One trading session: the market's open stretch of a trade date, from its open to its next break.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradingDay {
    /// The trade date, `YYYY-MM-DD`.
    pub date: String,
    /// When the market opened for it.
    #[ts(type = "number")]
    pub opens_at: Timestamp,
    /// The market's next break, when Tessera closes the account out.
    #[ts(type = "number")]
    pub closes_at: Timestamp,
    /// Where it stands.
    pub phase: TradingPhase,
    /// Its conversation.
    pub session_id: Option<SessionId>,
    /// The account.
    pub account_id: String,
    /// When it started.
    #[ts(type = "number | null")]
    pub started_at: Option<Timestamp>,
    /// Why it did not start, or what went wrong at its end.
    pub note: Option<String>,
    /// The Research study it trades, as set when it started.
    #[serde(default)]
    pub study_id: Option<String>,
}

/// `agent.trading_session` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TradingSessionInput {}

/// `agent.trading_session` and `agent.start_trading_session` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradingSessionStatus {
    /// The setting.
    pub setting: SessionRunnerSetting,
    /// The instructions file, the home directory spelled out.
    pub instructions_path: String,
    /// Its length in characters, when it reads.
    pub instructions_chars: Option<u32>,
    /// What stops a session from starting now, in the user's words; empty: nothing.
    pub missing: Vec<String>,
    /// The running session, or the last one.
    pub day: Option<TradingDay>,
    /// When the next one starts, when on.
    #[ts(type = "number | null")]
    pub next_start: Option<Timestamp>,
}

/// `agent.wake_at` input: wake the running trading session's analyst at a time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WakeAtInput {
    /// When, as an RFC 3339 time with its offset (`2026-10-27T09:25:00-04:00`); before the
    /// session's close-out.
    #[ts(type = "string | number")]
    pub at: Timestamp,
    /// What to do then, in the analyst's words; it gets this back when woken.
    pub note: String,
}

/// `agent.wake_at` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WakeAtOutput {
    /// When it wakes.
    #[ts(type = "number")]
    pub at: Timestamp,
    /// Every wake still set in the session, in order.
    #[ts(type = "number[]")]
    pub wakes: Vec<Timestamp>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggestions_are_capped_and_tagged() {
        let chip = |i: usize| Suggestion {
            label: format!("chip {i}"),
            tool: "market.get_quote".into(),
            input: serde_json::json!({"instrument": "QQQ"}),
        };
        let e = AgentEvent::suggestions((0..6).map(chip));
        let AgentEvent::Suggestions { items } = &e else {
            panic!("{e:?}")
        };
        assert_eq!(items.len(), MAX_SUGGESTIONS);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "suggestions");
        assert_eq!(v["items"][0]["tool"], "market.get_quote");
        assert_eq!(e.type_name(), "suggestions");
    }

    #[test]
    fn session_control_inputs_are_strict() {
        let ok: AgentSendInput =
            serde_json::from_value(serde_json::json!({"sessionId": "S1", "text": "hi"})).unwrap();
        assert!(ok.attachments.is_empty());
        assert_eq!(ok.delivery, None);
        let steer: AgentSendInput = serde_json::from_value(
            serde_json::json!({"sessionId": "S1", "text": "hi", "delivery": "steer"}),
        )
        .unwrap();
        assert_eq!(steer.delivery, Some(Delivery::Steer));
        assert!(
            serde_json::from_value::<AgentSendInput>(
                serde_json::json!({"sessionId": "S1", "text": "hi", "delivery": "later"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<AgentSetModeInput>(
                serde_json::json!({"sessionId": "S1", "mode": "auto_modify", "x": 1})
            )
            .is_err()
        );
    }

    #[test]
    fn events_are_tagged_snake_case_with_camel_fields() {
        let e = AgentEvent::ToolCallStarted {
            call_id: CallId::new("call_1"),
            tool: "market.get_candles".into(),
            risk: RiskTier::Read,
            args: serde_json::json!({"instrument": "QQQ"}),
            title: Some("Loaded candles".into()),
        };
        assert_eq!(e.type_name(), "tool_call_started");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "tool_call_started");
        assert_eq!(v["callId"], "call_1");
        let back: AgentEvent = serde_json::from_value(v).unwrap();
        assert_eq!(back, e);
    }
}
