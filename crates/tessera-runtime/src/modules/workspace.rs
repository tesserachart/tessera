use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_host::{
    KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicSizing, TsExports,
    parse_params,
};
use tessera_protocol::drawing_templates::{
    ChartApplyDrawingTemplateInput, ChartDeleteDrawingTemplateInput,
    ChartListDrawingTemplatesInput, ChartRenameDrawingTemplateInput, ChartSaveDrawingTemplateInput,
    ChartSetDefaultDrawingTemplateInput, DrawingDefaultOutput, DrawingTemplateSavedOutput,
    DrawingTemplates,
};
use tessera_protocol::drawings::{
    ChartAddDrawingInput, ChartDrawingOutput, ChartRemoveDrawingInput, ChartUpdateDrawingInput,
};
use tessera_protocol::indicators::{
    CustomLayerParams, IndicatorParams, IndicatorSpec, PriceSource,
};
use tessera_protocol::io::{
    ChartAddLayerInput, ChartAnnotateInput, ChartChangeOutput, ChartClearAnnotationsInput,
    ChartRemoveLayerInput, ChartReportViewportInput, ChartSetChartTypeInput,
    ChartSetDrawingSourcesInput, ChartSetHoursInput, ChartSetSymbolInput, ChartSetTimeframeInput,
    ChartStateOutput, ChartTarget, ChartUpdateLayerInput, LayerKindsInput, LayerKindsOutput,
    LayoutDeleteInput, LayoutDeleteOutput, LayoutGetInput, LayoutListInput, LayoutListOutput,
    LayoutSaveInput, LayoutSaveOutput, RemovedOutput, TileRequest, WorkspaceDocumentInput,
    WorkspaceOpenTileInput, WorkspaceOpenTileOutput,
};
use tessera_protocol::layers::{DrawnLayerKind, LevelsLayerParams};
use tessera_protocol::layout::{Layout, LayoutEvent};
use tessera_protocol::presets::{
    ChartApplyIndicatorPresetInput, ChartDeleteIndicatorPresetInput, ChartEditIndicatorPresetInput,
    ChartIndicatorPresetSavedOutput, ChartListIndicatorPresetsInput, ChartSaveIndicatorPresetInput,
    ChartSetIndicatorDefaultInput, IndicatorPresets,
};
use tessera_protocol::rpc::{RpcError, codes};
use tessera_protocol::surfaces::{
    ChartDrawingHistoryInput, ChartSetLinkInput, ChartSetViewportInput, ChartSetViewportOutput,
    DockRequest, JournalView, MarketsList, MarketsView, UiShowAreaInput, UiShowAreaOutput,
    UiShowWorkspaceInput, UiShowWorkspaceOutput, WorkspaceApplyPresetInput, WorkspaceCreateInput,
    WorkspaceCreatedOutput, WorkspaceDockOutput, WorkspaceDuplicateInput, WorkspaceListTilesInput,
    WorkspaceMaximizeTileInput, WorkspaceMoveTileInput, WorkspaceSetTileSettingsInput,
    WorkspaceSetViewInput, WorkspaceTileInput, WorkspaceTilesOutput,
};
use tessera_protocol::templates::{
    ChartApplyTemplateInput, ChartDeleteTemplateInput, ChartEditTemplateInput,
    ChartListTemplatesInput, ChartSaveTemplateInput, ChartTemplateSavedOutput, ChartTemplates,
};
use tessera_protocol::topics::{LayoutParams, names};
use tessera_protocol::trade_panel::{TradeGetPanelInput, TradePanelOutput, TradeSetPanelInput};
use tessera_tools::{RegistryError, ToolRegistry};

use crate::drawing_templates::DrawingTemplateService;
use crate::layout::LayoutService;
use crate::presets::PresetService;
use crate::settings::SettingsService;
use crate::templates::TemplateService;
use crate::tools::ViewportAck;

pub struct WorkspaceModule {
    layouts: Arc<LayoutService>,
    templates: Option<Arc<TemplateService>>,
    drawing_templates: Option<Arc<DrawingTemplateService>>,
    presets: Option<Arc<PresetService>>,
    settings: Option<Arc<SettingsService>>,
    accounts: bool,
}

impl std::fmt::Debug for WorkspaceModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceModule").finish_non_exhaustive()
    }
}

impl WorkspaceModule {
    pub fn new(layouts: Arc<LayoutService>) -> Self {
        Self {
            layouts,
            templates: None,
            drawing_templates: None,
            presets: None,
            settings: None,
            accounts: false,
        }
    }

