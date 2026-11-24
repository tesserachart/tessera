use std::fmt::Write as _;

use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::accounts::Environment;
use crate::ids::{AccountId, ApprovalId, DraftId, FillId, OrderId};
use crate::instrument::{ContractSpec, InstrumentId, SpecError};
use crate::money::{Money, Price, Qty, Rounding};
use crate::origin::Origin;
use crate::time::Timestamp;

/// Order side.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn holding(signed_qty: Decimal) -> Option<Side> {
        match signed_qty.cmp(&Decimal::ZERO) {
            std::cmp::Ordering::Greater => Some(Side::Buy),
            std::cmp::Ordering::Less => Some(Side::Sell),
            std::cmp::Ordering::Equal => None,
        }
    }

    pub fn sign(self) -> i64 {
        match self {
            Side::Buy => 1,
            Side::Sell => -1,
        }
    }

    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Side::Buy => "BUY",
            Side::Sell => "SELL",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrderType {
    Market,
    Limit,
    /// Stop (market on trigger).
    Stop,
    StopLimit,
}

impl OrderType {
    pub fn abbrev(self) -> &'static str {
        match self {
            OrderType::Market => "MKT",
            OrderType::Limit => "LMT",
            OrderType::Stop => "STP",
            OrderType::StopLimit => "STP LMT",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimeInForce {
    Day,
    /// Good till cancelled.
    Gtc,
    /// Immediate or cancel.
    Ioc,
    /// Fill or kill.
    Fok,
}

impl TimeInForce {
    pub fn label(self) -> &'static str {
        match self {
            TimeInForce::Day => "DAY",
            TimeInForce::Gtc => "GTC",
            TimeInForce::Ioc => "IOC",
            TimeInForce::Fok => "FOK",
        }
    }
}

/// Attached exit orders, activated on fill.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Bracket {
    /// Protective stop price.
    pub stop_loss: Option<Price>,
    /// Profit target price.
    pub take_profit: Option<Price>,
    /// The stop as a distance instead of a price: this many ticks from the price the entry
    /// fills at, placed there once it fills. Not with `stopLoss`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stop_ticks: Option<u32>,
    /// The target as a distance instead of a price: this many ticks from the price the entry
    /// fills at, placed there once it fills. Not with `takeProfit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_ticks: Option<u32>,
    /// Breakeven: once the trade is `triggerTicks` in profit, the stop moves to the entry's
    /// average fill price plus `offsetTicks` (locked in). Needs a stop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub breakeven: Option<BreakevenRule>,
    /// Trailing stop: once the trade is `triggerTicks` in profit, the stop follows the best trade
    /// price since the entry filled, `distanceTicks` behind it, `stepTicks` at a time, and only ever
    /// tightens. Needs a stop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trail: Option<TrailRule>,
}

impl Bracket {
    pub fn is_empty(&self) -> bool {
        !self.has_legs() && !self.has_stop_rules()
    }

    pub fn has_legs(&self) -> bool {
        self.has_stop() || self.take_profit.is_some() || self.target_ticks.is_some()
    }

    pub fn has_stop(&self) -> bool {
        self.stop_loss.is_some() || self.stop_ticks.is_some()
    }

    pub fn has_stop_rules(&self) -> bool {
        self.breakeven.is_some() || self.trail.is_some()
    }

    pub fn in_ticks(&self) -> bool {
        self.stop_ticks.is_some() || self.target_ticks.is_some()
    }

    pub fn priced_from(&self, side: Side, entry: Price, tick: Decimal) -> Bracket {
        let away = |ticks: u32, up: bool| {
            let d = tick * Decimal::from(ticks);
            Price(if up { entry.0 + d } else { entry.0 - d })
        };
        let long = side == Side::Buy;
        Bracket {
            stop_loss: self.stop_loss.or(self.stop_ticks.map(|n| away(n, !long))),
            take_profit: self
                .take_profit
                .or(self.target_ticks.map(|n| away(n, long))),
            stop_ticks: None,
            target_ticks: None,
            ..*self
        }
    }
}

/// A bracket's breakeven rule: when a trade prints `trigger_ticks` or more in the position's
/// favour (from the entry's average fill price), the stop moves to the entry plus `offset_ticks`
/// in its favour (long: entry + offset; short: entry − offset), once, and only if that tightens it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BreakevenRule {
    /// Profit, in ticks from the entry, that fires the move (at least 1).
    pub trigger_ticks: u32,
    /// Ticks locked in beyond the entry (0: the entry itself); below the trigger.
    pub offset_ticks: u32,
}

