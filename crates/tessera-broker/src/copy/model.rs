use rust_decimal::{Decimal, RoundingStrategy};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::orders::Side;
use tessera_core::{Qty, Timestamp};
use ts_rs::TS;

use crate::paper::engine::qty_label;

pub const MAX_FOLLOWERS: usize = 50;
pub const MAX_MULTIPLIER: Decimal = Decimal::from_parts(10, 0, 0, false, 0);
pub const MIN_MULTIPLIER: Decimal = Decimal::from_parts(1, 0, 0, false, 2);
pub const MAX_FIXED_QTY: i64 = 100;
pub const COPIED_IN_MICROS: [&str; 6] = ["NQ", "ES", "YM", "RTY", "CL", "GC"];

fn one() -> Decimal {
    Decimal::ONE
}

/// One account copying a group's leader, and how its size follows the leader's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CopyFollower {
    /// The follower's account id.
    pub account_id: AccountId,
    /// The position this follower holds is the leader's times this (`0.5`, `1`, `2`; default 1),
    /// rounded to whole contracts: to the nearest, halves up. Not used while `fixedQty` is set.
    #[serde(default = "one", with = "tessera_core::money::decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub multiplier: Decimal,
    /// Holds this many contracts whenever the leader holds any, whatever the leader's size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_qty: Option<Qty>,
    /// Trades the micro of each full-size contract the leader trades (NQ → MNQ, ES → MES, YM → MYM,
    /// RTY → M2K, CL → MCL, GC → MGC), at the same price; other contracts as the leader's. Default
    /// false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>")]
    pub micro: bool,
    /// Copying to this account is paused: the leader's orders skip it until it is resumed; what it
    /// holds stays.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>")]
    pub paused: bool,
}

impl CopyFollower {
    pub fn new(account_id: impl Into<String>) -> Self {
        Self {
            account_id: AccountId::new(account_id.into()),
            multiplier: Decimal::ONE,
            fixed_qty: None,
            micro: false,
            paused: false,
        }
    }

    #[must_use]
    pub fn times(mut self, m: Decimal) -> Self {
        self.multiplier = m;
        self.fixed_qty = None;
        self
    }

    #[must_use]
    pub fn fixed(mut self, qty: i64) -> Self {
        self.fixed_qty = Some(Qty::from(qty));
        self
    }

    #[must_use]
    pub fn in_micros(mut self) -> Self {
        self.micro = true;
        self
    }

    #[must_use]
    pub fn paused(mut self) -> Self {
        self.paused = true;
        self
    }

    pub fn target(&self, leader: Decimal) -> Decimal {
        if leader.is_zero() {
            return Decimal::ZERO;
        }
        let size = match self.fixed_qty {
            Some(q) => q.0,
            None => round_contracts(leader.abs() * self.multiplier),
        };
        if size.is_zero() {
            Decimal::ZERO
        } else if leader.is_sign_negative() {
            -size
        } else {
            size
        }
    }

    pub fn opens(&self, leader_opens: Decimal) -> Decimal {
        self.target(leader_opens).abs()
    }

    pub fn sizing_words(&self) -> String {
        match self.fixed_qty {
            Some(q) => format!("fixed {}", q.0.normalize()),
            None => format!("{}×", self.multiplier.normalize()),
        }
    }
}

pub fn round_contracts(q: Decimal) -> Decimal {
    q.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .max(Decimal::ZERO)
}

/// One leader and the accounts copying it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyGroup {
    /// Id (`cg1`).
    pub id: String,
    /// The user's name for it (`Apex evals`).
    pub name: String,
    /// The account whose orders are copied.
    pub leader_id: AccountId,
    /// The accounts its orders are copied to, each at its own size.
    pub followers: Vec<CopyFollower>,
    /// Copying now. At most one group is on per leader.
    pub enabled: bool,
    /// Created.
    pub created_at: Timestamp,
    /// Last changed.
    pub updated_at: Timestamp,
}

impl CopyGroup {
    pub fn follower(&self, account: &AccountId) -> Option<&CopyFollower> {
        self.followers.iter().find(|f| &f.account_id == account)
    }

