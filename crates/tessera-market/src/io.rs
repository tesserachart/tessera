use crate::aggregate::FootprintChanges;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Aggressor, AggressorSource, DataSource, FootprintBar};
use tessera_core::session::{MarketHoliday, SessionHours, TradingSession};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_protocol::compact::{CompactBar, CompactCell, CompactLevel, CompactTrade};
use ts_rs::TS;

/// `market.get_quote` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetQuoteInput {
    /// Instrument id or symbol (`NQ`, `NQZ6`, `NQZ6.CME-RITHMIC`).
    pub instrument: String,
}

/// Which part of the session to include.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum SessionFilter {
    /// Every bar the provider has (equities: pre/post market where available).
    #[default]
    All,
    /// Regular trading hours only (US cash session 09:30–16:00 ET).
    Rth,
}

/// `market.get_candles` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetCandlesInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// Timeframe: a count of s, m, h or D, e.g. 15s 1m 7m 90m 2h 1D 2D.
    pub tf: Timeframe,
    /// Earliest bar open time (inclusive).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// Latest bar open time (inclusive). Defaults to now.
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Maximum number of bars, newest kept (default 500, max 5000).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Session filter (default `all`).
    #[serde(default)]
    pub session: Option<SessionFilter>,
    /// Answer at once from the bars kept on this machine, without asking the connection: the
    /// newest bars kept without a gap that end at `to` (or, without `to`, the newest kept). May
    /// be empty or end before now.
    #[serde(default)]
    pub cached_only: Option<bool>,
    /// Daily (`1D`) bars of a dated equity-index future only: continue the history back through the
    /// earlier quarterly contracts, each from the roll date on which it became the front month, so
    /// the chart reads like the front month's history (`contracts` names where each stretch came
    /// from). Unadjusted: every bar is its own contract's real bar, so a roll can leave a price gap
    /// (the spread between the two contracts). Other timeframes and products answer as without it.
    #[serde(default)]
    pub front_months: Option<bool>,
}

/// A stretch of bars that came from one contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContractRun {
    /// The contract the bars belong to.
    pub instrument: InstrumentId,
    /// Open time of its first bar.
    pub from: Timestamp,
    /// Open time of its last bar.
    pub to: Timestamp,
}

/// `market.get_candles` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CandlesOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Timeframe.
    pub tf: Timeframe,
    /// Decimals to render prices with.
    pub price_decimals: u32,
    /// Exchange time zone for axis labels.
    pub tz: String,
    /// Column order of `bars` (`bv`, aggressive buy volume, only on bars whose feed knows it).
    pub columns: Vec<String>,
    /// Bars `[t, o, h, l, c, v, bv?]`, oldest first.
    pub bars: Vec<CompactBar>,
    /// True when the last bar is still forming.
    pub last_bar_open: bool,
    /// Provider id.
    pub provider: String,
    /// With `frontMonths`, when earlier contracts supplied some of the bars: which contract each
    /// stretch came from, oldest first (`instrument` above stays the contract asked for). Omitted
    /// when every bar is that contract's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub contracts: Option<Vec<ContractRun>>,
}

/// `market.search_instruments` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SearchInstrumentsInput {
    /// Free text: symbol, root, name or exchange. Empty lists everything.
    #[serde(default)]
    pub query: String,
    /// Restrict to an asset class.
    #[serde(default)]
    pub asset_class: Option<AssetClass>,
    /// Maximum results (default 20).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `market.search_instruments` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchInstrumentsOutput {
    /// Matches, best first.
    pub results: Vec<Instrument>,
}

/// `market.list_instruments` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ListInstrumentsInput {
    /// Only this connection (an id from connections.list); default: every market-data connection.
    #[serde(default)]
    pub connection: Option<String>,
    /// Restrict to an asset class.
    #[serde(default)]
    pub asset_class: Option<AssetClass>,
    /// Most instruments per connection (default 500, 1–2000).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `market.list_instruments` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListInstrumentsOutput {
    /// Each market-data connection with what it serves, the one feeding the desk first.
    pub connections: Vec<ListedConnection>,
}

/// One market-data connection and the instruments it serves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListedConnection {
    /// Connection id (`rithmic-apex`).
    pub id: String,
    /// Its display name.
    pub display_name: String,
    /// The desk's market data comes from it now (market.dataSource: every exchange without a
    /// connection of its own in market.dataByExchange).
    pub feeds_desk: bool,
    /// What it serves, as it lists them (a futures connection: each product's front month); empty when it lists
    /// nothing or could not answer.
    pub instruments: Vec<Instrument>,
    /// Why it could not answer (still logging in, down), when it could not.
    pub error: Option<String>,
}

/// `market.get_contract_spec` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetContractSpecInput {
    /// Instrument id or symbol.
    pub instrument: String,
}

/// `market.get_contract_spec` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContractSpecOutput {
    /// The instrument.
    pub instrument: Instrument,
    /// Its contract spec.
    pub spec: ContractSpec,
}

/// `market.get_sessions` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetSessionsInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// First trade date, `YYYY-MM-DD`. Default: the trade date before the current one.
    #[serde(default)]
    #[ts(as = "Option<String>")]
    pub from: Option<chrono::NaiveDate>,
    /// Last trade date, inclusive, at most 366 days after `from`. Default: the trade date after the current one.
    #[serde(default)]
    #[ts(as = "Option<String>")]
    pub to: Option<chrono::NaiveDate>,
}

/// `market.get_sessions` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionsOutput {
    /// The instrument.
    pub instrument: InstrumentId,
    /// The hours of its calendar.
    pub hours: SessionHours,
    /// Its trading sessions from `from` to `to`, oldest first: each one's open, close, the windows it trades
    /// in, and its regular session (RTH).
    pub sessions: Vec<TradingSession>,
    /// Weekdays in the range with no session of their own.
    pub holidays: Vec<MarketHoliday>,
}

