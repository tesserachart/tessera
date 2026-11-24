use std::sync::{Arc, OnceLock, Weak};

use async_trait::async_trait;
use serde_json::Value;
use tessera_host::{
    KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicSizing, TsExports,
    parse_params,
};
use tessera_protocol::methods::ServerCapabilities;
use tessera_protocol::rpc::{RpcError, codes};
use tessera_protocol::tools::{ApprovalEvent, DraftInfo, ToolCallEvent};
use tessera_protocol::topics::{
    AccountParams, HealthUpdate, NoParams, Notification, ToolCallsParams, names,
};
use tessera_tools::Invoker;

use crate::state::AppState;

pub(crate) type StateCell = Arc<OnceLock<Weak<AppState>>>;

fn state(cell: &StateCell) -> Result<Arc<AppState>, RpcError> {
    cell.get()
        .and_then(Weak::upgrade)
        .ok_or_else(|| RpcError::new(codes::SHUTTING_DOWN, "the runtime is shutting down"))
}

pub struct CoreModule {
    state: StateCell,
}

impl std::fmt::Debug for CoreModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreModule").finish_non_exhaustive()
    }
}

impl CoreModule {
    pub(crate) fn new(state: StateCell) -> Self {
        Self { state }
    }
}

impl RuntimeModule for CoreModule {
    fn name(&self) -> &'static str {
        "core"
    }

    fn topics(&self, host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![
            Arc::new(ToolCallsTopic),
            Arc::new(ApprovalsTopic(Arc::clone(&host.invoker))),
            Arc::new(DraftsTopic(Arc::clone(&host.invoker))),
            Arc::new(NotificationsTopic),
            Arc::new(HealthTopic(Arc::clone(&self.state))),
            Arc::new(CapabilitiesTopic(Arc::clone(&self.state))),
        ]
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (core)")
        .topic::<ToolCallsParams, ToolCallEvent>(names::TOOL_CALLS)
        .topic::<NoParams, ApprovalEvent>(names::APPROVALS)
        .topic::<AccountParams, DraftInfo>(names::DRAFTS)
        .topic::<NoParams, Notification>(names::NOTIFICATIONS)
        .topic::<NoParams, HealthUpdate>(names::HEALTH)
        .topic::<NoParams, ServerCapabilities>(names::CAPABILITIES)
}

struct ToolCallsTopic;

#[async_trait]
impl TopicHandler for ToolCallsTopic {
    fn name(&self) -> &'static str {
        names::TOOL_CALLS
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 1024,
            replay: 100,
        }
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: ToolCallsParams = parse_params(params)?;
        Ok(Subscribed::new(KeyFilter::Calls {
            origin: p.origin,
            session: p.session_id,
        }))
    }
}

struct ApprovalsTopic(Arc<Invoker>);

#[async_trait]
impl TopicHandler for ApprovalsTopic {
    fn name(&self) -> &'static str {
        names::APPROVALS
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::SNAPSHOT
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        let pending = self.0.approvals().pending();
        Ok(Subscribed::new(KeyFilter::All).snapshot(&ApprovalEvent::Snapshot { pending }))
    }
}

struct DraftsTopic(Arc<Invoker>);

#[async_trait]
impl TopicHandler for DraftsTopic {
    fn name(&self) -> &'static str {
        names::DRAFTS
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 512,
            replay: 0,
        }
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: AccountParams = parse_params(params)?;
        let mut sub = Subscribed::new(KeyFilter::Account(p.account_id.clone()));
        for d in self.0.live_drafts() {
            if p.account_id.as_ref().is_none_or(|a| a == &d.account) {
                sub = sub.snapshot(&d);
            }
        }
        Ok(sub)
    }
}

struct NotificationsTopic;

#[async_trait]
impl TopicHandler for NotificationsTopic {
    fn name(&self) -> &'static str {
        names::NOTIFICATIONS
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        Ok(Subscribed::new(KeyFilter::All))
    }
}

struct HealthTopic(StateCell);

#[async_trait]
impl TopicHandler for HealthTopic {
    fn name(&self) -> &'static str {
        names::HEALTH
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 64,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        let st = state(&self.0)?;
        Ok(Subscribed::new(KeyFilter::All).snapshot(&st.health()))
    }
}

struct CapabilitiesTopic(StateCell);

#[async_trait]
impl TopicHandler for CapabilitiesTopic {
    fn name(&self) -> &'static str {
        names::CAPABILITIES
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 64,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        let st = state(&self.0)?;
        Ok(Subscribed::new(KeyFilter::All).snapshot(&st.capabilities()))
    }
}
