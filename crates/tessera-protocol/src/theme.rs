use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;

use tessera_core::ids::unique;

use crate::chart_theme::{
    self, COLORS, ChartThemePresetInfo, FONTS, ORDER_KEYS, Preset, Rgba, Rule, ThemeColor, color,
    parse_hex, wcag_contrast_ratio,
};

pub const KEY: &str = "appearance.theme";
pub const SAVED_KEY: &str = "appearance.themes";
pub const SCHEME_KEY: &str = "appearance.scheme";

pub const MIN_TEXT_CONTRAST: f64 = 4.5;
pub const NAME_MAX: usize = 60;
pub const SAVED_MAX: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Dark,
    Light,
}

impl ThemeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ThemeMode::Dark => "dark",
            ThemeMode::Light => "light",
        }
    }

    fn parse(s: &str) -> Option<ThemeMode> {
        match s {
            "dark" => Some(ThemeMode::Dark),
            "light" => Some(ThemeMode::Light),
            _ => None,
        }
    }
}

use Rule::{From as F, Lit as L};

#[rustfmt::skip]
pub const SHELL: &[ThemeColor] = &[
    color("surfaces", "ground", "Ground", "Behind everything: the stage, the gaps between panels, the window, and the chart unless the chart sets its own.", L("#05080b")),
    color("surfaces", "panel", "Panels", "The sidebar, panels, dock tabs and settings cards.", L("#0b1116")),
    color("surfaces", "raise", "Raised", "Inputs, raised rows, a pressed toggle and the chart's crosshair labels.", L("#0d1319")),
    color("surfaces", "hover", "Hover", "A row, tab or button under the pointer.", F("surfaces.raise", 1.0)),
    color("surfaces", "menu", "Menus and dialogs", "Menus, popovers, tooltips, sheets and dialogs.", F("surfaces.panel", 1.0)),
    color("surfaces", "selection", "Selection", "Selected text, the page you are on in the sidebar, and selected rows.", L("#073f4f")),
    color("surfaces", "scrim", "Overlay", "The veil behind a dialog or a takeover.", F("surfaces.ground", 0.7)),
    color("surfaces", "shadow", "Shadow", "The one shadow under menus, sheets and floating panels.", F("surfaces.ground", 0.72)),
    color("ink", "t1", "Text", "Body text, figures and titles.", L("#e8eef3")),
    color("ink", "t2", "Secondary text", "Labels, secondary figures and inactive tabs.", L("#aebcc8")),
    color("ink", "t3", "Quiet text", "Hints, units, timestamps and placeholders.", L("#7c8b99")),
    color("ink", "t4", "Faint text", "Disabled controls and the faintest notes.", F("ink.t3", 1.0)),
    color("lines", "hairline", "Hairlines", "The lines between panels, table rules and the chart's borders.", L("#1b2730")),
    color("lines", "line2", "Rules", "Dividers inside a panel and scrollbars.", F("ink.t1", 0.12)),
    color("lines", "line3", "Strong rules", "Emphasised dividers and a splitter under the pointer.", F("ink.t1", 0.22)),
    color("accents", "aqua", "Ice", "Links, drop targets, and the analyst unless semantics.agent sets its own.", L("#8ed1fc")),
    color("accents", "teal", "Brand blue", "Focus rings, the primary button and a field being edited.", L("#0071a9")),
    color("accents", "deep", "Teal deep", "The splash, the analyst's draft frame and the Approve button.", L("#073f4f")),
    color("accents", "onDeep", "On teal deep", "Text on teal deep and on the primary button.", L("#e8eef3")),
    color("accents", "onDeep2", "Quiet on teal deep", "Secondary text on teal deep.", L("#aebcc8")),
    color("semantics", "up", "Up", "Up moves, gains, buying and targets, in the app and on the chart.", L("#2fd3b4")),
    color("semantics", "down", "Down", "Down moves, losses, selling and stops; the one warm colour.", L("#e0523f")),
    color("semantics", "agent", "Analyst", "The analyst's words, marks, lines and drafts.", F("accents.aqua", 1.0)),
    color("semantics", "hazard", "Limit", "A limit that binds now and an evaluation account.", L("#d8b26a")),
    color("semantics", "active", "Active", "The open position, the active workspace and the active tab.", F("semantics.hazard", 1.0)),
    color("card", "paper", "Order card", "The paper card an order draft is written on.", L("#f6f9f9")),
    color("card", "expired", "Expired card", "An order draft that went stale.", L("#e8eeef")),
    color("card", "ink", "Card text", "Figures and words on the order card.", L("#0b1418")),
    color("card", "t2", "Card secondary", "Labels on the order card.", L("#56646b")),
    color("card", "t3", "Card quiet", "Hints on the order card.", L("#5a676d")),
    color("card", "t4", "Card faint", "The faintest notes on the order card.", L("#7b888e")),
    color("card", "line", "Card rules", "Rules on the order card.", L("#dde5e7")),
    color("card", "line2", "Card edges", "The order card's edges.", L("#cdd7da")),
    color("card", "idle", "Approve at rest", "The Approve button before it arms.", L("#e3eaec")),
    color("card", "blue", "Card blue", "Brand blue on the order card.", F("accents.teal", 1.0)),
    color("card", "gold", "Card gold", "A limit on the order card.", L("#7a5f27")),
    color("categorical", "c1", "Group 1", "The first link group of charts and the first journal tag colour.", L("#7f9fbf")),
    color("categorical", "c2", "Group 2", "The third link group and the second tag colour.", L("#9bab78")),
    color("categorical", "c3", "Group 3", "The fourth link group and the third tag colour.", L("#b98f7a")),
    color("categorical", "c4", "Group 4", "The second link group and the fourth tag colour.", L("#a597cf")),
    color("categorical", "c5", "Group 5", "The fifth tag colour.", L("#6fa8a0")),
    color("categorical", "c6", "Group 6", "The sixth tag colour.", L("#c4a46b")),
    color("categorical", "c7", "Group 7", "The seventh tag colour.", L("#b07f9a")),
    color("categorical", "c8", "Group 8", "The eighth tag colour.", L("#8c96a8")),
];

#[derive(Clone, Copy, Debug)]
pub struct BuiltIn {
    pub id: &'static str,
    pub label: &'static str,
    pub family: &'static str,
    pub mode: ThemeMode,
    pub about: &'static str,
    pub colors: &'static [(&'static str, &'static str)],
}

