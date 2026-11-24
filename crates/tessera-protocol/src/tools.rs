use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::accounts::Environment;
use tessera_core::ids::{ApprovalId, CallId, DraftId, SessionId};
use tessera_core::instrument::InstrumentId;
use tessera_core::orders::DraftStatus;
use tessera_core::{Origin, Timestamp};
use ts_rs::TS;

/// Risk tier of a tool. Drives the permission gate and the UI's card weight.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RiskTier {
    /// Queries; no side effects outside caches.
    Read,
    /// Changes app state (chart, layers, notes, settings…).
    Modify,
    /// Creates, changes or cancels orders or positions, or moves money or risk limits.
    Financial,
}

impl RiskTier {
    pub fn label(self) -> &'static str {
        match self {
            RiskTier::Read => "READ",
            RiskTier::Modify => "MODIFY",
            RiskTier::Financial => "FINANCIAL",
        }
    }
}

/// How an agent session is allowed to use Modify and Financial tools. Only the user sets it.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    /// Modify tools ask for approval.
    #[default]
    Supervised,
    /// Modify tools run without asking.
    AutoModify,
    /// Modify tools are denied.
    ReadOnly,
    /// Modify tools run without asking, and so do Financial ones (orders, changes, cancels,
    /// flattens): no per-action approval, under the trader's own limits (decision 0018). A draft
    /// tool still drafts.
    FullAccess,
}

/// Rendering hints for the UI's tool-call rows and cards.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiHints {
    /// Icon name from the UI icon set.
    pub icon: Option<String>,
    /// Preferred result view (`quote`, `bars`, `table`, `json`, `chart_state`, `layout`).
    pub result_view: Option<String>,
    /// Short verb phrase for work rows (`Loaded candles`).
    pub activity_label: Option<String>,
    /// Hidden from command palettes and agent tool lists (UI plumbing tools).
    pub hidden: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub mcp_name: String,
    pub title: String,
    pub description: String,
    pub risk: RiskTier,
    pub category: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub ui_hints: UiHints,
    pub idempotent: bool,
    pub user_only: bool,
}

/// Final status of a tool call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcome {
    /// Completed; `output` is set.
    Ok,
    /// Failed; `error` is set.
    Error,
    /// Refused by the permission gate or a loop guard; `error` is set.
    Denied,
    /// Waiting for the user's approval; `approval` is set and `output` carries
    /// `{status:"pending_approval", approvalId, draftId?}`.
    PendingApproval,
}

/// Machine-readable error code of a failed or denied call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolErrorCode {
    /// Unknown tool name.
    UnknownTool,
    /// Input failed schema or semantic validation.
    InvalidInput,
    /// A referenced object does not exist.
    NotFound,
    /// A provider or service is unavailable.
    Unavailable,
    /// Not supported by the current providers' capabilities.
    Unsupported,
    /// The permission gate refused the call.
    PermissionDenied,
    /// A per-tool rate limit was hit.
    RateLimited,
    /// A loop guard tripped (steps, call cap, live draft).
    LoopGuard,
    /// Conflicting concurrent change (e.g. layout revision mismatch).
    Conflict,
    /// The referenced draft or approval is stale.
    Stale,
    /// The call timed out. It was stopped, so a Read or Modify tool's change was either made in
    /// full or not at all; check the state before retrying.
    Timeout,
    /// The call may have taken effect, but its result is not known: a Financial tool that ran past
    /// its timeout (it is never stopped, since its order may already be at the broker), or an
    /// approved call interrupted before its result was recorded. Never retryable: check orders and
    /// the activity log (`tool.calls`) first.
    OutcomeUnknown,
    /// The broker or a pre-trade rule refused the order: nothing is working. `details` says why
    /// (`checks`, `prop` with `sizeToFit`, or the rejected `order`).
    Rejected,
    /// Unexpected internal failure.
    Internal,
}

/// Error detail of a failed or denied call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolErrorInfo {
    /// Code.
    pub code: ToolErrorCode,
    /// Message (safe to show to users and models).
    pub message: String,
    /// Structured detail.
    pub details: Option<Value>,
    /// Retrying later may succeed.
    pub retryable: bool,
}

impl fmt::Display for ToolErrorInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

/// Pointer to the approval a call is waiting on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    /// Approval id.
    pub approval_id: ApprovalId,
    /// Draft id (financial tools).
    pub draft_id: Option<DraftId>,
    /// Hash the user must echo back to resolve it.
    pub preview_hash: String,
    /// When it goes stale.
    pub stale_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub status: ToolOutcome,
    pub call_id: CallId,
    pub duration_ms: f64,
    pub output: Option<Value>,
    pub error: Option<ToolErrorInfo>,
    pub approval: Option<PendingApproval>,
    pub deduped: bool,
}

