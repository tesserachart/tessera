use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::accounts::RiskStatus;
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::instrument::{ContractMonth, ContractSpec, ExchangeContract, Instrument};
use tessera_core::limits::{LimitsSetting, LimitsStatus, LockKind, LockSpan, LockedBy};
use tessera_core::orders::{Bracket, Fill, Order, OrderType, Position, Side, TimeInForce};
use tessera_core::{Price, Qty, Timestamp};
use tessera_protocol::topics::AccountUpdate;
use ts_rs::TS;

use crate::copy::CopyReport;

/// One order as the trader writes it: `orders.preview`, `orders.submit` and `orders.create_draft`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct OrderInput {
    /// Account id (`paper-main`, `rithmic-apex:APEX-123`).
    pub account_id: String,
    /// Instrument id or symbol. The order trades the account's own connection's contract of it
    /// (the same exchange, root and month), whatever connection's id is given.
    pub instrument: String,
    /// Side.
    pub side: Side,
    /// Quantity (contracts or shares; decimal for crypto).
    pub qty: Qty,
    /// Order type.
    pub order_type: OrderType,
    /// Limit price (limit and stop-limit).
    #[serde(default)]
    pub limit_price: Option<Price>,
    /// Stop trigger price (stop and stop-limit).
    #[serde(default)]
    pub stop_price: Option<Price>,
    /// Time in force (default `day`).
    #[serde(default)]
    pub tif: Option<TimeInForce>,
    /// Stop and target attached to the entry, working once it fills (one OCO pair).
    #[serde(default)]
    pub bracket: Option<Bracket>,
    /// Exit only: reduces the position, never opens or flips it. A reduce-only order is an exit,
    /// which the user can always send (it is never covered). A resting reduce-only stop, stop
    /// limit or limit is cancelled once the position is flat or has reversed.
    #[serde(default)]
    pub reduce_only: Option<bool>,
    /// Client order id (idempotent at the broker; defaults to the call's idempotency key).
    #[serde(default)]
    pub client_order_id: Option<String>,
}

/// `orders.submit` (and an approved `orders.create_draft`) output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubmitOutput {
    /// The order as the broker acknowledged it (working, partially filled or filled).
    pub order: Order,
    /// Its bracket's stop and target (held until the entry fills).
    pub bracket: Vec<Order>,
    /// What copying it to the accounts following this one came to, when it leads a copy group
    /// that is on (`crate::copy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub copies: Option<CopyReport>,
}

/// `orders.modify` input. At least one change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ModifyOrderInput {
    /// Account id.
    pub account_id: String,
    /// The order.
    pub order_id: OrderId,
    /// New quantity (entries; a bracket follows its entry).
    #[serde(default)]
    pub qty: Option<Qty>,
    /// New limit price.
    #[serde(default)]
    pub limit_price: Option<Price>,
    /// New stop price. Tightening a protective stop is an exit (never covered); moving it away is
    /// weighed against the trader's limits while one is on.
    #[serde(default)]
    pub stop_price: Option<Price>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelOrderInput {
    /// Account id.
    pub account_id: String,
    /// The order.
    pub order_id: OrderId,
}

/// One order after a change (`orders.modify`, `orders.cancel`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrderOutput {
    /// The order.
    pub order: Order,
    /// What copying it to the accounts following this one came to, when it leads a copy group
    /// that is on (`crate::copy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub copies: Option<CopyReport>,
}

/// `orders.cancel_all` and `orders.flatten` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AccountScopeInput {
    /// Account id.
    pub account_id: String,
    /// Only this instrument (id or symbol); all of the account's instruments when absent.
    #[serde(default)]
    pub instrument: Option<String>,
}