pub const BUILT_INS: &[BuiltIn] = &[
    BuiltIn {
        id: "tessera",
        label: "Tessera",
        family: "tessera",
        mode: ThemeMode::Dark,
        about: "Ink and mist, blue and teal for the brand, warm colour for down only.",
        colors: &[],
    },
    BuiltIn {
        id: "tessera-light",
        label: "Tessera Light",
        family: "tessera",
        mode: ThemeMode::Light,
        about: "Deep blue paper and blue-black ink. Brand blue leads, deep teal for up, Tessera's red deepened for down.",
        colors: &[
            ("surfaces.ground", "#c9dcf0"),
            ("surfaces.panel", "#e4eef7"),
            ("surfaces.raise", "#dbe8f5"),
            ("surfaces.hover", "#d9e7f4"),
            ("surfaces.menu", "#dbe8f5"),
            ("surfaces.selection", "#c6def2"),
            ("surfaces.scrim", "#08192a66"),
            ("surfaces.shadow", "#08192a26"),
            ("ink.t1", "#08192a"),
            ("ink.t2", "#334a5f"),
            ("ink.t3", "#4a6075"),
            ("lines.hairline", "#cddbe8"),
            ("accents.aqua", "#00629a"),
            ("accents.onDeep", "#ffffff"),
            ("accents.onDeep2", "#c3d6df"),
            ("semantics.up", "#00504a"),
            ("semantics.down", "#d23722"),
            ("semantics.hazard", "#7a5f27"),
            ("card.paper", "#dbe8f5"),
            ("card.expired", "#e4eef7"),
            ("categorical.c1", "#3d6a9a"),
            ("categorical.c2", "#5a7a3c"),
            ("categorical.c3", "#97604a"),
            ("categorical.c4", "#6b5fa3"),
            ("categorical.c5", "#2f7d78"),
            ("categorical.c6", "#8a6a22"),
            ("categorical.c7", "#8a5a78"),
            ("categorical.c8", "#566a85"),
            ("palette.background", "#dbe8f5"),
        ],
    },
    BuiltIn {
        id: "solarized-dark",
        label: "Solarized Dark",
        family: "solarized",
        mode: ThemeMode::Dark,
        about: "Solarized's deep blue-green ground, cyan up and red down.",
        colors: &[
            ("surfaces.ground", "#002b36"),
            ("surfaces.panel", "#03313d"),
            ("surfaces.raise", "#073642"),
            ("surfaces.menu", "#073642"),
            ("surfaces.selection", "#0d4f5f"),
            ("ink.t1", "#eee8d5"),
            ("ink.t2", "#b4bcb6"),
            ("ink.t3", "#93a1a1"),
            ("lines.hairline", "#0f4351"),
            ("accents.aqua", "#4ea0e0"),
            ("accents.teal", "#1c6ea6"),
            ("accents.deep", "#0d4f5f"),
            ("accents.onDeep", "#fdf6e3"),
            ("accents.onDeep2", "#c8cdc0"),
            ("semantics.up", "#2aa198"),
            ("semantics.down", "#ec5b52"),
            ("semantics.hazard", "#b58900"),
        ],
    },
    BuiltIn {
        id: "solarized-light",
        label: "Solarized Light",
        family: "solarized",
        mode: ThemeMode::Light,
        about: "Solarized's cream paper with its ink, cyan up and red down.",
        colors: &[
            ("surfaces.ground", "#fdf6e3"),
            ("surfaces.panel", "#f6efdb"),
            ("surfaces.raise", "#eee8d5"),
            ("surfaces.menu", "#fffbf0"),
            ("surfaces.selection", "#e3dcc4"),
            ("surfaces.scrim", "#07364240"),
            ("surfaces.shadow", "#07364226"),
            ("ink.t1", "#073642"),
            ("ink.t2", "#3c5560"),
            ("ink.t3", "#52666c"),
            ("lines.hairline", "#e2dbc6"),
            ("accents.aqua", "#1f72ad"),
            ("accents.teal", "#1f6ea8"),
            ("accents.deep", "#073642"),
            ("accents.onDeep", "#fdf6e3"),
            ("accents.onDeep2", "#c9cdbf"),
            ("semantics.up", "#1f877f"),
            ("semantics.down", "#cb2f2c"),
            ("semantics.hazard", "#8c6a00"),
            ("card.paper", "#fffcf3"),
            ("card.expired", "#f3eddb"),
            ("card.line", "#e6dfc9"),
            ("card.line2", "#d9d1b8"),
            ("card.idle", "#efe9d6"),
        ],
    },
    BuiltIn {
        id: "night-owl",
        label: "Night Owl",
        family: "night-owl",
        mode: ThemeMode::Dark,
        about: "Night Owl's midnight blue, cyan up, coral red down, violet for the brand.",
        colors: &[
            ("surfaces.ground", "#011627"),
            ("surfaces.panel", "#0b2238"),
            ("surfaces.raise", "#0f2c45"),
            ("surfaces.menu", "#0b2942"),
            ("surfaces.selection", "#1d3b53"),
            ("ink.t1", "#d6deeb"),
            ("ink.t2", "#aebacb"),
            ("ink.t3", "#8d9db0"),
            ("lines.hairline", "#122d42"),
            ("accents.aqua", "#82aaff"),
            ("accents.teal", "#7e57c2"),
            ("accents.deep", "#1d3b53"),
            ("accents.onDeep", "#ffffff"),
            ("accents.onDeep2", "#c5d0de"),
            ("semantics.up", "#7fdbca"),
            ("semantics.down", "#ef5350"),
            ("semantics.hazard", "#ecc48d"),
        ],
    },
    BuiltIn {
        id: "nord",
        label: "Nord",
        family: "nord",
        mode: ThemeMode::Dark,
        about: "Nord's polar night and snow storm, aurora green up and red down.",
        colors: &[
            ("surfaces.ground", "#2e3440"),
            ("surfaces.panel", "#333a47"),
            ("surfaces.raise", "#3b4252"),
            ("surfaces.menu", "#3b4252"),
            ("surfaces.selection", "#434c5e"),
            ("ink.t1", "#eceff4"),
            ("ink.t2", "#d8dee9"),
            ("ink.t3", "#b2bccb"),
            ("lines.hairline", "#3f4758"),
            ("accents.aqua", "#88c0d0"),
            ("accents.teal", "#4a6890"),
            ("accents.deep", "#3e5878"),
            ("accents.onDeep", "#eceff4"),
            ("accents.onDeep2", "#d8dee9"),
            ("semantics.up", "#a3be8c"),
            ("semantics.down", "#d0737c"),
            ("semantics.hazard", "#ebcb8b"),
        ],
    },
    BuiltIn {
        id: "gruvbox-dark",
        label: "Gruvbox Dark",
        family: "gruvbox",
        mode: ThemeMode::Dark,
        about: "Gruvbox's warm charcoal and parchment ink, aqua up and red down.",
        colors: &[
            ("surfaces.ground", "#1d2021"),
            ("surfaces.panel", "#282828"),
            ("surfaces.raise", "#32302f"),
            ("surfaces.menu", "#32302f"),
            ("surfaces.selection", "#504945"),
            ("ink.t1", "#ebdbb2"),
            ("ink.t2", "#d5c4a1"),
            ("ink.t3", "#bdae93"),
            ("lines.hairline", "#3c3836"),
            ("accents.aqua", "#83a598"),
            ("accents.teal", "#076678"),
            ("accents.deep", "#1e4c55"),
            ("accents.onDeep", "#fbf1c7"),
            ("accents.onDeep2", "#ebdbb2"),
            ("semantics.up", "#8ec07c"),
            ("semantics.down", "#fb4934"),
            ("semantics.hazard", "#fabd2f"),
        ],
    },
    BuiltIn {
        id: "gruvbox-light",
        label: "Gruvbox Light",
        family: "gruvbox",
        mode: ThemeMode::Light,
        about: "Gruvbox's parchment with charcoal ink, faded aqua up and red down.",
        colors: &[
            ("surfaces.ground", "#fbf1c7"),
            ("surfaces.panel", "#f2e5bc"),
            ("surfaces.raise", "#ebdbb2"),
            ("surfaces.menu", "#f9f5d7"),
            ("surfaces.selection", "#d5c4a1"),
            ("surfaces.scrim", "#28282840"),
            ("surfaces.shadow", "#28282826"),
            ("ink.t1", "#282828"),
            ("ink.t2", "#3c3836"),
            ("ink.t3", "#504945"),
            ("lines.hairline", "#e2d3a6"),
            ("accents.aqua", "#076678"),
            ("accents.teal", "#076678"),
            ("accents.deep", "#1e4c55"),
            ("accents.onDeep", "#fbf1c7"),
            ("accents.onDeep2", "#e2d6b0"),
            ("semantics.up", "#427b58"),
            ("semantics.down", "#9d0006"),
            ("semantics.hazard", "#946013"),
            ("card.paper", "#fdf8e4"),
            ("card.expired", "#f2e9c9"),
            ("card.line", "#ebdfba"),
            ("card.line2", "#dccfa6"),
            ("card.idle", "#f2e8c4"),
        ],
    },
];

const PRESET: &str = "preset";
const RESET: &str = "reset";
const MODE: &str = "mode";
const CHART_PRESET: &str = "chartPreset";
const FONTS_FIELD: &str = "fonts";
const SAVED: &str = "saved";

pub fn all_colors() -> impl Iterator<Item = &'static ThemeColor> {
    SHELL.iter().chain(COLORS.iter())
}

fn groups_of(table: &'static [ThemeColor]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for k in table {
        if !out.contains(&k.group) {
            out.push(k.group);
        }
    }
    out
}

pub fn shell_groups() -> Vec<&'static str> {
    groups_of(SHELL)
}

pub fn groups() -> Vec<&'static str> {
    let mut out = shell_groups();
    out.extend(chart_theme::groups());
    out
}

fn color_key(path: &str) -> Option<&'static ThemeColor> {
    all_colors().find(|k| k.path() == path)
}

pub fn built_in(id: &str) -> Option<&'static BuiltIn> {
    BUILT_INS.iter().find(|t| t.id == id)
}

fn built_in_list() -> String {
    BUILT_INS
        .iter()
        .map(|t| t.id)
        .collect::<Vec<_>>()
        .join(", ")
}

fn chart_preset_list() -> String {
    chart_theme::PRESETS
        .iter()
        .map(|p| p.id)
        .collect::<Vec<_>>()
        .join(", ")
}

fn sibling(t: &BuiltIn, mode: ThemeMode) -> Option<&'static BuiltIn> {
    BUILT_INS
        .iter()
        .find(|b| b.family == t.family && b.mode == mode)
}

fn pairs(colors: &[(&'static str, &'static str)]) -> BTreeMap<&'static str, Rgba> {
    colors
        .iter()
        .filter_map(|(k, v)| Some((*k, parse_hex(v)?)))
        .collect()
}

