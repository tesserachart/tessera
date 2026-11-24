use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::ids::SessionId;
use tessera_core::{InstrumentId, Timestamp};
use ts_rs::TS;

use crate::indicators::{LineDash, is_color};
use crate::layout::{AnchorPoint, AnnotationKind, ChartState, OverlayNamespace};

pub const DRAWINGS_MAX: usize = 1000;
pub const TEXT_MAX: usize = 500;
pub const LEVELS_MAX: usize = 24;
pub const FIB_LEVELS: [f64; 7] = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
pub const FIB_EXTENSION_LEVELS: [f64; 9] = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.618, 2.0];
pub const FIB_FAN_LEVELS: [f64; 3] = [0.382, 0.5, 0.618];
pub const DEFAULT_COLOR: &str = "mist";
const WIDTH_RANGE: (f64, f64) = (0.5, 4.0);
const LEVEL_RANGE: (f64, f64) = (-5.0, 10.0);
pub const LABEL_TEXT_MAX: usize = 500;
pub const LABEL_SIZE_RANGE: (u8, u8) = (8, 40);
pub const LABEL_SIZE: u8 = 12;

/// What a drawing is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DrawingKind {
    /// A line between two anchors.
    TrendLine,
    /// A line from the first anchor through the second, on to the edge.
    Ray,
    /// A line through two anchors, edge to edge.
    ExtendedLine,
    /// A trend line between two anchors with its angle in degrees from the horizontal, as the
    /// chart shows it (up is positive; the angle changes as the chart is zoomed).
    TrendAngle,
    /// A price across the whole chart (one anchor: its price).
    HorizontalLine,
    /// A price from a bar on to the right edge (one anchor).
    HorizontalRay,
    /// A bar's time, top to bottom (one anchor: its time).
    VerticalLine,
    /// A horizontal and a vertical line crossing at one anchor: its price and its bar's time.
    CrossLine,
    /// A box between two corners.
    Rectangle,
    /// A trend line and its parallel: two anchors for the line, a third whose price sets the
    /// parallel's offset.
    ParallelChannel,
    /// Retracement levels between two anchors (0 at the second, 1 at the first).
    FibRetracement,
    /// Trend-based extension: three anchors, a move (the first two) and the end of its pullback
    /// (the third). Each level is the third anchor's price plus the move times the level (0 at
    /// the third anchor, 1 a move as long as the first).
    FibExtension,
    /// Rays from the first anchor through each level of the rise to the second, measured at the
    /// second anchor's time (1 is the line to the second anchor, 0 the first anchor's price).
    FibFan,
    /// A note at one anchor (its text is the drawing's `text`).
    Text,
    /// The price distance between two anchors: points, ticks and percent.
    PriceRange,
    /// The time between two anchors: bars and duration.
    DateRange,
    /// Both at once: price distance, ticks, percent, bars and duration.
    Measure,
}

/// Which way a line goes on past its anchors.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum DrawingExtend {
    /// Stops at its anchors.
    #[default]
    None,
    /// On to the left edge.
    Left,
    /// On to the right edge.
    Right,
    /// Both ways.
    Both,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnchorNeeds {
    Price,
    Time,
    Both,
}

impl DrawingKind {
    pub const ALL: [DrawingKind; 17] = [
        DrawingKind::TrendLine,
        DrawingKind::Ray,
        DrawingKind::ExtendedLine,
        DrawingKind::TrendAngle,
        DrawingKind::HorizontalLine,
        DrawingKind::HorizontalRay,
        DrawingKind::VerticalLine,
        DrawingKind::CrossLine,
        DrawingKind::Rectangle,
        DrawingKind::ParallelChannel,
        DrawingKind::FibRetracement,
        DrawingKind::FibExtension,
        DrawingKind::FibFan,
        DrawingKind::Text,
        DrawingKind::PriceRange,
        DrawingKind::DateRange,
        DrawingKind::Measure,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            DrawingKind::TrendLine => "trend_line",
            DrawingKind::Ray => "ray",
            DrawingKind::ExtendedLine => "extended_line",
            DrawingKind::TrendAngle => "trend_angle",
            DrawingKind::HorizontalLine => "horizontal_line",
            DrawingKind::HorizontalRay => "horizontal_ray",
            DrawingKind::VerticalLine => "vertical_line",
            DrawingKind::CrossLine => "cross_line",
            DrawingKind::Rectangle => "rectangle",
            DrawingKind::ParallelChannel => "parallel_channel",
            DrawingKind::FibRetracement => "fib_retracement",
            DrawingKind::FibExtension => "fib_extension",
            DrawingKind::FibFan => "fib_fan",
            DrawingKind::Text => "text",
            DrawingKind::PriceRange => "price_range",
            DrawingKind::DateRange => "date_range",
            DrawingKind::Measure => "measure",
        }
    }

    pub fn anchors(self) -> usize {
        match self {
            DrawingKind::HorizontalLine
            | DrawingKind::HorizontalRay
            | DrawingKind::VerticalLine
            | DrawingKind::CrossLine
            | DrawingKind::Text => 1,
            DrawingKind::ParallelChannel | DrawingKind::FibExtension => 3,
            _ => 2,
        }
    }

    pub fn needs(self) -> AnchorNeeds {
        match self {
            DrawingKind::HorizontalLine => AnchorNeeds::Price,
            DrawingKind::VerticalLine => AnchorNeeds::Time,
            _ => AnchorNeeds::Both,
        }
    }

    pub fn extends(self) -> bool {
        matches!(
            self,
            DrawingKind::TrendLine
                | DrawingKind::Ray
                | DrawingKind::ExtendedLine
                | DrawingKind::TrendAngle
                | DrawingKind::Rectangle
                | DrawingKind::ParallelChannel
                | DrawingKind::FibRetracement
                | DrawingKind::FibExtension
                | DrawingKind::FibFan
        )
    }

    pub fn default_extend(self) -> DrawingExtend {
        match self {
            DrawingKind::Ray => DrawingExtend::Right,
            DrawingKind::ExtendedLine => DrawingExtend::Both,
            DrawingKind::FibFan => DrawingExtend::Right,
            _ => DrawingExtend::None,
        }
    }

    pub fn labels(self) -> bool {
        !matches!(self, DrawingKind::Text | DrawingKind::Measure)
    }

    pub fn default_levels(self) -> Option<&'static [f64]> {
        match self {
            DrawingKind::FibRetracement => Some(&FIB_LEVELS),
            DrawingKind::FibExtension => Some(&FIB_EXTENSION_LEVELS),
            DrawingKind::FibFan => Some(&FIB_FAN_LEVELS),
            _ => None,
        }
    }

    pub fn takes_levels(self) -> bool {
        self.default_levels().is_some()
    }

    pub fn label_words(self) -> bool {
        self.labels() && !self.takes_levels()
    }

    pub fn label_price(self) -> bool {
        matches!(
            self,
            DrawingKind::HorizontalLine
                | DrawingKind::HorizontalRay
                | DrawingKind::CrossLine
                | DrawingKind::FibRetracement
                | DrawingKind::FibExtension
        )
    }
}

