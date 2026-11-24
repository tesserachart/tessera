use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::time::Timestamp;

/// Coarse health state that drives the status-bar dots.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    /// Connected and current.
    Ok,
    /// Working with problems (lag, partial data, retrying).
    Degraded,
    /// Expected to work but failing.
    Down,
    /// Not connected (by choice or not configured).
    Disconnected,
    /// Not yet known.
    Unknown,
    /// Turned off by the user: nothing of it runs or is checked (an agent provider the user has not turned on).
    Disabled,
}

/// What kind of provider a health record describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    MarketData,
    /// Market intelligence (levels, gamma).
    Intelligence,
    /// Broker / order routing.
    Broker,
    /// AI agent provider.
    Agent,
    /// MCP server or client.
    Mcp,
    /// The Tessera runtime itself (storage, event bus, tool pipeline).
    Runtime,
}

/// Where a provider's login stands, for a provider that logs in and keeps a session open.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ConnectionPhase {
    /// Not started, or stopped by the user; nothing logs in until it is started again.
    Stopped,
    /// Logging in for the first time since it was started.
    Connecting,
    /// Logged in and serving.
    Live,
    /// The connection dropped and is logging in again by itself.
    Reconnecting {
        /// The try under way, counted from 1.
        attempt: u32,
        /// Why the connection dropped, in the provider's words.
        reason: String,
    },
    /// Logged out together with another connection of the same login; logs in again once that one is back.
    Waiting,
    /// The provider ended the session; it stays logged out until the user reconnects.
    LoggedOut,
    /// Another session of the same login took over; it stays logged out until the user reconnects.
    TakenOver,
    /// The provider refused the login; it stays logged out until the user reconnects.
    Refused {
        /// The provider's reason.
        reason: String,
    },
    /// The provider could not be reached; it stays logged out until the user reconnects.
    Unreachable {
        /// What failed, in the transport's words.
        reason: String,
    },
}

impl ConnectionPhase {
    pub fn status(&self) -> HealthStatus {
        match self {
            Self::Live => HealthStatus::Ok,
            Self::Connecting => HealthStatus::Unknown,
            Self::Stopped => HealthStatus::Disconnected,
            Self::Reconnecting { .. } | Self::Waiting => HealthStatus::Degraded,
            Self::LoggedOut | Self::TakenOver | Self::Refused { .. } | Self::Unreachable { .. } => {
                HealthStatus::Down
            }
        }
    }

    pub fn coming_back(&self) -> bool {
        matches!(
            self,
            Self::Connecting | Self::Reconnecting { .. } | Self::Waiting
        )
    }

    pub fn without_prices(&self) -> String {
        match self {
            Self::Live => "is live".into(),
            Self::Stopped => "is not connected".into(),
            Self::Connecting => "is still logging in".into(),
            Self::Reconnecting { .. } | Self::Waiting => "dropped and is reconnecting".into(),
            Self::LoggedOut => "was logged out; reconnect it in Connections".into(),
            Self::TakenOver => {
                "was logged out because another session of this login took over".into()
            }
            Self::Refused { .. } => "had its login refused".into(),
            Self::Unreachable { .. } => "cannot be reached".into(),
        }
    }
}

/// Health of one provider instance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    /// Stable provider id (`rithmic-apex`, `paper`, `acme`).
    pub provider_id: String,
    /// Provider kind.
    pub kind: ProviderKind,
    /// Display name (`Apex · Rithmic`).
    pub display_name: String,
    /// Health state.
    pub status: HealthStatus,
    /// Recent round-trip or feed latency in milliseconds, if measured.
    pub latency_ms: Option<f64>,
    /// When the provider last delivered data (provider timestamp when available).
    pub last_message_at: Option<Timestamp>,
    /// Human-readable detail the status and the connection phase do not already say (`No depth for NQZ6.CME: …`).
    pub message: Option<String>,
    /// Where the provider's login stands, for a provider that logs in and keeps a session open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connection: Option<ConnectionPhase>,
    /// For a login that serves both prices and accounts: where its account connection stands, when that differs from `connection` and is not live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accounts: Option<ConnectionPhase>,
    /// When this record was produced.
    pub checked_at: Timestamp,
}