fn pair_color(path: &str, up_down: &str) -> Option<Rgba> {
    let (_, up, down) = chart_theme::UP_DOWN_PAIRS
        .iter()
        .find(|(id, _, _)| *id == up_down)?;
    match path {
        "semantics.up" => parse_hex(up),
        "semantics.down" => parse_hex(down),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct Resolved {
    pub theme: &'static BuiltIn,
    pub chart_preset: &'static Preset,
    pub mode: ThemeMode,
    pub colors: BTreeMap<String, Option<Rgba>>,
    pub explicit: BTreeSet<String>,
    pub overridden: BTreeSet<String>,
    pub fonts: BTreeMap<String, f64>,
}

impl Resolved {
    pub fn color(&self, path: &str) -> Option<Rgba> {
        self.colors.get(path).copied().flatten()
    }
}

fn own_colors(value: &Value) -> BTreeMap<String, Rgba> {
    let mut out = BTreeMap::new();
    for g in groups() {
        if let Some(Value::Object(m)) = value.get(g) {
            for (k, v) in m {
                let path = format!("{g}.{k}");
                if color_key(&path).is_none() {
                    continue;
                }
                if let Some(c) = v.as_str().and_then(parse_hex) {
                    out.insert(path, c);
                }
            }
        }
    }
    out
}

fn mode_of(colors: &BTreeMap<String, Option<Rgba>>) -> ThemeMode {
    let lum = |k: &str| {
        colors
            .get(k)
            .copied()
            .flatten()
            .map_or(0.0, Rgba::wcag_relative_luminance)
    };
    if lum("surfaces.ground") > lum("ink.t1") {
        ThemeMode::Light
    } else {
        ThemeMode::Dark
    }
}

pub fn resolve(value: &Value, up_down: &str) -> Resolved {
    let theme = value
        .get(PRESET)
        .and_then(Value::as_str)
        .and_then(built_in)
        .unwrap_or(&BUILT_INS[0]);
    let chart_preset = value
        .get(CHART_PRESET)
        .and_then(Value::as_str)
        .and_then(chart_theme::preset)
        .unwrap_or(&chart_theme::PRESETS[0]);
    let from_theme = pairs(theme.colors);
    let from_chart = pairs(chart_preset.colors);
    let own = own_colors(value);
    let mut colors: BTreeMap<String, Option<Rgba>> = BTreeMap::new();
    let mut explicit = BTreeSet::new();
    let mut overridden = BTreeSet::new();
    for k in all_colors() {
        let path = k.path();
        let v = if let Some(c) = own.get(&path) {
            overridden.insert(path.clone());
            explicit.insert(path.clone());
            Some(*c)
        } else if let Some(c) = from_chart
            .get(path.as_str())
            .or_else(|| from_theme.get(path.as_str()))
        {
            explicit.insert(path.clone());
            Some(*c)
        } else {
            match k.rule {
                Rule::Lit(h) => pair_color(&path, up_down).or_else(|| parse_hex(h)),
                Rule::From(src, a) => colors.get(src).copied().flatten().map(|c| c.times_alpha(a)),
                Rule::Unset => None,
            }
        };
        colors.insert(path, v);
    }
    let fonts = FONTS
        .iter()
        .map(|f| {
            let v = value
                .get(FONTS_FIELD)
                .and_then(|o| o.get(f.key))
                .and_then(Value::as_f64)
                .filter(|v| *v >= f.min && *v <= f.max)
                .unwrap_or(f.default);
            (f.key.to_owned(), v)
        })
        .collect();
    let mode = mode_of(&colors);
    Resolved {
        theme,
        chart_preset,
        mode,
        colors,
        explicit,
        overridden,
        fonts,
    }
}

fn known_keys(group: &str) -> String {
    all_colors()
        .filter(|k| k.group == group)
        .map(|k| k.key)
        .collect::<Vec<_>>()
        .join(", ")
}

fn known_fields_list() -> String {
    let mut out = vec![PRESET, RESET, MODE, CHART_PRESET];
    out.extend(groups());
    out.push(FONTS_FIELD);
    out.join(", ")
}

fn fresh(theme: &BuiltIn) -> Map<String, Value> {
    let mut m = Map::new();
    if theme.id != BUILT_INS[0].id {
        m.insert(PRESET.into(), json!(theme.id));
    }
    m
}

fn no_version(t: &BuiltIn, mode: ThemeMode) -> String {
    let others = BUILT_INS
        .iter()
        .filter(|b| b.mode == mode)
        .map(|b| format!("{} ({})", b.label, b.id))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "mode: {} has no {} version; {} themes: {others}",
        t.label,
        mode.as_str(),
        mode.as_str()
    )
}

fn in_mode(t: &'static BuiltIn, mode: Option<ThemeMode>) -> Result<&'static BuiltIn, String> {
    match mode {
        None => Ok(t),
        Some(m) if t.mode == m => Ok(t),
        Some(m) => sibling(t, m).ok_or_else(|| no_version(t, m)),
    }
}

fn current_theme(current: &Value) -> &'static BuiltIn {
    current
        .get(PRESET)
        .and_then(Value::as_str)
        .and_then(built_in)
        .unwrap_or(&BUILT_INS[0])
}

pub fn patch(current: &Value, change: &Value) -> Result<Value, String> {
    let Some(change) = change.as_object() else {
        return Err(
            "expected an object such as {\"preset\": \"solarized-light\"} or {\"surfaces\": {\"ground\": \"#101418\"}}"
                .into(),
        );
    };
    let reset = match change.get(RESET) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err("reset: expected true".into()),
    };
    let mode = match change.get(MODE) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            Some(ThemeMode::parse(s).ok_or_else(|| format!("mode: {s:?} is not dark or light"))?)
        }
        Some(_) => return Err("mode: expected \"dark\" or \"light\"".into()),
    };
    let mut out: Map<String, Value> = match (reset, change.get(PRESET)) {
        (_, Some(Value::String(p))) => {
            let t = built_in(p).ok_or_else(|| {
                format!(
                    "preset: no built-in theme {p:?} (built-ins: {})",
                    built_in_list()
                )
            })?;
            fresh(in_mode(t, mode)?)
        }
        (_, Some(Value::Null)) | (true, None) => fresh(in_mode(&BUILT_INS[0], mode)?),
        (_, Some(_)) => return Err("preset: expected a built-in theme's id".into()),
        (false, None) => {
            let t = current_theme(current);
            match mode {
                Some(m) if t.mode != m => fresh(in_mode(t, Some(m))?),
                _ => current.as_object().cloned().unwrap_or_default(),
            }
        }
    };
    let chart_groups = chart_theme::groups();
    match change.get(CHART_PRESET) {
        None => {}
        Some(Value::Null) => {
            out.remove(CHART_PRESET);
            for g in &chart_groups {
                out.remove(*g);
            }
        }
        Some(Value::String(p)) => {
            if chart_theme::preset(p).is_none() {
                return Err(format!(
                    "chartPreset: no chart look {p:?} (looks: {})",
                    chart_preset_list()
                ));
            }
            for g in &chart_groups {
                out.remove(*g);
            }
            if p == chart_theme::PRESETS[0].id {
                out.remove(CHART_PRESET);
            } else {
                out.insert(CHART_PRESET.into(), json!(p));
            }
        }
        Some(_) => return Err("chartPreset: expected a chart look's id".into()),
    }
    let groups = groups();
    for (field, v) in change {
        if [PRESET, RESET, MODE, CHART_PRESET].contains(&field.as_str()) {
            continue;
        }
        if field == FONTS_FIELD {
            merge_fonts(&mut out, v)?;
            continue;
        }
        if !groups.contains(&field.as_str()) {
            return Err(format!(
                "unknown field {field} (known: {})",
                known_fields_list()
            ));
        }
        merge_group(&mut out, field, v)?;
    }
    Ok(Value::Object(out))
}

fn merge_group(out: &mut Map<String, Value>, field: &str, v: &Value) -> Result<(), String> {
    match v {
        Value::Null => {
            out.remove(field);
            Ok(())
        }
        Value::Object(keys) => {
            let mut group = out
                .get(field)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (k, x) in keys {
                if color_key(&format!("{field}.{k}")).is_none() {
                    return Err(format!(
                        "{field}: unknown key {k} (known: {})",
                        known_keys(field)
                    ));
                }
                match x {
                    Value::Null => {
                        group.remove(k);
                    }
                    Value::String(s) => {
                        let c = parse_hex(s).ok_or_else(|| {
                            format!(
                                "{field}.{k}: {s:?} is not a colour (#rrggbb, or #rrggbbaa with alpha)"
                            )
                        })?;
                        group.insert(k.clone(), json!(c.hex()));
                    }
                    _ => {
                        return Err(format!(
                            "{field}.{k}: expected a colour such as \"#2fd3b4\", or null"
                        ));
                    }
                }
            }
            if group.is_empty() {
                out.remove(field);
            } else {
                out.insert(field.to_owned(), Value::Object(group));
            }
            Ok(())
        }
        _ => Err(format!("{field}: expected an object of colours, or null")),
    }
}

