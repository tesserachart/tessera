use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use serde_json::json;
use tessera_broker::orders::LossWatch;
use tessera_broker::orders::io::{
    BreakevenStopInput, LockAccountInput, OrderInput, ReverseInput, SubmitOutput,
    UnlockAccountInput,
};
use tessera_broker::paper::{AccountSeed, PaperConfig, default_seeds};
use tessera_broker::protect::{PROTECT_TOOL, ProtectionMode};
use tessera_broker::{BrokerModule, BrokerProvider};
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::ManualClock;
use tessera_core::health::ProviderHealth;
use tessera_core::ids::{AccountId, SessionId};
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::limits::{LimitsSetting, LockKind, LockSpan, RiskLimits};
use tessera_core::market::{Aggressor, AggressorSource, Quote, Trade};
use tessera_core::orders::{
    Bracket, CheckSeverity, Order, OrderRole, OrderStatus, OrderType, Position, Side, TrailRule,
};
use tessera_core::settle::{settle, settle_async};
use tessera_core::{InstrumentId, Origin, Price, Qty, SharedClock, Timeframe, Timestamp};
use tessera_host::{EventBus, RuntimeModule};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream, MockConfig,
    MockMarket,
};
use tessera_protocol::methods::ApprovalsResolveParams;
use tessera_protocol::tools::{ApprovalDecision, SessionMode, ToolOutcome};
use tessera_protocol::topics::ProtectionNote;
use tessera_tools::{
    InvokeRequest, Invoker, InvokerConfig, MemoryObserver, SessionPolicy, SurfaceState,
    ToolRegistry,
};
use tokio::sync::broadcast;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

fn t0() -> Timestamp {
    Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap()
}

fn p(s: &str) -> Price {
    Price(Decimal::from_str(s).unwrap())
}

fn nq() -> InstrumentId {
    InstrumentId::new("NQZ6.CME").unwrap()
}

struct Tape {
    inner: MockMarket,
    quote: Mutex<Quote>,
    quotes: broadcast::Sender<Quote>,
    trades: broadcast::Sender<Trade>,
}

#[async_trait]
impl MarketDataProvider for Tape {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn display_name(&self) -> &str {
        self.inner.display_name()
    }
    fn capabilities(&self) -> MarketCapabilities {
        self.inner.capabilities()
    }
    fn health(&self) -> ProviderHealth {
        self.inner.health()
    }
    async fn search(
        &self,
        query: &str,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.inner.search(query, asset_class, limit).await
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.inner.resolve(input).await
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.inner.spec(i).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.inner.get_bars(req).await
    }
    async fn quote(&self, _i: &InstrumentId) -> Result<Quote, MarketError> {
        Ok(self.quote.lock().clone())
    }
    fn subscribe_quotes(&self, _i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Ok(Box::pin(
            BroadcastStream::new(self.quotes.subscribe()).filter_map(Result::ok),
        ))
    }
    fn subscribe_trades(&self, _i: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        Ok(Box::pin(
            BroadcastStream::new(self.trades.subscribe()).filter_map(Result::ok),
        ))
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.inner.subscribe_bars(i, tf)
    }
}

fn quote_at(bid: &str, ask: &str, last: &str) -> Quote {
    Quote {
        instrument: nq(),
        ts: t0(),
        bid: Some(p(bid)),
        bid_size: Some(Qty::from(10)),
        ask: Some(p(ask)),
        ask_size: Some(Qty::from(10)),
        last: Some(p(last)),
        last_size: Some(Qty::from(1)),
        session: None,
        source: None,
    }
}

struct Desk {
    module: BrokerModule,
    clock: Arc<ManualClock>,
    tape: Arc<Tape>,
    audit: Arc<MemoryObserver>,
    notes: broadcast::Receiver<ProtectionNote>,
    _tasks: Vec<tokio::task::JoinHandle<()>>,
}

const ACCOUNT: &str = "paper-main";

fn funded_seeds() -> Vec<AccountSeed> {
    default_seeds()
        .into_iter()
        .map(|s| AccountSeed {
            balance: Decimal::from(10_000_000),
            ..s
        })
        .collect()
}

async fn desk(mode: ProtectionMode) -> Desk {
    let manual = Arc::new(ManualClock::new(t0()));
    let clock: SharedClock = Arc::clone(&manual) as SharedClock;
    let mut cfg = MockConfig::new(Arc::clone(&clock));
    cfg.intraday_sessions = 1;
    cfg.daily_sessions = 5;
    let tape = Arc::new(Tape {
        inner: MockMarket::new(cfg),
        quote: Mutex::new(quote_at("20641.00", "20641.25", "20641.25")),
        quotes: broadcast::channel(64).0,
        trades: broadcast::channel(64).0,
    });
    let module = BrokerModule::paper_seeded(
        Arc::clone(&tape) as Arc<dyn MarketDataProvider>,
        clock,
        None,
        PaperConfig::default(),
        Arc::new(EventBus::new()),
        &funded_seeds(),
    )
    .await
    .unwrap();
    let audit = Arc::new(MemoryObserver::default());
    let protection = module.protection();
    protection.set_mode(mode);
    protection.set_audit(Arc::clone(&audit) as _);
    let notes = protection.notes();
    let mut tasks = module.paper_broker().start();
    tasks.extend(protection.start());
    Desk {
        module,
        clock: manual,
        tape,
        audit,
        notes,
        _tasks: tasks,
    }
}

fn bracket(stop: &str, target: &str) -> Option<Bracket> {
    Some(Bracket {
        stop_loss: Some(p(stop)),
        take_profit: Some(p(target)),
        ..Bracket::default()
    })
}

fn trailing_bracket(stop: &str, target: &str, trail: u32) -> Option<Bracket> {
    Some(Bracket {
        stop_loss: Some(p(stop)),
        take_profit: Some(p(target)),
        trail: Some(TrailRule {
            distance_ticks: trail,
            trigger_ticks: 0,
            step_ticks: 1,
        }),
        ..Bracket::default()
    })
}

impl Desk {
    async fn send(
        &self,
        side: Side,
        qty: i64,
        order_type: OrderType,
        limit: Option<&str>,
        b: Option<Bracket>,
    ) -> SubmitOutput {
        let input = OrderInput {
            account_id: ACCOUNT.into(),
            instrument: "NQZ6.CME".into(),
            side,
            qty: Qty::from(qty),
            order_type,
            limit_price: limit.map(p),
            stop_price: None,
            tif: None,
            bracket: b,
            reduce_only: None,
            client_order_id: None,
        };
        self.module
            .service()
            .submit(&input, None, None)
            .await
            .unwrap()
    }

    fn input(&self, side: Side, qty: i64, b: Option<Bracket>) -> OrderInput {
        OrderInput {
            account_id: ACCOUNT.into(),
            instrument: "NQZ6.CME".into(),
            side,
            qty: Qty::from(qty),
            order_type: OrderType::Market,
            limit_price: None,
            stop_price: None,
            tif: None,
            bracket: b,
            reduce_only: None,
            client_order_id: None,
        }
    }