/// A bracket's trailing rule: once the best trade price since the entry filled is `trigger_ticks`
/// or more in the position's favour (0: from the fill), the stop follows that best price
/// `distance_ticks` behind it, moving in whole steps of `step_ticks`, and only ever tightens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrailRule {
    /// How far behind the best price the stop follows, in ticks (at least 1).
    pub distance_ticks: u32,
    /// Profit, in ticks from the entry, before the stop starts to follow (0: from the fill).
    pub trigger_ticks: u32,
    /// The stop moves only in whole steps of this many ticks (at least 1; 1 is every tick).
    pub step_ticks: u32,
}

/// What a bracket's stop does by itself once its entry fills, carried on the stop order so it
/// outlives its entry (which leaves the book at the day's end) and survives a restart.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub struct StopRules {
    /// The bracket's breakeven rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub breakeven: Option<BreakevenRule>,
    /// The bracket's trailing rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trail: Option<TrailRule>,
    /// The entry's average fill price, breakeven's reference (absent until the entry fills).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub entry_price: Option<Price>,
    /// The best trade price since the entry filled, the price the trail follows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub best_price: Option<Price>,
    /// True once breakeven fired (it fires once, moving the stop only if that tightened it).
    #[serde(default)]
    pub breakeven_done: bool,
}

impl StopRules {
    pub fn of(bracket: &Bracket) -> Option<StopRules> {
        bracket.has_stop_rules().then_some(StopRules {
            breakeven: bracket.breakeven,
            trail: bracket.trail,
            ..StopRules::default()
        })
    }

    pub fn next_stop(
        &mut self,
        spec: &ContractSpec,
        long: bool,
        price: Price,
        stop: Price,
    ) -> Option<Price> {
        let entry = self.entry_price?.0;
        let tick = spec.tick_size.0;
        let dir = if long {
            Decimal::ONE
        } else {
            Decimal::NEGATIVE_ONE
        };
        let tighter = |a: Decimal, b: Decimal| if long { a > b } else { a < b };
        let toward_entry = if long { Rounding::Down } else { Rounding::Up };
        let p = price.0;
        let best = match self.best_price {
            Some(b) if !tighter(p, b.0) => b.0,
            _ => p,
        };
        self.best_price = Some(Price(best));
        let mut next: Option<Decimal> = None;
        let mut take = |cand: Decimal| {
            if next.is_none_or(|n| tighter(cand, n)) {
                next = Some(cand);
            }
        };
        if let Some(be) = self.breakeven
            && !self.breakeven_done
            && (best - entry) * dir >= Decimal::from(be.trigger_ticks) * tick
        {
            let raw = entry + dir * Decimal::from(be.offset_ticks) * tick;
            let at = spec.quantize(raw, toward_entry).0;
            if tighter(p, at) {
                self.breakeven_done = true;
                take(at);
            }
        }
        if let Some(t) = self.trail
            && (best - entry) * dir >= Decimal::from(t.trigger_ticks) * tick
        {
            let raw = best - dir * Decimal::from(t.distance_ticks) * tick;
            let want = spec.quantize(raw, toward_entry).0;
            let step = Decimal::from(t.step_ticks.max(1)) * tick;
            let steps = ((want - stop.0) * dir / step).floor();
            if steps >= Decimal::ONE {
                take(stop.0 + dir * steps * step);
            }
        }
        next.filter(|n| tighter(*n, stop.0) && tighter(p, *n))
            .map(Price)
    }
}

