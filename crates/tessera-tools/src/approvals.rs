use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tessera_core::accounts::Environment;
use tessera_core::hash::hash_json;
use tessera_core::ids::{ApprovalId, CallId, DraftId};
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{InstrumentId, Origin, Timestamp};
use tessera_protocol::tools::{
    Approval, ApprovalDecision, ApprovalKind, ApprovalResolution, ApprovalStatus, RiskTier,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StalenessPolicy {
    pub max_age_nanos: i64,
    pub max_ticks: Option<u32>,
}

impl Default for StalenessPolicy {
    fn default() -> Self {
        Self {
            max_age_nanos: 60 * NANOS_PER_SEC,
            max_ticks: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NewApproval {
    pub kind: ApprovalKind,
    pub origin: Origin,
    pub call_id: CallId,
    pub tool: String,
    pub risk: RiskTier,
    pub input: Value,
    pub preview: Value,
    pub draft_id: Option<DraftId>,
    pub environment: Option<Environment>,
    pub instrument: Option<InstrumentId>,
    pub replaces: Option<ApprovalId>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ApprovalError {
    #[error("approval {0} not found")]
    NotFound(ApprovalId),
    #[error("only the user can resolve approvals")]
    NotUser,
    #[error("an agent can never approve its own request")]
    SelfApproval,
    #[error("preview hash mismatch: the approval changed since it was shown")]
    HashMismatch,
    #[error("approval already {0:?}")]
    AlreadyResolved(ApprovalStatus),
    #[error("approval is stale; ask for a fresh preview")]
    Stale,
    #[error("edit requires replacement input")]
    MissingEditInput,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Final {
    Approved,
    Rejected,
    Cancelled,
}

impl From<Final> for ApprovalStatus {
    fn from(f: Final) -> Self {
        match f {
            Final::Approved => ApprovalStatus::Approved,
            Final::Rejected => ApprovalStatus::Rejected,
            Final::Cancelled => ApprovalStatus::Cancelled,
        }
    }
}

pub fn preview_hash(tool: &str, input: &Value, preview: &Value) -> String {
    hash_json(&json!({ "tool": tool, "input": input, "preview": preview }))
}

#[derive(Debug, Default)]
pub struct ApprovalBook {
    policy: Mutex<StalenessPolicy>,
    inner: Mutex<HashMap<ApprovalId, Approval>>,
}

impl ApprovalBook {
    pub fn new(policy: StalenessPolicy) -> Self {
        Self {
            policy: Mutex::new(policy),
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn policy(&self) -> StalenessPolicy {
        *self.policy.lock()
    }

    pub fn set_policy(&self, policy: StalenessPolicy) {
        *self.policy.lock() = policy;
    }

    pub fn create(&self, req: NewApproval, now: Timestamp) -> Approval {
        let approval = self.open(ApprovalId::generate(), req, now);
        self.inner
            .lock()
            .insert(approval.id.clone(), approval.clone());
        approval
    }

    fn open(&self, id: ApprovalId, req: NewApproval, now: Timestamp) -> Approval {
        let hash = preview_hash(&req.tool, &req.input, &req.preview);
        let policy = self.policy();
        Approval {
            id,
            kind: req.kind,
            status: ApprovalStatus::Pending,
            session_id: req.origin.session_id().cloned(),
            origin: req.origin,
            call_id: req.call_id,
            tool: req.tool,
            risk: req.risk,
            input: req.input,
            preview: req.preview,
            preview_hash: hash,
            draft_id: req.draft_id,
            environment: req.environment,
            max_ticks: if req.kind == ApprovalKind::Financial {
                policy.max_ticks
            } else {
                None
            },
            instrument: req.instrument,
            created_at: now,
            stale_at: now.add_nanos(policy.max_age_nanos),
            ticks_seen: 0,
            resolution: None,
            replaced_by: None,
            replaces: req.replaces,
        }
    }

    pub fn get(&self, id: &ApprovalId) -> Option<Approval> {
        self.inner.lock().get(id).cloned()
    }

    pub fn pending(&self) -> Vec<Approval> {
        let mut v: Vec<Approval> = self
            .inner
            .lock()
            .values()
            .filter(|a| a.status == ApprovalStatus::Pending)
            .cloned()
            .collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        v
    }

    pub fn is_stale(a: &Approval, now: Timestamp) -> bool {
        now >= a.stale_at || a.max_ticks.is_some_and(|m| a.ticks_seen >= m)
    }

    pub fn expire(&self, now: Timestamp) -> Vec<Approval> {
        let mut out = Vec::new();
        for a in self.inner.lock().values_mut() {
            if a.status == ApprovalStatus::Pending && Self::is_stale(a, now) {
                a.status = ApprovalStatus::Stale;
                out.push(a.clone());
            }
        }
        out
    }

    pub fn observe_ticks(
        &self,
        instrument: &InstrumentId,
        ticks: u32,
        now: Timestamp,
    ) -> Vec<Approval> {
        let mut out = Vec::new();
        for a in self.inner.lock().values_mut() {
            if a.status == ApprovalStatus::Pending && a.instrument.as_ref() == Some(instrument) {
                a.ticks_seen = a.ticks_seen.saturating_add(ticks);
                if Self::is_stale(a, now) {
                    a.status = ApprovalStatus::Stale;
                    out.push(a.clone());
                }
            }
        }
        out
    }

    pub fn check(
        &self,
        id: &ApprovalId,
        decision: ApprovalDecision,
        hash: &str,
        resolver: &Origin,
        now: Timestamp,
    ) -> Result<Approval, ApprovalError> {
        let mut map = self.inner.lock();
        let a = map
            .get_mut(id)
            .ok_or_else(|| ApprovalError::NotFound(id.clone()))?;
        if !resolver.is_user() {
            return Err(match (resolver.session_id(), a.origin.session_id()) {
                (Some(r), Some(o)) if r == o => ApprovalError::SelfApproval,
                _ => ApprovalError::NotUser,
            });
        }
        if a.status != ApprovalStatus::Pending {
            return Err(ApprovalError::AlreadyResolved(a.status));
        }
        if a.preview_hash != hash {
            return Err(ApprovalError::HashMismatch);
        }
        if decision != ApprovalDecision::Reject && Self::is_stale(a, now) {
            a.status = ApprovalStatus::Stale;
            return Err(ApprovalError::Stale);
        }
        Ok(a.clone())
    }

    pub fn finish(
        &self,
        id: &ApprovalId,
        status: Final,
        decision: Option<ApprovalDecision>,
        note: Option<String>,
        now: Timestamp,
    ) -> Result<Approval, ApprovalError> {
        let mut map = self.inner.lock();
        let a = map
            .get_mut(id)
            .ok_or_else(|| ApprovalError::NotFound(id.clone()))?;
        if a.status != ApprovalStatus::Pending {
            return Err(ApprovalError::AlreadyResolved(a.status));
        }
        a.status = status.into();
        if let Some(decision) = decision {
            a.resolution = Some(ApprovalResolution {
                decision,
                by: Origin::User,
                note,
                at: now,
            });
        }
        Ok(a.clone())
    }

    pub fn supersede(
        &self,
        id: &ApprovalId,
        replacement: ApprovalId,
        req: NewApproval,
        note: Option<String>,
        now: Timestamp,
    ) -> Result<(Approval, Approval), ApprovalError> {
        let mut map = self.inner.lock();
        let a = map
            .get_mut(id)
            .ok_or_else(|| ApprovalError::NotFound(id.clone()))?;
        if a.status != ApprovalStatus::Pending {
            return Err(ApprovalError::AlreadyResolved(a.status));
        }
        if Self::is_stale(a, now) {
            a.status = ApprovalStatus::Stale;
            return Err(ApprovalError::Stale);
        }
        let next = self.open(
            replacement,
            NewApproval {
                replaces: Some(id.clone()),
                ..req
            },
            now,
        );
        a.status = ApprovalStatus::Superseded;
        a.resolution = Some(ApprovalResolution {
            decision: ApprovalDecision::Edit,
            by: Origin::User,
            note,
            at: now,
        });
        a.replaced_by = Some(next.id.clone());
        let old = a.clone();
        map.insert(next.id.clone(), next.clone());
        Ok((old, next))
    }

    pub fn cancel_of(&self, origin: &Origin) -> Vec<Approval> {
        let session = origin.session_id();
        let mut out = Vec::new();
        for a in self.inner.lock().values_mut() {
            let theirs =
                a.origin == *origin || session.is_some_and(|s| a.session_id.as_ref() == Some(s));
            if a.status == ApprovalStatus::Pending && theirs {
                a.status = ApprovalStatus::Cancelled;
                out.push(a.clone());
            }
        }
        out
    }

    pub fn restore(&self, approvals: impl IntoIterator<Item = Approval>) {
        let mut map = self.inner.lock();
        for a in approvals {
            map.insert(a.id.clone(), a);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::ids::SessionId;

    fn new_req(origin: Origin) -> NewApproval {
        NewApproval {
            kind: ApprovalKind::Financial,
            origin,
            call_id: CallId::generate(),
            tool: "orders.submit".into(),
            risk: RiskTier::Financial,
            input: json!({"qty": 25}),
            preview: json!({"restatement": "BUY 25 QQQ LMT 487.25 DAY"}),
            draft_id: Some(DraftId::generate()),
            environment: Some(Environment::Paper),
            instrument: Some(InstrumentId::new("QQQ").unwrap()),
            replaces: None,
        }
    }

    fn agent() -> Origin {
        Origin::Agent {
            session_id: SessionId::new("S15"),
            provider: "codex".into(),
        }
    }

    #[test]
    fn hash_binds_tool_input_and_preview() {
        let a = preview_hash("t.x", &json!({"a":1}), &json!({"p":1}));
        assert_eq!(a, preview_hash("t.x", &json!({"a":1}), &json!({"p":1})));
        assert_ne!(a, preview_hash("t.y", &json!({"a":1}), &json!({"p":1})));
        assert_ne!(a, preview_hash("t.x", &json!({"a":2}), &json!({"p":1})));
        assert_ne!(a, preview_hash("t.x", &json!({"a":1}), &json!({"p":2})));
    }

    #[test]
    fn only_the_user_resolves() {
        let book = ApprovalBook::default();
        let t0 = Timestamp::from_secs(1000);
        let a = book.create(new_req(agent()), t0);
        assert_eq!(
            book.check(
                &a.id,
                ApprovalDecision::Approve,
                &a.preview_hash,
                &agent(),
                t0
            ),
            Err(ApprovalError::SelfApproval)
        );
        let other = Origin::Agent {
            session_id: SessionId::new("S16"),
            provider: "codex".into(),
        };
        assert_eq!(
            book.check(
                &a.id,
                ApprovalDecision::Approve,
                &a.preview_hash,
                &other,
                t0
            ),
            Err(ApprovalError::NotUser)
        );
        let ext = Origin::External {
            client_id: "claude-desktop".into(),
        };
        assert_eq!(
            book.check(&a.id, ApprovalDecision::Reject, &a.preview_hash, &ext, t0),
            Err(ApprovalError::NotUser)
        );
        assert!(
            book.check(
                &a.id,
                ApprovalDecision::Approve,
                &a.preview_hash,
                &Origin::User,
                t0
            )
            .is_ok()
        );
    }

    #[test]
    fn hash_mismatch_and_staleness() {
        let book = ApprovalBook::new(StalenessPolicy {
            max_age_nanos: 60 * NANOS_PER_SEC,
            max_ticks: Some(3),
        });
        let t0 = Timestamp::from_secs(1000);
        let a = book.create(new_req(agent()), t0);
        assert_eq!(a.stale_at, Timestamp::from_secs(1060));
        assert_eq!(a.max_ticks, Some(3));
        assert_eq!(
            book.check(
                &a.id,
                ApprovalDecision::Approve,
                "deadbeef",
                &Origin::User,
                t0
            ),
            Err(ApprovalError::HashMismatch)
        );
        let qqq = InstrumentId::new("QQQ").unwrap();
        assert!(book.observe_ticks(&qqq, 2, t0).is_empty());
        assert_eq!(book.observe_ticks(&qqq, 1, t0).len(), 1);
        assert_eq!(
            book.check(
                &a.id,
                ApprovalDecision::Approve,
                &a.preview_hash,
                &Origin::User,
                t0
            ),
            Err(ApprovalError::AlreadyResolved(ApprovalStatus::Stale))
        );
        let b = book.create(new_req(agent()), t0);
        let late = Timestamp::from_secs(1060);
        assert_eq!(
            book.check(
                &b.id,
                ApprovalDecision::Approve,
                &b.preview_hash,
                &Origin::User,
                late
            ),
            Err(ApprovalError::Stale)
        );
        assert_eq!(book.get(&b.id).unwrap().status, ApprovalStatus::Stale);
        let c = book.create(new_req(agent()), t0);
        assert!(
            book.check(
                &c.id,
                ApprovalDecision::Reject,
                &c.preview_hash,
                &Origin::User,
                late
            )
            .is_ok()
        );
        let d = book.create(new_req(agent()), t0);
        let swept = book.expire(late);
        assert!(swept.iter().any(|x| x.id == d.id));
    }

    #[test]
    fn finish_records_resolution_and_blocks_reuse() {
        let book = ApprovalBook::default();
        let t0 = Timestamp::from_secs(1);
        let a = book.create(new_req(agent()), t0);
        let done = book
            .finish(
                &a.id,
                Final::Rejected,
                Some(ApprovalDecision::Reject),
                Some("not now".into()),
                t0,
            )
            .unwrap();
        assert_eq!(done.resolution.as_ref().unwrap().by, Origin::User);
        assert_eq!(
            book.check(
                &a.id,
                ApprovalDecision::Approve,
                &a.preview_hash,
                &Origin::User,
                t0
            ),
            Err(ApprovalError::AlreadyResolved(ApprovalStatus::Rejected))
        );
        assert!(book.pending().is_empty());
    }

    #[test]
    fn finish_and_supersede_are_a_compare_and_set_on_pending() {
        let book = ApprovalBook::default();
        let t0 = Timestamp::from_secs(1);
        let a = book.create(new_req(agent()), t0);
        assert_eq!(book.cancel_of(&agent()).len(), 1);
        for status in [Final::Approved, Final::Rejected] {
            assert_eq!(
                book.finish(&a.id, status, Some(ApprovalDecision::Approve), None, t0),
                Err(ApprovalError::AlreadyResolved(ApprovalStatus::Cancelled))
            );
        }
        assert_eq!(
            book.supersede(&a.id, ApprovalId::generate(), new_req(agent()), None, t0),
            Err(ApprovalError::AlreadyResolved(ApprovalStatus::Cancelled))
        );
        let kept = book.get(&a.id).unwrap();
        assert_eq!(kept.status, ApprovalStatus::Cancelled);
        assert!(kept.resolution.is_none() && kept.replaced_by.is_none());
        assert!(book.pending().is_empty(), "no replacement was opened");

        let b = book.create(new_req(agent()), t0);
        let late = t0.add_nanos(60 * NANOS_PER_SEC);
        assert_eq!(
            book.supersede(&b.id, ApprovalId::generate(), new_req(agent()), None, late),
            Err(ApprovalError::Stale)
        );
        assert_eq!(book.get(&b.id).unwrap().status, ApprovalStatus::Stale);
        assert!(book.pending().is_empty());

        let c = book.create(new_req(agent()), t0);
        let next = ApprovalId::generate();
        let (old, rep) = book
            .supersede(
                &c.id,
                next.clone(),
                new_req(agent()),
                Some("smaller".into()),
                t0,
            )
            .unwrap();
        assert_eq!(old.status, ApprovalStatus::Superseded);
        assert_eq!(old.replaced_by.as_ref(), Some(&next));
        assert_eq!(old.resolution.unwrap().decision, ApprovalDecision::Edit);
        assert_eq!((rep.id.clone(), rep.replaces.clone()), (next, Some(c.id)));
        assert_eq!(book.pending(), vec![rep]);
    }

    #[test]
    fn cancel_of() {
        let book = ApprovalBook::default();
        let a = book.create(new_req(agent()), Timestamp(0));
        let _b = book.create(new_req(Origin::User), Timestamp(0));
        let client = Origin::External {
            client_id: "cursor".into(),
        };
        let c = book.create(new_req(client.clone()), Timestamp(0));
        let cancelled = book.cancel_of(&agent());
        assert_eq!(cancelled.len(), 1);
        assert_eq!(cancelled[0].id, a.id);
        let cancelled = book.cancel_of(&client);
        assert_eq!(cancelled.len(), 1);
        assert_eq!(cancelled[0].id, c.id);
        assert_eq!(book.pending().len(), 1);
    }
}
