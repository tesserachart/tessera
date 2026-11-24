use std::collections::{HashMap, HashSet};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tessera_core::hash::hash_json;
use tessera_core::ids::{AccountId, CallId, OrderId};
use tessera_core::limits::{LockKind, LockSpan, LockedBy};
use tessera_core::orders::{Order, OrderRole};
use tessera_core::{Origin, SessionCalendar, Timestamp};
use tessera_protocol::tools::{
    RiskTier, ToolCallRecord, ToolCallStatus, ToolErrorCode, ToolErrorInfo,
};
use tessera_protocol::topics::ProtectionNote;
use tessera_store::{Kept, Store};
use tessera_tools::{ToolCtx, ToolError};

use crate::limits::{AccountLock, LockCause};
use crate::orders::io::{
    AccountLockOutput, CancelOrderInput, GetLockInput, LockAccountInput, LockAccountOutput,
    LockOption, LockState, UnlockAccountInput, UnlockAccountOutput,
};
use crate::orders::{LossFlatten, OrdersService};
use crate::paper::account::{clock_label, clock_label_in};
use crate::protect::PROTECT_TOOL;

pub const LOCKS_KEY: &str = "risk.loss_locks";
const LOCKS: Kept<KeptLocks> = Kept::new(LOCKS_KEY);

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeptLocks {
    #[serde(default)]
    locks: Vec<AccountLock>,
    #[serde(default)]
    lifted: Vec<Lifted>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lifted {
    account_id: AccountId,
    day_pnl: Option<Decimal>,
}
pub const HOLD_FLAT_EVERY: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Flattening {
    Tried(Timestamp),
    Done,
}

#[derive(Debug, Default)]
pub struct AccountLocks {
    locks: RwLock<Vec<AccountLock>>,
    flattened: Mutex<HashMap<AccountId, Flattening>>,
    said: Mutex<HashMap<AccountId, String>>,
    lifted: Mutex<HashMap<AccountId, Option<Decimal>>>,
    changed: Mutex<HashSet<AccountId>>,
    store: Option<Store>,
}

impl AccountLocks {
    pub async fn load(store: Option<Store>) -> Self {
        let mut kept = KeptLocks::default();
        if let Some(s) = store.clone() {
            match tokio::task::spawn_blocking(move || s.settings().load(&LOCKS)).await {
                Ok(Ok(Some(k))) => kept = k,
                Ok(Ok(None)) => {}
                Ok(Err(e)) => tracing::warn!(error = %e, "cannot read the account locks"),
                Err(e) => tracing::warn!(error = %e, "cannot read the account locks"),
            }
        }
        Self {
            locks: RwLock::new(kept.locks),
            lifted: Mutex::new(
                kept.lifted
                    .into_iter()
                    .map(|l| (l.account_id, l.day_pnl))
                    .collect(),
            ),
            store,
            ..Self::default()
        }
    }

    pub fn active(&self, account: &AccountId, now: Timestamp) -> Option<AccountLock> {
        self.locks
            .read()
            .iter()
            .filter(|l| &l.account_id == account && l.holds(now))
            .max_by_key(|l| (l.until, l.kind() == LockKind::DailyLoss))
            .cloned()
    }

    pub fn active_of(
        &self,
        account: &AccountId,
        kind: LockKind,
        now: Timestamp,
    ) -> Option<AccountLock> {
        self.locks
            .read()
            .iter()
            .find(|l| &l.account_id == account && l.kind() == kind && l.holds(now))
            .cloned()
    }

    pub(crate) fn first_say(&self, account: &AccountId, text: &str) -> bool {
        let mut said = self.said.lock();
        if said.get(account).is_some_and(|t| t == text) {
            return false;
        }
        said.insert(account.clone(), text.to_owned());
        true
    }

    pub async fn lock(&self, lock: AccountLock) {
        let now = lock.at;
        let account = lock.account_id.clone();
        {
            let mut locks = self.locks.write();
            locks.retain(|l| !(l.account_id == lock.account_id && l.kind() == lock.kind()));
            locks.push(lock);
        }
        self.changed.lock().insert(account);
        self.save(now).await;
    }

    pub async fn unlock(
        &self,
        account: &AccountId,
        kind: LockKind,
        now: Timestamp,
    ) -> Option<AccountLock> {
        let lifted = {
            let mut locks = self.locks.write();
            let at = locks
                .iter()
                .position(|l| &l.account_id == account && l.kind() == kind && l.holds(now))?;
            locks.remove(at)
        };
        if kind == LockKind::DailyLoss {
            self.flattened.lock().remove(account);
        }
        self.changed.lock().insert(account.clone());
        self.save(now).await;
        Some(lifted)
    }

    pub fn take_changed(&self) -> Vec<AccountId> {
        self.changed.lock().drain().collect()
    }

    pub async fn lift_ended(&self, now: Timestamp) -> Vec<AccountId> {
        let ended: Vec<AccountLock> = {
            let mut locks = self.locks.write();
            let (kept, ended) = locks.drain(..).partition(|l| l.holds(now));
            *locks = kept;
            ended
        };
        if ended.is_empty() {
            return Vec::new();
        }
        {
            let mut flattened = self.flattened.lock();
            let mut said = self.said.lock();
            let mut lifted = self.lifted.lock();
            for l in ended.iter().filter(|l| l.kind() == LockKind::DailyLoss) {
                flattened.remove(&l.account_id);
                said.remove(&l.account_id);
                lifted.insert(l.account_id.clone(), None);
            }
        }
        self.save(now).await;
        let mut accounts: Vec<AccountId> = ended.into_iter().map(|l| l.account_id).collect();
        accounts.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        accounts.dedup();
        accounts
    }

    pub async fn from_before_the_lift(
        &self,
        account: &AccountId,
        day_pnl: Decimal,
        now: Timestamp,
    ) -> bool {
        let (before, changed) = {
            let mut lifted = self.lifted.lock();
            match lifted.get(account).copied() {
                None => (false, false),
                Some(None) => {
                    lifted.insert(account.clone(), Some(day_pnl));
                    (true, true)
                }
                Some(Some(was)) if was == day_pnl => (true, false),
                Some(Some(_)) => {
                    lifted.remove(account);
                    (false, true)
                }
            }
        };
        if changed {
            self.save(now).await;
        }
        before
    }

    pub fn flatten_due(&self, account: &AccountId, now: Timestamp) -> bool {
        let mut flattened = self.flattened.lock();
        let every = i64::try_from(HOLD_FLAT_EVERY.as_nanos()).unwrap_or(i64::MAX);
        let due = match flattened.get(account) {
            Some(Flattening::Done) => false,
            Some(Flattening::Tried(last)) => now.0.saturating_sub(last.0) >= every,
            None => true,
        };
        if due {
            flattened.insert(account.clone(), Flattening::Tried(now));
        }
        due
    }

    pub fn flattened(&self, account: &AccountId) {
        self.flattened
            .lock()
            .insert(account.clone(), Flattening::Done);
    }

    async fn save(&self, now: Timestamp) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let mut locks: Vec<AccountLock> = self.locks.read().clone();
        locks.sort_by(|a, b| {
            (a.account_id.as_str(), a.kind() == LockKind::Manual)
                .cmp(&(b.account_id.as_str(), b.kind() == LockKind::Manual))
        });
        let mut lifted: Vec<Lifted> = self
            .lifted
            .lock()
            .iter()
            .map(|(a, pnl)| Lifted {
                account_id: a.clone(),
                day_pnl: *pnl,
            })
            .collect();
        lifted.sort_by(|a, b| a.account_id.as_str().cmp(b.account_id.as_str()));
        let kept = KeptLocks { locks, lifted };
        match tokio::task::spawn_blocking(move || store.settings().keep(&LOCKS, &kept, now)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "cannot keep the account locks"),
            Err(e) => tracing::warn!(error = %e, "cannot keep the account locks"),
        }
    }
}

