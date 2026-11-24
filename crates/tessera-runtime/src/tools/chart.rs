use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_protocol::io::{
    ChartAddLayerInput, ChartAnnotateInput, ChartChangeOutput, ChartClearAnnotationsInput,
    ChartRemoveLayerInput, ChartReportViewportInput, ChartSetChartTypeInput,
    ChartSetDrawingSourcesInput, ChartSetHoursInput, ChartSetSymbolInput, ChartSetTimeframeInput,
    ChartStateOutput, ChartTarget, ChartUpdateLayerInput, LayerKindsInput, LayerKindsOutput,
    RemovedOutput,
};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RateLimit, RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::layout::LayoutService;
use crate::presets::PresetService;

fn change_summary(o: &ChartChangeOutput) -> Option<String> {
    Some(format!(
        "{} · {} {} · {} layers",
        o.chart.title,
        o.chart.instrument,
        o.chart.timeframe,
        o.chart.layers.len()
    ))
}

struct GetState(Arc<LayoutService>);

#[async_trait]
impl Tool for GetState {
    type Input = ChartTarget;
    type Output = ChartStateOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.get_state", "Read chart", RiskTier::Read)
            .description("A chart tile's model: instrument, timeframe, layers, annotations, drawings (each with the instrument it was drawn on; the chart shows those of its instrument) and the last viewport the UI reported. viewport.profiles lists each volume profile with some of its rows or its POC, VAH or VAL lines on screen at that report (each volume_profile layer's periods, composite, range, anchored or visible profile) with its span, POC, VAH and VAL; a profile that drew nothing in view (no volume read yet, its prices or its span off screen, or hours the bars cannot show) is not listed. After adding a profile, read it here before saying it is drawn; one not listed yet may still be reading, so ask again in a few seconds. Defaults to the active chart.")
            .activity("Read chart context")
            .result_view("chart_state")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ChartTarget,
    ) -> Result<ChartStateOutput, ToolError> {
        self.0
            .chart_state(input.layout_id.as_deref(), input.tile_id.as_deref())
    }

    fn summarize(&self, o: &ChartStateOutput) -> Option<String> {
        Some(format!(
            "{} · {} · {} · {} layers",
            o.chart.instrument,
            o.chart.timeframe,
            o.chart.title,
            o.chart.layers.len()
        ))
    }
}

struct SetSymbol(Arc<LayoutService>);

#[async_trait]
impl Tool for SetSymbol {
    type Input = ChartSetSymbolInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.set_symbol", "Change chart symbol", RiskTier::Modify)
            .description("Changes a chart's instrument (and every chart in its link group).")
            .activity("Changed symbol")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSetSymbolInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0
            .set_symbol(
                i.layout_id.as_deref(),
                i.tile_id.as_deref(),
                &i.instrument,
                &ctx.origin,
            )
            .await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        change_summary(o)
    }
}

struct SetTimeframe(Arc<LayoutService>);

#[async_trait]
impl Tool for SetTimeframe {
    type Input = ChartSetTimeframeInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.set_timeframe",
            "Change chart timeframe",
            RiskTier::Modify,
        )
        .description("Changes a chart's timeframe, any count of s, m, h or D (15s 1m 7m 90m 2h 1D 2D), or with printBars draws bars built from prints instead: tick (a bar every size prints), range (high to low within size ticks), volume (a bar every size contracts), delta (a bar until its net delta reaches size either way) or renko (bricks size ticks tall), each starting again at the session's open (market.get_print_bars). A call without printBars returns the chart to time bars.")
        .activity("Changed timeframe")
        .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSetTimeframeInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0
            .set_timeframe(
                i.layout_id.as_deref(),
                i.tile_id.as_deref(),
                i.tf,
                i.print_bars,
                &ctx.origin,
            )
            .await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        change_summary(o)
    }
}

struct SetHours(Arc<LayoutService>);

#[async_trait]
impl Tool for SetHours {
    type Input = ChartSetHoursInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.set_hours", "Change chart hours", RiskTier::Modify)
        .description("Sets which hours a chart shows: rth (regular trading hours only: the bars outside them leave the chart and its time axis) or eth (every hour, the default). Every study on the chart follows it, its volume profiles included, unless a profile sets hours of its own. chart.get_state shows it as hours (absent: eth). Defaults to the active chart.")
        .activity("Changed chart hours")
        .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSetHoursInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0
            .set_hours(
                i.layout_id.as_deref(),
                i.tile_id.as_deref(),
                i.hours,
                &ctx.origin,
            )
            .await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        change_summary(o)
    }
}

struct SetDrawingSources(Arc<LayoutService>);

