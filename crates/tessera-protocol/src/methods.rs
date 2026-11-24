use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::capabilities::{IntelCapabilities, MarketCapabilities};
use tessera_core::ids::ApprovalId;
use tessera_core::token::Secret;
use tessera_core::{Environment, Timestamp};
use ts_rs::TS;

use crate::tools::{Approval, ApprovalDecision, ToolResult};

pub const PROTOCOL_VERSION: u32 = 1;

pub mod names {
    pub const SESSION_HELLO: &str = "session.hello";
    pub const TOOLS_LIST: &str = "tools.list";
    pub const TOOLS_INVOKE: &str = "tools.invoke";
    pub const SUBSCRIBE: &str = "subscribe";
    pub const UNSUBSCRIBE: &str = "unsubscribe";
    pub const APPROVALS_RESOLVE: &str = "approvals.resolve";
    pub const SESSION_PULSE: &str = "session.pulse";

    pub const ALL: [&str; 6] = [
        SESSION_HELLO,
        TOOLS_LIST,
        TOOLS_INVOKE,
        SUBSCRIBE,
        UNSUBSCRIBE,
        APPROVALS_RESOLVE,
    ];
}

/// Identifies the client in `session.hello`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ClientInfo {
    /// Client name (`tessera-desktop`).
    pub name: String,
    /// Client version.
    #[serde(default)]
    pub version: Option<String>,
    /// `tauri` or `browser`.
    #[serde(default)]
    pub platform: Option<String>,
}

/// `session.hello` params: the first message on a connection. Unless the upgrade request carried the session
/// token as `Authorization: Bearer` (what a non-browser client does), the hello proves the connection is the
/// user's with `token` or `ticket`; until it does the runtime answers nothing else, and a hello without
/// either is refused. Credentials never travel in the URL.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HelloParams {
    /// Client identity.
    #[serde(default)]
    pub client: Option<ClientInfo>,
    /// Protocol version the client speaks.
    #[serde(default)]
    pub protocol_version: Option<u32>,
    /// The runtime's session token: how a page proves itself (a browser cannot set headers on a WebSocket).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    #[schemars(with = "Option<String>")]
    pub token: Option<Secret>,
    /// A one-time ticket, when the page holds no token: its launch link's, or the reload ticket its previous
    /// connection was given (`HelloResult.reloadTicket`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    #[schemars(with = "Option<String>")]
    pub ticket: Option<Secret>,
    /// `true` asks the runtime for a `session.pulse` every second on this connection, so the client can tell
    /// how far behind its events it reads.
    #[serde(default)]
    pub pulse: Option<bool>,
}

/// `session.pulse` params: pushed through the same queue as the connection's events, once every `everyMs`, to
/// a connection whose `session.hello` asked for `pulse`. A pulse handled later than the ones before it were,
/// against `ms`, says by how much the client trails its events.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PulseParams {
    /// Milliseconds since the connection opened, on the runtime's monotonic clock.
    #[ts(type = "number")]
    pub ms: u64,
    /// Milliseconds until the next pulse.
    #[ts(type = "number")]
    pub every_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketProviderInfo {
    pub provider_id: String,
    pub display_name: String,
    pub capabilities: MarketCapabilities,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IntelProviderInfo {
    pub provider_id: String,
    pub display_name: String,
    pub capabilities: IntelCapabilities,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub methods: Vec<String>,
    pub topics: Vec<String>,
    pub tool_count: u32,
    pub market: Vec<MarketProviderInfo>,
    pub intel: Vec<IntelProviderInfo>,
    pub mcp: bool,
    pub agents: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub server_version: String,
    pub protocol_version: u32,
    pub connection_id: String,
    pub environment: Option<Environment>,
    pub server_time: Timestamp,
    pub default_layout_id: String,
    pub capabilities: ServerCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub reload_ticket: Option<Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub token: Option<Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub pulse_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ToolsListParams {
    /// Only tools of this category (`market`).
    #[serde(default)]
    pub category: Option<String>,
    /// Include UI-plumbing tools marked hidden.
    #[serde(default)]
    pub include_hidden: Option<bool>,
}

/// The state of the UI surface a `tools.invoke` was made from. Only the user's own calls carry it
/// (the UI socket); agents and MCP clients have no surface, and the gate ignores it for them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvokeSurface {
    /// The surface is armed (PAPER: one click sends).
    #[serde(default)]
    pub armed: bool,
    /// The user completed the environment's press-and-hold (EVAL, SIM: arming or sending by a
    /// hold). Set only by the UI, after the hold.
    #[serde(default)]
    pub hold_confirmed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ToolsInvokeParams {
    /// Tool name.
    pub name: String,
    /// Tool input (an object matching the tool's input schema).
    #[serde(default)]
    pub input: Value,
    /// Repeating a call with the same key returns the first result (marked `deduped`); a repeat
    /// sent while the first call still runs waits for it.
    #[serde(default)]
    pub idempotency_key: Option<String>,
    /// The surface the call was made from (orders: armed, hold confirmed). Absent: unarmed.
    #[serde(default)]
    pub surface: Option<InvokeSurface>,
    /// Latest OS-clock instant the runtime may start this call (UTC nanoseconds). The UI sets it
    /// to the same moment as its request timeout. Compared to the OS clock, not the session
    /// clock, so a hung process that wakes late is refused even when the sim clock is frozen.
    /// A call processed after this is refused and never forwarded to a broker.
    #[serde(default)]
    pub deadline: Option<Timestamp>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SubscribeParams {
    /// Topic name.
    pub topic: String,
    /// Topic params (see the topics table).
    #[serde(default)]
    pub params: Value,
    /// Replay recent events from the topic's buffer first (default true for low-rate topics).
    #[serde(default)]
    pub replay: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeResult {
    pub subscription_id: String,
    pub topic: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeParams {
    /// Subscription to cancel.
    pub subscription_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeResult {
    pub removed: bool,
}

/// `approvals.resolve` params. User only: never callable by agents or MCP clients.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ApprovalsResolveParams {
    /// Approval.
    pub approval_id: ApprovalId,
    /// Decision.
    pub decision: ApprovalDecision,
    /// Must equal the approval's current `previewHash`.
    pub preview_hash: String,
    /// Optional note.
    #[serde(default)]
    pub note: Option<String>,
    /// Replacement input, required for `edit`. On `approve`, the input that runs in place of the
    /// previewed one (the user's own change, such as their bracket on an agent's entry).
    #[serde(default)]
    pub input: Option<Value>,
    /// Same meaning as `ToolsInvokeParams.deadline`. Required on Approve so a hung runtime
    /// cannot send the draft after the trader was told there was no answer.
    #[serde(default)]
    pub deadline: Option<Timestamp>,
    /// Same meaning as `ToolsInvokeParams.idempotency_key`. Approve of the same click is one send.
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalsResolveResult {
    pub approval: Approval,
    pub result: Option<ToolResult>,
    pub replacement: Option<Approval>,
}
