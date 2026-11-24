use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tessera_core::Timestamp;
use tessera_core::time::ExchangeTz;
use ts_rs::TS;

use crate::layers::LayerKind;

/// The bar price an input reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PriceSource {
    Open,
    High,
    Low,
    Close,
    /// (high + low) / 2.
    Hl2,
    /// (high + low + close) / 3, the typical price.
    Hlc3,
    /// (open + high + low + close) / 4.
    Ohlc4,
}

impl PriceSource {
    pub const ALL: [PriceSource; 7] = [
        PriceSource::Open,
        PriceSource::High,
        PriceSource::Low,
        PriceSource::Close,
        PriceSource::Hl2,
        PriceSource::Hlc3,
        PriceSource::Ohlc4,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PriceSource::Open => "open",
            PriceSource::High => "high",
            PriceSource::Low => "low",
            PriceSource::Close => "close",
            PriceSource::Hl2 => "hl2",
            PriceSource::Hlc3 => "hlc3",
            PriceSource::Ohlc4 => "ohlc4",
        }
    }
}

/// What kind of value an input holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InputType {
    /// A number within `min..=max`, edited in `step`s.
    Number,
    /// A whole number within `min..=max`.
    Int,
    /// One of `options`.
    Enum,
    /// A bar price ([`PriceSource`]).
    Source,
    /// On or off.
    Bool,
    /// A palette swatch or a custom `#rrggbb[aa]` colour.
    Color,
    /// Hours of the day as `HH:MM-HH:MM` (`07:00-10:00`); they may run through midnight
    /// (`20:00-00:00`).
    Session,
    /// An IANA time zone name (`Europe/London`, `America/New_York`, `UTC`).
    Timezone,
    /// A moment, given as RFC 3339 (`2026-09-08T09:30:00-04:00`) or integer nanoseconds and kept
    /// as RFC 3339 in UTC; empty until it is set.
    Time,
}

/// One choice of an enum input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InputOption {
    /// Stored value.
    pub value: String,
    /// What the user reads.
    pub label: String,
}

/// One typed input of an indicator.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorInput {
    /// Key in `params.inputs` (`length`).
    pub key: String,
    /// Label in the settings form (`Length`).
    pub label: String,
    /// Value type.
    #[serde(rename = "type")]
    pub ty: InputType,
    /// Default value.
    #[ts(type = "number | string | boolean")]
    pub default: Value,
    /// Lowest value (number, int).
    pub min: Option<f64>,
    /// Highest value (number, int).
    pub max: Option<f64>,
    /// Edit step (number, int).
    pub step: Option<f64>,
    /// Choices (enum).
    pub options: Option<Vec<InputOption>>,
    /// The value is part of the indicator's label (`RSI 14`).
    pub in_label: bool,
    /// Shown, and applied, only while a choice holds a value: one of a mode's own settings (Big
    /// trades' `Bars forward` under Zones On). Its value is kept either way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub when: Option<InputWhen>,
    /// The word the settings form shows in an empty number field, which stands for 0 (Big trades'
    /// `None` for a max size of 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub zero_label: Option<String>,
    /// Enum only: the settings form draws the options as buttons side by side instead of a menu.
    /// Use it for two or three short options that read as a mode (Big trades' `size`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(optional, as = "Option<bool>")]
    pub segmented: bool,
    /// A short plain note the settings form shows as a muted line under this input's row: what the
    /// setting does and when it ends. Read it to learn how the input works.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hint: Option<String>,
}

/// The choice an input belongs to ([`IndicatorInput::when`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InputWhen {
    /// The choice's key.
    pub input: String,
    /// The values it holds while the input applies.
    pub values: Vec<String>,
}

/// How a plot draws its values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlotKind {
    /// A line through the values.
    Line,
    /// A bar per value from zero (volume, the MACD histogram).
    Histogram,
    /// A horizontal guide at a fixed value or an input's value (RSI 70 / 30).
    Hline,
}

/// What picks a histogram bar's colour between `color` and `downColor`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlotColorBy {
    /// The bar's direction: `downColor` when it closed below its open (volume).
    Direction,
    /// The value's sign: `downColor` below zero (the MACD histogram).
    Sign,
}

/// A stroke's dash.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum LineDash {
    #[default]
    Solid,
    /// Dashed.
    Dash,
    /// Dotted.
    Dot,
}

/// How one plot is drawn (normalized: every field present).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlotStyle {
    /// A palette swatch ([`COLOR_SWATCHES`]) or a custom `#rrggbb[aa]`.
    pub color: String,
    /// Histograms coloured by direction or sign: the colour of a down bar.
    pub down_color: Option<String>,
    /// Stroke width in px (0.5–4).
    pub width: f64,
    /// Dash.
    pub line: LineDash,
    /// Opacity (0–1).
    pub opacity: f64,
    /// Drawn.
    pub visible: bool,
}

/// How a fill between two plots is drawn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FillStyle {
    /// A palette swatch or a custom `#rrggbb[aa]`.
    pub color: String,
    /// Opacity (0–1).
    pub opacity: f64,
    /// Drawn.
    pub visible: bool,
}

/// One output of an indicator.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorPlot {
    /// Key in `params.style.plots` and in the computed outputs (`rsi`).
    pub key: String,
    /// Label in the settings form and the legend (`RSI`).
    pub label: String,
    /// How it draws.
    pub kind: PlotKind,
    /// Histograms: what picks the down colour.
    pub color_by: Option<PlotColorBy>,
    /// Hlines: a fixed value (RSI's middle 50).
    pub value: Option<f64>,
    /// Hlines: the input holding the value (`upper`).
    pub value_input: Option<String>,
    /// A switch input that turns this plot on (VWAP's `band1` for `upper1`): while it is off the plot
    /// draws nothing and the settings do not list its style.
    pub shown_by: Option<String>,
    /// Default style.
    pub default: PlotStyle,
}

/// A fill between two plots (Bollinger's band, RSI's zone).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorFill {
    /// Key in `params.style.fills`.
    pub key: String,
    /// Label in the settings form.
    pub label: String,
    /// One edge (a plot key).
    pub from: String,
    /// The other edge (a plot key).
    pub to: String,
    /// A switch input that turns this fill on (see [`IndicatorPlot::shown_by`]).
    pub shown_by: Option<String>,
    /// Default style.
    pub default: FillStyle,
}

/// Where an indicator draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IndicatorPlacement {
    /// On the price pane, in price units.
    Overlay,
    /// In its own pane under the price, with its own scale.
    Pane,
}

/// The family an indicator belongs to: the Add-indicator dialog's groups, in this order. A group
/// with no indicator yet (order flow, until footprint, profile and delta join the registry) is not
/// shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IndicatorGroup {
    /// Moving averages: where price is going.
    Trend,
    /// Oscillators: how fast it is going.
    Momentum,
    /// Ranges and bands: how far it moves.
    Volatility,
    /// Volume and what is weighted by it.
    Volume,
    /// Bid/ask volume, delta, profiles (the order-flow suite).
    OrderFlow,
    /// The user's and the analyst's own (custom indicators).
    Custom,
    /// Order-flow studies that mark bars and zones rather than plot a series.
    Special,
}

/// How an indicator's values read on the axis and in the legend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ValueFormat {
    /// The instrument's price format.
    Price,
    /// Short volume (`2.71M`).
    Volume,
    /// Two decimals (oscillators).
    Number,
}

/// An indicator's declaration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorSpec {
    /// Layer kind.
    pub kind: LayerKind,
    /// Full name (`Relative strength index`).
    pub title: String,
    /// Short name that starts its label (`RSI`).
    pub short: String,
    /// Its family (the Add-indicator dialog's group).
    pub group: IndicatorGroup,
    /// Where it draws.
    pub placement: IndicatorPlacement,
    /// Inputs, in form order.
    pub inputs: Vec<IndicatorInput>,
    /// Outputs and guides, bottom to top.
    pub plots: Vec<IndicatorPlot>,
    /// Fills between plots, drawn under them.
    pub fills: Vec<IndicatorFill>,
    /// A fixed scale (`[0, 100]`); the pane auto-fits its values otherwise.
    pub range: Option<Vec<f64>>,
    /// Pane indicators: the default share of the plot height.
    pub height: Option<f64>,
    /// Values restart each trading day (session VWAP): lines do not join across days.
    pub session_reset: bool,
    /// With `session_reset`: the enum input naming the span values run over before they restart
    /// (VWAP's `period`: `session`, `week` or `month`), so lines join across days within a week or
    /// a month. Without one: each session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reset_by: Option<String>,
    /// How values read.
    pub format: ValueFormat,
}

/// `params` of an indicator layer, as callers send them: every part optional (the defaults, or
/// the layer's current values, fill the rest).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct IndicatorParams {
    /// Input values by key.
    #[serde(default)]
    #[ts(optional, type = "Record<string, number | string | boolean>")]
    pub inputs: Option<BTreeMap<String, Value>>,
    /// Styles of plots and fills by key.
    #[serde(default)]
    pub style: Option<IndicatorStyleParams>,
    /// Pane indicators: share of the plot height (0.05–0.8).
    #[serde(default)]
    pub height: Option<f64>,
}

/// `params.style` of an indicator layer.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct IndicatorStyleParams {
    /// Plot styles by plot key.
    #[serde(default)]
    pub plots: Option<BTreeMap<String, PlotStyleParams>>,
    /// Fill styles by fill key.
    #[serde(default)]
    pub fills: Option<BTreeMap<String, FillStyleParams>>,
    /// The labels its lines carry (indicators with a line plot).
    #[serde(default)]
    pub labels: Option<IndicatorLabelsParams>,
}

/// A plot's style as callers send it: what is omitted keeps its value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct PlotStyleParams {
    /// A palette swatch or a custom `#rrggbb[aa]`.
    #[serde(default)]
    pub color: Option<String>,
    /// Down colour of a histogram coloured by direction or sign.
    #[serde(default)]
    pub down_color: Option<String>,
    /// Stroke width in px (0.5–4).
    #[serde(default)]
    pub width: Option<f64>,
    /// Dash.
    #[serde(default)]
    pub line: Option<LineDash>,
    /// Opacity (0–1).
    #[serde(default)]
    pub opacity: Option<f64>,
    /// Drawn.
    #[serde(default)]
    pub visible: Option<bool>,
}

/// A fill's style as callers send it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct FillStyleParams {
    /// A palette swatch or a custom `#rrggbb[aa]`.
    #[serde(default)]
    pub color: Option<String>,
    /// Opacity (0–1).
    #[serde(default)]
    pub opacity: Option<f64>,
    /// Drawn.
    #[serde(default)]
    pub visible: Option<bool>,
}

pub const COLOR_SWATCHES: [&str; 9] = [
    "mist", "t1", "t2", "t3", "t4", "up", "down", "brass", "teal",
];

const HEIGHT_RANGE: (f64, f64) = (0.05, 0.8);
const WIDTH_RANGE: (f64, f64) = (0.5, 4.0);

/// The labels an indicator's lines carry (`params.style.labels`, normalized: every field present),
/// TradingView's style options: each line's last value tagged on the price scale, and a label at
/// each line's right end naming it. Indicators without a line plot have none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorLabels {
    /// Each shown line's last value tagged on the price scale ("Labels on price scale").
    pub price_scale: bool,
    /// A label at each shown line's right end naming it: the indicator for one line (`EMA 20`),
    /// the plot for several (`Upper`).
    pub name: bool,
    /// The name label also reads the line's value there.
    pub value: bool,
}