/// What the user or agent asks for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrderRequest {
    /// Target account.
    pub account_id: AccountId,
    /// Instrument (a dated contract for futures).
    pub instrument: InstrumentId,
    /// Side.
    pub side: Side,
    /// Quantity (positive).
    pub qty: Qty,
    /// Order type.
    pub order_type: OrderType,
    /// Limit price (limit and stop-limit).
    pub limit_price: Option<Price>,
    /// Stop trigger price (stop and stop-limit).
    pub stop_price: Option<Price>,
    /// Time in force.
    pub tif: TimeInForce,
    /// Attached bracket.
    pub bracket: Option<Bracket>,
    /// Client-assigned id for idempotent submission.
    pub client_order_id: Option<String>,
    /// Exit only: the order may reduce the position but never open or flip it (closes, flattens and
    /// bracket children are always reduce-only).
    #[serde(default)]
    pub reduce_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OrderValidationError {
    #[error("quantity must be positive")]
    NonPositiveQty,
    #[error("{0} order requires a {1} price")]
    MissingPrice(&'static str, &'static str),
    #[error("{0} order must not carry a {1} price")]
    UnexpectedPrice(&'static str, &'static str),
    #[error("bracket {0} is on the wrong side of the entry price")]
    BracketSide(&'static str),
    #[error("the bracket's {0} has both a price and a distance in ticks: give one")]
    LegTwice(&'static str),
    #[error("{0} needs a bracket stop loss")]
    RuleNeedsStop(&'static str),
    #[error("{0} must be at least 1 tick")]
    RuleTicks(&'static str),
    #[error("breakeven offset ({0} ticks) must be below its trigger ({1} ticks)")]
    BreakevenOffset(u32, u32),
    #[error(transparent)]
    Spec(#[from] SpecError),
    #[error("spec is for {0}, order is for {1}")]
    SpecMismatch(InstrumentId, InstrumentId),
}

impl OrderRequest {
    pub fn entry_price(&self) -> Option<Price> {
        self.limit_price.or(self.stop_price)
    }

    pub fn validate(&self, spec: &ContractSpec) -> Result<(), OrderValidationError> {
        if spec.instrument != self.instrument {
            return Err(OrderValidationError::SpecMismatch(
                spec.instrument.clone(),
                self.instrument.clone(),
            ));
        }
        if self.qty <= Qty::ZERO {
            return Err(OrderValidationError::NonPositiveQty);
        }
        spec.check_qty(self.qty)?;
        let name = self.order_type.abbrev();
        let (needs_limit, needs_stop) = match self.order_type {
            OrderType::Market => (false, false),
            OrderType::Limit => (true, false),
            OrderType::Stop => (false, true),
            OrderType::StopLimit => (true, true),
        };
        match (needs_limit, self.limit_price) {
            (true, None) => return Err(OrderValidationError::MissingPrice(name, "limit")),
            (false, Some(_)) => return Err(OrderValidationError::UnexpectedPrice(name, "limit")),
            (_, Some(p)) => spec.check_price(p)?,
            _ => {}
        }
        match (needs_stop, self.stop_price) {
            (true, None) => return Err(OrderValidationError::MissingPrice(name, "stop")),
            (false, Some(_)) => return Err(OrderValidationError::UnexpectedPrice(name, "stop")),
            (_, Some(p)) => spec.check_price(p)?,
            _ => {}
        }
        if let Some(b) = &self.bracket {
            for p in [b.stop_loss, b.take_profit].into_iter().flatten() {
                spec.check_price(p)?;
            }
            if b.stop_loss.is_some() && b.stop_ticks.is_some() {
                return Err(OrderValidationError::LegTwice("stop"));
            }
            if b.take_profit.is_some() && b.target_ticks.is_some() {
                return Err(OrderValidationError::LegTwice("target"));
            }
            if b.stop_ticks == Some(0) {
                return Err(OrderValidationError::RuleTicks("stop distance"));
            }
            if b.target_ticks == Some(0) {
                return Err(OrderValidationError::RuleTicks("target distance"));
            }
            if let Some(be) = b.breakeven {
                if !b.has_stop() {
                    return Err(OrderValidationError::RuleNeedsStop("breakeven"));
                }
                if be.trigger_ticks < 1 {
                    return Err(OrderValidationError::RuleTicks("breakeven trigger"));
                }
                if be.offset_ticks >= be.trigger_ticks {
                    return Err(OrderValidationError::BreakevenOffset(
                        be.offset_ticks,
                        be.trigger_ticks,
                    ));
                }
            }
            if let Some(t) = b.trail {
                if !b.has_stop() {
                    return Err(OrderValidationError::RuleNeedsStop("a trailing stop"));
                }
                if t.distance_ticks < 1 {
                    return Err(OrderValidationError::RuleTicks("trailing distance"));
                }
                if t.step_ticks < 1 {
                    return Err(OrderValidationError::RuleTicks("trailing step"));
                }
            }
            if let Some(entry) = self.entry_price() {
                let below = |p: Price| match self.side {
                    Side::Buy => p < entry,
                    Side::Sell => p > entry,
                };
                if b.stop_loss.is_some_and(|p| !below(p)) {
                    return Err(OrderValidationError::BracketSide("stop loss"));
                }
                if b.take_profit.is_some_and(|p| below(p) || p == entry) {
                    return Err(OrderValidationError::BracketSide("take profit"));
                }
            }
        }
        Ok(())
    }

    pub fn restatement(&self) -> String {
        let mut s = format!(
            "{} {} {} {}",
            self.side.label(),
            self.qty,
            self.instrument.symbol(),
            self.order_type.abbrev()
        );
        if let Some(p) = self.stop_price {
            let _ = write!(s, " {p}");
        }
        if let Some(p) = self.limit_price {
            let _ = write!(s, " {p}");
        }
        let _ = write!(s, " {}", self.tif.label());
        s
    }

    pub fn without_bracket(&self) -> OrderRequest {
        OrderRequest {
            bracket: None,
            ..self.clone()
        }
    }
}

/// Severity of a pre-trade check result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckSeverity {
    /// Informational note.
    Info,
    /// Warning; the order may proceed.
    Warn,
    /// Violation; the order may not proceed.
    Block,
}

/// One pre-trade check result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreTradeCheck {
    /// Stable code (`max_order_size`, `concentration`).
    pub code: String,
    /// Severity.
    pub severity: CheckSeverity,
    /// Human-readable message.
    pub message: String,
}

/// Everything shown on the order card and ticket before approval.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrderPreview {
    /// The request being previewed.
    pub request: OrderRequest,
    /// Environment of the target account.
    pub environment: Environment,
    /// Restatement (`BUY 25 QQQ LMT 487.25 DAY`).
    pub restatement: String,
    /// Reference price at preview time (last or mid).
    pub reference_price: Option<Price>,
    /// Estimated fill price.
    pub est_price: Option<Price>,
    /// Estimated notional value.
    pub est_value: Option<Money>,
    /// Estimated fees.
    pub est_fees: Option<Money>,
    /// Loss if the bracket stop is hit.
    pub risk_to_stop: Option<Money>,
    /// Buying power after a fill.
    pub buying_power_after: Option<Money>,
    /// Signed position after a fill.
    pub position_after: Option<Qty>,
    /// Pre-trade checks: the broker's, then the trader's own limits (Settings › Trading and risk), each
    /// limit's only while it is on.
    pub checks: Vec<PreTradeCheck>,
    /// When the preview was computed.
    pub created_at: Timestamp,
}

impl OrderPreview {
    pub fn passes(&self) -> bool {
        self.checks
            .iter()
            .all(|c| c.severity != CheckSeverity::Block)
    }
}

/// Lifecycle of a draft.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DraftStatus {
    /// Awaiting the user's decision.
    Live,
    /// Approved; submission follows.
    Approved,
    /// Rejected by the user.
    Rejected,
    /// Expired (time or ticks) before a decision.
    Stale,
    /// Submitted to the broker.
    Submitted,
    /// Approved, but the execution failed (the broker or a risk rule refused it): nothing was sent.
    Failed,
    /// Approved and sent, but its outcome is unknown (it ran past its timeout): check orders before
    /// trying again.
    Unconfirmed,
    /// Withdrawn by its creator or superseded by an edit.
    Cancelled,
}

/// An order draft: the single object behind every view of a proposed order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    /// Id (`d_51c2`).
    pub id: DraftId,
    /// The approval that resolves it.
    pub approval_id: Option<ApprovalId>,
    /// Who drafted it.
    pub origin: Origin,
    /// The request.
    pub request: OrderRequest,
    /// The preview shown for approval.
    pub preview: OrderPreview,
    /// Status.
    pub status: DraftStatus,
    /// Created.
    pub created_at: Timestamp,
    /// Becomes stale at.
    pub stale_at: Timestamp,
    /// Last change.
    pub updated_at: Timestamp,
}

