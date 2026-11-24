use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tessera_core::market::AggressorSource;
use tessera_core::timeframe::PrintBars;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_market::io::{PrintsLoaded, SessionFilter};
use tessera_protocol::indicators::{IndicatorObjects, IndicatorSpec};
use tessera_protocol::layers::LayerKind;
use ts_rs::TS;

/// A built-in indicator: computed on the chart, declared in the registry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinIndicator {
    /// Its layer kind (`rsi`).
    pub kind: LayerKind,
    /// What it takes and draws.
    pub spec: IndicatorSpec,
    /// What it computes.
    pub description: String,
}

/// A custom indicator (its latest version, unless a version was asked for).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CustomIndicator {
    /// Id (`ci_…`): a chart's `custom` layer names it in `params.indicator`.
    pub id: String,
    /// The version described.
    pub version: u32,
    /// The latest version.
    pub latest: u32,
    /// What it takes and draws, read from its code (`kind` is `custom`, `group` is `custom`).
    pub spec: IndicatorSpec,
    /// What it computes, in its author's words (`description`, or the comment its code opens with).
    pub description: Option<String>,
    /// Created.
    #[ts(type = "number")]
    pub created_at: Timestamp,
    /// Last saved.
    #[ts(type = "number")]
    pub updated_at: Timestamp,
    /// Who created it: `user`, `agent` or `external`.
    pub created_by: String,
}

/// Whether custom indicators can run here, and inside what.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    /// Custom indicators can run here (the engine is built in: always).
    pub available: bool,
    /// Why they cannot, when they cannot.
    pub reason: Option<String>,
    /// The engine that runs them (`QuickJS-ng`).
    pub engine: String,
    /// The walls around user code, in plain words.
    pub walls: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListIndicatorsInput {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorsListOutput {
    /// Built-in indicators, in registry order.
    pub builtins: Vec<BuiltinIndicator>,
    /// Custom indicators, oldest first.
    pub custom: Vec<CustomIndicator>,
    /// Whether custom indicators can run here.
    pub sandbox: SandboxStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetIndicatorInput {
    /// A custom indicator's id (`ci_…`) or a built-in's kind (`rsi`).
    pub id: String,
    /// A custom indicator's saved version (its latest when omitted).
    #[serde(default)]
    pub version: Option<u32>,
}

/// One saved version of a custom indicator.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorVersionInfo {
    /// Version.
    pub version: u32,
    /// Saved.
    #[ts(type = "number")]
    pub created_at: Timestamp,
    /// Who saved it: `user`, `agent` or `external`.
    pub created_by: String,
    /// What changed.
    pub note: Option<String>,
}

/// `indicators.get` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorDetail {
    /// The built-in, when the id is a kind.
    pub builtin: Option<BuiltinIndicator>,
    /// The custom indicator, when the id is one.
    pub custom: Option<CustomIndicator>,
    /// A custom indicator's code (at the version described).
    pub code: Option<String>,
    /// A custom indicator's saved versions, newest first.
    pub versions: Vec<IndicatorVersionInfo>,
}

/// `indicators.create_custom` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CreateCustomInput {
    /// JavaScript: `export const indicator = { title, inputs, plots, … }` and
    /// `export function compute(bars, inputs)` returning an object of plot name to an array as long
    /// as the bars; it may also draw lines, labels and boxes with `draw` (docs/indicators.md).
    pub code: String,
    /// What it is for, kept with the version.
    #[serde(default)]
    pub note: Option<String>,
}

/// `indicators.update_custom` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct UpdateCustomInput {
    /// The custom indicator.
    pub id: String,
    /// The new JavaScript (saved as a new version; earlier versions are kept).
    pub code: String,
    /// What changed.
    #[serde(default)]
    pub note: Option<String>,
    /// The version the edit started from: refused when another save came in between.
    #[serde(default)]
    pub base_version: Option<u32>,
}

/// `indicators.delete_custom` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteCustomInput {
    /// The custom indicator.
    pub id: String,
}

/// `indicators.delete_custom` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCustomOutput {
    /// It existed and is gone, with every version.
    pub deleted: bool,
}

