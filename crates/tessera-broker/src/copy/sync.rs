use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use futures::future::join_all;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::ids::AccountId;
use tessera_core::orders::Side;
use tessera_core::{InstrumentId, Qty, Timestamp};
use tessera_tools::ToolError;
use tokio::sync::{Notify, broadcast};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use ts_rs::TS;

use super::io::CopyStatusInput;
use super::model::{CopyFollower, CopyGroup, CopyOutcome, CopyReport};
use crate::BrokerEvent;
use crate::orders::OrdersService;
use crate::paper::engine::qty_label;

pub const SETTLE: Duration = Duration::from_secs(3);
const CHECK_EVERY: Duration = Duration::from_secs(1);
const QUIET_FOR: Duration = Duration::from_millis(200);
const NAMED_KEPT: usize = 4096;
const RECENT_KEPT: usize = 20;

/// Where a follower stands against its leader.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// Holds what it should at its size on every contract.
    InSync,
    /// Differs from its size for under 3 s: copies are on their way.
    Settling,
    /// Differs from its size, for 3 s or longer.
    OutOfSync,
    /// Its or the leader's positions could not be read (not connected): unknown, never assumed in
    /// sync.
    Unknown,
}

/// Where a follower stands on one contract against its leader.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyHolding {
    /// The leader's contract (`NQZ6.CME`); null when only the follower holds this contract.
    pub leader_instrument: Option<InstrumentId>,
    /// The follower's contract for it (`MNQZ6.CME` when it trades micros).
    pub instrument: InstrumentId,
    /// The leader's position there, signed (long positive).
    pub leader_qty: Qty,
    /// What the follower should hold there at its size, signed.
    pub target_qty: Qty,
    /// What it holds, signed.
    pub qty: Qty,
}

impl CopyHolding {
    pub fn apart(&self) -> bool {
        self.qty != self.target_qty
    }
}

/// One of the leader's open positions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LeaderHolding {
    /// The contract.
    pub instrument: InstrumentId,
    /// Signed quantity (long positive).
    pub qty: Qty,
}

/// The last action of the leader's copied to this follower, and how it went.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyLast {
    /// The action (`Buy 2 NQZ6 market`, `Flatten everything`, `Resync Evals`).
    pub what: String,
    /// How it went.
    pub outcome: CopyOutcome,
    /// What was sent, or why nothing was (`Buy 1 NQZ6 market · filled`, `Your $1 daily loss limit
    /// is reached: no new positions today. Exits work.`).
    pub text: String,
    /// When.
    pub at: Timestamp,
}

/// One action of the leader's and how copying it went.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyActivity {
    /// The action (`Buy 2 NQZ6 market`, `Resync Evals`, `Flatten everything`).
    pub what: String,
    /// When.
    pub at: Timestamp,
    /// How many accounts it was copied to.
    pub copied: u32,
    /// How many it was for.
    pub of: u32,
    /// The followers it did not reach and why (`Paper 3 skipped: Daily loss limit reached.`), null
    /// when every one copied or had nothing to copy.
    pub detail: Option<String>,
}

/// One follower's sync against its leader.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyFollowerSync {
    /// The follower.
    pub account_id: AccountId,
    /// Its name as shown.
    pub account: String,
    /// Where it stands.
    pub state: SyncState,
    /// Why it is not in sync, in words, null when in sync: `holds Long 3 MNQZ6, should hold Long
    /// 2`, `holds Short 1 ESZ6, the leader is flat`, `positions could not be read: not connected`.
    pub why: Option<String>,
    /// Every contract the leader or this follower holds (mapped), in sync or not.
    pub holdings: Vec<CopyHolding>,
    /// Since when it differs (settling or out of sync), else null.
    pub since: Option<Timestamp>,
    /// The last action of the leader's copied to it this run, and how it went; null until one is.
    pub last: Option<CopyLast>,
}

