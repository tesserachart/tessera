use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tessera_core::{InstrumentId, Timeframe};
use tessera_protocol::indicators::{
    IndicatorInput, IndicatorSpec, InputType, custom_ref, normalize_custom_params,
};
use tessera_protocol::layers::LayerKind;
use tessera_protocol::layout::{ChartHours, ChartLayer, ChartType, Layout, OverlayNamespace};
use tessera_protocol::templates::{self, ChartTemplate, LAYERS_MAX};

use super::contract::{SetupCode, SetupDisplay, SetupKind, SetupLine, SetupPart};
use super::{clip, units};
use crate::layout::{DOCK_VIEW_KEY, MAX_CHARTS};
use crate::modules::feedback::Scrubber;

pub const SETUP_VERSION: u32 = 1;
pub const MAX_SETUP_BODY: usize = 512_000;
pub const LAYOUT_NAME_MAX: usize = 60;
const CUSTOM_REF: &str = "custom:";
const MAX_NAME: usize = 120;
const MAX_ABOUT: usize = 200;
const MAX_LINES: usize = 100;
const MAX_LINE_LABEL: usize = 80;
const MAX_LINE_VALUE: usize = 200;
const MAX_PARTS: usize = 64;
const MAX_CUSTOM: usize = 8;
const MAX_CODE: usize = 100_000;
const MAX_TILE_ID: usize = 64;
const MAX_LINK_GROUP: usize = 16;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PortableSetup {
    Indicator {
        v: u32,
        layer: PortableLayer,
        custom: Vec<PortableCustom>,
    },
    Template {
        v: u32,
        name: String,
        #[serde(rename = "chartType")]
        chart_type: Option<ChartType>,
        layers: Vec<PortableLayer>,
        custom: Vec<PortableCustom>,
    },
    Layout {
        v: u32,
        name: String,
        #[serde(rename = "activeChartId")]
        active_chart_id: Option<String>,
        charts: Vec<PortableChart>,
        dock: Option<Value>,
        custom: Vec<PortableCustom>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableLayer {
    pub kind: LayerKind,
    pub params: Value,
    pub visible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableCustom {
    pub name: String,
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableChart {
    pub tile_id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub instrument: String,
    pub timeframe: Timeframe,
    #[serde(default)]
    pub chart_type: Option<ChartType>,
    #[serde(default)]
    pub hours: Option<ChartHours>,
    #[serde(default)]
    pub link_group: Option<String>,
    pub layers: Vec<PortableLayer>,
}

impl PortableSetup {
    pub fn kind(&self) -> SetupKind {
        match self {
            PortableSetup::Indicator { .. } => SetupKind::Indicator,
            PortableSetup::Template { .. } => SetupKind::Template,
            PortableSetup::Layout { .. } => SetupKind::Layout,
        }
    }

    pub fn custom(&self) -> &[PortableCustom] {
        match self {
            PortableSetup::Indicator { custom, .. }
            | PortableSetup::Template { custom, .. }
            | PortableSetup::Layout { custom, .. } => custom,
        }
    }

    fn custom_mut(&mut self) -> &mut Vec<PortableCustom> {
        match self {
            PortableSetup::Indicator { custom, .. }
            | PortableSetup::Template { custom, .. }
            | PortableSetup::Layout { custom, .. } => custom,
        }
    }

    pub fn layers(&self) -> Vec<&PortableLayer> {
        match self {
            PortableSetup::Indicator { layer, .. } => vec![layer],
            PortableSetup::Template { layers, .. } => layers.iter().collect(),
            PortableSetup::Layout { charts, .. } => charts.iter().flat_map(|c| &c.layers).collect(),
        }
    }

    fn drop_custom(&mut self, n: usize) {
        let refers = |l: &PortableLayer| custom_index(l) == Some(n);
        match self {
            PortableSetup::Indicator { .. } => {}
            PortableSetup::Template { layers, .. } => layers.retain(|l| !refers(l)),
            PortableSetup::Layout { charts, .. } => {
                for c in charts {
                    c.layers.retain(|l| !refers(l));
                }
            }
        }
        self.custom_mut().truncate(n);
    }
}

pub fn kind_word(kind: SetupKind) -> &'static str {
    match kind {
        SetupKind::Indicator => "indicator",
        SetupKind::Template => "template",
        SetupKind::Layout => "layout",
    }
}

pub fn custom_index(layer: &PortableLayer) -> Option<usize> {
    if layer.kind != LayerKind::Custom {
        return None;
    }
    layer
        .params
        .get("indicator")?
        .as_str()?
        .strip_prefix(CUSTOM_REF)?
        .parse()
        .ok()
}

#[derive(Clone, Debug)]
pub struct CustomSource {
    pub name: String,
    pub code: String,
    pub spec: IndicatorSpec,
}

pub type CustomKey = (String, Option<u32>);

pub type Customs = HashMap<CustomKey, CustomSource>;

pub fn custom_key(kind: &str, params: &Value) -> Option<CustomKey> {
    (LayerKind::parse(kind) == Some(LayerKind::Custom))
        .then(|| custom_ref(params).ok())
        .flatten()
}

pub fn own_layer(l: &ChartLayer) -> bool {
    l.namespace == OverlayNamespace::User && l.session_id.is_none()
}

#[derive(Clone, Debug)]
pub struct Built {
    pub setup: PortableSetup,
    pub specs: Vec<IndicatorSpec>,
}

struct Builder<'a> {
    customs: &'a Customs,
    scrubber: &'a Scrubber,
    custom: Vec<PortableCustom>,
    specs: Vec<IndicatorSpec>,
    index: HashMap<CustomKey, usize>,
}

fn scrub_strings(v: &Value, s: &Scrubber) -> Value {
    match v {
        Value::String(t) => Value::String(s.scrub(t)),
        Value::Array(a) => Value::Array(a.iter().map(|x| scrub_strings(x, s)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), scrub_strings(x, s)))
                .collect(),
        ),
        other => other.clone(),
    }
}