    fn limits(&self, every: RiskLimits) {
        self.module.service().set_limits(LimitsSetting {
            every,
            ..LimitsSetting::default()
        });
    }

    async fn send_stop(
        &self,
        side: Side,
        qty: i64,
        stop: &str,
        b: Option<Bracket>,
    ) -> SubmitOutput {
        let input = OrderInput {
            account_id: ACCOUNT.into(),
            instrument: "NQZ6.CME".into(),
            side,
            qty: Qty::from(qty),
            order_type: OrderType::Stop,
            limit_price: None,
            stop_price: Some(p(stop)),
            tif: None,
            bracket: b,
            reduce_only: None,
            client_order_id: None,
        };
        self.module
            .service()
            .submit(&input, None, None)
            .await
            .unwrap()
    }

    async fn print(&self, price: &str) {
        let px = p(price);
        let tick = Decimal::new(25, 2);
        let q = quote_at(
            &(px.0 - tick).to_string(),
            &(px.0 + tick).to_string(),
            price,
        );
        *self.tape.quote.lock() = q.clone();
        self.followed().await;
        let _ = self.tape.quotes.send(q);
        let _ = self.tape.trades.send(Trade {
            instrument: nq(),
            ts: t0(),
            price: px,
            size: Qty::from(50),
            aggressor: Aggressor::Unknown,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        });
    }

    async fn trade_on_an_empty_offer(&self, price: &str, size: i64) {
        let px = p(price);
        let q = Quote {
            ask_size: Some(Qty::ZERO),
            ..quote_at(&(px.0 - Decimal::new(25, 2)).to_string(), price, price)
        };
        *self.tape.quote.lock() = q.clone();
        self.followed().await;
        let _ = self.tape.quotes.send(q);
        tokio::time::sleep(Duration::from_millis(25)).await;
        let _ = self.tape.trades.send(Trade {
            instrument: nq(),
            ts: t0(),
            price: px,
            size: Qty::from(size),
            aggressor: Aggressor::Unknown,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        });
    }

    async fn orders(&self) -> Vec<Order> {
        self.module
            .paper_broker()
            .orders(&AccountId::new(ACCOUNT))
            .await
            .unwrap()
    }

    async fn position(&self) -> Option<Position> {
        self.module
            .paper_broker()
            .positions(&AccountId::new(ACCOUNT))
            .await
            .unwrap()
            .into_iter()
            .next()
    }

    async fn legs(&self) -> Vec<(OrderRole, i64, Price)> {
        let mut out: Vec<(OrderRole, i64, Price)> = self
            .orders()
            .await
            .into_iter()
            .filter(|o| {
                matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit)
                    && o.status.is_working()
            })
            .map(|o| {
                let price = o.request.stop_price.or(o.request.limit_price).unwrap();
                let left = i64::try_from(o.remaining().0.mantissa()).unwrap()
                    / 10_i64.pow(o.remaining().0.scale());
                (o.role, left, price)
            })
            .collect();
        out.sort_by(|a, b| {
            (a.0 != OrderRole::StopLoss, a.2).cmp(&(b.0 != OrderRole::StopLoss, b.2))
        });
        out
    }

    async fn legs_become(&self, want: &[(OrderRole, i64, &str)]) {
        let want: Vec<(OrderRole, i64, Price)> =
            want.iter().map(|(r, q, x)| (*r, *q, p(x))).collect();
        settle_async(
            &format!("the legs become {want:?}"),
            || self.legs(),
            |legs| *legs == want,
        )
        .await;
    }

    fn notes(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(n) = self.notes.try_recv() {
            out.push(n.text);
        }
        out
    }

    async fn notes_until(&mut self, done: impl Fn(&[String]) -> bool) -> Vec<String> {
        let mut out = Vec::new();
        settle(
            "the notes arrive",
            || {
                out.extend(self.notes());
                out.clone()
            },
            |notes| done(notes),
        )
        .await
    }

    async fn working(&self) -> Vec<Order> {
        self.orders()
            .await
            .into_iter()
            .filter(|o| o.status.is_open())
            .collect()
    }

    async fn working_legs(&self) -> Vec<Order> {
        self.working()
            .await
            .into_iter()
            .filter(|o| matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit))
            .collect()
    }

    async fn become_flat(&self) {
        settle_async(
            "flat with no working legs",
            move || async move { (self.position().await, self.working_legs().await) },
            |(position, legs)| position.is_none() && legs.is_empty(),
        )
        .await;
    }

    async fn followed(&self) {
        settle(
            "the paper broker follows the tape",
            || self.tape.trades.receiver_count(),
            |listeners| *listeners > 0,
        )
        .await;
    }

    async fn flatten(&self) {
        self.module
            .service()
            .flatten(&tessera_broker::orders::io::AccountScopeInput {
                account_id: ACCOUNT.into(),
                instrument: Some("NQZ6.CME".into()),
            })
            .await
            .unwrap();
    }

    async fn move_stop(&self, to: &str) {
        let stop = self
            .working_legs()
            .await
            .into_iter()
            .find(|o| o.role == OrderRole::StopLoss)
            .expect("a working stop");
        self.module
            .service()
            .modify(&tessera_broker::orders::io::ModifyOrderInput {
                account_id: ACCOUNT.into(),
                order_id: stop.id,
                qty: None,
                limit_price: None,
                stop_price: Some(p(to)),
            })
            .await
            .unwrap();
    }
}

const SL: OrderRole = OrderRole::StopLoss;
const TP: OrderRole = OrderRole::TakeProfit;

