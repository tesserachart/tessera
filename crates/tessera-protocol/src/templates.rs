use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::ids::{SessionId, numbered, slug};
use ts_rs::TS;

use crate::layers::LayerKind;
use crate::layout::{ChartLayer, ChartState, ChartType, OverlayNamespace};

pub const NAME_MAX: usize = 48;
pub const TEMPLATES_MAX: usize = 100;
pub const LAYERS_MAX: usize = 32;

fn shown() -> bool {
    true
}

/// One indicator of a template: its kind, its params (`{inputs, style, height}`, stored complete)
/// and whether it is shown.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemplateLayer {
    /// Indicator kind (`ema`, `rsi`): a kind with an indicator declaration.
    pub kind: String,
    /// The indicator's params, as `chart.add_layer` takes them.
    #[serde(default)]
    pub params: Value,
    /// Shown (a hidden indicator stays listed on the chart).
    #[serde(default = "shown")]
    pub visible: bool,
}

/// A saved chart setup.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartTemplate {
    /// Stable id (`scalp`, `scalp-2`); a rename keeps it.
    pub id: String,
    /// The user's name for it (`Scalp`).
    pub name: String,
    /// The chart type it sets; absent leaves the chart's type as it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chart_type: Option<ChartType>,
    /// The indicators, bottom to top; sub-pane indicators in pane order.
    #[serde(default)]
    pub layers: Vec<TemplateLayer>,
}

/// The `chart.templates` setting, and what the template tools return: every template in the
/// user's order and the one new charts start with.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartTemplates {
    /// The templates, in the order they were first saved.
    #[serde(default)]
    pub templates: Vec<ChartTemplate>,
    /// The template a new chart starts with; absent: new charts start without indicators.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_id: Option<String>,
}

/// `chart.list_templates` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartListTemplatesInput {}

/// `chart.save_template` input: saves a chart's setup under a name, replacing the template of
/// that name if there is one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSaveTemplateInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Template name (1–48 characters). A template with this name (any case) is replaced.
    pub name: String,
    /// The chart type to record (default: the chart's own, when one was picked).
    #[serde(default)]
    pub chart_type: Option<ChartType>,
    /// Also make it the template new charts start with.
    #[serde(default)]
    pub default: Option<bool>,
}

/// `chart.save_template` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartTemplateSavedOutput {
    /// The saved template.
    pub template: ChartTemplate,
    /// A template of that name was replaced.
    pub replaced: bool,
    /// The template new charts start with, after the save.
    pub default_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartApplyTemplateInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The template's id or name.
    pub template: String,
}

/// `chart.edit_template` input: renames a template and/or makes it (or stops it being) the
/// default for new charts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartEditTemplateInput {
    /// The template's id or name.
    pub template: String,
    /// New name (1–48 characters, not another template's).
    #[serde(default)]
    pub name: Option<String>,
    /// true: new charts start with it; false: if they did, they start without indicators.
    #[serde(default)]
    pub default: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDeleteTemplateInput {
    /// The template's id or name.
    pub template: String,
}

pub fn templatable(kind: LayerKind) -> bool {
    kind == LayerKind::Custom || (kind.indicator().is_some() && kind.drawn().is_some())
}

pub fn templatable_kinds() -> Vec<&'static str> {
    LayerKind::ALL
        .into_iter()
        .filter(|k| templatable(*k))
        .map(LayerKind::as_str)
        .collect()
}

pub fn is_template_layer(layer: &ChartLayer) -> bool {
    LayerKind::parse(&layer.kind).is_some_and(templatable)
}

pub fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("a template needs a name".into());
    }
    if n.chars().count() > NAME_MAX {
        return Err(format!("a template name has at most {NAME_MAX} characters"));
    }
    Ok(n.to_owned())
}

pub fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

const ID_MAX: usize = 40;

pub fn new_id<'a>(name: &str, taken: impl IntoIterator<Item = &'a str> + Clone) -> String {
    let mut base: String = slug(name).chars().take(ID_MAX).collect();
    if base.is_empty() {
        base = "template".into();
    }
    numbered(&base, "-")
        .find(|id| taken.clone().into_iter().all(|t| t != id))
        .expect("unbounded")
}

pub fn find<'a>(all: &'a ChartTemplates, reference: &str) -> Option<&'a ChartTemplate> {
    all.templates
        .iter()
        .find(|t| t.id == reference)
        .or_else(|| all.templates.iter().find(|t| same_name(&t.name, reference)))
}

pub fn validate_layer(layer: &TemplateLayer) -> Result<Value, String> {
    let kind = LayerKind::parse(&layer.kind)
        .filter(|k| templatable(*k))
        .ok_or_else(|| format!("{} is not an indicator a template can hold", layer.kind))?;
    kind.validate_params(&layer.params)
        .map_err(|e| format!("{kind} params: {e}"))
}