/// `params.style.labels` as callers send them: what is omitted keeps its value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct IndicatorLabelsParams {
    /// Each shown line's last value tagged on the price scale.
    #[serde(default)]
    pub price_scale: Option<bool>,
    /// A label naming each shown line at its right end.
    #[serde(default)]
    pub name: Option<bool>,
    /// The name label also reads the value.
    #[serde(default)]
    pub value: Option<bool>,
}

pub fn has_labels(spec: &IndicatorSpec) -> bool {
    spec.plots.iter().any(|p| p.kind == PlotKind::Line)
}

pub fn default_labels(spec: &IndicatorSpec) -> IndicatorLabels {
    IndicatorLabels {
        price_scale: spec.placement == IndicatorPlacement::Pane,
        name: false,
        value: false,
    }
}

pub const MAX_OBJECTS: usize = 500;

/// How far a line or box reaches past its ends.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ObjectExtend {
    /// Between its ends.
    #[default]
    None,
    /// To the chart's left edge.
    Left,
    /// To the chart's right edge.
    Right,
    /// Both ways.
    Both,
}

/// Where a label sits along its line or its box's edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LabelAlong {
    /// At its left end (a box's left side).
    Start,
    /// Halfway.
    Middle,
    /// At its right end (a box's right side).
    End,
}

/// Which side of its line a label sits on; a box's label: on its top edge or its bottom one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LabelSide {
    /// Above the line (a box's top edge).
    Above,
    /// Below the line (a box's bottom edge).
    Below,
}

/// Where a standalone label sits against its price.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LabelPlacement {
    /// Its bottom on the price.
    Above,
    /// Its top on the price.
    Below,
    /// Centred on the price.
    At,
}

/// A label's text size.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LabelSize {
    /// A size below the chart's text.
    Small,
    /// The chart's text.
    Normal,
    /// A size above it.
    Large,
}

/// Text on a line or a box.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObjectText {
    /// The words (one line, at most 100 characters).
    pub text: String,
    /// Where along it.
    pub at: LabelAlong,
    /// Which side.
    pub side: LabelSide,
    /// A palette swatch or `#rrggbb[aa]`; the line's own colour when `None`.
    pub color: Option<String>,
}

/// A line a custom indicator draws, from one bar time and price to another.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorLineObject {
    /// First end: a bar time (UTC ns).
    pub time1: Timestamp,
    /// First end: a price.
    pub price1: f64,
    /// Second end: a bar time (UTC ns); `None` runs the line to the last bar ("until now").
    pub time2: Option<Timestamp>,
    /// Second end: a price.
    pub price2: f64,
    /// A palette swatch or `#rrggbb[aa]`; the indicator's colour when `None` (its first line's,
    /// the analyst's aqua on an indicator the analyst added).
    pub color: Option<String>,
    /// Stroke width in px (0.5–4).
    pub width: f64,
    /// Dash.
    pub line: LineDash,
    /// Past its ends.
    pub extend: ObjectExtend,
    /// Text on it.
    pub label: Option<ObjectText>,
}

/// Text a custom indicator writes at a bar time and a price.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorLabelObject {
    /// A bar time (UTC ns).
    pub time: Timestamp,
    /// A price.
    pub price: f64,
    /// The words (one line, at most 100 characters).
    pub text: String,
    /// A palette swatch or `#rrggbb[aa]`; the indicator's colour when `None`.
    pub color: Option<String>,
    /// Text size.
    pub size: LabelSize,
    /// Against its price.
    pub side: LabelPlacement,
}

/// A box a custom indicator draws between two corners.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorBoxObject {
    /// One corner: a bar time (UTC ns).
    pub time1: Timestamp,
    /// One corner: a price.
    pub price1: f64,
    /// The other corner: a bar time (UTC ns); `None` runs the box to the last bar.
    pub time2: Option<Timestamp>,
    /// The other corner: a price.
    pub price2: f64,
    /// The border: a palette swatch or `#rrggbb[aa]`; the indicator's colour when `None`.
    pub color: Option<String>,
    /// Border width in px (0–4; 0 draws none).
    pub width: f64,
    /// Border dash.
    pub line: LineDash,
    /// The inside's colour; the border's when `None`.
    pub fill: Option<String>,
    /// The inside's opacity (0–1; 0 fills nothing).
    pub opacity: f64,
    /// Past its sides.
    pub extend: ObjectExtend,
    /// Text on its top or bottom edge.
    pub label: Option<ObjectText>,
}

/// What a custom indicator draws besides its plots, each kind oldest first, at most
/// [`MAX_OBJECTS`] of each (the newest).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorObjects {
    /// Lines and segments.
    #[serde(default)]
    pub lines: Vec<IndicatorLineObject>,
    /// Text labels.
    #[serde(default)]
    pub labels: Vec<IndicatorLabelObject>,
    /// Boxes.
    #[serde(default)]
    pub boxes: Vec<IndicatorBoxObject>,
}

impl IndicatorObjects {
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty() && self.labels.is_empty() && self.boxes.is_empty()
    }

    pub fn cap(&mut self) {
        fn newest<T>(v: &mut Vec<T>) {
            if v.len() > MAX_OBJECTS {
                v.drain(..v.len() - MAX_OBJECTS);
            }
        }
        newest(&mut self.lines);
        newest(&mut self.labels);
        newest(&mut self.boxes);
    }

    pub fn since(&self, from: Timestamp) -> IndicatorObjects {
        let reaches = |t1: Timestamp, t2: Option<Timestamp>| t2.is_none_or(|t2| t1.max(t2) >= from);
        IndicatorObjects {
            lines: self
                .lines
                .iter()
                .filter(|l| l.extend != ObjectExtend::None || reaches(l.time1, l.time2))
                .cloned()
                .collect(),
            labels: self
                .labels
                .iter()
                .filter(|l| l.time >= from)
                .cloned()
                .collect(),
            boxes: self
                .boxes
                .iter()
                .filter(|b| b.extend != ObjectExtend::None || reaches(b.time1, b.time2))
                .cloned()
                .collect(),
        }
    }

    pub fn check(&self) -> Result<(), String> {
        let color = |what: &str, c: &Option<String>| match c {
            Some(c) => check_color(what, c),
            None => Ok(()),
        };
        let finite = |what: &str, v: f64| {
            if v.is_finite() {
                Ok(())
            } else {
                Err(format!("{what} is not a number"))
            }
        };
        let text = |what: &str, t: &ObjectText| {
            color(what, &t.color)?;
            if t.text.chars().count() > 100 {
                return Err(format!("{what}: text longer than 100 characters"));
            }
            Ok::<(), String>(())
        };
        for (n, l) in self.lines.iter().enumerate() {
            let what = format!("line {n}");
            finite(&what, l.price1)?;
            finite(&what, l.price2)?;
            color(&what, &l.color)?;
            check_range(&format!("{what} width"), l.width, WIDTH_RANGE)?;
            if let Some(t) = &l.label {
                text(&what, t)?;
            }
        }
        for (n, l) in self.labels.iter().enumerate() {
            let what = format!("label {n}");
            finite(&what, l.price)?;
            color(&what, &l.color)?;
            if l.text.chars().count() > 100 {
                return Err(format!("{what}: text longer than 100 characters"));
            }
        }
        for (n, b) in self.boxes.iter().enumerate() {
            let what = format!("box {n}");
            finite(&what, b.price1)?;
            finite(&what, b.price2)?;
            color(&what, &b.color)?;
            color(&what, &b.fill)?;
            check_range(&format!("{what} width"), b.width, (0.0, WIDTH_RANGE.1))?;
            check_range(&format!("{what} opacity"), b.opacity, (0.0, 1.0))?;
            if let Some(t) = &b.label {
                text(&what, t)?;
            }
        }
        Ok(())
    }
}

fn input(key: &str, label: &str, ty: InputType, default: Value) -> IndicatorInput {
    IndicatorInput {
        key: key.into(),
        label: label.into(),
        ty,
        default,
        min: None,
        max: None,
        step: None,
        options: None,
        in_label: false,
        when: None,
        zero_label: None,
        segmented: false,
        hint: None,
    }
}

fn when(input: &str, value: &str, i: IndicatorInput) -> IndicatorInput {
    when_any(input, &[value], i)
}

fn when_any(input: &str, values: &[&str], i: IndicatorInput) -> IndicatorInput {
    IndicatorInput {
        when: Some(InputWhen {
            input: input.into(),
            values: values.iter().map(|v| (*v).into()).collect(),
        }),
        in_label: false,
        ..i
    }
}

fn zero_label(word: &str, i: IndicatorInput) -> IndicatorInput {
    IndicatorInput {
        zero_label: Some(word.into()),
        in_label: false,
        ..i
    }
}

fn segmented(i: IndicatorInput) -> IndicatorInput {
    IndicatorInput {
        segmented: true,
        ..i
    }
}

fn hint(text: &str, i: IndicatorInput) -> IndicatorInput {
    IndicatorInput {
        hint: Some(text.into()),
        ..i
    }
}

fn int(key: &str, label: &str, default: i64, min: i64, max: i64) -> IndicatorInput {
    IndicatorInput {
        min: Some(min as f64),
        max: Some(max as f64),
        step: Some(1.0),
        in_label: true,
        ..input(key, label, InputType::Int, json!(default))
    }
}

fn number(key: &str, label: &str, default: f64, min: f64, max: f64, step: f64) -> IndicatorInput {
    IndicatorInput {
        min: Some(min),
        max: Some(max),
        step: Some(step),
        ..input(key, label, InputType::Number, json!(default))
    }
}

fn source(default: PriceSource) -> IndicatorInput {
    input(
        "source",
        "Source",
        InputType::Source,
        json!(default.as_str()),
    )
}

fn colour(key: &str, label: &str, default: &str) -> IndicatorInput {
    input(key, label, InputType::Color, json!(default))
}

fn plain(mut i: IndicatorInput) -> IndicatorInput {
    i.in_label = false;
    i
}

fn boolean(key: &str, label: &str, default: bool) -> IndicatorInput {
    input(key, label, InputType::Bool, json!(default))
}

fn choice(key: &str, label: &str, options: &[(&str, &str)]) -> IndicatorInput {
    IndicatorInput {
        options: Some(
            options
                .iter()
                .map(|(value, label)| InputOption {
                    value: (*value).into(),
                    label: (*label).into(),
                })
                .collect(),
        ),
        ..input(key, label, InputType::Enum, json!(options[0].0))
    }
}

fn labelled(mut i: IndicatorInput) -> IndicatorInput {
    i.in_label = true;
    i
}

fn style(color: &str, width: f64, line: LineDash, opacity: f64) -> PlotStyle {
    PlotStyle {
        color: color.into(),
        down_color: None,
        width,
        line,
        opacity,
        visible: true,
    }
}

fn plot(key: &str, label: &str, kind: PlotKind, default: PlotStyle) -> IndicatorPlot {
    IndicatorPlot {
        key: key.into(),
        label: label.into(),
        kind,
        color_by: None,
        value: None,
        value_input: None,
        shown_by: None,
        default,
    }
}

fn line(key: &str, label: &str, color: &str, width: f64) -> IndicatorPlot {
    plot(
        key,
        label,
        PlotKind::Line,
        style(color, width, LineDash::Solid, 1.0),
    )
}

fn guide_at(key: &str, label: &str, value_input: &str) -> IndicatorPlot {
    IndicatorPlot {
        value_input: Some(value_input.into()),
        ..plot(
            key,
            label,
            PlotKind::Hline,
            style("t3", 1.0, LineDash::Dash, 1.0),
        )
    }
}