#[tokio::test(start_paused = true)]
async fn the_owners_sequence_ends_with_one_stop_and_one_target_of_the_whole_position() {
    let mut d = desk(ProtectionMode::Grow).await;
    let limit = d
        .send(
            Side::Buy,
            13,
            OrderType::Limit,
            Some("20630.00"),
            bracket("20590.00", "20690.00"),
        )
        .await;
    assert_eq!(limit.order.status, OrderStatus::Working);
    assert_eq!(limit.bracket.len(), 2, "flat: it carries its own legs");
    let first = d
        .send(
            Side::Buy,
            13,
            OrderType::Market,
            None,
            bracket("20600.00", "20700.00"),
        )
        .await;
    assert_eq!(first.order.status, OrderStatus::Filled);
    assert_eq!(first.bracket.len(), 2);
    d.legs_become(&[(SL, 13, "20600.00"), (TP, 13, "20700.00")])
        .await;
    let add = d
        .send(
            Side::Buy,
            5,
            OrderType::Market,
            None,
            bracket("20610.00", "20720.00"),
        )
        .await;
    assert_eq!(add.order.status, OrderStatus::Filled);
    assert!(add.order.request.bracket.is_none(), "sent without its legs");
    assert!(add.bracket.is_empty());
    d.legs_become(&[(SL, 18, "20600.00"), (TP, 18, "20700.00")])
        .await;
    d.print("20629.75").await;
    d.legs_become(&[(SL, 31, "20600.00"), (TP, 31, "20700.00")])
        .await;
    let pos = d.position().await.unwrap();
    assert_eq!(pos.qty, Qty::from(31));
    let limit_legs: Vec<Order> = d
        .orders()
        .await
        .into_iter()
        .filter(|o| o.parent_id.as_ref() == Some(&limit.order.id))
        .collect();
    assert!(
        limit_legs
            .iter()
            .all(|o| o.status == OrderStatus::Cancelled),
        "{limit_legs:?}"
    );
    let protects = || {
        d.audit
            .finished
            .lock()
            .iter()
            .filter(|c| c.tool == PROTECT_TOOL)
            .cloned()
            .collect::<Vec<_>>()
    };
    settle("two protect calls finish", || protects().len(), |n| *n >= 2).await;
    let calls = protects();
    assert_eq!(calls.len(), 2, "{calls:?}");
    let notes = d.notes_until(|n| n.len() >= 2).await;
    assert_eq!(
        notes,
        [
            "Grew the stop and the target to 18",
            "The add joins the position's bracket (its own stop and target cancelled). Grew the \
             stop and the target to 31",
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn each_entry_its_own_bracket_keeps_every_pair() {
    let mut d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        13,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    let add = d
        .send(
            Side::Buy,
            5,
            OrderType::Market,
            None,
            bracket("20610.00", "20720.00"),
        )
        .await;
    assert_eq!(add.bracket.len(), 2, "every entry carries its own legs");
    d.legs_become(&[
        (SL, 13, "20600.00"),
        (SL, 5, "20610.00"),
        (TP, 13, "20700.00"),
        (TP, 5, "20720.00"),
    ])
    .await;
    d.send(Side::Sell, 7, OrderType::Market, None, None).await;
    d.legs_become(&[(SL, 11, "20600.00"), (TP, 11, "20700.00")])
        .await;
    assert_eq!(
        d.notes_until(|n| !n.is_empty()).await,
        ["Cancelled the newest entry's stop and target. Shrank the stop and the target to 11"]
    );
}

#[tokio::test(start_paused = true)]
async fn a_partial_exit_shrinks_the_bracket_and_flat_cancels_it() {
    let d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        10,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.send(
        Side::Buy,
        4,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 14, "20600.00"), (TP, 14, "20700.00")])
        .await;
    d.send(Side::Sell, 6, OrderType::Market, None, None).await;
    d.legs_become(&[(SL, 8, "20600.00"), (TP, 8, "20700.00")])
        .await;
    d.send(
        Side::Sell,
        10,
        OrderType::Market,
        None,
        bracket("20680.00", "20580.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20680.00"), (TP, 2, "20580.00")])
        .await;
    assert_eq!(d.position().await.unwrap().qty, Qty::from(-2));
    d.send(Side::Buy, 2, OrderType::Market, None, None).await;
    d.legs_become(&[]).await;
    assert!(d.position().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn a_target_filled_in_part_leaves_the_stop_at_the_rest_and_the_stop_closes_flat() {
    for mode in [ProtectionMode::PerEntry, ProtectionMode::Grow] {
        let d = desk(mode).await;
        d.send(
            Side::Buy,
            2,
            OrderType::Market,
            None,
            bracket("20600.00", "20650.00"),
        )
        .await;
        d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20650.00")])
            .await;
        d.trade_on_an_empty_offer("20650.00", 1).await;
        d.legs_become(&[(SL, 1, "20600.00"), (TP, 1, "20650.00")])
            .await;
        assert_eq!(d.position().await.unwrap().qty, Qty::from(1), "{mode:?}");
        d.print("20599.75").await;
        d.become_flat().await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_trailing_stop_that_trails_then_fills_leaves_no_working_leg() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        1,
        OrderType::Market,
        None,
        trailing_bracket("20631.25", "20700.00", 20),
    )
    .await;
    d.legs_become(&[(SL, 1, "20631.25"), (TP, 1, "20700.00")])
        .await;
    d.print("20650.00").await;
    d.legs_become(&[(SL, 1, "20645.00"), (TP, 1, "20700.00")])
        .await;
    d.print("20644.75").await;
    d.become_flat().await;
    assert!(d.working_legs().await.is_empty());
    assert!(d.position().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn a_stop_the_trader_moved_then_fills_leaves_no_working_leg() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        1,
        OrderType::Market,
        None,
        bracket("20631.25", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 1, "20631.25"), (TP, 1, "20700.00")])
        .await;
    d.move_stop("20640.00").await;
    d.legs_become(&[(SL, 1, "20640.00"), (TP, 1, "20700.00")])
        .await;
    d.print("20639.75").await;
    d.become_flat().await;
    assert!(d.working_legs().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_target_fill_leaves_no_working_leg() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        1,
        OrderType::Market,
        None,
        bracket("20600.00", "20650.00"),
    )
    .await;
    d.legs_become(&[(SL, 1, "20600.00"), (TP, 1, "20650.00")])
        .await;
    d.print("20650.25").await;
    d.become_flat().await;
    assert!(d.working_legs().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn flatten_and_a_manual_close_leave_no_working_leg() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        1,
        OrderType::Market,
        None,
        trailing_bracket("20631.25", "20700.00", 20),
    )
    .await;
    d.legs_become(&[(SL, 1, "20631.25"), (TP, 1, "20700.00")])
        .await;
    d.print("20650.00").await;
    d.legs_become(&[(SL, 1, "20645.00"), (TP, 1, "20700.00")])
        .await;
    d.flatten().await;
    d.become_flat().await;
    assert!(d.working_legs().await.is_empty());

    d.send(
        Side::Buy,
        1,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 1, "20600.00"), (TP, 1, "20700.00")])
        .await;
    d.send(Side::Sell, 1, OrderType::Market, None, None).await;
    d.become_flat().await;
    assert!(d.working_legs().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_partial_close_resizes_the_legs_and_a_standalone_entry_survives_flat() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        3,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 3, "20600.00"), (TP, 3, "20700.00")])
        .await;
    let resting = d
        .send(Side::Buy, 1, OrderType::Limit, Some("20550.00"), None)
        .await
        .order;
    assert_eq!(resting.status, OrderStatus::Working);
    d.send(Side::Sell, 1, OrderType::Market, None, None).await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    assert_eq!(d.position().await.unwrap().qty, Qty::from(2));
    assert!(
        d.working()
            .await
            .iter()
            .any(|o| o.id == resting.id && o.status == OrderStatus::Working)
    );
    d.send(Side::Sell, 2, OrderType::Market, None, None).await;
    d.become_flat().await;
    assert!(d.working_legs().await.is_empty());
    assert!(
        d.working()
            .await
            .iter()
            .any(|o| o.id == resting.id && o.status == OrderStatus::Working)
    );
}

