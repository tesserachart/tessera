use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::indicators::{IndicatorSpec, indicator_spec, normalize_params};

/// Every layer kind a chart model can hold.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum LayerKind {
    /// Volume sub-pane.
    Volume,
    /// VWAP over each session, week or month, with optional σ bands.
    Vwap,
    /// Simple moving average.
    Sma,
    /// Exponential moving average.
    Ema,
    /// Price levels (vendor levels, computed concept levels).
    Levels,
    /// Relative strength index (sub-pane).
    Rsi,
    /// Average true range (sub-pane).
    Atr,
    /// Volume profile (POC, value area).
    VolumeProfile,
    /// Market Profile: each period's prices counted in time brackets, drawn as letters or blocks
    /// (TPO), with its POC, value area and initial balance.
    MarketProfile,
    /// Footprint cells (needs footprint data).
    Footprint,
    /// Large prints highlighted.
    BigTrades,
    /// Session shading.
    Sessions,
    /// Weighted moving average.
    Wma,
    /// Bollinger Bands: a moving average and σ bands.
    Bollinger,
    /// MACD: line, signal and histogram (sub-pane).
    Macd,
    /// Stochastic oscillator (sub-pane).
    Stochastic,
    /// Bar delta and cumulative volume delta (sub-pane).
    Delta,
    /// Effort absorption bands on the price.
    Effort,
    /// Stacked imbalance zones that extend right until price trades back into them (needs
    /// footprint data).
    StackedImbalance,
    /// The opening range, the initial balance and their extensions, measured each session from
    /// its open.
    OpeningRange,
    /// A custom indicator: the user's or the analyst's JavaScript, run in the runtime's script
    /// engine (`params.indicator` names it; `indicators.list`).
    Custom,
}

/// The layer kinds the UI draws today.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum DrawnLayerKind {
    /// Volume sub-pane.
    Volume,
    /// VWAP over each session, week or month, with σ bands.
    Vwap,
    /// Simple moving average.
    Sma,
    /// Exponential moving average.
    Ema,
    /// Price levels.
    Levels,
    /// Weighted moving average.
    Wma,
    /// Relative strength index.
    Rsi,
    /// Average true range.
    Atr,
    /// Bollinger Bands.
    Bollinger,
    Macd,
    /// Stochastic oscillator.
    Stochastic,
    VolumeProfile,
    /// Market Profile letters or blocks.
    MarketProfile,
    /// Footprint cells.
    Footprint,
    /// Big-trade bubbles.
    BigTrades,
    /// Bar delta and cumulative volume delta.
    Delta,
    /// Effort absorption bands.
    Effort,
    /// Stacked imbalance zones.
    StackedImbalance,
    /// Opening range and initial balance levels.
    OpeningRange,
    /// A custom indicator.
    Custom,
}

/// Data a layer kind needs from the connection serving the chart's instrument.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LayerRequirement {
    /// Footprint data (`capabilities.footprint`).
    Footprint,
}

/// Params of a `levels` layer: which levels it shows. A layer scopes either a vendor's package
/// (`Acme` · `Classic`) or a group of computed levels (`pd`), optionally to some fields.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LevelsLayerParams {
    /// Vendor (`Acme`, `Tessera` for computed levels).
    #[serde(default)]
    pub vendor: Option<String>,
    /// Vendor package (`Classic`).
    #[serde(default)]
    pub package: Option<String>,
    /// Level group (`gamma`, `pd`).
    #[serde(default)]
    pub group: Option<String>,
    /// Vendor field names shown; every field of the scope when omitted.
    #[serde(default)]
    pub fields: Option<Vec<String>>,
}

/// One entry of the registry, as `chart.list_layer_kinds` reports it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayerKindSpec {
    /// Kind.
    pub kind: LayerKind,
    /// Title (`VWAP`).
    pub title: String,
    /// What it shows: in full, or its first sentence in a compact list.
    pub description: String,
    /// The UI draws it; `chart.add_layer` refuses kinds that are not drawn yet.
    pub drawn: bool,
    /// Data it needs from the chart's connection.
    pub requires: Option<LayerRequirement>,
    /// JSON Schema of its params; listed in full entries only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub params_schema: Option<Value>,
    /// Indicators: what it takes and draws (inputs, plots, fills, placement); listed in full
    /// entries only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub indicator: Option<IndicatorSpec>,
}

