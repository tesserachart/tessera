use std::collections::{HashMap, HashSet};

use parking_lot::RwLock;
use rust_decimal::Decimal;
use tessera_core::Timestamp;
use tessera_core::ids::AccountId;
use tessera_store::Store;
use tokio::sync::broadcast;

use super::model::{
    CopyGroup, CopyGroupsUpdate, CopyNote, MAX_FIXED_QTY, MAX_FOLLOWERS, MAX_MULTIPLIER,
    MIN_MULTIPLIER,
};

pub const STORE_KEY: &str = "copy.groups";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountFacts {
    pub name: String,
    pub cannot_follow: Option<String>,
}

pub fn name_of(facts: &HashMap<AccountId, AccountFacts>, id: &AccountId) -> String {
    facts
        .get(id)
        .map_or_else(|| id.to_string(), |f| f.name.clone())
}

pub fn shape_rules(
    group: &CopyGroup,
    facts: &HashMap<AccountId, AccountFacts>,
) -> Result<(), String> {
    if group.name.trim().is_empty() {
        return Err("Give the group a name.".into());
    }
    if group.name.chars().count() > 60 {
        return Err("A group's name is at most 60 characters.".into());
    }
    if !facts.contains_key(&group.leader_id) {
        return Err(format!("No account {}.", group.leader_id));
    }
    if group.followers.len() > MAX_FOLLOWERS {
        return Err(format!(
            "A group copies to at most {MAX_FOLLOWERS} accounts."
        ));
    }
    let leader = name_of(facts, &group.leader_id);
    let mut seen = HashSet::new();
    for f in &group.followers {
        let Some(info) = facts.get(&f.account_id) else {
            return Err(format!("No account {}.", f.account_id));
        };
        if f.account_id == group.leader_id {
            return Err(format!(
                "{leader} leads this group; it cannot follow it too."
            ));
        }
        if !seen.insert(f.account_id.clone()) {
            return Err(format!("{} is listed twice.", info.name));
        }
        if let Some(why) = &info.cannot_follow {
            return Err(
                format!("{} cannot follow: {}", info.name, why.trim_end_matches('.')) + ".",
            );
        }
        match f.fixed_qty {
            Some(q) => {
                if q.0.fract() != Decimal::ZERO || q.0 < Decimal::ONE || q.0 > MAX_FIXED_QTY.into()
                {
                    return Err(format!(
                        "{}: a fixed size is 1 to {MAX_FIXED_QTY} whole contracts.",
                        info.name
                    ));
                }
            }
            None => {
                if f.multiplier < MIN_MULTIPLIER || f.multiplier > MAX_MULTIPLIER {
                    return Err(format!(
                        "{}: a multiplier is 0.01 to {}.",
                        info.name,
                        MAX_MULTIPLIER.normalize()
                    ));
                }
            }
        }
    }
    Ok(())
}

pub fn on_rules(
    group: &CopyGroup,
    all: &[CopyGroup],
    facts: &HashMap<AccountId, AccountFacts>,
) -> Result<Option<String>, String> {
    if group.followers.is_empty() {
        return Err(format!(
            "{} copies to nobody yet: add a follower first.",
            group.name
        ));
    }
    let replaced = all
        .iter()
        .find(|g| g.enabled && g.id != group.id && g.leader_id == group.leader_id)
        .map(|g| g.id.clone());
    let staying: Vec<&CopyGroup> = all
        .iter()
        .filter(|g| g.enabled && g.id != group.id && g.leader_id != group.leader_id)
        .collect();
    let name = |a: &AccountId| name_of(facts, a);
    if let Some(g) = staying
        .iter()
        .find(|g| g.follower(&group.leader_id).is_some())
    {
        return Err(format!(
            "{} follows {} ({}): an account that follows cannot lead too, as a copy is never \
             copied on.",
            name(&group.leader_id),
            name(&g.leader_id),
            g.name
        ));
    }
    for f in &group.followers {
        if let Some(g) = staying.iter().find(|g| g.leader_id == f.account_id) {
            return Err(format!(
                "{} leads {}: an account that leads cannot follow too, as a copy is never copied \
                 on.",
                name(&f.account_id),
                g.name
            ));
        }
        if let Some(g) = staying.iter().find(|g| g.follower(&f.account_id).is_some()) {
            return Err(format!(
                "{} already copies {} ({}): an account follows one leader at a time.",
                name(&f.account_id),
                name(&g.leader_id),
                g.name
            ));
        }
    }
    Ok(replaced)
}

