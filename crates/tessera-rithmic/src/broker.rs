use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use futures::StreamExt;
use futures::stream::BoxStream;
use parking_lot::{Mutex, RwLock};
use rithmic_rs::rti::messages::RithmicMessage;
use rithmic_rs::rti::{ExchangeOrderNotification, ResponseShowFillHistory};
use rithmic_rs::{
    ConnectStrategy, FillHistoryRange, RithmicAccount, RithmicBracketLevelAdjustment,
    RithmicCancelOrder, RithmicError, RithmicModifyOrder, RithmicOrderPlant,
    RithmicOrderPlantHandle, RithmicPnlPlant, RithmicPnlPlantHandle, RithmicResponse,
    RmsUpdateBits,
};
use rust_decimal::Decimal;
use tessera_broker::{BrokerError, BrokerEvent, BrokerProvider, BrokerSystem, OrderChanges};
use tessera_broker::{SendRefused, Verified};
use tessera_core::accounts::{AccountSummary, Environment, RiskStatus, TradingAccount};
use tessera_core::capabilities::BrokerCapabilities;
use tessera_core::health::{ConnectionPhase, HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::{AccountId, DraftId, OrderId};
use tessera_core::instrument::InstrumentId;
use tessera_core::money::{Price, Qty};
use tessera_core::orders::{
    Bracket, CheckSeverity, Fill, Order, OrderPreview, OrderRequest, OrderRole, OrderStatus,
    OrderType, Position, PreTradeCheck, Side, StopRules, TimeInForce,
};
use tessera_core::time::{NANOS_PER_SEC, Timestamp};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio_stream::wrappers::BroadcastStream;
use tracing::{info, warn};

use crate::account::{self, AccountInfo, AccountPnl, Ctx, RmsLimits, RmsLive};
use crate::firms::system_environment;
use crate::link::{Event, Link};
use crate::plant::Owned;
use crate::provider::RithmicMarket;
use crate::send::{AccountOrders, OrderEntry, SendError, send_order};
use crate::session::{End, OpenError, RECONNECT, Session, config, connection_end, login_error};
use crate::templates::{GateRefused, Template};

mod fill_days;
mod orders;
mod unshown;

use fill_days::{Coverage, TradeDays};
use orders::{BracketPlan, InDoubt};
use unshown::{Read, Unshown};

/// rithmic-rs's order plant sends login info (300) and trade routes (310) itself after login.
const AUTO_AFTER_LOGIN: [i32; 2] = [300, 310];
const ACCOUNT_LIST: i32 = 302;
const RMS_INFO: i32 = 304;
const ORDER_UPDATES: i32 = 308;
const SHOW_ORDERS: i32 = 320;
const ORDER_HISTORY: i32 = 322;
const BRACKET_UPDATES: i32 = 336;
const REPLAY_EXECUTIONS: i32 = 3506;
const RMS_UPDATES: i32 = 3508;
const FILL_HISTORY: i32 = 3512;
const PNL_UPDATES: i32 = 400;
const PNL_SNAPSHOT: i32 = 402;

const FILL_PAGE: i32 = 10_000;
const FILL_LOOKBACK_DAYS: i64 = 92;
const SNAPSHOT_WAIT: Duration = Duration::from_secs(4);
const NEW_ORDER: i32 = 312;
const MODIFY: i32 = 314;
const CANCEL: i32 = 316;
const BRACKET: i32 = 330;
const BRACKET_TARGET: i32 = 332;
const BRACKET_STOP: i32 = 334;
const OCO: i32 = 328;

struct Plants {
    order: Owned<RithmicOrderPlant>,
    _pnl: Owned<RithmicPnlPlant>,
    orders: HashMap<AccountId, AccountOrders>,
    pnls: HashMap<AccountId, RithmicPnlPlantHandle>,
    login: RithmicOrderPlantHandle,
    pnl_login: Option<RithmicPnlPlantHandle>,
}

impl Plants {
    fn abort(&self) {
        self.login.abort();
        if let Some(h) = &self.pnl_login {
            h.abort();
        }
    }
}

struct Entry {
    info: AccountInfo,
    account: TradingAccount,
    rms: Option<RmsLimits>,
    live: RmsLive,
    pnl: AccountPnl,
    pnl_seen: bool,
    positions: BTreeMap<InstrumentId, Position>,
    unshown: HashMap<InstrumentId, Unshown>,
    told: HashMap<InstrumentId, Decimal>,
    orders: HashMap<OrderId, Order>,
    fills: Vec<Fill>,
    fill_ids: HashSet<String>,
    coverage: Coverage,
    aliases: HashMap<String, OrderId>,
    brackets: HashMap<String, BracketPlan>,
    tags: HashMap<String, OrderId>,
    grouped: HashSet<OrderId>,
    sending: HashSet<String>,
    /// Rithmic can send a bracket's leg notifications before the submit's reply arrives.
    early: Vec<rithmic_rs::rti::RithmicOrderNotification>,
    in_doubt: Vec<InDoubt>,
}

impl Entry {
    fn new(info: AccountInfo, account: TradingAccount) -> Self {
        Self {
            info,
            account,
            rms: None,
            live: RmsLive::default(),
            pnl: AccountPnl::default(),
            pnl_seen: false,
            positions: BTreeMap::new(),
            unshown: HashMap::new(),
            told: HashMap::new(),
            orders: HashMap::new(),
            fills: Vec::new(),
            fill_ids: HashSet::new(),
            coverage: Coverage::default(),
            aliases: HashMap::new(),
            brackets: HashMap::new(),
            tags: HashMap::new(),
            grouped: HashSet::new(),
            sending: HashSet::new(),
            early: Vec::new(),
            in_doubt: Vec::new(),
        }
    }

    fn order_id(&self, provider_id: &str, basket: &str) -> OrderId {
        self.aliases
            .get(basket)
            .cloned()
            .unwrap_or_else(|| self.ctx(provider_id).order_id(basket))
    }

    fn ctx<'a>(&'a self, provider_id: &'a str) -> Ctx<'a> {
        Ctx {
            provider_id,
            account: &self.info.id,
            environment: self.account.environment,
            currency: self.info.currency,
        }
    }

    fn held(&self, instrument: &InstrumentId) -> Decimal {
        self.positions
            .get(instrument)
            .map_or(Decimal::ZERO, |p| p.qty.0)
            + self
                .unshown
                .get(instrument)
                .map_or(Decimal::ZERO, Unshown::qty)
    }

    fn position_at(&self, instrument: &InstrumentId, qty: Decimal) -> Position {
        let fill = self.unshown.get(instrument).and_then(|u| u.last);
        match self.positions.get(instrument) {
            Some(p) if !p.qty.is_zero() => Position {
                qty: Qty(qty),
                ..p.clone()
            },
            shown => Position {
                account_id: self.info.id.clone(),
                instrument: instrument.clone(),
                qty: Qty(qty),
                avg_price: fill.map_or(Price::ZERO, |(p, _)| p),
                realized_pnl: shown.map_or_else(
                    || tessera_core::money::Money::zero(self.info.currency),
                    |p| p.realized_pnl,
                ),
                unrealized_pnl: None,
                mark: None,
                opened_at: fill.map_or(Timestamp(0), |(_, at)| at),
            },
        }
    }

    fn open_positions(&self) -> Vec<Position> {
        let instruments: std::collections::BTreeSet<&InstrumentId> =
            self.positions.keys().chain(self.unshown.keys()).collect();
        instruments
            .into_iter()
            .filter_map(|i| {
                let qty = self.held(i);
                (!qty.is_zero()).then(|| self.position_at(i, qty))
            })
            .collect()
    }

    fn tell_position(
        &mut self,
        instrument: &InstrumentId,
        shown_changed: bool,
        out: &mut Vec<BrokerEvent>,
    ) {
        let qty = self.held(instrument);
        let told = self.told.get(instrument).copied().unwrap_or(Decimal::ZERO);
        if qty == told && (!shown_changed || qty.is_zero()) {
            return;
        }
        self.told.insert(instrument.clone(), qty);
        out.push(BrokerEvent::Position(self.position_at(instrument, qty)));
    }

    fn on_live_fill(&mut self, f: &Fill, now: Timestamp, out: &mut Vec<BrokerEvent>) {
        if !self.pnl_seen {
            return;
        }
        let signed = match f.side {
            Side::Buy => f.qty.0,
            Side::Sell => -f.qty.0,
        };
        self.unshown
            .entry(f.instrument.clone())
            .or_default()
            .filled(signed, f.price, now);
        self.tell_position(&f.instrument, false, out);
    }

    fn doubts(&self, now: Timestamp) -> usize {
        self.in_doubt.iter().filter(|d| d.holds(now)).count()
    }

    fn doubted(&self, tag: &str, now: Timestamp) -> bool {
        self.in_doubt.iter().any(|d| d.tag == tag && d.holds(now))
    }

    fn placed_under(&self, tag: &str) -> Vec<Order> {
        [OrderRole::StopLoss, OrderRole::TakeProfit]
            .into_iter()
            .filter_map(|role| {
                let id = self.tags.get(&orders::leg_tag(tag, role))?;
                self.orders.get(id).filter(|o| o.status.is_open()).cloned()
            })
            .collect()
    }

    fn unlinked_sibling(&self, request: &OrderRequest) -> Option<Order> {
        let want = orders::exit_role(request.order_type)?;
        if !request.reduce_only || request.bracket.is_some_and(|b| !b.is_empty()) {
            return None;
        }
        self.orders
            .values()
            .find(|o| {
                o.status == OrderStatus::Working
                    && o.filled_qty.is_zero()
                    && o.broker_order_id.is_some()
                    && o.parent_id.is_none()
                    && o.request.reduce_only
                    && o.request.instrument == request.instrument
                    && o.request.side == request.side
                    && o.request.qty == request.qty
                    && orders::exit_role(o.request.order_type).is_some_and(|r| r != want)
                    && !self.grouped.contains(&o.id)
                    && !o
                        .request
                        .client_order_id
                        .as_deref()
                        .is_some_and(orders::is_group_leg)
                    && self.tags.values().any(|id| id == &o.id)
            })
            .cloned()
    }

    fn fill_of(&self, pid: &str, n: &ExchangeOrderNotification) -> Option<Fill> {
        let mut f = account::fill_from_exchange(n, self.ctx(pid))?;
        if let Some(b) = n.basket_id.as_deref() {
            f.order_id = Some(self.order_id(pid, b));
        }
        Some(f)
    }

    fn add_fill(&mut self, f: Fill) -> bool {
        let key = f.id.as_str().to_owned();
        if !self.fill_ids.insert(key) {
            return false;
        }
        let at = self.fills.partition_point(|x| x.ts <= f.ts);
        self.fills.insert(at, f);
        true
    }

    fn on_order_notification(
        &mut self,
        pid: &str,
        n: &rithmic_rs::rti::RithmicOrderNotification,
        now: Timestamp,
        out: &mut Vec<BrokerEvent>,
    ) {
        let Some(basket) = n.basket_id.as_deref().filter(|b| !b.is_empty()) else {
            return;
        };
        let mut leg = None;
        let known = self.aliases.contains_key(basket)
            || self.orders.contains_key(&self.ctx(pid).order_id(basket));
        if !known && !self.sending.is_empty() {
            self.early.push(n.clone());
            return;
        }
        if !known
            && let Some(role) = orders::leg_role(n)
            && let Some(plan) = self
                .brackets
                .iter()
                .find(|(entry, p)| orders::is_leg_of(n, entry, &p.tag))
                .map(|(_, p)| p.clone())
        {
            let held = plan
                .leg(role)
                .filter(|id| {
                    self.orders
                        .get(*id)
                        .is_some_and(|o| o.broker_order_id.is_none())
                })
                .cloned();
            if let Some(id) = held {
                self.aliases.insert(basket.to_owned(), id);
            }
            leg = Some((role, plan.entry));
        }
        let id = self.order_id(pid, basket);
        let prev = self.orders.get(&id);
        let Some(mut o) = account::apply_order_notification(prev, n, self.ctx(pid), now) else {
            return;
        };
        o.id = id.clone();
        let recovered = if prev.is_none() && leg.is_none() {
            self.recovered_leg(pid, n)
        } else {
            None
        };
        if let Some((role, parent)) = leg.or(recovered) {
            o.role = role;
            o.parent_id = Some(parent);
        } else if let Some((role, parent, held)) = self.placed_leg(&o) {
            // On Apex a stop-only bracket's stop leg names neither its entry nor its tag.
            info!(
                basket,
                original = n.original_basket_id.as_deref().unwrap_or(""),
                linked = n.linked_basket_ids.as_deref().unwrap_or(""),
                tagged = n.user_tag.as_deref().is_some_and(|t| !t.is_empty()),
                bracket_type = n.bracket_type,
                "rithmic bracket leg taken in by its price from the fill"
            );
            self.rehome(o, role, parent, held, now, out);
            return;
        }
        if matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit) {
            o.request.reduce_only = true;
            o.request.client_order_id = None;
        }
        if o.status == OrderStatus::Rejected && prev.is_none_or(|p| p.reason != o.reason) {
            o.reason = orders::rejected_words(o.reason.as_deref());
        }
        if let Some(tag) = n.user_tag.as_deref().filter(|t| !t.is_empty()) {
            if o.role == OrderRole::Entry {
                self.tags.insert(tag.to_owned(), id.clone());
            }
            self.in_doubt.retain(|d| !d.shown_by(tag));
        }
        let ended_unfilled = !o.status.is_open() && o.filled_qty.is_zero();
        let filled_bracket = !o.filled_qty.is_zero() && self.brackets.contains_key(basket);
        let resting_entry =
            o.role == OrderRole::Entry && o.status.is_open() && o.filled_qty.is_zero();
        if self.orders.get(&id) != Some(&o) {
            self.orders.insert(id.clone(), o.clone());
            out.push(BrokerEvent::Order(o.clone()));
            if resting_entry {
                self.carry_held_legs(basket, &o, now, out);
            }
        }
        if filled_bracket {
            self.rehome_strays(now, out);
            self.start_stop_rules(basket, now, out);
        }
        // Rithmic never places a bracket's legs when its entry ends unfilled.
        if ended_unfilled && let Some(plan) = self.brackets.get(basket).cloned() {
            for leg in [plan.stop, plan.target].into_iter().flatten() {
                if let Some(l) = self.orders.get_mut(&leg)
                    && l.broker_order_id.is_none()
                    && l.status.is_open()
                {
                    l.status = OrderStatus::Cancelled;
                    l.reason = Some("Its entry ended unfilled.".into());
                    l.updated_at = now;
                    out.push(BrokerEvent::Order(l.clone()));
                }
            }
        }
    }

    fn recovered_leg(
        &self,
        pid: &str,
        n: &rithmic_rs::rti::RithmicOrderNotification,
    ) -> Option<(OrderRole, OrderId)> {
        let basket = n.basket_id.as_deref()?;
        let role = orders::leg_role(n)?;
        let other = |b: &&str| !b.is_empty() && *b != basket;
        if let Some(entry) = n.original_basket_id.as_deref().filter(other) {
            return Some((role, self.order_id(pid, entry)));
        }
        n.linked_basket_ids
            .as_deref()?
            .split([',', ' '])
            .map(str::trim)
            .filter(other)
            .find_map(|b| {
                self.orders
                    .get(&self.order_id(pid, b))
                    .filter(|o| matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit))
                    .and_then(|o| o.parent_id.clone())
            })
            .map(|parent| (role, parent))
    }

    fn placed_leg(&self, o: &Order) -> Option<(OrderRole, OrderId, OrderId)> {
        if o.role != OrderRole::Entry || o.parent_id.is_some() || !o.status.is_open() {
            return None;
        }
        if self.tags.values().any(|id| id == &o.id)
            || o.request
                .client_order_id
                .as_deref()
                .is_some_and(|t| !t.is_empty() && self.brackets.values().all(|p| p.tag != t))
        {
            return None;
        }
        let role = match o.request.order_type {
            OrderType::Stop | OrderType::StopLimit => OrderRole::StopLoss,
            OrderType::Limit => OrderRole::TakeProfit,
            OrderType::Market => return None,
        };
        let price = match role {
            OrderRole::StopLoss => o.request.stop_price,
            _ => o.request.limit_price,
        }?
        .0;
        let mut found = self.brackets.values().filter_map(|p| {
            let entry = self.orders.get(&p.entry)?;
            let held = p.leg(role)?;
            let h = self.orders.get(held)?;
            let near = |at: Price| (at.0 - price).abs() * Decimal::TWO < p.tick;
            let placed = entry.request.instrument == o.request.instrument
                && entry.request.side != o.request.side
                && !entry.filled_qty.is_zero()
                && o.request.qty <= entry.request.qty
                && h.broker_order_id.is_none()
                && h.status.is_open()
                && (p
                    .ticks(role)
                    .zip(entry.avg_fill_price)
                    .is_some_and(|(t, fill)| near(p.leg_price_from(role, t, fill.0)))
                    || h.request
                        .stop_price
                        .or(h.request.limit_price)
                        .is_some_and(near));
            placed.then(|| (role, p.entry.clone(), held.clone()))
        });
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }

    fn rehome(
        &mut self,
        mut o: Order,
        role: OrderRole,
        parent: OrderId,
        held: OrderId,
        now: Timestamp,
        out: &mut Vec<BrokerEvent>,
    ) {
        let stray = o.id.clone();
        if let Some(basket) = o.broker_order_id.clone() {
            self.aliases.insert(basket, held.clone());
        }
        if let Some(mut gone) = self.orders.remove(&stray) {
            gone.status = OrderStatus::Cancelled;
            gone.reason = Some(format!(
                "Shown as its bracket's {}.",
                if role == OrderRole::StopLoss {
                    "stop"
                } else {
                    "target"
                }
            ));
            gone.updated_at = now;
            out.push(BrokerEvent::Order(gone));
        }
        if let Some(h) = self.orders.get(&held) {
            o.created_at = h.created_at;
            o.draft_id = h.draft_id.clone();
            o.stop_rules = h.stop_rules;
        }
        o.id = held.clone();
        o.role = role;
        o.parent_id = Some(parent);
        o.request.reduce_only = true;
        o.request.client_order_id = None;
        self.orders.insert(held, o.clone());
        out.push(BrokerEvent::Order(o));
    }

    fn rehome_strays(&mut self, now: Timestamp, out: &mut Vec<BrokerEvent>) {
        let strays: Vec<_> = self
            .orders
            .values()
            .filter_map(|o| self.placed_leg(o).map(|leg| (o.clone(), leg)))
            .collect();
        for (o, (role, parent, held)) in strays {
            if self
                .orders
                .get(&held)
                .is_some_and(|h| h.broker_order_id.is_none())
            {
                self.rehome(o, role, parent, held, now, out);
            }
        }
    }

    fn start_stop_rules(&mut self, basket: &str, now: Timestamp, out: &mut Vec<BrokerEvent>) {
        let Some(plan) = self.brackets.get(basket) else {
            return;
        };
        let fill = self.orders.get(&plan.entry).and_then(|e| e.avg_fill_price);
        if let Some(stop) = plan.stop.as_ref().and_then(|id| self.orders.get_mut(id))
            && let Some(rules) = stop.stop_rules.as_mut()
            && fill.is_some()
            && rules.entry_price != fill
        {
            rules.entry_price = fill;
            stop.updated_at = now;
            out.push(BrokerEvent::Order(stop.clone()));
        }
    }

    fn replay_early(&mut self, pid: &str, now: Timestamp, out: &mut Vec<BrokerEvent>) {
        for n in std::mem::take(&mut self.early) {
            self.on_order_notification(pid, &n, now, out);
        }
    }

    fn on_bracket_update(
        &mut self,
        b: &rithmic_rs::rti::BracketUpdates,
        now: Timestamp,
        out: &mut Vec<BrokerEvent>,
    ) {
        let Some(plan) = b
            .basket_id
            .as_deref()
            .and_then(|basket| self.brackets.get_mut(basket))
        else {
            return;
        };
        let mut moved = Vec::new();
        for (role, ticks) in [
            (OrderRole::StopLoss, b.stop_ticks),
            (OrderRole::TakeProfit, b.target_ticks),
        ] {
            if let Some(t) = ticks.filter(|t| *t > 0) {
                plan.set_ticks(role, t);
                moved.push(role);
            }
        }
        let plan = plan.clone();
        self.reprice_held_legs(&plan, &moved, now, out);
    }

    fn carry_held_legs(
        &mut self,
        basket: &str,
        entry: &Order,
        now: Timestamp,
        out: &mut Vec<BrokerEvent>,
    ) {
        let Some(plan) = self.brackets.get_mut(basket) else {
            return;
        };
        let Ok(reference) = orders::bracket_reference(&entry.request, None) else {
            return;
        };
        if plan.reference == reference {
            return;
        }
        plan.reference = reference;
        let plan = plan.clone();
        self.reprice_held_legs(
            &plan,
            &[OrderRole::StopLoss, OrderRole::TakeProfit],
            now,
            out,
        );
    }

    fn reprice_held_legs(
        &mut self,
        plan: &BracketPlan,
        roles: &[OrderRole],
        now: Timestamp,
        out: &mut Vec<BrokerEvent>,
    ) {
        for &role in roles {
            let (Some(id), Some(ticks)) = (plan.leg(role), plan.ticks(role)) else {
                continue;
            };
            let price = plan.leg_price(role, ticks);
            if let Some(o) = self.orders.get_mut(id)
                && o.broker_order_id.is_none()
            {
                let slot = if role == OrderRole::StopLoss {
                    &mut o.request.stop_price
                } else {
                    &mut o.request.limit_price
                };
                if *slot != Some(price) {
                    *slot = Some(price);
                    o.updated_at = now;
                    out.push(BrokerEvent::Order(o.clone()));
                }
            }
        }
    }
}

