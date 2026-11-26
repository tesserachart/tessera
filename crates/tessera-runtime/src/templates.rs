use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_protocol::io::ChartChangeOutput;
use tessera_protocol::layers::LayerKind;
use tessera_protocol::layout::ChartType;
use tessera_protocol::templates::{
    self as model, ChartApplyTemplateInput, ChartDeleteTemplateInput, ChartEditTemplateInput,
    ChartSaveTemplateInput, ChartTemplate, ChartTemplateSavedOutput, ChartTemplates, LAYERS_MAX,
    NAME_MAX, TEMPLATES_MAX, TemplateLayer,
};
use tessera_tools::ToolError;

use crate::layout::LayoutService;
use crate::settings::SettingsService;

pub const KEY: &str = "chart.templates";

pub fn default_value() -> Value {
    let layer = |kind: LayerKind| TemplateLayer {
        kind: kind.as_str().to_owned(),
        params: kind.validate_params(&Value::Null).unwrap_or(Value::Null),
        visible: true,
    };
    let standard = ChartTemplate {
        id: "standard".into(),
        name: "Standard".into(),
        chart_type: None,
        layers: vec![layer(LayerKind::Volume), layer(LayerKind::Vwap)],
    };
    serde_json::to_value(ChartTemplates {
        templates: vec![standard],
        default_id: None,
    })
    .unwrap_or(Value::Null)
}

pub fn schema() -> Value {
    let layer = json!({"type": "object", "additionalProperties": false, "required": ["kind"],
    "properties": {
        "kind": {"type": "string", "enum": model::templatable_kinds()},
        "params": {"type": "object"},
        "visible": {"type": "boolean"},
    }});
    let template = json!({"type": "object", "additionalProperties": false,
    "required": ["id", "name"],
    "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": 64},
        "name": {"type": "string", "minLength": 1, "maxLength": NAME_MAX},
        "chartType": {"type": "string", "enum": ["candles", "bars", "line"]},
        "layers": {"type": "array", "maxItems": LAYERS_MAX, "items": layer},
    }});
    json!({"type": "object", "additionalProperties": false, "properties": {
        "templates": {"type": "array", "maxItems": TEMPLATES_MAX, "items": template},
        "defaultId": {"type": "string", "minLength": 1, "maxLength": 64},
    }})
}

pub fn known_layers(value: &Value) -> Value {
    let kinds = model::templatable_kinds();
    let mut v = value.clone();
    let templates = v.get_mut("templates").and_then(Value::as_array_mut);
    for t in templates.into_iter().flatten() {
        if let Some(layers) = t.get_mut("layers").and_then(Value::as_array_mut) {
            layers.retain(|l| {
                l.get("kind")
                    .and_then(Value::as_str)
                    .is_none_or(|k| kinds.contains(&k))
            });
        }
    }
    v
}

pub fn migrated_value(new_chart_layers: &Value) -> Option<Value> {
    let rows = new_chart_layers.as_array()?;
    let on: Vec<&str> = rows.iter().filter_map(Value::as_str).collect();
    let keep: Vec<LayerKind> = [LayerKind::Volume, LayerKind::Vwap]
        .into_iter()
        .filter(|k| on.contains(&k.as_str()))
        .collect();
    if keep.is_empty() {
        return None;
    }
    let mut value = model::read(&default_value());
    if let Some(t) = value.templates.first_mut() {
        t.layers
            .retain(|l| keep.iter().any(|k| k.as_str() == l.kind));
        value.default_id = Some(t.id.clone());
    }
    serde_json::to_value(value).ok()
}

pub async fn migrate_new_chart_layers(settings: &Arc<SettingsService>) -> Result<(), ToolError> {
    let Some(Value::Object(prefs)) = settings.stored("ui.preferences") else {
        return Ok(());
    };
    let Some(old) = prefs.get("newChartLayers").cloned() else {
        return Ok(());
    };
    if settings.stored(KEY).is_none()
        && let Some(value) = migrated_value(&old)
    {
        settings.set(KEY, value, &Origin::User).await?;
    }
    settings
        .set(
            "ui.preferences",
            serde_json::json!({"newChartLayers": null}),
            &Origin::User,
        )
        .await?;
    Ok(())
}