pub fn stopped_copying(before: &[CopyGroup], after: &[CopyGroup]) -> Vec<(CopyGroup, AccountId)> {
    let copies = |leader: &AccountId, follower: &AccountId| {
        after.iter().any(|g| {
            g.enabled && &g.leader_id == leader && g.copying().any(|f| &f.account_id == follower)
        })
    };
    before
        .iter()
        .filter(|g| g.enabled)
        .flat_map(|g| {
            g.copying()
                .filter(|f| !copies(&g.leader_id, &f.account_id))
                .map(|f| (g.clone(), f.account_id.clone()))
                .collect::<Vec<_>>()
        })
        .collect()
}

pub struct CopyBook {
    groups: RwLock<Vec<CopyGroup>>,
    store: Option<Store>,
    changes: broadcast::Sender<CopyGroupsUpdate>,
    notes: broadcast::Sender<CopyNote>,
}

impl std::fmt::Debug for CopyBook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CopyBook")
            .field("groups", &self.groups.read().len())
            .finish_non_exhaustive()
    }
}

impl Default for CopyBook {
    fn default() -> Self {
        Self::new(None, Vec::new())
    }
}

impl CopyBook {
    pub fn new(store: Option<Store>, groups: Vec<CopyGroup>) -> Self {
        Self {
            groups: RwLock::new(groups),
            store,
            changes: broadcast::channel(64).0,
            notes: broadcast::channel(256).0,
        }
    }