fn guide(key: &str, label: &str, value: f64) -> IndicatorPlot {
    IndicatorPlot {
        value: Some(value),
        ..plot(
            key,
            label,
            PlotKind::Hline,
            style("t4", 1.0, LineDash::Dot, 1.0),
        )
    }
}

fn histogram(key: &str, label: &str, by: PlotColorBy, opacity: f64) -> IndicatorPlot {
    IndicatorPlot {
        color_by: Some(by),
        ..plot(
            key,
            label,
            PlotKind::Histogram,
            PlotStyle {
                down_color: Some("down".into()),
                ..style("up", 1.0, LineDash::Solid, opacity)
            },
        )
    }
}

fn fill(
    key: &str,
    label: &str,
    from: &str,
    to: &str,
    opacity: f64,
    visible: bool,
) -> IndicatorFill {
    IndicatorFill {
        key: key.into(),
        label: label.into(),
        from: from.into(),
        to: to.into(),
        shown_by: None,
        default: FillStyle {
            color: "mist".into(),
            opacity,
            visible,
        },
    }
}

fn spec(
    kind: LayerKind,
    title: &str,
    short: &str,
    group: IndicatorGroup,
    placement: IndicatorPlacement,
) -> IndicatorSpec {
    IndicatorSpec {
        kind,
        title: title.into(),
        short: short.into(),
        group,
        placement,
        inputs: Vec::new(),
        plots: Vec::new(),
        fills: Vec::new(),
        range: None,
        height: (placement == IndicatorPlacement::Pane).then_some(0.16),
        session_reset: false,
        reset_by: None,
        format: ValueFormat::Price,
    }
}

fn moving_average(
    kind: LayerKind,
    title: &str,
    short: &str,
    length: i64,
    look: PlotStyle,
) -> IndicatorSpec {
    IndicatorSpec {
        inputs: vec![
            int("length", "Length", length, 1, 500),
            source(PriceSource::Close),
        ],
        plots: vec![plot("ma", short, PlotKind::Line, look)],
        ..spec(
            kind,
            title,
            short,
            IndicatorGroup::Trend,
            IndicatorPlacement::Overlay,
        )
    }
}