impl<'a> Builder<'a> {
    fn new(customs: &'a Customs, scrubber: &'a Scrubber) -> Self {
        Self {
            customs,
            scrubber,
            custom: Vec::new(),
            specs: Vec::new(),
            index: HashMap::new(),
        }
    }

    fn custom_index(&mut self, key: &CustomKey) -> Option<usize> {
        if let Some(n) = self.index.get(key) {
            return Some(*n);
        }
        let src = self.customs.get(key)?;
        let code = self.scrubber.scrub_words(&src.code);
        if self.custom.len() >= MAX_CUSTOM || units(&code) > MAX_CODE {
            return None;
        }
        self.custom.push(PortableCustom {
            name: clip(&self.scrubber.scrub(&src.name), MAX_NAME),
            code,
        });
        self.specs.push(src.spec.clone());
        let n = self.custom.len() - 1;
        self.index.insert(key.clone(), n);
        Some(n)
    }

    fn layer(&mut self, kind: LayerKind, params: &Value, visible: bool) -> Option<PortableLayer> {
        if !templates::templatable(kind) {
            return None;
        }
        let params = if kind == LayerKind::Custom {
            let n = self.custom_index(&custom_ref(params).ok()?)?;
            let mut o = normalize_custom_params(Some(&self.specs[n]), params)
                .ok()?
                .as_object()?
                .clone();
            o.remove("version");
            o.insert("indicator".into(), json!(format!("{CUSTOM_REF}{n}")));
            Value::Object(o)
        } else {
            kind.validate_params(params).ok()?
        };
        Some(PortableLayer {
            kind,
            params: scrub_strings(&params, self.scrubber),
            visible,
        })
    }

    fn chart_layer(&mut self, l: &ChartLayer) -> Option<PortableLayer> {
        self.layer(LayerKind::parse(&l.kind)?, &l.params, l.visible)
    }

    fn done(self, setup: impl FnOnce(Vec<PortableCustom>) -> PortableSetup) -> Built {
        Built {
            setup: setup(self.custom),
            specs: self.specs,
        }
    }
}