/// `market.get_print_bars` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetPrintBarsInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// What closes each bar: `{"kind":"tick","size":500}` (every 500 prints), `{"kind":"range","size":10}`
    /// (high to low within 10 ticks), `{"kind":"volume","size":1000}` (every 1000 contracts),
    /// `{"kind":"delta","size":300}` (net delta of 300 either way) or `{"kind":"renko","size":10}` (bricks
    /// 10 ticks tall).
    pub bars: crate::orderflow::print_bars::PrintBars,
    /// Sessions to build, the current one and those before it (default 2, at most 5).
    #[serde(default)]
    pub sessions: Option<u32>,
}

/// Session time with no saved or recorded prints: nothing in it is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrintGap {
    /// Start (inclusive).
    pub from: Timestamp,
    /// End (exclusive).
    pub to: Timestamp,
}

pub const DEFAULT_DAYS_TO_LOAD: u32 = 2;
pub const MAX_DAYS_TO_LOAD: u32 = 60;

/// How much of the sessions a study loads the answer holds: while `held` is under `sessions` and
/// the answer is `filling`, the rest is on its way.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrintsLoaded {
    /// Sessions within the days to load that the answer covers.
    pub sessions: u32,
    /// Of those, the sessions whose prints are all saved or recorded.
    pub held: u32,
    /// The connection refused the prints the other sessions are missing, or serves none that old:
    /// they stay missing, and the span is not asked for again before the next session.
    pub refused: bool,
}

/// `market.get_print_bars` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrintBarsOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// What closes each bar.
    pub bars: crate::orderflow::print_bars::PrintBars,
    /// Decimals to render prices with.
    pub price_decimals: u32,
    /// Column order of `candles`.
    pub columns: Vec<String>,
    /// Bars `[t, o, h, l, c, v, bv]` (t: the bar's first print), oldest first.
    pub candles: Vec<CompactBar>,
    /// True when the last bar is still forming.
    pub last_bar_open: bool,
    /// Spans of session time the bars were built over with no saved or recorded prints (closed hours and
    /// weekends are never gaps): nothing there is known, so it is missing history, not a quiet
    /// market.
    pub gaps: Vec<PrintGap>,
    /// The runtime is asking the connection's tick replay for some of `gaps`: ask again shortly
    /// and they shrink. False with gaps left: nothing more is coming for now; a span the connection refused is not asked for again before the next session.
    pub filling: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BarUpdate {
    pub instrument: InstrumentId,
    pub tf: Timeframe,
    pub bar: CompactBar,
    pub closed: bool,
    pub source: DataSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryUpdate {
    pub instrument: InstrumentId,
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    pub filling: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TradesUpdate {
    pub instrument: InstrumentId,
    #[ts(type = "number")]
    pub seq: u64,
    pub trades: Vec<CompactTrade>,
    pub aggressor_source: Option<AggressorSource>,
    pub source: DataSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub big_trades: Option<Vec<BigTrade>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub segment: Option<u64>,
}

/// A size filter: at least this many, or `auto`, Tessera's threshold for big trades
/// ([`BigTradeThreshold`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(untagged)]
pub enum MinSize {
    Auto(AutoSize),
    /// At least this size.
    Size(Qty),
}

/// The word `auto`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutoSize {
    /// Tessera picks the size.
    Auto,
}

/// `market.get_trades` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetTradesInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// Earliest print time (inclusive).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// Prints strictly before this time (default: up to the latest print).
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Maximum number of rows, newest kept (default 500, max 10000).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Only rows of at least this size: a number, or `auto` for the big-trade threshold (the
    /// answer's `threshold` says what it was).
    #[serde(default)]
    pub min_size: Option<MinSize>,
    /// Join the prints of one aggressor order into one row (its size, average price and print
    /// count), as the bubbles and the time & sales show them.
    #[serde(default)]
    pub aggregate: Option<bool>,
}

/// Tessera's big-trade size for one instrument **now**: the smallest aggressor event its Auto
/// rule calls big on the trade date of the call (`orderflow::big_trades`). Auto sizes each trade
/// date from the trailing five sessions, so the size holds for the whole day; this is the Low
/// cut, never below the contract's floor or the minimum notional (the floor alone while the model
/// is still sizing).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BigTradeThreshold {
    /// Events at least this size are big now.
    pub size: Qty,
    /// The floor for the contract.
    pub floor: Qty,
    /// Aggressor events with a side the model read.
    #[ts(type = "number")]
    pub orders: u64,
    /// Sessions read (whole, or the recording's part of one).
    pub sessions: u32,
}

/// `market.get_trades` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradesOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Decimals to render prices with.
    pub price_decimals: u32,
    /// Column order of `trades`.
    pub columns: Vec<String>,
    /// Prints `[t, price, size, side, order?]`, oldest first; side 1 buy, -1 sell, 0 unknown;
    /// order the aggressor order's key when the feed names it. Aggregated: one row per order, at
    /// its first print's time and its size-weighted average price.
    pub trades: Vec<CompactTrade>,
    /// Rows are aggressor orders (`aggregate`): `prints` says how many prints each joined.
    pub aggregated: bool,
    /// Prints joined into each row, when `aggregated` (empty otherwise).
    pub prints: Vec<u32>,
    /// The price each row's last print traded at, when `aggregated` (empty otherwise): where an
    /// order's sweep ended, on the tick grid, as a tape shows it beside the order's average.
    pub last: Vec<f64>,
    /// The big-trade threshold `minSize: "auto"` applied.
    pub threshold: Option<BigTradeThreshold>,
    /// Where the aggressor side came from (`exchange`, `inferred`, …), when any print has one.
    pub aggressor_source: Option<AggressorSource>,
    /// Spans of session time the rows were read over with no saved or recorded prints (closed hours and
    /// weekends are never gaps): nothing there is known, so it is missing history, not a quiet
    /// market.
    pub gaps: Vec<PrintGap>,
    /// The runtime is asking the connection's tick replay for some of `gaps`: ask again shortly
    /// and they shrink. False with gaps left: nothing more is coming for now; a span the connection refused is not asked for again before the next session.
    pub filling: bool,
    /// Older rows were left out: `from` was given and `limit` was reached, or (filtered or
    /// aggregated without `from`) the read stopped at its budget of prints.
    pub truncated: bool,
    /// Provider id.
    pub provider: String,
}

