use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use tessera_broker::protect::manager::{EXIT_LAG, STALE_AFTER};
use tessera_broker::protect::{ProtectionManager, ProtectionMode};
use tessera_broker::{
    BrokerError, BrokerEvent, BrokerProvider, BrokerSystem, GuardedBroker, OrderChanges, Verified,
};
use tessera_core::accounts::{AccountSummary, Environment, Restrictions, TradingAccount};
use tessera_core::capabilities::BrokerCapabilities;
use tessera_core::clock::ManualClock;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::{AccountId, BrokerId, ConnectionId, DraftId, FillId, OrderId};
use tessera_core::money::{Currency, Money, Price, Qty};
use tessera_core::orders::{
    BreakevenRule, Fill, Order, OrderPreview, OrderRequest, OrderRole, OrderStatus, OrderType,
    Position, Side, StopRules, TimeInForce,
};
use tessera_core::settle::settle;
use tessera_core::{InstrumentId, SharedClock, Timestamp};
use tokio::sync::{Notify, broadcast};
use tokio_stream::wrappers::BroadcastStream;

const FIRM: &str = "scripted-firm";
const ACCOUNT: &str = "sim-1";

fn t0() -> Timestamp {
    Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap()
}

fn nq() -> InstrumentId {
    InstrumentId::new("NQZ6.CME").unwrap()
}

fn working(
    id: &str,
    side: Side,
    order_type: OrderType,
    price: &str,
    reduce_only: bool,
    role: OrderRole,
    parent_id: Option<&str>,
) -> Order {
    let at = p(price);
    Order {
        id: OrderId::new(id),
        broker_order_id: Some(id.to_owned()),
        draft_id: None,
        request: OrderRequest {
            account_id: AccountId::new(ACCOUNT),
            instrument: nq(),
            side,
            qty: Qty::from(2),
            order_type,
            limit_price: (order_type == OrderType::Limit).then_some(at),
            stop_price: (order_type == OrderType::Stop).then_some(at),
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only,
        },
        role,
        parent_id: parent_id.map(OrderId::new),
        status: OrderStatus::Working,
        filled_qty: Qty::ZERO,
        avg_fill_price: None,
        queue_ahead: None,
        stop_rules: None,
        triggered_at: None,
        environment: Environment::Sim,
        reason: None,
        created_at: t0(),
        updated_at: t0(),
    }
}

fn stop_leg(id: &str, parent: &str, price: &str) -> Order {
    working(
        id,
        Side::Sell,
        OrderType::Stop,
        price,
        true,
        OrderRole::StopLoss,
        Some(parent),
    )
}

fn target_leg(id: &str, parent: &str, price: &str) -> Order {
    working(
        id,
        Side::Sell,
        OrderType::Limit,
        price,
        true,
        OrderRole::TakeProfit,
        Some(parent),
    )
}

fn buy_limit(id: &str, price: &str) -> Order {
    working(
        id,
        Side::Buy,
        OrderType::Limit,
        price,
        false,
        OrderRole::Entry,
        None,
    )
}

fn p(s: &str) -> Price {
    Price(Decimal::from_str(s).unwrap())
}

struct Firm {
    position: Mutex<i64>,
    reported: Mutex<Option<i64>>,
    orders: Mutex<Vec<Order>>,
    events: broadcast::Sender<BrokerEvent>,
    shown_later: Mutex<Option<Vec<(OrderId, OrderChanges)>>>,
    modifies: Mutex<u32>,
    next_read_waits_for: Mutex<Option<Arc<Notify>>>,
}

impl Firm {
    fn new(position: i64) -> Arc<Self> {
        Arc::new(Self {
            position: Mutex::new(position),
            reported: Mutex::new(None),
            orders: Mutex::new(Vec::new()),
            events: broadcast::channel(64).0,
            shown_later: Mutex::new(None),
            modifies: Mutex::new(0),
            next_read_waits_for: Mutex::new(None),
        })
    }

    fn answer_next_read_on(&self, release: Arc<Notify>) {
        *self.next_read_waits_for.lock() = Some(release);
    }

    fn change(&self, o: Order) {
        {
            let mut orders = self.orders.lock();
            let at = orders.iter().position(|x| x.id == o.id).unwrap();
            orders[at] = o.clone();
        }
        let _ = self.events.send(BrokerEvent::Order(o));
    }

