use std::sync::Arc;

use async_trait::async_trait;
use tessera_market::MarketDataProvider;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{Tool, ToolCtx, ToolError, ToolMeta};

use crate::cache::FrameKey;
use crate::io::{
    ComputeInput, CreateCustomInput, DeleteCustomInput, DeleteCustomOutput, GetIndicatorInput,
    IndicatorDetail, IndicatorSeries, IndicatorsListOutput, ListIndicatorsInput, PreviewInput,
    ReachInput, ReachOutput, UpdateCustomInput,
};
use crate::service::IndicatorsService;

const CODE_GUIDE: &str = "Custom indicators are JavaScript (an ES module) run by Tessera's built-in engine (QuickJS: no imports, files, network or timers; 2 s and 64 MB per run). Declare it: export const indicator = { title: 'EMA cross', short: 'EMA×', placement: 'overlay' (on the price) or 'pane' (own pane, the default), inputs: { fast: { type: 'int', default: 9, min: 1, max: 500 }, source: 'close' } (types int, number, bool, source, enum, color, session (hours 'HH:MM-HH:MM'), timezone (an IANA name); a bare default infers the type; a source input arrives as the price series it names; at most 24), plots: [{ name: 'fast', color: 'teal' }, { name: 'hist', kind: 'histogram', colorBy: 'sign' }, { name: 'zero', kind: 'hline', value: 0 }] (plots: [] when it only draws), optional fills: [{ from: 'upper', to: 'lower' }], range: [0, 100], format ('price' | 'number' | 'volume'), description }. Then export function compute(bars, inputs): bars.time (UTC seconds), open, high, low, close, volume, hl2, hlc3, ohlc4, day (the trading day, yyyymmdd) and, when the market reports aggressor sides, buyVolume, sellVolume, delta (Float64Arrays, oldest first; bars.length); return { plotName: array as long as the bars } (NaN where there is no value). Globals: ta (sma, ema, rma, wma, stdev, zscore, sum, cum, highest, lowest, shift, change, crossover, crossunder, rsi, tr, atr, vwap(bars, {reset: 'day'|'week'|'none'}) and vwapStdev over bar typical prices, firstAbove(x, level, from), firstBelow — the chart's own definitions, except the chart's VWAP, which is measured from prints: read it with indicators.compute vwap), session (hours are read in UTC unless an IANA zone follows them, daylight saving handled: list(bars, '07:00-10:00', 'Europe/London') gives each occurrence {start, end, high, highAt, low, lowAt, complete}; an unknown zone is refused; days(bars), weeks(bars) the instrument's trading days and weeks, which no zone changes; ids(bars, hours, zone), high, low (running), prior(bars, 'day'|'week'|hours, zone) {high, low} per bar; clock(t, zone = 'UTC') {year, month, day, weekday, hour, minute, second}; give a session's hours and zone as session and timezone inputs), console.log, and draw (Pine's line.new, label.new, box.new): draw.line(time1, price1, [time2, price2,] {color, width, style: 'solid'|'dash'|'dot', extend: 'none'|'left'|'right'|'both', label: 'text', labelAt: 'start'|'middle'|'end', labelSide: 'above'|'below', labelColor}) (no time2 runs it to the last bar, no price2 keeps it level; its label is in the line's colour), draw.label(time, price, text, {color, size: 'small'|'normal'|'large', side: 'above'|'below'|'at'}), draw.box(time1, price1, time2, price2, {color, fill, opacity, label, …}); times are bar times (bars.time[i]); each returns a handle to change later (lv.time2 = bars.time[j]; lv.style = 'dash' stops a level where price traded through it) or lv.delete(); at most 500 of each kind, the newest kept. A level, zone or name that must move with new sessions belongs in an indicator's lines and labels, not in fixed chart notes (chart_annotate, chart_add_drawing): those stay where they were put. Errors name the line. Full guide, with a complete session-levels example: docs/indicators.md.";

pub(crate) struct ListIndicators(pub Arc<IndicatorsService>);

