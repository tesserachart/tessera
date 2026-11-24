use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tessera_core::accounts::Environment;
use tessera_core::clock::ManualClock;
use tessera_core::ids::SessionId;
use tessera_core::orders::DraftStatus;
use tessera_core::settle::settle;
use tessera_core::time::{NANOS_PER_MILLI, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Origin, Timestamp};
use tessera_protocol::methods::ApprovalsResolveParams;
use tessera_protocol::tools::{
    ApprovalDecision, ApprovalEvent, ApprovalStatus, RiskTier, SessionMode, ToolCallStatus,
    ToolErrorCode, ToolOutcome,
};
use tessera_tools::approvals::{ApprovalError, StalenessPolicy};
use tessera_tools::{
    ActionTarget, Audience, InvokeRequest, Invoker, InvokerConfig, LATE_ORDER, LoopLimits,
    MemoryObserver, RateLimit, RegistryError, ResolveError, SessionPolicy, SurfaceState, Tool,
    ToolCtx, ToolError, ToolMeta, ToolRegistry,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
struct EchoInput {
    #[serde(default)]
    text: String,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Default)]
struct Counter(AtomicU32);
impl Counter {
    fn get(&self) -> u32 {
        self.0.load(Ordering::SeqCst)
    }
    fn bump(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

struct ReadTool(Arc<Counter>);

#[async_trait]
impl Tool for ReadTool {
    type Input = EchoInput;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("test.read", "Read", RiskTier::Read).description("Echoes its input.")
    }
    async fn call(&self, _ctx: &ToolCtx, input: EchoInput) -> Result<Value, ToolError> {
        self.0.bump();
        Ok(json!({ "echo": input.text }))
    }
    fn summarize(&self, out: &Value) -> Option<String> {
        Some(format!("echo {}", out["echo"]))
    }
}

struct ModifyTool(Arc<Counter>);

#[async_trait]
impl Tool for ModifyTool {
    type Input = EchoInput;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.set_symbol", "Set symbol", RiskTier::Modify)
    }
    async fn call(&self, ctx: &ToolCtx, input: EchoInput) -> Result<Value, ToolError> {
        self.0.bump();
        Ok(json!({ "set": input.text, "approvedBy": ctx.approved_by, "origin": ctx.origin }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
struct OrderInput {
    account: String,
    symbol: String,
    qty: u32,
    #[serde(default)]
    env: Option<Environment>,
    /// The call only reduces risk (cancel, flatten).
    #[serde(default)]
    exit: bool,
}

struct OrderTool(Arc<Counter>);

#[async_trait]
impl Tool for OrderTool {
    type Input = OrderInput;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.submit", "Submit order", RiskTier::Financial)
    }
    async fn call(&self, ctx: &ToolCtx, input: OrderInput) -> Result<Value, ToolError> {
        self.0.bump();
        Ok(json!({ "submitted": input.qty, "approvedBy": ctx.approved_by }))
    }
    async fn preview(&self, _ctx: &ToolCtx, input: &OrderInput) -> Result<Value, ToolError> {
        if input.qty == 0 {
            return Err(ToolError::invalid_input("qty must be positive"));
        }
        Ok(json!({ "restatement": format!("BUY {} {} LMT", input.qty, input.symbol) }))
    }
    async fn target(&self, input: &OrderInput) -> Option<ActionTarget> {
        Some(ActionTarget {
            account: input.account.clone(),
            instrument: InstrumentId::new(&input.symbol).ok(),
            environment: Some(input.env.unwrap_or(Environment::Paper)),
            exit: input.exit,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
struct Empty {}

struct ViewportTool(Arc<Counter>);

#[async_trait]
impl Tool for ViewportTool {
    type Input = Empty;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.report_viewport", "Report viewport", RiskTier::Modify)
            .user_only()
            .quiet()
            .rate_limit(RateLimit::new(0.01, 2))
    }
    async fn call(&self, _ctx: &ToolCtx, _input: Empty) -> Result<Value, ToolError> {
        self.0.bump();
        Ok(json!({}))
    }
}

struct PanicTool;

#[async_trait]
impl Tool for PanicTool {
    type Input = Empty;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("test.panic", "Panic", RiskTier::Read)
    }
    async fn call(&self, _ctx: &ToolCtx, _input: Empty) -> Result<Value, ToolError> {
        panic!("boom");
    }
}

struct SlowTool;

#[async_trait]
impl Tool for SlowTool {
    type Input = Empty;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("test.slow", "Slow", RiskTier::Read).timeout_ms(20)
    }
    async fn call(&self, _ctx: &ToolCtx, _input: Empty) -> Result<Value, ToolError> {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        Ok(json!({}))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
struct SlowOrderInput {
    account: String,
    symbol: String,
    delay_ms: u64,
    #[serde(default)]
    fail: bool,
}

struct SlowOrderTool {
    started: Arc<Counter>,
    sent: Arc<Counter>,
}

#[async_trait]
impl Tool for SlowOrderTool {
    type Input = SlowOrderInput;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.slow", "Slow order", RiskTier::Financial).timeout_ms(5_000)
    }
    async fn call(&self, _ctx: &ToolCtx, input: SlowOrderInput) -> Result<Value, ToolError> {
        self.started.bump();
        tokio::time::sleep(std::time::Duration::from_millis(input.delay_ms)).await;
        self.sent.bump();
        if input.fail {
            return Err(
                ToolError::new(ToolErrorCode::Unavailable, "the broker refused")
                    .with_details(json!({ "broker": "paper", "reason": "closed" })),
            );
        }
        Ok(json!({ "filled": true }))
    }
    async fn preview(&self, _ctx: &ToolCtx, input: &SlowOrderInput) -> Result<Value, ToolError> {
        Ok(json!({ "restatement": format!("BUY 1 {}", input.symbol) }))
    }
    async fn target(&self, input: &SlowOrderInput) -> Option<ActionTarget> {
        Some(ActionTarget {
            account: input.account.clone(),
            instrument: InstrumentId::new(&input.symbol).ok(),
            environment: Some(Environment::Paper),
            exit: false,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
struct DelayInput {
    delay_ms: u64,
}

struct SlowChangeTool(Arc<Counter>);

#[async_trait]
impl Tool for SlowChangeTool {
    type Input = DelayInput;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.slow_change", "Slow change", RiskTier::Modify).timeout_ms(50)
    }
    async fn call(&self, _ctx: &ToolCtx, input: DelayInput) -> Result<Value, ToolError> {
        tokio::time::sleep(std::time::Duration::from_millis(input.delay_ms)).await;
        self.0.bump();
        Ok(json!({ "changed": true }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
struct StuckOrderInput {
    account: String,
    symbol: String,
    delay_ms: u64,
}

struct StuckOrderTool(Arc<Counter>);

#[async_trait]
impl Tool for StuckOrderTool {
    type Input = StuckOrderInput;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.stuck", "Stuck order", RiskTier::Financial).timeout_ms(50)
    }
    async fn call(&self, _ctx: &ToolCtx, input: StuckOrderInput) -> Result<Value, ToolError> {
        tokio::time::sleep(std::time::Duration::from_millis(input.delay_ms)).await;
        self.0.bump();
        Ok(json!({ "filled": true }))
    }
    fn summarize(&self, _out: &Value) -> Option<String> {
        Some("filled".into())
    }
    async fn preview(&self, _ctx: &ToolCtx, input: &StuckOrderInput) -> Result<Value, ToolError> {
        Ok(json!({ "restatement": format!("BUY 1 {}", input.symbol) }))
    }
    async fn target(&self, input: &StuckOrderInput) -> Option<ActionTarget> {
        Some(ActionTarget {
            account: input.account.clone(),
            instrument: InstrumentId::new(&input.symbol).ok(),
            environment: Some(Environment::Paper),
            exit: false,
        })
    }
}

#[derive(Default)]
struct Gate {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
struct GatedOrderInput {
    account: String,
    symbol: String,
    qty: u32,
    #[serde(default)]
    hold: bool,
}

struct GatedOrderTool(Arc<Gate>);

#[async_trait]
impl Tool for GatedOrderTool {
    type Input = GatedOrderInput;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.gated", "Gated order", RiskTier::Financial)
    }
    async fn call(&self, _ctx: &ToolCtx, input: GatedOrderInput) -> Result<Value, ToolError> {
        Ok(json!({ "submitted": input.qty }))
    }
    async fn preview(&self, _ctx: &ToolCtx, input: &GatedOrderInput) -> Result<Value, ToolError> {
        if input.hold {
            self.0.entered.notify_one();
            self.0.release.notified().await;
        }
        Ok(json!({ "restatement": format!("BUY {} {}", input.qty, input.symbol) }))
    }
    async fn target(&self, input: &GatedOrderInput) -> Option<ActionTarget> {
        Some(ActionTarget {
            account: input.account.clone(),
            instrument: InstrumentId::new(&input.symbol).ok(),
            environment: Some(Environment::Paper),
            exit: false,
        })
    }
}

struct H {
    inv: Invoker,
    obs: Arc<MemoryObserver>,
    clock: Arc<ManualClock>,
    reads: Arc<Counter>,
    modifies: Arc<Counter>,
    orders: Arc<Counter>,
    viewports: Arc<Counter>,
    slow_started: Arc<Counter>,
    slow_orders: Arc<Counter>,
    slow_changes: Arc<Counter>,
    stuck_orders: Arc<Counter>,
    gate: Arc<Gate>,
}

fn harness_with(config: InvokerConfig) -> H {
    let reads = Arc::new(Counter::default());
    let modifies = Arc::new(Counter::default());
    let orders = Arc::new(Counter::default());
    let viewports = Arc::new(Counter::default());
    let slow_started = Arc::new(Counter::default());
    let slow_orders = Arc::new(Counter::default());
    let slow_changes = Arc::new(Counter::default());
    let stuck_orders = Arc::new(Counter::default());
    let gate = Arc::new(Gate::default());
    let mut reg = ToolRegistry::new();
    reg.register(ReadTool(reads.clone())).unwrap();
    reg.register(ModifyTool(modifies.clone())).unwrap();
    reg.register(OrderTool(orders.clone())).unwrap();
    reg.register(ViewportTool(viewports.clone())).unwrap();
    reg.register(PanicTool).unwrap();
    reg.register(SlowTool).unwrap();
    reg.register(SlowOrderTool {
        started: slow_started.clone(),
        sent: slow_orders.clone(),
    })
    .unwrap();
    reg.register(SlowChangeTool(slow_changes.clone())).unwrap();
    reg.register(StuckOrderTool(stuck_orders.clone())).unwrap();
    reg.register(GatedOrderTool(gate.clone())).unwrap();
    let obs = Arc::new(MemoryObserver::default());
    let clock = Arc::new(ManualClock::new(Timestamp::from_secs(1_790_000_000)));
    let inv = Invoker::new(Arc::new(reg), obs.clone(), clock.clone(), config);
    H {
        inv,
        obs,
        clock,
        reads,
        modifies,
        orders,
        viewports,
        slow_started,
        slow_orders,
        slow_changes,
        stuck_orders,
        gate,
    }
}

fn harness() -> H {
    harness_with(InvokerConfig::default())
}

impl H {
    async fn executing(&self) {
        settle(
            "a slow order is executing",
            || (self.slow_started.get(), self.slow_orders.get()),
            |(started, sent)| started > sent,
        )
        .await;
    }
}

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S15"),
        provider: "codex".into(),
    }
}

fn external() -> Origin {
    Origin::External {
        client_id: "claude-desktop".into(),
    }
}

fn req(name: &str, input: Value, origin: Origin) -> InvokeRequest {
    InvokeRequest::new(name, input, origin)
}

fn order(symbol: &str) -> Value {
    json!({ "account": "paper-main", "symbol": symbol, "qty": 25 })
}

fn resolve_params(
    approval_id: &tessera_core::ids::ApprovalId,
    hash: &str,
    decision: ApprovalDecision,
) -> ApprovalsResolveParams {
    ApprovalsResolveParams {
        approval_id: approval_id.clone(),
        decision,
        preview_hash: hash.to_owned(),
        note: None,
        input: None,
        deadline: None,
        idempotency_key: None,
    }
}

#[tokio::test]
async fn user_read_runs_and_is_audited() {
    let h = harness();
    let r = h
        .inv
        .invoke(req(
            "test.read",
            json!({"text": "hi", "password": "hunter2"}),
            Origin::User,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    assert_eq!(r.status, ToolOutcome::Ok);
    assert_eq!(r.output.unwrap()["echo"], "hi");
    assert_eq!(h.reads.get(), 1);
    let finished = h.obs.finished.lock().clone();
    assert_eq!(finished.len(), 1);
    let rec = &finished[0];
    assert_eq!(rec.status, ToolCallStatus::Ok);
    assert_eq!(rec.summary.as_deref(), Some("echo \"hi\""));
    assert_eq!(rec.input["password"], "[redacted]");
    assert_eq!(rec.call_id, r.call_id);
    assert_eq!(h.obs.started.lock().len(), 1);
}

#[tokio::test]
async fn unknown_tool_and_invalid_input() {
    let h = harness();
    let r = h
        .inv
        .invoke(req("nope.tool", json!({}), Origin::User))
        .await;
    assert_eq!(r.error.unwrap().code, ToolErrorCode::UnknownTool);
    let r = h
        .inv
        .invoke(req("orders.submit", json!({"account": 1}), Origin::User))
        .await;
    assert!(!r.ok);
    assert_eq!(r.error.unwrap().code, ToolErrorCode::InvalidInput);
    let r = h
        .inv
        .invoke(req("test.read", Value::Null, Origin::User))
        .await;
    assert!(r.ok);
    assert_eq!(h.obs.finished.lock().len(), 3, "every call is audited");
}

#[tokio::test]
async fn agent_dedup_window() {
    let h = harness();
    let a = h
        .inv
        .invoke(req("test.read", json!({"text": "q"}), agent()))
        .await;
    assert!(a.ok && !a.deduped);
    h.clock.advance(9 * NANOS_PER_SEC);
    let b = h
        .inv
        .invoke(req("test.read", json!({"text": "q"}), agent()))
        .await;
    assert!(b.ok && b.deduped);
    assert_eq!(b.output, a.output);
    assert_ne!(b.call_id, a.call_id);
    assert_eq!(h.reads.get(), 1);
    let c = h
        .inv
        .invoke(req("test.read", json!({"text": "other"}), agent()))
        .await;
    assert!(!c.deduped);
    assert_eq!(h.reads.get(), 2);
    h.clock.advance(2 * NANOS_PER_SEC);
    let d = h
        .inv
        .invoke(req("test.read", json!({"text": "q"}), agent()))
        .await;
    assert!(!d.deduped);
    assert_eq!(h.reads.get(), 3);
    let other = Origin::Agent {
        session_id: SessionId::new("S16"),
        provider: "codex".into(),
    };
    let e = h
        .inv
        .invoke(req("test.read", json!({"text": "q"}), other))
        .await;
    assert!(!e.deduped);
    let deduped_records = h.obs.finished.lock().iter().filter(|r| r.deduped).count();
    assert_eq!(deduped_records, 1);
}

#[tokio::test]
async fn a_quiet_call_stays_out_of_the_audit_and_is_reported_without_its_input() {
    let h = harness();
    h.inv
        .invoke(req(
            "chart.report_viewport",
            json!({"secret": "hunter22"}),
            Origin::User,
        ))
        .await;
    assert!(
        h.obs
            .finished
            .lock()
            .iter()
            .all(|r| r.tool != "chart.report_viewport")
    );
    let reported = h.obs.quietly.lock().clone();
    assert_eq!(reported.len(), 1);
    assert_eq!(reported[0].tool, "chart.report_viewport");
    assert_eq!(reported[0].input, Value::Null);
    assert!(reported[0].input_hash.is_empty());
}

#[tokio::test]
async fn a_change_ends_the_reads_cached_before_it() {
    let h = harness();
    let read = || req("test.read", json!({"text": "q"}), agent());
    assert!(!h.inv.invoke(read()).await.deduped);
    assert!(h.inv.invoke(read()).await.deduped);
    let quiet = h
        .inv
        .invoke(req("chart.report_viewport", json!({}), Origin::User))
        .await;
    assert!(quiet.ok);
    assert!(
        h.inv.invoke(read()).await.deduped,
        "a quiet call keeps them"
    );
    let change = h
        .inv
        .invoke(req("chart.set_symbol", json!({"text": "NQ"}), Origin::User))
        .await;
    assert!(change.ok);
    let after = h.inv.invoke(read()).await;
    assert!(after.ok && !after.deduped, "read again after the change");
    assert!(h.inv.invoke(read()).await.deduped);
    assert_eq!(h.reads.get(), 2);
}

#[tokio::test]
async fn deduped_calls_report_the_approvals_current_state() {
    let h = harness();
    let first = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    assert_eq!(first.status, ToolOutcome::PendingApproval);
    let p = first.approval.clone().unwrap();
    let again = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    assert!(again.deduped);
    assert_eq!(again.status, ToolOutcome::PendingApproval);
    assert_eq!(again.approval.as_ref().unwrap().approval_id, p.approval_id);
    let done = h
        .inv
        .resolve(
            &resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve),
            &Origin::User,
        )
        .await
        .unwrap();
    let executed = done.result.unwrap();
    assert_eq!(h.orders.get(), 1);
    h.clock.advance(2 * NANOS_PER_SEC);
    let after = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    assert!(after.deduped, "still inside the duplicate-call window");
    assert_eq!(after.status, ToolOutcome::Ok, "{after:?}");
    assert!(after.ok);
    assert!(
        after.approval.is_none(),
        "nothing waits on an approval any more"
    );
    assert_eq!(after.output, executed.output);
    assert_eq!(after.output.as_ref().unwrap()["submitted"], 25);
    assert_eq!(h.orders.get(), 1, "the repeat did not execute again");
    {
        let finished = h.obs.finished.lock();
        let rec = finished.last().unwrap();
        assert!(rec.deduped);
        assert_eq!(rec.status, ToolCallStatus::Ok);
        assert_eq!(rec.approval_id.as_ref(), Some(&p.approval_id));
        assert!(
            rec.summary.as_deref().unwrap().contains("approved"),
            "{rec:?}"
        );
    }

    let h = harness();
    let p = h
        .inv
        .invoke(req("orders.submit", order("SPY"), agent()))
        .await
        .approval
        .unwrap();
    h.inv
        .resolve(
            &resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Reject),
            &Origin::User,
        )
        .await
        .unwrap();
    let after = h
        .inv
        .invoke(req("orders.submit", order("SPY"), agent()))
        .await;
    assert!(after.deduped && !after.ok);
    assert_eq!(after.status, ToolOutcome::Denied);
    let err = after.error.unwrap();
    assert_eq!(err.code, ToolErrorCode::PermissionDenied);
    assert!(err.message.contains("rejected"), "{}", err.message);
    assert_eq!(err.details.as_ref().unwrap()["approvalStatus"], "rejected");
    assert_eq!(h.orders.get(), 0);

    let h = harness();
    let p = h
        .inv
        .invoke(req("orders.submit", order("NVDA"), agent()))
        .await
        .approval
        .unwrap();
    let mut edit = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Edit);
    edit.input = Some(json!({"account": "paper-main", "symbol": "NVDA", "qty": 10}));
    let rep = h
        .inv
        .resolve(&edit, &Origin::User)
        .await
        .unwrap()
        .replacement
        .unwrap();
    let after = h
        .inv
        .invoke(req("orders.submit", order("NVDA"), agent()))
        .await;
    assert!(after.deduped);
    assert_eq!(after.status, ToolOutcome::PendingApproval);
    let pointer = after.approval.unwrap();
    assert_eq!(pointer.approval_id, rep.id);
    assert_eq!(pointer.preview_hash, rep.preview_hash);
    assert_eq!(after.output.unwrap()["approvalId"], json!(rep.id));

    let h = harness_with(InvokerConfig {
        staleness: StalenessPolicy {
            max_age_nanos: 5 * NANOS_PER_SEC,
            max_ticks: None,
        },
        limits: LoopLimits::default(),
    });
    let p = h
        .inv
        .invoke(req("orders.submit", order("AAPL"), agent()))
        .await
        .approval
        .unwrap();
    h.clock.advance(6 * NANOS_PER_SEC);
    assert_eq!(h.inv.expire_stale().len(), 1);
    let after = h
        .inv
        .invoke(req("orders.submit", order("AAPL"), agent()))
        .await;
    assert!(after.deduped && !after.ok);
    let err = after.error.unwrap();
    assert_eq!(err.code, ToolErrorCode::Stale);
    assert_eq!(err.details.unwrap()["approvalId"], json!(p.approval_id));
    assert_eq!(h.orders.get(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_repeat_during_the_approved_execution_reports_its_real_outcome() {
    for fail in [false, true] {
        let h = harness();
        let input =
            json!({ "account": "paper-main", "symbol": "QQQ", "delay_ms": 300, "fail": fail });
        let first = h
            .inv
            .invoke(req("orders.slow", input.clone(), agent()))
            .await;
        let p = first.approval.clone().unwrap();
        let approve = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
        let (resolved, repeat) = tokio::join!(h.inv.resolve(&approve, &Origin::User), async {
            h.executing().await;
            h.inv
                .invoke(req("orders.slow", input.clone(), agent()))
                .await
        });
        let executed = resolved.unwrap().result.unwrap();
        assert_eq!(h.slow_orders.get(), 1, "executed once");
        assert!(repeat.deduped);
        assert_eq!(repeat.status, executed.status, "fail={fail}: {repeat:?}");
        assert_eq!(repeat.ok, !fail);
        if fail {
            assert_eq!(repeat.status, ToolOutcome::Error);
            let err = repeat.error.unwrap();
            assert_eq!(err.code, ToolErrorCode::Unavailable);
            let details = err.details.unwrap();
            assert_eq!(details["approvalId"], json!(p.approval_id));
            assert_eq!(details["approvalStatus"], "approved");
            assert_eq!(
                details["broker"], "paper",
                "the tool's own details are kept"
            );
        } else {
            assert_eq!(repeat.output, Some(json!({ "filled": true })));
            assert!(repeat.error.is_none());
        }
    }
}

#[tokio::test]
async fn a_repeat_after_the_stale_time_reports_stale_before_the_sweep() {
    let h = harness_with(InvokerConfig {
        staleness: StalenessPolicy {
            max_age_nanos: 5 * NANOS_PER_SEC,
            max_ticks: None,
        },
        limits: LoopLimits::default(),
    });
    let p = h
        .inv
        .invoke(req("orders.submit", order("TSLA"), agent()))
        .await
        .approval
        .unwrap();
    h.clock.advance(5 * NANOS_PER_SEC);
    let after = h
        .inv
        .invoke(req("orders.submit", order("TSLA"), agent()))
        .await;
    assert!(after.deduped && !after.ok, "{after:?}");
    assert!(after.approval.is_none(), "no dead approval is offered");
    let err = after.error.unwrap();
    assert_eq!(err.code, ToolErrorCode::Stale);
    assert_eq!(err.details.unwrap()["approvalStatus"], "stale");
    assert_eq!(
        h.inv.approvals().get(&p.approval_id).unwrap().status,
        ApprovalStatus::Stale
    );
    assert!(matches!(
        h.obs.approvals.lock().last(),
        Some(ApprovalEvent::Stale { approval }) if approval.id == p.approval_id
    ));
    assert!(h.inv.drafts().is_empty(), "the draft slot is released");
}

#[tokio::test]
async fn approved_results_outlive_hundreds_of_later_approvals() {
    let h = harness();
    let mut first_output = None;
    for i in 0..300u32 {
        let mut r = req(
            "orders.submit",
            json!({ "account": "paper-main", "symbol": "QQQ", "qty": i + 1 }),
            Origin::User,
        );
        r.idempotency_key = Some(format!("order-{i}"));
        let p = h.inv.invoke(r).await.approval.unwrap();
        let done = h
            .inv
            .resolve(
                &resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve),
                &Origin::User,
            )
            .await
            .unwrap();
        if i == 0 {
            first_output = done.result.unwrap().output;
        }
        h.clock.advance(NANOS_PER_SEC);
    }
    assert_eq!(h.orders.get(), 300);
    let mut again = req(
        "orders.submit",
        json!({ "account": "paper-main", "symbol": "QQQ", "qty": 1 }),
        Origin::User,
    );
    again.idempotency_key = Some("order-0".into());
    let r = h.inv.invoke(again).await;
    assert!(r.deduped && r.ok, "{r:?}");
    assert_eq!(r.status, ToolOutcome::Ok);
    assert_eq!(r.output, first_output);
    assert_eq!(h.orders.get(), 300, "nothing ran twice");
}

#[tokio::test]
async fn user_calls_are_not_deduped_but_honor_idempotency_keys() {
    let h = harness();
    h.inv
        .invoke(req("test.read", json!({"text": "q"}), Origin::User))
        .await;
    h.inv
        .invoke(req("test.read", json!({"text": "q"}), Origin::User))
        .await;
    assert_eq!(h.reads.get(), 2);
    let mut r = req("chart.set_symbol", json!({"text": "NQ"}), Origin::User);
    r.idempotency_key = Some("k-1".into());
    let first = h.inv.invoke(r.clone()).await;
    let second = h.inv.invoke(r).await;
    assert!(first.ok && !first.deduped);
    assert!(second.ok && second.deduped);
    assert_eq!(h.modifies.get(), 1);
}

#[tokio::test]
async fn supervised_modify_needs_approval_then_runs_once() {
    let h = harness();
    let r = h
        .inv
        .invoke(req("chart.set_symbol", json!({"text": "NQ"}), agent()))
        .await;
    assert!(r.ok);
    assert_eq!(r.status, ToolOutcome::PendingApproval);
    let pending = r.approval.clone().unwrap();
    assert!(pending.draft_id.is_none(), "modify approvals have no draft");
    assert_eq!(r.output.as_ref().unwrap()["status"], "pending_approval");
    assert_eq!(h.modifies.get(), 0, "nothing executes before approval");
    assert!(matches!(
        h.obs.approvals.lock().last(),
        Some(ApprovalEvent::Requested { .. })
    ));

    let res = h
        .inv
        .resolve(
            &resolve_params(
                &pending.approval_id,
                &pending.preview_hash,
                ApprovalDecision::Approve,
            ),
            &Origin::User,
        )
        .await
        .unwrap();
    assert_eq!(res.approval.status, ApprovalStatus::Approved);
    let out = res.result.unwrap();
    assert!(out.ok, "{out:?}");
    assert_eq!(h.modifies.get(), 1);
    let output = out.output.unwrap();
    assert_eq!(output["approvedBy"], json!(pending.approval_id));
    assert_eq!(
        output["origin"]["kind"], "agent",
        "attributed to the requester"
    );
    let rec = h.obs.finished.lock().last().cloned().unwrap();
    assert_eq!(rec.approved_by.as_ref(), Some(&pending.approval_id));

    let again = h
        .inv
        .resolve(
            &resolve_params(
                &pending.approval_id,
                &pending.preview_hash,
                ApprovalDecision::Approve,
            ),
            &Origin::User,
        )
        .await;
    assert_eq!(
        again.unwrap_err(),
        ResolveError::Approval(ApprovalError::AlreadyResolved(ApprovalStatus::Approved))
    );
    assert_eq!(h.modifies.get(), 1);
}

#[tokio::test]
async fn session_modes() {
    let h = harness();
    h.inv
        .set_policy(&agent(), SessionPolicy::with_mode(SessionMode::AutoModify));
    let r = h
        .inv
        .invoke(req("chart.set_symbol", json!({"text": "NQ"}), agent()))
        .await;
    assert_eq!(r.status, ToolOutcome::Ok);
    assert_eq!(h.modifies.get(), 1);

    h.inv
        .set_policy(&agent(), SessionPolicy::with_mode(SessionMode::ReadOnly));
    let r = h
        .inv
        .invoke(req("chart.set_symbol", json!({"text": "ES"}), agent()))
        .await;
    assert_eq!(r.status, ToolOutcome::Denied);
    assert_eq!(r.error.unwrap().code, ToolErrorCode::PermissionDenied);
    let r = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    assert_eq!(r.status, ToolOutcome::Denied);
    let r = h.inv.invoke(req("test.read", json!({}), agent())).await;
    assert_eq!(r.status, ToolOutcome::Ok);
    assert_eq!(h.modifies.get(), 1);
    assert_eq!(h.orders.get(), 0);
}

#[tokio::test]
async fn allow_and_deny_lists() {
    let h = harness();
    h.inv.set_policy(
        &external(),
        SessionPolicy {
            mode: SessionMode::AutoModify,
            allow: Some(vec!["test.*".into(), "chart.set_symbol".into()]),
            deny: vec!["chart.set_symbol".into()],
        },
    );
    let r = h.inv.invoke(req("test.read", json!({}), external())).await;
    assert!(r.ok);
    let r = h
        .inv
        .invoke(req("chart.set_symbol", json!({}), external()))
        .await;
    assert_eq!(r.status, ToolOutcome::Denied, "deny list wins");
    let r = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), external()))
        .await;
    assert_eq!(r.status, ToolOutcome::Denied, "not in allow list");
}

#[tokio::test]
async fn financial_from_agent_is_a_draft_with_one_live_per_account_and_symbol() {
    let h = harness();
    let r1 = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    assert_eq!(r1.status, ToolOutcome::PendingApproval);
    let p1 = r1.approval.clone().unwrap();
    assert!(p1.draft_id.is_some());
    assert_eq!(r1.output.as_ref().unwrap()["draftId"], json!(p1.draft_id));
    assert_eq!(h.orders.get(), 0);
    {
        let drafts = h.obs.drafts.lock();
        assert_eq!(drafts.len(), 1);
        assert!(drafts[0].live);
        assert_eq!(drafts[0].account, "paper-main");
    }
    let a = h.inv.approvals().get(&p1.approval_id).unwrap();
    assert_eq!(a.environment, Some(Environment::Paper));
    assert_eq!(a.preview["restatement"], "BUY 25 QQQ LMT");

    let mut second = order("QQQ");
    second["qty"] = json!(10);
    let r2 = h.inv.invoke(req("orders.submit", second, agent())).await;
    assert_eq!(r2.status, ToolOutcome::Denied);
    assert_eq!(r2.error.as_ref().unwrap().code, ToolErrorCode::LoopGuard);
    assert!(r2.error.unwrap().message.contains("live draft"));

    let r3 = h
        .inv
        .invoke(req("orders.submit", order("SPY"), agent()))
        .await;
    assert_eq!(r3.status, ToolOutcome::PendingApproval);

    let res = h
        .inv
        .resolve(
            &resolve_params(&p1.approval_id, &p1.preview_hash, ApprovalDecision::Reject),
            &Origin::User,
        )
        .await
        .unwrap();
    assert_eq!(res.approval.status, ApprovalStatus::Rejected);
    assert!(!h.obs.drafts.lock().last().unwrap().live);
    let mut third = order("QQQ");
    third["qty"] = json!(5);
    let r4 = h.inv.invoke(req("orders.submit", third, agent())).await;
    assert_eq!(r4.status, ToolOutcome::PendingApproval);
    assert_eq!(h.orders.get(), 0, "no order ever executed without approval");
}

#[tokio::test]
async fn self_approval_and_external_resolution_are_refused() {
    let h = harness();
    let r = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    let p = r.approval.unwrap();
    let params = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
    assert_eq!(
        h.inv.resolve(&params, &agent()).await.unwrap_err(),
        ResolveError::Approval(ApprovalError::SelfApproval)
    );
    assert_eq!(
        h.inv.resolve(&params, &external()).await.unwrap_err(),
        ResolveError::Approval(ApprovalError::NotUser)
    );
    assert_eq!(h.orders.get(), 0);
    assert_eq!(
        h.inv.approvals().get(&p.approval_id).unwrap().status,
        ApprovalStatus::Pending
    );
    let ok = h.inv.resolve(&params, &Origin::User).await.unwrap();
    assert!(ok.result.unwrap().ok);
    assert_eq!(h.orders.get(), 1);
}

#[tokio::test]
async fn preview_hash_must_match_and_stale_approvals_fail() {
    let h = harness();
    let r = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    let p = r.approval.unwrap();
    let bad = resolve_params(&p.approval_id, "0000", ApprovalDecision::Approve);
    assert_eq!(
        h.inv.resolve(&bad, &Origin::User).await.unwrap_err(),
        ResolveError::Approval(ApprovalError::HashMismatch)
    );
    h.clock.advance(60 * NANOS_PER_SEC);
    let good = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
    assert_eq!(
        h.inv.resolve(&good, &Origin::User).await.unwrap_err(),
        ResolveError::Approval(ApprovalError::Stale)
    );
    assert_eq!(h.orders.get(), 0);
    assert!(matches!(
        h.obs.approvals.lock().last(),
        Some(ApprovalEvent::Stale { .. })
    ));
    let again = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    assert_eq!(again.status, ToolOutcome::PendingApproval);
}

#[tokio::test]
async fn expiry_sweep_and_tick_staleness() {
    let h = harness_with(InvokerConfig {
        staleness: StalenessPolicy {
            max_age_nanos: 60 * NANOS_PER_SEC,
            max_ticks: Some(5),
        },
        limits: LoopLimits::default(),
    });
    let a = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    let b = h
        .inv
        .invoke(req("chart.set_symbol", json!({"text": "x"}), agent()))
        .await;
    let qqq = InstrumentId::new("QQQ").unwrap();
    assert!(h.inv.observe_ticks(&qqq, 4).is_empty());
    let stale = h.inv.observe_ticks(&qqq, 1);
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].id, a.approval.unwrap().approval_id);
    h.clock.advance(61 * NANOS_PER_SEC);
    let swept = h.inv.expire_stale();
    assert_eq!(swept.len(), 1);
    assert_eq!(swept[0].id, b.approval.unwrap().approval_id);
    assert!(h.inv.approvals().pending().is_empty());
    assert!(h.inv.drafts().is_empty());
}

#[tokio::test]
async fn edit_supersedes_with_a_fresh_preview() {
    let h = harness();
    let r = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    let p = r.approval.unwrap();

    let mut bad = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Edit);
    bad.input = Some(json!({"account": "paper-main", "symbol": "QQQ", "qty": 0}));
    assert!(matches!(
        h.inv.resolve(&bad, &Origin::User).await.unwrap_err(),
        ResolveError::InvalidInput(_)
    ));
    let mut missing = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Edit);
    missing.input = None;
    assert_eq!(
        h.inv.resolve(&missing, &Origin::User).await.unwrap_err(),
        ResolveError::Approval(ApprovalError::MissingEditInput)
    );
    assert_eq!(
        h.inv.approvals().get(&p.approval_id).unwrap().status,
        ApprovalStatus::Pending
    );

    let mut edit = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Edit);
    edit.input = Some(json!({"account": "paper-main", "symbol": "QQQ", "qty": 10}));
    let res = h.inv.resolve(&edit, &Origin::User).await.unwrap();
    assert_eq!(res.approval.status, ApprovalStatus::Superseded);
    let rep = res.replacement.unwrap();
    assert_eq!(res.approval.replaced_by.as_ref(), Some(&rep.id));
    assert_eq!(rep.replaces.as_ref(), Some(&p.approval_id));
    assert_eq!(rep.draft_id, p.draft_id, "same draft object");
    assert_ne!(rep.preview_hash, p.preview_hash);
    assert_eq!(rep.preview["restatement"], "BUY 10 QQQ LMT");

    let old = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
    assert!(h.inv.resolve(&old, &Origin::User).await.is_err());
    let new = resolve_params(&rep.id, &rep.preview_hash, ApprovalDecision::Approve);
    let done = h.inv.resolve(&new, &Origin::User).await.unwrap();
    assert_eq!(done.result.unwrap().output.unwrap()["submitted"], 10);
    assert_eq!(h.orders.get(), 1);
    assert!(h.inv.drafts().is_empty());
}

#[tokio::test]
async fn approving_with_an_input_runs_it_in_the_drafts_place() {
    let h = harness();
    let p = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await
        .approval
        .unwrap();

    let mut refused = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
    refused.input = Some(json!({"account": "paper-main", "symbol": "QQQ", "qty": 0}));
    assert!(matches!(
        h.inv.resolve(&refused, &Origin::User).await.unwrap_err(),
        ResolveError::InvalidInput(_)
    ));
    let mut stale_hash = resolve_params(&p.approval_id, "other", ApprovalDecision::Approve);
    stale_hash.input = Some(json!({"account": "paper-main", "symbol": "QQQ", "qty": 10}));
    assert_eq!(
        h.inv.resolve(&stale_hash, &Origin::User).await.unwrap_err(),
        ResolveError::Approval(ApprovalError::HashMismatch)
    );
    assert_eq!(h.orders.get(), 0);
    assert_eq!(
        h.inv.approvals().get(&p.approval_id).unwrap().status,
        ApprovalStatus::Pending
    );

    let mut approve = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
    approve.input = Some(json!({"account": "paper-main", "symbol": "QQQ", "qty": 10}));
    let done = h.inv.resolve(&approve, &Origin::User).await.unwrap();
    assert_eq!(done.result.unwrap().output.unwrap()["submitted"], 10);
    assert_eq!(h.orders.get(), 1);
    assert_eq!(done.approval.status, ApprovalStatus::Approved);
    assert_eq!(done.approval.replaces.as_ref(), Some(&p.approval_id));
    assert_eq!(done.approval.input["qty"], 10);
    assert_eq!(done.approval.draft_id, p.draft_id, "same draft object");
    let old = h.inv.approvals().get(&p.approval_id).unwrap();
    assert_eq!(old.status, ApprovalStatus::Superseded);
    assert_eq!(old.replaced_by.as_ref(), Some(&done.approval.id));
    assert!(h.inv.approvals().pending().is_empty());
    assert!(h.inv.drafts().is_empty());
    assert!(
        !h.obs.approvals.lock().iter().any(|e| matches!(
            e,
            ApprovalEvent::Requested { approval } if approval.replaces.is_some()
        )),
        "the replacement never waits as a draft of its own"
    );
    let again = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
    assert!(h.inv.resolve(&again, &Origin::User).await.is_err());
    assert_eq!(h.orders.get(), 1, "sent once");
}

#[tokio::test]
async fn user_financial_needs_confirmation_unless_paper_and_armed() {
    let h = harness();
    let r = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), Origin::User))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval);
    let p = r.approval.unwrap();
    h.inv
        .resolve(
            &resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Reject),
            &Origin::User,
        )
        .await
        .unwrap();

    let mut armed = req("orders.submit", order("QQQ"), Origin::User);
    armed.surface = SurfaceState {
        armed: true,
        hold_confirmed: false,
    };
    let r = h.inv.invoke(armed).await;
    assert_eq!(r.status, ToolOutcome::Ok, "PAPER + ARMED is one click");
    assert_eq!(h.orders.get(), 1);

    for env in [
        Environment::Sim,
        Environment::Eval,
        Environment::Funded,
        Environment::Live,
    ] {
        let mut input = order("SPY");
        input["env"] = json!(env);
        input["account"] = json!(format!("acct-{env:?}"));
        let mut armed = req("orders.submit", input, Origin::User);
        armed.surface = SurfaceState {
            armed: true,
            hold_confirmed: false,
        };
        let r = h.inv.invoke(armed).await;
        assert_eq!(
            r.status,
            ToolOutcome::PendingApproval,
            "{env:?}: arming alone never sends"
        );
    }
    assert_eq!(h.orders.get(), 1);

    for (env, sends) in [
        (Environment::Sim, true),
        (Environment::Eval, true),
        (Environment::Funded, true),
        (Environment::Live, true),
    ] {
        let mut input = order("NVDA");
        input["env"] = json!(env);
        input["account"] = json!(format!("held-{env:?}"));
        let mut held = req("orders.submit", input, Origin::User);
        held.surface = SurfaceState {
            armed: false,
            hold_confirmed: true,
        };
        let r = h.inv.invoke(held).await;
        let want = if sends {
            ToolOutcome::Ok
        } else {
            ToolOutcome::PendingApproval
        };
        assert_eq!(r.status, want, "{env:?} after a hold");
    }
    assert_eq!(h.orders.get(), 5);

    for env in [Environment::Eval, Environment::Live] {
        let mut input = order("AAPL");
        input["env"] = json!(env);
        input["exit"] = json!(true);
        input["account"] = json!(format!("exit-{env:?}"));
        let r = h
            .inv
            .invoke(req("orders.submit", input.clone(), Origin::User))
            .await;
        assert_eq!(
            r.status,
            ToolOutcome::Ok,
            "{env:?}: an exit is never covered"
        );
        let mut armed = req("orders.submit", input, agent());
        armed.surface = SurfaceState {
            armed: true,
            hold_confirmed: true,
        };
        let r = h.inv.invoke(armed).await;
        assert_eq!(
            r.status,
            ToolOutcome::PendingApproval,
            "an agent never executes, whatever surface it claims"
        );
    }
    assert_eq!(h.orders.get(), 7);
}