/// Where a label sits along its drawing (TradingView's horizontal alignment): at its left end, in
/// its middle or at its right end. On a vertical line the text runs upwards: its foot, middle or
/// top.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum LabelAlign {
    /// The left end (a vertical line's foot).
    Left,
    /// The middle.
    #[default]
    Center,
    /// The right end (a vertical line's top).
    Right,
}

/// Which side of its line a label sits on (TradingView's vertical alignment): above it, on it (the
/// line gives way to the words), or below it. On a vertical line: its left, on it, its right; on a
/// rectangle or a range: over its top edge, in its middle, under its bottom edge; on a channel:
/// over it, on its middle line, under it.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum LabelPosition {
    /// Above the line.
    #[default]
    Above,
    /// On the line.
    On,
    /// Below the line.
    Below,
}

fn label_size() -> u8 {
    LABEL_SIZE
}

fn yes() -> bool {
    true
}

/// A drawing's label (TradingView's Text tab): its words and how they look and sit. The words move
/// with the drawing and run along a sloped line. A Fibonacci drawing's labels are its levels: its
/// label sets how they look and sit and whether each shows its level (and, but for a fan, its
/// price), and takes no words.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawingLabel {
    /// The words (`\n` breaks lines); empty: none.
    #[serde(default)]
    pub text: String,
    /// Text colour, a swatch or `#rrggbb`; absent: the line's colour (an agent's line's aqua).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Text size in px (8–40).
    #[serde(default = "label_size")]
    pub size: u8,
    /// Bold.
    #[serde(default)]
    pub bold: bool,
    /// Italic.
    #[serde(default)]
    pub italic: bool,
    /// Where along the drawing.
    #[serde(default)]
    pub align: LabelAlign,
    /// Which side of the line.
    #[serde(default)]
    pub position: LabelPosition,
    /// A horizontal line's, ray's or cross line's price after its words; a retracement's or
    /// extension's price on each level.
    #[serde(default)]
    pub show_price: bool,
    /// A Fibonacci drawing's level (`0.618`) on each level (other kinds have none to show).
    #[serde(default = "yes")]
    pub show_levels: bool,
}

impl DrawingLabel {
    pub fn default_for(kind: DrawingKind) -> Self {
        let align = match kind {
            DrawingKind::HorizontalLine | DrawingKind::VerticalLine | DrawingKind::CrossLine => {
                LabelAlign::Right
            }
            DrawingKind::HorizontalRay
            | DrawingKind::Rectangle
            | DrawingKind::PriceRange
            | DrawingKind::DateRange
            | DrawingKind::FibRetracement
            | DrawingKind::FibExtension
            | DrawingKind::FibFan => LabelAlign::Left,
            _ => LabelAlign::Center,
        };
        Self {
            text: String::new(),
            color: None,
            size: LABEL_SIZE,
            bold: false,
            italic: false,
            align,
            position: LabelPosition::Above,
            show_price: matches!(
                kind,
                DrawingKind::FibRetracement | DrawingKind::FibExtension
            ),
            show_levels: true,
        }
    }

    #[must_use]
    pub fn look(&self) -> Self {
        Self {
            text: String::new(),
            ..self.clone()
        }
    }
}

/// Part of a label, as tools take it: what is absent keeps its value (or the kind's default).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct DrawingLabelInput {
    /// The words (`\n` breaks lines, up to 500 characters); "" removes them. A Fibonacci drawing
    /// takes none.
    #[serde(default)]
    pub text: Option<String>,
    /// Text colour: a swatch (mist, t1, t2, t3, t4, up, down, brass, teal) or #rrggbb; "" follows
    /// the line's colour again (the default).
    #[serde(default)]
    pub color: Option<String>,
    /// Text size in px (8–40, default 12).
    #[serde(default)]
    pub size: Option<u8>,
    /// Bold.
    #[serde(default)]
    pub bold: Option<bool>,
    /// Italic.
    #[serde(default)]
    pub italic: Option<bool>,
    /// Along the drawing: left, center or right (a vertical line: its foot, middle or top).
    #[serde(default)]
    pub align: Option<LabelAlign>,
    /// Across the line: above, on or below (a rectangle or range: over its top, in its middle,
    /// under its bottom).
    #[serde(default)]
    pub position: Option<LabelPosition>,
    /// Horizontal line, ray and cross line: the price after the words; retracement and
    /// extension: each level's price.
    #[serde(default)]
    pub show_price: Option<bool>,
    /// Fibonacci retracement, extension and fan: each level's ratio (0.618).
    #[serde(default)]
    pub show_levels: Option<bool>,
}