/// `orders.cancel_all` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CancelAllInput {
    /// Account id.
    pub account_id: String,
    /// Only this instrument (id or symbol); all of the account's instruments when absent.
    #[serde(default)]
    pub instrument: Option<String>,
    /// Leave each open position's own stops and targets working (the Trade panel's Cancel): entries go with their
    /// legs, and so does every other order; the position stays protected. Default false: every working order goes.
    #[serde(default)]
    pub keep_protection: Option<bool>,
}

impl CancelAllInput {
    pub fn scope(&self) -> AccountScopeInput {
        AccountScopeInput {
            account_id: self.account_id.clone(),
            instrument: self.instrument.clone(),
        }
    }
}

/// `orders.cancel_all` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CancelAllOutput {
    /// The orders cancelled (bracket children included).
    pub cancelled: Vec<Order>,
    /// What copying it to the accounts following this one came to, when it leads a copy group
    /// that is on (`crate::copy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub copies: Option<CopyReport>,
}

/// `orders.flatten` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FlattenOutput {
    /// The working orders cancelled first.
    pub cancelled: Vec<Order>,
    /// The reduce-only market orders that closed the positions.
    pub closing: Vec<Order>,
    /// True when no position is left in scope.
    pub flat: bool,
    /// What copying it to the accounts following this one came to, when it leads a copy group
    /// that is on (`crate::copy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub copies: Option<CopyReport>,
}

/// `orders.merge_brackets` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutput {
    /// What was done (`Merged 3 brackets into one for 31`).
    pub summary: String,
    /// The orders working on the contract after it.
    pub orders: Vec<Order>,
}

/// `orders.breakeven` input: the position to move to breakeven.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct BreakevenStopInput {
    /// Account id.
    pub account_id: String,
    /// The position's instrument (id or symbol).
    pub instrument: String,
    /// Ticks beyond the average entry, toward profit (the Trade panel sends its bracket's
    /// breakeven offset while its rule is on). Left out: the offset of the breakeven rule the
    /// position's stops carry, else 0.
    #[serde(default)]
    pub offset_ticks: Option<u32>,
}

/// `orders.breakeven` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BreakevenStopOutput {
    /// What was done (`Moved the stop to breakeven, 20,601.25 (the entry + 1 tick)`, or `Placed a
    /// stop at breakeven, 20,601.25 (the entry + 1 tick)` for a position that had none).
    pub summary: String,
    /// Where the stops went: the average entry plus the offset, on the tick toward profit.
    pub price: Price,
    /// The position's average entry.
    pub entry: Price,
    /// The offset in ticks.
    pub offset_ticks: u32,
    /// The stops moved, as the broker answered.
    pub moved: Vec<Order>,
    /// The stop sent for a position that had none: reduce-only, for the whole position, at
    /// `price`, as the broker answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placed: Option<Order>,
    /// Stops already at or past breakeven, left where they were.
    pub kept: u32,
    /// What copying it to the accounts following this one came to, when it leads a copy group
    /// that is on (`crate::copy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub copies: Option<CopyReport>,
}

/// `orders.reverse` input: the position to turn around.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ReverseInput {
    /// Account id.
    pub account_id: String,
    /// The position's instrument (id or symbol).
    pub instrument: String,
    /// The new side's stop and target, priced for the new side (a short's stop above the market,
    /// its target below), as `orders.submit` takes them: the Trade panel sends its bracket. Left
    /// out: the new side goes without one.
    #[serde(default)]
    pub bracket: Option<Bracket>,
}

/// `orders.reverse` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReverseOutput {
    /// What was done (`Reversed long 2 NQZ6 to short 2`).
    pub summary: String,
    /// The new side.
    pub side: Side,
    /// Its size: the position's when it was reversed.
    pub qty: Qty,
    /// The position's working orders cancelled first (its old stop and target among them).
    pub cancelled: Vec<Order>,
    /// The reduce-only market order that closed the old side.
    pub closing: Order,
    /// The market order that opened the new side.
    pub entry: Order,
    /// The new side's stop and target (held until the entry fills).
    pub bracket: Vec<Order>,
    /// What copying it to the accounts following this one came to, when it leads a copy group
    /// that is on (`crate::copy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub copies: Option<CopyReport>,
}