/// `market.depth` params.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct DepthParams {
    /// Instrument or symbol.
    pub instrument: String,
    /// Levels per side (the provider's maximum if omitted, and never more).
    #[serde(default)]
    pub levels: Option<u32>,
}

/// Whether a depth update replaces the book or changes some of its levels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DepthKind {
    /// The whole book (at the subscription's depth): replace what you hold.
    Snapshot,
    /// Only the levels that changed: set each level's size and order count; size `0` removes
    /// the level. Then keep the best `levels` per side.
    Delta,
    /// Nothing changed for a second: the book at `seq` still stands (`bids` and `asks` are
    /// empty). Sent only while the book is known, so a ladder that hears nothing for two seconds
    /// knows its book is stale. A heartbeat whose `seq` is above the book held means updates were
    /// missed: resubscribe.
    Heartbeat,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DepthUpdate {
    pub instrument: InstrumentId,
    pub ts: Timestamp,
    #[ts(type = "number")]
    pub seq: u64,
    pub kind: DepthKind,
    pub levels: u32,
    pub bids: Vec<CompactLevel>,
    pub asks: Vec<CompactLevel>,
    pub source: DataSource,
}

/// `market.get_depth` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetDepthInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// Levels per side (default 20, at most what the connection offers).
    #[serde(default)]
    pub levels: Option<u32>,
}

/// `market.get_depth` output: the resting book now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DepthOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Book time.
    pub ts: Timestamp,
    /// Decimals to render prices with.
    pub price_decimals: u32,
    /// Bids `[[price, size, orders?], …]`, best first.
    pub bids: Vec<CompactLevel>,
    /// Asks `[[price, size, orders?], …]`, best first.
    pub asks: Vec<CompactLevel>,
    /// Provider id.
    pub provider: String,
}

/// `market.footprint` params.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct FootprintParams {
    /// Instrument or symbol.
    pub instrument: String,
    /// Timeframe.
    pub tf: Timeframe,
    /// Ticks per row (default 1).
    #[serde(default)]
    pub row_ticks: Option<u32>,
}

/// A footprint bar on the wire: per-price aggressor volume of one bar.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompactFootprint {
    /// Bar open time.
    pub t: Timestamp,
    /// Row height in price units.
    pub row: Price,
    /// Rows `[price, bidVolume, askVolume, trades]`, lowest price first; `price` is the row's floor
    /// and `trades` the count of prints there.
    pub cells: Vec<CompactCell>,
    /// Point of control: the row with the most volume.
    pub poc: Option<Price>,
    /// Total volume.
    pub volume: Qty,
    /// Ask minus bid volume (buyers lifting minus sellers hitting).
    pub delta: Qty,
    /// The highest the running delta reached within the bar, from 0 at its open print by print
    /// (with `deltaLow` and `delta`, the bar's delta candle; the cumulative delta candle adds the
    /// cumulative delta before the bar). Null when the path is not known.
    pub delta_high: Option<Qty>,
    /// The lowest the running delta reached within the bar (see `deltaHigh`).
    pub delta_low: Option<Qty>,
    /// Where the aggressor split came from.
    pub aggressor_source: AggressorSource,
}

impl CompactFootprint {
    pub fn of_changes(c: &FootprintChanges) -> Self {
        Self {
            t: c.bar.t,
            row: c.bar.bucket,
            cells: c.bar.cells.iter().map(CompactCell::from).collect(),
            poc: c.bar.poc,
            volume: c.bid + c.ask,
            delta: c.ask - c.bid,
            delta_high: c.bar.delta_high,
            delta_low: c.bar.delta_low,
            aggressor_source: c.bar.aggressor_source,
        }
    }
}