#[tokio::test(start_paused = true)]
async fn an_add_that_fills_after_a_stop_out_gets_the_legs_it_was_placed_with() {
    let mut d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    let add = d
        .send_stop(Side::Buy, 3, "20660.00", bracket("20640.00", "20700.00"))
        .await;
    assert_eq!(add.order.status, OrderStatus::Working);
    assert!(add.bracket.is_empty());
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.print("20599.75").await;
    settle_async("stopped out", || d.position(), Option::is_none).await;
    d.legs_become(&[]).await;
    d.print("20660.00").await;
    d.legs_become(&[(SL, 3, "20640.00"), (TP, 3, "20700.00")])
        .await;
    let legs: Vec<Order> = d
        .orders()
        .await
        .into_iter()
        .filter(|o| o.parent_id.as_ref() == Some(&add.order.id) && o.status.is_open())
        .collect();
    assert_eq!(legs.len(), 2, "shown under the add");
    let gone = "The bracket was gone: attached the add's stop 20,640.00 and target 20,700.00 for 3";
    let notes = d.notes_until(|n| n.iter().any(|n| n == gone)).await;
    assert!(notes.iter().any(|n| n == gone), "{notes:?}");
}

#[tokio::test(start_paused = true)]
async fn an_add_priced_beyond_the_positions_stop_keeps_its_own_legs() {
    let d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    let under = d
        .send(
            Side::Buy,
            3,
            OrderType::Limit,
            Some("20590.00"),
            bracket("20580.00", "20650.00"),
        )
        .await;
    assert_eq!(under.bracket.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn legacy_pairs_stay_until_merged_into_one() {
    let mut d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        13,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.send(
        Side::Buy,
        5,
        OrderType::Market,
        None,
        bracket("20610.00", "20690.00"),
    )
    .await;
    d.legs_become(&[
        (SL, 13, "20600.00"),
        (SL, 5, "20610.00"),
        (TP, 5, "20690.00"),
        (TP, 13, "20700.00"),
    ])
    .await;
    d.module.protection().set_mode(ProtectionMode::Grow);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(d.legs().await.len(), 4);
    let out = d
        .module
        .service()
        .merge_brackets(&tessera_broker::orders::io::AccountScopeInput {
            account_id: ACCOUNT.into(),
            instrument: Some("NQZ6.CME".into()),
        })
        .await
        .unwrap();
    assert_eq!(out.summary, "Merged 2 brackets into one for 18");
    d.legs_become(&[(SL, 18, "20610.00"), (TP, 18, "20690.00")])
        .await;
    let _ = d.notes();
}

#[tokio::test(start_paused = true)]
async fn the_traders_limits_weigh_an_add_at_the_positions_stop() {
    let d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.limits(RiskLimits {
        max_risk_per_trade: Some(500.0),
        ..RiskLimits::default()
    });
    let service = d.module.service();
    let add = d.input(Side::Buy, 1, bracket("20636.00", "20700.00"));
    let preview = service.preview(&add).await.unwrap();
    let block = preview
        .checks
        .iter()
        .find(|c| c.severity == CheckSeverity::Block)
        .expect("refused at the position's stop");
    assert_eq!(block.code, "limit_risk_per_trade");
    assert!(
        block.message.contains("This stop risks $825:"),
        "{}",
        block.message
    );
    let e = service.submit(&add, None, None).await.unwrap_err();
    assert!(e.message.contains("This stop risks $825:"), "{}", e.message);
    let bare = d.input(Side::Buy, 1, None);
    let e = service.submit(&bare, None, None).await.unwrap_err();
    assert!(
        e.message.contains("This stop risks $825:") && !e.message.contains("No stop"),
        "{}",
        e.message
    );
    assert_eq!(d.position().await.unwrap().qty, Qty::from(2));
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.limits(RiskLimits {
        max_risk_per_trade: Some(1000.0),
        ..RiskLimits::default()
    });
    let out = service.submit(&add, None, None).await.unwrap();
    assert!(out.order.request.bracket.is_none(), "sent without its legs");
    d.legs_become(&[(SL, 3, "20600.00"), (TP, 3, "20700.00")])
        .await;
}

#[tokio::test(start_paused = true)]
async fn the_traders_limits_never_refuse_what_keeps_a_position_protected() {
    let mut d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    let add = d
        .send(
            Side::Buy,
            1,
            OrderType::Limit,
            Some("20630.00"),
            bracket("20620.00", "20700.00"),
        )
        .await;
    assert!(add.bracket.is_empty());
    d.limits(RiskLimits {
        max_position_qty: Some(2),
        max_risk_per_trade: Some(1.0),
        ..RiskLimits::default()
    });
    let e = d
        .module
        .service()
        .submit(&d.input(Side::Buy, 1, None), None, None)
        .await
        .unwrap_err();
    assert!(e.message.contains("over your 2 contracts"), "{}", e.message);
    d.print("20629.75").await;
    d.legs_become(&[(SL, 3, "20600.00"), (TP, 3, "20700.00")])
        .await;
    assert_eq!(d.position().await.unwrap().qty, Qty::from(3));
    d.send(Side::Sell, 1, OrderType::Market, None, None).await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.send(Side::Sell, 2, OrderType::Market, None, None).await;
    d.legs_become(&[]).await;
    assert!(d.position().await.is_none());
    let grew = |n: &String| n == "Grew the stop and the target to 3";
    let notes = d.notes_until(|n| n.iter().any(grew)).await;
    assert!(notes.iter().any(grew), "{notes:?}");
    assert!(
        d.audit
            .finished
            .lock()
            .iter()
            .filter(|c| c.tool == PROTECT_TOOL)
            .all(|c| c.error.is_none()),
        "no protective step refused"
    );
}

fn breakeven_input(offset: Option<u32>) -> BreakevenStopInput {
    BreakevenStopInput {
        account_id: ACCOUNT.into(),
        instrument: "NQZ6.CME".into(),
        offset_ticks: offset,
    }
}

#[tokio::test(start_paused = true)]
async fn breakeven_moves_a_longs_stop_to_the_entry_plus_the_offset() {
    let d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.print("20660.00").await;
    let out = d
        .module
        .service()
        .breakeven(&breakeven_input(Some(4)), true)
        .await
        .unwrap()
        .1;
    assert_eq!(out.price, p("20642.25"));
    assert_eq!(out.entry, p("20641.25"));
    assert_eq!(out.moved.len(), 1);
    assert_eq!(
        out.summary,
        "Moved the stop to breakeven, 20,642.25 (the entry + 4 ticks)"
    );
    d.legs_become(&[(SL, 2, "20642.25"), (TP, 2, "20700.00")])
        .await;
    let e = d
        .module
        .service()
        .breakeven(&breakeven_input(Some(4)), true)
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        "Paper (Tessera Paper): The stop is already at or past breakeven (20,642.25)."
    );
}

#[tokio::test(start_paused = true)]
async fn breakeven_moves_a_shorts_stop_down_to_the_entry_minus_the_offset() {
    let d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Sell,
        2,
        OrderType::Market,
        None,
        bracket("20680.00", "20580.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20680.00"), (TP, 2, "20580.00")])
        .await;
    d.print("20620.00").await;
    let out = d
        .module
        .service()
        .breakeven(&breakeven_input(Some(4)), true)
        .await
        .unwrap()
        .1;
    assert_eq!(out.price, p("20640.00"));
    d.legs_become(&[(SL, 2, "20640.00"), (TP, 2, "20580.00")])
        .await;
}

