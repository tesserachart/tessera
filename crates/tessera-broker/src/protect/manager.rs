//! A connection may report a fill before the position it makes: Rithmic's order plant and PnL
//! plant are two connections.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::StreamExt;
use parking_lot::{Mutex, RwLock};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_core::hash::hash_json;
use tessera_core::ids::{AccountId, CallId, OrderId};
use tessera_core::orders::{
    Bracket, CheckSeverity, Order, OrderRequest, OrderRole, OrderStatus, OrderType, Position, Side,
    TimeInForce,
};
use tessera_core::{InstrumentId, Origin, Price, Qty, SharedClock};
use tessera_protocol::tools::{RiskTier, ToolCallRecord, ToolCallStatus, ToolErrorInfo};
use tessera_protocol::topics::ProtectionNote;
use tessera_tools::ToolObserver;
use tokio::sync::{Notify, broadcast};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::breakeven::{self, BreakevenAsk, BreakevenPlan};
use super::plan::{self, Intent, Memory, Plan, ProtectionMode, Reading, State, Step, Why};
use super::rules::RuleBook;
use crate::orders::{Broker, legs_words};
use crate::paper::engine::qty_label;
use crate::{BrokerError, BrokerEvent, OrderChanges};

pub const PROTECT_TOOL: &str = "orders.protect";

const DEBOUNCE: Duration = Duration::from_millis(60);
pub const STALE_AFTER: Duration = Duration::from_millis(1500);
pub const IN_FLIGHT: Duration = Duration::from_secs(5);
pub const BACK_OFF: Duration = Duration::from_secs(15);
pub const EXIT_LAG: Duration = Duration::from_secs(10);
const RETRY: Duration = Duration::from_millis(400);

pub(super) type Key = (AccountId, InstrumentId);

#[derive(Debug, Default)]
struct Watch {
    dirty: bool,
    last_event: Option<Instant>,
    fill_seen: Option<Instant>,
    position_seen: Option<Instant>,
    retry_at: Option<Instant>,
    evened: Option<Instant>,
    qty: Option<Decimal>,
    exits_ahead: Decimal,
    exit_seen: Option<Instant>,
}

impl Watch {
    fn exited(&mut self, qty: Decimal, now: Instant) {
        if !qty.is_zero() {
            self.exits_ahead += qty;
            self.exit_seen = Some(now);
        }
    }

    fn position_is(&mut self, qty: Decimal) {
        if let Some(was) = self.qty {
            let crossed = was * qty < Decimal::ZERO;
            let shrank = if crossed {
                was.abs()
            } else {
                (was.abs() - qty.abs()).max(Decimal::ZERO)
            };
            self.exits_ahead = (self.exits_ahead - shrank).max(Decimal::ZERO);
        }
        self.qty = Some(qty);
    }

    fn reading(&self, now: Instant) -> Reading {
        let counted = self.exit_seen.is_none_or(|at| now - at >= EXIT_LAG);
        if self.exits_ahead.is_zero() || counted {
            Reading::Current
        } else {
            Reading::ExitsAhead(self.exits_ahead)
        }
    }
}

#[derive(Debug, Default)]
struct Inner {
    watch: HashMap<Key, Watch>,
    memory: HashMap<Key, Memory>,
    intents: HashMap<Key, Vec<Intent>>,
    recent: HashMap<OrderId, (Step, Instant, Sent)>,
    filled: HashMap<OrderId, Qty>,
}

impl Inner {
    fn newly_filled(&mut self, o: &Order) -> Decimal {
        let before = self.filled.get(&o.id).copied().unwrap_or(Qty::ZERO);
        if o.status.is_terminal() {
            self.filled.remove(&o.id);
        } else {
            self.seen_filled(o);
        }
        (o.filled_qty.0 - before.0).max(Decimal::ZERO)
    }

