use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_broker::paper::{AccountSeed, PaperBroker, PaperConfig, test_seeds};
use tessera_broker::{
    BrokerConnection, BrokerError, BrokerEvent, BrokerModule, BrokerProvider, BrokerSystem,
    OrderChanges, Verified,
};
use tessera_core::accounts::{AccountSummary, Environment, RiskStatus, TradingAccount};
use tessera_core::capabilities::{BrokerCapabilities, MarketCapabilities};
use tessera_core::clock::ManualClock;
use tessera_core::health::ProviderHealth;
use tessera_core::ids::{AccountId, DraftId, OrderId, SessionId};
use tessera_core::instrument::{AssetClass, ContractSpec, ExchangeContract, Instrument};
use tessera_core::limits::{LimitsSetting, RiskLimits};
use tessera_core::market::{Quote, Trade};
use tessera_core::orders::{
    Bracket, Fill, Order, OrderPreview, OrderRequest, OrderRole, OrderType, Position, Side,
    TimeInForce,
};
use tessera_core::{InstrumentId, Origin, Qty, SharedClock, Timeframe, Timestamp};
use tessera_host::{EventBus, RuntimeModule};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream, MockConfig,
    MockMarket,
};
use tessera_protocol::methods::ApprovalsResolveParams;
use tessera_protocol::tools::{ApprovalDecision, ToolErrorCode, ToolOutcome, ToolResult};
use tessera_store::Store;
use tessera_tools::approvals::ApprovalError;
use tessera_tools::{
    InvokeRequest, Invoker, InvokerConfig, MemoryObserver, ResolveError, SurfaceState, ToolRegistry,
};

fn t0() -> Timestamp {
    Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap()
}

struct SlowMarket {
    inner: MockMarket,
    slow: AtomicBool,
}

#[async_trait]
impl MarketDataProvider for SlowMarket {
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
    fn prices_flowing(&self) -> bool {
        self.inner.prices_flowing()
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
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        if self.slow.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_secs(40)).await;
        }
        self.inner.quote(i).await
    }
    fn subscribe_quotes(&self, i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.inner.subscribe_quotes(i)
    }
    fn subscribe_trades(&self, i: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.inner.subscribe_trades(i)
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.inner.subscribe_bars(i, tf)
    }
}

struct H {
    inv: Invoker,
    obs: Arc<MemoryObserver>,
    market: Arc<SlowMarket>,
    module: BrokerModule,
    clock: Arc<ManualClock>,
}

fn market(clock: SharedClock) -> Arc<SlowMarket> {
    let mut cfg = MockConfig::new(clock);
    cfg.intraday_sessions = 1;
    cfg.daily_sessions = 5;
    Arc::new(SlowMarket {
        inner: MockMarket::new(cfg),
        slow: AtomicBool::new(false),
    })
}

fn funded_seeds() -> Vec<AccountSeed> {
    test_seeds()
        .into_iter()
        .map(|s| AccountSeed {
            balance: rust_decimal::Decimal::from(10_000_000),
            ..s
        })
        .collect()
}

async fn harness_with(store: Option<Store>) -> H {
    let manual = Arc::new(ManualClock::new(t0()));
    let clock: SharedClock = Arc::clone(&manual) as SharedClock;
    let market = market(Arc::clone(&clock));
    let module = BrokerModule::paper_seeded(
        Arc::clone(&market) as Arc<dyn MarketDataProvider>,
        Arc::clone(&clock),
        store,
        PaperConfig::default(),
        Arc::new(EventBus::new()),
        &funded_seeds(),
    )
    .await
    .unwrap();
    let mut registry = ToolRegistry::new();
    module.register_tools(&mut registry).unwrap();
    let obs = Arc::new(MemoryObserver::default());
    let inv = Invoker::new(
        Arc::new(registry),
        obs.clone(),
        clock,
        InvokerConfig::default(),
    );
    H {
        inv,
        obs,
        market,
        module,
        clock: manual,
    }
}

async fn harness() -> H {
    harness_with(Some(Store::open_in_memory().unwrap())).await
}

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S1"),
        provider: "codex".into(),
    }
}

fn buy_nq(account: &str, qty: u32) -> Value {
    json!({
        "accountId": account,
        "instrument": "NQ",
        "side": "buy",
        "qty": qty,
        "orderType": "market",
        "bracket": { "stopLoss": 20630, "takeProfit": 20700 },
    })
}

fn call(name: &str, input: Value, origin: Origin, surface: SurfaceState) -> InvokeRequest {
    let mut r = InvokeRequest::new(name, input, origin);
    r.surface = surface;
    r
}

const ARMED: SurfaceState = SurfaceState {
    armed: true,
    hold_confirmed: false,
};
const HELD: SurfaceState = SurfaceState {
    armed: false,
    hold_confirmed: true,
};
const COVERED: SurfaceState = SurfaceState {
    armed: false,
    hold_confirmed: false,
};

async fn orders(h: &H, account: &str) -> Vec<tessera_core::orders::Order> {
    h.module
        .paper_broker()
        .orders(&AccountId::new(account))
        .await
        .unwrap()
}

async fn positions(h: &H, account: &str) -> Vec<tessera_core::orders::Position> {
    h.module
        .paper_broker()
        .positions(&AccountId::new(account))
        .await
        .unwrap()
}

fn approve(r: &ToolResult) -> ApprovalsResolveParams {
    let p = r.approval.clone().expect("a pending approval");
    ApprovalsResolveParams {
        approval_id: p.approval_id,
        decision: ApprovalDecision::Approve,
        preview_hash: p.preview_hash,
        note: None,
        input: None,
        deadline: None,
        idempotency_key: None,
    }
}