pub fn indicator_spec(kind: LayerKind) -> Option<IndicatorSpec> {
    use IndicatorGroup::{Momentum, OrderFlow, Special, Volatility, Volume};
    use IndicatorPlacement::{Overlay, Pane};
    let s = match kind {
        LayerKind::Sma => moving_average(
            kind,
            "Simple moving average",
            "SMA",
            20,
            style("t2", 1.0, LineDash::Solid, 1.0),
        ),
        LayerKind::Ema => moving_average(
            kind,
            "Exponential moving average",
            "EMA",
            9,
            style("t1", 1.0, LineDash::Solid, 1.0),
        ),
        LayerKind::Wma => moving_average(
            kind,
            "Weighted moving average",
            "WMA",
            20,
            style("t2", 1.0, LineDash::Dash, 1.0),
        ),
        LayerKind::Vwap => {
            let mut inputs = vec![segmented(choice(
                "period",
                "Period",
                &[("session", "Session"), ("week", "Week"), ("month", "Month")],
            ))];
            let mut plots = vec![plot(
                "vwap",
                "VWAP",
                PlotKind::Line,
                style("mist", 1.25, LineDash::Solid, 0.55),
            )];
            let mut fills = Vec::new();
            for (n, k) in [(1, 1.0), (2, 2.0), (3, 3.0)] {
                inputs.push(boolean(&format!("band{n}"), &format!("Band {n}"), false));
                inputs.push(number(
                    &format!("mult{n}"),
                    &format!("Band {n} σ"),
                    k,
                    0.1,
                    5.0,
                    0.1,
                ));
                for edge in ["upper", "lower"] {
                    plots.push(IndicatorPlot {
                        shown_by: Some(format!("band{n}")),
                        ..plot(
                            &format!("{edge}{n}"),
                            &format!("{} {n}", if edge == "upper" { "Upper" } else { "Lower" }),
                            PlotKind::Line,
                            style("mist", 1.0, LineDash::Dash, 0.4),
                        )
                    });
                }
                fills.push(IndicatorFill {
                    shown_by: Some(format!("band{n}")),
                    ..fill(
                        &format!("band{n}"),
                        &format!("Band {n} fill"),
                        &format!("upper{n}"),
                        &format!("lower{n}"),
                        0.04,
                        false,
                    )
                });
            }
            IndicatorSpec {
                inputs,
                plots,
                fills,
                session_reset: true,
                reset_by: Some("period".into()),
                ..spec(kind, "VWAP", "VWAP", Volume, Overlay)
            }
        }
        LayerKind::Volume => IndicatorSpec {
            inputs: vec![IndicatorInput {
                in_label: false,
                ..int("maLength", "Average length", 20, 1, 500)
            }],
            plots: vec![
                histogram("volume", "Volume", PlotColorBy::Direction, 0.26),
                IndicatorPlot {
                    default: PlotStyle {
                        visible: false,
                        ..style("t2", 1.0, LineDash::Solid, 0.5)
                    },
                    ..line("ma", "Average", "t2", 1.0)
                },
            ],
            height: Some(0.1),
            format: ValueFormat::Volume,
            ..spec(kind, "Volume", "Vol", Volume, Pane)
        },
        LayerKind::Rsi => IndicatorSpec {
            inputs: vec![
                int("length", "Length", 14, 2, 500),
                source(PriceSource::Close),
                number("upper", "Upper band", 70.0, 50.0, 100.0, 1.0),
                number("lower", "Lower band", 30.0, 0.0, 50.0, 1.0),
            ],
            plots: vec![
                guide_at("upperBand", "Upper band", "upper"),
                guide("middle", "Middle", 50.0),
                guide_at("lowerBand", "Lower band", "lower"),
                line("rsi", "RSI", "mist", 1.25),
            ],
            fills: vec![fill(
                "zone",
                "Background",
                "upperBand",
                "lowerBand",
                0.04,
                true,
            )],
            range: Some(vec![0.0, 100.0]),
            format: ValueFormat::Number,
            ..spec(kind, "Relative strength index", "RSI", Momentum, Pane)
        },
        LayerKind::Atr => IndicatorSpec {
            inputs: vec![
                int("length", "Length", 14, 1, 500),
                choice(
                    "smoothing",
                    "Smoothing",
                    &[
                        ("rma", "RMA (Wilder)"),
                        ("sma", "SMA"),
                        ("ema", "EMA"),
                        ("wma", "WMA"),
                    ],
                ),
            ],
            plots: vec![line("atr", "ATR", "mist", 1.25)],
            ..spec(kind, "Average true range", "ATR", Volatility, Pane)
        },
        LayerKind::Bollinger => IndicatorSpec {
            inputs: vec![
                int("length", "Length", 20, 2, 500),
                source(PriceSource::Close),
                labelled(number("mult", "Std dev", 2.0, 0.1, 10.0, 0.1)),
            ],
            plots: vec![
                plot(
                    "basis",
                    "Basis",
                    PlotKind::Line,
                    style("t3", 1.0, LineDash::Dash, 1.0),
                ),
                line("upper", "Upper", "t3", 1.0),
                line("lower", "Lower", "t3", 1.0),
            ],
            fills: vec![fill("band", "Background", "upper", "lower", 0.03, true)],
            ..spec(kind, "Bollinger Bands", "BB", Volatility, Overlay)
        },
        LayerKind::Macd => IndicatorSpec {
            inputs: vec![
                int("fast", "Fast length", 12, 1, 500),
                int("slow", "Slow length", 26, 1, 500),
                int("signal", "Signal length", 9, 1, 500),
                source(PriceSource::Close),
            ],
            plots: vec![
                guide("zero", "Zero", 0.0),
                histogram("hist", "Histogram", PlotColorBy::Sign, 0.5),
                line("macd", "MACD", "mist", 1.25),
                line("signal", "Signal", "t3", 1.25),
            ],
            format: ValueFormat::Number,
            ..spec(kind, "MACD", "MACD", Momentum, Pane)
        },
        LayerKind::Stochastic => IndicatorSpec {
            inputs: vec![
                int("length", "%K length", 14, 1, 500),
                int("smoothK", "%K smoothing", 1, 1, 100),
                int("smoothD", "%D smoothing", 3, 1, 100),
                number("upper", "Upper band", 80.0, 50.0, 100.0, 1.0),
                number("lower", "Lower band", 20.0, 0.0, 50.0, 1.0),
            ],
            plots: vec![
                guide_at("upperBand", "Upper band", "upper"),
                IndicatorPlot {
                    default: PlotStyle {
                        visible: false,
                        ..style("t4", 1.0, LineDash::Dot, 1.0)
                    },
                    ..guide("middle", "Middle", 50.0)
                },
                guide_at("lowerBand", "Lower band", "lower"),
                line("k", "%K", "mist", 1.25),
                line("d", "%D", "t3", 1.25),
            ],
            fills: vec![fill(
                "zone",
                "Background",
                "upperBand",
                "lowerBand",
                0.04,
                true,
            )],
            range: Some(vec![0.0, 100.0]),
            format: ValueFormat::Number,
            ..spec(kind, "Stochastic", "Stoch", Momentum, Pane)
        },
        LayerKind::Footprint => IndicatorSpec {
            inputs: vec![
                choice(
                    "mode",
                    "Show",
                    &[
                        ("bid_ask", "Bid × Ask"),
                        ("delta", "Delta"),
                        ("volume", "Volume"),
                        ("trades", "Trades"),
                        ("histogram", "Bid × Ask histogram"),
                    ],
                ),
                choice(
                    "tint",
                    "Cell tint",
                    &[("volume", "Volume"), ("delta", "Delta"), ("none", "None")],
                ),
                row_ticks(),
                hint(
                    "Cells trading less than this share of their bar's busiest level fade.",
                    zero_label(
                        "Off",
                        IndicatorInput {
                            step: Some(5.0),
                            ..int("dimBelow", "Dim below %", 0, 0, 90)
                        },
                    ),
                ),
                choice(
                    "maxLevel",
                    "Max level",
                    &[
                        ("off", "Off"),
                        ("volume", "Volume"),
                        ("trades", "Trades"),
                        ("bid", "Bid"),
                        ("ask", "Ask"),
                    ],
                ),
                labelled(number("ratio", "Imbalance ratio", 3.0, 1.5, 10.0, 0.5)),
                IndicatorInput {
                    in_label: false,
                    ..int("minVolume", "Min volume", 5, 1, 10_000)
                },
                IndicatorInput {
                    in_label: false,
                    ..int("minDifference", "Min difference", 0, 0, 10_000)
                },
                boolean("includeZero", "Include zero", false),
                IndicatorInput {
                    in_label: false,
                    ..int("stackRows", "Stack rows", 3, 2, 8)
                },
                boolean("extendZones", "Extend zones", true),
                boolean("poc", "POC", true),
                boolean("deltaPoc", "Delta POC", true),
                boolean("valueArea", "Value area", true),
                boolean("unfinished", "Unfinished auctions", true),
                boolean("stats", "Bar stats table", false),
                days_to_load(),
            ],
            format: ValueFormat::Volume,
            ..spec(kind, "Footprint", "Footprint", OrderFlow, Overlay)
        },
        LayerKind::VolumeProfile => IndicatorSpec {
            inputs: vec![
                choice(
                    "period",
                    "Period",
                    &[
                        ("session", "Session"),
                        ("day", "Day"),
                        ("week", "Week"),
                        ("month", "Month"),
                        ("composite", "Composite"),
                        ("range", "Fixed range"),
                        ("anchored", "Anchored"),
                        ("visible", "Visible"),
                    ],
                ),
                when(
                    "period",
                    "composite",
                    choice(
                        "compositePeriod",
                        "Composite of",
                        &[
                            ("session", "Sessions"),
                            ("day", "Days"),
                            ("week", "Weeks"),
                            ("month", "Months"),
                        ],
                    ),
                ),
                when_any(
                    "period",
                    &["session", "day", "week", "month", "composite"],
                    IndicatorInput {
                        max: None,
                        ..int("length", "Length", 5, 1, 1)
                    },
                ),
                when_any(
                    "period",
                    &["range", "anchored"],
                    input("from", "From", InputType::Time, json!("")),
                ),
                when(
                    "period",
                    "range",
                    input("to", "To", InputType::Time, json!("")),
                ),
                choice(
                    "hours",
                    "Hours",
                    &[
                        ("chart", "Chart"),
                        ("all", "Whole session"),
                        ("rth", "RTH only"),
                        ("split", "RTH and ETH apart"),
                    ],
                ),
                plain(choice(
                    "contract",
                    "Contract",
                    &[("chart", "Chart’s contract")],
                )),
                choice(
                    "show",
                    "Show",
                    &[
                        ("volume", "Volume"),
                        ("split", "Bid/Ask split"),
                        ("delta", "Delta"),
                        ("volumeDelta", "Volume and delta"),
                    ],
                ),
                IndicatorInput {
                    in_label: false,
                    ..int("valueArea", "Value area %", 70, 50, 95)
                },
                row_ticks(),
                when_any(
                    "period",
                    &PROFILE_PERIODS,
                    choice(
                        "side",
                        "Profile side",
                        &[("left", "Period start"), ("right", "Period end")],
                    ),
                ),
                when_any(
                    "period",
                    &PROFILE_PERIODS,
                    boolean("priorVa", "Prior period POC and VA", false),
                ),
                when_any(
                    "period",
                    &PROFILE_PERIODS,
                    boolean("nakedPocs", "Naked POCs", true),
                ),
                boolean("extendLines", "Extend POC and VA lines", false),
                boolean("developingPoc", "Developing POC", false),
                boolean("developingVa", "Developing VA", false),
                boolean("nodes", "HVN · LVN", false),
                days_to_load(),
            ],
            plots: vec![
                plot(
                    "poc",
                    "POC",
                    PlotKind::Line,
                    style("mist", 1.0, LineDash::Solid, 0.7),
                ),
                plot(
                    "vah",
                    "VAH",
                    PlotKind::Line,
                    style("t3", 1.0, LineDash::Dot, 1.0),
                ),
                plot(
                    "val",
                    "VAL",
                    PlotKind::Line,
                    style("t3", 1.0, LineDash::Dot, 1.0),
                ),
            ],
            format: ValueFormat::Price,
            ..spec(kind, "Volume profile", "VP", OrderFlow, Overlay)
        },
        LayerKind::MarketProfile => IndicatorSpec {
            inputs: vec![
                choice(
                    "period",
                    "Period",
                    &[
                        ("session", "Session"),
                        ("day", "Day"),
                        ("week", "Week"),
                        ("month", "Month"),
                    ],
                ),
                plain(IndicatorInput {
                    max: None,
                    ..int("length", "Length", 5, 1, 1)
                }),
                IndicatorInput {
                    default: json!("30"),
                    ..labelled(choice(
                        "tpo",
                        "TPO size",
                        &[
                            ("5", "5 min"),
                            ("10", "10 min"),
                            ("15", "15 min"),
                            ("30", "30 min"),
                            ("60", "60 min"),
                        ],
                    ))
                },
                segmented(choice(
                    "style",
                    "Draw as",
                    &[("letters", "Letters"), ("blocks", "Blocks")],
                )),
                choice(
                    "hours",
                    "Hours",
                    &[
                        ("chart", "Chart"),
                        ("all", "Whole session"),
                        ("rth", "RTH only"),
                    ],
                ),
                plain(choice(
                    "contract",
                    "Contract",
                    &[("chart", "Chart’s contract")],
                )),
                IndicatorInput {
                    in_label: false,
                    ..int("valueArea", "Value area %", 70, 50, 95)
                },
                IndicatorInput {
                    in_label: false,
                    ..row_ticks()
                },
                boolean("ib", "Initial balance", true),
            ],
            plots: vec![
                plot(
                    "poc",
                    "POC",
                    PlotKind::Line,
                    style("mist", 1.0, LineDash::Solid, 0.7),
                ),
                plot(
                    "vah",
                    "VAH",
                    PlotKind::Line,
                    style("t3", 1.0, LineDash::Dot, 1.0),
                ),
                plot(
                    "val",
                    "VAL",
                    PlotKind::Line,
                    style("t3", 1.0, LineDash::Dot, 1.0),
                ),
            ],
            format: ValueFormat::Price,
            ..spec(kind, "Market profile (TPO)", "TPO", OrderFlow, Overlay)
        },
        LayerKind::Delta => IndicatorSpec {
            inputs: vec![
                choice(
                    "mode",
                    "Mode",
                    &[("cumulative", "Cumulative"), ("bar", "Bar delta")],
                ),
                choice(
                    "style",
                    "CVD style",
                    &[
                        ("candles", "Candles"),
                        ("line", "Line"),
                        ("histogram", "Histogram"),
                    ],
                ),
                choice(
                    "reset",
                    "Reset",
                    &[("session", "Session"), ("chart", "Chart start")],
                ),
                boolean("barStats", "Bar stats", true),
                hint(
                    "Bars whose delta is at least this share of their volume stand out; the rest fade.",
                    zero_label(
                        "Off",
                        IndicatorInput {
                            step: Some(5.0),
                            ..int("highlight", "Highlight delta %", 0, 0, 100)
                        },
                    ),
                ),
                boolean("divergence", "Divergences", false),
                days_to_load(),
            ],
            plots: vec![
                guide("zero", "Zero", 0.0),
                histogram("delta", "Histogram", PlotColorBy::Sign, 0.5),
                plot(
                    "cvd",
                    "CVD line",
                    PlotKind::Line,
                    style("mist", 1.25, LineDash::Solid, 0.55),
                ),
            ],
            height: Some(0.22),
            format: ValueFormat::Volume,
            ..spec(kind, "Delta and CVD", "CVD", OrderFlow, Pane)
        },
        LayerKind::Effort => IndicatorSpec {
            inputs: vec![
                plain(number(
                    "minDeltaPercent",
                    "Min |delta| %",
                    10.0,
                    0.0,
                    100.0,
                    1.0,
                )),
                plain(number(
                    "maxDeltaPercent",
                    "Max |delta| %",
                    40.0,
                    0.0,
                    100.0,
                    1.0,
                )),
                plain(number(
                    "maxDeltaPerTick",
                    "Max |delta| per tick",
                    14.0,
                    0.0,
                    100_000.0,
                    1.0,
                )),
                plain(number(
                    "maxBarSeconds",
                    "Max bar seconds",
                    45.0,
                    0.0,
                    3600.0,
                    1.0,
                )),
                plain(int("minBars", "Bars to arm", 2, 1, 50)),
                plain(int("fullRangeBars", "Full-range bars", 1, 0, 50)),
                plain(number("keepPercent", "Band kept %", 50.0, 0.0, 100.0, 5.0)),
                plain(int("extendBars", "Project bars", 20, 1, 200)),
                plain(number(
                    "tickSize",
                    "Tick size",
                    0.25,
                    0.000_001,
                    100.0,
                    0.25,
                )),
                plain(number("opacity", "Fill opacity", 0.18, 0.0, 1.0, 0.02)),
                plain(colour("buyColor", "Buy band", "#26a69a")),
                plain(colour("sellColor", "Sell band", "#ef5350")),
            ],
            ..spec(kind, "Effort absorption", "Effort", Special, Overlay)
        },
        LayerKind::BigTrades => IndicatorSpec {
            inputs: vec![
                segmented(choice(
                    "size",
                    "Min size",
                    &[("auto", "Auto"), ("fixed", "Fixed")],
                )),
                when(
                    "size",
                    "auto",
                    hint(
                        "Auto measures the five sessions before the trade date. Low is about the 120th largest event of a session, Medium the 45th and High the 15th. Each pick also shows the tiers above it.",
                        segmented(choice(
                            "tier",
                            "Auto shows",
                            &[("low", "Low"), ("medium", "Medium"), ("high", "High")],
                        )),
                    ),
                ),
                when("size", "fixed", int("minSize", "At least", 60, 1, 100_000)),
                when(
                    "size",
                    "fixed",
                    zero_label("None", int("maxSize", "At most", 0, 0, 100_000)),
                ),
                boolean("showSize", "Show size", true),
                choice(
                    "price",
                    "Plot at",
                    &[
                        ("vwap", "Average price"),
                        ("start", "First print"),
                        ("last", "Last print"),
                    ],
                ),
                boolean("joinOrders", "Join an order's fills", true),
                boolean("reachLimit", "Stop 2 ticks past the sweep", true),
                hint(
                    "A zone is a band one tick either side of a big trade's price, from the next bar until a bar trades through it. Body and wick pick trades by where they sit in their bar. With the bar means a buy in an up bar or a sell in a down bar.",
                    choice("zones", "Zones", &[("off", "Off"), ("on", "On")]),
                ),
                when("zones", "on", int("zoneBars", "Bars forward", 10, 1, 200)),
                when(
                    "zones",
                    "on",
                    boolean("zoneBiggest", "Biggest of each bar only", false),
                ),
                when(
                    "zones",
                    "on",
                    choice(
                        "zoneBody",
                        "Trades in the body",
                        &[
                            ("trend", "With the bar"),
                            ("all", "All"),
                            ("reversal", "Against the bar"),
                            ("none", "None"),
                        ],
                    ),
                ),
                when(
                    "zones",
                    "on",
                    choice(
                        "zoneWick",
                        "Trades in the wick",
                        &[
                            ("all", "All"),
                            ("trend", "With the bar"),
                            ("reversal", "Against the bar"),
                            ("none", "None"),
                        ],
                    ),
                ),
                days_to_load(),
            ],
            format: ValueFormat::Volume,
            ..spec(kind, "Big trades", "Big trades", OrderFlow, Overlay)
        },
        LayerKind::StackedImbalance => IndicatorSpec {
            inputs: vec![
                labelled(number("ratio", "Imbalance ratio", 3.0, 1.5, 10.0, 0.5)),
                int("stackRows", "Minimum stack", 3, 2, 8),
                plain(int("minVolume", "Min volume", 5, 1, 10_000)),
                plain(int("minDifference", "Min difference", 0, 0, 10_000)),
                boolean("includeZero", "Include zero", false),
                IndicatorInput {
                    in_label: false,
                    ..row_ticks()
                },
                boolean("tested", "Tested zones", true),
            ],
            format: ValueFormat::Price,
            ..spec(kind, "Stacked imbalance", "Stacks", OrderFlow, Overlay)
        },
        LayerKind::OpeningRange => IndicatorSpec {
            inputs: vec![
                int("minutes", "Opening range minutes", 15, 1, 240),
                plain(int("ib", "Initial balance minutes", 60, 1, 240)),
                segmented(choice(
                    "open",
                    "Starts at",
                    &[("rth", "Regular open"), ("session", "Session open")],
                )),
                segmented(choice(
                    "extensions",
                    "Extensions of",
                    &[("ib", "Initial balance"), ("range", "Opening range")],
                )),
            ],
            plots: vec![
                plot(
                    "orHigh",
                    "OR high",
                    PlotKind::Line,
                    style("t1", 1.0, LineDash::Dash, 0.9),
                ),
                plot(
                    "orLow",
                    "OR low",
                    PlotKind::Line,
                    style("t1", 1.0, LineDash::Dash, 0.9),
                ),
                plot(
                    "ibHigh",
                    "IB high",
                    PlotKind::Line,
                    style("mist", 1.0, LineDash::Dash, 0.8),
                ),
                plot(
                    "ibLow",
                    "IB low",
                    PlotKind::Line,
                    style("mist", 1.0, LineDash::Dash, 0.8),
                ),
                plot(
                    "ibMid",
                    "IB mid",
                    PlotKind::Line,
                    PlotStyle {
                        visible: false,
                        ..style("mist", 1.0, LineDash::Dot, 0.8)
                    },
                ),
                plot(
                    "up50",
                    "+50%",
                    PlotKind::Line,
                    style("t4", 1.0, LineDash::Dash, 1.0),
                ),
                plot(
                    "up100",
                    "+100%",
                    PlotKind::Line,
                    style("t4", 1.0, LineDash::Dash, 1.0),
                ),
                plot(
                    "down50",
                    "−50%",
                    PlotKind::Line,
                    style("t4", 1.0, LineDash::Dash, 1.0),
                ),
                plot(
                    "down100",
                    "−100%",
                    PlotKind::Line,
                    style("t4", 1.0, LineDash::Dash, 1.0),
                ),
            ],
            fills: vec![fill(
                "range",
                "Opening range fill",
                "orHigh",
                "orLow",
                0.04,
                true,
            )],
            session_reset: true,
            ..spec(kind, "Opening range", "OR", Volatility, Overlay)
        },
        _ => return None,
    };
    Some(s)
}