#[derive(Default)]
struct State {
    accounts: Vec<Entry>,
}

impl State {
    fn by_id(&self, id: &AccountId) -> Option<&Entry> {
        self.accounts.iter().find(|e| &e.info.id == id)
    }

    fn by_id_mut(&mut self, id: &AccountId) -> Option<&mut Entry> {
        self.accounts.iter_mut().find(|e| &e.info.id == id)
    }

    fn by_rithmic(&mut self, account_id: Option<&str>) -> Option<&mut Entry> {
        let a = account_id?;
        self.accounts
            .iter_mut()
            .find(|e| e.info.account.account_id == a)
    }
}

struct Inner {
    session: Arc<Session>,
    link: Mutex<Link>,
    state: RwLock<State>,
    plants: RwLock<Option<Arc<Plants>>>,
    events: broadcast::Sender<BrokerEvent>,
    last_message: AtomicI64,
    fill_pull: tokio::sync::Mutex<()>,
    starting: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct RithmicBroker {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for RithmicBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RithmicBroker")
            .field("provider_id", &self.inner.session.opts.provider_id)
            .field("phase", &self.phase())
            .finish_non_exhaustive()
    }
}

fn gate_error(e: GateRefused) -> BrokerError {
    match e {
        GateRefused::RoutingDisabled(_) => BrokerError::Refused(SendRefused::RoutingDisabled),
        GateRefused::OrderEntryOff(_) => BrokerError::Refused(SendRefused::OrderEntryOff),
        GateRefused::NotAllowed(_) => BrokerError::Refused(SendRefused::ReadOnly),
        GateRefused::Closed => BrokerError::Unavailable(e.to_string()),
    }
}