#[tokio::test]
async fn the_agent_never_executes_whatever_it_claims() {
    let h = harness().await;
    for (tool, input) in [
        ("orders.submit", buy_nq("paper-main", 1)),
        ("orders.create_draft", buy_nq("eval-50k", 1)),
        ("orders.flatten", json!({ "accountId": "paper-main" })),
        ("orders.cancel_all", json!({ "accountId": "eval-50k" })),
    ] {
        let r = h
            .inv
            .invoke(call(
                tool,
                input,
                agent(),
                SurfaceState {
                    armed: true,
                    hold_confirmed: true,
                },
            ))
            .await;
        assert_eq!(r.status, ToolOutcome::PendingApproval, "{tool}: {r:?}");
        assert!(r.approval.as_ref().unwrap().draft_id.is_some(), "{tool}");
    }
    assert!(
        orders(&h, "paper-main").await.is_empty(),
        "nothing reached the broker"
    );
    assert!(orders(&h, "eval-50k").await.is_empty());
    let draft = h.obs.drafts.lock()[0].clone();
    assert_eq!(draft.account, "paper-main");
    assert_eq!(
        draft.environment,
        Some(tessera_core::accounts::Environment::Paper)
    );
    assert_eq!(
        draft.preview["restatement"], "BUY 1 NQZ6 MKT DAY",
        "the symbol resolved to the front contract"
    );
    assert_eq!(draft.preview["environment"], "paper");
}

#[tokio::test]
async fn the_agent_cannot_approve_its_own_draft_and_the_users_approval_sends_it_once() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 2),
            agent(),
            COVERED,
        ))
        .await;
    let params = approve(&r);
    let e = h.inv.resolve(&params, &agent()).await.unwrap_err();
    assert_eq!(e, ResolveError::Approval(ApprovalError::SelfApproval));
    let other = Origin::External {
        client_id: "claude-desktop".into(),
    };
    let e = h.inv.resolve(&params, &other).await.unwrap_err();
    assert_eq!(e, ResolveError::Approval(ApprovalError::NotUser));
    assert!(orders(&h, "paper-main").await.is_empty());

    let done = h.inv.resolve(&params, &Origin::User).await.unwrap();
    let result = done.result.unwrap();
    assert!(result.ok, "{result:?}");
    let out = result.output.unwrap();
    assert_eq!(out["order"]["status"], "filled");
    assert_eq!(out["order"]["draftId"], json!(r.approval.unwrap().draft_id));
    assert_eq!(out["bracket"].as_array().unwrap().len(), 2);
    let pos = positions(&h, "paper-main").await;
    assert_eq!(pos[0].qty, tessera_core::Qty::from(2));
    assert!(h.inv.resolve(&params, &Origin::User).await.is_err());
    let entries = orders(&h, "paper-main")
        .await
        .into_iter()
        .filter(|o| o.parent_id.is_none())
        .count();
    assert_eq!(entries, 1);
    let last = h.obs.drafts.lock().last().cloned().unwrap();
    assert_eq!(last.status, tessera_core::orders::DraftStatus::Submitted);
}

const NO_LIVE_PRICES: &str = "Mock market dropped and is reconnecting. New market orders wait until its \
                              prices are back; Flat, closes and Reverse still go. Nothing sent.";

fn nq_market(side: &str, qty: u32) -> Value {
    json!({ "accountId": "paper-main", "instrument": "NQ", "side": side, "qty": qty, "orderType": "market" })
}

async fn as_user(h: &H, tool: &str, input: Value) -> ToolResult {
    h.inv.invoke(call(tool, input, Origin::User, ARMED)).await
}

async fn held(h: &H) -> Option<tessera_core::Qty> {
    positions(h, "paper-main").await.first().map(|p| p.qty)
}

#[tokio::test]
async fn an_approved_market_draft_waits_while_its_prices_are_down_and_goes_once_they_are_back() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            agent(),
            COVERED,
        ))
        .await;
    let params = approve(&r);

    h.market.inner.set_outage(true);
    let e = h.inv.resolve(&params, &Origin::User).await.unwrap_err();
    let ResolveError::NotReady(refused) = &e else {
        panic!("{e:?}")
    };
    assert_eq!(refused.code, ToolErrorCode::Rejected);
    assert_eq!(e.to_string(), NO_LIVE_PRICES);
    assert!(
        orders(&h, "paper-main").await.is_empty(),
        "nothing reached the broker"
    );

    h.market.inner.set_outage(false);
    let done = h.inv.resolve(&params, &Origin::User).await.unwrap();
    let result = done.result.unwrap();
    assert!(result.ok, "the same approval goes: {result:?}");
    assert_eq!(held(&h).await, Some(tessera_core::Qty::from(1)));
}

const PAPER_NO_LIVE_PRICE: &str = "No live price for NQZ6 since 14:42. Nothing sent.";

#[tokio::test]
async fn while_prices_are_down_the_gate_holds_opening_market_orders_and_paper_fills_none() {
    let h = harness().await;
    let went = |r: &ToolResult| r.ok && r.status == ToolOutcome::Ok;
    let refusal = |r: &ToolResult| {
        r.error
            .clone()
            .unwrap_or_else(|| panic!("went: {r:?}"))
            .message
    };
    assert!(went(
        &as_user(&h, "orders.submit", nq_market("buy", 2)).await
    ));
    let instrument = positions(&h, "paper-main").await[0].instrument.to_string();
    h.market.inner.set_outage(true);

    for (side, qty) in [("buy", 1), ("sell", 3)] {
        let r = as_user(&h, "orders.submit", nq_market(side, qty)).await;
        let e = r
            .error
            .clone()
            .unwrap_or_else(|| panic!("{side} {qty} went: {r:?}"));
        assert_eq!(e.code, ToolErrorCode::Rejected);
        assert!(e.message.ends_with(NO_LIVE_PRICES), "{}", e.message);
    }
    assert_eq!(
        held(&h).await,
        Some(tessera_core::Qty::from(2)),
        "nothing opened"
    );

    let close = as_user(&h, "orders.submit", nq_market("sell", 1)).await;
    assert!(
        refusal(&close).ends_with(PAPER_NO_LIVE_PRICE),
        "a close passes the gate and Paper has no live price to fill it at: {}",
        refusal(&close)
    );
    let reversed = as_user(
        &h,
        "orders.reverse",
        json!({ "accountId": "paper-main", "instrument": instrument }),
    )
    .await;
    assert!(
        refusal(&reversed).contains(PAPER_NO_LIVE_PRICE),
        "{}",
        refusal(&reversed)
    );
    let limit = json!({
        "accountId": "paper-main", "instrument": "NQ", "side": "buy", "qty": 1,
        "orderType": "limit", "limitPrice": 20000,
    });
    assert!(
        went(&as_user(&h, "orders.submit", limit).await),
        "a limit goes"
    );
    let flat = as_user(&h, "orders.flatten", json!({ "accountId": "paper-main" })).await;
    assert!(
        refusal(&flat).contains(PAPER_NO_LIVE_PRICE),
        "{}",
        refusal(&flat)
    );
    assert_eq!(
        held(&h).await,
        Some(tessera_core::Qty::from(2)),
        "nothing filled at the price from before the drop"
    );

    h.market.inner.set_outage(false);
    let flat = as_user(&h, "orders.flatten", json!({ "accountId": "paper-main" })).await;
    assert!(went(&flat), "Flatten goes once prices are back: {flat:?}");
    assert_eq!(held(&h).await, None);
}

