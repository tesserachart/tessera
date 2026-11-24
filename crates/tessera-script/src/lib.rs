mod engine;
mod indicator;
mod strategy;

pub use engine::{CodeError, CodeFrame, Limits, MAX_LOG, ScriptError};
pub use indicator::{
    BarArrays, IndicatorManifest, IndicatorRun, MAX_CODE, Series, call, describe, run_indicator,
};
pub use strategy::{Decisions, StudyColumns, describe_strategy, read_records, run_strategy};

pub const ENGINE: &str = "QuickJS-ng (rquickjs 0.14)";

pub fn walls() -> Vec<String> {
    vec![
        "JavaScript in an embedded QuickJS engine, inside Tessera's runtime: nothing to install"
            .into(),
        "only the language and the indicator API: no imports, files, network, timers or processes"
            .into(),
        format!(
            "each run in a fresh engine with {} MB of memory and {} s of time",
            Limits::INDICATOR.memory >> 20,
            Limits::INDICATOR.time.as_secs()
        ),
    ]
}
