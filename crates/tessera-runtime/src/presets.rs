use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_protocol::indicators::{CustomIndicators, IndicatorSpec, custom_ref, merge_patch};
use tessera_protocol::io::{ChartChangeOutput, ChartUpdateLayerInput};
use tessera_protocol::layers::LayerKind;
use tessera_protocol::layout::ChartLayer;
use tessera_protocol::presets::{
    self as model, ChartApplyIndicatorPresetInput, ChartDeleteIndicatorPresetInput,
    ChartEditIndicatorPresetInput, ChartIndicatorPresetSavedOutput, ChartSaveIndicatorPresetInput,
    ChartSetIndicatorDefaultInput, DEFAULT_REF, FACTORY_REF, IndicatorPreset, IndicatorPresets,
    NAME_MAX, PRESETS_MAX,
};
use tessera_protocol::templates::same_name;
use tessera_tools::ToolError;

use crate::layout::LayoutService;
use crate::settings::SettingsService;

pub const KEY: &str = "chart.indicatorPresets";

pub fn default_value() -> Value {
    json!({ "presets": [], "defaults": {} })
}

pub fn schema() -> Value {
    let preset = json!({"type": "object", "additionalProperties": false,
    "required": ["id", "name", "indicator", "params"],
    "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": 64},
        "name": {"type": "string", "minLength": 1, "maxLength": NAME_MAX},
        "indicator": {"type": "string", "minLength": 1, "maxLength": 64},
        "params": {"type": "object"},
    }});
    json!({"type": "object", "additionalProperties": false, "properties": {
        "presets": {"type": "array", "maxItems": PRESETS_MAX, "items": preset},
        "defaults": {"type": "object", "additionalProperties": {"type": "object"}},
    }})
}

pub struct PresetService {
    settings: Arc<SettingsService>,
    layouts: Arc<LayoutService>,
    custom: Option<Arc<dyn CustomIndicators>>,
    writes: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for PresetService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PresetService").finish_non_exhaustive()
    }
}

fn invalid(e: String) -> ToolError {
    ToolError::invalid_input(e)
}