const PROFILE_PERIODS: [&str; 4] = ["session", "day", "week", "month"];

fn days_to_load() -> IndicatorInput {
    hint(
        "Sessions of history it fetches, this one counting as one. Older bars use what is already saved.",
        IndicatorInput {
            in_label: false,
            ..int("daysToLoad", "Days to load", 2, 1, 60)
        },
    )
}

fn row_ticks() -> IndicatorInput {
    choice(
        "rowTicks",
        "Row size",
        &[
            ("auto", "Auto"),
            ("1", "1 tick"),
            ("2", "2 ticks"),
            ("4", "4 ticks"),
            ("5", "5 ticks"),
            ("10", "10 ticks"),
            ("20", "20 ticks"),
            ("25", "25 ticks"),
            ("50", "50 ticks"),
            ("100", "100 ticks"),
        ],
    )
}

pub fn indicator_specs() -> Vec<IndicatorSpec> {
    LayerKind::ALL
        .into_iter()
        .filter_map(indicator_spec)
        .collect()
}

/// `params` of a `custom` layer: the custom indicator it draws, then the same `{ inputs, style,
/// height }` as a built-in indicator's, against that indicator's own declaration.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CustomLayerParams {
    /// The custom indicator's id (`indicators.list`).
    pub indicator: String,
    /// A saved version to draw; the latest when omitted, so a save shows on the chart at once.
    #[serde(default)]
    pub version: Option<u32>,
    /// Input values by key.
    #[serde(default)]
    #[ts(optional, type = "Record<string, number | string | boolean>")]
    pub inputs: Option<BTreeMap<String, Value>>,
    /// Styles of plots and fills by key.
    #[serde(default)]
    pub style: Option<IndicatorStyleParams>,
    /// Pane indicators: share of the plot height (0.05–0.8).
    #[serde(default)]
    pub height: Option<f64>,
}

pub trait CustomIndicators: Send + Sync {
    fn custom_spec(&self, id: &str, version: Option<u32>) -> Result<IndicatorSpec, String>;
}

pub fn custom_ref(params: &Value) -> Result<(String, Option<u32>), String> {
    let id = params
        .get("indicator")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("params.indicator names the custom indicator (its id in indicators.list)")?;
    let version = match params.get("version") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v >= 1)
                .ok_or("params.version is a saved version (1, 2, …)")?,
        ),
    };
    Ok((id.to_owned(), version))
}

pub fn normalize_custom_params(
    spec: Option<&IndicatorSpec>,
    params: &Value,
) -> Result<Value, String> {
    let params = if params.is_null() {
        json!({})
    } else {
        params.clone()
    };
    let p: CustomLayerParams = serde_json::from_value(params.clone()).map_err(|e| {
        if e.to_string().contains("missing field `indicator`") {
            "params.indicator names the custom indicator (its id in indicators.list)".to_owned()
        } else {
            e.to_string()
        }
    })?;
    let (id, version) = custom_ref(&params)?;
    let mut rest = Map::new();
    if let Some(i) = p.inputs {
        rest.insert("inputs".into(), json!(i));
    }
    if let Some(s) = params.get("style") {
        rest.insert("style".into(), s.clone());
    }
    if let Some(h) = p.height {
        rest.insert("height".into(), json!(h));
    }
    let mut out = match spec {
        Some(spec) => normalize_params(spec, &Value::Object(rest))?,
        None => Value::Object(rest),
    };
    let o = out.as_object_mut().ok_or("params are an object")?;
    o.insert("indicator".into(), json!(id));
    if let Some(v) = version {
        o.insert("version".into(), json!(v));
    }
    Ok(out)
}

const BIG_TRADES_TIER_INPUTS: [&str; 4] = ["mode", "high", "medium", "low"];
const BIG_TRADES_TIERS: [&str; 3] = ["low", "medium", "high"];

fn big_trades_by_size(obj: &Map<String, Value>) -> Option<Value> {
    let inputs = obj.get("inputs")?.as_object()?;
    if inputs.contains_key("size") {
        return None;
    }
    let tiered = BIG_TRADES_TIER_INPUTS
        .iter()
        .any(|k| inputs.contains_key(*k));
    let min = inputs.get("minSize").and_then(Value::as_f64);
    if !tiered && min.is_none() {
        return None;
    }
    let positive = min.is_some_and(|m| m > 0.0);
    let fixed = if tiered {
        inputs.get("mode").and_then(Value::as_str) == Some("manual")
    } else {
        positive
    };
    let tier = BIG_TRADES_TIERS
        .into_iter()
        .find(|k| inputs.get(*k) != Some(&json!(false)))
        .unwrap_or("low");
    let mut migrated = inputs.clone();
    for k in BIG_TRADES_TIER_INPUTS {
        migrated.remove(k);
    }
    if min.is_some() && !positive {
        migrated.remove("minSize");
    }
    migrated.insert("size".into(), json!(if fixed { "fixed" } else { "auto" }));
    if !fixed {
        migrated.insert("tier".into(), json!(tier));
    }
    let mut rest = obj.clone();
    rest.insert("inputs".into(), Value::Object(migrated));
    Some(Value::Object(rest))
}

pub fn migrate_legacy(kind: LayerKind, params: &Value) -> Value {
    let Some(obj) = params.as_object() else {
        return params.clone();
    };
    if kind == LayerKind::BigTrades {
        return big_trades_by_size(obj).unwrap_or_else(|| params.clone());
    }
    if obj.contains_key("inputs") || obj.contains_key("style") {
        return params.clone();
    }
    match kind {
        LayerKind::Sma | LayerKind::Ema if obj.contains_key("period") => {
            let mut rest = obj.clone();
            let period = rest.remove("period").unwrap_or(Value::Null);
            rest.insert("inputs".into(), json!({ "length": period }));
            Value::Object(rest)
        }
        LayerKind::Vwap if obj.contains_key("bands") => {
            let mut rest = obj.clone();
            let bands = rest.remove("bands").unwrap_or(Value::Null);
            let mut inputs = Map::new();
            for (n, k) in legacy_vwap_mults(&bands).into_iter().enumerate() {
                inputs.insert(format!("mult{}", n + 1), json!(k));
            }
            rest.insert("inputs".into(), Value::Object(inputs));
            Value::Object(rest)
        }
        LayerKind::Volume if obj.contains_key("mode") => {
            let mut rest = obj.clone();
            rest.remove("mode");
            Value::Object(rest)
        }
        _ => params.clone(),
    }
}

pub fn legacy_vwap_mults(bands: &Value) -> Vec<f64> {
    let mut ks: Vec<f64> = bands
        .as_array()
        .map(|l| {
            l.iter()
                .filter_map(Value::as_f64)
                .filter(|k| k.is_finite())
                .collect()
        })
        .unwrap_or_default();
    ks.sort_by(f64::total_cmp);
    ks.truncate(3);
    let (lo, hi) = indicator_spec(LayerKind::Vwap)
        .and_then(|s| s.inputs.into_iter().find(|i| i.key == "mult1"))
        .map_or((0.1, 5.0), |i| (i.min.unwrap_or(0.1), i.max.unwrap_or(5.0)));
    ks.into_iter().map(|k| k.clamp(lo, hi)).collect()
}

pub fn is_color(s: &str) -> bool {
    if COLOR_SWATCHES.contains(&s) {
        return true;
    }
    let Some(hex) = s.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

fn check_color(what: &str, c: &str) -> Result<(), String> {
    if is_color(c) {
        Ok(())
    } else {
        Err(format!(
            "{what}: {c:?} is not a colour (a swatch: {}, or #rrggbb)",
            COLOR_SWATCHES.join(", ")
        ))
    }
}

pub fn is_session_hours(s: &str) -> bool {
    fn clock(t: &str) -> Option<u32> {
        let (h, m) = t.trim().split_once(':')?;
        let digits = |x: &str, n: std::ops::RangeInclusive<usize>| {
            n.contains(&x.len()) && x.bytes().all(|b| b.is_ascii_digit())
        };
        if !digits(h, 1..=2) || !digits(m, 2..=2) {
            return None;
        }
        let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
        (m <= 59).then_some(h * 60 + m)
    }
    let Some((from, to)) = s.split_once('-') else {
        return false;
    };
    matches!((clock(from), clock(to)), (Some(a), Some(b)) if a < 1440 && b <= 1440)
}

fn check_range(what: &str, v: f64, (lo, hi): (f64, f64)) -> Result<f64, String> {
    if v.is_finite() && v >= lo && v <= hi {
        Ok(v)
    } else {
        Err(format!("{what} must be {lo}–{hi}"))
    }
}

fn normalize_input(i: &IndicatorInput, v: &Value) -> Result<Value, String> {
    let what = format!("inputs.{}", i.key);
    let bounds = (i.min.unwrap_or(f64::MIN), i.max.unwrap_or(f64::MAX));
    match i.ty {
        InputType::Number => {
            let n = v
                .as_f64()
                .ok_or_else(|| format!("{what} must be a number"))?;
            Ok(json!(check_range(&what, n, bounds)?))
        }
        InputType::Int => {
            let n = v
                .as_f64()
                .ok_or_else(|| format!("{what} must be a whole number"))?;
            if n.fract() != 0.0 {
                return Err(format!("{what} must be a whole number"));
            }
            Ok(json!(check_range(&what, n, bounds)? as i64))
        }
        InputType::Enum => {
            let s = v
                .as_str()
                .ok_or_else(|| format!("{what} must be a string"))?;
            let options = i.options.as_deref().unwrap_or_default();
            if options.iter().any(|o| o.value == s) {
                Ok(json!(s))
            } else {
                let all: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
                Err(format!("{what} must be one of {}", all.join(", ")))
            }
        }
        InputType::Source => {
            let s = v.as_str().unwrap_or_default();
            if PriceSource::ALL.iter().any(|p| p.as_str() == s) {
                Ok(json!(s))
            } else {
                let all: Vec<&str> = PriceSource::ALL.iter().map(|p| p.as_str()).collect();
                Err(format!("{what} must be one of {}", all.join(", ")))
            }
        }
        InputType::Bool => v
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| format!("{what} must be true or false")),
        InputType::Color => {
            let s = v
                .as_str()
                .ok_or_else(|| format!("{what} must be a colour"))?;
            check_color(&what, s)?;
            Ok(json!(s))
        }
        InputType::Session => match v.as_str() {
            Some(s) if is_session_hours(s) => Ok(json!(s)),
            _ => Err(format!(
                "{what} must be hours of the day as HH:MM-HH:MM (09:30-11:00), not {v}"
            )),
        },
        InputType::Timezone => match v.as_str() {
            Some(s) if s.parse::<ExchangeTz>().is_ok() => Ok(json!(s)),
            _ => Err(format!(
                "{what}: {v} is not a time zone (an IANA name such as America/New_York, Europe/London or UTC)"
            )),
        },
        InputType::Time => match v {
            Value::String(s) if s.is_empty() => Ok(json!("")),
            _ => serde_json::from_value::<Timestamp>(v.clone())
                .map(|t| json!(t.to_rfc3339()))
                .map_err(|_| {
                    format!("{what} must be a time as RFC 3339 (2026-09-08T09:30:00-04:00) or nanoseconds, not {v}")
                }),
        },
    }
}