    fn position_now(&self) -> Position {
        Position {
            account_id: AccountId::new(ACCOUNT),
            instrument: nq(),
            qty: Qty::from(*self.position.lock()),
            avg_price: p("20641.25"),
            realized_pnl: Money::usd(Decimal::ZERO),
            unrealized_pnl: None,
            mark: None,
            opened_at: t0(),
        }
    }

    fn rest(&self, id: &str, side: Side, order_type: OrderType, price: &str, reduce_only: bool) {
        self.announce(working(
            id,
            side,
            order_type,
            price,
            reduce_only,
            OrderRole::Entry,
            None,
        ));
    }

    fn announce(&self, o: Order) {
        self.orders.lock().push(o.clone());
        let _ = self.events.send(BrokerEvent::Order(o));
    }

    fn plant(&self, o: Order) {
        self.orders.lock().push(o);
    }

    fn disconnect(&self) {
        let _ = self.events.send(BrokerEvent::Disconnected {
            reason: "the firm dropped the session".into(),
        });
    }

    fn close_elsewhere(&self, to: i64) {
        *self.position.lock() = to;
        let _ = self.events.send(BrokerEvent::Position(self.position_now()));
    }

    fn fill_with_its_position_late(&self, side: Side, qty: i64) {
        let reported = *self.position.lock();
        *self.reported.lock() = Some(reported);
        *self.position.lock() += if side == Side::Buy { qty } else { -qty };
        let _ = self.events.send(BrokerEvent::Fill(Fill {
            id: FillId::generate(),
            broker_fill_id: None,
            order_id: Some(OrderId::new("e1")),
            account_id: AccountId::new(ACCOUNT),
            instrument: nq(),
            side,
            qty: Qty::from(qty),
            price: p("20641.25"),
            ts: t0(),
            fee: Money::usd(Decimal::ZERO),
            realized_pnl: None,
            source: FIRM.into(),
        }));
    }

    fn fill_in_part(&self, id: &str, qty: i64) {
        let o = {
            let mut orders = self.orders.lock();
            let o = orders.iter_mut().find(|o| o.id.as_str() == id).unwrap();
            o.filled_qty = o.filled_qty + Qty::from(qty);
            o.status = OrderStatus::PartiallyFilled;
            o.clone()
        };
        let _ = self.events.send(BrokerEvent::Order(o.clone()));
        let _ = self.events.send(BrokerEvent::Fill(Fill {
            id: FillId::generate(),
            broker_fill_id: None,
            order_id: Some(o.id.clone()),
            account_id: AccountId::new(ACCOUNT),
            instrument: nq(),
            side: o.request.side,
            qty: Qty::from(qty),
            price: o.request.limit_price.or(o.request.stop_price).unwrap(),
            ts: t0(),
            fee: Money::usd(Decimal::ZERO),
            realized_pnl: None,
            source: FIRM.into(),
        }));
    }

    fn left(&self, id: &str) -> Qty {
        self.orders
            .lock()
            .iter()
            .find(|o| o.id.as_str() == id)
            .map(Order::remaining)
            .unwrap()
    }

    fn status(&self, id: &str) -> OrderStatus {
        self.orders
            .lock()
            .iter()
            .find(|o| o.id.as_str() == id)
            .map(|o| o.status)
            .unwrap()
    }
}