pub const DEFAULT_LOCK_CALENDAR: SessionCalendar = SessionCalendar::CmeEquityIndex;
pub const UNLOCK_WORD: &str = "UNLOCK";

fn entry_waiting(o: &Order) -> bool {
    o.status.is_open()
        && o.role == OrderRole::Entry
        && o.parent_id.is_none()
        && !o.request.reduce_only
}

impl OrdersService {
    async fn lock_calendar(&self, instrument: Option<&str>) -> Result<SessionCalendar, ToolError> {
        let Some(named) = instrument.map(str::trim).filter(|i| !i.is_empty()) else {
            return Ok(DEFAULT_LOCK_CALENDAR);
        };
        let unknown = |e: tessera_market::MarketError| {
            ToolError::invalid_input(format!("{named}: {e}. Nothing locked."))
        };
        let id = self.market_ref().resolve(named).await.map_err(unknown)?;
        let (_, spec) = self.market_ref().spec(&id).await.map_err(unknown)?;
        Ok(spec.sessions)
    }

    pub fn lock_state(&self, lock: &AccountLock) -> LockState {
        let now = self.clock_ref().now();
        let manual = match &lock.cause {
            LockCause::Manual { manual } => Some(manual),
            LockCause::DailyLoss { .. } => None,
        };
        LockState {
            kind: lock.kind(),
            since: lock.at,
            until: lock.until,
            by: manual.map(|m| m.by),
            span: manual.map(|m| m.span),
            words: lock.words(now, self.display_zone()),
            liftable: manual.is_some() && self.limits().allow_early_unlock,
        }
    }