pub fn indicator(
    kind: LayerKind,
    params: &Value,
    customs: &Customs,
    scrubber: &Scrubber,
) -> Option<Built> {
    let mut b = Builder::new(customs, scrubber);
    let layer = b.layer(kind, params, true)?;
    Some(b.done(|custom| PortableSetup::Indicator {
        v: SETUP_VERSION,
        layer,
        custom,
    }))
}

pub fn template(t: &ChartTemplate, customs: &Customs, scrubber: &Scrubber) -> Built {
    let mut b = Builder::new(customs, scrubber);
    let layers: Vec<PortableLayer> = t
        .layers
        .iter()
        .filter_map(|l| b.layer(LayerKind::parse(&l.kind)?, &l.params, l.visible))
        .take(LAYERS_MAX)
        .collect();
    let name = clip(&scrubber.scrub(&t.name), templates::NAME_MAX);
    b.done(|custom| PortableSetup::Template {
        v: SETUP_VERSION,
        name,
        chart_type: t.chart_type,
        layers,
        custom,
    })
}

pub fn layout(l: &Layout, customs: &Customs, scrubber: &Scrubber) -> Built {
    let mut b = Builder::new(customs, scrubber);
    let dock = portable_dock(&l.dock, scrubber);
    let placed = dock.as_ref().map(placed_tiles);
    let mut charts = Vec::new();
    for c in l.charts.values() {
        let tile_id = scrubber.scrub(&c.tile_id);
        if placed.as_ref().is_some_and(|p| !p.contains(&tile_id)) || charts.len() >= MAX_CHARTS {
            continue;
        }
        let layers = c
            .layers
            .iter()
            .filter(|x| own_layer(x))
            .filter_map(|x| b.chart_layer(x))
            .take(LAYERS_MAX)
            .collect();
        charts.push(PortableChart {
            tile_id,
            title: Some(clip(&scrubber.scrub(&c.title), MAX_NAME)).filter(|t| !t.is_empty()),
            instrument: scrubber.scrub(c.instrument.as_str()),
            timeframe: c.timeframe,
            chart_type: c.chart_type,
            hours: c.hours,
            link_group: c
                .link_group
                .as_deref()
                .map(|g| clip(&scrubber.scrub(g), MAX_LINK_GROUP)),
            layers,
        });
    }
    let active_chart_id = l
        .active_chart_id
        .as_deref()
        .map(|a| scrubber.scrub(a))
        .filter(|a| charts.iter().any(|c: &PortableChart| &c.tile_id == a));
    let name = clip(&scrubber.scrub(&l.name), LAYOUT_NAME_MAX);
    b.done(|custom| PortableSetup::Layout {
        v: SETUP_VERSION,
        name,
        active_chart_id,
        charts,
        dock,
        custom,
    })
}

fn placed_tiles(dock: &Value) -> HashSet<String> {
    let mut out = HashSet::new();
    for (id, panel) in dock
        .get("panels")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        out.insert(id.clone());
        if let Some(t) = panel
            .get("params")
            .and_then(|p| p.get("tileId"))
            .and_then(Value::as_str)
        {
            out.insert(t.to_owned());
        }
    }
    out
}

pub const PANEL_PARAMS: [&str; 4] = ["layoutId", "tileId", "link", "instrument"];

struct Dock<'a> {
    s: &'a Scrubber,
}

type Field<'a> = (&'a str, &'a dyn Fn(&Value) -> Option<Value>);