#[tokio::test]
async fn the_user_sends_armed_on_paper_after_the_hold_on_eval_and_exits_are_never_covered() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            Origin::User,
            COVERED,
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval);
    h.inv
        .resolve(
            &ApprovalsResolveParams {
                decision: ApprovalDecision::Reject,
                ..approve(&r)
            },
            &Origin::User,
        )
        .await
        .unwrap();
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok && r.status == ToolOutcome::Ok, "{r:?}");

    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("eval-50k", 1),
            Origin::User,
            ARMED,
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    h.inv
        .resolve(
            &ApprovalsResolveParams {
                decision: ApprovalDecision::Reject,
                ..approve(&r)
            },
            &Origin::User,
        )
        .await
        .unwrap();
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("eval-50k", 1),
            Origin::User,
            HELD,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    assert_eq!(positions(&h, "eval-50k").await.len(), 1);

    let r = h
        .inv
        .invoke(call(
            "orders.create_draft",
            buy_nq("paper-main", 1),
            Origin::User,
            SurfaceState {
                armed: true,
                hold_confirmed: true,
            },
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval);

    let r = h
        .inv
        .invoke(call(
            "orders.flatten",
            json!({ "accountId": "eval-50k" }),
            Origin::User,
            COVERED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let out = r.output.unwrap();
    assert_eq!(out["flat"], true);
    assert_eq!(out["closing"][0]["status"], "filled");
    assert_eq!(out["closing"][0]["request"]["reduceOnly"], true);
    assert_eq!(
        out["cancelled"].as_array().unwrap().len(),
        2,
        "its stop and target"
    );
    assert!(positions(&h, "eval-50k").await.is_empty());
}

#[tokio::test]
async fn only_the_traders_own_limits_refuse_for_risk_and_before_anything_is_sent() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.preview",
            buy_nq("eval-50k", 20),
            Origin::User,
            COVERED,
        ))
        .await;
    assert_eq!(r.output.unwrap()["checks"], json!([]));
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("eval-50k", 20),
            Origin::User,
            HELD,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let r = h
        .inv
        .invoke(call(
            "orders.flatten",
            json!({ "accountId": "eval-50k" }),
            Origin::User,
            COVERED,
        ))
        .await;
    assert!(r.ok, "{r:?}");

    h.module.service().set_limits(LimitsSetting {
        every: RiskLimits {
            daily_loss_limit: Some(1000.0),
            max_risk_per_trade: Some(500.0),
            max_order_qty: Some(10),
            ..RiskLimits::default()
        },
        ..LimitsSetting::default()
    });
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("eval-50k", 4),
            Origin::User,
            HELD,
        ))
        .await;
    assert!(!r.ok);
    let e = r.error.unwrap();
    assert_eq!(e.code, ToolErrorCode::Rejected);
    assert_eq!(
        e.message,
        "Eval 50K (Tessera Paper): This stop risks $920: over your $500 a trade."
    );
    let details = e.details.unwrap();
    assert_eq!(details["sent"], false);
    assert_eq!(details["code"], "limit_risk_per_trade");
    let before = orders(&h, "eval-50k").await.len();
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("eval-50k", 12),
            Origin::User,
            HELD,
        ))
        .await;
    assert_eq!(
        r.error.unwrap().message,
        "Eval 50K (Tessera Paper): 12 contracts: over your 10 contracts an order."
    );
    let mut naked = buy_nq("eval-50k", 1);
    naked.as_object_mut().unwrap().remove("bracket");
    let r = h
        .inv
        .invoke(call("orders.submit", naked, Origin::User, HELD))
        .await;
    assert_eq!(
        r.error.unwrap().message,
        "Eval 50K (Tessera Paper): No stop: your $500 a trade is measured at the stop. Add one."
    );
    assert_eq!(
        orders(&h, "eval-50k").await.len(),
        before,
        "nothing was sent"
    );

    let r = h
        .inv
        .invoke(call(
            "orders.preview",
            buy_nq("eval-50k", 4),
            Origin::User,
            COVERED,
        ))
        .await;
    let out = r.output.unwrap();
    assert_eq!(out["checks"][0]["severity"], "block");
    assert_eq!(out["checks"][0]["code"], "limit_risk_per_trade");
    let r = h
        .inv
        .invoke(call(
            "orders.preview",
            buy_nq("eval-50k", 2),
            Origin::User,
            COVERED,
        ))
        .await;
    let out = r.output.unwrap();
    assert_eq!(out["checks"][0]["severity"], "warn");
    assert_eq!(
        out["checks"][0]["message"],
        "This stop risks $460 of your $500 a trade."
    );

    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("eval-50k", 1),
            Origin::User,
            HELD,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let accounts = h
        .inv
        .invoke(call("risk.get_limits", json!({}), agent(), COVERED))
        .await;
    let out = accounts.output.unwrap();
    let eval = out["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["accountId"] == "eval-50k")
        .unwrap()
        .clone();
    assert_eq!(eval["status"]["dailyLossLimit"]["amount"], 1000);
    assert_eq!(eval["status"]["maxRiskPerTrade"]["amount"], 500);
    assert_eq!(eval["status"]["locked"], false);
    assert_eq!(out["setting"]["every"]["maxOrderQty"], 10);

    h.module.service().set_limits(LimitsSetting::default());
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("eval-50k", 4),
            Origin::User,
            HELD,
        ))
        .await;
    assert!(r.ok, "{r:?}");
}