/// State of a call in the activity feed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    /// Started, not finished.
    Running,
    /// Completed.
    Ok,
    /// Failed.
    Error,
    /// Refused.
    Denied,
    /// Waiting for approval.
    PendingApproval,
}

impl From<ToolOutcome> for ToolCallStatus {
    fn from(o: ToolOutcome) -> Self {
        match o {
            ToolOutcome::Ok => ToolCallStatus::Ok,
            ToolOutcome::Error => ToolCallStatus::Error,
            ToolOutcome::Denied => ToolCallStatus::Denied,
            ToolOutcome::PendingApproval => ToolCallStatus::PendingApproval,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub call_id: CallId,
    pub tool: String,
    pub risk: RiskTier,
    pub origin: Origin,
    pub session_id: Option<SessionId>,
    pub input_hash: String,
    pub input: Value,
    pub status: ToolCallStatus,
    pub started_at: Timestamp,
    pub finished_at: Option<Timestamp>,
    pub duration_ms: Option<f64>,
    pub error: Option<ToolErrorInfo>,
    pub approval_id: Option<ApprovalId>,
    pub deduped: bool,
    pub idempotency_key: Option<String>,
    pub summary: Option<String>,
    pub approved_by: Option<ApprovalId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEvent {
    pub phase: ToolCallPhase,
    pub call: ToolCallRecord,
}

/// Phase of a `tool.calls` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallPhase {
    /// The call started.
    Started,
    /// The call finished (any outcome).
    Finished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    /// A Modify tool from a supervised session.
    Modify,
    /// A Financial tool (always a draft).
    Financial,
}

/// Approval lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    /// Waiting for the user.
    Pending,
    /// Approved and executed (see the linked call).
    Approved,
    /// Rejected by the user.
    Rejected,
    /// Expired before a decision; approving it fails.
    Stale,
    /// Replaced by an edited approval.
    Superseded,
    /// Withdrawn (session ended, draft cancelled).
    Cancelled,
}

impl ApprovalStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, ApprovalStatus::Pending)
    }
}

/// The user's decision in `approvals.resolve`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    /// Execute the call as previewed.
    Approve,
    /// Do not execute.
    Reject,
    /// Replace the input; a fresh preview and approval are created.
    Edit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolution {
    pub decision: ApprovalDecision,
    pub by: Origin,
    pub note: Option<String>,
    pub at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: ApprovalId,
    pub kind: ApprovalKind,
    pub status: ApprovalStatus,
    pub origin: Origin,
    pub session_id: Option<SessionId>,
    pub call_id: CallId,
    pub tool: String,
    pub risk: RiskTier,
    pub input: Value,
    pub preview: Value,
    pub preview_hash: String,
    pub draft_id: Option<DraftId>,
    pub environment: Option<Environment>,
    pub instrument: Option<InstrumentId>,
    pub created_at: Timestamp,
    pub stale_at: Timestamp,
    pub max_ticks: Option<u32>,
    pub ticks_seen: u32,
    pub resolution: Option<ApprovalResolution>,
    pub replaced_by: Option<ApprovalId>,
    pub replaces: Option<ApprovalId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ApprovalEvent {
    Snapshot { pending: Vec<Approval> },
    Requested { approval: Approval },
    Resolved { approval: Approval },
    Stale { approval: Approval },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    pub draft_id: DraftId,
    pub approval_id: ApprovalId,
    pub tool: String,
    pub account: String,
    #[serde(default)]
    pub environment: Option<Environment>,
    pub instrument: Option<InstrumentId>,
    pub preview: Value,
    pub live: bool,
    #[serde(default = "legacy_draft_status")]
    pub status: DraftStatus,
    pub origin: Origin,
    pub created_at: Timestamp,
    #[serde(default)]
    pub stale_at: Timestamp,
    #[serde(default)]
    pub error: Option<ToolErrorInfo>,
}

fn legacy_draft_status() -> DraftStatus {
    DraftStatus::Cancelled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_are_snake_case() {
        assert_eq!(
            serde_json::to_string(&RiskTier::Financial).unwrap(),
            "\"financial\""
        );
        assert_eq!(
            serde_json::to_string(&ToolOutcome::PendingApproval).unwrap(),
            "\"pending_approval\""
        );
        assert_eq!(
            serde_json::to_string(&SessionMode::AutoModify).unwrap(),
            "\"auto_modify\""
        );
        assert!(RiskTier::Read < RiskTier::Modify && RiskTier::Modify < RiskTier::Financial);
    }

    #[test]
    fn approval_event_is_tagged() {
        let v = serde_json::to_value(ApprovalEvent::Snapshot { pending: vec![] }).unwrap();
        assert_eq!(v, serde_json::json!({"type":"snapshot","pending":[]}));
    }
}