#[async_trait]
impl Tool for ListIndicators {
    type Input = ListIndicatorsInput;
    type Output = IndicatorsListOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("indicators.list", "List indicators", RiskTier::Read)
            .description("Every indicator: the built-ins (each with its declaration: inputs, plots, placement) and the custom ones the user or an analyst wrote in JavaScript (id, latest version, declaration, description), plus the engine that runs them and its walls. Add one to a chart with chart.add_layer: a built-in by its kind; a custom one with kind custom and params {indicator: id}.")
            .activity("Listing indicators")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: ListIndicatorsInput,
    ) -> Result<IndicatorsListOutput, ToolError> {
        Ok(IndicatorsListOutput {
            builtins: IndicatorsService::builtins(),
            custom: self.0.custom(),
            sandbox: self.0.status(),
        })
    }

    fn summarize(&self, out: &IndicatorsListOutput) -> Option<String> {
        Some(format!(
            "{} built-in, {} custom",
            out.builtins.len(),
            out.custom.len()
        ))
    }
}

pub(crate) struct GetIndicator(pub Arc<IndicatorsService>);

#[async_trait]
impl Tool for GetIndicator {
    type Input = GetIndicatorInput;
    type Output = IndicatorDetail;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("indicators.get", "Get an indicator", RiskTier::Read)
            .description("One indicator: a built-in by its kind (rsi) with its declaration, or a custom one by its id with its JavaScript (at its latest version, or the version asked for), its declaration and its saved versions.")
            .activity("Reading an indicator")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: GetIndicatorInput,
    ) -> Result<IndicatorDetail, ToolError> {
        self.0.get(&input.id, input.version).await
    }

    fn summarize(&self, out: &IndicatorDetail) -> Option<String> {
        match (&out.builtin, &out.custom) {
            (Some(b), _) => Some(b.spec.title.clone()),
            (_, Some(c)) => Some(format!("{} v{}", c.spec.title, c.version)),
            _ => None,
        }
    }
}

pub(crate) struct CreateCustom(pub Arc<IndicatorsService>);

#[async_trait]
impl Tool for CreateCustom {
    type Input = CreateCustomInput;
    type Output = IndicatorDetail;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("indicators.create_custom", "Create a custom indicator", RiskTier::Modify)
            .description(format!("Saves a new custom indicator (version 1) from JavaScript, after reading its declaration; a bad declaration is refused with the line it is on. Try the code first with indicators.preview. Returns its id; draw it with chart.add_layer {{kind: 'custom', params: {{indicator: id}}}}. {CODE_GUIDE}"))
            .activity("Writing an indicator")
            .timeout_ms(30_000)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CreateCustomInput,
    ) -> Result<IndicatorDetail, ToolError> {
        self.0
            .create(&input.code, input.note, &ctx.origin, ctx.now)
            .await
    }

    fn summarize(&self, out: &IndicatorDetail) -> Option<String> {
        out.custom
            .as_ref()
            .map(|c| format!("{} ({})", c.spec.title, c.id))
    }
}

pub(crate) struct UpdateCustom(pub Arc<IndicatorsService>);

#[async_trait]
impl Tool for UpdateCustom {
    type Input = UpdateCustomInput;
    type Output = IndicatorDetail;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("indicators.update_custom", "Change a custom indicator", RiskTier::Modify)
            .description(format!("Saves new code for a custom indicator as its next version (earlier versions are kept; indicators.get lists them). Charts that draw its latest version recompute at once. Give base_version (the version you edited) so a save made in between is not overwritten. {CODE_GUIDE}"))
            .activity("Changing an indicator")
            .timeout_ms(30_000)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: UpdateCustomInput,
    ) -> Result<IndicatorDetail, ToolError> {
        self.0
            .update(
                &input.id,
                &input.code,
                input.note,
                input.base_version,
                &ctx.origin,
                ctx.now,
            )
            .await
    }

    fn summarize(&self, out: &IndicatorDetail) -> Option<String> {
        out.custom
            .as_ref()
            .map(|c| format!("{} v{}", c.spec.title, c.version))
    }
}

pub(crate) struct DeleteCustom(pub Arc<IndicatorsService>);

#[async_trait]
impl Tool for DeleteCustom {
    type Input = DeleteCustomInput;
    type Output = DeleteCustomOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("indicators.delete_custom", "Delete a custom indicator", RiskTier::Modify)
            .description("Deletes a custom indicator and every saved version. Charts that draw it show that it is gone; remove their layers with chart.remove_layer.")
            .activity("Deleting an indicator")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: DeleteCustomInput,
    ) -> Result<DeleteCustomOutput, ToolError> {
        Ok(DeleteCustomOutput {
            deleted: self.0.delete(&input.id).await?,
        })
    }
}

