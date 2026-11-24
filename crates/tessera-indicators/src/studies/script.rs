use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use tessera_script::{Limits, ScriptError};

use super::{Drawn, FORMING_THROTTLE, Study};
use crate::frame::{Changed, Rows};

pub(crate) struct ScriptStudy {
    code: Arc<str>,
    inputs: Map<String, Value>,
    columns: Vec<String>,
}

impl std::fmt::Debug for ScriptStudy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScriptStudy")
            .field("inputs", &self.inputs)
            .field("columns", &self.columns)
            .finish_non_exhaustive()
    }
}

impl ScriptStudy {
    pub fn new(code: &str, inputs: Map<String, Value>, columns: Vec<String>) -> Self {
        Self {
            code: Arc::from(code),
            inputs,
            columns,
        }
    }
}

impl Study for ScriptStudy {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn forming_every(&self) -> Duration {
        FORMING_THROTTLE
    }

    fn restart(&self, _rows: &Rows, _changed: Changed) -> usize {
        0
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        _from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let run = tessera_script::run_indicator(
            &self.code,
            &rows.arrays(),
            &self.inputs,
            Limits::INDICATOR,
        )?;
        for (c, key) in self.columns.iter().enumerate() {
            let values = run.series.iter().find(|(k, _)| k == key).map(|(_, v)| v);
            for (i, out) in cols[c].iter_mut().enumerate() {
                *out = values
                    .and_then(|v| v.get(i).copied())
                    .filter(|x| x.is_finite())
                    .unwrap_or(f64::NAN);
            }
        }
        Ok(Some(Drawn::new(run.objects, run.logs)))
    }
}