fn said(e: &BrokerError) -> String {
    match e {
        BrokerError::Rejected(w) | BrokerError::Unavailable(w) | BrokerError::Unsupported(w) => {
            w.trim_end_matches('.').to_owned()
        }
        BrokerError::NotFound(w) => format!("{w} not found"),
        BrokerError::Refused(r) => r.to_string(),
    }
}

fn rejected(frames: &[RithmicResponse]) -> Option<&RithmicError> {
    frames.iter().find_map(|r| r.error.as_ref())
}

enum Linked {
    NotSent(BrokerError, Box<Order>),
    Failed(BrokerError),
}

#[derive(Debug)]
enum SendFail {
    NotSent(BrokerError),
    Unknown(String),
}

impl RithmicBroker {
    pub fn for_market(market: &RithmicMarket) -> Self {
        Self::on_session(Arc::clone(market.session()))
    }

    pub async fn connect(market: &RithmicMarket) -> Result<Self, OpenError> {
        let broker = Self::for_market(market);
        broker.start().await?;
        Ok(broker)
    }

    fn on_session(session: Arc<Session>) -> Self {
        let (events, _) = broadcast::channel(4_096);
        Self {
            inner: Arc::new(Inner {
                session,
                link: Mutex::new(Link::default()),
                state: RwLock::new(State::default()),
                plants: RwLock::new(None),
                events,
                last_message: AtomicI64::new(0),
                fill_pull: tokio::sync::Mutex::new(()),
                starting: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub async fn start(&self) -> Result<(), OpenError> {
        let _one = self.inner.starting.lock().await;
        let generation = self.inner.link.lock().start();
        self.inner.drop_plants();
        match self.inner.open().await {
            Ok(opened) if !self.inner.advance(generation, Event::LoggedIn) => {
                self.inner.drop_own(&opened.plants);
                Err(OpenError::Transport(
                    "the account connection was stopped while it opened".into(),
                ))
            }
            Ok(opened) => {
                let inner = Arc::clone(&self.inner);
                self.inner
                    .session
                    .runtime()
                    .spawn(async move { inner.supervise(opened, generation).await });
                Ok(())
            }
            Err(e) => {
                self.inner.advance(generation, Event::failed(&e));
                Err(e)
            }
        }
    }

    pub async fn reconnect(&self) -> Result<(), OpenError> {
        self.inner.session.gate.reopen();
        self.start().await
    }

    pub async fn shutdown(&self) {
        self.inner.link.lock().stop();
        let plants = self.inner.plants.write().take();
        if let Some(p) = plants {
            let _ = tokio::time::timeout(Duration::from_secs(5), p.login.disconnect()).await;
            if let Some(h) = &p.pnl_login {
                let _ = tokio::time::timeout(Duration::from_secs(5), h.disconnect()).await;
            }
        }
    }

    pub fn phase(&self) -> ConnectionPhase {
        self.inner.phase()
    }

    pub fn set_paper_routing(&self, enabled: bool) {
        self.inner.session.gate.set_paper_routing(enabled);
    }

    pub fn set_account_order_entry(
        &self,
        account: &AccountId,
        enabled: bool,
    ) -> Result<(), BrokerError> {
        self.inner
            .session
            .gate
            .set_account_order_entry(account.as_str(), enabled)
            .map_err(gate_error)?;
        info!(
            provider = %self.provider_id(),
            enabled,
            "rithmic account order entry switched",
        );
        Ok(())
    }

    pub fn rms(&self, account: &AccountId) -> Option<RmsLimits> {
        self.inner
            .state
            .read()
            .by_id(account)
            .and_then(|e| e.rms.clone())
    }

    pub fn template_counts(&self) -> BTreeMap<i32, u64> {
        self.inner.session.gate.counts()
    }

    fn provider_id(&self) -> &str {
        &self.inner.session.opts.provider_id
    }

    fn takes_orders(&self, account: &AccountId) -> bool {
        let gate = &self.inner.session.gate;
        if gate.is_paper_system() {
            gate.paper_routing()
        } else {
            gate.account_order_entry(account.as_str())
        }
    }

    fn takes_any_orders(&self) -> bool {
        let gate = &self.inner.session.gate;
        if gate.is_paper_system() {
            gate.paper_routing()
        } else {
            !gate.order_entry_accounts().is_empty()
        }
    }

    fn caps(&self, entry: bool) -> BrokerCapabilities {
        let system = &self.inner.session.login.system_name;
        BrokerCapabilities {
            order_types: if entry {
                vec![
                    OrderType::Market,
                    OrderType::Limit,
                    OrderType::Stop,
                    OrderType::StopLimit,
                ]
            } else {
                vec![]
            },
            time_in_force: vec![
                TimeInForce::Day,
                TimeInForce::Gtc,
                TimeInForce::Ioc,
                TimeInForce::Fok,
            ],
            brackets: entry,
            oco: false,
            modify: entry,
            read_only: !entry,
            environments: vec![system_environment(system)],
            fractional_qty: false,
            stop_rules: false,
        }
    }

    fn entry_err(&self, account: &AccountId) -> BrokerError {
        if self.inner.state.read().accounts.is_empty() {
            BrokerError::Unavailable(self.inner.unavailable_reason())
        } else {
            BrokerError::NotFound(format!("account {account}"))
        }
    }

    fn with_entry<T>(
        &self,
        account: &AccountId,
        f: impl FnOnce(&Entry) -> Result<T, BrokerError>,
    ) -> Result<T, BrokerError> {
        let state = self.inner.state.read();
        match state.by_id(account) {
            Some(e) => f(e),
            None => {
                drop(state);
                Err(self.entry_err(account))
            }
        }
    }

    fn order_wire(&self, account: &AccountId) -> Result<AccountOrders, BrokerError> {
        let plants = self
            .inner
            .plants
            .read()
            .clone()
            .ok_or_else(|| BrokerError::Unavailable(self.inner.unavailable_reason()))?;
        plants
            .orders
            .get(account)
            .cloned()
            .ok_or_else(|| self.entry_err(account))
    }

    async fn send(
        &self,
        account: &AccountId,
        entry: OrderEntry,
    ) -> Result<Vec<RithmicResponse>, SendFail> {
        let wire = self.order_wire(account).map_err(SendFail::NotSent)?;
        let wrote = tokio::time::timeout(
            self.inner.session.opts.request_timeout,
            send_order(&self.inner.session.gate, &wire, entry),
        )
        .await
        .map_err(|_| {
            SendFail::Unknown(format!(
                "Rithmic did not answer within {:?}",
                self.inner.session.opts.request_timeout
            ))
        })?;
        match wrote {
            Ok(frames) => Ok(frames),
            Err(SendError::Refused(e)) => Err(SendFail::NotSent(gate_error(e))),
            Err(SendError::Wire(e)) if orders::may_have_left(&e) => {
                Err(SendFail::Unknown(self.inner.session.redact(&e)))
            }
            Err(SendError::Wire(e)) => Err(SendFail::NotSent(BrokerError::Rejected(
                self.inner.session.login.redact(&orders::plain(&e)),
            ))),
        }
    }

    async fn send_change(
        &self,
        account: &AccountId,
        entry: OrderEntry,
    ) -> Result<Vec<RithmicResponse>, BrokerError> {
        match self.send(account, entry).await {
            Ok(frames) => match rejected(&frames) {
                Some(e) => Err(BrokerError::Rejected(
                    self.inner.session.login.redact(&orders::plain(e)),
                )),
                None => Ok(frames),
            },
            Err(SendFail::NotSent(e)) => Err(e),
            Err(SendFail::Unknown(why)) => Err(BrokerError::Unavailable(format!(
                "Rithmic did not confirm the change ({why}). Tessera does not send it again; \
                 the order shows what Rithmic has once the account reconnects."
            ))),
        }
    }

    fn precheck(&self, template: i32, account: &AccountId) -> Result<(), BrokerError> {
        self.inner
            .session
            .gate
            .check_for(Template::OrderEntry(template), Some(account.as_str()))
            .map_err(gate_error)
    }

    fn known_order(&self, order: &OrderId) -> Result<Order, BrokerError> {
        self.order_of(order)
            .ok_or_else(|| BrokerError::NotFound(format!("order {order}")))
    }

    fn tick_and_last(
        &self,
        instrument: &InstrumentId,
        side: Side,
    ) -> (Option<rust_decimal::Decimal>, Option<rust_decimal::Decimal>) {
        let Ok(key) = orders::contract(instrument) else {
            return (None, None);
        };
        let feeds = &self.inner.session.feeds;
        let tick = feeds.grid(&key).and_then(crate::map::Grid::tick);
        let last = feeds.quote(&key).and_then(|q| {
            let touch = match side {
                Side::Buy => q.ask,
                Side::Sell => q.bid,
            };
            q.last.or(touch).map(|p| p.0)
        });
        (tick, last)
    }

    fn held_leg(&self, order: &Order) -> Option<(String, BracketPlan)> {
        if order.broker_order_id.is_some() {
            return None;
        }
        let parent = order.parent_id.as_ref()?;
        let state = self.inner.state.read();
        let e = state.by_id(&order.request.account_id)?;
        e.brackets
            .iter()
            .find(|(_, p)| &p.entry == parent && p.leg(order.role) == Some(&order.id))
            .map(|(b, p)| (b.clone(), p.clone()))
    }

    fn entry_filled(&self, leg: &Order) -> bool {
        leg.parent_id
            .as_ref()
            .and_then(|p| self.order_of(p))
            .is_some_and(|e| !e.filled_qty.is_zero())
    }

    fn entry_fill(&self, leg: &Order) -> Option<Decimal> {
        leg.parent_id
            .as_ref()
            .and_then(|p| self.order_of(p))
            .filter(|e| !e.filled_qty.is_zero())
            .and_then(|e| e.avg_fill_price)
            .map(|p| p.0)
    }

    fn take_in_placed_legs(&self, account: &AccountId) {
        self.inner.change_account(account, |e, out| {
            e.rehome_strays(Timestamp::now(), out);
        });
    }

    /// R|Protocol does not document how a bracket leg's level is numbered.
    async fn adjust_leg(
        &self,
        account: &AccountId,
        role: OrderRole,
        basket: &str,
        ticks: i32,
        level: i32,
    ) -> Result<(), BrokerError> {
        let entry = |level: i32| -> Result<OrderEntry, BrokerError> {
            let adjust = RithmicBracketLevelAdjustment::new()
                .id(basket)
                .ticks(ticks)
                .level(level)
                .build()
                .map_err(|e| BrokerError::Rejected(orders::plain(&e)))?;
            Ok(if role == OrderRole::StopLoss {
                OrderEntry::BracketStop(adjust)
            } else {
                OrderEntry::BracketTarget(adjust)
            })
        };
        match self.send_change(account, entry(level)?).await {
            Err(BrokerError::Rejected(m)) if level != 1 && m.to_lowercase().contains("level") => {
                warn!(
                    provider = self.inner.provider_id(),
                    "rithmic refused a bracket level by its ticks; asking for the first level"
                );
                self.send_change(account, entry(1)?).await.map(|_| ())
            }
            r => r.map(|_| ()),
        }
    }

    async fn sibling_ended(&self, sibling: &OrderId) -> Option<Order> {
        let deadline = tokio::time::Instant::now() + self.inner.session.opts.request_timeout;
        loop {
            let now = self.order_of(sibling)?;
            if !now.status.is_open() || tokio::time::Instant::now() >= deadline {
                return Some(now);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn send_linked(
        &self,
        request: &OrderRequest,
        tag: &str,
        sibling: Order,
        draft: Option<DraftId>,
    ) -> Result<Order, Linked> {
        let account = request.account_id.clone();
        let fail = Linked::Failed;
        self.precheck(OCO, &account).map_err(fail)?;
        self.precheck(CANCEL, &account).map_err(fail)?;
        let basket = sibling.broker_order_id.clone().unwrap_or_default();
        let cancel = RithmicCancelOrder::new()
            .id(basket)
            .build()
            .map_err(|e| fail(BrokerError::Rejected(orders::plain(&e))))?;
        self.send_change(&account, OrderEntry::Cancel(cancel))
            .await
            .map_err(fail)?;
        let ended = self
            .sibling_ended(&sibling.id)
            .await
            .unwrap_or(sibling.clone());
        let what = if orders::exit_role(sibling.request.order_type) == Some(OrderRole::StopLoss) {
            "stop"
        } else {
            "target"
        };
        if ended.status.is_open() {
            return Err(fail(BrokerError::Unavailable(format!(
                "Rithmic did not confirm the {what}'s cancel to link it with this exit; nothing \
                 sent. Check the {what} on the chart."
            ))));
        }
        if !ended.filled_qty.is_zero() {
            return Err(fail(BrokerError::Rejected(format!(
                "The {what} filled as it was being linked with this exit; nothing sent."
            ))));
        }
        let new_role = orders::exit_role(request.order_type).unwrap_or(OrderRole::TakeProfit);
        let old_role = orders::exit_role(sibling.request.order_type).unwrap_or(OrderRole::StopLoss);
        let mut legs = vec![
            (new_role, request.clone()),
            (old_role, sibling.request.clone()),
        ];
        legs.sort_by_key(|(r, _)| *r != OrderRole::StopLoss);
        let sent = orders::oco_for(&legs, tag)
            .map_err(|e| Linked::NotSent(e, Box::new(sibling.clone())))?;
        let frames = match self.send(&account, sent).await {
            Ok(f) => f,
            Err(SendFail::NotSent(e)) => return Err(Linked::NotSent(e, Box::new(sibling))),
            Err(SendFail::Unknown(why)) => {
                warn!(provider = %self.provider_id(), %why, "rithmic linked exits not confirmed; not sent again");
                let sentence = format!("{} and its other exit", request.restatement());
                self.inner.change_account(&account, |e, _| {
                    e.in_doubt.push(InDoubt {
                        tag: tag.to_owned(),
                        sentence: sentence.clone(),
                        at: Timestamp::now(),
                    });
                });
                return Err(fail(BrokerError::Unavailable(orders::in_doubt_words(
                    &sentence,
                ))));
            }
        };
        if let Some(e) = rejected(&frames) {
            return Err(Linked::NotSent(
                BrokerError::Rejected(self.inner.session.login.redact(&orders::plain(e))),
                Box::new(sibling),
            ));
        }
        let baskets: Vec<String> = frames
            .iter()
            .find_map(|f| match &f.message {
                RithmicMessage::ResponseOcoOrder(r) if !r.basket_id.is_empty() => {
                    Some(r.basket_id.clone())
                }
                _ => None,
            })
            .unwrap_or_default();
        if baskets.len() != legs.len() {
            return Err(fail(BrokerError::Unavailable(
                "Rithmic took the linked stop and target but sent no order ids; they show here \
                 once Rithmic reports them."
                    .into(),
            )));
        }
        let pid = self.provider_id().to_owned();
        let now = Timestamp::now();
        let placed = self.inner.change_account(&account, |e, out| {
            let mut placed = None;
            for ((role, leg), basket) in legs.iter().zip(&baskets) {
                let id = e.order_id(&pid, basket);
                let leg_tag = orders::leg_tag(tag, *role);
                let carried = (*role == old_role).then_some(&sibling);
                let o = e.orders.entry(id.clone()).or_insert_with(|| Order {
                    id: id.clone(),
                    broker_order_id: Some(basket.clone()),
                    draft_id: None,
                    request: leg.clone(),
                    role: OrderRole::Entry,
                    parent_id: None,
                    status: OrderStatus::Working,
                    filled_qty: Qty::ZERO,
                    avg_fill_price: None,
                    queue_ahead: None,
                    stop_rules: None,
                    triggered_at: None,
                    environment: e.account.environment,
                    reason: None,
                    created_at: now,
                    updated_at: now,
                });
                o.request.reduce_only = true;
                o.request.client_order_id = Some(leg_tag.clone());
                o.draft_id = carried.map_or(draft.clone(), |s| s.draft_id.clone());
                o.stop_rules = carried.and_then(|s| s.stop_rules);
                let o = o.clone();
                e.grouped.insert(id.clone());
                e.tags.insert(leg_tag, id.clone());
                if *role == new_role {
                    placed = Some(o.clone());
                }
                out.push(BrokerEvent::Order(o));
            }
            placed
        });
        info!(provider = %pid, "rithmic stop and target linked as one group");
        placed
            .flatten()
            .ok_or_else(|| fail(BrokerError::NotFound(format!("account {account}"))))
    }

    fn put_order(&self, order: Order) {
        self.inner.change(|state, out| {
            if let Some(e) = state.by_id_mut(&order.request.account_id) {
                e.orders.insert(order.id.clone(), order.clone());
            }
            out.push(BrokerEvent::Order(order));
        });
    }
}

impl Inner {
    fn provider_id(&self) -> &str {
        &self.session.opts.provider_id
    }

    fn phase(&self) -> ConnectionPhase {
        self.link.lock().phase().clone()
    }

    fn advance(&self, generation: u64, event: Event) -> bool {
        self.link.lock().advance(generation, event)
    }

    fn current(&self, generation: u64) -> bool {
        self.link.lock().current(generation)
    }

    fn emit(&self, e: BrokerEvent) {
        let _ = self.events.send(e);
    }

    fn change<R>(&self, f: impl FnOnce(&mut State, &mut Vec<BrokerEvent>) -> R) -> R {
        let mut state = self.state.write();
        let mut out = Vec::new();
        let r = f(&mut state, &mut out);
        for e in out {
            self.emit(e);
        }
        drop(state);
        r
    }

    fn change_account<R>(
        &self,
        account: &AccountId,
        f: impl FnOnce(&mut Entry, &mut Vec<BrokerEvent>) -> R,
    ) -> Option<R> {
        self.change(|state, out| state.by_id_mut(account).map(|e| f(e, out)))
    }

    fn drop_plants(&self) {
        if let Some(p) = self.plants.write().take() {
            p.abort();
        }
    }

    fn drop_own(&self, plants: &Arc<Plants>) {
        let mut slot = self.plants.write();
        if slot.as_ref().is_some_and(|p| Arc::ptr_eq(p, plants)) {
            *slot = None;
        }
        drop(slot);
        plants.abort();
    }

    fn unavailable_reason(&self) -> String {
        match self.phase() {
            ConnectionPhase::Stopped => "the Rithmic account connection is not started".into(),
            ConnectionPhase::Connecting => "connecting to Rithmic's order and P&L plants".into(),
            ConnectionPhase::Live => "Rithmic's account plants are not ready".into(),
            ConnectionPhase::Reconnecting { attempt, reason } => format!(
                "Rithmic account connection lost ({reason}); reconnecting, attempt {attempt}"
            ),
            ConnectionPhase::Waiting => "Logged out by Rithmic; logging in again".into(),
            ConnectionPhase::LoggedOut => {
                "Rithmic ended the session (ForcedLogout); reconnect to continue".into()
            }
            ConnectionPhase::TakenOver => crate::session::TAKEN_OVER.into(),
            ConnectionPhase::Refused { reason } => format!("Rithmic refused the login: {reason}"),
            ConnectionPhase::Unreachable { reason } => format!("cannot reach Rithmic: {reason}"),
        }
    }

    async fn read<T>(
        &self,
        template: i32,
        fut: impl std::future::Future<Output = Result<T, RithmicError>>,
    ) -> Result<T, BrokerError> {
        self.session
            .gate
            .allow(Template::AccountRead(template))
            .map_err(gate_error)?;
        match tokio::time::timeout(self.session.opts.request_timeout, fut).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(BrokerError::Unavailable(self.session.redact(e))),
            Err(_) => Err(BrokerError::Unavailable(format!(
                "Rithmic did not answer template {template} within {:?}",
                self.session.opts.request_timeout
            ))),
        }
    }

    fn note(&self, what: &str, r: Result<impl Sized, BrokerError>) {
        if let Err(e) = r {
            warn!(provider = %self.provider_id(), %e, "rithmic {what} unavailable");
        }
    }

    fn note_frame(&self, what: &str, r: Result<RithmicResponse, BrokerError>) {
        match r {
            Ok(f) => {
                if let Some(e) = &f.error {
                    warn!(
                        provider = %self.provider_id(),
                        error = %self.session.redact(e),
                        "rithmic {what} refused",
                    );
                }
            }
            Err(e) => warn!(provider = %self.provider_id(), %e, "rithmic {what} unavailable"),
        }
    }

    async fn open(self: &Arc<Self>) -> Result<Opened, OpenError> {
        let session_generation = self.session.generation();
        let login = &self.session.login;
        let timeout = self.session.opts.connect_timeout;
        let cfg = config(login, 1 << 12)?;

        self.session.gate.allow(Template::Login)?;
        for id in AUTO_AFTER_LOGIN {
            self.session.gate.allow(Template::AccountRead(id))?;
        }
        let order = tokio::time::timeout(
            timeout,
            RithmicOrderPlant::connect(&cfg, ConnectStrategy::Simple),
        )
        .await
        .map_err(|_| OpenError::Transport("order plant connect timed out".into()))?
        .map_err(|e| OpenError::Transport(self.session.redact(e)))?;
        let order = Owned::new(order);
        let order_login = order.get_handle(&RithmicAccount::new("", "", ""));
        match tokio::time::timeout(timeout, order_login.login()).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(login_error(&e, |x| self.session.redact(x))),
            Err(_) => return Err(OpenError::Transport("order plant login timed out".into())),
        }
        let order_rx = order.subscribe_all();

        let listed = self
            .read(ACCOUNT_LIST, order_login.get_account_list())
            .await
            .map_err(|e| OpenError::Transport(e.to_string()));
        let listed = listed?;
        if let Some(e) = rejected(&listed) {
            return Err(OpenError::Refused(format!(
                "the account list was refused: {}",
                self.session.redact(e)
            )));
        }
        let pid = self.provider_id().to_owned();
        let infos: Vec<AccountInfo> = listed
            .iter()
            .filter_map(|r| match &r.message {
                RithmicMessage::ResponseAccountList(a) => AccountInfo::from_list(&pid, a),
                _ => None,
            })
            .collect();

        self.session.gate.allow(Template::Login)?;
        let pnl = match tokio::time::timeout(
            timeout,
            RithmicPnlPlant::connect(&cfg, ConnectStrategy::Simple),
        )
        .await
        {
            Ok(Ok(p)) => Owned::new(p),
            Ok(Err(e)) => return Err(OpenError::Transport(self.session.redact(e))),
            Err(_) => return Err(OpenError::Transport("PnL plant connect timed out".into())),
        };
        let pnl_rx = pnl.subscribe_all();
        let mut pnls = HashMap::new();
        let mut orders = HashMap::new();
        for i in &infos {
            pnls.insert(i.id.clone(), pnl.get_handle(&i.account));
            orders.insert(
                i.id.clone(),
                AccountOrders::new(&i.id, order.get_handle(&i.account)),
            );
        }
        // One login serves every handle of a rithmic-rs plant, an empty account's included.
        let pnl_login = pnl.get_handle(
            &infos
                .first()
                .map_or_else(|| RithmicAccount::new("", "", ""), |i| i.account.clone()),
        );
        match tokio::time::timeout(timeout, pnl_login.login()).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(login_error(&e, |x| self.session.redact(x))),
            Err(_) => return Err(OpenError::Transport("PnL plant login timed out".into())),
        }

        self.install(&infos);
        info!(
            provider = %pid,
            accounts = infos.len(),
            "rithmic order and PnL plants logged in",
        );

        let plants = Arc::new(Plants {
            order,
            _pnl: pnl,
            orders,
            pnls,
            login: order_login,
            pnl_login: Some(pnl_login),
        });
        *self.plants.write() = Some(Arc::clone(&plants));
        let mut opened = Opened {
            plants,
            order_rx,
            pnl_rx,
            ended: None,
            session_generation,
        };
        self.load(&mut opened).await;
        Ok(opened)
    }

    fn install(&self, infos: &[AccountInfo]) {
        let pid = self.provider_id();
        let system = &self.session.login.system_name;
        let mut state = self.state.write();
        let mut old: Vec<Entry> = std::mem::take(&mut state.accounts);
        for info in infos.iter().cloned() {
            let account = info.trading_account(pid, system);
            let kept = old
                .iter()
                .position(|e| e.info.id == info.id)
                .map(|at| old.swap_remove(at));
            state.accounts.push(match kept {
                Some(mut e) => {
                    e.info = info;
                    e.account = account;
                    e
                }
                None => Entry::new(info, account),
            });
        }
    }

    fn apply_rms(&self, frames: &[RithmicResponse]) {
        let messages: Vec<&RithmicMessage> = frames.iter().map(|f| &f.message).collect();
        self.apply_rms_messages(&messages);
    }

    fn apply_rms_messages(&self, messages: &[&RithmicMessage]) {
        let mut state = self.state.write();
        for m in messages {
            if let RithmicMessage::ResponseAccountRmsInfo(i) = m
                && let Some((acct, limits)) = RmsLimits::from_info(i)
                && let Some(e) = state.by_rithmic(Some(&acct))
            {
                e.rms = Some(limits);
            }
        }
    }

    async fn load(self: &Arc<Self>, opened: &mut Opened) {
        let plants = Arc::clone(&opened.plants);
        let ids: Vec<AccountId> = plants.orders.keys().cloned().collect();
        for id in &ids {
            let h = plants.orders[id].reads();
            match self.read(RMS_INFO, h.get_account_rms_info()).await {
                Ok(frames) => self.apply_rms(&frames),
                Err(e) => self.note("RMS info", Err::<(), _>(e)),
            }
            let r = self
                .read(
                    RMS_UPDATES,
                    h.subscribe_account_rms_updates(
                        true,
                        vec![RmsUpdateBits::AutoLiqThresholdCurrentValue],
                    ),
                )
                .await;
            self.note_frame("RMS updates", r);
            let r = self.read(ORDER_UPDATES, h.subscribe_order_updates()).await;
            self.note_frame("order updates", r);
            let r = self
                .read(BRACKET_UPDATES, h.subscribe_bracket_updates())
                .await;
            self.note_frame("bracket updates", r);
            let r = self.read(SHOW_ORDERS, h.show_orders()).await;
            self.note_frame("working orders", r);
            // Rithmic replays an account's order history onto the order updates.
            if self
                .state
                .read()
                .by_id(id)
                .is_some_and(|e| !e.in_doubt.is_empty())
            {
                let r = self.read(ORDER_HISTORY, h.show_order_history(None)).await;
                self.note("order history", r);
            }
            let r = self.replay_today(&plants, id).await;
            self.note("today's fills", r);

            let p = &plants.pnls[id];
            let r = self.read(PNL_SNAPSHOT, p.get_pnl_position_snapshot()).await;
            self.note_frame("P&L snapshot", r);
            let r = self.read(PNL_UPDATES, p.subscribe_pnl_updates()).await;
            self.note_frame("P&L updates", r);
        }
        // Rithmic delivers the P&L snapshot as updates, not in the reply.
        let deadline = tokio::time::Instant::now() + SNAPSHOT_WAIT;
        while opened.ended.is_none() && !self.state.read().accounts.iter().all(|e| e.pnl_seen) {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                r = opened.order_rx.recv() => match r {
                    Ok(u) => opened.ended = self.on_order(u),
                    Err(RecvError::Closed) => {
                        opened.ended = Some(End::Lost("the order plant stopped".into()));
                    }
                    Err(RecvError::Lagged(_)) => {
                        self.coverage_lost(Timestamp::now());
                        self.resync(&opened.plants);
                    }
                },
                r = opened.pnl_rx.recv() => match r {
                    Ok(u) => opened.ended = self.on_pnl(u),
                    Err(RecvError::Closed) => {
                        opened.ended = Some(End::Lost("the PnL plant stopped".into()));
                    }
                    Err(RecvError::Lagged(_)) => self.resync(&opened.plants),
                },
            }
        }
    }

    async fn replay_today(&self, plants: &Plants, account: &AccountId) -> Result<(), BrokerError> {
        let _one = self.fill_pull.lock().await;
        if self.coverage_of(account)?.0.needs_replay() {
            self.replay(plants, account).await?;
        }
        Ok(())
    }

    fn coverage_of(
        &self,
        account: &AccountId,
    ) -> Result<(Coverage, Option<Timestamp>), BrokerError> {
        self.state
            .read()
            .by_id(account)
            .map(|e| (e.coverage, e.info.created))
            .ok_or_else(|| BrokerError::NotFound(format!("account {account}")))
    }

    async fn replay(&self, plants: &Plants, account: &AccountId) -> Result<(), BrokerError> {
        let h = plants_reads(plants, account)?;
        let now = Timestamp::now();
        let today = fill_days::trade_date(now);
        let open = fill_days::session_open(today);
        let mut updates = plants.order.subscribe_all();
        let frames = self
            .read(
                REPLAY_EXECUTIONS,
                h.replay_executions(unix_secs(open), unix_secs(now).saturating_add(1)),
            )
            .await?;
        if let Some(e) = rejected(&frames) {
            return Err(BrokerError::Rejected(self.session.redact(e)));
        }
        let (replayed, missed) = buffered(&mut updates);
        if missed > 0 {
            warn!(
                provider = %self.provider_id(),
                missed,
                "rithmic replayed more executions than the order plant buffers",
            );
        }
        let pid = self.provider_id().to_owned();
        let mut state = self.state.write();
        let Some(e) = state.by_id_mut(account) else {
            return Ok(());
        };
        for u in &replayed {
            if let RithmicMessage::ExchangeOrderNotification(n) = &u.message
                && n.account_id.as_deref() == Some(e.info.account.account_id.as_str())
                && let Some(fill) = e.fill_of(&pid, n)
            {
                e.add_fill(fill);
            }
        }
        if missed == 0 {
            e.coverage.replayed(today);
        }
        Ok(())
    }

    async fn load_fills(
        &self,
        plants: &Plants,
        account: &AccountId,
        wanted: NaiveDate,
    ) -> Result<(), BrokerError> {
        let _one = self.fill_pull.lock().await;
        if self.coverage_of(account)?.0.needs_replay() {
            self.replay(plants, account).await?;
        }
        let (coverage, created) = self.coverage_of(account)?;
        let Some(days) = coverage.missing(wanted, created) else {
            return Ok(());
        };
        self.prior_fills(plants, account, days).await?;
        if let Some(e) = self.state.write().by_id_mut(account) {
            e.coverage.fetched(wanted);
        }
        Ok(())
    }

    async fn prior_fills(
        &self,
        plants: &Plants,
        account: &AccountId,
        days: TradeDays,
    ) -> Result<(), BrokerError> {
        let h = plants_reads(plants, account)?;
        let mut ahead: VecDeque<TradeDays> = days.windows().into();
        while let Some(window) = ahead.pop_front() {
            let (start, finish) = window.yyyymmdd();
            let frames = self
                .read(
                    FILL_HISTORY,
                    h.show_fill_history(
                        FillHistoryRange::trade_date(start, finish),
                        Some(FILL_PAGE),
                    ),
                )
                .await?;
            if let Some(e) = rejected(&frames) {
                return Err(BrokerError::Rejected(self.session.redact(e)));
            }
            let rows: Vec<&ResponseShowFillHistory> = frames
                .iter()
                .filter_map(|f| match &f.message {
                    RithmicMessage::ResponseShowFillHistory(r) if r.rp_code.is_empty() => Some(r),
                    _ => None,
                })
                .collect();
            if rows.len() >= FILL_PAGE as usize {
                if let Some([older, newer]) = window.halves() {
                    ahead.push_front(newer);
                    ahead.push_front(older);
                    continue;
                }
                warn!(
                    provider = %self.provider_id(),
                    "rithmic fill history is full for one trade date; that day may be missing fills",
                );
            }
            let pid = self.provider_id().to_owned();
            let mut state = self.state.write();
            let Some(e) = state.by_id_mut(account) else {
                return Ok(());
            };
            for r in rows {
                if let Some(fill) = account::fill_from_history(r, e.ctx(&pid)) {
                    e.add_fill(fill);
                }
            }
        }
        Ok(())
    }

    fn coverage_lost(&self, at: Timestamp) {
        for e in &mut self.state.write().accounts {
            e.coverage.lost(at);
        }
    }

    fn on_order(&self, u: RithmicResponse) -> Option<End> {
        self.on_order_message(&u.message, u.error.as_ref())
    }

    fn on_order_message(
        &self,
        message: &RithmicMessage,
        error: Option<&RithmicError>,
    ) -> Option<End> {
        if let Some(end) = connection_end(message, error) {
            return Some(end);
        }
        self.last_message
            .store(Timestamp::now().nanos(), Ordering::Relaxed);
        let pid = self.provider_id().to_owned();
        let now = Timestamp::now();
        self.change(|state, out| match message {
            RithmicMessage::RithmicOrderNotification(n) => {
                if let Some(e) = state.by_rithmic(n.account_id.as_deref()) {
                    e.on_order_notification(&pid, n, now, out);
                }
            }
            RithmicMessage::ExchangeOrderNotification(n) => {
                if let Some(e) = state.by_rithmic(n.account_id.as_deref()) {
                    if let Some(f) = e.fill_of(&pid, n) {
                        if n.is_snapshot == Some(true) {
                            e.add_fill(f);
                        } else if e.add_fill(f.clone()) {
                            out.push(BrokerEvent::Fill(f.clone()));
                            e.on_live_fill(&f, now, out);
                        }
                    }
                    if n.notify_type == Some(6)
                        && let Some(b) = n.basket_id.as_deref()
                    {
                        let id = e.order_id(&pid, b);
                        if let Some(o) = e.orders.get_mut(&id) {
                            o.status = OrderStatus::Rejected;
                            o.reason = orders::rejected_words(
                                n.text.as_deref().or(n.report_text.as_deref()),
                            )
                            .or(o.reason.take());
                            o.updated_at = now;
                            out.push(BrokerEvent::Order(o.clone()));
                        }
                    }
                }
            }
            RithmicMessage::BracketUpdates(b) => {
                if let Some(e) = state.by_rithmic(b.account_id.as_deref()) {
                    e.on_bracket_update(b, now, out);
                }
            }
            RithmicMessage::AccountRmsUpdates(r) => {
                if let Some(e) = state.by_rithmic(r.account_id.as_deref()) {
                    e.live.merge(r);
                    if e.pnl_seen {
                        out.push(BrokerEvent::Account(account::summary(
                            &e.info.id,
                            e.info.currency,
                            &e.pnl,
                            now,
                        )));
                    }
                }
            }
            _ => {}
        });
        None
    }

    fn on_pnl(&self, u: RithmicResponse) -> Option<End> {
        self.on_pnl_message(&u.message, u.error.as_ref())
    }

    fn on_pnl_message(
        &self,
        message: &RithmicMessage,
        error: Option<&RithmicError>,
    ) -> Option<End> {
        if let Some(end) = connection_end(message, error) {
            return Some(end);
        }
        self.last_message
            .store(Timestamp::now().nanos(), Ordering::Relaxed);
        let now = Timestamp::now();
        self.change(|state, out| match message {
            RithmicMessage::AccountPnLPositionUpdate(p) => {
                if let Some(e) = state.by_rithmic(p.account_id.as_deref()) {
                    e.pnl.merge(p);
                    e.pnl_seen = true;
                    out.push(BrokerEvent::Account(account::summary(
                        &e.info.id,
                        e.info.currency,
                        &e.pnl,
                        now,
                    )));
                }
            }
            RithmicMessage::InstrumentPnLPositionUpdate(p) => {
                if let Some(e) = state.by_rithmic(p.account_id.as_deref()) {
                    let key = match (&p.symbol, &p.exchange) {
                        (Some(s), Some(x)) => Some(crate::symbols::instrument_id(s, x)),
                        _ => None,
                    };
                    let prev = key.as_ref().and_then(|k| e.positions.get(k));
                    if let Some(pos) = account::position(&e.info.id, p, prev, e.info.currency, now)
                    {
                        let was = prev.map_or(Decimal::ZERO, |x| x.qty.0);
                        let changed = prev != Some(&pos);
                        let instrument = pos.instrument.clone();
                        let read = if p.is_snapshot == Some(true) {
                            Read::Snapshot
                        } else {
                            Read::Update
                        };
                        e.unshown.entry(instrument.clone()).or_default().shown(
                            pos.qty.0 - was,
                            now,
                            read,
                        );
                        e.positions.insert(instrument.clone(), pos);
                        e.tell_position(&instrument, changed, out);
                    }
                }
            }
            _ => {}
        });
        None
    }

    async fn supervise(self: Arc<Self>, mut opened: Opened, generation: u64) {
        loop {
            let ended = self.pump(&mut opened, generation).await;
            self.coverage_lost(Timestamp::now());
            self.drop_own(&opened.plants);
            if !self.current(generation) {
                return;
            }
            match ended {
                End::Stopped => return,
                End::Forced => {
                    if !self.session.gate.is_closed() {
                        self.session
                            .forced_logout("order", opened.session_generation);
                    }
                    if !self.advance(generation, Event::Waiting) {
                        return;
                    }
                    self.emit(BrokerEvent::Disconnected {
                        reason: self.session.forced_out_words(),
                    });
                    match self.recover(generation, Wait::Forced).await {
                        Some(o) => opened = o,
                        None => return,
                    }
                }
                End::Lost(reason) => {
                    warn!(
                        provider = %self.provider_id(),
                        %reason,
                        "rithmic account plants connection lost",
                    );
                    self.emit(BrokerEvent::Disconnected {
                        reason: format!("Connection to Rithmic lost ({reason}). Reconnecting."),
                    });
                    match self.recover(generation, Wait::Backoff(reason)).await {
                        Some(o) => opened = o,
                        None => return,
                    }
                }
            }
        }
    }

    async fn pump(&self, opened: &mut Opened, generation: u64) -> End {
        if let Some(end) = opened.ended.take() {
            return end;
        }
        loop {
            if !self.current(generation) {
                return End::Stopped;
            }
            if self.session.gate.is_closed() {
                return End::Forced;
            }
            let end = tokio::select! {
                r = opened.order_rx.recv() => match r {
                    Ok(u) => self.on_order(u),
                    Err(RecvError::Lagged(n)) => {
                        warn!(provider = %self.provider_id(), missed = n, "rithmic order updates missed; reloading");
                        self.coverage_lost(Timestamp::now());
                        self.resync(&opened.plants);
                        None
                    }
                    Err(RecvError::Closed) => Some(End::Lost("the order plant stopped".into())),
                },
                r = opened.pnl_rx.recv() => match r {
                    Ok(u) => self.on_pnl(u),
                    Err(RecvError::Lagged(n)) => {
                        warn!(provider = %self.provider_id(), missed = n, "rithmic P&L updates missed; reloading");
                        self.resync(&opened.plants);
                        None
                    }
                    Err(RecvError::Closed) => Some(End::Lost("the PnL plant stopped".into())),
                },
                _ = tokio::time::sleep(Duration::from_secs(1)) => None,
            };
            match end {
                Some(End::Lost(r)) => return End::Lost(self.session.redact(r)),
                Some(e) => return e,
                None => {}
            }
        }
    }

    fn resync(&self, plants: &Arc<Plants>) {
        let plants = Arc::clone(plants);
        let session = Arc::clone(&self.session);
        self.session.runtime().spawn(async move {
            for (id, p) in &plants.pnls {
                if session
                    .gate
                    .allow(Template::AccountRead(PNL_SNAPSHOT))
                    .is_ok()
                {
                    let _ = tokio::time::timeout(
                        session.opts.request_timeout,
                        p.get_pnl_position_snapshot(),
                    )
                    .await;
                }
                if let Some(h) = plants.orders.get(id)
                    && session
                        .gate
                        .allow(Template::AccountRead(SHOW_ORDERS))
                        .is_ok()
                {
                    let _ =
                        tokio::time::timeout(session.opts.request_timeout, h.reads().show_orders())
                            .await;
                }
            }
        });
    }

    async fn recover(self: &Arc<Self>, generation: u64, mut wait: Wait) -> Option<Opened> {
        let mut attempt = 0u32;
        loop {
            match &wait {
                Wait::Forced => {
                    if !self.advance(generation, Event::Waiting) {
                        return None;
                    }
                    loop {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        if !self.current(generation) {
                            return None;
                        }
                        match self.session.phase() {
                            ConnectionPhase::Live if !self.session.gate.is_closed() => break,
                            p if p == ConnectionPhase::Live || p.coming_back() => {}
                            ConnectionPhase::TakenOver => {
                                self.advance(generation, Event::TakenOver);
                                return None;
                            }
                            _ => {
                                self.advance(generation, Event::LoggedOut);
                                return None;
                            }
                        }
                    }
                }
                Wait::Backoff(reason) => {
                    attempt += 1;
                    let retrying = Event::Retrying {
                        attempt,
                        reason: reason.clone(),
                    };
                    if !self.advance(generation, retrying) {
                        return None;
                    }
                    tokio::time::sleep(RECONNECT.delay(attempt)).await;
                    if !self.current(generation) {
                        return None;
                    }
                    if self.session.gate.is_closed() {
                        wait = Wait::Forced;
                        continue;
                    }
                }
            }
            let _one = self.starting.lock().await;
            if !self.current(generation) {
                return None;
            }
            match self.open().await {
                Ok(o) if self.advance(generation, Event::LoggedIn) => {
                    info!(provider = %self.provider_id(), attempt, "rithmic account plants reconnected");
                    return Some(o);
                }
                Ok(o) => {
                    self.drop_own(&o.plants);
                    return None;
                }
                Err(OpenError::Refused(m)) => {
                    warn!(provider = %self.provider_id(), "rithmic refused the login on reconnect; not retrying");
                    self.advance(generation, Event::Refused(m));
                    return None;
                }
                Err(OpenError::Gate(_)) => wait = Wait::Forced,
                Err(OpenError::Transport(m)) => {
                    warn!(provider = %self.provider_id(), attempt, reason = %m, "rithmic account plants reconnect failed");
                    if matches!(wait, Wait::Forced) {
                        wait = Wait::Backoff(m);
                    }
                }
            }
        }
    }
}

enum Wait {
    Backoff(String),
    Forced,
}

struct Opened {
    plants: Arc<Plants>,
    order_rx: broadcast::Receiver<RithmicResponse>,
    pnl_rx: broadcast::Receiver<RithmicResponse>,
    ended: Option<End>,
    session_generation: u64,
}

fn plants_reads<'a>(
    plants: &'a Plants,
    account: &AccountId,
) -> Result<&'a RithmicOrderPlantHandle, BrokerError> {
    plants
        .orders
        .get(account)
        .map(AccountOrders::reads)
        .ok_or_else(|| BrokerError::NotFound(format!("account {account}")))
}

fn unix_secs(ts: Timestamp) -> i32 {
    i32::try_from(ts.secs().max(0)).unwrap_or(i32::MAX)
}

fn buffered(updates: &mut broadcast::Receiver<RithmicResponse>) -> (Vec<RithmicResponse>, u64) {
    let mut out = Vec::new();
    let mut missed = 0;
    loop {
        match updates.try_recv() {
            Ok(u) => out.push(u),
            Err(TryRecvError::Lagged(n)) => missed += n,
            Err(TryRecvError::Empty | TryRecvError::Closed) => return (out, missed),
        }
    }
}

#[async_trait]
impl BrokerProvider for RithmicBroker {
    fn id(&self) -> &str {
        self.provider_id()
    }