#[tokio::test(start_paused = true)]
async fn breakeven_is_refused_until_price_has_passed_it() {
    let d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    let e = d
        .module
        .service()
        .breakeven(&breakeven_input(None), true)
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        "Paper (Tessera Paper): Price hasn't passed your entry (20,641.25) yet; the stop stays at \
         20,600.00."
    );
    d.print("20642.00").await;
    let e = d
        .module
        .service()
        .breakeven(&breakeven_input(Some(8)), true)
        .await
        .unwrap_err();
    assert!(
        e.message.contains(
            "Price hasn't passed breakeven (20,643.25, the entry + 8 ticks) yet; the stop stays \
             at 20,600.00."
        ),
        "{}",
        e.message
    );
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
}

#[tokio::test(start_paused = true)]
async fn each_entry_its_own_bracket_moves_every_pairs_stop_to_the_positions_average() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.print("20651.00").await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20620.00", "20720.00"),
    )
    .await;
    d.legs_become(&[
        (SL, 2, "20600.00"),
        (SL, 2, "20620.00"),
        (TP, 2, "20700.00"),
        (TP, 2, "20720.00"),
    ])
    .await;
    assert_eq!(d.position().await.unwrap().avg_price, p("20646.25"));
    d.print("20670.00").await;
    let out = d
        .module
        .service()
        .breakeven(&breakeven_input(None), true)
        .await
        .unwrap()
        .1;
    assert_eq!(
        out.summary,
        "Moved 2 stops to breakeven, 20,646.25 (the entry): every entry's stop to the position's \
         average entry"
    );
    d.legs_become(&[
        (SL, 2, "20646.25"),
        (SL, 2, "20646.25"),
        (TP, 2, "20700.00"),
        (TP, 2, "20720.00"),
    ])
    .await;
}

#[tokio::test(start_paused = true)]
async fn the_traders_limits_never_refuse_breakeven() {
    let d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.print("20660.00").await;
    d.limits(RiskLimits {
        max_position_qty: Some(1),
        max_risk_per_trade: Some(1.0),
        daily_loss_limit: Some(1.0),
        ..RiskLimits::default()
    });
    let e = d
        .module
        .service()
        .submit(&d.input(Side::Buy, 1, None), None, None)
        .await
        .unwrap_err();
    assert!(e.message.contains("over your 1 contract"), "{}", e.message);
    d.module
        .service()
        .breakeven(&breakeven_input(Some(0)), true)
        .await
        .unwrap();
    d.legs_become(&[(SL, 2, "20641.25"), (TP, 2, "20700.00")])
        .await;
}