/// One group's sync: the leader's positions and where each follower stands against them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyGroupSync {
    /// The group.
    pub group_id: String,
    /// The leader.
    pub leader_id: AccountId,
    /// The leader's name as shown.
    pub leader: String,
    /// The leader's open positions: contract and signed qty.
    pub leader_holdings: Vec<LeaderHolding>,
    /// One per follower, paused ones included (the group's paused flag says which).
    pub followers: Vec<CopyFollowerSync>,
    /// How many followers are out of sync or unknown.
    pub out_of_sync: u32,
    /// What copying did for this group this run, newest first (at most 20): every action of the
    /// leader's copied, every resync and every copy.flatten.
    pub recent: Vec<CopyActivity>,
}

/// `copy.sync` payload and `copy.status` output: every group's sync, whole.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopySyncUpdate {
    /// Every group's sync.
    pub groups: Vec<CopyGroupSync>,
    /// When it was checked.
    pub checked_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Mapped {
    pub leader: InstrumentId,
    pub own: InstrumentId,
    pub qty: Decimal,
}

pub(crate) type Held = Vec<(InstrumentId, Decimal)>;

pub(crate) fn holdings(
    f: &CopyFollower,
    mapped: &[Mapped],
    held: &[(InstrumentId, Decimal)],
) -> Vec<CopyHolding> {
    let mut out: Vec<CopyHolding> = Vec::with_capacity(mapped.len() + held.len());
    for m in mapped {
        let target = f.target(m.qty);
        match out.iter_mut().find(|h| h.instrument == m.own) {
            Some(h) => {
                h.leader_qty = Qty((h.leader_qty.0 + m.qty).normalize());
                h.target_qty = Qty((h.target_qty.0 + target).normalize());
            }
            None => out.push(CopyHolding {
                leader_instrument: Some(m.leader.clone()),
                instrument: m.own.clone(),
                leader_qty: Qty(m.qty.normalize()),
                target_qty: Qty(target.normalize()),
                qty: Qty::ZERO,
            }),
        }
    }
    for (i, q) in held.iter().filter(|(_, q)| !q.is_zero()) {
        match out.iter_mut().find(|h| &h.instrument == i) {
            Some(h) => h.qty = Qty((h.qty.0 + q).normalize()),
            None => out.push(CopyHolding {
                leader_instrument: None,
                instrument: i.clone(),
                leader_qty: Qty::ZERO,
                target_qty: Qty::ZERO,
                qty: Qty(q.normalize()),
            }),
        }
    }
    out
}

pub(crate) fn holding_words(qty: Decimal) -> String {
    format!(
        "{} {}",
        if Side::holding(qty) == Some(Side::Sell) {
            "Short"
        } else {
            "Long"
        },
        qty_label(Qty(qty.abs()))
    )
}