/// How a drawing is drawn (stored complete).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawingStyle {
    /// A palette swatch (`mist`, `t2`, `up`, `down`, `brass`, `teal`, …) or a custom `#rrggbb`.
    pub color: String,
    /// Stroke width in px (0.5–4).
    pub width: f64,
    /// Dash.
    pub line: LineDash,
    /// Which way its lines go on past the anchors (kinds that extend).
    #[serde(default)]
    pub extend: DrawingExtend,
}

impl DrawingStyle {
    pub fn default_for(kind: DrawingKind) -> Self {
        Self {
            color: DEFAULT_COLOR.into(),
            width: 1.0,
            line: LineDash::Solid,
            extend: kind.default_extend(),
        }
    }
}

/// Part of a style, as tools take it: what is absent keeps its value (or the kind's default).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct DrawingStyleInput {
    /// A palette swatch (mist, t1, t2, t3, t4, up, down, brass, teal) or a custom #rrggbb.
    #[serde(default)]
    pub color: Option<String>,
    /// Stroke width in px (0.5–4).
    #[serde(default)]
    pub width: Option<f64>,
    /// Dash: solid, dash or dot.
    #[serde(default)]
    pub line: Option<LineDash>,
    /// none, left, right or both (trend lines, rays, trend angles, rectangles, channels, Fibonacci;
    /// a fan's rays: none stops them at the second anchor's time, right runs them on).
    #[serde(default)]
    pub extend: Option<DrawingExtend>,
}

/// A drawing on a chart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Drawing {
    /// Id, unique within the chart (`dr_…`).
    pub id: String,
    /// What it is.
    pub kind: DrawingKind,
    /// The instrument it was drawn on: the chart shows it while it shows that instrument.
    pub instrument: InstrumentId,
    /// Anchors, each a bar time and a price (a horizontal line needs only the price, a vertical
    /// line only the time).
    pub points: Vec<AnchorPoint>,
    /// How it is drawn.
    pub style: DrawingStyle,
    /// A note's text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    /// A Fibonacci retracement's, extension's or fan's levels (`0.618`), as drawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub levels: Option<Vec<f64>>,
    /// Its label (lines and shapes, a Fibonacci drawing's levels); absent: none (a Fibonacci
    /// drawing shows its levels as [`DrawingLabel::default_for`] says). Drawings saved before labels
    /// load without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<DrawingLabel>,
    /// Locked: it can be selected and removed but not moved.
    #[serde(default)]
    pub locked: bool,
    /// Who drew it.
    pub namespace: OverlayNamespace,
    /// Agent session that drew it.
    pub session_id: Option<SessionId>,
    /// Created.
    pub created_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartAddDrawingInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// What to draw. Anchors: horizontal_line 1 (price), vertical_line 1 (time), horizontal_ray,
    /// cross_line and text 1 (time and price), parallel_channel 3 (the line's two, then one whose
    /// price sets the parallel), fib_extension 3 (the move's start and end, then the pullback's
    /// end), every other kind 2 (time and price each).
    pub kind: DrawingKind,
    /// Anchors: `{"t": a bar time (RFC 3339 or ns), "price": …}`.
    pub points: Vec<AnchorPoint>,
    /// Style (default: mist, 1 px, solid; a ray and a fan's rays extend right, an extended line
    /// both ways).
    #[serde(default)]
    pub style: Option<DrawingStyleInput>,
    /// A note's text (required for text). A line's or shape's words go in its `label`.
    #[serde(default)]
    pub text: Option<String>,
    /// A Fibonacci drawing's levels. Defaults: retracement 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1;
    /// extension 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2; fan 0.382, 0.5, 0.618.
    #[serde(default)]
    pub levels: Option<Vec<f64>>,
    /// The label of a line or shape (its words on the line, how they look and sit), or how a
    /// Fibonacci drawing's level labels show; absent fields take the kind's defaults.
    #[serde(default)]
    pub label: Option<DrawingLabelInput>,
    /// Lock it against moves.
    #[serde(default)]
    pub locked: Option<bool>,
}

/// `chart.update_drawing` input: what is given replaces the drawing's own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartUpdateDrawingInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The drawing's id.
    pub drawing_id: String,
    /// New anchors (as many as the kind takes).
    #[serde(default)]
    pub points: Option<Vec<AnchorPoint>>,
    /// Style changes; absent fields keep theirs.
    #[serde(default)]
    pub style: Option<DrawingStyleInput>,
    /// A note's new text.
    #[serde(default)]
    pub text: Option<String>,
    /// A Fibonacci retracement's, extension's or fan's new levels.
    #[serde(default)]
    pub levels: Option<Vec<f64>>,
    /// Label changes (a line's or shape's words and their look, a Fibonacci drawing's level labels);
    /// absent fields keep theirs.
    #[serde(default)]
    pub label: Option<DrawingLabelInput>,
    /// Lock or unlock it.
    #[serde(default)]
    pub locked: Option<bool>,
}

/// `chart.remove_drawing` input: one drawing by id, or every drawing of the caller's on the
/// chart's instrument (`all`; an agent's own namespace only).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartRemoveDrawingInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The drawing's id.
    #[serde(default)]
    pub drawing_id: Option<String>,
    /// Every drawing on the chart's instrument instead (an agent removes only agent drawings, unless
    /// `includeUser`).
    #[serde(default)]
    pub all: Option<bool>,
    /// With `all`, an agent removes the user's drawings too, as the user's own Remove all drawings does.
    #[serde(default)]
    pub include_user: Option<bool>,
}

