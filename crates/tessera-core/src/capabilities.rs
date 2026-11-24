use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::accounts::Environment;
use crate::instrument::AssetClass;
use crate::market::AggressorSource;
use crate::orders::{OrderType, TimeInForce};
use crate::timeframe::Timeframe;

/// What a market-data provider can do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketCapabilities {
    /// Timeframes available from `get_bars`. Any timeframe built from a listed one is available too:
    /// 2m and 90m from 1m, 2D from 1D, 15s from 1s.
    pub history_timeframes: Vec<Timeframe>,
    /// Timeframes available as live bar subscriptions, built the same way.
    pub live_timeframes: Vec<Timeframe>,
    /// Live top-of-book quotes.
    pub quotes: bool,
    /// Live trades (time & sales).
    pub trades: bool,
    /// Live depth, with the maximum number of levels per side.
    pub depth_levels: Option<u32>,
    /// Footprint bars, which the desk builds from prints that carry an aggressor side. The
    /// market router reports it for any connection whose prints do.
    pub footprint: bool,
    /// Asset classes served.
    pub asset_classes: Vec<AssetClass>,
    /// How far back intraday history goes, in days.
    pub max_intraday_history_days: Option<u32>,
    /// How far back daily history goes, in days.
    pub max_daily_history_days: Option<u32>,
    /// Data arrives in real time (not delayed or replayed).
    pub realtime: bool,
    /// Where trade aggressor flags come from.
    pub aggressor_source: Option<AggressorSource>,
}

impl MarketCapabilities {
    pub fn serves_history(&self, tf: Timeframe) -> bool {
        builds(&self.history_timeframes, tf)
    }

    pub fn serves_live(&self, tf: Timeframe) -> bool {
        builds(&self.live_timeframes, tf)
    }

    pub fn order_flow(&self) -> bool {
        self.trades && self.aggressor_source.is_some()
    }
}

fn builds(listed: &[Timeframe], tf: Timeframe) -> bool {
    listed.contains(&tf) || listed.contains(&tf.base().unwrap_or(Timeframe::S1))
}

/// What a market-intelligence provider (levels, gamma) can do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntelCapabilities {
    /// Vendor name (`Acme`).
    pub vendor: String,
    /// Packages the account is entitled to (`Classic`, `State`, `Orderflow`).
    pub packages: Vec<String>,
    /// Price levels.
    pub levels: bool,
    /// Strike or price profiles.
    pub profiles: bool,
    /// Price-space conversions (e.g. NDX → NQ).
    pub conversions: bool,
    /// Point-in-time history.
    pub history: bool,
    /// Streaming updates.
    pub realtime: bool,
    /// Polled only during regular trading hours.
    pub rth_only: bool,
}

/// What a broker adapter can do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrokerCapabilities {
    /// Supported order types.
    pub order_types: Vec<OrderType>,
    /// Supported time-in-force values.
    pub time_in_force: Vec<TimeInForce>,
    /// Native bracket orders.
    pub brackets: bool,
    /// Native OCO orders.
    pub oco: bool,
    /// Order modification.
    pub modify: bool,
    /// Read-only (accounts, fills, P&L) — no order entry on this connection.
    pub read_only: bool,
    /// Environments this adapter can serve.
    pub environments: Vec<Environment>,
    /// Fractional quantities (crypto).
    pub fractional_qty: bool,
    /// Moves a bracket's stop by its breakeven and trailing rules itself; without it, Tessera
    /// moves the stop while it runs.
    pub stop_rules: bool,
}

/// How an agent provider authenticates. `api_key` is reserved and unused in the MVP.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AgentAuthType {
    /// The user's own signed-in CLI (Codex, Claude Code).
    SubscriptionCli,
    /// A local model endpoint (Ollama, LM Studio).
    Local,
    /// An external MCP client driving Tessera's tools.
    McpExternal,
    /// Reserved; not surfaced in the MVP.
    ApiKey,
}

/// What an agent provider can do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    /// Can call tools.
    pub tools: bool,
    /// Accepts images.
    pub vision: bool,
    /// Emits reasoning summaries.
    pub reasoning: bool,
    /// Streams deltas.
    pub streaming: bool,
    /// Can resume an earlier session.
    pub resume: bool,
    /// How it authenticates.
    pub auth: AgentAuthType,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listed_resolution_serves_every_timeframe_built_from_it() {
        let tf = |s: &str| s.parse::<Timeframe>().unwrap();
        let minutes_and_days = [Timeframe::M1, Timeframe::D1];
        assert!(builds(&minutes_and_days, tf("7m")));
        assert!(builds(&minutes_and_days, tf("90m")));
        assert!(builds(&minutes_and_days, tf("3h")));
        assert!(builds(&minutes_and_days, tf("2D")));
        assert!(!builds(&minutes_and_days, tf("15s")));
        assert!(builds(&[Timeframe::S1], tf("15s")));
        assert!(builds(&[Timeframe::S1], tf("90s")));
        assert!(!builds(&[Timeframe::S1], tf("2m")));
        assert!(builds(&[Timeframe::M5], Timeframe::M5));
    }
}
