use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::ids::AccountId;
use tessera_core::{Qty, Timestamp};
use ts_rs::TS;

use super::model::{CopyFollower, CopyReport};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CopyListInput {
    /// Only the groups this account leads or follows (all when left out).
    #[serde(default)]
    pub account_id: Option<String>,
}

/// One follower as listed: its sizing and whether it can follow now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyFollowerView {
    /// Account id.
    pub account_id: AccountId,
    /// Its name as shown.
    pub account: String,
    /// It holds the leader's position times this, unless `fixedQty` is set.
    #[serde(with = "tessera_core::money::decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub multiplier: Decimal,
    /// It holds this many contracts whenever the leader holds any, instead.
    pub fixed_qty: Option<Qty>,
    /// `1×`, `0.5×`, `fixed 2`.
    pub sizing: String,
    /// Trades the micro of each full-size contract the leader trades.
    pub micro: bool,
    /// Copying to it is paused.
    pub paused: bool,
    /// Why it cannot take orders now (order entry off, read-only); its copies are skipped until it
    /// can. Null when it can.
    pub cannot_follow: Option<String>,
}

/// One copy group as listed, with names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyGroupView {
    /// Id (`cg1`).
    pub id: String,
    /// The user's name for it.
    pub name: String,
    /// The leader.
    pub leader_id: AccountId,
    /// Its name as shown.
    pub leader: String,
    /// Copying now.
    pub enabled: bool,
    /// The followers.
    pub followers: Vec<CopyFollowerView>,
    /// Created.
    pub created_at: Timestamp,
    /// Last changed.
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyListOutput {
    /// The groups, in the order they were made.
    pub groups: Vec<CopyGroupView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CopyCreateInput {
    /// Its name (default `Copy <leader>`).
    #[serde(default)]
    pub name: Option<String>,
    /// The account whose orders are copied.
    pub leader_id: String,
    /// The accounts they are copied to (none yet is fine; the group stays off until one is added).
    #[serde(default)]
    pub followers: Vec<CopyFollower>,
    /// On at once (default false).
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// `copy.update` input: what changes (followers are replaced whole).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CopyUpdateInput {
    /// The group.
    pub group_id: String,
    /// A new name.
    #[serde(default)]
    pub name: Option<String>,
    /// A new leader.
    #[serde(default)]
    pub leader_id: Option<String>,
    /// Every follower, as it should be now.
    #[serde(default)]
    pub followers: Option<Vec<CopyFollower>>,
}

/// `copy.enable`, `copy.disable` and `copy.delete` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyGroupIdInput {
    /// The group.
    pub group_id: String,
}

/// `copy.create`, `copy.update`, `copy.enable` and `copy.disable` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyGroupOutput {
    /// The group now.
    pub group: CopyGroupView,
    /// What the user should know: the leader's other group turned off, a follower already in a
    /// position (out of sync until resynced), the leader already in one, and each working copy
    /// of a leader order cancelled on a follower that stopped copying (paused, removed, its group
    /// off): `Cancelled Paper 2's working copy of Buy 2 NQZ6 limit 20,600.00.`
    pub said: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyDeleteOutput {
    /// The group deleted.
    pub group_id: String,
    /// Its name.
    pub name: String,
    /// What the user should know: each follower's working copy of a leader order that was
    /// cancelled as the group went (`Cancelled Paper 2's working copy of Buy 2 NQZ6 limit
    /// 20,600.00.`).
    pub said: Vec<String>,
}

/// What an approval shows of the copies an order on a leader account makes (`copies` in its
/// preview): the approval covers these accounts and no others.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyPreview {
    /// The group.
    pub group_id: String,
    /// Its name.
    pub group_name: String,
    /// The followers' names.
    pub accounts: Vec<String>,
    /// `and 6 accounts by copy`.
    pub words: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CopyStatusInput {
    /// Only this group (all when left out).
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CopyResyncInput {
    /// The group.
    pub group_id: String,
    /// Only this follower (every follower out of sync when left out).
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CopyFlattenInput {
    /// The group.
    pub group_id: String,
    /// Only this account, the leader or a follower (the leader and every follower when left out).
    #[serde(default)]
    pub account_id: Option<String>,
}

/// `copy.resync` and `copy.flatten` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyActionOutput {
    /// What it came to, account by account.
    pub report: CopyReport,
}