impl From<&FootprintBar> for CompactFootprint {
    fn from(b: &FootprintBar) -> Self {
        let (bid, ask) = b.cells.iter().fold((Qty::ZERO, Qty::ZERO), |(b0, a0), c| {
            (b0 + c.bid_volume, a0 + c.ask_volume)
        });
        Self {
            t: b.t,
            row: b.bucket,
            cells: b.cells.iter().map(CompactCell::from).collect(),
            poc: b.poc,
            volume: bid + ask,
            delta: ask - bid,
            delta_high: b.delta_high,
            delta_low: b.delta_low,
            aggressor_source: b.aggressor_source,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FootprintUpdate {
    pub instrument: InstrumentId,
    pub tf: Timeframe,
    pub bar: CompactFootprint,
    pub closed: bool,
    pub partial: bool,
    #[ts(type = "number | null")]
    pub seq: Option<u64>,
    pub source: DataSource,
}

/// `market.get_footprint` input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetFootprintInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// Timeframe: a count of s, m, h or D, e.g. 15s 1m 7m 90m 2h 1D 2D.
    pub tf: Timeframe,
    /// Earliest bar open time (inclusive).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// Latest bar open time (inclusive). Defaults to now.
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Maximum number of bars, newest kept (default 20, max 200).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Ticks per row (default: the round height that fits the widest bar in 40 rows).
    #[serde(default)]
    pub row_ticks: Option<u32>,
    /// Sessions whose missing prints the call asks the connection for, the current one counting
    /// as one (default 2, 1–60). Older bars are built from saved prints only.
    #[serde(default)]
    pub days_to_load: Option<u32>,
    /// Diagonal imbalance ratio for `stackedImbalances` (default 3 = 300%, 1.5–20).
    #[serde(default)]
    pub imbalance_ratio: Option<f64>,
    /// Volume the imbalanced side must reach for `stackedImbalances` (default 5; the chart's
    /// footprint setting of the same name).
    #[serde(default)]
    pub imbalance_min_volume: Option<f64>,
    /// How far the imbalanced side must exceed the side it is compared with, in contracts, for
    /// `stackedImbalances` (default 0; the chart's footprint "Min difference").
    #[serde(default)]
    pub imbalance_min_difference: Option<f64>,
    /// Count a side compared with an empty row as an imbalance, N against 0 (default false; the
    /// chart's footprint "Include zero").
    #[serde(default)]
    pub imbalance_include_zero: Option<bool>,
}

/// Three or more adjacent footprint rows of one bar where one side's aggression was at least the
/// ratio times the other's on the diagonal (buyers at a row against sellers one row below; sellers
/// against buyers one row above), at least the minimum volume, and ahead of the other side by at
/// least the minimum difference. A side against an empty row (N against 0) counts only when zero is
/// included; rows outside the bar are never compared.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StackedImbalance {
    /// Bar open time.
    pub t: Timestamp,
    /// The side in control: `buy` (lifting offers) or `sell` (hitting bids).
    pub side: Aggressor,
    /// Lowest row's floor.
    pub low: Price,
    /// Highest row's floor.
    pub high: Price,
    /// Rows stacked.
    pub rows: u32,
}

/// `market.get_footprint` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FootprintOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Timeframe.
    pub tf: Timeframe,
    /// Decimals to render prices with.
    pub price_decimals: u32,
    /// Row height in price units.
    pub row: Price,
    /// Bars, oldest first, each built from every one of its prints; a bar with no prints is
    /// left out.
    pub bars: Vec<CompactFootprint>,
    /// Older bars asked for were left out: the call read its budget of prints.
    pub truncated: bool,
    /// Spans of session time the bars cover with no saved or recorded prints (closed hours and
    /// weekends are never gaps): nothing there is known, so it is missing history, not a quiet
    /// market.
    pub gaps: Vec<PrintGap>,
    /// The runtime is asking the connection's tick replay for some of `gaps`: ask again shortly
    /// and they shrink. False with gaps left: nothing more is coming for now; a span the connection refused is not asked for again before the next session.
    pub filling: bool,
    /// How much of the days to load the answer holds.
    pub loaded: PrintsLoaded,
    /// Open of the oldest bar the answer accounts for, with a footprint or not: ask with `to`
    /// just before it for older bars. Null: the connection has no older bar.
    pub first_open: Option<Timestamp>,
    /// The diagonal imbalance ratio used.
    pub imbalance_ratio: f64,
    /// The minimum volume of the imbalanced side used.
    pub imbalance_min_volume: f64,
    /// The minimum difference between the two sides used.
    pub imbalance_min_difference: f64,
    /// Whether a side against an empty row counted as an imbalance.
    pub imbalance_include_zero: bool,
    /// Stacked imbalances of the bars, oldest first.
    pub stacked_imbalances: Vec<StackedImbalance>,
    /// True when the last bar is still forming.
    pub last_bar_open: bool,
    /// Provider id.
    pub provider: String,
}

/// `market.get_depth_history` input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetDepthHistoryInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// Start of the span (default: 30 minutes before `to`).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// End of the span, exclusive (default: now).
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Lowest price to include.
    #[serde(default)]
    pub price_from: Option<f64>,
    /// Highest price to include.
    #[serde(default)]
    pub price_to: Option<f64>,
    /// Levels per side (default 10, max 50), largest mean first.
    #[serde(default)]
    pub top: Option<u32>,
}

/// Bid or ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RestingSide {
    /// Resting bids.
    Bid,
    /// Resting asks.
    Ask,
}

/// One price's resting size over a span of the recording.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DepthLevelStat {
    /// Price.
    pub price: f64,
    /// Bid or ask.
    pub side: RestingSide,
    /// Mean resting size over the recorded time of the span (time without size counts as zero).
    pub mean_size: f64,
    /// The largest one-second mean.
    pub max_size: f64,
    /// Times its size fell: fills and cancels alike (a measured count, not a reading of intent).
    #[ts(type = "number")]
    pub decreases: u64,
    /// Share of the recorded time it had size (0–1).
    pub presence: f64,
}

/// `market.get_depth_history` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DepthHistoryOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Decimals to render prices with.
    pub price_decimals: u32,
    /// Price step.
    pub tick: f64,
    /// Start of the span.
    pub from: Timestamp,
    /// End of the span (exclusive).
    pub to: Timestamp,
    /// The earliest recorded column: nothing before it is known (the recorder only moves
    /// forward).
    pub recorded_from: Option<Timestamp>,
    /// True while the book is being recorded.
    pub recording: bool,
    /// Milliseconds of the span a recorded book covers.
    #[ts(type = "number")]
    pub recorded_ms: u64,
    /// Largest resting bids by mean size.
    pub bids: Vec<DepthLevelStat>,
    /// Largest resting asks by mean size.
    pub asks: Vec<DepthLevelStat>,
    /// Provider id.
    pub provider: String,
}

/// Which span a volume profile covers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfileMode {
    /// One profile per trading session (the newest `count` sessions).
    #[default]
    Session,
    /// One profile per calendar day in the exchange's time zone, midnight to midnight (the newest
    /// `count` days).
    Day,
    /// One profile per trading week: the sessions whose trade dates fall in one Monday-to-Sunday
    /// week (the newest `count` weeks).
    Week,
    /// One profile per month: the sessions whose trade dates fall in one calendar month (the
    /// newest `count` months).
    Month,
    /// One profile of `from`–`to` (a chart's visible range, a fixed range).
    Range,
    /// One profile of the newest `count` periods (`period`, default sessions) together.
    Composite,
}

