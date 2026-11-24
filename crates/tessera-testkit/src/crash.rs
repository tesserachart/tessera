use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tessera_host::{ModuleContext, ModuleFactory, RuntimeModule};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

pub const CRASH_VAR: &str = "TESSERA_TEST_CRASH";

pub const CRASH_MESSAGE: &str = "the sim was asked to crash (sim.crash)";

pub fn crash_module_from_env() -> Option<ModuleFactory> {
    std::env::var(CRASH_VAR)
        .is_ok_and(|v| v == "1")
        .then(crash_module)
}

pub fn crash_module() -> ModuleFactory {
    Box::new(|_: &ModuleContext| Ok(Arc::new(CrashModule) as Arc<dyn RuntimeModule>))
}

#[derive(Debug)]
struct CrashModule;

impl RuntimeModule for CrashModule {
    fn name(&self) -> &'static str {
        "test-crash"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(Crash)
    }
}

struct Crash;

#[async_trait]
impl Tool for Crash {
    type Input = Value;
    type Output = Value;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("sim.crash", "Crash a runtime task", RiskTier::Modify)
            .description("The sim runtime's own (TESSERA_TEST_CRASH=1): one of its tasks panics, as a bug would, and the runtime carries on. For proving how a panic is reported.")
            .user_only()
    }

    async fn call(&self, _ctx: &ToolCtx, _input: Value) -> Result<Value, ToolError> {
        let task = tokio::spawn(async { crash() });
        let crashed = task.await.is_err();
        Ok(json!({ "crashed": crashed }))
    }
}

#[inline(never)]
fn crash() {
    panic!("{CRASH_MESSAGE}");
}