pub(crate) struct Compute(pub Arc<IndicatorsService>);

#[async_trait]
impl Tool for Compute {
    type Input = ComputeInput;
    type Output = IndicatorSeries;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("indicators.compute", "Compute an indicator", RiskTier::Read)
            .description("An indicator's values over an instrument's bars (the newest `limit`, default 500, or from/to; session rth for regular hours only) with the inputs given (defaults for the rest): a custom indicator by its id, or a built-in by its kind (sma, ema, wma, vwap, volume, rsi, atr, bollinger, macd, stochastic, delta; footprint, volume profile and big trades are read with the market tools). One value per bar per series, null where there is none. The values are the ones the runtime keeps for the instrument's bars, which a chart showing them draws: averages and running totals start at computedFrom, which can be before the first bar returned, so an average there is already warm. When the runtime keeps no values reaching that far back, they are computed over the bars asked for and computedFrom is their first bar. vwap is the VWAP the chart draws, measured from the prints of each period from its open: inputs.period session (the default), week or month (the bars of the first period before the ones returned are read too); a period whose bars' prints are not all held or saved is weighted by bar typical price (h+l+c)/3 instead. delta returns each bar's delta and volume and the cumulative delta as open, high, low and close (close is the CVD line); bars whose prints are not known have none; a session counts from its first bar when that bar's prints are held, and the session the prints are known only partway through counts from the first bar they cover. A read reads the prints of the newest session at once; older sessions are measured once a chart following them has read them. These are measured values of the formula over the data, not predictions. Use `tail` to get only the last values.")
            .activity("Computing an indicator")
            .timeout_ms(30_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ComputeInput,
    ) -> Result<IndicatorSeries, ToolError> {
        self.0.compute(input).await
    }

    fn summarize(&self, out: &IndicatorSeries) -> Option<String> {
        Some(format!(
            "{} on {} {}: {} bars, {:.0} ms",
            out.spec.short, out.instrument, out.tf, out.bars, out.compute_ms
        ))
    }
}

pub(crate) struct Preview(pub Arc<IndicatorsService>);

#[async_trait]
impl Tool for Preview {
    type Input = PreviewInput;
    type Output = IndicatorSeries;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("indicators.preview", "Try indicator code", RiskTier::Read)
            .description(format!("Runs unsaved custom-indicator code over an instrument's newest bars and returns its declaration and values (or the error, with its line), without saving anything: use it to check code before indicators.create_custom or indicators.update_custom. {CODE_GUIDE}"))
            .activity("Trying indicator code")
            .timeout_ms(30_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: PreviewInput,
    ) -> Result<IndicatorSeries, ToolError> {
        self.0.preview(input).await
    }

    fn summarize(&self, out: &IndicatorSeries) -> Option<String> {
        Some(format!(
            "{}: {} bars, {:.0} ms",
            out.spec.short, out.bars, out.compute_ms
        ))
    }
}

pub(crate) struct Reach(pub Arc<IndicatorsService>);

#[async_trait]
impl Tool for Reach {
    type Input = ReachInput;
    type Output = ReachOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("indicators.reach", "Reach indicator values back", RiskTier::Read)
            .description("Extends every indicator series of an instrument's bars (one timeframe and session) back to `from`, a chart's first bar, so the values its series send cover the bars the chart holds; at most 50,000 bars are kept, the newest. Asking again for the same or a later bar does nothing. Returns the first bar now covered.")
            .activity("Reaching indicator values back")
            .user_only()
            .idempotent(true)
            .quiet()
    }

    async fn call(&self, _ctx: &ToolCtx, input: ReachInput) -> Result<ReachOutput, ToolError> {
        let instrument = self
            .0
            .market()
            .resolve(&input.instrument)
            .await
            .map_err(tessera_market::market_error)?;
        let key = FrameKey {
            instrument,
            bars: crate::frame::BarKind::Time(input.tf),
            session: input.session.unwrap_or_default(),
        };
        let grid = self.0.grid(&key).await;
        let from = self.0.cache().reach(&key, grid, input.from.0).await?;
        Ok(ReachOutput {
            from: from.map(tessera_core::Timestamp),
        })
    }
}