    pub fn copying(&self) -> impl Iterator<Item = &CopyFollower> {
        self.followers.iter().filter(|f| !f.paused)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FollowerQty {
    pub close: Decimal,
    pub open: Decimal,
}

impl FollowerQty {
    pub fn is_zero(&self) -> bool {
        self.close.is_zero() && self.open.is_zero()
    }
}

pub fn split(pos: Decimal, side: Side, qty: Decimal, reduce_only: bool) -> (Decimal, Decimal) {
    let against = Side::holding(pos) == Some(side.opposite());
    let closing = if against {
        qty.min(pos.abs())
    } else {
        Decimal::ZERO
    };
    let opening = if reduce_only {
        Decimal::ZERO
    } else {
        qty - closing
    };
    (closing, opening)
}

pub fn leader_after(before: Decimal, side: Side, qty: Decimal, reduce_only: bool) -> Decimal {
    let (closing, opening) = split(before, side, qty, reduce_only);
    before + Decimal::from(side.sign()) * (closing + opening)
}

fn same_side(a: Decimal, b: Decimal) -> bool {
    !a.is_zero() && !b.is_zero() && a.is_sign_positive() == b.is_sign_positive()
}

pub fn follower_qty(
    leader_before: Decimal,
    side: Side,
    qty: Decimal,
    reduce_only: bool,
    follower_pos: Decimal,
    sizing: &CopyFollower,
) -> FollowerQty {
    let after = leader_after(leader_before, side, qty, reduce_only);
    let held_there = on_side(follower_pos, leader_before);
    let size_before = sizing.target(leader_before).abs();
    let size_after = sizing.target(after).abs();
    let crossed = !leader_before.is_zero() && !same_side(after, leader_before);
    if !crossed && after.abs() < leader_before.abs() {
        return FollowerQty {
            close: (size_before - size_after)
                .max(Decimal::ZERO)
                .min(held_there),
            open: Decimal::ZERO,
        };
    }
    let grows_by = size_after - on_side(sizing.target(leader_before), after);
    let short_of = size_after - on_side(follower_pos, after);
    FollowerQty {
        close: if crossed { held_there } else { Decimal::ZERO },
        open: grows_by.min(short_of).max(Decimal::ZERO),
    }
}

fn on_side(qty: Decimal, side_of: Decimal) -> Decimal {
    if same_side(qty, side_of) {
        qty.abs()
    } else {
        Decimal::ZERO
    }
}

pub fn why_nothing(
    leader_before: Decimal,
    side: Side,
    qty: Decimal,
    reduce_only: bool,
    follower_pos: Decimal,
    sizing: &CopyFollower,
    symbol: &str,
) -> String {
    let (closing, opening) = split(leader_before, side, qty, reduce_only);
    let after = leader_after(leader_before, side, qty, reduce_only);
    let size = Qty(sizing.target(after).abs());
    let grows = size.0 > on_side(sizing.target(leader_before), after);
    let held = on_side(follower_pos, after);
    if !opening.is_zero() && size.is_zero() {
        format!(
            "{} at {} rounds to 0 contracts; nothing sent",
            qty_label(Qty(after.abs())),
            sizing.sizing_words()
        )
    } else if !opening.is_zero() && grows && held >= size.0 {
        format!(
            "it holds {} {symbol} already, at or over its size of {}; nothing sent",
            super::sync::holding_words(follower_pos),
            qty_label(size)
        )
    } else if !closing.is_zero() && !same_side(follower_pos, leader_before) {
        format!("no {symbol} position to close; nothing sent")
    } else if !(closing.is_zero() && opening.is_zero()) {
        format!(
            "its size at {} stays {}; nothing sent",
            sizing.sizing_words(),
            qty_label(size)
        )
    } else {
        "nothing to copy".to_owned()
    }
}

/// How one follower's copy went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CopyOutcome {
    /// Sent, and the broker took it.
    Copied,
    /// Refused (its own limits, its order entry, the broker): nothing sent for it, the leader and
    /// the others went on.
    Skipped,
    /// Nothing to copy for it (its size rounds to 0 or stays as it is, no position to close, no
    /// matching order, in sync already, paused).
    Nothing,
    /// No answer in time, or its connection failed: check its orders.
    Unknown,
}

/// One account's part of a copy: a follower's copy of one action of the leader's (for
/// copy.flatten, the leader's own flatten too).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    /// The account.
    pub account_id: AccountId,
    /// Its name as shown (`Eval 3`).
    pub account: String,
    /// How it went.
    pub outcome: CopyOutcome,
    /// What was sent, or why nothing was (`Buy 1 NQZ6 market · filled`, `Daily loss limit
    /// reached`).
    pub text: String,
    /// The follower's orders it sent or changed.
    pub orders: Vec<OrderId>,
}

