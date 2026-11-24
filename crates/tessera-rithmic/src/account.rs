use std::str::FromStr;

use rithmic_rs::RithmicAccount;
use rithmic_rs::rti::{
    AccountPnLPositionUpdate, AccountRmsUpdates, ExchangeOrderNotification,
    InstrumentPnLPositionUpdate, ResponseAccountList, ResponseAccountRmsInfo,
    ResponseShowFillHistory, RithmicOrderNotification,
};
use rust_decimal::Decimal;
use tessera_core::accounts::{
    AccountSummary, ContractLimits, Environment, Restrictions, RiskStatus, TradingAccount,
    mask_account_number,
};
use tessera_core::ids::{AccountId, BrokerId, ConnectionId, FillId, OrderId};
use tessera_core::money::{Currency, Money, Price, Qty, decimal_from_f64};
use tessera_core::orders::{
    Fill, Order, OrderRequest, OrderRole, OrderStatus, OrderType, Position, Side, TimeInForce,
};
use tessera_core::time::Timestamp;

use crate::firms;
use crate::map::message_time;
use crate::symbols::instrument_id;

/// Rithmic's "no limit" for an RMS loss limit (sent as `9999999`).
pub const NO_LOSS_LIMIT: Decimal = Decimal::from_parts(9_999_999, 0, 0, false, 0);