#[tokio::test(start_paused = true)]
async fn the_analysts_breakeven_is_a_draft_the_user_approves_and_the_users_own_goes_at_once() {
    let d = desk(ProtectionMode::Grow).await;
    let mut registry = ToolRegistry::new();
    d.module.register_tools(&mut registry).unwrap();
    let inv = Invoker::new(
        Arc::new(registry),
        Arc::clone(&d.audit) as _,
        Arc::new(ManualClock::new(t0())) as SharedClock,
        InvokerConfig::default(),
    );
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.print("20660.00").await;
    let agent = Origin::Agent {
        session_id: SessionId::new("S1"),
        provider: "codex".into(),
    };
    let input = json!({ "accountId": ACCOUNT, "instrument": "NQZ6.CME", "offsetTicks": 4 });
    let mut req = InvokeRequest::new("orders.breakeven", input.clone(), agent);
    req.surface = SurfaceState {
        armed: true,
        hold_confirmed: true,
    };
    let r = inv.invoke(req).await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    let pending = r.approval.clone().unwrap();
    let approval = inv.approvals().get(&pending.approval_id).unwrap();
    assert_eq!(
        approval.preview["restatement"],
        "Move the NQZ6 stop on Paper to breakeven: 20,642.25 (the entry + 4 ticks)"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    let done = inv
        .resolve(
            &ApprovalsResolveParams {
                approval_id: pending.approval_id,
                decision: ApprovalDecision::Approve,
                preview_hash: pending.preview_hash,
                note: None,
                input: None,
                deadline: None,
                idempotency_key: None,
            },
            &Origin::User,
        )
        .await
        .unwrap();
    assert!(done.result.unwrap().ok);
    d.legs_become(&[(SL, 2, "20642.25"), (TP, 2, "20700.00")])
        .await;
    d.print("20680.00").await;
    let mut req = InvokeRequest::new(
        "orders.breakeven",
        json!({ "accountId": ACCOUNT, "instrument": "NQZ6.CME", "offsetTicks": 8 }),
        Origin::User,
    );
    req.surface = SurfaceState::default();
    let r = inv.invoke(req).await;
    assert_eq!(r.status, ToolOutcome::Ok, "{r:?}");
    d.legs_become(&[(SL, 2, "20643.25"), (TP, 2, "20700.00")])
        .await;
}

async fn open_exits(d: &Desk) -> Vec<Order> {
    d.orders()
        .await
        .into_iter()
        .filter(|o| o.role == OrderRole::Exit && o.status.is_open())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn breakeven_places_a_stop_at_the_entry_for_a_position_without_one() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(Side::Buy, 2, OrderType::Market, None, None).await;
    let e = d
        .module
        .service()
        .breakeven(&breakeven_input(None), true)
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        "Paper (Tessera Paper): Price hasn't passed your entry (20,641.25) yet; no stop sent."
    );
    assert!(open_exits(&d).await.is_empty(), "nothing sent");
    d.print("20660.00").await;
    let out = d
        .module
        .service()
        .breakeven(&breakeven_input(None), true)
        .await
        .unwrap()
        .1;
    assert_eq!(
        out.summary,
        "Placed a stop at breakeven, 20,641.25 (the entry)"
    );
    assert!(out.moved.is_empty());
    let placed = out.placed.unwrap();
    let r = &placed.request;
    assert_eq!(
        (r.side, r.qty, r.order_type, r.stop_price, r.reduce_only),
        (
            Side::Sell,
            Qty::from(2),
            OrderType::Stop,
            Some(p("20641.25")),
            true
        )
    );
    assert_eq!(placed.status, OrderStatus::Working);
    let e = d
        .module
        .service()
        .breakeven(&breakeven_input(None), true)
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        "Paper (Tessera Paper): The stop is already at or past breakeven (20,641.25)."
    );
    assert_eq!(open_exits(&d).await.len(), 1, "one stop, never two");
    d.send(Side::Sell, 2, OrderType::Market, None, None).await;
    settle_async(
        "the stop goes with the position",
        || open_exits(&d),
        Vec::is_empty,
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn the_analysts_breakeven_without_a_stop_is_a_draft_that_sends_nothing_until_approved() {
    let d = desk(ProtectionMode::PerEntry).await;
    let mut registry = ToolRegistry::new();
    d.module.register_tools(&mut registry).unwrap();
    let inv = Invoker::new(
        Arc::new(registry),
        Arc::clone(&d.audit) as _,
        Arc::new(ManualClock::new(t0())) as SharedClock,
        InvokerConfig::default(),
    );
    d.send(Side::Buy, 2, OrderType::Market, None, None).await;
    d.print("20660.00").await;
    let agent = Origin::Agent {
        session_id: SessionId::new("S1"),
        provider: "codex".into(),
    };
    let mut req = InvokeRequest::new(
        "orders.breakeven",
        json!({ "accountId": ACCOUNT, "instrument": "NQZ6.CME" }),
        agent,
    );
    req.surface = SurfaceState {
        armed: true,
        hold_confirmed: true,
    };
    let r = inv.invoke(req).await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    let pending = r.approval.clone().unwrap();
    let approval = inv.approvals().get(&pending.approval_id).unwrap();
    assert_eq!(
        approval.preview["restatement"],
        "Place a stop for the long 2 NQZ6 on Paper at breakeven: 20,641.25 (the entry)"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        open_exits(&d).await.is_empty(),
        "nothing sent before the approval"
    );
    let done = inv
        .resolve(
            &ApprovalsResolveParams {
                approval_id: pending.approval_id,
                decision: ApprovalDecision::Approve,
                preview_hash: pending.preview_hash,
                note: None,
                input: None,
                deadline: None,
                idempotency_key: None,
            },
            &Origin::User,
        )
        .await
        .unwrap();
    assert!(done.result.unwrap().ok);
    assert_eq!(open_exits(&d).await.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_dragged_stop_dies_with_its_side_when_the_position_reverses_on_paper() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(Side::Buy, 2, OrderType::Market, None, None).await;
    let stop = d
        .module
        .service()
        .submit(
            &OrderInput {
                stop_price: Some(p("20600.00")),
                order_type: OrderType::Stop,
                reduce_only: Some(true),
                ..d.input(Side::Sell, 2, None)
            },
            None,
            None,
        )
        .await
        .unwrap()
        .order;
    assert_eq!(stop.status, OrderStatus::Working);
    d.send(Side::Sell, 4, OrderType::Market, None, None).await;
    assert_eq!(d.position().await.unwrap().qty, Qty::from(-2));
    settle_async(
        "the long's stop goes with it",
        || open_exits(&d),
        Vec::is_empty,
    )
    .await;
}

fn reverse_input(b: Option<Bracket>) -> ReverseInput {
    ReverseInput {
        account_id: ACCOUNT.into(),
        instrument: "NQZ6.CME".into(),
        bracket: b,
    }
}

#[tokio::test(start_paused = true)]
async fn reverse_turns_a_long_into_a_short_of_the_same_size_under_its_own_bracket() {
    let mut d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.send(
        Side::Buy,
        1,
        OrderType::Market,
        None,
        bracket("20610.00", "20710.00"),
    )
    .await;
    d.legs_become(&[(SL, 3, "20600.00"), (TP, 3, "20700.00")])
        .await;
    d.notes();
    let out = d
        .module
        .service()
        .reverse(&reverse_input(bracket("20680.00", "20580.00")), None)
        .await
        .unwrap();
    assert_eq!(out.summary, "Reversed long 3 NQZ6 to short 3 at 20,641.00");
    assert_eq!((out.side, out.qty), (Side::Sell, Qty::from(3)));
    assert_eq!(
        out.cancelled.len(),
        2,
        "the old side's stop and target first"
    );
    assert!(out.closing.request.reduce_only);
    assert_eq!(out.closing.status, OrderStatus::Filled);
    assert_eq!(out.closing.request.qty, Qty::from(3));
    assert!(!out.entry.request.reduce_only);
    assert_eq!(out.entry.request.qty, Qty::from(3));
    assert_eq!(out.bracket.len(), 2);
    assert_eq!(d.position().await.unwrap().qty, Qty::from(-3));
    d.legs_become(&[(SL, 3, "20680.00"), (TP, 3, "20580.00")])
        .await;
    assert!(
        d.orders()
            .await
            .iter()
            .all(|o| o.request.qty <= Qty::from(3))
    );
    d.send(
        Side::Sell,
        1,
        OrderType::Market,
        None,
        bracket("20690.00", "20590.00"),
    )
    .await;
    d.legs_become(&[(SL, 4, "20680.00"), (TP, 4, "20580.00")])
        .await;
}

#[tokio::test(start_paused = true)]
async fn reverse_turns_a_short_into_a_long_and_cancels_what_worked_on_the_contract() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Sell,
        2,
        OrderType::Market,
        None,
        bracket("20680.00", "20600.00"),
    )
    .await;
    let add = d
        .send(Side::Sell, 1, OrderType::Limit, Some("20660.00"), None)
        .await;
    let exit = d
        .module
        .service()
        .submit(
            &OrderInput {
                order_type: OrderType::Limit,
                limit_price: Some(p("20620.00")),
                reduce_only: Some(true),
                ..d.input(Side::Buy, 1, None)
            },
            None,
            None,
        )
        .await
        .unwrap();
    d.legs_become(&[(SL, 2, "20680.00"), (TP, 2, "20600.00")])
        .await;
    let out = d
        .module
        .service()
        .reverse(&reverse_input(bracket("20610.00", "20700.00")), None)
        .await
        .unwrap();
    assert_eq!(out.summary, "Reversed short 2 NQZ6 to long 2 at 20,641.25");
    assert_eq!(
        out.cancelled.len(),
        4,
        "the stop, the target, the add and the exit"
    );
    assert_eq!(d.position().await.unwrap().qty, Qty::from(2));
    d.legs_become(&[(SL, 2, "20610.00"), (TP, 2, "20700.00")])
        .await;
    let orders = d.orders().await;
    for id in [&add.order.id, &exit.order.id] {
        let o = orders.iter().find(|o| &o.id == id).unwrap();
        assert_eq!(o.status, OrderStatus::Cancelled);
    }
}

