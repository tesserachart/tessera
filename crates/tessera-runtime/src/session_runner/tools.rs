use std::sync::Arc;

use async_trait::async_trait;
use tessera_host::{ModuleHost, RuntimeModule, TsExports};
use tessera_protocol::agent::{
    TradingSessionInput, TradingSessionStatus, WakeAtInput, WakeAtOutput,
};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use tokio::task::JoinHandle;

use super::SessionRunner;

pub struct SessionRunnerModule(pub Option<Arc<SessionRunner>>);

impl std::fmt::Debug for SessionRunnerModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionRunnerModule")
            .finish_non_exhaustive()
    }
}

impl RuntimeModule for SessionRunnerModule {
    fn name(&self) -> &'static str {
        "session-runner"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(Status(self.0.clone()))?;
        r.register(StartNow(self.0.clone()))?;
        r.register(WakeAt(self.0.clone()))
    }

    fn start(&self, host: &ModuleHost) -> Vec<JoinHandle<()>> {
        let Some(runner) = &self.0 else {
            return Vec::new();
        };
        runner.attach_invoker(Arc::clone(&host.invoker));
        vec![runner.spawn()]
    }
}

fn runner(r: &Option<Arc<SessionRunner>>) -> Result<&Arc<SessionRunner>, ToolError> {
    r.as_ref()
        .ok_or_else(|| ToolError::unavailable("the analyst is not running in this Tessera"))
}

struct Status(Option<Arc<SessionRunner>>);

#[async_trait]
impl Tool for Status {
    type Input = TradingSessionInput;
    type Output = TradingSessionStatus;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("agent.trading_session", "Trading sessions", RiskTier::Read)
            .description("Where the analyst's trading sessions stand (the user's setting agent.sessionRunner, Settings › Analyst › Trading sessions): the setting, the instructions file and whether it reads, what stops a session from starting now, the current or last session (trading, closing, done or skipped, its conversation, the market's open and next break) and when the next one starts. A session follows the CME market's own hours: it starts when the market opens (the reopen after the daily break or the weekend, from the trading calendar) on the account the user picked, in full access under the account's limits, and the user's standing instructions decide when and what it trades; its alerts wake it; ten minutes before the market's next break (the daily break, the weekend, a holiday halt or an early close) it closes out and writes its log; at the break Tessera closes the account's positions and reports the session in its conversation and the journal's day.")
            .activity("Reading the trading sessions")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: TradingSessionInput,
    ) -> Result<TradingSessionStatus, ToolError> {
        Ok(runner(&self.0)?.status().await)
    }
}

struct StartNow(Option<Arc<SessionRunner>>);

#[async_trait]
impl Tool for StartNow {
    type Input = TradingSessionInput;
    type Output = TradingSessionStatus;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "agent.start_trading_session",
            "Start the trading session now",
            RiskTier::Modify,
        )
        .description("Starts the trading session now, as at the market's open, when the market is open and its next break is more than ten minutes away, sessions are turned on and none runs. The user's alone.")
        .activity("Starting the trading session")
        .user_only()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: TradingSessionInput,
    ) -> Result<TradingSessionStatus, ToolError> {
        runner(&self.0)?.start_now().await
    }
}

struct WakeAt(Option<Arc<SessionRunner>>);

#[async_trait]
impl Tool for WakeAt {
    type Input = WakeAtInput;
    type Output = WakeAtOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("agent.wake_at", "Wake me at a time", RiskTier::Modify)
            .description("For the analyst of a running trading session (Settings › Analyst › Trading sessions): wakes it at a time with its note, as a turn of its own, such as when the hours its standing instructions name begin. Alerts wake it on the market; this wakes it on the clock. The time goes before the session's close-out, ten minutes before the market's next break; a time already past wakes it at once. Up to 24 wakes a session; they go with the session.")
            .activity("Setting a wake")
    }

    async fn call(&self, ctx: &ToolCtx, input: WakeAtInput) -> Result<WakeAtOutput, ToolError> {
        runner(&self.0)?.wake_at(ctx.session_id.as_ref(), input.at, &input.note)
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (trading sessions)")
        .tool::<TradingSessionInput, TradingSessionStatus>("agent.trading_session")
        .tool::<TradingSessionInput, TradingSessionStatus>("agent.start_trading_session")
        .tool::<WakeAtInput, WakeAtOutput>("agent.wake_at")
}