#[async_trait]
impl BrokerProvider for Firm {
    fn id(&self) -> &str {
        FIRM
    }
    fn capabilities(&self) -> BrokerCapabilities {
        BrokerCapabilities {
            order_types: vec![OrderType::Market, OrderType::Limit, OrderType::Stop],
            time_in_force: vec![TimeInForce::Day],
            brackets: false,
            oco: false,
            modify: true,
            read_only: false,
            environments: vec![Environment::Sim],
            fractional_qty: false,
            stop_rules: false,
        }
    }
    fn system(&self) -> BrokerSystem {
        BrokerSystem {
            name: "Scripted firm".into(),
            environment: Environment::Sim,
        }
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: FIRM.into(),
            kind: ProviderKind::Broker,
            display_name: "Scripted firm".into(),
            status: HealthStatus::Ok,
            latency_ms: None,
            last_message_at: None,
            message: None,
            connection: None,
            accounts: None,
            checked_at: Timestamp(0),
        }
    }
    fn environment_of(&self, account: &AccountId) -> Option<Environment> {
        (account.as_str() == ACCOUNT).then_some(Environment::Sim)
    }
    fn order_of(&self, order: &OrderId) -> Option<Order> {
        self.orders.lock().iter().find(|o| &o.id == order).cloned()
    }
    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        Ok(vec![TradingAccount {
            id: AccountId::new(ACCOUNT),
            display_name: "Sim 1".into(),
            environment: Environment::Sim,
            broker_id: BrokerId::new(FIRM),
            connection_id: ConnectionId::new(FIRM),
            program_id: None,
            rule_set_id: None,
            currency: Currency::Usd,
            restrictions: Restrictions::default(),
            group_id: None,
            external_ref_masked: None,
        }])
    }
    async fn summary(&self, account: &AccountId) -> Result<AccountSummary, BrokerError> {
        let z = Money::usd(Decimal::ZERO);
        Ok(AccountSummary {
            account_id: account.clone(),
            balance: z,
            net_liq: z,
            day_pnl: z,
            realized_today: z,
            fees_today: z,
            unrealized_today: z,
            open_pnl: z,
            buying_power: z,
            as_of: Timestamp(0),
        })
    }
    async fn positions(&self, _: &AccountId) -> Result<Vec<Position>, BrokerError> {
        let mut now = self.position_now();
        if let Some(late) = *self.reported.lock() {
            now.qty = Qty::from(late);
        }
        Ok(if now.qty.is_zero() { vec![] } else { vec![now] })
    }
    async fn fresh_position(&self, _: &AccountId, _: &InstrumentId) -> Result<Qty, BrokerError> {
        Ok(self.position_now().qty)
    }
    async fn orders(&self, _: &AccountId) -> Result<Vec<Order>, BrokerError> {
        let book = self.orders.lock().clone();
        let release = self.next_read_waits_for.lock().take();
        if let Some(release) = release {
            release.notified().await;
        }
        Ok(book)
    }
    async fn fills(&self, _: &AccountId, _: Timestamp) -> Result<Vec<Fill>, BrokerError> {
        Ok(vec![])
    }
    async fn preview(&self, _: &OrderRequest) -> Result<OrderPreview, BrokerError> {
        Err(BrokerError::Unsupported(
            "the scripted firm previews nothing".into(),
        ))
    }
    async fn submit(
        &self,
        _: &Verified,
        _: OrderRequest,
        _: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        Err(BrokerError::Unsupported(
            "the scripted firm takes no orders".into(),
        ))
    }
    async fn modify(
        &self,
        _: &Verified,
        order: &OrderId,
        changes: OrderChanges,
    ) -> Result<Order, BrokerError> {
        *self.modifies.lock() += 1;
        if let Some(later) = self.shown_later.lock().as_mut() {
            later.push((order.clone(), changes));
            return self
                .order_of(order)
                .ok_or_else(|| BrokerError::NotFound(order.to_string()));
        }
        self.apply(order, changes)
    }
    async fn cancel(&self, _: &Verified, order: &OrderId) -> Result<Order, BrokerError> {
        let mut orders = self.orders.lock();
        let o = orders
            .iter_mut()
            .find(|o| &o.id == order)
            .ok_or_else(|| BrokerError::NotFound(order.to_string()))?;
        o.status = OrderStatus::Cancelled;
        let o = o.clone();
        let _ = self.events.send(BrokerEvent::Order(o.clone()));
        Ok(o)
    }
    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        BroadcastStream::new(self.events.subscribe())
            .filter_map(|e| async move { e.ok() })
            .boxed()
    }
}

impl Firm {
    fn apply(&self, order: &OrderId, changes: OrderChanges) -> Result<Order, BrokerError> {
        let mut orders = self.orders.lock();
        let o = orders
            .iter_mut()
            .find(|o| &o.id == order)
            .ok_or_else(|| BrokerError::NotFound(order.to_string()))?;
        o.request.qty = changes.qty.unwrap_or(o.request.qty);
        o.request.limit_price = changes.limit_price.or(o.request.limit_price);
        o.request.stop_price = changes.stop_price.or(o.request.stop_price);
        let o = o.clone();
        let _ = self.events.send(BrokerEvent::Order(o.clone()));
        Ok(o)
    }

    fn show_changes_later(&self) {
        *self.shown_later.lock() = Some(Vec::new());
    }