#[tokio::test(start_paused = true)]
async fn concurrent_armed_calls_with_one_key_send_one_order() {
    let h = harness();
    let mut call = req(
        "orders.slow",
        json!({ "account": "paper-main", "symbol": "QQQ", "delay_ms": 200 }),
        Origin::User,
    );
    call.surface = SurfaceState {
        armed: true,
        hold_confirmed: false,
    };
    call.idempotency_key = Some("click-1".into());
    let (a, b) = tokio::join!(h.inv.invoke(call.clone()), async {
        h.executing().await;
        h.inv.invoke(call.clone()).await
    });
    assert!(a.ok && b.ok, "{a:?} {b:?}");
    assert_eq!(h.slow_orders.get(), 1, "one order, not two");
    assert!(!a.deduped && b.deduped, "the repeat waited for the first");
    assert_eq!(a.output, b.output);
    let c = h.inv.invoke(call.clone()).await;
    assert!(c.deduped && c.ok);
    call.idempotency_key = Some("click-2".into());
    assert!(h.inv.invoke(call).await.ok);
    assert_eq!(h.slow_orders.get(), 2);

    let mut failing = req(
        "orders.slow",
        json!({ "account": "paper-2", "symbol": "SPY", "delay_ms": 10, "fail": true }),
        Origin::User,
    );
    failing.surface = SurfaceState {
        armed: true,
        hold_confirmed: false,
    };
    failing.idempotency_key = Some("click-3".into());
    assert!(!h.inv.invoke(failing.clone()).await.ok);
    let retry = h.inv.invoke(failing).await;
    assert!(!retry.deduped, "a failure is not stored");
    assert_eq!(h.slow_orders.get(), 4);
}