pub fn unique_name(name: &str, taken: &[String], max: usize) -> String {
    let fits = |base: &str, suffix: &str| {
        let room = max.saturating_sub(suffix.chars().count());
        let kept: String = base.trim().chars().take(room).collect();
        format!("{}{suffix}", kept.trim_end())
    };
    std::iter::once(String::new())
        .chain((2u64..).map(|n| format!(" ({n})")))
        .map(|suffix| fits(name, &suffix))
        .find(|c| !taken.iter().any(|t| model::same_name(t, c)))
        .expect("unbounded")
}

pub struct TemplateService {
    settings: Arc<SettingsService>,
    layouts: Arc<LayoutService>,
    writes: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for TemplateService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TemplateService").finish_non_exhaustive()
    }
}

fn invalid(e: String) -> ToolError {
    ToolError::invalid_input(e)
}

impl TemplateService {
    pub fn new(settings: Arc<SettingsService>, layouts: Arc<LayoutService>) -> Arc<Self> {
        Arc::new(Self {
            settings,
            layouts,
            writes: tokio::sync::Mutex::new(()),
        })
    }

    pub fn list(&self) -> ChartTemplates {
        model::read(&self.settings.value(KEY).unwrap_or(Value::Null))
    }

    fn find(all: &ChartTemplates, reference: &str) -> Result<ChartTemplate, ToolError> {
        model::find(all, reference).cloned().ok_or_else(|| {
            ToolError::not_found(format!(
                "no template {reference}; chart.list_templates lists them"
            ))
        })
    }

    async fn store(&self, all: &ChartTemplates, origin: &Origin) -> Result<(), ToolError> {
        let value = serde_json::to_value(all).map_err(|e| ToolError::internal(e.to_string()))?;
        self.settings.set(KEY, value, origin).await.map(|_| ())
    }

    pub async fn save(
        &self,
        input: ChartSaveTemplateInput,
        origin: &Origin,
    ) -> Result<ChartTemplateSavedOutput, ToolError> {
        let name = model::clean_name(&input.name).map_err(invalid)?;
        let chart = self
            .layouts
            .chart_state(input.layout_id.as_deref(), input.tile_id.as_deref())?
            .chart;
        let layers = model::capture(&chart);
        let chart_type = input.chart_type.or(chart.chart_type);
        let _serial = self.writes.lock().await;
        let mut all = self.list();
        let (template, replaced) = match all
            .templates
            .iter_mut()
            .find(|t| model::same_name(&t.name, &name))
        {
            Some(t) => {
                t.name = name;
                t.chart_type = chart_type;
                t.layers = layers;
                (t.clone(), true)
            }
            None => {
                if all.templates.len() >= TEMPLATES_MAX {
                    return Err(ToolError::invalid_input(format!(
                        "at most {TEMPLATES_MAX} templates: delete one first"
                    )));
                }
                let id = model::new_id(&name, all.templates.iter().map(|t| t.id.as_str()));
                let t = ChartTemplate {
                    id,
                    name,
                    chart_type,
                    layers,
                };
                all.templates.push(t.clone());
                (t, false)
            }
        };
        match input.default {
            Some(true) => all.default_id = Some(template.id.clone()),
            Some(false) if all.default_id.as_deref() == Some(template.id.as_str()) => {
                all.default_id = None;
            }
            _ => {}
        }
        self.store(&all, origin).await?;
        Ok(ChartTemplateSavedOutput {
            template,
            replaced,
            default_id: all.default_id,
        })
    }

