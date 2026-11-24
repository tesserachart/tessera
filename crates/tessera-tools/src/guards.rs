use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use tessera_core::ids::{ApprovalId, CallId, DraftId};
use tessera_core::time::{NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Origin, Timestamp};
use tessera_protocol::tools::{ToolErrorCode, ToolErrorInfo, ToolOutcome, ToolResult};
use tokio::sync::watch;

use crate::meta::RateLimit;

pub fn scope_of(origin: &Origin) -> String {
    match origin {
        Origin::User => "user".to_owned(),
        Origin::Agent { session_id, .. } => format!("agent:{session_id}"),
        Origin::External { client_id } => format!("external:{client_id}"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoopLimits {
    pub max_steps_per_turn: u32,
    pub max_tool_calls_per_turn: u32,
    pub dedup_window_nanos: i64,
}

impl Default for LoopLimits {
    fn default() -> Self {
        Self {
            max_steps_per_turn: 20,
            max_tool_calls_per_turn: 40,
            dedup_window_nanos: 10 * NANOS_PER_SEC,
        }
    }
}

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum GuardTrip {
    #[error("step limit reached: {0} steps per turn")]
    Steps(u32),
    #[error("tool-call limit reached: {0} calls per turn")]
    Calls(u32),
    #[error("rate limit for {tool}: {per_second}/s")]
    RateLimited { tool: String, per_second: f64 },
    #[error("a live draft {draft_id} already exists for {account} {instrument}; resolve it first")]
    LiveDraft {
        account: String,
        instrument: String,
        draft_id: DraftId,
        approval_id: ApprovalId,
    },
}

#[derive(Debug, Default)]
struct ScopeState {
    steps: u32,
    calls: u32,
    recent: HashMap<(String, String), (Timestamp, ToolResult)>,
}

#[derive(Debug, Default)]
pub struct LoopGuard {
    limits: Mutex<LoopLimits>,
    scopes: Mutex<HashMap<String, ScopeState>>,
}

impl LoopGuard {
    pub fn new(limits: LoopLimits) -> Self {
        Self {
            limits: Mutex::new(limits),
            scopes: Mutex::default(),
        }
    }

    pub fn limits(&self) -> LoopLimits {
        *self.limits.lock()
    }

    pub fn set_limits(&self, limits: LoopLimits) {
        *self.limits.lock() = limits;
    }

    pub fn begin_turn(&self, scope: &str) {
        let mut scopes = self.scopes.lock();
        let s = scopes.entry(scope.to_owned()).or_default();
        s.steps = 0;
        s.calls = 0;
    }

    pub fn note_step(&self, scope: &str) -> Result<u32, GuardTrip> {
        let max = self.limits().max_steps_per_turn;
        let mut scopes = self.scopes.lock();
        let s = scopes.entry(scope.to_owned()).or_default();
        if s.steps >= max {
            return Err(GuardTrip::Steps(max));
        }
        s.steps += 1;
        Ok(s.steps)
    }

    pub fn note_call(&self, scope: &str) -> Result<u32, GuardTrip> {
        let max = self.limits().max_tool_calls_per_turn;
        let mut scopes = self.scopes.lock();
        let s = scopes.entry(scope.to_owned()).or_default();
        if s.calls >= max {
            return Err(GuardTrip::Calls(max));
        }
        s.calls += 1;
        Ok(s.calls)
    }

    pub fn dedup_lookup(
        &self,
        scope: &str,
        tool: &str,
        input_hash: &str,
        now: Timestamp,
    ) -> Option<ToolResult> {
        let window = self.limits().dedup_window_nanos;
        let mut scopes = self.scopes.lock();
        let s = scopes.get_mut(scope)?;
        s.recent.retain(|_, (at, _)| now.0 - at.0 < window);
        s.recent
            .get(&(tool.to_owned(), input_hash.to_owned()))
            .map(|(_, r)| r.clone())
    }

    pub fn dedup_store(
        &self,
        scope: &str,
        tool: &str,
        input_hash: &str,
        result: &ToolResult,
        now: Timestamp,
    ) {
        let mut scopes = self.scopes.lock();
        scopes.entry(scope.to_owned()).or_default().recent.insert(
            (tool.to_owned(), input_hash.to_owned()),
            (now, result.clone()),
        );
    }

    pub fn forget_reads(&self, is_read: impl Fn(&str) -> bool) {
        for s in self.scopes.lock().values_mut() {
            s.recent.retain(|(tool, _), _| !is_read(tool));
        }
    }

    pub fn drop_scope(&self, scope: &str) {
        self.scopes.lock().remove(scope);
    }
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

#[derive(Debug, Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<(String, String), Bucket>>,
}

impl RateLimiter {
    pub fn check(
        &self,
        tool: &str,
        scope: &str,
        limit: RateLimit,
        at: Instant,
    ) -> Result<(), GuardTrip> {
        let mut buckets = self.buckets.lock();
        let b = buckets
            .entry((tool.to_owned(), scope.to_owned()))
            .or_insert(Bucket {
                tokens: f64::from(limit.burst),
                last: at,
            });
        let elapsed = at.saturating_duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * limit.per_second).min(f64::from(limit.burst));
        b.last = at;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            Ok(())
        } else {
            Err(GuardTrip::RateLimited {
                tool: tool.to_owned(),
                per_second: limit.per_second,
            })
        }
    }
}

pub type DraftKey = (String, String);

pub fn draft_key(account: &str, instrument: Option<&InstrumentId>) -> DraftKey {
    (
        account.to_owned(),
        instrument.map_or_else(|| "*".to_owned(), |i| i.to_string()),
    )
}

#[derive(Debug, Default)]
pub struct DraftGuard {
    live: Mutex<HashMap<DraftKey, (DraftId, ApprovalId)>>,
}

impl DraftGuard {
    pub fn reserve(
        &self,
        key: DraftKey,
        draft: DraftId,
        approval: ApprovalId,
    ) -> Result<(), GuardTrip> {
        let mut live = self.live.lock();
        if let Some((d, a)) = live.get(&key) {
            return Err(GuardTrip::LiveDraft {
                account: key.0,
                instrument: key.1,
                draft_id: d.clone(),
                approval_id: a.clone(),
            });
        }
        live.insert(key, (draft, approval));
        Ok(())
    }

    pub fn check(&self, key: &DraftKey) -> Result<(), GuardTrip> {
        match self.live.lock().get(key) {
            Some((d, a)) => Err(GuardTrip::LiveDraft {
                account: key.0.clone(),
                instrument: key.1.clone(),
                draft_id: d.clone(),
                approval_id: a.clone(),
            }),
            None => Ok(()),
        }
    }

    pub fn transfer(
        &self,
        from: &ApprovalId,
        key: DraftKey,
        draft: DraftId,
        to: ApprovalId,
    ) -> Result<(), GuardTrip> {
        let mut live = self.live.lock();
        if let Some((d, a)) = live.get(&key)
            && a != from
        {
            return Err(GuardTrip::LiveDraft {
                account: key.0,
                instrument: key.1,
                draft_id: d.clone(),
                approval_id: a.clone(),
            });
        }
        live.retain(|_, (_, a)| a != from);
        live.insert(key, (draft, to));
        Ok(())
    }

    pub fn release_approval(&self, approval: &ApprovalId) {
        self.live.lock().retain(|_, (_, a)| a != approval);
    }

    pub fn len(&self) -> usize {
        self.live.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.live.lock().is_empty()
    }
}

#[derive(Debug)]
enum Slot {
    Running(watch::Receiver<Option<ToolResult>>),
    Done(Timestamp, Box<ToolResult>),
}

#[derive(Debug, PartialEq)]
pub enum Waited {
    Finished(Box<ToolResult>),
    GaveUp,
    StillRunning,
}

#[derive(Debug)]
pub enum Claim {
    Cached(ToolResult),
    Running(watch::Receiver<Option<ToolResult>>),
    Reserved(Reservation),
}

type Entries = Arc<Mutex<HashMap<(String, String), Slot>>>;

#[derive(Debug, Default)]
pub struct IdempotencyCache {
    entries: Entries,
}

impl IdempotencyCache {
    pub const TTL_NANOS: i64 = 10 * NANOS_PER_MINUTE;

    fn expire(entries: &mut HashMap<(String, String), Slot>, now: Timestamp) {
        entries.retain(|_, slot| match slot {
            Slot::Running(_) => true,
            Slot::Done(at, _) => now.0 - at.0 < Self::TTL_NANOS,
        });
    }

    pub fn claim(&self, scope: &str, key: &str, now: Timestamp) -> Claim {
        let mut entries = self.entries.lock();
        Self::expire(&mut entries, now);
        let k = (scope.to_owned(), key.to_owned());
        match entries.get(&k) {
            Some(Slot::Done(_, r)) => return Claim::Cached(r.as_ref().clone()),
            Some(Slot::Running(rx)) => return Claim::Running(rx.clone()),
            None => {}
        }
        let (tx, rx) = watch::channel(None);
        entries.insert(k.clone(), Slot::Running(rx));
        Claim::Reserved(Reservation {
            entries: Arc::clone(&self.entries),
            key: k,
            tx,
            at: now,
            executing: false,
            done: false,
        })
    }

    pub async fn wait(
        mut rx: watch::Receiver<Option<ToolResult>>,
        limit: std::time::Duration,
    ) -> Waited {
        match tokio::time::timeout(limit, rx.wait_for(Option::is_some)).await {
            Ok(Ok(r)) => r
                .clone()
                .map_or(Waited::GaveUp, |r| Waited::Finished(Box::new(r))),
            Ok(Err(_closed)) => Waited::GaveUp,
            Err(_elapsed) => Waited::StillRunning,
        }
    }

    pub fn get(&self, scope: &str, key: &str, now: Timestamp) -> Option<ToolResult> {
        let mut entries = self.entries.lock();
        Self::expire(&mut entries, now);
        match entries.get(&(scope.to_owned(), key.to_owned())) {
            Some(Slot::Done(_, r)) => Some(r.as_ref().clone()),
            _ => None,
        }
    }

    pub fn put(&self, scope: &str, key: &str, result: &ToolResult, now: Timestamp) {
        self.entries.lock().insert(
            (scope.to_owned(), key.to_owned()),
            Slot::Done(now, Box::new(result.clone())),
        );
    }
}

#[derive(Debug)]
pub struct Reservation {
    entries: Entries,
    key: (String, String),
    tx: watch::Sender<Option<ToolResult>>,
    at: Timestamp,
    executing: bool,
    done: bool,
}

impl Reservation {
    pub fn executing(&mut self) {
        self.executing = true;
    }

    pub fn finish(mut self, result: &ToolResult, store: bool, now: Timestamp) {
        self.done = true;
        {
            let mut entries = self.entries.lock();
            if store {
                entries.insert(self.key.clone(), Slot::Done(now, Box::new(result.clone())));
            } else {
                entries.remove(&self.key);
            }
        }
        self.tx.send_replace(Some(result.clone()));
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let mut entries = self.entries.lock();
        if self.executing {
            let error = ToolErrorInfo {
                code: ToolErrorCode::OutcomeUnknown,
                message:
                    "the call holding this idempotency key was interrupted while it executed; \
                          its outcome is unknown: check orders and the activity log (tool.calls) \
                          before trying again"
                        .to_owned(),
                details: Some(serde_json::json!({ "outcome": "unknown" })),
                retryable: false,
            };
            let result = ToolResult {
                ok: false,
                status: ToolOutcome::Error,
                call_id: CallId::generate(),
                duration_ms: 0.0,
                output: None,
                error: Some(error),
                approval: None,
                deduped: false,
            };
            entries.insert(
                self.key.clone(),
                Slot::Done(self.at, Box::new(result.clone())),
            );
            drop(entries);
            self.tx.send_replace(Some(result));
        } else {
            entries.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::ids::{CallId, SessionId};
    use tessera_protocol::tools::ToolOutcome;

    fn result() -> ToolResult {
        ToolResult {
            ok: true,
            status: ToolOutcome::Ok,
            call_id: CallId::new("call_1"),
            duration_ms: 1.0,
            output: Some(serde_json::json!(1)),
            error: None,
            approval: None,
            deduped: false,
        }
    }

    #[test]
    fn scopes() {
        assert_eq!(scope_of(&Origin::User), "user");
        assert_eq!(
            scope_of(&Origin::Agent {
                session_id: SessionId::new("S1"),
                provider: "codex".into()
            }),
            "agent:S1"
        );
        assert_eq!(
            scope_of(&Origin::External {
                client_id: "c".into()
            }),
            "external:c"
        );
    }

    #[test]
    fn steps_and_calls_cap_per_turn() {
        let g = LoopGuard::new(LoopLimits {
            max_steps_per_turn: 2,
            max_tool_calls_per_turn: 3,
            ..LoopLimits::default()
        });
        assert_eq!(g.note_step("agent:S1"), Ok(1));
        assert_eq!(g.note_step("agent:S1"), Ok(2));
        assert_eq!(g.note_step("agent:S1"), Err(GuardTrip::Steps(2)));
        for i in 1..=3 {
            assert_eq!(g.note_call("agent:S1"), Ok(i));
        }
        assert_eq!(g.note_call("agent:S1"), Err(GuardTrip::Calls(3)));
        assert_eq!(g.note_call("agent:S2"), Ok(1), "scopes are independent");
        g.begin_turn("agent:S1");
        assert_eq!(g.note_call("agent:S1"), Ok(1));
        assert_eq!(g.note_step("agent:S1"), Ok(1));
    }

    #[test]
    fn dedup_window() {
        let g = LoopGuard::default();
        let t0 = Timestamp::from_secs(100);
        assert!(
            g.dedup_lookup("agent:S1", "market.get_quote", "h1", t0)
                .is_none()
        );
        g.dedup_store("agent:S1", "market.get_quote", "h1", &result(), t0);
        let in_window = Timestamp::from_secs(109);
        assert!(
            g.dedup_lookup("agent:S1", "market.get_quote", "h1", in_window)
                .is_some()
        );
        assert!(
            g.dedup_lookup("agent:S1", "market.get_quote", "h2", in_window)
                .is_none()
        );
        assert!(
            g.dedup_lookup("agent:S1", "market.get_candles", "h1", in_window)
                .is_none()
        );
        assert!(
            g.dedup_lookup("agent:S2", "market.get_quote", "h1", in_window)
                .is_none()
        );
        let after = Timestamp::from_secs(110);
        assert!(
            g.dedup_lookup("agent:S1", "market.get_quote", "h1", after)
                .is_none()
        );
    }

    #[test]
    fn token_bucket() {
        let r = RateLimiter::default();
        let lim = RateLimit::new(2.0, 2);
        let t0 = Instant::now();
        assert!(r.check("chart.report_viewport", "user", lim, t0).is_ok());
        assert!(r.check("chart.report_viewport", "user", lim, t0).is_ok());
        assert!(r.check("chart.report_viewport", "user", lim, t0).is_err());
        assert!(
            r.check("chart.report_viewport", "agent:S1", lim, t0)
                .is_ok()
        );
        let half = t0 + std::time::Duration::from_millis(500);
        assert!(r.check("chart.report_viewport", "user", lim, half).is_ok());
        assert!(r.check("chart.report_viewport", "user", lim, half).is_err());
    }

    #[test]
    fn one_live_draft_per_account_and_instrument() {
        let g = DraftGuard::default();
        let qqq = InstrumentId::new("QQQ").unwrap();
        let key = draft_key("paper-main", Some(&qqq));
        let (d1, a1) = (DraftId::new("d_1"), ApprovalId::new("apr_1"));
        g.reserve(key.clone(), d1.clone(), a1.clone()).unwrap();
        let err = g
            .reserve(key.clone(), DraftId::new("d_2"), ApprovalId::new("apr_2"))
            .unwrap_err();
        assert!(matches!(err, GuardTrip::LiveDraft { ref draft_id, .. } if *draft_id == d1));
        let spy = InstrumentId::new("SPY").unwrap();
        g.reserve(
            draft_key("paper-main", Some(&spy)),
            DraftId::new("d_3"),
            ApprovalId::new("apr_3"),
        )
        .unwrap();
        g.reserve(
            draft_key("rtest-01", Some(&qqq)),
            DraftId::new("d_4"),
            ApprovalId::new("apr_4"),
        )
        .unwrap();
        assert_eq!(g.len(), 3);
        g.release_approval(&a1);
        assert!(g.check(&key).is_ok());
    }

    #[test]
    fn an_edit_moves_its_draft_only_to_a_free_key() {
        let g = DraftGuard::default();
        let qqq = InstrumentId::new("QQQ").unwrap();
        let spy = InstrumentId::new("SPY").unwrap();
        let (q, s) = (
            draft_key("paper-main", Some(&qqq)),
            draft_key("paper-main", Some(&spy)),
        );
        let d1 = DraftId::new("d_1");
        let (a1, a2) = (ApprovalId::new("apr_1"), ApprovalId::new("apr_2"));
        g.reserve(q.clone(), d1.clone(), a1.clone()).unwrap();
        g.reserve(s.clone(), DraftId::new("d_2"), a2.clone())
            .unwrap();
        assert!(matches!(
            g.transfer(&a1, s.clone(), d1.clone(), ApprovalId::new("apr_1b")),
            Err(GuardTrip::LiveDraft { ref approval_id, .. }) if *approval_id == a2
        ));
        assert!(
            matches!(g.check(&q), Err(GuardTrip::LiveDraft { ref approval_id, .. }) if *approval_id == a1)
        );
        let a1b = ApprovalId::new("apr_1b");
        g.transfer(&a1, q.clone(), d1.clone(), a1b.clone()).unwrap();
        assert!(
            matches!(g.check(&q), Err(GuardTrip::LiveDraft { ref approval_id, .. }) if *approval_id == a1b)
        );
        g.release_approval(&a2);
        let a1c = ApprovalId::new("apr_1c");
        g.transfer(&a1b, s.clone(), d1, a1c).unwrap();
        assert!(g.check(&q).is_ok());
        assert_eq!(g.len(), 1);
    }

    #[test]
    fn idempotency_ttl() {
        let c = IdempotencyCache::default();
        let t0 = Timestamp::from_secs(0);
        c.put("user", "k1", &result(), t0);
        assert!(c.get("user", "k1", Timestamp::from_secs(599)).is_some());
        assert!(c.get("agent:S1", "k1", Timestamp::from_secs(1)).is_none());
        assert!(c.get("user", "k1", Timestamp::from_secs(600)).is_none());
    }

    #[tokio::test]
    async fn a_key_is_reserved_while_its_call_runs() {
        let c = IdempotencyCache::default();
        let t0 = Timestamp::from_secs(0);
        let Claim::Reserved(first) = c.claim("user", "k1", t0) else {
            panic!("the first claim reserves");
        };
        let Claim::Running(rx) = c.claim("user", "k1", t0) else {
            panic!("a repeat while it runs waits");
        };
        assert!(matches!(c.claim("user", "k2", t0), Claim::Reserved(_)));
        let waiter = tokio::spawn(IdempotencyCache::wait(
            rx,
            std::time::Duration::from_secs(5),
        ));
        first.finish(&result(), true, t0);
        assert_eq!(waiter.await.unwrap(), Waited::Finished(Box::new(result())));
        assert!(matches!(c.claim("user", "k1", t0), Claim::Cached(_)));

        let Claim::Reserved(r) = c.claim("user", "k3", t0) else {
            panic!()
        };
        let mut failed = result();
        failed.ok = false;
        r.finish(&failed, false, t0);
        assert!(matches!(c.claim("user", "k3", t0), Claim::Reserved(_)));

        let Claim::Reserved(r) = c.claim("user", "k4", t0) else {
            panic!()
        };
        drop(r);
        assert!(matches!(c.claim("user", "k4", t0), Claim::Reserved(_)));

        let Claim::Reserved(mut r) = c.claim("user", "k5", t0) else {
            panic!()
        };
        r.executing();
        drop(r);
        let Claim::Cached(unknown) = c.claim("user", "k5", t0) else {
            panic!("an abandoned execution is never re-run");
        };
        assert_eq!(unknown.error.unwrap().code, ToolErrorCode::OutcomeUnknown);
    }
}
