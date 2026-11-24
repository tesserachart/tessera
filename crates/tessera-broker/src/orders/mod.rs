pub mod io;
pub mod throttle;
pub mod tools;

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use chrono_tz::Tz;
use parking_lot::{Mutex, RwLock};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tessera_core::accounts::{AccountSummary, Environment, RiskStatus, TradingAccount};
use tessera_core::health::{HealthStatus, ProviderHealth};
use tessera_core::ids::{AccountId, DraftId, OrderId};
use tessera_core::instrument::{ContractSpec, ExchangeContract, Instrument};
use tessera_core::limits::{LimitsSetting, LimitsStatus, LockKind};
use tessera_core::orders::{
    Bracket, CheckSeverity, Order, OrderPreview, OrderRequest, OrderRole, OrderStatus, OrderType,
    Position, PreTradeCheck, Side, TimeInForce,
};
use tessera_core::{InstrumentId, Price, Qty, SharedClock, Timestamp};
use tessera_market::{ConnectionRef, MarketDataProvider, MarketError, exchange_contract};
use tessera_protocol::topics::AccountUpdate;
use tessera_tools::ToolError;
use ts_rs::TS;

use self::io::{
    AccountScopeInput, BreakevenStopInput, BreakevenStopOutput, CancelAllInput, CancelAllOutput,
    CancelOrderInput, ContractForInput, ContractForOutput, FlattenOutput, MergeOutput,
    ModifyOrderInput, OrderInput, OrderOutput, ReverseInput, ReverseOutput, SubmitOutput,
};
use self::throttle::{ORDERS_PER_SECOND, PAUSE, Throttle};
use crate::copy::{CopyBook, CopyState};
use crate::limits::{self, AccountLock, DayFacts, OrderFacts};
use crate::lockout::AccountLocks;
use crate::paper::engine::{price_label, qty_label};
use crate::protect::{Breakeven, BreakevenAsk, ProtectionManager, ProtectionMode, Shaped, Touch};
use crate::{BrokerError, BrokerProvider, GuardedBroker, OrderChanges};

pub type Broker = GuardedBroker<dyn BrokerProvider>;

/// What an approval shows for an action that is not a new order (cancel, cancel all, flatten,
/// modify): the sentence, the account's environment and the orders and positions it touches.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActionPreview {
    /// The action as one sentence (`Flatten NQZ6 on Paper: cancel 2 orders, sell 1 at
    /// market`).
    pub restatement: String,
    /// The account.
    pub account_id: AccountId,
    /// Its environment, when known.
    pub environment: Option<Environment>,
    /// The orders it cancels or changes.
    pub orders: Vec<Order>,
    /// The positions it closes.
    pub positions: Vec<Position>,
    /// When the preview was computed.
    pub created_at: Timestamp,
}

pub fn broker_error(e: BrokerError) -> ToolError {
    match e {
        BrokerError::Refused(why) => ToolError::permission_denied(format!("{why}. Nothing sent.")),
        BrokerError::Rejected(why) => ToolError::rejected(why),
        BrokerError::Unsupported(why) => ToolError::unsupported(why),
        BrokerError::Unavailable(why) => ToolError::unavailable(why),
        BrokerError::NotFound(what) => ToolError::not_found(format!("{what} not found")),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Named {
    pub instrument: Instrument,
    pub spec: ContractSpec,
    pub wanted: ExchangeContract,
}

fn no_live_prices(down: &ProviderHealth) -> String {
    let name = &down.display_name;
    let lost = match (&down.connection, down.status, down.message.as_deref()) {
        (Some(phase), _, _) => format!("{name} {}", phase.without_prices()),
        (None, HealthStatus::Degraded, _) => format!("{name} dropped and is reconnecting"),
        (None, _, Some(m)) => format!("{name} has no live prices ({})", m.trim_end_matches('.')),
        (None, _, None) => format!("{name} has no live prices"),
    };
    format!(
        "{lost}. New market orders wait until its prices are back; Flat, closes and Reverse still \
         go. Nothing sent."
    )
}

pub fn naming(words: &str, mut e: ToolError) -> ToolError {
    if !words.is_empty() && !e.message.contains(words) {
        e.message = format!("{words}: {}", e.message);
    }
    e
}

pub struct OrdersService {
    broker: Arc<Broker>,
    market: Arc<dyn MarketDataProvider>,
    clock: SharedClock,
    resolved: RwLock<HashMap<(String, String), InstrumentId>>,
    limits: RwLock<LimitsSetting>,
    trades: Mutex<HashMap<AccountId, (Timestamp, u32)>>,
    protection: OnceLock<Arc<ProtectionManager>>,
    pub(crate) copying: CopyState,
    throttle: Throttle,
    locks: AccountLocks,
    zone: RwLock<Tz>,
}

impl std::fmt::Debug for OrdersService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrdersService")
            .field("broker", &self.broker)
            .finish_non_exhaustive()
    }
}

impl OrdersService {
    pub fn new(
        broker: Arc<Broker>,
        market: Arc<dyn MarketDataProvider>,
        clock: SharedClock,
    ) -> Self {
        Self {
            broker,
            market,
            clock,
            resolved: RwLock::new(HashMap::new()),
            limits: RwLock::new(LimitsSetting::default()),
            trades: Mutex::new(HashMap::new()),
            protection: OnceLock::new(),
            copying: CopyState::new(CopyBook::default()),
            throttle: Throttle::default(),
            locks: AccountLocks::default(),
            zone: RwLock::new(crate::paper::account::DAY_CALENDAR.tz()),
        }
    }

    fn admit(&self, account: &AccountId) -> Result<(), ToolError> {
        let now = self.clock.now();
        self.throttle
            .admit(account, now)
            .map_err(|until| paused_error(until, now))
    }

    fn not_paused(&self, account: &AccountId) -> Result<(), ToolError> {
        let now = self.clock.now();
        match self.throttle.paused(account, now) {
            Some(until) => Err(paused_error(until, now)),
            None => Ok(()),
        }
    }

    async fn adds(&self, req: &OrderRequest) -> bool {
        if req.reduce_only {
            return false;
        }
        let held = self
            .provider()
            .positions(&req.account_id)
            .await
            .ok()
            .and_then(|ps| ps.into_iter().find(|p| p.instrument == req.instrument))
            .map_or(Decimal::ZERO, |p| p.qty.0);
        !limits::opening_qty(held, req.side, req.qty.0, false).is_zero()
    }

    #[must_use]
    pub fn with_account_locks(mut self, locks: AccountLocks) -> Self {
        self.locks = locks;
        self
    }

    pub(crate) fn account_locks(&self) -> &AccountLocks {
        &self.locks
    }

    pub fn lock_of(&self, account: &AccountId) -> Option<AccountLock> {
        self.locks.active(account, self.clock.now())
    }

    pub fn set_display_zone(&self, zone: Tz) {
        *self.zone.write() = zone;
    }

    pub fn display_zone(&self) -> Tz {
        *self.zone.read()
    }

    #[must_use]
    pub fn with_copy_book(mut self, book: CopyBook) -> Self {
        self.copying = CopyState::new(book);
        self
    }

    pub fn set_protection(&self, manager: Arc<ProtectionManager>) {
        let _ = self.protection.set(manager);
    }

    pub fn protection(&self) -> Option<&Arc<ProtectionManager>> {
        self.protection.get()
    }

    async fn shape(&self, req: &OrderRequest) -> Shaped {
        match self.protection() {
            Some(p) => p.shape(req).await,
            None => Shaped::keep(req),
        }
    }

    pub fn set_limits(&self, setting: LimitsSetting) {
        *self.limits.write() = setting;
        self.trades.lock().clear();
    }

    pub fn limits(&self) -> LimitsSetting {
        self.limits.read().clone()
    }

    pub fn note_fill(&self, account: &AccountId) {
        self.trades.lock().remove(account);
    }