fn plot_style(
    key: &str,
    base: &PlotStyle,
    p: Option<&PlotStyleParams>,
) -> Result<PlotStyle, String> {
    let Some(p) = p else {
        return Ok(base.clone());
    };
    let what = |f: &str| format!("style.plots.{key}.{f}");
    let s = PlotStyle {
        color: p.color.clone().unwrap_or_else(|| base.color.clone()),
        down_color: p.down_color.clone().or_else(|| base.down_color.clone()),
        width: check_range(&what("width"), p.width.unwrap_or(base.width), WIDTH_RANGE)?,
        line: p.line.unwrap_or(base.line),
        opacity: check_range(
            &what("opacity"),
            p.opacity.unwrap_or(base.opacity),
            (0.0, 1.0),
        )?,
        visible: p.visible.unwrap_or(base.visible),
    };
    check_color(&what("color"), &s.color)?;
    if let Some(c) = &s.down_color {
        check_color(&what("downColor"), c)?;
    }
    Ok(s)
}

fn fill_style(
    key: &str,
    base: &FillStyle,
    p: Option<&FillStyleParams>,
) -> Result<FillStyle, String> {
    let Some(p) = p else {
        return Ok(base.clone());
    };
    let what = |f: &str| format!("style.fills.{key}.{f}");
    let s = FillStyle {
        color: p.color.clone().unwrap_or_else(|| base.color.clone()),
        opacity: check_range(
            &what("opacity"),
            p.opacity.unwrap_or(base.opacity),
            (0.0, 1.0),
        )?,
        visible: p.visible.unwrap_or(base.visible),
    };
    check_color(&what("color"), &s.color)?;
    Ok(s)
}

pub fn normalize_params(spec: &IndicatorSpec, params: &Value) -> Result<Value, String> {
    let migrated = if params.is_null() {
        json!({})
    } else {
        migrate_legacy(spec.kind, params)
    };
    let p: IndicatorParams = serde_json::from_value(migrated).map_err(|e| e.to_string())?;
    let given = p.inputs.unwrap_or_default();
    if let Some(unknown) = given
        .keys()
        .find(|k| !spec.inputs.iter().any(|i| &i.key == *k))
    {
        let known: Vec<&str> = spec.inputs.iter().map(|i| i.key.as_str()).collect();
        return Err(format!(
            "{} has no input {unknown} (inputs: {})",
            spec.short,
            known.join(", ")
        ));
    }
    let mut inputs = Map::new();
    for i in &spec.inputs {
        let v = match given.get(&i.key) {
            Some(v) => normalize_input(i, v)?,
            None => i.default.clone(),
        };
        inputs.insert(i.key.clone(), v);
    }
    let style = p.style.unwrap_or_default();
    let plots_in = style.plots.unwrap_or_default();
    let fills_in = style.fills.unwrap_or_default();
    if let Some(unknown) = plots_in
        .keys()
        .find(|k| !spec.plots.iter().any(|x| &x.key == *k))
    {
        let known: Vec<&str> = spec.plots.iter().map(|x| x.key.as_str()).collect();
        return Err(format!(
            "{} has no plot {unknown} (plots: {})",
            spec.short,
            known.join(", ")
        ));
    }
    if let Some(unknown) = fills_in
        .keys()
        .find(|k| !spec.fills.iter().any(|x| &x.key == *k))
    {
        return Err(format!("{} has no fill {unknown}", spec.short));
    }
    let mut plots = Map::new();
    for x in &spec.plots {
        let s = plot_style(&x.key, &x.default, plots_in.get(&x.key))?;
        plots.insert(
            x.key.clone(),
            serde_json::to_value(s).map_err(|e| e.to_string())?,
        );
    }
    let mut fills = Map::new();
    for x in &spec.fills {
        let s = fill_style(&x.key, &x.default, fills_in.get(&x.key))?;
        fills.insert(
            x.key.clone(),
            serde_json::to_value(s).map_err(|e| e.to_string())?,
        );
    }
    let mut style_out = json!({ "plots": Value::Object(plots), "fills": Value::Object(fills) });
    match (has_labels(spec), style.labels) {
        (true, given) => {
            let d = default_labels(spec);
            let given = given.unwrap_or_default();
            let labels = IndicatorLabels {
                price_scale: given.price_scale.unwrap_or(d.price_scale),
                name: given.name.unwrap_or(d.name),
                value: given.value.unwrap_or(d.value),
            };
            style_out["labels"] = serde_json::to_value(labels).map_err(|e| e.to_string())?;
        }
        (false, Some(_)) => {
            return Err(format!("{} has no line to label", spec.short));
        }
        (false, None) => {}
    }
    let mut out = Map::new();
    out.insert("inputs".into(), Value::Object(inputs));
    out.insert("style".into(), style_out);
    match (spec.height, p.height) {
        (Some(default), h) => {
            let h = check_range("height", h.unwrap_or(default), HEIGHT_RANGE)?;
            out.insert("height".into(), json!(h));
        }
        (None, Some(_)) => {
            return Err(format!("{} draws on the price pane: no height", spec.short));
        }
        (None, None) => {}
    }
    Ok(Value::Object(out))
}

pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Some(p) = patch.as_object() else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let t = target.as_object_mut().expect("object");
    for (k, v) in p {
        if v.is_null() {
            t.remove(k);
        } else {
            merge_patch(t.entry(k.clone()).or_insert(Value::Null), v);
        }
    }
}

fn color_schema() -> Value {
    json!({
        "type": "string",
        "description": format!(
            "A palette swatch ({}) or a custom #rrggbb / #rrggbbaa colour.",
            COLOR_SWATCHES.join(", ")
        ),
        "anyOf": [
            { "enum": COLOR_SWATCHES },
            { "pattern": "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" }
        ]
    })
}

fn input_schema(i: &IndicatorInput) -> Value {
    let mut s = match i.ty {
        InputType::Number => json!({ "type": "number", "minimum": i.min, "maximum": i.max }),
        InputType::Int => json!({ "type": "integer", "minimum": i.min, "maximum": i.max }),
        InputType::Enum => json!({
            "type": "string",
            "enum": i.options.iter().flatten().map(|o| o.value.clone()).collect::<Vec<_>>()
        }),
        InputType::Source => json!({
            "type": "string",
            "enum": PriceSource::ALL.iter().map(|p| p.as_str()).collect::<Vec<_>>()
        }),
        InputType::Bool => json!({ "type": "boolean" }),
        InputType::Color => color_schema(),
        InputType::Session => json!({
            "type": "string",
            "pattern": r"^\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*$"
        }),
        InputType::Timezone => json!({ "type": "string" }),
        InputType::Time => json!({ "type": ["string", "integer"] }),
    };
    let o = s.as_object_mut().expect("object");
    o.insert("description".into(), json!(i.label));
    o.insert("default".into(), i.default.clone());
    s
}