    fn show_change_of(&self, id: &str) {
        let change = {
            let mut later = self.shown_later.lock();
            let later = later.as_mut().unwrap();
            let at = later.iter().position(|(o, _)| o.as_str() == id).unwrap();
            later.remove(at)
        };
        self.apply(&change.0, change.1).unwrap();
    }

    fn modifies(&self) -> u32 {
        *self.modifies.lock()
    }
}

struct Desk {
    firm: Arc<Firm>,
    protection: Arc<ProtectionManager>,
    _tasks: Vec<tokio::task::JoinHandle<()>>,
}

fn desk(position: i64) -> Desk {
    desk_ready(position, |_| {})
}

fn desk_ready(position: i64, seed: impl FnOnce(&Firm)) -> Desk {
    desk_in(ProtectionMode::PerEntry, position, seed)
}

fn desk_in(mode: ProtectionMode, position: i64, seed: impl FnOnce(&Firm)) -> Desk {
    let firm = Firm::new(position);
    seed(&firm);
    let guarded = GuardedBroker::new(Arc::clone(&firm) as Arc<dyn BrokerProvider>);
    guarded.set_account_order_entry(FIRM, &AccountId::new(ACCOUNT), true);
    let clock: SharedClock = Arc::new(ManualClock::new(t0()));
    let protection = ProtectionManager::new(Arc::new(guarded), clock);
    protection.set_mode(mode);
    let tasks = protection.start();
    Desk {
        firm,
        protection,
        _tasks: tasks,
    }
}

