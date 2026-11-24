use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use ts_rs::TS;

use crate::layers::{LayerKind, LayerKindSpec};
use crate::layout::{
    AnchorPoint, AnnotationKind, ChartHours, ChartState, ChartType, OverlayNamespace, Viewport,
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LayoutGetInput {
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

/// `layout.save` input. Saves the UI-owned parts of a layout: name, dock tree, active chart and
/// the set of chart tiles (new tiles get default chart state; removed tiles are dropped).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LayoutSaveInput {
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Fails with `conflict` unless the stored revision equals this. Omit it to overwrite
    /// whatever revision is stored.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expected_revision: Option<u64>,
    /// New name.
    #[serde(default)]
    pub name: Option<String>,
    /// Opaque dock tree (dockview JSON).
    #[serde(default)]
    pub dock: Option<Value>,
    /// Active chart tile.
    #[serde(default)]
    pub active_chart_id: Option<String>,
    /// Full chart states to store, keyed by tile id. When present it replaces the chart set.
    #[serde(default)]
    pub charts: Option<BTreeMap<String, ChartState>>,
    /// Opaque trade setup (the Trade panel's account, quantity, entry and OCO), owned by the UI.
    #[serde(default)]
    pub trade: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSaveOutput {
    /// Layout id.
    pub layout_id: String,
    /// New revision.
    #[ts(type = "number")]
    pub revision: u64,
}

/// `layout.list` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutListInput {}

/// One chart of a listed layout: what it shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutChartBrief {
    /// Tile id.
    pub tile_id: String,
    /// Instrument the chart shows.
    pub instrument: InstrumentId,
    /// Timeframe.
    pub timeframe: Timeframe,
}

/// One stored layout (a workspace), without its dock tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSummary {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Revision.
    #[ts(type = "number")]
    pub revision: u64,
    /// Last change.
    pub updated_at: Timestamp,
    /// Its charts, in tile order.
    pub charts: Vec<LayoutChartBrief>,
    /// Changed since the user last saved it.
    #[serde(default)]
    #[ts(as = "Option<bool>", optional)]
    pub unsaved: bool,
    /// Its unsaved changes outlived a Tessera that closed before the user saved or dropped them.
    #[serde(default)]
    #[ts(as = "Option<bool>", optional)]
    pub recovered: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutListOutput {
    /// Every stored layout, by id.
    pub layouts: Vec<LayoutSummary>,
    /// The active (default) layout: the one the UI opens and chart tools target by default.
    pub active_id: String,
}

/// `workspace.save` and `workspace.revert` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceDocumentInput {
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutDeleteInput {
    /// The layout to delete. The active layout cannot be deleted.
    pub layout_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDeleteOutput {
    /// The layout deleted.
    pub layout_id: String,
}

/// A kind of tile on the desk (`workspace.open_tile`, `workspace.close_tile`, `workspace.focus_tile`): the desk's
/// own tile kinds, as its registry names them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OpenTileKind {
    /// A chart. Opening one adds a pane beside a chart's pane (at most six panes), or a tab in its pane
    /// ([`ChartPlacement`]); a workspace holds at most 24 charts.
    Chart,
    /// Trade, the trading panel: the active chart's ticket (a tab of the right edge in a fresh workspace; one per
    /// workspace).
    Trade,
    /// The analyst's conversation and its sessions (a tab of the right edge in a fresh workspace; one per
    /// workspace).
    Analyst,
    /// Markets is an area now (ui.show_area {area: markets}); open_tile and focus_tile with it show the Markets area.
    /// Kept so stored docks and older calls still parse.
    Markets,
    /// Positions (the bottom edge; one).
    Positions,
    /// Accounts and connections (the bottom edge; one).
    Accounts,
    /// Alerts (the bottom edge; one): every alert, active, paused and fired, and their firings.
    Alerts,
    /// The depth-of-market ladder: the book, session volume, the position and orders at their prices.
    Dom,
    /// Time & sales: the prints, or the aggressor orders they joined into, newest first.
    Tape,
    /// The journal's desk tile: today's trades and their summary, beside the charts (the Journal area is its home).
    Journal,
    /// The indicators: every built-in study and the user's own scripts, each added to the active chart from here
    /// (one per workspace).
    Indicators,
    /// The trade copier: its copy groups, their leaders and followers (one per workspace).
    Copy,
}

const LEGACY_MARKETS_COMPONENT: &str = "watchlist";

impl OpenTileKind {
    pub const ALL: [Self; 12] = [
        Self::Chart,
        Self::Trade,
        Self::Analyst,
        Self::Markets,
        Self::Positions,
        Self::Accounts,
        Self::Alerts,
        Self::Dom,
        Self::Tape,
        Self::Journal,
        Self::Indicators,
        Self::Copy,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chart => "chart",
            Self::Trade => "trade",
            Self::Analyst => "analyst",
            Self::Markets => "markets",
            Self::Positions => "positions",
            Self::Accounts => "accounts",
            Self::Alerts => "alerts",
            Self::Dom => "dom",
            Self::Tape => "tape",
            Self::Journal => "journal",
            Self::Indicators => "indicators",
            Self::Copy => "copy",
        }
    }

    pub fn from_component(component: &str) -> Option<Self> {
        match component {
            LEGACY_MARKETS_COMPONENT => Some(Self::Markets),
            c => Self::ALL.into_iter().find(|k| k.as_str() == c),
        }
    }

    pub fn singleton(self) -> bool {
        matches!(
            self,
            Self::Trade
                | Self::Analyst
                | Self::Markets
                | Self::Positions
                | Self::Accounts
                | Self::Alerts
                | Self::Journal
                | Self::Indicators
                | Self::Copy
        )
    }

    pub fn words(self) -> &'static str {
        match self {
            Self::Chart => "chart",
            Self::Trade => "Trade",
            Self::Analyst => "the analyst",
            Self::Markets => "Markets",
            Self::Positions => "Positions",
            Self::Accounts => "Accounts",
            Self::Alerts => "Alerts",
            Self::Dom => "DOM",
            Self::Tape => "time & sales",
            Self::Journal => "the journal",
            Self::Indicators => "the indicators",
            Self::Copy => "the trade copier",
        }
    }
}

