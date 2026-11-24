use std::sync::Arc;

use async_trait::async_trait;
use tessera_core::health::HealthStatus;
use tessera_core::ids::SessionId;
use tessera_core::token::Secret;
use tessera_protocol::agent::{AgentModel, AgentState, TurnEnd};
use tokio::sync::{mpsc, oneshot};

use crate::AgentError;
use crate::report::TurnUsage;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderState {
    pub status: HealthStatus,
    pub message: Option<String>,
}

impl ProviderState {
    pub fn unknown() -> Self {
        Self {
            status: HealthStatus::Unknown,
            message: None,
        }
    }

    pub fn new(status: HealthStatus, message: impl Into<String>) -> Self {
        Self {
            status,
            message: Some(message.into()),
        }
    }

    pub fn ready(&self) -> bool {
        self.status == HealthStatus::Ok
    }
}

#[derive(Debug)]
pub struct SignIn {
    pub url: String,
    pub opened: bool,
    pub takes_code: bool,
    pub ended: Option<oneshot::Receiver<()>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
    Thread(String),
    ThreadLost,
    Model(String),
    Status(AgentState),
    Delta {
        message_id: String,
        text: String,
    },
    Message {
        message_id: String,
        text: String,
    },
    Reasoning {
        text: String,
        duration_ms: Option<f64>,
    },
    Error {
        message: String,
    },
    TurnEnded {
        end: TurnEnd,
        error: Option<String>,
        usage: Option<TurnUsage>,
    },
    Exited {
        message: String,
    },
}

pub type EventSink = mpsc::UnboundedSender<(SessionId, ProviderEvent)>;

#[derive(Clone, Debug)]
pub struct OpenThread {
    pub session: SessionId,
    pub mcp_url: String,
    pub token: Secret,
    pub instructions: Arc<str>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub resume: Option<String>,
    pub events: EventSink,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TurnContent {
    Image,
    Pdf,
    Text,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnAttachment {
    pub name: String,
    pub mime_type: String,
    pub content: TurnContent,
    pub data: Arc<[u8]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnInput {
    pub text: String,
    pub attachments: Vec<TurnAttachment>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SteerOutcome {
    Took,
    NoTurn,
    Unsupported,
}

#[async_trait]
pub trait ProviderThread: Send + Sync {
    fn thread_id(&self) -> Option<String>;

    async fn send(&self, turn: TurnInput) -> Result<(), AgentError>;

    async fn steer(&self, _turn: TurnInput) -> Result<SteerOutcome, AgentError> {
        Ok(SteerOutcome::Unsupported)
    }

    async fn interrupt(&self) -> Result<bool, AgentError>;

    async fn close(&self);
}

#[async_trait]
pub trait AgentProvider: Send + Sync + 'static {
    fn id(&self) -> &'static str;

    fn name(&self) -> &'static str;

    fn state(&self) -> ProviderState;

    async fn connect(&self) -> ProviderState;

    async fn sign_in(&self) -> Result<SignIn, AgentError> {
        Err(AgentError::Unavailable(format!(
            "{} signs in in its own CLI only",
            self.name()
        )))
    }

    async fn sign_in_code(&self, _code: &str) -> Result<(), AgentError> {
        Err(AgentError::Unavailable(format!(
            "{} takes no sign-in code",
            self.name()
        )))
    }

    async fn install(&self) -> Result<(), AgentError> {
        Err(AgentError::Unavailable(format!(
            "{} installs from its own download page",
            self.name()
        )))
    }

    fn version(&self) -> Option<String> {
        None
    }

    fn config_home(&self) -> Option<String> {
        None
    }

    fn reads_pdfs(&self) -> bool {
        false
    }

    async fn models(&self) -> Vec<AgentModel>;

    async fn open(&self, req: OpenThread) -> Result<Arc<dyn ProviderThread>, AgentError>;

    async fn shutdown(&self) {}
}