#[tokio::test(start_paused = true)]
async fn an_approved_execution_outlives_its_resolver() {
    let h = harness();
    let input = json!({ "account": "paper-main", "symbol": "QQQ", "delay_ms": 200 });
    let p = h
        .inv
        .invoke(req("orders.slow", input.clone(), agent()))
        .await
        .approval
        .unwrap();
    let params = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
    tokio::select! {
        r = h.inv.resolve(&params, &Origin::User) => panic!("resolved before the order ran: {r:?}"),
        () = h.executing() => {}
    }
    let (sent, status) = settle(
        "the approved order finishes without its resolver",
        || {
            let status = h
                .obs
                .finished
                .lock()
                .iter()
                .rev()
                .find(|r| r.approved_by.as_ref() == Some(&p.approval_id))
                .map(|r| r.status);
            (h.slow_orders.get(), status)
        },
        |(_, status)| status.is_some(),
    )
    .await;
    assert_eq!(sent, 1);
    assert_eq!(status, Some(ToolCallStatus::Ok));
    let draft = h.obs.drafts.lock().last().cloned().unwrap();
    assert_eq!(draft.status, DraftStatus::Submitted);
    let repeat = h.inv.invoke(req("orders.slow", input, agent())).await;
    assert!(repeat.deduped && repeat.ok, "{repeat:?}");
    assert_eq!(h.slow_orders.get(), 1, "never executed twice");
}

