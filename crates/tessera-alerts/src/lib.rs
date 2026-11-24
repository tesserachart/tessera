pub mod deps;
pub mod discord;
pub mod engine;
pub mod eval;
pub mod flow;
pub mod io;
pub mod service;
pub mod tools;

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_host::{
    KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicSizing, TsExports,
};
use tessera_market::hub::MarketHub;
use tessera_protocol::rpc::RpcError;
use tessera_protocol::topics::NoParams;
use tessera_tools::{RegistryError, ToolRegistry};
use tokio::task::JoinHandle;

pub use deps::{AlertAnalyst, AlertSources, IndicatorReading, WebhookSender, WebhookVault};
pub use engine::AlertEngine;
pub use io::*;
pub use service::{AlertsService, TOPIC};

pub struct AlertsModule {
    service: Arc<AlertsService>,
    hub: Arc<MarketHub>,
    sources: Arc<dyn AlertSources>,
}

impl std::fmt::Debug for AlertsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AlertsModule").finish_non_exhaustive()
    }
}

impl AlertsModule {
    pub fn new(
        service: Arc<AlertsService>,
        hub: Arc<MarketHub>,
        sources: Arc<dyn AlertSources>,
    ) -> Self {
        Self {
            service,
            hub,
            sources,
        }
    }

    pub fn service(&self) -> &Arc<AlertsService> {
        &self.service
    }
}

impl RuntimeModule for AlertsModule {
    fn name(&self) -> &'static str {
        "alerts"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        let s = || Arc::clone(&self.service);
        r.register(tools::Create(s()))?;
        r.register(tools::List(s()))?;
        r.register(tools::Update(s()))?;
        r.register(tools::Pause(s()))?;
        r.register(tools::Delete(s()))?;
        r.register(tools::History(s()))?;
        r.register(tools::SetDiscord(s()))?;
        r.register(tools::TestDiscord(s()))
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(AlertsTopic(Arc::clone(&self.service)))]
    }

    fn start(&self, host: &ModuleHost) -> Vec<JoinHandle<()>> {
        let engine = AlertEngine::new(
            Arc::clone(&self.service),
            Arc::clone(&self.hub),
            Arc::clone(&host.ctx.bus),
            Arc::clone(&self.sources),
        );
        vec![engine.spawn()]
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-alerts")
        .ty::<Operand>()
        .ty::<AlertStep>()
        .ty::<AlertLive>()
        .tool::<AlertsCreateInput, Alert>("alerts.create")
        .tool::<AlertsListInput, AlertsListOutput>("alerts.list")
        .tool::<AlertsUpdateInput, Alert>("alerts.update")
        .tool::<AlertsPauseInput, Alert>("alerts.pause")
        .tool::<AlertsDeleteInput, AlertsDeleteOutput>("alerts.delete")
        .tool::<AlertsHistoryInput, AlertsHistoryOutput>("alerts.history")
        .tool::<AlertsSetDiscordInput, AlertsDiscordOutput>("alerts.set_discord")
        .tool::<AlertsTestDiscordInput, AlertsDiscordOutput>("alerts.test_discord")
        .topic::<NoParams, AlertsEvent>(TOPIC)
}

struct AlertsTopic(Arc<AlertsService>);

#[async_trait]
impl TopicHandler for AlertsTopic {
    fn name(&self) -> &'static str {
        TOPIC
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 512,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        Ok(Subscribed::new(KeyFilter::All).snapshot(&self.0.snapshot().await))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::{InstrumentId, SystemClock, Timestamp};
    use tessera_host::{EventBus, TopicKey};
    use tessera_market::MarketRouter;
    use tessera_store::Store;

    struct NoWebhook;

    #[async_trait]
    impl WebhookVault for NoWebhook {
        async fn get(&self) -> Result<Option<String>, String> {
            Ok(None)
        }

        async fn set(&self, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
    }

    #[async_trait]
    impl WebhookSender for NoWebhook {
        async fn post(&self, _: &str, _: &Value) -> Result<(), String> {
            Ok(())
        }
    }

    fn fired() -> AlertsEvent {
        AlertsEvent::Fired {
            fire: AlertFire {
                id: "af_1".into(),
                alert_id: "al_1".into(),
                symbol: "NQ".into(),
                instrument: InstrumentId::new("NQZ6.CME").unwrap(),
                title: "NQ crosses above 21000".into(),
                message: None,
                price: 21000.25,
                target: Some(21000.0),
                at: Timestamp(0),
                bar_time: None,
                source: "Apex · Rithmic".into(),
                deliver: Default::default(),
                discord: None,
                analyst: None,
                size: None,
                side: None,
            },
        }
    }

    #[tokio::test]
    async fn a_subscriber_after_a_firing_starts_from_the_snapshot_without_the_firing() {
        let bus = Arc::new(EventBus::new());
        let service = AlertsService::load(
            Store::open_in_memory().unwrap(),
            Arc::clone(&bus),
            Arc::new(SystemClock),
            MarketRouter::new(),
            Arc::new(NoWebhook),
            Arc::new(NoWebhook),
        )
        .unwrap();
        let topic = AlertsTopic(service);
        bus.register(TOPIC, topic.sizing()).unwrap();
        bus.publish(TOPIC, TopicKey::None, &fired());

        let (mut live, replayed) = bus.subscribe(TOPIC).unwrap();
        assert!(replayed.is_empty());
        let snapshot: Vec<AlertsEvent> = topic
            .subscribe(Value::Null)
            .await
            .unwrap()
            .snapshot
            .iter()
            .map(|raw| serde_json::from_str(raw.get()).unwrap())
            .collect();
        assert!(matches!(snapshot[..], [AlertsEvent::Snapshot { .. }]));

        bus.publish(TOPIC, TopicKey::None, &fired());
        let next = live.try_recv().unwrap();
        assert_eq!(
            serde_json::from_str::<AlertsEvent>(next.data.get()).unwrap(),
            fired()
        );
    }
}
