use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_host::{
    EventBus, KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicKey,
    TopicSizing, TsExports, parse_params,
};
use tessera_protocol::rpc::RpcError;
use tessera_protocol::topics::{ResearchRunParams, names};

use tessera_tools::{RegistryError, ToolRegistry};

use crate::budget::ResearchBudget;
use crate::run::{ResearchArtifact, ResearchRunUpdate};
use crate::study::Studies;

pub fn publish_run(bus: &EventBus, update: &ResearchRunUpdate) -> u64 {
    bus.publish(
        names::RESEARCH_RUN,
        TopicKey::Id(update.run_id.clone()),
        update,
    )
}

#[derive(Debug, Default)]
pub struct ResearchModule {
    studies: Option<Arc<Studies>>,
}

impl ResearchModule {
    pub fn new() -> Self {
        Self { studies: None }
    }

    pub fn with_studies(studies: Arc<Studies>) -> Self {
        Self {
            studies: Some(studies),
        }
    }
}

impl RuntimeModule for ResearchModule {
    fn name(&self) -> &'static str {
        "research"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        match &self.studies {
            Some(s) => crate::tools::register(r, s),
            None => Ok(()),
        }
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(RunTopic)]
    }
}

pub fn ts_exports() -> TsExports {
    crate::tools::ts_exports(TsExports::new("tessera-research"))
        .topic::<ResearchRunParams, ResearchRunUpdate>(names::RESEARCH_RUN)
        .ty::<ResearchArtifact>()
        .ty::<ResearchBudget>()
}

struct RunTopic;

#[async_trait]
impl TopicHandler for RunTopic {
    fn name(&self) -> &'static str {
        names::RESEARCH_RUN
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::LOW_RATE
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: ResearchRunParams = parse_params(params)?;
        Ok(Subscribed::new(KeyFilter::Id(p.run_id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::experiment::ExperimentState;
    use crate::run::BudgetView;

    #[tokio::test]
    async fn run_updates_reach_their_subscribers() {
        let bus = EventBus::new();
        bus.register(names::RESEARCH_RUN, RunTopic.sizing())
            .unwrap();
        let sub = RunTopic
            .subscribe(serde_json::json!({"runId": "rs_1"}))
            .await
            .unwrap();
        let (mut rx, _) = bus.subscribe(names::RESEARCH_RUN).unwrap();
        let u = ResearchRunUpdate {
            run_id: "rs_1".into(),
            experiment_id: "exp_1".into(),
            state: ExperimentState::Running,
            progress: Some(0.5),
            message: None,
            budget: BudgetView::from(&ResearchBudget::new("f", 1)),
            artifacts: vec![],
        };
        assert_eq!(publish_run(&bus, &u), 1);
        let ev = rx.try_recv().unwrap();
        assert!(sub.filter.matches(&ev.key));
        assert!(!sub.filter.matches(&TopicKey::Id("rs_2".into())));
    }
}