    pub fn copy_lock_words(&self, account: &AccountId) -> Option<String> {
        let groups = self.copy_book().groups();
        let on = groups.iter().filter(|g| g.enabled);
        if let Some(g) = on.clone().find(|g| &g.leader_id == account) {
            return Some(format!(
                "It leads {}: while it is locked the group copies no entries. Exits are still \
                 copied.",
                g.name
            ));
        }
        on.filter(|g| g.copying().any(|f| &f.account_id == account))
            .map(|g| {
                format!(
                    "It follows in {}: while it is locked the leader's entries skip it, and each \
                     skip says so. Exits are still copied.",
                    g.name
                )
            })
            .next()
    }

    pub fn leader_locked(&self, leader: &AccountId) -> Option<ToolError> {
        let lock = self.lock_of(leader)?;
        let now = self.clock_ref().now();
        Some(
            ToolError::rejected(format!(
                "the leader is locked until {}: entries are not copied",
                clock_label_in(lock.until, now, self.display_zone())
            ))
            .with_details(json!({ "code": lock.code(), "until": lock.until, "sent": false })),
        )
    }

    pub async fn lock_info(&self, input: &GetLockInput) -> Result<AccountLockOutput, ToolError> {
        let account = self.account(&input.account_id).await?;
        let calendar = self.lock_calendar(input.instrument.as_deref()).await?;
        let now = self.clock_ref().now();
        let options = LockSpan::offered()
            .into_iter()
            .map(|span| {
                let until = span.until(calendar, now);
                LockOption {
                    span,
                    label: span.label(now),
                    unavailable: until.as_ref().err().cloned(),
                    until: until.ok(),
                }
            })
            .collect();
        Ok(AccountLockOutput {
            display_name: self.account_name(account.as_str()).await,
            lock: self.lock_of(&account).map(|l| self.lock_state(&l)),
            options,
            exchange_zone: calendar.tz().name().to_owned(),
            copy: self.copy_lock_words(&account),
            as_of: now,
            account_id: account,
        })
    }

