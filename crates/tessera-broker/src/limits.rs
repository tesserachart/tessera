use std::collections::HashMap;

use chrono_tz::Tz;
use rust_decimal::Decimal;
use rust_decimal::prelude::Signed;
use serde::{Deserialize, Serialize};
use tessera_core::accounts::RiskStatus;
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::limits::{
    LimitsStatus, LockKind, LockSpan, LockedBy, RiskLimits, next_session_open,
};
use tessera_core::money::{Currency, Money, decimal_from_f64};
use tessera_core::orders::{
    CheckSeverity, Fill, Order, OrderRole, OrderType, Position, PreTradeCheck, Side,
};
use tessera_core::{InstrumentId, Timestamp};

use crate::paper::account::{DAY_CALENDAR, clock_label_in};
use crate::paper::engine::usd;

fn near(used: Decimal, of: Decimal) -> bool {
    used * Decimal::from(10) >= of * Decimal::from(8)
}

fn dec(v: f64) -> Decimal {
    decimal_from_f64(v).unwrap_or_default()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OrderFacts {
    pub qty: Decimal,
    pub opening: Decimal,
    pub after: Decimal,
    pub opens_trade: bool,
    pub risk_at_stop: Option<Decimal>,
    pub open_risk: Decimal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualLock {
    pub by: LockedBy,
    pub span: LockSpan,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LockCause {
    DailyLoss { limit: Decimal },
    Manual { manual: ManualLock },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLock {
    pub account_id: AccountId,
    #[serde(flatten)]
    pub cause: LockCause,
    pub at: Timestamp,
    pub until: Timestamp,
}

impl AccountLock {
    pub fn daily_loss(account: &AccountId, limit: Decimal, now: Timestamp) -> Self {
        Self {
            account_id: account.clone(),
            cause: LockCause::DailyLoss { limit },
            at: now,
            until: next_session_open(DAY_CALENDAR, now),
        }
    }

    pub fn manual(
        account: &AccountId,
        by: LockedBy,
        span: LockSpan,
        now: Timestamp,
        until: Timestamp,
    ) -> Self {
        Self {
            account_id: account.clone(),
            cause: LockCause::Manual {
                manual: ManualLock { by, span },
            },
            at: now,
            until,
        }
    }

    pub fn kind(&self) -> LockKind {
        match self.cause {
            LockCause::DailyLoss { .. } => LockKind::DailyLoss,
            LockCause::Manual { .. } => LockKind::Manual,
        }
    }

    pub fn holds(&self, now: Timestamp) -> bool {
        now < self.until
    }

    pub fn words(&self, now: Timestamp, zone: Tz) -> String {
        let clock = |t| clock_label_in(t, now, zone);
        match &self.cause {
            LockCause::DailyLoss { limit } => format!(
                "Your {} daily loss limit was reached at {}: Tessera closed the account's positions. \
                 New entries wait for the next session at {}. Exits work.",
                usd(*limit),
                clock(self.at),
                clock(self.until)
            ),
            LockCause::Manual { manual } => format!(
                "Trading on this account is locked{} since {}, until {}: no new entries. Exits, \
                 stops and targets work.",
                match manual.by {
                    LockedBy::User => "",
                    LockedBy::Agent => " by an agent at your request",
                },
                clock(self.at),
                clock(self.until)
            ),
        }
    }

    pub fn code(&self) -> &'static str {
        match self.kind() {
            LockKind::DailyLoss => "limit_daily_loss",
            LockKind::Manual => "account_locked",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DayFacts {
    pub currency: Currency,
    pub day_pnl: Decimal,
    pub trades_today: Option<u32>,
    pub firm: Option<RiskStatus>,
    pub lock: Option<AccountLock>,
    pub zone: Tz,
    pub now: Timestamp,
}

pub fn left_today(limits: &RiskLimits, day: &DayFacts) -> Option<Decimal> {
    limits
        .daily_loss()
        .map(|l| (dec(l) + day.day_pnl).max(Decimal::ZERO))
}

pub fn breached(limits: &RiskLimits, day: &DayFacts) -> Option<Decimal> {
    let limit = limits.daily_loss().map(dec)?;
    left_today(limits, day)
        .is_some_and(|left| left.is_zero())
        .then_some(limit)
}

pub fn lock(limits: &RiskLimits, day: &DayFacts) -> Option<String> {
    if let Some(l) = &day.lock {
        return Some(l.words(day.now, day.zone));
    }
    if let (Some(l), Some(left)) = (limits.daily_loss(), left_today(limits, day))
        && left.is_zero()
    {
        return Some(format!(
            "Your {} daily loss limit is reached: no new positions today. Exits work.",
            usd(dec(l))
        ));
    }
    let firm = day.firm.as_ref()?;
    if firm.locked {
        return Some(
            "Your firm's platform has this account locked: no new positions. Exits work.".into(),
        );
    }
    firm.room
        .filter(|r| r.amount <= Decimal::ZERO)
        .map(|_| "Your firm's rules leave no room: no new positions. Exits work.".into())
}

pub fn standing(
    account: &AccountId,
    limits: &RiskLimits,
    own: bool,
    day: &DayFacts,
    now: Timestamp,
) -> Option<LimitsStatus> {
    if limits.is_off() && day.firm.is_none() && day.lock.is_none() {
        return None;
    }
    let money = |d: Decimal| Money::new(d, day.currency);
    let why = lock(limits, day);
    Some(LimitsStatus {
        account_id: account.clone(),
        own,
        daily_loss_limit: limits.daily_loss().map(|v| money(dec(v))),
        daily_loss_left: left_today(limits, day).map(money),
        max_risk_per_trade: limits.risk_per_trade().map(|v| money(dec(v))),
        max_order_qty: limits.order_qty(),
        max_position_qty: limits.position_qty(),
        max_trades_per_day: limits.trades_per_day(),
        trades_today: limits.trades_per_day().and(day.trades_today),
        firm_room: day
            .firm
            .as_ref()
            .and_then(|f| f.room)
            .map(|r| money(r.amount.max(Decimal::ZERO))),
        locked: why.is_some(),
        locked_why: why,
        locked_until: day.lock.as_ref().map(|l| l.until),
        lock_kind: day.lock.as_ref().map(AccountLock::kind),
        as_of: now,
    })
}

fn qty_words(q: Decimal) -> String {
    let n = q.normalize();
    if n == Decimal::ONE {
        "1 contract".into()
    } else {
        format!("{n} contracts")
    }
}

fn stop_words(risk: Decimal, open: Decimal) -> String {
    if open > Decimal::ZERO {
        format!(
            "This stop risks {} and your working stops {}",
            usd(risk),
            usd(open)
        )
    } else {
        format!("This stop risks {}", usd(risk))
    }
}

pub fn check(limits: &RiskLimits, order: &OrderFacts, day: &DayFacts) -> Vec<PreTradeCheck> {
    let mut out = Vec::new();
    if order.opening <= Decimal::ZERO {
        return out;
    }
    let mut push = |code: &str, severity: CheckSeverity, message: String| {
        out.push(PreTradeCheck {
            code: code.into(),
            severity,
            message,
        });
    };
    let block = CheckSeverity::Block;
    if let Some(why) = lock(limits, day) {
        let code = match &day.lock {
            Some(l) => l.code(),
            None if limits.daily_loss().is_some()
                && left_today(limits, day).is_some_and(|l| l.is_zero()) =>
            {
                "limit_daily_loss"
            }
            None => "firm_rules",
        };
        push(code, block, why);
        return out;
    }
    if let Some(max) = limits.order_qty()
        && order.qty > Decimal::from(max)
    {
        push(
            "limit_order_qty",
            block,
            format!(
                "{}: over your {} an order.",
                qty_words(order.qty),
                qty_words(Decimal::from(max))
            ),
        );
    }
    if let Some(max) = limits.position_qty()
        && order.after.abs() > Decimal::from(max)
    {
        push(
            "limit_position",
            block,
            format!(
                "That holds {}: over your {}.",
                qty_words(order.after.abs()),
                qty_words(Decimal::from(max))
            ),
        );
    }
    if let (Some(max), Some(n)) = (limits.trades_per_day(), day.trades_today)
        && order.opens_trade
        && n >= max
    {
        push(
            "limit_trades",
            block,
            format!(
                "{n} trades today, your limit: no new trades today. Adding to or closing a position works."
            ),
        );
    }
    if let Some(max) = limits.risk_per_trade().map(dec) {
        match order.risk_at_stop {
            None => push(
                "limit_risk_per_trade",
                block,
                format!(
                    "No stop: your {} a trade is measured at the stop. Add one.",
                    usd(max)
                ),
            ),
            Some(r) if r > max => push(
                "limit_risk_per_trade",
                block,
                format!(
                    "This stop risks {}: over your {} a trade.",
                    usd(r),
                    usd(max)
                ),
            ),
            Some(r) if near(r, max) => push(
                "limit_risk_per_trade",
                CheckSeverity::Warn,
                format!("This stop risks {} of your {} a trade.", usd(r), usd(max)),
            ),
            Some(_) => {}
        }
    }
    if let (Some(limit), Some(left), Some(r)) = (
        limits.daily_loss().map(dec),
        left_today(limits, day),
        order.risk_at_stop,
    ) {
        let worst = r + order.open_risk;
        if worst > left {
            push(
                "limit_daily_loss",
                block,
                format!(
                    "{}: over the {} left of your {} daily loss limit.",
                    stop_words(r, order.open_risk),
                    usd(left),
                    usd(limit)
                ),
            );
        } else if near(worst, left) {
            push(
                "limit_daily_loss",
                CheckSeverity::Warn,
                format!(
                    "{}: {} of the {} left today.",
                    stop_words(r, order.open_risk),
                    usd(worst),
                    usd(left)
                ),
            );
        }
    }
    if let (Some(room), Some(r)) = (
        day.firm.as_ref().and_then(|f| f.room).map(|m| m.amount),
        order.risk_at_stop,
    ) {
        let worst = r + order.open_risk;
        if worst > room {
            push(
                "firm_rules",
                block,
                format!(
                    "{}: over the {} your firm's rules leave.",
                    stop_words(r, order.open_risk),
                    usd(room)
                ),
            );
        }
    }
    out
}

pub fn check_stop_move(
    limits: &RiskLimits,
    trade_risk: Decimal,
    open_risk: Decimal,
    day: &DayFacts,
) -> Option<String> {
    if let Some(max) = limits.risk_per_trade().map(dec)
        && trade_risk > max
    {
        return Some(format!(
            "The stop there risks {} from your entry: over your {} a trade.",
            usd(trade_risk),
            usd(max)
        ));
    }
    if let (Some(limit), Some(left)) = (limits.daily_loss().map(dec), left_today(limits, day))
        && open_risk > left
    {
        return Some(format!(
            "Your stops there risk {}: over the {} left of your {} daily loss limit.",
            usd(open_risk),
            usd(left),
            usd(limit)
        ));
    }
    if let Some(room) = day.firm.as_ref().and_then(|f| f.room).map(|m| m.amount)
        && open_risk > room
    {
        return Some(format!(
            "Your stops there risk {}: over the {} your firm's rules leave.",
            usd(open_risk),
            usd(room)
        ));
    }
    None
}

fn signed(side: Side, qty: Decimal) -> Decimal {
    Decimal::from(side.sign()) * qty
}

pub fn opening_qty(position: Decimal, side: Side, qty: Decimal, reduce_only: bool) -> Decimal {
    if reduce_only {
        return Decimal::ZERO;
    }
    if position.is_zero() || position.signum() == Decimal::from(side.sign()) {
        qty
    } else {
        (qty - position.abs()).max(Decimal::ZERO)
    }
}

pub fn opens_trade(position: Decimal, side: Side, qty: Decimal, reduce_only: bool) -> bool {
    let opening = opening_qty(position, side, qty, reduce_only);
    opening > Decimal::ZERO
        && (position.is_zero() || position.signum() != Decimal::from(side.sign()))
}

pub fn trades_today(positions: &[Position], fills: &[Fill]) -> u32 {
    let mut fills: Vec<&Fill> = fills.iter().collect();
    fills.sort_by_key(|f| f.ts);
    let mut held: HashMap<&InstrumentId, Decimal> = HashMap::new();
    for p in positions {
        *held.entry(&p.instrument).or_default() += p.qty.0;
    }
    for f in &fills {
        *held.entry(&f.instrument).or_default() -= signed(f.side, f.qty.0);
    }
    let mut n = 0;
    for f in fills {
        let q = held.entry(&f.instrument).or_default();
        let before = *q;
        *q += signed(f.side, f.qty.0);
        if !q.is_zero() && (before.is_zero() || before.signum() != q.signum()) {
            n += 1;
        }
    }
    n
}

pub fn open_risk(
    positions: &[Position],
    orders: &[Order],
    multiplier: &dyn Fn(&InstrumentId) -> Option<Decimal>,
    exclude: Option<&OrderId>,
) -> Decimal {
    let mut loss = Decimal::ZERO;
    for p in positions {
        let (Some(side), Some(mult)) = (p.side(), multiplier(&p.instrument)) else {
            continue;
        };
        let mark = p.mark.unwrap_or(p.avg_price);
        let closing = side.opposite();
        let mut uncovered = p.qty.0.abs();
        for o in orders.iter().filter(|o| {
            o.request.instrument == p.instrument
                && o.request.side == closing
                && o.request.reduce_only
                && o.status.is_working()
                && matches!(o.request.order_type, OrderType::Stop | OrderType::StopLimit)
                && exclude != Some(&o.id)
        }) {
            let Some(stop) = o.request.stop_price else {
                continue;
            };
            let q = o.remaining().0.min(uncovered);
            uncovered -= q;
            let dir = Decimal::from(-o.request.side.sign());
            loss += ((mark.0 - stop.0) * dir).max(Decimal::ZERO) * q * mult;
        }
    }
    for o in orders.iter().filter(|o| {
        o.role == OrderRole::Entry
            && o.parent_id.is_none()
            && o.status.is_working()
            && exclude != Some(&o.id)
    }) {
        let Some(child) = orders.iter().find(|c| {
            c.parent_id.as_ref() == Some(&o.id)
                && c.role == OrderRole::StopLoss
                && c.status.is_open()
        }) else {
            continue;
        };
        let (Some(stop), Some(entry), Some(mult)) = (
            child.request.stop_price,
            o.request.entry_price(),
            multiplier(&o.request.instrument),
        ) else {
            continue;
        };
        loss += (entry.0 - stop.0).abs() * o.remaining().0 * mult;
    }
    loss
}

pub fn adds_risk(
    positions: &[Position],
    orders: &[Order],
    multiplier: &dyn Fn(&InstrumentId) -> Option<Decimal>,
    exclude: Option<&OrderId>,
) -> Decimal {
    let mut loss = Decimal::ZERO;
    for p in positions {
        let (Some(side), Some(mult)) = (p.side(), multiplier(&p.instrument)) else {
            continue;
        };
        let on: Vec<Order> = orders
            .iter()
            .filter(|o| o.request.instrument == p.instrument)
            .cloned()
            .collect();
        let Some(stop) = crate::protect::plan::protection_prices(&on, p.qty.0).stop_loss else {
            continue;
        };
        let long = side == Side::Buy;
        let own_stop = |e: &Order| {
            on.iter().any(|c| {
                c.parent_id.as_ref() == Some(&e.id)
                    && c.role == OrderRole::StopLoss
                    && c.status.is_open()
            })
        };
        for o in on.iter().filter(|o| {
            o.role == OrderRole::Entry
                && o.parent_id.is_none()
                && o.status.is_working()
                && o.request.side == side
                && !o.request.reduce_only
                && exclude != Some(&o.id)
                && !own_stop(o)
        }) {
            let Some(entry) = o.request.entry_price() else {
                continue;
            };
            if (long && entry <= stop) || (!long && entry >= stop) {
                continue;
            }
            loss += (entry.0 - stop.0).abs() * o.remaining().0 * mult;
        }
    }
    loss
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::ids::FillId;
    use tessera_core::orders::{OrderRequest, OrderStatus, TimeInForce};
    use tessera_core::{Price, Qty};

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn day(pnl: &str) -> DayFacts {
        DayFacts {
            currency: Currency::Usd,
            day_pnl: d(pnl),
            trades_today: None,
            firm: None,
            lock: None,
            zone: DAY_CALENDAR.tz(),
            now: Timestamp(0),
        }
    }

    fn entry(qty: &str, risk: Option<&str>) -> OrderFacts {
        OrderFacts {
            qty: d(qty),
            opening: d(qty),
            after: d(qty),
            opens_trade: true,
            risk_at_stop: risk.map(d),
            open_risk: Decimal::ZERO,
        }
    }

    fn blocks(c: &[PreTradeCheck]) -> Vec<&str> {
        c.iter()
            .filter(|c| c.severity == CheckSeverity::Block)
            .map(|c| c.message.as_str())
            .collect()
    }

    #[test]
    fn a_reached_daily_loss_limit_locks_new_entries_until_the_next_session_whatever_the_limits() {
        let friday = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        let lock = AccountLock::daily_loss(&AccountId::new("paper-main"), d("500"), friday);
        assert_eq!(
            lock.until,
            Timestamp::parse("2026-10-04T18:00:00-04:00").unwrap(),
            "Friday's lock lifts when Globex opens on Sunday"
        );
        assert!(lock.holds(friday) && !lock.holds(lock.until));
        let tuesday = Timestamp::parse("2026-10-06T09:31:00-04:00").unwrap();
        assert_eq!(
            AccountLock::daily_loss(&AccountId::new("a"), d("500"), tuesday).until,
            Timestamp::parse("2026-10-06T18:00:00-04:00").unwrap()
        );
        let locked = DayFacts {
            lock: Some(lock.clone()),
            now: friday,
            ..day("120")
        };
        let words = "Your $500 daily loss limit was reached at 14:42: Tessera closed the account's \
                     positions. New entries wait for the next session at Sun 18:00. Exits work.";
        for limits in [
            RiskLimits::default(),
            RiskLimits {
                daily_loss_limit: Some(5000.0),
                ..RiskLimits::default()
            },
        ] {
            let c = check(&limits, &entry("1", Some("10")), &locked);
            assert_eq!(c.len(), 1, "{c:?}");
            assert_eq!(
                (c[0].code.as_str(), c[0].severity, c[0].message.as_str()),
                ("limit_daily_loss", CheckSeverity::Block, words)
            );
            let exit = OrderFacts {
                opening: Decimal::ZERO,
                ..entry("1", None)
            };
            assert!(check(&limits, &exit, &locked).is_empty(), "exits work");
            let s = standing(
                &AccountId::new("paper-main"),
                &limits,
                false,
                &locked,
                friday,
            )
            .expect("a lock shows with no limit on");
            assert!(s.locked);
            assert_eq!(s.locked_until, Some(lock.until));
            assert_eq!(s.locked_why.as_deref(), Some(words));
        }
        let l = RiskLimits {
            daily_loss_limit: Some(500.0),
            ..RiskLimits::default()
        };
        assert_eq!(breached(&l, &day("-499.99")), None);
        assert_eq!(breached(&l, &day("-500")), Some(d("500")));
        assert_eq!(breached(&RiskLimits::default(), &day("-9999")), None);
    }

    #[test]
    fn a_manual_lock_refuses_entries_in_the_users_zone_and_lets_exits_through() {
        let at = Timestamp::parse("2026-10-06T14:42:00-04:00").unwrap();
        let a = AccountId::new("paper-main");
        let span = LockSpan::Minutes { minutes: 60 };
        let lock = |by| {
            AccountLock::manual(
                &a,
                by,
                span,
                at,
                Timestamp::parse("2026-10-06T15:42:00-04:00").unwrap(),
            )
        };
        let locked = DayFacts {
            lock: Some(lock(LockedBy::User)),
            zone: Tz::Europe__London,
            now: at,
            ..day("0")
        };
        let c = check(&RiskLimits::default(), &entry("1", Some("10")), &locked);
        assert_eq!(
            (c[0].code.as_str(), c[0].severity, c[0].message.as_str()),
            (
                "account_locked",
                CheckSeverity::Block,
                "Trading on this account is locked since 19:42, until 20:42: no new entries. \
                 Exits, stops and targets work."
            )
        );
        let exit = OrderFacts {
            opening: Decimal::ZERO,
            ..entry("1", None)
        };
        assert!(check(&RiskLimits::default(), &exit, &locked).is_empty());
        let s = standing(&a, &RiskLimits::default(), false, &locked, at).unwrap();
        assert_eq!(
            (s.locked, s.lock_kind, s.locked_until),
            (
                true,
                Some(LockKind::Manual),
                Some(lock(LockedBy::User).until)
            )
        );
        assert!(
            lock(LockedBy::Agent)
                .words(at, DAY_CALENDAR.tz())
                .starts_with("Trading on this account is locked by an agent at your request since 14:42, until 15:42")
        );
    }

    #[test]
    fn with_nothing_set_nothing_is_refused_or_said() {
        let none = RiskLimits::default();
        let huge = OrderFacts {
            open_risk: d("1000000"),
            ..entry("500", None)
        };
        assert!(check(&none, &huge, &day("-99999")).is_empty());
        assert_eq!(
            standing(
                &AccountId::new("a"),
                &none,
                false,
                &day("-99999"),
                Timestamp(0)
            ),
            None
        );
    }

    #[test]
    fn the_daily_loss_limit_counts_down_refuses_what_would_cross_it_and_locks_when_reached() {
        let l = RiskLimits {
            daily_loss_limit: Some(500.0),
            ..RiskLimits::default()
        };
        let down = day("-190");
        assert_eq!(left_today(&l, &down), Some(d("310")));
        let s = standing(&AccountId::new("a"), &l, false, &down, Timestamp(0)).unwrap();
        assert_eq!(s.daily_loss_left.unwrap().amount, d("310"));
        assert!(!s.locked);
        assert!(check(&l, &entry("1", Some("100")), &down).is_empty());
        let w = check(&l, &entry("1", Some("260")), &down);
        assert_eq!(w[0].severity, CheckSeverity::Warn);
        assert_eq!(
            w[0].message,
            "This stop risks $260: $260 of the $310 left today."
        );
        let b = check(&l, &entry("2", Some("340")), &down);
        assert_eq!(
            blocks(&b),
            ["This stop risks $340: over the $310 left of your $500 daily loss limit."]
        );
        let with_open = OrderFacts {
            open_risk: d("200"),
            ..entry("1", Some("150"))
        };
        assert_eq!(
            blocks(&check(&l, &with_open, &down)),
            [
                "This stop risks $150 and your working stops $200: over the $310 left of your $500 daily loss limit."
            ]
        );
        assert!(blocks(&check(&l, &entry("1", Some("310")), &down)).is_empty());
        let out = day("-500");
        let s = standing(&AccountId::new("a"), &l, false, &out, Timestamp(0)).unwrap();
        assert!(s.locked);
        let why = "Your $500 daily loss limit is reached: no new positions today. Exits work.";
        assert_eq!(s.locked_why.as_deref(), Some(why));
        assert_eq!(blocks(&check(&l, &entry("1", None), &out)), [why]);
        let exit = OrderFacts {
            opening: Decimal::ZERO,
            ..entry("1", None)
        };
        assert!(check(&l, &exit, &out).is_empty());
        assert!(check(&l, &entry("1", None), &down).is_empty());
    }

    #[test]
    fn risk_per_trade_size_and_trades_each_say_their_number() {
        let l = RiskLimits {
            max_risk_per_trade: Some(250.0),
            max_order_qty: Some(5),
            max_position_qty: Some(10),
            max_trades_per_day: Some(6),
            ..RiskLimits::default()
        };
        let mut today = day("0");
        today.trades_today = Some(2);
        assert!(check(&l, &entry("2", Some("150")), &today).is_empty());
        assert_eq!(
            check(&l, &entry("2", Some("230")), &today)[0].message,
            "This stop risks $230 of your $250 a trade."
        );
        assert_eq!(
            blocks(&check(&l, &entry("2", Some("340")), &today)),
            ["This stop risks $340: over your $250 a trade."]
        );
        assert_eq!(
            blocks(&check(&l, &entry("1", None), &today)),
            ["No stop: your $250 a trade is measured at the stop. Add one."]
        );
        let big = OrderFacts {
            after: d("12"),
            ..entry("8", Some("100"))
        };
        assert_eq!(
            blocks(&check(&l, &big, &today)),
            [
                "8 contracts: over your 5 contracts an order.",
                "That holds 12 contracts: over your 10 contracts."
            ]
        );
        today.trades_today = Some(6);
        assert_eq!(
            blocks(&check(&l, &entry("1", Some("100")), &today)),
            [
                "6 trades today, your limit: no new trades today. Adding to or closing a position works."
            ]
        );
        let add = OrderFacts {
            opens_trade: false,
            after: d("2"),
            ..entry("1", Some("100"))
        };
        assert!(check(&l, &add, &today).is_empty());
        let s = standing(&AccountId::new("a"), &l, true, &today, Timestamp(0)).unwrap();
        assert_eq!(s.trades_today, Some(6));
        assert!(s.own && !s.locked && s.daily_loss_left.is_none());
    }

    #[test]
    fn the_firms_rules_count_only_when_given() {
        let firm = RiskStatus {
            account_id: AccountId::new("apex"),
            daily_loss_limit: None,
            daily_loss_remaining: None,
            trailing_threshold: Some(Money::usd(d("48000"))),
            trailing_room: Some(Money::usd(d("400"))),
            high_water_mark: None,
            room: Some(Money::usd(d("400"))),
            locked: false,
            locked_until: None,
            breach: None,
            contract_limits: None,
            as_of: Timestamp(0),
        };
        let none = RiskLimits::default();
        assert!(check(&none, &entry("1", Some("500")), &day("0")).is_empty());
        let mut used = day("0");
        used.firm = Some(firm.clone());
        assert_eq!(
            blocks(&check(&none, &entry("1", Some("500")), &used)),
            ["This stop risks $500: over the $400 your firm's rules leave."]
        );
        let s = standing(&AccountId::new("apex"), &none, false, &used, Timestamp(0)).unwrap();
        assert_eq!(s.firm_room.unwrap().amount, d("400"));
        used.firm = Some(RiskStatus {
            locked: true,
            ..firm
        });
        assert_eq!(
            blocks(&check(&none, &entry("1", Some("10")), &used)),
            ["Your firm's platform has this account locked: no new positions. Exits work."]
        );
    }

    #[test]
    fn a_stop_moved_away_is_weighed_for_the_trade_and_the_day() {
        let l = RiskLimits {
            daily_loss_limit: Some(500.0),
            max_risk_per_trade: Some(250.0),
            ..RiskLimits::default()
        };
        let down = day("-190");
        assert_eq!(check_stop_move(&l, d("200"), d("200"), &down), None);
        assert_eq!(
            check_stop_move(&l, d("300"), d("300"), &down).unwrap(),
            "The stop there risks $300 from your entry: over your $250 a trade."
        );
        assert_eq!(
            check_stop_move(&l, d("200"), d("400"), &down).unwrap(),
            "Your stops there risk $400: over the $310 left of your $500 daily loss limit."
        );
        assert_eq!(
            check_stop_move(&RiskLimits::default(), d("9999"), d("9999"), &down),
            None
        );
    }

    fn fill(side: Side, qty: i64, ts: i64) -> Fill {
        Fill {
            id: FillId::generate(),
            broker_fill_id: None,
            order_id: None,
            account_id: AccountId::new("a"),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            side,
            qty: Qty::from(qty),
            price: Price(d("20000")),
            ts: Timestamp(ts),
            fee: Money::usd(Decimal::ZERO),
            realized_pnl: None,
            source: "paper".into(),
        }
    }

    fn position(qty: i64) -> Position {
        Position {
            account_id: AccountId::new("a"),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            qty: Qty::from(qty),
            avg_price: Price(d("20000")),
            realized_pnl: Money::usd(Decimal::ZERO),
            unrealized_pnl: None,
            mark: Some(Price(d("20010"))),
            opened_at: Timestamp(0),
        }
    }

    #[test]
    fn trades_start_from_flat_or_a_flip_counting_from_the_overnight_position() {
        use Side::{Buy, Sell};
        let fills = [
            fill(Buy, 2, 1),
            fill(Buy, 1, 2),
            fill(Sell, 3, 3),
            fill(Sell, 1, 4),
            fill(Buy, 2, 5),
        ];
        assert_eq!(trades_today(&[position(1)], &fills), 3);
        let overnight = [fill(Sell, 2, 1), fill(Buy, 1, 2)];
        assert_eq!(trades_today(&[position(1)], &overnight), 1);
        assert_eq!(trades_today(&[], &[]), 0);
        assert!(opens_trade(Decimal::ZERO, Buy, d("1"), false));
        assert!(!opens_trade(d("2"), Buy, d("1"), false), "adding");
        assert!(opens_trade(d("2"), Sell, d("3"), false), "a flip");
        assert!(!opens_trade(d("2"), Sell, d("2"), false), "a close");
        assert!(
            !opens_trade(Decimal::ZERO, Buy, d("1"), true),
            "reduce-only"
        );
        assert_eq!(opening_qty(d("2"), Sell, d("3"), false), d("1"));
    }

    fn order(id: &str, side: Side, kind: OrderType, stop: Option<&str>, role: OrderRole) -> Order {
        Order {
            id: OrderId::new(id),
            broker_order_id: None,
            draft_id: None,
            request: OrderRequest {
                account_id: AccountId::new("a"),
                instrument: InstrumentId::new("NQZ6.CME").unwrap(),
                side,
                qty: Qty::from(1),
                order_type: kind,
                limit_price: (kind == OrderType::Limit).then(|| Price(d("19990"))),
                stop_price: stop.map(|s| Price(d(s))),
                tif: TimeInForce::Day,
                bracket: None,
                client_order_id: None,
                reduce_only: role != OrderRole::Entry,
            },
            role,
            parent_id: None,
            status: OrderStatus::Working,
            filled_qty: Qty::ZERO,
            avg_fill_price: None,
            queue_ahead: None,
            stop_rules: None,
            triggered_at: None,
            environment: tessera_core::Environment::Paper,
            reason: None,
            created_at: Timestamp(0),
            updated_at: Timestamp(0),
        }
    }

    #[test]
    fn open_risk_is_each_stop_from_the_mark_and_each_working_entry_to_its_stop() {
        let mult = |_: &InstrumentId| Some(Decimal::from(20));
        let stop = order(
            "s",
            Side::Sell,
            OrderType::Stop,
            Some("20000"),
            OrderRole::Exit,
        );
        let entry = order("e", Side::Buy, OrderType::Limit, None, OrderRole::Entry);
        let mut child = order(
            "c",
            Side::Sell,
            OrderType::Stop,
            Some("19980"),
            OrderRole::StopLoss,
        );
        child.parent_id = Some(OrderId::new("e"));
        child.status = OrderStatus::Held;
        let orders = [stop, entry, child];
        assert_eq!(open_risk(&[position(1)], &orders, &mult, None), d("400"));
        assert_eq!(
            open_risk(&[position(1)], &orders, &mult, Some(&OrderId::new("e"))),
            d("200")
        );
        assert_eq!(open_risk(&[position(1)], &[], &mult, None), Decimal::ZERO);
    }

    #[test]
    fn an_add_working_without_its_legs_is_counted_to_the_positions_stop() {
        let mult = |_: &InstrumentId| Some(Decimal::from(20));
        let mut stop = order(
            "s",
            Side::Sell,
            OrderType::Stop,
            Some("20000"),
            OrderRole::StopLoss,
        );
        stop.parent_id = Some(OrderId::new("f"));
        let mut add = order("a", Side::Buy, OrderType::Limit, None, OrderRole::Entry);
        add.request.limit_price = Some(Price(d("20005")));
        let under = order("u", Side::Buy, OrderType::Limit, None, OrderRole::Entry);
        let orders = [stop, add, under];
        assert_eq!(adds_risk(&[position(1)], &orders, &mult, None), d("100"));
        assert_eq!(
            adds_risk(&[position(1)], &orders, &mult, Some(&OrderId::new("a"))),
            Decimal::ZERO
        );
        assert_eq!(adds_risk(&[], &orders, &mult, None), Decimal::ZERO);
    }
}
