use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use tessera_core::SharedClock;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_host::{EventBus, RuntimeModule, TopicHandler};
use tessera_intel::IntelModule;
use tessera_market::MarketModule;
use tessera_protocol::methods::{ServerCapabilities, names as methods};
use tessera_protocol::topics::HealthUpdate;
use tessera_store::Store;
use tessera_tools::{Audience, Invoker};
use tokio::sync::watch;

use crate::auth::{OriginPolicy, SessionToken, Tickets};
use crate::connections::ConnectionsService;
use crate::layout::LayoutService;
use crate::settings::SettingsService;

pub struct AppState {
    pub mcp: Arc<tessera_mcp::McpService>,
    pub principals: Arc<tessera_mcp::McpPrincipals>,
    pub mcp_clients: Arc<crate::modules::mcp::McpClients>,
    pub account: Arc<crate::modules::account::AccountService>,
    pub version: &'static str,
    pub port: u16,
    pub token: SessionToken,
    pub tickets: Tickets,
    pub origins: OriginPolicy,
    pub bus: Arc<EventBus>,
    pub invoker: Arc<Invoker>,
    pub store: Store,
    pub observer: Arc<crate::observer::RuntimeObserver>,
    pub telemetry: crate::telemetry::Telemetry,
    pub broker: Arc<tessera_broker::BrokerModule>,
    pub modules: Vec<Arc<dyn RuntimeModule>>,
    pub topics: HashMap<&'static str, Arc<dyn TopicHandler>>,
    pub connections: Arc<ConnectionsService>,
    pub market: Arc<MarketModule>,
    pub intel: Arc<IntelModule>,
    pub layouts: Arc<LayoutService>,
    pub settings: Arc<SettingsService>,
    pub clock: SharedClock,
    pub ui_dir: Option<PathBuf>,
    pub shutdown: watch::Receiver<bool>,
    pub next_conn: AtomicU64,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("version", &self.version)
            .field("port", &self.port)
            .field(
                "modules",
                &self.modules.iter().map(|m| m.name()).collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

impl AppState {
    pub fn health(&self) -> HealthUpdate {
        let now = self.clock.now();
        let store_ok = self.store.schema_version().is_ok();
        let runtime = ProviderHealth {
            provider_id: "runtime".into(),
            kind: ProviderKind::Runtime,
            display_name: format!("Tessera runtime {}", self.version),
            status: if store_ok {
                HealthStatus::Ok
            } else {
                HealthStatus::Degraded
            },
            latency_ms: None,
            last_message_at: Some(now),
            message: (!store_ok).then(|| "database unavailable".to_owned()),
            connection: None,
            accounts: None,
            checked_at: now,
        };
        let providers = crate::connections::one_per_connection(
            std::iter::once(runtime)
                .chain(self.modules.iter().flat_map(|m| m.health()))
                .collect(),
        );
        HealthUpdate {
            providers,
            prices_down: self.market.hub().router().prices_down(),
        }
    }

    pub fn capabilities(&self) -> ServerCapabilities {
        let mut topics: Vec<String> = self
            .topics
            .values()
            .filter(|t| t.offered())
            .map(|t| t.name().to_owned())
            .collect();
        topics.sort();
        let mut caps = ServerCapabilities {
            methods: methods::ALL.iter().map(|s| (*s).to_owned()).collect(),
            topics,
            tool_count: self
                .invoker
                .registry()
                .descriptors(Audience::User, None, false)
                .len() as u32,
            market: Vec::new(),
            intel: Vec::new(),
            mcp: true,
            agents: false,
        };
        for m in &self.modules {
            m.describe(&mut caps);
        }
        caps
    }
}

pub type SharedState = Arc<AppState>;
