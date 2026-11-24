use std::sync::Arc;

use async_trait::async_trait;
use tessera_protocol::io::ChartChangeOutput;
use tessera_protocol::templates::{
    ChartApplyTemplateInput, ChartDeleteTemplateInput, ChartEditTemplateInput,
    ChartListTemplatesInput, ChartSaveTemplateInput, ChartTemplateSavedOutput, ChartTemplates,
};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::templates::TemplateService;

fn list_summary(o: &ChartTemplates) -> Option<String> {
    let default = o
        .default_id
        .as_deref()
        .and_then(|id| o.templates.iter().find(|t| t.id == id))
        .map_or_else(
            || "no default".to_owned(),
            |t| format!("default {}", t.name),
        );
    Some(format!("{} templates · {default}", o.templates.len()))
}

struct ListTemplates(Arc<TemplateService>);

#[async_trait]
impl Tool for ListTemplates {
    type Input = ChartListTemplatesInput;
    type Output = ChartTemplates;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.list_templates", "List chart templates", RiskTier::Read)
            .description("The user's chart templates: each a name, an optional chart type and its indicators (kind, params, visible) in order, and the default new charts start with (defaultId). chart.apply_template puts one on a chart, or the built-in `Order flow` (not listed here).")
            .activity("Listed chart templates")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: ChartListTemplatesInput,
    ) -> Result<ChartTemplates, ToolError> {
        Ok(self.0.list())
    }

    fn summarize(&self, o: &ChartTemplates) -> Option<String> {
        list_summary(o)
    }
}

struct SaveTemplate(Arc<TemplateService>);

#[async_trait]
impl Tool for SaveTemplate {
    type Input = ChartSaveTemplateInput;
    type Output = ChartTemplateSavedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.save_template", "Save chart template", RiskTier::Modify)
            .description("Saves a chart's setup as a template under a name: its indicators in order with their inputs, styles, pane heights and visibility, and its chart type (or chartType). A template with the same name (any case) is replaced. Levels, drawings, the symbol and the interval are not part of a template. default: true also makes it the template new charts start with. Defaults to the active chart.")
            .activity("Saved chart template")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSaveTemplateInput,
    ) -> Result<ChartTemplateSavedOutput, ToolError> {
        self.0.save(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartTemplateSavedOutput) -> Option<String> {
        Some(format!(
            "{} {} · {} indicators",
            if o.replaced { "replaced" } else { "saved" },
            o.template.name,
            o.template.layers.len()
        ))
    }
}

struct ApplyTemplate(Arc<TemplateService>);

#[async_trait]
impl Tool for ApplyTemplate {
    type Input = ChartApplyTemplateInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.apply_template", "Apply chart template", RiskTier::Modify)
            .description("Puts a template (by id or name) on a chart: its indicators replace the chart's indicators, and its chart type replaces the chart's when it has one. Levels, drawings, the symbol and the interval stay. Besides the user's own (chart.list_templates) there is the built-in `Order flow`: footprint, the session volume profile, big trades and the CVD pane, each at its defaults. A template is the user's own setup: the indicators it puts on the chart are the user's and keep the template's colours (an agent's call records its session). Defaults to the active chart.")
            .activity("Applied chart template")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartApplyTemplateInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0.apply(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        Some(format!(
            "{} · {} layers",
            o.chart.title,
            o.chart.layers.len()
        ))
    }
}

struct EditTemplate(Arc<TemplateService>);

#[async_trait]
impl Tool for EditTemplate {
    type Input = ChartEditTemplateInput;
    type Output = ChartTemplates;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.edit_template", "Edit chart template", RiskTier::Modify)
            .description("Renames a template (by id or name; names are unique ignoring case) and/or makes it the template new charts start with (default: true), or stops it being that (default: false: new charts then start without indicators). To change what a template holds, apply it, edit the chart, and save it again under its name.")
            .activity("Edited chart template")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartEditTemplateInput,
    ) -> Result<ChartTemplates, ToolError> {
        self.0.edit(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartTemplates) -> Option<String> {
        list_summary(o)
    }
}

struct DeleteTemplate(Arc<TemplateService>);

#[async_trait]
impl Tool for DeleteTemplate {
    type Input = ChartDeleteTemplateInput;
    type Output = ChartTemplates;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.delete_template", "Delete chart template", RiskTier::Modify)
            .description("Deletes a template (by id or name). Charts it was applied to keep their indicators; if it was the default, new charts start without indicators.")
            .activity("Deleted chart template")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartDeleteTemplateInput,
    ) -> Result<ChartTemplates, ToolError> {
        self.0.delete(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartTemplates) -> Option<String> {
        list_summary(o)
    }
}

pub(crate) fn register(
    r: &mut ToolRegistry,
    s: &Arc<TemplateService>,
) -> Result<(), RegistryError> {
    r.register(ListTemplates(Arc::clone(s)))?;
    r.register(SaveTemplate(Arc::clone(s)))?;
    r.register(ApplyTemplate(Arc::clone(s)))?;
    r.register(EditTemplate(Arc::clone(s)))?;
    r.register(DeleteTemplate(Arc::clone(s)))?;
    Ok(())
}
