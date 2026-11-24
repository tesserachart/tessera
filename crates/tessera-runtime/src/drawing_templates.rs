use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_protocol::drawing_templates::{
    self as model, BUILT_IN, ChartApplyDrawingTemplateInput, ChartDeleteDrawingTemplateInput,
    ChartListDrawingTemplatesInput, ChartRenameDrawingTemplateInput, ChartSaveDrawingTemplateInput,
    ChartSetDefaultDrawingTemplateInput, DrawingDefaultOutput, DrawingLook,
    DrawingTemplateSavedOutput, DrawingTemplates, KEY, TOOLS_KEY,
};
use tessera_protocol::drawings::{ChartDrawingOutput, ChartUpdateDrawingInput, DrawingKind};
use tessera_protocol::templates::{clean_name, same_name};
use tessera_tools::ToolError;

use crate::layout::LayoutService;
use crate::settings::SettingsService;

pub struct DrawingTemplateService {
    settings: Arc<SettingsService>,
    layouts: Arc<LayoutService>,
    writes: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for DrawingTemplateService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DrawingTemplateService")
            .finish_non_exhaustive()
    }
}

fn invalid(e: String) -> ToolError {
    ToolError::invalid_input(e)
}

fn not_found(e: String) -> ToolError {
    ToolError::not_found(e)
}

impl DrawingTemplateService {
    pub fn new(settings: Arc<SettingsService>, layouts: Arc<LayoutService>) -> Arc<Self> {
        Arc::new(Self {
            settings,
            layouts,
            writes: tokio::sync::Mutex::new(()),
        })
    }

    fn all(&self) -> DrawingTemplates {
        model::read(&self.settings.value(KEY).unwrap_or(Value::Null))
    }

    pub fn list(&self, input: &ChartListDrawingTemplatesInput) -> DrawingTemplates {
        let mut all = self.all();
        if let Some(k) = input.kind {
            all.templates.retain(|t| t.kind == k);
        }
        all
    }

    fn styles(&self) -> Option<Value> {
        self.settings
            .value(TOOLS_KEY)
            .and_then(|v| v.get("styles").cloned())
    }

    async fn store(&self, all: &DrawingTemplates, origin: &Origin) -> Result<(), ToolError> {
        let value = serde_json::to_value(all).map_err(|e| ToolError::internal(e.to_string()))?;
        self.settings.set(KEY, value, origin).await.map(|_| ())
    }

    async fn set_new_drawings(
        &self,
        kind: DrawingKind,
        look: Option<&DrawingLook>,
        origin: &Origin,
    ) -> Result<(), ToolError> {
        let styles = model::styles_with(self.styles().as_ref(), kind, look);
        self.settings
            .set(TOOLS_KEY, json!({"styles": styles}), origin)
            .await
            .map(|_| ())
    }

    pub async fn save(
        &self,
        input: ChartSaveDrawingTemplateInput,
        origin: &Origin,
    ) -> Result<DrawingTemplateSavedOutput, ToolError> {
        let name = clean_name(&input.name).map_err(invalid)?;
        let (kind, look) = match &input.drawing_id {
            Some(id) => {
                if input.kind.is_some()
                    || input.style.is_some()
                    || input.label.is_some()
                    || input.levels.is_some()
                {
                    return Err(invalid(
                        "give either drawingId (its look is saved) or kind with style, label and levels".into(),
                    ));
                }
                let chart = self
                    .layouts
                    .chart_state(input.layout_id.as_deref(), input.tile_id.as_deref())?
                    .chart;
                let d =
                    chart.drawings.iter().find(|d| &d.id == id).ok_or_else(|| {
                        not_found(format!("no drawing {id} on {}", chart.tile_id))
                    })?;
                (d.kind, model::look_of(d))
            }
            None => {
                let kind = input.kind.ok_or_else(|| {
                    invalid("give drawingId, or the kind the template styles".into())
                })?;
                let look = model::look_from_input(
                    kind,
                    input.style.as_ref(),
                    input.label.as_ref(),
                    input.levels.as_deref(),
                )
                .map_err(invalid)?;
                (kind, look)
            }
        };
        let _serial = self.writes.lock().await;
        let mut all = self.all();
        let id = model::fresh_id(&all, &name);
        let (template, replaced) =
            model::put(&mut all, model::template_of(id, name, kind, look.clone()))
                .map_err(invalid)?;
        self.store(&all, origin).await?;
        let new_drawings = input.new_drawings == Some(true);
        if new_drawings {
            self.set_new_drawings(kind, Some(&look), origin).await?;
        }
        Ok(DrawingTemplateSavedOutput {
            template,
            replaced,
            new_drawings,
        })
    }