pub fn read(value: &Value) -> ChartTemplates {
    let mut out = ChartTemplates::default();
    let Some(obj) = value.as_object() else {
        return out;
    };
    for raw in obj
        .get("templates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Ok(mut t) = serde_json::from_value::<ChartTemplate>(raw.clone()) else {
            continue;
        };
        let Ok(name) = clean_name(&t.name) else {
            continue;
        };
        if t.id.is_empty() || out.templates.iter().any(|x| x.id == t.id) {
            continue;
        }
        t.name = name;
        t.layers
            .retain(|l| LayerKind::parse(&l.kind).is_some_and(templatable));
        t.layers.truncate(LAYERS_MAX);
        for l in &mut t.layers {
            if let Ok(p) = validate_layer(l) {
                l.params = p;
            }
        }
        out.templates.push(t);
        if out.templates.len() == TEMPLATES_MAX {
            break;
        }
    }
    out.default_id = obj
        .get("defaultId")
        .and_then(Value::as_str)
        .filter(|id| out.templates.iter().any(|t| t.id == *id))
        .map(str::to_owned);
    out
}

pub fn capture(chart: &ChartState) -> Vec<TemplateLayer> {
    chart
        .layers
        .iter()
        .filter(|l| is_template_layer(l))
        .take(LAYERS_MAX)
        .map(|l| {
            let kind = LayerKind::parse(&l.kind).expect("templatable kinds parse");
            TemplateLayer {
                kind: l.kind.clone(),
                params: kind
                    .validate_params(&l.params)
                    .unwrap_or_else(|_| l.params.clone()),
                visible: l.visible,
            }
        })
        .collect()
}

