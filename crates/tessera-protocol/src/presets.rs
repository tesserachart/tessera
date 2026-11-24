use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;

use crate::indicators::{IndicatorSpec, normalize_params};
use crate::layers::LayerKind;
use crate::layout::ChartLayer;
use crate::templates::{new_id, same_name};

pub const NAME_MAX: usize = 48;
pub const PRESETS_MAX: usize = 200;
pub const DEFAULT_REF: &str = "default";
pub const FACTORY_REF: &str = "factory";

/// An indicator's settings kept under a name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorPreset {
    /// Id (`fast-ema`), unique over every preset.
    pub id: String,
    /// Its name, unique among the indicator's presets (any case).
    pub name: String,
    /// The indicator it is for: a built-in's kind (`ema`) or a custom indicator's id (`ci_…`).
    pub indicator: String,
    /// Its settings, `{inputs, style}` complete as the indicator was when it was saved.
    #[ts(type = "Record<string, unknown>")]
    pub params: Value,
}

/// Every preset, and the defaults new indicators start from (the `chart.indicatorPresets`
/// setting; `chart.list_indicator_presets`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorPresets {
    /// Presets, in the order they were saved.
    #[serde(default)]
    pub presets: Vec<IndicatorPreset>,
    /// The settings a new indicator starts from, by indicator (kind or custom id); an indicator
    /// not named starts from its own defaults.
    #[serde(default)]
    #[ts(type = "Record<string, Record<string, unknown>>")]
    pub defaults: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartListIndicatorPresetsInput {
    /// Only this indicator's (a kind or a custom indicator's id).
    #[serde(default)]
    pub indicator: Option<String>,
}

/// `chart.save_indicator_preset` input: an indicator layer's settings, or settings given for an
/// indicator, under a name (a preset of that name for the indicator is replaced).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSaveIndicatorPresetInput {
    /// Chart tile id (default: the active chart), with `layer_id`.
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout), with `layer_id`.
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The indicator layer whose current settings to keep.
    #[serde(default)]
    pub layer_id: Option<String>,
    /// Without a layer: the indicator (a kind, or a custom indicator's id)…
    #[serde(default)]
    pub indicator: Option<String>,
    /// …and its settings, `{inputs, style}` (omitted values take its own defaults).
    #[serde(default)]
    pub params: Option<Value>,
    /// The preset's name (at most 48 characters).
    pub name: String,
}

/// `chart.save_indicator_preset` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartIndicatorPresetSavedOutput {
    /// The preset as kept.
    pub preset: IndicatorPreset,
    /// It replaced the indicator's preset of the same name.
    pub replaced: bool,
}

/// `chart.apply_indicator_preset` input: a chart indicator takes a preset's settings (its pane
/// height stays).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartApplyIndicatorPresetInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The indicator layer.
    pub layer_id: String,
    /// A preset of the layer's indicator, by id or name; `default` for the saved default ("Reset
    /// settings": the indicator's own defaults when none is saved); `factory` for the indicator's
    /// own defaults.
    pub preset: String,
}

/// `chart.edit_indicator_preset` input: renames a preset.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartEditIndicatorPresetInput {
    /// The preset, by id or name.
    pub preset: String,
    /// The indicator whose preset a name means (needed only when two indicators have one of that
    /// name).
    #[serde(default)]
    pub indicator: Option<String>,
    /// Its new name.
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartDeleteIndicatorPresetInput {
    /// The preset, by id or name.
    pub preset: String,
    /// The indicator whose preset a name means (needed only when two indicators have one of that
    /// name).
    #[serde(default)]
    pub indicator: Option<String>,
}

/// `chart.set_indicator_default` input: the settings new indicators of one kind start from
/// ("Save as default"): an indicator layer's current ones, a saved preset's, settings given, or
/// (`clear`) its own defaults again.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetIndicatorDefaultInput {
    /// Chart tile id (default: the active chart), with `layer_id`.
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout), with `layer_id`.
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The indicator layer whose current settings become the default.
    #[serde(default)]
    pub layer_id: Option<String>,
    /// Without a layer: the indicator (a kind, or a custom indicator's id).
    #[serde(default)]
    pub indicator: Option<String>,
    /// A preset of the indicator, by id or name, whose settings become the default.
    #[serde(default)]
    pub preset: Option<String>,
    /// Settings given, `{inputs, style}` (omitted values take its own defaults).
    #[serde(default)]
    pub params: Option<Value>,
    /// True: no default; new ones start from the indicator's own defaults.
    #[serde(default)]
    pub clear: Option<bool>,
}

pub fn presettable(kind: LayerKind) -> bool {
    kind == LayerKind::Custom || kind.indicator().is_some()
}

