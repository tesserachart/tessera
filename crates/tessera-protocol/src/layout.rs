use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::ids::SessionId;
use tessera_core::{InstrumentId, Price, Timeframe, Timestamp};
use ts_rs::TS;

/// Who owns a layer or annotation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OverlayNamespace {
    /// Created by the user.
    User,
    /// Created by an agent: dashed stroke, AI tag, clearable as a group.
    Agent,
}

/// A layer on a chart (study, level set, overlay).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartLayer {
    /// Layer id, unique within the chart.
    pub id: String,
    /// Kind from the chart registry (`vwap`, `ema`, `sma`, `volume`, `volume_profile`,
    /// `levels`, `footprint`, `rsi`, `atr`).
    pub kind: String,
    /// Kind-specific parameters (`{"period": 9}`, `{"vendor":"Acme","package":"Classic",
    /// "fields":["max_positive_gamma"]}`).
    pub params: Value,
    /// Visible.
    pub visible: bool,
    /// Who added it.
    pub namespace: OverlayNamespace,
    /// Agent session that added it.
    pub session_id: Option<SessionId>,
}

/// Shape of an annotation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationKind {
    /// Rectangle between two anchor points.
    Box,
    /// Arrow from the first to the second anchor.
    Arrow,
    /// Full-width price band between two prices.
    Zone,
    /// Marker at one anchor.
    Marker,
    /// Horizontal line at one price.
    Hline,
    /// Text pinned at one anchor.
    Text,
}

/// A point on the chart: a time, a price, or both.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnchorPoint {
    /// Bar time.
    pub t: Option<Timestamp>,
    /// Price.
    pub price: Option<Price>,
}

/// An annotation drawn on a chart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    /// Id.
    pub id: String,
    /// Shape.
    pub kind: AnnotationKind,
    /// Owner namespace.
    pub namespace: OverlayNamespace,
    /// Agent session that drew it.
    pub session_id: Option<SessionId>,
    /// Instrument the chart showed when it was drawn (the UI hides annotations of other
    /// instruments).
    pub instrument: Option<InstrumentId>,
    /// Label (`touch zone · Max +Gamma ±0.10 ATR`).
    pub label: Option<String>,
    /// Longer note shown when the pin expands.
    pub note: Option<String>,
    /// Anchor points (count depends on the kind).
    pub points: Vec<AnchorPoint>,
    /// Style overrides (color token, dash) — renderer-defined.
    pub style: Option<Value>,
    /// Created.
    pub created_at: Timestamp,
}

/// What drew a volume profile on a chart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RenderedProfileSource {
    /// A `volume_profile` layer.
    Layer,
}

/// A volume profile the chart drew, as the UI reported it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenderedProfile {
    /// The volume_profile layer that drew it.
    pub source: RenderedProfileSource,
    /// The layer's id.
    pub id: String,
    /// The span in words (`Fri`, `Wk Sep 28`, `Oct 2026`, `13 weeks`, `Visible`, `Range`,
    /// `Anchored`).
    pub label: String,
    /// Start of the profile's span.
    pub from: Timestamp,
    /// End of the profile's span.
    pub to: Timestamp,
    /// Point of control as drawn.
    pub poc: Option<Price>,
    /// Value area high as drawn.
    pub vah: Option<Price>,
    /// Value area low as drawn.
    pub val: Option<Price>,
    /// Volume in the profile.
    pub volume: f64,
    /// Buy volume less sell volume in the profile, prints with no side left out: the bar deltas
    /// of the delta study (`delta`) over the same span add up to it.
    pub delta: f64,
    /// Measured from part of the span's prints (the rest has no tick history).
    pub partial: bool,
}

/// The visible range the UI last reported for a chart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    /// First visible bar time.
    pub from: Timestamp,
    /// Last visible bar time.
    pub to: Timestamp,
    /// Lowest visible price.
    pub price_min: Option<Price>,
    /// Highest visible price.
    pub price_max: Option<Price>,
    /// Number of visible bars.
    pub bars: Option<u32>,
    /// When the UI reported it.
    pub reported_at: Timestamp,
    /// The view follows new bars as they print (its right edge is the newest bar).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub follows: bool,
    /// Why the chart shows less than chart.set_viewport last asked of it (lastBars or from), in words:
    /// the history it holds or can read stops short. Absent when it shows what was asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub short: Option<String>,
    /// The chart.set_viewport request (its `request.id`) this report answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answers: Option<String>,
    /// The volume profiles on screen at that report, each with its POC, VAH, VAL, volume and
    /// delta: each volume_profile layer's (one per period with some of its rows or lines in view,
    /// or its composite, range, anchored or visible profile). A profile that drew nothing in view
    /// is not listed; one added a moment ago may still be reading: ask again shortly.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<RenderedProfile>>", optional)]
    pub profiles: Vec<RenderedProfile>,
}