    async fn trades_today(&self, account: &AccountId, fresh: bool) -> Result<u32, BrokerError> {
        let since = self.day_start();
        if !fresh
            && let Some((day, n)) = self.trades.lock().get(account)
            && *day == since
        {
            return Ok(*n);
        }
        let fills = self.provider().fills(account, since).await?;
        let positions = self.provider().positions(account).await?;
        let n = limits::trades_today(&positions, &fills);
        self.trades.lock().insert(account.clone(), (since, n));
        Ok(n)
    }

    async fn day_facts(
        &self,
        account: &AccountId,
        summary: &AccountSummary,
        count_trades: bool,
        firm: Option<RiskStatus>,
    ) -> Result<DayFacts, BrokerError> {
        let trades_today = if count_trades {
            Some(self.trades_today(account, true).await?)
        } else {
            None
        };
        Ok(DayFacts {
            currency: summary.balance.currency,
            day_pnl: summary.day_pnl.amount,
            trades_today,
            firm,
            lock: self.lock_of(account),
            zone: self.display_zone(),
            now: self.clock.now(),
        })
    }

    pub async fn standing(
        &self,
        account: &TradingAccount,
        summary: &AccountSummary,
        firm: Option<&RiskStatus>,
    ) -> Option<LimitsStatus> {
        let setting = self.limits();
        let (held, own) = setting.of(&account.id);
        let firm = firm.filter(|_| setting.use_firm_limits).cloned();
        let lock = self.lock_of(&account.id);
        if held.is_off() && firm.is_none() && lock.is_none() {
            return None;
        }
        let trades_today = match held.trades_per_day() {
            Some(_) => self
                .trades_today(&account.id, false)
                .await
                .map_err(|e| tracing::debug!(account = %account.id, error = %e, "no trade count"))
                .ok(),
            None => None,
        };
        let day = DayFacts {
            currency: summary.balance.currency,
            day_pnl: summary.day_pnl.amount,
            trades_today,
            firm,
            lock,
            zone: self.display_zone(),
            now: self.clock.now(),
        };
        limits::standing(&account.id, held, own, &day, self.clock.now())
    }

    async fn multipliers(
        &self,
        positions: &[Position],
        orders: &[Order],
        also: &InstrumentId,
    ) -> HashMap<InstrumentId, Decimal> {
        let mut out = HashMap::new();
        let wanted = positions
            .iter()
            .map(|p| &p.instrument)
            .chain(orders.iter().map(|o| &o.request.instrument))
            .chain(std::iter::once(also));
        for i in wanted {
            if out.contains_key(i) {
                continue;
            }
            if let Ok((_, spec)) = self.market.spec(i).await {
                out.insert(i.clone(), spec.multiplier);
            }
        }
        out
    }

    pub(crate) async fn touch(
        &self,
        instrument: &InstrumentId,
        side: Side,
    ) -> Option<tessera_core::Price> {
        let q = self.market.quote(instrument).await.ok()?;
        match side {
            Side::Buy => q.ask,
            Side::Sell => q.bid,
        }
        .or(q.last)
    }

    async fn limit_checks(
        &self,
        req: &OrderRequest,
        est: Option<tessera_core::Price>,
        exclude: Option<&OrderId>,
        flat_first: bool,
    ) -> Result<Vec<PreTradeCheck>, ToolError> {
        let setting = self.limits();
        let (held, _) = setting.of(&req.account_id);
        let locked = self.lock_of(&req.account_id).is_some();
        if held.is_off() && !setting.use_firm_limits && !locked {
            return Ok(Vec::new());
        }
        let account = &req.account_id;
        let provider = self.provider();
        let firm = if setting.use_firm_limits {
            provider.risk(account).await
        } else {
            Ok(None)
        };
        if held.is_off() && matches!(firm, Ok(None)) && !locked {
            return Ok(Vec::new());
        }
        let unmeasured = |e: BrokerError| {
            ToolError::unavailable(format!(
                "Your limits cannot be checked now: {e}. Nothing sent."
            ))
        };
        let mut positions = provider.positions(account).await.map_err(unmeasured)?;
        if flat_first {
            positions.retain(|p| p.instrument != req.instrument);
        }
        let position = positions
            .iter()
            .find(|p| p.instrument == req.instrument)
            .map_or(Decimal::ZERO, |p| p.qty.0);
        let opening = limits::opening_qty(position, req.side, req.qty.0, req.reduce_only);
        if opening.is_zero() {
            return Ok(Vec::new());
        }
        let firm = firm.map_err(unmeasured)?;
        let mut orders = provider.orders(account).await.map_err(unmeasured)?;
        if flat_first {
            orders.retain(|o| o.request.instrument != req.instrument);
        }
        let summary = provider.summary(account).await.map_err(unmeasured)?;
        let day = self
            .day_facts(account, &summary, held.trades_per_day().is_some(), firm)
            .await
            .map_err(unmeasured)?;
        let mults = self.multipliers(&positions, &orders, &req.instrument).await;
        let est = match est {
            Some(p) => Some(p),
            None => self.touch(&req.instrument, req.side).await,
        };
        let tick = self
            .market
            .spec(&req.instrument)
            .await
            .ok()
            .map(|(_, s)| s.tick_size.0);
        let stop = match (req.bracket, est, tick) {
            (Some(b), Some(at), Some(tick)) => b.priced_from(req.side, at, tick).stop_loss,
            (b, _, _) => b.and_then(|b| b.stop_loss),
        };
        let risk_at_stop = match (stop, est, mults.get(&req.instrument)) {
            (Some(stop), Some(entry), Some(m)) => Some((entry.0 - stop.0).abs() * opening * m),
            _ => None,
        };
        let facts = OrderFacts {
            qty: req.qty.0,
            opening,
            after: position + Decimal::from(req.side.sign()) * req.qty.0,
            opens_trade: limits::opens_trade(position, req.side, req.qty.0, req.reduce_only),
            risk_at_stop,
            open_risk: self.open_risk(&positions, &orders, &mults, exclude),
        };
        Ok(limits::check(held, &facts, &day))
    }

    fn open_risk(
        &self,
        positions: &[Position],
        orders: &[Order],
        mults: &HashMap<InstrumentId, Decimal>,
        exclude: Option<&OrderId>,
    ) -> Decimal {
        let m = |i: &InstrumentId| mults.get(i).copied();
        let mut risk = limits::open_risk(positions, orders, &m, exclude);
        if self
            .protection()
            .is_some_and(|p| p.mode() == ProtectionMode::Grow)
        {
            risk += limits::adds_risk(positions, orders, &m, exclude);
        }
        risk
    }

    async fn preview_request(&self, req: &OrderRequest) -> Result<OrderPreview, ToolError> {
        let mut preview = self.provider().preview(req).await.map_err(broker_error)?;
        let checks = self
            .limit_checks(req, preview.est_price, None, false)
            .await?;
        preview.checks.extend(checks);
        Ok(preview)
    }