impl PresetService {
    pub fn new(
        settings: Arc<SettingsService>,
        layouts: Arc<LayoutService>,
        custom: Option<Arc<dyn CustomIndicators>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            settings,
            layouts,
            custom,
            writes: tokio::sync::Mutex::new(()),
        })
    }

    pub fn list(&self) -> IndicatorPresets {
        model::read(&self.settings.value(KEY).unwrap_or(Value::Null))
    }

    pub fn list_for(&self, indicator: Option<&str>) -> IndicatorPresets {
        let mut all = self.list();
        if let Some(i) = indicator {
            all.presets.retain(|p| p.indicator == i);
            all.defaults.retain(|k, _| k == i);
        }
        all
    }

    async fn store(&self, all: &IndicatorPresets, origin: &Origin) -> Result<(), ToolError> {
        let value = serde_json::to_value(all).map_err(|e| ToolError::internal(e.to_string()))?;
        self.settings.set(KEY, value, origin).await.map(|_| ())
    }

    fn spec_of(&self, indicator: &str, version: Option<u32>) -> Result<IndicatorSpec, ToolError> {
        match model::kind_of_indicator(indicator) {
            Some(LayerKind::Custom) => {
                let c = self.custom.as_ref().ok_or_else(|| {
                    ToolError::unavailable("custom indicators are not available here")
                })?;
                c.custom_spec(indicator, version)
                    .map_err(ToolError::not_found)
            }
            Some(kind) => kind
                .indicator()
                .ok_or_else(|| ToolError::invalid_input(format!("{kind} takes no presets"))),
            None => Err(ToolError::invalid_input(format!(
                "{indicator} is not an indicator: a built-in's kind (ema) or a custom indicator's id (ci_…)"
            ))),
        }
    }

    fn layer(
        &self,
        layout_id: Option<&str>,
        tile_id: Option<&str>,
        layer_id: &str,
    ) -> Result<(ChartLayer, String, IndicatorSpec), ToolError> {
        let chart = self.layouts.chart_state(layout_id, tile_id)?.chart;
        let layer = chart
            .layers
            .iter()
            .find(|l| l.id == layer_id)
            .cloned()
            .ok_or_else(|| ToolError::not_found(format!("no layer {layer_id} on the chart")))?;
        let indicator = model::indicator_of(&layer).ok_or_else(|| {
            ToolError::invalid_input(format!(
                "{layer_id} is not an indicator: it takes no presets"
            ))
        })?;
        let version = if layer.kind == LayerKind::Custom.as_str() {
            custom_ref(&layer.params).map_err(invalid)?.1
        } else {
            None
        };
        let spec = self.spec_of(&indicator, version)?;
        Ok((layer, indicator, spec))
    }

    fn settings_from(
        &self,
        layout_id: Option<&str>,
        tile_id: Option<&str>,
        layer_id: Option<&str>,
        indicator: Option<&str>,
        params: Option<&Value>,
    ) -> Result<(String, Value), ToolError> {
        match (layer_id, indicator) {
            (Some(layer_id), _) => {
                if params.is_some() {
                    return Err(ToolError::invalid_input(
                        "give a layer (its settings are kept) or params, not both",
                    ));
                }
                let (layer, indicator, spec) = self.layer(layout_id, tile_id, layer_id)?;
                let params = model::preset_params(&spec, &layer.params).map_err(invalid)?;
                Ok((indicator, params))
            }
            (None, Some(indicator)) => {
                let spec = self.spec_of(indicator, None)?;
                let params = model::preset_params(&spec, params.unwrap_or(&json!({})))
                    .map_err(|e| invalid(format!("{indicator} params: {e}")))?;
                Ok((indicator.to_owned(), params))
            }
            (None, None) => Err(ToolError::invalid_input(
                "give the indicator layer (layer_id) or the indicator and its params",
            )),
        }
    }

    pub async fn save(
        &self,
        input: ChartSaveIndicatorPresetInput,
        origin: &Origin,
    ) -> Result<ChartIndicatorPresetSavedOutput, ToolError> {
        let name = model::clean_name(&input.name).map_err(invalid)?;
        let (indicator, params) = self.settings_from(
            input.layout_id.as_deref(),
            input.tile_id.as_deref(),
            input.layer_id.as_deref(),
            input.indicator.as_deref(),
            input.params.as_ref(),
        )?;
        let _serial = self.writes.lock().await;
        let mut all = self.list();
        let (preset, replaced) = match all
            .presets
            .iter_mut()
            .find(|p| p.indicator == indicator && same_name(&p.name, &name))
        {
            Some(p) => {
                p.name = name;
                p.params = params;
                (p.clone(), true)
            }
            None => {
                if all.presets.len() >= PRESETS_MAX {
                    return Err(ToolError::invalid_input(format!(
                        "at most {PRESETS_MAX} presets: delete one first"
                    )));
                }
                let p = IndicatorPreset {
                    id: model::preset_id(&all, &name),
                    name,
                    indicator,
                    params,
                };
                all.presets.push(p.clone());
                (p, false)
            }
        };
        self.store(&all, origin).await?;
        Ok(ChartIndicatorPresetSavedOutput { preset, replaced })
    }

    fn resolve(
        all: &IndicatorPresets,
        indicator: &str,
        spec: &IndicatorSpec,
        reference: &str,
    ) -> Result<Value, ToolError> {
        let r = reference.trim();
        let own = || model::fit(spec, &json!({}));
        let preset = model::find(all, r, Some(indicator));
        if preset.is_err() && same_name(r, FACTORY_REF) {
            return Ok(own());
        }
        if preset.is_err() && same_name(r, DEFAULT_REF) {
            return Ok(all
                .defaults
                .get(indicator)
                .map_or_else(own, |d| model::fit(spec, d)));
        }
        Ok(model::fit(
            spec,
            &preset.map_err(ToolError::not_found)?.params,
        ))
    }

    pub async fn apply(
        &self,
        input: ChartApplyIndicatorPresetInput,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let (_, indicator, spec) = self.layer(
            input.layout_id.as_deref(),
            input.tile_id.as_deref(),
            &input.layer_id,
        )?;
        let params = Self::resolve(&self.list(), &indicator, &spec, &input.preset)?;
        self.layouts
            .update_layer(
                ChartUpdateLayerInput {
                    tile_id: input.tile_id,
                    layout_id: input.layout_id,
                    layer_id: input.layer_id,
                    params: Some(json!({ "inputs": params["inputs"], "style": params["style"] })),
                    visible: None,
                },
                origin,
            )
            .await
    }

    pub async fn edit(
        &self,
        input: ChartEditIndicatorPresetInput,
        origin: &Origin,
    ) -> Result<IndicatorPresets, ToolError> {
        let name = model::clean_name(&input.name).map_err(invalid)?;
        let _serial = self.writes.lock().await;
        let mut all = self.list();
        let found = model::find(&all, &input.preset, input.indicator.as_deref())
            .map_err(ToolError::not_found)?
            .clone();
        if all.presets.iter().any(|p| {
            p.id != found.id && p.indicator == found.indicator && same_name(&p.name, &name)
        }) {
            return Err(ToolError::conflict(format!(
                "another {} preset is named {name}",
                found.indicator
            )));
        }
        if let Some(p) = all.presets.iter_mut().find(|p| p.id == found.id) {
            p.name = name;
        }
        self.store(&all, origin).await?;
        Ok(all)
    }

    pub async fn delete(
        &self,
        input: ChartDeleteIndicatorPresetInput,
        origin: &Origin,
    ) -> Result<IndicatorPresets, ToolError> {
        let _serial = self.writes.lock().await;
        let mut all = self.list();
        let id = model::find(&all, &input.preset, input.indicator.as_deref())
            .map_err(ToolError::not_found)?
            .id
            .clone();
        all.presets.retain(|p| p.id != id);
        self.store(&all, origin).await?;
        Ok(all)
    }

    pub async fn set_default(
        &self,
        input: ChartSetIndicatorDefaultInput,
        origin: &Origin,
    ) -> Result<IndicatorPresets, ToolError> {
        let given = [
            input.layer_id.is_some(),
            input.preset.is_some(),
            input.params.is_some(),
            input.clear == Some(true),
        ]
        .iter()
        .filter(|x| **x)
        .count();
        if given > 1 {
            return Err(ToolError::invalid_input(
                "give one of layer_id, preset, params or clear",
            ));
        }
        let (indicator, params) = if input.clear == Some(true) || input.preset.is_some() {
            let indicator = input.indicator.clone().ok_or_else(|| {
                ToolError::invalid_input("give the indicator (a kind, or a custom indicator's id)")
            })?;
            self.spec_of(&indicator, None)?;
            (indicator, None)
        } else {
            let (i, p) = self.settings_from(
                input.layout_id.as_deref(),
                input.tile_id.as_deref(),
                input.layer_id.as_deref(),
                input.indicator.as_deref(),
                input.params.as_ref(),
            )?;
            (i, Some(p))
        };
        let _serial = self.writes.lock().await;
        let mut all = self.list();
        let params = match (&input.preset, params) {
            (Some(r), _) => Some(
                model::find(&all, r, Some(&indicator))
                    .map_err(ToolError::not_found)?
                    .params
                    .clone(),
            ),
            (None, p) => p,
        };
        match params {
            Some(p) => {
                all.defaults.insert(indicator, p);
            }
            None => {
                all.defaults.remove(&indicator);
            }
        }
        self.store(&all, origin).await?;
        Ok(all)
    }

    pub fn start_params(&self, kind: LayerKind, params: Option<&Value>) -> Option<Value> {
        if !model::presettable(kind) {
            return None;
        }
        let indicator = if kind == LayerKind::Custom {
            custom_ref(params?).ok()?.0
        } else {
            kind.as_str().to_owned()
        };
        let all = self.list();
        let saved = all.defaults.get(&indicator)?;
        let version = params.and_then(|p| custom_ref(p).ok()).and_then(|r| r.1);
        let spec = self.spec_of(&indicator, version).ok()?;
        let mut base = model::fit(&spec, saved);
        if let Some(p) = params {
            merge_patch(&mut base, p);
        }
        Some(base)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::validate;

    #[test]
    fn the_schema_takes_the_default_and_refuses_bad_values() {
        let s = schema();
        validate(&s, &default_value()).unwrap();
        validate(
            &s,
            &json!({"presets": [{"id": "a", "name": "A", "indicator": "ema", "params": {}}], "defaults": {"ema": {}}}),
        )
        .unwrap();
        assert!(validate(&s, &json!({"presets": [{"id": "a", "name": "A"}]})).is_err());
        assert!(validate(&s, &json!({"defaults": {"ema": 3}})).is_err());
        assert!(validate(&s, &json!({"other": 1})).is_err());
    }
}