#[tokio::test(start_paused = true)]
async fn reverse_is_refused_when_flat_and_sends_nothing() {
    let d = desk(ProtectionMode::Grow).await;
    let e = d
        .module
        .service()
        .reverse(&reverse_input(bracket("20680.00", "20580.00")), None)
        .await
        .unwrap_err();
    assert_eq!(e.code, tessera_protocol::tools::ToolErrorCode::Rejected);
    assert!(
        e.message
            .ends_with("No NQZ6 position to reverse. Nothing sent."),
        "{}",
        e.message
    );
    assert!(d.orders().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_traders_limits_weigh_a_reverses_new_side_as_an_entry_and_never_its_close() {
    let d = desk(ProtectionMode::Grow).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.limits(RiskLimits {
        max_risk_per_trade: Some(500.0),
        max_order_qty: Some(2),
        ..RiskLimits::default()
    });
    let e = d
        .module
        .service()
        .reverse(&reverse_input(bracket("20680.00", "20580.00")), None)
        .await
        .unwrap_err();
    assert!(
        e.message
            .contains("over your $500 a trade. Nothing sent; the long 2 NQZ6 stays."),
        "{}",
        e.message
    );
    assert_eq!(d.position().await.unwrap().qty, Qty::from(2));
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    let e = d
        .module
        .service()
        .reverse(&reverse_input(None), None)
        .await
        .unwrap_err();
    assert!(e.message.contains("No stop"), "{}", e.message);
    d.module
        .service()
        .reverse(&reverse_input(bracket("20650.00", "20580.00")), None)
        .await
        .unwrap();
    assert_eq!(d.position().await.unwrap().qty, Qty::from(-2));
    d.legs_become(&[(SL, 2, "20650.00"), (TP, 2, "20580.00")])
        .await;
}

#[tokio::test(start_paused = true)]
async fn the_analysts_reverse_is_a_draft_and_the_users_own_is_an_armed_entry() {
    let d = desk(ProtectionMode::Grow).await;
    let mut registry = ToolRegistry::new();
    d.module.register_tools(&mut registry).unwrap();
    let inv = Invoker::new(
        Arc::new(registry),
        Arc::clone(&d.audit) as _,
        Arc::new(ManualClock::new(t0())) as SharedClock,
        InvokerConfig::default(),
    );
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    let agent = Origin::Agent {
        session_id: SessionId::new("S1"),
        provider: "codex".into(),
    };
    let input = json!({
        "accountId": ACCOUNT,
        "instrument": "NQZ6.CME",
        "bracket": { "stopLoss": "20680.00", "takeProfit": "20580.00" },
    });
    let mut req = InvokeRequest::new("orders.reverse", input.clone(), agent);
    req.surface = SurfaceState {
        armed: true,
        hold_confirmed: true,
    };
    let r = inv.invoke(req).await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    let pending = r.approval.clone().unwrap();
    let approval = inv.approvals().get(&pending.approval_id).unwrap();
    assert_eq!(
        approval.preview["restatement"],
        "Reverse the long 2 NQZ6 on Paper: cancel 2 orders, sell 2 at market to close, then sell \
         2 at market with stop 20,680.00 and target 20,580.00"
    );
    assert_eq!(d.position().await.unwrap().qty, Qty::from(2), "a draft");
    let done = inv
        .resolve(
            &ApprovalsResolveParams {
                approval_id: pending.approval_id,
                decision: ApprovalDecision::Approve,
                preview_hash: pending.preview_hash,
                note: None,
                input: None,
                deadline: None,
                idempotency_key: None,
            },
            &Origin::User,
        )
        .await
        .unwrap();
    assert!(done.result.unwrap().ok);
    assert_eq!(d.position().await.unwrap().qty, Qty::from(-2));
    d.legs_become(&[(SL, 2, "20680.00"), (TP, 2, "20580.00")])
        .await;
    let back = json!({
        "accountId": ACCOUNT,
        "instrument": "NQZ6.CME",
        "bracket": { "stopLoss": "20600.00", "takeProfit": "20700.00" },
    });
    let mut req = InvokeRequest::new("orders.reverse", back.clone(), Origin::User);
    req.surface = SurfaceState::default();
    assert_eq!(inv.invoke(req).await.status, ToolOutcome::PendingApproval);
    let mut req = InvokeRequest::new("orders.reverse", back, Origin::User);
    req.surface = SurfaceState {
        armed: true,
        hold_confirmed: false,
    };
    let r = inv.invoke(req).await;
    assert_eq!(r.status, ToolOutcome::Ok, "{r:?}");
    assert_eq!(d.position().await.unwrap().qty, Qty::from(2));
}

#[tokio::test(start_paused = true)]
async fn the_daily_loss_limit_flattens_the_account_and_locks_entries_until_the_next_session() {
    let d = desk(ProtectionMode::PerEntry).await;
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20500.00", "20800.00"),
    )
    .await;
    d.send(
        Side::Buy,
        1,
        OrderType::Limit,
        Some("20400.00"),
        bracket("20300.00", "20500.00"),
    )
    .await;
    d.limits(RiskLimits {
        daily_loss_limit: Some(500.0),
        ..RiskLimits::default()
    });
    let svc = d.module.service();
    let account = AccountId::new(ACCOUNT);
    assert!(matches!(
        svc.watch_loss_limit(&account).await,
        LossWatch::Clear
    ));

    d.print("20620.00").await;
    let latest = Mutex::new(LossWatch::Clear);
    let (svc_ref, account_ref, latest_ref) = (&svc, &account, &latest);
    settle_async(
        "the daily loss limit holds",
        move || async move {
            let watched = svc_ref.watch_loss_limit(account_ref).await;
            let seen = format!("{watched:?}");
            *latest_ref.lock() = watched;
            seen
        },
        |_| matches!(*latest_ref.lock(), LossWatch::Held { .. }),
    )
    .await;
    let LossWatch::Held { lock, fresh, flat } = latest.into_inner() else {
        panic!("2 NQ 21 points down is over the $500 limit");
    };
    assert!(fresh);
    assert_eq!(
        lock.until,
        Timestamp::parse("2026-10-04T18:00:00-04:00").unwrap()
    );
    let flat = flat.expect("flattened at once");
    let notes = svc.loss_lock_held(&lock, &flat);
    assert_eq!(
        notes.len(),
        1,
        "one note for the chart of the contract it closed"
    );
    let (instruments, out) = (flat.instruments, flat.result);
    let out = out.unwrap();
    assert!(out.flat);
    assert_eq!(instruments, [nq()]);
    assert_eq!(out.closing.len(), 1, "one reduce-only market close");
    assert!(d.position().await.is_none_or(|p| p.qty.is_zero()));
    assert!(
        d.orders().await.iter().all(|o| !o.status.is_open()),
        "the bracket and the resting limit are cancelled"
    );
    assert!(
        d.audit
            .finished
            .lock()
            .iter()
            .any(|r| r.tool == PROTECT_TOOL
                && r.summary.as_deref().is_some_and(|s| s.starts_with(
                    "Daily loss limit reached: Tessera cancelled the working orders and closed the \
                 positions. New entries wait for the next session at Sun 18:00"
                ))),
        "audited as Tessera's own action"
    );

    let refused = |e: tessera_tools::ToolError| e.message;
    let e = refused(
        svc.submit(&d.input(Side::Buy, 1, None), None, None)
            .await
            .unwrap_err(),
    );
    assert_eq!(
        e,
        "Paper (Tessera Paper): Your $500 daily loss limit was reached at 14:42: Tessera closed \
         the account's positions. New entries wait for the next session at Sun 18:00. Exits work."
    );
    d.limits(RiskLimits::default());
    assert!(
        svc.submit(&d.input(Side::Sell, 1, None), None, None)
            .await
            .is_err(),
        "turning the limit off does not lift the lock"
    );
    let shown = svc.accounts().await.unwrap();
    let limits = shown
        .iter()
        .find(|u| u.account.id == account)
        .and_then(|u| u.limits.clone())
        .expect("the lock shows with no limit on");
    assert!(limits.locked);
    assert_eq!(limits.locked_until, Some(lock.until));

    let sunday = Timestamp::parse("2026-10-04T18:00:01-04:00").unwrap();
    d.clock.set(sunday);
    assert_eq!(svc.lift_ended_locks().await, std::slice::from_ref(&account));
    assert!(
        matches!(svc.watch_loss_limit(&account).await, LossWatch::Clear),
        "Friday's loss does not lock Sunday's session"
    );
    let resting = OrderInput {
        order_type: OrderType::Limit,
        limit_price: Some(p("20500.00")),
        ..d.input(Side::Buy, 1, None)
    };
    let sent = svc.submit(&resting, None, None).await;
    assert!(
        sent.is_ok(),
        "the next session takes entries again: {sent:?}"
    );
}

fn lock_for(minutes: u32) -> LockAccountInput {
    LockAccountInput {
        account_id: ACCOUNT.into(),
        span: LockSpan::Minutes { minutes },
        instrument: Some("NQZ6.CME".into()),
    }
}

#[tokio::test(start_paused = true)]
async fn a_locked_account_refuses_entries_from_anyone_and_keeps_its_exits_and_stops() {
    let d = desk(ProtectionMode::PerEntry).await;
    let svc = d.module.service();
    d.send(
        Side::Buy,
        2,
        OrderType::Market,
        None,
        bracket("20600.00", "20700.00"),
    )
    .await;
    d.legs_become(&[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    let resting = d
        .send(Side::Buy, 1, OrderType::Limit, Some("20500.00"), None)
        .await
        .order;

    let user = tessera_tools::ToolCtx::new(Origin::User, t0());
    let out = svc.lock_account(&user, &lock_for(30)).await.unwrap();
    assert!(out.extended);
    assert_eq!(
        out.cancelled,
        std::slice::from_ref(&resting.id),
        "the waiting entry"
    );
    assert_eq!(
        out.summary,
        "Locked new entries until 15:12; cancelled 1 working entry"
    );
    assert_eq!(out.lock.kind, LockKind::Manual);
    assert!(!out.lock.liftable, "early unlock is off by default");
    let words = "Trading on this account is locked since 14:42, until 15:12: no new entries. \
                 Exits, stops and targets work.";
    assert_eq!(out.lock.words, words);

    let e = svc
        .submit(&d.input(Side::Buy, 1, None), None, None)
        .await
        .unwrap_err();
    assert_eq!(e.message, format!("Paper (Tessera Paper): {words}"));
    assert_eq!(e.details.unwrap()["code"], "account_locked");
    let preview = svc.preview(&d.input(Side::Buy, 1, None)).await.unwrap();
    assert!(
        preview
            .checks
            .iter()
            .any(|c| c.code == "account_locked" && c.severity == CheckSeverity::Block),
        "the ticket says why before sending: {preview:?}"
    );
    d.move_stop("20610.00").await;
    d.legs_become(&[(SL, 2, "20610.00"), (TP, 2, "20700.00")])
        .await;
    d.send(Side::Sell, 1, OrderType::Market, None, None).await;
    assert_eq!(
        d.position().await.unwrap().qty,
        Qty::from(1),
        "an exit works"
    );

    let mut registry = ToolRegistry::new();
    d.module.register_tools(&mut registry).unwrap();
    let inv = Invoker::new(
        Arc::new(registry),
        Arc::clone(&d.audit) as _,
        Arc::clone(&d.clock) as SharedClock,
        InvokerConfig::default(),
    );
    let agent = Origin::Agent {
        session_id: SessionId::new("S1"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::FullAccess));
    let call = |name: &str, input: serde_json::Value| {
        let mut req = InvokeRequest::new(name, input, agent.clone());
        req.surface = SurfaceState {
            armed: true,
            hold_confirmed: true,
        };
        inv.invoke(req)
    };
    let r = call(
        "orders.submit",
        json!({ "accountId": ACCOUNT, "instrument": "NQZ6.CME", "side": "buy", "qty": 1, "orderType": "market" }),
    )
    .await;
    assert_eq!(r.status, ToolOutcome::Error, "{r:?}");
    assert_eq!(
        r.error.unwrap().message,
        format!("Paper (Tessera Paper): {words}"),
        "the agent is told why, in words it can relay"
    );
    let r = call("risk.get_lock", json!({ "accountId": ACCOUNT })).await;
    assert_eq!(r.output.unwrap()["lock"]["words"], words);
    let r = call(
        "risk.lock_account",
        json!({ "accountId": ACCOUNT, "span": { "kind": "minutes", "minutes": 5 } }),
    )
    .await;
    assert_eq!(r.status, ToolOutcome::Ok, "{r:?}");
    assert_eq!(
        r.output.unwrap()["summary"],
        "Already locked until 15:12: a lock is never shortened"
    );
    let r = call(
        "risk.unlock_account",
        json!({ "accountId": ACCOUNT, "confirm": "UNLOCK" }),
    )
    .await;
    assert_eq!(r.status, ToolOutcome::Denied, "an agent never lifts a lock");
    assert!(svc.lock_of(&AccountId::new(ACCOUNT)).is_some());

    let unlock = |confirm: &str| UnlockAccountInput {
        account_id: ACCOUNT.into(),
        confirm: confirm.into(),
    };
    let e = svc
        .unlock_account(&Origin::User, &unlock("UNLOCK"))
        .await
        .unwrap_err();
    assert!(
        e.message
            .ends_with("Lifting a lock early is off (Settings › Trading and risk).")
    );
    svc.set_limits(LimitsSetting {
        allow_early_unlock: true,
        ..LimitsSetting::default()
    });
    let e = svc
        .unlock_account(&Origin::User, &unlock("unlock please"))
        .await
        .unwrap_err();
    assert_eq!(e.message, "Type UNLOCK to lift the lock. It still holds.");
    svc.unlock_account(&Origin::User, &unlock("UNLOCK"))
        .await
        .unwrap();
    assert!(
        svc.submit(&d.input(Side::Buy, 1, None), None, None)
            .await
            .is_ok()
    );

    svc.lock_account(&user, &lock_for(5)).await.unwrap();
    assert!(
        svc.submit(&d.input(Side::Buy, 1, None), None, None)
            .await
            .is_err()
    );
    d.clock.set(t0().add_nanos(6 * 60 * 1_000_000_000));
    assert_eq!(
        svc.lift_ended_locks().await,
        [AccountId::new(ACCOUNT)],
        "the account's chip updates when the lock ends"
    );
    assert_eq!(svc.lock_of(&AccountId::new(ACCOUNT)), None);
    let shown = svc.accounts().await.unwrap();
    assert!(
        shown
            .iter()
            .all(|u| u.limits.as_ref().is_none_or(|l| !l.locked)),
        "{shown:?}"
    );
}