impl LayerKindSpec {
    #[must_use]
    pub fn compact(self) -> Self {
        Self {
            description: first_sentence(&self.description).to_owned(),
            params_schema: None,
            indicator: None,
            ..self
        }
    }

    pub fn matches(&self, words: &str) -> bool {
        let words = words.trim().to_lowercase().replace(['_', '-'], " ");
        let kind = self.kind.as_str().replace('_', " ");
        words.is_empty() || kind.contains(&words) || self.title.to_lowercase().contains(&words)
    }
}

fn first_sentence(text: &str) -> &str {
    let mut depth = 0_i32;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            '.' if depth <= 0 && chars.peek().is_some_and(|(_, n)| *n == ' ') => {
                return &text[..=i];
            }
            _ => {}
        }
    }
    text
}

fn schema<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or(Value::Null)
}

fn normalize<T: DeserializeOwned + Serialize>(params: &Value) -> Result<Value, String> {
    let v = if params.is_null() {
        Value::Object(Default::default())
    } else {
        params.clone()
    };
    let typed: T = serde_json::from_value(v).map_err(|e| e.to_string())?;
    serde_json::to_value(typed).map_err(|e| e.to_string())
}

impl LayerKind {
    pub const ALL: [LayerKind; 21] = [
        LayerKind::Volume,
        LayerKind::Vwap,
        LayerKind::Sma,
        LayerKind::Ema,
        LayerKind::Levels,
        LayerKind::Rsi,
        LayerKind::Atr,
        LayerKind::VolumeProfile,
        LayerKind::MarketProfile,
        LayerKind::Footprint,
        LayerKind::BigTrades,
        LayerKind::Sessions,
        LayerKind::Wma,
        LayerKind::Bollinger,
        LayerKind::Macd,
        LayerKind::Stochastic,
        LayerKind::Delta,
        LayerKind::Effort,
        LayerKind::StackedImbalance,
        LayerKind::OpeningRange,
        LayerKind::Custom,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            LayerKind::Volume => "volume",
            LayerKind::Vwap => "vwap",
            LayerKind::Sma => "sma",
            LayerKind::Ema => "ema",
            LayerKind::Levels => "levels",
            LayerKind::Rsi => "rsi",
            LayerKind::Atr => "atr",
            LayerKind::VolumeProfile => "volume_profile",
            LayerKind::MarketProfile => "market_profile",
            LayerKind::Footprint => "footprint",
            LayerKind::BigTrades => "big_trades",
            LayerKind::Sessions => "sessions",
            LayerKind::Wma => "wma",
            LayerKind::Bollinger => "bollinger",
            LayerKind::Macd => "macd",
            LayerKind::Stochastic => "stochastic",
            LayerKind::Delta => "delta",
            LayerKind::Effort => "effort",
            LayerKind::StackedImbalance => "stacked_imbalance",
            LayerKind::OpeningRange => "opening_range",
            LayerKind::Custom => "custom",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == name)
    }

    pub fn drawn(self) -> Option<DrawnLayerKind> {
        match self {
            LayerKind::Volume => Some(DrawnLayerKind::Volume),
            LayerKind::Vwap => Some(DrawnLayerKind::Vwap),
            LayerKind::Sma => Some(DrawnLayerKind::Sma),
            LayerKind::Ema => Some(DrawnLayerKind::Ema),
            LayerKind::Levels => Some(DrawnLayerKind::Levels),
            LayerKind::Wma => Some(DrawnLayerKind::Wma),
            LayerKind::Rsi => Some(DrawnLayerKind::Rsi),
            LayerKind::Atr => Some(DrawnLayerKind::Atr),
            LayerKind::Bollinger => Some(DrawnLayerKind::Bollinger),
            LayerKind::Macd => Some(DrawnLayerKind::Macd),
            LayerKind::Stochastic => Some(DrawnLayerKind::Stochastic),
            LayerKind::VolumeProfile => Some(DrawnLayerKind::VolumeProfile),
            LayerKind::MarketProfile => Some(DrawnLayerKind::MarketProfile),
            LayerKind::Footprint => Some(DrawnLayerKind::Footprint),
            LayerKind::BigTrades => Some(DrawnLayerKind::BigTrades),
            LayerKind::Delta => Some(DrawnLayerKind::Delta),
            LayerKind::Effort => Some(DrawnLayerKind::Effort),
            LayerKind::StackedImbalance => Some(DrawnLayerKind::StackedImbalance),
            LayerKind::OpeningRange => Some(DrawnLayerKind::OpeningRange),
            LayerKind::Custom => Some(DrawnLayerKind::Custom),
            LayerKind::Sessions => None,
        }
    }

    pub fn requires(self) -> Option<LayerRequirement> {
        match self {
            LayerKind::Footprint
            | LayerKind::VolumeProfile
            | LayerKind::MarketProfile
            | LayerKind::Delta
            | LayerKind::BigTrades
            | LayerKind::StackedImbalance => Some(LayerRequirement::Footprint),
            _ => None,
        }
    }

    fn title(self) -> &'static str {
        match self {
            LayerKind::Volume => "Volume",
            LayerKind::Vwap => "VWAP",
            LayerKind::Sma => "SMA",
            LayerKind::Ema => "EMA",
            LayerKind::Levels => "Levels",
            LayerKind::Rsi => "RSI",
            LayerKind::Atr => "ATR",
            LayerKind::VolumeProfile => "Volume profile",
            LayerKind::MarketProfile => "Market profile (TPO)",
            LayerKind::Footprint => "Footprint",
            LayerKind::BigTrades => "Big trades",
            LayerKind::Sessions => "Sessions",
            LayerKind::Wma => "WMA",
            LayerKind::Bollinger => "Bollinger Bands",
            LayerKind::Macd => "MACD",
            LayerKind::Stochastic => "Stochastic",
            LayerKind::Delta => "Delta and CVD",
            LayerKind::Effort => "Effort absorption",
            LayerKind::StackedImbalance => "Stacked imbalance",
            LayerKind::OpeningRange => "Opening range",
            LayerKind::Custom => "Custom indicator",
        }
    }

    fn description(self) -> &'static str {
        match self {
            LayerKind::Volume => {
                "Volume histogram in its own pane, coloured by bar direction, with an optional average (inputs.maLength)."
            }
            LayerKind::Vwap => {
                "VWAP measured from every print of its period (a period whose prints are not all held or saved is weighted by bar typical price), with up to three σ bands over the same prints (inputs.band1..3 on/off, inputs.mult1..3). inputs.period picks when it starts over: session (the default: each trading day), week (the sessions whose trade dates fall in one Monday-to-Sunday week, so NQ's opens Sunday evening) or month (the sessions of one calendar month's trade dates); a weekly VWAP of NQ is chart.add_layer {kind: \"vwap\", params: {inputs: {period: \"week\"}}}. A period whose first session the chart's bars do not reach draws nothing. The values are indicators.compute vwap's with the same inputs."
            }
            LayerKind::Sma => "Simple moving average (inputs.length, inputs.source).",
            LayerKind::Ema => {
                "Exponential moving average, seeded with the SMA (inputs.length, inputs.source)."
            }
            LayerKind::Wma => "Linearly weighted moving average (inputs.length, inputs.source).",
            LayerKind::Levels => {
                "Price levels from intelligence providers (vendor/package, e.g. Acme · Classic) or computed concepts (group pd: prior-day high/low/close), optionally limited to some fields."
            }
            LayerKind::Rsi => {
                "Relative strength index with Wilder's smoothing in its own pane, 0–100, with upper/lower bands (inputs.length, source, upper, lower)."
            }
            LayerKind::Atr => {
                "Average true range in its own pane (inputs.length; inputs.smoothing: rma (Wilder, the default), sma, ema or wma)."
            }
            LayerKind::Bollinger => {
                "Bollinger Bands: SMA basis and bands at inputs.mult population standard deviations (inputs.length, source, mult)."
            }
            LayerKind::Macd => {
                "MACD in its own pane: EMA(fast) − EMA(slow), its EMA signal and the histogram between them (inputs.fast, slow, signal, source)."
            }
            LayerKind::Stochastic => {
                "Stochastic oscillator in its own pane: %K over inputs.length smoothed by smoothK, %D its SMA over smoothD, with upper/lower bands."
            }
            LayerKind::VolumeProfile => {
                "Volume by price drawn on the chart, with its POC (highlighted row and line), VAH and VAL. Every volume profile is this one study; inputs.period picks its span on the instrument's trading calendar: session (one profile per trading session), day (per calendar day in the exchange's zone), week (per trading week, Monday to Sunday trade dates, so NQ's opens Sunday evening) or month, each drawn over its period for the newest inputs.length periods; composite (the newest inputs.length periods of inputs.compositePeriod session, day, week or month merged into one, drawn at the right edge and rolling forward as periods close); range (a fixed range from inputs.from to inputs.to, drawn over those bars); anchored (from inputs.from to the newest print, growing as prints come in); visible (the bars in view). inputs.length has no cap: a profile reads as far back as the prints held allow. inputs.from and inputs.to are times (RFC 3339 or nanoseconds); the user sets them by clicking the chart with the rail's Fixed range or Anchored volume profile tool. Each draws on every timeframe, 1D included, and on tick, range and volume bars. A weekly profile of NQ is chart.add_layer {kind: \"volume_profile\", params: {inputs: {period: \"week\"}}}; a 13-week rolling composite is {period: \"composite\", compositePeriod: \"week\", length: 13}; the profile from bar X to bar Y is {period: \"range\", from: X, to: Y}. inputs.show volume, split (bid/ask), delta, or volumeDelta (volume with each row's delta in a column beside it); inputs.hours chart (the default: the chart's own hours, chart.set_hours), all (the whole period), rth (only the regular-hours prints, ranges and composites included) or split (each period as its overnight (ETH) and regular-hours (RTH) profiles); inputs.contract chart (the contract the chart shows); inputs.valueArea percent; for session, day, week and month: inputs.side left draws each period's profile from its start, right against its end; inputs.priorVa carries the prior period's POC, VAH and VAL (pPOC, pVAH, pVAL) across the newest period; inputs.nakedPocs draws earlier periods' untouched POCs. inputs.extendLines runs POC, VAH and VAL to the chart's right edge; inputs.developingPoc and inputs.developingVa trace the POC and the value area as the bars came in; inputs.nodes marks high-volume nodes (a mist rule) and low-volume nodes (dotted) where the smoothed profile peaks and dips by at least 12% of its busiest row. The numbers are market.get_volume_profile's for the same mode, and the session, week and month POC, VAH and VAL are the volume_profile concept's (concepts.get_levels group vp). Once drawn, chart.get_state's viewport.profiles lists each profile the chart shows with its POC, VAH and VAL: read it to confirm the profile rendered."
            }
            LayerKind::MarketProfile => {
                "Market Profile (TPO) drawn on the chart: each period's prices counted in time, one letter (or block) per inputs.tpo-minute bracket at every price the bracket traded from its low to its high, stacked from the period's start, with the TPO POC (the price the most brackets visited, highlighted row and line), the value area (VAH and VAL) holding inputs.valueArea percent of the letters, and the initial balance (the first hour from the regular open) as a bar beside the letters. Letters run A to Z then a to z from each session's open and start again at the next session. inputs.period picks the span on the instrument's trading calendar: session (the default), day, week or month, for the newest inputs.length periods; inputs.tpo the bracket in minutes (30, the classic, or 5, 10, 15, 60); inputs.style letters (the default) or blocks; inputs.hours chart (the chart's hours), all or rth; inputs.rowTicks auto or ticks per row; inputs.ib the initial balance bar. Where letters would be too small to read they draw as blocks. Measured from the same prints as the volume profile: the numbers are market.get_volume_profile's with tpoMinutes for the same mode. A 30-minute TPO of NQ's sessions is chart.add_layer {kind: \"market_profile\"}; chart.get_state's viewport.profiles lists each drawn profile with its TPO POC, VAH and VAL."
            }
            LayerKind::Footprint => {
                "Bid × ask volume per price inside each bar, replacing the candles once bars are wide enough (zoom in for the numbers): inputs.mode bid_ask, delta, volume, trades or histogram; inputs.tint volume, delta or none; inputs.rowTicks auto or ticks per row; diagonal imbalances at inputs.ratio (with inputs.minVolume, inputs.minDifference between the sides, and inputs.includeZero to count a side against an empty row), found on the contract's rows or inputs.rowTicks at every zoom, stacked from inputs.stackRows rows and extended as zones (inputs.extendZones); the POC boxed (inputs.poc); per bar the delta POC (inputs.deltaPoc), its value area (inputs.valueArea) and unfinished auctions at its high or low (inputs.unfinished); inputs.mode volume draws each bar as a profile of its rows; inputs.stats adds a table of each bar's volume, delta, delta %, delta high and low and CVD across the pane's foot. inputs.mode trades writes the count of prints at each price; histogram draws each row's bid and ask volume as bars out from the bar's centre, bid left and ask right, with the bid × ask numbers over them once they fit. inputs.dimBelow (percent, 0 off) fades every row that traded less than that share of its bar's busiest row; inputs.maxLevel off, volume, trades, bid or ask outlines each bar's row with the most of it. Rows default to the contract's (NQ 4 ticks, ES 1). The numbers are market.get_footprint's."
            }
            LayerKind::BigTrades => {
                "Big trades as bubbles at their time and price (market.get_big_trades' set): one bubble per event, never merged. Prints group into events as inputs.joinOrders and inputs.reachLimit say, both on by default; both off joins them by the 5 ms chain alone (market.get_big_trades describes the rule). Every event the filter admits is one bubble at every zoom, fixed at its own candle: its x is the centre of that candle's body (with a footprint on, the centre of that bar's stem) and its y is the plotted price, the same point on every frame, scroll and zoom, never summed, slid sideways or moved to dodge a neighbour. A bubble is a disc of the buy colour for a buy aggressor or the sell colour for a sell at 75% over a 1 px ring of it; its radius in pixels grows with the bar spacing (2 to 10 px) and with the square root of its size over the filter's minimum (Auto: the chosen tier's cut for the trade date), up to 2.5 times, and while a footprint replaces the candles it is capped to its bar plus a slight spill; the disc is never stretched to hold a figure. Discs paint smallest first so the bigger one sits on top and its ring reads. With inputs.showSize on (the default) a bubble carries its size only where the figure fits inside that disc and its box touches no other figure, so figures come in a few at a time as the bars widen, the biggest trades first, and under 5 px bars none carries one. inputs.price places a bubble at the event's average price rounded to a tick (vwap, the default), its first print (start) or its last (last). The tooltip is a card per event: side, size, price, time, fills, and what happened in the 60 s after it (market.get_big_trades' outcome: pushed, absorbed or neither, decided live from the tape the same way); the bubble's look does not change with it. inputs.size picks how the events are chosen. auto (the default) shows the events Tessera's model calls big for their trade date, at or above the cut of the tier inputs.tier names: low (the default) is every tier, about the 120th largest event of a session and up, medium is the 45th and up, high is the 15th and up (as market.get_big_trades describes; with under an hour of events in the five sessions before, Auto shows none and its legend says sizing). fixed shows the events of at least inputs.minSize lots (default 60) and at most inputs.maxSize (0, the default: no limit); inputs.tier is kept while fixed holds and inputs.minSize and inputs.maxSize while auto holds, and only the ones the current size names apply. inputs.zones on projects a band from each big trade's plotted price, one tick either side, from the bar after it for inputs.zoneBars bars, ending where a later bar trades through it; inputs.zoneBody (trades in the bar's body) and inputs.zoneWick (trades in its wick) pick which trades make one by where the price sits in its bar and by side against the bar (trend: a buy in an up bar or a sell in a down or flat bar; reversal: the opposite; all; none), and inputs.zoneBiggest keeps the largest of each bar only."
            }
            LayerKind::Delta => {
                "Order-flow delta in its own pane: the cumulative volume delta (inputs.mode cumulative, candles, a line or a histogram of the running total from zero by inputs.style, reset each session or from the chart start by inputs.reset) or each bar's delta (bar); inputs.barStats adds each bar's delta and volume under it when bars are wide. inputs.highlight (a percent, 0 the default is off) keeps the bars whose |delta| is at least that share of their volume at full strength and fades the rest; on a line it dots those bars. inputs.divergence (off by default) marks each bar whose price closed against its delta (up on negative delta, down on positive) with a small triangle pointing the way price closed, in the up or down colour, just past the bar's mark on its delta's side. The numbers are market.get_footprint's."
            }
            LayerKind::Effort => {
                "Absorption bands on the price: a bar qualifies when its delta is strongly one-sided (inputs.minDeltaPercent to inputs.maxDeltaPercent of its volume) but price barely moved (inputs.maxDeltaPerTick) and the bar formed within inputs.maxBarSeconds; consecutive qualifying bars arm a band over the streak's range (the middle inputs.keepPercent after inputs.fullRangeBars) that projects inputs.extendBars bars, ending where price trades back into it. Built for tick charts: inputs.tickSize converts the open-close distance and inputs.maxBarSeconds assumes sub-minute bars. Add it to a 40-tick NQ chart."
            }
            LayerKind::StackedImbalance => {
                "Stacked imbalances as zones on the price, with or without the footprint: a bar's stack of inputs.stackRows or more adjacent rows where one side's aggression beat the other's on the diagonal by inputs.ratio (buyers at a row against sellers one row below; sellers against buyers one row above), with inputs.minVolume, inputs.minDifference and inputs.includeZero as the footprint reads them, on rows of inputs.rowTicks (auto: the contract's footprint rows, NQ 4 ticks, ES 1). Each zone covers its stack's rows and runs right from its bar until a later bar trades back into it or three trading days pass; buy stacks in the ask colour, sell stacks in the bid colour. inputs.tested keeps zones price came back to, ended at the bar that touched them; off shows only the zones still open. An alert fires when price returns to one: alerts.create with subject {kind: \"stacked_imbalance\", side, ratio, minVolume, minDifference, includeZero, rowTicks}, op at_least and the minimum stack as the value. The numbers are market.get_footprint's."
            }
            LayerKind::OpeningRange => {
                "The opening range and the initial balance of every session, with extensions beyond them, as levels on the price: each session's high and low over its first inputs.minutes minutes (the opening range, default 15) and its first inputs.ib minutes (the initial balance, default 60), timed from the regular open (inputs.open rth, the default) or from the session's open (session). A market without a regular session times them from its session's open. Each level is one horizontal line from its window's open to the session's end: the window's final high or low once it closes, the high or low so far while it trades. The extensions appear once the range they extend has closed. inputs.extensions picks what the ±50% and ±100% lines extend: the initial balance's range (ib, the default) or the opening range's (range). Measured from the session's one-minute bars, so the levels are the same on every interval, tick and volume bars included; the initial balance matches concepts.get_levels group ib for the same minutes."
            }
            LayerKind::Sessions => "Shading of trading sessions.",
            LayerKind::Custom => {
                "A custom indicator written in JavaScript (the user's or the analyst's), computed by the runtime's script engine over the chart's bars: params.indicator is its id from indicators.list, params.version pins a saved version (the latest when omitted, so saves show at once); params.inputs and params.style follow its own declaration (indicators.get), like a built-in indicator's."
            }
        }
    }

    fn params_schema(self) -> Value {
        if let Some(spec) = indicator_spec(self) {
            return crate::indicators::params_schema(&spec);
        }
        match self {
            LayerKind::Levels => schema::<LevelsLayerParams>(),
            LayerKind::Custom => schema::<crate::indicators::CustomLayerParams>(),
            _ => serde_json::json!({ "type": "object" }),
        }
    }

    pub fn indicator(self) -> Option<IndicatorSpec> {
        indicator_spec(self)
    }

    pub fn spec(self) -> LayerKindSpec {
        LayerKindSpec {
            kind: self,
            title: self.title().to_owned(),
            description: self.description().to_owned(),
            drawn: self.drawn().is_some(),
            requires: self.requires(),
            params_schema: Some(self.params_schema()),
            indicator: self.indicator(),
        }
    }

    pub fn validate_params(self, params: &Value) -> Result<Value, String> {
        if let Some(spec) = indicator_spec(self) {
            return normalize_params(&spec, params);
        }
        match self {
            LayerKind::Levels => {
                let v = normalize::<LevelsLayerParams>(params)?;
                let p: LevelsLayerParams =
                    serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
                if p.vendor.is_none() && p.group.is_none() {
                    return Err("a levels layer scopes a vendor or a group".into());
                }
                Ok(v)
            }
            LayerKind::Custom => crate::indicators::normalize_custom_params(None, params),
            other => Err(format!("{} layers take no params yet", other.as_str())),
        }
    }
}