/// `indicators.compute` input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ComputeInput {
    /// A custom indicator's id (`ci_…`), or a built-in's kind (`rsi`).
    pub indicator: String,
    /// A custom indicator's saved version (the latest when omitted).
    #[serde(default)]
    pub version: Option<u32>,
    /// Input values by key; omitted inputs take their defaults.
    #[serde(default)]
    #[ts(type = "Record<string, number | string | boolean>")]
    pub inputs: Option<Map<String, Value>>,
    /// Instrument id or symbol (`NQ`, `QQQ`).
    pub instrument: String,
    /// Timeframe.
    pub tf: Timeframe,
    /// Earliest bar open time (inclusive).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// Latest bar open time (inclusive).
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Bars returned, newest kept (default 500, at most 20000). The values are the ones the
    /// runtime keeps for these bars, the chart's when a chart shows them, so an average may be
    /// seeded before the first bar returned: `computedFrom` says where.
    #[serde(default)]
    pub limit: Option<u32>,
    /// Return only the last N values of each series (default: all).
    #[serde(default)]
    pub tail: Option<u32>,
    /// Which hours the bars cover (default: all).
    #[serde(default)]
    pub session: Option<SessionFilter>,
}

/// `indicators.preview` input: unsaved code over live bars.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct PreviewInput {
    /// JavaScript (as `indicators.create_custom` takes it).
    pub code: String,
    /// Input values by key; omitted inputs take their defaults.
    #[serde(default)]
    #[ts(type = "Record<string, number | string | boolean>")]
    pub inputs: Option<Map<String, Value>>,
    /// Instrument id or symbol.
    pub instrument: String,
    /// Timeframe.
    pub tf: Timeframe,
    /// Bars computed over, newest kept (default 500, at most 20000).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Return only the last N values of each series (default: all).
    #[serde(default)]
    pub tail: Option<u32>,
}

/// One computed series.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPlot {
    /// Plot key.
    pub key: String,
    /// Plot label.
    pub label: String,
    /// One value per bar of `time`; null where the indicator has none (warm-up, gaps).
    pub values: Vec<Option<f64>>,
}

/// `indicators.compute` / `indicators.preview` output: measured values of the indicator over the
/// bars, one per bar.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorSeries {
    /// The custom indicator (empty for a preview).
    pub indicator: String,
    /// The version computed (none for a preview).
    pub version: Option<u32>,
    /// Its declaration, read from the code that ran.
    pub spec: IndicatorSpec,
    /// What it computes.
    pub description: Option<String>,
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Timeframe.
    pub tf: Timeframe,
    /// The input values used (defaults filled in).
    #[ts(type = "Record<string, number | string | boolean>")]
    pub inputs: Map<String, Value>,
    /// Bar open times (UTC ns), one per value.
    #[ts(type = "number[]")]
    pub time: Vec<Timestamp>,
    /// One series per line and histogram plot.
    pub plots: Vec<SeriesPlot>,
    /// The lines, labels and boxes it drew (`draw`), the newest 500 of each kind; with
    /// `tail`, those that reach the values returned.
    pub objects: IndicatorObjects,
    /// Bars computed over.
    pub bars: u32,
    /// The first bar open (UTC ns) the values are computed from: averages and running totals
    /// start there. Null when there are no bars.
    pub computed_from: Option<Timestamp>,
    /// Time inside `compute`, ms.
    pub compute_ms: f64,
    /// Time of the whole run, the engine's start included (it runs on one thread), ms.
    pub cpu_ms: f64,
    /// What the code printed.
    pub logs: String,
    /// The market-data connection the bars came from.
    pub provider: String,
}

