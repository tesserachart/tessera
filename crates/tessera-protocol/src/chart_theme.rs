use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;

pub const KEY: &str = "appearance.chartTheme";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rule {
    Lit(&'static str),
    From(&'static str, f64),
    Unset,
}

#[derive(Clone, Copy, Debug)]
pub struct ThemeColor {
    pub group: &'static str,
    pub key: &'static str,
    pub label: &'static str,
    pub about: &'static str,
    pub rule: Rule,
}

impl ThemeColor {
    pub fn path(&self) -> String {
        format!("{}.{}", self.group, self.key)
    }
}

pub const fn color(
    group: &'static str,
    key: &'static str,
    label: &'static str,
    about: &'static str,
    rule: Rule,
) -> ThemeColor {
    ThemeColor {
        group,
        key,
        label,
        about,
        rule,
    }
}

use Rule::{From as F, Unset as U};

const fn c(
    group: &'static str,
    key: &'static str,
    label: &'static str,
    about: &'static str,
    rule: Rule,
) -> ThemeColor {
    color(group, key, label, about, rule)
}

#[rustfmt::skip]
pub const COLORS: &[ThemeColor] = &[
    c("palette", "background", "Background", "The chart's ground.", F("surfaces.ground", 1.0)),
    c("palette", "text", "Text", "Values: the legend's figures, the crosshair's readout, the line chart.", F("ink.t1", 1.0)),
    c("palette", "subtle", "Secondary text", "A new session's day, prior-day levels, a lone working order.", F("ink.t2", 1.0)),
    c("palette", "muted", "Quiet text", "Axis prices and times, and the legend's labels.", F("ink.t3", 1.0)),
    c("palette", "mist", "Lines", "The grid, the crosshair and resting liquidity.", F("ink.t1", 1.0)),
    c("palette", "up", "Up", "Up candles, buying, targets; every up colour derives from it.", F("semantics.up", 1.0)),
    c("palette", "down", "Down", "Down candles, selling, stops; every down colour derives from it.", F("semantics.down", 1.0)),
    c("palette", "analyst", "Analyst", "The analyst's lines, drafts and marks.", F("semantics.agent", 1.0)),
    c("palette", "hazard", "Limit", "A limit that binds now (the daily loss limit).", F("semantics.hazard", 1.0)),
    c("palette", "active", "Active", "An open position: its entry line and tag.", F("semantics.active", 1.0)),
    c("canvas", "gridHorizontal", "Horizontal grid", "Lines at the price axis's steps.", F("palette.mist", 0.032)),
    c("canvas", "gridVertical", "Vertical grid", "Lines at the time axis's steps (none by default).", F("palette.mist", 0.0)),
    c("canvas", "border", "Borders", "Scale lines and the separators between panes.", F("lines.hairline", 1.0)),
    c("canvas", "sessions", "Session separators", "The dashed line where a new session starts.", F("lines.hairline", 1.0)),
    c("axis", "text", "Axis text", "Prices and times on the axes, and the legend's labels.", F("palette.muted", 1.0)),
    c("axis", "day", "New day", "A new session's day on the time axis.", F("palette.subtle", 1.0)),
    c("crosshair", "line", "Crosshair", "The crosshair's dashed lines.", F("palette.mist", 0.32)),
    c("crosshair", "label", "Crosshair labels", "The ground of the crosshair's price and time on the axes.", F("surfaces.raise", 1.0)),
    c("lastPrice", "line", "Last price line", "The dotted line at the last price.", F("palette.text", 0.55)),
    c("lastPrice", "label", "Last price label", "The last price's box on the axis.", F("palette.text", 1.0)),
    c("candles", "upBody", "Up body", "The body of an up candle.", F("palette.up", 1.0)),
    c("candles", "downBody", "Down body", "The body of a down candle.", F("palette.down", 1.0)),
    c("candles", "upWick", "Up wick", "The wick of an up candle.", F("candles.upBody", 1.0)),
    c("candles", "downWick", "Down wick", "The wick of a down candle.", F("candles.downBody", 1.0)),
    c("candles", "upBorder", "Up border", "The edge of an up candle's body.", F("candles.upBody", 1.0)),
    c("candles", "downBorder", "Down border", "The edge of a down candle's body.", F("candles.downBody", 1.0)),
    c("candles", "barUp", "Up bar", "An up OHLC bar.", F("palette.up", 1.0)),
    c("candles", "barDown", "Down bar", "A down OHLC bar.", F("palette.down", 1.0)),
    c("candles", "line", "Line", "The line chart through the closes.", F("palette.text", 1.0)),
    c("volume", "up", "Up volume", "Volume bars of up candles (drawn at the volume indicator's opacity).", F("palette.up", 1.0)),
    c("volume", "down", "Down volume", "Volume bars of down candles.", F("palette.down", 1.0)),
    c("levels", "custom", "Other levels", "Any other level.", F("palette.subtle", 1.0)),
    c("orders", "position", "Position", "An open position's or a bracket's entry line and tag.", F("palette.active", 1.0)),
    c("orders", "working", "Working order", "A lone working order.", F("palette.subtle", 1.0)),
    c("orders", "stop", "Stop", "A stop leg, its line and its zone.", F("palette.down", 1.0)),
    c("orders", "target", "Target", "A target leg, its line and its zone.", F("palette.up", 1.0)),
    c("orders", "stopZone", "Stop zone", "The band from a position's entry to its stop; clear to hide it.", F("orders.stop", 0.07)),
    c("orders", "targetZone", "Target zone", "The band from a position's entry to its target; clear to hide it.", F("orders.target", 0.07)),
    c("orders", "draft", "Draft", "An order the analyst drafted, until you approve it.", F("palette.analyst", 1.0)),
    c("profile", "bar", "Profile", "Volume profile rows.", F("palette.subtle", 0.22)),
    c("profile", "valueArea", "Value area", "Volume profile rows inside the value area.", F("palette.subtle", 0.42)),
    c("profile", "poc", "Point of control", "The profile's point of control row.", F("palette.mist", 0.72)),
    c("profile", "buy", "Profile buying", "The buying side of a split profile row.", F("palette.up", 0.24)),
    c("profile", "sell", "Profile selling", "The selling side of a split profile row.", F("palette.down", 0.28)),
    c("footprint", "text", "Footprint figures", "The footprint's counts.", F("palette.text", 0.82)),
    c("footprint", "ask", "Footprint buying", "Cells and figures of aggressive buying (at the ask).", F("palette.up", 1.0)),
    c("footprint", "bid", "Footprint selling", "Cells and figures of aggressive selling (at the bid).", F("palette.down", 1.0)),
    c("footprint", "imbalanceAsk", "Buy imbalance", "A buying imbalance and stacked buying zones.", F("footprint.ask", 1.0)),
    c("footprint", "imbalanceBid", "Sell imbalance", "A selling imbalance and stacked selling zones.", F("footprint.bid", 1.0)),
    c("footprint", "volume", "Volume tint", "Cells tinted by volume.", F("palette.mist", 1.0)),
    c("footprint", "poc", "Footprint POC", "A bar's point of control outline.", F("palette.mist", 1.0)),
    c("delta", "positive", "Positive delta", "Delta and cumulative delta above zero.", F("palette.up", 1.0)),
    c("delta", "negative", "Negative delta", "Delta and cumulative delta below zero.", F("palette.down", 1.0)),
    c("bigTrades", "buy", "Big buys", "Big-trade bubbles of aggressive buying. The colour's opacity is the bubble's: an opaque colour draws a solid bubble.", F("palette.up", 0.25)),
    c("bigTrades", "sell", "Big sells", "Big-trade bubbles of aggressive selling. The colour's opacity is the bubble's: an opaque colour draws a solid bubble.", F("palette.down", 0.25)),
    c("drawings", "handles", "Drawing handles", "A selected drawing's handles (unset: the drawing's own colour).", U),
];

pub const ORDER_KEYS: &[&str] = &[
    "orders.position",
    "orders.working",
    "orders.stop",
    "orders.target",
    "orders.draft",
];

const WCAG_NON_TEXT_CONTRAST: f64 = 3.0;

pub const MIN_ORDER_CONTRAST: f64 = WCAG_NON_TEXT_CONTRAST;

#[derive(Clone, Copy, Debug)]
pub struct ThemeFont {
    pub key: &'static str,
    pub label: &'static str,
    pub about: &'static str,
    pub default: f64,
    pub min: f64,
    pub max: f64,
}

pub const FONTS: &[ThemeFont] = &[
    ThemeFont {
        key: "size",
        label: "Text size",
        about: "Times, the legend and words on the chart, in px.",
        default: 11.5,
        min: 10.0,
        max: 16.0,
    },
    ThemeFont {
        key: "priceSize",
        label: "Price size",
        about: "Prices on the axis and in its tags, in px.",
        default: 12.0,
        min: 11.0,
        max: 18.0,
    },
];

#[derive(Clone, Copy, Debug)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub about: &'static str,
    pub colors: &'static [(&'static str, &'static str)],
}

pub const PRESETS: &[Preset] = &[
    Preset {
        id: "tessera",
        label: "App theme",
        about: "The app theme's own chart: its ground, ink, lines and up and down.",
        colors: &[],
    },
    Preset {
        id: "classic",
        label: "Classic",
        about: "Slate ground, teal and red candles, a grid both ways.",
        colors: &[
            ("palette.background", "#131722"),
            ("palette.text", "#d1d4dc"),
            ("palette.subtle", "#b2b5be"),
            ("palette.muted", "#787b86"),
            ("palette.mist", "#b2b5be"),
            ("palette.up", "#26a69a"),
            ("palette.down", "#ef5350"),
            ("canvas.gridHorizontal", "#2a2e3999"),
            ("canvas.gridVertical", "#2a2e3999"),
            ("canvas.border", "#2a2e39"),
            ("canvas.sessions", "#363a45"),
            ("crosshair.line", "#9598a1aa"),
            ("crosshair.label", "#363a45"),
            ("palette.active", "#b2b5be"),
        ],
    },
    Preset {
        id: "terminal",
        label: "Terminal",
        about: "Black ground, bright green and red, a fine grid.",
        colors: &[
            ("palette.background", "#000000"),
            ("palette.text", "#e8e8e8"),
            ("palette.subtle", "#a6a6a6"),
            ("palette.muted", "#6e6e6e"),
            ("palette.mist", "#cfcfcf"),
            ("palette.up", "#22c55e"),
            ("palette.down", "#ef4444"),
            ("canvas.gridHorizontal", "#ffffff12"),
            ("canvas.gridVertical", "#ffffff0a"),
            ("canvas.border", "#262626"),
            ("canvas.sessions", "#333333"),
            ("crosshair.line", "#ffffff66"),
            ("crosshair.label", "#1f1f1f"),
            ("palette.active", "#cfcfcf"),
        ],
    },
    Preset {
        id: "graphite",
        label: "Graphite",
        about: "Neutral grey, hollow up candles, quiet green and red for order flow.",
        colors: &[
            ("palette.background", "#15171b"),
            ("palette.text", "#e6e8eb"),
            ("palette.subtle", "#a9aeb6"),
            ("palette.muted", "#737a84"),
            ("palette.mist", "#d5d9de"),
            ("palette.up", "#7cbf9e"),
            ("palette.down", "#dc8580"),
            ("canvas.gridHorizontal", "#ffffff0a"),
            ("canvas.border", "#262a30"),
            ("canvas.sessions", "#2c3036"),
            ("crosshair.label", "#22262c"),
            ("candles.upBody", "#15171b"),
            ("candles.upWick", "#c9ced6"),
            ("candles.upBorder", "#c9ced6"),
            ("candles.downBody", "#6b737e"),
            ("candles.barUp", "#c9ced6"),
            ("candles.barDown", "#6b737e"),
            ("candles.line", "#c9ced6"),
            ("palette.active", "#d5d9de"),
        ],
    },
];

pub const UP_DOWN_PAIRS: &[(&str, &str, &str)] = &[
    ("tessera", "#2fd3b4", "#e0523f"),
    ("jade_coral", "#5fc79c", "#ec7b78"),
];

pub const UP_DOWN_KEY: &str = "appearance.upDownColors";

pub fn known_up_down(value: &Value) -> Value {
    match value.as_str() {
        Some("blue_red") => json!("tessera"),
        Some("green_red") => json!("jade_coral"),
        _ => value.clone(),
    }
}
const PRESET_FIELD: &str = "preset";
const RESET_FIELD: &str = "reset";
const FONTS_FIELD: &str = "fonts";
const CHART_PRESET_FIELD: &str = "chartPreset";

pub fn groups() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for k in COLORS {
        if !out.contains(&k.group) {
            out.push(k.group);
        }
    }
    out
}

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