#[tokio::test]
async fn a_stop_moved_past_a_limit_is_refused_and_tightening_never_is() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let stop = orders(&h, "paper-main")
        .await
        .into_iter()
        .find(|o| o.role == tessera_core::orders::OrderRole::StopLoss && o.status.is_open())
        .expect("its stop works");
    h.module.service().set_limits(LimitsSetting {
        every: RiskLimits {
            max_risk_per_trade: Some(300.0),
            ..RiskLimits::default()
        },
        ..LimitsSetting::default()
    });
    let modify = |price: f64| {
        call(
            "orders.modify",
            json!({ "accountId": "paper-main", "orderId": stop.id, "stopPrice": price }),
            Origin::User,
            ARMED,
        )
    };
    let r = h.inv.invoke(modify(20620.0)).await;
    assert_eq!(
        r.error.unwrap().message,
        "Paper (Tessera Paper): The stop there risks $430 from your entry: over your $300 a trade. \
         The stop stays at 20,630.00."
    );
    let r = h.inv.invoke(modify(20635.0)).await;
    assert!(r.ok, "tightening always goes: {r:?}");
    h.module.service().set_limits(LimitsSetting::default());
    let r = h.inv.invoke(modify(20600.0)).await;
    assert!(r.ok, "{r:?}");
}

#[tokio::test]
async fn a_plain_resting_limit_moves_where_it_is_dragged_and_grows_no_legs() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            json!({
                "accountId": "paper-main",
                "instrument": "NQ",
                "side": "buy",
                "qty": 1,
                "orderType": "limit",
                "limitPrice": 20600,
            }),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let entry = r.output.unwrap()["order"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let r = h
        .inv
        .invoke(call(
            "orders.modify",
            json!({ "accountId": "paper-main", "orderId": entry, "limitPrice": 20604 }),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let all = orders(&h, "paper-main").await;
    assert_eq!(all.len(), 1, "a plain limit has no stop or target: {all:?}");
    assert_eq!(all[0].id.as_str(), entry);
    assert!(all[0].status.is_open());
    assert!(all[0].request.bracket.is_none());
    assert_eq!(
        all[0].request.limit_price,
        Some(tessera_core::Price(Decimal::from(20604)))
    );
}

#[tokio::test]
async fn a_resized_entry_that_moves_is_weighed_with_its_stop_where_it_goes() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            json!({
                "accountId": "paper-main",
                "instrument": "NQ",
                "side": "buy",
                "qty": 1,
                "orderType": "limit",
                "limitPrice": 20600,
                "bracket": { "stopLoss": 20590, "takeProfit": 20700 },
            }),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let entry = r.output.unwrap()["order"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    h.module.service().set_limits(LimitsSetting {
        every: RiskLimits {
            max_risk_per_trade: Some(450.0),
            ..RiskLimits::default()
        },
        ..LimitsSetting::default()
    });
    let r = h
        .inv
        .invoke(call(
            "orders.modify",
            json!({ "accountId": "paper-main", "orderId": entry, "qty": 2, "limitPrice": 20620 }),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(
        r.ok,
        "two contracts 10 points from the stop risk $400: {r:?}"
    );
    let stop = orders(&h, "paper-main")
        .await
        .into_iter()
        .find(|o| o.role == tessera_core::orders::OrderRole::StopLoss)
        .expect("its stop is held");
    assert_eq!(
        stop.request.stop_price,
        Some(tessera_core::Price(rust_decimal::Decimal::from(20610)))
    );
}

#[tokio::test]
async fn the_daily_loss_limit_reached_leaves_exits_only() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 2),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    h.module.service().set_limits(LimitsSetting {
        every: RiskLimits {
            daily_loss_limit: Some(1.0),
            ..RiskLimits::default()
        },
        ..LimitsSetting::default()
    });
    let summary = h
        .module
        .paper_broker()
        .summary(&AccountId::new("paper-main"))
        .await
        .unwrap();
    assert!(
        summary.day_pnl.amount < rust_decimal::Decimal::from(-1),
        "{summary:?}"
    );
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            Origin::User,
            ARMED,
        ))
        .await;
    assert_eq!(
        r.error.unwrap().message,
        "Paper (Tessera Paper): Your $1 daily loss limit is reached: no new positions today. Exits work."
    );
    let r = h
        .inv
        .invoke(call(
            "orders.flatten",
            json!({ "accountId": "paper-main" }),
            Origin::User,
            COVERED,
        ))
        .await;
    assert!(r.ok, "an exit always goes: {r:?}");
    assert!(positions(&h, "paper-main").await.is_empty());
}

struct FirmUnreadable {
    inner: Arc<dyn BrokerProvider>,
    on: AtomicBool,
}

#[async_trait]
impl BrokerProvider for FirmUnreadable {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn capabilities(&self) -> BrokerCapabilities {
        self.inner.capabilities()
    }
    fn system(&self) -> BrokerSystem {
        self.inner.system()
    }
    fn health(&self) -> ProviderHealth {
        self.inner.health()
    }
    async fn connection_of(&self, a: &AccountId) -> Result<BrokerConnection, BrokerError> {
        self.inner.connection_of(a).await
    }
    fn environment_of(&self, a: &AccountId) -> Option<Environment> {
        self.inner.environment_of(a)
    }
    fn order_of(&self, o: &OrderId) -> Option<Order> {
        self.inner.order_of(o)
    }
    fn account_order_entry(&self) -> Option<Vec<AccountId>> {
        self.inner.account_order_entry()
    }
    async fn contract_for(
        &self,
        a: &AccountId,
        want: &ExchangeContract,
    ) -> Result<Option<(Instrument, ContractSpec)>, BrokerError> {
        self.inner.contract_for(a, want).await
    }
    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        self.inner.accounts().await
    }
    async fn summary(&self, a: &AccountId) -> Result<AccountSummary, BrokerError> {
        self.inner.summary(a).await
    }
    async fn positions(&self, a: &AccountId) -> Result<Vec<Position>, BrokerError> {
        self.inner.positions(a).await
    }
    async fn orders(&self, a: &AccountId) -> Result<Vec<Order>, BrokerError> {
        self.inner.orders(a).await
    }
    async fn fills(&self, a: &AccountId, since: Timestamp) -> Result<Vec<Fill>, BrokerError> {
        self.inner.fills(a, since).await
    }
    async fn preview(&self, request: &OrderRequest) -> Result<OrderPreview, BrokerError> {
        self.inner.preview(request).await
    }
    async fn risk(&self, a: &AccountId) -> Result<Option<RiskStatus>, BrokerError> {
        if self.on.load(Ordering::SeqCst) {
            return Err(BrokerError::Unavailable("risk system not answering".into()));
        }
        self.inner.risk(a).await
    }
    async fn submit(
        &self,
        verified: &Verified,
        request: OrderRequest,
        draft: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        self.inner.submit(verified, request, draft).await
    }
    async fn modify(
        &self,
        verified: &Verified,
        order: &OrderId,
        changes: OrderChanges,
    ) -> Result<Order, BrokerError> {
        self.inner.modify(verified, order, changes).await
    }
    async fn cancel(&self, verified: &Verified, order: &OrderId) -> Result<Order, BrokerError> {
        self.inner.cancel(verified, order).await
    }
    async fn attach_bracket(
        &self,
        verified: &Verified,
        entry: &OrderId,
        bracket: Bracket,
        qty: Qty,
    ) -> Result<Vec<Order>, BrokerError> {
        self.inner
            .attach_bracket(verified, entry, bracket, qty)
            .await
    }
    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        self.inner.events()
    }
}