#[tokio::test(start_paused = true)]
async fn shutdown_finishes_the_records_of_running_financial_calls() {
    let h = harness();
    let input = json!({ "account": "paper-main", "symbol": "QQQ", "delay_ms": 3_000 });
    let p = h
        .inv
        .invoke(req("orders.slow", input, agent()))
        .await
        .approval
        .unwrap();
    let params = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve);
    tokio::select! {
        r = h.inv.resolve(&params, &Origin::User) => panic!("resolved before the order ran: {r:?}"),
        () = h.executing() => {}
    }
    let finished = h.inv.shutdown();
    assert_eq!(finished.len(), 1);
    let rec = h.obs.finished.lock().last().cloned().unwrap();
    assert_eq!(rec.call_id, finished[0].call_id);
    assert_eq!(rec.approved_by.as_ref(), Some(&p.approval_id));
    assert_eq!(rec.status, ToolCallStatus::Error);
    let err = rec.error.unwrap();
    assert_eq!(err.code, ToolErrorCode::OutcomeUnknown);
    assert_eq!(err.details.unwrap()["reason"], "shutdown");
    assert!(rec.finished_at.is_some());
    let draft = h.obs.drafts.lock().last().cloned().unwrap();
    assert_eq!(draft.status, DraftStatus::Unconfirmed);
    assert!(h.inv.shutdown().is_empty(), "finished once");
}