    fn seen_filled(&mut self, o: &Order) {
        let seen = self.filled.entry(o.id.clone()).or_insert(Qty::ZERO);
        *seen = (*seen).max(o.filled_qty);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Read {
    Cached,
    Fresh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sent {
    InFlight,
    Refused,
}

impl Sent {
    fn ttl(self) -> Duration {
        match self {
            Sent::InFlight => IN_FLIGHT,
            Sent::Refused => BACK_OFF,
        }
    }
}

fn exits(o: &Order) -> bool {
    matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit) || o.request.reduce_only
}

#[derive(Clone, Debug, PartialEq)]
pub struct Shaped {
    pub send: OrderRequest,
    pub check: OrderRequest,
    pub intent: Option<Bracket>,
}

impl Shaped {
    pub fn keep(req: &OrderRequest) -> Self {
        Self {
            send: req.clone(),
            check: req.clone(),
            intent: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub text: String,
    pub ok: bool,
    pub call_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Breakeven {
    pub plan: BreakevenPlan,
    pub position: Position,
    pub stops: Vec<Order>,
    pub placed: Option<Order>,
}

pub struct ProtectionManager {
    broker: Arc<Broker>,
    clock: SharedClock,
    mode: RwLock<ProtectionMode>,
    inner: Mutex<Inner>,
    audit: RwLock<Option<Arc<dyn ToolObserver>>>,
    notes: broadcast::Sender<ProtectionNote>,
    first_listener: Mutex<Option<broadcast::Receiver<ProtectionNote>>>,
    wake: Notify,
    running: tokio::sync::Mutex<()>,
    rules: Mutex<RuleBook>,
    rule_store: std::sync::OnceLock<tessera_store::Store>,
}

impl std::fmt::Debug for ProtectionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtectionManager")
            .field("mode", &self.mode())
            .finish_non_exhaustive()
    }
}

impl ProtectionManager {
    pub fn new(broker: Arc<Broker>, clock: SharedClock) -> Arc<Self> {
        let (notes, first_listener) = broadcast::channel(256);
        Arc::new(Self {
            broker,
            clock,
            mode: RwLock::new(ProtectionMode::default()),
            inner: Mutex::new(Inner::default()),
            audit: RwLock::new(None),
            notes,
            first_listener: Mutex::new(Some(first_listener)),
            wake: Notify::new(),
            running: tokio::sync::Mutex::new(()),
            rules: Mutex::new(RuleBook::default()),
            rule_store: std::sync::OnceLock::new(),
        })
    }

    pub(super) fn broker(&self) -> &Arc<Broker> {
        &self.broker
    }

    pub(super) fn clock(&self) -> &SharedClock {
        &self.clock
    }

    pub(super) fn rule_book(&self) -> &Mutex<RuleBook> {
        &self.rules
    }

    pub(super) fn rule_store(&self) -> &std::sync::OnceLock<tessera_store::Store> {
        &self.rule_store
    }

    pub fn mode(&self) -> ProtectionMode {
        *self.mode.read()
    }

    pub fn set_mode(&self, mode: ProtectionMode) {
        let changed = {
            let mut m = self.mode.write();
            let changed = *m != mode;
            *m = mode;
            changed
        };
        if changed {
            let mut inner = self.inner.lock();
            inner.memory.clear();
            for w in inner.watch.values_mut() {
                w.dirty = true;
            }
            drop(inner);
            self.wake.notify_one();
        }
    }

    pub fn set_audit(&self, observer: Arc<dyn ToolObserver>) {
        *self.audit.write() = Some(observer);
    }

    pub fn audit(&self) -> Option<Arc<dyn ToolObserver>> {
        self.audit.read().clone()
    }

    pub fn notes(&self) -> broadcast::Receiver<ProtectionNote> {
        self.first_listener
            .lock()
            .take()
            .unwrap_or_else(|| self.notes.subscribe())
    }

    pub fn intents(&self, account: &AccountId, instrument: &InstrumentId) -> Vec<Intent> {
        self.inner
            .lock()
            .intents
            .get(&(account.clone(), instrument.clone()))
            .cloned()
            .unwrap_or_default()
    }

    pub fn memory(&self, account: &AccountId, instrument: &InstrumentId) -> Memory {
        self.inner
            .lock()
            .memory
            .get(&(account.clone(), instrument.clone()))
            .cloned()
            .unwrap_or_default()
    }

    pub async fn shape(&self, req: &OrderRequest) -> Shaped {
        let keep = Shaped::keep(req);
        if self.mode() != ProtectionMode::Grow || req.reduce_only {
            return keep;
        }
        let legs = req.bracket.filter(|b| !b.is_empty());
        let Ok((position, orders)) = self.read(&req.account_id, &req.instrument).await else {
            return keep;
        };
        let side = if position > Decimal::ZERO {
            Side::Buy
        } else {
            Side::Sell
        };
        if position.is_zero() || side != req.side || !plan::protected(&orders, position) {
            return keep;
        }
        let at = plan::protection_prices(&orders, position);
        if let Some(entry) = req.entry_price() {
            let long = side == Side::Buy;
            let stop_ok = at
                .stop_loss
                .is_none_or(|s| if long { s < entry } else { s > entry });
            let target_ok = at
                .take_profit
                .is_none_or(|t| if long { t > entry } else { t < entry });
            if !(stop_ok && target_ok) {
                return keep;
            }
        }
        let mut check = req.clone();
        check.bracket = (at.stop_loss.is_some() || at.take_profit.is_some()).then_some(at);
        Shaped {
            send: req.without_bracket(),
            check,
            intent: legs,
        }
    }

    pub fn remember(&self, order: &Order, bracket: Bracket) {
        let key = (
            order.request.account_id.clone(),
            order.request.instrument.clone(),
        );
        let mut inner = self.inner.lock();
        let list = inner.intents.entry(key.clone()).or_default();
        list.retain(|i| i.entry != order.id);
        list.push(Intent {
            entry: order.id.clone(),
            bracket,
        });
        inner.watch.entry(key).or_default().dirty = true;
        drop(inner);
        self.wake.notify_one();
    }

    pub fn start(self: &Arc<Self>) -> Vec<JoinHandle<()>> {
        let mut events = self.broker.provider().events();
        let (marked, on_marked) = tokio::sync::oneshot::channel();
        let me = Arc::downgrade(self);
        let watch = tokio::spawn(async move {
            if let Some(m) = me.upgrade() {
                m.mark_positions().await;
            }
            let _ = marked.send(());
            while let Some(e) = events.next().await {
                let Some(m) = me.upgrade() else { return };
                m.observe(&e);
                if matches!(e, BrokerEvent::Disconnected { .. }) {
                    m.mark_positions().await;
                }
            }
        });
        let me = Arc::downgrade(self);
        let work = tokio::spawn(async move {
            if on_marked.await.is_err() {
                return;
            }
            loop {
                let Some(m) = me.upgrade() else { return };
                let wake = tokio::time::sleep(Duration::from_millis(50));
                tokio::select! {
                    () = m.wake.notified() => {}
                    () = wake => {}
                }
                m.run_due().await;
            }
        });
        vec![watch, work]
    }

    async fn mark_positions(&self) {
        let provider = self.broker.provider();
        let Ok(accounts) = provider.accounts().await else {
            return;
        };
        let now = Instant::now();
        for a in accounts {
            let Ok(positions) = provider.positions(&a.id).await else {
                continue;
            };
            let orders = provider.orders(&a.id).await.unwrap_or_else(|e| {
                tracing::warn!(account = %a.id, error = %e, "position protection: orders not read");
                Vec::new()
            });
            {
                let mut book = self.rules.lock();
                for o in &orders {
                    book.track(o);
                }
            }
            let mut inner = self.inner.lock();
            for p in positions.iter().filter(|p| !p.qty.is_zero()) {
                let w = inner
                    .watch
                    .entry((p.account_id.clone(), p.instrument.clone()))
                    .or_default();
                w.dirty = true;
                w.position_seen = Some(now);
                w.position_is(p.qty.0);
            }
            for o in orders.iter().filter(|o| o.status.is_open()) {
                inner.seen_filled(o);
                inner
                    .watch
                    .entry((o.request.account_id.clone(), o.request.instrument.clone()))
                    .or_default()
                    .dirty = true;
            }
        }
        self.wake.notify_one();
    }

    pub fn observe(&self, e: &BrokerEvent) {
        if let BrokerEvent::Order(o) = e {
            self.rules.lock().track(o);
        }
        let now = Instant::now();
        let mut inner = self.inner.lock();
        let (key, fill, exited, position) = match e {
            BrokerEvent::Order(o) => {
                let more = inner.newly_filled(o);
                (
                    (o.request.account_id.clone(), o.request.instrument.clone()),
                    !more.is_zero(),
                    if exits(o) { more } else { Decimal::ZERO },
                    None,
                )
            }
            BrokerEvent::Fill(f) => (
                (f.account_id.clone(), f.instrument.clone()),
                true,
                Decimal::ZERO,
                None,
            ),
            BrokerEvent::Position(p) => (
                (p.account_id.clone(), p.instrument.clone()),
                false,
                Decimal::ZERO,
                Some(p.qty.0),
            ),
            BrokerEvent::Disconnected { .. } | BrokerEvent::Account(_) => return,
        };
        let w = inner.watch.entry(key).or_default();
        w.dirty = true;
        w.last_event = Some(now);
        if fill {
            w.fill_seen = Some(now);
        }
        w.exited(exited, now);
        if let Some(qty) = position {
            w.position_seen = Some(now);
            w.position_is(qty);
        }
        drop(inner);
        self.wake.notify_one();
    }

    fn due(&self) -> Vec<(Key, Reading, Read)> {
        let now = Instant::now();
        let mut inner = self.inner.lock();
        let mut out = Vec::new();
        for (key, w) in &mut inner.watch {
            if w.retry_at.is_some_and(|t| t <= now) {
                w.retry_at = None;
                w.dirty = true;
            }
            if !w.dirty || w.last_event.is_some_and(|t| now - t < DEBOUNCE) {
                continue;
            }
            let stale = match (w.fill_seen, w.position_seen) {
                (Some(f), Some(p)) => f > p,
                (Some(_), None) => true,
                _ => false,
            };
            if stale && w.fill_seen.is_some_and(|f| now - f < STALE_AFTER) {
                if w.evened != w.last_event {
                    w.evened = w.last_event;
                    out.push((key.clone(), Reading::FillsAhead, Read::Cached));
                }
                continue;
            }
            w.dirty = false;
            let reading = w.reading(now);
            if let Reading::ExitsAhead(_) = reading {
                w.retry_at = w.exit_seen.map(|at| at + EXIT_LAG);
            }
            let read = if stale { Read::Fresh } else { Read::Cached };
            out.push((key.clone(), reading, read));
        }
        out
    }

    pub async fn run_due(&self) {
        for ((account, instrument), reading, read) in self.due() {
            let planned = match read {
                Read::Cached => self.plan_now(&account, &instrument, reading).await,
                Read::Fresh => self.plan_fresh(&account, &instrument, reading).await,
            };
            if let Err(e) = planned {
                tracing::debug!(error = %e, "position protection: not planned");
            }
        }
        self.save_rules().await;
    }

    async fn read(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
    ) -> Result<(Decimal, Vec<Order>), BrokerError> {
        let provider = self.broker.provider();
        let position = provider
            .positions(account)
            .await?
            .into_iter()
            .find(|p| &p.instrument == instrument)
            .map_or(Decimal::ZERO, |p| p.qty.0);
        let mut orders: Vec<Order> = provider
            .orders(account)
            .await?
            .into_iter()
            .filter(|o| &o.request.instrument == instrument)
            .collect();
        let missing: Vec<OrderId> = orders
            .iter()
            .filter_map(|o| o.parent_id.clone())
            .filter(|p| !orders.iter().any(|o| &o.id == p))
            .collect();
        for id in missing {
            if let Some(o) = provider.order_of(&id) {
                orders.push(o);
            }
        }
        Ok((position, orders))
    }

    async fn acts_on(&self, account: &AccountId) -> bool {
        match self.broker.provider().connection_of(account).await {
            Ok(c) => !c.capabilities.read_only,
            Err(_) => false,
        }
    }

    async fn plan_fresh(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
        reading: Reading,
    ) -> Result<Option<Outcome>, BrokerError> {
        let key = (account.clone(), instrument.clone());
        let fresh = self
            .broker
            .provider()
            .fresh_position(account, instrument)
            .await;
        let qty = {
            let mut inner = self.inner.lock();
            let w = inner.watch.entry(key).or_default();
            match fresh {
                Ok(qty) => {
                    w.position_seen = Some(Instant::now());
                    w.position_is(qty.0);
                    qty.0
                }
                Err(e) => {
                    w.dirty = true;
                    w.retry_at = Some(Instant::now() + RETRY);
                    return Err(e);
                }
            }
        };
        self.plan_with(account, instrument, reading, Some(qty))
            .await
    }

    pub async fn plan_now(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
        reading: Reading,
    ) -> Result<Option<Outcome>, BrokerError> {
        self.plan_with(account, instrument, reading, None).await
    }

    async fn plan_with(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
        reading: Reading,
        fresh: Option<Decimal>,
    ) -> Result<Option<Outcome>, BrokerError> {
        let _one = self.running.lock().await;
        if !self.acts_on(account).await {
            return Ok(None);
        }
        let key = (account.clone(), instrument.clone());
        let (cached, orders) = self.read(account, instrument).await?;
        let position = fresh.unwrap_or(cached);
        let (intents, memory) = {
            let inner = self.inner.lock();
            (
                inner.intents.get(&key).cloned().unwrap_or_default(),
                inner.memory.get(&key).cloned().unwrap_or_default(),
            )
        };
        let changing = self.changing(&orders);
        let state = State {
            mode: self.mode(),
            position,
            reading,
            orders: &orders,
            changing: &changing,
            intents: &intents,
        };
        let p = plan::plan(&state, &memory);
        self.keep(&key, &p);
        let steps = self.fresh_steps(p.steps);
        if steps.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.carry_out(&key, steps, &orders, false).await))
    }

    pub async fn merge(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
    ) -> Result<Outcome, BrokerError> {
        let _one = self.running.lock().await;
        let key = (account.clone(), instrument.clone());
        let (position, orders) = self.read(account, instrument).await?;
        let changing = self.changing(&orders);
        let state = State {
            mode: self.mode(),
            position,
            reading: Reading::Current,
            orders: &orders,
            changing: &changing,
            intents: &[],
        };
        let p = plan::merge(&state);
        if p.waiting {
            return Err(BrokerError::Unavailable(
                "A stop or target is on its way to the broker; merge again in a moment.".into(),
            ));
        }
        if p.steps.is_empty() {
            return Err(BrokerError::Rejected(
                "Nothing to merge: the position has one stop and one target at most.".into(),
            ));
        }
        self.inner.lock().memory.insert(key.clone(), p.memory);
        Ok(self.carry_out(&key, p.steps, &orders, true).await)
    }

    pub async fn breakeven(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
        ask: &BreakevenAsk,
        act: bool,
    ) -> Result<Breakeven, BrokerError> {
        let _one = if act {
            Some(self.running.lock().await)
        } else {
            None
        };
        let provider = self.broker.provider();
        let position = provider
            .positions(account)
            .await?
            .into_iter()
            .find(|p| &p.instrument == instrument && !p.qty.is_zero());
        let orders: Vec<Order> = provider
            .orders(account)
            .await?
            .into_iter()
            .filter(|o| &o.request.instrument == instrument)
            .collect();
        let plan = breakeven::plan(position.as_ref(), &orders, ask)
            .map_err(|r| BrokerError::Rejected(r.words(instrument.symbol())))?;
        let position = position.expect("planned on a position");
        let before: Vec<Order> = plan
            .moves
            .iter()
            .filter_map(|m| orders.iter().find(|o| o.id == m.order).cloned())
            .collect();
        if !act {
            return Ok(Breakeven {
                plan,
                position,
                stops: before,
                placed: None,
            });
        }
        if let Some(qty) = plan.new_stop {
            let stop = breakeven_stop(account, instrument, &plan, qty);
            let placed = self.place_stop(stop).await?;
            tracing::info!("breakeven stop placed");
            return Ok(Breakeven {
                plan,
                position,
                stops: Vec::new(),
                placed: Some(placed),
            });
        }
        let b = &self.broker;
        let mut moved: Vec<Order> = Vec::with_capacity(plan.moves.len());
        for m in &plan.moves {
            let changes = OrderChanges {
                stop_price: Some(m.to),
                limit_price: m.limit,
                ..OrderChanges::default()
            };
            let r = b.modify(account, &m.order, changes).await;
            match r {
                Ok(o) => moved.push(o),
                Err(e) if moved.is_empty() => return Err(e),
                Err(e) => {
                    let why = match e {
                        BrokerError::Rejected(w)
                        | BrokerError::Unavailable(w)
                        | BrokerError::Unsupported(w) => w.trim_end_matches('.').to_owned(),
                        other => other.to_string(),
                    };
                    return Err(BrokerError::Rejected(format!(
                        "Moved {} of {} stops to breakeven, {}; the others stay: {why}.",
                        moved.len(),
                        plan.moves.len(),
                        price_words(plan.price)
                    )));
                }
            }
        }
        tracing::info!(stops = moved.len(), "breakeven");
        Ok(Breakeven {
            plan,
            position,
            stops: moved,
            placed: None,
        })
    }

    async fn place_stop(&self, stop: OrderRequest) -> Result<Order, BrokerError> {
        let b = &self.broker;
        let preview = b.provider().preview(&stop).await?;
        if let Some(block) = preview
            .checks
            .iter()
            .find(|c| c.severity == CheckSeverity::Block)
        {
            return Err(BrokerError::Rejected(format!(
                "{} No stop sent.",
                block.message.trim_end()
            )));
        }
        let order = b.submit(stop, None).await?;
        if order.status == OrderStatus::Rejected {
            return Err(BrokerError::Rejected(
                order
                    .reason
                    .unwrap_or_else(|| "Rejected by the broker.".into()),
            ));
        }
        Ok(order)
    }

    fn keep(&self, key: &Key, p: &Plan) {
        let mut inner = self.inner.lock();
        inner.memory.insert(key.clone(), p.memory.clone());
        if let Some(list) = inner.intents.get_mut(key) {
            list.retain(|i| !p.done.contains(&i.entry));
        }
        if p.waiting {
            inner.watch.entry(key.clone()).or_default().retry_at = Some(Instant::now() + RETRY);
        }
    }

    fn fresh_steps(&self, steps: Vec<Step>) -> Vec<Step> {
        let now = Instant::now();
        let mut inner = self.inner.lock();
        inner
            .recent
            .retain(|_, (_, at, sent)| now - *at < sent.ttl());
        steps
            .into_iter()
            .filter(|s| {
                inner
                    .recent
                    .get(s.order())
                    .is_none_or(|(was, _, _)| was != s)
            })
            .collect()
    }

    fn note_recent(&self, step: &Step, sent: Sent) {
        self.inner
            .lock()
            .recent
            .insert(step.order().clone(), (step.clone(), Instant::now(), sent));
    }

    fn changing(&self, orders: &[Order]) -> Vec<OrderId> {
        let now = Instant::now();
        self.inner
            .lock()
            .recent
            .iter()
            .filter(|(_, (_, at, sent))| *sent == Sent::InFlight && now - *at < IN_FLIGHT)
            .filter(|(id, (step, _, _))| {
                orders
                    .iter()
                    .find(|o| &o.id == *id)
                    .is_some_and(|o| !step.shown_by(o))
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    async fn carry_out(
        &self,
        key: &Key,
        steps: Vec<Step>,
        orders: &[Order],
        merged: bool,
    ) -> Outcome {
        let (account, instrument) = key;
        let started = self.clock.now();
        let timer = Instant::now();
        let mut done: Vec<Step> = Vec::new();
        let mut failed: Option<(Step, BrokerError)> = None;
        for step in steps {
            match self.take(account, &step).await {
                Ok(Took::Sent) => {
                    self.note_recent(&step, Sent::InFlight);
                    done.push(step);
                }
                Ok(Took::Already) => done.push(step),
                Ok(Took::Gone) => {}
                Err(e) => {
                    self.note_recent(&step, Sent::Refused);
                    failed = Some((step, e));
                    break;
                }
            }
        }
        let text = words(&done, failed.as_ref(), orders, merged);
        let ok = failed.is_none();
        let call_id = CallId::generate();
        if done.is_empty() && failed.is_none() {
            return Outcome {
                text,
                ok,
                call_id: call_id.to_string(),
            };
        }
        let input = json!({
            "accountId": account,
            "instrument": instrument,
            "mode": self.mode().as_str(),
            "merge": merged,
            "orders": done.iter().map(|s| s.order().to_string()).collect::<Vec<_>>(),
            "entries": done
                .iter()
                .filter_map(|s| match s {
                    Step::Attach { entry, .. } => Some(entry.to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            "steps": done.iter().map(step_json).collect::<Vec<_>>(),
        });
        let call_id = self.record(
            key,
            input,
            &text,
            failed.as_ref().map(|(_, e)| e),
            started,
            timer,
        );
        self.note(key, &text, ok, &call_id);
        tracing::info!(
            steps = done.len(),
            ok,
            mode = self.mode().as_str(),
            "position protection"
        );
        Outcome {
            text,
            ok,
            call_id: call_id.to_string(),
        }
    }

    pub(crate) fn tell(&self, key: &Key, input: Value, text: &str, failed: Option<&BrokerError>) {
        let call_id = self.record(key, input, text, failed, self.clock.now(), Instant::now());
        self.note(key, text, failed.is_none(), &call_id);
    }

    pub(super) fn record(
        &self,
        (_, instrument): &Key,
        input: Value,
        text: &str,
        failed: Option<&BrokerError>,
        started: tessera_core::Timestamp,
        timer: Instant,
    ) -> CallId {
        let call_id = CallId::generate();
        let record = ToolCallRecord {
            call_id: call_id.clone(),
            tool: PROTECT_TOOL.to_owned(),
            risk: RiskTier::Financial,
            origin: Origin::User,
            session_id: None,
            input_hash: hash_json(&input),
            input,
            status: if failed.is_none() {
                ToolCallStatus::Ok
            } else {
                ToolCallStatus::Error
            },
            started_at: started,
            finished_at: Some(self.clock.now()),
            duration_ms: Some(timer.elapsed().as_secs_f64() * 1000.0),
            error: failed.map(|e| ToolErrorInfo {
                code: tessera_protocol::tools::ToolErrorCode::Rejected,
                message: e.to_string(),
                retryable: false,
                details: None,
            }),
            approval_id: None,
            deduped: false,
            idempotency_key: None,
            summary: Some(format!("{}: {text}", instrument.symbol())),
            approved_by: None,
        };
        if let Some(a) = self.audit.read().clone() {
            a.call_finished(&record);
        }
        call_id
    }

    pub(super) fn note(&self, (account, instrument): &Key, text: &str, ok: bool, call_id: &CallId) {
        let _ = self.notes.send(ProtectionNote {
            account_id: account.to_string(),
            instrument: instrument.clone(),
            text: text.to_owned(),
            tone: if ok { "ok" } else { "err" }.into(),
            call_id: call_id.to_string(),
            ts: self.clock.now(),
        });
    }

    async fn take(&self, account: &AccountId, step: &Step) -> Result<Took, BrokerError> {
        let b = &self.broker;
        let now = b.provider().order_of(step.order());
        match step {
            Step::Cancel { order, .. } => {
                if now.as_ref().is_none_or(|o| !o.status.is_open()) {
                    return Ok(Took::Gone);
                }
                b.cancel(account, order).await?;
            }
            Step::Resize { order, qty, .. } => {
                match &now {
                    Some(o) if o.status.is_open() && o.request.qty != *qty => {}
                    Some(o) if o.status.is_open() => return Ok(Took::Already),
                    _ => return Ok(Took::Gone),
                }
                let changes = OrderChanges {
                    qty: Some(*qty),
                    ..OrderChanges::default()
                };
                b.modify(account, order, changes).await?;
            }
            Step::Move {
                order, role, to, ..
            } => {
                if now.as_ref().is_none_or(|o| !o.status.is_open()) {
                    return Ok(Took::Gone);
                }
                let changes = if *role == OrderRole::StopLoss {
                    OrderChanges {
                        stop_price: Some(*to),
                        ..OrderChanges::default()
                    }
                } else {
                    OrderChanges {
                        limit_price: Some(*to),
                        ..OrderChanges::default()
                    }
                };
                b.modify(account, order, changes).await?;
            }
            Step::Attach {
                entry,
                bracket,
                qty,
                ..
            } => {
                b.attach(account, entry, *bracket, *qty).await?;
            }
        }
        Ok(Took::Sent)
    }
}

fn breakeven_stop(
    account: &AccountId,
    instrument: &InstrumentId,
    plan: &BreakevenPlan,
    qty: Qty,
) -> OrderRequest {
    OrderRequest {
        account_id: account.clone(),
        instrument: instrument.clone(),
        side: plan.side.opposite(),
        qty,
        order_type: OrderType::Stop,
        limit_price: None,
        stop_price: Some(plan.price),
        tif: TimeInForce::Day,
        bracket: None,
        client_order_id: None,
        reduce_only: true,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Took {
    Sent,
    Already,
    Gone,
}

pub fn downgrade(m: &Arc<ProtectionManager>) -> Weak<ProtectionManager> {
    Arc::downgrade(m)
}

fn role_word(r: OrderRole) -> &'static str {
    if r == OrderRole::StopLoss {
        "stop"
    } else {
        "target"
    }
}

fn step_json(s: &Step) -> Value {
    match s {
        Step::Cancel { order, role, why } => json!({
            "action": "cancel", "orderId": order, "role": role, "why": why,
        }),
        Step::Resize {
            order,
            role,
            from,
            to,
            why,
            ..
        } => json!({
            "action": "resize", "orderId": order, "role": role, "from": from, "to": to, "why": why,
        }),
        Step::Move {
            order,
            role,
            from,
            to,
        } => json!({
            "action": "move", "orderId": order, "role": role, "from": from, "to": to,
        }),
        Step::Attach {
            entry,
            bracket,
            qty,
        } => json!({
            "action": "attach", "entryId": entry, "bracket": bracket, "qty": qty,
        }),
    }
}

pub fn error_words(e: &BrokerError) -> String {
    match e {
        BrokerError::Rejected(w) | BrokerError::Unavailable(w) | BrokerError::Unsupported(w) => {
            w.trim_end_matches('.').to_owned()
        }
        other => other.to_string(),
    }
}

pub fn price_words(p: Price) -> String {
    let s = p.0.normalize().to_string();
    let (int, frac) = s.split_once('.').unwrap_or((&s, ""));
    let (sign, digits) = int.strip_prefix('-').map_or(("", int), |d| ("-", d));
    let mut grouped = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let frac = format!("{frac:0<2}");
    format!("{sign}{grouped}.{frac}")
}

fn bare_legs(roles: &[OrderRole]) -> &'static str {
    let stop = roles.contains(&OrderRole::StopLoss);
    let target = roles.contains(&OrderRole::TakeProfit);
    match (stop, target) {
        (true, true) => "stop and target",
        (true, false) => "stop",
        _ => "target",
    }
}

fn legs_word(roles: &[OrderRole]) -> &'static str {
    let stop = roles.contains(&OrderRole::StopLoss);
    let target = roles.contains(&OrderRole::TakeProfit);
    match (stop, target) {
        (true, true) => "the stop and the target",
        (true, false) => "the stop",
        _ => "the target",
    }
}

pub fn words(
    done: &[Step],
    failed: Option<&(Step, BrokerError)>,
    orders: &[Order],
    merged: bool,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    let roles_of = |pred: &dyn Fn(&Step) -> bool| -> Vec<OrderRole> {
        done.iter()
            .filter(|s| pred(s))
            .filter_map(|s| match s {
                Step::Cancel { role, .. } | Step::Resize { role, .. } | Step::Move { role, .. } => {
                    Some(*role)
                }
                Step::Attach { .. } => None,
            })
            .collect()
    };
    if merged {
        let pairs = done
            .iter()
            .filter(|s| matches!(s, Step::Cancel { .. }))
            .filter_map(|s| {
                orders
                    .iter()
                    .find(|o| &o.id == s.order())
                    .and_then(|o| o.parent_id.clone())
            })
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        let size = done.iter().find_map(|s| match s {
            Step::Resize { to, .. } => Some(*to),
            _ => None,
        });
        let mut s = format!("Merged {} brackets into one", pairs + 1);
        if let Some(q) = size {
            s.push_str(&format!(" for {}", qty_label(q)));
        }
        parts.push(s);
    } else {
        let cancelled = |why: Why| {
            let r = roles_of(&|s| matches!(s, Step::Cancel { why: w, .. } if *w == why));
            (!r.is_empty()).then(|| legs_word(&r))
        };
        if let Some(w) = cancelled(Why::Flat) {
            parts.push(format!("Cancelled {w}: the position is flat"));
        }
        let reversed = roles_of(&|s| {
            matches!(
                s,
                Step::Cancel {
                    why: Why::Reversed,
                    ..
                }
            )
        });
        if !reversed.is_empty() {
            parts.push(format!(
                "Cancelled the old side's {}: the position reversed",
                bare_legs(&reversed)
            ));
        }
        if cancelled(Why::Joined).is_some() {
            parts.push(
                "The add joins the position's bracket (its own stop and target cancelled)".into(),
            );
        }
        let mut sizes: Vec<(Why, Qty, Vec<OrderRole>)> = Vec::new();
        for s in done {
            let (why, to, role) = match s {
                Step::Resize { why, to, role, .. } => (*why, *to, *role),
                Step::Cancel {
                    why: why @ (Why::Shrank | Why::Merged),
                    role,
                    ..
                } => (*why, Qty::ZERO, *role),
                _ => continue,
            };
            match sizes.iter_mut().find(|(w, q, _)| *w == why && *q == to) {
                Some((_, _, roles)) => roles.push(role),
                None => sizes.push((why, to, vec![role])),
            }
        }
        for (why, to, roles) in sizes {
            let w = legs_word(&roles);
            let cap = |s: &str| {
                let mut c = s.chars();
                c.next()
                    .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                    .unwrap_or_default()
            };
            parts.push(match why {
                Why::Grew => format!("Grew {w} to {}", qty_label(to)),
                Why::Oco => format!(
                    "{} to {} as its pair filled in part",
                    cap(&format!("shrank {w}")),
                    qty_label(to)
                ),
                _ if to.is_zero() => format!("Cancelled the newest entry's {}", bare_legs(&roles)),
                _ => format!("Shrank {w} to {}", qty_label(to)),
            });
        }
    }
    for s in done {
        if let Step::Attach { bracket, qty, .. } = s {
            let legs = legs_words(bracket, price_words);
            parts.push(format!(
                "The bracket was gone: attached the add's {legs} for {}",
                qty_label(*qty)
            ));
        }
    }
    if let Some((step, e)) = failed {
        let what = match step {
            Step::Cancel { role, .. } => format!("cancel the {}", role_word(*role)),
            Step::Resize { role, to, .. } => {
                format!("size the {} to {}", role_word(*role), qty_label(*to))
            }
            Step::Move { role, to, .. } => {
                format!("move the {} to {}", role_word(*role), price_words(*to))
            }
            Step::Attach { .. } => "attach the add's stop and target".into(),
        };
        parts.push(format!("Could not {what}: {}", error_words(e)));
    }
    parts.join(". ")
}

#[cfg(test)]
mod tests;
