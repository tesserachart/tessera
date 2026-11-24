use std::collections::{BTreeMap, HashMap};

use rust_decimal::Decimal;
use rust_decimal::prelude::{Signed, ToPrimitive};
use tessera_core::accounts::AccountSummary;
use tessera_core::ids::{AccountId, DraftId, FillId, OrderId};
use tessera_core::instrument::{AssetClass, ContractSpec};
use tessera_core::margin::initial_margin;
use tessera_core::market::{Quote, Trade};
use tessera_core::money::Money;
use tessera_core::orders::{
    Bracket, CheckSeverity, Fill, Order, OrderPreview, OrderRequest, OrderRole, OrderStatus,
    OrderType, Position, PreTradeCheck, Side, StopRules, TimeInForce,
};
use tessera_core::products::{Product, product};
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{InstrumentId, Price, Qty, Timestamp};

use super::account::{PaperAccount, clock_label};
use super::room::{Margining, Opening, Stake, max_order_qty};
use crate::OrderChanges;
use crate::limits::opening_qty;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Commission {
    pub standard: Decimal,
    pub micro: Decimal,
}

impl Commission {
    pub const NONE: Self = Self {
        standard: Decimal::ZERO,
        micro: Decimal::ZERO,
    };

    pub const RETAIL: Self = Self {
        standard: Decimal::from_parts(287, 0, 0, false, 2),
        micro: Decimal::from_parts(94, 0, 0, false, 2),
    };

