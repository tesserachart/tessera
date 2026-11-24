use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::InstrumentId;
use ts_rs::TS;

/// How a ticket sizes its entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TicketSizing {
    /// A number of contracts (`qty`).
    Qty,
    /// The money at risk at the stop (`risk`): the size comes from the stop the user clicks.
    Risk,
}

/// Which contract of the chart's family a ticket trades.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteAs {
    /// The charted contract.
    Chart,
    /// The family's full-size contract (NQ on an MNQ chart).
    Full,
    /// The family's micro (MNQ on an NQ chart).
    Micro,
}

/// How a bracket leg's distance is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OcoUnit {
    Ticks,
    Points,
    /// Dollars for the whole position.
    Usd,
    /// Percent of the account's balance.
    Pct,
}

/// A bracket leg (the stop loss or the take profit), as a change: what is absent keeps its value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct OcoLegInput {
    /// The leg goes with entries.
    #[serde(default)]
    pub on: Option<bool>,
    /// The unit `value` is in.
    #[serde(default)]
    pub unit: Option<OcoUnit>,
    /// Its distance from the entry, in `unit` (above 0).
    #[serde(default)]
    pub value: Option<f64>,
}

/// The stop's breakeven rule, as a change.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct BreakevenInput {
    /// On.
    #[serde(default)]
    pub on: Option<bool>,
    /// Once the trade is this many ticks in profit (1–1000)…
    #[serde(default)]
    pub trigger: Option<u32>,
    /// …the stop moves to the entry plus this many ticks (−100–100), once.
    #[serde(default)]
    pub offset: Option<i32>,
}

/// The stop's trailing rule, as a change.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TrailInput {
    /// On.
    #[serde(default)]
    pub on: Option<bool>,
    /// The stop follows the best price this many ticks behind it, only ever tighter (1–1000)…
    #[serde(default)]
    pub ticks: Option<u32>,
    /// …once the trade is this many ticks in profit (0–1000; 0 is from the fill)…
    #[serde(default)]
    pub trigger: Option<u32>,
    /// …moving this many ticks at a time (1–1000; 1 is every tick).
    #[serde(default)]
    pub step: Option<u32>,
}

/// The bracket (OCO) every entry from the panel carries, as a change.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct OcoInput {
    /// The bracket goes with entries at all.
    #[serde(default)]
    pub on: Option<bool>,
    /// The stop loss.
    #[serde(default)]
    pub stop: Option<OcoLegInput>,
    /// The take profit.
    #[serde(default)]
    pub target: Option<OcoLegInput>,
    /// The stop's breakeven rule.
    #[serde(default)]
    pub breakeven: Option<BreakevenInput>,
    /// The stop's trailing rule.
    #[serde(default)]
    pub trail: Option<TrailInput>,
}

/// `trade.set_panel` input: the fields to change, the others keep their value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TradeSetPanelInput {
    /// The chart whose panel this is (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The account the chart trades (portfolio.get_accounts).
    #[serde(default)]
    pub account_id: Option<String>,
    /// Contracts per entry (1–1000), when sizing by quantity.
    #[serde(default)]
    pub qty: Option<u32>,
    /// Size by quantity, or by the money at risk at the stop.
    #[serde(default)]
    pub sizing: Option<TicketSizing>,
    /// The money at risk at the stop when sizing by risk, in the account's currency (above 0).
    #[serde(default)]
    pub risk: Option<f64>,
    /// A stop limit's limit, in whole ticks past its stop (0–99).
    #[serde(default)]
    pub stop_limit_ticks: Option<u32>,
    /// Which contract of the family the panel trades.
    #[serde(default)]
    pub execute: Option<ExecuteAs>,
    /// The bracket section open (true) or folded to its row (false).
    #[serde(default)]
    pub bracket_open: Option<bool>,
    /// The breakeven and trailing rules shown under the legs (true) or folded (false).
    #[serde(default)]
    pub rules_open: Option<bool>,
    /// The bracket for the chart's account and instrument.
    #[serde(default)]
    pub oco: Option<OcoInput>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TradeGetPanelInput {
    /// The chart (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

/// A chart's ticket as `trade.get_panel` reads it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TicketView {
    /// The account it trades; null: the account new tickets start with (the one last picked), else the first.
    pub account_id: Option<String>,
    /// Contracts per entry.
    pub qty: u32,
    /// How it sizes.
    pub sizing: TicketSizing,
    /// The money at risk when sizing by risk.
    pub risk: f64,
    /// A stop limit's offset in ticks.
    pub stop_limit_ticks: u32,
    /// Which contract of the family it trades.
    pub execute: ExecuteAs,
    /// The bracket section open.
    pub bracket_open: bool,
    /// The breakeven and trailing rules shown.
    pub rules_open: bool,
    /// The chart has a ticket of its own (else it starts from the workspace's, or the defaults).
    pub own: bool,
}

/// A bracket the workspace keeps for an account and an instrument root, as stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OcoEntry {
    /// The account.
    pub account_id: String,
    /// The instrument root (`NQ`, `MNQ`).
    pub root: String,
    /// `{on, stop: {on, unit, value}, target: {on, unit, value}, breakeven: {on, trigger, offset}, trail: {on,
    /// ticks, trigger, step}}`.
    pub oco: Value,
}

/// `trade.get_panel` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradePanelOutput {
    /// Layout id.
    pub layout_id: String,
    /// The chart.
    pub tile_id: String,
    /// What the chart shows.
    pub instrument: InstrumentId,
    /// Its ticket.
    pub ticket: TicketView,
    /// The brackets the workspace keeps, per account and root (an entry absent: the default, a 40-tick stop and an
    /// 80-tick target).
    pub brackets: Vec<OcoEntry>,
}