    pub async fn lock_account(
        &self,
        ctx: &ToolCtx,
        input: &LockAccountInput,
    ) -> Result<LockAccountOutput, ToolError> {
        let account = self.account(&input.account_id).await?;
        let calendar = self.lock_calendar(input.instrument.as_deref()).await?;
        let now = self.clock_ref().now();
        let until = input
            .span
            .until(calendar, now)
            .map_err(|why| ToolError::invalid_input(format!("{why}. Nothing locked.")))?;
        let held = self.lock_of(&account);
        let extended = held.as_ref().is_none_or(|l| l.until < until);
        if extended {
            let lock =
                AccountLock::manual(&account, LockedBy::of(&ctx.origin), input.span, now, until);
            self.account_locks().lock(lock).await;
            tracing::info!(%account, until = %until.0, "trading locked");
        }
        let cancelled = self.cancel_waiting_entries(ctx, &account).await;
        let lock = self
            .lock_of(&account)
            .ok_or_else(|| ToolError::internal("the lock did not hold"))?;
        let state = self.lock_state(&lock);
        let clock = |t| clock_label_in(t, now, self.display_zone());
        let mut summary = if extended {
            format!("Locked new entries until {}", clock(lock.until))
        } else {
            format!(
                "Already locked until {}: a lock is never shortened",
                clock(lock.until)
            )
        };
        if !cancelled.is_empty() {
            summary.push_str(&format!(
                "; cancelled {} working {}",
                cancelled.len(),
                if cancelled.len() == 1 {
                    "entry"
                } else {
                    "entries"
                }
            ));
        }
        Ok(LockAccountOutput {
            lock: state,
            extended,
            cancelled,
            copy: self.copy_lock_words(&account),
            summary,
            account_id: account,
        })
    }

    async fn cancel_waiting_entries(&self, ctx: &ToolCtx, account: &AccountId) -> Vec<OrderId> {
        let orders = match self.provider_ref().orders(account).await {
            Ok(o) => o,
            Err(e) => {
                tracing::warn!(%account, error = %e, "lock: working orders unread");
                return Vec::new();
            }
        };
        let own = ToolCtx {
            approved_by: None,
            ..ctx.clone()
        };
        let mut cancelled = Vec::new();
        for o in orders.iter().filter(|o| entry_waiting(o)) {
            let cancel = CancelOrderInput {
                account_id: account.to_string(),
                order_id: o.id.clone(),
            };
            match self.cancel_copying(&own, &cancel).await {
                Ok(out) => cancelled.push(out.order.id),
                Err(e) => {
                    tracing::warn!(%account, order = %o.id, error = %e.message, "lock: entry not cancelled")
                }
            }
        }
        cancelled
    }

    pub async fn unlock_account(
        &self,
        origin: &Origin,
        input: &UnlockAccountInput,
    ) -> Result<UnlockAccountOutput, ToolError> {
        if !origin.is_user() {
            return Err(ToolError::permission_denied(
                "Only the trader lifts a lock, in the app. It holds until its time.",
            ));
        }
        let account = self.account(&input.account_id).await?;
        let now = self.clock_ref().now();
        let Some(manual) = self
            .account_locks()
            .active_of(&account, LockKind::Manual, now)
        else {
            return Err(match self.lock_of(&account) {
                Some(l) => ToolError::rejected(format!(
                    "{} A reached daily loss limit's lock never lifts early.",
                    l.words(now, self.display_zone())
                )),
                None => ToolError::not_found("The account is not locked."),
            });
        };
        if !self.limits().allow_early_unlock {
            return Err(ToolError::rejected(format!(
                "{} Lifting a lock early is off (Settings › Trading and risk).",
                manual.words(now, self.display_zone())
            )));
        }
        if input.confirm.trim() != UNLOCK_WORD {
            return Err(ToolError::invalid_input(format!(
                "Type {UNLOCK_WORD} to lift the lock. It still holds."
            )));
        }
        let lifted = self
            .account_locks()
            .unlock(&account, LockKind::Manual, now)
            .await
            .ok_or_else(|| ToolError::conflict("The lock ended meanwhile."))?;
        tracing::info!(%account, "trading lock lifted early");
        Ok(UnlockAccountOutput {
            lifted: self.lock_state(&lifted),
            account_id: account,
        })
    }