#[tokio::test]
async fn call_cap_and_steps_per_turn() {
    let h = harness_with(InvokerConfig {
        staleness: StalenessPolicy::default(),
        limits: LoopLimits {
            max_steps_per_turn: 2,
            max_tool_calls_per_turn: 3,
            ..LoopLimits::default()
        },
    });
    for i in 0..3 {
        let r = h
            .inv
            .invoke(req("test.read", json!({"text": i.to_string()}), agent()))
            .await;
        assert!(r.ok);
    }
    let r = h
        .inv
        .invoke(req("test.read", json!({"text": "4"}), agent()))
        .await;
    assert_eq!(r.status, ToolOutcome::Denied);
    assert_eq!(r.error.unwrap().code, ToolErrorCode::LoopGuard);
    for _ in 0..5 {
        assert!(
            h.inv
                .invoke(req("test.read", json!({}), Origin::User))
                .await
                .ok
        );
    }
    h.inv.begin_turn(&agent());
    let r = h
        .inv
        .invoke(req("test.read", json!({"text": "5"}), agent()))
        .await;
    assert!(r.ok);
    assert!(h.inv.note_step(&agent()).is_ok());
    assert!(h.inv.note_step(&agent()).is_ok());
    assert!(h.inv.note_step(&agent()).is_err());
}