/// How a chart draws its price series.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChartType {
    /// Candlesticks.
    Candles,
    /// OHLC bars.
    Bars,
    /// A line through the closes.
    Line,
    /// No price series: the bars are hidden, and the price axis, studies and drawings stay.
    None,
}

/// Which hours a chart shows: its bars, its time axis and every study that does not set hours
/// of its own.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ChartHours {
    /// Extended trading hours: every bar of the session, overnight included.
    #[default]
    Eth,
    /// Regular trading hours only (the cash session, 09:30–16:00 New York for CME equity-index
    /// futures and US stocks); the bars outside it are left off the chart.
    Rth,
}

/// The model of one chart tile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartState {
    /// Tile id (`chart-1`).
    pub tile_id: String,
    /// Display title (`Chart 1`).
    pub title: String,
    /// Instrument.
    pub instrument: InstrumentId,
    /// Timeframe.
    pub timeframe: Timeframe,
    /// Bars built from prints instead of the clock (tick, range, volume, delta or renko bars, from
    /// market.get_print_bars); absent: time bars of `timeframe`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub print_bars: Option<tessera_core::timeframe::PrintBars>,
    /// Layers, bottom to top.
    pub layers: Vec<ChartLayer>,
    /// Annotations.
    pub annotations: Vec<Annotation>,
    /// Last reported viewport.
    pub viewport: Option<Viewport>,
    /// Link group (`A`–`F`): charts in a group share symbol changes.
    pub link_group: Option<String>,
    /// How the chart draws its price series; absent until one is picked (or a template sets it),
    /// and the UI then draws its default type. Older layouts kept it in the UI's dock value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chart_type: Option<ChartType>,
    /// Which hours the chart shows (absent: `eth`, every hour). Its studies follow it unless one
    /// sets hours of its own, as a volume profile's `hours` input can.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hours: Option<ChartHours>,
    /// The drawings made on this chart, each with the instrument it was drawn on (the chart shows
    /// those of its instrument). A drawing stays on the chart it was made on. Absent: none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<crate::drawings::Drawing>>", optional)]
    pub drawings: Vec<crate::drawings::Drawing>,
    /// Other charts of this workspace (tile ids) whose drawings this chart also shows, those on
    /// its instrument (chart.set_drawing_sources). Absent: only its own drawings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub drawings_from: Vec<String>,
}

/// A saved workspace layout.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// Id (`default`, `research`).
    pub id: String,
    /// Name (`Day · QQQ/NQ`).
    pub name: String,
    /// Monotonic revision; bumped on every change.
    #[ts(type = "number")]
    pub revision: u64,
    /// Last change.
    pub updated_at: Timestamp,
    /// The chart `chart.*` tools target when no tile id is given.
    pub active_chart_id: Option<String>,
    /// Opaque dock tree owned by the UI (dockview JSON). `null` until the UI saves one.
    pub dock: Value,
    /// Chart models keyed by tile id.
    pub charts: BTreeMap<String, ChartState>,
    /// The workspace's trade setup, owned by the UI like the dock (the Trade panel's account, quantity and
    /// entry, the OCO per account and instrument): saved as it changes. `null` until the UI saves one.
    #[serde(default)]
    pub trade: Value,
    /// Changed since the user last saved it (`workspace.save` keeps the changes, `workspace.revert` drops them). Size,
    /// collapse, focus and scroll are not changes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub unsaved: bool,
}

impl Layout {
    pub fn resolve_chart(&self, tile_id: Option<&str>) -> Option<&ChartState> {
        match tile_id {
            Some(id) => self.charts.get(id),
            None => self
                .active_chart_id
                .as_deref()
                .and_then(|id| self.charts.get(id))
                .or_else(|| self.charts.values().next()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LayoutEvent {
    pub layout_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub reason: String,
    pub origin: tessera_core::Origin,
    pub tile_id: Option<String>,
    pub layout: Layout,
}