pub fn presets_info() -> Vec<ChartThemePresetInfo> {
    PRESETS
        .iter()
        .map(|p| ChartThemePresetInfo {
            id: p.id.into(),
            label: p.label.into(),
            about: p.about.into(),
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba(pub u8, pub u8, pub u8, pub u8);

impl Rgba {
    pub fn hex(self) -> String {
        let Rgba(r, g, b, a) = self;
        if a == 255 {
            format!("#{r:02x}{g:02x}{b:02x}")
        } else {
            format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
        }
    }

    pub fn times_alpha(self, k: f64) -> Self {
        let a = (f64::from(self.3) * k.clamp(0.0, 1.0)).round();
        Rgba(self.0, self.1, self.2, a as u8)
    }

    pub fn over(self, ground: Rgba) -> Rgba {
        let a = f64::from(self.3) / 255.0;
        let mix = |f: u8, b: u8| (f64::from(f) * a + f64::from(b) * (1.0 - a)).round() as u8;
        Rgba(
            mix(self.0, ground.0),
            mix(self.1, ground.1),
            mix(self.2, ground.2),
            255,
        )
    }

    pub fn wcag_relative_luminance(self) -> f64 {
        let lin = |v: u8| {
            let c = f64::from(v) / 255.0;
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(self.0) + 0.7152 * lin(self.1) + 0.0722 * lin(self.2)
    }
}

pub fn parse_hex(s: &str) -> Option<Rgba> {
    let h = s.trim().strip_prefix('#')?;
    if !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let digit = |i: usize| u8::from_str_radix(&h[i..=i], 16).ok().map(|d| d * 17);
    let pair = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    match h.len() {
        3 => Some(Rgba(digit(0)?, digit(1)?, digit(2)?, 255)),
        4 => Some(Rgba(digit(0)?, digit(1)?, digit(2)?, digit(3)?)),
        6 => Some(Rgba(pair(0)?, pair(2)?, pair(4)?, 255)),
        8 => Some(Rgba(pair(0)?, pair(2)?, pair(4)?, pair(6)?)),
        _ => None,
    }
}

pub fn wcag_contrast_ratio(fg: Rgba, bg: Rgba) -> f64 {
    let bg = Rgba(bg.0, bg.1, bg.2, 255);
    let (a, b) = (
        fg.over(bg).wcag_relative_luminance(),
        bg.wcag_relative_luminance(),
    );
    let (hi, lo) = if a > b { (a, b) } else { (b, a) };
    (hi + 0.05) / (lo + 0.05)
}

/// `appearance.get_chart_theme` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartThemeGetInput {}

/// A preset, as the tool lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartThemePresetInfo {
    /// Its id (`preset`).
    pub id: String,
    /// Its name.
    pub label: String,
    /// One line on it.
    pub about: String,
}

/// `appearance.get_chart_theme` output: the chart theme every chart draws with now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartThemeOutput {
    /// The preset it starts from.
    pub preset: String,
    /// Every colour key (`group.key`) and the colour it draws in (`#rrggbb[aa]`), null where the
    /// chart picks (a handle in its drawing's colour).
    pub colors: BTreeMap<String, Option<String>>,
    /// The keys you set over the preset (the stored value's colours).
    pub overridden: Vec<String>,
    /// `fonts.size` and `fonts.priceSize` in px.
    pub fonts: BTreeMap<String, f64>,
    /// The presets `preset` may name.
    pub presets: Vec<ChartThemePresetInfo>,
    /// The stored value, as settings.get returns it.
    pub value: Value,
}

fn preset_list() -> String {
    PRESETS.iter().map(|p| p.id).collect::<Vec<_>>().join(", ")
}

pub fn to_theme_change(change: &Value) -> Result<Value, String> {
    let Some(change) = change.as_object() else {
        return Err(
            "expected an object such as {\"palette\": {\"background\": \"#101418\"}}".into(),
        );
    };
    let groups = groups();
    let mut out = Map::new();
    match change.get(RESET_FIELD) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => {}
        Some(Value::Bool(true)) => {
            out.insert(CHART_PRESET_FIELD.into(), Value::Null);
            out.insert(FONTS_FIELD.into(), Value::Null);
        }
        Some(_) => return Err("reset: expected true".into()),
    }
    for (field, v) in change {
        match field.as_str() {
            RESET_FIELD => {}
            PRESET_FIELD => match v {
                Value::String(p) if preset(p).is_some() => {
                    out.insert(CHART_PRESET_FIELD.into(), v.clone());
                }
                Value::String(p) => {
                    return Err(format!(
                        "preset: no preset {p:?} (presets: {})",
                        preset_list()
                    ));
                }
                Value::Null => {
                    out.insert(CHART_PRESET_FIELD.into(), Value::Null);
                }
                _ => return Err("preset: expected a preset's id".into()),
            },
            FONTS_FIELD => {
                out.insert(FONTS_FIELD.into(), v.clone());
            }
            g if groups.contains(&g) => {
                out.insert(field.clone(), v.clone());
            }
            _ => {
                return Err(format!(
                    "unknown field {field} (known: preset, reset, {}, fonts)",
                    groups.join(", ")
                ));
            }
        }
    }
    Ok(Value::Object(out))
}

pub fn view(theme_value: &Value) -> Value {
    let groups = groups();
    let mut out = Map::new();
    let Some(m) = theme_value.as_object() else {
        return Value::Object(out);
    };
    for (field, v) in m {
        if field == CHART_PRESET_FIELD {
            out.insert(PRESET_FIELD.into(), v.clone());
        } else if field == FONTS_FIELD || groups.contains(&field.as_str()) {
            out.insert(field.clone(), v.clone());
        }
    }
    Value::Object(out)
}

pub fn schema() -> Value {
    let full = crate::theme::schema();
    let props = full["properties"].as_object().cloned().unwrap_or_default();
    let mut out = Map::new();
    out.insert(
        PRESET_FIELD.into(),
        json!({"type": "string", "enum": PRESETS.iter().map(|p| p.id).collect::<Vec<_>>(),
            "description": "The chart look everything starts from (tessera: the app theme's own chart); setting it drops your chart colours."}),
    );
    out.insert(
        RESET_FIELD.into(),
        json!({"type": "boolean", "description": "true: back to the app theme's own chart (only in a change, never stored)."}),
    );
    for g in groups() {
        if let Some(s) = props.get(g) {
            out.insert(g.into(), s.clone());
        }
    }
    if let Some(s) = props.get(FONTS_FIELD) {
        out.insert(FONTS_FIELD.into(), s.clone());
    }
    json!({"type": "object", "additionalProperties": false, "properties": out})
}

pub fn output(theme_value: &Value, up_down: &str) -> ChartThemeOutput {
    let r = crate::theme::resolve(theme_value, up_down);
    let chart: BTreeSet<String> = COLORS.iter().map(ThemeColor::path).collect();
    ChartThemeOutput {
        preset: r.chart_preset.id.to_owned(),
        colors: r
            .colors
            .iter()
            .filter(|(k, _)| chart.contains(*k))
            .map(|(k, v)| (k.clone(), v.map(Rgba::hex)))
            .collect(),
        overridden: COLORS
            .iter()
            .map(ThemeColor::path)
            .filter(|k| r.overridden.contains(k))
            .collect(),
        fonts: r.fonts,
        presets: presets_info(),
        value: view(theme_value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{self, check, patch, resolve};

    fn chart(current: &Value, change: Value) -> Result<Value, String> {
        patch(current, &to_theme_change(&change)?)
    }

    #[test]
    fn tessera_resolves_to_the_systems_colours() {
        let r = resolve(&json!({}), "tessera");
        let hex = |k: &str| r.colors[k].map(Rgba::hex);
        assert_eq!(r.chart_preset.id, "tessera");
        assert_eq!(hex("palette.background").as_deref(), Some("#05080b"));
        assert_eq!(hex("palette.text").as_deref(), Some("#e8eef3"));
        assert_eq!(hex("palette.subtle").as_deref(), Some("#aebcc8"));
        assert_eq!(hex("palette.muted").as_deref(), Some("#7c8b99"));
        assert_eq!(hex("candles.upBody").as_deref(), Some("#2fd3b4"));
        assert_eq!(hex("candles.upWick").as_deref(), Some("#2fd3b4"));
        assert_eq!(hex("candles.downBody").as_deref(), Some("#e0523f"));
        assert_eq!(hex("profile.buy").as_deref(), Some("#2fd3b43d"));
        assert_eq!(hex("profile.sell").as_deref(), Some("#e0523f47"));
        assert_eq!(hex("canvas.gridHorizontal").as_deref(), Some("#e8eef308"));
        assert_eq!(hex("canvas.gridVertical").as_deref(), Some("#e8eef300"));
        assert_eq!(hex("canvas.border").as_deref(), Some("#1b2730"));
        assert_eq!(hex("crosshair.label").as_deref(), Some("#0d1319"));
        assert_eq!(hex("palette.active").as_deref(), Some("#d8b26a"));
        assert_eq!(hex("orders.position").as_deref(), Some("#d8b26a"));
        assert_eq!(hex("orders.draft").as_deref(), Some("#8ed1fc"));
        assert_eq!(hex("drawings.handles"), None);
        assert!(r.explicit.is_empty());
        let g = resolve(&json!({}), "jade_coral");
        assert_eq!(
            g.colors["candles.downBody"].map(Rgba::hex).as_deref(),
            Some("#ec7b78")
        );
        assert_eq!(
            g.colors["candles.upBody"].map(Rgba::hex).as_deref(),
            Some("#5fc79c")
        );
        let c = resolve(&json!({"chartPreset": "classic"}), "jade_coral");
        assert_eq!(
            c.colors["candles.upBody"].map(Rgba::hex).as_deref(),
            Some("#26a69a")
        );
        assert_eq!(r.fonts["size"], 11.5);
    }

    #[test]
    fn tessera_text_and_candles_read_on_its_ground() {
        let r = resolve(&json!({}), "tessera");
        let ground = r.colors["palette.background"].unwrap();
        let ratio = |k: &str| wcag_contrast_ratio(r.colors[k].unwrap(), ground);
        for k in [
            "palette.text",
            "palette.subtle",
            "palette.muted",
            "axis.text",
        ] {
            assert!(ratio(k) >= 4.5, "{k} {:.2}", ratio(k));
        }
        for k in ["candles.upBody", "candles.downBody", "orders.position"] {
            assert!(ratio(k) >= WCAG_NON_TEXT_CONTRAST, "{k} {:.2}", ratio(k));
        }
    }

    #[test]
    fn a_saved_up_down_pair_from_before_blue_and_orange_opens_on_its_new_name() {
        assert_eq!(known_up_down(&json!("blue_red")), json!("tessera"));
        assert_eq!(known_up_down(&json!("green_red")), json!("jade_coral"));
        assert_eq!(known_up_down(&json!("jade_coral")), json!("jade_coral"));
        assert_eq!(known_up_down(&json!("tessera")), json!("tessera"));
        let ids: Vec<&str> = UP_DOWN_PAIRS.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(ids, ["tessera", "jade_coral"]);
    }

    #[test]
    fn a_chart_change_merges_into_the_one_theme_and_null_drops_an_override() {
        let v = chart(&json!({}), json!({"palette": {"background": "#0A0B0C"}})).unwrap();
        assert_eq!(v, json!({"palette": {"background": "#0a0b0c"}}));
        let v = chart(
            &v,
            json!({"candles": {"upWick": "#fff"}, "fonts": {"size": 13}}),
        )
        .unwrap();
        assert_eq!(
            v,
            json!({"palette": {"background": "#0a0b0c"}, "candles": {"upWick": "#ffffff"}, "fonts": {"size": 13}})
        );
        let r = resolve(&v, "tessera");
        assert_eq!(
            r.colors["candles.upWick"].map(Rgba::hex).as_deref(),
            Some("#ffffff")
        );
        assert_eq!(
            r.colors["candles.upBorder"].map(Rgba::hex).as_deref(),
            Some("#2fd3b4")
        );
        assert!(r.explicit.contains("candles.upWick"));
        let v = chart(&v, json!({"candles": {"upWick": null}, "fonts": null})).unwrap();
        assert_eq!(v, json!({"palette": {"background": "#0a0b0c"}}));
        let v = chart(&v, json!({"palette": null})).unwrap();
        assert_eq!(v, json!({}));
        let app = json!({"preset": "nord", "ink": {"t2": "#cccccc"}});
        let v = chart(&app, json!({"palette": {"up": "#00ff00"}})).unwrap();
        assert_eq!(view(&v), json!({"palette": {"up": "#00ff00"}}));
        assert_eq!(v["preset"], json!("nord"));
    }

    #[test]
    fn a_chart_preset_starts_the_chart_clean_and_reset_goes_back_to_the_theme() {
        let mine = json!({"preset": "nord", "palette": {"up": "#00ff00"}});
        let v = chart(&mine, json!({"preset": "terminal"})).unwrap();
        assert_eq!(v, json!({"preset": "nord", "chartPreset": "terminal"}));
        assert_eq!(view(&v), json!({"preset": "terminal"}));
        let v = chart(
            &mine,
            json!({"preset": "classic", "candles": {"upBody": "#ffffff"}}),
        )
        .unwrap();
        assert_eq!(
            v,
            json!({"preset": "nord", "chartPreset": "classic", "candles": {"upBody": "#ffffff"}})
        );
        assert_eq!(
            chart(&v, json!({"reset": true})).unwrap(),
            json!({"preset": "nord"})
        );
        assert_eq!(
            chart(&v, json!({"preset": "tessera"})).unwrap(),
            json!({"preset": "nord"})
        );
    }

    #[test]
    fn wrong_keys_and_colours_are_refused_with_the_right_ones() {
        let e = chart(&json!({}), json!({"candle": {}})).unwrap_err();
        assert!(
            e.contains("unknown field candle") && e.contains("candles"),
            "{e}"
        );
        let e = chart(&json!({}), json!({"candles": {"wick": "#fff"}})).unwrap_err();
        assert!(e.contains("upWick"), "{e}");
        let e = chart(&json!({}), json!({"palette": {"up": "green"}})).unwrap_err();
        assert!(e.contains("not a colour"), "{e}");
        let e = chart(&json!({}), json!({"preset": "dracula"})).unwrap_err();
        assert!(e.contains("classic"), "{e}");
        let e = chart(&json!({}), json!({"fonts": {"size": 40}})).unwrap_err();
        assert!(e.contains("10"), "{e}");
        let e = chart(&json!({}), json!({"surfaces": {"ground": "#000000"}})).unwrap_err();
        assert!(e.contains("unknown field surfaces"), "{e}");
        assert!(to_theme_change(&json!("dark")).is_err());
    }

    #[test]
    fn every_preset_keeps_its_orders_readable_under_both_pairs() {
        for p in PRESETS {
            for (pair, _, _) in UP_DOWN_PAIRS {
                let v = chart(&json!({}), json!({"preset": p.id})).unwrap();
                check(&v, pair).unwrap_or_else(|e| panic!("{} {pair}: {e}", p.id));
                assert!(
                    schema()["properties"]["preset"]["enum"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(p.id))
                );
            }
        }
    }

    #[test]
    fn an_unreadable_order_colour_is_refused_and_named() {
        let v = chart(&json!({}), json!({"palette": {"background": "#ffffff"}})).unwrap();
        let e = check(&v, "tessera").unwrap_err();
        assert!(
            e.contains("orders.target") && e.contains("orders.position"),
            "{e}"
        );
        assert!(e.contains("3:1"), "{e}");
        let v = chart(
            &json!({}),
            json!({"palette": {"background": "#ffffff", "mist": "#333333", "subtle": "#555555", "up": "#0b7a3e",
                "down": "#b3261e", "analyst": "#00796b", "active": "#7a5f27"}}),
        )
        .unwrap();
        check(&v, "tessera").unwrap();
        let v = chart(&json!({}), json!({"orders": {"stop": "#0a0c12"}})).unwrap();
        let e = check(&v, "tessera").unwrap_err();
        assert!(e.contains("orders.stop #0a0c12"), "{e}");
    }

    #[test]
    fn contrast_composites_alpha_over_the_ground() {
        let ink = parse_hex("#05070c").unwrap();
        let white = parse_hex("#ffffff").unwrap();
        assert!(wcag_contrast_ratio(white, ink) > 19.0);
        assert!((wcag_contrast_ratio(parse_hex("#ffffff00").unwrap(), ink) - 1.0).abs() < 1e-9);
        assert_eq!(parse_hex("#abc"), Some(Rgba(0xaa, 0xbb, 0xcc, 255)));
        assert_eq!(
            parse_hex("#abcd").map(Rgba::hex).as_deref(),
            Some("#aabbccdd")
        );
        assert_eq!(parse_hex("#12345"), None);
        assert_eq!(parse_hex("red"), None);
    }

    #[test]
    fn the_read_tool_lists_every_chart_key_and_the_chart_overrides() {
        let v = json!({"chartPreset": "classic", "orders": {"stop": "#ff0000", "notInTheTable": "#00ff00"},
            "ink": {"t2": "#cccccc"}});
        let o = output(&v, "tessera");
        assert_eq!(o.preset, "classic");
        assert_eq!(o.colors.len(), COLORS.len());
        assert!(!o.colors.contains_key("orders.notInTheTable"));
        assert!(!o.colors.contains_key("ink.t2"));
        assert_eq!(o.overridden, vec!["orders.stop".to_owned()]);
        assert_eq!(o.colors["palette.background"].as_deref(), Some("#131722"));
        assert_eq!(o.presets.len(), PRESETS.len());
        assert_eq!(
            theme::SHELL.len() + COLORS.len(),
            theme::all_colors().count()
        );
    }
}