pub(crate) fn apart_words(holdings: &[CopyHolding]) -> Option<String> {
    let leader_flat = holdings.iter().all(|h| h.leader_qty.is_zero());
    let parts: Vec<String> = holdings
        .iter()
        .filter(|h| h.apart())
        .map(|h| {
            let symbol = h.instrument.symbol();
            let holds = if h.qty.is_zero() {
                format!("holds no {symbol}")
            } else {
                format!("holds {} {symbol}", holding_words(h.qty.0))
            };
            let should = if !h.target_qty.is_zero() {
                format!("should hold {}", holding_words(h.target_qty.0))
            } else if leader_flat {
                "the leader is flat".to_owned()
            } else {
                "should hold none".to_owned()
            };
            format!("{holds}, {should}")
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Judged {
    pub state: SyncState,
    pub why: Option<String>,
    pub holdings: Vec<CopyHolding>,
    pub since: Option<Timestamp>,
}

type Seat = (String, AccountId);

pub(crate) struct SyncBook {
    apart: Mutex<HashMap<Seat, (Instant, Timestamp)>>,
    lasts: Mutex<HashMap<Seat, CopyLast>>,
    recent: Mutex<HashMap<String, VecDeque<CopyActivity>>>,
    named: Mutex<HashMap<(AccountId, InstrumentId, bool), InstrumentId>>,
    published: Mutex<Option<Vec<CopyGroupSync>>>,
    updates: broadcast::Sender<CopySyncUpdate>,
    nudge: Arc<Notify>,
}

impl Default for SyncBook {
    fn default() -> Self {
        Self {
            apart: Mutex::new(HashMap::new()),
            lasts: Mutex::new(HashMap::new()),
            recent: Mutex::new(HashMap::new()),
            named: Mutex::new(HashMap::new()),
            published: Mutex::new(None),
            updates: broadcast::channel(64).0,
            nudge: Arc::new(Notify::new()),
        }
    }
}

impl SyncBook {
    pub(crate) fn judge(
        &self,
        seat: &Seat,
        reading: Result<Vec<CopyHolding>, String>,
        now: Instant,
        wall: Timestamp,
    ) -> Judged {
        let holdings = match reading {
            Ok(h) => h,
            Err(why) => {
                self.apart.lock().remove(seat);
                return Judged {
                    state: SyncState::Unknown,
                    why: Some(why),
                    holdings: Vec::new(),
                    since: None,
                };
            }
        };
        let Some(why) = apart_words(&holdings) else {
            self.apart.lock().remove(seat);
            return Judged {
                state: SyncState::InSync,
                why: None,
                holdings,
                since: None,
            };
        };
        let (first, since) = *self.apart.lock().entry(seat.clone()).or_insert((now, wall));
        let state = if now.saturating_duration_since(first) < SETTLE {
            SyncState::Settling
        } else {
            SyncState::OutOfSync
        };
        Judged {
            state,
            why: Some(why),
            holdings,
            since: Some(since),
        }
    }

    pub(crate) fn remember(
        &self,
        group: &CopyGroup,
        what: &str,
        report: &CopyReport,
        at: Timestamp,
    ) {
        {
            let mut lasts = self.lasts.lock();
            for r in &report.results {
                lasts.insert(
                    (group.id.clone(), r.account_id.clone()),
                    CopyLast {
                        what: what.to_owned(),
                        outcome: r.outcome,
                        text: r.text.clone(),
                        at,
                    },
                );
            }
        }
        {
            let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
            let mut recent = self.recent.lock();
            let kept = recent.entry(group.id.clone()).or_default();
            kept.push_front(CopyActivity {
                what: what.to_owned(),
                at,
                copied: count(report.copied()),
                of: count(report.results.len()),
                detail: report.missed(),
            });
            kept.truncate(RECENT_KEPT);
        }
        self.nudge.notify_one();
    }

    fn last(&self, seat: &Seat) -> Option<CopyLast> {
        self.lasts.lock().get(seat).cloned()
    }

    fn recent(&self, group: &str) -> Vec<CopyActivity> {
        self.recent
            .lock()
            .get(group)
            .map(|v| v.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn keep_only(&self, groups: &[CopyGroup]) {
        let seats: HashSet<Seat> = groups
            .iter()
            .flat_map(|g| {
                g.followers
                    .iter()
                    .map(|f| (g.id.clone(), f.account_id.clone()))
                    .chain(std::iter::once((g.id.clone(), g.leader_id.clone())))
            })
            .collect();
        self.apart.lock().retain(|s, _| seats.contains(s));
        self.lasts.lock().retain(|s, _| seats.contains(s));
        self.recent
            .lock()
            .retain(|id, _| groups.iter().any(|g| &g.id == id));
    }

    pub(crate) fn updates(&self) -> broadcast::Receiver<CopySyncUpdate> {
        self.updates.subscribe()
    }
}

fn account_of(e: &BrokerEvent) -> Option<&AccountId> {
    match e {
        BrokerEvent::Order(o) => Some(&o.request.account_id),
        BrokerEvent::Fill(f) => Some(&f.account_id),
        BrokerEvent::Position(p) => Some(&p.account_id),
        BrokerEvent::Account(_) | BrokerEvent::Disconnected { .. } => None,
    }
}

impl OrdersService {
    pub fn copy_sync_updates(&self) -> broadcast::Receiver<CopySyncUpdate> {
        self.copying.sync.updates()
    }

    pub async fn copy_status(&self, input: &CopyStatusInput) -> Result<CopySyncUpdate, ToolError> {
        let groups = self.copying.book.groups();
        let groups = match input.group_id.as_deref().map(str::trim) {
            Some(id) => vec![
                groups
                    .into_iter()
                    .find(|g| g.id == id)
                    .ok_or_else(|| ToolError::not_found(format!("no copy group {id}")))?,
            ],
            None => groups,
        };
        Ok(self.sync_of(&groups).await)
    }

    pub(crate) async fn sync_of(&self, groups: &[CopyGroup]) -> CopySyncUpdate {
        let now = Instant::now();
        let names = self.names().await;
        let checked = join_all(groups.iter().map(|g| self.group_sync(g, &names, now))).await;
        CopySyncUpdate {
            groups: checked,
            checked_at: self.clock_ref().now(),
        }
    }

    async fn names(&self) -> HashMap<AccountId, String> {
        self.provider_ref()
            .accounts()
            .await
            .map(|v| v.into_iter().map(|a| (a.id, a.display_name)).collect())
            .unwrap_or_default()
    }

    pub(crate) async fn open_positions(&self, account: &AccountId) -> Result<Held, String> {
        let mut held: Held = self
            .provider_ref()
            .positions(account)
            .await
            .map_err(|e| crate::orders::broker_error(e).message)?
            .into_iter()
            .filter(|p| !p.qty.is_zero())
            .map(|p| (p.instrument, p.qty.0))
            .collect();
        held.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(held)
    }

    async fn group_sync(
        &self,
        g: &CopyGroup,
        names: &HashMap<AccountId, String>,
        now: Instant,
    ) -> CopyGroupSync {
        let name = |a: &AccountId| names.get(a).cloned().unwrap_or_else(|| a.to_string());
        let lead = self.open_positions(&g.leader_id).await;
        let leader_holdings = lead
            .as_ref()
            .map(|v| {
                v.iter()
                    .map(|(i, q)| LeaderHolding {
                        instrument: i.clone(),
                        qty: Qty(q.normalize()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let followers = join_all(g.followers.iter().map(|f| {
            let lead = &lead;
            async move {
                let reading = match lead {
                    Err(why) => Err(format!("the leader's positions could not be read: {why}")),
                    Ok(lead) => self.reading(f, lead).await,
                };
                let seat = (g.id.clone(), f.account_id.clone());
                let judged = self
                    .copying
                    .sync
                    .judge(&seat, reading, now, self.clock_ref().now());
                CopyFollowerSync {
                    account_id: f.account_id.clone(),
                    account: name(&f.account_id),
                    state: judged.state,
                    why: judged.why,
                    holdings: judged.holdings,
                    since: judged.since,
                    last: self.copying.sync.last(&seat),
                }
            }
        }))
        .await;
        let out_of_sync = followers
            .iter()
            .filter(|f| matches!(f.state, SyncState::OutOfSync | SyncState::Unknown))
            .count();
        CopyGroupSync {
            group_id: g.id.clone(),
            leader_id: g.leader_id.clone(),
            leader: name(&g.leader_id),
            leader_holdings,
            followers,
            out_of_sync: u32::try_from(out_of_sync).unwrap_or(u32::MAX),
            recent: self.copying.sync.recent(&g.id),
        }
    }

    pub(crate) async fn reading(
        &self,
        f: &CopyFollower,
        lead: &[(InstrumentId, Decimal)],
    ) -> Result<Vec<CopyHolding>, String> {
        let held = self
            .open_positions(&f.account_id)
            .await
            .map_err(|why| format!("positions could not be read: {why}"))?;
        let mut mapped = Vec::with_capacity(lead.len());
        for (i, q) in lead {
            let own = self.named_contract(f, i).await.map_err(|e| {
                format!(
                    "its contract for {} could not be named: {}",
                    i.symbol(),
                    e.message.trim_end_matches('.')
                )
            })?;
            mapped.push(Mapped {
                leader: i.clone(),
                own,
                qty: *q,
            });
        }
        Ok(holdings(f, &mapped, &held))
    }

    async fn named_contract(
        &self,
        f: &CopyFollower,
        leader: &InstrumentId,
    ) -> Result<InstrumentId, ToolError> {
        let key = (f.account_id.clone(), leader.clone(), f.micro);
        if let Some(own) = self.copying.sync.named.lock().get(&key) {
            return Ok(own.clone());
        }
        let own = self.follower_contract(f, leader.as_str()).await?;
        let mut named = self.copying.sync.named.lock();
        if named.len() >= NAMED_KEPT {
            named.clear();
        }
        named.insert(key, own.clone());
        Ok(own)
    }

    async fn publish_sync(&self) {
        let groups = self.copying.book.groups();
        let now = self.sync_of(&groups).await;
        self.copying.sync.keep_only(&groups);
        {
            let mut published = self.copying.sync.published.lock();
            if published.as_ref() == Some(&now.groups) {
                return;
            }
            *published = Some(now.groups.clone());
        }
        let _ = self.copying.sync.updates.send(now);
    }

    pub(crate) fn start_sync(self: &Arc<Self>) -> JoinHandle<()> {
        let mut events = self.provider_ref().events();
        let mut groups = self.copying.book.changes();
        let nudge = Arc::clone(&self.copying.sync.nudge);
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut every = tokio::time::interval(CHECK_EVERY);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut seen: HashMap<(AccountId, InstrumentId), Decimal> = HashMap::new();
            loop {
                tokio::select! {
                    _ = every.tick() => {}
                    () = nudge.notified() => {}
                    g = groups.recv() => {
                        if matches!(g, Err(broadcast::error::RecvError::Closed)) {
                            return;
                        }
                    }
                    e = events.next() => {
                        let Some(e) = e else { return };
                        let Some(m) = me.upgrade() else { return };
                        if !m.moves_a_group(&e, &mut seen) {
                            continue;
                        }
                        drop(m);
                        let quiet = tokio::time::sleep(QUIET_FOR);
                        tokio::pin!(quiet);
                        loop {
                            tokio::select! {
                                () = &mut quiet => break,
                                more = events.next() => {
                                    if more.is_none() {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
                let Some(m) = me.upgrade() else { return };
                m.publish_sync().await;
            }
        })
    }

    fn moves_a_group(
        &self,
        e: &BrokerEvent,
        seen: &mut HashMap<(AccountId, InstrumentId), Decimal>,
    ) -> bool {
        if let BrokerEvent::Disconnected { .. } = e {
            return true;
        }
        let Some(account) = account_of(e) else {
            return false;
        };
        if !self.copying.book.involves(account) {
            return false;
        }
        match e {
            BrokerEvent::Position(p) => {
                let key = (p.account_id.clone(), p.instrument.clone());
                seen.insert(key, p.qty.0) != Some(p.qty.0)
            }
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(s: &str) -> InstrumentId {
        InstrumentId::new(s).unwrap()
    }

    fn d(s: &str) -> Decimal {
        s.parse().unwrap()
    }

    fn q(s: &str) -> Qty {
        Qty(d(s))
    }

    fn nq(qty: &str) -> Mapped {
        Mapped {
            leader: id("NQZ6.CME"),
            own: id("NQZ6.CME"),
            qty: d(qty),
        }
    }

    fn seat() -> Seat {
        ("cg1".to_owned(), AccountId::new("f"))
    }

    #[test]
    fn a_follower_at_its_size_is_in_sync() {
        let f = CopyFollower::new("f").times(d("0.5"));
        let h = holdings(&f, &[nq("3")], &[(id("NQZ6.CME"), d("2"))]);
        assert_eq!(
            h,
            vec![CopyHolding {
                leader_instrument: Some(id("NQZ6.CME")),
                instrument: id("NQZ6.CME"),
                leader_qty: q("3"),
                target_qty: q("2"),
                qty: q("2"),
            }]
        );
        assert_eq!(apart_words(&h), None);
        assert_eq!(apart_words(&holdings(&f, &[], &[])), None);
    }

    #[test]
    fn a_follower_over_or_under_its_size_says_what_it_holds_and_should() {
        let f = CopyFollower::new("f");
        let over = holdings(&f, &[nq("2")], &[(id("NQZ6.CME"), d("3"))]);
        assert_eq!(
            apart_words(&over).as_deref(),
            Some("holds Long 3 NQZ6, should hold Long 2")
        );
        let under = holdings(&f, &[nq("-2")], &[]);
        assert_eq!(
            apart_words(&under).as_deref(),
            Some("holds no NQZ6, should hold Short 2")
        );
        let other_side = holdings(&f, &[nq("-1")], &[(id("NQZ6.CME"), d("1"))]);
        assert_eq!(
            apart_words(&other_side).as_deref(),
            Some("holds Long 1 NQZ6, should hold Short 1")
        );
    }

    #[test]
    fn a_contract_only_the_follower_holds_should_be_flat() {
        let f = CopyFollower::new("f");
        let h = holdings(&f, &[], &[(id("ESZ6.CME"), d("-1"))]);
        assert_eq!(h[0].leader_instrument, None);
        assert_eq!(h[0].target_qty, Qty::ZERO);
        assert_eq!(
            apart_words(&h).as_deref(),
            Some("holds Short 1 ESZ6, the leader is flat")
        );
        let h = holdings(
            &f,
            &[nq("1")],
            &[(id("NQZ6.CME"), d("1")), (id("ESZ6.CME"), d("-1"))],
        );
        assert_eq!(h.len(), 2);
        assert_eq!(
            apart_words(&h).as_deref(),
            Some("holds Short 1 ESZ6, should hold none")
        );
    }

    #[test]
    fn a_micro_follower_is_weighed_on_its_micro_contract() {
        let f = CopyFollower::new("f").times(d("0.5")).in_micros();
        let mapped = [Mapped {
            leader: id("NQZ6.CME"),
            own: id("MNQZ6.CME"),
            qty: d("4"),
        }];
        let h = holdings(
            &f,
            &mapped,
            &[(id("MNQZ6.CME"), d("3")), (id("NQZ6.CME"), d("1"))],
        );
        assert_eq!(
            h[0],
            CopyHolding {
                leader_instrument: Some(id("NQZ6.CME")),
                instrument: id("MNQZ6.CME"),
                leader_qty: q("4"),
                target_qty: q("2"),
                qty: q("3"),
            }
        );
        assert_eq!(h[1].instrument, id("NQZ6.CME"));
        assert_eq!(h[1].leader_instrument, None);
        assert_eq!(
            apart_words(&h).as_deref(),
            Some("holds Long 3 MNQZ6, should hold Long 2; holds Long 1 NQZ6, should hold none")
        );
    }

    #[test]
    fn unread_positions_are_unknown_never_in_sync() {
        let book = SyncBook::default();
        let j = book.judge(
            &seat(),
            Err("positions could not be read: not connected".into()),
            Instant::now(),
            Timestamp(0),
        );
        assert_eq!(j.state, SyncState::Unknown);
        assert_eq!(
            j.why.as_deref(),
            Some("positions could not be read: not connected")
        );
        assert!(j.holdings.is_empty());
        assert_eq!(j.since, None);
    }

    #[test]
    fn a_follower_apart_settles_for_three_seconds_then_is_out_of_sync() {
        let book = SyncBook::default();
        let f = CopyFollower::new("f");
        let apart = || Ok(holdings(&f, &[nq("1")], &[]));
        let t = Instant::now();
        let j = book.judge(&seat(), apart(), t, Timestamp(7));
        assert_eq!(j.state, SyncState::Settling);
        assert_eq!(j.since, Some(Timestamp(7)));
        let j = book.judge(
            &seat(),
            apart(),
            t + Duration::from_millis(2_900),
            Timestamp(9),
        );
        assert_eq!(j.state, SyncState::Settling);
        assert_eq!(j.since, Some(Timestamp(7)));
        let j = book.judge(&seat(), apart(), t + SETTLE, Timestamp(10));
        assert_eq!(j.state, SyncState::OutOfSync);
        assert_eq!(j.since, Some(Timestamp(7)));
        let j = book.judge(
            &seat(),
            Ok(holdings(&f, &[nq("1")], &[(id("NQZ6.CME"), d("1"))])),
            t + SETTLE,
            Timestamp(10),
        );
        assert_eq!(j.state, SyncState::InSync);
        assert_eq!(j.since, None);
        let j = book.judge(&seat(), apart(), t + SETTLE * 2, Timestamp(20));
        assert_eq!(
            j.state,
            SyncState::Settling,
            "a new difference settles again"
        );
        assert_eq!(j.since, Some(Timestamp(20)));
    }

    #[test]
    fn each_followers_last_copy_and_the_groups_recent_copies_are_kept() {
        let book = SyncBook::default();
        let group = CopyGroup {
            id: "cg1".into(),
            name: "Evals".into(),
            leader_id: AccountId::new("lead"),
            followers: vec![CopyFollower::new("f")],
            enabled: true,
            created_at: Timestamp(0),
            updated_at: Timestamp(0),
        };
        let report = |outcome, text: &str| CopyReport {
            group_id: "cg1".into(),
            group_name: "Evals".into(),
            leader_id: AccountId::new("lead"),
            results: vec![super::super::model::CopyResult {
                account_id: AccountId::new("f"),
                account: "F".into(),
                outcome,
                text: text.into(),
                orders: Vec::new(),
            }],
        };
        assert_eq!(book.last(&seat()), None);
        book.remember(
            &group,
            "Buy 1 NQZ6 market",
            &report(CopyOutcome::Skipped, "Daily loss limit reached."),
            Timestamp(5),
        );
        assert_eq!(
            book.last(&seat()),
            Some(CopyLast {
                what: "Buy 1 NQZ6 market".into(),
                outcome: CopyOutcome::Skipped,
                text: "Daily loss limit reached.".into(),
                at: Timestamp(5),
            })
        );
        assert_eq!(
            book.recent("cg1"),
            vec![CopyActivity {
                what: "Buy 1 NQZ6 market".into(),
                at: Timestamp(5),
                copied: 0,
                of: 1,
                detail: Some("F skipped: Daily loss limit reached.".into()),
            }]
        );
        for n in 0..25 {
            book.remember(
                &group,
                &format!("Buy {n} NQZ6 market"),
                &report(CopyOutcome::Copied, "Buy 1 NQZ6 market · filled"),
                Timestamp(6 + n),
            );
        }
        let recent = book.recent("cg1");
        assert_eq!(recent.len(), 20);
        assert_eq!(recent[0].what, "Buy 24 NQZ6 market", "newest first");
        assert_eq!((recent[0].copied, recent[0].of), (1, 1));
        assert_eq!(recent[0].detail, None);
        assert_eq!(book.last(&seat()).unwrap().outcome, CopyOutcome::Copied);
        book.keep_only(&[]);
        assert_eq!(book.last(&seat()), None);
        assert!(book.recent("cg1").is_empty());
    }
}