/// Where `workspace.open_tile` puts a new chart, by the chart it opens beside (`beside`, else the active chart).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChartPlacement {
    /// A pane of its own beside that chart's pane (the desk splits the longer side). With six panes of charts
    /// already, the desk opens it as a tab instead.
    Split,
    /// A tab in that chart's pane, the one the pane shows.
    Tab,
}

impl ChartPlacement {
    pub fn words(self) -> &'static str {
        match self {
            Self::Split => "split",
            Self::Tab => "tab",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceOpenTileInput {
    /// `chart` (a new chart pane), `trade`, `analyst`, `positions`, `accounts` (the edges' tiles: shown, their edge
    /// opened), `dom` (the depth-of-market ladder), `tape` (time & sales) or `journal` (today's trades, beside the
    /// charts). `markets` is an area now (ui.show_area {area: markets}): open_tile with it shows the Markets area.
    pub kind: OpenTileKind,
    /// `dom`, `tape`: pin the tile to this instrument id or symbol (omitted: it follows a chart, `link`, else the
    /// active chart). `chart`: the instrument the new chart shows (omitted: the active chart's).
    #[serde(default)]
    pub instrument: Option<String>,
    /// `dom`, `tape`: colour link group `1`–`4`, the tile follows that group's chart. Omitted (and no `instrument`):
    /// it follows the active chart.
    #[serde(default)]
    pub link: Option<String>,
    /// The tile's settings, as its settings popover sets them (an object; what the tile does not know or cannot take
    /// is left at its default). DOM: `rowTicks` (1, 2, 4, 5, 10), `volumeColumn` (`session`, `recent`, `off`),
    /// `traded` (volume traded at the bid and the ask: `session`, `recent`, `off`), `pullStack` (size added or pulled
    /// per level over 5, 10 or 30 s; 0 off), `orders` (resting orders per level), `refills`, `queue` (size ahead of
    /// the user's resting limit orders), `pnl` (P&L in ticks), `autoCentre`. Time & sales: `minSize` (0 shows every
    /// print), `highlight` (`auto`: Tessera's big-trade rule, or a size), `side` (`all`, `buy`, `sell`), `speed`
    /// (`slow`, `medium`, `fast` even out bursts at most 2 s behind; `live` the default), `aggregate`, `millis`.
    #[serde(default)]
    pub settings: Option<Value>,
    /// `chart`: `split` (default: a pane of its own beside the chart's pane) or `tab` (a tab in that pane, shown).
    /// Adding a chart never rearranges the other panes or splits their tabs apart.
    #[serde(default)]
    pub placement: Option<ChartPlacement>,
    /// `chart`: the chart tile (`workspace.list_tiles`) whose pane the new chart joins as a tab or opens beside
    /// (omitted: the active chart).
    #[serde(default)]
    pub beside: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

/// One tile the desk is asked to open, kept in the layout's dock value (`dock.tessera.open`) until the desk has
/// opened it and saved its dock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TileRequest {
    /// The request's id, unique in its layout (`open-<revision>`: requests are taken in revision order);
    /// `area-markets` when Markets, an area now, was shown instead and nothing waits in the dock.
    pub id: String,
    /// The desk's tile kind.
    pub kind: OpenTileKind,
    /// The tile's params: `instrument` (resolved) and `link`, each null when not asked for.
    pub params: TileRequestParams,
}

/// The params a [`TileRequest`] gives its tile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TileRequestParams {
    /// The instrument it is pinned to, or null to follow a chart.
    pub instrument: Option<InstrumentId>,
    /// The link group it follows, or null.
    pub link: Option<String>,
    /// The tile's settings asked for (an object), or absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub settings: Option<Value>,
    /// A chart: a pane of its own or a tab, when asked for (absent: a pane).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placement: Option<ChartPlacement>,
    /// A chart: the chart whose pane it joins or opens beside, when asked for (absent: the active chart).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub beside: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenTileOutput {
    /// Layout id.
    pub layout_id: String,
    /// New revision.
    #[ts(type = "number")]
    pub revision: u64,
    /// The request as the desk takes it.
    pub request: TileRequest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SettingsGetInput {
    /// Keys to read; all known settings if omitted.
    #[serde(default)]
    pub keys: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum SettingsEvent {
    Snapshot { values: BTreeMap<String, Value> },
    Changed { key: String, value: Value },
}

/// Description of one setting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingInfo {
    /// Key (`agent.maxStepsPerTurn`).
    pub key: String,
    /// Current value.
    pub value: Value,
    /// Default value.
    pub default: Value,
    /// Description.
    pub description: String,
    /// JSON Schema of valid values.
    pub schema: Value,
    /// Safety setting (agent loop guards, approval staleness): only the user can change it.
    pub user_only: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsGetOutput {
    /// Settings, by key.
    pub settings: BTreeMap<String, SettingInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSetInput {
    /// Key.
    pub key: String,
    /// New value (validated against the setting's schema).
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetOutput {
    /// Key.
    pub key: String,
    /// Stored value.
    pub value: Value,
    /// Previous value.
    pub previous: Value,
}

/// Target chart for `chart.*` tools.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartTarget {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

/// `chart.get_state` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartStateOutput {
    /// Layout id.
    pub layout_id: String,
    /// Layout revision.
    #[ts(type = "number")]
    pub revision: u64,
    /// The chart model, including the last viewport the UI reported.
    pub chart: ChartState,
    /// The drawings the chart shows from the charts in its `drawingsFrom`, those on its
    /// instrument, each with the chart it was made on. chart.update_drawing and
    /// chart.remove_drawing on this chart change them on that chart.
    pub pulled: Vec<PulledDrawing>,
}

/// A drawing a chart shows from another chart of its workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PulledDrawing {
    /// The chart it was made on, which keeps it.
    pub tile_id: String,
    /// The drawing.
    pub drawing: crate::drawings::Drawing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetSymbolInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Instrument id or symbol.
    pub instrument: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetTimeframeInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Timeframe.
    pub tf: Timeframe,
    /// Bars built from prints instead (`{"kind":"tick","size":500}`, `{"kind":"range","size":10}`,
    /// `{"kind":"volume","size":1000}`, `{"kind":"delta","size":300}`, `{"kind":"renko","size":10}`), each starting again at the session's open; absent: time
    /// bars of `tf`.
    #[serde(default)]
    pub print_bars: Option<tessera_core::timeframe::PrintBars>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetChartTypeInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// How the chart draws its price series: candles, bars or line; none hides it on this chart only.
    pub chart_type: ChartType,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetDrawingSourcesInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The other charts of the workspace (tile ids) whose drawings this chart shows, those on its
    /// instrument; `[]` shows only its own.
    pub from: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetHoursInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// `rth` for regular trading hours only, `eth` for every hour.
    pub hours: ChartHours,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartAddLayerInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Layer kind. Only kinds the UI draws are accepted (`chart.list_layer_kinds`); the others
    /// answer `unsupported`.
    pub kind: LayerKind,
    /// Kind-specific parameters, validated against the kind's schema (`chart.list_layer_kinds`).
    /// Indicators take `{"inputs": {...}, "style": {...}}`; what is omitted takes the defaults.
    #[serde(default)]
    pub params: Option<Value>,
    /// Layer id (generated if omitted; must be unique on the chart).
    #[serde(default)]
    pub id: Option<String>,
}

/// `chart.update_layer` input: edits a layer's params (a JSON merge patch over its current
/// params) and/or its visibility.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartUpdateLayerInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Layer id.
    pub layer_id: String,
    /// Merge patch over the layer's params (`{"inputs": {"length": 21}}`,
    /// `{"style": {"plots": {"rsi": {"color": "brass"}}}}`); `null` for a key returns it to its
    /// default. Validated against the kind's schema.
    #[serde(default)]
    pub params: Option<Value>,
    /// Show or hide the layer.
    #[serde(default)]
    pub visible: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartRemoveLayerInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Layer id.
    pub layer_id: String,
}

/// `chart.annotate` input. Agent annotations land in the agent namespace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartAnnotateInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Shape. Points needed: box/arrow 2 (time+price), zone 2 (price), marker/text 1, hline 1 (price).
    pub kind: AnnotationKind,
    /// Anchor points.
    pub points: Vec<AnchorPoint>,
    /// Label.
    #[serde(default)]
    pub label: Option<String>,
    /// Note.
    #[serde(default)]
    pub note: Option<String>,
    /// Style overrides.
    #[serde(default)]
    pub style: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartClearAnnotationsInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Namespace to clear (default `agent`). Agents may only clear the agent namespace.
    #[serde(default)]
    pub namespace: Option<OverlayNamespace>,
    /// Only annotations from this agent session.
    #[serde(default)]
    pub session_id: Option<String>,
}

/// Result of `chart.clear_annotations` and `chart.remove_layer`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemovedOutput {
    /// Number of objects removed.
    pub removed: u32,
    /// Layout revision after the change.
    #[ts(type = "number")]
    pub revision: u64,
}