/// The span each profile of a period mode covers, and the unit a composite merges.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ProfilePeriod {
    /// A trading session (for CME futures it opens the evening before its trade date).
    #[default]
    Session,
    /// A calendar day in the exchange's time zone.
    Day,
    /// A trading week (trade dates Monday to Sunday).
    Week,
    /// A calendar month of trade dates.
    Month,
}

impl ProfilePeriod {
    pub fn as_str(self) -> &'static str {
        match self {
            ProfilePeriod::Session => "session",
            ProfilePeriod::Day => "day",
            ProfilePeriod::Week => "week",
            ProfilePeriod::Month => "month",
        }
    }
}

impl ProfileMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ProfileMode::Session => "session",
            ProfileMode::Day => "day",
            ProfileMode::Week => "week",
            ProfileMode::Month => "month",
            ProfileMode::Range => "range",
            ProfileMode::Composite => "composite",
        }
    }

    pub fn period(self) -> Option<ProfilePeriod> {
        match self {
            ProfileMode::Session => Some(ProfilePeriod::Session),
            ProfileMode::Day => Some(ProfilePeriod::Day),
            ProfileMode::Week => Some(ProfilePeriod::Week),
            ProfileMode::Month => Some(ProfilePeriod::Month),
            ProfileMode::Range | ProfileMode::Composite => None,
        }
    }
}

/// `market.get_volume_profile` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetVolumeProfileInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// `session` (default), `day`, `week`, `month`, `range` or `composite`.
    #[serde(default)]
    pub mode: Option<ProfileMode>,
    /// The period a `composite` merges: `session` (default), `day`, `week` or `month`.
    #[serde(default)]
    pub period: Option<ProfilePeriod>,
    /// How many periods: one profile each in `session`, `day`, `week` and `month` modes (default
    /// 1), merged in `composite` mode (default 5, reaching back only as far as prints are held);
    /// 1 or more.
    #[serde(default)]
    pub count: Option<u32>,
    /// The older name of `count`.
    #[serde(default)]
    pub sessions: Option<u32>,
    /// Start of the range (`range` mode, required).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// End of the range in `range` mode (default now: an anchored profile); in the other modes the
    /// newest period is the one trading at this time (default now).
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Session part in every mode: `all` (default) or `rth`, each session's regular hours only.
    #[serde(default)]
    pub session: Option<SessionFilter>,
    /// Also count the span in time, as a Market Profile: each profile gains `tpo`, with one bracket
    /// per this many minutes (1–240; 30 is the classic) from each session's open.
    #[serde(default)]
    pub tpo_minutes: Option<u32>,
    /// Row height in ticks (default: the smallest round height that fits `maxRows`); kept up to 4,000 rows, past
    /// which taller rows are used.
    #[serde(default)]
    pub row_ticks: Option<u32>,
    /// Most rows a profile returns (default 60, max 500); taller profiles use taller rows.
    #[serde(default)]
    pub max_rows: Option<u32>,
    /// Share of the volume in the value area, in percent (default 70, 1–99).
    #[serde(default)]
    pub value_area_percent: Option<f64>,
    /// Sessions whose missing prints the call asks the connection for, the current one counting
    /// as one (default 2, 1–60). Older ones are read from saved prints only.
    #[serde(default)]
    pub days_to_load: Option<u32>,
}

/// A volume profile row as `[price, volume, buyVolume, sellVolume]`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct CompactProfileRow(pub Price, pub Qty, pub Qty, pub Qty);

/// One volume profile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileOutput {
    /// Start of the span.
    pub from: Timestamp,
    /// End of the span (exclusive).
    pub to: Timestamp,
    /// The period's scheduled end (the period modes). Later than `to` while the period is still
    /// trading: `to` is when it was read, and its prints from then on are still to come.
    pub session_end: Option<Timestamp>,
    /// The session's trade date (`session` mode); the day itself (`day`); the first trade date of
    /// the week or month (`week`, `month`).
    #[ts(type = "string | null")]
    #[schemars(with = "Option<String>")]
    pub trade_date: Option<chrono::NaiveDate>,
    /// Row height in price units.
    pub row: Price,
    /// Point of control: floor of the row with the most volume (the row spans `poc` to
    /// `poc + row` less a tick).
    pub poc: Option<Price>,
    /// Value area high: the highest price it covers (the top tick of its highest row, at most
    /// the traded high).
    pub vah: Option<Price>,
    /// Value area low: the lowest price it covers (the floor of its lowest row, at least the
    /// traded low).
    pub val: Option<Price>,
    /// Volume inside the value area.
    pub value_area_volume: Qty,
    /// Total volume (prints without a side included).
    pub volume: Qty,
    /// Buyers lifting the offer.
    pub buy_volume: Qty,
    /// Sellers hitting the bid.
    pub sell_volume: Qty,
    /// `buyVolume − sellVolume`.
    pub delta: Qty,
    /// Highest traded price.
    pub high: Option<Price>,
    /// Lowest traded price.
    pub low: Option<Price>,
    /// With `tpoMinutes`: the same prints counted in time (Market Profile).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tpo: Option<TpoOutput>,
    /// Prints counted.
    #[ts(type = "number")]
    pub prints: u64,
    /// First print counted.
    pub first_print: Option<Timestamp>,
    /// Last print counted.
    pub last_print: Option<Timestamp>,
    /// Spans of session time in the profile's span with no saved or recorded prints: the profile
    /// counts every other print, so with gaps it is not the whole span's.
    pub gaps: Vec<PrintGap>,
    /// Rows `[price, volume, buyVolume, sellVolume]` with volume, lowest first.
    pub rows: Vec<CompactProfileRow>,
}

/// A Market Profile bracket as `[start, letter, low, high]`: its start, its place in its session
/// counted from the session's open (0 is the open's bracket, read as `A`), and the lowest and
/// highest prices traded in it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct CompactTpoBracket(pub Timestamp, pub u32, pub Price, pub Price);