fn merge_fonts(out: &mut Map<String, Value>, v: &Value) -> Result<(), String> {
    match v {
        Value::Null => {
            out.remove(FONTS_FIELD);
            Ok(())
        }
        Value::Object(keys) => {
            let mut fonts = out
                .get(FONTS_FIELD)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (k, x) in keys {
                let Some(f) = FONTS.iter().find(|f| f.key == k) else {
                    return Err(format!("fonts: unknown key {k} (known: size, priceSize)"));
                };
                match x {
                    Value::Null => {
                        fonts.remove(k);
                    }
                    Value::Number(n) => {
                        let n = n.as_f64().unwrap_or(f64::NAN);
                        if !(n >= f.min && n <= f.max) {
                            return Err(format!(
                                "fonts.{k}: {n} is outside {}–{} px",
                                f.min, f.max
                            ));
                        }
                        fonts.insert(k.clone(), x.clone());
                    }
                    _ => return Err(format!("fonts.{k}: expected a number of px, or null")),
                }
            }
            if fonts.is_empty() {
                out.remove(FONTS_FIELD);
            } else {
                out.insert(FONTS_FIELD.into(), Value::Object(fonts));
            }
            Ok(())
        }
        _ => Err("fonts: expected {\"size\": px, \"priceSize\": px}, or null".into()),
    }
}

pub fn known_fields(value: &Value) -> Value {
    let Some(m) = value.as_object() else {
        return value.clone();
    };
    let groups = groups();
    let mut out = Map::new();
    for (f, v) in m {
        if groups.contains(&f.as_str()) {
            let Some(keys) = v.as_object() else { continue };
            let kept: Map<String, Value> = keys
                .iter()
                .filter(|(k, _)| color_key(&format!("{f}.{k}")).is_some())
                .map(|(k, x)| (k.clone(), x.clone()))
                .collect();
            if !kept.is_empty() {
                out.insert(f.clone(), Value::Object(kept));
            }
        } else if [PRESET, CHART_PRESET, FONTS_FIELD, SAVED].contains(&f.as_str()) {
            out.insert(f.clone(), v.clone());
        }
    }
    Value::Object(out)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Unreadable {
    pub fg: String,
    pub fg_hex: String,
    pub bg: String,
    pub bg_hex: String,
    pub ratio: f64,
    pub needs: f64,
}

impl Unreadable {
    fn words(&self) -> String {
        format!(
            "{} {} on {} {} ({:.1}:1)",
            self.fg, self.fg_hex, self.bg, self.bg_hex, self.ratio
        )
    }
}

const TEXT_KEYS: &[&str] = &["ink.t1", "ink.t2", "ink.t3", "ink.t4"];
const TEXT_SURFACES: &[&str] = &[
    "surfaces.ground",
    "surfaces.panel",
    "surfaces.raise",
    "surfaces.menu",
];
const BRAND_PAIRS: &[(&str, &str)] = &[
    ("ink.t1", "surfaces.selection"),
    ("ink.t1", "surfaces.hover"),
    ("accents.onDeep", "accents.deep"),
    ("accents.onDeep", "accents.teal"),
];

pub fn unreadable(r: &Resolved) -> (Vec<Unreadable>, Vec<Unreadable>) {
    let ground = r.color("surfaces.ground");
    let opaque = |c: Rgba| match ground {
        Some(g) if c.3 < 255 => c.over(Rgba(g.0, g.1, g.2, 255)),
        _ => c,
    };
    let mut text = Vec::new();
    let measure = |fg: &str, bg: &str, needs: f64, out: &mut Vec<Unreadable>| {
        let (Some(f), Some(b)) = (r.color(fg), r.color(bg)) else {
            return;
        };
        let b = opaque(b);
        let ratio = wcag_contrast_ratio(f, b);
        if ratio < needs {
            out.push(Unreadable {
                fg: fg.to_owned(),
                fg_hex: f.hex(),
                bg: bg.to_owned(),
                bg_hex: b.hex(),
                ratio,
                needs,
            });
        }
    };
    for fg in TEXT_KEYS {
        for bg in TEXT_SURFACES {
            measure(fg, bg, MIN_TEXT_CONTRAST, &mut text);
        }
    }
    for (fg, bg) in BRAND_PAIRS {
        measure(fg, bg, MIN_TEXT_CONTRAST, &mut text);
    }
    let mut orders = Vec::new();
    for k in ORDER_KEYS {
        measure(
            k,
            "palette.background",
            chart_theme::MIN_ORDER_CONTRAST,
            &mut orders,
        );
    }
    (text, orders)
}

fn colours_parse(value: &Value) -> Result<(), String> {
    for g in groups() {
        if let Some(Value::Object(m)) = value.get(g) {
            for (k, v) in m {
                if v.as_str().and_then(parse_hex).is_none() {
                    return Err(format!(
                        "{g}.{k}: {v} is not a colour (#rrggbb or #rrggbbaa)"
                    ));
                }
            }
        }
    }
    Ok(())
}

pub fn check(value: &Value, up_down: &str) -> Result<(), String> {
    colours_parse(value)?;
    let r = resolve(value, up_down);
    let (text, orders) = unreadable(&r);
    let mut out = Vec::new();
    if !orders.is_empty() {
        out.push(format!(
            "unreadable order colours on the background {}: {}. Orders must keep at least {}:1 against the \
             background so a stop, a target or a position never disappears; change those colours in the same \
             change (e.g. {{\"orders\": {{\"stop\": \"#…\"}}}}) or pick another background",
            orders[0].bg_hex,
            orders
                .iter()
                .map(|u| format!("{} {} ({:.1}:1)", u.fg, u.fg_hex, u.ratio))
                .collect::<Vec<_>>()
                .join(", "),
            chart_theme::MIN_ORDER_CONTRAST
        ));
    }
    if !text.is_empty() {
        out.push(format!(
            "unreadable text: {}. Text must keep at least {MIN_TEXT_CONTRAST}:1 on every surface it sits on; \
             change those colours in the same change, or start from a built-in theme (preset: {})",
            text.iter()
                .map(Unreadable::words)
                .collect::<Vec<_>>()
                .join(", "),
            built_in_list()
        ));
    }
    if out.is_empty() {
        Ok(())
    } else {
        Err(out.join("; "))
    }
}

fn color_group_schema(group: &str, tessera: &Resolved) -> Value {
    let mut keys = Map::new();
    for k in all_colors().filter(|k| k.group == group) {
        let mut s = json!({"type": "string", "description": format!("{}: {}", k.label, k.about)});
        if let Some(c) = tessera.color(&k.path()) {
            s["default"] = json!(c.hex());
        }
        keys.insert(k.key.into(), s);
    }
    json!({"type": "object", "additionalProperties": false, "properties": keys})
}

fn fonts_schema() -> Value {
    let mut fonts = Map::new();
    for f in FONTS {
        fonts.insert(
            f.key.into(),
            json!({"type": "number", "minimum": f.min, "maximum": f.max, "default": f.default,
                "description": format!("{}: {}", f.label, f.about)}),
        );
    }
    json!({"type": "object", "additionalProperties": false, "properties": fonts})
}

fn value_properties() -> Map<String, Value> {
    let tessera = resolve(&json!({}), "tessera");
    let mut props = Map::new();
    props.insert(
        PRESET.into(),
        json!({"type": "string", "enum": BUILT_INS.iter().map(|t| t.id).collect::<Vec<_>>(),
            "description": "The built-in theme everything starts from; setting it drops your own colours."}),
    );
    props.insert(
        CHART_PRESET.into(),
        json!({"type": "string", "enum": chart_theme::PRESETS.iter().map(|p| p.id).collect::<Vec<_>>(),
            "description": "A chart look over the theme (tessera: the theme's own chart); setting it drops your own chart colours."}),
    );
    for g in groups() {
        props.insert(g.into(), color_group_schema(g, &tessera));
    }
    props.insert(FONTS_FIELD.into(), fonts_schema());
    props
}

pub fn theme_value_schema() -> Value {
    json!({"type": "object", "additionalProperties": false, "properties": value_properties()})
}

pub fn schema() -> Value {
    let mut props = value_properties();
    props.insert(
        SAVED.into(),
        json!({"type": "string", "minLength": 1, "maxLength": 64,
            "description": "A saved theme (appearance.themes) to show; changes then save into it."}),
    );
    props.insert(
        RESET.into(),
        json!({"type": "boolean", "description": "true: back to Tessera (only in a change, never stored)."}),
    );
    props.insert(
        MODE.into(),
        json!({"type": "string", "enum": ["dark", "light"],
            "description": "In a change: the same built-in in that mode (solarized-dark ↔ solarized-light); never stored, a theme's mode follows its colours."}),
    );
    json!({"type": "object", "additionalProperties": false, "properties": props})
}

pub fn saved_schema() -> Value {
    let item = json!({"type": "object", "additionalProperties": false, "required": ["id", "name", "theme"],
    "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": 64},
        "name": {"type": "string", "minLength": 1, "maxLength": NAME_MAX},
        "theme": theme_value_schema(),
    }});
    json!({"type": "object", "additionalProperties": false, "properties": {
        "themes": {"type": "array", "maxItems": SAVED_MAX, "items": item},
    }})
}

