use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tessera_core::Timestamp;
use tessera_core::hash::hash_json;
use ts_rs::TS;

/// Lifecycle state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentState {
    /// Being defined; results are labelled exploratory.
    Draft,
    /// Definition, data and code hashed; no more edits.
    Frozen,
    /// Executing.
    Running,
    /// Results stored.
    Recorded,
    /// Run failed (the trial still counts).
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("cannot {action} an experiment in state {from:?}")]
pub struct TransitionError {
    pub from: ExperimentState,
    pub action: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Experiment {
    pub id: String,
    pub family: String,
    pub generation: u32,
    pub state: ExperimentState,
    pub definition: Value,
    pub hypothesis: Option<String>,
    pub manifest_hash: Option<String>,
    pub frozen_at: Option<Timestamp>,
}

impl Experiment {
    pub fn draft(id: impl Into<String>, family: impl Into<String>, definition: Value) -> Self {
        Self {
            id: id.into(),
            family: family.into(),
            generation: 1,
            state: ExperimentState::Draft,
            definition,
            hypothesis: None,
            manifest_hash: None,
            frozen_at: None,
        }
    }

    pub fn edit(&mut self, definition: Value) -> Result<(), TransitionError> {
        if self.state != ExperimentState::Draft {
            return Err(TransitionError {
                from: self.state,
                action: "edit",
            });
        }
        self.definition = definition;
        Ok(())
    }

    pub fn freeze(
        &mut self,
        data_hash: &str,
        code_version: &str,
        at: Timestamp,
    ) -> Result<&str, TransitionError> {
        if self.state != ExperimentState::Draft {
            return Err(TransitionError {
                from: self.state,
                action: "freeze",
            });
        }
        let manifest = json!({
            "id": self.id,
            "family": self.family,
            "generation": self.generation,
            "definition": self.definition,
            "hypothesis": self.hypothesis,
            "data": data_hash,
            "code": code_version,
        });
        self.manifest_hash = Some(hash_json(&manifest));
        self.frozen_at = Some(at);
        self.state = ExperimentState::Frozen;
        Ok(self.manifest_hash.as_deref().unwrap_or_default())
    }

    pub fn start(&mut self) -> Result<(), TransitionError> {
        self.transition(ExperimentState::Frozen, ExperimentState::Running, "start")
    }

    pub fn record(&mut self) -> Result<(), TransitionError> {
        self.transition(
            ExperimentState::Running,
            ExperimentState::Recorded,
            "record",
        )
    }

    pub fn fail(&mut self) -> Result<(), TransitionError> {
        self.transition(ExperimentState::Running, ExperimentState::Failed, "fail")
    }

    pub fn revise(&self, definition: Value) -> Result<Experiment, TransitionError> {
        if self.state == ExperimentState::Draft {
            return Err(TransitionError {
                from: self.state,
                action: "revise",
            });
        }
        Ok(Experiment {
            id: self.id.clone(),
            family: self.family.clone(),
            generation: self.generation + 1,
            state: ExperimentState::Draft,
            definition,
            hypothesis: self.hypothesis.clone(),
            manifest_hash: None,
            frozen_at: None,
        })
    }

    pub fn is_exploratory(&self) -> bool {
        self.manifest_hash.is_none()
    }

    fn transition(
        &mut self,
        from: ExperimentState,
        to: ExperimentState,
        action: &'static str,
    ) -> Result<(), TransitionError> {
        if self.state != from {
            return Err(TransitionError {
                from: self.state,
                action,
            });
        }
        self.state = to;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle() {
        let mut e = Experiment::draft("rs_2a91", "gamma-reversion/QQQ", json!({"tol": 0.10}));
        assert!(e.is_exploratory());
        e.edit(json!({"tol": 0.15})).unwrap();
        assert!(e.start().is_err(), "must freeze first");
        let h = e
            .freeze("data-d7c1e", "tessera 0.1.0", Timestamp(1))
            .unwrap()
            .to_owned();
        assert_eq!(h.len(), 64);
        assert!(
            e.edit(json!({})).is_err(),
            "frozen definitions are immutable"
        );
        assert!(e.freeze("x", "y", Timestamp(2)).is_err());
        e.start().unwrap();
        e.record().unwrap();
        assert_eq!(e.state, ExperimentState::Recorded);
        let g2 = e.revise(json!({"tol": 0.05})).unwrap();
        assert_eq!(g2.generation, 2);
        assert_eq!(g2.state, ExperimentState::Draft);
        let mut a = Experiment::draft("x", "f", json!({"a": 1}));
        let mut b = Experiment::draft("x", "f", json!({"a": 1}));
        let mut c = Experiment::draft("x", "f", json!({"a": 2}));
        let ha = a.freeze("d", "c", Timestamp(0)).unwrap().to_owned();
        let hb = b.freeze("d", "c", Timestamp(9)).unwrap().to_owned();
        let hc = c.freeze("d", "c", Timestamp(0)).unwrap().to_owned();
        assert_eq!(ha, hb);
        assert_ne!(ha, hc);
    }
}