    fn capabilities(&self) -> BrokerCapabilities {
        self.caps(self.takes_any_orders())
    }

    async fn connection_of(
        &self,
        account: &AccountId,
    ) -> Result<tessera_broker::BrokerConnection, BrokerError> {
        Ok(tessera_broker::BrokerConnection {
            id: self.provider_id().to_owned(),
            system: self.system(),
            capabilities: self.caps(self.takes_orders(account)),
        })
    }

    fn account_order_entry(&self) -> Option<Vec<AccountId>> {
        let gate = &self.inner.session.gate;
        gate.is_per_account().then(|| {
            gate.order_entry_accounts()
                .into_iter()
                .map(AccountId::new)
                .collect()
        })
    }

    fn system(&self) -> BrokerSystem {
        let name = self.inner.session.login.system_name.clone();
        BrokerSystem {
            environment: system_environment(&name),
            name,
        }
    }

    fn health(&self) -> ProviderHealth {
        let in_doubt: usize = self
            .inner
            .state
            .read()
            .accounts
            .iter()
            .map(|e| e.doubts(Timestamp::now()))
            .sum();
        let phase = self.phase();
        let (status, message) = match &phase {
            ConnectionPhase::Live if in_doubt > 0 => (
                HealthStatus::Degraded,
                Some(format!(
                    "{in_doubt} order{} sent as the connection dropped {} not confirmed by \
                     Rithmic; check the firm's platform.",
                    if in_doubt == 1 { "" } else { "s" },
                    if in_doubt == 1 { "is" } else { "are" },
                )),
            ),
            p => (p.status(), None),
        };
        let last = self.inner.last_message.load(Ordering::Relaxed);
        ProviderHealth {
            provider_id: self.provider_id().to_owned(),
            kind: ProviderKind::Broker,
            display_name: self.inner.session.opts.display_name.clone(),
            status,
            latency_ms: None,
            last_message_at: (last > 0).then_some(Timestamp(last)),
            message,
            connection: Some(phase),
            accounts: None,
            checked_at: Timestamp::now(),
        }
    }