/// What copying one action of the leader's came to, follower by follower.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    /// The group.
    pub group_id: String,
    /// Its name.
    pub group_name: String,
    /// The leader.
    pub leader_id: AccountId,
    /// Each follower's copy (for copy.flatten the leader's flatten first, when it was flattened).
    pub results: Vec<CopyResult>,
}

impl CopyReport {
    pub fn copied(&self) -> usize {
        self.results
            .iter()
            .filter(|r| r.outcome == CopyOutcome::Copied)
            .count()
    }

    pub fn summary(&self) -> String {
        format!("copied to {} of {}", self.copied(), self.results.len())
    }

    pub fn missed(&self) -> Option<String> {
        let missed: Vec<String> = self
            .results
            .iter()
            .filter_map(|r| {
                let why = r.text.trim_end_matches('.');
                match r.outcome {
                    CopyOutcome::Skipped => Some(format!("{} skipped: {why}", r.account)),
                    CopyOutcome::Unknown => Some(format!("{}: {why}", r.account)),
                    CopyOutcome::Copied | CopyOutcome::Nothing => None,
                }
            })
            .collect();
        (!missed.is_empty()).then(|| format!("{}.", missed.join(". ")))
    }

    pub fn note(&self, what: &str) -> Option<(String, String, &'static str)> {
        if self
            .results
            .iter()
            .all(|r| r.outcome == CopyOutcome::Copied)
        {
            return None;
        }
        Some(self.said(what))
    }