/// Broker order status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    /// Sent, not yet acknowledged.
    PendingSubmit,
    /// A bracket child waiting for its entry to fill (dormant); it works once the entry fills.
    Held,
    /// Working at the broker.
    Working,
    /// Partially filled, remainder working.
    PartiallyFilled,
    /// Cancel sent, not yet acknowledged.
    PendingCancel,
    /// Completely filled.
    Filled,
    Cancelled,
    /// Rejected by broker or exchange.
    Rejected,
    /// Expired (TIF).
    Expired,
}

impl OrderStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            OrderStatus::Filled
                | OrderStatus::Cancelled
                | OrderStatus::Rejected
                | OrderStatus::Expired
        )
    }

    pub fn is_open(self) -> bool {
        !self.is_terminal()
    }

    pub fn is_working(self) -> bool {
        matches!(self, OrderStatus::Working | OrderStatus::PartiallyFilled)
    }
}

/// What an order is for. Bracket children and exits are reduce-only.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum OrderRole {
    /// Opens or adds to a position (or any order the trader sent as such).
    #[default]
    Entry,
    /// The protective stop of a bracket.
    StopLoss,
    /// The profit target of a bracket.
    TakeProfit,
    /// A closing order (close, flatten).
    Exit,
}

/// An order at the broker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    /// Tessera id.
    pub id: OrderId,
    /// Broker's id.
    pub broker_order_id: Option<String>,
    /// Draft it came from, if any.
    pub draft_id: Option<DraftId>,
    /// Request.
    pub request: OrderRequest,
    /// What the order is for.
    pub role: OrderRole,
    /// The entry a bracket child belongs to; the stop and the target of one entry are one OCO pair.
    pub parent_id: Option<OrderId>,
    /// Status.
    pub status: OrderStatus,
    /// Filled quantity.
    pub filled_qty: Qty,
    /// Average fill price.
    pub avg_fill_price: Option<Price>,
    /// Estimated size ahead of a resting limit at its price, when the broker knows or estimates it.
    pub queue_ahead: Option<Qty>,
    /// A bracket stop's breakeven and trailing rules (only on the stop of a bracket that asked
    /// for them); the broker moves the stop by itself, only ever tighter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stop_rules: Option<StopRules>,
    /// When a stop or stop-limit triggered.
    pub triggered_at: Option<Timestamp>,
    /// Environment of the account.
    pub environment: Environment,
    /// Reject or cancel reason.
    pub reason: Option<String>,
    /// Created.
    pub created_at: Timestamp,
    /// Last update.
    pub updated_at: Timestamp,
}