async fn firm_limits_harness() -> (H, Arc<FirmUnreadable>) {
    let h = harness().await;
    let brokers = h.module.brokers();
    let id = h.module.paper_broker().id().to_owned();
    let firm = Arc::new(FirmUnreadable {
        inner: brokers.remove(&id).unwrap(),
        on: AtomicBool::new(false),
    });
    brokers
        .add(Arc::clone(&firm) as Arc<dyn BrokerProvider>)
        .unwrap();
    h.module.service().set_limits(LimitsSetting {
        use_firm_limits: true,
        ..LimitsSetting::default()
    });
    (h, firm)
}

const FIRM_UNREADABLE: &str = "Paper (Tessera Paper): Your limits cannot be checked now: \
                               unavailable: risk system not answering. Nothing sent.";

#[tokio::test]
async fn an_order_that_opens_risk_is_refused_while_the_firms_limits_cannot_be_read() {
    let (h, firm) = firm_limits_harness().await;
    firm.on.store(true, Ordering::SeqCst);
    let r = as_user(&h, "orders.submit", buy_nq("paper-main", 1)).await;
    assert!(!r.ok, "{r:?}");
    let e = r.error.unwrap();
    assert_eq!(e.code, ToolErrorCode::Unavailable);
    assert_eq!(e.message, FIRM_UNREADABLE);
    assert!(
        orders(&h, "paper-main").await.is_empty(),
        "nothing was sent"
    );
    assert_eq!(held(&h).await, None);
}