    async fn check_change(&self, order: &Order, changes: &OrderChanges) -> Result<(), ToolError> {
        let setting = self.limits();
        let (held, _) = setting.of(&order.request.account_id);
        let locked = self.lock_of(&order.request.account_id).is_some();
        if held.is_off() && !setting.use_firm_limits && !locked {
            return Ok(());
        }
        let account = &order.request.account_id;
        let provider = self.provider();
        let unmeasured = |e: BrokerError| {
            ToolError::unavailable(format!(
                "Your limits cannot be checked now: {e}. Nothing changed."
            ))
        };
        let orders = provider.orders(account).await.map_err(unmeasured)?;
        let r = &order.request;
        let is_entry = order.role == OrderRole::Entry && order.parent_id.is_none();
        if is_entry && changes.qty.is_some_and(|q| q.0 > r.qty.0) {
            let stop = orders
                .iter()
                .find(|c| c.parent_id.as_ref() == Some(&order.id) && c.role == OrderRole::StopLoss)
                .and_then(|c| c.request.stop_price);
            let mut probe = r.clone();
            probe.qty = changes.qty.unwrap_or(r.qty) - order.filled_qty;
            probe.limit_price = changes.limit_price.or(r.limit_price);
            probe.stop_price = changes.stop_price.or(r.stop_price);
            let carried = match (r.entry_price(), probe.entry_price()) {
                (Some(from), Some(to)) if order.filled_qty.is_zero() => to.0 - from.0,
                _ => Decimal::ZERO,
            };
            probe.bracket = stop.map(|s| Bracket {
                stop_loss: Some(Price(s.0 + carried)),
                ..Bracket::default()
            });
            if stop.is_none() {
                probe = self.shape(&probe).await.check;
            }
            let checks = self
                .limit_checks(&probe, probe.entry_price(), Some(&order.id), false)
                .await?;
            if let Some(b) = checks.iter().find(|c| c.severity == CheckSeverity::Block) {
                return Err(ToolError::rejected(b.message.clone())
                    .with_details(json!({ "code": b.code, "checks": checks, "sent": false })));
            }
            return Ok(());
        }
        let (Some(old), Some(new)) = (r.stop_price, changes.stop_price) else {
            return Ok(());
        };
        let protective =
            r.reduce_only && matches!(r.order_type, OrderType::Stop | OrderType::StopLimit);
        let looser = match r.side {
            Side::Sell => new < old,
            Side::Buy => new > old,
        };
        if !protective || !looser {
            return Ok(());
        }
        let firm = if setting.use_firm_limits {
            provider.risk(account).await.map_err(unmeasured)?
        } else {
            None
        };
        let positions = provider.positions(account).await.map_err(unmeasured)?;
        let summary = provider.summary(account).await.map_err(unmeasured)?;
        let day = self
            .day_facts(account, &summary, false, firm)
            .await
            .map_err(unmeasured)?;
        let mults = self.multipliers(&positions, &orders, &r.instrument).await;
        let Some(mult) = mults.get(&r.instrument).copied() else {
            return Ok(());
        };
        let moved: Vec<Order> = orders
            .iter()
            .map(|o| {
                let mut o = o.clone();
                if o.id == order.id {
                    o.request.stop_price = Some(new);
                }
                o
            })
            .collect();
        let open = self.open_risk(&positions, &moved, &mults, None);
        let parent = order
            .parent_id
            .as_ref()
            .and_then(|p| orders.iter().find(|o| &o.id == p))
            .filter(|p| !p.status.is_terminal());
        let from = match parent {
            Some(p) => p.request.entry_price(),
            None => positions
                .iter()
                .find(|p| p.instrument == r.instrument)
                .map(|p| p.avg_price),
        };
        let trade = from.map_or(Decimal::ZERO, |f| {
            (Decimal::from(-r.side.sign()) * (f.0 - new.0)).max(Decimal::ZERO)
                * order.remaining().0
                * mult
        });
        if let Some(why) = limits::check_stop_move(held, trade, open, &day) {
            let spec = self.market.spec(&r.instrument).await.ok().map(|(_, s)| s);
            let at = spec
                .as_ref()
                .map_or_else(|| old.0.normalize().to_string(), |s| price_label(s, old));
            return Err(
                ToolError::rejected(format!("{why} The stop stays at {at}."))
                    .with_details(json!({ "sent": false })),
            );
        }
        Ok(())
    }

    pub fn broker(&self) -> &Arc<Broker> {
        &self.broker
    }

    fn provider(&self) -> &Arc<dyn BrokerProvider> {
        self.broker.provider()
    }

    pub(crate) fn provider_ref(&self) -> &Arc<dyn BrokerProvider> {
        self.broker.provider()
    }

    pub(crate) fn market_ref(&self) -> &Arc<dyn MarketDataProvider> {
        &self.market
    }

    pub(crate) fn clock_ref(&self) -> &SharedClock {
        &self.clock
    }

    pub fn environment(&self, account: &str) -> Option<Environment> {
        self.provider().environment_of(&AccountId::new(account))
    }

    pub fn order(&self, id: &OrderId) -> Option<Order> {
        self.provider().order_of(id)
    }

    pub fn instrument_hint(&self, account: &str, input: &str) -> Option<InstrumentId> {
        let key = (account.to_owned(), input.trim().to_ascii_uppercase());
        self.resolved
            .read()
            .get(&key)
            .cloned()
            .or_else(|| InstrumentId::new(input).ok())
    }

    pub async fn resolve(&self, input: &str) -> Result<InstrumentId, ToolError> {
        let direct = match InstrumentId::new(input) {
            Ok(id) if self.market.spec(&id).await.is_ok() => Some(id),
            _ => None,
        };
        match direct {
            Some(id) => Ok(id),
            None => self.market.resolve(input).await.map_err(|_| {
                ToolError::not_found(format!(
                    "unknown instrument {input}; try market.search_instruments"
                ))
            }),
        }
    }

    pub async fn resolve_for(&self, account: &str, input: &str) -> Result<InstrumentId, ToolError> {
        let named = self
            .name_contract(&AccountId::new(account), input, None)
            .await?;
        let key = (account.to_owned(), input.trim().to_ascii_uppercase());
        self.resolved
            .write()
            .insert(key, named.instrument.id.clone());
        Ok(named.instrument.id)
    }

    pub async fn account_words(&self, account: &AccountId) -> String {
        let name = self.account_name(account.as_str()).await;
        let connection = match self.provider().connection_of(account).await {
            Ok(c) => Some(
                self.market
                    .connection(&c.id)
                    .map_or(c.system.name, |m| m.display_name),
            ),
            Err(_) => None,
        };
        match connection {
            Some(c) => format!("{name} ({c})"),
            None => name,
        }
    }

    pub(crate) async fn meant(
        &self,
        input: &str,
    ) -> Result<(Instrument, ConnectionRef), ToolError> {
        let as_id = InstrumentId::new(input).ok();
        let venue = as_id.as_ref().filter(|_| input.contains('.'));
        let unknown = || match venue {
            Some(id) => ToolError::not_found(format!("no connection serves {} now", id.symbol())),
            None => ToolError::not_found(format!(
                "unknown instrument {input}; try market.search_instruments"
            )),
        };
        let plain = |e: MarketError| match e {
            MarketError::Unavailable(w)
            | MarketError::Unsupported(w)
            | MarketError::InvalidRequest(w)
            | MarketError::UnknownInstrument(w) => ToolError::unavailable(w),
        };
        let exact = match &as_id {
            Some(id) => self.market.spec(id).await.ok().map(|(i, _)| i),
            None => None,
        };
        let instrument = match exact {
            Some(i) => i,
            None => {
                let id = self.market.resolve(input).await.map_err(|e| match e {
                    MarketError::Unavailable(why) => ToolError::unavailable(why),
                    _ => unknown(),
                })?;
                self.market.spec(&id).await.map_err(plain)?.0
            }
        };
        let served = self.market.serving(&instrument.id).await.map_err(plain)?;
        Ok((instrument, served))
    }

    pub async fn name_contract(
        &self,
        account: &AccountId,
        input: &str,
        root: Option<&str>,
    ) -> Result<Named, ToolError> {
        let words = self.account_words(account).await;
        let (instrument, served) = self.meant(input).await.map_err(|e| naming(&words, e))?;
        if served.id == tessera_market::replay::SOURCE {
            return Err(ToolError::rejected(format!(
                "{} replays a saved day: it takes no orders",
                instrument.symbol
            )));
        }
        let Some(mut wanted) = exchange_contract(&instrument) else {
            return Err(ToolError::not_found(format!(
                "{words}: {input} names no exchange contract"
            )));
        };
        if let Some(r) = root.map(str::trim).filter(|r| !r.is_empty()) {
            wanted = wanted.with_root(r);
        }
        self.name_wanted(account, &words, Some((instrument, served)), wanted)
            .await
    }