#[tokio::test]
async fn user_only_quiet_rate_limited_tool() {
    let h = harness();
    let r = h
        .inv
        .invoke(req("chart.report_viewport", json!({}), agent()))
        .await;
    assert_eq!(r.status, ToolOutcome::Denied, "user-only");
    {
        let finished = h.obs.finished.lock();
        assert_eq!(finished.len(), 1, "the agent's denied call is audited");
        assert_eq!(finished[0].tool, "chart.report_viewport");
        assert_eq!(finished[0].status, ToolCallStatus::Denied);
        assert!(!finished[0].origin.is_user());
    }
    assert!(
        h.inv
            .invoke(req("chart.report_viewport", json!({}), Origin::User))
            .await
            .ok
    );
    assert!(
        h.inv
            .invoke(req("chart.report_viewport", json!({}), Origin::User))
            .await
            .ok
    );
    let limited = h
        .inv
        .invoke(req("chart.report_viewport", json!({}), Origin::User))
        .await;
    assert_eq!(limited.error.unwrap().code, ToolErrorCode::RateLimited);
    h.clock.advance(60 * NANOS_PER_SEC);
    let still = h
        .inv
        .invoke(req("chart.report_viewport", json!({}), Origin::User))
        .await;
    assert_eq!(
        still.error.unwrap().code,
        ToolErrorCode::RateLimited,
        "the market clock does not pace calls: a frozen or jumping clock neither starves nor floods a tool"
    );
    assert_eq!(h.viewports.get(), 2);
    assert_eq!(h.obs.started.lock().len(), 0);
    assert_eq!(h.obs.finished.lock().len(), 1, "only the agent's attempt");
}

