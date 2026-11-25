use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tessera_core::hash::hash_json;
use tessera_core::ids::{ApprovalId, CallId, DraftId};
use tessera_core::orders::DraftStatus;
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{InstrumentId, Origin, SharedClock, Timestamp};
use tessera_protocol::methods::{ApprovalsResolveParams, ApprovalsResolveResult};
use tessera_protocol::tools::{
    Approval, ApprovalDecision, ApprovalEvent, ApprovalKind, ApprovalStatus, DraftInfo,
    PendingApproval, RiskTier, ToolCallRecord, ToolCallStatus, ToolErrorCode, ToolErrorInfo,
    ToolOutcome, ToolResult,
};

use crate::approvals::{ApprovalBook, ApprovalError, Final, NewApproval, StalenessPolicy};
use crate::audit::{ToolObserver, redact};
use crate::error::ToolError;
use crate::gate::{self, GateDecision, SessionPolicy, SurfaceState};
use crate::guards::{
    Claim, DraftGuard, IdempotencyCache, LoopGuard, LoopLimits, RateLimiter, Reservation, Waited,
    draft_key, scope_of,
};
use crate::registry::ToolRegistry;
use crate::tool::{ActionTarget, DynTool, ErasedOutput, Extensions, ToolCtx, normalize_input};
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinError, JoinHandle};

const STOP_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InvokerConfig {
    pub staleness: StalenessPolicy,
    pub limits: LoopLimits,
}

#[derive(Clone, Debug)]
pub struct InvokeRequest {
    pub name: String,
    pub input: Value,
    pub origin: Origin,
    pub idempotency_key: Option<String>,
    pub surface: SurfaceState,
    pub call_id: Option<CallId>,
    pub deadline: Option<Timestamp>,
}

impl InvokeRequest {
    pub fn new(name: impl Into<String>, input: Value, origin: Origin) -> Self {
        Self {
            name: name.into(),
            input,
            origin,
            idempotency_key: None,
            surface: SurfaceState::default(),
            call_id: None,
            deadline: None,
        }
    }

    pub fn with_call_id(mut self, id: CallId) -> Self {
        self.call_id = Some(id);
        self
    }

    pub fn with_deadline(mut self, deadline: Timestamp) -> Self {
        self.deadline = Some(deadline);
        self
    }
}

pub const LATE_ORDER: &str = "Too late. The runtime did not take it in time. Nothing sent.";

pub fn late_error() -> ToolError {
    ToolError::rejected(LATE_ORDER).with_details(json!({
        "code": "late",
        "sent": false,
        "outcome": "late",
    }))
}

