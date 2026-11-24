use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Trials spent in one family of related tests.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResearchBudget {
    /// Family (`gamma-reversion/NQ`).
    pub family: String,
    /// Variants tried (every trial counts, including failures and negatives).
    pub trials: u32,
    /// Free parameters in the specification.
    pub free_parameters: u32,
    /// Segments examined (volatility terciles, years…).
    pub segments: u32,
}

impl ResearchBudget {
    pub fn new(family: impl Into<String>, free_parameters: u32) -> Self {
        Self {
            family: family.into(),
            trials: 0,
            free_parameters,
            segments: 1,
        }
    }

    pub fn record_trials(&mut self, n: u32) {
        self.trials = self.trials.saturating_add(n);
    }

    pub fn record_segments(&mut self, n: u32) {
        self.segments = self.segments.saturating_add(n);
    }

    pub fn comparisons(&self) -> u32 {
        self.trials.max(1).saturating_mul(self.segments.max(1))
    }

    pub fn adjust_p(&self, p: f64) -> f64 {
        (p * f64::from(self.comparisons())).min(1.0)
    }

    pub fn risk_label(&self) -> &'static str {
        match self.comparisons() {
            0..=3 => "Likely not overfitting",
            4..=20 => "Some search; check robustness",
            _ => "Heavy search; treat as exploratory",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_accounting() {
        let mut b = ResearchBudget::new("gamma-reversion/QQQ", 3);
        b.record_trials(1);
        assert_eq!(b.comparisons(), 1);
        assert_eq!(b.risk_label(), "Likely not overfitting");
        assert!((b.adjust_p(0.00006) - 0.00006).abs() < 1e-12);
        b.record_trials(27);
        assert_eq!(b.trials, 28);
        assert_eq!(b.risk_label(), "Heavy search; treat as exploratory");
        assert_eq!(b.adjust_p(0.05), 1.0);
    }
}