    pub async fn load(store: Option<Store>) -> Self {
        let groups = match &store {
            Some(s) => {
                let s = s.clone();
                match tokio::task::spawn_blocking(move || s.settings().get(STORE_KEY)).await {
                    Ok(Ok(Some(v))) => serde_json::from_value(v).unwrap_or_else(|e| {
                        tracing::warn!(error = %e, "ignoring unreadable copy groups");
                        Vec::new()
                    }),
                    Ok(Ok(None)) => Vec::new(),
                    Ok(Err(e)) => {
                        tracing::warn!(error = %e, "cannot read the copy groups");
                        Vec::new()
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "cannot read the copy groups");
                        Vec::new()
                    }
                }
            }
            None => Vec::new(),
        };
        Self::new(store, groups)
    }

    pub fn groups(&self) -> Vec<CopyGroup> {
        self.groups.read().clone()
    }

    pub fn group(&self, id: &str) -> Option<CopyGroup> {
        self.groups.read().iter().find(|g| g.id == id).cloned()
    }

    pub fn led_by(&self, leader: &AccountId) -> Option<CopyGroup> {
        self.groups
            .read()
            .iter()
            .find(|g| g.enabled && &g.leader_id == leader)
            .cloned()
    }

    pub fn involves(&self, account: &AccountId) -> bool {
        self.groups
            .read()
            .iter()
            .any(|g| &g.leader_id == account || g.follower(account).is_some())
    }

    pub fn next_id(&self) -> String {
        let n = self
            .groups
            .read()
            .iter()
            .filter_map(|g| g.id.strip_prefix("cg").and_then(|n| n.parse::<u64>().ok()))
            .max()
            .unwrap_or(0);
        format!("cg{}", n + 1)
    }

    pub async fn replace(&self, groups: Vec<CopyGroup>) -> Result<(), String> {
        if let Some(store) = &self.store {
            let value = serde_json::to_value(&groups).map_err(|e| e.to_string())?;
            let store = store.clone();
            let now = groups
                .iter()
                .map(|g| g.updated_at)
                .max()
                .unwrap_or(Timestamp(0));
            tokio::task::spawn_blocking(move || store.settings().set(STORE_KEY, &value, now))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("cannot keep the copy groups: {e}"))?;
        }
        *self.groups.write() = groups.clone();
        let _ = self.changes.send(CopyGroupsUpdate { groups });
        Ok(())
    }

    pub fn changes(&self) -> broadcast::Receiver<CopyGroupsUpdate> {
        self.changes.subscribe()
    }

    pub fn notes(&self) -> broadcast::Receiver<CopyNote> {
        self.notes.subscribe()
    }

    pub fn say(&self, note: CopyNote) {
        tracing::info!(group = %note.group_id, title = %note.title, "copy");
        let _ = self.notes.send(note);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::copy::model::CopyFollower;

    fn facts(ids: &[&str]) -> HashMap<AccountId, AccountFacts> {
        ids.iter()
            .map(|id| {
                (
                    AccountId::new(*id),
                    AccountFacts {
                        name: id.to_uppercase(),
                        cannot_follow: None,
                    },
                )
            })
            .collect()
    }

    fn group(id: &str, leader: &str, followers: &[&str], enabled: bool) -> CopyGroup {
        CopyGroup {
            id: id.into(),
            name: format!("group {id}"),
            leader_id: AccountId::new(leader),
            followers: followers.iter().map(|f| CopyFollower::new(*f)).collect(),
            enabled,
            created_at: Timestamp(0),
            updated_at: Timestamp(0),
        }
    }

    #[test]
    fn a_follower_is_a_known_account_listed_once_other_than_the_leader() {
        let f = facts(&["a", "b", "c"]);
        assert!(shape_rules(&group("cg1", "a", &["b", "c"], false), &f).is_ok());
        let e = shape_rules(&group("cg1", "a", &["a"], false), &f).unwrap_err();
        assert_eq!(e, "A leads this group; it cannot follow it too.");
        let e = shape_rules(&group("cg1", "a", &["b", "b"], false), &f).unwrap_err();
        assert_eq!(e, "B is listed twice.");
        let e = shape_rules(&group("cg1", "a", &["z"], false), &f).unwrap_err();
        assert_eq!(e, "No account z.");
    }

    #[test]
    fn a_read_only_or_order_entry_off_account_cannot_follow() {
        let mut f = facts(&["a", "b"]);
        f.get_mut(&AccountId::new("b")).unwrap().cannot_follow =
            Some("order entry is off for this account; turn it on in Accounts".into());
        let e = shape_rules(&group("cg1", "a", &["b"], false), &f).unwrap_err();
        assert_eq!(
            e,
            "B cannot follow: order entry is off for this account; turn it on in Accounts."
        );
    }

    #[test]
    fn sizes_stay_in_range() {
        let f = facts(&["a", "b"]);
        let mut g = group("cg1", "a", &["b"], false);
        g.followers[0] = CopyFollower::new("b").times(Decimal::new(11, 0));
        assert!(shape_rules(&g, &f).unwrap_err().contains("multiplier"));
        g.followers[0] = CopyFollower::new("b").fixed(0);
        assert!(shape_rules(&g, &f).unwrap_err().contains("fixed size"));
        g.followers[0] = CopyFollower::new("b").fixed(2);
        assert!(shape_rules(&g, &f).is_ok());
    }

    #[test]
    fn one_group_is_on_per_leader_and_turning_one_on_turns_the_other_off() {
        let f = facts(&["a", "b", "c"]);
        let on = group("cg1", "a", &["b"], true);
        let other = group("cg2", "a", &["c"], false);
        let all = vec![on, other.clone()];
        assert_eq!(on_rules(&other, &all, &f), Ok(Some("cg1".into())));
    }

    #[test]
    fn an_account_follows_one_leader_at_a_time() {
        let f = facts(&["a", "b", "c"]);
        let all = vec![
            group("cg1", "a", &["c"], true),
            group("cg2", "b", &["c"], false),
        ];
        let e = on_rules(&all[1], &all, &f).unwrap_err();
        assert_eq!(
            e,
            "C already copies A (group cg1): an account follows one leader at a time."
        );
    }

    #[test]
    fn an_account_leads_or_follows_never_both_so_copies_never_go_round() {
        let f = facts(&["a", "b", "c"]);
        let all = vec![
            group("cg1", "a", &["b"], true),
            group("cg2", "b", &["a"], false),
        ];
        let e = on_rules(&all[1], &all, &f).unwrap_err();
        assert_eq!(
            e,
            "B follows A (group cg1): an account that follows cannot lead too, as a copy is never \
             copied on."
        );
        let all = vec![
            group("cg1", "a", &["b"], true),
            group("cg2", "b", &["c"], false),
        ];
        assert!(
            on_rules(&all[1], &all, &f)
                .unwrap_err()
                .contains("follows A")
        );
        let all = vec![
            group("cg1", "b", &["c"], true),
            group("cg2", "a", &["b"], false),
        ];
        let e = on_rules(&all[1], &all, &f).unwrap_err();
        assert_eq!(
            e,
            "B leads group cg1: an account that leads cannot follow too, as a copy is never \
             copied on."
        );
        let all = vec![
            group("cg1", "a", &["b"], false),
            group("cg2", "b", &["c"], false),
        ];
        assert_eq!(on_rules(&all[1], &all, &f), Ok(None));
    }

    #[test]
    fn a_follower_stops_copying_when_paused_removed_or_its_group_goes_off() {
        let stopped = |before: &[CopyGroup], after: &[CopyGroup]| -> Vec<(String, String)> {
            stopped_copying(before, after)
                .into_iter()
                .map(|(g, f)| (g.id, f.to_string()))
                .collect()
        };
        let on = group("cg1", "a", &["b", "c"], true);
        assert!(stopped(std::slice::from_ref(&on), std::slice::from_ref(&on)).is_empty());
        let mut paused = on.clone();
        paused.followers[0] = CopyFollower::new("b").paused();
        assert_eq!(
            stopped(std::slice::from_ref(&on), std::slice::from_ref(&paused)),
            [("cg1".to_owned(), "b".to_owned())]
        );
        assert!(
            stopped(std::slice::from_ref(&paused), std::slice::from_ref(&on)).is_empty(),
            "resumed"
        );
        let removed = group("cg1", "a", &["c"], true);
        assert_eq!(
            stopped(std::slice::from_ref(&on), &[removed]),
            [("cg1".to_owned(), "b".to_owned())]
        );
        let off = group("cg1", "a", &["b", "c"], false);
        assert_eq!(stopped(std::slice::from_ref(&on), &[off]).len(), 2);
        assert_eq!(stopped(std::slice::from_ref(&on), &[]).len(), 2, "deleted");
        let new_leader = group("cg1", "d", &["b", "c"], true);
        assert_eq!(stopped(std::slice::from_ref(&on), &[new_leader]).len(), 2);
        let other = group("cg2", "a", &["b"], true);
        let replaced = group("cg1", "a", &["b", "c"], false);
        assert_eq!(
            stopped(std::slice::from_ref(&on), &[replaced, other]),
            [("cg1".to_owned(), "c".to_owned())],
            "b still copies a in the group that replaced it"
        );
        assert!(
            stopped(&[group("cg1", "a", &["b"], false)], &[]).is_empty(),
            "an off group copied nothing"
        );
    }

    #[test]
    fn a_group_on_copies_to_somebody() {
        let f = facts(&["a"]);
        let g = group("cg1", "a", &[], false);
        assert!(
            on_rules(&g, std::slice::from_ref(&g), &f)
                .unwrap_err()
                .contains("add a follower")
        );
    }
}