/// `portfolio.get_accounts` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetAccountsInput {}

/// `portfolio.get_accounts` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountsOutput {
    /// Every account: name and environment, summary, prop standing.
    pub accounts: Vec<AccountUpdate>,
}

/// `portfolio.get_positions`, `portfolio.get_risk_status` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AccountFilterInput {
    /// One account; every account when absent.
    #[serde(default)]
    pub account_id: Option<String>,
}

/// `portfolio.get_positions` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PositionsOutput {
    /// Open positions.
    pub positions: Vec<Position>,
}

/// `portfolio.get_orders` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetOrdersInput {
    /// One account; every account when absent.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Only orders still working or held (default false: today's finished ones too).
    #[serde(default)]
    pub open_only: Option<bool>,
}

/// `portfolio.get_orders` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrdersOutput {
    /// Orders, oldest first.
    pub orders: Vec<Order>,
}

/// `portfolio.get_fills` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetFillsInput {
    /// One account; every account when absent.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Fills at or after this time (default: the start of the trading day).
    #[serde(default)]
    pub since: Option<Timestamp>,
}

/// `portfolio.get_fills` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FillsOutput {
    /// Fills, oldest first.
    pub fills: Vec<Fill>,
}

/// `portfolio.get_risk_status` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RiskStatusInput {
    /// Account id.
    pub account_id: String,
}

/// `portfolio.get_risk_status` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RiskStatusOutput {
    /// The rules the account's prop firm's platform reports, as reported; `null` without them.
    /// Informational unless the user holds the account to them (`useFirmLimits`).
    pub risk: Option<RiskStatus>,
    /// Where the account stands against the trader's own limits; `null` while none is on.
    pub limits: Option<LimitsStatus>,
}

/// `risk.get_limits` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetLimitsInput {
    /// One account (all when left out).
    #[serde(default)]
    pub account_id: Option<String>,
}

/// One account under the trader's limits.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountLimits {
    /// Account id.
    pub account_id: AccountId,
    /// Its name as shown.
    pub display_name: String,
    /// It has limits of its own (else every account's).
    pub own: bool,
    /// Where it stands against the limits it is held to; `null` while none is on.
    pub status: Option<LimitsStatus>,
    /// The rules its prop firm's platform reports (informational unless `useFirmLimits`).
    pub firm: Option<RiskStatus>,
}

/// `risk.get_limits` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LimitsOutput {
    /// The limits as the user set them (the setting `risk.limits`).
    pub setting: LimitsSetting,
    /// Each account, with where it stands.
    pub accounts: Vec<AccountLimits>,
}

/// `orders.contract_for` input: what is meant, for one account. Give `instrument` (a contract as a
/// chart or any connection names it, or a symbol or root, `NQ` for the front month) and, for its
/// family sibling, `root` (`MNQ` for an NQ contract: the same exchange and month); or give
/// `exchange`, `root` and `expiry` without an instrument.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ContractForInput {
    /// The account whose connection names the contract.
    pub account_id: String,
    /// What is meant: `NQZ6.CME`, `NQZ6.CME-RITHMIC`, `NQZ6`, `NQ`.
    #[serde(default)]
    pub instrument: Option<String>,
    /// The exchange (`CME`), when no instrument is given.
    #[serde(default)]
    pub exchange: Option<String>,
    /// The root (`MNQ`): with an instrument, its family sibling of this root; without, the root
    /// meant.
    #[serde(default)]
    pub root: Option<String>,
    /// The contract month (`2026-12`), when no instrument is given.
    #[serde(default)]
    pub expiry: Option<ContractMonth>,
}

