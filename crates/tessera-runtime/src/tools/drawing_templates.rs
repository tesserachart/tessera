use std::sync::Arc;

use async_trait::async_trait;
use tessera_protocol::drawing_templates::{
    ChartApplyDrawingTemplateInput, ChartDeleteDrawingTemplateInput,
    ChartListDrawingTemplatesInput, ChartRenameDrawingTemplateInput, ChartSaveDrawingTemplateInput,
    ChartSetDefaultDrawingTemplateInput, DrawingDefaultOutput, DrawingTemplateSavedOutput,
    DrawingTemplates,
};
use tessera_protocol::drawings::ChartDrawingOutput;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::drawing_templates::DrawingTemplateService;

fn list_summary(o: &DrawingTemplates) -> Option<String> {
    Some(format!("{} drawing templates", o.templates.len()))
}

struct ListDrawingTemplates(Arc<DrawingTemplateService>);

#[async_trait]
impl Tool for ListDrawingTemplates {
    type Input = ChartListDrawingTemplatesInput;
    type Output = DrawingTemplates;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.list_drawing_templates",
            "List drawing templates",
            RiskTier::Read,
        )
        .description("The user's drawing templates (all kinds, or one kind's): each a name, the kind of drawing it styles, its style (color, width, line, extend), its label's look (color, size, bold, italic, align, position, showPrice, showLevels; never words) and a Fibonacci drawing's levels. chart.apply_drawing_template puts one on a drawing; what new drawings of a kind take is the chart.drawingTools setting's styles (chart.set_default_drawing_template).")
        .activity("Listed drawing templates")
        .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ChartListDrawingTemplatesInput,
    ) -> Result<DrawingTemplates, ToolError> {
        Ok(self.0.list(&input))
    }

    fn summarize(&self, o: &DrawingTemplates) -> Option<String> {
        list_summary(o)
    }
}

struct SaveDrawingTemplate(Arc<DrawingTemplateService>);

#[async_trait]
impl Tool for SaveDrawingTemplate {
    type Input = ChartSaveDrawingTemplateInput;
    type Output = DrawingTemplateSavedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.save_drawing_template",
            "Save drawing template",
            RiskTier::Modify,
        )
        .description("Saves a drawing's look as a template of its kind under a name: drawingId (from chart.get_state; tileId and layoutId find its chart), or kind with style, label (its look; a template keeps no words) and levels over the kind's built-in look. Its kind's template of the same name (any case) is replaced; another kind may share the name. newDrawings: true also makes it what new drawings of its kind take.")
        .activity("Saved drawing template")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSaveDrawingTemplateInput,
    ) -> Result<DrawingTemplateSavedOutput, ToolError> {
        self.0.save(i, &ctx.origin).await
    }

    fn summarize(&self, o: &DrawingTemplateSavedOutput) -> Option<String> {
        Some(format!(
            "{} {} · {}",
            if o.replaced { "replaced" } else { "saved" },
            o.template.name,
            o.template.kind.as_str().replace('_', " ")
        ))
    }
}

struct ApplyDrawingTemplate(Arc<DrawingTemplateService>);

#[async_trait]
impl Tool for ApplyDrawingTemplate {
    type Input = ChartApplyDrawingTemplateInput;
    type Output = ChartDrawingOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.apply_drawing_template",
            "Apply drawing template",
            RiskTier::Modify,
        )
        .description("Gives a drawing (drawingId) a template's look: a template of its kind by id or name, or `built-in` for the kind's built-in look (mist, 1 px, solid, its default label). Its style, its label's look and a Fibonacci drawing's levels change; its words and anchors stay. Defaults to the active chart.")
        .activity("Applied drawing template")
        .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartApplyDrawingTemplateInput,
    ) -> Result<ChartDrawingOutput, ToolError> {
        self.0.apply(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartDrawingOutput) -> Option<String> {
        Some(format!(
            "{} {} on {}",
            o.drawing.kind.as_str().replace('_', " "),
            o.drawing.id,
            o.tile_id
        ))
    }
}

struct SetDefaultDrawingTemplate(Arc<DrawingTemplateService>);

#[async_trait]
impl Tool for SetDefaultDrawingTemplate {
    type Input = ChartSetDefaultDrawingTemplateInput;
    type Output = DrawingDefaultOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.set_default_drawing_template",
            "Set new drawings' template",
            RiskTier::Modify,
        )
        .description("What new drawings of a kind take (the style bar's Apply to new drawings): a template (by id or name; kind tells two kinds' templates of one name apart) gives every new drawing of its kind its look; kind without a template gives them the built-in look again. Writes that kind's entry of the chart.drawingTools setting's styles; the user's last chosen style sets it too.")
        .activity("Set new drawings' look")
        .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSetDefaultDrawingTemplateInput,
    ) -> Result<DrawingDefaultOutput, ToolError> {
        self.0.set_default(i, &ctx.origin).await
    }

    fn summarize(&self, o: &DrawingDefaultOutput) -> Option<String> {
        Some(format!(
            "new {} drawings: {}",
            o.kind.as_str().replace('_', " "),
            o.template.as_ref().map_or("built-in", |t| t.name.as_str())
        ))
    }
}

struct RenameDrawingTemplate(Arc<DrawingTemplateService>);

#[async_trait]
impl Tool for RenameDrawingTemplate {
    type Input = ChartRenameDrawingTemplateInput;
    type Output = DrawingTemplates;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.rename_drawing_template",
            "Rename drawing template",
            RiskTier::Modify,
        )
        .description("Renames a drawing template (by id or name; kind tells two kinds' templates of one name apart). Names are unique within a kind, ignoring case. To change what a template holds, apply it, restyle the drawing, and save it again under its name.")
        .activity("Renamed drawing template")
        .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartRenameDrawingTemplateInput,
    ) -> Result<DrawingTemplates, ToolError> {
        self.0.rename(i, &ctx.origin).await
    }

    fn summarize(&self, o: &DrawingTemplates) -> Option<String> {
        list_summary(o)
    }
}

struct DeleteDrawingTemplate(Arc<DrawingTemplateService>);

#[async_trait]
impl Tool for DeleteDrawingTemplate {
    type Input = ChartDeleteDrawingTemplateInput;
    type Output = DrawingTemplates;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.delete_drawing_template",
            "Delete drawing template",
            RiskTier::Modify,
        )
        .description("Deletes a drawing template (by id or name; kind tells two kinds' templates of one name apart). Drawings it was applied to keep their look, and so do new drawings of its kind if they took it.")
        .activity("Deleted drawing template")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartDeleteDrawingTemplateInput,
    ) -> Result<DrawingTemplates, ToolError> {
        self.0.delete(i, &ctx.origin).await
    }

    fn summarize(&self, o: &DrawingTemplates) -> Option<String> {
        list_summary(o)
    }
}

pub(crate) fn register(
    r: &mut ToolRegistry,
    s: &Arc<DrawingTemplateService>,
) -> Result<(), RegistryError> {
    r.register(ListDrawingTemplates(Arc::clone(s)))?;
    r.register(SaveDrawingTemplate(Arc::clone(s)))?;
    r.register(ApplyDrawingTemplate(Arc::clone(s)))?;
    r.register(SetDefaultDrawingTemplate(Arc::clone(s)))?;
    r.register(RenameDrawingTemplate(Arc::clone(s)))?;
    r.register(DeleteDrawingTemplate(Arc::clone(s)))?;
    Ok(())
}