    async fn name_wanted(
        &self,
        account: &AccountId,
        words: &str,
        meant: Option<(Instrument, ConnectionRef)>,
        wanted: ExchangeContract,
    ) -> Result<Named, ToolError> {
        let connection = self
            .provider()
            .connection_of(account)
            .await
            .map_err(|e| naming(words, broker_error(e)))?;
        let own = self.market.connection(&connection.id);
        let details = |extra: serde_json::Value| {
            let mut d = json!({ "sent": false, "wanted": wanted });
            if let (Some(d), Some(x)) = (d.as_object_mut(), extra.as_object()) {
                d.extend(x.clone());
            }
            d
        };
        let found = match self.provider().contract_for(account, &wanted).await {
            Ok(Some((i, spec))) => Ok(Some((i, Some(spec)))),
            Ok(None) => Ok(None),
            Err(BrokerError::Unsupported(_)) => {
                let on_market = match (&own, &meant) {
                    (Some(c), _) => self.market.contract_on(&c.id, &wanted).await,
                    (None, Some((i, _))) if exchange_contract(i).as_ref() == Some(&wanted) => {
                        Ok(Some(i.clone()))
                    }
                    (None, Some((_, served))) => self.market.contract_on(&served.id, &wanted).await,
                    (None, None) => self.market.contract_for(&wanted).await,
                };
                match on_market {
                    Ok(found) => Ok(found.map(|i| (i, None))),
                    Err(MarketError::UnknownInstrument(_)) => Ok(None),
                    Err(
                        MarketError::Unavailable(w)
                        | MarketError::Unsupported(w)
                        | MarketError::InvalidRequest(w),
                    ) => Err(w),
                }
            }
            Err(e) => Err(e.to_string()),
        };
        let (found, spec) = match found {
            Ok(Some(x)) => x,
            Ok(None) => {
                return Err(ToolError::rejected(format!("{words} has no {wanted}"))
                    .with_details(details(json!({}))));
            }
            Err(why) => {
                return Err(ToolError::unavailable(format!(
                    "{words} cannot name {wanted} now: {why}"
                ))
                .with_details(details(json!({}))));
            }
        };
        let (instrument, spec) = match spec {
            Some(spec) => (found, spec),
            None => self.market.spec(&found.id).await.map_err(|e| {
                naming(words, ToolError::unavailable(e.to_string()))
                    .with_details(details(json!({})))
            })?,
        };
        Ok(Named {
            instrument,
            spec,
            wanted,
        })
    }

    pub async fn contract_for(
        &self,
        input: &ContractForInput,
    ) -> Result<ContractForOutput, ToolError> {
        let account = self.account(&input.account_id).await?;
        let words = self.account_words(&account).await;
        let named = match &input.instrument {
            Some(i) => self.name_contract(&account, i, input.root.as_deref()).await,
            None => {
                let (Some(exchange), Some(root)) = (&input.exchange, &input.root) else {
                    return Err(ToolError::invalid_input(
                        "give an instrument, or an exchange and a root (and an expiry for a \
                         dated contract)",
                    ));
                };
                let wanted = ExchangeContract::new(exchange, root, input.expiry);
                self.name_wanted(&account, &words, None, wanted).await
            }
        };
        let out = |wanted, instrument, spec, refused| ContractForOutput {
            account_id: account.clone(),
            account: words.clone(),
            wanted,
            instrument,
            spec,
            refused,
        };
        match named {
            Ok(n) => Ok(out(Some(n.wanted), Some(n.instrument), Some(n.spec), None)),
            Err(e) if e.code != tessera_protocol::tools::ToolErrorCode::InvalidInput => {
                let details = e.details.clone().unwrap_or_default();
                let wanted = serde_json::from_value(details["wanted"].clone()).ok();
                Ok(out(wanted, None, None, Some(e.message)))
            }
            Err(e) => Err(e),
        }
    }

    pub(crate) async fn account(&self, account: &str) -> Result<AccountId, ToolError> {
        let id = AccountId::new(account);
        let accounts = self.provider().accounts().await.map_err(broker_error)?;
        if accounts.iter().any(|a| a.id == id) {
            return Ok(id);
        }
        let known: Vec<String> = accounts.iter().map(|a| a.id.to_string()).collect();
        Err(ToolError::not_found(format!(
            "no account {account}; accounts: {}",
            known.join(", ")
        )))
    }

    pub async fn request(
        &self,
        input: &OrderInput,
        key: Option<&str>,
    ) -> Result<OrderRequest, ToolError> {
        let account_id = self.account(&input.account_id).await?;
        let named = self
            .name_contract(&account_id, &input.instrument, None)
            .await?;
        self.resolved.write().insert(
            (
                input.account_id.clone(),
                input.instrument.trim().to_ascii_uppercase(),
            ),
            named.instrument.id.clone(),
        );
        let (instrument, spec) = (named.instrument.id, named.spec);
        let req = OrderRequest {
            account_id,
            instrument,
            side: input.side,
            qty: input.qty,
            order_type: input.order_type,
            limit_price: input.limit_price,
            stop_price: input.stop_price,
            tif: input.tif.unwrap_or(TimeInForce::Day),
            bracket: input.bracket.filter(|b| !b.is_empty()),
            client_order_id: input
                .client_order_id
                .clone()
                .or_else(|| key.map(str::to_owned)),
            reduce_only: input.reduce_only.unwrap_or(false),
        };
        req.validate(&spec)
            .map_err(|e| ToolError::invalid_input(format!("{}: {e}", req.restatement())))?;
        if req.reduce_only && req.bracket.is_some() {
            return Err(ToolError::invalid_input(
                "a reduce-only order closes a position: it takes no bracket",
            ));
        }
        Ok(req)
    }

    async fn named(&self, account: &str, e: ToolError) -> ToolError {
        naming(&self.account_words(&AccountId::new(account)).await, e)
    }

    pub(crate) async fn named_error(&self, account: &str, e: ToolError) -> ToolError {
        self.named(account, e).await
    }