    pub fn loss_lock_held(&self, lock: &AccountLock, flat: &LossFlatten) -> Vec<ProtectionNote> {
        let now = self.clock_ref().now();
        let instruments = &flat.instruments;
        let (text, ok, orders) = match &flat.result {
            Ok(out) => (
                format!(
                    "Daily loss limit reached: Tessera cancelled the working orders and closed the \
                     positions. New entries wait for the next session at {}",
                    clock_label(lock.until, now)
                ),
                true,
                out.cancelled
                    .iter()
                    .chain(&out.closing)
                    .map(|o| o.id.to_string())
                    .collect::<Vec<_>>(),
            ),
            Err(why) if flat.again => (
                format!(
                    "Daily loss limit reached, not flat yet: {}. Tessera tries again in {} s",
                    why.trim_end_matches('.'),
                    HOLD_FLAT_EVERY.as_secs()
                ),
                false,
                Vec::new(),
            ),
            Err(why) => (
                format!(
                    "Daily loss limit reached, not flat: {}. Tessera does not send it again",
                    why.trim_end_matches('.')
                ),
                false,
                Vec::new(),
            ),
        };
        if !self.account_locks().first_say(&lock.account_id, &text) {
            return Vec::new();
        }
        let call_id = CallId::generate();
        let input = json!({
            "accountId": lock.account_id,
            "mode": "loss_limit",
            "merge": false,
            "orders": orders,
            "entries": [],
            "until": lock.until,
        });
        if let Some(audit) = self.protection().and_then(|p| p.audit()) {
            audit.call_finished(&ToolCallRecord {
                call_id: call_id.clone(),
                tool: PROTECT_TOOL.to_owned(),
                risk: RiskTier::Financial,
                origin: Origin::User,
                session_id: None,
                input_hash: hash_json(&input),
                input,
                status: if ok {
                    ToolCallStatus::Ok
                } else {
                    ToolCallStatus::Error
                },
                started_at: now,
                finished_at: Some(now),
                duration_ms: None,
                error: (!ok).then(|| ToolErrorInfo {
                    code: ToolErrorCode::Rejected,
                    message: text.clone(),
                    retryable: true,
                    details: None,
                }),
                approval_id: None,
                deduped: false,
                idempotency_key: None,
                summary: Some(text.clone()),
                approved_by: None,
            });
        }
        instruments
            .iter()
            .map(|i| ProtectionNote {
                account_id: lock.account_id.to_string(),
                instrument: i.clone(),
                text: text.clone(),
                tone: if ok { "ok" } else { "err" }.into(),
                call_id: call_id.to_string(),
                ts: now,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::limits::LockSpan;

    fn manual(a: &AccountId, at: Timestamp, minutes: i64) -> AccountLock {
        AccountLock::manual(
            a,
            LockedBy::User,
            LockSpan::Minutes { minutes: 15 },
            at,
            at.add_nanos(minutes * 60 * 1_000_000_000),
        )
    }

    #[tokio::test]
    async fn a_lifted_daily_loss_lock_stays_lifted_on_yesterdays_pnl_across_a_restart() {
        let store = Store::open_in_memory().unwrap();
        let a = AccountId::new("paper-main");
        let friday = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        let sunday = Timestamp::parse("2026-10-04T18:00:01-04:00").unwrap();
        let fridays_loss = Decimal::from(-600);
        let locks = AccountLocks::load(Some(store.clone())).await;
        locks
            .lock(AccountLock::daily_loss(&a, Decimal::from(500), friday))
            .await;
        assert_eq!(locks.lift_ended(sunday).await, std::slice::from_ref(&a));
        drop(locks);

        let restarted = AccountLocks::load(Some(store.clone())).await;
        assert!(
            restarted
                .from_before_the_lift(&a, fridays_loss, sunday)
                .await,
            "the broker has not reset its day yet: Friday's loss"
        );
        drop(restarted);
        let restarted = AccountLocks::load(Some(store.clone())).await;
        assert!(
            restarted
                .from_before_the_lift(&a, fridays_loss, sunday)
                .await
        );
        assert!(
            !restarted
                .from_before_the_lift(&a, Decimal::from(-20), sunday)
                .await,
            "a new day's P&L counts"
        );
        drop(restarted);
        let restarted = AccountLocks::load(Some(store)).await;
        assert!(
            !restarted
                .from_before_the_lift(&a, fridays_loss, sunday)
                .await,
            "the lift is spent once the day was reset"
        );
    }

    #[test]
    fn a_daily_loss_lock_kept_before_manual_locks_existed_reads_back_unchanged() {
        let a = AccountId::new("paper-main");
        let friday = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        let kept = serde_json::json!([{
            "accountId": "paper-main",
            "limit": "500",
            "at": friday,
            "until": Timestamp::parse("2026-10-04T18:00:00-04:00").unwrap(),
        }]);
        let read: Vec<AccountLock> = serde_json::from_value(kept.clone()).unwrap();
        assert_eq!(
            read,
            [AccountLock::daily_loss(&a, Decimal::from(500), friday)]
        );
        assert_eq!(serde_json::to_value(&read).unwrap(), kept);
        let mine = manual(&a, friday, 15);
        let back: AccountLock =
            serde_json::from_value(serde_json::to_value(&mine).unwrap()).unwrap();
        assert_eq!(back, mine);
        assert_eq!(back.kind(), LockKind::Manual);
    }

    #[tokio::test]
    async fn a_manual_lock_survives_a_restart_and_lifts_alone_at_its_time() {
        let store = Store::open_in_memory().unwrap();
        let a = AccountId::new("paper-main");
        let at = Timestamp::parse("2026-10-06T14:42:00-04:00").unwrap();
        let locks = AccountLocks::load(Some(store.clone())).await;
        locks.lock(manual(&a, at, 15)).await;
        locks
            .lock(AccountLock::daily_loss(&a, Decimal::from(500), at))
            .await;
        assert_eq!(locks.take_changed(), std::slice::from_ref(&a));
        let restarted = AccountLocks::load(Some(store)).await;
        assert_eq!(
            restarted.active(&a, at).map(|l| l.kind()),
            Some(LockKind::DailyLoss),
            "the lock ending last binds"
        );
        assert!(restarted.active_of(&a, LockKind::Manual, at).is_some());
        let later = at.add_nanos(16 * 60 * 1_000_000_000);
        assert_eq!(restarted.lift_ended(later).await, std::slice::from_ref(&a));
        assert!(restarted.active_of(&a, LockKind::Manual, later).is_none());
        assert!(
            !restarted
                .from_before_the_lift(&a, Decimal::from(-600), later)
                .await,
            "a manual lock's end is not a daily loss lift"
        );
    }

    #[tokio::test]
    async fn a_day_loss_left_over_from_before_the_lift_does_not_lock_again_until_it_moves() {
        let locks = AccountLocks::default();
        let a = AccountId::new("rithmic-apex-x");
        let friday = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        let lock = AccountLock::daily_loss(&a, Decimal::from(500), friday);
        locks.locks.write().push(lock.clone());
        assert!(
            !locks
                .from_before_the_lift(&a, Decimal::from(-600), friday)
                .await,
            "no lift yet"
        );
        let after = lock.until.add_nanos(1);
        assert_eq!(locks.active(&a, after), None);
        locks.locks.write().retain(|l| l.holds(after));
        locks.lifted.lock().insert(a.clone(), None);
        assert!(
            locks
                .from_before_the_lift(&a, Decimal::from(-600), friday)
                .await,
            "yesterday's figure"
        );
        assert!(
            locks
                .from_before_the_lift(&a, Decimal::from(-600), friday)
                .await
        );
        assert!(
            !locks.from_before_the_lift(&a, Decimal::ZERO, friday).await,
            "the broker's day reset"
        );
        assert!(
            !locks
                .from_before_the_lift(&a, Decimal::from(-600), friday)
                .await,
            "a new day's loss counts"
        );
    }
}