/// `chart.report_viewport` input (user only, rate limited).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartReportViewportInput {
    /// Chart tile id.
    pub tile_id: String,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The visible range.
    pub viewport: Viewport,
}

/// Output of chart mutations: the chart after the change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartChangeOutput {
    /// Layout id.
    pub layout_id: String,
    /// New revision.
    #[ts(type = "number")]
    pub revision: u64,
    /// The chart after the change.
    pub chart: ChartState,
}

/// `chart.list_layer_kinds` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LayerKindsInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Only the kinds whose id or title holds these words, in any case: a kind (`volume_profile`)
    /// or part of a name (`profile`, `trades`). Absent: every kind.
    #[serde(default)]
    pub kind: Option<String>,
    /// Most kinds listed (default: every match).
    #[serde(default)]
    pub limit: Option<u32>,
    /// List each kind in full: its whole description, params schema and indicator spec. Absent:
    /// in full only when the filter leaves one kind; otherwise each kind with the first sentence
    /// of its description, so ask again with that kind for its schema.
    #[serde(default)]
    pub full: Option<bool>,
}

/// `chart.list_layer_kinds` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayerKindsOutput {
    /// The kinds asked for, with `available` evaluated for the target chart.
    pub kinds: Vec<LayerKindEntry>,
    /// Kinds that matched past the limit, left out.
    #[serde(default, skip_serializing_if = "is_zero")]
    #[ts(as = "Option<u32>", optional)]
    pub omitted: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// One layer kind as offered on a chart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayerKindEntry {
    /// The registry entry.
    #[serde(flatten)]
    pub spec: LayerKindSpec,
    /// `chart.add_layer` accepts it on this chart: the UI draws it and the chart's connection
    /// offers the data it needs.
    pub available: bool,
    /// Why not, when unavailable.
    pub reason: Option<String>,
}