    pub async fn apply(
        &self,
        input: ChartApplyDrawingTemplateInput,
        origin: &Origin,
    ) -> Result<ChartDrawingOutput, ToolError> {
        let chart = self
            .layouts
            .chart_state(input.layout_id.as_deref(), input.tile_id.as_deref())?
            .chart;
        let kind = chart
            .drawings
            .iter()
            .find(|d| d.id == input.drawing_id)
            .map(|d| d.kind)
            .ok_or_else(|| {
                not_found(format!(
                    "no drawing {} on {}",
                    input.drawing_id, chart.tile_id
                ))
            })?;
        let all = self.all();
        let look = if same_name(&input.template, BUILT_IN)
            && model::find(&all, &input.template, Some(kind)).is_err()
        {
            model::built_in(kind)
        } else {
            model::template_look(model::find(&all, &input.template, Some(kind)).map_err(not_found)?)
        };
        let (style, label, levels) = model::restyle_input(&look);
        self.layouts
            .update_drawing(
                ChartUpdateDrawingInput {
                    tile_id: Some(chart.tile_id.clone()),
                    layout_id: input.layout_id,
                    drawing_id: input.drawing_id,
                    points: None,
                    style: Some(style),
                    text: None,
                    levels,
                    label,
                    locked: None,
                },
                origin,
            )
            .await
    }

    pub async fn set_default(
        &self,
        input: ChartSetDefaultDrawingTemplateInput,
        origin: &Origin,
    ) -> Result<DrawingDefaultOutput, ToolError> {
        let _serial = self.writes.lock().await;
        let all = self.all();
        match &input.template {
            Some(reference) => {
                let t = model::find(&all, reference, input.kind)
                    .map_err(not_found)?
                    .clone();
                self.set_new_drawings(t.kind, Some(&model::template_look(&t)), origin)
                    .await?;
                Ok(DrawingDefaultOutput {
                    kind: t.kind,
                    template: Some(t),
                })
            }
            None => {
                let kind = input.kind.ok_or_else(|| {
                    invalid("give the template, or the kind whose new drawings take the built-in look again".into())
                })?;
                self.set_new_drawings(kind, None, origin).await?;
                Ok(DrawingDefaultOutput {
                    kind,
                    template: None,
                })
            }
        }
    }

    pub async fn rename(
        &self,
        input: ChartRenameDrawingTemplateInput,
        origin: &Origin,
    ) -> Result<DrawingTemplates, ToolError> {
        let name = clean_name(&input.name).map_err(invalid)?;
        let _serial = self.writes.lock().await;
        let mut all = self.all();
        let t = model::find(&all, &input.template, input.kind)
            .map_err(not_found)?
            .clone();
        if all
            .templates
            .iter()
            .any(|x| x.id != t.id && x.kind == t.kind && same_name(&x.name, &name))
        {
            return Err(ToolError::conflict(format!(
                "another {} template is named {name}",
                t.kind.as_str()
            )));
        }
        if let Some(x) = all.templates.iter_mut().find(|x| x.id == t.id) {
            x.name = name;
        }
        self.store(&all, origin).await?;
        Ok(all)
    }

    pub async fn delete(
        &self,
        input: ChartDeleteDrawingTemplateInput,
        origin: &Origin,
    ) -> Result<DrawingTemplates, ToolError> {
        let _serial = self.writes.lock().await;
        let mut all = self.all();
        let id = model::find(&all, &input.template, input.kind)
            .map_err(not_found)?
            .id
            .clone();
        all.templates.retain(|t| t.id != id);
        self.store(&all, origin).await?;
        Ok(all)
    }
}
