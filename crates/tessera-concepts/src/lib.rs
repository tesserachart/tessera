pub mod atr;
pub mod initial_balance;
pub mod module;
pub mod prior_day;
pub mod volume_profile;

pub use module::{ConceptsModule, ts_exports};

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::market::Bar;
use tessera_core::session::SessionCalendar;
use tessera_core::{InstrumentId, Timeframe, Timestamp};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "bars")]
pub enum Lookback {
    Bars(usize),
    Session,
    Unbounded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AvailableAt {
    BarClose,
    BarOpen,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputKind {
    Value,
    State,
    Signal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSpec {
    pub name: String,
    pub kind: OutputKind,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptInfo {
    pub id: String,
    pub version: u32,
    pub title: String,
    pub description: String,
    pub params_schema: Value,
    pub outputs: Vec<OutputSpec>,
    pub lookback: Lookback,
    pub available_at: AvailableAt,
}

impl ConceptInfo {
    pub fn implementation_id(&self) -> String {
        format!("{}@{}", self.id, self.version)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ConceptInput<'a> {
    pub instrument: &'a InstrumentId,
    pub tf: Timeframe,
    pub bars: &'a [Bar],
    pub calendar: SessionCalendar,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptSeries {
    pub implementation_id: String,
    pub t: Vec<Timestamp>,
    pub columns: BTreeMap<String, Vec<Option<f64>>>,
    pub warmup_complete_at: Option<usize>,
    pub quality_flags: Vec<String>,
}

impl ConceptSeries {
    pub fn column(&self, name: &str) -> Option<&[Option<f64>]> {
        self.columns.get(name).map(Vec::as_slice)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConceptError {
    #[error("invalid params: {0}")]
    InvalidParams(String),
    #[error("unknown concept {0}")]
    Unknown(String),
}

pub trait Concept: Send + Sync {
    fn info(&self) -> ConceptInfo;

    fn compute(
        &self,
        input: &ConceptInput<'_>,
        params: &Value,
    ) -> Result<ConceptSeries, ConceptError>;
}

pub(crate) fn parse_params<T: serde::de::DeserializeOwned + Default>(
    v: &Value,
) -> Result<T, ConceptError> {
    if v.is_null() {
        return Ok(T::default());
    }
    serde_json::from_value(v.clone()).map_err(|e| ConceptError::InvalidParams(e.to_string()))
}

#[derive(Default, Clone)]
pub struct ConceptRegistry {
    concepts: BTreeMap<String, Arc<dyn Concept>>,
}

impl std::fmt::Debug for ConceptRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConceptRegistry")
            .field("concepts", &self.concepts.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl ConceptRegistry {
    pub fn with_builtins() -> Self {
        let mut r = Self::default();
        r.register(Arc::new(atr::Atr));
        r
    }

    pub fn register(&mut self, concept: Arc<dyn Concept>) {
        self.concepts.insert(concept.info().id, concept);
    }

    pub fn list(&self) -> Vec<ConceptInfo> {
        self.concepts.values().map(|c| c.info()).collect()
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Concept>> {
        self.concepts.get(id).cloned()
    }

    pub fn compute(
        &self,
        id: &str,
        input: &ConceptInput<'_>,
        params: &Value,
    ) -> Result<ConceptSeries, ConceptError> {
        self.get(id)
            .ok_or_else(|| ConceptError::Unknown(id.to_owned()))?
            .compute(input, params)
    }
}

pub fn check_no_lookahead(
    concept: &dyn Concept,
    input: &ConceptInput<'_>,
    params: &Value,
) -> Result<(), (usize, String, usize)> {
    let full = concept
        .compute(input, params)
        .map_err(|e| (0, e.to_string(), 0))?;
    for k in 1..=input.bars.len() {
        let prefix = ConceptInput {
            bars: &input.bars[..k],
            ..*input
        };
        let part = concept
            .compute(&prefix, params)
            .map_err(|e| (k, e.to_string(), 0))?;
        for (name, col) in &part.columns {
            let reference = &full.columns[name];
            for (i, v) in col.iter().enumerate() {
                let same = match (v, reference[i]) {
                    (Some(a), Some(b)) => (a - b).abs() <= 1e-9 * b.abs().max(1.0),
                    (None, None) => true,
                    _ => false,
                };
                if !same {
                    return Err((k, name.clone(), i));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;
    use tessera_core::{Price, Qty};

    pub fn bar(t: &str, o: f64, h: f64, l: f64, c: f64, v: f64) -> Bar {
        Bar {
            t: Timestamp::parse(t).unwrap(),
            o: Price::from_f64(o).unwrap(),
            h: Price::from_f64(h).unwrap(),
            l: Price::from_f64(l).unwrap(),
            c: Price::from_f64(c).unwrap(),
            v: Qty::from_f64(v).unwrap(),
            bv: None,
        }
    }

    pub fn approx(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_and_computes_builtins() {
        let r = ConceptRegistry::with_builtins();
        let ids: Vec<String> = r
            .list()
            .into_iter()
            .map(|i| i.implementation_id())
            .collect();
        assert_eq!(ids, vec!["atr@1"]);
        let id = InstrumentId::new("QQQ").unwrap();
        let bars = [testutil::bar(
            "2026-10-02T13:30:00Z",
            10.0,
            11.0,
            9.0,
            10.0,
            100.0,
        )];
        let input = ConceptInput {
            instrument: &id,
            tf: Timeframe::M5,
            bars: &bars,
            calendar: SessionCalendar::UsEquities,
        };
        assert!(r.compute("atr", &input, &Value::Null).is_ok());
        assert_eq!(
            r.compute("nope", &input, &Value::Null),
            Err(ConceptError::Unknown("nope".into()))
        );
        for info in r.list() {
            assert_eq!(info.params_schema["type"], "object", "{}", info.id);
        }
    }
}