const APPEARANCE: &str = "appearance";
const APPEARANCES: [&str; 3] = ["light", "dark", "system"];
const MODES: [ThemeMode; 2] = [ThemeMode::Dark, ThemeMode::Light];

fn kept_theme_schema() -> Value {
    let mut props = value_properties();
    props.insert(
        SAVED.into(),
        json!({"type": "string", "minLength": 1, "maxLength": 64,
            "description": "A saved theme (appearance.themes) kept for this mode."}),
    );
    json!({"type": "object", "additionalProperties": false, "properties": props})
}

pub fn scheme_schema() -> Value {
    let kept = |mode: &str| {
        let mut s = kept_theme_schema();
        s["description"] = json!(format!(
            "The theme shown in {mode} mode, stored as appearance.theme stores one; Tessera's own {mode} built-in when unset."
        ));
        s
    };
    json!({"type": "object", "additionalProperties": false, "properties": {
        APPEARANCE: {"type": "string", "enum": APPEARANCES,
            "description": "light or dark: the app stays in that mode. system: it follows the computer's light or dark mode, live."},
        "dark": kept("dark"),
        "light": kept("light"),
    }})
}

pub fn known_scheme(value: &Value) -> Value {
    let Some(m) = value.as_object() else {
        return value.clone();
    };
    let mut out = Map::new();
    if let Some(a) = m.get(APPEARANCE) {
        out.insert(APPEARANCE.into(), a.clone());
    }
    for mode in MODES {
        if let Some(t) = m.get(mode.as_str()) {
            out.insert(mode.as_str().into(), known_fields(t));
        }
    }
    Value::Object(out)
}