#[async_trait]
impl Tool for SetDrawingSources {
    type Input = ChartSetDrawingSourcesInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.set_drawing_sources",
            "Show drawings from other charts",
            RiskTier::Modify,
        )
        .description("Picks which other charts of the workspace a chart also shows drawings from, by tile id (from chart.get_state or layout.get), whatever their timeframe: an NQ 1m chart given [\"chart-2\"] shows chart-2's NQ drawings beside its own. A drawing stays on the chart it was made on; a chart with none picked shows only its own, and a new chart picks none. `from` replaces the list ([] shows only its own). chart.get_state lists the picked charts as chart.drawingsFrom and their drawings under pulled. Defaults to the active chart.")
        .activity("Changed which charts' drawings a chart shows")
        .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSetDrawingSourcesInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0
            .set_drawing_sources(
                i.layout_id.as_deref(),
                i.tile_id.as_deref(),
                i.from,
                &ctx.origin,
            )
            .await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        change_summary(o)
    }
}

struct SetChartType(Arc<LayoutService>);

#[async_trait]
impl Tool for SetChartType {
    type Input = ChartSetChartTypeInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.set_chart_type",
            "Change chart type",
            RiskTier::Modify,
        )
        .description("Changes how a chart draws its price series: candles, bars (OHLC), line (the closes) or none, which hides the price on this chart only while its price axis, studies and drawings stay (a profile-only chart; any other type shows the price again). chart.get_state shows it as chartType (absent: candles, the default). Defaults to the active chart.")
        .activity("Changed chart type")
        .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartSetChartTypeInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0
            .set_chart_type(
                i.layout_id.as_deref(),
                i.tile_id.as_deref(),
                i.chart_type,
                &ctx.origin,
            )
            .await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        change_summary(o)
    }
}

struct AddLayer(Arc<LayoutService>, Option<Arc<PresetService>>);

#[async_trait]
impl Tool for AddLayer {
    type Input = ChartAddLayerInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.add_layer", "Add chart layer", RiskTier::Modify)
            .description("Adds a layer to a chart: an indicator (sma, ema, wma, vwap, bollinger on the price; volume, rsi, atr, macd, stochastic in their own panes), an order-flow view (footprint, volume_profile, big_trades and effort on the price; delta in its own pane; each needs prints with an aggressor side from the chart's connection) or levels ({vendor, package} or {group}, optional fields). Indicator params are {inputs, style}: e.g. {inputs: {length: 50, source: \"hlc3\"}}, {inputs: {band1: true, band2: true}} for VWAP σ bands, {style: {plots: {ma: {color: \"brass\", width: 2}}}}; {style: {labels: {priceScale: true, name: true, value: false}}} for the labels its lines carry (each line's last value on the price scale; its name, and optionally its value, at its right end); omitted values take the defaults (the user's saved default for that indicator when there is one, chart.set_indicator_default), and the stored layer shows them all. chart.list_layer_kinds gives each kind's inputs, plots, defaults and schema, and which kinds are available on the chart (a kind whose data the chart's connection does not offer answers unsupported, with the reason). Agent layers are tagged with the session. The user sees an agent indicator's main line (its first line plot) in the analyst's aqua while that line has its default colour; a colour you give it (or the user does) shows as given.")
            .activity("Added layer")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        mut i: ChartAddLayerInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        if let Some(start) = self
            .1
            .as_ref()
            .and_then(|p| p.start_params(i.kind, i.params.as_ref()))
        {
            i.params = Some(start);
        }
        self.0.add_layer(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        change_summary(o)
    }
}

struct ListLayerKinds(Arc<LayoutService>);

#[async_trait]
impl Tool for ListLayerKinds {
    type Input = LayerKindsInput;
    type Output = LayerKindsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.list_layer_kinds", "List chart layer kinds", RiskTier::Read)
            .description("The chart layer kinds, each with its title, data requirement and whether chart.add_layer accepts it on the target chart (drawn by the chart, and the chart's connection offers the data it needs). With no filter each kind comes with the first sentence of its description; name one with kind (`volume_profile`, or words of its title such as `profile`) for its whole description, params schema and indicator spec, or pass full: true. limit caps the list; omitted counts what it left out. Defaults to the active chart.")
            .activity("Listed layer kinds")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: LayerKindsInput,
    ) -> Result<LayerKindsOutput, ToolError> {
        self.0.layer_kinds(input).await
    }

    fn summarize(&self, o: &LayerKindsOutput) -> Option<String> {
        let available = o.kinds.iter().filter(|k| k.available).count();
        Some(format!("{available} of {} kinds available", o.kinds.len()))
    }
}

struct RemoveLayer(Arc<LayoutService>);