    #[must_use]
    pub fn with_templates(mut self, templates: Arc<TemplateService>) -> Self {
        self.templates = Some(templates);
        self
    }

    #[must_use]
    pub fn with_drawing_templates(mut self, templates: Arc<DrawingTemplateService>) -> Self {
        self.drawing_templates = Some(templates);
        self
    }

    #[must_use]
    pub fn with_presets(mut self, presets: Arc<PresetService>) -> Self {
        self.presets = Some(presets);
        self
    }

    #[must_use]
    pub fn with_settings(mut self, settings: Arc<SettingsService>) -> Self {
        self.settings = Some(settings);
        self
    }

    #[must_use]
    pub fn with_accounts(mut self, accounts: bool) -> Self {
        self.accounts = accounts;
        self
    }
}

impl RuntimeModule for WorkspaceModule {
    fn name(&self) -> &'static str {
        "workspace"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        crate::tools::layout::register(r, &self.layouts, self.settings.as_ref())?;
        crate::tools::chart::register(r, &self.layouts, self.presets.as_ref())?;
        crate::tools::drawings::register(r, &self.layouts)?;
        crate::tools::surfaces::register(r, &self.layouts, self.settings.as_ref())?;
        crate::tools::trade_panel::register(r, &self.layouts)?;
        if let Some(t) = &self.templates {
            crate::tools::templates::register(r, t)?;
        }
        if let Some(t) = &self.drawing_templates {
            crate::tools::drawing_templates::register(r, t)?;
        }
        if let Some(p) = &self.presets {
            crate::tools::presets::register(r, p)?;
        }
        if let Some(s) = &self.settings {
            crate::tools::surfaces::register_ui(r, s, &self.layouts, self.accounts)?;
            crate::tools::workspaces::register(r, &self.layouts, s, self.templates.as_ref())?;
        }
        Ok(())
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(LayoutTopic(Arc::clone(&self.layouts)))]
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (workspace)")
        .tool::<LayoutGetInput, Layout>("layout.get")
        .tool::<LayoutSaveInput, LayoutSaveOutput>("layout.save")
        .tool::<LayoutListInput, LayoutListOutput>("layout.list")
        .tool::<LayoutDeleteInput, LayoutDeleteOutput>("layout.delete")
        .tool::<WorkspaceDocumentInput, LayoutSaveOutput>("workspace.save")
        .tool::<WorkspaceDocumentInput, LayoutSaveOutput>("workspace.revert")
        .tool::<WorkspaceOpenTileInput, WorkspaceOpenTileOutput>("workspace.open_tile")
        .tool::<WorkspaceTileInput, WorkspaceDockOutput>("workspace.close_tile")
        .tool::<WorkspaceTileInput, WorkspaceDockOutput>("workspace.focus_tile")
        .tool::<WorkspaceApplyPresetInput, WorkspaceDockOutput>("workspace.apply_preset")
        .tool::<WorkspaceSetTileSettingsInput, WorkspaceDockOutput>("workspace.set_tile_settings")
        .tool::<WorkspaceMoveTileInput, WorkspaceDockOutput>("workspace.move_tile")
        .tool::<WorkspaceSetViewInput, WorkspaceDockOutput>("workspace.set_view")
        .tool::<WorkspaceListTilesInput, WorkspaceTilesOutput>("workspace.list_tiles")
        .tool::<WorkspaceMaximizeTileInput, WorkspaceDockOutput>("workspace.maximize_tile")
        .tool::<WorkspaceCreateInput, WorkspaceCreatedOutput>("workspace.create")
        .tool::<WorkspaceDuplicateInput, WorkspaceCreatedOutput>("workspace.duplicate")
        .tool::<TradeGetPanelInput, TradePanelOutput>("trade.get_panel")
        .tool::<TradeSetPanelInput, WorkspaceDockOutput>("trade.set_panel")
        .tool::<UiShowAreaInput, UiShowAreaOutput>("ui.show_area")
        .tool::<UiShowWorkspaceInput, UiShowWorkspaceOutput>("ui.show_workspace")
        .tool::<ChartTarget, ChartStateOutput>("chart.get_state")
        .tool::<ChartSetSymbolInput, ChartChangeOutput>("chart.set_symbol")
        .tool::<ChartSetTimeframeInput, ChartChangeOutput>("chart.set_timeframe")
        .tool::<ChartSetChartTypeInput, ChartChangeOutput>("chart.set_chart_type")
        .tool::<ChartSetHoursInput, ChartChangeOutput>("chart.set_hours")
        .tool::<ChartSetDrawingSourcesInput, ChartChangeOutput>("chart.set_drawing_sources")
        .tool::<ChartSetLinkInput, ChartChangeOutput>("chart.set_link")
        .tool::<ChartSetViewportInput, ChartSetViewportOutput>("chart.set_viewport")
        .tool::<ChartDrawingHistoryInput, WorkspaceDockOutput>("chart.undo_drawing")
        .tool::<ChartDrawingHistoryInput, WorkspaceDockOutput>("chart.redo_drawing")
        .tool::<ChartAddLayerInput, ChartChangeOutput>("chart.add_layer")
        .tool::<LayerKindsInput, LayerKindsOutput>("chart.list_layer_kinds")
        .tool::<ChartUpdateLayerInput, ChartChangeOutput>("chart.update_layer")
        .tool::<ChartRemoveLayerInput, RemovedOutput>("chart.remove_layer")
        .tool::<ChartAnnotateInput, ChartChangeOutput>("chart.annotate")
        .tool::<ChartClearAnnotationsInput, RemovedOutput>("chart.clear_annotations")
        .tool::<ChartAddDrawingInput, ChartDrawingOutput>("chart.add_drawing")
        .tool::<ChartUpdateDrawingInput, ChartDrawingOutput>("chart.update_drawing")
        .tool::<ChartRemoveDrawingInput, RemovedOutput>("chart.remove_drawing")
        .tool::<ChartReportViewportInput, ViewportAck>("chart.report_viewport")
        .tool::<ChartListTemplatesInput, ChartTemplates>("chart.list_templates")
        .tool::<ChartSaveTemplateInput, ChartTemplateSavedOutput>("chart.save_template")
        .tool::<ChartApplyTemplateInput, ChartChangeOutput>("chart.apply_template")
        .tool::<ChartEditTemplateInput, ChartTemplates>("chart.edit_template")
        .tool::<ChartDeleteTemplateInput, ChartTemplates>("chart.delete_template")
        .tool::<ChartListDrawingTemplatesInput, DrawingTemplates>("chart.list_drawing_templates")
        .tool::<ChartSaveDrawingTemplateInput, DrawingTemplateSavedOutput>(
            "chart.save_drawing_template",
        )
        .tool::<ChartApplyDrawingTemplateInput, ChartDrawingOutput>("chart.apply_drawing_template")
        .tool::<ChartSetDefaultDrawingTemplateInput, DrawingDefaultOutput>(
            "chart.set_default_drawing_template",
        )
        .tool::<ChartRenameDrawingTemplateInput, DrawingTemplates>("chart.rename_drawing_template")
        .tool::<ChartDeleteDrawingTemplateInput, DrawingTemplates>("chart.delete_drawing_template")
        .tool::<ChartListIndicatorPresetsInput, IndicatorPresets>("chart.list_indicator_presets")
        .tool::<ChartSaveIndicatorPresetInput, ChartIndicatorPresetSavedOutput>(
            "chart.save_indicator_preset",
        )
        .tool::<ChartApplyIndicatorPresetInput, ChartChangeOutput>("chart.apply_indicator_preset")
        .tool::<ChartEditIndicatorPresetInput, IndicatorPresets>("chart.edit_indicator_preset")
        .tool::<ChartDeleteIndicatorPresetInput, IndicatorPresets>("chart.delete_indicator_preset")
        .tool::<ChartSetIndicatorDefaultInput, IndicatorPresets>("chart.set_indicator_default")
        .topic::<LayoutParams, LayoutEvent>(names::LAYOUT)
        .ty::<TileRequest>()
        .ty::<DockRequest>()
        .ty::<JournalView>()
        .ty::<MarketsView>()
        .ty::<MarketsList>()
        .ty::<DrawnLayerKind>()
        .ty::<LevelsLayerParams>()
        .ty::<IndicatorSpec>()
        .ty::<IndicatorParams>()
        .ty::<CustomLayerParams>()
        .ty::<PriceSource>()
}

struct LayoutTopic(Arc<LayoutService>);

#[async_trait]
impl TopicHandler for LayoutTopic {
    fn name(&self) -> &'static str {
        names::LAYOUT
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::SNAPSHOT
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: LayoutParams = parse_params(params)?;
        let ev = self
            .0
            .snapshot_event(p.layout_id.as_deref())
            .map_err(|e| RpcError::new(codes::NOT_FOUND, e.message))?;
        Ok(Subscribed::new(KeyFilter::Layout(ev.layout_id.clone())).snapshot(&ev))
    }
}