pub fn indicator_of(layer: &ChartLayer) -> Option<String> {
    let kind = LayerKind::parse(&layer.kind).filter(|k| presettable(*k))?;
    if kind == LayerKind::Custom {
        return layer
            .params
            .get("indicator")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
    }
    Some(kind.as_str().to_owned())
}

pub fn kind_of_indicator(indicator: &str) -> Option<LayerKind> {
    match LayerKind::parse(indicator) {
        Some(k) if k != LayerKind::Custom && presettable(k) => Some(k),
        Some(_) => None,
        None => indicator.starts_with("ci_").then_some(LayerKind::Custom),
    }
}

pub fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("a preset needs a name".into());
    }
    if n.chars().count() > NAME_MAX {
        return Err(format!("a preset name has at most {NAME_MAX} characters"));
    }
    Ok(n.to_owned())
}

pub fn preset_id(all: &IndicatorPresets, name: &str) -> String {
    new_id(name, all.presets.iter().map(|p| p.id.as_str()))
}

pub fn find<'a>(
    all: &'a IndicatorPresets,
    reference: &str,
    indicator: Option<&str>,
) -> Result<&'a IndicatorPreset, String> {
    let of = |p: &&IndicatorPreset| indicator.is_none_or(|i| p.indicator == i);
    if let Some(p) = all.presets.iter().filter(of).find(|p| p.id == reference) {
        return Ok(p);
    }
    let named: Vec<&IndicatorPreset> = all
        .presets
        .iter()
        .filter(of)
        .filter(|p| same_name(&p.name, reference))
        .collect();
    match named.as_slice() {
        [p] => Ok(p),
        [] => Err(match indicator {
            Some(i) => {
                format!("{i} has no preset {reference}; chart.list_indicator_presets lists them")
            }
            None => format!("no preset {reference}; chart.list_indicator_presets lists them"),
        }),
        _ => Err(format!(
            "presets of several indicators are named {reference}: give the indicator"
        )),
    }
}

pub fn preset_params(spec: &IndicatorSpec, params: &Value) -> Result<Value, String> {
    let mut rest = Map::new();
    if let Some(o) = params.as_object() {
        for k in ["inputs", "style"] {
            if let Some(v) = o.get(k) {
                rest.insert(k.into(), v.clone());
            }
        }
    }
    let mut out = normalize_params(spec, &Value::Object(rest))?;
    if let Some(o) = out.as_object_mut() {
        o.remove("height");
    }
    Ok(out)
}

pub fn fit(spec: &IndicatorSpec, params: &Value) -> Value {
    let ok = |v: &Value| preset_params(spec, v).is_ok();
    let entries = |v: Option<&Value>| -> Vec<(String, Value)> {
        v.and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    };
    let mut inputs = Map::new();
    for (k, v) in entries(params.get("inputs")) {
        if ok(&json!({ "inputs": { k.clone(): v.clone() } })) {
            inputs.insert(k, v);
        }
    }
    let style_in = params.get("style");
    let mut style = Map::new();
    for part in ["plots", "fills"] {
        let mut kept = Map::new();
        for (k, v) in entries(style_in.and_then(|s| s.get(part))) {
            if ok(&json!({ "style": { part: { k.clone(): v.clone() } } })) {
                kept.insert(k, v);
            }
        }
        style.insert(part.into(), Value::Object(kept));
    }
    if let Some(l) = style_in.and_then(|s| s.get("labels"))
        && ok(&json!({ "style": { "labels": l } }))
    {
        style.insert("labels".into(), l.clone());
    }
    preset_params(spec, &json!({ "inputs": inputs, "style": style }))
        .or_else(|_| preset_params(spec, &json!({})))
        .unwrap_or_else(|_| json!({}))
}