#[async_trait]
impl Tool for RemoveLayer {
    type Input = ChartRemoveLayerInput;
    type Output = RemovedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.remove_layer", "Remove chart layer", RiskTier::Modify)
            .description("Removes a layer from a chart by id.")
            .activity("Removed layer")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartRemoveLayerInput,
    ) -> Result<RemovedOutput, ToolError> {
        self.0
            .remove_layer(
                i.layout_id.as_deref(),
                i.tile_id.as_deref(),
                &i.layer_id,
                &ctx.origin,
            )
            .await
    }

    fn summarize(&self, o: &RemovedOutput) -> Option<String> {
        Some(format!("removed {}", o.removed))
    }
}

struct UpdateLayer(Arc<LayoutService>);

#[async_trait]
impl Tool for UpdateLayer {
    type Input = ChartUpdateLayerInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.update_layer", "Edit chart layer", RiskTier::Modify)
            .description("Edits a chart layer by id: params is a JSON merge patch over its current params (an indicator's {inputs: {length: 21}} or {style: {plots: {rsi: {color: \"brass\", line: \"dash\"}}, fills: {zone: {visible: false}}}}, or its lines' labels {style: {labels: {priceScale: false, name: true, value: true}}}; null returns a value to its default), validated against the kind's schema; visible shows or hides it. chart.apply_indicator_preset puts a saved preset's settings on it whole. An agent indicator's main line shows in the analyst's aqua only while it keeps its default colour.")
            .activity("Edited layer")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartUpdateLayerInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0.update_layer(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        change_summary(o)
    }
}

struct Annotate(Arc<LayoutService>);

#[async_trait]
impl Tool for Annotate {
    type Input = ChartAnnotateInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.annotate", "Annotate chart", RiskTier::Modify)
            .description("Draws a box, arrow, zone, marker, horizontal line or text on a chart: the analyst's marks, dashed, AI-tagged and cleared together with chart.clear_annotations. For a drawing the user can select, edit and keep like their own, use chart.add_drawing. Marks stay where they are put: levels, zones or names that should follow new sessions (each session's high and low until swept, named on its line) are a custom indicator's lines, labels and boxes (draw.line with a label in its JavaScript, indicators.create_custom).")
            .activity("Annotated chart")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartAnnotateInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0.annotate(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        Some(format!(
            "{} annotations on {}",
            o.chart.annotations.len(),
            o.chart.title
        ))
    }
}

struct ClearAnnotations(Arc<LayoutService>);

#[async_trait]
impl Tool for ClearAnnotations {
    type Input = ChartClearAnnotationsInput;
    type Output = RemovedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.clear_annotations", "Clear annotations", RiskTier::Modify)
            .description("Removes annotations from a chart: by default the agent namespace, optionally only one session's.")
            .activity("Cleared annotations")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartClearAnnotationsInput,
    ) -> Result<RemovedOutput, ToolError> {
        self.0.clear_annotations(i, &ctx.origin).await
    }

    fn summarize(&self, o: &RemovedOutput) -> Option<String> {
        Some(format!("removed {}", o.removed))
    }
}

/// Output of `chart.report_viewport`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ViewportAck {
    /// Always true.
    pub stored: bool,
}

struct ReportViewport(Arc<LayoutService>);

#[async_trait]
impl Tool for ReportViewport {
    type Input = ChartReportViewportInput;
    type Output = ViewportAck;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "chart.report_viewport",
            "Report chart viewport",
            RiskTier::Modify,
        )
        .description("UI telemetry: the visible range of a chart, read back by chart.get_state.")
        .user_only()
        .quiet()
        .refreshes(&["chart.get_state"])
        .idempotent(true)
        .rate_limit(RateLimit::new(10.0, 20))
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        i: ChartReportViewportInput,
    ) -> Result<ViewportAck, ToolError> {
        self.0
            .report_viewport(i.layout_id.as_deref(), &i.tile_id, i.viewport)?;
        Ok(ViewportAck { stored: true })
    }
}

pub(crate) fn register(
    r: &mut ToolRegistry,
    s: &Arc<LayoutService>,
    presets: Option<&Arc<PresetService>>,
) -> Result<(), RegistryError> {
    let l = s;
    r.register(GetState(Arc::clone(l)))?;
    r.register(SetSymbol(Arc::clone(l)))?;
    r.register(SetTimeframe(Arc::clone(l)))?;
    r.register(SetChartType(Arc::clone(l)))?;
    r.register(SetHours(Arc::clone(l)))?;
    r.register(SetDrawingSources(Arc::clone(l)))?;
    r.register(AddLayer(Arc::clone(l), presets.cloned()))?;
    r.register(ListLayerKinds(Arc::clone(l)))?;
    r.register(UpdateLayer(Arc::clone(l)))?;
    r.register(RemoveLayer(Arc::clone(l)))?;
    r.register(Annotate(Arc::clone(l)))?;
    r.register(ClearAnnotations(Arc::clone(l)))?;
    r.register(ReportViewport(Arc::clone(l)))?;
    Ok(())
}
