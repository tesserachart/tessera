use std::sync::Arc;

use async_trait::async_trait;
use tessera_protocol::io::ChartChangeOutput;
use tessera_protocol::presets::{
    ChartApplyIndicatorPresetInput, ChartDeleteIndicatorPresetInput, ChartEditIndicatorPresetInput,
    ChartIndicatorPresetSavedOutput, ChartListIndicatorPresetsInput, ChartSaveIndicatorPresetInput,
    ChartSetIndicatorDefaultInput, IndicatorPresets,
};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::presets::PresetService;

fn list_summary(o: &IndicatorPresets) -> Option<String> {
    Some(format!(
        "{} presets · {} defaults",
        o.presets.len(),
        o.defaults.len()
    ))
}

struct ListPresets(Arc<PresetService>);

#[async_trait]
impl Tool for ListPresets {
    type Input = ChartListIndicatorPresetsInput;
    type Output = IndicatorPresets;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.list_indicator_presets", "List indicator presets", RiskTier::Read)
            .description("The user's indicator presets: each a name, the indicator it is for (a built-in's kind such as ema, or a custom indicator's id) and its settings ({inputs, style}); and defaults, the settings a new indicator of a kind starts from, by indicator. indicator narrows it to one indicator's.")
            .activity("Listed indicator presets")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        i: ChartListIndicatorPresetsInput,
    ) -> Result<IndicatorPresets, ToolError> {
        Ok(self.0.list_for(i.indicator.as_deref()))
    }

    fn summarize(&self, o: &IndicatorPresets) -> Option<String> {
        list_summary(o)
    }
}

struct SavePreset(Arc<PresetService>);

#[async_trait]
impl Tool for SavePreset {
    type Input = ChartSaveIndicatorPresetInput;
    type Output = ChartIndicatorPresetSavedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.save_indicator_preset", "Save indicator preset", RiskTier::Modify)
            .description("Keeps an indicator's settings under a name (Save preset as…): a chart indicator layer's current inputs and style (layer_id, on the active chart by default), or settings you give for an indicator (indicator: a kind such as ema or a custom indicator's id, and params {inputs, style}; omitted values take its defaults). The pane height is not part of a preset. The indicator's preset of the same name (any case) is replaced. chart.apply_indicator_preset puts it on an indicator.")
            .activity("Saved indicator preset")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSaveIndicatorPresetInput,
    ) -> Result<ChartIndicatorPresetSavedOutput, ToolError> {
        self.0.save(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartIndicatorPresetSavedOutput) -> Option<String> {
        Some(format!(
            "{} {} · {}",
            if o.replaced { "replaced" } else { "saved" },
            o.preset.name,
            o.preset.indicator
        ))
    }
}

struct ApplyPreset(Arc<PresetService>);

#[async_trait]
impl Tool for ApplyPreset {
    type Input = ChartApplyIndicatorPresetInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.apply_indicator_preset", "Apply indicator preset", RiskTier::Modify)
            .description("Puts a preset's settings on a chart indicator layer (layer_id): its inputs and style are replaced whole; its pane height and visibility stay. preset is one of the layer's indicator's presets by id or name, `default` for the saved default (Reset settings: the indicator's own defaults when none is saved), or `factory` for the indicator's own defaults. A preset saved before a custom indicator changed keeps what still fits it. Defaults to the active chart.")
            .activity("Applied indicator preset")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartApplyIndicatorPresetInput,
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

struct EditPreset(Arc<PresetService>);

#[async_trait]
impl Tool for EditPreset {
    type Input = ChartEditIndicatorPresetInput;
    type Output = IndicatorPresets;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.edit_indicator_preset", "Rename indicator preset", RiskTier::Modify)
            .description("Renames a preset (by id or name; an indicator's preset names are unique ignoring case). To change what a preset holds, apply it, change the indicator, and save it again under its name.")
            .activity("Renamed indicator preset")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartEditIndicatorPresetInput,
    ) -> Result<IndicatorPresets, ToolError> {
        self.0.edit(i, &ctx.origin).await
    }

    fn summarize(&self, o: &IndicatorPresets) -> Option<String> {
        list_summary(o)
    }
}

struct DeletePreset(Arc<PresetService>);

#[async_trait]
impl Tool for DeletePreset {
    type Input = ChartDeleteIndicatorPresetInput;
    type Output = IndicatorPresets;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.delete_indicator_preset", "Delete indicator preset", RiskTier::Modify)
            .description("Deletes a preset (by id or name). Indicators it was applied to keep their settings; the default is apart from presets (chart.set_indicator_default clear: true removes it).")
            .activity("Deleted indicator preset")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartDeleteIndicatorPresetInput,
    ) -> Result<IndicatorPresets, ToolError> {
        self.0.delete(i, &ctx.origin).await
    }

    fn summarize(&self, o: &IndicatorPresets) -> Option<String> {
        list_summary(o)
    }
}

struct SetDefault(Arc<PresetService>);

#[async_trait]
impl Tool for SetDefault {
    type Input = ChartSetIndicatorDefaultInput;
    type Output = IndicatorPresets;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.set_indicator_default", "Set indicator default", RiskTier::Modify)
            .description("Sets the settings a new indicator of one kind starts from (Save as default), for the user's adds and chart.add_layer alike: a chart indicator layer's current settings (layer_id), one of the indicator's presets (indicator and preset), settings given (indicator and params {inputs, style}), or clear: true with the indicator to start from its own defaults again. Indicators already on charts keep their settings.")
            .activity("Set indicator default")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSetIndicatorDefaultInput,
    ) -> Result<IndicatorPresets, ToolError> {
        self.0.set_default(i, &ctx.origin).await
    }

    fn summarize(&self, o: &IndicatorPresets) -> Option<String> {
        list_summary(o)
    }
}

pub(crate) fn register(r: &mut ToolRegistry, s: &Arc<PresetService>) -> Result<(), RegistryError> {
    r.register(ListPresets(Arc::clone(s)))?;
    r.register(SavePreset(Arc::clone(s)))?;
    r.register(ApplyPreset(Arc::clone(s)))?;
    r.register(EditPreset(Arc::clone(s)))?;
    r.register(DeletePreset(Arc::clone(s)))?;
    r.register(SetDefault(Arc::clone(s)))?;
    Ok(())
}