pub fn apply(
    chart: &mut ChartState,
    template: &ChartTemplate,
    namespace: OverlayNamespace,
    session_id: Option<SessionId>,
) -> Result<(), String> {
    let mut fresh = Vec::with_capacity(template.layers.len());
    let kept: Vec<ChartLayer> = chart
        .layers
        .iter()
        .filter(|l| !is_template_layer(l))
        .cloned()
        .collect();
    for l in &template.layers {
        let params = validate_layer(l).map_err(|e| format!("template {}: {e}", template.name))?;
        let id = (1..)
            .map(|n| format!("{}-{n}", l.kind))
            .find(|cand| {
                kept.iter().all(|x| &x.id != cand)
                    && fresh.iter().all(|x: &ChartLayer| &x.id != cand)
            })
            .expect("unbounded");
        fresh.push(ChartLayer {
            id,
            kind: l.kind.clone(),
            params,
            visible: l.visible,
            namespace,
            session_id: session_id.clone(),
        });
    }
    let at = chart
        .layers
        .iter()
        .position(is_template_layer)
        .map_or(kept.len(), |first| {
            chart.layers[..first]
                .iter()
                .filter(|l| !is_template_layer(l))
                .count()
        });
    let mut layers = kept;
    layers.splice(at..at, fresh);
    chart.layers = layers;
    if let Some(t) = template.chart_type {
        chart.chart_type = Some(t);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tessera_core::{InstrumentId, Timeframe};

    fn layer(id: &str, kind: &str, params: Value) -> ChartLayer {
        ChartLayer {
            id: id.into(),
            kind: kind.into(),
            params,
            visible: true,
            namespace: OverlayNamespace::User,
            session_id: None,
        }
    }

    fn chart(layers: Vec<ChartLayer>) -> ChartState {
        ChartState {
            tile_id: "chart-1".into(),
            title: "Chart 1".into(),
            instrument: InstrumentId::new("QQQ").unwrap(),
            timeframe: Timeframe::M5,
            print_bars: None,
            layers,
            annotations: Vec::new(),
            viewport: None,
            link_group: None,
            chart_type: None,
            hours: None,
            drawings: Vec::new(),
            drawings_from: Vec::new(),
        }
    }

    #[test]
    fn only_drawn_indicators_go_in_a_template() {
        let kinds = templatable_kinds();
        for k in [
            "volume",
            "vwap",
            "sma",
            "ema",
            "wma",
            "rsi",
            "atr",
            "bollinger",
            "footprint",
            "volume_profile",
            "delta",
            "big_trades",
        ] {
            assert!(kinds.contains(&k), "{k}");
        }
        for k in ["levels", "sessions"] {
            assert!(!kinds.contains(&k), "{k}");
        }
    }

    #[test]
    fn names_and_ids() {
        assert_eq!(clean_name("  Scalp  ").unwrap(), "Scalp");
        assert!(clean_name("   ").is_err());
        assert!(clean_name(&"x".repeat(NAME_MAX + 1)).is_err());
        assert!(same_name("scalp ", "SCALP"));
        assert_eq!(new_id("Scalp NQ / 1m", ["x"]), "scalp-nq-1m");
        assert_eq!(new_id("Scalp", ["scalp", "scalp-2"]), "scalp-3");
        assert_eq!(new_id("★★", [] as [&str; 0]), "template");
    }

    #[test]
    fn a_stored_value_is_read_leniently() {
        let t = read(&json!({
            "templates": [
                {"id": "a", "name": " Scalp ", "chartType": "bars",
                 "layers": [{"kind": "ema", "params": {"inputs": {"length": 21}}},
                            {"kind": "levels", "params": {"group": "pd"}},
                            {"kind": "rsi", "params": {"inputs": {"length": 0}}, "visible": false}]},
                {"id": "a", "name": "Duplicate"},
                {"name": "No id"},
                {"id": "b", "name": ""},
                {"id": "c", "name": "Swing"},
                "junk"
            ],
            "defaultId": "nope"
        }));
        assert_eq!(t.templates.len(), 2);
        let a = &t.templates[0];
        assert_eq!(a.name, "Scalp");
        assert_eq!(a.chart_type, Some(ChartType::Bars));
        assert_eq!(a.layers.len(), 2, "levels dropped");
        assert_eq!(a.layers[0].params["inputs"]["length"], 21);
        assert_eq!(a.layers[0].params["inputs"]["source"], "close", "completed");
        assert_eq!(a.layers[1].params, json!({"inputs": {"length": 0}}), "kept");
        assert!(!a.layers[1].visible);
        assert!(a.layers[0].visible, "visible by default");
        assert_eq!(
            t.default_id, None,
            "a default naming no template is dropped"
        );
        assert_eq!(read(&json!(null)), ChartTemplates::default());
        let t = read(&json!({"templates": [{"id": "c", "name": "Swing"}], "defaultId": "c"}));
        assert_eq!(t.default_id.as_deref(), Some("c"));
        assert_eq!(find(&t, "SWING").map(|x| x.id.as_str()), Some("c"));
        assert_eq!(find(&t, "c").map(|x| x.name.as_str()), Some("Swing"));
        assert!(find(&t, "nope").is_none());
    }

    #[test]
    fn capture_then_apply_replaces_indicators_and_keeps_the_rest() {
        let mut src = chart(vec![
            layer("volume-1", "volume", json!({"height": 0.25})),
            layer("lv", "levels", json!({"group": "pd"})),
            layer("ema-1", "ema", json!({"inputs": {"length": 9}})),
        ]);
        src.layers[2].visible = false;
        src.layers[2].namespace = OverlayNamespace::Agent;
        let layers = capture(&src);
        assert_eq!(
            layers.iter().map(|l| l.kind.as_str()).collect::<Vec<_>>(),
            ["volume", "ema"]
        );
        assert_eq!(layers[0].params["height"], 0.25, "pane height kept");
        assert!(!layers[1].visible);
        let template = ChartTemplate {
            id: "t".into(),
            name: "T".into(),
            chart_type: Some(ChartType::Line),
            layers,
        };

        let mut dst = chart(vec![
            layer("vwap-1", "vwap", json!({})),
            layer("lv", "levels", json!({"group": "pd"})),
            layer("rsi-1", "rsi", json!({})),
        ]);
        apply(&mut dst, &template, OverlayNamespace::User, None).unwrap();
        let ids: Vec<&str> = dst.layers.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(
            ids,
            ["volume-1", "ema-1", "lv"],
            "at the first indicator's place"
        );
        assert_eq!(dst.layers[1].namespace, OverlayNamespace::User);
        assert_eq!(dst.layers[1].params["inputs"]["length"], 9);
        assert_eq!(dst.chart_type, Some(ChartType::Line));

        let mut dst = chart(vec![layer("lv", "levels", json!({"group": "pd"}))]);
        dst.chart_type = Some(ChartType::Bars);
        let plain = ChartTemplate {
            chart_type: None,
            ..template.clone()
        };
        apply(&mut dst, &plain, OverlayNamespace::User, None).unwrap();
        assert_eq!(dst.chart_type, Some(ChartType::Bars));
        assert_eq!(dst.layers[0].id, "lv");

        let bad = ChartTemplate {
            layers: vec![TemplateLayer {
                kind: "rsi".into(),
                params: json!({"inputs": {"length": 0}}),
                visible: true,
            }],
            ..template
        };
        let before = dst.clone();
        assert!(apply(&mut dst, &bad, OverlayNamespace::User, None).is_err());
        assert_eq!(dst, before);
    }
}