    pub fn said(&self, what: &str) -> (String, String, &'static str) {
        let off: Vec<&CopyResult> = self
            .results
            .iter()
            .filter(|r| r.outcome != CopyOutcome::Copied)
            .collect();
        let tone = if off
            .iter()
            .any(|r| matches!(r.outcome, CopyOutcome::Skipped | CopyOutcome::Unknown))
        {
            "err"
        } else {
            "info"
        };
        let title = format!(
            "{what}: copied to {} of {}",
            self.copied(),
            self.results.len()
        );
        let told = if off.is_empty() {
            self.results.iter().collect()
        } else {
            off
        };
        let detail = told
            .iter()
            .map(|r| {
                let why = r.text.trim_end_matches('.');
                match r.outcome {
                    CopyOutcome::Skipped => format!("{} skipped: {why}", r.account),
                    _ => format!("{}: {why}", r.account),
                }
            })
            .collect::<Vec<_>>()
            .join(". ");
        (title, format!("{detail}."), tone)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CopyNote {
    pub group_id: String,
    pub leader_id: AccountId,
    pub title: String,
    pub detail: String,
    pub tone: String,
    pub ts: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CopyGroupsUpdate {
    pub groups: Vec<CopyGroup>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use Side::{Buy, Sell};

    fn d(s: &str) -> Decimal {
        s.parse().unwrap()
    }

    #[test]
    fn a_follower_in_micros_trades_the_micros_its_description_names() {
        use tessera_core::products::{Product, product};
        let micros: Vec<(&str, &str)> = COPIED_IN_MICROS
            .iter()
            .map(|r| (*r, product(r).and_then(Product::micro).unwrap().root))
            .collect();
        assert_eq!(
            micros,
            [
                ("NQ", "MNQ"),
                ("ES", "MES"),
                ("YM", "MYM"),
                ("RTY", "M2K"),
                ("CL", "MCL"),
                ("GC", "MGC")
            ]
        );
    }

    fn at(m: &str) -> CopyFollower {
        CopyFollower::new("f").times(d(m))
    }

    fn fixed(q: i64) -> CopyFollower {
        CopyFollower::new("f").fixed(q)
    }

    #[test]
    fn a_followers_size_is_the_leaders_position_at_its_sizing_on_the_leaders_side() {
        assert_eq!(at("1").target(d("2")), d("2"));
        assert_eq!(at("0.5").target(d("2")), d("1"));
        assert_eq!(at("0.5").target(d("1")), d("1"));
        assert_eq!(at("0.5").target(d("3")), d("2"));
        assert_eq!(at("1.5").target(d("3")), d("5"));
        assert_eq!(at("2").target(d("-2")), d("-4"));
        assert_eq!(at("0.5").target(d("-3")), d("-2"));
        assert_eq!(at("0.25").target(d("1")), d("0"));
        assert_eq!(at("0.4").target(d("-1")), d("0"));
        assert_eq!(at("1").target(d("0")), d("0"));
        assert_eq!(fixed(3).target(d("1")), d("3"));
        assert_eq!(fixed(3).target(d("-7")), d("-3"));
        assert_eq!(fixed(3).target(d("0")), d("0"));
        assert_eq!(at("0.5").opens(d("3")), d("2"));
        assert_eq!(fixed(3).opens(d("1")), d("3"));
    }

    #[test]
    fn each_leader_move_moves_the_follower_by_what_it_means_at_its_size() {
        let rows = [
            (
                "an entry from flat opens its size",
                "0",
                Buy,
                "2",
                false,
                "0",
                at("0.5"),
                "0",
                "1",
            ),
            (
                "an entry short opens its size",
                "0",
                Sell,
                "3",
                false,
                "0",
                at("2"),
                "0",
                "6",
            ),
            (
                "an add opens what its size grows by",
                "2",
                Buy,
                "1",
                false,
                "4",
                at("2"),
                "0",
                "2",
            ),
            (
                "an add its size does not grow by sends nothing",
                "1",
                Buy,
                "1",
                false,
                "1",
                at("0.5"),
                "0",
                "0",
            ),
            (
                "the next add grows it",
                "2",
                Buy,
                "1",
                false,
                "1",
                at("0.5"),
                "0",
                "1",
            ),
            (
                "a fixed size holds through adds",
                "2",
                Buy,
                "1",
                false,
                "2",
                fixed(2),
                "0",
                "0",
            ),
            (
                "and through partial exits",
                "3",
                Sell,
                "1",
                true,
                "2",
                fixed(2),
                "0",
                "0",
            ),
            (
                "a partial exit closes what its size shrinks by",
                "2",
                Sell,
                "1",
                true,
                "4",
                at("2"),
                "2",
                "0",
            ),
            (
                "a partial exit not marked reduce-only too",
                "3",
                Sell,
                "1",
                false,
                "2",
                at("0.5"),
                "1",
                "0",
            ),
            (
                "a partial exit its size does not shrink by sends nothing",
                "2",
                Sell,
                "1",
                true,
                "1",
                at("0.5"),
                "0",
                "0",
            ),
            (
                "never more than it holds there",
                "3",
                Sell,
                "2",
                true,
                "1",
                at("1"),
                "1",
                "0",
            ),
            (
                "the leader's last exit closes everything there",
                "2",
                Sell,
                "2",
                false,
                "3",
                at("1"),
                "3",
                "0",
            ),
            (
                "whatever its size",
                "2",
                Sell,
                "2",
                true,
                "5",
                fixed(2),
                "5",
                "0",
            ),
            (
                "a reverse closes it and opens its size on the other side",
                "2",
                Sell,
                "4",
                false,
                "1",
                at("0.5"),
                "1",
                "1",
            ),
            (
                "from short too",
                "-2",
                Buy,
                "3",
                false,
                "-2",
                at("1"),
                "2",
                "1",
            ),
            (
                "nothing on the leader's side closes nothing",
                "2",
                Sell,
                "2",
                true,
                "0",
                at("1"),
                "0",
                "0",
            ),
            (
                "the other side closes nothing",
                "2",
                Sell,
                "2",
                true,
                "-1",
                at("1"),
                "0",
                "0",
            ),
            (
                "the other side on a partial exit",
                "2",
                Sell,
                "1",
                true,
                "-1",
                at("1"),
                "0",
                "0",
            ),
            (
                "a reduce-only order on a flat leader sends nothing",
                "0",
                Sell,
                "1",
                true,
                "2",
                at("1"),
                "0",
                "0",
            ),
            (
                "a reverse opens only what a follower on the new side lacks",
                "2",
                Sell,
                "4",
                false,
                "-1",
                at("1"),
                "0",
                "1",
            ),
            (
                "an entry never opens past a follower's size",
                "0",
                Buy,
                "1",
                false,
                "2",
                at("1"),
                "0",
                "0",
            ),
            (
                "an add opens at most the leader's change for one under its size",
                "2",
                Buy,
                "1",
                false,
                "0",
                at("1"),
                "0",
                "1",
            ),
            (
                "an add opens up to the size of one over it",
                "2",
                Buy,
                "2",
                false,
                "3",
                at("1"),
                "0",
                "1",
            ),
        ];
        for (what, before, side, qty, reduce, held, f, close, open) in rows {
            assert_eq!(
                follower_qty(d(before), side, d(qty), reduce, d(held), &f),
                FollowerQty {
                    close: d(close),
                    open: d(open)
                },
                "{what}"
            );
        }
    }

    #[test]
    fn a_follower_at_its_size_stays_at_it_so_rounding_never_drifts() {
        for f in [at("0.5"), at("1.5"), at("2"), fixed(2)] {
            let (mut leader, mut held) = (d("0"), d("0"));
            for (side, qty, reduce) in [
                (Buy, "1", false),
                (Buy, "1", false),
                (Buy, "1", false),
                (Sell, "1", true),
                (Sell, "1", true),
                (Sell, "4", false),
                (Sell, "1", false),
                (Buy, "1", true),
                (Buy, "3", true),
            ] {
                let q = follower_qty(leader, side, d(qty), reduce, held, &f);
                held += Decimal::from(side.sign()) * (q.close + q.open);
                leader = leader_after(leader, side, d(qty), reduce);
                assert_eq!(
                    held,
                    f.target(leader),
                    "{} at leader {leader}",
                    f.sizing_words()
                );
            }
            assert!(leader.is_zero());
        }
    }

    #[test]
    fn a_follower_sent_nothing_is_told_why() {
        let why = |before, side, qty, reduce, held, f: CopyFollower| {
            why_nothing(d(before), side, d(qty), reduce, d(held), &f, "NQZ6")
        };
        assert_eq!(
            why("0", Buy, "1", false, "0", at("0.25")),
            "1 at 0.25× rounds to 0 contracts; nothing sent"
        );
        assert_eq!(
            why("1", Buy, "1", false, "1", at("0.5")),
            "its size at 0.5× stays 1; nothing sent"
        );
        assert_eq!(
            why("3", Sell, "1", true, "2", fixed(2)),
            "its size at fixed 2 stays 2; nothing sent"
        );
        assert_eq!(
            why("2", Sell, "2", true, "0", at("1")),
            "no NQZ6 position to close; nothing sent"
        );
        assert_eq!(why("0", Sell, "1", true, "0", at("1")), "nothing to copy");
        assert_eq!(
            why("0", Buy, "1", false, "2", at("1")),
            "it holds Long 2 NQZ6 already, at or over its size of 1; nothing sent"
        );
        assert_eq!(
            why("2", Sell, "4", false, "-2", at("1")),
            "it holds Short 2 NQZ6 already, at or over its size of 2; nothing sent"
        );
    }

    #[test]
    fn a_paused_follower_is_not_copying() {
        let g = CopyGroup {
            id: "cg1".into(),
            name: "Evals".into(),
            leader_id: AccountId::new("lead"),
            followers: vec![CopyFollower::new("a"), CopyFollower::new("b").paused()],
            enabled: true,
            created_at: Timestamp(0),
            updated_at: Timestamp(0),
        };
        let copying: Vec<&str> = g.copying().map(|f| f.account_id.as_str()).collect();
        assert_eq!(copying, ["a"]);
    }

    #[test]
    fn a_stored_follower_without_micro_or_paused_still_loads_and_stays_without_them() {
        let f: CopyFollower =
            serde_json::from_value(serde_json::json!({ "accountId": "a", "multiplier": 0.5 }))
                .unwrap();
        assert!(!f.micro && !f.paused);
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({ "accountId": "a", "multiplier": 0.5 })
        );
        let f = CopyFollower::new("a").in_micros().paused();
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({ "accountId": "a", "multiplier": 1, "micro": true, "paused": true })
        );
    }

    #[test]
    fn the_note_names_each_follower_that_did_not_copy() {
        let r = |a: &str, outcome, text: &str| CopyResult {
            account_id: AccountId::new(a),
            account: a.to_owned(),
            outcome,
            text: text.to_owned(),
            orders: Vec::new(),
        };
        let mut report = CopyReport {
            group_id: "cg1".into(),
            group_name: "Evals".into(),
            leader_id: AccountId::new("lead"),
            results: vec![
                r("Eval 1", CopyOutcome::Copied, "Buy 1 NQZ6 market"),
                r("Eval 2", CopyOutcome::Skipped, "Daily loss limit reached."),
            ],
        };
        let (title, detail, tone) = report.note("Buy 2 NQZ6").unwrap();
        assert_eq!(title, "Buy 2 NQZ6: copied to 1 of 2");
        assert_eq!(detail, "Eval 2 skipped: Daily loss limit reached.");
        assert_eq!(tone, "err");
        assert_eq!(
            report.missed().as_deref(),
            Some("Eval 2 skipped: Daily loss limit reached.")
        );
        report.results.pop();
        assert_eq!(report.missed(), None);
        assert!(report.note("Buy 2 NQZ6").is_none());
        assert_eq!(
            report.said("Resync Evals"),
            (
                "Resync Evals: copied to 1 of 1".to_owned(),
                "Eval 1: Buy 1 NQZ6 market.".to_owned(),
                "info"
            )
        );
    }
}