impl Dock<'_> {
    fn text(&self, v: &Value) -> Option<Value> {
        v.as_str().map(|t| Value::String(self.s.scrub(t)))
    }

    fn number(v: &Value) -> Option<Value> {
        v.as_f64().filter(|f| f.is_finite()).map(|_| v.clone())
    }

    fn flag(v: &Value) -> Option<Value> {
        v.as_bool().map(Value::Bool)
    }

    fn scalar(&self, v: &Value) -> Option<Value> {
        match v {
            Value::Null => Some(Value::Null),
            Value::String(_) => self.text(v),
            Value::Bool(_) => Dock::flag(v),
            Value::Number(_) => Dock::number(v),
            _ => None,
        }
    }

    fn texts(&self, v: &Value) -> Option<Value> {
        Some(Value::Array(
            v.as_array()?.iter().filter_map(|x| self.text(x)).collect(),
        ))
    }

    fn pick(&self, src: &Value, keys: &[Field<'_>]) -> Option<Value> {
        let src = src.as_object()?;
        let mut out = Map::new();
        for (key, f) in keys {
            if let Some(v) = src.get(*key).and_then(f) {
                out.insert((*key).to_owned(), v);
            }
        }
        Some(Value::Object(out))
    }

    fn tab_group(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("id", &|x| self.text(x)),
                ("label", &|x| self.text(x)),
                ("color", &|x| self.text(x)),
                ("collapsed", &Dock::flag),
                ("panelIds", &|x| self.texts(x)),
            ],
        )
    }

    fn group(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("id", &|x| self.text(x)),
                ("views", &|x| self.texts(x)),
                ("activeView", &|x| self.text(x)),
                ("locked", &|x| Dock::flag(x).or_else(|| self.text(x))),
                ("hideHeader", &Dock::flag),
                ("headerPosition", &|x| self.text(x)),
                ("tabGroups", &|x| {
                    Some(Value::Array(
                        x.as_array()?
                            .iter()
                            .filter_map(|t| self.tab_group(t))
                            .collect(),
                    ))
                }),
            ],
        )
    }

    fn node(&self, v: &Value) -> Option<Value> {
        let leaf = v.get("type")?.as_str()? == "leaf";
        let data = v.get("data")?;
        let data = if leaf {
            self.group(data)?
        } else {
            Value::Array(
                data.as_array()?
                    .iter()
                    .filter_map(|n| self.node(n))
                    .collect(),
            )
        };
        let mut out = self
            .pick(v, &[("size", &Dock::number), ("visible", &Dock::flag)])?
            .as_object()?
            .clone();
        out.insert("type".into(), json!(if leaf { "leaf" } else { "branch" }));
        out.insert("data".into(), data);
        Some(Value::Object(out))
    }

    fn grid(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("root", &|x| self.node(x)),
                ("width", &Dock::number),
                ("height", &Dock::number),
                ("orientation", &|x| self.text(x)),
            ],
        )
    }

    fn params(&self, v: &Value) -> Option<Value> {
        let src = v.as_object()?;
        Some(Value::Object(
            PANEL_PARAMS
                .iter()
                .filter_map(|k| Some(((*k).to_owned(), self.scalar(src.get(*k)?)?)))
                .collect(),
        ))
    }

    fn panel(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("id", &|x| self.text(x)),
                ("contentComponent", &|x| self.text(x)),
                ("tabComponent", &|x| self.text(x)),
                ("title", &|x| self.text(x)),
                ("renderer", &|x| self.text(x)),
                ("params", &|x| self.params(x)),
                ("minimumWidth", &Dock::number),
                ("minimumHeight", &Dock::number),
                ("maximumWidth", &Dock::number),
                ("maximumHeight", &Dock::number),
                ("pinned", &Dock::flag),
            ],
        )
    }

    fn panels(&self, v: &Value) -> Option<Value> {
        Some(Value::Object(
            v.as_object()?
                .iter()
                .filter_map(|(k, p)| Some((self.s.scrub(k), self.panel(p)?)))
                .collect(),
        ))
    }

    fn box_of(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("top", &Dock::number),
                ("left", &Dock::number),
                ("bottom", &Dock::number),
                ("right", &Dock::number),
                ("width", &Dock::number),
                ("height", &Dock::number),
            ],
        )
    }

    fn floating(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("data", &|x| self.group(x)),
                ("grid", &|x| self.grid(x)),
                ("position", &|x| self.box_of(x)),
            ],
        )
    }

    fn edge(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("size", &Dock::number),
                ("visible", &Dock::flag),
                ("collapsed", &Dock::flag),
                ("group", &|x| self.group(x)),
                ("autoHide", &Dock::flag),
                ("autoReveal", &Dock::flag),
                ("minimumSize", &Dock::number),
                ("maximumSize", &Dock::number),
                ("collapsedSize", &Dock::number),
            ],
        )
    }

    fn flags(v: &Value) -> Option<Value> {
        Some(Value::Object(
            v.as_object()?
                .iter()
                .filter_map(|(k, x)| Some((k.clone(), Dock::flag(x)?)))
                .collect(),
        ))
    }

    fn view(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("v", &Dock::number),
                ("preset", &|x| self.text(x)),
                ("syncInterval", &Dock::flag),
                ("chartTypes", &|x| {
                    Some(Value::Object(
                        x.as_object()?
                            .iter()
                            .filter_map(|(k, t)| Some((self.s.scrub(k), self.text(t)?)))
                            .collect(),
                    ))
                }),
                ("collapsed", &Dock::flags),
                ("story", &|x| self.text(x)),
            ],
        )
    }

    fn dock(&self, v: &Value) -> Option<Value> {
        self.pick(
            v,
            &[
                ("grid", &|x| self.grid(x)),
                ("panels", &|x| self.panels(x)),
                ("activeGroup", &|x| self.text(x)),
                ("floatingGroups", &|x| {
                    Some(Value::Array(
                        x.as_array()?
                            .iter()
                            .filter_map(|f| self.floating(f))
                            .collect(),
                    ))
                }),
                ("edgeGroups", &|x| {
                    self.pick(
                        x,
                        &[
                            ("top", &|e| self.edge(e)),
                            ("bottom", &|e| self.edge(e)),
                            ("left", &|e| self.edge(e)),
                            ("right", &|e| self.edge(e)),
                        ],
                    )
                }),
                (DOCK_VIEW_KEY, &|x| self.view(x)),
            ],
        )
    }
}