/// Result of `chart.add_drawing` and `chart.update_drawing`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartDrawingOutput {
    /// Layout id.
    pub layout_id: String,
    /// Chart tile id.
    pub tile_id: String,
    /// Layout revision after the change.
    #[ts(type = "number")]
    pub revision: u64,
    /// The drawing as stored.
    pub drawing: Drawing,
}

fn check_points(kind: DrawingKind, points: &[AnchorPoint]) -> Result<(), String> {
    let need = kind.anchors();
    if points.len() != need {
        return Err(format!(
            "{} takes {need} anchor(s), got {}",
            kind.as_str(),
            points.len()
        ));
    }
    for p in points {
        match kind.needs() {
            AnchorNeeds::Price if p.price.is_none() => {
                return Err(format!("{}: each anchor needs a price", kind.as_str()));
            }
            AnchorNeeds::Time if p.t.is_none() => {
                return Err(format!("{}: each anchor needs a time", kind.as_str()));
            }
            AnchorNeeds::Both if p.t.is_none() || p.price.is_none() => {
                return Err(format!(
                    "{}: each anchor needs a time and a price",
                    kind.as_str()
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn apply_style(style: &mut DrawingStyle, input: &DrawingStyleInput) -> Result<(), String> {
    if let Some(c) = &input.color {
        if !is_color(c) {
            return Err(format!(
                "color: {c:?} is not a colour (a swatch: mist, t1, t2, t3, t4, up, down, brass, teal, or #rrggbb)"
            ));
        }
        style.color.clone_from(c);
    }
    if let Some(w) = input.width {
        if !(w.is_finite() && w >= WIDTH_RANGE.0 && w <= WIDTH_RANGE.1) {
            return Err(format!(
                "width must be {}–{} px",
                WIDTH_RANGE.0, WIDTH_RANGE.1
            ));
        }
        style.width = w;
    }
    if let Some(l) = input.line {
        style.line = l;
    }
    if let Some(e) = input.extend {
        style.extend = e;
    }
    Ok(())
}

fn no_text(kind: DrawingKind) -> String {
    if kind.label_words() {
        format!(
            "{} takes no text: its words go on the line as label.text",
            kind.as_str()
        )
    } else {
        format!("{} takes no text", kind.as_str())
    }
}

fn clean_text(text: &str) -> Result<String, String> {
    let t = text.trim_end();
    if t.trim().is_empty() {
        return Err("a note needs text".into());
    }
    if t.chars().count() > TEXT_MAX {
        return Err(format!("a note has at most {TEXT_MAX} characters"));
    }
    Ok(t.to_owned())
}

pub fn clean_levels(levels: &[f64]) -> Result<Vec<f64>, String> {
    if levels.is_empty() {
        return Err("a Fibonacci drawing needs at least one level".into());
    }
    let mut out: Vec<f64> = Vec::with_capacity(levels.len());
    for &l in levels {
        if !(l.is_finite() && l >= LEVEL_RANGE.0 && l <= LEVEL_RANGE.1) {
            return Err(format!(
                "levels must be {}–{}",
                LEVEL_RANGE.0, LEVEL_RANGE.1
            ));
        }
        if !out.iter().any(|x| (x - l).abs() < 1e-9) {
            out.push(l);
        }
    }
    if out.len() > LEVELS_MAX {
        return Err(format!(
            "a Fibonacci drawing draws at most {LEVELS_MAX} levels"
        ));
    }
    out.sort_by(f64::total_cmp);
    Ok(out)
}

fn clean_label_text(text: &str) -> Result<String, String> {
    let t = text.trim_end();
    if t.chars().count() > LABEL_TEXT_MAX {
        return Err(format!("a label has at most {LABEL_TEXT_MAX} characters"));
    }
    Ok(t.to_owned())
}

pub fn apply_label(
    kind: DrawingKind,
    label: &mut DrawingLabel,
    input: &DrawingLabelInput,
) -> Result<(), String> {
    if !kind.labels() {
        return Err(if kind == DrawingKind::Text {
            "a note takes no label: its words are its text".into()
        } else {
            format!("{} takes no label", kind.as_str())
        });
    }
    if let Some(t) = &input.text {
        if !kind.label_words() && !t.trim().is_empty() {
            return Err(format!(
                "{}: its labels are its levels and take no text (label.showLevels, label.showPrice)",
                kind.as_str()
            ));
        }
        label.text = clean_label_text(t)?;
    }
    if let Some(c) = &input.color {
        if c.is_empty() {
            label.color = None;
        } else if is_color(c) {
            label.color = Some(c.clone());
        } else {
            return Err(format!(
                "label.color: {c:?} is not a colour (a swatch: mist, t1, t2, t3, t4, up, down, brass, teal, or #rrggbb; \"\" for the line's)"
            ));
        }
    }
    if let Some(size) = input.size {
        if size < LABEL_SIZE_RANGE.0 || size > LABEL_SIZE_RANGE.1 {
            return Err(format!(
                "label.size must be {}–{} px",
                LABEL_SIZE_RANGE.0, LABEL_SIZE_RANGE.1
            ));
        }
        label.size = size;
    }
    if let Some(b) = input.bold {
        label.bold = b;
    }
    if let Some(i) = input.italic {
        label.italic = i;
    }
    if let Some(a) = input.align {
        label.align = a;
    }
    if let Some(p) = input.position {
        label.position = p;
    }
    if let Some(p) = input.show_price {
        if p && !kind.label_price() {
            return Err(format!(
                "label.showPrice: a {} has no price to show (horizontal_line, horizontal_ray, cross_line, fib_retracement and fib_extension do)",
                kind.as_str()
            ));
        }
        label.show_price = p;
    }
    if let Some(l) = input.show_levels {
        if !kind.takes_levels() {
            return Err("label.showLevels is a Fibonacci drawing's".into());
        }
        label.show_levels = l;
    }
    Ok(())
}

pub fn check_label(kind: DrawingKind, label: &DrawingLabel) -> Result<DrawingLabel, String> {
    let mut out = DrawingLabel::default_for(kind);
    let input = DrawingLabelInput {
        text: Some(label.text.clone()),
        color: Some(label.color.clone().unwrap_or_default()),
        size: Some(label.size),
        bold: Some(label.bold),
        italic: Some(label.italic),
        align: Some(label.align),
        position: Some(label.position),
        show_price: Some(label.show_price && kind.label_price()),
        show_levels: kind.takes_levels().then_some(label.show_levels),
    };
    apply_label(kind, &mut out, &input)?;
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub fn build(
    id: String,
    instrument: InstrumentId,
    input: &ChartAddDrawingInput,
    namespace: OverlayNamespace,
    session_id: Option<SessionId>,
    created_at: Timestamp,
) -> Result<Drawing, String> {
    let kind = input.kind;
    check_points(kind, &input.points)?;
    let mut style = DrawingStyle::default_for(kind);
    if let Some(s) = &input.style {
        apply_style(&mut style, s)?;
    }
    let text = match (kind, &input.text) {
        (DrawingKind::Text, Some(t)) => Some(clean_text(t)?),
        (DrawingKind::Text, None) => return Err("a note needs text".into()),
        (_, Some(_)) => return Err(no_text(kind)),
        (_, None) => None,
    };
    let levels = match (kind.default_levels(), &input.levels) {
        (Some(_), Some(l)) => Some(clean_levels(l)?),
        (Some(d), None) => Some(d.to_vec()),
        (None, Some(_)) => return Err(format!("{} takes no levels", kind.as_str())),
        (None, None) => None,
    };
    let label = match &input.label {
        Some(i) => {
            let mut l = DrawingLabel::default_for(kind);
            apply_label(kind, &mut l, i)?;
            Some(l)
        }
        None => None,
    };
    Ok(Drawing {
        id,
        kind,
        instrument,
        points: input.points.clone(),
        style,
        text,
        levels,
        label,
        locked: input.locked.unwrap_or(false),
        namespace,
        session_id,
        created_at,
    })
}

pub fn update(drawing: &mut Drawing, input: &ChartUpdateDrawingInput) -> Result<(), String> {
    let mut next = drawing.clone();
    if let Some(p) = &input.points {
        check_points(next.kind, p)?;
        next.points.clone_from(p);
    }
    if let Some(s) = &input.style {
        apply_style(&mut next.style, s)?;
    }
    if let Some(t) = &input.text {
        if next.kind != DrawingKind::Text {
            return Err(no_text(next.kind));
        }
        next.text = Some(clean_text(t)?);
    }
    if let Some(i) = &input.label {
        let mut label = next
            .label
            .take()
            .unwrap_or_else(|| DrawingLabel::default_for(next.kind));
        apply_label(next.kind, &mut label, i)?;
        next.label = Some(label);
    }
    if let Some(l) = &input.levels {
        if !next.kind.takes_levels() {
            return Err(format!("{} takes no levels", next.kind.as_str()));
        }
        next.levels = Some(clean_levels(l)?);
    }
    if let Some(l) = input.locked {
        next.locked = l;
    }
    *drawing = next;
    Ok(())
}

pub fn new_id() -> String {
    format!(
        "dr_{}",
        tessera_core::ids::CallId::generate()
            .0
            .trim_start_matches("call_")
    )
}

const LEGACY_HLINE: &str = "u_hline_";

pub fn migrate_annotations(chart: &mut ChartState) -> bool {
    let before = chart.annotations.len();
    let mut moved = Vec::new();
    chart.annotations.retain(|a| {
        let price = a.points.first().and_then(|p| p.price);
        let take = a.namespace == OverlayNamespace::User
            && a.kind == AnnotationKind::Hline
            && a.id.starts_with(LEGACY_HLINE)
            && price.is_some();
        if take {
            moved.push(Drawing {
                id: format!("dr_{}", a.id.trim_start_matches(LEGACY_HLINE)),
                kind: DrawingKind::HorizontalLine,
                instrument: a
                    .instrument
                    .clone()
                    .unwrap_or_else(|| chart.instrument.clone()),
                points: vec![AnchorPoint { t: None, price }],
                style: DrawingStyle::default_for(DrawingKind::HorizontalLine),
                text: None,
                levels: None,
                label: None,
                locked: false,
                namespace: OverlayNamespace::User,
                session_id: None,
                created_at: a.created_at,
            });
        }
        !take
    });
    let any = chart.annotations.len() != before;
    chart.drawings.extend(moved);
    any
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Annotation;
    use serde_json::json;
    use tessera_core::{Price, Timeframe};

    fn price(v: f64) -> Option<Price> {
        Price::from_f64(v)
    }

    fn at(t: i64, p: f64) -> AnchorPoint {
        AnchorPoint {
            t: Some(Timestamp::from_secs(t)),
            price: price(p),
        }
    }

    fn add(kind: DrawingKind, points: Vec<AnchorPoint>) -> ChartAddDrawingInput {
        ChartAddDrawingInput {
            tile_id: None,
            layout_id: None,
            kind,
            points,
            style: None,
            text: None,
            levels: None,
            label: None,
            locked: None,
        }
    }

    fn make(input: &ChartAddDrawingInput) -> Result<Drawing, String> {
        build(
            "dr_1".into(),
            InstrumentId::new("NQ").unwrap(),
            input,
            OverlayNamespace::User,
            None,
            Timestamp::from_secs(1),
        )
    }

    #[test]
    fn wire_names_round_trip() {
        for k in DrawingKind::ALL {
            let v = serde_json::to_value(k).unwrap();
            assert_eq!(v, json!(k.as_str()));
            let back: DrawingKind = serde_json::from_value(v).unwrap();
            assert_eq!(back, k);
        }
    }

    #[test]
    fn anchors_are_checked_per_kind() {
        assert!(make(&add(DrawingKind::TrendLine, vec![at(1, 1.0), at(2, 2.0)])).is_ok());
        let one = make(&add(DrawingKind::TrendLine, vec![at(1, 1.0)])).unwrap_err();
        assert!(one.contains("takes 2"), "{one}");
        let no_time = AnchorPoint {
            t: None,
            price: price(5.0),
        };
        assert!(make(&add(DrawingKind::HorizontalLine, vec![no_time])).is_ok());
        assert!(make(&add(DrawingKind::HorizontalRay, vec![no_time])).is_err());
        let no_price = AnchorPoint {
            t: Some(Timestamp::from_secs(9)),
            price: None,
        };
        assert!(make(&add(DrawingKind::VerticalLine, vec![no_price])).is_ok());
        assert!(make(&add(DrawingKind::VerticalLine, vec![no_time])).is_err());
        assert!(
            make(&add(
                DrawingKind::ParallelChannel,
                vec![at(1, 1.0), at(2, 2.0), at(1, 3.0)]
            ))
            .is_ok()
        );
    }

    #[test]
    fn new_drawings_take_their_kinds_defaults() {
        let ray = make(&add(DrawingKind::Ray, vec![at(1, 1.0), at(2, 2.0)])).unwrap();
        assert_eq!(ray.style.extend, DrawingExtend::Right);
        assert_eq!(ray.style.color, "mist");
        let ext = make(&add(
            DrawingKind::ExtendedLine,
            vec![at(1, 1.0), at(2, 2.0)],
        ))
        .unwrap();
        assert_eq!(ext.style.extend, DrawingExtend::Both);
        let fib = make(&add(
            DrawingKind::FibRetracement,
            vec![at(1, 1.0), at(2, 2.0)],
        ))
        .unwrap();
        assert_eq!(fib.levels.as_deref(), Some(&FIB_LEVELS[..]));
        assert!(!fib.locked);
    }

    #[test]
    fn styles_text_and_levels_are_validated() {
        let mut i = add(DrawingKind::TrendLine, vec![at(1, 1.0), at(2, 2.0)]);
        i.style = Some(DrawingStyleInput {
            color: Some("brass".into()),
            width: Some(2.0),
            line: Some(LineDash::Dash),
            extend: Some(DrawingExtend::Left),
        });
        let d = make(&i).unwrap();
        assert_eq!(d.style.color, "brass");
        assert_eq!(d.style.width, 2.0);
        i.style = Some(DrawingStyleInput {
            color: Some("aqua".into()),
            ..DrawingStyleInput::default()
        });
        assert!(make(&i).is_err(), "aqua is the analyst's alone");
        i.style = Some(DrawingStyleInput {
            width: Some(9.0),
            ..DrawingStyleInput::default()
        });
        assert!(make(&i).is_err());
        i.style = None;
        i.text = Some("hi".into());
        assert!(make(&i).is_err(), "a line takes no text");

        let mut note = add(DrawingKind::Text, vec![at(1, 1.0)]);
        assert!(make(&note).is_err(), "a note needs text");
        note.text = Some("   ".into());
        assert!(make(&note).is_err());
        note.text = Some("Opening drive\n".into());
        assert_eq!(make(&note).unwrap().text.as_deref(), Some("Opening drive"));

        let mut fib = add(DrawingKind::FibRetracement, vec![at(1, 1.0), at(2, 2.0)]);
        fib.levels = Some(vec![1.0, 0.5, 0.5, 1.618]);
        assert_eq!(make(&fib).unwrap().levels.unwrap(), vec![0.5, 1.0, 1.618]);
        fib.levels = Some(vec![]);
        assert!(make(&fib).is_err());
        fib.levels = Some(vec![f64::NAN]);
        assert!(make(&fib).is_err());
    }

    #[test]
    fn each_fibonacci_kind_takes_its_own_levels_and_labels() {
        let ext = make(&add(
            DrawingKind::FibExtension,
            vec![at(1, 100.0), at(2, 110.0), at(3, 105.0)],
        ))
        .unwrap();
        assert_eq!(ext.levels.as_deref(), Some(&FIB_EXTENSION_LEVELS[..]));
        assert!(
            make(&add(
                DrawingKind::FibExtension,
                vec![at(1, 100.0), at(2, 110.0)]
            ))
            .is_err(),
            "an extension takes three anchors"
        );
        let fan = make(&add(DrawingKind::FibFan, vec![at(1, 100.0), at(2, 110.0)])).unwrap();
        assert_eq!(fan.levels.as_deref(), Some(&FIB_FAN_LEVELS[..]));
        assert_eq!(
            fan.style.extend,
            DrawingExtend::Right,
            "a fan's lines are rays"
        );
        assert!(DrawingLabel::default_for(DrawingKind::FibExtension).show_price);
        assert!(!DrawingLabel::default_for(DrawingKind::FibFan).show_price);

        let mut priced = add(DrawingKind::FibFan, vec![at(1, 100.0), at(2, 110.0)]);
        priced.label = label(DrawingLabelInput {
            show_price: Some(true),
            ..DrawingLabelInput::default()
        });
        assert!(make(&priced).is_err(), "a fan's levels have no one price");
        priced.label = label(DrawingLabelInput {
            show_levels: Some(false),
            ..DrawingLabelInput::default()
        });
        assert!(!make(&priced).unwrap().label.unwrap().show_levels);
        priced.label = label(DrawingLabelInput {
            text: Some("swing".into()),
            ..DrawingLabelInput::default()
        });
        assert!(make(&priced).is_err(), "its labels are its levels");
    }

    #[test]
    fn a_cross_line_and_a_trend_angle_are_lines_with_labels() {
        let no_time = AnchorPoint {
            t: None,
            price: price(5.0),
        };
        assert!(make(&add(DrawingKind::CrossLine, vec![no_time])).is_err());
        let mut cross = add(DrawingKind::CrossLine, vec![at(1, 20_641.25)]);
        cross.label = label(DrawingLabelInput {
            text: Some("Open".into()),
            show_price: Some(true),
            ..DrawingLabelInput::default()
        });
        let l = make(&cross).unwrap().label.unwrap();
        assert!(l.show_price);
        assert_eq!(l.align, LabelAlign::Right);
        let mut angle = add(DrawingKind::TrendAngle, vec![at(1, 1.0), at(2, 2.0)]);
        angle.levels = Some(vec![0.5]);
        assert!(make(&angle).is_err(), "a trend angle has no levels");
        angle.levels = None;
        angle.style = Some(DrawingStyleInput {
            extend: Some(DrawingExtend::Right),
            ..DrawingStyleInput::default()
        });
        assert_eq!(make(&angle).unwrap().style.extend, DrawingExtend::Right);
    }

    #[test]
    fn an_update_applies_whole_or_not_at_all() {
        let mut d = make(&add(DrawingKind::TrendLine, vec![at(1, 1.0), at(2, 2.0)])).unwrap();
        let up = ChartUpdateDrawingInput {
            tile_id: None,
            layout_id: None,
            drawing_id: d.id.clone(),
            points: Some(vec![at(3, 3.0), at(4, 4.0)]),
            style: Some(DrawingStyleInput {
                width: Some(2.0),
                ..DrawingStyleInput::default()
            }),
            text: None,
            levels: None,
            label: None,
            locked: Some(true),
        };
        update(&mut d, &up).unwrap();
        assert_eq!(d.points[0], at(3, 3.0));
        assert_eq!(d.style.width, 2.0);
        assert_eq!(d.style.color, "mist", "untouched fields keep theirs");
        assert!(d.locked);
        let bad = ChartUpdateDrawingInput {
            points: Some(vec![at(5, 5.0), at(6, 6.0)]),
            levels: Some(vec![0.5]),
            ..up
        };
        assert!(update(&mut d, &bad).is_err());
        assert_eq!(d.points[0], at(3, 3.0), "nothing changed");
    }

    #[test]
    fn a_volume_profile_is_a_study_not_a_drawing() {
        for kind in ["profile_range", "profile_anchored"] {
            assert!(
                serde_json::from_value::<DrawingKind>(json!(kind)).is_err(),
                "{kind}"
            );
        }
    }

    #[test]
    fn user_horizontal_lines_become_drawings() {
        let ann = |id: &str, kind, ns| Annotation {
            id: id.into(),
            kind,
            namespace: ns,
            session_id: None,
            instrument: None,
            label: None,
            note: None,
            points: vec![AnchorPoint {
                t: None,
                price: price(20_641.25),
            }],
            style: None,
            created_at: Timestamp::from_secs(5),
        };
        let mut c = ChartState {
            tile_id: "chart-1".into(),
            title: "Chart 1".into(),
            instrument: InstrumentId::new("NQ").unwrap(),
            timeframe: Timeframe::M5,
            print_bars: None,
            layers: Vec::new(),
            annotations: vec![
                ann("u_hline_abc", AnnotationKind::Hline, OverlayNamespace::User),
                ann("ann_1", AnnotationKind::Hline, OverlayNamespace::Agent),
                ann("ann_2", AnnotationKind::Zone, OverlayNamespace::User),
                ann("ann_3", AnnotationKind::Hline, OverlayNamespace::User),
            ],
            viewport: None,
            link_group: None,
            chart_type: None,
            hours: None,
            drawings: Vec::new(),
            drawings_from: Vec::new(),
        };
        assert!(migrate_annotations(&mut c));
        assert_eq!(
            c.annotations.len(),
            3,
            "agent annotations, other kinds and annotate's own lines stay"
        );
        assert_eq!(c.drawings.len(), 1);
        let d = &c.drawings[0];
        assert_eq!(d.id, "dr_abc");
        assert_eq!(d.kind, DrawingKind::HorizontalLine);
        assert_eq!(d.instrument.as_str(), "NQ");
        assert_eq!(d.points[0].price, price(20_641.25));
        assert!(!migrate_annotations(&mut c), "once");
    }

    fn label(input: DrawingLabelInput) -> Option<DrawingLabelInput> {
        Some(input)
    }

    #[test]
    fn lines_and_shapes_take_a_label_with_the_kinds_defaults() {
        let mut i = add(
            DrawingKind::HorizontalLine,
            vec![AnchorPoint {
                t: None,
                price: price(20_641.25),
            }],
        );
        i.label = label(DrawingLabelInput {
            text: Some("Asia high\n".into()),
            show_price: Some(true),
            ..DrawingLabelInput::default()
        });
        let d = make(&i).unwrap();
        let l = d.label.as_ref().unwrap();
        assert_eq!(l.text, "Asia high", "trailing space trimmed");
        assert_eq!(
            l.align,
            LabelAlign::Right,
            "a level's words sit at the right"
        );
        assert_eq!(l.position, LabelPosition::Above);
        assert_eq!(l.size, LABEL_SIZE);
        assert!(l.show_price && l.color.is_none());

        let mut t = add(DrawingKind::TrendLine, vec![at(1, 1.0), at(2, 2.0)]);
        t.text = Some("PDH".into());
        let err = make(&t).unwrap_err();
        assert!(err.contains("label.text"), "{err}");
        t.text = None;
        assert!(
            make(&t).unwrap().label.is_none(),
            "no label until one is given"
        );
        for (bad, why) in [
            (
                DrawingLabelInput {
                    show_price: Some(true),
                    ..DrawingLabelInput::default()
                },
                "a trend line has no price",
            ),
            (
                DrawingLabelInput {
                    size: Some(60),
                    ..DrawingLabelInput::default()
                },
                "too big",
            ),
            (
                DrawingLabelInput {
                    color: Some("aqua".into()),
                    ..DrawingLabelInput::default()
                },
                "aqua is the analyst's",
            ),
            (
                DrawingLabelInput {
                    show_levels: Some(false),
                    ..DrawingLabelInput::default()
                },
                "levels are a retracement's",
            ),
            (
                DrawingLabelInput {
                    text: Some("x".repeat(LABEL_TEXT_MAX + 1)),
                    ..DrawingLabelInput::default()
                },
                "too long",
            ),
        ] {
            t.label = Some(bad);
            assert!(make(&t).is_err(), "{why}");
        }

        let mut note = add(DrawingKind::Text, vec![at(1, 1.0)]);
        note.text = Some("hi".into());
        note.label = label(DrawingLabelInput::default());
        assert!(make(&note).is_err());
        let mut fib = add(DrawingKind::FibRetracement, vec![at(1, 1.0), at(2, 2.0)]);
        fib.label = label(DrawingLabelInput {
            text: Some("swing".into()),
            ..DrawingLabelInput::default()
        });
        assert!(make(&fib).is_err());
        fib.label = label(DrawingLabelInput {
            show_levels: Some(false),
            align: Some(LabelAlign::Right),
            ..DrawingLabelInput::default()
        });
        let l = make(&fib).unwrap().label.unwrap();
        assert!(!l.show_levels && l.show_price, "prices stay on by default");
        assert_eq!(l.align, LabelAlign::Right);
    }

    #[test]
    fn a_label_update_keeps_what_it_does_not_name() {
        let mut i = add(DrawingKind::Ray, vec![at(1, 1.0), at(2, 2.0)]);
        i.label = label(DrawingLabelInput {
            text: Some("Swing".into()),
            color: Some("brass".into()),
            bold: Some(true),
            ..DrawingLabelInput::default()
        });
        let mut d = make(&i).unwrap();
        let up = |l: DrawingLabelInput| ChartUpdateDrawingInput {
            tile_id: None,
            layout_id: None,
            drawing_id: "dr_1".into(),
            points: None,
            style: None,
            text: None,
            levels: None,
            label: Some(l),
            locked: None,
        };
        update(
            &mut d,
            &up(DrawingLabelInput {
                position: Some(LabelPosition::Below),
                color: Some(String::new()),
                ..DrawingLabelInput::default()
            }),
        )
        .unwrap();
        let l = d.label.clone().unwrap();
        assert_eq!(l.text, "Swing");
        assert!(l.bold);
        assert_eq!(l.position, LabelPosition::Below);
        assert_eq!(l.color, None, "\"\" follows the line again");
        assert!(
            update(
                &mut d,
                &up(DrawingLabelInput {
                    size: Some(2),
                    text: Some("lost".into()),
                    ..DrawingLabelInput::default()
                })
            )
            .is_err()
        );
        assert_eq!(d.label.as_ref().unwrap().text, "Swing", "nothing changed");
        assert_eq!(d.label.unwrap().look().text, "");
    }

    #[test]
    fn a_drawing_saved_before_labels_loads_without_one() {
        let v = json!({
            "id": "dr_old", "kind": "horizontal_line", "instrument": "NQ",
            "points": [{"t": null, "price": 20641.25}],
            "style": {"color": "mist", "width": 1, "line": "solid"},
            "namespace": "user", "sessionId": null, "createdAt": "1970-01-01T00:00:01Z"
        });
        let d: Drawing = serde_json::from_value(v).unwrap();
        assert!(d.label.is_none());
        let back = serde_json::to_value(&d).unwrap();
        assert!(back.get("label").is_none(), "absent stays absent");
        let l: DrawingLabel = serde_json::from_value(json!({"text": "PDH"})).unwrap();
        assert_eq!(l.size, LABEL_SIZE);
        assert!(l.show_levels && !l.show_price);
        let priced = DrawingLabel {
            show_price: true,
            ..l.clone()
        };
        assert!(
            !check_label(DrawingKind::TrendLine, &priced)
                .unwrap()
                .show_price,
            "a price a trend line cannot show is dropped"
        );
    }

    #[test]
    fn stored_drawings_read_back_and_the_schema_names_every_kind() {
        let d = make(&add(DrawingKind::Measure, vec![at(1, 1.0), at(2, 2.0)])).unwrap();
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("text").is_none(), "absent fields are not written");
        assert_eq!(v["style"]["extend"], "none");
        let back: Drawing = serde_json::from_value(v).unwrap();
        assert_eq!(back, d);
        let s = serde_json::to_string(&schemars::schema_for!(ChartAddDrawingInput)).unwrap();
        for k in DrawingKind::ALL {
            assert!(s.contains(k.as_str()), "{}", k.as_str());
        }
    }
}
