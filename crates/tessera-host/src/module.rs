use std::sync::Arc;

use tessera_core::SharedClock;
use tessera_core::health::ProviderHealth;
use tessera_protocol::methods::ServerCapabilities;
use tessera_tools::{Extensions, Invoker, RegistryError, ToolRegistry};
use tokio::task::JoinHandle;

use crate::bus::EventBus;
use crate::topic::TopicHandler;

#[derive(Clone, Debug)]
pub struct ModuleContext {
    pub bus: Arc<EventBus>,
    pub clock: SharedClock,
    pub services: Extensions,
}

#[derive(Clone, Debug)]
pub struct ModuleHost {
    pub ctx: ModuleContext,
    pub invoker: Arc<Invoker>,
}

pub trait RuntimeModule: Send + Sync + 'static {
    fn name(&self) -> &'static str;

    fn register_tools(&self, _registry: &mut ToolRegistry) -> Result<(), RegistryError> {
        Ok(())
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        Vec::new()
    }

    fn health(&self) -> Vec<ProviderHealth> {
        Vec::new()
    }

    fn describe(&self, _caps: &mut ServerCapabilities) {}

    fn start(&self, _host: &ModuleHost) -> Vec<JoinHandle<()>> {
        Vec::new()
    }
}

pub type ModuleError = Box<dyn std::error::Error + Send + Sync>;

pub type ModuleFactory =
    Box<dyn FnOnce(&ModuleContext) -> Result<Arc<dyn RuntimeModule>, ModuleError> + Send>;

type RegisterFn = dyn Fn(&mut ToolRegistry) -> Result<(), RegistryError> + Send + Sync;

pub struct ToolsModule {
    name: &'static str,
    register: Box<RegisterFn>,
}

impl std::fmt::Debug for ToolsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolsModule")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl ToolsModule {
    pub fn new(
        name: &'static str,
        register: impl Fn(&mut ToolRegistry) -> Result<(), RegistryError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            name,
            register: Box::new(register),
        }
    }

    pub fn factory(self) -> ModuleFactory {
        Box::new(move |_| Ok(Arc::new(self) as Arc<dyn RuntimeModule>))
    }
}

impl RuntimeModule for ToolsModule {
    fn name(&self) -> &'static str {
        self.name
    }

    fn register_tools(&self, registry: &mut ToolRegistry) -> Result<(), RegistryError> {
        (self.register)(registry)
    }
}