pub fn check_scheme(value: &Value, saved: &Value, up_down: &str) -> Result<(), String> {
    let list = read_saved(saved);
    for mode in MODES {
        let Some(kept) = value.get(mode.as_str()) else {
            continue;
        };
        let link = kept.get(SAVED).and_then(Value::as_str);
        if link.is_some() && linked(kept, &list).is_none() {
            return Err(format!(
                "{}: saved: no saved theme {:?} ({})",
                mode.as_str(),
                link.unwrap_or_default(),
                saved_names(&list)
            ));
        }
        let (theme, _) = effective(kept, saved);
        colours_parse(&theme).map_err(|e| format!("{}: {e}", mode.as_str()))?;
        let r = resolve(&theme, up_down);
        if r.mode != mode {
            return Err(format!(
                "{}: {} is a {} theme; {} themes: {}",
                mode.as_str(),
                link.map_or(r.theme.label, |_| "that saved theme"),
                r.mode.as_str(),
                mode.as_str(),
                BUILT_INS
                    .iter()
                    .filter(|b| b.mode == mode)
                    .map(|b| format!("{} ({})", b.label, b.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        check(&theme, up_down).map_err(|e| format!("{}: {e}", mode.as_str()))?;
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedTheme {
    /// Its id (`saved`).
    pub id: String,
    /// The name the trader gave it.
    pub name: String,
    /// Its colours: the built-in it starts from (`preset`), a chart look (`chartPreset`), its own colours
    /// by group, and the chart's text sizes (`fonts`).
    pub theme: Value,
}

pub fn read_saved(value: &Value) -> Vec<SavedTheme> {
    value
        .get("themes")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|r| serde_json::from_value::<SavedTheme>(r.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn write_saved(list: &[SavedTheme]) -> Value {
    json!({"themes": list})
}

pub fn known_saved(value: &Value) -> Value {
    let list: Vec<SavedTheme> = read_saved(value)
        .into_iter()
        .map(|t| SavedTheme {
            theme: known_fields(&t.theme),
            ..t
        })
        .collect();
    write_saved(&list)
}

pub fn check_saved(value: &Value, up_down: &str) -> Result<(), String> {
    let list = read_saved(value);
    let mut ids = BTreeSet::new();
    for t in &list {
        if !ids.insert(t.id.as_str()) {
            return Err(format!("themes: the id {} is used twice", t.id));
        }
        check(&t.theme, up_down).map_err(|e| format!("{}: {e}", t.name))?;
    }
    Ok(())
}

fn find<'a>(list: &'a [SavedTheme], key: &str) -> Option<&'a SavedTheme> {
    list.iter().find(|t| t.id == key).or_else(|| {
        list.iter()
            .find(|t| t.name.trim().eq_ignore_ascii_case(key.trim()))
    })
}

fn saved_names(list: &[SavedTheme]) -> String {
    if list.is_empty() {
        return "none saved yet".into();
    }
    list.iter()
        .map(|t| format!("{} ({})", t.name, t.id))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn linked<'a>(active: &Value, list: &'a [SavedTheme]) -> Option<&'a SavedTheme> {
    let id = active.get(SAVED).and_then(Value::as_str)?;
    list.iter().find(|t| t.id == id)
}

fn own_value(active: &Value) -> Value {
    let mut v = active.as_object().cloned().unwrap_or_default();
    v.remove(SAVED);
    Value::Object(v)
}

pub fn effective(active: &Value, saved: &Value) -> (Value, Option<SavedTheme>) {
    let list = read_saved(saved);
    match linked(active, &list) {
        Some(t) => (t.theme.clone(), Some(t.clone())),
        None => (own_value(active), None),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub active: Option<Value>,
    pub saved: Option<Value>,
}

fn replaced(list: &[SavedTheme], id: &str, theme: Value) -> Value {
    let list: Vec<SavedTheme> = list
        .iter()
        .map(|t| {
            if t.id == id {
                SavedTheme {
                    theme: theme.clone(),
                    ..t.clone()
                }
            } else {
                t.clone()
            }
        })
        .collect();
    write_saved(&list)
}

pub fn plan(active: &Value, saved: &Value, change: &Value) -> Result<Plan, String> {
    let list = read_saved(saved);
    let Some(change) = change.as_object() else {
        return patch(&json!({}), change).map(|_| Plan::default());
    };
    let mut rest = change.clone();
    let pick = rest.remove(SAVED);
    let starts = [PRESET, RESET, MODE].iter().any(|f| rest.contains_key(*f));
    let rest = Value::Object(rest);
    let link = linked(active, &list);
    match pick {
        Some(Value::String(key)) => {
            let t = find(&list, &key)
                .ok_or_else(|| format!("saved: no saved theme {key:?} ({})", saved_names(&list)))?;
            let active = Some(json!({SAVED: t.id}));
            if rest.as_object().is_some_and(Map::is_empty) {
                return Ok(Plan {
                    active,
                    saved: None,
                });
            }
            let theme = patch(&t.theme, &rest)?;
            Ok(Plan {
                active,
                saved: Some(replaced(&list, &t.id, theme)),
            })
        }
        Some(Value::Null) => {
            let base = link.map_or_else(|| own_value(active), |t| t.theme.clone());
            Ok(Plan {
                active: Some(patch(&base, &rest)?),
                saved: None,
            })
        }
        Some(_) => Err("saved: expected a saved theme's id or name, or null".into()),
        None => match link {
            Some(t) if !starts => Ok(Plan {
                active: None,
                saved: Some(replaced(&list, &t.id, patch(&t.theme, &rest)?)),
            }),
            _ => {
                let base = link.map_or_else(|| own_value(active), |t| t.theme.clone());
                Ok(Plan {
                    active: Some(patch(&base, &rest)?),
                    saved: None,
                })
            }
        },
    }
}

pub fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("a theme needs a name".into());
    }
    if n.chars().count() > NAME_MAX {
        return Err(format!("a theme name has at most {NAME_MAX} characters"));
    }
    Ok(n.to_owned())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Saved {
    pub saved: Value,
    pub theme: SavedTheme,
    pub replaced: bool,
}

pub fn save(saved: &Value, name: &str, theme: &Value) -> Result<Saved, String> {
    let name = clean_name(name)?;
    let theme = known_fields(&own_value(theme));
    let mut list = read_saved(saved);
    if let Some(i) = list.iter().position(|t| t.name.eq_ignore_ascii_case(&name)) {
        list[i].theme = theme;
        let t = list[i].clone();
        return Ok(Saved {
            saved: write_saved(&list),
            theme: t,
            replaced: true,
        });
    }
    if list.len() >= SAVED_MAX {
        return Err(format!(
            "{SAVED_MAX} themes are saved already; delete one first"
        ));
    }
    let t = SavedTheme {
        id: unique("th_"),
        name,
        theme,
    };
    list.push(t.clone());
    Ok(Saved {
        saved: write_saved(&list),
        theme: t,
        replaced: false,
    })
}

pub fn rename(saved: &Value, key: &str, name: &str) -> Result<(Value, SavedTheme), String> {
    let name = clean_name(name)?;
    let mut list = read_saved(saved);
    let id = find(&list, key)
        .ok_or_else(|| format!("no saved theme {key:?} ({})", saved_names(&list)))?
        .id
        .clone();
    if list
        .iter()
        .any(|t| t.id != id && t.name.eq_ignore_ascii_case(&name))
    {
        return Err(format!("a theme named {name} is saved already"));
    }
    let i = list.iter().position(|t| t.id == id).unwrap_or_default();
    list[i].name = name;
    let t = list[i].clone();
    Ok((write_saved(&list), t))
}

pub fn remove(saved: &Value, key: &str) -> Result<(Value, SavedTheme), String> {
    let list = read_saved(saved);
    let t = find(&list, key)
        .ok_or_else(|| format!("no saved theme {key:?} ({})", saved_names(&list)))?
        .clone();
    let kept: Vec<SavedTheme> = list.into_iter().filter(|x| x.id != t.id).collect();
    Ok((write_saved(&kept), t))
}

pub fn source(active: &Value, saved: &Value, from: Option<&str>) -> Result<Value, String> {
    let Some(key) = from else {
        return Ok(effective(active, saved).0);
    };
    let list = read_saved(saved);
    if let Some(t) = find(&list, key) {
        return Ok(t.theme.clone());
    }
    if let Some(b) = built_in(key) {
        return Ok(Value::Object(fresh(b)));
    }
    Err(format!(
        "from: no saved or built-in theme {key:?} (built-ins: {}; saved: {})",
        built_in_list(),
        saved_names(&list)
    ))
}

pub fn read_import(v: &Value) -> Result<(Option<String>, Value), String> {
    let (name, theme) = match v.get("theme") {
        Some(t) if t.is_object() => (
            v.get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_owned),
            t,
        ),
        _ => (None, v),
    };
    let Some(m) = theme.as_object() else {
        return Err("theme: expected a theme object, as Export writes it".into());
    };
    let mut clean = m.clone();
    for f in [SAVED, RESET, MODE, "format", "name"] {
        clean.remove(f);
    }
    Ok((name, patch(&json!({}), &Value::Object(clean))?))
}

/// `appearance.get_theme` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeGetInput {}

/// A built-in theme, as the tools list it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeBuiltInInfo {
    /// Its id (`preset`).
    pub id: String,
    /// Its name.
    pub label: String,
    /// dark or light.
    pub mode: ThemeMode,
    /// Its family: the built-ins of one family are one theme in its two modes.
    pub family: String,
    /// One line on it.
    pub about: String,
}

/// A saved theme, as the tools list it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSavedInfo {
    /// Its id (`saved`).
    pub id: String,
    /// Its name.
    pub name: String,
    /// dark or light, from its colours.
    pub mode: ThemeMode,
    /// The built-in it starts from.
    pub preset: String,
}

/// `appearance.get_theme` output: the theme the whole app draws with now, app and charts alike.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeOutput {
    /// The built-in it starts from.
    pub preset: String,
    /// The saved theme it shows (its changes save into it), if any.
    pub saved: Option<ThemeSavedInfo>,
    /// dark or light, from its ground and text.
    pub mode: ThemeMode,
    /// The chart look over it (tessera: the theme's own chart).
    pub chart_preset: String,
    /// Every colour key (`group.key`: the app's surfaces, ink, lines, accents, semantics, card and
    /// categorical groups, then the chart's) and the colour it draws in (`#rrggbb[aa]`), null where the
    /// chart picks.
    pub colors: BTreeMap<String, Option<String>>,
    /// The keys set over the built-in (the theme's own colours).
    pub overridden: Vec<String>,
    /// `fonts.size` and `fonts.priceSize` in px.
    pub fonts: BTreeMap<String, f64>,
    /// The built-in themes, always there and read-only.
    pub built_ins: Vec<ThemeBuiltInInfo>,
    /// The themes the trader saved.
    pub saved_themes: Vec<ThemeSavedInfo>,
    /// The chart looks `chartPreset` may name.
    pub chart_presets: Vec<ChartThemePresetInfo>,
    /// The theme's own value: what Export writes and appearance.save_theme's `theme` takes.
    pub value: Value,
}

fn saved_info(t: &SavedTheme, up_down: &str) -> ThemeSavedInfo {
    let r = resolve(&t.theme, up_down);
    ThemeSavedInfo {
        id: t.id.clone(),
        name: t.name.clone(),
        mode: r.mode,
        preset: r.theme.id.to_owned(),
    }
}

pub fn output(active: &Value, saved: &Value, up_down: &str) -> ThemeOutput {
    let (value, link) = effective(active, saved);
    let r = resolve(&value, up_down);
    let list = read_saved(saved);
    ThemeOutput {
        preset: r.theme.id.to_owned(),
        saved: link.as_ref().map(|t| saved_info(t, up_down)),
        mode: r.mode,
        chart_preset: r.chart_preset.id.to_owned(),
        overridden: all_colors()
            .map(ThemeColor::path)
            .filter(|k| r.overridden.contains(k))
            .collect(),
        colors: r
            .colors
            .into_iter()
            .map(|(k, v)| (k, v.map(Rgba::hex)))
            .collect(),
        fonts: r.fonts,
        built_ins: BUILT_INS
            .iter()
            .map(|t| ThemeBuiltInInfo {
                id: t.id.into(),
                label: t.label.into(),
                mode: t.mode,
                family: t.family.into(),
                about: t.about.into(),
            })
            .collect(),
        saved_themes: list.iter().map(|t| saved_info(t, up_down)).collect(),
        chart_presets: chart_theme::presets_info(),
        value,
    }
}

/// `appearance.save_theme` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeSaveInput {
    /// Its name. A saved theme of the same name is replaced.
    pub name: String,
    /// What to save: a saved theme's id or name, or a built-in's id. Default: the theme shown now.
    #[serde(default)]
    #[ts(optional)]
    pub from: Option<String>,
    /// A theme as Export writes it (`{"name", "theme"}`, or the theme object alone), to import.
    #[serde(default)]
    #[ts(optional)]
    pub theme: Option<Value>,
}

/// `appearance.rename_theme` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeRenameInput {
    /// The saved theme's id or name.
    pub id: String,
    /// Its new name.
    pub name: String,
}

/// `appearance.delete_theme` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeDeleteInput {
    /// The saved theme's id or name.
    pub id: String,
}

/// A saved theme after it was saved, renamed or deleted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSavedOutput {
    /// Its id.
    pub id: String,
    /// Its name.
    pub name: String,
    /// true when a saved theme of that name was replaced.
    pub replaced: bool,
    /// The theme the app draws with now.
    pub theme: ThemeOutput,
}