/// A profile counted in time (Market Profile, TPO): each bracket of `minutes` marks every price
/// from its low to its high once, so a price's count is how many brackets traded there.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TpoOutput {
    /// Minutes each bracket covers.
    pub minutes: u32,
    /// Brackets with prints, oldest first; letters start again at each session's open.
    pub brackets: Vec<CompactTpoBracket>,
    /// TPO point of control: floor of the row the most brackets traded in (rows as the profile's).
    pub poc: Option<Price>,
    /// TPO value area high: the highest price of the band around `poc` holding the value-area
    /// share of the brackets' marks.
    pub vah: Option<Price>,
    /// TPO value area low.
    pub val: Option<Price>,
    /// Start of the initial balance: the regular open of the profile's first session (its session
    /// open where it has no regular hours); absent when the profile does not reach it.
    pub ib_from: Option<Timestamp>,
    /// Initial balance high: the highest price of the hour from `ibFrom`.
    pub ib_high: Option<Price>,
    /// Initial balance low.
    pub ib_low: Option<Price>,
}

/// `market.get_volume_profile` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VolumeProfileOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Decimals to render prices with.
    pub price_decimals: u32,
    /// The mode answered.
    pub mode: ProfileMode,
    /// The period each profile covers (period modes) or the composite merged; absent for `range`.
    pub period: Option<ProfilePeriod>,
    /// Share of the volume in each value area, in percent.
    pub value_area_percent: f64,
    /// Column order of each profile's `rows`.
    pub columns: Vec<String>,
    /// Profiles, oldest first.
    pub profiles: Vec<ProfileOutput>,
    /// The runtime is asking the connection's tick replay for some of the profiles' `gaps`: ask
    /// again shortly and they shrink.
    pub filling: bool,
    /// How much of the days to load the answer holds.
    pub loaded: PrintsLoaded,
    /// Where the buy/sell split came from, when any print has a side.
    pub aggressor_source: Option<AggressorSource>,
    /// Provider id.
    pub provider: String,
}

/// `market.get_big_trades` input. Auto (the default) or Manual, never both: `minSize` or
/// `maxSize` asks for Manual, `tiers` for Auto.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetBigTradesInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// Earliest event (default: 60 minutes before `to`).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// Events strictly before this time (default: now).
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Auto: events in these tiers of Tessera's cuts (default all three).
    #[serde(default)]
    pub tiers: Option<Vec<BigTradeTier>>,
    /// Manual: events of at least this many lots; 0 is the contract's default (ES 30, NQ 12,
    /// any other contract 2). Tessera's floors do not apply.
    #[serde(default)]
    pub min_size: Option<Qty>,
    /// Manual: events of at most this many lots; 0 is no limit.
    #[serde(default)]
    pub max_size: Option<Qty>,
    /// Join an aggressor order's fills into one event whatever the gap or price: prints of one
    /// order key, and prints at one exchange time when no key tells orders apart (default true).
    /// Off, prints join only by the 5 ms chain.
    #[serde(default)]
    pub join_orders: Option<bool>,
    /// Stop an event 2 ticks past its extreme: a continuing print lands at most 2 ticks beyond
    /// the event's highest price (a buy) or lowest (a sell) (default true). Off, a sweep walks
    /// any number of levels. With both this and joinOrders off, prints join by the 5 ms chain
    /// alone.
    #[serde(default)]
    pub reach_limit: Option<bool>,
    /// Most trades returned, newest kept (default 50, max 5000).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Sessions whose missing prints the call asks the connection for, the current one counting
    /// as one (default 2, 1–60). Older ones are read from saved prints only.
    #[serde(default)]
    pub days_to_load: Option<u32>,
}

/// How big an event is for its trade date, by Auto's cuts ([`BigTradeCuts`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BigTradeTier {
    /// At least the High cut: about the 15 largest events of a session.
    High,
    /// At least the Medium cut: about the 45 largest.
    Medium,
    /// At least the Low cut, the least big: about the 120 largest.
    Low,
}

/// Which big trades show.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BigTradeMode {
    /// Tessera's floors and cuts, the tiers chosen.
    Auto,
    /// At least a size, and at most another when set.
    Manual,
}

/// Auto's cuts for a trade date, measured from the events of the trailing sessions that clear the
/// floors: the sizes of about the 120th, 45th and 15th largest event per session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BigTradeCuts {
    /// Smallest Low event, in lots.
    pub low: Qty,
    /// Smallest Medium event.
    pub medium: Qty,
    /// Smallest High event.
    pub high: Qty,
}

/// What the market did after a big trade, decided by the first print that settles it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BigTradeOutcomeKind {
    /// A later print reached `reachTicks` back past the event's average price, against it: the
    /// other side held.
    Absorbed,
    /// A later print reached `reachTicks` past the event's far price (its highest for a buy, its
    /// lowest for a sell), its way: it moved the market.
    Pushed,
    /// 60 seconds passed after its last print with neither.
    Neither,
}

/// A big trade's outcome: the first of pushed, absorbed or 60 seconds with neither.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BigTradeOutcome {
    /// What happened.
    pub kind: BigTradeOutcomeKind,
    /// When: the print that decided it, or 60 seconds after the event's last print for neither.
    pub decided: Timestamp,
    /// The ticks a print had to reach: half the median one-minute high-to-low range of the model's
    /// sessions in the event's half hour of its session on the instrument's calendar (the whole
    /// session's when that half hour has none), at least 2.
    pub reach_ticks: u32,
}