/// `orders.contract_for` output: the contract the account trades for what was meant, or why none.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContractForOutput {
    /// The account.
    pub account_id: AccountId,
    /// The account in words: its name and its connection (`TEST-000001 (Test · Rithmic)`).
    pub account: String,
    /// The exchange contract meant (`CME MNQ 2026-12`); null when the input names nothing.
    pub wanted: Option<ExchangeContract>,
    /// The account's connection's own instrument for it: what an order for it sends. Null when
    /// refused.
    pub instrument: Option<Instrument>,
    /// Its contract spec.
    pub spec: Option<ContractSpec>,
    /// Why the account cannot trade it, in words naming the account and the contract; null when
    /// it can.
    pub refused: Option<String>,
}

/// `risk.get_lock` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetLockInput {
    /// Account id.
    pub account_id: String,
    /// The contract whose exchange's clock the times follow (`NQZ6.CME`); CME equity index
    /// futures' (New York) when left out.
    #[serde(default)]
    pub instrument: Option<String>,
}

/// A lock on an account's new entries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LockState {
    /// What holds it.
    pub kind: LockKind,
    /// Set at.
    pub since: Timestamp,
    /// New entries work again at.
    pub until: Timestamp,
    /// Who set it, for a manual lock.
    pub by: Option<LockedBy>,
    /// The span it was set for, for a manual lock.
    pub span: Option<LockSpan>,
    /// The lock in the trader's words, times in the user's time zone. Relay it as is.
    pub words: String,
    /// The trader may lift it now, in the app, by typing UNLOCK: a manual lock while early unlock
    /// is allowed (`risk.limits` `allowEarlyUnlock`). Never by an agent.
    pub liftable: bool,
}

/// One way to lock the account now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LockOption {
    /// The span to pass to `risk.lock_account`.
    pub span: LockSpan,
    /// As the app labels it (`15 min`, `Rest of the New York session`).
    pub label: String,
    /// When the lock would end if set now; null when it cannot be set now.
    pub until: Option<Timestamp>,
    /// Why it cannot be set now, when not.
    pub unavailable: Option<String>,
}

/// `risk.get_lock` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountLockOutput {
    /// Account.
    pub account_id: AccountId,
    /// Its name as shown.
    pub display_name: String,
    /// The lock holding now (the one ending last when two hold); null when entries are open.
    pub lock: Option<LockState>,
    /// What each span would lock until, set now.
    pub options: Vec<LockOption>,
    /// The time zone the spans' clock times are in (the exchange's: `America/New_York` for CME).
    pub exchange_zone: String,
    /// What a lock does to the account's copy group, when it is in one that is on.
    pub copy: Option<String>,
    /// As of.
    pub as_of: Timestamp,
}

/// `risk.lock_account` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LockAccountInput {
    /// Account id.
    pub account_id: String,
    /// How long (from `risk.get_lock` `options`).
    pub span: LockSpan,
    /// The contract whose exchange's clock the span follows (`NQZ6.CME`); CME equity index
    /// futures' (New York) when left out.
    #[serde(default)]
    pub instrument: Option<String>,
}

/// `risk.lock_account` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LockAccountOutput {
    /// Account.
    pub account_id: AccountId,
    /// The lock holding now.
    pub lock: LockState,
    /// False when a lock already held as long or longer: nothing changed (a lock is never
    /// shortened).
    pub extended: bool,
    /// Working entry orders it cancelled (with their copies on followers). Stops, targets and
    /// other exits stay.
    pub cancelled: Vec<OrderId>,
    /// What it does to the account's copy group, when it is in one that is on.
    pub copy: Option<String>,
    /// The outcome in one sentence.
    pub summary: String,
}

/// `risk.unlock_account` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlockAccountInput {
    /// Account id.
    pub account_id: String,
    /// The trader's typed confirmation: `UNLOCK`.
    pub confirm: String,
}

/// `risk.unlock_account` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnlockAccountOutput {
    /// Account.
    pub account_id: AccountId,
    /// The lock lifted.
    pub lifted: LockState,
}