#[tokio::test]
async fn exits_and_protective_stops_go_while_the_firms_limits_cannot_be_read_and_loosening_waits() {
    let (h, firm) = firm_limits_harness().await;
    let r = as_user(&h, "orders.submit", nq_market("buy", 3)).await;
    assert!(r.ok, "{r:?}");
    let protective_stop = || {
        json!({
            "accountId": "paper-main",
            "instrument": "NQ",
            "side": "sell",
            "qty": 3,
            "orderType": "stop",
            "stopPrice": 20600,
            "reduceOnly": true,
        })
    };
    let stop = as_user(&h, "orders.submit", protective_stop()).await;
    assert!(stop.ok, "{stop:?}");
    let stop_id = stop.output.unwrap()["order"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    firm.on.store(true, Ordering::SeqCst);

    let r = as_user(&h, "orders.submit", protective_stop()).await;
    assert!(r.ok, "a stop that protects the position goes: {r:?}");
    let r = h
        .inv
        .invoke(call(
            "orders.modify",
            json!({ "accountId": "paper-main", "orderId": stop_id, "stopPrice": 20610 }),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "tightening a stop goes: {r:?}");
    let r = h
        .inv
        .invoke(call(
            "orders.modify",
            json!({ "accountId": "paper-main", "orderId": stop_id, "stopPrice": 20500 }),
            Origin::User,
            ARMED,
        ))
        .await;
    assert_eq!(
        r.error.unwrap().message,
        "Paper (Tessera Paper): Your limits cannot be checked now: \
         unavailable: risk system not answering. Nothing changed.",
        "loosening it adds risk the firm's limits must weigh"
    );
    let r = as_user(&h, "orders.submit", nq_market("sell", 1)).await;
    assert!(r.ok, "a reducing order goes: {r:?}");
    assert_eq!(held(&h).await, Some(Qty::from(2)));
    let r = as_user(&h, "orders.flatten", json!({ "accountId": "paper-main" })).await;
    assert!(r.ok, "an exit always goes: {r:?}");
    assert_eq!(held(&h).await, None);
}

#[tokio::test]
async fn an_order_that_opens_risk_goes_when_the_broker_reports_no_firm_limits() {
    let (h, _) = firm_limits_harness().await;
    let r = as_user(&h, "orders.submit", buy_nq("paper-main", 1)).await;
    assert!(r.ok, "{r:?}");
    assert_eq!(held(&h).await, Some(Qty::from(1)));
}

#[tokio::test]
async fn concurrent_armed_calls_with_one_key_send_one_order() {
    let h = harness().await;
    let mut a = call(
        "orders.submit",
        buy_nq("paper-main", 1),
        Origin::User,
        ARMED,
    );
    a.idempotency_key = Some("ladder-click-7".into());
    let b = a.clone();
    let (ra, rb) = tokio::join!(h.inv.invoke(a.clone()), h.inv.invoke(b));
    assert!(ra.ok && rb.ok, "{ra:?} {rb:?}");
    assert_eq!(
        ra.output.as_ref().unwrap()["order"]["id"],
        rb.output.as_ref().unwrap()["order"]["id"]
    );
    assert!(
        ra.deduped != rb.deduped,
        "one ran, the other heard its result"
    );
    let entries: Vec<_> = orders(&h, "paper-main")
        .await
        .into_iter()
        .filter(|o| o.parent_id.is_none())
        .collect();
    assert_eq!(entries.len(), 1, "one order, not two");
    assert_eq!(
        entries[0].request.client_order_id.as_deref(),
        Some("ladder-click-7")
    );
    assert_eq!(
        positions(&h, "paper-main").await[0].qty,
        tessera_core::Qty::from(1)
    );
    let again = h.inv.invoke(a.clone()).await;
    assert!(again.deduped && again.ok);
    a.idempotency_key = Some("ladder-click-8".into());
    assert!(h.inv.invoke(a).await.ok);
    assert_eq!(
        positions(&h, "paper-main").await[0].qty,
        tessera_core::Qty::from(2)
    );
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_execution_is_outcome_unknown_and_never_sent_again() {
    let h = harness_with(None).await;
    h.market.slow.store(true, Ordering::SeqCst);
    let mut c = call(
        "orders.submit",
        buy_nq("paper-main", 1),
        Origin::User,
        ARMED,
    );
    c.idempotency_key = Some("slow-1".into());
    let first = h.inv.invoke(c.clone()).await;
    assert!(!first.ok);
    let e = first.error.clone().unwrap();
    assert_eq!(e.code, ToolErrorCode::OutcomeUnknown, "{e:?}");
    assert!(!e.retryable);
    h.market.slow.store(false, Ordering::SeqCst);
    let repeat = h.inv.invoke(c.clone()).await;
    assert!(repeat.deduped);
    assert_eq!(repeat.error.unwrap().code, ToolErrorCode::OutcomeUnknown);
    tokio::time::sleep(Duration::from_secs(30)).await;
    let entries: Vec<_> = orders(&h, "paper-main")
        .await
        .into_iter()
        .filter(|o| o.parent_id.is_none())
        .collect();
    assert_eq!(entries.len(), 1);
    let late = h
        .obs
        .finished
        .lock()
        .iter()
        .rev()
        .find(|r| r.call_id == first.call_id)
        .cloned()
        .unwrap();
    assert_eq!(late.status, tessera_protocol::tools::ToolCallStatus::Ok);
    let after = h.inv.invoke(c).await;
    assert!(after.deduped);
    assert_eq!(after.error.unwrap().code, ToolErrorCode::OutcomeUnknown);
    let entries = orders(&h, "paper-main")
        .await
        .into_iter()
        .filter(|o| o.parent_id.is_none())
        .count();
    assert_eq!(entries, 1, "never sent twice");
}

#[tokio::test]
async fn a_restart_restores_accounts_orders_fills_and_positions() {
    let store = Store::open_in_memory().unwrap();
    let h = harness_with(Some(store.clone())).await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 2),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let limit = json!({
        "accountId": "eval-50k",
        "instrument": "NQZ6.CME",
        "side": "buy",
        "qty": 1,
        "orderType": "limit",
        "limitPrice": 20600,
        "tif": "gtc",
        "bracket": { "stopLoss": 20590 },
    });
    let r = h
        .inv
        .invoke(call("orders.submit", limit, Origin::User, HELD))
        .await;
    assert!(r.ok, "{r:?}");
    let paper = Arc::clone(h.module.paper_broker());
    paper.flush().await;
    let main = AccountId::new("paper-main");
    let before = (
        paper.summary(&main).await.unwrap().balance,
        paper.positions(&main).await.unwrap(),
        paper.fills(&main, t0()).await.unwrap(),
    );
    drop(h);

    let clock: SharedClock = Arc::new(ManualClock::new(t0().add_nanos(60_000_000_000)));
    let again = PaperBroker::open(
        market(Arc::clone(&clock)) as Arc<dyn MarketDataProvider>,
        clock,
        Some(store),
        PaperConfig::default(),
        &funded_seeds(),
    )
    .await
    .unwrap();
    assert_eq!(again.summary(&main).await.unwrap().balance, before.0);
    let positions = again.positions(&main).await.unwrap();
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0].qty, before.1[0].qty);
    assert_eq!(positions[0].avg_price, before.1[0].avg_price);
    assert_eq!(again.fills(&main, t0()).await.unwrap(), before.2);
    let eval = again.orders(&AccountId::new("eval-50k")).await.unwrap();
    let working: Vec<_> = eval.iter().filter(|o| o.status.is_open()).collect();
    assert_eq!(working.len(), 2, "the limit and its held stop");
    assert_eq!(again.accounts().await.unwrap().len(), 2);
}

#[tokio::test]
async fn adv_flatten_on_a_closed_market_sends_no_close_and_keeps_the_stops() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    h.clock
        .set(Timestamp::parse("2026-10-02T17:30:00-04:00").unwrap());
    let r = h
        .inv
        .invoke(call(
            "orders.flatten",
            json!({ "accountId": "paper-main" }),
            Origin::User,
            COVERED,
        ))
        .await;
    let e = r.error.expect("not flat on a closed market");
    assert!(e.message.contains("NQZ6 is closed"), "{}", e.message);
    assert_eq!(
        e.details.as_ref().map(|d| d["closing"].clone()),
        Some(json!([])),
        "no close sent after its preview blocked"
    );
    assert_eq!(positions(&h, "paper-main").await.len(), 1);
    let orders = orders(&h, "paper-main").await;
    assert!(
        !orders
            .iter()
            .any(|o| o.request.reduce_only && o.request.order_type == OrderType::Market),
        "{orders:?}"
    );
    let working: Vec<_> = orders.iter().filter(|o| o.status.is_open()).collect();
    assert!(
        working
            .iter()
            .any(|o| o.role == tessera_core::orders::OrderRole::StopLoss),
        "a position left open without its stop"
    );
}

