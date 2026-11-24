use std::sync::Arc;

use async_trait::async_trait;
use tessera_protocol::drawings::{
    ChartAddDrawingInput, ChartDrawingOutput, ChartRemoveDrawingInput, ChartUpdateDrawingInput,
};
use tessera_protocol::io::RemovedOutput;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::layout::LayoutService;

fn drawing_summary(o: &ChartDrawingOutput) -> Option<String> {
    let d = &o.drawing;
    Some(format!(
        "{} {} on {} · {}",
        d.kind.as_str().replace('_', " "),
        d.id,
        d.instrument,
        o.tile_id
    ))
}

struct AddDrawing(Arc<LayoutService>);

#[async_trait]
impl Tool for AddDrawing {
    type Input = ChartAddDrawingInput;
    type Output = ChartDrawingOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.add_drawing", "Draw on chart", RiskTier::Modify)
            .description("Draws on a chart, on its current instrument: trend_line, ray or extended_line (2 anchors), trend_angle (2: a trend line with its angle from the horizontal in degrees as the chart shows it), horizontal_line (1 anchor, price only), horizontal_ray (1), vertical_line (1, time only), cross_line (1: a horizontal and a vertical line through one bar's time and price), rectangle (2 corners), parallel_channel (3: the line's two anchors, then one whose price sets the parallel), fib_retracement (2: level 1 at the first anchor, 0 at the second; default levels 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1), fib_extension (3: a move's start and end, then the end of its pullback; each level is the third anchor's price plus the move times the level, so 1 is a second move as long as the first; default levels 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2), fib_fan (2: rays from the first anchor through each level of the rise to the second, at the second's time, 1 being the line to the second; default levels 0.382, 0.5, 0.618; extend none stops the rays at the second anchor's time), text (1, with text), price_range, date_range or measure (2). A volume profile over a range or from an anchor is a study, not a drawing: chart.add_layer volume_profile with inputs.period range or anchored. Each anchor is {t: bar time (RFC 3339 or ns), price}. Style: color (a swatch or #rrggbb), width 0.5–4, line solid|dash|dot, extend none|left|right|both. Label: words ON a line or shape (every kind but text and measure), so a level reads `Asia high` without a separate note: label {text (\\n breaks lines), color (default: the line's), size 8–40 px (12), bold, italic, align left|center|right along it (a vertical line: foot, middle, top), position above|on|below it (a rectangle or range: over its top, in its middle, under its bottom), showPrice (horizontal_line, horizontal_ray and cross_line: the price after the words)}; on a sloped line the words run along it. A Fibonacci drawing's labels are its levels: label {showLevels, showPrice (retracement and extension), align and position (a fan's sit flat beside each ray at the second anchor's time), size, color…} and no text; levels [ratios] sets which it draws. An agent's drawing shows in the analyst's aqua while it has the default colour (mist); a color you give it (or the user does) shows as given. A drawing is the user's to select, edit and keep, like their own, and chart.clear_annotations leaves it; for temporary analyst marks use chart.annotate. Returns the drawing with its id; chart.get_state lists every drawing. Defaults to the active chart.")
            .activity("Drew on chart")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartAddDrawingInput,
    ) -> Result<ChartDrawingOutput, ToolError> {
        self.0.add_drawing(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartDrawingOutput) -> Option<String> {
        drawing_summary(o)
    }
}

struct UpdateDrawing(Arc<LayoutService>);

#[async_trait]
impl Tool for UpdateDrawing {
    type Input = ChartUpdateDrawingInput;
    type Output = ChartDrawingOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.update_drawing", "Edit drawing", RiskTier::Modify)
            .description("Changes a drawing (by drawingId, from chart.get_state): new anchors (as many as its kind takes), style fields (absent ones keep theirs), a note's text, the label (absent fields keep theirs: label {text: \"PDH\"} names a line, {text: \"\"} clears its words, {color: \"\"} follows the line's colour again; a Fibonacci drawing's {showLevels, showPrice}), a Fibonacci drawing's levels, or locked. A locked drawing is not moved until it is unlocked (locked: false in the same call unlocks it). Defaults to the active chart.")
            .activity("Edited drawing")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartUpdateDrawingInput,
    ) -> Result<ChartDrawingOutput, ToolError> {
        self.0.update_drawing(i, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartDrawingOutput) -> Option<String> {
        drawing_summary(o)
    }
}

struct RemoveDrawing(Arc<LayoutService>);

#[async_trait]
impl Tool for RemoveDrawing {
    type Input = ChartRemoveDrawingInput;
    type Output = RemovedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.remove_drawing", "Remove drawing", RiskTier::Modify)
            .description("Removes a drawing by drawingId, or with all: true every drawing on the chart's current instrument (an agent's all removes only agent drawings). Defaults to the active chart.")
            .activity("Removed drawing")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ChartRemoveDrawingInput,
    ) -> Result<RemovedOutput, ToolError> {
        self.0.remove_drawing(i, &ctx.origin).await
    }

    fn summarize(&self, o: &RemovedOutput) -> Option<String> {
        Some(format!("removed {}", o.removed))
    }
}

pub(crate) fn register(r: &mut ToolRegistry, s: &Arc<LayoutService>) -> Result<(), RegistryError> {
    r.register(AddDrawing(Arc::clone(s)))?;
    r.register(UpdateDrawing(Arc::clone(s)))?;
    r.register(RemoveDrawing(Arc::clone(s)))?;
    Ok(())
}