#[tokio::test]
async fn panics_and_timeouts_become_errors() {
    let h = harness();
    let r = h
        .inv
        .invoke(req("test.panic", json!({}), Origin::User))
        .await;
    assert_eq!(r.error.unwrap().code, ToolErrorCode::Internal);
    let r = h
        .inv
        .invoke(req("test.slow", json!({}), Origin::User))
        .await;
    let e = r.error.unwrap();
    assert_eq!(e.code, ToolErrorCode::Timeout);
    assert!(e.retryable);
}

#[tokio::test(start_paused = true)]
async fn a_modify_tool_past_its_timeout_is_stopped() {
    let h = harness();
    let r = h
        .inv
        .invoke(req(
            "chart.slow_change",
            json!({ "delay_ms": 300 }),
            Origin::User,
        ))
        .await;
    let e = r.error.unwrap();
    assert_eq!(e.code, ToolErrorCode::Timeout);
    assert!(e.message.contains("stopped"), "{}", e.message);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(h.slow_changes.get(), 0, "the timed-out tool kept running");
    let rec = h.obs.finished.lock().last().cloned().unwrap();
    assert_eq!(rec.status, ToolCallStatus::Error);
    assert_eq!(rec.error.unwrap().code, ToolErrorCode::Timeout);
}

#[tokio::test(start_paused = true)]
async fn a_financial_call_past_its_timeout_has_an_unknown_outcome() {
    let h = harness();
    let mut call = req(
        "orders.stuck",
        json!({ "account": "paper-main", "symbol": "QQQ", "delay_ms": 300 }),
        Origin::User,
    );
    call.surface = SurfaceState {
        armed: true,
        hold_confirmed: false,
    };
    call.idempotency_key = Some("order-1".into());
    let first = h.inv.invoke(call.clone()).await;
    assert!(!first.ok);
    assert_eq!(first.status, ToolOutcome::Error);
    let err = first.error.clone().unwrap();
    assert_eq!(err.code, ToolErrorCode::OutcomeUnknown, "{err:?}");
    assert!(!err.retryable);
    assert!(
        err.message
            .contains("outcome unknown — check orders before retrying"),
        "{}",
        err.message
    );
    assert_eq!(err.details.as_ref().unwrap()["outcome"], "unknown");
    let audited = h.obs.finished.lock().last().cloned().unwrap();
    assert_eq!(audited.call_id, first.call_id);
    assert_eq!(
        audited.error.as_ref().unwrap().code,
        ToolErrorCode::OutcomeUnknown
    );

    let again = h.inv.invoke(call.clone()).await;
    assert!(again.deduped, "{again:?}");
    assert_eq!(again.error.unwrap().code, ToolErrorCode::OutcomeUnknown);

    let (sent, _) = settle(
        "the timed-out order finishes late",
        || {
            let last = h.obs.finished.lock().last().map(|r| r.status);
            (h.stuck_orders.get(), last)
        },
        |(sent, last)| *sent >= 1 && *last == Some(ToolCallStatus::Ok),
    )
    .await;
    assert_eq!(sent, 1);
    let late = h.obs.finished.lock().last().cloned().unwrap();
    assert_eq!(late.call_id, first.call_id, "the same record, updated");
    assert_eq!(late.status, ToolCallStatus::Ok);
    assert!(late.error.is_none());
    assert!(
        late.summary
            .as_deref()
            .unwrap()
            .contains("past its timeout"),
        "{late:?}"
    );
    let after = h.inv.invoke(call).await;
    assert!(after.deduped);
    assert_eq!(after.error.unwrap().code, ToolErrorCode::OutcomeUnknown);
    assert_eq!(h.stuck_orders.get(), 1, "never sent twice");
}

#[tokio::test(start_paused = true)]
async fn an_approved_financial_call_past_its_timeout_has_an_unknown_outcome() {
    let h = harness();
    let input = json!({ "account": "paper-main", "symbol": "QQQ", "delay_ms": 300 });
    let p = h
        .inv
        .invoke(req("orders.stuck", input.clone(), agent()))
        .await
        .approval
        .unwrap();
    let done = h
        .inv
        .resolve(
            &resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve),
            &Origin::User,
        )
        .await
        .unwrap();
    let executed = done.result.unwrap();
    assert_eq!(executed.error.unwrap().code, ToolErrorCode::OutcomeUnknown);
    let repeat = h.inv.invoke(req("orders.stuck", input, agent())).await;
    assert!(repeat.deduped && !repeat.ok, "{repeat:?}");
    let err = repeat.error.unwrap();
    assert_eq!(err.code, ToolErrorCode::OutcomeUnknown);
    assert!(!err.retryable);
    assert_eq!(err.details.unwrap()["approvalId"], json!(p.approval_id));
    let sent = settle(
        "the approved order runs on past its timeout",
        || h.stuck_orders.get(),
        |sent| *sent >= 1,
    )
    .await;
    assert_eq!(sent, 1, "executed once, and not stopped");
}

#[tokio::test]
async fn an_approved_draft_past_its_timeout_takes_its_real_outcome_when_it_ends() {
    let h = harness();
    let input = json!({ "account": "paper-main", "symbol": "QQQ", "delay_ms": 300 });
    let p = h
        .inv
        .invoke(req("orders.stuck", input, agent()))
        .await
        .approval
        .unwrap();
    let done = h
        .inv
        .resolve(
            &resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Approve),
            &Origin::User,
        )
        .await
        .unwrap();
    assert_eq!(
        done.result.unwrap().error.unwrap().code,
        ToolErrorCode::OutcomeUnknown
    );
    let last = || h.obs.drafts.lock().last().map(|d| d.status);
    assert_eq!(last(), Some(DraftStatus::Unconfirmed));
    settle(
        "the order ends past its timeout and its draft says so",
        last,
        |s| *s == Some(DraftStatus::Submitted),
    )
    .await;
    assert_eq!(h.stuck_orders.get(), 1);
}

#[tokio::test]
async fn an_edit_never_overrides_what_ended_its_approval_meanwhile() {
    for closed in [true, false] {
        let h = harness_with(InvokerConfig {
            staleness: StalenessPolicy {
                max_age_nanos: 5 * NANOS_PER_SEC,
                max_ticks: None,
            },
            limits: LoopLimits::default(),
        });
        let input = json!({ "account": "paper-main", "symbol": "QQQ", "qty": 25 });
        let p = h
            .inv
            .invoke(req("orders.gated", input, agent()))
            .await
            .approval
            .unwrap();
        let mut edit = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Edit);
        edit.input =
            Some(json!({ "account": "paper-main", "symbol": "QQQ", "qty": 10, "hold": true }));
        let (res, ()) = tokio::join!(h.inv.resolve(&edit, &Origin::User), async {
            h.gate.entered.notified().await;
            if closed {
                h.inv.close(&agent());
            } else {
                h.clock.advance(6 * NANOS_PER_SEC);
                assert_eq!(h.inv.expire_stale().len(), 1);
            }
            h.gate.release.notify_one();
        });
        let ended = if closed {
            ApprovalStatus::Cancelled
        } else {
            ApprovalStatus::Stale
        };
        assert_eq!(
            res.unwrap_err(),
            ResolveError::Approval(ApprovalError::AlreadyResolved(ended)),
            "closed={closed}"
        );
        let a = h.inv.approvals().get(&p.approval_id).unwrap();
        assert_eq!(a.status, ended, "not overwritten by the edit");
        assert!(a.replaced_by.is_none());
        assert!(h.inv.approvals().pending().is_empty(), "no replacement");
        assert!(h.inv.drafts().is_empty(), "no draft slot left behind");
        assert!(
            !h.obs.approvals.lock().iter().any(|e| matches!(
                e,
                ApprovalEvent::Requested { approval } if approval.replaces.is_some()
            )),
            "no replacement was announced"
        );
    }
}