impl Desk {
    async fn becomes(&self, id: &str, want: OrderStatus) {
        settle(
            &format!("{id} becomes {want:?}"),
            || self.firm.status(id),
            |status| *status == want,
        )
        .await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_loose_reduce_only_stop_dies_when_the_position_closes_at_a_firm_that_keeps_it() {
    let d = desk(2);
    let mut notes = d.protection.notes();
    d.firm
        .rest("be", Side::Sell, OrderType::Stop, "20641.25", true);
    d.firm
        .rest("tp", Side::Sell, OrderType::Limit, "20700.00", true);
    d.firm.rest(
        "short-entry",
        Side::Sell,
        OrderType::Stop,
        "20500.00",
        false,
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        d.firm.status("be"),
        OrderStatus::Working,
        "it protects the long"
    );
    d.firm.close_elsewhere(0);
    d.becomes("be", OrderStatus::Cancelled).await;
    d.becomes("tp", OrderStatus::Cancelled).await;
    assert_eq!(
        d.firm.status("short-entry"),
        OrderStatus::Working,
        "an entry order is the trader's, flat or not"
    );
    let note = tokio::time::timeout(Duration::from_secs(5), notes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        note.text,
        "Cancelled the stop and the target: the position is flat"
    );
}

#[tokio::test(start_paused = true)]
async fn a_loose_reduce_only_stop_of_the_old_side_dies_when_the_position_reverses() {
    let d = desk(2);
    d.firm
        .rest("be", Side::Sell, OrderType::Stop, "20641.25", true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.close_elsewhere(-2);
    d.becomes("be", OrderStatus::Cancelled).await;
    d.firm
        .rest("short-be", Side::Buy, OrderType::Stop, "20641.25", true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        d.firm.status("short-be"),
        OrderStatus::Working,
        "the new side's stop stays"
    );
}

#[tokio::test(start_paused = true)]
async fn tessera_bracket_legs_die_when_the_firm_closes_the_position() {
    let d = desk(2);
    let mut notes = d.protection.notes();
    d.firm.announce(stop_leg("e1-sl", "e1", "20600.00"));
    d.firm.announce(target_leg("e1-tp", "e1", "20700.00"));
    d.firm.announce(buy_limit("reenter", "20550.00"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.close_elsewhere(0);
    d.becomes("e1-sl", OrderStatus::Cancelled).await;
    d.becomes("e1-tp", OrderStatus::Cancelled).await;
    assert_eq!(d.firm.status("reenter"), OrderStatus::Working);
    let note = tokio::time::timeout(Duration::from_secs(5), notes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        note.text,
        "Cancelled the stop and the target: the position is flat"
    );
}

#[tokio::test(start_paused = true)]
async fn leftover_bracket_legs_die_when_the_account_starts_flat() {
    let d = desk_ready(0, |firm| {
        firm.announce(stop_leg("e1-sl", "e1", "20600.00"));
        firm.announce(target_leg("e1-tp", "e1", "20700.00"));
        firm.announce(buy_limit("reenter", "20550.00"));
    });
    let mut notes = d.protection.notes();
    d.becomes("e1-sl", OrderStatus::Cancelled).await;
    d.becomes("e1-tp", OrderStatus::Cancelled).await;
    assert_eq!(d.firm.status("reenter"), OrderStatus::Working);
    let note = tokio::time::timeout(Duration::from_secs(5), notes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        note.text,
        "Cancelled the stop and the target: the position is flat"
    );
}

#[tokio::test(start_paused = true)]
async fn leftover_bracket_legs_die_when_the_account_reconnects() {
    let d = desk(0);
    d.firm.plant(stop_leg("e1-sl", "e1", "20600.00"));
    d.firm.plant(target_leg("e1-tp", "e1", "20700.00"));
    d.firm.plant(buy_limit("reenter", "20550.00"));
    let mut notes = d.protection.notes();
    d.firm.disconnect();
    d.becomes("e1-sl", OrderStatus::Cancelled).await;
    d.becomes("e1-tp", OrderStatus::Cancelled).await;
    assert_eq!(d.firm.status("reenter"), OrderStatus::Working);
    let note = tokio::time::timeout(Duration::from_secs(5), notes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        note.text,
        "Cancelled the stop and the target: the position is flat"
    );
}

#[tokio::test(start_paused = true)]
async fn tessera_bracket_legs_die_when_the_firm_reverses_the_position() {
    let d = desk(2);
    d.firm.announce(stop_leg("e1-sl", "e1", "20600.00"));
    d.firm.announce(target_leg("e1-tp", "e1", "20700.00"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.close_elsewhere(-2);
    d.becomes("e1-sl", OrderStatus::Cancelled).await;
    d.becomes("e1-tp", OrderStatus::Cancelled).await;
}

#[tokio::test(start_paused = true)]
async fn a_filled_entrys_legs_stay_when_its_position_update_never_comes() {
    let d = desk(0);
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.fill_with_its_position_late(Side::Buy, 2);
    bracketed_long_of_two(&d.firm);
    tokio::time::sleep(STALE_AFTER * 3).await;
    assert_eq!(
        (d.firm.status("e1-sl"), d.firm.status("e1-tp")),
        (OrderStatus::Working, OrderStatus::Working),
        "planned from a fresh read of the position, not the flat one it last reported"
    );
}

fn bracketed_long_of_two(firm: &Firm) {
    firm.announce(stop_leg("e1-sl", "e1", "20600.00"));
    firm.announce(target_leg("e1-tp", "e1", "20700.00"));
}

#[tokio::test(start_paused = true)]
async fn a_target_filled_in_part_shrinks_its_stop_before_the_position_reports_the_exit() {
    let d = desk_in(ProtectionMode::PerEntry, 2, bracketed_long_of_two);
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.fill_in_part("e1-tp", 1);
    tokio::time::sleep(STALE_AFTER / 3).await;
    assert_eq!(
        (d.firm.left("e1-sl"), d.firm.left("e1-tp")),
        (Qty::from(1), Qty::from(1)),
        "the stop covers what the target left, with the position still reading 2"
    );
}

#[tokio::test(start_paused = true)]
async fn a_stop_filled_in_part_shrinks_its_target_before_the_position_reports_the_exit() {
    let d = desk_in(ProtectionMode::PerEntry, 2, bracketed_long_of_two);
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.fill_in_part("e1-sl", 1);
    tokio::time::sleep(STALE_AFTER / 3).await;
    assert_eq!(
        (d.firm.left("e1-sl"), d.firm.left("e1-tp")),
        (Qty::from(1), Qty::from(1)),
    );
}

#[tokio::test(start_paused = true)]
async fn in_grow_mode_a_late_position_never_grows_back_a_stop_its_target_shrank() {
    let d = desk_in(ProtectionMode::Grow, 2, bracketed_long_of_two);
    let mut notes = d.protection.notes();
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.announce(Order {
        status: OrderStatus::Filled,
        filled_qty: Qty::from(2),
        ..working(
            "e1",
            Side::Buy,
            OrderType::Market,
            "20641.25",
            false,
            OrderRole::Entry,
            None,
        )
    });
    d.firm.fill_in_part("e1-tp", 1);
    tokio::time::sleep(STALE_AFTER * 2).await;
    d.firm.close_elsewhere(2);
    tokio::time::sleep(STALE_AFTER * 2).await;
    assert_eq!(
        (d.firm.left("e1-sl"), d.firm.left("e1-tp")),
        (Qty::from(1), Qty::from(1)),
        "the position still reads 2 long past the wait for it, and once more after the fill"
    );
    d.firm.close_elsewhere(1);
    tokio::time::sleep(STALE_AFTER).await;
    assert_eq!(
        (d.firm.left("e1-sl"), d.firm.left("e1-tp")),
        (Qty::from(1), Qty::from(1)),
    );
    let mut texts = Vec::new();
    while let Ok(n) = notes.try_recv() {
        texts.push(n.text);
    }
    assert_eq!(texts, ["Shrank the stop to 1 as its pair filled in part"]);
}

#[tokio::test(start_paused = true)]
async fn in_grow_mode_a_pair_growing_one_leg_at_a_time_is_left_until_both_legs_show_it() {
    let d = desk_in(ProtectionMode::Grow, 2, bracketed_long_of_two);
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.show_changes_later();
    d.firm.close_elsewhere(3);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(d.firm.modifies(), 2, "the stop and the target grow to 3");
    d.firm.show_change_of("e1-sl");
    tokio::time::sleep(STALE_AFTER * 2).await;
    assert_eq!(
        (
            d.firm.modifies(),
            d.firm.left("e1-sl"),
            d.firm.left("e1-tp")
        ),
        (2, Qty::from(3), Qty::from(2)),
        "the target's change is on its way"
    );
    d.firm.show_change_of("e1-tp");
    tokio::time::sleep(STALE_AFTER * 2).await;
    assert_eq!(
        (
            d.firm.modifies(),
            d.firm.left("e1-sl"),
            d.firm.left("e1-tp")
        ),
        (2, Qty::from(3), Qty::from(3)),
    );
}

#[tokio::test(start_paused = true)]
async fn in_grow_mode_an_add_after_a_position_that_counted_the_exit_first_still_grows_the_legs() {
    let d = desk_in(ProtectionMode::Grow, 2, bracketed_long_of_two);
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.firm.close_elsewhere(1);
    d.firm.fill_in_part("e1-tp", 1);
    tokio::time::sleep(STALE_AFTER * 2).await;
    assert_eq!(
        (d.firm.left("e1-sl"), d.firm.left("e1-tp")),
        (Qty::from(1), Qty::from(1)),
    );
    d.firm.close_elsewhere(2);
    tokio::time::sleep(EXIT_LAG + STALE_AFTER).await;
    assert_eq!(
        (d.firm.left("e1-sl"), d.firm.left("e1-tp")),
        (Qty::from(2), Qty::from(2)),
        "the add of 1 is covered once the exit is surely counted"
    );
}

#[tokio::test(start_paused = true)]
async fn a_note_made_before_anyone_listens_reaches_the_first_listener() {
    let d = desk_ready(0, |firm| {
        firm.announce(stop_leg("e1-sl", "e1", "20600.00"));
        firm.announce(target_leg("e1-tp", "e1", "20700.00"));
    });
    d.becomes("e1-sl", OrderStatus::Cancelled).await;
    d.becomes("e1-tp", OrderStatus::Cancelled).await;
    let mut notes = d.protection.notes();
    let note = tokio::time::timeout(Duration::from_secs(5), notes.recv())
        .await
        .expect("the note made before the listener came")
        .unwrap();
    assert_eq!(
        note.text,
        "Cancelled the stop and the target: the position is flat"
    );
}

#[tokio::test(start_paused = true)]
async fn a_stop_that_starts_working_while_protection_reads_the_book_keeps_its_rules() {
    let rules = StopRules {
        breakeven: Some(BreakevenRule {
            trigger_ticks: 8,
            offset_ticks: 1,
        }),
        entry_price: Some(p("20641.25")),
        ..StopRules::default()
    };
    let held = Order {
        status: OrderStatus::Held,
        stop_rules: Some(rules),
        ..stop_leg("e1-sl", "e1", "20600.00")
    };
    let release = Arc::new(Notify::new());
    let d = desk_ready(2, |firm| {
        firm.plant(held.clone());
        firm.answer_next_read_on(Arc::clone(&release));
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    d.firm.change(Order {
        status: OrderStatus::Working,
        ..held
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    release.notify_one();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        d.protection.rule_instruments(),
        [nq()],
        "the book read while the stop was held is older than the stop working"
    );
}