pub fn portable_dock(dock: &Value, scrubber: &Scrubber) -> Option<Value> {
    Dock { s: scrubber }
        .dock(dock)
        .filter(|d| d.as_object().is_some_and(|o| !o.is_empty()))
}

fn shape_words(kind: SetupKind, count: usize) -> String {
    let (what, of) = match kind {
        SetupKind::Indicator => return "Indicator".to_owned(),
        SetupKind::Template => ("Chart template", "indicator"),
        SetupKind::Layout => ("Workspace", "chart"),
    };
    let plural = if count == 1 { "" } else { "s" };
    format!("{what} · {count} {of}{plural}")
}

pub(crate) const SWATCHES: [(&str, &str); 9] = [
    ("mist", "palette.mist"),
    ("t1", "palette.text"),
    ("t2", "palette.subtle"),
    ("t3", "palette.muted"),
    ("t4", "ink.t4"),
    ("up", "palette.up"),
    ("down", "palette.down"),
    ("brass", "palette.hazard"),
    ("teal", "accents.teal"),
];

fn swatch_hex(name: &str) -> Option<&'static str> {
    static HEX: std::sync::OnceLock<HashMap<&'static str, String>> = std::sync::OnceLock::new();
    HEX.get_or_init(|| {
        let theme = tessera_protocol::theme::resolve(&json!({}), "");
        SWATCHES
            .iter()
            .filter_map(|(s, path)| Some((*s, theme.color(path)?.hex().chars().take(7).collect())))
            .collect()
    })
    .get(name)
    .map(String::as_str)
}

pub fn colour_hex(c: &str) -> String {
    if let Some(hex) = swatch_hex(c) {
        return hex.to_owned();
    }
    let Some(hex) = c.strip_prefix('#').map(str::to_ascii_lowercase) else {
        return c.to_owned();
    };
    match hex.len() {
        3 => format!("#{}", hex.chars().flat_map(|d| [d, d]).collect::<String>()),
        6 | 8 => format!("#{}", &hex[..6]),
        _ => c.to_owned(),
    }
}

fn number_words(v: &Value) -> String {
    match v.as_f64() {
        Some(f) if f.is_finite() => format!("{f}"),
        _ => v.to_string(),
    }
}