pub fn refuse_late(deadline: Option<Timestamp>) -> Result<(), ToolError> {
    match deadline {
        Some(deadline) if Timestamp::now() >= deadline => Err(late_error()),
        _ => Ok(()),
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ResolveError {
    #[error(transparent)]
    Approval(#[from] ApprovalError),
    #[error("invalid edited input: {0}")]
    InvalidInput(ToolError),
    #[error("tool {0} is not registered")]
    UnknownTool(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{}", .0.message)]
    NotReady(ToolError),
}

struct Execution {
    result: watch::Sender<Option<ToolResult>>,
    finished_at: Option<Timestamp>,
}

enum Executed {
    Finished(ToolResult),
    StillRunning(Duration),
    Unknown,
}

struct InFlight {
    rec: ToolCallRecord,
    approval: Option<ApprovalId>,
    draft: Option<DraftInfo>,
}

struct Shared {
    observer: Arc<dyn ToolObserver>,
    clock: SharedClock,
    executions: Mutex<HashMap<ApprovalId, Execution>>,
    inflight: Mutex<HashMap<CallId, InFlight>>,
    keep_nanos: AtomicI64,
}

impl Shared {
    fn record_execution(&self, approval: &ApprovalId, result: &ToolResult) {
        let now = self.clock.now();
        let keep = self.keep_nanos.load(Ordering::Relaxed);
        let mut executions = self.executions.lock();
        if let Some(e) = executions.get_mut(approval) {
            e.result.send_replace(Some(result.clone()));
            e.finished_at = Some(now);
        }
        executions.retain(|_, e| e.finished_at.is_none_or(|at| now.0 - at.0 <= keep));
    }

    fn draft_executed(&self, mut info: DraftInfo, result: &ToolResult) {
        info.status = if result.ok {
            DraftStatus::Submitted
        } else if outcome_unknown(result) {
            DraftStatus::Unconfirmed
        } else {
            DraftStatus::Failed
        };
        info.error = result.error.clone();
        self.observer.draft(&info);
    }

    fn finish(
        self: &Arc<Self>,
        mut rec: ToolCallRecord,
        started: Instant,
        completion: Completion,
        quiet: bool,
        draft: Option<DraftInfo>,
    ) -> ToolResult {
        self.inflight.lock().remove(&rec.call_id);
        let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
        rec.finished_at = Some(self.clock.now());
        rec.duration_ms = Some(duration_ms);
        let mut still_running = None;
        let (status, output, error, approval) = match completion {
            Completion::Ok { output, summary } => {
                rec.summary = summary;
                (ToolOutcome::Ok, Some(output), None, None)
            }
            Completion::Failed(e) => (ToolOutcome::Error, None, Some(e.to_info()), None),
            Completion::Denied(e) => (ToolOutcome::Denied, None, Some(e.to_info()), None),
            Completion::Unknown { error, task } => {
                still_running = Some(task);
                (ToolOutcome::Error, None, Some(error.to_info()), None)
            }
            Completion::Pending(a) => {
                rec.approval_id = Some(a.id.clone());
                rec.summary = Some(format!("awaiting approval {}", a.id));
                let (stub, pending) = pending_parts(&a, self.clock.now());
                (
                    ToolOutcome::PendingApproval,
                    Some(stub),
                    None,
                    Some(pending),
                )
            }
        };
        rec.status = status.into();
        rec.error = error.clone();
        report_finished(self.observer.as_ref(), &rec, quiet);
        let call_id = rec.call_id.clone();
        if let Some(task) = still_running {
            self.record_late_outcome(rec, started, task, quiet, draft);
        }
        ToolResult {
            ok: matches!(status, ToolOutcome::Ok | ToolOutcome::PendingApproval),
            status,
            call_id,
            duration_ms,
            output,
            error,
            approval,
            deduped: false,
        }
    }

    fn record_late_outcome(
        self: &Arc<Self>,
        mut rec: ToolCallRecord,
        started: Instant,
        task: JoinHandle<Result<ErasedOutput, ToolError>>,
        quiet: bool,
        draft: Option<DraftInfo>,
    ) {
        let shared = Arc::clone(self);
        let observer = Arc::clone(&self.observer);
        let clock = Arc::clone(&self.clock);
        tokio::spawn(async move {
            let joined = task.await;
            rec.finished_at = Some(clock.now());
            let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
            rec.duration_ms = Some(duration_ms);
            let late = format!("ended {duration_ms:.0} ms after it started, past its timeout");
            match joined {
                Ok(Ok(out)) => {
                    rec.status = ToolCallStatus::Ok;
                    rec.error = None;
                    rec.summary = Some(match out.summary {
                        Some(s) => format!("{s} ({late})"),
                        None => late,
                    });
                }
                Ok(Err(e)) => {
                    rec.status = ToolCallStatus::Error;
                    rec.error = Some(e.to_info());
                    rec.summary = Some(late);
                }
                Err(join) => {
                    tracing::error!(tool = %rec.tool, error = %join, "tool task failed");
                    rec.status = ToolCallStatus::Error;
                    rec.error = Some(
                        ToolError::internal(format!("{} failed unexpectedly", rec.tool)).to_info(),
                    );
                    rec.summary = Some(late);
                }
            }
            tracing::warn!(
                tool = %rec.tool,
                call = %rec.call_id,
                status = ?rec.status,
                "a financial call that timed out has ended"
            );
            report_finished(observer.as_ref(), &rec, quiet);
            if let Some(d) = draft {
                let ok = rec.status == ToolCallStatus::Ok;
                let ended = ToolResult {
                    ok,
                    status: if ok {
                        ToolOutcome::Ok
                    } else {
                        ToolOutcome::Error
                    },
                    call_id: rec.call_id.clone(),
                    duration_ms,
                    output: None,
                    error: rec.error.clone(),
                    approval: None,
                    deduped: false,
                };
                shared.draft_executed(d, &ended);
            }
        });
    }
}

fn report_finished(observer: &dyn ToolObserver, rec: &ToolCallRecord, quiet: bool) {
    if quiet {
        observer.call_finished_quietly(&ToolCallRecord {
            input: Value::Null,
            input_hash: String::new(),
            ..rec.clone()
        });
    } else {
        observer.call_finished(rec);
    }
}

struct ExecutionGuard {
    shared: Arc<Shared>,
    approval: ApprovalId,
    finished: bool,
}

impl ExecutionGuard {
    fn finish(mut self, result: &ToolResult) {
        self.shared.record_execution(&self.approval, result);
        self.finished = true;
    }

    fn abandon(mut self) {
        self.shared.executions.lock().remove(&self.approval);
        self.finished = true;
    }
}

impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let err = ToolError::outcome_unknown(format!(
            "the approved call (approval {}) was interrupted before its result was recorded; its \
             outcome is unknown: check orders and the activity log (tool.calls) before trying again",
            self.approval
        ));
        self.shared
            .record_execution(&self.approval, &unknown_result(err));
    }
}

fn unknown_result(err: ToolError) -> ToolResult {
    ToolResult {
        ok: false,
        status: ToolOutcome::Error,
        call_id: CallId::generate(),
        duration_ms: 0.0,
        output: None,
        error: Some(err.to_info()),
        approval: None,
        deduped: false,
    }
}

struct Financial {
    reservation: Option<Reservation>,
    execution: Option<ExecutionGuard>,
    draft: Option<DraftInfo>,
}

fn finish_reservation(r: Reservation, result: &ToolResult, now: Timestamp) {
    r.finish(result, result.ok || outcome_unknown(result), now);
}

type Joined = Result<Result<ErasedOutput, ToolError>, JoinError>;

enum Completion {
    Ok {
        output: Value,
        summary: Option<String>,
    },
    Failed(ToolError),
    Denied(ToolError),
    Pending(Box<Approval>),
    Unknown {
        error: ToolError,
        task: JoinHandle<Result<ErasedOutput, ToolError>>,
    },
}

struct AbortOnDrop(Option<AbortHandle>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}

fn joined_completion(name: &str, joined: Joined) -> Completion {
    match joined {
        Ok(Ok(out)) => Completion::Ok {
            output: out.value,
            summary: out.summary,
        },
        Ok(Err(e)) => Completion::Failed(e),
        Err(join) => {
            tracing::error!(tool = %name, error = %join, "tool task failed");
            Completion::Failed(ToolError::internal(format!("{name} failed unexpectedly")))
        }
    }
}

async fn execute_tool(tool: &Arc<dyn DynTool>, ctx: ToolCtx, input: Value) -> Completion {
    let meta = tool.meta();
    let timeout = Duration::from_millis(meta.timeout_ms.max(1));
    let name = meta.name.clone();
    let financial = meta.risk == RiskTier::Financial;
    let task_tool = Arc::clone(tool);
    let mut handle = tokio::spawn(async move { task_tool.call_json(&ctx, input).await });
    let _stop_if_dropped = AbortOnDrop((!financial).then(|| handle.abort_handle()));
    let ms = timeout.as_millis();
    match tokio::time::timeout(timeout, &mut handle).await {
        Ok(joined) => joined_completion(&name, joined),
        Err(_) if financial => {
            tracing::warn!(tool = %name, timeout_ms = %ms, "financial call timed out; its outcome is unknown");
            Completion::Unknown {
                error: ToolError::outcome_unknown(format!(
                    "{name} timed out after {ms} ms; outcome unknown — check orders before \
                     retrying. The call was not stopped, so it may still take effect; the \
                     activity log (tool.calls) shows its outcome once it ends"
                ))
                .with_details(json!({ "outcome": "unknown", "timeoutMs": ms })),
                task: handle,
            }
        }
        Err(_) => {
            handle.abort();
            match tokio::time::timeout(STOP_GRACE, &mut handle).await {
                Ok(Err(join)) if join.is_cancelled() => Completion::Failed(ToolError::new(
                    ToolErrorCode::Timeout,
                    format!("{name} timed out after {ms} ms and was stopped"),
                )),
                Ok(joined) => joined_completion(&name, joined),
                Err(_) => {
                    tracing::error!(tool = %name, "tool did not stop when cancelled at its timeout");
                    Completion::Failed(ToolError::new(
                        ToolErrorCode::Timeout,
                        format!("{name} timed out after {ms} ms and did not stop when cancelled"),
                    ))
                }
            }
        }
    }
}

pub struct Invoker {
    registry: Arc<ToolRegistry>,
    approvals: ApprovalBook,
    loop_guard: LoopGuard,
    rate: RateLimiter,
    drafts: DraftGuard,
    draft_info: Mutex<HashMap<ApprovalId, DraftInfo>>,
    idempotency: IdempotencyCache,
    policies: Mutex<HashMap<String, SessionPolicy>>,
    shared: Arc<Shared>,
    extensions: Extensions,
    resolve_lock: tokio::sync::Mutex<()>,
    approvals_changed: tokio::sync::watch::Sender<u64>,
}

impl std::fmt::Debug for Invoker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Invoker")
            .field("registry", &self.registry)
            .finish_non_exhaustive()
    }
}

