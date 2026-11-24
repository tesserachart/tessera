mod delta;
mod effort;
mod natives;
mod opening;
mod script;
mod vwap;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use tessera_protocol::indicators::IndicatorObjects;
use tessera_protocol::layers::LayerKind;
use tessera_script::ScriptError;

use crate::frame::{Changed, Opening, Period, Rows};

pub(crate) use script::ScriptStudy;

pub const COMPUTED_BUILTINS: [&str; 12] = [
    "sma",
    "ema",
    "wma",
    "vwap",
    "volume",
    "rsi",
    "atr",
    "bollinger",
    "macd",
    "stochastic",
    "delta",
    "opening_range",
];

pub(crate) const NATIVE_FORMING_EVERY: Duration = Duration::from_millis(100);
pub const FORMING_THROTTLE: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Pulls {
    No,
    Sessions(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Needs {
    Bars,
    Flow(Pulls),
}

impl Needs {
    pub fn reads_flow(self) -> bool {
        matches!(self, Needs::Flow(_))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Drawn {
    pub objects: IndicatorObjects,
    pub logs: String,
    bytes: usize,
}

impl Drawn {
    pub fn new(objects: IndicatorObjects, logs: String) -> Self {
        let drawn = serde_json::to_vec(&objects).map_or(0, |v| v.len());
        let bytes = std::mem::size_of::<Self>() + drawn + logs.len();
        Self {
            objects,
            logs,
            bytes,
        }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

pub(crate) trait Study: Send + Sync + std::fmt::Debug + 'static {
    fn columns(&self) -> &[String];

    fn state(&self) -> usize {
        0
    }

    fn needs(&self) -> Needs {
        Needs::Bars
    }

    fn forming_every(&self) -> Duration {
        NATIVE_FORMING_EVERY
    }

    fn restart(&self, _rows: &Rows, changed: Changed) -> usize {
        changed.at
    }

    fn period(&self) -> Option<Period> {
        None
    }

    fn opening(&self) -> Option<Opening> {
        None
    }

    fn plot_key<'a>(&self, column: &'a str) -> &'a str {
        column
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError>;
}

pub(crate) fn native(kind: LayerKind, inputs: &Map<String, Value>) -> Option<Arc<dyn Study>> {
    let i = natives::Inputs(inputs);
    Some(match kind {
        LayerKind::Sma => Arc::new(natives::Sma::of(i)),
        LayerKind::Ema => Arc::new(natives::Ema::of(i)),
        LayerKind::Wma => Arc::new(natives::Wma::of(i)),
        LayerKind::Vwap => Arc::new(vwap::Vwap::of(i)),
        LayerKind::Volume => Arc::new(natives::Volume::of(i)),
        LayerKind::Rsi => Arc::new(natives::Rsi::of(i)),
        LayerKind::Atr => Arc::new(natives::Atr::of(i)),
        LayerKind::Bollinger => Arc::new(natives::Bollinger::of(i)),
        LayerKind::Macd => Arc::new(natives::Macd::of(i)),
        LayerKind::Stochastic => Arc::new(natives::Stochastic::of(i)),
        LayerKind::Delta => Arc::new(delta::Delta::of(i)),
        LayerKind::Effort => Arc::new(effort::Effort::of(i)),
        LayerKind::OpeningRange => Arc::new(opening::OpeningRange::of(i)),
        LayerKind::Levels
        | LayerKind::VolumeProfile
        | LayerKind::MarketProfile
        | LayerKind::Footprint
        | LayerKind::BigTrades
        | LayerKind::StackedImbalance
        | LayerKind::Sessions
        | LayerKind::Custom => return None,
    })
}

#[derive(Debug)]
pub(crate) struct Failed(pub String);

impl Study for Failed {
    fn columns(&self) -> &[String] {
        &[]
    }

    fn restart(&self, _rows: &Rows, _changed: Changed) -> usize {
        0
    }

    fn run(
        &self,
        _rows: &Rows,
        _cols: &mut [Vec<f64>],
        _from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        Err(ScriptError::invalid(self.0.clone()))
    }
}

pub(crate) fn session_restart(rows: &Rows, changed: Changed) -> usize {
    period_restart(rows, changed, Period::Session)
}

pub(crate) fn period_restart(rows: &Rows, changed: Changed, period: Period) -> usize {
    let at = changed.at.min(rows.len());
    let around = [
        changed.day,
        rows.iter().nth(at).map(|r| r.day),
        at.checked_sub(1).map(|i| rows[i].day),
    ]
    .map(|day| day.map(|d| period.of_day(d)));
    (0..at)
        .rev()
        .take_while(|i| around.contains(&Some(period.of_day(rows[*i].day))))
        .last()
        .unwrap_or(at)
}

pub(crate) fn columns(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|k| (*k).to_owned()).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tessera_protocol::indicators::{PlotKind, indicator_spec, normalize_params};

    use super::*;

    fn defaults(kind: LayerKind) -> Option<Map<String, Value>> {
        let spec = indicator_spec(kind)?;
        let p = normalize_params(&spec, &json!({})).ok()?;
        p["inputs"].as_object().cloned()
    }

    #[test]
    fn the_computed_builtins_are_the_native_studies_that_compute_a_plot() {
        let natives: Vec<&str> = LayerKind::ALL
            .iter()
            .filter(|k| {
                defaults(**k)
                    .and_then(|i| native(**k, &i))
                    .is_some_and(|study| !study.columns().is_empty())
            })
            .map(|k| k.as_str())
            .collect();
        let mut listed = COMPUTED_BUILTINS.to_vec();
        listed.sort_unstable();
        let mut natives_sorted = natives.clone();
        natives_sorted.sort_unstable();
        assert_eq!(natives_sorted, listed);
    }

    #[test]
    fn every_native_computes_each_plot_its_declaration_draws() {
        for kind in LayerKind::ALL {
            let Some(inputs) = defaults(kind) else {
                continue;
            };
            let Some(study) = native(kind, &inputs) else {
                continue;
            };
            let spec = indicator_spec(kind).unwrap();
            for plot in spec.plots.iter().filter(|p| p.kind != PlotKind::Hline) {
                let drawn_from = match (kind, plot.key.as_str()) {
                    (LayerKind::Delta, "cvd") => "close",
                    (_, key) => key,
                };
                assert!(
                    study.columns().iter().any(|c| c == drawn_from),
                    "{kind}: {} is not computed",
                    plot.key
                );
            }
        }
    }
}