fn source_words(s: &str) -> String {
    match s {
        "hl2" | "hlc3" | "ohlc4" => s.to_ascii_uppercase(),
        _ => {
            let mut c = s.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default()
        }
    }
}

fn input_words(i: &IndicatorInput, v: &Value) -> String {
    match i.ty {
        InputType::Bool => if v.as_bool() == Some(true) {
            "On"
        } else {
            "Off"
        }
        .to_owned(),
        InputType::Number | InputType::Int => number_words(v),
        InputType::Color => colour_hex(v.as_str().unwrap_or_default()),
        InputType::Source => source_words(v.as_str().unwrap_or_default()),
        InputType::Enum => {
            let raw = v.as_str().map_or_else(|| v.to_string(), str::to_owned);
            i.options
                .iter()
                .flatten()
                .find(|o| o.value == raw)
                .map_or(raw, |o| o.label.clone())
        }
        InputType::Session | InputType::Timezone | InputType::Time => {
            v.as_str().map_or_else(|| v.to_string(), str::to_owned)
        }
    }
}

struct Shown<'a> {
    spec: IndicatorSpec,
    name: String,
    params: &'a Value,
}

impl Shown<'_> {
    fn input(&self, key: &str) -> Option<Value> {
        let given = self.params.get("inputs").and_then(|i| i.get(key)).cloned();
        given.or_else(|| {
            self.spec
                .inputs
                .iter()
                .find(|i| i.key == key)
                .map(|i| i.default.clone())
        })
    }

    fn applies(&self, i: &IndicatorInput) -> bool {
        i.when.as_ref().is_none_or(|w| {
            self.input(&w.input)
                .and_then(|v| v.as_str().map(str::to_owned))
                .is_some_and(|v| w.values.contains(&v))
        })
    }

    fn label(&self) -> String {
        let summary: Vec<String> = self
            .spec
            .inputs
            .iter()
            .filter(|i| i.in_label && self.applies(i))
            .filter_map(|i| Some(input_words(i, &self.input(&i.key)?)))
            .collect();
        if summary.is_empty() {
            self.name.clone()
        } else {
            format!("{} {}", self.name, summary.join(" "))
        }
    }

    fn lines(&self) -> Vec<SetupLine> {
        let mut out: Vec<SetupLine> = self
            .spec
            .inputs
            .iter()
            .filter(|i| self.applies(i))
            .filter_map(|i| Some(line(&i.label, &input_words(i, &self.input(&i.key)?))))
            .collect();
        let plots = self.params.get("style").and_then(|s| s.get("plots"));
        for p in &self.spec.plots {
            let style = plots.and_then(|s| s.get(&p.key));
            let visible = style
                .and_then(|s| s.get("visible"))
                .and_then(Value::as_bool)
                .unwrap_or(p.default.visible);
            let switched_on = p
                .shown_by
                .as_deref()
                .is_none_or(|k| self.input(k).and_then(|v| v.as_bool()) != Some(false));
            if !visible || !switched_on {
                continue;
            }
            let colour = style
                .and_then(|s| s.get("color"))
                .and_then(Value::as_str)
                .unwrap_or(&p.default.color);
            out.push(line(&p.label, &colour_hex(colour)));
        }
        out.truncate(MAX_LINES);
        out
    }
}

fn line(label: &str, value: &str) -> SetupLine {
    SetupLine {
        label: clip(label, MAX_LINE_LABEL),
        value: clip(value, MAX_LINE_VALUE),
    }
}

fn shown<'a>(
    l: &'a PortableLayer,
    specs: &[IndicatorSpec],
    custom: &[PortableCustom],
) -> Option<Shown<'a>> {
    match custom_index(l) {
        Some(n) => Some(Shown {
            spec: specs.get(n)?.clone(),
            name: custom.get(n)?.name.clone(),
            params: &l.params,
        }),
        None => {
            let spec = l.kind.indicator()?;
            Some(Shown {
                name: spec.short.clone(),
                spec,
                params: &l.params,
            })
        }
    }
}

fn chart_type_words(t: ChartType) -> &'static str {
    match t {
        ChartType::Candles => "Candles",
        ChartType::Bars => "Bars",
        ChartType::Line => "Line",
        ChartType::None => "No price",
    }
}