impl Order {
    pub fn remaining(&self) -> Qty {
        self.request.qty - self.filled_qty
    }
}

/// An execution. Fills are the source of truth for positions, trades and P&L.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    /// Tessera id.
    pub id: FillId,
    /// Broker's execution id.
    pub broker_fill_id: Option<String>,
    /// Order.
    pub order_id: Option<OrderId>,
    /// Account.
    pub account_id: AccountId,
    /// Exact instrument (dated contract).
    pub instrument: InstrumentId,
    /// Side.
    pub side: Side,
    /// Quantity (positive).
    pub qty: Qty,
    /// Price.
    pub price: Price,
    /// Exchange time.
    pub ts: Timestamp,
    /// Fees and commissions.
    pub fee: Money,
    /// Realized P&L of the part of the fill that closed a position (gross of fees), if any.
    pub realized_pnl: Option<Money>,
    /// Source (`paper`, `rithmic`, `csv:rtrader`).
    pub source: String,
}

/// A net position.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// Account.
    pub account_id: AccountId,
    /// Instrument.
    pub instrument: InstrumentId,
    /// Signed quantity (long positive).
    pub qty: Qty,
    /// Average entry price.
    pub avg_price: Price,
    /// Realized P&L from closed portions.
    pub realized_pnl: Money,
    /// Unrealized P&L at the last mark.
    pub unrealized_pnl: Option<Money>,
    /// Last mark price.
    pub mark: Option<Price>,
    /// When the position was opened.
    pub opened_at: Timestamp,
}