#[tokio::test]
async fn adv_a_restart_keeps_the_marks_net_liq_and_day_pnl() {
    let store = Store::open_in_memory().unwrap();
    let h = harness_with(Some(store.clone())).await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 2),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    h.clock.advance(40 * 60 * 1_000_000_000);
    let r = h
        .inv
        .invoke(call(
            "orders.preview",
            buy_nq("paper-main", 1),
            Origin::User,
            COVERED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let paper = Arc::clone(h.module.paper_broker());
    paper.flush().await;
    let main = AccountId::new("paper-main");
    let before = paper.summary(&main).await.unwrap();
    let pos_before = paper.positions(&main).await.unwrap();
    let now = tessera_core::Clock::now(h.clock.as_ref());
    drop(h);
    drop(paper);
    let clock: SharedClock = Arc::new(ManualClock::new(now));
    let again = PaperBroker::open(
        market(Arc::clone(&clock)) as Arc<dyn MarketDataProvider>,
        clock,
        Some(store),
        PaperConfig::default(),
        &funded_seeds(),
    )
    .await
    .unwrap();
    let after = again.summary(&main).await.unwrap();
    let pos_after = again.positions(&main).await.unwrap();
    eprintln!(
        "before {:?} {:?}\nafter {:?} {:?}",
        before.net_liq, pos_before[0].mark, after.net_liq, pos_after[0].mark
    );
    assert_eq!(after.net_liq, before.net_liq);
    assert_eq!(after.day_pnl, before.day_pnl);
    assert_eq!(pos_after[0].mark, pos_before[0].mark);
}

#[tokio::test]
async fn a_position_held_over_a_restart_into_a_new_day_counts_today_from_the_prior_settlement() {
    let store = Store::open_in_memory().unwrap();
    let h = harness_with(Some(store.clone())).await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 2),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let paper = Arc::clone(h.module.paper_broker());
    paper.flush().await;
    drop(h);
    drop(paper);

    let monday = Timestamp::parse("2026-10-05T10:00:00-04:00").unwrap();
    let clock: SharedClock = Arc::new(ManualClock::new(monday));
    let market = market(Arc::clone(&clock));
    let again = PaperBroker::open(
        Arc::clone(&market) as Arc<dyn MarketDataProvider>,
        clock,
        Some(store),
        PaperConfig::default(),
        &test_seeds(),
    )
    .await
    .unwrap();
    let main = AccountId::new("paper-main");
    let nq = again.positions(&main).await.unwrap()[0].instrument.clone();
    again
        .preview(&OrderRequest {
            account_id: main.clone(),
            instrument: nq.clone(),
            side: Side::Buy,
            qty: Qty::from(1),
            order_type: OrderType::Market,
            limit_price: None,
            stop_price: None,
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only: false,
        })
        .await
        .unwrap();
    let q = market.quote(&nq).await.unwrap();
    let settlement = q.session.as_ref().and_then(|s| s.prev_close).unwrap();
    let last = q.last.unwrap();
    let today = again.summary(&main).await.unwrap().day_pnl.amount;
    assert_eq!(
        today,
        (last.0 - settlement.0) * Decimal::from(2 * 20),
        "Monday's move on 2 NQ from Friday's settlement {settlement:?} to {last:?}"
    );
}

#[tokio::test]
async fn adv_two_concurrent_approvals_of_one_draft_send_one_order() {
    let h = Arc::new(harness().await);
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            agent(),
            COVERED,
        ))
        .await;
    let params = approve(&r);
    let (a, b) = tokio::join!(
        h.inv.resolve(&params, &Origin::User),
        h.inv.resolve(&params, &Origin::User)
    );
    eprintln!("{:?}\n{:?}", a.is_ok(), b.is_ok());
    assert!(a.is_ok() != b.is_ok());
    let entries = orders(&h, "paper-main")
        .await
        .into_iter()
        .filter(|o| o.parent_id.is_none())
        .count();
    assert_eq!(entries, 1);
    let again = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            agent(),
            COVERED,
        ))
        .await;
    eprintln!(
        "repeat: {:?} {:?} deduped={}",
        again.status, again.error, again.deduped
    );
    assert!(again.deduped);
    let entries = orders(&h, "paper-main")
        .await
        .into_iter()
        .filter(|o| o.parent_id.is_none())
        .count();
    assert_eq!(entries, 1);
}