fn hours_words(h: ChartHours) -> &'static str {
    match h {
        ChartHours::Eth => "Extended hours",
        ChartHours::Rth => "Regular hours",
    }
}

fn chart_name(c: &PortableChart) -> String {
    let symbol = InstrumentId::new(&c.instrument)
        .map(|i| i.symbol().to_owned())
        .unwrap_or_else(|_| c.instrument.clone());
    format!("{symbol} · {}", c.timeframe)
}

pub fn display(built: &Built) -> SetupDisplay {
    let setup = &built.setup;
    let custom = setup.custom();
    let specs = built.specs.as_slice();
    let (name, lines, parts, count) = match setup {
        PortableSetup::Indicator { layer, .. } => {
            let s = shown(layer, specs, custom);
            (
                s.as_ref()
                    .map_or_else(|| "Indicator".to_owned(), |s| s.name.clone()),
                s.map(|s| s.lines()).unwrap_or_default(),
                Vec::new(),
                1,
            )
        }
        PortableSetup::Template {
            name,
            chart_type,
            layers,
            ..
        } => (
            name.clone(),
            chart_type
                .map(|t| vec![line("Chart type", chart_type_words(t))])
                .unwrap_or_default(),
            layers
                .iter()
                .filter_map(|l| shown(l, specs, custom))
                .map(|s| SetupPart {
                    name: clip(&s.label(), MAX_NAME),
                    lines: s.lines(),
                })
                .collect(),
            layers.len(),
        ),
        PortableSetup::Layout { name, charts, .. } => (
            name.clone(),
            Vec::new(),
            charts
                .iter()
                .map(|c| {
                    let mut lines = Vec::new();
                    if let Some(t) = c.chart_type {
                        lines.push(line("Chart type", chart_type_words(t)));
                    }
                    if let Some(h) = c.hours {
                        lines.push(line("Hours", hours_words(h)));
                    }
                    let indicators: Vec<String> = c
                        .layers
                        .iter()
                        .filter_map(|l| shown(l, specs, custom))
                        .map(|s| s.label())
                        .collect();
                    if !indicators.is_empty() {
                        lines.push(line("Indicators", &indicators.join(", ")));
                    }
                    SetupPart {
                        name: clip(&chart_name(c), MAX_NAME),
                        lines,
                    }
                })
                .collect(),
            charts.len(),
        ),
    };
    let about = match (setup, custom.is_empty()) {
        (PortableSetup::Indicator { .. }, false) => "Custom indicator".to_owned(),
        _ => shape_words(setup.kind(), count),
    };
    SetupDisplay {
        name: clip(&name, MAX_NAME),
        about: clip(&about, MAX_ABOUT),
        lines,
        parts: parts.into_iter().take(MAX_PARTS).collect(),
        code: custom
            .iter()
            .map(|c| SetupCode {
                name: c.name.clone(),
                code: c.code.clone(),
            })
            .collect(),
    }
}

pub fn body_size(title: &str, display: &SetupDisplay, setup: &PortableSetup) -> usize {
    let size = |v: Result<Vec<u8>, serde_json::Error>| v.map_or(usize::MAX, |v| v.len());
    size(serde_json::to_vec(display))
        .saturating_add(size(serde_json::to_vec(setup)))
        .saturating_add(title.len() + 64)
}

pub fn fit(built: &mut Built, title: &str) -> Option<SetupDisplay> {
    loop {
        let shown = display(built);
        if body_size(title, &shown, &built.setup) <= MAX_SETUP_BODY {
            return Some(shown);
        }
        if matches!(built.setup, PortableSetup::Indicator { .. }) {
            return None;
        }
        if let Some(n) = built.setup.custom().len().checked_sub(1) {
            built.setup.drop_custom(n);
            built.specs.truncate(n);
        } else if let PortableSetup::Layout {
            dock: dock @ Some(_),
            ..
        } = &mut built.setup
        {
            *dock = None;
        } else {
            return None;
        }
    }
}