impl Position {
    pub fn side(&self) -> Option<Side> {
        Side::holding(self.qty.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;
    use chrono::NaiveDate;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn p(s: &str) -> Price {
        Price(Decimal::from_str(s).unwrap())
    }

    fn qqq_buy() -> OrderRequest {
        OrderRequest {
            account_id: AccountId::new("paper-main"),
            instrument: InstrumentId::new("QQQ").unwrap(),
            side: Side::Buy,
            qty: Qty::from(25),
            order_type: OrderType::Limit,
            limit_price: Some(p("487.25")),
            stop_price: None,
            tif: TimeInForce::Day,
            bracket: Some(Bracket {
                stop_loss: Some(p("485.30")),
                ..Bracket::default()
            }),
            client_order_id: None,
            reduce_only: false,
        }
    }

    #[test]
    fn a_holding_is_long_short_or_flat_and_never_both() {
        let d = |s: &str| Decimal::from_str(s).unwrap();
        assert_eq!(Side::holding(d("2")), Some(Side::Buy));
        assert_eq!(Side::holding(d("0.5")), Some(Side::Buy));
        assert_eq!(Side::holding(d("-3")), Some(Side::Sell));
        assert_eq!(Side::holding(Decimal::ZERO), None);
        assert_eq!(Side::holding(-Decimal::ZERO), None);
        let position = |qty: &str| Position {
            account_id: AccountId::new("paper-main"),
            instrument: InstrumentId::new("MNQZ6.CME").unwrap(),
            qty: Qty(d(qty)),
            avg_price: p("20000"),
            realized_pnl: Money::usd(Decimal::ZERO),
            unrealized_pnl: None,
            mark: None,
            opened_at: Timestamp(0),
        };
        assert_eq!(position("1").side(), Some(Side::Buy));
        assert_eq!(position("-1").side(), Some(Side::Sell));
        assert_eq!(position("0").side(), None);
    }

    #[test]
    fn working_is_resting_at_the_broker_whole_or_in_part() {
        let working = [OrderStatus::Working, OrderStatus::PartiallyFilled];
        for status in [
            OrderStatus::PendingSubmit,
            OrderStatus::Held,
            OrderStatus::Working,
            OrderStatus::PartiallyFilled,
            OrderStatus::PendingCancel,
            OrderStatus::Filled,
            OrderStatus::Cancelled,
            OrderStatus::Rejected,
            OrderStatus::Expired,
        ] {
            assert_eq!(status.is_working(), working.contains(&status), "{status:?}");
        }
    }

    #[test]
    fn restatement_matches_the_ticket() {
        assert_eq!(qqq_buy().restatement(), "BUY 25 QQQ LMT 487.25 DAY");
    }

    #[test]
    fn validation() {
        let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let spec = cat.spec(&InstrumentId::new("QQQ").unwrap()).unwrap();
        assert!(qqq_buy().validate(spec).is_ok());

        let mut r = qqq_buy();
        r.limit_price = None;
        assert_eq!(
            r.validate(spec),
            Err(OrderValidationError::MissingPrice("LMT", "limit"))
        );
        let mut r = qqq_buy();
        r.limit_price = Some(p("487.255"));
        assert!(matches!(
            r.validate(spec),
            Err(OrderValidationError::Spec(_))
        ));
        let mut r = qqq_buy();
        r.bracket = Some(Bracket {
            stop_loss: Some(p("488.00")),
            ..Bracket::default()
        });
        assert_eq!(
            r.validate(spec),
            Err(OrderValidationError::BracketSide("stop loss"))
        );
        let mut r = qqq_buy();
        r.qty = Qty::ZERO;
        assert_eq!(r.validate(spec), Err(OrderValidationError::NonPositiveQty));
        let mut r = qqq_buy();
        r.order_type = OrderType::Market;
        assert_eq!(
            r.validate(spec),
            Err(OrderValidationError::UnexpectedPrice("MKT", "limit"))
        );
        let nq = cat.spec(&InstrumentId::new("NQZ6.CME").unwrap()).unwrap();
        assert!(matches!(
            qqq_buy().validate(nq),
            Err(OrderValidationError::SpecMismatch(..))
        ));
    }

    #[test]
    fn a_bracket_in_ticks_is_priced_from_where_its_entry_fills() {
        let tick = Decimal::from_str("0.25").unwrap();
        let ticks = Bracket {
            stop_ticks: Some(40),
            target_ticks: Some(80),
            ..Bracket::default()
        };
        let priced = |stop: &str, target: &str| Bracket {
            stop_loss: Some(p(stop)),
            take_profit: Some(p(target)),
            ..Bracket::default()
        };
        assert_eq!(
            ticks.priced_from(Side::Buy, p("20623.75"), tick),
            priced("20613.75", "20643.75")
        );
        assert_eq!(
            ticks.priced_from(Side::Sell, p("20623.75"), tick),
            priced("20633.75", "20603.75")
        );
        let mixed = Bracket {
            stop_loss: Some(p("20600.00")),
            target_ticks: Some(80),
            ..Bracket::default()
        };
        assert_eq!(
            mixed.priced_from(Side::Buy, p("20623.75"), tick),
            priced("20600.00", "20643.75"),
            "a stop set at a price keeps it"
        );
        assert_eq!(
            serde_json::to_value(ticks).unwrap(),
            serde_json::json!({"stopLoss": null, "takeProfit": null, "stopTicks": 40, "targetTicks": 80})
        );
    }

    #[test]
    fn a_leg_is_a_price_or_a_distance_never_both() {
        let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let nq = cat.spec(&InstrumentId::new("NQZ6.CME").unwrap()).unwrap();
        let market = |b: Bracket| OrderRequest {
            instrument: nq.instrument.clone(),
            order_type: OrderType::Market,
            limit_price: None,
            bracket: Some(b),
            ..qqq_buy()
        };
        let ok = Bracket {
            stop_ticks: Some(40),
            target_ticks: Some(80),
            trail: trail(8, 0, 1),
            ..Bracket::default()
        };
        assert!(market(ok).validate(nq).is_ok());
        let cases = [
            (
                Bracket {
                    stop_loss: Some(p("20600.00")),
                    stop_ticks: Some(40),
                    ..Bracket::default()
                },
                OrderValidationError::LegTwice("stop"),
            ),
            (
                Bracket {
                    take_profit: Some(p("20700.00")),
                    target_ticks: Some(80),
                    ..Bracket::default()
                },
                OrderValidationError::LegTwice("target"),
            ),
            (
                Bracket {
                    stop_ticks: Some(0),
                    ..Bracket::default()
                },
                OrderValidationError::RuleTicks("stop distance"),
            ),
            (
                Bracket {
                    target_ticks: Some(0),
                    ..Bracket::default()
                },
                OrderValidationError::RuleTicks("target distance"),
            ),
        ];
        for (b, want) in cases {
            assert_eq!(market(b).validate(nq), Err(want), "{b:?}");
        }
    }

    #[test]
    fn breakeven_and_trailing_need_a_stop_and_whole_ticks() {
        let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let spec = cat.spec(&InstrumentId::new("QQQ").unwrap()).unwrap();
        let with = |b: Bracket| OrderRequest {
            bracket: Some(b),
            ..qqq_buy()
        };
        let be = |trigger_ticks, offset_ticks| {
            Some(BreakevenRule {
                trigger_ticks,
                offset_ticks,
            })
        };
        let stop = Some(p("485.30"));
        let ok = with(Bracket {
            stop_loss: stop,
            breakeven: be(4, 1),
            trail: trail(8, 12, 2),
            ..Bracket::default()
        });
        assert!(ok.validate(spec).is_ok());
        assert!(
            with(Bracket {
                stop_loss: stop,
                breakeven: be(1, 0),
                ..Bracket::default()
            })
            .validate(spec)
            .is_ok(),
            "lock in the entry itself"
        );
        let cases = [
            (
                Bracket {
                    take_profit: Some(p("490.00")),
                    breakeven: be(4, 1),
                    ..Bracket::default()
                },
                OrderValidationError::RuleNeedsStop("breakeven"),
            ),
            (
                Bracket {
                    trail: trail(8, 0, 1),
                    ..Bracket::default()
                },
                OrderValidationError::RuleNeedsStop("a trailing stop"),
            ),
            (
                Bracket {
                    stop_loss: stop,
                    breakeven: be(0, 0),
                    ..Bracket::default()
                },
                OrderValidationError::RuleTicks("breakeven trigger"),
            ),
            (
                Bracket {
                    stop_loss: stop,
                    breakeven: be(4, 4),
                    ..Bracket::default()
                },
                OrderValidationError::BreakevenOffset(4, 4),
            ),
            (
                Bracket {
                    stop_loss: stop,
                    trail: trail(0, 0, 1),
                    ..Bracket::default()
                },
                OrderValidationError::RuleTicks("trailing distance"),
            ),
            (
                Bracket {
                    stop_loss: stop,
                    trail: trail(8, 0, 0),
                    ..Bracket::default()
                },
                OrderValidationError::RuleTicks("trailing step"),
            ),
        ];
        for (b, want) in cases {
            assert_eq!(with(b).validate(spec), Err(want), "{b:?}");
        }
        let json = serde_json::to_value(Bracket {
            stop_loss: stop,
            ..Bracket::default()
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"stopLoss": 485.30, "takeProfit": null})
        );
        let b: Bracket = serde_json::from_value(serde_json::json!({
            "stopLoss": 485.30,
            "takeProfit": null,
            "breakeven": {"triggerTicks": 4, "offsetTicks": 1},
            "trail": {"distanceTicks": 8, "triggerTicks": 12, "stepTicks": 2}
        }))
        .unwrap();
        assert_eq!(b.breakeven, be(4, 1));
        assert_eq!(b.trail, trail(8, 12, 2));
        assert!(Bracket::default().is_empty() && !b.is_empty() && b.has_stop_rules());
    }

    fn trail(distance_ticks: u32, trigger_ticks: u32, step_ticks: u32) -> Option<TrailRule> {
        Some(TrailRule {
            distance_ticks,
            trigger_ticks,
            step_ticks,
        })
    }

    #[test]
    fn a_stop_moves_to_breakeven_once_and_trails_from_its_trigger_in_steps() {
        let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let nq = cat.spec(&InstrumentId::new("NQZ6.CME").unwrap()).unwrap();
        let mut rules = StopRules {
            breakeven: Some(BreakevenRule {
                trigger_ticks: 8,
                offset_ticks: 1,
            }),
            trail: trail(12, 20, 4),
            entry_price: Some(p("20000")),
            ..StopRules::default()
        };
        let mut stop = p("19990");
        let mut tape = |rules: &mut StopRules, price: &str| {
            if let Some(next) = rules.next_stop(nq, true, p(price), stop) {
                stop = next;
            }
            stop
        };
        assert_eq!(
            tape(&mut rules, "20001.75"),
            p("19990"),
            "under the trigger"
        );
        assert_eq!(
            tape(&mut rules, "20002"),
            p("20000.25"),
            "breakeven + 1 tick"
        );
        assert!(rules.breakeven_done);
        assert_eq!(
            tape(&mut rules, "20004.75"),
            p("20000.25"),
            "the trail waits"
        );
        assert_eq!(
            tape(&mut rules, "20005"),
            p("20001.25"),
            "20 ticks up: toward 12 behind the best, in whole 4-tick steps"
        );
        assert_eq!(tape(&mut rules, "20005.5"), p("20002.25"));
        assert_eq!(
            tape(&mut rules, "20005.75"),
            p("20002.25"),
            "2 ticks is not a step"
        );
        assert_eq!(tape(&mut rules, "20006.25"), p("20003.25"));
        assert_eq!(tape(&mut rules, "20001"), p("20003.25"), "only tighter");
        assert_eq!(rules.best_price, Some(p("20006.25")));
        assert_eq!(
            tape(&mut rules, "20009"),
            p("20005.25"),
            "two steps at once"
        );

        let mut late = StopRules {
            breakeven: Some(BreakevenRule {
                trigger_ticks: 8,
                offset_ticks: 4,
            }),
            entry_price: Some(p("20000")),
            best_price: Some(p("20002")),
            ..StopRules::default()
        };
        assert_eq!(
            late.next_stop(nq, true, p("20000.75"), p("19990")),
            None,
            "price fell back under the breakeven stop since the last look: wait"
        );
        assert!(!late.breakeven_done);
        assert_eq!(
            late.next_stop(nq, true, p("20001.25"), p("19990")),
            Some(p("20001"))
        );

        let mut short = StopRules {
            trail: trail(4, 0, 1),
            entry_price: Some(p("20000")),
            ..StopRules::default()
        };
        assert_eq!(
            short.next_stop(nq, false, p("19999"), p("20010")),
            Some(p("20000")),
            "a short trails above from the fill"
        );
        assert_eq!(short.next_stop(nq, false, p("20003"), p("20000")), None);
        let mut unfilled = StopRules {
            entry_price: None,
            ..short
        };
        assert_eq!(unfilled.next_stop(nq, false, p("19990"), p("20010")), None);
    }

    #[test]
    fn statuses() {
        assert!(OrderStatus::Filled.is_terminal());
        assert!(!OrderStatus::Working.is_terminal());
        assert!(OrderStatus::Held.is_open() && OrderStatus::PendingCancel.is_open());
        assert!(!OrderStatus::Expired.is_open());
        assert_eq!(Side::Buy.opposite(), Side::Sell);
    }
}