/// One big aggressor event: the prints of one aggressor order, or of orders that continued it
/// within the continuation window (a sweep or a burst split across messages).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BigTrade {
    /// Time of its first print.
    pub t: Timestamp,
    /// Nanoseconds from its first print to its last.
    #[ts(type = "number")]
    pub duration_ns: i64,
    /// The side that crossed the spread.
    pub side: Aggressor,
    /// Total size.
    pub size: Qty,
    /// Size-weighted average price.
    pub price: Price,
    /// First print's price.
    pub first_price: Price,
    /// Last print's price.
    pub last_price: Price,
    /// Prices it printed at.
    pub levels: u32,
    /// Ticks from its lowest price to its highest.
    pub range_ticks: u32,
    /// Prints it was reported as (its fills).
    pub prints: u32,
    /// Aggressor orders joined (more than one: orders continued it within the window).
    pub orders: u32,
    /// Its tier by Auto's cuts for its trade date, in either mode; none below the Low cut, under
    /// the floors (the contract's floor lots, $500k notional), or while the model is still
    /// sizing.
    pub tier: Option<BigTradeTier>,
    /// What the market did next (`market.get_big_trades`); null while the prints that decide it
    /// are not in yet, and in the live stream (`market.trades`).
    pub outcome: Option<BigTradeOutcome>,
    /// The hub's number of its first print (`market.trades` numbering), when found live.
    #[ts(type = "number | null")]
    pub seq: Option<u64>,
}

/// The rule a big-trade answer used.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BigTradeRule {
    /// The mode applied.
    pub mode: BigTradeMode,
    /// Auto: the tiers shown, highest first.
    pub tiers: Option<Vec<BigTradeTier>>,
    /// Manual: the smallest size shown, in lots (the contract's default when asked for 0).
    pub min_size: Option<Qty>,
    /// Manual: the largest size shown, in lots; none: no limit.
    pub max_size: Option<Qty>,
    /// Auto's cuts, from the model of `to`'s trade date (they tier the events in both modes);
    /// null while the model is still sizing (under 60 minutes of events in its sessions).
    pub cuts: Option<BigTradeCuts>,
    /// Auto: the smallest big event on the contract, whatever the cuts.
    pub floor: Qty,
    /// Auto: the smallest notional (size × price × multiplier) of a big event.
    pub min_notional: f64,
    /// The contract's multiplier: one lot's notional per point of price.
    pub multiplier: f64,
    /// Whether an aggressor order's fills joined into one event whatever the gap or price.
    pub join_orders: bool,
    /// Whether an event stopped 2 ticks past its extreme.
    pub reach_limit: bool,
    /// Prints of other orders on the same side within this many ms, not retreating, continue an
    /// event.
    pub continuation_ms: f64,
    /// The smallest size shown on the trade date of `to`.
    pub size_now: Qty,
    /// Aggressor events with a side the model read.
    #[ts(type = "number")]
    pub model_orders: u64,
    /// Sessions the model read.
    pub model_sessions: u32,
    /// Minutes of those sessions that held an event: the cuts' counts scale by them over the
    /// minutes of one of those sessions on the instrument's calendar.
    pub model_minutes: u32,
    /// The ticks an outcome needs, by half hour from the open of the trade date's session on the
    /// instrument's calendar (`reachFrom`): half the median one-minute high-to-low range of the
    /// model's sessions in that half hour (the whole session's when it has none), at least 2.
    /// Empty while there is no model; a half hour past the list needs 2.
    pub reach_ticks: Vec<u32>,
    /// The open of the trade date's session that `reachTicks` counts half hours from; null when
    /// that date has no session.
    pub reach_from: Option<Timestamp>,
}

/// Big trades by tier (the rest have none: Manual's events below the Low cut or under the floors,
/// or any while the model is still sizing).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BigTradeTierCounts {
    /// High.
    pub high: u32,
    /// Medium.
    pub medium: u32,
    /// Low.
    pub low: u32,
}

/// `market.get_big_trades` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BigTradesOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Decimals to render prices with.
    pub price_decimals: u32,
    /// Start of the span.
    pub from: Timestamp,
    /// End of the span (exclusive).
    pub to: Timestamp,
    /// The rule applied.
    pub rule: BigTradeRule,
    /// Big trades, oldest first (the newest `limit`).
    pub trades: Vec<BigTrade>,
    /// Big trades in the span (more than `trades` when cut to `limit`).
    pub count: u32,
    /// Of them, by tier.
    pub tiers: BigTradeTierCounts,
    /// Their buy volume.
    pub buy_volume: Qty,
    /// Their sell volume.
    pub sell_volume: Qty,
    /// Aggressor events in the span.
    #[ts(type = "number")]
    pub orders: u64,
    /// Spans of session time from `from` to `to` with no saved or recorded prints (closed hours and
    /// weekends are never gaps): nothing there is known, so it is missing history, not a quiet
    /// market.
    pub gaps: Vec<PrintGap>,
    /// The runtime is asking the connection's tick replay for some of `gaps`, or for the model's
    /// sessions: ask again shortly. False with gaps left: nothing more is coming for now; a span the connection refused is not asked for again before the next session.
    pub filling: bool,
    /// How much of the days to load the answer holds.
    pub loaded: PrintsLoaded,
    /// Where the sides came from.
    pub aggressor_source: Option<AggressorSource>,
    /// Provider id.
    pub provider: String,
}

/// `market.get_delta` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetDeltaInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// Timeframe: a count of s, m, h or D, e.g. 15s 1m 7m 90m 2h 1D 2D.
    pub tf: Timeframe,
    /// Earliest bar open time (inclusive).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// Latest bar open time (inclusive). Defaults to now.
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Maximum number of bars, newest kept (default 100, max 1000).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Where cumulative delta starts again: `session` (default) or `none`.
    #[serde(default)]
    pub reset: Option<crate::orderflow::delta::DeltaReset>,
}

/// A delta bar as `[t, volume, buyVolume, sellVolume, delta, cumDelta]`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct CompactDeltaBar(pub Timestamp, pub Qty, pub Qty, pub Qty, pub Qty, pub Qty);

/// What a delta answer was computed from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeltaBasis {
    /// Every bar's own buy volume.
    Bars,
    /// The prints of every bar.
    Prints,
    /// Some bars from their buy volume, some from prints.
    Mixed,
}

