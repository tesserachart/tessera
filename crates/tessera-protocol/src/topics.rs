use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::accounts::{AccountSummary, RiskStatus, TradingAccount};
use tessera_core::health::ProviderHealth;
use tessera_core::levels::Level;
use tessera_core::limits::LimitsStatus;
use tessera_core::orders::{Fill, Order, Position};
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use ts_rs::TS;

pub mod names {
    pub const MARKET_QUOTES: &str = "market.quotes";
    pub const MARKET_BARS: &str = "market.bars";
    pub const MARKET_HISTORY: &str = "market.history";
    pub const MARKET_TRADES: &str = "market.trades";
    pub const MARKET_DEPTH: &str = "market.depth";
    pub const MARKET_FOOTPRINT: &str = "market.footprint";
    pub const INTEL_LEVELS: &str = "intel.levels";
    pub const ORDERS: &str = "orders";
    pub const POSITIONS: &str = "positions";
    pub const ACCOUNTS: &str = "accounts";
    pub const FILLS: &str = "fills";
    pub const PROTECTION: &str = "protection";
    pub const DRAFTS: &str = "drafts";
    pub const APPROVALS: &str = "approvals";
    pub const AGENT_SESSION: &str = "agent.session";
    pub const AGENT_SESSIONS: &str = "agent.sessions";
    pub const SETTINGS: &str = "settings";
    pub const TOOL_CALLS: &str = "tool.calls";
    pub const HEALTH: &str = "health";
    pub const RESEARCH_RUN: &str = "research.run";
    pub const CARDS: &str = "cards";
    pub const NOTIFICATIONS: &str = "notifications";
    pub const LAYOUT: &str = "layout";
    pub const CAPABILITIES: &str = "capabilities";
    pub const ACCOUNT: &str = "account";
}

/// Params of topics that take none.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct NoParams {}

/// Params naming a set of instruments. Symbols are resolved like `market.search_instruments`
/// (`NQ` → front contract).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentsParams {
    /// Instruments or symbols.
    pub instruments: Vec<String>,
}

/// Params naming one instrument.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentParams {
    /// Instrument or symbol.
    pub instrument: String,
}

/// Params for bar and footprint subscriptions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BarsParams {
    /// Instrument or symbol.
    pub instrument: String,
    /// Timeframe.
    pub tf: Timeframe,
}

/// Params filtering account-scoped topics.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AccountParams {
    /// Account id; all accounts if omitted.
    #[serde(default)]
    pub account_id: Option<String>,
}

/// Params for one agent session's transcript.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AgentSessionParams {
    /// Session id.
    pub session_id: String,
    /// Replay events after this sequence number first.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub after_seq: Option<u64>,
}

/// Filters for the tool-call feed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ToolCallsParams {
    /// Only calls from this agent session.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Only calls from this origin kind (`user`, `agent`, `external`).
    #[serde(default)]
    pub origin: Option<String>,
}

/// Params for research run progress.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRunParams {
    /// Run id.
    pub run_id: String,
}

/// Params for layout changes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LayoutParams {
    /// Layout id; the active layout if omitted.
    #[serde(default)]
    pub layout_id: Option<String>,
}

/// `intel.levels` payload, and the output of `intel.get_levels`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LevelsUpdate {
    /// Instrument the prices apply to (resolved id, e.g. `NQZ6.CME` for `NQ`).
    pub instrument: InstrumentId,
    /// Current levels, vendor identity preserved; converted levels carry their conversion.
    pub levels: Vec<Level>,
    /// Snapshot time.
    pub as_of: Timestamp,
    /// Id of the provider that produced the snapshot (`acme`, `tessera-concepts`).
    pub provider: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrderUpdate {
    pub order: Order,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionNote {
    pub account_id: String,
    pub instrument: InstrumentId,
    pub text: String,
    pub tone: String,
    pub call_id: String,
    pub ts: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PositionUpdate {
    pub position: Position,
}

/// `accounts` payload, and one entry of `portfolio.get_accounts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountUpdate {
    /// The account: name, environment (always shown), connection.
    pub account: TradingAccount,
    /// The account summary.
    pub summary: AccountSummary,
    /// The rules its firm's platform reports for it (a prop evaluation or funded account), as the
    /// platform reports them: informational, unless the user holds the account to them
    /// (Settings › Trading and risk, "Use my firm's limits").
    pub risk: Option<RiskStatus>,
    /// Where it stands against the trader's own limits (Settings › Trading and risk); absent while none is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limits: Option<LimitsStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FillUpdate {
    pub fill: Fill,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HealthUpdate {
    pub providers: Vec<ProviderHealth>,
    pub prices_down: Vec<String>,
}

/// Severity of a notification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NotificationLevel {
    /// Informational.
    Info,
    /// Warning.
    Warn,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub level: NotificationLevel,
    pub title: String,
    pub body: Option<String>,
    pub source: Option<String>,
    pub ts: Timestamp,
}