fn keep_nanos(limits: LoopLimits) -> i64 {
    IdempotencyCache::TTL_NANOS.max(limits.dedup_window_nanos)
}

impl Invoker {
    pub fn new(
        registry: Arc<ToolRegistry>,
        observer: Arc<dyn ToolObserver>,
        clock: SharedClock,
        config: InvokerConfig,
    ) -> Self {
        Self {
            registry,
            approvals: ApprovalBook::new(config.staleness),
            loop_guard: LoopGuard::new(config.limits),
            rate: RateLimiter::default(),
            drafts: DraftGuard::default(),
            draft_info: Mutex::default(),
            idempotency: IdempotencyCache::default(),
            policies: Mutex::default(),
            shared: Arc::new(Shared {
                observer,
                clock,
                executions: Mutex::default(),
                inflight: Mutex::default(),
                keep_nanos: AtomicI64::new(keep_nanos(config.limits)),
            }),
            extensions: Extensions::default(),
            resolve_lock: tokio::sync::Mutex::new(()),
            approvals_changed: tokio::sync::watch::channel(0).0,
        }
    }

    pub fn approvals_changed(&self) -> tokio::sync::watch::Receiver<u64> {
        self.approvals_changed.subscribe()
    }

    fn told(&self, event: &ApprovalEvent) {
        self.shared.observer.approval(event);
        self.approvals_changed.send_modify(|n| *n += 1);
    }

    pub fn with_extensions(mut self, extensions: Extensions) -> Self {
        self.extensions = extensions;
        self
    }

    fn clock(&self) -> &SharedClock {
        &self.shared.clock
    }

    pub fn registry(&self) -> &Arc<ToolRegistry> {
        &self.registry
    }

    pub fn approvals(&self) -> &ApprovalBook {
        &self.approvals
    }

    pub fn drafts(&self) -> &DraftGuard {
        &self.drafts
    }

