use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_core::health::ProviderHealth;
use tessera_host::{
    KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicSizing, TsExports,
    parse_params,
};
use tessera_protocol::agent::{
    AgentAttachmentData, AgentAttachmentIdInput, AgentDeleteSessionInput, AgentDeleteSessionOutput,
    AgentDiscardAttachmentOutput, AgentEditQueuedInput, AgentEventEnvelope,
    AgentGetTranscriptInput, AgentInstallInput, AgentInstallOutput, AgentInterruptInput,
    AgentInterruptOutput, AgentListProvidersInput, AgentListSessionsInput, AgentProvidersOutput,
    AgentRemoveQueuedInput, AgentRenameSessionInput, AgentResumeQueueInput, AgentSearchOutput,
    AgentSearchSessionsInput, AgentSendInput, AgentSendOutput, AgentSessionOutput,
    AgentSessionsEvent, AgentSessionsOutput, AgentSetModeInput, AgentSetModelInput,
    AgentSignInInput, AgentSignInOutput, AgentStartSessionInput, AgentTranscriptOutput,
    AgentUploadAttachmentInput, AgentUploadAttachmentOutput, Suggestion, TranscriptRole,
};
use tessera_protocol::methods::ServerCapabilities;
use tessera_protocol::rpc::{RpcError, codes};
use tessera_protocol::topics::{AgentSessionParams, NoParams, names};
use tessera_store::Store;
use tessera_tools::{RegistryError, ToolRegistry};
use tokio::task::JoinHandle;

use crate::service::AgentService;

pub const SNAPSHOT_EVENTS: u32 = 10_000;

pub struct AgentModule {
    store: Store,
    service: Option<Arc<AgentService>>,
}

impl std::fmt::Debug for AgentModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentModule").finish_non_exhaustive()
    }
}

impl AgentModule {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            service: None,
        }
    }

    pub fn with_service(store: Store, service: Arc<AgentService>) -> Self {
        Self {
            store,
            service: Some(service),
        }
    }
}

impl RuntimeModule for AgentModule {
    fn name(&self) -> &'static str {
        "agent"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        crate::tools::register(r, &self.store, self.service.as_ref())
    }

    fn health(&self) -> Vec<ProviderHealth> {
        self.service.iter().flat_map(|s| s.health()).collect()
    }

    fn describe(&self, caps: &mut ServerCapabilities) {
        if self.service.is_some() {
            caps.agents = true;
            caps.mcp = true;
        }
    }

    fn start(&self, host: &ModuleHost) -> Vec<JoinHandle<()>> {
        let Some(s) = self.service.clone() else {
            return Vec::new();
        };
        s.attach_invoker(Arc::clone(&host.invoker));
        vec![tokio::spawn(s.watch())]
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![
            Arc::new(SessionTopic(self.store.clone())),
            Arc::new(SessionsTopic(self.store.clone())),
        ]
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-agent")
        .topic::<AgentSessionParams, AgentEventEnvelope>(names::AGENT_SESSION)
        .topic::<NoParams, AgentSessionsEvent>(names::AGENT_SESSIONS)
        .tool::<AgentStartSessionInput, AgentSessionOutput>("agent.start_session")
        .tool::<AgentSendInput, AgentSendOutput>("agent.send")
        .tool::<AgentUploadAttachmentInput, AgentUploadAttachmentOutput>("agent.upload_attachment")
        .tool::<AgentAttachmentIdInput, AgentAttachmentData>("agent.get_attachment")
        .tool::<AgentAttachmentIdInput, AgentDiscardAttachmentOutput>("agent.discard_attachment")
        .tool::<AgentInterruptInput, AgentInterruptOutput>("agent.interrupt")
        .tool::<AgentEditQueuedInput, AgentSessionOutput>("agent.edit_queued")
        .tool::<AgentRemoveQueuedInput, AgentSessionOutput>("agent.remove_queued")
        .tool::<AgentResumeQueueInput, AgentSessionOutput>("agent.resume_queue")
        .tool::<AgentSetModelInput, AgentSessionOutput>("agent.set_model")
        .tool::<AgentSetModeInput, AgentSessionOutput>("agent.set_mode")
        .tool::<AgentRenameSessionInput, AgentSessionOutput>("agent.rename_session")
        .tool::<AgentDeleteSessionInput, AgentDeleteSessionOutput>("agent.delete_session")
        .tool::<AgentListProvidersInput, AgentProvidersOutput>("agent.list_providers")
        .tool::<AgentInstallInput, AgentInstallOutput>("agent.install")
        .tool::<AgentSignInInput, AgentSignInOutput>("agent.sign_in")
        .tool::<AgentListSessionsInput, AgentSessionsOutput>("agent.list_sessions")
        .tool::<AgentGetTranscriptInput, AgentTranscriptOutput>("agent.get_transcript")
        .tool::<AgentSearchSessionsInput, AgentSearchOutput>("agent.search_sessions")
        .ty::<Suggestion>()
        .ty::<TranscriptRole>()
}

fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::new(codes::INTERNAL_ERROR, e.to_string())
}

struct SessionTopic(Store);

#[async_trait]
impl TopicHandler for SessionTopic {
    fn name(&self) -> &'static str {
        names::AGENT_SESSION
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 4096,
            replay: 0,
        }
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: AgentSessionParams = parse_params(params)?;
        let store = self.0.clone();
        let sid = p.session_id.clone();
        let after = p.after_seq.unwrap_or(0);
        let events = tokio::task::spawn_blocking(move || {
            store.agent_events().list(&sid, after, SNAPSHOT_EVENTS)
        })
        .await
        .map_err(internal)?
        .map_err(internal)?;
        let mut sub = Subscribed::new(KeyFilter::Id(p.session_id));
        for e in &events {
            sub = sub.snapshot(e);
        }
        Ok(sub)
    }
}

struct SessionsTopic(Store);

#[async_trait]
impl TopicHandler for SessionsTopic {
    fn name(&self) -> &'static str {
        names::AGENT_SESSIONS
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        let store = self.0.clone();
        let sessions = tokio::task::spawn_blocking(move || store.sessions().list())
            .await
            .map_err(internal)?
            .map_err(internal)?;
        Ok(Subscribed::new(KeyFilter::All).snapshot(&AgentSessionsEvent::Snapshot { sessions }))
    }
}
