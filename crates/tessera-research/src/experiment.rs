use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Lifecycle state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentState {
    /// Being defined; results are labelled exploratory.
    Draft,
    /// Definition, data and code hashed; no more edits.
    Frozen,
    /// Results stored.
    Recorded,
}