fn valid_tile_id(id: &str) -> bool {
    (1..=MAX_TILE_ID).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

pub fn checked_layer(l: PortableLayer, customs: usize) -> Result<PortableLayer, String> {
    if !templates::templatable(l.kind) {
        return Err(format!("{} is not an indicator", l.kind));
    }
    let params = if l.kind == LayerKind::Custom {
        let n = custom_index(&l).ok_or("a custom indicator names its code")?;
        if n >= customs || l.params.get("version").is_some() {
            return Err("a custom indicator names code the link does not bring".into());
        }
        normalize_custom_params(None, &l.params)?
    } else {
        l.kind.validate_params(&l.params)?
    };
    Ok(PortableLayer { params, ..l })
}

fn checked_layers(
    layers: Vec<PortableLayer>,
    customs: usize,
) -> Result<Vec<PortableLayer>, String> {
    if layers.len() > LAYERS_MAX {
        return Err("too many indicators".into());
    }
    layers
        .into_iter()
        .map(|l| checked_layer(l, customs))
        .collect()
}

fn checked_custom(custom: &[PortableCustom]) -> Result<(), String> {
    if custom.len() > MAX_CUSTOM {
        return Err("too many custom indicators".into());
    }
    for c in custom {
        if c.name.trim().is_empty() || units(&c.name) > MAX_NAME {
            return Err("a custom indicator needs a name".into());
        }
        if c.code.trim().is_empty() || units(&c.code) > MAX_CODE {
            return Err("a custom indicator's code is missing or too long".into());
        }
    }
    Ok(())
}

pub fn read(kind: &str, setup: Value) -> Result<PortableSetup, String> {
    let setup: PortableSetup = serde_json::from_value(setup).map_err(|e| e.to_string())?;
    if kind_word(setup.kind()) != kind {
        return Err(format!("a {kind} link holds a {}", kind_word(setup.kind())));
    }
    checked(setup)
}

pub fn checked(setup: PortableSetup) -> Result<PortableSetup, String> {
    let customs = setup.custom().len();
    checked_custom(setup.custom())?;
    match setup {
        PortableSetup::Indicator { v, layer, custom } if v == SETUP_VERSION => {
            Ok(PortableSetup::Indicator {
                v,
                layer: checked_layer(layer, customs)?,
                custom,
            })
        }
        PortableSetup::Template {
            v,
            name,
            chart_type,
            layers,
            custom,
        } if v == SETUP_VERSION => Ok(PortableSetup::Template {
            v,
            name: templates::clean_name(&name)?,
            chart_type,
            layers: checked_layers(layers, customs)?,
            custom,
        }),
        PortableSetup::Layout {
            v,
            name,
            active_chart_id,
            charts,
            dock,
            custom,
        } if v == SETUP_VERSION => {
            if charts.len() > MAX_CHARTS {
                return Err("too many charts".into());
            }
            let mut seen = HashSet::new();
            let mut out = Vec::with_capacity(charts.len());
            for c in charts {
                if !valid_tile_id(&c.tile_id) || !seen.insert(c.tile_id.clone()) {
                    return Err(format!("{:?} is not a chart tile id", c.tile_id));
                }
                InstrumentId::new(&c.instrument).map_err(|e| e.to_string())?;
                out.push(PortableChart {
                    title: c.title.map(|t| clip(&t, MAX_NAME)),
                    link_group: c.link_group.map(|g| clip(&g, MAX_LINK_GROUP)),
                    layers: checked_layers(c.layers, customs)?,
                    ..c
                });
            }
            let name = clip(&name, LAYOUT_NAME_MAX);
            if name.is_empty() {
                return Err("a workspace needs a name".into());
            }
            Ok(PortableSetup::Layout {
                v,
                name,
                active_chart_id: active_chart_id.filter(|a| seen.contains(a)),
                charts: out,
                dock: dock.and_then(|d| portable_dock(&d, &Scrubber::default())),
                custom,
            })
        }
        other => Err(format!(
            "a {} setup of an unknown version",
            kind_word(other.kind())
        )),
    }
}