    pub async fn add(
        &self,
        name: &str,
        chart_type: Option<ChartType>,
        layers: Vec<TemplateLayer>,
        origin: &Origin,
    ) -> Result<(ChartTemplates, ChartTemplate), ToolError> {
        let name = model::clean_name(name).map_err(invalid)?;
        let layers = layers
            .into_iter()
            .take(LAYERS_MAX)
            .map(|l| model::validate_layer(&l).map(|params| TemplateLayer { params, ..l }))
            .collect::<Result<Vec<_>, _>>()
            .map_err(invalid)?;
        let _serial = self.writes.lock().await;
        let mut all = self.list();
        if all.templates.len() >= TEMPLATES_MAX {
            return Err(ToolError::invalid_input(format!(
                "You have {TEMPLATES_MAX} templates. Delete one first."
            )));
        }
        let taken: Vec<String> = all.templates.iter().map(|t| t.name.clone()).collect();
        let name = unique_name(&name, &taken, NAME_MAX);
        let template = ChartTemplate {
            id: model::new_id(&name, all.templates.iter().map(|t| t.id.as_str())),
            name,
            chart_type,
            layers,
        };
        all.templates.push(template.clone());
        self.store(&all, origin).await?;
        Ok((all, template))
    }

    pub async fn apply(
        &self,
        input: ChartApplyTemplateInput,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let all = self.list();
        let builtin = model::find(&all, &input.template).is_none()
            && (model::same_name(&input.template, crate::layout::ORDER_FLOW_TEMPLATE)
                || input.template.trim() == crate::layout::ORDER_FLOW_TEMPLATE_ID);
        let template = if builtin {
            crate::layout::order_flow_template()
        } else {
            Self::find(&all, &input.template)?
        };
        self.layouts
            .apply_template(
                input.layout_id.as_deref(),
                input.tile_id.as_deref(),
                &template,
                origin,
            )
            .await
    }

    pub async fn edit(
        &self,
        input: ChartEditTemplateInput,
        origin: &Origin,
    ) -> Result<ChartTemplates, ToolError> {
        if input.name.is_none() && input.default.is_none() {
            return Err(ToolError::invalid_input(
                "nothing to change: give name and/or default",
            ));
        }
        let name = input
            .name
            .as_deref()
            .map(model::clean_name)
            .transpose()
            .map_err(invalid)?;
        let _serial = self.writes.lock().await;
        let mut all = self.list();
        let id = Self::find(&all, &input.template)?.id;
        if let Some(name) = name {
            if all
                .templates
                .iter()
                .any(|t| t.id != id && model::same_name(&t.name, &name))
            {
                return Err(ToolError::conflict(format!(
                    "another template is named {name}"
                )));
            }
            if let Some(t) = all.templates.iter_mut().find(|t| t.id == id) {
                t.name = name;
            }
        }
        match input.default {
            Some(true) => all.default_id = Some(id),
            Some(false) if all.default_id.as_deref() == Some(id.as_str()) => {
                all.default_id = None;
            }
            _ => {}
        }
        self.store(&all, origin).await?;
        Ok(all)
    }