    fn environment_of(&self, account: &AccountId) -> Option<Environment> {
        self.inner
            .state
            .read()
            .by_id(account)
            .map(|e| e.account.environment)
    }

    fn order_of(&self, order: &OrderId) -> Option<Order> {
        self.inner
            .state
            .read()
            .accounts
            .iter()
            .find_map(|e| e.orders.get(order).cloned())
    }

    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        let state = self.inner.state.read();
        if state.accounts.is_empty() && self.phase() != ConnectionPhase::Live {
            return Err(BrokerError::Unavailable(self.inner.unavailable_reason()));
        }
        Ok(state.accounts.iter().map(|e| e.account.clone()).collect())
    }

    async fn summary(&self, account: &AccountId) -> Result<AccountSummary, BrokerError> {
        self.with_entry(account, |e| {
            if !e.pnl_seen {
                return Err(BrokerError::Unavailable(
                    "Rithmic has not sent this account's P&L yet".into(),
                ));
            }
            Ok(account::summary(
                &e.info.id,
                e.info.currency,
                &e.pnl,
                Timestamp::now(),
            ))
        })
    }

    async fn positions(&self, account: &AccountId) -> Result<Vec<Position>, BrokerError> {
        self.with_entry(account, |e| Ok(e.open_positions()))
    }

