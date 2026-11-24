pub mod activity;
pub use tessera_core::b64;
pub mod csv;
pub mod filter;
pub mod import;
pub mod model;
pub mod module;
pub mod repo;
pub mod service;
pub mod specs;
pub mod stats;
pub mod trades;

pub use module::{JournalModule, ts_exports};
pub use service::{Added, FillSource, JOURNAL_CHANGES, JournalService, MarketSource, NewFill};

use tessera_core::Money;
use tessera_core::accounts::{Computability, RiskRule};

pub use trades::{RoundTrip, TradeBuilder};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleStatus {
    pub rule: RiskRule,
    pub computability: Computability,
    pub headroom: Option<Money>,
    pub level: RuleLevel,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleLevel {
    Ok,
    Warn,
    Breach,
}

pub trait RuleEvaluator: Send + Sync {
    fn evaluate(
        &self,
        rules: &[RiskRule],
        trades: &[RoundTrip],
        open_pnl: Option<Money>,
    ) -> Vec<RuleStatus>;
}
