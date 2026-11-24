pub mod account;
pub mod cards;
pub mod core;
pub mod data;
pub mod feedback;
pub mod mcp;
pub mod settings;
pub mod share;
pub mod telemetry;
pub mod workspace;

use tessera_host::TsExports;

pub fn ts_exports() -> Vec<TsExports> {
    vec![
        tessera_host::protocol_exports(),
        core::ts_exports(),
        workspace::ts_exports(),
        settings::ts_exports(),
        data::ts_exports(),
        mcp::ts_exports(),
        account::ts_exports(),
        cards::ts_exports(),
        telemetry::ts_exports(),
        feedback::ts_exports(),
        share::ts_exports(),
        crate::session_runner::tools::ts_exports(),
        crate::connections::ts_exports(),
        tessera_market::ts_exports(),
        tessera_market::saved_tools::ts_exports(),
        tessera_intel::ts_exports(),
        tessera_concepts::ts_exports(),
        tessera_indicators::ts_exports(),
        tessera_alerts::ts_exports(),
        tessera_broker::ts_exports(),
        tessera_research::ts_exports(),
        tessera_journal::ts_exports(),
        tessera_agent::ts_exports(),
    ]
}