    async fn orders(&self, account: &AccountId) -> Result<Vec<Order>, BrokerError> {
        self.with_entry(account, |e| {
            let mut v: Vec<Order> = e.orders.values().cloned().collect();
            v.sort_by_key(|o| o.created_at);
            Ok(v)
        })
    }

    async fn fills(&self, account: &AccountId, since: Timestamp) -> Result<Vec<Fill>, BrokerError> {
        let created = self.with_entry(account, |e| Ok(e.info.created))?;
        let floor = created.unwrap_or_else(|| {
            Timestamp(Timestamp::now().nanos() - FILL_LOOKBACK_DAYS * 86_400 * NANOS_PER_SEC)
        });
        let wanted = fill_days::trade_date(since.max(floor));
        let plants = self.inner.plants.read().clone();
        match plants {
            Some(plants) => self.inner.load_fills(&plants, account, wanted).await?,
            None if self.with_entry(account, |e| Ok(e.coverage.holds(wanted)))? => {}
            None => return Err(BrokerError::Unavailable(self.inner.unavailable_reason())),
        }
        self.with_entry(account, |e| {
            Ok(e.fills.iter().filter(|f| f.ts >= since).cloned().collect())
        })
    }

    async fn preview(&self, request: &OrderRequest) -> Result<OrderPreview, BrokerError> {
        let account = &request.account_id;
        let (environment, rms, held, in_doubt) = self.with_entry(account, |e| {
            let held = Qty(e.held(&request.instrument));
            Ok((
                e.account.environment,
                e.rms.clone(),
                held,
                e.doubts(Timestamp::now()),
            ))
        })?;
        let signed = match request.side {
            Side::Buy => request.qty,
            Side::Sell => Qty::new(-request.qty.value()),
        };
        let after = Qty::new(held.value() + signed.value());
        let mut checks = Vec::new();
        let block = |code: &str, message: String| PreTradeCheck {
            code: code.into(),
            severity: CheckSeverity::Block,
            message,
        };
        let gate = &self.inner.session.gate;
        let system = &self.inner.session.login.system_name;
        if gate.is_paper_system() {
            if !gate.paper_routing() {
                checks.push(block(
                    "routing_disabled",
                    format!("Order routing is off for {system}; turn it on to send orders."),
                ));
            }
        } else if !gate.account_order_entry(account.as_str()) {
            checks.push(block(
                "order_entry_off",
                "Order entry is off for this account; turn it on in Accounts to send it orders."
                    .into(),
            ));
        }
        if let Some(b) = request.bracket.filter(|b| !b.is_empty()) {
            if request.order_type == OrderType::Market {
                checks.push(PreTradeCheck {
                    code: "bracket_from_fill".into(),
                    severity: CheckSeverity::Info,
                    message: "Rithmic places the stop and target the same number of ticks from \
                              the fill."
                        .into(),
                });
            }
            if b.has_stop_rules() {
                checks.push(PreTradeCheck {
                    code: "stop_rules_held".into(),
                    severity: CheckSeverity::Info,
                    message: orders::STOP_RULES_HELD.into(),
                });
            }
        }
        if request.reduce_only {
            let closes = !held.is_zero()
                && held.value().is_sign_positive() != signed.value().is_sign_positive()
                && request.qty.value() <= held.value().abs();
            if !closes {
                checks.push(block(
                    "reduce_only",
                    "A closing order cannot open or add to a position.".into(),
                ));
            }
        }
        if in_doubt > 0 {
            checks.push(PreTradeCheck {
                code: "order_in_doubt".into(),
                severity: CheckSeverity::Warn,
                message: "An order sent as the connection dropped is not confirmed yet; check \
                          the firm's platform before adding to it."
                    .into(),
            });
        }
        if let Some(r) = &rms {
            if r.is_locked() && !request.reduce_only {
                checks.push(block(
                    "account_locked",
                    format!(
                        "Rithmic has this account {}; it takes no new positions.",
                        r.status.as_deref().unwrap_or("locked")
                    ),
                ));
            }
            let limits = r.contract_limits();
            let info = |code: &str, what: String| PreTradeCheck {
                code: code.into(),
                severity: CheckSeverity::Info,
                message: format!(
                    "Rithmic reports {what}; Rithmic refuses the order itself if it is over the \
                     account's limits."
                ),
            };
            if let Some(max) = limits.and_then(|l| l.per_order)
                && request.qty.value() > rust_decimal::Decimal::from(max)
            {
                checks.push(info(
                    "max_order_size",
                    format!("an account order limit of {max}"),
                ));
            }
            let (limit, over, side) = if after.value().is_sign_negative() {
                (limits.and_then(|l| l.sell), after.value().abs(), "sell")
            } else {
                (limits.and_then(|l| l.buy), after.value(), "buy")
            };
            if let Some(limit) = limit
                && over > rust_decimal::Decimal::from(limit)
            {
                checks.push(info(
                    "max_position",
                    format!("an account {side} limit of {limit}"),
                ));
            }
        }
        Ok(OrderPreview {
            request: request.clone(),
            environment,
            restatement: request.restatement(),
            reference_price: None,
            est_price: request.limit_price.or(request.stop_price),
            est_value: None,
            est_fees: None,
            risk_to_stop: None,
            buying_power_after: None,
            position_after: Some(after),
            checks,
            created_at: Timestamp::now(),
        })
    }