impl std::fmt::Display for LayerKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_is_consistent() {
        for k in LayerKind::ALL {
            assert_eq!(LayerKind::parse(k.as_str()), Some(k));
            assert_eq!(serde_json::to_value(k).unwrap(), json!(k.as_str()));
            let spec = k.spec();
            assert_eq!(spec.drawn, k.drawn().is_some());
            if let Some(d) = k.drawn() {
                assert_eq!(
                    serde_json::to_value(d).unwrap(),
                    json!(k.as_str()),
                    "drawn kinds keep their wire names"
                );
            }
        }
        assert_eq!(
            LayerKind::Delta.requires(),
            Some(LayerRequirement::Footprint)
        );
        assert!(LayerKind::parse("nope").is_none());
    }

    #[test]
    fn params_are_validated_and_normalized() {
        let vwap = LayerKind::Vwap
            .validate_params(&json!({"bands": [1, 2]}))
            .unwrap();
        assert_eq!(vwap["inputs"]["band2"], false, "legacy bands stay off");
        assert_eq!(vwap["inputs"]["mult2"], 2.0);
        assert!(
            LayerKind::Vwap
                .validate_params(&json!({"inputs": {"mult1": 9}}))
                .is_err()
        );
        assert!(LayerKind::Vwap.validate_params(&json!({"x": 1})).is_err());
        assert_eq!(
            LayerKind::Sma
                .validate_params(&json!({"period": 20}))
                .unwrap()["inputs"],
            json!({"length": 20, "source": "close"})
        );
        assert_eq!(
            LayerKind::Ema.validate_params(&json!({})).unwrap()["inputs"]["length"],
            9
        );
        assert!(
            LayerKind::Ema
                .validate_params(&json!({"period": 0}))
                .is_err()
        );
        assert!(
            LayerKind::Levels
                .validate_params(&json!({"fields": ["pdh"]}))
                .is_err()
        );
        assert!(
            LayerKind::Levels
                .validate_params(&json!({"group": "pd", "fields": ["pdh"]}))
                .is_ok()
        );
        assert_eq!(
            LayerKind::Volume.validate_params(&Value::Null).unwrap()["height"],
            0.1
        );
    }

    #[test]
    fn every_indicator_is_drawn() {
        for k in LayerKind::ALL {
            if let Some(i) = k.spec().indicator {
                assert!(
                    k.drawn().is_some(),
                    "{k}: an indicator the UI does not draw"
                );
                assert_eq!(i.kind, k);
            }
        }
        assert!(LayerKind::Levels.drawn().is_some() && LayerKind::Levels.indicator().is_none());
    }

    #[test]
    fn a_compact_kind_keeps_its_first_whole_sentence_and_drops_its_schema() {
        for k in LayerKind::ALL {
            let full = k.spec();
            let compact = full.clone().compact();
            assert!(compact.params_schema.is_none() && compact.indicator.is_none());
            assert!(full.description.starts_with(&compact.description), "{k}");
            assert!(
                compact.description.len() <= 1_000,
                "{k}: {}",
                compact.description
            );
            assert!(
                compact.description.ends_with('.') || compact.description == full.description,
                "{k}: {}",
                compact.description
            );
        }
        assert!(
            LayerKind::Levels
                .spec()
                .compact()
                .description
                .contains("Acme · Classic"),
            "an abbreviation in brackets does not end the sentence"
        );
    }

    #[test]
    fn a_kind_matches_its_id_or_title_in_any_case() {
        let named = |words: &str| -> Vec<LayerKind> {
            LayerKind::ALL
                .into_iter()
                .filter(|k| k.spec().matches(words))
                .collect()
        };
        assert_eq!(named("volume_profile"), [LayerKind::VolumeProfile]);
        assert_eq!(
            named("Profile"),
            [LayerKind::VolumeProfile, LayerKind::MarketProfile]
        );
        assert_eq!(named("tpo"), [LayerKind::MarketProfile]);
        assert_eq!(named("big trades"), [LayerKind::BigTrades]);
        assert_eq!(named("").len(), LayerKind::ALL.len());
        assert!(named("renko").is_empty());
    }
}