#[tokio::test]
async fn adv_agent_exits_and_auto_modify_still_draft() {
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("eval-50k", 1),
            Origin::User,
            HELD,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let o = r.output.unwrap();
    let stop_id = o["bracket"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["role"] == "stop_loss")
        .unwrap()["id"]
        .clone();
    h.inv.set_policy(
        &agent(),
        tessera_tools::SessionPolicy::with_mode(tessera_protocol::tools::SessionMode::AutoModify),
    );
    for (n, (tool, input)) in [
        ("orders.cancel", json!({ "accountId": "eval-50k", "orderId": stop_id })),
        ("orders.modify", json!({ "accountId": "eval-50k", "orderId": stop_id, "stopPrice": 20635 })),
        (
            "orders.submit",
            json!({ "accountId": "eval-50k", "instrument": "NQ", "side": "sell", "qty": 1, "orderType": "market", "reduceOnly": true }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let r = h
            .inv
            .invoke(call(tool, input, agent(), SurfaceState { armed: true, hold_confirmed: true }))
            .await;
        if n == 0 {
            assert_eq!(r.status, ToolOutcome::PendingApproval, "{tool}: {r:?}");
        } else {
            assert_eq!(
                r.error.as_ref().map(|e| e.code),
                Some(ToolErrorCode::LoopGuard),
                "{tool}: {r:?}"
            );
        }
    }
    let open = orders(&h, "eval-50k")
        .await
        .into_iter()
        .filter(|o| o.status.is_open())
        .count();
    assert_eq!(open, 2, "stop and target untouched");
    assert_eq!(positions(&h, "eval-50k").await.len(), 1);
    let r = h
        .inv
        .invoke(call(
            "orders.modify",
            json!({ "accountId": "eval-50k", "orderId": stop_id, "stopPrice": 20620 }),
            Origin::User,
            ARMED,
        ))
        .await;
    eprintln!("{r:?}");
    assert_ne!(r.status, ToolOutcome::Ok);
}

#[tokio::test(start_paused = true)]
async fn adv_a_timed_out_order_retried_after_the_key_expired_is_not_sent_twice() {
    let h = harness_with(None).await;
    h.market.slow.store(true, Ordering::SeqCst);
    let mut c = call(
        "orders.submit",
        buy_nq("paper-main", 1),
        Origin::User,
        ARMED,
    );
    c.idempotency_key = Some("slow-2".into());
    let first = h.inv.invoke(c.clone()).await;
    assert_eq!(first.error.unwrap().code, ToolErrorCode::OutcomeUnknown);
    h.market.slow.store(false, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(30)).await;
    h.clock.advance(11 * 60 * 1_000_000_000);
    let retry = h.inv.invoke(c).await;
    eprintln!(
        "retry: {:?} deduped={} {:?}",
        retry.status, retry.deduped, retry.error
    );
    let entries = orders(&h, "paper-main")
        .await
        .into_iter()
        .filter(|o| o.parent_id.is_none())
        .count();
    assert_eq!(entries, 1, "the broker knows the client order id");
}

#[tokio::test]
async fn cancel_all_can_keep_the_positions_protection() {
    use tessera_core::orders::{OrderRole, OrderStatus};
    let h = harness().await;
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            buy_nq("paper-main", 1),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    assert_eq!(positions(&h, "paper-main").await.len(), 1);
    let r = h
        .inv
        .invoke(call(
            "orders.submit",
            json!({
                "accountId": "paper-main",
                "instrument": "NQ",
                "side": "buy",
                "qty": 1,
                "orderType": "limit",
                "limitPrice": 20500,
                "bracket": { "stopLoss": 20480, "takeProfit": 20560 },
            }),
            Origin::User,
            ARMED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let open = |os: &[tessera_core::orders::Order]| -> Vec<(OrderRole, OrderStatus)> {
        os.iter()
            .filter(|o| o.status.is_open())
            .map(|o| (o.role, o.status))
            .collect()
    };
    let before = open(&orders(&h, "paper-main").await);
    assert!(before.len() >= 3, "{before:?}");

    let r = h
        .inv
        .invoke(call(
            "orders.cancel_all",
            json!({ "accountId": "paper-main", "instrument": "NQ", "keepProtection": true }),
            agent(),
            COVERED,
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    h.inv
        .resolve(
            &ApprovalsResolveParams {
                decision: ApprovalDecision::Reject,
                ..approve(&r)
            },
            &Origin::User,
        )
        .await
        .unwrap();

    let r = h
        .inv
        .invoke(call(
            "orders.cancel_all",
            json!({ "accountId": "paper-main", "instrument": "NQ", "keepProtection": true }),
            Origin::User,
            COVERED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    let after = open(&orders(&h, "paper-main").await);
    assert_eq!(
        after
            .iter()
            .filter(|(_, s)| *s == OrderStatus::Held)
            .count(),
        0,
        "the entry's held legs went with it: {after:?}"
    );
    assert!(
        after.iter().any(|(r, _)| *r == OrderRole::StopLoss)
            && after.iter().any(|(r, _)| *r == OrderRole::TakeProfit),
        "the position keeps its stop and target: {after:?}"
    );
    assert!(
        !after.iter().any(|(r, _)| *r == OrderRole::Entry),
        "the entry is cancelled: {after:?}"
    );
    let r = h
        .inv
        .invoke(call(
            "orders.cancel_all",
            json!({ "accountId": "paper-main", "instrument": "NQ" }),
            Origin::User,
            COVERED,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    assert!(open(&orders(&h, "paper-main").await).is_empty());
}

#[tokio::test]
async fn more_than_six_entries_a_second_pause_entries_for_ten_seconds_and_exits_still_go() {
    let h = harness().await;
    let r = as_user(&h, "orders.submit", buy_nq("paper-main", 1)).await;
    assert!(r.ok, "{r:?}");
    let rest = |price: u32| {
        json!({
            "accountId": "paper-main", "instrument": "NQ", "side": "buy", "qty": 1,
            "orderType": "limit", "limitPrice": price,
        })
    };
    for price in [20_000, 20_001, 20_002, 20_003, 20_004] {
        let r = as_user(&h, "orders.submit", rest(price)).await;
        assert!(r.ok, "entry at {price}: {r:?}");
    }
    let r = as_user(&h, "orders.submit", rest(20_005)).await;
    let e = r.error.expect("the seventh in a second is refused");
    assert_eq!(
        e.message,
        "Paper (Tessera Paper): Too many orders: more than 6 in a second. New entries pause for \
         10 s, until 14:42:40. Exits, stops, targets and cancels still go. Nothing sent."
    );
    assert_eq!(e.details.as_ref().unwrap()["code"], "order_rate");
    let all = orders(&h, "paper-main").await;
    assert_eq!(
        all.iter()
            .filter(|o| o.role == OrderRole::Entry && o.status.is_open())
            .count(),
        5,
        "nothing sent for it"
    );
    let resting = all
        .iter()
        .find(|o| o.role == OrderRole::Entry && o.status.is_open())
        .unwrap()
        .id
        .clone();
    let stop = all
        .iter()
        .find(|o| o.role == OrderRole::StopLoss && o.status.is_open())
        .unwrap()
        .id
        .clone();

    let r = as_user(
        &h,
        "orders.modify",
        json!({ "accountId": "paper-main", "orderId": resting, "limitPrice": 20_010 }),
    )
    .await;
    assert!(
        r.error
            .is_some_and(|e| e.message.contains("Too many orders")),
        "an entry's change waits too"
    );
    let r = as_user(
        &h,
        "orders.reverse",
        json!({ "accountId": "paper-main", "instrument": "NQ" }),
    )
    .await;
    assert!(
        r.error
            .is_some_and(|e| e.message.contains("Too many orders")),
        "a reverse would open: refused before it closes anything"
    );
    assert_eq!(held(&h).await, Some(tessera_core::Qty::from(1)));
    let r = as_user(
        &h,
        "orders.modify",
        json!({ "accountId": "paper-main", "orderId": stop, "stopPrice": 20_632 }),
    )
    .await;
    assert!(r.ok, "a stop always moves: {r:?}");
    let r = as_user(
        &h,
        "orders.cancel",
        json!({ "accountId": "paper-main", "orderId": resting }),
    )
    .await;
    assert!(r.ok, "a cancel always goes: {r:?}");
    let mut exit = nq_market("sell", 1);
    exit["reduceOnly"] = json!(true);
    let r = as_user(&h, "orders.submit", exit).await;
    assert!(r.ok, "an exit always goes: {r:?}");
    assert_eq!(held(&h).await, None);

    h.clock.advance(10_000_000_000);
    let r = as_user(&h, "orders.submit", rest(20_006)).await;
    assert!(r.ok, "ten seconds on, entries go again: {r:?}");
}