/// `indicators.series` params: an indicator's values over an instrument's bars, kept current as
/// bars form and close: a built-in study (`ema`, `rsi`, the volume pane `volume`), delta and CVD
/// (`delta`) or a custom indicator (`ci_…`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SeriesParams {
    /// A built-in's kind (`ema`, `delta`) or a custom indicator's id (`ci_…`).
    pub indicator: String,
    /// A custom indicator's saved version; the latest when omitted (a save resends everything).
    #[serde(default)]
    pub version: Option<u32>,
    /// Input values by key; omitted inputs take their defaults.
    #[serde(default)]
    #[ts(type = "Record<string, number | string | boolean>")]
    pub inputs: Option<Map<String, Value>>,
    /// Instrument id or symbol.
    pub instrument: String,
    /// Timeframe.
    pub tf: Timeframe,
    /// Which hours the bars cover (default: all).
    #[serde(default)]
    pub session: Option<SessionFilter>,
    /// The first bar open (UTC ns) the values must cover, such as a chart's first bar; the newest
    /// 1,500 bars when omitted. `indicators.reach` extends it.
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// The chart's tick, range, volume, delta or renko bars; time bars when omitted.
    #[serde(default)]
    pub print_bars: Option<PrintBars>,
}

/// Why a series has no values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeriesError {
    /// What went wrong, in plain words (`line 12: TypeError: cannot read property 'x' of undefined`).
    pub message: String,
    /// The line of the code it points at.
    pub line: Option<u32>,
}

/// Which held values an `indicators.series` update replaces.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Replaces {
    /// Every value held before (a snapshot, a new version, another connection's bars).
    All,
    /// The values of bars opening in `[from, to]`; a bar of that span missing from `time` has none.
    Span {
        /// First bar open (UTC ns).
        from: Timestamp,
        /// Last bar open (UTC ns).
        to: Timestamp,
    },
}

/// One computed column in an `indicators.series` update.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeriesColumn {
    /// Column key: a plot's key, or a part of a plot (`open`, `high`, `low`, `close`, `candle` of the
    /// CVD candles).
    pub key: String,
    /// One value per entry of `time`, as little-endian f64 in base64 (NaN where there is none);
    /// null when every value is NaN.
    pub values: Option<String>,
}

/// `indicators.series` payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeriesUpdate {
    /// The indicator, as asked.
    pub indicator: String,
    /// A custom indicator's version computed; none for a built-in.
    pub version: Option<u32>,
    /// Resolved instrument.
    pub instrument: InstrumentId,
    /// Timeframe.
    pub tf: Timeframe,
    /// One more than the update before it; a gap means updates were missed: subscribe again.
    #[ts(type = "number")]
    pub rev: u64,
    /// Which held values these replace.
    pub replaces: Replaces,
    /// Bar open times, epoch ms, as little-endian f64 in base64.
    pub time: String,
    /// Values by column, one per entry of `time`.
    pub columns: Vec<SeriesColumn>,
    /// The lines, labels and boxes a custom indicator draws (`draw`), whole, when they changed:
    /// they replace every earlier one. Null: unchanged (with `replaces` all: it draws none).
    pub objects: Option<IndicatorObjects>,
    /// Where the sides of the prints a series reads come from; null for one that reads only bars,
    /// or before any print is read. A bar with no known prints has no value (NaN), never zero.
    pub aggressor_source: Option<AggressorSource>,
    /// How much of its days to load a series that reads prints holds; null for one that reads
    /// only bars.
    pub loaded: Option<PrintsLoaded>,
    /// The runtime is asking the connection for prints some of these bars are missing: their
    /// values follow in a later update.
    pub filling: bool,
    /// The computation failed: no values until it works again.
    pub error: Option<SeriesError>,
    /// The market-data connection the bars came from.
    pub provider: String,
    /// Time computing this update, ms.
    pub compute_ms: f64,
}

/// `indicators.reach` input: extend every series of a chart's bars back to its first bar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ReachInput {
    /// Instrument id or symbol.
    pub instrument: String,
    /// Timeframe.
    pub tf: Timeframe,
    /// Which hours the bars cover (default: all).
    #[serde(default)]
    pub session: Option<SessionFilter>,
    /// The first bar open (UTC ns) the series must cover.
    pub from: Timestamp,
}

/// `indicators.reach` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReachOutput {
    /// The first bar open (UTC ns) the series now cover; null when the instrument has no bars.
    pub from: Option<Timestamp>,
}

/// `indicators.catalog` payload: every custom indicator, resent whole on each change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogUpdate {
    /// Custom indicators, oldest first.
    pub custom: Vec<CustomIndicator>,
}