pub fn params_schema(spec: &IndicatorSpec) -> Value {
    let inputs: Map<String, Value> = spec
        .inputs
        .iter()
        .map(|i| (i.key.clone(), input_schema(i)))
        .collect();
    let plots: Map<String, Value> = spec
        .plots
        .iter()
        .map(|x| {
            (
                x.key.clone(),
                json!({ "$ref": "#/$defs/PlotStyle", "description": x.label }),
            )
        })
        .collect();
    let fills: Map<String, Value> = spec
        .fills
        .iter()
        .map(|x| {
            (
                x.key.clone(),
                json!({ "$ref": "#/$defs/FillStyle", "description": x.label }),
            )
        })
        .collect();
    let mut properties = json!({
        "inputs": {
            "type": "object",
            "description": "Input values; omitted inputs keep their defaults (or, in chart.update_layer, their current values).",
            "properties": inputs,
            "additionalProperties": false
        },
        "style": {
            "type": "object",
            "description": "How each plot and fill is drawn; omitted fields keep their values.",
            "properties": {
                "plots": { "type": "object", "properties": plots, "additionalProperties": false },
                "fills": { "type": "object", "properties": fills, "additionalProperties": false }
            },
            "additionalProperties": false
        }
    });
    if has_labels(spec) {
        let d = default_labels(spec);
        properties["style"]["properties"]
            .as_object_mut()
            .expect("object")
            .insert(
                "labels".into(),
                json!({
                    "type": "object",
                    "description": "The labels its lines carry, as TradingView's style options.",
                    "properties": {
                        "priceScale": { "type": "boolean", "default": d.price_scale, "description": "Each shown line's last value tagged on the price scale." },
                        "name": { "type": "boolean", "default": d.name, "description": "A label at each shown line's right end naming it (the indicator for one line, the plot for several)." },
                        "value": { "type": "boolean", "default": d.value, "description": "The name label also reads the line's value." }
                    },
                    "additionalProperties": false
                }),
            );
    }
    if let Some(h) = spec.height {
        properties.as_object_mut().expect("object").insert(
            "height".into(),
            json!({
                "type": "number",
                "minimum": HEIGHT_RANGE.0,
                "maximum": HEIGHT_RANGE.1,
                "default": h,
                "description": "Share of the plot height the indicator's pane takes."
            }),
        );
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": format!("{} params", spec.title),
        "type": "object",
        "properties": properties,
        "additionalProperties": false,
        "$defs": {
            "PlotStyle": {
                "type": "object",
                "properties": {
                    "color": color_schema(),
                    "downColor": color_schema(),
                    "width": { "type": "number", "minimum": WIDTH_RANGE.0, "maximum": WIDTH_RANGE.1 },
                    "line": { "type": "string", "enum": ["solid", "dash", "dot"] },
                    "opacity": { "type": "number", "minimum": 0, "maximum": 1 },
                    "visible": { "type": "boolean" }
                },
                "additionalProperties": false
            },
            "FillStyle": {
                "type": "object",
                "properties": {
                    "color": color_schema(),
                    "opacity": { "type": "number", "minimum": 0, "maximum": 1 },
                    "visible": { "type": "boolean" }
                },
                "additionalProperties": false
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rsi() -> IndicatorSpec {
        indicator_spec(LayerKind::Rsi).unwrap()
    }

    #[test]
    fn an_input_shown_under_a_choice_names_the_choice_and_one_of_its_values() {
        for spec in indicator_specs() {
            for i in spec.inputs.iter().filter(|i| i.when.is_some()) {
                let w = i.when.as_ref().unwrap();
                let choice = spec.inputs.iter().find(|c| c.key == w.input);
                let choice = choice.unwrap_or_else(|| panic!("{}: {}", spec.short, w.input));
                assert_eq!(choice.ty, InputType::Enum, "{}", spec.short);
                let options = choice.options.as_deref().unwrap_or_default();
                assert!(!w.values.is_empty(), "{}", i.key);
                for v in &w.values {
                    assert!(options.iter().any(|o| &o.value == v), "{}", i.key);
                }
            }
        }
    }

    #[test]
    fn big_trades_size_is_auto_with_a_tier_or_fixed_with_a_band() {
        let spec = indicator_spec(LayerKind::BigTrades).unwrap();
        let p = normalize_params(&spec, &json!({})).unwrap();
        assert_eq!(
            p["inputs"],
            json!({
                "size": "auto", "tier": "low", "minSize": 60, "maxSize": 0, "showSize": true,
                "price": "vwap", "joinOrders": true, "reachLimit": true, "zones": "off",
                "zoneBars": 10, "zoneBiggest": false, "zoneBody": "trend", "zoneWick": "all",
                "daysToLoad": 2
            })
        );
        let input = |key: &str| spec.inputs.iter().find(|i| i.key == key).unwrap();
        let when = |key: &str| {
            input(key)
                .when
                .as_ref()
                .map(|w| (w.input.as_str(), w.values.join("|")))
        };
        assert_eq!(when("tier"), Some(("size", "auto".into())));
        assert_eq!(when("minSize"), Some(("size", "fixed".into())));
        assert_eq!(when("maxSize"), Some(("size", "fixed".into())));
        assert!(["size", "tier"].iter().all(|k| input(k).segmented));
        assert!(
            ["minSize", "maxSize", "zones"]
                .iter()
                .all(|k| !input(k).segmented)
        );
        assert_eq!(
            input("maxSize").zero_label.as_deref(),
            Some("None"),
            "an empty At most field reads None"
        );
        assert!(input("minSize").zero_label.is_none());
        assert!(input("tier").hint.is_some() && input("zones").hint.is_some());
        let band = json!({"inputs": {"size": "fixed", "minSize": 12, "maxSize": 400}});
        let band = normalize_params(&spec, &band).unwrap();
        assert_eq!(
            (
                &band["inputs"]["size"],
                &band["inputs"]["minSize"],
                &band["inputs"]["maxSize"]
            ),
            (&json!("fixed"), &json!(12), &json!(400))
        );
        let high = json!({"inputs": {"tier": "high"}});
        assert_eq!(
            normalize_params(&spec, &high).unwrap()["inputs"]["tier"],
            "high"
        );
        for bad in [
            json!({"size": "fixed", "minSize": 0}),
            json!({"size": "fixed", "minSize": -1}),
            json!({"maxSize": 100_001}),
            json!({"size": "manual"}),
            json!({"tier": "huge"}),
            json!({"tiers": ["high"]}),
        ] {
            let p = json!({ "inputs": bad });
            assert!(normalize_params(&spec, &p).is_err(), "{p}");
        }
    }

    #[test]
    fn big_trades_saved_before_the_size_switch_open_on_the_mode_they_read_as() {
        let spec = indicator_spec(LayerKind::BigTrades).unwrap();
        let inputs = |params: Value| normalize_params(&spec, &params).unwrap()["inputs"].clone();
        let shows = |i: &Value| {
            [
                i["size"].clone(),
                i["tier"].clone(),
                i["minSize"].clone(),
                i["maxSize"].clone(),
            ]
        };
        let tiers = inputs(json!({
            "inputs": {"mode": "auto", "high": true, "medium": true, "low": false, "showSize": false},
            "style": {}
        }));
        assert_eq!(
            shows(&tiers),
            [json!("auto"), json!("medium"), json!(60), json!(0)]
        );
        assert_eq!(tiers["showSize"], false);
        let only_high = inputs(json!({"inputs": {"low": false, "medium": false}}));
        assert_eq!(only_high["tier"], "high");
        let none_on = inputs(json!({"inputs": {"high": false, "medium": false, "low": false}}));
        assert_eq!(none_on["tier"], "low");
        let manual = inputs(
            json!({"inputs": {"mode": "manual", "low": false, "minSize": 25, "maxSize": 300}}),
        );
        assert_eq!(
            shows(&manual),
            [json!("fixed"), json!("low"), json!(25), json!(300)]
        );
        let manual_zero = inputs(json!({"inputs": {"mode": "manual", "minSize": 0}}));
        assert_eq!(
            shows(&manual_zero),
            [json!("fixed"), json!("low"), json!(60), json!(0)]
        );
        let auto_zero = inputs(json!({"inputs": {"minSize": 0, "maxSize": 80}}));
        assert_eq!(
            shows(&auto_zero),
            [json!("auto"), json!("low"), json!(60), json!(80)]
        );
        let sized = inputs(json!({"inputs": {"minSize": 25, "maxSize": 300}}));
        assert_eq!(
            shows(&sized),
            [json!("fixed"), json!("low"), json!(25), json!(300)]
        );
        let current = json!({"inputs": {"size": "fixed", "minSize": 25}, "style": {}});
        assert_eq!(migrate_legacy(LayerKind::BigTrades, &current), current);
    }

    #[test]
    fn custom_layer_params_name_their_indicator_and_follow_its_declaration() {
        assert!(normalize_custom_params(None, &json!({})).is_err());
        assert!(
            normalize_custom_params(None, &json!({"indicator": "ci_1", "version": 0})).is_err()
        );
        assert!(normalize_custom_params(None, &json!({"indicator": "ci_1", "x": 1})).is_err());
        let p = normalize_custom_params(None, &json!({"indicator": "ci_1", "inputs": {"n": 3}}))
            .unwrap();
        assert_eq!(p, json!({"indicator": "ci_1", "inputs": {"n": 3}}));
        let mut spec = rsi();
        spec.kind = LayerKind::Custom;
        let p = normalize_custom_params(
            Some(&spec),
            &json!({"indicator": "ci_1", "version": 2, "inputs": {"length": 7}}),
        )
        .unwrap();
        assert_eq!(p["inputs"]["length"], 7);
        assert_eq!(p["inputs"]["upper"], 70.0, "defaults fill the rest");
        assert_eq!(p["version"], 2);
        assert!(p["style"]["plots"]["rsi"].is_object());
        assert!(
            normalize_custom_params(
                Some(&spec),
                &json!({"indicator": "ci_1", "inputs": {"nope": 1}})
            )
            .is_err()
        );
        assert_eq!(custom_ref(&p).unwrap(), ("ci_1".to_owned(), Some(2)));
    }

    #[test]
    fn labels_are_set_on_indicators_with_lines() {
        let rsi = rsi();
        let p = normalize_params(&rsi, &json!({})).unwrap();
        assert_eq!(
            p["style"]["labels"],
            json!({"priceScale": true, "name": false, "value": false}),
            "a pane's lines keep their tags"
        );
        let ema = indicator_spec(LayerKind::Ema).unwrap();
        let p = normalize_params(&ema, &json!({"style": {"labels": {"name": true}}})).unwrap();
        assert_eq!(
            p["style"]["labels"],
            json!({"priceScale": false, "name": true, "value": false})
        );
        assert!(normalize_params(&ema, &json!({"style": {"labels": {"nope": true}}})).is_err());
        assert!(params_schema(&ema)["properties"]["style"]["properties"]["labels"].is_object());
        let mut bars = rsi.clone();
        bars.plots.retain(|p| p.kind == PlotKind::Hline);
        bars.plots.push(histogram("h", "H", PlotColorBy::Sign, 1.0));
        assert!(!has_labels(&bars));
        assert!(
            normalize_params(&bars, &json!({})).unwrap()["style"]
                .get("labels")
                .is_none()
        );
        let e = normalize_params(&bars, &json!({"style": {"labels": {"name": true}}})).unwrap_err();
        assert!(e.contains("no line to label"), "{e}");
    }

    #[test]
    fn objects_are_capped_and_cut_to_a_window() {
        let line = |t1: i64, t2: Option<i64>, extend| IndicatorLineObject {
            time1: Timestamp(t1),
            price1: 1.0,
            time2: t2.map(Timestamp),
            price2: 1.0,
            color: None,
            width: 1.0,
            line: LineDash::Solid,
            extend,
            label: None,
        };
        let mut o = IndicatorObjects {
            lines: (0..(MAX_OBJECTS as i64 + 20))
                .map(|t| line(t, Some(t + 1), ObjectExtend::None))
                .collect(),
            ..IndicatorObjects::default()
        };
        o.cap();
        assert_eq!(o.lines.len(), MAX_OBJECTS);
        assert_eq!(o.lines[0].time1, Timestamp(20), "the newest are kept");
        let o = IndicatorObjects {
            lines: vec![
                line(1, Some(2), ObjectExtend::None),
                line(1, None, ObjectExtend::None),
                line(1, Some(2), ObjectExtend::Right),
                line(9, Some(12), ObjectExtend::None),
            ],
            ..IndicatorObjects::default()
        };
        assert_eq!(o.since(Timestamp(10)).lines.len(), 3);
        let mut bad = o.clone();
        bad.lines[0].color = Some("blue".into());
        assert!(bad.check().is_err());
        bad.lines[0].color = None;
        bad.lines[0].price1 = f64::NAN;
        assert!(bad.check().is_err());
        assert!(o.check().is_ok());
    }

    #[test]
    fn objects_round_trip_on_the_wire() {
        let o = IndicatorObjects {
            lines: vec![IndicatorLineObject {
                time1: Timestamp(1_760_000_000_000_000_000),
                price1: 21_500.25,
                time2: None,
                price2: 21_500.25,
                color: Some("#9d8cf2".into()),
                width: 1.0,
                line: LineDash::Dash,
                extend: ObjectExtend::Right,
                label: Some(ObjectText {
                    text: "Asia H".into(),
                    at: LabelAlong::End,
                    side: LabelSide::Above,
                    color: None,
                }),
            }],
            labels: vec![IndicatorLabelObject {
                time: Timestamp(1_760_000_300_000_000_000),
                price: 21_480.0,
                text: "x".into(),
                color: None,
                size: LabelSize::Small,
                side: LabelPlacement::At,
            }],
            boxes: vec![IndicatorBoxObject {
                time1: Timestamp(1),
                price1: 2.0,
                time2: Some(Timestamp(3)),
                price2: 1.0,
                color: None,
                width: 0.0,
                line: LineDash::Solid,
                fill: Some("teal".into()),
                opacity: 0.2,
                extend: ObjectExtend::None,
                label: None,
            }],
        };
        let wire = serde_json::to_value(&o).unwrap();
        assert_eq!(
            wire["lines"][0],
            json!({"time1": 1_760_000_000_000_000_000_i64, "price1": 21500.25, "time2": null,
                "price2": 21500.25, "color": "#9d8cf2", "width": 1.0, "line": "dash", "extend": "right",
                "label": {"text": "Asia H", "at": "end", "side": "above", "color": null}})
        );
        assert_eq!(wire["labels"][0]["side"], "at");
        assert_eq!(wire["boxes"][0]["fill"], "teal");
        let back: IndicatorObjects = serde_json::from_value(wire).unwrap();
        assert_eq!(back, o);
    }

    #[test]
    fn declarations_are_consistent() {
        for s in indicator_specs() {
            let k = s.short.as_str();
            for i in &s.inputs {
                let normalized = normalize_input(i, &i.default);
                assert_eq!(normalized.as_ref(), Ok(&i.default), "{k}.{}", i.key);
            }
            for x in &s.plots {
                assert!(is_color(&x.default.color), "{k}.{}", x.key);
                if let Some(v) = &x.value_input {
                    assert!(s.inputs.iter().any(|i| &i.key == v), "{k}.{}", x.key);
                }
                if x.kind == PlotKind::Hline {
                    assert!(
                        x.value.is_some() || x.value_input.is_some(),
                        "{k}.{}",
                        x.key
                    );
                }
            }
            for f in &s.fills {
                assert!(
                    s.plots.iter().any(|p| p.key == f.from),
                    "{k} fill {}",
                    f.key
                );
                assert!(s.plots.iter().any(|p| p.key == f.to), "{k} fill {}", f.key);
            }
            let shown_by = s.plots.iter().map(|p| (&p.key, &p.shown_by));
            for (key, by) in shown_by.chain(s.fills.iter().map(|f| (&f.key, &f.shown_by))) {
                if let Some(by) = by {
                    assert!(
                        s.inputs
                            .iter()
                            .any(|i| &i.key == by && i.ty == InputType::Bool),
                        "{k}.{key}: {by} is a switch"
                    );
                }
            }
            assert_eq!(
                s.height.is_some(),
                s.placement == IndicatorPlacement::Pane,
                "{k}: panes have a height"
            );
            let keys: std::collections::BTreeSet<_> = s.plots.iter().map(|p| &p.key).collect();
            assert_eq!(keys.len(), s.plots.len(), "{k}: plot keys are unique");
            let n = normalize_params(&s, &Value::Null).unwrap();
            assert_eq!(normalize_params(&s, &n).unwrap(), n, "{k}");
        }
    }

    #[test]
    fn price_pane_defaults_are_told_apart() {
        let mut seen = std::collections::HashMap::<(String, LineDash), (String, String)>::new();
        for s in indicator_specs() {
            if s.placement != IndicatorPlacement::Overlay || s.group == IndicatorGroup::OrderFlow {
                continue;
            }
            for p in &s.plots {
                if p.kind == PlotKind::Hline || p.shown_by.is_some() || !p.default.visible {
                    continue;
                }
                let look = (p.default.color.clone(), p.default.line);
                let here = (s.short.clone(), p.key.clone());
                if let Some((other, plot)) = seen.get(&look) {
                    assert_eq!(
                        other, &s.short,
                        "{}.{} and {other}.{plot} are both {:?} {:?}",
                        s.short, p.key, look.0, look.1
                    );
                } else {
                    seen.insert(look, here);
                }
            }
        }
    }

    #[test]
    fn params_fill_defaults_and_refuse_bad_values() {
        let n = normalize_params(&rsi(), &json!({"inputs": {"length": 21}})).unwrap();
        assert_eq!(n["inputs"]["length"], 21);
        assert_eq!(n["inputs"]["source"], "close");
        assert_eq!(n["inputs"]["upper"], 70.0);
        assert_eq!(n["style"]["plots"]["rsi"]["color"], "mist");
        assert_eq!(n["style"]["fills"]["zone"]["visible"], true);
        assert_eq!(n["height"], 0.16);
        let bad = [
            json!({"inputs": {"length": 1}}),
            json!({"inputs": {"length": 14.5}}),
            json!({"inputs": {"source": "vwap"}}),
            json!({"inputs": {"upper": true}}),
            json!({"inputs": {"nope": 1}}),
            json!({"style": {"plots": {"rsi": {"color": "aqua"}}}}),
            json!({"style": {"plots": {"rsi": {"width": 9}}}}),
            json!({"style": {"plots": {"x": {}}}}),
            json!({"style": {"fills": {"zone": {"opacity": 2}}}}),
            json!({"height": 0.95}),
            json!({"extra": true}),
        ];
        for p in bad {
            assert!(normalize_params(&rsi(), &p).is_err(), "{p}");
        }
        let custom = normalize_params(
            &rsi(),
            &json!({"style": {"plots": {"rsi": {"color": "#ff8800", "line": "dot"}}}}),
        )
        .unwrap();
        assert_eq!(custom["style"]["plots"]["rsi"]["color"], "#ff8800");
        assert_eq!(custom["style"]["plots"]["rsi"]["line"], "dot");
        assert_eq!(custom["style"]["plots"]["rsi"]["width"], 1.25);
        let sma = indicator_spec(LayerKind::Sma).unwrap();
        assert!(
            normalize_params(&sma, &json!({"height": 0.2})).is_err(),
            "overlays have no pane height"
        );
        assert!(
            normalize_params(&sma, &Value::Null)
                .unwrap()
                .get("height")
                .is_none()
        );
    }

    #[test]
    fn enum_inputs_take_one_of_their_options() {
        let atr = indicator_spec(LayerKind::Atr).unwrap();
        let n = normalize_params(&atr, &Value::Null).unwrap();
        assert_eq!(n["inputs"]["smoothing"], "rma");
        let n = normalize_params(&atr, &json!({"inputs": {"smoothing": "ema"}})).unwrap();
        assert_eq!(n["inputs"]["smoothing"], "ema");
        let err = normalize_params(&atr, &json!({"inputs": {"smoothing": "hma"}})).unwrap_err();
        assert!(err.contains("rma, sma, ema, wma"), "{err}");
        let schema = params_schema(&atr);
        assert_eq!(
            schema["properties"]["inputs"]["properties"]["smoothing"]["enum"],
            json!(["rma", "sma", "ema", "wma"])
        );
    }

    #[test]
    fn session_and_timezone_inputs_take_hours_and_an_iana_zone() {
        let mut spec = rsi();
        spec.kind = LayerKind::Custom;
        spec.inputs = vec![
            input(
                "hours",
                "London hours",
                InputType::Session,
                json!("07:00-10:00"),
            ),
            input(
                "zone",
                "London time zone",
                InputType::Timezone,
                json!("Europe/London"),
            ),
        ];
        let n = normalize_params(&spec, &Value::Null).unwrap();
        assert_eq!(
            (&n["inputs"]["hours"], &n["inputs"]["zone"]),
            (&json!("07:00-10:00"), &json!("Europe/London"))
        );
        let n = normalize_params(
            &spec,
            &json!({"inputs": {"hours": "20:00-00:00", "zone": "America/New_York"}}),
        )
        .unwrap();
        assert_eq!(n["inputs"]["hours"], "20:00-00:00");
        assert_eq!(n["inputs"]["zone"], "America/New_York");
        for hours in [
            "7am",
            "07:00",
            "24:00-01:00",
            "07:60-08:00",
            "07:00-24:01",
            "7:0-8:00",
        ] {
            let err = normalize_params(&spec, &json!({"inputs": {"hours": hours}})).unwrap_err();
            assert!(
                err.starts_with("inputs.hours must be hours of the day"),
                "{hours}: {err}"
            );
        }
        for ok in [
            "9:30-16:00",
            " 18:00 - 02:00 ",
            "00:00-00:00",
            "22:00-24:00",
        ] {
            assert!(is_session_hours(ok), "{ok}");
        }
        for zone in [json!("Mars/Olympus"), json!("europe/london"), json!(5)] {
            let err = normalize_params(&spec, &json!({"inputs": {"zone": zone}})).unwrap_err();
            assert!(err.contains("is not a time zone"), "{zone}: {err}");
        }
        let schema = params_schema(&spec);
        let inputs = &schema["properties"]["inputs"]["properties"];
        assert_eq!(inputs["hours"]["type"], "string");
        assert!(inputs["hours"]["pattern"].is_string());
        assert_eq!(inputs["zone"]["default"], "Europe/London");
    }

    #[test]
    fn legacy_params_migrate() {
        let sma = indicator_spec(LayerKind::Sma).unwrap();
        let n = normalize_params(&sma, &json!({"period": 50})).unwrap();
        assert_eq!(n["inputs"]["length"], 50);
        assert!(normalize_params(&sma, &json!({"period": 0})).is_err());
        let vwap = indicator_spec(LayerKind::Vwap).unwrap();
        let n = normalize_params(&vwap, &json!({"bands": [2, 1.5]})).unwrap();
        assert_eq!(n["inputs"]["band1"], false, "legacy bands stay off");
        assert_eq!(n["inputs"]["mult1"], 1.5);
        assert_eq!(n["inputs"]["band2"], false);
        assert_eq!(n["inputs"]["mult2"], 2.0);
        assert_eq!(n["inputs"]["mult3"], 3.0, "unlisted: the default");
        for bands in [
            json!([9]),
            json!("x"),
            json!(null),
            json!([1, "a", 2, 3, 4]),
        ] {
            assert!(normalize_params(&vwap, &json!({ "bands": bands })).is_ok());
        }
        let vol = indicator_spec(LayerKind::Volume).unwrap();
        let n = normalize_params(&vol, &json!({"mode": "pane"})).unwrap();
        assert_eq!(n["inputs"]["maLength"], 20);
        assert_eq!(n["height"], 0.1);
    }

    #[test]
    fn legacy_params_match_the_shared_vectors() {
        let v: Value =
            serde_json::from_str(include_str!("../testdata/legacy-params.json")).unwrap();
        for case in v["cases"].as_array().unwrap() {
            let kind = LayerKind::parse(case["kind"].as_str().unwrap()).unwrap();
            let got = migrate_legacy(kind, &case["params"]);
            assert!(same(&got, &case["migrated"]), "{case}: got {got}");
        }
    }

    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Array(x), Value::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
            }
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            _ => a == b,
        }
    }

    #[test]
    fn merge_patches_edit_and_reset() {
        let mut v = normalize_params(&rsi(), &json!({"inputs": {"length": 21}})).unwrap();
        merge_patch(
            &mut v,
            &json!({"inputs": {"upper": 80}, "style": {"plots": {"rsi": {"color": "brass"}}}}),
        );
        let n = normalize_params(&rsi(), &v).unwrap();
        assert_eq!(n["inputs"]["length"], 21);
        assert_eq!(n["inputs"]["upper"], 80.0);
        assert_eq!(n["style"]["plots"]["rsi"]["color"], "brass");
        assert_eq!(n["style"]["plots"]["rsi"]["width"], 1.25);
        let mut v = n;
        merge_patch(&mut v, &json!({"inputs": {"length": null}}));
        assert_eq!(
            normalize_params(&rsi(), &v).unwrap()["inputs"]["length"],
            14
        );
    }

    #[test]
    fn schema_describes_inputs_and_styles() {
        let s = params_schema(&rsi());
        assert_eq!(
            s["properties"]["inputs"]["properties"]["length"]["type"],
            "integer"
        );
        assert_eq!(
            s["properties"]["inputs"]["properties"]["length"]["minimum"],
            2.0
        );
        assert_eq!(
            s["properties"]["inputs"]["properties"]["length"]["default"],
            14
        );
        assert_eq!(
            s["properties"]["inputs"]["properties"]["source"]["enum"][5],
            "hlc3"
        );
        assert!(s["properties"]["style"]["properties"]["plots"]["properties"]["rsi"].is_object());
        assert!(s["properties"]["height"].is_object());
        let sma = params_schema(&indicator_spec(LayerKind::Sma).unwrap());
        assert!(sma["properties"].get("height").is_none());
    }
}