pub fn account_key(provider_id: &str, account: &RithmicAccount) -> AccountId {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in [&account.fcm_id, &account.ib_id, &account.account_id] {
        for b in part.bytes().chain([0]) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    AccountId::new(format!("{provider_id}-{:012x}", h >> 16))
}

pub fn dec(s: Option<&str>) -> Option<Decimal> {
    let s = s?.trim();
    if s.is_empty() {
        return None;
    }
    Decimal::from_str(s)
        .or_else(|_| Decimal::from_scientific(s))
        .ok()
        .map(|d| d.normalize())
}

fn dec_f(v: Option<f64>) -> Option<Decimal> {
    v.and_then(decimal_from_f64)
}

fn clean_price(v: f64) -> Option<Price> {
    crate::map::clean(v).map(Price)
}

fn currency(code: Option<&str>) -> Currency {
    match code.map(|c| c.trim().to_ascii_uppercase()).as_deref() {
        Some("EUR") => Currency::Eur,
        Some("GBP") => Currency::Gbp,
        _ => Currency::Usd,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AccountInfo {
    pub account: RithmicAccount,
    pub id: AccountId,
    pub name: Option<String>,
    pub currency: Currency,
    pub loss_limit: Option<Decimal>,
    pub auto_liquidate: Option<String>,
    pub auto_liq_threshold: Option<Decimal>,
    pub created: Option<Timestamp>,
}

impl AccountInfo {
    pub fn from_list(provider_id: &str, a: &ResponseAccountList) -> Option<Self> {
        let account_id = a.account_id.clone().filter(|s| !s.is_empty())?;
        let account = RithmicAccount::new(
            a.fcm_id.clone().unwrap_or_default(),
            a.ib_id.clone().unwrap_or_default(),
            account_id,
        );
        Some(Self {
            id: account_key(provider_id, &account),
            account,
            name: a.account_name.clone(),
            currency: currency(a.account_currency.as_deref()),
            loss_limit: dec(a.loss_limit.as_deref()).filter(|l| is_limit(*l)),
            auto_liquidate: a.account_auto_liquidate.clone(),
            auto_liq_threshold: dec(a.auto_liq_threshold_current_value.as_deref()),
            created: a
                .account_creation_ssboe
                .filter(|s| *s > 0)
                .map(|s| Timestamp::from_secs(i64::from(s))),
        })
    }

    pub fn trading_account(&self, provider_id: &str, system: &str) -> TradingAccount {
        TradingAccount {
            id: self.id.clone(),
            display_name: self.account.account_id.clone(),
            environment: firms::environment(system, &self.account.account_id, self.name.as_deref()),
            broker_id: BrokerId::new(provider_id),
            connection_id: ConnectionId::new(provider_id),
            program_id: None,
            rule_set_id: None,
            currency: self.currency,
            restrictions: Restrictions::default(),
            group_id: None,
            external_ref_masked: Some(mask_account_number(&self.account.account_id)),
        }
    }
}

fn is_limit(l: Decimal) -> bool {
    l > Decimal::ZERO && l < NO_LOSS_LIMIT
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RmsLimits {
    pub status: Option<String>,
    pub algorithm: Option<String>,
    pub auto_liquidate: bool,
    pub auto_liquidate_criteria: Option<String>,
    pub auto_liquidate_threshold: Option<Decimal>,
    pub auto_liquidate_max_min_account_balance: Option<Decimal>,
    pub loss_limit: Option<Decimal>,
    pub min_account_balance: Option<Decimal>,
    pub check_min_account_balance: bool,
    pub buy_limit: Option<i32>,
    pub sell_limit: Option<i32>,
    pub max_order_quantity: Option<i32>,
}

impl RmsLimits {
    pub fn contract_limits(&self) -> Option<ContractLimits> {
        let count = |n: Option<i32>| n.and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0);
        let l = ContractLimits {
            buy: count(self.buy_limit),
            sell: count(self.sell_limit),
            per_order: count(self.max_order_quantity),
        };
        (l.buy.is_some() || l.sell.is_some() || l.per_order.is_some()).then_some(l)
    }

    pub fn from_info(i: &ResponseAccountRmsInfo) -> Option<(String, Self)> {
        let account = i.account_id.clone().filter(|s| !s.is_empty())?;
        Some((
            account,
            Self {
                status: i.status.clone(),
                algorithm: i.algorithm.clone(),
                auto_liquidate: i.auto_liquidate == Some(1),
                auto_liquidate_criteria: i.auto_liquidate_criteria.clone(),
                auto_liquidate_threshold: dec_f(i.auto_liquidate_threshold),
                auto_liquidate_max_min_account_balance: dec_f(
                    i.auto_liquidate_max_min_account_balance,
                ),
                loss_limit: dec_f(i.loss_limit).filter(|l| is_limit(*l)),
                min_account_balance: dec_f(i.min_account_balance),
                check_min_account_balance: i.check_min_account_balance == Some(true),
                buy_limit: i.buy_limit,
                sell_limit: i.sell_limit,
                max_order_quantity: i.max_order_quantity,
            },
        ))
    }

    pub fn is_locked(&self) -> bool {
        self.status
            .as_deref()
            .is_some_and(|s| !s.trim().eq_ignore_ascii_case("active"))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RmsLive {
    pub threshold: Option<Decimal>,
    pub peak: Option<Decimal>,
}

impl RmsLive {
    pub fn merge(&mut self, u: &AccountRmsUpdates) {
        if let Some(v) = dec(u.auto_liq_threshold_current_value.as_deref()) {
            self.threshold = Some(v);
        }
        if let Some(v) = dec(u.auto_liq_peak_account_balance.as_deref()) {
            self.peak = Some(v);
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountPnl {
    pub account_balance: Option<Decimal>,
    pub cash_on_hand: Option<Decimal>,
    pub open_position_pnl: Option<Decimal>,
    pub closed_position_pnl: Option<Decimal>,
    pub day_pnl: Option<Decimal>,
    pub day_open_pnl: Option<Decimal>,
    pub day_closed_pnl: Option<Decimal>,
    pub available_buying_power: Option<Decimal>,
    pub min_account_balance: Option<Decimal>,
    pub commission: Option<Decimal>,
    pub net_quantity: Option<i32>,
    pub as_of: Option<Timestamp>,
}

impl AccountPnl {
    pub fn merge(&mut self, u: &AccountPnLPositionUpdate) {
        let set = |slot: &mut Option<Decimal>, v: &Option<String>| {
            if let Some(d) = dec(v.as_deref()) {
                *slot = Some(d);
            }
        };
        set(&mut self.account_balance, &u.account_balance);
        set(&mut self.cash_on_hand, &u.cash_on_hand);
        set(&mut self.open_position_pnl, &u.open_position_pnl);
        set(&mut self.closed_position_pnl, &u.closed_position_pnl);
        set(&mut self.day_pnl, &u.day_pnl);
        set(&mut self.day_open_pnl, &u.day_open_pnl);
        set(&mut self.day_closed_pnl, &u.day_closed_pnl);
        set(&mut self.available_buying_power, &u.available_buying_power);
        set(&mut self.min_account_balance, &u.min_account_balance);
        set(&mut self.commission, &u.rms_account_commission);
        if u.net_quantity.is_some() {
            self.net_quantity = u.net_quantity;
        }
        if let Some(ts) = message_time((None, None, None), (u.ssboe, u.usecs)) {
            self.as_of = Some(ts);
        }
    }

    fn balance(&self) -> Decimal {
        self.account_balance
            .or(self.cash_on_hand)
            .unwrap_or_default()
    }

    fn open(&self) -> Decimal {
        self.open_position_pnl.unwrap_or_default()
    }

    pub fn net_liq(&self) -> Decimal {
        self.balance() + self.open()
    }

    fn day(&self) -> Decimal {
        self.day_pnl.unwrap_or_else(|| {
            self.day_open_pnl.unwrap_or_default() + self.day_closed_pnl.unwrap_or_default()
        })
    }
}

/// A prop account on Rithmic reports no buying power.
pub fn summary(
    account: &AccountId,
    currency: Currency,
    pnl: &AccountPnl,
    now: Timestamp,
) -> AccountSummary {
    let m = |d: Decimal| Money::new(d, currency);
    AccountSummary {
        account_id: account.clone(),
        balance: m(pnl.balance()),
        net_liq: m(pnl.net_liq()),
        day_pnl: m(pnl.day()),
        realized_today: m(pnl.day_closed_pnl.unwrap_or_default()),
        fees_today: m(pnl.commission.unwrap_or_default()),
        unrealized_today: m(pnl.day_open_pnl.unwrap_or_default()),
        open_pnl: m(pnl.open()),
        buying_power: m(pnl.available_buying_power.unwrap_or_else(|| pnl.net_liq())),
        as_of: pnl.as_of.unwrap_or(now),
    }
}

pub fn risk(
    info: &AccountInfo,
    rms: Option<&RmsLimits>,
    live: RmsLive,
    pnl: &AccountPnl,
    now: Timestamp,
) -> Option<RiskStatus> {
    let m = |d: Decimal| Money::new(d, info.currency);
    let min_balance_checked = rms.is_some_and(|r| r.auto_liquidate || r.check_min_account_balance);
    let threshold = live.threshold.or(info.auto_liq_threshold).or_else(|| {
        min_balance_checked
            .then(|| {
                rms.and_then(|r| r.min_account_balance)
                    .or(pnl.min_account_balance)
            })
            .flatten()
    });
    let loss_limit = rms.and_then(|r| r.loss_limit).or(info.loss_limit);
    let locked = rms.is_some_and(RmsLimits::is_locked);
    let contract_limits = rms.and_then(RmsLimits::contract_limits);
    if threshold.is_none() && loss_limit.is_none() && !locked && contract_limits.is_none() {
        return None;
    }
    let net_liq = pnl.net_liq();
    let trailing_room = threshold.map(|t| (net_liq - t).max(Decimal::ZERO));
    let daily_left = loss_limit.map(|l| (l + pnl.day()).max(Decimal::ZERO));
    let room = match (trailing_room, daily_left) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    Some(RiskStatus {
        account_id: info.id.clone(),
        daily_loss_limit: loss_limit.map(m),
        daily_loss_remaining: daily_left.map(m),
        trailing_threshold: threshold.map(m),
        trailing_room: trailing_room.map(m),
        high_water_mark: live.peak.map(m),
        room: room.map(m),
        locked,
        locked_until: None,
        breach: None,
        contract_limits,
        as_of: pnl.as_of.unwrap_or(now),
    })
}

pub fn position(
    account: &AccountId,
    u: &InstrumentPnLPositionUpdate,
    prev: Option<&Position>,
    currency: Currency,
    now: Timestamp,
) -> Option<Position> {
    let instrument = match (&u.symbol, &u.exchange) {
        (Some(s), Some(e)) => instrument_id(s, e),
        _ => prev?.instrument.clone(),
    };
    let net = u
        .net_quantity
        .or_else(|| Some(u.buy_qty? - u.sell_qty?))
        .map(i64::from)
        .or_else(|| prev.map(|p| p.qty.value().try_into().unwrap_or(0)))?;
    let money = |d: Decimal| Money::new(d, currency);
    let ts = message_time((None, None, None), (u.ssboe, u.usecs)).unwrap_or(now);
    Some(Position {
        account_id: account.clone(),
        instrument,
        qty: Qty::from(net),
        avg_price: u
            .avg_open_fill_price
            .and_then(clean_price)
            .or(prev.map(|p| p.avg_price))
            .unwrap_or(Price::ZERO),
        realized_pnl: dec_f(u.day_closed_pnl)
            .or_else(|| dec(u.closed_position_pnl.as_deref()))
            .map(money)
            .or(prev.map(|p| p.realized_pnl))
            .unwrap_or(Money::zero(currency)),
        unrealized_pnl: dec(u.open_position_pnl.as_deref())
            .or_else(|| dec_f(u.day_open_pnl))
            .map(money)
            .or(prev.and_then(|p| p.unrealized_pnl)),
        mark: prev.and_then(|p| p.mark),
        opened_at: prev
            .filter(|p| !p.qty.is_zero())
            .map_or(ts, |p| p.opened_at),
    })
}

fn side(transaction_type: Option<i32>) -> Option<Side> {
    match transaction_type? {
        1 => Some(Side::Buy),
        2 | 3 => Some(Side::Sell),
        _ => None,
    }
}

fn side_str(s: Option<&str>) -> Option<Side> {
    match s?.trim().to_ascii_uppercase().as_str() {
        "BUY" | "B" | "1" => Some(Side::Buy),
        "SELL" | "S" | "SS" | "2" | "3" => Some(Side::Sell),
        _ => None,
    }
}

fn order_type(price_type: Option<i32>) -> Option<OrderType> {
    match price_type? {
        1 => Some(OrderType::Limit),
        2 => Some(OrderType::Market),
        3 => Some(OrderType::StopLimit),
        4 => Some(OrderType::Stop),
        _ => None,
    }
}

fn tif(duration: Option<i32>) -> Option<TimeInForce> {
    match duration? {
        1 => Some(TimeInForce::Day),
        2 => Some(TimeInForce::Gtc),
        3 => Some(TimeInForce::Ioc),
        4 => Some(TimeInForce::Fok),
        _ => None,
    }
}

pub fn order_status(
    status: Option<&str>,
    notify_type: Option<i32>,
    completion_reason: Option<&str>,
    filled: i32,
    unfilled: Option<i32>,
) -> Option<OrderStatus> {
    let complete = || {
        let reason = completion_reason.unwrap_or_default().to_ascii_lowercase();
        if reason.contains("fill") {
            OrderStatus::Filled
        } else if reason.contains("reject") || reason.contains("fail") {
            OrderStatus::Rejected
        } else if reason.contains("expire") {
            OrderStatus::Expired
        } else if reason.contains("cancel") {
            OrderStatus::Cancelled
        } else if filled > 0 && unfilled.unwrap_or(0) == 0 {
            OrderStatus::Filled
        } else {
            OrderStatus::Cancelled
        }
    };
    let working = || {
        if filled > 0 {
            OrderStatus::PartiallyFilled
        } else {
            OrderStatus::Working
        }
    };
    if let Some(s) = status.map(|s| s.trim().to_ascii_lowercase()) {
        match s.as_str() {
            "complete" | "completed" => return Some(complete()),
            "filled" => return Some(OrderStatus::Filled),
            "cancelled" | "canceled" => return Some(OrderStatus::Cancelled),
            "rejected" => return Some(OrderStatus::Rejected),
            "expired" => return Some(OrderStatus::Expired),
            "cancel pending" | "cancel received" | "cancel sent to exch" => {
                return Some(OrderStatus::PendingCancel);
            }
            "open pending" | "pending" | "order received" | "order sent to exch" => {
                return Some(OrderStatus::PendingSubmit);
            }
            "open" | "partial" | "partially filled" | "modify pending" | "trigger pending" => {
                return Some(working());
            }
            _ => {}
        }
    }
    match notify_type? {
        1 | 4 | 7 | 10 => Some(OrderStatus::PendingSubmit),
        3 | 6 | 9 | 12 => Some(OrderStatus::PendingCancel),
        2 | 5 | 8 | 11 | 13 | 14 | 18 => Some(working()),
        15 => Some(complete()),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Ctx<'a> {
    pub provider_id: &'a str,
    pub account: &'a AccountId,
    pub environment: Environment,
    pub currency: Currency,
}

impl Ctx<'_> {
    pub fn order_id(&self, basket_id: &str) -> OrderId {
        OrderId::new(format!("{}-{basket_id}", self.provider_id))
    }
}

const EXIT_TAG: &str = "-ro";

pub fn exit_tag(tag: String, reduce_only: bool) -> String {
    if reduce_only && !tag.ends_with(EXIT_TAG) {
        format!("{tag}{EXIT_TAG}")
    } else {
        tag
    }
}

pub fn apply_order_notification(
    prev: Option<&Order>,
    n: &RithmicOrderNotification,
    ctx: Ctx<'_>,
    now: Timestamp,
) -> Option<Order> {
    let basket = n.basket_id.as_deref().filter(|b| !b.is_empty())?;
    let ts = message_time((None, None, None), (n.ssboe, n.usecs)).unwrap_or(now);
    let instrument = match (&n.symbol, &n.exchange) {
        (Some(s), Some(e)) => instrument_id(s, e),
        _ => prev?.request.instrument.clone(),
    };
    let prev_req = prev.map(|o| &o.request);
    let order_type = order_type(n.price_type)
        .or(prev_req.map(|r| r.order_type))
        .unwrap_or(OrderType::Market);
    let uses_limit = matches!(order_type, OrderType::Limit | OrderType::StopLimit);
    let uses_stop = matches!(order_type, OrderType::Stop | OrderType::StopLimit);
    let request = OrderRequest {
        account_id: ctx.account.clone(),
        instrument,
        side: side(n.transaction_type)
            .or(prev_req.map(|r| r.side))
            .unwrap_or(Side::Buy),
        // Rithmic's open-pending and trigger-pending notifications can carry a quantity of 0.
        qty: n
            .quantity
            .filter(|q| *q > 0)
            .map(|q| Qty::from(i64::from(q)))
            .or(prev_req.map(|r| r.qty))
            .unwrap_or(Qty::ZERO),
        order_type,
        limit_price: if uses_limit {
            n.price
                .and_then(clean_price)
                .or(prev_req.and_then(|r| r.limit_price))
        } else {
            None
        },
        stop_price: if uses_stop {
            n.trigger_price
                .and_then(clean_price)
                .or(prev_req.and_then(|r| r.stop_price))
        } else {
            None
        },
        tif: tif(n.duration)
            .or(prev_req.map(|r| r.tif))
            .unwrap_or(TimeInForce::Day),
        bracket: None,
        client_order_id: n
            .user_tag
            .clone()
            .or(prev_req.and_then(|r| r.client_order_id.clone())),
        reduce_only: prev_req.map_or_else(
            || n.user_tag.as_deref().is_some_and(|t| t.ends_with(EXIT_TAG)),
            |r| r.reduce_only,
        ),
    };
    let filled = n
        .total_fill_size
        .or(prev.and_then(|o| o.filled_qty.value().try_into().ok()))
        .unwrap_or(0);
    let status = order_status(
        n.status.as_deref(),
        n.notify_type,
        n.completion_reason.as_deref(),
        filled,
        n.total_unfilled_size,
    )
    .or(prev.map(|o| o.status))
    .unwrap_or(OrderStatus::Working);
    let status = match prev.map(|o| o.status) {
        Some(ended) if ended.is_terminal() && !status.is_terminal() => ended,
        _ => status,
    };
    let reason = matches!(status, OrderStatus::Rejected | OrderStatus::Cancelled)
        .then(|| {
            [&n.text, &n.report_text, &n.completion_reason]
                .into_iter()
                .flatten()
                .find(|t| !t.trim().is_empty())
                .cloned()
        })
        .flatten()
        .or(prev.and_then(|o| o.reason.clone()));
    Some(Order {
        id: ctx.order_id(basket),
        broker_order_id: Some(basket.to_owned()),
        draft_id: prev.and_then(|o| o.draft_id.clone()),
        request,
        role: prev.map_or(OrderRole::default(), |o| o.role),
        parent_id: prev.and_then(|o| o.parent_id.clone()),
        status,
        filled_qty: Qty::from(i64::from(filled)),
        avg_fill_price: n
            .avg_fill_price
            .filter(|p| *p > 0.0)
            .and_then(clean_price)
            .or(prev.and_then(|o| o.avg_fill_price)),
        queue_ahead: None,
        stop_rules: prev.and_then(|o| o.stop_rules),
        triggered_at: prev.and_then(|o| o.triggered_at),
        environment: ctx.environment,
        reason,
        created_at: prev.map_or(ts, |o| o.created_at),
        updated_at: ts,
    })
}

pub fn fill_from_exchange(n: &ExchangeOrderNotification, ctx: Ctx<'_>) -> Option<Fill> {
    if n.notify_type != Some(5) {
        return None;
    }
    let price = clean_price(n.fill_price?)?;
    let qty = Qty::from(i64::from(n.fill_size.filter(|s| *s > 0)?));
    let basket = n.basket_id.as_deref().filter(|b| !b.is_empty());
    let exec = n
        .fill_id
        .clone()
        .or_else(|| Some(format!("{}-{}", basket?, n.sequence_number.as_deref()?)))?;
    let ts = message_time(
        (n.source_ssboe, n.source_usecs, n.source_nsecs),
        (n.ssboe, n.usecs),
    )?;
    Some(Fill {
        id: FillId::new(format!("{}-{exec}", ctx.provider_id)),
        broker_fill_id: Some(exec),
        order_id: basket.map(|b| ctx.order_id(b)),
        account_id: ctx.account.clone(),
        instrument: instrument_id(n.symbol.as_deref()?, n.exchange.as_deref()?),
        side: side(n.transaction_type)?,
        qty,
        price,
        ts,
        fee: Money::zero(ctx.currency),
        realized_pnl: None,
        source: "rithmic".into(),
    })
}

pub fn fill_from_history(f: &ResponseShowFillHistory, ctx: Ctx<'_>) -> Option<Fill> {
    let price = clean_price(f.fill_price?)?;
    let qty = Qty::from(i64::try_from(f.fill_size.filter(|s| *s > 0)?).ok()?);
    let basket = f.basket_id.as_deref().filter(|b| !b.is_empty());
    let exec = f
        .fill_id
        .clone()
        .or_else(|| Some(format!("{}-{}", basket?, f.sequence_number.as_deref()?)))?;
    let ts = message_time(
        (f.source_ssboe, f.source_usecs, f.source_nsecs),
        (f.ssboe, f.usecs),
    )?;
    Some(Fill {
        id: FillId::new(format!("{}-{exec}", ctx.provider_id)),
        broker_fill_id: Some(exec),
        order_id: basket.map(|b| ctx.order_id(b)),
        account_id: ctx.account.clone(),
        instrument: instrument_id(f.symbol.as_deref()?, f.exchange.as_deref()?),
        side: side_str(f.transaction_type.as_deref())?,
        qty,
        price,
        ts,
        fee: Money::zero(ctx.currency),
        realized_pnl: None,
        source: "rithmic".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rithmic-rs message structs are `#[non_exhaustive]`, so tests build them from `Default`.
    macro_rules! msg {
        ($ty:ident { $($field:ident: $value:expr),* $(,)? }) => {{
            let mut m = $ty::default();
            $(m.$field = $value;)*
            m
        }};
    }

    fn acct() -> RithmicAccount {
        RithmicAccount::new("TestFcm", "TestIb", "TEST-000001-01")
    }

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn info() -> AccountInfo {
        AccountInfo::from_list(
            "rithmic-apex",
            &msg!(ResponseAccountList {
                fcm_id: Some("TestFcm".into()),
                ib_id: Some("TestIb".into()),
                account_id: Some("TEST-000001-01".into()),
                account_name: Some("TEST-000001 (Sample)".into()),
                account_currency: Some("USD".into()),
                loss_limit: Some("9999999".into()),
                account_auto_liquidate: Some("enabled".into()),
                auto_liq_threshold_current_value: Some("24000.000000".into()),
                account_creation_ssboe: Some(1_780_000_000),
            }),
        )
        .unwrap()
    }

    fn pnl(balance: &str, open: &str, day: &str) -> AccountPnl {
        let mut p = AccountPnl::default();
        p.merge(&msg!(AccountPnLPositionUpdate {
            is_snapshot: Some(true),
            account_balance: Some(balance.into()),
            cash_on_hand: Some(balance.into()),
            open_position_pnl: Some(open.into()),
            day_pnl: Some(day.into()),
            available_buying_power: Some(String::new()),
            min_account_balance: Some("24000.00".into()),
            ssboe: Some(1_791_390_487),
        }));
        p
    }

    #[test]
    fn account_ids_hide_the_number_and_stay_stable() {
        let id = account_key("rithmic-apex", &acct());
        assert!(id.as_str().starts_with("rithmic-apex-"));
        assert!(!id.as_str().contains("000001"));
        assert_eq!(id, account_key("rithmic-apex", &acct()));
        let other = RithmicAccount::new("TestFcm", "TestIb", "TEST-000001-02");
        assert_ne!(id, account_key("rithmic-apex", &other));

        let a = info().trading_account("rithmic-apex", "Apex");
        assert_eq!(a.id, id);
        assert_eq!(a.display_name, "TEST-000001-01");
        assert_eq!(a.external_ref_masked.as_deref(), Some("••••1-01"));
        assert_eq!(a.environment, Environment::Eval);
        assert_eq!(a.currency, Currency::Usd);
    }

    #[test]
    fn the_end_of_list_frame_is_not_an_account() {
        assert!(AccountInfo::from_list("p", &ResponseAccountList::default()).is_none());
        assert!(RmsLimits::from_info(&ResponseAccountRmsInfo::default()).is_none());
    }

    #[test]
    fn an_account_knows_when_it_was_created() {
        assert_eq!(info().created, Some(Timestamp::from_secs(1_780_000_000)));
        let unsaid = msg!(ResponseAccountList {
            account_id: Some("TEST-000001-01".into()),
            account_creation_ssboe: Some(0),
        });
        assert_eq!(AccountInfo::from_list("p", &unsaid).unwrap().created, None);
    }

    #[test]
    fn no_limit_is_no_limit() {
        let i = info();
        assert_eq!(i.loss_limit, None);
        assert_eq!(i.auto_liq_threshold, Some(d("24000")));
        assert_eq!(dec(Some("")), None);
        assert_eq!(dec(Some("25000.00")), Some(d("25000")));
    }

    #[test]
    fn summary_reads_the_pnl_plant() {
        let s = summary(
            &info().id,
            Currency::Usd,
            &pnl("25000.00", "-150.50", "-150.50"),
            Timestamp(0),
        );
        assert_eq!(s.balance.amount, d("25000"));
        assert_eq!(s.open_pnl.amount, d("-150.5"));
        assert_eq!(s.net_liq.amount, d("24849.5"));
        assert_eq!(s.day_pnl.amount, d("-150.5"));
        assert_eq!(s.buying_power.amount, d("24849.5"));
        assert_eq!(s.as_of, Timestamp::from_secs(1_791_390_487));
    }

    #[test]
    fn updates_keep_what_they_do_not_carry() {
        let mut p = pnl("25000.00", "0.00", "0.00");
        p.merge(&msg!(AccountPnLPositionUpdate {
            open_position_pnl: Some("12.50".into()),
            account_balance: Some(String::new()),
        }));
        assert_eq!(p.account_balance, Some(d("25000")));
        assert_eq!(p.open_position_pnl, Some(d("12.5")));
    }

    #[test]
    fn the_auto_liquidation_balance_is_the_trailing_threshold() {
        let (acct, rms) = RmsLimits::from_info(&msg!(ResponseAccountRmsInfo {
            account_id: Some("TEST-000001-01".into()),
            status: Some("active".into()),
            algorithm: Some("Max Loss".into()),
            auto_liquidate: Some(1),
            auto_liquidate_criteria: Some("Limited Trailing Minimum Account Balance".into()),
            auto_liquidate_threshold: Some(1000.0),
            auto_liquidate_max_min_account_balance: Some(26500.0),
            loss_limit: Some(9_999_999.0),
            min_account_balance: Some(24000.0),
            check_min_account_balance: Some(false),
            max_order_quantity: Some(8),
        }))
        .unwrap();
        assert_eq!(acct, "TEST-000001-01");
        assert_eq!(rms.loss_limit, None);
        let r = risk(
            &info(),
            Some(&rms),
            RmsLive::default(),
            &pnl("25000.00", "-300.00", "-300.00"),
            Timestamp(0),
        )
        .unwrap();
        assert_eq!(r.trailing_threshold.unwrap().amount, d("24000"));
        assert_eq!(r.trailing_room.unwrap().amount, d("700"));
        assert_eq!(r.room.unwrap().amount, d("700"));
        assert_eq!(r.daily_loss_limit, None);
        assert!(!r.locked);

        let mut live = RmsLive::default();
        live.merge(&msg!(AccountRmsUpdates {
            auto_liq_threshold_current_value: Some("24200.00".into()),
            auto_liq_peak_account_balance: Some("25200.00".into()),
        }));
        let r = risk(
            &info(),
            Some(&rms),
            live,
            &pnl("25100", "0", "0"),
            Timestamp(0),
        )
        .unwrap();
        assert_eq!(r.trailing_threshold.unwrap().amount, d("24200"));
        assert_eq!(r.high_water_mark.unwrap().amount, d("25200"));
        assert_eq!(r.trailing_room.unwrap().amount, d("900"));
        let r = risk(
            &info(),
            Some(&rms),
            live,
            &pnl("24000", "0", "0"),
            Timestamp(0),
        )
        .unwrap();
        assert_eq!(r.trailing_room.unwrap().amount, Decimal::ZERO);
    }

    #[test]
    fn a_daily_loss_limit_counts_down_with_the_day() {
        let rms = RmsLimits {
            status: Some("active".into()),
            loss_limit: Some(d("500")),
            ..RmsLimits::default()
        };
        let mut i = info();
        i.auto_liq_threshold = None;
        let r = risk(
            &i,
            Some(&rms),
            RmsLive::default(),
            &pnl("25000", "-120", "-120"),
            Timestamp(0),
        )
        .unwrap();
        assert_eq!(r.daily_loss_limit.unwrap().amount, d("500"));
        assert_eq!(r.daily_loss_remaining.unwrap().amount, d("380"));
        assert_eq!(r.trailing_threshold, None);
        assert_eq!(r.room.unwrap().amount, d("380"));

        let locked = RmsLimits {
            status: Some("Auto Liquidated".into()),
            ..rms
        };
        assert!(
            risk(
                &i,
                Some(&locked),
                RmsLive::default(),
                &pnl("25000", "0", "0"),
                Timestamp(0)
            )
            .unwrap()
            .locked
        );
        assert!(
            risk(
                &i,
                None,
                RmsLive::default(),
                &pnl("25000", "0", "0"),
                Timestamp(0)
            )
            .is_none()
        );
    }

    #[test]
    fn positions_come_from_instrument_pnl() {
        let id = info().id;
        let u = msg!(InstrumentPnLPositionUpdate {
            symbol: Some("MNQZ6".into()),
            exchange: Some("CME".into()),
            net_quantity: Some(-2),
            avg_open_fill_price: Some(21012.25),
            open_position_pnl: Some("-15.00".into()),
            day_closed_pnl: Some(40.0),
            ssboe: Some(1_791_390_000),
        });
        let p = position(&id, &u, None, Currency::Usd, Timestamp(0)).unwrap();
        assert_eq!(p.instrument.as_str(), "MNQZ6.CME-RITHMIC");
        assert_eq!(p.qty, Qty::from(-2));
        assert_eq!(p.avg_price, Price::from_f64(21012.25).unwrap());
        assert_eq!(p.unrealized_pnl.unwrap().amount, d("-15"));
        assert_eq!(p.realized_pnl.amount, d("40"));
        assert_eq!(p.opened_at, Timestamp::from_secs(1_791_390_000));

        let later = msg!(InstrumentPnLPositionUpdate {
            symbol: Some("MNQZ6".into()),
            exchange: Some("CME".into()),
            net_quantity: Some(0),
            ssboe: Some(1_791_390_100),
        });
        let closed = position(&id, &later, Some(&p), Currency::Usd, Timestamp(0)).unwrap();
        assert!(closed.qty.is_zero());
        assert_eq!(closed.opened_at, p.opened_at);
    }

    fn ctx(id: &AccountId) -> Ctx<'_> {
        Ctx {
            provider_id: "rithmic-apex",
            account: id,
            environment: Environment::Eval,
            currency: Currency::Usd,
        }
    }

    #[test]
    fn order_notifications_fold_into_one_order() {
        let id = info().id;
        let open = msg!(RithmicOrderNotification {
            basket_id: Some("B1".into()),
            symbol: Some("ESZ6".into()),
            exchange: Some("CME".into()),
            status: Some("open".into()),
            notify_type: Some(13),
            quantity: Some(2),
            price: Some(6702.25),
            price_type: Some(1),
            transaction_type: Some(1),
            duration: Some(1),
            ssboe: Some(100),
        });
        let o = apply_order_notification(None, &open, ctx(&id), Timestamp(0)).unwrap();
        assert_eq!(o.id.as_str(), "rithmic-apex-B1");
        assert_eq!(o.status, OrderStatus::Working);
        assert_eq!(o.request.order_type, OrderType::Limit);
        assert_eq!(o.request.limit_price, Price::from_f64(6702.25));
        assert_eq!(o.request.stop_price, None);
        assert_eq!(o.request.qty, Qty::from(2));
        assert_eq!(o.request.instrument.as_str(), "ESZ6.CME-RITHMIC");

        let part = msg!(RithmicOrderNotification {
            basket_id: Some("B1".into()),
            status: Some("open".into()),
            total_fill_size: Some(1),
            total_unfilled_size: Some(1),
            avg_fill_price: Some(6702.25),
            ssboe: Some(101),
        });
        let o = apply_order_notification(Some(&o), &part, ctx(&id), Timestamp(0)).unwrap();
        assert_eq!(o.status, OrderStatus::PartiallyFilled);
        assert_eq!(o.request.qty, Qty::from(2));
        assert_eq!(o.created_at, Timestamp::from_secs(100));

        let pending = msg!(RithmicOrderNotification {
            basket_id: Some("B1".into()),
            status: Some("open pending".into()),
            quantity: Some(0),
        });
        let o = apply_order_notification(Some(&o), &pending, ctx(&id), Timestamp(0)).unwrap();
        assert_eq!(o.request.qty, Qty::from(2));

        let done = msg!(RithmicOrderNotification {
            basket_id: Some("B1".into()),
            status: Some("complete".into()),
            completion_reason: Some("Fill".into()),
            total_fill_size: Some(2),
            total_unfilled_size: Some(0),
        });
        let o = apply_order_notification(Some(&o), &done, ctx(&id), Timestamp(0)).unwrap();
        assert_eq!(o.status, OrderStatus::Filled);
        assert_eq!(o.filled_qty, Qty::from(2));

        assert!(apply_order_notification(None, &part, ctx(&id), Timestamp(0)).is_none());
    }

    #[test]
    fn an_exit_tessera_sent_is_reduce_only_again_after_a_restart() {
        let id = info().id;
        let tag = exit_tag("ord_1".into(), true);
        assert_eq!(tag, "ord_1-ro");
        assert_eq!(exit_tag(tag.clone(), true), tag);
        assert_eq!(exit_tag("ord_2".into(), false), "ord_2");
        let working = |tag: &str| {
            msg!(RithmicOrderNotification {
                basket_id: Some("B7".into()),
                symbol: Some("NQZ6".into()),
                exchange: Some("CME".into()),
                status: Some("open".into()),
                quantity: Some(2),
                trigger_price: Some(20641.25),
                price_type: Some(4),
                transaction_type: Some(2),
                duration: Some(1),
                user_tag: Some(tag.into()),
            })
        };
        let exit = apply_order_notification(None, &working(&tag), ctx(&id), Timestamp(0)).unwrap();
        assert!(exit.request.reduce_only);
        let entry =
            apply_order_notification(None, &working("ord_2"), ctx(&id), Timestamp(0)).unwrap();
        assert!(!entry.request.reduce_only);
    }

    #[test]
    fn a_filled_order_never_goes_back_to_working() {
        let id = info().id;
        let mut n = msg!(RithmicOrderNotification {
            basket_id: Some("B9".into()),
            symbol: Some("NQZ6".into()),
            exchange: Some("CME".into()),
            status: Some("complete".into()),
            completion_reason: Some("Fill".into()),
            quantity: Some(2),
            total_fill_size: Some(2),
            total_unfilled_size: Some(0),
            price: Some(20641.25),
            price_type: Some(1),
            transaction_type: Some(2),
            duration: Some(1),
        });
        let filled = apply_order_notification(None, &n, ctx(&id), Timestamp(0)).unwrap();
        assert_eq!(filled.status, OrderStatus::Filled);
        n.status = Some("open".into());
        n.completion_reason = None;
        let late = apply_order_notification(Some(&filled), &n, ctx(&id), Timestamp(1)).unwrap();
        assert_eq!(late.status, OrderStatus::Filled, "a late notification");
    }

    #[test]
    fn statuses_read_text_then_kind() {
        use OrderStatus::*;
        let s = |st: Option<&str>, nt, reason, filled| order_status(st, nt, reason, filled, None);
        assert_eq!(s(Some("open pending"), None, None, 0), Some(PendingSubmit));
        assert_eq!(s(Some("Trigger Pending"), None, None, 0), Some(Working));
        assert_eq!(
            s(Some("cancel pending"), None, None, 0),
            Some(PendingCancel)
        );
        assert_eq!(
            s(Some("complete"), None, Some("Cancel"), 0),
            Some(Cancelled)
        );
        assert_eq!(s(Some("complete"), None, Some("Reject"), 0), Some(Rejected));
        assert_eq!(s(Some("complete"), None, None, 0), Some(Cancelled));
        assert_eq!(s(None, Some(15), Some("Fill"), 1), Some(Filled));
        assert_eq!(s(None, Some(13), None, 1), Some(PartiallyFilled));
        assert_eq!(s(None, Some(10), None, 0), Some(PendingSubmit));
        assert_eq!(s(None, Some(19), None, 0), None);
    }

    #[test]
    fn fills_come_from_notifications_and_history() {
        let id = info().id;
        let n = msg!(ExchangeOrderNotification {
            notify_type: Some(5),
            basket_id: Some("B1".into()),
            fill_id: Some("F9".into()),
            symbol: Some("ESZ6".into()),
            exchange: Some("CME".into()),
            transaction_type: Some(2),
            fill_price: Some(6701.5),
            fill_size: Some(1),
            source_ssboe: Some(200),
            source_nsecs: Some(5_000_000),
        });
        let f = fill_from_exchange(&n, ctx(&id)).unwrap();
        assert_eq!(f.id.as_str(), "rithmic-apex-F9");
        assert_eq!(f.order_id.as_ref().unwrap().as_str(), "rithmic-apex-B1");
        assert_eq!(f.side, Side::Sell);
        assert_eq!(f.ts, Timestamp(200_005_000_000));
        let mut status = n.clone();
        status.notify_type = Some(1);
        assert!(fill_from_exchange(&status, ctx(&id)).is_none());

        let h = msg!(ResponseShowFillHistory {
            basket_id: Some("B1".into()),
            fill_id: Some("F9".into()),
            symbol: Some("ESZ6".into()),
            exchange: Some("CME".into()),
            transaction_type: Some("SELL".into()),
            fill_price: Some(6701.5),
            fill_size: Some(1),
            source_ssboe: Some(200),
            source_nsecs: Some(5_000_000),
        });
        assert_eq!(fill_from_history(&h, ctx(&id)).unwrap(), f);
        assert!(fill_from_history(&ResponseShowFillHistory::default(), ctx(&id)).is_none());
    }
}