    pub fn live_drafts(&self) -> Vec<DraftInfo> {
        let mut v: Vec<DraftInfo> = self
            .draft_info
            .lock()
            .values()
            .filter(|d| d.is_live())
            .cloned()
            .collect();
        v.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then(a.draft_id.cmp(&b.draft_id))
        });
        v
    }

    pub fn set_policy(&self, origin: &Origin, policy: SessionPolicy) {
        self.policies.lock().insert(scope_of(origin), policy);
    }

    pub fn policy_for(&self, origin: &Origin) -> SessionPolicy {
        self.policies
            .lock()
            .get(&scope_of(origin))
            .cloned()
            .unwrap_or_default()
    }

    pub fn set_limits(&self, limits: LoopLimits) {
        self.loop_guard.set_limits(limits);
        self.shared
            .keep_nanos
            .store(keep_nanos(limits), Ordering::Relaxed);
    }

    pub fn set_staleness(&self, policy: StalenessPolicy) {
        self.approvals.set_policy(policy);
    }

    pub fn limits(&self) -> LoopLimits {
        self.loop_guard.limits()
    }

    pub fn begin_turn(&self, origin: &Origin) {
        self.loop_guard.begin_turn(&scope_of(origin));
    }

    pub fn note_step(&self, origin: &Origin) -> Result<u32, crate::guards::GuardTrip> {
        self.loop_guard.note_step(&scope_of(origin))
    }

    pub async fn invoke(&self, req: InvokeRequest) -> ToolResult {
        let started = Instant::now();
        let now = self.clock().now();
        let input = normalize_input(req.input);
        let scope = scope_of(&req.origin);
        let mut rec = ToolCallRecord {
            call_id: req.call_id.clone().unwrap_or_else(CallId::generate),
            tool: req.name.clone(),
            risk: RiskTier::Read,
            session_id: req.origin.session_id().cloned(),
            origin: req.origin.clone(),
            input_hash: hash_json(&input),
            input: redact(&input, &[]),
            status: ToolCallStatus::Running,
            started_at: now,
            finished_at: None,
            duration_ms: None,
            error: None,
            approval_id: None,
            deduped: false,
            idempotency_key: req.idempotency_key.clone(),
            summary: None,
            approved_by: None,
        };

        let Some(tool) = self.registry.get(&req.name) else {
            let err = ToolError::new(
                ToolErrorCode::UnknownTool,
                format!("unknown tool {:?}", req.name),
            );
            return self.complete(rec, started, Completion::Failed(err), false);
        };
        let meta = tool.meta().clone();
        rec.risk = meta.risk;
        rec.input = redact(&input, &meta.redact);
        let quiet = meta.quiet && req.origin.is_user();

        let mut reservation = None;
        if let Some(key) = &req.idempotency_key {
            loop {
                match self.idempotency.claim(&scope, key, now) {
                    Claim::Cached(cached) => return self.complete_cached(rec, cached, quiet).await,
                    Claim::Running(rx) => {
                        let limit = Duration::from_millis(meta.timeout_ms.saturating_add(5_000));
                        match IdempotencyCache::wait(rx, limit).await {
                            Waited::Finished(first) => {
                                return self.complete_cached(rec, *first, quiet).await;
                            }
                            Waited::GaveUp => continue,
                            Waited::StillRunning => {
                                let err = ToolError::conflict(format!(
                                    "a call with idempotency key {key:?} is still running; check \
                                     the activity log (tool.calls) for its result instead of \
                                     calling again"
                                ));
                                return self.complete(rec, started, Completion::Failed(err), quiet);
                            }
                        }
                    }
                    Claim::Reserved(r) => {
                        reservation = Some(r);
                        break;
                    }
                }
            }
        }

        if let Err(e) = refuse_late(req.deadline) {
            let result = self.complete(rec, started, Completion::Failed(e), quiet);
            if let Some(r) = reservation {
                finish_reservation(r, &result, self.clock().now());
            }
            return result;
        }

        let result = self
            .run(
                &tool,
                req.origin,
                req.surface,
                input,
                rec,
                started,
                quiet,
                &mut reservation,
            )
            .await;
        if let Some(r) = reservation {
            finish_reservation(r, &result, self.clock().now());
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn run(
        &self,
        tool: &Arc<dyn DynTool>,
        origin: Origin,
        surface: SurfaceState,
        input: Value,
        rec: ToolCallRecord,
        started: Instant,
        quiet: bool,
        reservation: &mut Option<Reservation>,
    ) -> ToolResult {
        let meta = tool.meta();
        let scope = scope_of(&origin);
        let now = rec.started_at;
        let policy = self.policy_for(&origin);
        let target = if meta.risk == RiskTier::Read {
            None
        } else {
            tool.target_json(&input).await.ok().flatten()
        };
        let decision = gate::evaluate(meta, &origin, &policy, surface, target.as_ref());
        if let GateDecision::Deny(reason) = decision {
            let err = ToolError::permission_denied(reason.message(&meta.name));
            return self.complete(rec, started, Completion::Denied(err), quiet);
        }

        if let Err(e) = tool.validate(&input) {
            return self.complete(rec, started, Completion::Failed(e), quiet);
        }

        if !origin.is_user() {
            if let Some(cached) =
                self.loop_guard
                    .dedup_lookup(&scope, &meta.name, &rec.input_hash, now)
            {
                return self.complete_cached(rec, cached, quiet).await;
            }
            if let Err(trip) = self.loop_guard.note_call(&scope) {
                let err = ToolError::new(ToolErrorCode::LoopGuard, trip.to_string());
                return self.complete(rec, started, Completion::Denied(err), quiet);
            }
        }

        if let Some(limit) = meta.rate_limit
            && let Err(trip) = self.rate.check(&meta.name, &scope, limit, started)
        {
            let err = ToolError::new(ToolErrorCode::RateLimited, trip.to_string());
            return self.complete(rec, started, Completion::Denied(err), quiet);
        }

        if !quiet {
            self.shared.observer.call_started(&rec);
        }
        let ctx = ToolCtx {
            call_id: rec.call_id.clone(),
            origin: origin.clone(),
            session_id: origin.session_id().cloned(),
            idempotency_key: rec.idempotency_key.clone(),
            approved_by: None,
            draft_id: None,
            now,
            extensions: self.extensions.clone(),
        };
        match decision {
            GateDecision::RequireApproval(kind) => {
                let completion = self.request_approval(tool, &ctx, kind, input, target).await;
                self.complete(rec, started, completion, quiet)
            }
            _ if meta.risk == RiskTier::Financial => {
                let mut reservation = reservation.take();
                if let Some(r) = reservation.as_mut() {
                    r.executing();
                }
                let task = self.spawn_financial(
                    Arc::clone(tool),
                    ctx,
                    input,
                    rec,
                    started,
                    quiet,
                    Financial {
                        reservation,
                        execution: None,
                        draft: None,
                    },
                );
                join_financial(task).await
            }
            _ => {
                let completion = execute_tool(tool, ctx, input).await;
                self.complete(rec, started, completion, quiet)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_financial(
        &self,
        tool: Arc<dyn DynTool>,
        ctx: ToolCtx,
        input: Value,
        rec: ToolCallRecord,
        started: Instant,
        quiet: bool,
        owned: Financial,
    ) -> JoinHandle<ToolResult> {
        self.shared.inflight.lock().insert(
            rec.call_id.clone(),
            InFlight {
                rec: rec.clone(),
                approval: rec.approved_by.clone(),
                draft: owned.draft.clone(),
            },
        );
        let shared = Arc::clone(&self.shared);
        tokio::spawn(async move {
            let Financial {
                reservation,
                execution,
                draft,
            } = owned;
            let completion = execute_tool(&tool, ctx, input).await;
            let result = shared.finish(rec, started, completion, quiet, draft.clone());
            if let Some(r) = reservation {
                finish_reservation(r, &result, shared.clock.now());
            }
            if let Some(e) = execution {
                e.finish(&result);
            }
            if let Some(d) = draft {
                shared.draft_executed(d, &result);
            }
            result
        })
    }

    async fn request_approval(
        &self,
        tool: &Arc<dyn DynTool>,
        ctx: &ToolCtx,
        kind: ApprovalKind,
        input: Value,
        target: Option<ActionTarget>,
    ) -> Completion {
        let meta = tool.meta();
        let key = (kind == ApprovalKind::Financial)
            .then(|| {
                target
                    .as_ref()
                    .map(|t| draft_key(&t.account, t.instrument.as_ref()))
            })
            .flatten();
        if let Some(k) = &key
            && let Err(trip) = self.drafts.check(k)
        {
            return Completion::Denied(
                ToolError::new(ToolErrorCode::LoopGuard, trip.to_string())
                    .with_details(json!({ "rule": "one_live_draft" })),
            );
        }
        let timeout = Duration::from_millis(meta.timeout_ms.max(1));
        let preview = match tokio::time::timeout(timeout, tool.preview_json(ctx, &input)).await {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => return Completion::Failed(e),
            Err(_) => {
                return Completion::Failed(ToolError::new(
                    ToolErrorCode::Timeout,
                    format!("{} preview timed out", meta.name),
                ));
            }
        };
        let draft_id = (kind == ApprovalKind::Financial).then(DraftId::generate);
        let approval = self.approvals.create(
            NewApproval {
                kind,
                origin: ctx.origin.clone(),
                call_id: ctx.call_id.clone(),
                tool: meta.name.clone(),
                risk: meta.risk,
                input,
                preview,
                draft_id: draft_id.clone(),
                environment: target.as_ref().and_then(|t| t.environment),
                instrument: target.as_ref().and_then(|t| t.instrument.clone()),
                replaces: None,
            },
            ctx.now,
        );
        if let (Some(k), Some(d)) = (key, &draft_id)
            && let Err(trip) = self.drafts.reserve(k, d.clone(), approval.id.clone())
        {
            let _ = self
                .approvals
                .finish(&approval.id, Final::Cancelled, None, None, ctx.now);
            return Completion::Denied(ToolError::new(ToolErrorCode::LoopGuard, trip.to_string()));
        }
        self.told(&ApprovalEvent::Requested {
            approval: approval.clone(),
        });
        if let (Some(d), Some(t)) = (&draft_id, &target) {
            let info = DraftInfo {
                draft_id: d.clone(),
                approval_id: approval.id.clone(),
                tool: approval.tool.clone(),
                account: t.account.clone(),
                environment: t.environment,
                instrument: t.instrument.clone(),
                preview: approval.preview.clone(),
                status: DraftStatus::Live,
                origin: approval.origin.clone(),
                created_at: approval.created_at,
                stale_at: approval.stale_at,
                error: None,
            };
            self.shared.observer.draft(&info);
            self.draft_info.lock().insert(approval.id.clone(), info);
        }
        Completion::Pending(Box::new(approval))
    }

    fn complete(
        &self,
        rec: ToolCallRecord,
        started: Instant,
        completion: Completion,
        quiet: bool,
    ) -> ToolResult {
        let origin = rec.origin.clone();
        let approved = rec.approved_by.is_some();
        let (tool, input_hash, started_at) =
            (rec.tool.clone(), rec.input_hash.clone(), rec.started_at);
        let result = self.shared.finish(rec, started, completion, quiet, None);
        if result.ok
            && result.status == ToolOutcome::Ok
            && !quiet
            && self.risk_of(&tool) != Some(RiskTier::Read)
        {
            self.loop_guard
                .forget_reads(|t| self.risk_of(t) == Some(RiskTier::Read));
        }
        let refreshes = self
            .registry
            .get(&tool)
            .map(|t| t.meta().refreshes.clone())
            .unwrap_or_default();
        if result.ok && !refreshes.is_empty() {
            self.loop_guard
                .forget_reads(|t| refreshes.iter().any(|r| r == t));
        }
        if (result.ok || outcome_unknown(&result)) && !origin.is_user() && !approved {
            self.loop_guard.dedup_store(
                &scope_of(&origin),
                &tool,
                &input_hash,
                &result,
                started_at,
            );
        }
        result
    }

    fn risk_of(&self, tool: &str) -> Option<RiskTier> {
        self.registry.get(tool).map(|t| t.meta().risk)
    }

    async fn complete_cached(
        &self,
        mut rec: ToolCallRecord,
        cached: ToolResult,
        quiet: bool,
    ) -> ToolResult {
        let (cached, approval_id, summary) = match self.approval_now(&cached).await {
            Some((result, approval)) => {
                let summary = format!(
                    "served from cache: approval {} is {}",
                    approval.id,
                    status_word(approval.status)
                );
                (result, Some(approval.id), summary)
            }
            None => (cached, None, "served from cache".to_owned()),
        };
        rec.status = cached.status.into();
        rec.deduped = true;
        rec.finished_at = Some(self.clock().now());
        rec.duration_ms = Some(0.0);
        rec.error = cached.error.clone();
        rec.approval_id = approval_id;
        rec.summary = Some(summary);
        if !quiet {
            self.shared.observer.call_finished(&rec);
        }
        ToolResult {
            call_id: rec.call_id,
            duration_ms: 0.0,
            deduped: true,
            ..cached
        }
    }

    async fn approval_now(&self, cached: &ToolResult) -> Option<(ToolResult, Approval)> {
        let mut approval = self.approvals.get(&cached.approval.as_ref()?.approval_id)?;
        for _ in 0..32 {
            match (&approval.status, &approval.replaced_by) {
                (ApprovalStatus::Superseded, Some(next)) => match self.approvals.get(next) {
                    Some(a) => approval = a,
                    None => break,
                },
                _ => break,
            }
        }
        if approval.status == ApprovalStatus::Pending
            && ApprovalBook::is_stale(&approval, self.clock().now())
        {
            self.expire_stale();
            approval = self.approvals.get(&approval.id).unwrap_or(approval);
        }
        let details = json!({
            "approvalId": approval.id,
            "draftId": approval.draft_id,
            "approvalStatus": approval.status,
        });
        let refused = |status: ToolOutcome, error: ToolError| ToolResult {
            ok: false,
            status,
            output: None,
            error: Some(error.with_details(details.clone()).to_info()),
            approval: None,
            ..cached.clone()
        };
        let result = match approval.status {
            ApprovalStatus::Pending => {
                let (stub, pending) = pending_parts(&approval, self.clock().now());
                ToolResult {
                    ok: true,
                    status: ToolOutcome::PendingApproval,
                    output: Some(stub),
                    error: None,
                    approval: Some(pending),
                    ..cached.clone()
                }
            }
            ApprovalStatus::Approved => match self.execution(&approval).await {
                Executed::Finished(executed) => ToolResult {
                    ok: executed.ok,
                    status: executed.status,
                    output: executed.output,
                    error: executed.error.map(|e| with_approval_details(e, &details)),
                    approval: None,
                    ..cached.clone()
                },
                Executed::StillRunning(waited) => refused(
                    ToolOutcome::Error,
                    ToolError::new(
                        ToolErrorCode::Timeout,
                        format!(
                            "the user approved this request (approval {}); its execution was still \
                             running after {} ms. Check the activity log (tool.calls) for its result \
                             instead of calling again",
                            approval.id,
                            waited.as_millis()
                        ),
                    ),
                ),
                Executed::Unknown => refused(
                    ToolOutcome::Error,
                    ToolError::new(
                        ToolErrorCode::Unavailable,
                        format!(
                            "the user approved this request (approval {}), but its result is no \
                             longer known here; check the activity log (tool.calls) before trying \
                             again",
                            approval.id
                        ),
                    ),
                ),
            },
            ApprovalStatus::Rejected => refused(
                ToolOutcome::Denied,
                ToolError::permission_denied(format!(
                    "the user rejected this request (approval {}); nothing was executed",
                    approval.id
                )),
            ),
            ApprovalStatus::Stale | ApprovalStatus::Cancelled | ApprovalStatus::Superseded => {
                refused(
                    ToolOutcome::Error,
                    ToolError::new(
                        ToolErrorCode::Stale,
                        format!(
                            "approval {} is {} without a decision; nothing was executed",
                            approval.id,
                            status_word(approval.status)
                        ),
                    ),
                )
            }
        };
        Some((result, approval))
    }

    async fn execution(&self, approval: &Approval) -> Executed {
        let Some(mut rx) = self
            .shared
            .executions
            .lock()
            .get(&approval.id)
            .map(|e| e.result.subscribe())
        else {
            return Executed::Unknown;
        };
        let timeout_ms = self
            .registry
            .get(&approval.tool)
            .map_or(0, |t| t.meta().timeout_ms);
        let wait = Duration::from_millis(timeout_ms.saturating_add(1_000));
        match tokio::time::timeout(wait, rx.wait_for(Option::is_some)).await {
            Ok(Ok(result)) => result.clone().map_or(Executed::Unknown, Executed::Finished),
            Ok(Err(_closed)) => Executed::Unknown,
            Err(_elapsed) => Executed::StillRunning(wait),
        }
    }

    fn begin_execution(&self, approval: &ApprovalId) -> ExecutionGuard {
        let (result, _) = watch::channel(None);
        self.shared.executions.lock().insert(
            approval.clone(),
            Execution {
                result,
                finished_at: None,
            },
        );
        ExecutionGuard {
            shared: Arc::clone(&self.shared),
            approval: approval.clone(),
            finished: false,
        }
    }

    pub async fn resolve(
        &self,
        params: &ApprovalsResolveParams,
        resolver: &Origin,
    ) -> Result<ApprovalsResolveResult, ResolveError> {
        let _serial = self.resolve_lock.lock().await;
        let now = self.clock().now();
        let approval = match self.approvals.check(
            &params.approval_id,
            params.decision,
            &params.preview_hash,
            resolver,
            now,
        ) {
            Ok(a) => a,
            Err(ApprovalError::Stale) => {
                if let Some(a) = self.approvals.get(&params.approval_id) {
                    self.after_terminal(
                        &a,
                        ApprovalEvent::Stale {
                            approval: a.clone(),
                        },
                    );
                }
                return Err(ResolveError::Approval(ApprovalError::Stale));
            }
            Err(e) => return Err(e.into()),
        };

        match params.decision {
            ApprovalDecision::Reject => {
                let done = self.approvals.finish(
                    &approval.id,
                    Final::Rejected,
                    Some(ApprovalDecision::Reject),
                    params.note.clone(),
                    now,
                )?;
                self.after_terminal(
                    &done,
                    ApprovalEvent::Resolved {
                        approval: done.clone(),
                    },
                );
                Ok(ApprovalsResolveResult {
                    approval: done,
                    result: None,
                    replacement: None,
                })
            }
            ApprovalDecision::Approve => {
                if let Err(e) = refuse_late(params.deadline) {
                    return Err(ResolveError::NotReady(e));
                }
                let approval = match &params.input {
                    Some(input) => {
                        let input = normalize_input(input.clone());
                        self.registry
                            .get(&approval.tool)
                            .ok_or_else(|| ResolveError::UnknownTool(approval.tool.clone()))?
                            .validate(&input)
                            .map_err(ResolveError::InvalidInput)?;
                        self.ready(&approval, &input, now).await?;
                        let (old, replacement, target) = self
                            .replace(approval, input, params.note.clone(), now)
                            .await?;
                        self.told(&ApprovalEvent::Resolved {
                            approval: old.clone(),
                        });
                        self.hand_over_draft(&old.id, &replacement, target.as_ref());
                        replacement
                    }
                    None => {
                        self.ready(&approval, &approval.input, now).await?;
                        approval
                    }
                };
                let execution = self.begin_execution(&approval.id);
                let done = match self.approvals.finish(
                    &approval.id,
                    Final::Approved,
                    Some(ApprovalDecision::Approve),
                    params.note.clone(),
                    now,
                ) {
                    Ok(done) => done,
                    Err(e) => {
                        execution.abandon();
                        return Err(e.into());
                    }
                };
                let draft = self.after_terminal(
                    &done,
                    ApprovalEvent::Resolved {
                        approval: done.clone(),
                    },
                );
                let result = self
                    .execute_approved(&done, execution, draft, params.idempotency_key.clone())
                    .await;
                Ok(ApprovalsResolveResult {
                    approval: done,
                    result: Some(result),
                    replacement: None,
                })
            }
            ApprovalDecision::Edit => self.edit(approval, params, now).await,
        }
    }

    async fn ready(
        &self,
        approval: &Approval,
        input: &Value,
        now: tessera_core::Timestamp,
    ) -> Result<(), ResolveError> {
        let Some(tool) = self.registry.get(&approval.tool) else {
            return Ok(());
        };
        let ctx = ToolCtx {
            call_id: approval.call_id.clone(),
            origin: approval.origin.clone(),
            session_id: approval.session_id.clone(),
            idempotency_key: None,
            approved_by: Some(approval.id.clone()),
            draft_id: approval.draft_id.clone(),
            now,
            extensions: self.extensions.clone(),
        };
        tool.ready_json(&ctx, input)
            .await
            .map_err(ResolveError::NotReady)
    }

    async fn edit(
        &self,
        approval: Approval,
        params: &ApprovalsResolveParams,
        now: tessera_core::Timestamp,
    ) -> Result<ApprovalsResolveResult, ResolveError> {
        let new_input = normalize_input(
            params
                .input
                .clone()
                .ok_or(ResolveError::Approval(ApprovalError::MissingEditInput))?,
        );
        let (old, replacement, target) = self
            .replace(approval, new_input, params.note.clone(), now)
            .await?;
        self.told(&ApprovalEvent::Resolved {
            approval: old.clone(),
        });
        self.told(&ApprovalEvent::Requested {
            approval: replacement.clone(),
        });
        self.hand_over_draft(&old.id, &replacement, target.as_ref());
        Ok(ApprovalsResolveResult {
            approval: old,
            result: None,
            replacement: Some(replacement),
        })
    }

    async fn replace(
        &self,
        approval: Approval,
        new_input: Value,
        note: Option<String>,
        now: tessera_core::Timestamp,
    ) -> Result<(Approval, Approval, Option<ActionTarget>), ResolveError> {
        let tool = self
            .registry
            .get(&approval.tool)
            .ok_or_else(|| ResolveError::UnknownTool(approval.tool.clone()))?;
        tool.validate(&new_input)
            .map_err(ResolveError::InvalidInput)?;
        let ctx = ToolCtx {
            call_id: approval.call_id.clone(),
            origin: approval.origin.clone(),
            session_id: approval.session_id.clone(),
            idempotency_key: None,
            approved_by: None,
            draft_id: approval.draft_id.clone(),
            now,
            extensions: self.extensions.clone(),
        };
        let target = tool.target_json(&new_input).await.ok().flatten();
        let preview = tool
            .preview_json(&ctx, &new_input)
            .await
            .map_err(ResolveError::InvalidInput)?;
        let replacement_id = ApprovalId::generate();
        let financial = approval.kind == ApprovalKind::Financial;
        if financial && let (Some(t), Some(d)) = (&target, &approval.draft_id) {
            self.drafts
                .transfer(
                    &approval.id,
                    draft_key(&t.account, t.instrument.as_ref()),
                    d.clone(),
                    replacement_id.clone(),
                )
                .map_err(|trip| ResolveError::Conflict(trip.to_string()))?;
        }
        let request = NewApproval {
            kind: approval.kind,
            origin: approval.origin.clone(),
            call_id: approval.call_id.clone(),
            tool: approval.tool.clone(),
            risk: approval.risk,
            input: new_input,
            preview,
            draft_id: approval.draft_id.clone(),
            environment: target
                .as_ref()
                .and_then(|t| t.environment)
                .or(approval.environment),
            instrument: target
                .as_ref()
                .and_then(|t| t.instrument.clone())
                .or_else(|| approval.instrument.clone()),
            replaces: Some(approval.id.clone()),
        };
        let superseded = self.approvals.supersede(
            &approval.id,
            replacement_id.clone(),
            request,
            note,
            self.clock().now(),
        );
        let (old, replacement) = match superseded {
            Ok(pair) => pair,
            Err(e) => {
                self.drafts.release_approval(&replacement_id);
                if e == ApprovalError::Stale
                    && let Some(a) = self.approvals.get(&approval.id)
                {
                    self.after_terminal(
                        &a,
                        ApprovalEvent::Stale {
                            approval: a.clone(),
                        },
                    );
                }
                return Err(e.into());
            }
        };
        if financial && (target.is_none() || approval.draft_id.is_none()) {
            self.drafts.release_approval(&approval.id);
        }
        Ok((old, replacement, target))
    }

    fn hand_over_draft(
        &self,
        old: &ApprovalId,
        replacement: &Approval,
        target: Option<&ActionTarget>,
    ) {
        let info = self.draft_info.lock().remove(old);
        if let Some(mut info) = info {
            info.approval_id = replacement.id.clone();
            info.preview = replacement.preview.clone();
            info.stale_at = replacement.stale_at;
            if let Some(t) = target {
                info.account = t.account.clone();
                info.environment = t.environment.or(info.environment);
                info.instrument = t.instrument.clone();
            }
            self.shared.observer.draft(&info);
            self.draft_info.lock().insert(replacement.id.clone(), info);
        }
    }

    async fn execute_approved(
        &self,
        approval: &Approval,
        execution: ExecutionGuard,
        draft: Option<DraftInfo>,
        idempotency_key: Option<String>,
    ) -> ToolResult {
        let started = Instant::now();
        let now = self.clock().now();
        let mut rec = ToolCallRecord {
            call_id: CallId::generate(),
            tool: approval.tool.clone(),
            risk: approval.risk,
            origin: approval.origin.clone(),
            session_id: approval.session_id.clone(),
            input_hash: hash_json(&approval.input),
            input: redact(&approval.input, &[]),
            status: ToolCallStatus::Running,
            started_at: now,
            finished_at: None,
            duration_ms: None,
            error: None,
            approval_id: Some(approval.id.clone()),
            deduped: false,
            idempotency_key: idempotency_key.clone(),
            summary: None,
            approved_by: Some(approval.id.clone()),
        };
        let Some(tool) = self.registry.get(&approval.tool) else {
            let err = ToolError::new(
                ToolErrorCode::UnknownTool,
                format!("tool {} is no longer registered", approval.tool),
            );
            let result = self.complete(rec, started, Completion::Failed(err), false);
            execution.finish(&result);
            if let Some(d) = draft {
                self.shared.draft_executed(d, &result);
            }
            return result;
        };
        rec.input = redact(&approval.input, &tool.meta().redact);
        let mut reservation = None;
        if let Some(key) = &idempotency_key {
            let scope = scope_of(&Origin::User);
            loop {
                match self.idempotency.claim(&scope, key, now) {
                    Claim::Cached(cached) => {
                        let result = self.complete_cached(rec, cached, false).await;
                        execution.finish(&result);
                        if let Some(d) = draft {
                            self.shared.draft_executed(d, &result);
                        }
                        return result;
                    }
                    Claim::Running(rx) => {
                        let limit =
                            Duration::from_millis(tool.meta().timeout_ms.saturating_add(5_000));
                        match IdempotencyCache::wait(rx, limit).await {
                            Waited::Finished(first) => {
                                let result = self.complete_cached(rec, *first, false).await;
                                execution.finish(&result);
                                if let Some(d) = draft {
                                    self.shared.draft_executed(d, &result);
                                }
                                return result;
                            }
                            Waited::GaveUp => continue,
                            Waited::StillRunning => {
                                let err = ToolError::conflict(format!(
                                    "a call with idempotency key {key:?} is still running; check \
                                     the activity log (tool.calls) for its result instead of \
                                     calling again"
                                ));
                                let result =
                                    self.complete(rec, started, Completion::Failed(err), false);
                                execution.finish(&result);
                                if let Some(d) = draft {
                                    self.shared.draft_executed(d, &result);
                                }
                                return result;
                            }
                        }
                    }
                    Claim::Reserved(r) => {
                        reservation = Some(r);
                        break;
                    }
                }
            }
        }
        self.shared.observer.call_started(&rec);
        let ctx = ToolCtx {
            call_id: rec.call_id.clone(),
            origin: approval.origin.clone(),
            session_id: approval.session_id.clone(),
            idempotency_key,
            approved_by: Some(approval.id.clone()),
            draft_id: approval.draft_id.clone(),
            now,
            extensions: self.extensions.clone(),
        };
        if tool.meta().risk == RiskTier::Financial {
            let task = self.spawn_financial(
                tool,
                ctx,
                approval.input.clone(),
                rec,
                started,
                false,
                Financial {
                    reservation,
                    execution: Some(execution),
                    draft,
                },
            );
            return join_financial(task).await;
        }
        let completion = execute_tool(&tool, ctx, approval.input.clone()).await;
        let result = self.complete(rec, started, completion, false);
        if let Some(r) = reservation {
            finish_reservation(r, &result, self.clock().now());
        }
        execution.finish(&result);
        if let Some(d) = draft {
            self.shared.draft_executed(d, &result);
        }
        result
    }

    fn after_terminal(&self, approval: &Approval, event: ApprovalEvent) -> Option<DraftInfo> {
        self.drafts.release_approval(&approval.id);
        self.told(&event);
        let mut info = self.draft_info.lock().remove(&approval.id)?;
        info.status = match approval.status {
            ApprovalStatus::Pending | ApprovalStatus::Superseded | ApprovalStatus::Cancelled => {
                DraftStatus::Cancelled
            }
            ApprovalStatus::Approved => DraftStatus::Approved,
            ApprovalStatus::Rejected => DraftStatus::Rejected,
            ApprovalStatus::Stale => DraftStatus::Stale,
        };
        self.shared.observer.draft(&info);
        Some(info)
    }

    pub fn expire_stale(&self) -> Vec<Approval> {
        let stale = self.approvals.expire(self.clock().now());
        for a in &stale {
            self.after_terminal(
                a,
                ApprovalEvent::Stale {
                    approval: a.clone(),
                },
            );
        }
        stale
    }

    pub fn observe_ticks(&self, instrument: &InstrumentId, ticks: u32) -> Vec<Approval> {
        let stale = self
            .approvals
            .observe_ticks(instrument, ticks, self.clock().now());
        for a in &stale {
            self.after_terminal(
                a,
                ApprovalEvent::Stale {
                    approval: a.clone(),
                },
            );
        }
        stale
    }

    pub fn tick_watched_instruments(&self) -> Vec<InstrumentId> {
        let mut v: Vec<InstrumentId> = self
            .approvals
            .pending()
            .into_iter()
            .filter(|a| a.max_ticks.is_some())
            .filter_map(|a| a.instrument)
            .collect();
        v.sort();
        v.dedup();
        v
    }

    pub fn close(&self, origin: &Origin) -> Vec<Approval> {
        let cancelled = self.approvals.cancel_of(origin);
        for a in &cancelled {
            self.after_terminal(
                a,
                ApprovalEvent::Resolved {
                    approval: a.clone(),
                },
            );
        }
        let scope = scope_of(origin);
        self.loop_guard.drop_scope(&scope);
        self.policies.lock().remove(&scope);
        cancelled
    }

    pub fn shutdown(&self) -> Vec<ToolCallRecord> {
        let now = self.clock().now();
        let inflight: Vec<InFlight> = self
            .shared
            .inflight
            .lock()
            .drain()
            .map(|(_, f)| f)
            .collect();
        let mut finished = Vec::with_capacity(inflight.len());
        for f in inflight {
            let mut rec = f.rec;
            let err = ToolError::outcome_unknown(format!(
                "the runtime stopped while {} was running; its outcome is unknown: check orders \
                 before trying again",
                rec.tool
            ))
            .with_details(json!({ "outcome": "unknown", "reason": "shutdown" }));
            rec.status = ToolCallStatus::Error;
            rec.error = Some(err.to_info());
            rec.finished_at = Some(now);
            rec.summary = Some("interrupted when the runtime stopped".to_owned());
            tracing::warn!(tool = %rec.tool, call = %rec.call_id, "financial call interrupted by shutdown; outcome unknown");
            self.shared.observer.call_finished(&rec);
            let result = ToolResult {
                call_id: rec.call_id.clone(),
                ..unknown_result(err)
            };
            if let Some(a) = &f.approval {
                self.shared.record_execution(a, &result);
            }
            if let Some(d) = f.draft {
                self.shared.draft_executed(d, &result);
            }
            finished.push(rec);
        }
        finished
    }
}

async fn join_financial(task: JoinHandle<ToolResult>) -> ToolResult {
    match task.await {
        Ok(result) => result,
        Err(join) => {
            tracing::error!(error = %join, "financial execution task ended without a result");
            unknown_result(ToolError::outcome_unknown(
                "the call was interrupted before its result was recorded; its outcome is unknown: \
                 check orders and the activity log (tool.calls) before trying again",
            ))
        }
    }
}

fn waiting_words(a: &Approval, now: Timestamp) -> String {
    let until = a.stale_at.to_datetime().format("%Y-%m-%dT%H:%M:%SZ");
    let left = a.stale_at.0.saturating_sub(now.0).max(0);
    let secs = (left + NANOS_PER_SEC - 1) / NANOS_PER_SEC;
    let trades = match (a.max_ticks, &a.instrument) {
        (Some(max), Some(instrument)) => format!(
            ", or until {} more trades on {instrument}, whichever comes first",
            max.saturating_sub(a.ticks_seen)
        ),
        _ => String::new(),
    };
    format!(
        "Drafted, not sent: it waits for the user's approval in Tessera until {until} ({secs} s from now){trades}. \
         If they have not approved it by then, it expires and nothing is sent."
    )
}

fn pending_parts(a: &Approval, now: Timestamp) -> (Value, PendingApproval) {
    let stub = json!({
        "status": "pending_approval",
        "approvalId": a.id,
        "draftId": a.draft_id,
        "previewHash": a.preview_hash,
        "staleAt": a.stale_at,
        "message": waiting_words(a, now),
    });
    let pending = PendingApproval {
        approval_id: a.id.clone(),
        draft_id: a.draft_id.clone(),
        preview_hash: a.preview_hash.clone(),
        stale_at: a.stale_at,
    };
    (stub, pending)
}

fn with_approval_details(mut error: ToolErrorInfo, approval: &Value) -> ToolErrorInfo {
    let mut details = match error.details.take() {
        Some(Value::Object(own)) => own,
        Some(other) => serde_json::Map::from_iter([("toolDetails".to_owned(), other)]),
        None => serde_json::Map::new(),
    };
    if let Value::Object(ids) = approval {
        details.extend(ids.clone());
    }
    error.details = Some(Value::Object(details));
    error
}

fn outcome_unknown(result: &ToolResult) -> bool {
    result
        .error
        .as_ref()
        .is_some_and(|e| e.code == ToolErrorCode::OutcomeUnknown)
}

fn status_word(status: ApprovalStatus) -> &'static str {
    match status {
        ApprovalStatus::Pending => "pending",
        ApprovalStatus::Approved => "approved",
        ApprovalStatus::Rejected => "rejected",
        ApprovalStatus::Stale => "stale",
        ApprovalStatus::Superseded => "superseded",
        ApprovalStatus::Cancelled => "cancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::MemoryObserver;
    use tessera_core::clock::ManualClock;
    use tessera_core::time::NANOS_PER_SEC;

    fn ok_result() -> ToolResult {
        ToolResult {
            ok: true,
            status: ToolOutcome::Ok,
            call_id: CallId::generate(),
            duration_ms: 1.0,
            output: Some(json!({ "done": true })),
            error: None,
            approval: None,
            deduped: false,
        }
    }

    #[test]
    fn execution_results_are_kept_as_long_as_a_cache_can_point_at_them() {
        let clock = Arc::new(ManualClock::new(Timestamp::from_secs(1_790_000_000)));
        let inv = Invoker::new(
            Arc::new(ToolRegistry::new()),
            Arc::new(MemoryObserver::default()),
            clock.clone(),
            InvokerConfig::default(),
        );
        let (old, running, recent) = (
            ApprovalId::generate(),
            ApprovalId::generate(),
            ApprovalId::generate(),
        );
        inv.begin_execution(&old).finish(&ok_result());
        let still_running = inv.begin_execution(&running);
        clock.advance(IdempotencyCache::TTL_NANOS);
        inv.begin_execution(&recent).finish(&ok_result());
        assert_eq!(inv.shared.executions.lock().len(), 3);
        clock.advance(NANOS_PER_SEC);
        inv.begin_execution(&ApprovalId::generate())
            .finish(&ok_result());
        let kept = inv.shared.executions.lock();
        assert!(!kept.contains_key(&old));
        assert!(kept.contains_key(&running) && kept.contains_key(&recent));
        drop(kept);
        drop(still_running);
        let interrupted = inv.shared.executions.lock()[&running]
            .result
            .borrow()
            .clone()
            .unwrap();
        assert!(!interrupted.ok);
        let err = interrupted.error.unwrap();
        assert_eq!(err.code, ToolErrorCode::OutcomeUnknown);
        assert!(
            !err.retryable,
            "an unknown outcome is never retried blindly"
        );
    }

    #[test]
    fn a_deadline_in_the_past_is_late_and_an_open_one_is_not() {
        let late = refuse_late(Some(Timestamp::from_secs(1))).unwrap_err();
        assert_eq!(late.code, ToolErrorCode::Rejected);
        assert_eq!(late.message, LATE_ORDER);
        let details = late.details.unwrap();
        assert_eq!(details["outcome"], "late");
        assert_eq!(details["sent"], false);
        assert!(refuse_late(Some(Timestamp::now().add_nanos(60 * NANOS_PER_SEC))).is_ok());
        assert!(refuse_late(None).is_ok());
    }
}