/// `market.get_delta` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeltaOutput {
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Timeframe.
    pub tf: Timeframe,
    /// Where cumulative delta starts again.
    pub reset: crate::orderflow::delta::DeltaReset,
    /// Column order of `bars`.
    pub columns: Vec<String>,
    /// Bars `[t, volume, buyVolume, sellVolume, delta, cumDelta]`, oldest first.
    pub bars: Vec<CompactDeltaBar>,
    /// Bars left out because their buy/sell split is unknown (cumulative delta skips them).
    pub missing: u32,
    /// Earlier bars of the first session whose split is unknown: cumulative delta should have
    /// counted them and does not (0 when it is whole).
    pub missing_before: u32,
    /// What the split came from (none when no bar has one).
    pub basis: Option<DeltaBasis>,
    /// True when the last bar is still forming.
    pub last_bar_open: bool,
    /// Where the prints' sides came from, when prints were read.
    pub aggressor_source: Option<AggressorSource>,
    /// Spans of session time the bars cover with no saved or recorded prints (closed hours and
    /// weekends are never gaps): nothing there is known, so it is missing history, not a quiet
    /// market. A bar that touches one is counted in `missing`.
    pub gaps: Vec<PrintGap>,
    /// The runtime is asking the connection's tick replay for some of `gaps`: ask again shortly
    /// and they shrink. False with gaps left: nothing more is coming for now; a span the connection refused is not asked for again before the next session.
    pub filling: bool,
    /// Provider id.
    pub provider: String,
}

/// A replay of a saved day: its own instrument, the day it plays and where its clock stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplayState {
    /// The replay's own instrument id (`NQZ6-R1.CME`): chart, footprint and time and sales take
    /// it like any instrument. It takes no orders. A jump to another time gives a new id.
    pub instrument: InstrumentId,
    /// The saved contract it plays.
    pub contract: InstrumentId,
    /// The connection that served the saved prints.
    pub source: String,
    /// The trade date it plays.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub trade_date: chrono::NaiveDate,
    /// Start of the saved prints of the day.
    pub from: Timestamp,
    /// End of the saved prints of the day (exclusive).
    pub to: Timestamp,
    /// The replay clock: every print before it has played.
    pub cursor: Timestamp,
    /// The clock is running.
    pub playing: bool,
    /// How many seconds of the day play per second.
    pub speed: u32,
    /// The bars saved on this machine before the day's saved prints, which its charts show first.
    pub earlier: EarlierBars,
}

/// How far the bars saved before a replay's day reach.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EarlierBars {
    /// Every trading minute from the open of the trading day before to the day's first saved print
    /// has its bar.
    Whole,
    /// The latest stretch of trading time in that span with no saved bar.
    Gap {
        /// Start of the stretch (UTC ns).
        from: Timestamp,
        /// End of the stretch (UTC ns).
        to: Timestamp,
    },
    /// No bar before the day's first saved print is saved.
    Missing,
}

/// One saved trade date of a contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedDayInfo {
    /// The trade date.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub trade_date: chrono::NaiveDate,
    /// Start of the saved prints.
    pub from: Timestamp,
    /// End of the saved prints (exclusive).
    pub to: Timestamp,
    /// How many prints are saved.
    #[ts(type = "number")]
    pub prints: u64,
}

/// A contract's saved trade dates, as one connection served them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedContractDays {
    /// The dated contract (`NQZ6.CME`).
    pub instrument: InstrumentId,
    /// The connection that served its prints.
    pub source: String,
    /// Its saved trade dates, oldest first.
    pub days: Vec<SavedDayInfo>,
}

/// `market.list_replay_days` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ListReplayDaysInput {
    /// Only this contract: a saved contract's id (`NQZ6.CME`) or symbol (`NQZ6`).
    #[serde(default)]
    pub instrument: Option<String>,
}

/// `market.list_replay_days` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListReplayDaysOutput {
    /// Every contract with saved days.
    pub contracts: Vec<SavedContractDays>,
}

/// `market.open_replay` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct OpenReplayInput {
    /// The saved contract (`NQZ6.CME`, or its symbol), as `market.list_replay_days` lists it.
    pub instrument: String,
    /// The connection that saved it, when more than one did.
    #[serde(default)]
    pub source: Option<String>,
    /// The trade date to play (YYYY-MM-DD).
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub trade_date: chrono::NaiveDate,
    /// Where the clock starts (RFC 3339). Default: the cash open, or the first saved print.
    #[serde(default)]
    pub at: Option<Timestamp>,
    /// Seconds of the day per second, 1 to 600 (default 1).
    #[serde(default)]
    pub speed: Option<u32>,
    /// Start playing at once (default true).
    #[serde(default)]
    pub playing: Option<bool>,
}

/// `market.control_replay` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ControlReplayInput {
    /// The replay's instrument id (`NQZ6-R1.CME`).
    pub instrument: String,
    /// Play (true) or pause (false).
    #[serde(default)]
    pub playing: Option<bool>,
    /// Seconds of the day per second, 1 to 600.
    #[serde(default)]
    pub speed: Option<u32>,
    /// Jump the clock to this time of the saved day (RFC 3339). The replay continues under a
    /// new instrument id, which the output names; the old id closes.
    #[serde(default)]
    pub at: Option<Timestamp>,
}

/// `market.get_replays` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetReplaysInput {
    /// Only this replay (`NQZ6-R1.CME`).
    #[serde(default)]
    pub instrument: Option<String>,
}

/// `market.get_replays` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplaysOutput {
    /// The open replays.
    pub replays: Vec<ReplayState>,
}

/// `market.close_replay` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseReplayInput {
    /// The replay's instrument id (`NQZ6-R1.CME`).
    pub instrument: String,
}

/// `market.close_replay` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloseReplayOutput {
    /// The replay was open and is now closed.
    pub closed: bool,
}