    async fn risk(&self, account: &AccountId) -> Result<Option<RiskStatus>, BrokerError> {
        self.with_entry(account, |e| {
            Ok(account::risk(
                &e.info,
                e.rms.as_ref(),
                e.live,
                &e.pnl,
                Timestamp::now(),
            ))
        })
    }

    async fn submit(
        &self,
        verified: &Verified,
        request: OrderRequest,
        draft: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        let account = request.account_id.clone();
        let bracketed = request.bracket.is_some_and(|b| !b.is_empty());
        self.precheck(if bracketed { BRACKET } else { NEW_ORDER }, &account)?;
        let pid = self.provider_id().to_owned();
        let tag = account::exit_tag(
            request
                .client_order_id
                .clone()
                .unwrap_or_else(|| OrderId::generate().0),
            request.reduce_only,
        );
        {
            let mut state = self.inner.state.write();
            let e = state
                .by_id_mut(&account)
                .ok_or_else(|| BrokerError::NotFound(format!("account {account}")))?;
            if let Some(o) = e.tags.get(&tag).and_then(|id| e.orders.get(id)) {
                return Ok(o.clone());
            }
            if e.doubted(&tag, Timestamp::now()) {
                return Err(BrokerError::Unavailable(orders::in_doubt_words(
                    &request.restatement(),
                )));
            }
            if !e.sending.insert(tag.clone()) {
                return Err(BrokerError::Rejected(
                    "This order is being sent already.".into(),
                ));
            }
        }
        let done = |inner: &Inner| {
            inner.change_account(&account, |e, out| {
                e.sending.remove(&tag);
                e.replay_early(&pid, Timestamp::now(), out);
            });
        };
        let sibling = self
            .inner
            .state
            .read()
            .by_id(&account)
            .and_then(|e| e.unlinked_sibling(&request));
        if let Some(sibling) = sibling {
            let r = self.send_linked(&request, &tag, sibling, draft).await;
            done(&self.inner);
            return match r {
                Err(Linked::NotSent(e, sibling)) => {
                    let sibling = *sibling;
                    warn!(provider = %pid, error = %e, "rithmic exit not linked; its other exit goes back alone");
                    let mut back = sibling.request;
                    back.client_order_id = Some(OrderId::generate().0);
                    if let Err(again) =
                        Box::pin(self.submit(verified, back, sibling.draft_id)).await
                    {
                        warn!(provider = %pid, error = %again, "rithmic exit not placed back");
                        return Err(BrokerError::Rejected(format!(
                            "{}. Its other exit was cancelled to be linked and could not be \
                             placed back: {}. Place it again.",
                            said(&e),
                            said(&again)
                        )));
                    }
                    Err(e)
                }
                Err(Linked::Failed(e)) => Err(e),
                Ok(o) => Ok(o),
            };
        }
        let (tick, last) = self.tick_and_last(&request.instrument, request.side);
        let (entry, plan) = match orders::entry_for(&request, &tag, tick, last) {
            Ok(x) => x,
            Err(e) => {
                done(&self.inner);
                return Err(e);
            }
        };
        let frames = match self.send(&account, entry).await {
            Ok(frames) => frames,
            Err(SendFail::NotSent(e)) => {
                done(&self.inner);
                return Err(e);
            }
            Err(SendFail::Unknown(why)) => {
                warn!(provider = %pid, %why, "rithmic order not confirmed; not sent again");
                let sentence = request.restatement();
                self.inner.change_account(&account, |e, out| {
                    e.sending.remove(&tag);
                    e.in_doubt.push(InDoubt {
                        tag: tag.clone(),
                        sentence: sentence.clone(),
                        at: Timestamp::now(),
                    });
                    e.replay_early(&pid, Timestamp::now(), out);
                });
                return Err(BrokerError::Unavailable(orders::in_doubt_words(&sentence)));
            }
        };
        if let Some(e) = rejected(&frames) {
            done(&self.inner);
            return Err(BrokerError::Rejected(
                self.inner.session.login.redact(&orders::plain(e)),
            ));
        }
        let Some(basket) = frames.iter().find_map(|f| match &f.message {
            RithmicMessage::ResponseNewOrder(r) => r.basket_id.clone(),
            RithmicMessage::ResponseBracketOrder(r) => r.basket_id.clone(),
            _ => None,
        }) else {
            done(&self.inner);
            return Err(BrokerError::Unavailable(
                "Rithmic took the order but sent no order id; it shows here once Rithmic reports \
                 it."
                .into(),
            ));
        };
        let now = Timestamp::now();
        self.inner.change(|state, out| {
            let e = state
                .by_id_mut(&account)
                .ok_or_else(|| BrokerError::NotFound(format!("account {account}")))?;
            let id = e.order_id(&pid, &basket);
            let environment = e.account.environment;
            let blank = |request: OrderRequest, role, parent_id, status| Order {
                id: id.clone(),
                broker_order_id: Some(basket.clone()),
                draft_id: None,
                request,
                role,
                parent_id,
                status,
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
            let order = e.orders.entry(id.clone()).or_insert_with(|| {
                blank(
                    request.clone(),
                    OrderRole::Entry,
                    None,
                    OrderStatus::PendingSubmit,
                )
            });
            order.draft_id = draft;
            order.request.reduce_only = request.reduce_only;
            order.request.bracket = request.bracket;
            let order = order.clone();
            e.tags.insert(tag.clone(), id.clone());
            if let Some(legs) = plan {
                let mut p = BracketPlan {
                    entry: id.clone(),
                    tag: tag.clone(),
                    side: request.side,
                    reference: legs.reference,
                    tick: legs.tick,
                    stop: None,
                    target: None,
                    stop_ticks: legs.stop,
                    target_ticks: legs.target,
                };
                let exit_side = match request.side {
                    Side::Buy => Side::Sell,
                    Side::Sell => Side::Buy,
                };
                for (role, ticks) in [
                    (OrderRole::StopLoss, legs.stop),
                    (OrderRole::TakeProfit, legs.target),
                ] {
                    let Some(ticks) = ticks else { continue };
                    let leg_id = OrderId::new(format!(
                        "{id}-{}",
                        if role == OrderRole::StopLoss {
                            "sl"
                        } else {
                            "tp"
                        }
                    ));
                    let price = p.leg_price(role, ticks);
                    let leg = Order {
                        id: leg_id.clone(),
                        broker_order_id: None,
                        stop_rules: request
                            .bracket
                            .as_ref()
                            .and_then(StopRules::of)
                            .filter(|_| role == OrderRole::StopLoss),
                        ..blank(
                            OrderRequest {
                                side: exit_side,
                                order_type: if role == OrderRole::StopLoss {
                                    OrderType::Stop
                                } else {
                                    OrderType::Limit
                                },
                                limit_price: (role == OrderRole::TakeProfit).then_some(price),
                                stop_price: (role == OrderRole::StopLoss).then_some(price),
                                bracket: None,
                                client_order_id: None,
                                reduce_only: true,
                                ..request.clone()
                            },
                            role,
                            Some(id.clone()),
                            OrderStatus::Held,
                        )
                    };
                    if role == OrderRole::StopLoss {
                        p.stop = Some(leg_id.clone());
                    } else {
                        p.target = Some(leg_id.clone());
                    }
                    if let std::collections::hash_map::Entry::Vacant(slot) = e.orders.entry(leg_id)
                    {
                        slot.insert(leg.clone());
                        out.push(BrokerEvent::Order(leg));
                    }
                }
                e.brackets.insert(basket.clone(), p);
            }
            e.sending.remove(&tag);
            e.replay_early(&pid, now, out);
            let order = e.orders.get(&id).cloned().unwrap_or(order);
            out.insert(0, BrokerEvent::Order(order.clone()));
            Ok(order)
        })
    }

    async fn modify(
        &self,
        _verified: &Verified,
        order: &OrderId,
        changes: OrderChanges,
    ) -> Result<Order, BrokerError> {
        let mut o = self.known_order(order)?;
        let account = o.request.account_id.clone();
        if self.held_leg(&o).is_some() && self.entry_filled(&o) {
            self.take_in_placed_legs(&account);
            o = self.known_order(order)?;
        }
        // Rithmic counts a bracket leg's ticks from the entry's fill once it has filled.
        if let Some((entry_basket, plan)) = self.held_leg(&o) {
            if changes.qty.is_some_and(|q| q != o.request.qty) {
                return Err(BrokerError::Unsupported(
                    "A bracket's leg takes the entry's size; change the entry instead.".into(),
                ));
            }
            let (template, price) = match o.role {
                OrderRole::StopLoss => (BRACKET_STOP, changes.stop_price),
                _ => (BRACKET_TARGET, changes.limit_price),
            };
            let Some(price) = price else {
                return Ok(o);
            };
            self.precheck(template, &account)?;
            let fill = self.entry_fill(&o);
            let from = fill.unwrap_or(plan.reference);
            let ticks = orders::ticks_for(plan.side, o.role, from, price.0, plan.tick).map_err(
                |e| match fill {
                    Some(f) => BrokerError::Unavailable(format!(
                        "Rithmic has not reported this {}'s own order yet; until it does it moves \
                         only on its side of the fill at {}. Try again in a moment.",
                        if o.role == OrderRole::StopLoss {
                            "stop"
                        } else {
                            "target"
                        },
                        f.normalize()
                    )),
                    None => e,
                },
            )?;
            let level = plan.ticks(o.role).unwrap_or(ticks);
            self.adjust_leg(&account, o.role, &entry_basket, ticks, level)
                .await?;
            if let Some(e) = self.inner.state.write().by_id_mut(&account)
                && let Some(p) = e.brackets.get_mut(&entry_basket)
            {
                p.set_ticks(o.role, ticks);
            }
            let mut moved = o.clone();
            let at = plan.leg_price_from(o.role, ticks, from);
            if o.role == OrderRole::StopLoss {
                moved.request.stop_price = Some(at);
            } else {
                moved.request.limit_price = Some(at);
            }
            moved.updated_at = Timestamp::now();
            self.put_order(moved.clone());
            return Ok(moved);
        }
        self.precheck(MODIFY, &account)?;
        let basket = o
            .broker_order_id
            .clone()
            .ok_or_else(|| BrokerError::NotFound(format!("order {order}")))?;
        let (symbol, exchange) = orders::contract(&o.request.instrument)?;
        let qty = changes.qty.unwrap_or(o.request.qty);
        let limit = changes.limit_price.or(o.request.limit_price);
        let stop = changes.stop_price.or(o.request.stop_price);
        let mut m = RithmicModifyOrder::new()
            .id(basket)
            .symbol(symbol)
            .exchange(exchange)
            .quantity(orders::whole_qty(qty)?)
            .price_type(orders::rithmic_type(o.request.order_type));
        if let Some(p) = limit {
            m = m.price(p.to_f64());
        }
        if let Some(p) = stop {
            m = m.trigger_price(p.to_f64());
        }
        let m = m
            .build()
            .map_err(|e| BrokerError::Rejected(orders::plain(&e)))?;
        self.send_change(&account, OrderEntry::Modify(Box::new(m)))
            .await?;
        let sent = self.inner.change_account(&account, |e, out| {
            let cur = e.orders.get_mut(order)?;
            if !cur.status.is_open() {
                return Some(cur.clone());
            }
            cur.request.qty = qty;
            cur.request.limit_price = limit;
            cur.request.stop_price = stop;
            cur.updated_at = Timestamp::now();
            out.push(BrokerEvent::Order(cur.clone()));
            Some(cur.clone())
        });
        Ok(sent.flatten().unwrap_or(o))
    }

    async fn cancel(&self, _verified: &Verified, order: &OrderId) -> Result<Order, BrokerError> {
        let mut o = self.known_order(order)?;
        let account = o.request.account_id.clone();
        if !o.status.is_open() {
            return Ok(o);
        }
        if self.held_leg(&o).is_some() && self.entry_filled(&o) {
            self.take_in_placed_legs(&account);
            o = self.known_order(order)?;
            if self.held_leg(&o).is_some() {
                return Err(BrokerError::Unavailable(
                    "Rithmic has not reported this leg's own order yet; cancel it again in a \
                     moment."
                        .into(),
                ));
            }
        }
        if self.held_leg(&o).is_some() {
            let entry_open = o
                .parent_id
                .as_ref()
                .and_then(|p| self.order_of(p))
                .is_some_and(|e| e.status.is_open() && e.status != OrderStatus::PendingCancel);
            if entry_open {
                return Err(BrokerError::Unsupported(
                    "Rithmic holds the stop and target with the entry: cancel the entry to cancel \
                     its bracket, or move the leg."
                        .into(),
                ));
            }
            o.status = OrderStatus::Cancelled;
            o.reason = Some("Its entry was cancelled.".into());
            o.updated_at = Timestamp::now();
            self.put_order(o.clone());
            return Ok(o);
        }
        self.precheck(CANCEL, &account)?;
        let basket = o
            .broker_order_id
            .clone()
            .ok_or_else(|| BrokerError::NotFound(format!("order {order}")))?;
        let c = RithmicCancelOrder::new()
            .id(basket)
            .build()
            .map_err(|e| BrokerError::Rejected(orders::plain(&e)))?;
        self.send_change(&account, OrderEntry::Cancel(c)).await?;
        let pending = self.inner.change(|state, out| {
            let cur = state
                .by_id_mut(&account)
                .and_then(|e| e.orders.get_mut(order))?;
            if cur.status.is_open() && cur.status != OrderStatus::PendingCancel {
                cur.status = OrderStatus::PendingCancel;
                cur.updated_at = Timestamp::now();
                out.push(BrokerEvent::Order(cur.clone()));
            }
            Some(cur.clone())
        });
        match pending {
            Some(now) => Ok(now),
            None => {
                o.status = OrderStatus::PendingCancel;
                o.updated_at = Timestamp::now();
                Ok(o)
            }
        }
    }

    async fn attach_bracket(
        &self,
        _verified: &Verified,
        entry_id: &OrderId,
        bracket: Bracket,
        qty: Qty,
    ) -> Result<Vec<Order>, BrokerError> {
        let entry = self.known_order(entry_id)?;
        let account = entry.request.account_id.clone();
        if entry.role != OrderRole::Entry || entry.filled_qty.is_zero() {
            return Err(BrokerError::Rejected(
                "Legs are attached to an entry that has filled.".into(),
            ));
        }
        let tag = format!("{entry_id}-legs");
        let (tick, _) = self.tick_and_last(&entry.request.instrument, entry.request.side);
        let bracket = match (entry.avg_fill_price, tick) {
            (Some(fill), Some(tick)) => bracket.priced_from(entry.request.side, fill, tick),
            _ => bracket,
        };
        let (sent, legs) = orders::attach_for(&entry, &bracket, qty, &tag)?;
        let oco = matches!(sent, OrderEntry::Oco(_));
        self.precheck(if oco { OCO } else { NEW_ORDER }, &account)?;
        let pid = self.provider_id().to_owned();
        {
            let mut state = self.inner.state.write();
            let e = state
                .by_id_mut(&account)
                .ok_or_else(|| BrokerError::NotFound(format!("account {account}")))?;
            let placed = e.placed_under(&tag);
            if !placed.is_empty() {
                return Ok(placed);
            }
            if e.doubted(&tag, Timestamp::now()) {
                return Err(BrokerError::Unavailable(orders::in_doubt_words(
                    "The add's stop and target",
                )));
            }
            if !e.sending.insert(tag.clone()) {
                return Err(BrokerError::Rejected(
                    "These legs are being sent already.".into(),
                ));
            }
        }
        let settle = |inner: &Inner, register: &dyn Fn(&mut Entry, Timestamp) -> Vec<Order>| {
            let now = Timestamp::now();
            inner
                .change_account(&account, |e, out| {
                    let placed = register(e, now);
                    out.extend(placed.iter().cloned().map(BrokerEvent::Order));
                    e.sending.remove(&tag);
                    e.replay_early(&pid, now, out);
                    placed
                })
                .unwrap_or_default()
        };
        let frames = match self.send(&account, sent).await {
            Ok(frames) => frames,
            Err(SendFail::NotSent(e)) => {
                settle(&self.inner, &|_, _| Vec::new());
                return Err(e);
            }
            Err(SendFail::Unknown(why)) => {
                warn!(provider = %pid, %why, "rithmic legs not confirmed; not sent again");
                let sentence = "The add's stop and target";
                settle(&self.inner, &|e, now| {
                    e.in_doubt.push(InDoubt {
                        tag: tag.clone(),
                        sentence: sentence.into(),
                        at: now,
                    });
                    Vec::new()
                });
                return Err(BrokerError::Unavailable(orders::in_doubt_words(sentence)));
            }
        };
        if let Some(e) = rejected(&frames) {
            settle(&self.inner, &|_, _| Vec::new());
            return Err(BrokerError::Rejected(
                self.inner.session.login.redact(&orders::plain(e)),
            ));
        }
        let baskets: Vec<String> = frames
            .iter()
            .find_map(|f| match &f.message {
                RithmicMessage::ResponseOcoOrder(r) if !r.basket_id.is_empty() => {
                    Some(r.basket_id.clone())
                }
                RithmicMessage::ResponseNewOrder(r) => r.basket_id.clone().map(|b| vec![b]),
                _ => None,
            })
            .unwrap_or_default();
        if baskets.len() != legs.len() {
            settle(&self.inner, &|_, _| Vec::new());
            return Err(BrokerError::Unavailable(
                "Rithmic took the stop and target but sent no order ids; they show here once \
                 Rithmic reports them."
                    .into(),
            ));
        }
        let rules = StopRules::of(&bracket).map(|r| StopRules {
            entry_price: entry.avg_fill_price,
            ..r
        });
        let placed = settle(&self.inner, &|e, now| {
            let environment = e.account.environment;
            legs.iter()
                .zip(&baskets)
                .map(|((role, request), basket)| {
                    let id = e.order_id(&pid, basket);
                    let o = e.orders.entry(id.clone()).or_insert_with(|| Order {
                        id: id.clone(),
                        broker_order_id: Some(basket.clone()),
                        draft_id: None,
                        request: request.clone(),
                        role: *role,
                        parent_id: Some(entry_id.clone()),
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
                    });
                    o.role = *role;
                    o.parent_id = Some(entry_id.clone());
                    o.request.reduce_only = true;
                    o.request.client_order_id = None;
                    if *role == OrderRole::StopLoss {
                        o.stop_rules = rules;
                    }
                    o.clone()
                })
                .collect()
        });
        Ok(placed)
    }

    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        BroadcastStream::new(self.inner.events.subscribe())
            .filter_map(|e| async move { e.ok() })
            .boxed()
    }
}

#[cfg(test)]
mod tests;