    pub async fn preview(&self, input: &OrderInput) -> Result<OrderPreview, ToolError> {
        let r = async {
            let req = self.request(input, None).await?;
            let shaped = self.shape(&req).await;
            self.preview_request(&shaped.check).await
        }
        .await;
        match r {
            Ok(p) => Ok(p),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    pub async fn submit(
        &self,
        input: &OrderInput,
        key: Option<&str>,
        draft: Option<DraftId>,
    ) -> Result<SubmitOutput, ToolError> {
        match self.submit_unnamed(input, key, draft).await {
            Ok(out) => Ok(out),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    async fn submit_unnamed(
        &self,
        input: &OrderInput,
        key: Option<&str>,
        draft: Option<DraftId>,
    ) -> Result<SubmitOutput, ToolError> {
        let req = self.request(input, key).await?;
        self.live_prices(&req).await?;
        self.send_request(req, draft).await
    }

    pub async fn ready(&self, input: &OrderInput) -> Result<(), ToolError> {
        match self.request(input, None).await {
            Ok(req) => self.live_prices(&req).await,
            Err(_) => Ok(()),
        }
    }

    async fn live_prices(&self, req: &OrderRequest) -> Result<(), ToolError> {
        if req.order_type != OrderType::Market {
            return Ok(());
        }
        let Some(down) = self.market.prices_down_for(&req.instrument) else {
            return Ok(());
        };
        let held = self
            .provider()
            .positions(&req.account_id)
            .await
            .ok()
            .and_then(|ps| ps.into_iter().find(|p| p.instrument == req.instrument))
            .map_or(Decimal::ZERO, |p| p.qty.0);
        if limits::opening_qty(held, req.side, req.qty.0, false).is_zero() {
            return Ok(());
        }
        Err(
            ToolError::rejected(no_live_prices(&down)).with_details(json!({
                "code": "no_live_prices",
                "provider": down.provider_id,
                "sent": false,
            })),
        )
    }

    async fn send_request(
        &self,
        req: OrderRequest,
        draft: Option<DraftId>,
    ) -> Result<SubmitOutput, ToolError> {
        let shaped = self.shape(&req).await;
        let preview = self.preview_request(&shaped.check).await?;
        let req = shaped.send;
        if let Some(block) = preview
            .checks
            .iter()
            .find(|c| c.severity == CheckSeverity::Block)
        {
            return Err(
                ToolError::rejected(block.message.clone()).with_details(json!({
                    "code": block.code,
                    "checks": preview.checks,
                    "sent": false,
                })),
            );
        }
        let account = req.account_id.clone();
        if self.adds(&req).await {
            self.admit(&account)?;
        }
        let order = self.broker.submit(req, draft).await.map_err(broker_error)?;
        if let (Some(p), Some(b)) = (self.protection(), shaped.intent)
            && order.status != OrderStatus::Rejected
        {
            p.remember(&order, b);
        }
        if order.status == OrderStatus::Rejected {
            return Err(ToolError::rejected(
                order
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Rejected by the broker.".into()),
            )
            .with_details(json!({ "order": order, "sent": true })));
        }
        let bracket = self
            .provider()
            .orders(&account)
            .await
            .map_err(broker_error)?
            .into_iter()
            .filter(|o| o.parent_id.as_ref() == Some(&order.id))
            .collect();
        Ok(SubmitOutput {
            order,
            bracket,
            copies: None,
        })
    }

    async fn open_order(&self, account: &str, id: &OrderId) -> Result<Order, ToolError> {
        let account = self.account(account).await?;
        let order = self
            .provider()
            .orders(&account)
            .await
            .map_err(broker_error)?
            .into_iter()
            .find(|o| &o.id == id)
            .ok_or_else(|| ToolError::not_found(format!("order {id} not found on {account}")))?;
        if !order.status.is_open() {
            return Err(ToolError::conflict(format!(
                "The order is already {}.",
                status_word(order.status)
            ))
            .with_details(json!({ "order": order })));
        }
        Ok(order)
    }

    pub async fn modify(&self, input: &ModifyOrderInput) -> Result<OrderOutput, ToolError> {
        match self.modify_unnamed(input).await {
            Ok(out) => Ok(out),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    async fn modify_unnamed(&self, input: &ModifyOrderInput) -> Result<OrderOutput, ToolError> {
        let order = self.open_order(&input.account_id, &input.order_id).await?;
        let changes = OrderChanges {
            qty: input.qty,
            limit_price: input.limit_price,
            stop_price: input.stop_price,
        };
        if changes == OrderChanges::default() {
            return Err(ToolError::invalid_input(
                "nothing to change: give qty, limitPrice or stopPrice",
            ));
        }
        self.check_change(&order, &changes).await?;
        let account = order.request.account_id.clone();
        if order.role == OrderRole::Entry && !order.request.reduce_only {
            self.admit(&account)?;
        }
        let order = self
            .broker
            .modify(&account, &order.id, changes)
            .await
            .map_err(broker_error)?;
        Ok(OrderOutput {
            order,
            copies: None,
        })
    }

    pub async fn cancel(&self, input: &CancelOrderInput) -> Result<OrderOutput, ToolError> {
        match self.cancel_unnamed(input).await {
            Ok(out) => Ok(out),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    async fn cancel_unnamed(&self, input: &CancelOrderInput) -> Result<OrderOutput, ToolError> {
        let order = self.open_order(&input.account_id, &input.order_id).await?;
        let account = order.request.account_id.clone();
        let order = self
            .broker
            .cancel(&account, &order.id)
            .await
            .map_err(broker_error)?;
        Ok(OrderOutput {
            order,
            copies: None,
        })
    }

    async fn scope(
        &self,
        input: &AccountScopeInput,
    ) -> Result<(AccountId, Option<InstrumentId>, Vec<Order>, Vec<Position>), ToolError> {
        let account = self.account(&input.account_id).await?;
        let instrument = match &input.instrument {
            Some(i) => Some(match self.name_contract(&account, i, None).await {
                Ok(n) => n.instrument.id,
                Err(_) => self.resolve(i).await?,
            }),
            None => None,
        };
        let inside = |i: &InstrumentId| instrument.as_ref().is_none_or(|x| x == i);
        let orders = self
            .provider()
            .orders(&account)
            .await
            .map_err(broker_error)?
            .into_iter()
            .filter(|o| o.status.is_open() && inside(&o.request.instrument))
            .collect();
        let positions = self
            .provider()
            .positions(&account)
            .await
            .map_err(broker_error)?
            .into_iter()
            .filter(|p| !p.qty.is_zero() && inside(&p.instrument))
            .collect();
        Ok((account, instrument, orders, positions))
    }

    pub async fn cancel_all(&self, input: &CancelAllInput) -> Result<CancelAllOutput, ToolError> {
        let r = async {
            let (account, _, mut orders, positions) = self.scope(&input.scope()).await?;
            if input.keep_protection == Some(true) {
                orders.retain(|o| !protects(o, &positions));
            }
            let cancelled = self.cancel_each(&account, &orders).await?;
            Ok(CancelAllOutput {
                cancelled,
                copies: None,
            })
        }
        .await;
        match r {
            Ok(out) => Ok(out),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    async fn cancel_each(
        &self,
        account: &AccountId,
        orders: &[Order],
    ) -> Result<Vec<Order>, ToolError> {
        let mut ordered: Vec<&Order> = orders.iter().collect();
        ordered.sort_by_key(|o| o.parent_id.is_some());
        for o in ordered {
            if !self
                .provider()
                .order_of(&o.id)
                .is_none_or(|now| now.status.is_open())
            {
                continue;
            }
            match self.broker.cancel(account, &o.id).await {
                Ok(_) | Err(BrokerError::Rejected(_)) => {}
                Err(e) => return Err(broker_error(e)),
            }
        }
        let now: Vec<Order> = self
            .provider()
            .orders(account)
            .await
            .map_err(broker_error)?;
        Ok(orders
            .iter()
            .filter_map(|o| now.iter().find(|n| n.id == o.id).cloned())
            .filter(|o| o.status == OrderStatus::Cancelled)
            .collect())
    }

    pub async fn flatten(&self, input: &AccountScopeInput) -> Result<FlattenOutput, ToolError> {
        match self.flatten_unnamed(input).await {
            Ok(out) => Ok(out),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    async fn flatten_unnamed(&self, input: &AccountScopeInput) -> Result<FlattenOutput, ToolError> {
        let (account, instrument, orders, positions) = self.scope(input).await?;
        let mut closes = Vec::with_capacity(positions.len());
        let mut kept: Vec<(InstrumentId, String)> = Vec::new();
        for p in &positions {
            let Some(side) = p.side() else {
                continue;
            };
            let req = OrderRequest {
                account_id: account.clone(),
                instrument: p.instrument.clone(),
                side: side.opposite(),
                qty: p.qty.abs(),
                order_type: OrderType::Market,
                limit_price: None,
                stop_price: None,
                tif: TimeInForce::Day,
                bracket: None,
                client_order_id: None,
                reduce_only: true,
            };
            let preview = self.provider().preview(&req).await.map_err(broker_error)?;
            if let Some(block) = preview
                .checks
                .iter()
                .find(|c| c.severity == CheckSeverity::Block)
            {
                kept.push((p.instrument.clone(), block.message.clone()));
                continue;
            }
            closes.push(req);
        }
        let cancel: Vec<Order> = orders
            .into_iter()
            .filter(|o| {
                !(o.request.reduce_only && kept.iter().any(|(i, _)| i == &o.request.instrument))
            })
            .collect();
        let cancelled = self.cancel_each(&account, &cancel).await?;
        let mut closing = Vec::new();
        for mut req in closes {
            let room = self
                .broker
                .closable(&account, &req.instrument, req.side)
                .await
                .map_err(broker_error)?;
            if room.is_zero() {
                continue;
            }
            req.qty = req.qty.min(room);
            let o = self.broker.submit(req, None).await.map_err(broker_error)?;
            closing.push(o);
        }
        let left = self
            .closes_settle(&account, instrument.as_ref(), &mut closing)
            .await?;
        let flat = left.is_empty();
        if !flat {
            let why = kept
                .first()
                .map(|(_, why)| why.clone())
                .or_else(|| closing.iter().find_map(|o| o.reason.clone()))
                .unwrap_or_else(|| "the closing order did not fill".into());
            let open = left
                .iter()
                .map(|p| format!("{} {}", qty_label(p.qty.abs()), p.instrument.symbol()))
                .collect::<Vec<_>>()
                .join(", ");
            let message = if kept.is_empty() {
                format!("Not flat: {why} Working orders are cancelled; {open} still open.")
            } else {
                format!(
                    "Not flat: {why} {open} still open with its exits working; working entries \
                     are cancelled."
                )
            };
            return Err(ToolError::rejected(message).with_details(
                json!({ "cancelled": cancelled, "closing": closing, "flat": false }),
            ));
        }
        Ok(FlattenOutput {
            cancelled,
            closing,
            flat,
            copies: None,
        })
    }

    async fn closes_settle(
        &self,
        account: &AccountId,
        instrument: Option<&InstrumentId>,
        closing: &mut [Order],
    ) -> Result<Vec<Position>, ToolError> {
        let deadline = tokio::time::Instant::now() + REVERSE_SETTLE;
        loop {
            for c in closing.iter_mut() {
                if let Some(now) = self.provider().order_of(&c.id) {
                    *c = now;
                }
            }
            let left: Vec<Position> = self
                .provider()
                .positions(account)
                .await
                .map_err(broker_error)?
                .into_iter()
                .filter(|p| !p.qty.is_zero() && instrument.is_none_or(|i| i == &p.instrument))
                .collect();
            let sent_and_filling = closing.iter().any(|c| !c.status.is_terminal())
                || (!left.is_empty()
                    && !closing.is_empty()
                    && closing.iter().all(|c| c.status == OrderStatus::Filled));
            if left.is_empty() || !sent_and_filling || tokio::time::Instant::now() >= deadline {
                return Ok(left);
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    pub async fn merge_brackets(
        &self,
        input: &AccountScopeInput,
    ) -> Result<MergeOutput, ToolError> {
        let r = async {
            let Some(p) = self.protection() else {
                return Err(ToolError::unsupported(
                    "Tessera does not keep positions' brackets here",
                ));
            };
            let Some(i) = input.instrument.as_deref() else {
                return Err(ToolError::invalid_input("name the position's instrument"));
            };
            let account = self.account(&input.account_id).await?;
            let instrument = match self.name_contract(&account, i, None).await {
                Ok(n) => n.instrument.id,
                Err(_) => self.resolve(i).await?,
            };
            let out = p.merge(&account, &instrument).await.map_err(broker_error)?;
            let orders = self
                .provider()
                .orders(&account)
                .await
                .map_err(broker_error)?
                .into_iter()
                .filter(|o| o.request.instrument == instrument && o.status.is_open())
                .collect();
            if !out.ok {
                return Err(ToolError::rejected(out.text.clone())
                    .with_details(json!({ "orders": orders, "callId": out.call_id })));
            }
            Ok(MergeOutput {
                summary: out.text,
                orders,
            })
        }
        .await;
        match r {
            Ok(out) => Ok(out),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    pub async fn breakeven(
        &self,
        input: &BreakevenStopInput,
        act: bool,
    ) -> Result<(Breakeven, BreakevenStopOutput), ToolError> {
        let r = async {
            let Some(p) = self.protection() else {
                return Err(ToolError::unsupported(
                    "Tessera does not keep positions' stops here",
                ));
            };
            let account = self.account(&input.account_id).await?;
            let instrument = match self.name_contract(&account, &input.instrument, None).await {
                Ok(n) => n.instrument.id,
                Err(_) => self.resolve(&input.instrument).await?,
            };
            let (_, spec) = self
                .market
                .spec(&instrument)
                .await
                .map_err(|e| ToolError::unavailable(e.to_string()))?;
            let touch = match self.market.quote(&instrument).await {
                Ok(q) => Touch {
                    bid: q.bid,
                    ask: q.ask,
                    last: q.last,
                },
                Err(_) => Touch::default(),
            };
            let ask = BreakevenAsk {
                spec,
                offset_ticks: input.offset_ticks,
                touch,
            };
            let done = p
                .breakeven(&account, &instrument, &ask, act)
                .await
                .map_err(broker_error)?;
            let out = BreakevenStopOutput {
                summary: done.plan.summary(),
                price: done.plan.price,
                entry: done.plan.entry,
                offset_ticks: done.plan.offset_ticks,
                moved: if act { done.stops.clone() } else { Vec::new() },
                placed: done.placed.clone(),
                kept: u32::try_from(done.plan.kept).unwrap_or(u32::MAX),
                copies: None,
            };
            Ok((done, out))
        }
        .await;
        match r {
            Ok(out) => Ok(out),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    pub async fn reverse_plan(&self, input: &ReverseInput) -> Result<ReversePlan, ToolError> {
        match self.reverse_plan_unnamed(input).await {
            Ok(p) => Ok(p),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    async fn reverse_plan_unnamed(&self, input: &ReverseInput) -> Result<ReversePlan, ToolError> {
        let account = self.account(&input.account_id).await?;
        let named = self
            .name_contract(&account, &input.instrument, None)
            .await?;
        self.resolved.write().insert(
            (
                input.account_id.clone(),
                input.instrument.trim().to_ascii_uppercase(),
            ),
            named.instrument.id.clone(),
        );
        let instrument = named.instrument.id.clone();
        let provider = self.provider();
        let Some((position, held)) = provider
            .positions(&account)
            .await
            .map_err(broker_error)?
            .into_iter()
            .filter(|p| p.instrument == instrument)
            .find_map(|p| p.side().map(|side| (p, side)))
        else {
            return Err(ToolError::rejected(format!(
                "No {} position to reverse. Nothing sent.",
                instrument.symbol()
            ))
            .with_details(json!({ "sent": false })));
        };
        let orders: Vec<Order> = provider
            .orders(&account)
            .await
            .map_err(broker_error)?
            .into_iter()
            .filter(|o| o.request.instrument == instrument && o.status.is_open())
            .collect();
        let side = held.opposite();
        let qty = position.qty.abs();
        let bracket = input.bracket.filter(|b| !b.is_empty());
        let close = market_order(&account, &instrument, side, qty, None, true);
        let entry = market_order(&account, &instrument, side, qty, bracket, false);
        entry
            .validate(&named.spec)
            .map_err(|e| ToolError::invalid_input(format!("{}: {e}", entry.restatement())))?;
        let stays = format!(
            "Nothing sent; the {} {} stays.",
            position_words(position.qty.0),
            instrument.symbol()
        );
        let refuse = |checks: &[PreTradeCheck]| {
            checks
                .iter()
                .find(|c| c.severity == CheckSeverity::Block)
                .map(|b| {
                    ToolError::rejected(format!("{} {stays}", b.message.trim_end()))
                        .with_details(json!({ "code": b.code, "checks": checks, "sent": false }))
                })
        };
        let closing = provider.preview(&close).await.map_err(broker_error)?;
        if let Some(e) = refuse(&closing.checks) {
            return Err(e);
        }
        let mut preview = provider.preview(&entry).await.map_err(broker_error)?;
        let checks = self
            .limit_checks(&entry, preview.est_price, None, true)
            .await?;
        preview.checks.extend(checks);
        if let Some(e) = refuse(&preview.checks) {
            return Err(e);
        }
        Ok(ReversePlan {
            account,
            spec: named.spec,
            position,
            orders,
            close,
            entry,
            preview,
        })
    }

    pub async fn reverse(
        &self,
        input: &ReverseInput,
        draft: Option<DraftId>,
    ) -> Result<ReverseOutput, ToolError> {
        match self.reverse_unnamed(input, draft).await {
            Ok(out) => Ok(out),
            Err(e) => Err(self.named(&input.account_id, e).await),
        }
    }

    async fn reverse_unnamed(
        &self,
        input: &ReverseInput,
        draft: Option<DraftId>,
    ) -> Result<ReverseOutput, ToolError> {
        let ReversePlan {
            account,
            spec,
            position,
            orders,
            mut close,
            mut entry,
            ..
        } = self.reverse_plan_unnamed(input).await?;
        self.not_paused(&account)?;
        let instrument = position.instrument.clone();
        let symbol = instrument.symbol().to_owned();
        let was = position_words(position.qty.0);
        let cancelled = self.cancel_each(&account, &orders).await?;
        let now = self.position_qty(&account, &instrument).await?;
        if Side::holding(now) != position.side() {
            return Err(ToolError::rejected(format!(
                "The {was} {symbol} closed before it could be reversed (an exit filled): flat, \
                 nothing new sent."
            ))
            .with_details(json!({ "cancelled": cancelled, "flat": now.is_zero() })));
        }
        let qty = Qty(now.abs());
        close.qty = qty;
        entry.qty = qty;
        let was = position_words(now);
        let closing = self
            .broker
            .submit(close, None)
            .await
            .map_err(broker_error)?;
        let gone: Vec<OrderId> = orders.iter().map(|o| o.id.clone()).collect();
        let closing = match self
            .settle_flat(&account, &instrument, &closing, &gone)
            .await
        {
            Ok(c) => c,
            Err(why) => {
                return Err(ToolError::rejected(format!(
                    "Not reversed: {why} Its working orders are cancelled; nothing new was sent."
                ))
                .with_details(
                    json!({ "cancelled": cancelled, "closing": closing, "flat": false }),
                ));
            }
        };
        let new = position_words(-now);
        let entered = match self.send_request(entry, draft).await {
            Ok(out) => out,
            Err(mut e) => {
                e.message = format!(
                    "Flat {symbol}, but the {} was not sent: {}",
                    new.split(' ').next().unwrap_or("new side"),
                    e.message
                );
                let mut details =
                    json!({ "cancelled": cancelled, "closing": closing, "flat": true });
                if let (Some(d), Some(Value::Object(x))) =
                    (details.as_object_mut(), e.details.take())
                {
                    for (k, v) in x {
                        d.entry(k).or_insert(v);
                    }
                }
                return Err(e.with_details(details));
            }
        };
        let at = entered
            .order
            .avg_fill_price
            .map(|p| format!(" at {}", price_label(&spec, p)))
            .unwrap_or_default();
        Ok(ReverseOutput {
            summary: format!("Reversed {was} {symbol} to {new}{at}"),
            side: entered.order.request.side,
            qty,
            cancelled,
            closing,
            entry: entered.order,
            bracket: entered.bracket,
            copies: None,
        })
    }

    async fn position_qty(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
    ) -> Result<Decimal, ToolError> {
        Ok(self
            .provider()
            .positions(account)
            .await
            .map_err(broker_error)?
            .into_iter()
            .find(|p| &p.instrument == instrument)
            .map_or(Decimal::ZERO, |p| p.qty.0))
    }

    async fn settle_flat(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
        close: &Order,
        gone: &[OrderId],
    ) -> Result<Order, String> {
        let provider = self.provider();
        let deadline = tokio::time::Instant::now() + REVERSE_SETTLE;
        let mut last = close.clone();
        loop {
            if let Some(c) = provider.order_of(&close.id) {
                last = c;
            }
            if matches!(
                last.status,
                OrderStatus::Rejected | OrderStatus::Cancelled | OrderStatus::Expired
            ) {
                let why = last.reason.clone().unwrap_or_default();
                return Err(format!(
                    "the close was {}{}.",
                    status_word(last.status),
                    if why.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", why.trim_end_matches('.'))
                    }
                ));
            }
            let ended = gone
                .iter()
                .all(|id| provider.order_of(id).is_none_or(|o| !o.status.is_open()));
            if last.status == OrderStatus::Filled
                && ended
                && self
                    .position_qty(account, instrument)
                    .await
                    .is_ok_and(|q| q.is_zero())
            {
                return Ok(last);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(if last.status == OrderStatus::Filled {
                    "the close filled, but the position does not read flat yet.".into()
                } else {
                    format!("the close is still {}.", status_word(last.status))
                });
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    pub async fn accounts(&self) -> Result<Vec<AccountUpdate>, ToolError> {
        let accounts = self.provider().accounts().await.map_err(broker_error)?;
        let mut out = Vec::with_capacity(accounts.len());
        for account in accounts {
            let summary = match self.provider().summary(&account.id).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::debug!(account = %account.id, error = %e, "no balance yet");
                    continue;
                }
            };
            let risk = self.provider().risk(&account.id).await.unwrap_or_else(|e| {
                tracing::debug!(account = %account.id, error = %e, "no risk status");
                None
            });
            let limits = self.standing(&account, &summary, risk.as_ref()).await;
            out.push(AccountUpdate {
                account,
                summary,
                risk,
                limits,
            });
        }
        Ok(out)
    }

    pub async fn account_ids(&self, filter: Option<&str>) -> Result<Vec<AccountId>, ToolError> {
        match filter {
            Some(a) => Ok(vec![self.account(a).await?]),
            None => Ok(self
                .provider()
                .accounts()
                .await
                .map_err(broker_error)?
                .into_iter()
                .map(|a| a.id)
                .collect()),
        }
    }

    pub async fn watch_loss_limit(&self, account: &AccountId) -> LossWatch {
        let now = self.clock.now();
        let setting = self.limits();
        let (held, _) = setting.of(account);
        let mut fresh = false;
        let lock = match self.locks.active_of(account, LockKind::DailyLoss, now) {
            Some(l) => l,
            None => {
                if held.daily_loss().is_none() {
                    return LossWatch::Clear;
                }
                let Ok(summary) = self.provider().summary(account).await else {
                    return LossWatch::Clear;
                };
                if self
                    .locks
                    .from_before_the_lift(account, summary.day_pnl.amount, now)
                    .await
                {
                    return LossWatch::Clear;
                }
                let day = DayFacts {
                    currency: summary.balance.currency,
                    day_pnl: summary.day_pnl.amount,
                    trades_today: None,
                    firm: None,
                    lock: None,
                    zone: self.display_zone(),
                    now,
                };
                let Some(limit) = limits::breached(held, &day) else {
                    return LossWatch::Clear;
                };
                let lock = AccountLock::daily_loss(account, limit, now);
                self.locks.lock(lock.clone()).await;
                tracing::warn!(%account, "daily loss limit reached: flattening and locking");
                fresh = true;
                lock
            }
        };
        if !self.locks.flatten_due(account, now) {
            return LossWatch::Held {
                lock,
                fresh,
                flat: None,
            };
        }
        let scope = AccountScopeInput {
            account_id: account.to_string(),
            instrument: None,
        };
        let mut open: Vec<InstrumentId> = match self.scope(&scope).await {
            Ok((_, _, orders, positions)) => orders
                .iter()
                .map(|o| o.request.instrument.clone())
                .chain(positions.iter().map(|p| p.instrument.clone()))
                .collect(),
            Err(e) => {
                tracing::warn!(%account, error = %e.message, "daily loss lock: account not read; trying again");
                return LossWatch::Held {
                    lock,
                    fresh,
                    flat: None,
                };
            }
        };
        if open.is_empty() {
            self.locks.flattened(account);
            return LossWatch::Held {
                lock,
                fresh,
                flat: None,
            };
        }
        open.sort();
        open.dedup();
        let result = self.flatten_unnamed(&scope).await;
        let again = result
            .as_ref()
            .is_err_and(|e| e.code != tessera_protocol::tools::ToolErrorCode::Rejected);
        if !again {
            self.locks.flattened(account);
        }
        LossWatch::Held {
            lock,
            fresh,
            flat: Some(Box::new(LossFlatten {
                instruments: open,
                result: result.map_err(|e| e.message),
                again,
            })),
        }
    }

    pub async fn lift_ended_locks(&self) -> Vec<AccountId> {
        let mut changed = self.locks.lift_ended(self.clock.now()).await;
        changed.extend(self.locks.take_changed());
        changed.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        changed.dedup();
        changed
    }

    pub fn day_start(&self) -> Timestamp {
        let now = self.clock.now();
        let cal = crate::paper::account::DAY_CALENDAR;
        cal.session(cal.trade_date(now))
            .map_or(now, |s| s.open.min(now))
    }

    pub async fn action_preview(
        &self,
        restatement: String,
        account: &str,
        orders: Vec<Order>,
        positions: Vec<Position>,
    ) -> ActionPreview {
        ActionPreview {
            restatement,
            account_id: AccountId::new(account),
            environment: self.environment(account),
            orders,
            positions,
            created_at: self.clock.now(),
        }
    }

    pub async fn account_name(&self, account: &str) -> String {
        self.provider()
            .accounts()
            .await
            .ok()
            .and_then(|v| {
                v.into_iter()
                    .find(|a| a.id.as_str() == account)
                    .map(|a| a.display_name)
            })
            .unwrap_or_else(|| account.to_owned())
    }

    pub async fn sentence(&self, o: &Order) -> String {
        let spec = self
            .market
            .spec(&o.request.instrument)
            .await
            .ok()
            .map(|(_, s)| s);
        order_sentence(o, spec.as_ref())
    }

    pub async fn scope_preview(
        &self,
        input: &AccountScopeInput,
    ) -> Result<(Vec<Order>, Vec<Position>), ToolError> {
        let (_, _, orders, positions) = self.scope(input).await?;
        Ok((orders, positions))
    }
}

fn paused_error(until: Timestamp, now: Timestamp) -> ToolError {
    let at = until
        .in_tz(crate::paper::account::DAY_CALENDAR.tz())
        .format("%H:%M:%S");
    ToolError::rejected(format!(
        "Too many orders: more than {ORDERS_PER_SECOND} in a second. New entries pause for {} s, \
         until {at}. Exits, stops, targets and cancels still go. Nothing sent.",
        PAUSE.as_secs()
    ))
    .with_details(json!({
        "code": "order_rate",
        "until": until,
        "secondsLeft": (until.0 - now.0).max(0) / 1_000_000_000,
        "sent": false,
    }))
}

#[derive(Clone, Debug)]
pub enum LossWatch {
    Clear,
    Held {
        lock: AccountLock,
        fresh: bool,
        flat: Option<Box<LossFlatten>>,
    },
}

#[derive(Clone, Debug)]
pub struct LossFlatten {
    pub instruments: Vec<InstrumentId>,
    pub result: Result<FlattenOutput, String>,
    pub again: bool,
}

pub fn protects(o: &Order, positions: &[Position]) -> bool {
    if o.status == OrderStatus::Held {
        return false;
    }
    let exit = matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit)
        || (o.request.reduce_only
            && matches!(
                o.request.order_type,
                OrderType::Stop | OrderType::StopLimit | OrderType::Limit
            ));
    exit && positions.iter().any(|p| {
        p.instrument == o.request.instrument && p.side() == Some(o.request.side.opposite())
    })
}

pub fn legs_words(b: &Bracket, price: impl Fn(Price) -> String) -> String {
    let leg = |word: &str, at: Option<Price>, ticks: Option<u32>| match (at, ticks) {
        (Some(p), _) => Some(format!("{word} {}", price(p))),
        (None, Some(n)) => Some(format!(
            "{word} {n} tick{} from the fill",
            if n == 1 { "" } else { "s" }
        )),
        (None, None) => None,
    };
    [
        leg("stop", b.stop_loss, b.stop_ticks),
        leg("target", b.take_profit, b.target_ticks),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" and ")
}

pub fn order_sentence(o: &Order, spec: Option<&ContractSpec>) -> String {
    let r = &o.request;
    let price = |p: Option<Price>| match (p, spec) {
        (Some(p), Some(s)) => price_label(s, p),
        (Some(p), None) => p.0.normalize().to_string(),
        (None, _) => String::new(),
    };
    let side = match r.side {
        Side::Buy => "Buy",
        Side::Sell => "Sell",
    };
    let what = match (o.role, r.order_type) {
        (OrderRole::StopLoss, _) => format!("stop {}", price(r.stop_price)),
        (OrderRole::TakeProfit, _) => format!("target {}", price(r.limit_price)),
        (_, OrderType::Market) => "market".to_owned(),
        (_, OrderType::Limit) => format!("limit {}", price(r.limit_price)),
        (_, OrderType::Stop) => format!("stop {}", price(r.stop_price)),
        (_, OrderType::StopLimit) => format!(
            "stop {} limit {}",
            price(r.stop_price),
            price(r.limit_price)
        ),
    };
    format!(
        "{side} {} {} {what}",
        qty_label(r.qty),
        r.instrument.symbol()
    )
}

pub const REVERSE_SETTLE: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq)]
pub struct ReversePlan {
    pub account: AccountId,
    pub spec: ContractSpec,
    pub position: Position,
    pub orders: Vec<Order>,
    pub close: OrderRequest,
    pub entry: OrderRequest,
    pub preview: OrderPreview,
}

pub fn position_words(qty: Decimal) -> String {
    format!(
        "{} {}",
        if Side::holding(qty) == Some(Side::Sell) {
            "short"
        } else {
            "long"
        },
        qty_label(Qty(qty.abs()))
    )
}

fn market_order(
    account: &AccountId,
    instrument: &InstrumentId,
    side: Side,
    qty: Qty,
    bracket: Option<Bracket>,
    reduce_only: bool,
) -> OrderRequest {
    OrderRequest {
        account_id: account.clone(),
        instrument: instrument.clone(),
        side,
        qty,
        order_type: OrderType::Market,
        limit_price: None,
        stop_price: None,
        tif: TimeInForce::Day,
        bracket,
        client_order_id: None,
        reduce_only,
    }
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
    use tessera_core::health::{ConnectionPhase, ProviderKind};
    use tessera_core::time::Timestamp;

    use super::*;

    fn down(phase: ConnectionPhase, message: Option<&str>) -> ProviderHealth {
        ProviderHealth {
            provider_id: "rithmic-apex".into(),
            kind: ProviderKind::MarketData,
            display_name: "Apex · Rithmic".into(),
            status: phase.status(),
            latency_ms: None,
            last_message_at: None,
            message: message.map(str::to_owned),
            connection: Some(phase),
            accounts: None,
            checked_at: Timestamp(0),
        }
    }

    #[test]
    fn no_live_prices_says_where_the_login_stands() {
        let rest = "New market orders wait until its prices are back; Flat, closes and Reverse \
                    still go. Nothing sent.";
        let reconnecting = ConnectionPhase::Reconnecting {
            attempt: 2,
            reason: "heartbeat timeout".into(),
        };
        assert_eq!(
            no_live_prices(&down(reconnecting, None)),
            format!("Apex · Rithmic dropped and is reconnecting. {rest}")
        );
        assert_eq!(
            no_live_prices(&down(ConnectionPhase::TakenOver, None)),
            format!(
                "Apex · Rithmic was logged out because another session of this login took over. {rest}"
            )
        );
        assert_eq!(
            no_live_prices(&down(ConnectionPhase::Stopped, Some("stale words"))),
            format!("Apex · Rithmic is not connected. {rest}")
        );
    }
}