pub fn read(value: &Value) -> IndicatorPresets {
    let mut out = IndicatorPresets::default();
    let Some(obj) = value.as_object() else {
        return out;
    };
    for raw in obj
        .get("presets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Ok(mut p) = serde_json::from_value::<IndicatorPreset>(raw.clone()) else {
            continue;
        };
        let Ok(name) = clean_name(&p.name) else {
            continue;
        };
        if p.id.is_empty()
            || kind_of_indicator(&p.indicator).is_none()
            || !p.params.is_object()
            || out
                .presets
                .iter()
                .any(|x| x.id == p.id || (x.indicator == p.indicator && same_name(&x.name, &name)))
        {
            continue;
        }
        p.name = name;
        out.presets.push(p);
        if out.presets.len() >= PRESETS_MAX {
            break;
        }
    }
    for (k, v) in obj
        .get("defaults")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if v.is_object() && kind_of_indicator(k).is_some() {
            out.defaults.insert(k.clone(), v.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indicators::indicator_spec;
    use crate::layout::OverlayNamespace;

    fn ema() -> IndicatorSpec {
        indicator_spec(LayerKind::Ema).unwrap()
    }

    #[test]
    fn presets_keep_settings_without_the_pane_or_the_indicator() {
        let rsi = indicator_spec(LayerKind::Rsi).unwrap();
        let p = preset_params(
            &rsi,
            &json!({"inputs": {"length": 7}, "height": 0.3, "indicator": "x"}),
        )
        .unwrap();
        assert_eq!(p["inputs"]["length"], 7);
        assert_eq!(p["inputs"]["upper"], 70.0, "complete");
        assert!(p.get("height").is_none());
        assert!(p.get("indicator").is_none());
        assert_eq!(p["style"]["labels"]["priceScale"], true);
        assert!(preset_params(&rsi, &json!({"inputs": {"length": 0}})).is_err());
    }

    #[test]
    fn a_preset_fits_the_indicator_as_it_is_now() {
        let spec = ema();
        let stored = json!({
            "inputs": {"length": 50, "gone": 3, "source": "nope"},
            "style": {"plots": {"ma": {"color": "teal", "width": 9}, "old": {}}, "labels": {"name": true}}
        });
        let p = fit(&spec, &stored);
        assert_eq!(p["inputs"]["length"], 50, "what still fits is kept");
        assert_eq!(
            p["inputs"]["source"], "close",
            "a value it no longer takes gives way"
        );
        assert!(p["inputs"].get("gone").is_none());
        assert_eq!(
            p["style"]["plots"]["ma"]["color"], spec.plots[0].default.color,
            "a style with a bad value gives way whole"
        );
        assert_eq!(p["style"]["labels"]["name"], true);
        assert_eq!(
            fit(&spec, &json!({"inputs": {"length": 9}}))["inputs"]["length"],
            9
        );
    }

    #[test]
    fn presets_are_read_leniently_and_found_by_id_or_name() {
        let all = read(&json!({
            "presets": [
                {"id": "fast", "name": " Fast ", "indicator": "ema", "params": {}},
                {"id": "fast", "name": "Dup id", "indicator": "ema", "params": {}},
                {"id": "fast-2", "name": "fast", "indicator": "ema", "params": {}},
                {"id": "fast-sma", "name": "Fast", "indicator": "sma", "params": {}},
                {"id": "c", "name": "Mine", "indicator": "ci_1", "params": {}},
                {"id": "x", "name": "Bad", "indicator": "levels", "params": {}},
                {"id": "", "name": "No id", "indicator": "ema", "params": {}},
                {"id": "y", "name": "No params", "indicator": "ema", "params": 3},
                "junk"
            ],
            "defaults": {"ema": {"inputs": {"length": 50}}, "nope": {}, "rsi": 1}
        }));
        assert_eq!(
            all.presets
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["fast", "fast-sma", "c"]
        );
        assert_eq!(all.presets[0].name, "Fast");
        assert_eq!(all.defaults.keys().collect::<Vec<_>>(), ["ema"]);
        assert_eq!(find(&all, "fast", None).unwrap().id, "fast", "an id first");
        assert_eq!(find(&all, "FAST", Some("sma")).unwrap().id, "fast-sma");
        assert!(
            find(&all, "Fast!", None).unwrap_err().contains("no preset"),
            "not found"
        );
        let two = IndicatorPresets {
            presets: vec![
                IndicatorPreset {
                    id: "a".into(),
                    name: "Same".into(),
                    indicator: "ema".into(),
                    params: json!({}),
                },
                IndicatorPreset {
                    id: "b".into(),
                    name: "Same".into(),
                    indicator: "sma".into(),
                    params: json!({}),
                },
            ],
            defaults: BTreeMap::new(),
        };
        assert!(
            find(&two, "same", None)
                .unwrap_err()
                .contains("give the indicator")
        );
        assert_eq!(find(&two, "same", Some("sma")).unwrap().id, "b");
        assert_eq!(preset_id(&all, "Fast"), "fast-2");
        assert!(clean_name("  ").is_err());
        assert!(clean_name(&"x".repeat(49)).is_err());
    }

    #[test]
    fn a_layer_names_the_indicator_its_presets_are_for() {
        let layer = |kind: &str, params: Value| ChartLayer {
            id: "x".into(),
            kind: kind.into(),
            params,
            visible: true,
            namespace: OverlayNamespace::User,
            session_id: None,
        };
        assert_eq!(
            indicator_of(&layer("ema", json!({}))).as_deref(),
            Some("ema")
        );
        assert_eq!(
            indicator_of(&layer("custom", json!({"indicator": "ci_9"}))).as_deref(),
            Some("ci_9")
        );
        assert_eq!(indicator_of(&layer("levels", json!({}))), None);
        assert_eq!(kind_of_indicator("rsi"), Some(LayerKind::Rsi));
        assert_eq!(kind_of_indicator("ci_9"), Some(LayerKind::Custom));
        assert_eq!(kind_of_indicator("custom"), None);
        assert_eq!(kind_of_indicator("levels"), None);
    }
}