#[tokio::test]
async fn a_refused_edit_keeps_the_drafts_slot() {
    let h = harness();
    let p = h
        .inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await
        .approval
        .unwrap();
    h.inv
        .invoke(req("orders.submit", order("SPY"), agent()))
        .await
        .approval
        .unwrap();
    let mut edit = resolve_params(&p.approval_id, &p.preview_hash, ApprovalDecision::Edit);
    edit.input = Some(order("SPY"));
    assert!(matches!(
        h.inv.resolve(&edit, &Origin::User).await.unwrap_err(),
        ResolveError::Conflict(_)
    ));
    assert_eq!(
        h.inv.approvals().get(&p.approval_id).unwrap().status,
        ApprovalStatus::Pending
    );
    let mut qqq = order("QQQ");
    qqq["qty"] = json!(1);
    let second = h.inv.invoke(req("orders.submit", qqq, agent())).await;
    assert_eq!(
        second.status,
        ToolOutcome::Denied,
        "QQQ still has its draft"
    );
    assert_eq!(second.error.unwrap().code, ToolErrorCode::LoopGuard);
}

#[tokio::test]
async fn closing_a_session_cancels_its_approvals() {
    let h = harness();
    h.inv
        .invoke(req("orders.submit", order("QQQ"), agent()))
        .await;
    h.inv
        .invoke(req("chart.set_symbol", json!({}), agent()))
        .await;
    let cancelled = h.inv.close(&agent());
    assert_eq!(cancelled.len(), 2);
    assert!(
        cancelled
            .iter()
            .all(|a| a.status == ApprovalStatus::Cancelled)
    );
    assert!(h.inv.drafts().is_empty());
}

#[test]
fn registry_rules_and_listing() {
    let mut reg = ToolRegistry::new();
    let c = Arc::new(Counter::default());
    reg.register(ReadTool(c.clone())).unwrap();
    assert_eq!(
        reg.register(ReadTool(c.clone())).unwrap_err(),
        RegistryError::Duplicate("test.read".into())
    );
    reg.register(ViewportTool(c.clone())).unwrap();
    reg.register(OrderTool(c)).unwrap();
    assert_eq!(reg.resolve_mcp_name("orders_submit"), Some("orders.submit"));
    let agent_view = reg.descriptors(Audience::Agent, None, true);
    assert!(agent_view.iter().all(|d| d.name != "chart.report_viewport"));
    let user_view = reg.descriptors(Audience::User, None, true);
    assert!(user_view.iter().any(|d| d.name == "chart.report_viewport"));
    let visible = reg.descriptors(Audience::User, None, false);
    assert!(visible.iter().all(|d| d.name != "chart.report_viewport"));
    let orders = reg.descriptors(Audience::User, Some("orders"), false);
    assert_eq!(orders.len(), 1);
    let d = &orders[0];
    assert_eq!(d.mcp_name, "orders_submit");
    assert_eq!(d.risk, RiskTier::Financial);
    assert_eq!(d.input_schema["type"], "object");
    assert!(d.input_schema["properties"]["qty"].is_object());
    assert!(!d.input_schema.to_string().contains("$ref"));
}

#[test]
fn registry_refuses_bad_names_and_collisions() {
    struct Named(&'static str, bool);
    #[async_trait]
    impl Tool for Named {
        type Input = Empty;
        type Output = Value;
        fn meta(&self) -> ToolMeta {
            let m = ToolMeta::new(self.0, "x", RiskTier::Read);
            if self.1 { m.user_only() } else { m }
        }
        async fn call(&self, _: &ToolCtx, _: Empty) -> Result<Value, ToolError> {
            Ok(Value::Null)
        }
    }
    let mut reg = ToolRegistry::new();
    assert!(matches!(
        reg.register(Named("Bad.Name", false)),
        Err(RegistryError::InvalidName(_))
    ));
    reg.register(Named("a.b_c", false)).unwrap();
    assert!(matches!(
        reg.register(Named("a_b.c", false)),
        Err(RegistryError::McpCollision(..))
    ));
    assert!(matches!(
        reg.register(Named("approvals.list", false)),
        Err(RegistryError::ApprovalNotUserOnly(_))
    ));
    reg.register(Named("approvals.list", true)).unwrap();
}

fn armed(mut req: InvokeRequest) -> InvokeRequest {
    req.surface = SurfaceState {
        armed: true,
        hold_confirmed: false,
    };
    req
}

#[tokio::test]
async fn a_hung_order_is_refused_when_it_wakes_past_its_deadline() {
    let h = harness();
    let deadline = Timestamp::now().add_nanos(-40 * NANOS_PER_MILLI);
    let mut call = armed(req("orders.submit", order("NQ"), Origin::User));
    call.deadline = Some(deadline);
    call.idempotency_key = Some("hang-1".into());
    let r = h.inv.invoke(call).await;
    assert!(!r.ok, "{r:?}");
    assert_eq!(r.error.as_ref().unwrap().message, LATE_ORDER);
    assert_eq!(
        r.error.as_ref().unwrap().details.as_ref().unwrap()["outcome"],
        "late"
    );
    assert_eq!(h.orders.get(), 0);
}

#[tokio::test]
async fn a_slow_order_within_its_deadline_goes_once() {
    let h = harness();
    let mut call = armed(req(
        "orders.slow",
        json!({ "account": "paper-main", "symbol": "QQQ", "delay_ms": 80 }),
        Origin::User,
    ));
    call.deadline = Some(Timestamp::now().add_nanos(2 * NANOS_PER_SEC));
    call.idempotency_key = Some("slow-ok".into());
    let r = h.inv.invoke(call.clone()).await;
    assert!(r.ok, "{r:?}");
    assert_eq!(h.slow_orders.get(), 1);
    let again = h.inv.invoke(call).await;
    assert!(again.ok && again.deduped, "{again:?}");
    assert_eq!(h.slow_orders.get(), 1);
}

#[tokio::test]
async fn a_repeated_idempotency_key_does_not_send_twice() {
    let h = harness();
    let mut call = armed(req("orders.submit", order("NQ"), Origin::User));
    call.deadline = Some(Timestamp::now().add_nanos(20 * NANOS_PER_SEC));
    call.idempotency_key = Some("click-once".into());
    assert!(h.inv.invoke(call.clone()).await.ok);
    let again = h.inv.invoke(call).await;
    assert!(again.ok && again.deduped, "{again:?}");
    assert_eq!(h.orders.get(), 1);
}

#[tokio::test]
async fn an_approved_agent_draft_past_its_deadline_is_not_sent() {
    let h = harness();
    let pending = h
        .inv
        .invoke(req("orders.submit", order("NQ"), agent()))
        .await
        .approval
        .unwrap();
    let mut late = resolve_params(
        &pending.approval_id,
        &pending.preview_hash,
        ApprovalDecision::Approve,
    );
    late.deadline = Some(Timestamp::now().add_nanos(-NANOS_PER_SEC));
    late.idempotency_key = Some("draft-late".into());
    let err = h.inv.resolve(&late, &Origin::User).await.unwrap_err();
    assert!(
        matches!(err, ResolveError::NotReady(ref e) if e.message == LATE_ORDER),
        "{err:?}"
    );
    assert_eq!(h.orders.get(), 0);
    assert_eq!(
        h.inv.approvals().get(&pending.approval_id).unwrap().status,
        ApprovalStatus::Pending
    );

    let mut on_time = resolve_params(
        &pending.approval_id,
        &pending.preview_hash,
        ApprovalDecision::Approve,
    );
    on_time.deadline = Some(Timestamp::now().add_nanos(20 * NANOS_PER_SEC));
    on_time.idempotency_key = Some("draft-ok".into());
    let done = h.inv.resolve(&on_time, &Origin::User).await.unwrap();
    assert!(done.result.as_ref().unwrap().ok, "{done:?}");
    assert_eq!(h.orders.get(), 1);

    let again = h.inv.resolve(&on_time, &Origin::User).await.unwrap_err();
    assert!(
        matches!(again, ResolveError::Approval(_)),
        "the draft is already resolved: {again:?}"
    );
    assert_eq!(h.orders.get(), 1);
}