    pub async fn delete(
        &self,
        input: ChartDeleteTemplateInput,
        origin: &Origin,
    ) -> Result<ChartTemplates, ToolError> {
        let _serial = self.writes.lock().await;
        let mut all = self.list();
        let id = Self::find(&all, &input.template)?.id;
        all.templates.retain(|t| t.id != id);
        if all.default_id.as_deref() == Some(id.as_str()) {
            all.default_id = None;
        }
        self.store(&all, origin).await?;
        Ok(all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::validate;
    use tessera_core::clock::ManualClock;
    use tessera_core::{SharedClock, Timestamp};
    use tessera_store::Store;

    #[test]
    fn the_default_has_no_default_template_and_standard_stays_complete_and_valid() {
        let v = default_value();
        assert!(validate(&schema(), &v).is_ok());
        let t = model::read(&v);
        assert_eq!(t.default_id, None, "a new chart starts without studies");
        let kinds: Vec<&str> = t.templates[0]
            .layers
            .iter()
            .map(|l| l.kind.as_str())
            .collect();
        assert_eq!(kinds, ["volume", "vwap"]);
        assert_eq!(t.templates[0].layers[1].params["inputs"]["band1"], false);
        assert_eq!(
            model::read(&v),
            t,
            "stored complete: reading changes nothing"
        );
    }

    #[test]
    fn the_schema_refuses_what_a_template_cannot_hold() {
        let s = schema();
        let ok = json!({"templates": [{"id": "a", "name": "A", "chartType": "bars",
            "layers": [{"kind": "ema", "params": {}, "visible": false}]}], "defaultId": "a"});
        assert!(validate(&s, &ok).is_ok());
        for bad in [
            json!({"templates": [{"id": "a", "name": "A", "layers": [{"kind": "levels"}]}]}),
            json!({"templates": [{"id": "a", "name": "A", "chartType": "renko"}]}),
            json!({"templates": [{"id": "a"}]}),
            json!({"templates": [{"id": "a", "name": "A", "layers": [{"params": {}}]}]}),
            json!({"templates": [], "default": "a"}),
            json!({"templates": [{"id": "a", "name": "A", "colour": "red"}]}),
        ] {
            assert!(validate(&s, &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_name_already_taken_gets_the_next_number_and_still_fits() {
        let taken = vec!["Scalp".to_owned(), "scalp (2)".to_owned()];
        assert_eq!(unique_name("Swing", &taken, NAME_MAX), "Swing");
        assert_eq!(unique_name(" Scalp ", &taken, NAME_MAX), "Scalp (3)");
        let long = "x".repeat(NAME_MAX);
        let named = unique_name(&long, std::slice::from_ref(&long), NAME_MAX);
        assert_eq!(named.chars().count(), NAME_MAX);
        assert!(named.ends_with(" (2)"), "{named}");
    }

    #[test]
    fn new_chart_layers_become_the_standard_template() {
        let both = model::read(&migrated_value(&json!(["volume", "vwap"])).unwrap());
        assert_eq!(both.default_id.as_deref(), Some("standard"));
        assert_eq!(both.templates[0].layers.len(), 2);
        let v = model::read(&migrated_value(&json!(["vwap"])).unwrap());
        assert_eq!(v.default_id.as_deref(), Some("standard"));
        assert_eq!(v.templates[0].layers.len(), 1);
        assert_eq!(v.templates[0].layers[0].kind, "vwap");
        assert_eq!(
            migrated_value(&json!([])),
            None,
            "none on: new charts already start empty"
        );
        assert_eq!(migrated_value(&json!("junk")), None);
    }

    async fn settings() -> (Store, SharedClock, Arc<SettingsService>) {
        let store = Store::open_in_memory().unwrap();
        let clock: SharedClock = Arc::new(ManualClock::new(Timestamp(1)));
        let s = SettingsService::load(store.clone(), clock.clone()).unwrap();
        (store, clock, s)
    }

    #[tokio::test]
    async fn the_migration_moves_the_preference_once() {
        let (store, clock, s) = settings().await;
        let prefs = json!({"newChartLayers": ["volume"], "panelOpen": false});
        s.set("ui.preferences", prefs, &Origin::User).await.unwrap();
        migrate_new_chart_layers(&s).await.unwrap();
        assert_eq!(
            s.stored("ui.preferences"),
            Some(json!({"panelOpen": false})),
            "the field goes, the rest stays"
        );
        let t = model::read(&s.value(KEY).unwrap());
        assert_eq!(t.templates[0].layers.len(), 1);
        assert_eq!(t.templates[0].layers[0].kind, "volume");
        let again = SettingsService::load(store, clock).unwrap();
        migrate_new_chart_layers(&again).await.unwrap();
        assert_eq!(model::read(&again.value(KEY).unwrap()), t);

        let (_, _, s) = settings().await;
        let mine = json!({"templates": [{"id": "x", "name": "X"}]});
        s.set(KEY, mine.clone(), &Origin::User).await.unwrap();
        s.set(
            "ui.preferences",
            json!({"newChartLayers": []}),
            &Origin::User,
        )
        .await
        .unwrap();
        migrate_new_chart_layers(&s).await.unwrap();
        assert_eq!(s.stored(KEY), Some(mine));
        assert_eq!(s.stored("ui.preferences"), Some(json!({})));

        let (_, _, s) = settings().await;
        migrate_new_chart_layers(&s).await.unwrap();
        assert_eq!(s.stored(KEY), None);
        assert_eq!(s.stored("ui.preferences"), None);
    }
}
