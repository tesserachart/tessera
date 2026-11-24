use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_protocol::agent::Epistemic;
use ts_rs::TS;

use crate::budget::ResearchBudget;
use crate::experiment::ExperimentState;

/// One artifact of a research run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResearchArtifact {
    /// Artifact id.
    pub id: String,
    /// Kind (`event_study`, `backtest`, `equity_curve`, `table`).
    pub kind: String,
    /// Title.
    pub title: String,
    /// What kind of claim it is: measured, observed, hypothesis or interpretation.
    pub epistemic: Epistemic,
    /// Inline data, or a summary with a blob reference.
    pub data: Option<Value>,
}

/// The research budget as shown with a result: the counts plus the plain-language risk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BudgetView {
    /// Trials, free parameters and segments of the family.
    #[serde(flatten)]
    pub budget: ResearchBudget,
    /// Comparisons used for multiplicity adjustment (trials × segments).
    pub comparisons: u32,
    /// Plain-language overfitting risk (`Heavy search; treat as exploratory`).
    pub risk: String,
}

impl From<&ResearchBudget> for BudgetView {
    fn from(b: &ResearchBudget) -> Self {
        Self {
            budget: b.clone(),
            comparisons: b.comparisons(),
            risk: b.risk_label().to_owned(),
        }
    }
}

/// `research.run` payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRunUpdate {
    /// Run id.
    pub run_id: String,
    /// The experiment the run belongs to.
    pub experiment_id: String,
    /// Lifecycle state (`draft → frozen → running → recorded`, or `failed`; a failed run still
    /// counts as a trial).
    pub state: ExperimentState,
    /// Progress 0–1 while running.
    pub progress: Option<f64>,
    /// Status message.
    pub message: Option<String>,
    /// The family's research budget, including this run's trials.
    pub budget: BudgetView,
    /// Artifacts so far (all of them once recorded).
    pub artifacts: Vec<ResearchArtifact>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_carry_state_budget_and_epistemic_artifacts() {
        let mut b = ResearchBudget::new("gamma-reversion/QQQ", 3);
        b.record_trials(28);
        let u = ResearchRunUpdate {
            run_id: "rs_1".into(),
            experiment_id: "exp_1".into(),
            state: ExperimentState::Recorded,
            progress: Some(1.0),
            message: None,
            budget: BudgetView::from(&b),
            artifacts: vec![ResearchArtifact {
                id: "a1".into(),
                kind: "event_study".into(),
                title: "First touch of the gamma flip".into(),
                epistemic: Epistemic::Measured,
                data: None,
            }],
        };
        let v = serde_json::to_value(&u).unwrap();
        assert_eq!(v["state"], "recorded");
        assert_eq!(v["budget"]["trials"], 28);
        assert_eq!(v["budget"]["family"], "gamma-reversion/QQQ");
        assert_eq!(v["budget"]["risk"], "Heavy search; treat as exploratory");
        assert_eq!(v["artifacts"][0]["epistemic"], "measured");
    }
}