    pub fn per_side(&self, spec: &ContractSpec) -> Decimal {
        match (spec.asset_class, spec.root.as_deref()) {
            (AssetClass::Future, Some(root)) if product(root).is_some_and(Product::is_micro) => {
                self.micro
            }
            (AssetClass::Future, _) => self.standard,
            _ => Decimal::ZERO,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaperConfig {
    pub commission: Commission,
    pub max_quote_age_nanos: i64,
}

impl Default for PaperConfig {
    fn default() -> Self {
        Self {
            commission: Commission::RETAIL,
            max_quote_age_nanos: 5 * NANOS_PER_SEC,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feed {
    Live { heard_at: Timestamp },
    Down,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BookError {
    #[error("account {0} is not on this connection")]
    UnknownAccount(AccountId),
    #[error("no market data for {0}")]
    UnknownInstrument(InstrumentId),
    #[error("order {0} not found")]
    UnknownOrder(OrderId),
    #[error("{0}")]
    NotOpen(String),
    #[error("{0}")]
    Refused(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Changes {
    pub orders: Vec<Order>,
    pub fills: Vec<Fill>,
    pub positions: Vec<Position>,
    pub accounts: Vec<AccountId>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.orders.is_empty()
            && self.fills.is_empty()
            && self.positions.is_empty()
            && self.accounts.is_empty()
    }

    fn order(&mut self, o: &Order) {
        match self.orders.iter_mut().find(|x| x.id == o.id) {
            Some(x) => *x = o.clone(),
            None => self.orders.push(o.clone()),
        }
    }

    fn position(&mut self, p: &Position) {
        match self
            .positions
            .iter_mut()
            .find(|x| x.account_id == p.account_id && x.instrument == p.instrument)
        {
            Some(x) => *x = p.clone(),
            None => self.positions.push(p.clone()),
        }
    }

    fn account(&mut self, a: &AccountId) {
        if !self.accounts.contains(a) {
            self.accounts.push(a.clone());
        }
    }

    pub fn merge(&mut self, other: Changes) {
        for o in &other.orders {
            self.order(o);
        }
        self.fills.extend(other.fills);
        for p in &other.positions {
            self.position(p);
        }
        for a in &other.accounts {
            self.account(a);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Market {
    spec: ContractSpec,
    tradable: bool,
    quote: Option<Quote>,
    heard_at: Option<Timestamp>,
}

type PositionKey = (AccountId, InstrumentId);

#[derive(Clone, Debug, Default)]
pub struct Book {
    config: PaperConfig,
    accounts: BTreeMap<AccountId, PaperAccount>,
    orders: BTreeMap<OrderId, Order>,
    positions: BTreeMap<PositionKey, Position>,
    fills: Vec<Fill>,
    markets: HashMap<InstrumentId, Market>,
    synced: HashMap<OrderId, Decimal>,
}

fn signed(side: Side, qty: Decimal) -> Decimal {
    Decimal::from(side.sign()) * qty
}

pub fn usd(amount: Decimal) -> String {
    let neg = amount.is_sign_negative() && !amount.is_zero();
    let a = amount.abs().round_dp(2);
    let whole = a.trunc();
    let cents = ((a - whole) * Decimal::from(100))
        .round()
        .to_u32()
        .unwrap_or(0);
    let grouped = grouped(&whole.to_string());
    let sign = if neg { "−" } else { "" };
    if cents == 0 {
        format!("{sign}${grouped}")
    } else {
        format!("{sign}${grouped}.{cents:02}")
    }
}

pub fn price_label(spec: &ContractSpec, p: Price) -> String {
    let v = p.0.round_dp(spec.price_decimals);
    let s = format!("{:.*}", spec.price_decimals as usize, v);
    let (int, frac) = s
        .split_once('.')
        .map_or((s.as_str(), None), |(i, f)| (i, Some(f)));
    let (neg, int) = int
        .strip_prefix('-')
        .map_or((false, int), |rest| (true, rest));
    let grouped = grouped(int);
    let sign = if neg { "−" } else { "" };
    match frac {
        Some(f) => format!("{sign}{grouped}.{f}"),
        None => format!("{sign}{grouped}"),
    }
}

const NOTHING_SENT: &str = "Nothing sent.";

const ORDER_KEPT: &str = "The order stays as it was.";

pub fn qty_label(q: Qty) -> String {
    q.0.normalize().to_string()
}

fn grouped(digits: &str) -> String {
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn count_label(n: Decimal) -> String {
    let n = n.normalize();
    if !n.fract().is_zero() {
        return n.to_string();
    }
    let sign = if n.is_sign_negative() { "−" } else { "" };
    format!("{sign}{}", grouped(&n.abs().to_string()))
}

impl Book {
    pub fn new(config: PaperConfig) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }

    pub fn config(&self) -> PaperConfig {
        self.config
    }

    pub fn set_commission(&mut self, commission: Commission) {
        self.config.commission = Commission {
            standard: commission.standard.max(Decimal::ZERO),
            micro: commission.micro.max(Decimal::ZERO),
        };
    }

    pub fn add_account(&mut self, account: PaperAccount) {
        self.accounts.insert(account.id().clone(), account);
    }

    pub fn restore_order(&mut self, order: Order) {
        if order.role == OrderRole::Entry && !order.filled_qty.is_zero() {
            self.synced.insert(order.id.clone(), order.filled_qty.0);
        }
        self.orders.insert(order.id.clone(), order);
    }

    pub fn restore_position(&mut self, position: Position) {
        if !position.qty.is_zero() {
            self.positions.insert(
                (position.account_id.clone(), position.instrument.clone()),
                position,
            );
        }
    }

    pub fn restore_fill(&mut self, fill: Fill) {
        self.fills.push(fill);
    }

    pub fn set_market(&mut self, spec: ContractSpec, tradable: bool) {
        let entry = self
            .markets
            .entry(spec.instrument.clone())
            .or_insert_with(|| Market {
                spec: spec.clone(),
                tradable,
                quote: None,
                heard_at: None,
            });
        entry.spec = spec;
        entry.tradable = tradable;
    }

    pub fn has_market(&self, instrument: &InstrumentId) -> bool {
        self.markets.contains_key(instrument)
    }

    pub fn accounts(&self) -> impl Iterator<Item = &PaperAccount> {
        let mut v: Vec<&PaperAccount> = self.accounts.values().collect();
        v.sort_by_key(|a| (a.account.environment as u8, a.name().to_lowercase()));
        v.into_iter()
    }

    pub fn account(&self, id: &AccountId) -> Option<&PaperAccount> {
        self.accounts.get(id)
    }

    pub fn order(&self, id: &OrderId) -> Option<&Order> {
        self.orders.get(id)
    }

    pub fn orders(&self, account: Option<&AccountId>) -> Vec<Order> {
        self.orders
            .values()
            .filter(|o| account.is_none_or(|a| &o.request.account_id == a))
            .cloned()
            .collect()
    }

    pub fn positions(&self, account: Option<&AccountId>) -> Vec<Position> {
        self.positions
            .values()
            .filter(|p| account.is_none_or(|a| &p.account_id == a))
            .cloned()
            .collect()
    }

    pub fn fills(&self, account: Option<&AccountId>, since: Timestamp) -> Vec<Fill> {
        self.fills
            .iter()
            .filter(|f| f.ts >= since && account.is_none_or(|a| &f.account_id == a))
            .cloned()
            .collect()
    }

    pub fn instruments_of_interest(&self) -> Vec<InstrumentId> {
        let mut v: Vec<InstrumentId> = self
            .orders
            .values()
            .filter(|o| o.status.is_open())
            .map(|o| o.request.instrument.clone())
            .chain(self.positions.keys().map(|(_, i)| i.clone()))
            .collect();
        v.sort();
        v.dedup();
        v
    }

    pub fn net_liq(&self, id: &AccountId) -> Option<Money> {
        let a = self.accounts.get(id)?;
        Some(Money::new(
            a.balance.amount + self.open_pnl(id).amount,
            a.balance.currency,
        ))
    }

    fn open_pnl(&self, id: &AccountId) -> Money {
        let currency = self
            .accounts
            .get(id)
            .map_or(tessera_core::money::Currency::Usd, |a| a.balance.currency);
        let amount = self
            .positions
            .values()
            .filter(|p| &p.account_id == id)
            .filter_map(|p| p.unrealized_pnl)
            .map(|m| m.amount)
            .sum();
        Money::new(amount, currency)
    }

    pub fn summary(&self, id: &AccountId, now: Timestamp) -> Option<AccountSummary> {
        let a = self.accounts.get(id)?;
        let net = self.net_liq(id)?;
        let unmarked = self
            .positions
            .values()
            .filter(|p| &p.account_id == id && a.awaiting_day_mark.contains(&p.instrument))
            .filter_map(|p| p.unrealized_pnl)
            .map(|m| m.amount)
            .sum();
        let power = self.buying_power(id)?;
        Some(a.summary(net, self.open_pnl(id), unmarked, power, now))
    }

    fn day_start_net_liq(&self, id: &AccountId) -> (Money, Vec<InstrumentId>) {
        let a = &self.accounts[id];
        let mut awaiting = Vec::new();
        let mut open = Decimal::ZERO;
        for p in self.positions.values().filter(|p| &p.account_id == id) {
            let quoted = self
                .markets
                .get(&p.instrument)
                .is_some_and(|m| m.quote.is_some());
            match (quoted, p.unrealized_pnl) {
                (true, Some(u)) => open += u.amount,
                _ => awaiting.push(p.instrument.clone()),
            }
        }
        (
            Money::new(a.balance.amount + open, a.balance.currency),
            awaiting,
        )
    }

    fn mark_day_start(&mut self, quote: &Quote, spec: &ContractSpec, ch: &mut Changes) {
        let i = &quote.instrument;
        let mark = self.mark(i);
        for (id, a) in &mut self.accounts {
            if !a.awaiting_day_mark.contains(i) {
                continue;
            }
            let settlement = quote
                .session
                .as_ref()
                .filter(|s| s.trade_date == a.day)
                .and_then(|s| s.prev_close);
            let Some(at) = settlement.or(mark) else {
                continue;
            };
            let open = self
                .positions
                .get(&(id.clone(), i.clone()))
                .map_or(Decimal::ZERO, |p| open_pnl(p, at, spec).amount);
            if a.mark_day_start(i, open) {
                ch.account(id);
            }
        }
    }

    pub fn buying_power(&self, id: &AccountId) -> Option<Money> {
        let net = self.net_liq(id)?;
        Some(Money::new(
            net.amount - self.margin_held(id, None, None),
            net.currency,
        ))
    }

    fn margin_per_contract(&self, i: &InstrumentId) -> Option<Decimal> {
        let spec = &self.markets.get(i)?.spec;
        if spec.asset_class != AssetClass::Future {
            return None;
        }
        initial_margin(spec.root.as_deref()?).map(|m| m.amount)
    }

    fn stake(&self, account: &AccountId, i: &InstrumentId, except: Option<&OrderId>) -> Stake {
        let mut stake = Stake {
            held: self.position_qty(account, i),
            ..Stake::default()
        };
        let working = self.orders.values().filter(|o| {
            &o.request.account_id == account
                && &o.request.instrument == i
                && o.status.is_open()
                && !o.request.reduce_only
                && Some(&o.id) != except
        });
        for o in working {
            stake.add(o.request.side, o.remaining().0);
        }
        stake
    }

    fn margin_held(
        &self,
        account: &AccountId,
        except: Option<&OrderId>,
        extra: Option<(&InstrumentId, Side, Decimal)>,
    ) -> Decimal {
        let mut instruments: Vec<&InstrumentId> = self
            .positions
            .keys()
            .filter(|(a, _)| a == account)
            .map(|(_, i)| i)
            .chain(
                self.orders
                    .values()
                    .filter(|o| &o.request.account_id == account && o.status.is_open())
                    .map(|o| &o.request.instrument),
            )
            .chain(extra.map(|(i, _, _)| i))
            .collect();
        instruments.sort();
        instruments.dedup();
        instruments
            .into_iter()
            .filter_map(|i| {
                let per = self.margin_per_contract(i)?;
                let mut stake = self.stake(account, i, except);
                if let Some((at, side, qty)) = extra
                    && at == i
                {
                    stake.add(side, qty);
                }
                Some(stake.contracts() * per)
            })
            .sum()
    }

    fn opening(
        &self,
        req: &OrderRequest,
        spec: &ContractSpec,
        resized: Option<&Order>,
    ) -> Option<Opening> {
        let net_liq = self.net_liq(&req.account_id)?.amount;
        let product = spec
            .root
            .clone()
            .unwrap_or_else(|| req.instrument.symbol().to_owned());
        let qty = resized.map_or(req.qty.0, |o| req.qty.0 - o.filled_qty.0);
        let pos = self.position_qty(&req.account_id, &req.instrument);
        let future = spec.asset_class == AssetClass::Future;
        let margining = match self.margin_per_contract(&req.instrument) {
            Some(_) => Margining::PerContract,
            None if future => Margining::Unknown,
            None => Margining::NotFuture,
        };
        Some(Opening {
            max_order: future.then(|| max_order_qty(&product)),
            product,
            qty,
            opening: opening_qty(pos, req.side, qty, req.reduce_only),
            margining,
            net_liq,
            margin_before: self.margin_held(&req.account_id, None, None),
            margin_after: self.margin_held(
                &req.account_id,
                resized.map(|o| &o.id),
                Some((&req.instrument, req.side, qty)),
            ),
        })
    }

    fn market(&self, i: &InstrumentId) -> Result<&Market, BookError> {
        self.markets
            .get(i)
            .ok_or_else(|| BookError::UnknownInstrument(i.clone()))
    }

    fn mark(&self, i: &InstrumentId) -> Option<Price> {
        let q = self.markets.get(i)?.quote.as_ref()?;
        q.last.or_else(|| match (q.bid, q.ask) {
            (Some(b), Some(a)) => Some(Price((b.0 + a.0) / Decimal::from(2))),
            (b, a) => b.or(a),
        })
    }

    fn touch(&self, i: &InstrumentId, side: Side) -> Option<Price> {
        let q = self.markets.get(i)?.quote.as_ref()?;
        match side {
            Side::Buy => q.ask,
            Side::Sell => q.bid,
        }
        .or(q.last)
    }

    fn position_qty(&self, account: &AccountId, i: &InstrumentId) -> Decimal {
        self.positions
            .get(&(account.clone(), i.clone()))
            .map_or(Decimal::ZERO, |p| p.qty.0)
    }

    pub fn preview(&self, req: &OrderRequest, now: Timestamp) -> Result<OrderPreview, BookError> {
        let acct = self
            .accounts
            .get(&req.account_id)
            .ok_or_else(|| BookError::UnknownAccount(req.account_id.clone()))?;
        let m = self.market(&req.instrument)?;
        let spec = &m.spec;
        let symbol = req.instrument.symbol().to_owned();
        let mut checks = Vec::new();
        let mut block = |code: &str, message: String| {
            checks.push(PreTradeCheck {
                code: code.into(),
                severity: CheckSeverity::Block,
                message,
            });
        };

        if let Err(e) = req.validate(spec) {
            block("invalid", format!("{e}."));
        }
        if !m.tradable {
            block(
                "not_tradable",
                format!("{symbol} is a reference index: it does not trade."),
            );
        }
        let mark = self.mark(&req.instrument);
        let touch = self.touch(&req.instrument, req.side);
        if req.order_type == OrderType::Market {
            if !spec.sessions.is_open(now) {
                block(
                    "closed",
                    format!(
                        "{symbol} is closed. Opens {}. Nothing sent.",
                        clock_label(next_open(spec, now), now)
                    ),
                );
            } else if touch.is_none() {
                block(
                    "no_price",
                    format!("No price for {symbol} yet. Nothing sent."),
                );
            } else if !self.quote_fresh(&req.instrument, now) {
                let at = m.quote.as_ref().map_or(now, |q| q.ts);
                block(
                    "stale_price",
                    format!(
                        "No live price for {symbol} since {}. Nothing sent.",
                        clock_label(at, now.add_nanos(-1))
                    ),
                );
            }
        }
        let pos = self.position_qty(&req.account_id, &req.instrument);
        if req.reduce_only && (pos.is_zero() || pos.signum() == Decimal::from(req.side.sign())) {
            let held = if pos.is_zero() {
                "no position".to_owned()
            } else if pos > Decimal::ZERO {
                "a long position".to_owned()
            } else {
                "a short position".to_owned()
            };
            block(
                "reduce_only",
                format!(
                    "Reduce-only {} on {held} in {symbol}: it would add risk. Nothing sent.",
                    req.side.label().to_lowercase()
                ),
            );
        }
        if matches!(req.order_type, OrderType::Stop | OrderType::StopLimit)
            && let (Some(stop), Some(last)) = (req.stop_price, mark)
        {
            let through = match req.side {
                Side::Buy => stop <= last,
                Side::Sell => stop >= last,
            };
            if through {
                let (side, rel) = match req.side {
                    Side::Buy => ("Buy", "at or below"),
                    Side::Sell => ("Sell", "at or above"),
                };
                block(
                    "stop_through",
                    format!(
                        "{side} stop {} is {rel} the market ({}): it would fill at once. Use a limit.",
                        price_label(spec, stop),
                        price_label(spec, last)
                    ),
                );
            }
        }

        let est_price = match req.order_type {
            OrderType::Market => touch,
            OrderType::Limit => Some(match touch {
                Some(t) if crosses(req.side, req.limit_price, t) => t,
                _ => req.limit_price.unwrap_or_default(),
            }),
            OrderType::Stop | OrderType::StopLimit => req.stop_price,
        };
        let priced = req
            .bracket
            .zip(est_price)
            .map(|(b, fill)| b.priced_from(req.side, fill, spec.tick_size.0));
        if let (Some(b), Some(fill)) = (priced, est_price)
            && req.validate(spec).is_ok()
        {
            let (losing, winning) = match req.side {
                Side::Buy => ("at or above", "at or below"),
                Side::Sell => ("at or below", "at or above"),
            };
            let below = |p: Price| match req.side {
                Side::Buy => p < fill,
                Side::Sell => p > fill,
            };
            if let Some(s) = b.stop_loss.filter(|&s| !below(s)) {
                block(
                    "bracket_side",
                    format!(
                        "Stop {} is {losing} the market ({}): it would stop out at once.",
                        price_label(spec, s),
                        price_label(spec, fill)
                    ),
                );
            }
            if let Some(t) = b.take_profit.filter(|&t| below(t) || t == fill) {
                block(
                    "bracket_side",
                    format!(
                        "Target {} is {winning} the market ({}): it would fill at once.",
                        price_label(spec, t),
                        price_label(spec, fill)
                    ),
                );
            }
        }
        let opening = self.opening(req, spec, None);
        checks.extend(opening.iter().flat_map(|o| o.refusals(NOTHING_SENT)));
        let qty = req.qty;
        let est_fees = Money::new(
            self.config.commission.per_side(spec) * qty.0,
            acct.balance.currency,
        );
        let risk_to_stop = match (priced.and_then(|b| b.stop_loss), est_price) {
            (Some(stop), Some(entry)) => Some(
                spec.pnl(Qty(signed(req.side, qty.0)), entry, stop)
                    .scale(Decimal::NEGATIVE_ONE),
            ),
            _ => None,
        };
        Ok(OrderPreview {
            request: req.clone(),
            environment: acct.account.environment,
            restatement: req.restatement(),
            reference_price: mark,
            est_price,
            est_value: est_price.map(|p| spec.notional(qty, p)),
            est_fees: Some(est_fees),
            risk_to_stop,
            buying_power_after: opening
                .map(|o| Money::new(o.net_liq - o.margin_after, acct.balance.currency)),
            position_after: Some(Qty(pos + signed(req.side, qty.0))),
            checks,
            created_at: now,
        })
    }

    fn quote_fresh(&self, i: &InstrumentId, now: Timestamp) -> bool {
        self.markets
            .get(i)
            .and_then(|m| m.heard_at)
            .is_some_and(|t| now.0 - t.0 <= self.config.max_quote_age_nanos)
    }

    pub fn on_feed(&mut self, instrument: &InstrumentId, feed: Feed) {
        if let Some(m) = self.markets.get_mut(instrument) {
            m.heard_at = match feed {
                Feed::Live { heard_at } => m.heard_at.max(Some(heard_at)),
                Feed::Down => None,
            };
        }
    }

    pub fn submit(
        &mut self,
        req: OrderRequest,
        draft_id: Option<DraftId>,
        now: Timestamp,
    ) -> Result<(Order, Changes), BookError> {
        let mut ch = self.roll(now);
        if !self.accounts.contains_key(&req.account_id) {
            return Err(BookError::UnknownAccount(req.account_id.clone()));
        }
        if let Some(coid) = &req.client_order_id
            && let Some(o) = self.orders.values().find(|o| {
                o.request.account_id == req.account_id
                    && o.request.client_order_id.as_ref() == Some(coid)
            })
        {
            return Ok((o.clone(), ch));
        }
        let preview = self.preview(&req, now)?;
        let environment = self.accounts[&req.account_id].account.environment;
        let role = if req.reduce_only {
            OrderRole::Exit
        } else {
            OrderRole::Entry
        };
        let mut order = Order {
            id: OrderId::generate(),
            broker_order_id: None,
            draft_id,
            request: req,
            role,
            parent_id: None,
            status: OrderStatus::Working,
            filled_qty: Qty::ZERO,
            avg_fill_price: None,
            queue_ahead: None,
            stop_rules: None,
            triggered_at: None,
            environment,
            reason: None,
            created_at: now,
            updated_at: now,
        };
        order.broker_order_id = Some(order.id.to_string());
        if let Some(c) = preview
            .checks
            .iter()
            .find(|c| c.severity == CheckSeverity::Block)
        {
            order.status = OrderStatus::Rejected;
            order.reason = Some(c.message.clone());
            self.orders.insert(order.id.clone(), order.clone());
            ch.order(&order);
            return Ok((order, ch));
        }
        let id = order.id.clone();
        let tick = self.market(&order.request.instrument)?.spec.tick_size.0;
        let bracket = order
            .request
            .bracket
            .zip(preview.est_price)
            .map(|(b, at)| b.priced_from(order.request.side, at, tick));
        self.orders.insert(id.clone(), order.clone());
        ch.order(&order);
        if let Some(b) = bracket {
            self.attach_bracket_held(&id, b, now, &mut ch);
        }
        self.init_queue(&id);
        self.try_immediate(&id, now, &mut ch);
        if let Some(o) = self.orders.get(&id)
            && o.status.is_open()
            && matches!(o.request.tif, TimeInForce::Ioc | TimeInForce::Fok)
        {
            let why = format!(
                "{}: nothing filled at once. Cancelled.",
                o.request.tif.label()
            );
            self.cancel_tree(&id, &why, now, &mut ch);
        }
        Ok((self.orders[&id].clone(), ch))
    }

    fn attach_bracket_held(
        &mut self,
        entry: &OrderId,
        b: Bracket,
        now: Timestamp,
        ch: &mut Changes,
    ) {
        let parent = self.orders[entry].clone();
        let side = parent.request.side.opposite();
        let legs = [
            (
                OrderRole::StopLoss,
                b.stop_loss.map(|p| (OrderType::Stop, None, Some(p))),
            ),
            (
                OrderRole::TakeProfit,
                b.take_profit.map(|p| (OrderType::Limit, Some(p), None)),
            ),
        ];
        for (role, leg) in legs {
            let Some((order_type, limit_price, stop_price)) = leg else {
                continue;
            };
            let id = OrderId::generate();
            let child = Order {
                id: id.clone(),
                broker_order_id: Some(id.to_string()),
                draft_id: parent.draft_id.clone(),
                request: OrderRequest {
                    account_id: parent.request.account_id.clone(),
                    instrument: parent.request.instrument.clone(),
                    side,
                    qty: parent.request.qty,
                    order_type,
                    limit_price,
                    stop_price,
                    tif: TimeInForce::Gtc,
                    bracket: None,
                    client_order_id: None,
                    reduce_only: true,
                },
                role,
                parent_id: Some(entry.clone()),
                status: OrderStatus::Held,
                filled_qty: Qty::ZERO,
                avg_fill_price: None,
                queue_ahead: None,
                stop_rules: StopRules::of(&b).filter(|_| role == OrderRole::StopLoss),
                triggered_at: None,
                environment: parent.environment,
                reason: None,
                created_at: now,
                updated_at: now,
            };
            self.orders.insert(id, child.clone());
            ch.order(&child);
        }
    }

    pub fn cancel(&mut self, id: &OrderId, now: Timestamp) -> Result<(Order, Changes), BookError> {
        let mut ch = self.roll(now);
        let o = self
            .orders
            .get(id)
            .ok_or_else(|| BookError::UnknownOrder(id.clone()))?;
        if !o.status.is_open() {
            return Err(BookError::NotOpen(format!(
                "The order is already {}.",
                status_word(o.status)
            )));
        }
        self.cancel_tree(id, "Cancelled.", now, &mut ch);
        Ok((self.orders[id].clone(), ch))
    }

    pub fn modify(
        &mut self,
        id: &OrderId,
        changes: &OrderChanges,
        now: Timestamp,
    ) -> Result<(Order, Changes), BookError> {
        let mut ch = self.roll(now);
        let o = self
            .orders
            .get(id)
            .ok_or_else(|| BookError::UnknownOrder(id.clone()))?
            .clone();
        if !o.status.is_open() {
            return Err(BookError::NotOpen(format!(
                "The order is already {}.",
                status_word(o.status)
            )));
        }
        let m = self.market(&o.request.instrument)?.clone();
        let spec = &m.spec;
        let mut req = o.request.clone();
        if let Some(q) = changes.qty {
            if q <= o.filled_qty || q.0 <= Decimal::ZERO {
                return Err(BookError::Refused(format!(
                    "The quantity must stay above the {} already filled.",
                    qty_label(o.filled_qty)
                )));
            }
            if o.parent_id.is_some() && o.status == OrderStatus::Held {
                return Err(BookError::Refused(
                    "A bracket's stop and target follow the entry's fills until it fills; resize \
                     the entry."
                        .into(),
                ));
            }
            req.qty = q;
        }
        if let Some(p) = changes.limit_price {
            if req.limit_price.is_none() {
                return Err(BookError::Refused(format!(
                    "A {} order has no limit price.",
                    req.order_type.abbrev()
                )));
            }
            req.limit_price = Some(p);
        }
        if let Some(p) = changes.stop_price {
            if o.triggered_at.is_some() {
                return Err(BookError::Refused("The stop has already triggered.".into()));
            }
            if req.stop_price.is_none() {
                return Err(BookError::Refused(format!(
                    "A {} order has no stop price.",
                    req.order_type.abbrev()
                )));
            }
            req.stop_price = Some(p);
        }
        let carried = match (o.request.entry_price(), req.entry_price()) {
            (Some(from), Some(to)) if o.role == OrderRole::Entry && o.filled_qty.is_zero() => {
                Some(to.0 - from.0).filter(|d| !d.is_zero())
            }
            _ => None,
        };
        if let (Some(d), Some(b)) = (carried, req.bracket.as_mut()) {
            b.stop_loss = b.stop_loss.map(|p| Price(p.0 + d));
            b.take_profit = b.take_profit.map(|p| Price(p.0 + d));
        }
        req.validate(spec)
            .map_err(|e| BookError::Refused(format!("{e}.")))?;
        if changes.qty.is_some_and(|q| q > o.request.qty)
            && let Some(refused) = self
                .opening(&req, spec, Some(&o))
                .and_then(|grown| grown.refusals(ORDER_KEPT).into_iter().next())
        {
            return Err(BookError::Refused(refused.message));
        }
        if o.status != OrderStatus::Held
            && let (Some(stop), Some(last)) = (req.stop_price, self.mark(&req.instrument))
            && changes.stop_price.is_some()
        {
            let through = match req.side {
                Side::Buy => stop <= last,
                Side::Sell => stop >= last,
            };
            if through {
                return Err(BookError::Refused(format!(
                    "Stop {} is through the market ({}): it would fill at once. Flatten instead.",
                    price_label(spec, stop),
                    price_label(spec, last)
                )));
            }
        }
        let order = self.orders.get_mut(id).expect("checked above");
        let moved = order.request.limit_price != req.limit_price;
        order.request = req;
        order.updated_at = now;
        if moved {
            // A moved limit joins the back of its new price's queue.
            order.queue_ahead = None;
        }
        let order = order.clone();
        ch.order(&order);
        if order.status == OrderStatus::Held
            && (changes.limit_price.is_some() || changes.stop_price.is_some())
        {
            self.pin_held_leg(&order, now, &mut ch);
        }
        if let Some(d) = carried {
            self.carry_held_legs(id, d, now, &mut ch);
        }
        if order.role == OrderRole::Entry {
            self.sync_bracket(id, now, &mut ch);
        } else if changes.qty.is_some()
            && let Some(entry) = order.parent_id.clone()
        {
            let left = order.remaining().0;
            let siblings: Vec<OrderId> = self
                .orders
                .values()
                .filter(|c| {
                    c.parent_id.as_ref() == Some(&entry) && c.id != order.id && c.status.is_open()
                })
                .map(|c| c.id.clone())
                .collect();
            for sid in siblings {
                let c = self.orders.get_mut(&sid).expect("listed");
                let qty = Qty(c.filled_qty.0 + left);
                if c.request.qty != qty {
                    c.request.qty = qty;
                    c.updated_at = now;
                    let c = c.clone();
                    ch.order(&c);
                }
            }
        }
        self.init_queue(id);
        if moved {
            self.try_immediate(id, now, &mut ch);
        }
        Ok((self.orders[id].clone(), ch))
    }

    pub fn on_quote(&mut self, quote: &Quote, now: Timestamp) -> Changes {
        let mut ch = self.roll(now);
        let Some(m) = self.markets.get_mut(&quote.instrument) else {
            return ch;
        };
        m.quote = Some(quote.clone());
        m.heard_at = m.heard_at.max(Some(quote.ts.min(now)));
        let spec = m.spec.clone();
        self.mark_day_start(quote, &spec, &mut ch);
        let mark = self.mark(&quote.instrument);
        if let Some(mark) = mark {
            for p in self
                .positions
                .values_mut()
                .filter(|p| p.instrument == quote.instrument)
            {
                let unrealized = open_pnl(p, mark, &spec);
                if p.mark != Some(mark) || p.unrealized_pnl != Some(unrealized) {
                    p.mark = Some(mark);
                    p.unrealized_pnl = Some(unrealized);
                    ch.position(p);
                    ch.account(&p.account_id);
                }
            }
        }
        let resting: Vec<OrderId> = self
            .orders
            .values()
            .filter(|o| o.request.instrument == quote.instrument && o.queue_ahead.is_none())
            .map(|o| o.id.clone())
            .collect();
        for id in resting {
            if self.init_queue(&id)
                && let Some(o) = self.orders.get(&id)
            {
                ch.order(o);
            }
        }
        ch
    }

    pub fn on_trade(&mut self, trade: &Trade, now: Timestamp) -> Changes {
        let mut ch = self.roll(now);
        let Some(m) = self.markets.get_mut(&trade.instrument) else {
            return ch;
        };
        m.heard_at = m.heard_at.max(Some(trade.ts.min(now)));
        self.manage_stops(trade, now, &mut ch);
        let ids: Vec<OrderId> = self
            .orders
            .values()
            .filter(|o| o.request.instrument == trade.instrument && o.status.is_working())
            .map(|o| o.id.clone())
            .collect();
        let (p, size) = (trade.price, trade.size);
        for id in ids {
            let Some(o) = self.orders.get(&id).cloned() else {
                continue;
            };
            if !o.status.is_working() {
                continue;
            }
            let side = o.request.side;
            match o.request.order_type {
                OrderType::Market => {
                    if let Some(t) = self.touch(&o.request.instrument, side) {
                        self.execute(&id, o.remaining().0, t, now, &mut ch);
                    }
                }
                OrderType::Stop | OrderType::StopLimit if o.triggered_at.is_none() => {
                    let Some(stop) = o.request.stop_price else {
                        continue;
                    };
                    let triggered = match side {
                        Side::Buy => p >= stop,
                        Side::Sell => p <= stop,
                    };
                    if !triggered {
                        continue;
                    }
                    let order = self.orders.get_mut(&id).expect("listed above");
                    order.triggered_at = Some(now);
                    order.updated_at = now;
                    let order = order.clone();
                    ch.order(&order);
                    if o.request.order_type == OrderType::Stop {
                        let price = stop_fill(side, self.touch(&o.request.instrument, side), p);
                        self.execute(&id, o.remaining().0, price, now, &mut ch);
                    } else {
                        self.init_queue(&id);
                        self.try_immediate(&id, now, &mut ch);
                    }
                }
                OrderType::Limit | OrderType::StopLimit => {
                    let Some(limit) = o.request.limit_price else {
                        continue;
                    };
                    let through = match side {
                        Side::Buy => p < limit,
                        Side::Sell => p > limit,
                    };
                    if through {
                        self.execute(&id, o.remaining().0, limit, now, &mut ch);
                    } else if p == limit
                        && let Some(ahead) = o.queue_ahead
                    {
                        let consumed = size.0.min(ahead.0);
                        let left = ahead.0 - consumed;
                        let spare = size.0 - consumed;
                        let order = self.orders.get_mut(&id).expect("listed above");
                        order.queue_ahead = Some(Qty(left));
                        let order = order.clone();
                        ch.order(&order);
                        if left.is_zero() && spare > Decimal::ZERO {
                            self.execute(&id, spare.min(o.remaining().0), limit, now, &mut ch);
                        }
                    }
                }
                OrderType::Stop => {}
            }
        }
        ch
    }

    fn manage_stops(&mut self, trade: &Trade, now: Timestamp, ch: &mut Changes) {
        let Some(spec) = self.markets.get(&trade.instrument).map(|m| m.spec.clone()) else {
            return;
        };
        let ids: Vec<OrderId> = self
            .orders
            .values()
            .filter(|o| {
                o.request.instrument == trade.instrument
                    && o.stop_rules.is_some_and(|r| r.entry_price.is_some())
                    && o.triggered_at.is_none()
                    && o.status.is_working()
            })
            .map(|o| o.id.clone())
            .collect();
        for id in ids {
            let o = self.orders.get_mut(&id).expect("listed above");
            let (Some(mut rules), Some(stop)) = (o.stop_rules, o.request.stop_price) else {
                continue;
            };
            let long = o.request.side == Side::Sell;
            let next = rules.next_stop(&spec, long, trade.price, stop);
            let fired = rules.breakeven_done != o.stop_rules.is_some_and(|r| r.breakeven_done);
            o.stop_rules = Some(rules);
            if let Some(next) = next {
                o.request.stop_price = Some(next);
            }
            if next.is_some() || fired {
                o.updated_at = now;
                let o = o.clone();
                ch.order(&o);
            }
        }
    }

    fn init_queue(&mut self, id: &OrderId) -> bool {
        let Some(o) = self.orders.get(id) else {
            return false;
        };
        let rests = o.status.is_working()
            && (o.request.order_type == OrderType::Limit
                || (o.request.order_type == OrderType::StopLimit && o.triggered_at.is_some()));
        if !rests || o.queue_ahead.is_some() {
            return false;
        }
        let Some(limit) = o.request.limit_price else {
            return false;
        };
        let Some(q) = self
            .markets
            .get(&o.request.instrument)
            .and_then(|m| m.quote.as_ref())
        else {
            return false;
        };
        let (best, size) = match o.request.side {
            Side::Buy => (q.bid, q.bid_size),
            Side::Sell => (q.ask, q.ask_size),
        };
        let better = |a: Price, b: Price| match o.request.side {
            Side::Buy => a > b,
            Side::Sell => a < b,
        };
        let ahead = match best {
            Some(b) if b == limit => size,
            Some(b) if better(limit, b) => Some(Qty::ZERO),
            _ => None,
        };
        match ahead {
            Some(a) => {
                self.orders.get_mut(id).expect("checked").queue_ahead = Some(a);
                true
            }
            None => false,
        }
    }

    fn try_immediate(&mut self, id: &OrderId, now: Timestamp, ch: &mut Changes) {
        let Some(o) = self.orders.get(id).cloned() else {
            return;
        };
        if !o.status.is_working() {
            return;
        }
        let side = o.request.side;
        let instrument = &o.request.instrument;
        let Some(touch) = self
            .touch(instrument, side)
            .filter(|_| self.quote_fresh(instrument, now))
        else {
            return;
        };
        match o.request.order_type {
            OrderType::Market => self.execute(id, o.remaining().0, touch, now, ch),
            OrderType::Limit => {
                if crosses(side, o.request.limit_price, touch) {
                    self.execute(id, o.remaining().0, touch, now, ch);
                }
            }
            OrderType::StopLimit if o.triggered_at.is_some() => {
                if crosses(side, o.request.limit_price, touch) {
                    self.execute(id, o.remaining().0, touch, now, ch);
                }
            }
            OrderType::Stop | OrderType::StopLimit => {
                let (Some(stop), Some(last)) =
                    (o.request.stop_price, self.mark(&o.request.instrument))
                else {
                    return;
                };
                let through = match side {
                    Side::Buy => last >= stop,
                    Side::Sell => last <= stop,
                };
                if !through {
                    return;
                }
                let order = self.orders.get_mut(id).expect("checked");
                order.triggered_at = Some(now);
                order.updated_at = now;
                let order = order.clone();
                ch.order(&order);
                if o.request.order_type == OrderType::Stop {
                    let price = stop_fill(side, Some(touch), last);
                    self.execute(id, o.remaining().0, price, now, ch);
                } else {
                    self.try_immediate(id, now, ch);
                }
            }
        }
    }

    fn execute(
        &mut self,
        id: &OrderId,
        qty: Decimal,
        price: Price,
        now: Timestamp,
        ch: &mut Changes,
    ) {
        let Some(o) = self.orders.get(id).cloned() else {
            return;
        };
        let (account, instrument, side) = (
            o.request.account_id.clone(),
            o.request.instrument.clone(),
            o.request.side,
        );
        let mut qty = qty.min(o.remaining().0);
        if o.request.reduce_only {
            let pos = self.position_qty(&account, &instrument);
            let closable = if !pos.is_zero() && pos.signum() != Decimal::from(side.sign()) {
                pos.abs()
            } else {
                Decimal::ZERO
            };
            if closable.is_zero() {
                self.cancel_tree(id, "The position is flat: nothing to reduce.", now, ch);
                return;
            }
            qty = qty.min(closable);
        }
        if qty <= Decimal::ZERO {
            return;
        }
        let Some(spec) = self.markets.get(&instrument).map(|m| m.spec.clone()) else {
            return;
        };
        let realized =
            self.apply_to_position(&account, &instrument, side, qty, price, &spec, now, ch);
        let fee = self.config.commission.per_side(&spec) * qty;
        let currency = spec.currency;
        if let Some(a) = self.accounts.get_mut(&account) {
            a.book(realized.unwrap_or(Decimal::ZERO), fee);
        }
        ch.account(&account);
        let fill = Fill {
            id: FillId::generate(),
            broker_fill_id: None,
            order_id: Some(id.clone()),
            account_id: account,
            instrument,
            side,
            qty: Qty(qty),
            price,
            ts: now,
            fee: Money::new(fee, currency),
            realized_pnl: realized.map(|r| Money::new(r, currency)),
            source: "paper".into(),
        };
        self.fills.push(fill.clone());
        ch.fills.push(fill);

        let order = self.orders.get_mut(id).expect("checked");
        let before = order.filled_qty.0;
        let avg = match order.avg_fill_price {
            Some(a) => (a.0 * before + price.0 * qty) / (before + qty),
            None => price.0,
        };
        order.avg_fill_price = Some(Price(avg));
        order.filled_qty = Qty(before + qty);
        order.status = if order.remaining().0 <= Decimal::ZERO {
            OrderStatus::Filled
        } else {
            OrderStatus::PartiallyFilled
        };
        if order.status == OrderStatus::Filled {
            order.queue_ahead = None;
        }
        order.updated_at = now;
        let order = order.clone();
        ch.order(&order);
        self.after_fill(&order, now, ch);
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_to_position(
        &mut self,
        account: &AccountId,
        instrument: &InstrumentId,
        side: Side,
        qty: Decimal,
        price: Price,
        spec: &ContractSpec,
        now: Timestamp,
        ch: &mut Changes,
    ) -> Option<Decimal> {
        let key = (account.clone(), instrument.clone());
        let q = signed(side, qty);
        let mark = self.mark(instrument);
        let p = self
            .positions
            .entry(key.clone())
            .or_insert_with(|| Position {
                account_id: account.clone(),
                instrument: instrument.clone(),
                qty: Qty::ZERO,
                avg_price: price,
                realized_pnl: Money::zero(spec.currency),
                unrealized_pnl: None,
                mark: None,
                opened_at: now,
            });
        let pos = p.qty.0;
        let mult = spec.multiplier;
        let mut realized = None;
        if pos.is_zero() || pos.signum() == q.signum() {
            if pos.is_zero() {
                p.opened_at = now;
                p.realized_pnl = Money::zero(spec.currency);
            }
            let cost = cost_of(p, spec) + qty * price.0 * mult;
            p.qty = Qty(pos + q);
            p.avg_price = if pos.is_zero() {
                price
            } else {
                avg_of(cost, p.qty.0, mult, price)
            };
        } else {
            let closing = qty.min(pos.abs());
            let dir = pos.signum();
            let cost = cost_of(p, spec);
            let proceeds = closing * price.0 * mult;
            let (r, released) = if closing == pos.abs() {
                (dir * (proceeds - cost), cost)
            } else {
                let share = cost * closing / pos.abs();
                let r = Money::new(dir * (proceeds - share), spec.currency)
                    .round_cents()
                    .amount;
                (r, proceeds - dir * r)
            };
            p.realized_pnl.amount += r;
            realized = Some(r);
            let after = pos + q;
            p.qty = Qty(after);
            if !after.is_zero() && after.signum() != pos.signum() {
                p.avg_price = price;
                p.opened_at = now;
                p.realized_pnl = Money::zero(spec.currency);
            } else if !after.is_zero() {
                p.avg_price = avg_of(cost - released, after, mult, p.avg_price);
            }
        }
        let mark = mark.unwrap_or(price);
        p.mark = Some(mark);
        p.unrealized_pnl = Some(open_pnl(p, mark, spec));
        let snapshot = p.clone();
        if snapshot.qty.is_zero() {
            self.positions.remove(&key);
            let mut flat = snapshot;
            flat.unrealized_pnl = Some(Money::zero(spec.currency));
            ch.position(&flat);
        } else {
            ch.position(&snapshot);
        }
        realized
    }

    fn after_fill(&mut self, order: &Order, now: Timestamp, ch: &mut Changes) {
        match (order.role, &order.parent_id) {
            (OrderRole::Entry, _) => self.sync_bracket(&order.id, now, ch),
            (OrderRole::StopLoss | OrderRole::TakeProfit, Some(parent)) => {
                let parent = parent.clone();
                self.sync_bracket(&parent, now, ch);
            }
            _ => {}
        }
        let (a, i) = (&order.request.account_id, &order.request.instrument);
        if self.position_qty(a, i).is_zero() {
            let exits: Vec<(OrderId, Option<OrderId>)> = self
                .orders
                .values()
                .filter(|o| {
                    &o.request.account_id == a
                        && &o.request.instrument == i
                        && o.request.reduce_only
                        && o.status.is_working()
                })
                .map(|o| (o.id.clone(), o.parent_id.clone()))
                .collect();
            for (id, entry) in exits {
                self.cancel_one(&id, "The position is closed.", now, ch);
                if let Some(entry) = entry {
                    self.cancel_one(&entry, "The position is closed.", now, ch);
                }
            }
        }
    }

    fn carry_held_legs(
        &mut self,
        entry_id: &OrderId,
        by: Decimal,
        now: Timestamp,
        ch: &mut Changes,
    ) {
        let legs: Vec<OrderId> = self
            .orders
            .values()
            .filter(|c| c.parent_id.as_ref() == Some(entry_id) && c.status == OrderStatus::Held)
            .map(|c| c.id.clone())
            .collect();
        for leg in legs {
            let c = self.orders.get_mut(&leg).expect("listed");
            c.request.limit_price = c.request.limit_price.map(|p| Price(p.0 + by));
            c.request.stop_price = c.request.stop_price.map(|p| Price(p.0 + by));
            c.updated_at = now;
            let c = c.clone();
            ch.order(&c);
        }
    }

    fn sync_bracket(&mut self, entry_id: &OrderId, now: Timestamp, ch: &mut Changes) {
        let Some(entry) = self.orders.get(entry_id).cloned() else {
            return;
        };
        let children: Vec<Order> = self
            .orders
            .values()
            .filter(|c| c.parent_id.as_ref() == Some(entry_id))
            .cloned()
            .collect();
        if children.is_empty() {
            return;
        }
        if entry.filled_qty.is_zero() {
            if entry.status.is_terminal() {
                for c in children.iter().filter(|c| c.status.is_open()) {
                    self.cancel_one(&c.id, "The entry did not fill.", now, ch);
                }
                return;
            }
            for c in children.iter().filter(|c| c.status.is_open()) {
                let o = self.orders.get_mut(&c.id).expect("listed");
                if o.request.qty != entry.request.qty {
                    o.request.qty = entry.request.qty;
                    o.updated_at = now;
                    let o = o.clone();
                    ch.order(&o);
                }
            }
            return;
        }
        if let Some(done) = children.iter().find(|c| c.status == OrderStatus::Filled) {
            let why = match done.role {
                OrderRole::TakeProfit => "The target filled.",
                _ => "The stop filled.",
            };
            for c in children.iter().filter(|c| c.status.is_open()) {
                self.cancel_one(&c.id, why, now, ch);
            }
            if entry.status.is_open() {
                self.cancel_one(&entry.id, why, now, ch);
            }
            return;
        }
        let seen = self.synced.get(entry_id).copied().unwrap_or(Decimal::ZERO);
        let grown = (entry.filled_qty.0 - seen).max(Decimal::ZERO);
        self.synced.insert(entry_id.clone(), entry.filled_qty.0);
        let exited: Decimal = children.iter().map(|c| c.filled_qty.0).sum();
        let lefts: Vec<Decimal> = children
            .iter()
            .filter(|c| c.status.is_open())
            .map(|c| {
                if c.status == OrderStatus::Held {
                    (entry.filled_qty.0 - exited).max(Decimal::ZERO)
                } else {
                    c.remaining().0 + grown
                }
            })
            .collect();
        let cover = lefts.iter().copied().min().unwrap_or(Decimal::ZERO);
        if cover <= Decimal::ZERO {
            return;
        }
        let at_fill = self.legs_at_fill(&entry);
        let mut activated = Vec::new();
        for c in children.iter().filter(|c| c.status.is_open()) {
            let o = self.orders.get_mut(&c.id).expect("listed");
            let qty = Qty(o.filled_qty.0 + cover);
            let mut changed = false;
            if o.request.qty != qty {
                o.request.qty = qty;
                changed = true;
            }
            if o.status == OrderStatus::Held
                && let Some(b) = at_fill
            {
                match o.role {
                    OrderRole::StopLoss if b.stop_loss.is_some() => {
                        o.request.stop_price = b.stop_loss;
                    }
                    OrderRole::TakeProfit if b.take_profit.is_some() => {
                        o.request.limit_price = b.take_profit;
                    }
                    _ => {}
                }
            }
            if let Some(rules) = o.stop_rules.as_mut()
                && rules.entry_price != entry.avg_fill_price
            {
                rules.entry_price = entry.avg_fill_price;
                changed = true;
            }
            if o.status == OrderStatus::Held {
                o.status = OrderStatus::Working;
                activated.push(o.id.clone());
                changed = true;
            }
            if changed {
                o.updated_at = now;
                let o = o.clone();
                ch.order(&o);
            }
        }
        for id in activated {
            self.init_queue(&id);
            self.try_immediate(&id, now, ch);
        }
    }

    fn legs_at_fill(&self, entry: &Order) -> Option<Bracket> {
        let b = entry.request.bracket.filter(Bracket::in_ticks)?;
        let fill = entry.avg_fill_price?;
        let tick = self
            .market(&entry.request.instrument)
            .ok()?
            .spec
            .tick_size
            .0;
        let ticks_only = Bracket {
            stop_loss: None,
            take_profit: None,
            ..b
        };
        Some(ticks_only.priced_from(entry.request.side, fill, tick))
    }

    fn pin_held_leg(&mut self, leg: &Order, now: Timestamp, ch: &mut Changes) {
        let Some(entry) = leg
            .parent_id
            .as_ref()
            .and_then(|id| self.orders.get_mut(id))
        else {
            return;
        };
        let Some(b) = entry.request.bracket.as_mut() else {
            return;
        };
        match leg.role {
            OrderRole::StopLoss if b.stop_ticks.is_some() => {
                b.stop_ticks = None;
                b.stop_loss = leg.request.stop_price;
            }
            OrderRole::TakeProfit if b.target_ticks.is_some() => {
                b.target_ticks = None;
                b.take_profit = leg.request.limit_price;
            }
            _ => return,
        }
        entry.updated_at = now;
        let entry = entry.clone();
        ch.order(&entry);
    }

    pub fn attach_bracket(
        &mut self,
        entry_id: &OrderId,
        b: Bracket,
        qty: Qty,
        now: Timestamp,
    ) -> Result<(Vec<Order>, Changes), BookError> {
        let mut ch = self.roll(now);
        let entry = self
            .orders
            .get(entry_id)
            .cloned()
            .ok_or_else(|| BookError::UnknownOrder(entry_id.clone()))?;
        if entry.role != OrderRole::Entry || entry.filled_qty.is_zero() {
            return Err(BookError::Refused(
                "Legs are attached to an entry that has filled.".into(),
            ));
        }
        let spec = self.market(&entry.request.instrument)?.spec.clone();
        let b = match entry.avg_fill_price {
            Some(fill) => b.priced_from(entry.request.side, fill, spec.tick_size.0),
            None => b,
        };
        if b.stop_loss.is_none() && b.take_profit.is_none() {
            return Err(BookError::Refused(
                "No stop and no target to attach.".into(),
            ));
        }
        if qty.0 <= Decimal::ZERO {
            return Err(BookError::Refused("The quantity must be positive.".into()));
        }
        if self
            .orders
            .values()
            .any(|c| c.parent_id.as_ref() == Some(entry_id) && c.status.is_open())
        {
            return Err(BookError::Refused(
                "The entry's legs are working already.".into(),
            ));
        }
        if let Some(last) = self.mark(&entry.request.instrument) {
            let long = entry.request.side == Side::Buy;
            if let Some(s) = b.stop_loss
                && (if long { s >= last } else { s <= last })
            {
                return Err(BookError::Refused(format!(
                    "Stop {} is through the market ({}): it would stop out at once.",
                    price_label(&spec, s),
                    price_label(&spec, last)
                )));
            }
            if let Some(t) = b.take_profit
                && (if long { t <= last } else { t >= last })
            {
                return Err(BookError::Refused(format!(
                    "Target {} is through the market ({}): it would fill at once.",
                    price_label(&spec, t),
                    price_label(&spec, last)
                )));
            }
        }
        self.attach_bracket_held(entry_id, b, now, &mut ch);
        let kids: Vec<OrderId> = self
            .orders
            .values()
            .filter(|c| c.parent_id.as_ref() == Some(entry_id) && c.status == OrderStatus::Held)
            .map(|c| c.id.clone())
            .collect();
        for id in &kids {
            let o = self.orders.get_mut(id).expect("listed");
            o.request.qty = qty;
            o.status = OrderStatus::Working;
            if let Some(rules) = o.stop_rules.as_mut() {
                rules.entry_price = entry.avg_fill_price;
            }
            o.updated_at = now;
            let o = o.clone();
            ch.order(&o);
        }
        self.synced.insert(entry_id.clone(), entry.filled_qty.0);
        for id in &kids {
            self.init_queue(id);
            self.try_immediate(id, now, &mut ch);
        }
        let legs = kids
            .iter()
            .filter_map(|id| self.orders.get(id).cloned())
            .collect();
        Ok((legs, ch))
    }

    fn cancel_tree(&mut self, id: &OrderId, why: &str, now: Timestamp, ch: &mut Changes) {
        self.cancel_one(id, why, now, ch);
        if self
            .orders
            .get(id)
            .is_some_and(|o| o.role == OrderRole::Entry)
        {
            self.sync_bracket(id, now, ch);
        }
    }

    fn cancel_one(&mut self, id: &OrderId, why: &str, now: Timestamp, ch: &mut Changes) {
        if let Some(o) = self.orders.get_mut(id)
            && o.status.is_open()
        {
            o.status = OrderStatus::Cancelled;
            o.reason = Some(why.to_owned());
            o.queue_ahead = None;
            o.updated_at = now;
            let o = o.clone();
            ch.order(&o);
        }
    }

    pub fn roll(&mut self, now: Timestamp) -> Changes {
        let mut ch = Changes::default();
        let ids: Vec<AccountId> = self.accounts.keys().cloned().collect();
        for id in ids {
            if !self.accounts[&id].rolls_at(now) {
                continue;
            }
            let (net, awaiting) = self.day_start_net_liq(&id);
            self.accounts
                .get_mut(&id)
                .expect("listed")
                .roll(now, net, awaiting);
            ch.account(&id);
            let day_orders: Vec<OrderId> = self
                .orders
                .values()
                .filter(|o| {
                    o.request.account_id == id
                        && o.status.is_open()
                        && o.request.tif == TimeInForce::Day
                })
                .map(|o| o.id.clone())
                .collect();
            for oid in day_orders {
                if let Some(o) = self.orders.get_mut(&oid) {
                    o.status = OrderStatus::Expired;
                    o.reason = Some("Day order: the session ended.".into());
                    o.updated_at = now;
                    let o = o.clone();
                    ch.order(&o);
                }
                self.sync_bracket(&oid, now, &mut ch);
            }
            let day_start = super::account::DAY_CALENDAR
                .session(self.accounts[&id].day)
                .map_or(now, |s| s.open.min(now));
            self.orders.retain(|_, o| {
                o.request.account_id != id || o.status.is_open() || o.updated_at >= day_start
            });
            self.fills
                .retain(|f| f.account_id != id || f.ts >= day_start);
        }
        ch
    }
}

fn crosses(side: Side, limit: Option<Price>, touch: Price) -> bool {
    limit.is_some_and(|l| match side {
        Side::Buy => touch <= l,
        Side::Sell => touch >= l,
    })
}

fn stop_fill(side: Side, touch: Option<Price>, trade: Price) -> Price {
    let t = touch.unwrap_or(trade);
    match side {
        Side::Buy => t.max(trade),
        Side::Sell => t.min(trade),
    }
}

const COST_DP: u32 = 12;

fn cost_of(p: &Position, spec: &ContractSpec) -> Decimal {
    (p.qty.0.abs() * p.avg_price.0 * spec.multiplier).round_dp(COST_DP)
}

fn avg_of(cost: Decimal, qty: Decimal, mult: Decimal, fallback: Price) -> Price {
    if qty.is_zero() || mult.is_zero() {
        fallback
    } else {
        Price(cost / (qty.abs() * mult))
    }
}

fn open_pnl(p: &Position, mark: Price, spec: &ContractSpec) -> Money {
    let value = p.qty.0.abs() * mark.0 * spec.multiplier;
    Money::new(p.qty.0.signum() * (value - cost_of(p, spec)), spec.currency)
}

fn next_open(spec: &ContractSpec, now: Timestamp) -> Timestamp {
    let cal = spec.sessions;
    let mut d = cal.trade_date(now);
    for _ in 0..10 {
        if let Some(s) = cal.session(d)
            && let Some(w) = s.segments.iter().find(|w| w.start > now)
        {
            return w.start;
        }
        d = cal.next_trade_date(d);
    }
    now
}

fn status_word(s: OrderStatus) -> &'static str {
    match s {
        OrderStatus::PendingSubmit => "pending",
        OrderStatus::Held => "held",
        OrderStatus::Working => "working",
        OrderStatus::PartiallyFilled => "partially filled",
        OrderStatus::PendingCancel => "cancelling",
        OrderStatus::Filled => "filled",
        OrderStatus::Cancelled => "cancelled",
        OrderStatus::Rejected => "rejected",
        OrderStatus::Expired => "expired",
    }
}

#[cfg(test)]
mod tests {
    use tessera_core::money::Currency;
    use tessera_core::session::SessionCalendar;
    use tessera_core::time::ExchangeTz;

    use super::*;

    fn future(root: &str) -> ContractSpec {
        ContractSpec {
            instrument: InstrumentId::new(format!("{root}Z6.CME")).unwrap(),
            asset_class: AssetClass::Future,
            root: Some(root.to_owned()),
            tick_size: Price(Decimal::ONE),
            tick_value: Money::usd(Decimal::ONE),
            multiplier: Decimal::ONE,
            currency: Currency::Usd,
            price_decimals: 2,
            qty_step: Qty(Decimal::ONE),
            min_qty: Qty(Decimal::ONE),
            sessions: SessionCalendar::CmeGlobex,
            tz: ExchangeTz::CHICAGO,
            expiry: None,
            last_trade: None,
            roll_date: None,
            micro_of: None,
        }
    }

    #[test]
    fn every_micro_pays_the_micro_commission_and_every_full_size_the_standard() {
        let rate = |root: &str| Commission::RETAIL.per_side(&future(root));
        for micro in [
            "MNQ", "MES", "MYM", "M2K", "MCL", "MGC", "MNG", "SIL", "MHG", "M6A", "M6B", "M6E",
            "MCD", "MSF", "MBT",
        ] {
            assert_eq!(rate(micro), Commission::RETAIL.micro, "{micro}");
        }
        for full in ["NQ", "ES", "CL", "GC", "SI", "HG", "6E", "ZN", "QM", "XC"] {
            assert_eq!(rate(full), Commission::RETAIL.standard, "{full}");
        }
    }
}