pub fn tables_json() -> Value {
    let rule = |r: Rule| match r {
        Rule::Lit(h) => json!({"lit": h}),
        Rule::From(src, a) => json!({"from": src, "alpha": a}),
        Rule::Unset => json!({}),
    };
    let row = |k: &ThemeColor| json!({"group": k.group, "key": k.key, "label": k.label, "about": k.about, "rule": rule(k.rule)});
    json!({
        "shell": SHELL.iter().map(row).collect::<Vec<_>>(),
        "colors": COLORS.iter().map(row).collect::<Vec<_>>(),
        "fonts": FONTS.iter().map(|f| json!({
            "key": f.key, "label": f.label, "about": f.about, "default": f.default, "min": f.min, "max": f.max,
        })).collect::<Vec<_>>(),
        "builtIns": BUILT_INS.iter().map(|t| json!({
            "id": t.id, "label": t.label, "family": t.family, "mode": t.mode.as_str(), "about": t.about,
            "colors": t.colors.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect::<Map<_, _>>(),
        })).collect::<Vec<_>>(),
        "presets": chart_theme::PRESETS.iter().map(|p| json!({
            "id": p.id, "label": p.label, "about": p.about,
            "colors": p.colors.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect::<Map<_, _>>(),
        })).collect::<Vec<_>>(),
        "upDownPairs": chart_theme::UP_DOWN_PAIRS.iter()
            .map(|(id, up, down)| ((*id).to_owned(), json!({"up": up, "down": down})))
            .collect::<Map<_, _>>(),
        "orderKeys": ORDER_KEYS,
        "minOrderContrast": chart_theme::MIN_ORDER_CONTRAST,
        "textKeys": TEXT_KEYS,
        "textSurfaces": TEXT_SURFACES,
        "brandPairs": BRAND_PAIRS.iter().map(|(f, b)| json!([f, b])).collect::<Vec<_>>(),
        "minTextContrast": MIN_TEXT_CONTRAST,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(r: &Resolved, k: &str) -> Option<String> {
        r.colors[k].map(Rgba::hex)
    }

    #[test]
    fn every_rule_names_a_key_listed_before_it_and_every_built_in_a_real_key() {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for k in all_colors() {
            if let Rule::From(src, a) = k.rule {
                assert!(
                    seen.contains(src),
                    "{} derives from {src}, not listed before it",
                    k.path()
                );
                assert!((0.0..=1.0).contains(&a), "{}", k.path());
            }
            if let Rule::Lit(h) = k.rule {
                assert!(parse_hex(h).is_some(), "{}", k.path());
            }
            assert!(seen.insert(k.path()), "{} twice", k.path());
        }
        for t in BUILT_INS {
            for (k, v) in t.colors {
                assert!(color_key(k).is_some(), "{}: unknown key {k}", t.id);
                assert!(parse_hex(v).is_some(), "{}: {k} {v}", t.id);
            }
        }
        let shell = shell_groups();
        for g in chart_theme::groups() {
            assert!(!shell.contains(&g), "{g} is both a shell and a chart group");
        }
    }

    #[test]
    fn tessera_is_the_default_and_keeps_the_375_palette() {
        let r = resolve(&json!({}), "tessera");
        assert_eq!(r.theme.id, "tessera");
        assert_eq!(r.mode, ThemeMode::Dark);
        for (k, v) in [
            ("surfaces.ground", "#05080b"),
            ("surfaces.panel", "#0b1116"),
            ("surfaces.raise", "#0d1319"),
            ("surfaces.selection", "#073f4f"),
            ("lines.hairline", "#1b2730"),
            ("accents.teal", "#0071a9"),
            ("accents.aqua", "#8ed1fc"),
            ("accents.deep", "#073f4f"),
            ("ink.t1", "#e8eef3"),
            ("ink.t2", "#aebcc8"),
            ("ink.t3", "#7c8b99"),
            ("ink.t4", "#7c8b99"),
            ("semantics.up", "#2fd3b4"),
            ("semantics.down", "#e0523f"),
            ("semantics.agent", "#8ed1fc"),
            ("semantics.hazard", "#d8b26a"),
            ("semantics.active", "#d8b26a"),
            ("palette.background", "#05080b"),
            ("palette.text", "#e8eef3"),
            ("palette.subtle", "#aebcc8"),
            ("palette.muted", "#7c8b99"),
            ("palette.mist", "#e8eef3"),
            ("palette.analyst", "#8ed1fc"),
            ("canvas.border", "#1b2730"),
            ("crosshair.label", "#0d1319"),
            ("surfaces.scrim", "#05080bb3"),
            ("lines.line2", "#e8eef31f"),
        ] {
            assert_eq!(hex(&r, k).as_deref(), Some(v), "{k}");
        }
        assert!(r.explicit.is_empty());
        let jade = resolve(&json!({}), "jade_coral");
        assert_eq!(hex(&jade, "semantics.up").as_deref(), Some("#5fc79c"));
        assert_eq!(hex(&jade, "candles.downBody").as_deref(), Some("#ec7b78"));
    }

    #[test]
    fn the_whole_app_follows_one_colour_unless_the_chart_sets_its_own() {
        let v = patch(&json!({}), &json!({"surfaces": {"ground": "#101418"}})).unwrap();
        let r = resolve(&v, "tessera");
        assert_eq!(hex(&r, "palette.background").as_deref(), Some("#101418"));
        let v = patch(&v, &json!({"palette": {"background": "#000000"}})).unwrap();
        let r = resolve(&v, "tessera");
        assert_eq!(hex(&r, "surfaces.ground").as_deref(), Some("#101418"));
        assert_eq!(hex(&r, "palette.background").as_deref(), Some("#000000"));
        let v = patch(&v, &json!({"chartPreset": "classic"})).unwrap();
        assert_eq!(
            v,
            json!({"surfaces": {"ground": "#101418"}, "chartPreset": "classic"})
        );
        let r = resolve(&v, "tessera");
        assert_eq!(hex(&r, "palette.background").as_deref(), Some("#131722"));
        assert_eq!(hex(&r, "palette.analyst").as_deref(), Some("#8ed1fc"));
    }

    #[test]
    fn every_built_in_reads_under_both_pairs_and_its_mode_is_its_colours() {
        let mut ids = BTreeSet::new();
        for t in BUILT_INS {
            assert!(ids.insert(t.id), "{} twice", t.id);
            for (pair, _, _) in chart_theme::UP_DOWN_PAIRS {
                let v = patch(&json!({}), &json!({"preset": t.id})).unwrap();
                check(&v, pair).unwrap_or_else(|e| panic!("{} {pair}: {e}", t.id));
                let r = resolve(&v, pair);
                assert_eq!(r.mode, t.mode, "{}", t.id);
                assert_eq!(r.theme.id, t.id);
                let ground = r.color("surfaces.ground").unwrap();
                for k in [
                    "semantics.up",
                    "semantics.down",
                    "semantics.agent",
                    "semantics.hazard",
                ] {
                    for s in ["surfaces.ground", "surfaces.panel", "surfaces.raise"] {
                        let ratio = wcag_contrast_ratio(r.color(k).unwrap(), r.color(s).unwrap());
                        assert!(ratio >= 3.0, "{} {k} on {s} {ratio:.2}", t.id);
                    }
                }
                let own_chart_ground = t.colors.iter().find(|(k, _)| *k == "palette.background");
                let chart_ground = own_chart_ground.map_or(Some(ground), |(_, hex)| parse_hex(hex));
                assert_eq!(r.color("palette.background"), chart_ground, "{}", t.id);
            }
        }
        let families: BTreeSet<&str> = BUILT_INS.iter().map(|t| t.family).collect();
        assert_eq!(families.len(), 5);
        for f in ["tessera", "solarized", "gruvbox"] {
            let modes: BTreeSet<&str> = BUILT_INS
                .iter()
                .filter(|t| t.family == f)
                .map(|t| t.mode.as_str())
                .collect();
            assert_eq!(modes.len(), 2, "{f}");
        }
    }

    #[test]
    fn a_preset_starts_clean_mode_moves_within_a_family_and_reset_is_tessera() {
        let mine = json!({"ink": {"t1": "#ffffff"}, "chartPreset": "classic"});
        assert_eq!(
            patch(&mine, &json!({"preset": "solarized-dark"})).unwrap(),
            json!({"preset": "solarized-dark"})
        );
        assert_eq!(
            patch(
                &json!({"preset": "solarized-dark"}),
                &json!({"mode": "light"})
            )
            .unwrap(),
            json!({"preset": "solarized-light"})
        );
        assert_eq!(
            patch(
                &json!({}),
                &json!({"preset": "gruvbox-dark", "mode": "light"})
            )
            .unwrap(),
            json!({"preset": "gruvbox-light"})
        );
        let same = json!({"preset": "solarized-light", "ink": {"t2": "#333333"}});
        assert_eq!(patch(&same, &json!({"mode": "light"})).unwrap(), same);
        assert_eq!(
            patch(&json!({}), &json!({"mode": "light"})).unwrap(),
            json!({"preset": "tessera-light"})
        );
        assert_eq!(
            patch(
                &json!({"preset": "tessera-light"}),
                &json!({"mode": "dark"})
            )
            .unwrap(),
            json!({})
        );
        let e = patch(&json!({"preset": "nord"}), &json!({"mode": "light"})).unwrap_err();
        assert!(
            e.contains("Nord has no light version") && e.contains("tessera-light"),
            "{e}"
        );
        assert_eq!(patch(&mine, &json!({"reset": true})).unwrap(), json!({}));
        assert_eq!(
            patch(&mine, &json!({"preset": "tessera"})).unwrap(),
            json!({})
        );
    }

    #[test]
    fn wrong_fields_keys_and_colours_are_refused_with_the_right_ones() {
        let e = patch(&json!({}), &json!({"surface": {}})).unwrap_err();
        assert!(
            e.contains("unknown field surface") && e.contains("surfaces"),
            "{e}"
        );
        let e = patch(&json!({}), &json!({"ink": {"t5": "#fff"}})).unwrap_err();
        assert!(e.contains("t1, t2, t3, t4"), "{e}");
        let e = patch(&json!({}), &json!({"surfaces": {"ground": "black"}})).unwrap_err();
        assert!(e.contains("not a colour"), "{e}");
        let e = patch(&json!({}), &json!({"preset": "dracula"})).unwrap_err();
        assert!(
            e.contains("night-owl") && e.contains("gruvbox-light"),
            "{e}"
        );
        let e = patch(&json!({}), &json!({"chartPreset": "neon"})).unwrap_err();
        assert!(e.contains("graphite"), "{e}");
        let e = patch(&json!({}), &json!({"mode": "dim"})).unwrap_err();
        assert!(e.contains("dark or light"), "{e}");
    }

    #[test]
    fn an_unreadable_pair_is_refused_with_both_colours_named() {
        let v = patch(&json!({}), &json!({"surfaces": {"raise": "#7c8b99"}})).unwrap();
        let e = check(&v, "tessera").unwrap_err();
        assert!(
            e.contains("ink.t3 #7c8b99 on surfaces.raise #7c8b99 (1.0:1)"),
            "{e}"
        );
        assert!(e.contains("4.5:1"), "{e}");
        let v = patch(
            &json!({"preset": "solarized-light"}),
            &json!({"accents": {"onDeep": "#073642"}}),
        )
        .unwrap();
        let e = check(&v, "tessera").unwrap_err();
        assert!(e.contains("accents.onDeep #073642 on accents.deep"), "{e}");
        let v = patch(&json!({}), &json!({"palette": {"background": "#ffffff"}})).unwrap();
        let e = check(&v, "tessera").unwrap_err();
        assert!(
            e.contains("unreadable order colours") && e.contains("orders.target"),
            "{e}"
        );
        let light_by_hand = patch(
            &json!({}),
            &json!({
                "surfaces": {"ground": "#ffffff", "panel": "#f4f6f8", "raise": "#eceff2", "selection": "#dbe8f0"},
                "ink": {"t1": "#101418", "t2": "#3a444d", "t3": "#55606a"},
                "accents": {"teal": "#005f8f", "aqua": "#00639a"},
                "semantics": {"up": "#0b7a6a", "down": "#b3261e", "hazard": "#7a5f27"},
            }),
        )
        .unwrap();
        check(&light_by_hand, "tessera").unwrap();
        assert_eq!(resolve(&light_by_hand, "tessera").mode, ThemeMode::Light);
    }

    #[test]
    fn a_saved_theme_takes_the_changes_while_it_is_shown() {
        let s = save(&json!({}), "Night Desk", &json!({"preset": "nord"})).unwrap();
        assert!(!s.replaced);
        let id = s.theme.id.clone();
        let active = json!({"saved": id});
        let (value, link) = effective(&active, &s.saved);
        assert_eq!(value, json!({"preset": "nord"}));
        assert_eq!(link.unwrap().name, "Night Desk");

        let p = plan(
            &active,
            &s.saved,
            &json!({"surfaces": {"ground": "#20242c"}}),
        )
        .unwrap();
        assert_eq!(p.active, None);
        let saved = p.saved.unwrap();
        assert_eq!(
            read_saved(&saved)[0].theme,
            json!({"preset": "nord", "surfaces": {"ground": "#20242c"}})
        );

        let p = plan(&active, &saved, &json!({"preset": "solarized-light"})).unwrap();
        assert_eq!(p.active, Some(json!({"preset": "solarized-light"})));
        assert_eq!(p.saved, None);

        let p = plan(&json!({}), &saved, &json!({"saved": "night desk"})).unwrap();
        assert_eq!(p.active, Some(json!({"saved": id})));

        let p = plan(&active, &saved, &json!({"saved": null})).unwrap();
        assert_eq!(
            p.active,
            Some(json!({"preset": "nord", "surfaces": {"ground": "#20242c"}}))
        );

        let e = plan(&json!({}), &saved, &json!({"saved": "Day Desk"})).unwrap_err();
        assert!(e.contains("Night Desk"), "{e}");

        let again = save(&saved, "night desk", &json!({"preset": "gruvbox-dark"})).unwrap();
        assert!(again.replaced);
        assert_eq!(again.theme.id, id);
        assert_eq!(read_saved(&again.saved).len(), 1);

        let (renamed, t) = rename(&again.saved, &id, "Day Desk").unwrap();
        assert_eq!(t.name, "Day Desk");
        let (gone, t) = remove(&renamed, "Day Desk").unwrap();
        assert_eq!(t.id, id);
        assert!(read_saved(&gone).is_empty());
    }

    #[test]
    fn an_exported_theme_imports_as_it_was() {
        let theme =
            json!({"preset": "night-owl", "semantics": {"up": "#00FF00"}, "fonts": {"size": 13}});
        let (name, v) =
            read_import(&json!({"format": "tessera-theme", "name": "Owl", "theme": theme}))
                .unwrap();
        assert_eq!(name.as_deref(), Some("Owl"));
        assert_eq!(
            v,
            json!({"preset": "night-owl", "semantics": {"up": "#00ff00"}, "fonts": {"size": 13}})
        );
        let (name, v) = read_import(&json!({"preset": "nord"})).unwrap();
        assert_eq!((name, v), (None, json!({"preset": "nord"})));
        assert!(read_import(&json!({"theme": {"palette": {"up": "red"}}})).is_err());
    }

    #[test]
    fn the_read_tool_lists_built_ins_first_then_saved_themes() {
        let s = save(&json!({}), "Mine", &json!({"preset": "gruvbox-light"})).unwrap();
        let o = output(&json!({"saved": s.theme.id}), &s.saved, "tessera");
        assert_eq!(o.preset, "gruvbox-light");
        assert_eq!(o.mode, ThemeMode::Light);
        assert_eq!(o.saved.as_ref().map(|x| x.name.as_str()), Some("Mine"));
        assert_eq!(o.built_ins.len(), BUILT_INS.len());
        assert_eq!(o.built_ins[0].id, "tessera");
        assert_eq!(o.saved_themes.len(), 1);
        assert_eq!(o.colors.len(), SHELL.len() + COLORS.len());
        assert_eq!(o.colors["surfaces.ground"].as_deref(), Some("#fbf1c7"));
        assert_eq!(o.value, json!({"preset": "gruvbox-light"}));
    }

    #[test]
    fn each_mode_keeps_a_readable_theme_of_its_own_mode() {
        let saved = json!({"themes": [
            {"id": "th-1", "name": "Night Desk", "theme": {"preset": "nord"}},
            {"id": "th-2", "name": "Day Desk", "theme": {"preset": "gruvbox-light"}},
        ]});
        let fine = json!({"appearance": "system", "dark": {"saved": "th-1"}, "light": {"preset": "tessera-light", "accents": {"aqua": "#005080"}}});
        check_scheme(&fine, &saved, "tessera").unwrap();
        let e = check_scheme(&json!({"light": {"preset": "nord"}}), &saved, "tessera").unwrap_err();
        assert!(
            e.starts_with("light: Nord is a dark theme") && e.contains("tessera-light"),
            "{e}"
        );
        let e = check_scheme(&json!({"dark": {"saved": "th-2"}}), &saved, "tessera").unwrap_err();
        assert!(
            e.starts_with("dark: that saved theme is a light theme"),
            "{e}"
        );
        let e = check_scheme(&json!({"dark": {"saved": "gone"}}), &saved, "tessera").unwrap_err();
        assert!(
            e.contains("no saved theme \"gone\"") && e.contains("Night Desk (th-1)"),
            "{e}"
        );
        let e = check_scheme(
            &json!({"light": {"preset": "tessera-light", "ink": {"t3": "#eef5fb"}}}),
            &saved,
            "tessera",
        )
        .unwrap_err();
        assert!(e.starts_with("light: unreadable text: ink.t3"), "{e}");
        assert_eq!(
            known_scheme(
                &json!({"appearance": "light", "dark": {"surfaces": {"gone": "#000000", "ground": "#000000"}}, "old": 1})
            ),
            json!({"appearance": "light", "dark": {"surfaces": {"ground": "#000000"}}})
        );
    }

    #[test]
    fn a_stored_key_this_build_does_not_have_is_dropped() {
        let v = known_fields(
            &json!({"gone": {"x": "#112233"}, "ink": {"t1": "#ffffff", "t9": "#000000"}, "preset": "nord"}),
        );
        assert_eq!(v, json!({"ink": {"t1": "#ffffff"}, "preset": "nord"}));
    }
}
