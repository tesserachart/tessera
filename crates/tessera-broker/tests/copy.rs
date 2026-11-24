use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_broker::copy::{COPY_TOOL, CopyNote, RESYNC_TOOL};
use tessera_broker::paper::{AccountSeed, PaperConfig};
use tessera_broker::protect::{PROTECT_TOOL, ProtectionMode};
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
use tessera_core::market::{Aggressor, AggressorSource, Quote, Trade};
use tessera_core::orders::{
    Bracket, Fill, Order, OrderPreview, OrderRequest, OrderRole, OrderStatus, Position,
};
use tessera_core::settle::{settle, settle_async};
use tessera_core::{InstrumentId, Origin, Price, Qty, SharedClock, Timeframe, Timestamp};
use tessera_host::{EventBus, RuntimeModule};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream, MockConfig,
    MockMarket,
};
use tessera_protocol::methods::ApprovalsResolveParams;
use tessera_protocol::tools::{ApprovalDecision, ToolOutcome, ToolResult};
use tessera_tools::{
    InvokeRequest, Invoker, InvokerConfig, MemoryObserver, SurfaceState, ToolRegistry,
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
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        Ok(Quote {
            instrument: i.clone(),
            ..self.quote.lock().clone()
        })
    }
    fn subscribe_quotes(&self, i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        let id = i.first().cloned().unwrap_or_else(nq);
        Ok(Box::pin(
            BroadcastStream::new(self.quotes.subscribe())
                .filter_map(Result::ok)
                .map(move |q| Quote {
                    instrument: id.clone(),
                    ..q
                }),
        ))
    }
    fn subscribe_trades(&self, i: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        let id = i.first().cloned().unwrap_or_else(nq);
        Ok(Box::pin(
            BroadcastStream::new(self.trades.subscribe())
                .filter_map(Result::ok)
                .map(move |t| Trade {
                    instrument: id.clone(),
                    ..t
                }),
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

const LEAD: &str = "lead";
const E1: &str = "eval-1";
const E2: &str = "eval-2";
const E3: &str = "eval-3";
const E4: &str = "eval-4";

fn seeds(followers: Environment) -> Vec<AccountSeed> {
    let seed = |id, name, environment| AccountSeed {
        id,
        name,
        environment,
        balance: Decimal::from(10_000_000),
        formerly: None,
    };
    vec![
        seed(LEAD, "Lead", Environment::Paper),
        seed(E1, "Eval 1", followers),
        seed(E2, "Eval 2", followers),
        seed(E3, "Eval 3", followers),
        seed(E4, "Eval 4", followers),
    ]
}

struct Desk {
    module: BrokerModule,
    tape: Arc<Tape>,
    audit: Arc<MemoryObserver>,
    inv: Invoker,
    notes: broadcast::Receiver<CopyNote>,
    _tasks: Vec<tokio::task::JoinHandle<()>>,
}

async fn desk_with(followers: Environment) -> Desk {
    let clock: SharedClock = Arc::new(ManualClock::new(t0()));
    let mut cfg = MockConfig::new(Arc::clone(&clock));
    cfg.intraday_sessions = 1;
    cfg.daily_sessions = 5;
    let tape = Arc::new(Tape {
        inner: MockMarket::new(cfg),
        quote: Mutex::new(quote_at("20641.00", "20641.25", "20641.00")),
        quotes: broadcast::channel(64).0,
        trades: broadcast::channel(64).0,
    });
    let module = BrokerModule::paper_seeded(
        Arc::clone(&tape) as Arc<dyn MarketDataProvider>,
        clock,
        None,
        PaperConfig::default(),
        Arc::new(EventBus::new()),
        &seeds(followers),
    )
    .await
    .unwrap();
    let audit = Arc::new(MemoryObserver::default());
    let protection = module.protection();
    protection.set_mode(ProtectionMode::Grow);
    protection.set_audit(Arc::clone(&audit) as _);
    let service = module.service();
    service.set_copy_audit(Arc::clone(&audit) as _);
    let notes = service.copy_book().notes();
    let mut tasks = module.paper_broker().start();
    tasks.extend(protection.start());
    tasks.extend(service.start_copying());
    let mut registry = ToolRegistry::new();
    module.register_tools(&mut registry).unwrap();
    let inv = Invoker::new(
        Arc::new(registry),
        Arc::clone(&audit) as _,
        Arc::new(ManualClock::new(t0())) as SharedClock,
        InvokerConfig::default(),
    );
    Desk {
        module,
        tape,
        audit,
        inv,
        notes,
        _tasks: tasks,
    }
}

async fn desk() -> Desk {
    desk_with(Environment::Paper).await
}

fn order(account: &str, side: &str, qty: i64, bracket: Option<(&str, &str)>) -> Value {
    let mut v = json!({
        "accountId": account,
        "instrument": "NQZ6.CME",
        "side": side,
        "qty": qty,
        "orderType": "market",
    });
    if let Some((stop, target)) = bracket {
        v["bracket"] = json!({ "stopLoss": stop, "takeProfit": target });
    }
    v
}

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S1"),
        provider: "codex".into(),
    }
}

const SL: OrderRole = OrderRole::StopLoss;
const TP: OrderRole = OrderRole::TakeProfit;

impl Desk {
    async fn user(&self, tool: &str, input: Value) -> ToolResult {
        let mut req = InvokeRequest::new(tool, input, Origin::User);
        req.surface = SurfaceState {
            armed: true,
            hold_confirmed: false,
        };
        self.inv.invoke(req).await
    }

    async fn ok(&self, tool: &str, input: Value) -> Value {
        let r = self.user(tool, input).await;
        assert!(r.ok, "{tool}: {r:?}");
        r.output.unwrap()
    }

    async fn group(&self, followers: Value) -> String {
        let out = self
            .ok(
                "copy.create",
                json!({ "name": "Evals", "leaderId": LEAD, "followers": followers, "enabled": true }),
            )
            .await;
        assert_eq!(out["group"]["enabled"], true, "{out}");
        out["group"]["id"].as_str().unwrap().to_owned()
    }

    async fn held(&self, account: &str) -> i64 {
        self.held_in(account, "NQZ6.CME").await
    }

    async fn held_in(&self, account: &str, instrument: &str) -> i64 {
        let instrument = InstrumentId::new(instrument).unwrap();
        self.module
            .paper_broker()
            .positions(&AccountId::new(account))
            .await
            .unwrap()
            .into_iter()
            .find(|p| p.instrument == instrument)
            .map_or(0, |p| whole(p.qty.0))
    }

    async fn holds_become(&self, account: &str, instrument: &str, want: i64) {
        settle_async(
            &format!("{account} holds {want} {instrument}"),
            || self.held_in(account, instrument),
            |held| *held == want,
        )
        .await;
    }

    async fn sync_of(&self, account: &str) -> Value {
        let out = self.ok("copy.status", json!({})).await;
        out["groups"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["followers"].as_array().unwrap().iter())
            .find(|f| f["accountId"] == account)
            .cloned()
            .unwrap_or_else(|| panic!("{account} follows no group: {out}"))
    }

    async fn sync_becomes(&self, account: &str, state: &str) -> Value {
        settle_async(
            &format!("{account} is {state}"),
            || self.sync_of(account),
            |f| f["state"] == state,
        )
        .await
    }

    async fn all(&self, followers: &[&str]) -> Vec<i64> {
        let mut out = vec![self.held(LEAD).await];
        for f in followers {
            out.push(self.held(f).await);
        }
        out
    }

    async fn all_become(&self, followers: &[&str], want: &[i64]) {
        settle_async(
            &format!("positions become {want:?}"),
            || self.all(followers),
            |held| held == want,
        )
        .await;
    }

    async fn orders(&self, account: &str) -> Vec<Order> {
        self.module
            .paper_broker()
            .orders(&AccountId::new(account))
            .await
            .unwrap()
    }

    async fn legs(&self, account: &str) -> Vec<(OrderRole, i64, Price)> {
        let mut out: Vec<(OrderRole, i64, Price)> = self
            .orders(account)
            .await
            .into_iter()
            .filter(|o| matches!(o.role, SL | TP) && o.status.is_working())
            .map(|o| {
                let price = o.request.stop_price.or(o.request.limit_price).unwrap();
                (o.role, whole(o.remaining().0), price)
            })
            .collect();
        out.sort_by_key(|a| (a.0 != SL, a.2));
        out
    }

    async fn legs_become(&self, account: &str, want: &[(OrderRole, i64, &str)]) {
        let want: Vec<(OrderRole, i64, Price)> =
            want.iter().map(|(r, q, x)| (*r, *q, p(x))).collect();
        settle_async(
            &format!("{account}'s legs become {want:?}"),
            || self.legs(account),
            |legs| *legs == want,
        )
        .await;
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

    fn notes(&mut self) -> Vec<CopyNote> {
        let mut out = Vec::new();
        while let Ok(n) = self.notes.try_recv() {
            out.push(n);
        }
        out
    }

    fn copies_audited(&self) -> Vec<(String, String, bool)> {
        self.audit
            .finished
            .lock()
            .iter()
            .filter(|c| c.tool == COPY_TOOL)
            .map(|c| {
                (
                    c.input["accountId"].as_str().unwrap_or_default().to_owned(),
                    c.input["copyOf"].as_str().unwrap_or_default().to_owned(),
                    c.error.is_none(),
                )
            })
            .collect()
    }

    fn limits(&self, accounts: &[(&str, RiskLimits)]) {
        self.module.service().set_limits(LimitsSetting {
            accounts: accounts
                .iter()
                .map(|(a, l)| ((*a).to_owned(), l.clone()))
                .collect(),
            ..LimitsSetting::default()
        });
    }
}

fn whole(d: Decimal) -> i64 {
    i64::try_from(d.trunc().mantissa()).unwrap() / 10_i64.pow(d.trunc().scale())
}

fn outcomes(out: &Value) -> Vec<(String, String)> {
    out["copies"]["results"]
        .as_array()
        .unwrap_or_else(|| panic!("no copies in {out}"))
        .iter()
        .map(|r| {
            (
                r["accountId"].as_str().unwrap().to_owned(),
                r["outcome"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn all_copied(out: &Value, accounts: &[&str]) {
    let want: Vec<(String, String)> = accounts
        .iter()
        .map(|a| ((*a).to_owned(), "copied".to_owned()))
        .collect();
    assert_eq!(outcomes(out), want, "{out}");
}

#[tokio::test(start_paused = true)]
async fn an_entry_with_its_bracket_goes_to_each_follower_at_its_own_size() {
    let d = desk().await;
    d.group(json!([
        { "accountId": E1, "multiplier": 1 },
        { "accountId": E2, "multiplier": 0.5 },
        { "accountId": E3, "multiplier": 2 },
    ]))
    .await;
    let out = d
        .ok(
            "orders.submit",
            order(LEAD, "buy", 2, Some(("20600.00", "20700.00"))),
        )
        .await;
    all_copied(&out, &[E1, E2, E3]);
    d.all_become(&[E1, E2, E3], &[2, 2, 1, 4]).await;
    d.legs_become(LEAD, &[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.legs_become(E1, &[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.legs_become(E2, &[(SL, 1, "20600.00"), (TP, 1, "20700.00")])
        .await;
    d.legs_become(E3, &[(SL, 4, "20600.00"), (TP, 4, "20700.00")])
        .await;
    assert_eq!(d.held(E4).await, 0);
    assert!(d.orders(E4).await.is_empty());
    let mut audited = d.copies_audited();
    audited.sort();
    assert_eq!(
        audited,
        [E1, E2, E3]
            .iter()
            .map(|a| ((*a).to_owned(), "orders.submit".to_owned(), true))
            .collect::<Vec<_>>()
    );
}

#[tokio::test(start_paused = true)]
async fn a_partial_exit_breakeven_reverse_and_flatten_follow() {
    let d = desk().await;
    let followers = [E1, E2, E3];
    d.group(json!([
        { "accountId": E1 },
        { "accountId": E2, "multiplier": 0.5 },
        { "accountId": E3, "multiplier": 2 },
    ]))
    .await;
    d.ok(
        "orders.submit",
        order(LEAD, "buy", 2, Some(("20600.00", "20700.00"))),
    )
    .await;
    d.all_become(&followers, &[2, 2, 1, 4]).await;
    d.legs_become(E3, &[(SL, 4, "20600.00"), (TP, 4, "20700.00")])
        .await;

    d.print("20660.00").await;
    let out = d
        .ok(
            "orders.breakeven",
            json!({ "accountId": LEAD, "instrument": "NQZ6.CME", "offsetTicks": 4 }),
        )
        .await;
    all_copied(&out, &followers);
    for (a, q) in [(LEAD, 2), (E1, 2), (E2, 1), (E3, 4)] {
        d.legs_become(a, &[(SL, q, "20642.25"), (TP, q, "20700.00")])
            .await;
    }

    let mut exit = order(LEAD, "sell", 1, None);
    exit["reduceOnly"] = json!(true);
    let out = d.ok("orders.submit", exit).await;
    assert_eq!(
        outcomes(&out),
        vec![
            (E1.to_owned(), "copied".to_owned()),
            (E2.to_owned(), "nothing".to_owned()),
            (E3.to_owned(), "copied".to_owned()),
        ],
        "{out}"
    );
    assert_eq!(
        out["copies"]["results"][1]["text"],
        "its size at 0.5× stays 1; nothing sent"
    );
    d.all_become(&followers, &[1, 1, 1, 2]).await;
    d.legs_become(E1, &[(SL, 1, "20642.25"), (TP, 1, "20700.00")])
        .await;
    d.legs_become(E2, &[(SL, 1, "20642.25"), (TP, 1, "20700.00")])
        .await;
    d.legs_become(E3, &[(SL, 2, "20642.25"), (TP, 2, "20700.00")])
        .await;

    let out = d
        .ok(
            "orders.reverse",
            json!({
                "accountId": LEAD,
                "instrument": "NQZ6.CME",
                "bracket": { "stopLoss": "20690.00", "takeProfit": "20600.00" },
            }),
        )
        .await;
    all_copied(&out, &followers);
    d.all_become(&followers, &[-1, -1, -1, -2]).await;
    for (a, q) in [(LEAD, 1), (E1, 1), (E2, 1), (E3, 2)] {
        d.legs_become(a, &[(SL, q, "20690.00"), (TP, q, "20600.00")])
            .await;
    }

    let out = d
        .ok(
            "orders.flatten",
            json!({ "accountId": LEAD, "instrument": "NQZ6.CME" }),
        )
        .await;
    all_copied(&out, &followers);
    d.all_become(&followers, &[0, 0, 0, 0]).await;
    for a in followers {
        d.legs_become(a, &[]).await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_resting_entrys_modify_and_cancel_follow() {
    let d = desk().await;
    d.group(json!([{ "accountId": E1 }, { "accountId": E2, "multiplier": 2 }]))
        .await;
    let mut limit = order(LEAD, "buy", 1, Some(("20590.00", "20690.00")));
    limit["orderType"] = json!("limit");
    limit["limitPrice"] = json!("20630.00");
    let out = d.ok("orders.submit", limit).await;
    all_copied(&out, &[E1, E2]);
    let entry = out["order"]["id"].as_str().unwrap().to_owned();
    let resting = |o: &Order| o.parent_id.is_none() && o.status == OrderStatus::Working;
    for (a, q) in [(E1, 1), (E2, 2)] {
        let e: Vec<Order> = d.orders(a).await.into_iter().filter(resting).collect();
        assert_eq!(e.len(), 1, "{a}: {e:?}");
        assert_eq!(e[0].request.limit_price, Some(p("20630.00")));
        assert_eq!(e[0].request.qty, Qty::from(q));
    }
    let out = d
        .ok(
            "orders.modify",
            json!({ "accountId": LEAD, "orderId": entry, "limitPrice": "20635.00", "qty": 2 }),
        )
        .await;
    all_copied(&out, &[E1, E2]);
    for (a, q) in [(E1, 2), (E2, 4)] {
        let e: Vec<Order> = d.orders(a).await.into_iter().filter(resting).collect();
        assert_eq!(e[0].request.limit_price, Some(p("20635.00")), "{a}");
        assert_eq!(e[0].request.qty, Qty::from(q), "{a}");
    }
    let out = d
        .ok(
            "orders.cancel",
            json!({ "accountId": LEAD, "orderId": entry }),
        )
        .await;
    all_copied(&out, &[E1, E2]);
    for a in [LEAD, E1, E2] {
        assert!(
            !d.orders(a).await.iter().any(|o| o.status.is_open()),
            "{a}: nothing works"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_moved_resting_entry_fills_with_every_bracket_at_its_distance() {
    let d = desk().await;
    d.group(json!([{ "accountId": E1 }, { "accountId": E2, "multiplier": 2 }]))
        .await;
    let mut limit = order(LEAD, "buy", 1, Some(("20590.00", "20690.00")));
    limit["orderType"] = json!("limit");
    limit["limitPrice"] = json!("20630.00");
    let out = d.ok("orders.submit", limit).await;
    all_copied(&out, &[E1, E2]);
    let entry = out["order"]["id"].as_str().unwrap().to_owned();
    let out = d
        .ok(
            "orders.modify",
            json!({ "accountId": LEAD, "orderId": entry, "limitPrice": "20635.00" }),
        )
        .await;
    all_copied(&out, &[E1, E2]);
    let d = &d;
    settle_async(
        "the moved entries fill on the prints",
        move || async move {
            d.print("20634.00").await;
            d.all(&[E1, E2]).await
        },
        |held| *held == [1, 1, 2],
    )
    .await;
    for (a, q) in [(LEAD, 1), (E1, 1), (E2, 2)] {
        d.legs_become(a, &[(SL, q, "20595.00"), (TP, q, "20695.00")])
            .await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_follower_over_its_daily_loss_is_skipped_and_the_others_go_on() {
    let mut d = desk().await;
    let followers = [E1, E2, E3];
    d.group(json!([{ "accountId": E1 }, { "accountId": E2 }, { "accountId": E3 }]))
        .await;
    d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    d.all_become(&followers, &[1, 1, 1, 1]).await;
    d.notes();
    d.limits(&[(
        E2,
        RiskLimits {
            daily_loss_limit: Some(1.0),
            ..RiskLimits::default()
        },
    )]);
    let out = d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    assert_eq!(
        outcomes(&out),
        vec![
            (E1.to_owned(), "copied".to_owned()),
            (E2.to_owned(), "skipped".to_owned()),
            (E3.to_owned(), "copied".to_owned()),
        ]
    );
    let skipped = &out["copies"]["results"][1]["text"];
    assert_eq!(
        skipped, "Your $1 daily loss limit is reached: no new positions today. Exits work.",
        "{out}"
    );
    d.all_become(&followers, &[2, 2, 1, 2]).await;
    let notes = d.notes();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].title, "Buy 1 NQZ6 market: copied to 2 of 3");
    assert_eq!(
        notes[0].detail,
        "Eval 2 skipped: Your $1 daily loss limit is reached: no new positions today. Exits work."
    );
    assert_eq!(notes[0].tone, "err");
    assert!(
        d.copies_audited()
            .contains(&(E2.to_owned(), "orders.submit".to_owned(), false))
    );
    let e2 = d.sync_of(E2).await;
    assert_eq!(e2["last"]["what"], "Buy 1 NQZ6 market", "{e2}");
    assert_eq!(e2["last"]["outcome"], "skipped", "{e2}");
    assert_eq!(
        e2["last"]["text"],
        "Your $1 daily loss limit is reached: no new positions today. Exits work."
    );
    assert_eq!(d.sync_of(E1).await["last"]["outcome"], "copied");
    let status = d.ok("copy.status", json!({})).await;
    let recent = &status["groups"][0]["recent"];
    assert_eq!(
        recent[0],
        json!({
            "what": "Buy 1 NQZ6 market",
            "at": recent[0]["at"],
            "copied": 2,
            "of": 3,
            "detail": "Eval 2 skipped: Your $1 daily loss limit is reached: no new positions today. Exits work.",
        }),
        "{status}"
    );
    assert_eq!(recent[1]["what"], "Buy 1 NQZ6 market");
    assert_eq!(recent[1]["copied"], 3);
    assert_eq!(recent[1]["detail"], Value::Null);
    let out = d.ok("orders.flatten", json!({ "accountId": LEAD })).await;
    all_copied(&out, &followers);
    d.all_become(&followers, &[0, 0, 0, 0]).await;
}

#[tokio::test(start_paused = true)]
async fn exits_are_never_refused_by_a_followers_limits() {
    let d = desk().await;
    let followers = [E1, E2];
    d.group(json!([{ "accountId": E1 }, { "accountId": E2, "multiplier": 2 }]))
        .await;
    d.ok(
        "orders.submit",
        order(LEAD, "buy", 2, Some(("20600.00", "20700.00"))),
    )
    .await;
    d.all_become(&followers, &[2, 2, 4]).await;
    d.legs_become(E2, &[(SL, 4, "20600.00"), (TP, 4, "20700.00")])
        .await;
    let strict = RiskLimits {
        daily_loss_limit: Some(1.0),
        max_order_qty: Some(1),
        max_position_qty: Some(1),
        ..RiskLimits::default()
    };
    d.limits(&[(E1, strict.clone()), (E2, strict)]);
    let out = d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    assert!(outcomes(&out).iter().all(|(_, o)| o == "skipped"), "{out}");
    d.all_become(&followers, &[3, 2, 4]).await;
    let mut exit = order(LEAD, "sell", 1, None);
    exit["reduceOnly"] = json!(true);
    let out = d.ok("orders.submit", exit).await;
    all_copied(&out, &followers);
    d.all_become(&followers, &[2, 1, 2]).await;
    d.print("20660.00").await;
    let out = d
        .ok(
            "orders.breakeven",
            json!({ "accountId": LEAD, "instrument": "NQZ6.CME", "offsetTicks": 0 }),
        )
        .await;
    all_copied(&out, &followers);
    d.legs_become(E2, &[(SL, 2, "20641.25"), (TP, 2, "20700.00")])
        .await;
    let out = d.ok("orders.flatten", json!({ "accountId": LEAD })).await;
    all_copied(&out, &followers);
    d.all_become(&followers, &[0, 0, 0]).await;
}

#[tokio::test(start_paused = true)]
async fn no_loops_a_copy_never_copies_again_and_an_account_leads_or_follows() {
    let d = desk().await;
    d.group(json!([{ "accountId": E1 }, { "accountId": E2 }]))
        .await;
    for followers in [json!([{ "accountId": LEAD }]), json!([{ "accountId": E3 }])] {
        let r = d
            .user(
                "copy.create",
                json!({ "leaderId": E1, "followers": followers, "enabled": true }),
            )
            .await;
        let e = r.error.unwrap();
        assert_eq!(
            e.message,
            "Eval 1 follows Lead (Evals): an account that follows cannot lead too, as a copy is \
             never copied on."
        );
    }
    let out = d
        .ok(
            "copy.create",
            json!({ "leaderId": E1, "followers": [{ "accountId": E3 }] }),
        )
        .await;
    let id = out["group"]["id"].as_str().unwrap().to_owned();
    let r = d.user("copy.enable", json!({ "groupId": id })).await;
    assert!(r.error.unwrap().message.contains("cannot lead too"));
    let r = d
        .user(
            "copy.create",
            json!({ "leaderId": E3, "followers": [{ "accountId": LEAD }], "enabled": true }),
        )
        .await;
    assert_eq!(
        r.error.unwrap().message,
        "Lead leads Evals: an account that leads cannot follow too, as a copy is never copied on."
    );
    d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    d.all_become(&[E1, E2, E3], &[1, 1, 1, 0]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    for a in [LEAD, E1, E2] {
        let entries = d
            .orders(a)
            .await
            .into_iter()
            .filter(|o| o.parent_id.is_none())
            .count();
        assert_eq!(entries, 1, "{a}: one entry");
    }
    let out = d.ok("orders.submit", order(E1, "buy", 1, None)).await;
    assert!(out.get("copies").is_none(), "{out}");
    d.all_become(&[E1, E2, E3], &[1, 2, 1, 0]).await;
    assert_eq!(d.copies_audited().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn an_analysts_order_on_a_leader_is_one_approval_naming_the_copies() {
    let d = desk().await;
    let id = d
        .group(json!([
            { "accountId": E1 },
            { "accountId": E2, "multiplier": 0.5 },
            { "accountId": E3, "fixedQty": 3 },
        ]))
        .await;
    for (tool, input) in [
        (
            "copy.create",
            json!({ "leaderId": E4, "followers": [{ "accountId": E1 }] }),
        ),
        ("copy.enable", json!({ "groupId": id })),
        (
            "copy.update",
            json!({ "groupId": id, "followers": [{ "accountId": E4 }] }),
        ),
        ("copy.delete", json!({ "groupId": id })),
    ] {
        let r = d.inv.invoke(InvokeRequest::new(tool, input, agent())).await;
        assert_eq!(r.status, ToolOutcome::Denied, "{tool}: {r:?}");
    }
    let r = d
        .inv
        .invoke(InvokeRequest::new("copy.list", json!({}), agent()))
        .await;
    assert!(r.ok, "{r:?}");
    assert_eq!(
        r.output.unwrap()["groups"][0]["followers"][1]["sizing"],
        "0.5×"
    );

    let input = order(LEAD, "buy", 2, Some(("20600.00", "20700.00")));
    let r = d
        .inv
        .invoke(InvokeRequest::new("orders.submit", input, agent()))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    let pending = r.approval.unwrap();
    let approval = d.inv.approvals().get(&pending.approval_id).unwrap();
    assert!(
        approval.preview["restatement"]
            .as_str()
            .unwrap()
            .ends_with(" and 3 accounts by copy"),
        "{}",
        approval.preview
    );
    assert_eq!(
        approval.preview["copies"]["accounts"],
        json!(["Eval 1", "Eval 2", "Eval 3"])
    );
    d.ok(
        "copy.update",
        json!({ "groupId": id, "followers": [
            { "accountId": E1 },
            { "accountId": E2, "multiplier": 0.5 },
            { "accountId": E3, "fixedQty": 3 },
            { "accountId": E4 },
        ] }),
    )
    .await;
    d.all_become(&[E1, E2, E3, E4], &[0, 0, 0, 0, 0]).await;
    let done = d
        .inv
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
    let result = done.result.unwrap();
    assert!(result.ok, "{result:?}");
    all_copied(result.output.as_ref().unwrap(), &[E1, E2, E3]);
    d.all_become(&[E1, E2, E3, E4], &[2, 2, 1, 3, 0]).await;
    assert!(d.inv.approvals().pending().is_empty(), "one approval");
    let approved: Vec<_> = d
        .audit
        .finished
        .lock()
        .iter()
        .filter(|c| c.tool == COPY_TOOL)
        .map(|c| c.approved_by.clone())
        .collect();
    assert_eq!(approved.len(), 3);
    assert!(approved.iter().all(Option::is_some));
    let r = d
        .inv
        .invoke(InvokeRequest::new(
            "copy.disable",
            json!({ "groupId": id }),
            agent(),
        ))
        .await;
    assert_ne!(r.status, ToolOutcome::Denied, "{r:?}");
}

#[tokio::test(start_paused = true)]
async fn a_follower_already_in_a_position_is_said_and_never_evened_out() {
    let mut d = desk().await;
    let followers = [E1, E2];
    d.ok("orders.submit", order(E2, "buy", 3, None)).await;
    d.all_become(&followers, &[0, 0, 3]).await;
    let out = d
        .ok(
            "copy.create",
            json!({ "name": "Evals", "leaderId": LEAD, "followers": [
                { "accountId": E1 }, { "accountId": E2 },
            ], "enabled": true }),
        )
        .await;
    assert_eq!(
        out["said"],
        json!([
            "Eval 2 already holds Long 3 NQZ6: copies never take it past its size, and resync \
             puts it at its size; Lead's last exit there closes it, as its flatten does."
        ])
    );
    let notes = d.notes();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].title, "Evals is on");
    d.all_become(&followers, &[0, 0, 3]).await;
    let out = d.ok("orders.submit", order(LEAD, "buy", 2, None)).await;
    assert_eq!(out["copies"]["results"][1]["outcome"], "nothing", "{out}");
    assert_eq!(
        out["copies"]["results"][1]["text"],
        "it holds Long 3 NQZ6 already, at or over its size of 2; nothing sent"
    );
    d.all_become(&followers, &[2, 2, 3]).await;
    let mut exit = order(LEAD, "sell", 1, None);
    exit["reduceOnly"] = json!(true);
    d.ok("orders.submit", exit).await;
    d.all_become(&followers, &[1, 1, 2]).await;
    let e2 = d.sync_becomes(E2, "out_of_sync").await;
    assert_eq!(e2["why"], "holds Long 2 NQZ6, should hold Long 1", "{e2}");
    d.ok("orders.flatten", json!({ "accountId": LEAD })).await;
    d.all_become(&followers, &[0, 0, 0]).await;
    d.sync_becomes(E2, "in_sync").await;
}

#[tokio::test(start_paused = true)]
async fn a_paper_leaders_click_is_weighed_by_its_followers_stricter_environment() {
    let d = desk_with(Environment::Eval).await;
    d.group(json!([{ "accountId": E1 }])).await;
    assert_eq!(
        d.module.service().gate_environment(LEAD),
        Some(Environment::Eval)
    );
    let r = d.user("orders.submit", order(LEAD, "buy", 1, None)).await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    d.all_become(&[E1], &[0, 0]).await;
    let r = d.user("orders.flatten", json!({ "accountId": LEAD })).await;
    assert_eq!(r.status, ToolOutcome::Ok, "{r:?}");
    let id = d.module.service().copy_book().groups()[0].id.clone();
    let r = d.user("copy.resync", json!({ "groupId": id })).await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    let r = d.user("copy.flatten", json!({ "groupId": id })).await;
    assert_eq!(r.status, ToolOutcome::Ok, "{r:?}");
}

struct Unreadable {
    inner: Arc<dyn BrokerProvider>,
    account: AccountId,
    on: AtomicBool,
    no_environment: Option<AccountId>,
}

#[async_trait]
impl BrokerProvider for Unreadable {
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
        if self.no_environment.as_ref() == Some(a) {
            return None;
        }
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
        if self.on.load(Ordering::SeqCst) && a == &self.account {
            return Err(BrokerError::Unavailable("not connected".into()));
        }
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

impl Desk {
    fn wrap_paper(&self, unreadable: bool, no_environment: Option<&str>) {
        let brokers = self.module.brokers();
        let id = self.module.paper_broker().id().to_owned();
        let inner = brokers.remove(&id).unwrap();
        brokers
            .add(Arc::new(Unreadable {
                inner,
                account: AccountId::new(LEAD),
                on: AtomicBool::new(unreadable),
                no_environment: no_environment.map(AccountId::new),
            }))
            .unwrap();
    }

    fn leader_positions_unreadable(&self) {
        self.wrap_paper(true, None);
    }

    async fn working(&self, account: &str) -> Vec<Order> {
        self.orders(account)
            .await
            .into_iter()
            .filter(|o| o.status.is_open())
            .collect()
    }

    async fn resting_entry(&self, account: &str) -> Option<Order> {
        self.working(account)
            .await
            .into_iter()
            .find(|o| o.parent_id.is_none() && o.role == OrderRole::Entry)
    }
}

fn copies_of(r: &ToolResult) -> Value {
    match (&r.output, &r.error) {
        (Some(out), _) => out["copies"].clone(),
        (None, Some(e)) => e
            .details
            .as_ref()
            .map(|d| d["copies"].clone())
            .unwrap_or_default(),
        (None, None) => Value::Null,
    }
}

#[tokio::test(start_paused = true)]
async fn a_micro_follower_trades_the_micro_at_its_size_with_the_bracket_breakeven_and_flatten() {
    let d = desk().await;
    let followers = [E1, E2];
    d.group(json!([
        { "accountId": E1 },
        { "accountId": E2, "multiplier": 0.5, "micro": true },
    ]))
    .await;
    let out = d
        .ok(
            "orders.submit",
            order(LEAD, "buy", 2, Some(("20600.00", "20700.00"))),
        )
        .await;
    all_copied(&out, &followers);
    d.all_become(&followers, &[2, 2, 0]).await;
    d.holds_become(E2, "MNQZ6.CME", 1).await;
    d.legs_become(E1, &[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    d.legs_become(E2, &[(SL, 1, "20600.00"), (TP, 1, "20700.00")])
        .await;
    assert!(
        d.orders(E2)
            .await
            .iter()
            .all(|o| o.request.instrument.as_str() == "MNQZ6.CME"),
        "{:?}",
        d.orders(E2).await
    );
    let e2 = d.sync_becomes(E2, "in_sync").await;
    assert_eq!(
        e2["holdings"],
        json!([{
            "leaderInstrument": "NQZ6.CME",
            "instrument": "MNQZ6.CME",
            "leaderQty": 2,
            "targetQty": 1,
            "qty": 1,
        }])
    );
    let list = d.ok("copy.list", json!({})).await;
    assert_eq!(list["groups"][0]["followers"][1]["micro"], true);
    assert_eq!(list["groups"][0]["followers"][1]["paused"], false);

    d.print("20660.00").await;
    let out = d
        .ok(
            "orders.breakeven",
            json!({ "accountId": LEAD, "instrument": "NQZ6.CME", "offsetTicks": 4 }),
        )
        .await;
    all_copied(&out, &followers);
    for (a, q) in [(LEAD, 2), (E1, 2), (E2, 1)] {
        d.legs_become(a, &[(SL, q, "20642.25"), (TP, q, "20700.00")])
            .await;
    }

    let out = d
        .ok(
            "orders.flatten",
            json!({ "accountId": LEAD, "instrument": "NQZ6.CME" }),
        )
        .await;
    all_copied(&out, &followers);
    d.all_become(&followers, &[0, 0, 0]).await;
    d.holds_become(E2, "MNQZ6.CME", 0).await;
    for a in followers {
        d.legs_become(a, &[]).await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_paused_follower_gets_nothing_falls_out_of_sync_and_a_resync_brings_it_back() {
    let d = desk().await;
    let id = d
        .group(json!([
            { "accountId": E1 },
            { "accountId": E2, "multiplier": 0.5, "micro": true, "paused": true },
        ]))
        .await;
    let out = d
        .ok(
            "orders.submit",
            order(LEAD, "buy", 2, Some(("20600.00", "20700.00"))),
        )
        .await;
    all_copied(&out, &[E1]);
    d.all_become(&[E1, E2], &[2, 2, 0]).await;
    d.legs_become(LEAD, &[(SL, 2, "20600.00"), (TP, 2, "20700.00")])
        .await;
    assert!(d.orders(E2).await.is_empty());
    let e2 = d.sync_becomes(E2, "out_of_sync").await;
    assert_eq!(e2["why"], "holds no MNQZ6, should hold Long 1", "{e2}");
    assert!(e2["since"].is_number(), "{e2}");
    let group = d.ok("copy.status", json!({ "groupId": id })).await;
    assert_eq!(group["groups"][0]["outOfSync"], 1, "{group}");
    assert_eq!(
        group["groups"][0]["leaderHoldings"],
        json!([{ "instrument": "NQZ6.CME", "qty": 2 }])
    );

    let out = d.ok("copy.resync", json!({ "groupId": id })).await;
    let results = out["report"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 1, "{out}");
    assert_eq!(results[0]["accountId"], E2);
    assert_eq!(results[0]["outcome"], "nothing");
    assert_eq!(results[0]["text"], "paused: resync it on its own");
    assert!(d.orders(E2).await.is_empty());

    let out = d
        .ok("copy.resync", json!({ "groupId": id, "accountId": E2 }))
        .await;
    assert_eq!(out["report"]["results"][0]["outcome"], "copied", "{out}");
    d.holds_become(E2, "MNQZ6.CME", 1).await;
    d.legs_become(E2, &[(SL, 1, "20600.00"), (TP, 1, "20700.00")])
        .await;
    d.sync_becomes(E2, "in_sync").await;
    let e2 = d.sync_of(E2).await;
    assert_eq!(e2["last"]["what"], "Resync Evals", "{e2}");
    assert_eq!(e2["last"]["outcome"], "copied", "{e2}");
    assert!(
        d.copies_audited()
            .contains(&(E2.to_owned(), RESYNC_TOOL.to_owned(), true))
    );
    assert_eq!(d.held(E1).await, 2, "the follower in sync is left alone");
}

#[tokio::test(start_paused = true)]
async fn copy_flatten_flattens_the_leader_and_its_followers_and_resync_keeps_to_the_group() {
    let d = desk().await;
    let id = d
        .group(json!([{ "accountId": E1 }, { "accountId": E2, "paused": true }]))
        .await;
    d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    d.ok("orders.submit", order(E2, "buy", 2, None)).await;
    d.ok("orders.submit", order(E3, "buy", 1, None)).await;
    d.all_become(&[E1, E2, E3], &[1, 1, 2, 1]).await;
    let before = d.orders(E3).await.len();

    let r = d
        .user("copy.resync", json!({ "groupId": id, "accountId": E3 }))
        .await;
    let e = r.error.unwrap();
    assert_eq!(e.code, tessera_protocol::tools::ToolErrorCode::Rejected);
    assert_eq!(e.message, "Eval 3 is not in Evals.");
    let r = d
        .user("copy.resync", json!({ "groupId": id, "accountId": LEAD }))
        .await;
    assert_eq!(
        r.error.unwrap().message,
        "Lead leads Evals; resync puts followers at their size."
    );
    assert_eq!(
        d.orders(E3).await.len(),
        before,
        "nothing sent outside the group"
    );
    assert!(d.copies_audited().iter().all(|(a, _, _)| a != E3));
    let r = d
        .inv
        .invoke(InvokeRequest::new(
            "copy.resync",
            json!({ "groupId": id }),
            agent(),
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::Denied, "the user's alone: {r:?}");

    let r = d
        .user("copy.flatten", json!({ "groupId": id, "accountId": E3 }))
        .await;
    assert_eq!(r.error.unwrap().message, "Eval 3 is not in Evals.");
    let r = d
        .inv
        .invoke(InvokeRequest::new(
            "copy.flatten",
            json!({ "groupId": id }),
            agent(),
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    let out = d.ok("copy.flatten", json!({ "groupId": id })).await;
    let results: Vec<(String, String)> = out["report"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["accountId"].as_str().unwrap().to_owned(),
                r["outcome"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        results,
        [LEAD, E1, E2]
            .iter()
            .map(|a| ((*a).to_owned(), "copied".to_owned()))
            .collect::<Vec<_>>(),
        "{out}"
    );
    d.all_become(&[E1, E2, E3], &[0, 0, 0, 1]).await;
}

#[tokio::test(start_paused = true)]
async fn an_unreadable_leader_position_copies_nothing() {
    let d = desk().await;
    let followers = [E1, E2];
    d.group(json!([{ "accountId": E1 }, { "accountId": E2 }]))
        .await;
    d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    d.all_become(&followers, &[1, 1, 1]).await;
    d.leader_positions_unreadable();
    let mut exit = order(LEAD, "sell", 1, None);
    exit["reduceOnly"] = json!(true);
    let r = d.user("orders.submit", exit).await;
    let copies = copies_of(&r);
    let results = copies["results"]
        .as_array()
        .unwrap_or_else(|| panic!("{r:?}"));
    assert_eq!(results.len(), 2, "{copies}");
    for res in results {
        assert_eq!(res["outcome"], "unknown", "{copies}");
        assert_eq!(
            res["text"],
            "the leader's position could not be read; nothing copied"
        );
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(d.held(E1).await, 1);
    assert_eq!(d.held(E2).await, 1);
    let e1 = d.sync_becomes(E1, "unknown").await;
    assert_eq!(
        e1["why"], "the leader's positions could not be read: not connected",
        "{e1}"
    );
}

fn limit(account: &str, qty: i64, price: &str) -> Value {
    let mut v = order(account, "buy", qty, None);
    v["orderType"] = json!("limit");
    v["limitPrice"] = json!(price);
    v
}

#[tokio::test(start_paused = true)]
async fn resyncs_at_once_and_beside_a_leader_add_leave_the_follower_at_its_size() {
    let d = desk().await;
    let id = d
        .group(json!([{ "accountId": E1 }, { "accountId": E2, "paused": true }]))
        .await;
    let resume = json!({ "groupId": id, "followers": [{ "accountId": E1 }, { "accountId": E2 }] });
    let pause = json!({ "groupId": id, "followers": [
        { "accountId": E1 }, { "accountId": E2, "paused": true },
    ] });
    d.ok("orders.submit", order(LEAD, "buy", 2, None)).await;
    d.all_become(&[E1, E2], &[2, 2, 0]).await;
    d.ok("copy.update", resume.clone()).await;
    d.sync_becomes(E2, "out_of_sync").await;
    let resync = json!({ "groupId": id });
    let (a, b) = tokio::join!(
        d.user("copy.resync", resync.clone()),
        d.user("copy.resync", resync.clone())
    );
    assert!(a.ok && b.ok, "{a:?} {b:?}");
    d.all_become(&[E1, E2], &[2, 2, 2]).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(d.held(E2).await, 2, "two resyncs at once send once");

    d.ok("copy.update", pause).await;
    d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    d.all_become(&[E1, E2], &[3, 3, 2]).await;
    d.ok("copy.update", resume).await;
    d.sync_becomes(E2, "out_of_sync").await;
    let (r, add) = tokio::join!(
        d.user("copy.resync", resync.clone()),
        d.user("orders.submit", order(LEAD, "buy", 1, None))
    );
    assert!(r.ok && add.ok, "{r:?} {add:?}");
    d.all_become(&[E1, E2], &[4, 4, 4]).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        d.all(&[E1, E2]).await,
        [4, 4, 4],
        "a racing add does not double"
    );
    d.sync_becomes(E2, "in_sync").await;
}

#[tokio::test(start_paused = true)]
async fn a_resync_leaves_a_follower_alone_while_its_copies_settle() {
    let d = desk().await;
    let id = d
        .group(json!([{ "accountId": E1 }, { "accountId": E2, "paused": true }]))
        .await;
    d.ok("orders.submit", order(LEAD, "buy", 2, None)).await;
    let out = d
        .ok("copy.resync", json!({ "groupId": id, "accountId": E2 }))
        .await;
    let first = &out["report"]["results"][0];
    assert_eq!(first["outcome"], "nothing", "{out}");
    assert_eq!(
        first["text"],
        "copies are on their way; resync once it settles"
    );
    assert_eq!(d.held(E2).await, 0, "nothing sent while it settles");
    d.sync_becomes(E2, "out_of_sync").await;
    let out = d
        .ok("copy.resync", json!({ "groupId": id, "accountId": E2 }))
        .await;
    assert_eq!(out["report"]["results"][0]["outcome"], "copied", "{out}");
    d.holds_become(E2, "NQZ6.CME", 2).await;
}

#[tokio::test(start_paused = true)]
async fn a_follower_that_stops_copying_has_its_working_copies_cancelled() {
    let d = desk().await;
    let id = d
        .group(json!([{ "accountId": E1 }, { "accountId": E2 }]))
        .await;
    let out = d.ok("orders.submit", limit(LEAD, 2, "20630.00")).await;
    all_copied(&out, &[E1, E2]);
    let entry = out["order"]["id"].as_str().unwrap().to_owned();
    assert!(d.resting_entry(E2).await.is_some());
    let out = d
        .ok(
            "copy.update",
            json!({ "groupId": id, "followers": [
                { "accountId": E1 }, { "accountId": E2, "paused": true },
            ] }),
        )
        .await;
    let said: Vec<&str> = out["said"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(
        said.iter()
            .any(|s| s.starts_with("Cancelled Eval 2's working copy of Buy 2 NQZ6 limit 20")),
        "{said:?}"
    );
    assert!(d.working(E2).await.is_empty(), "{:?}", d.working(E2).await);
    assert!(
        d.resting_entry(E1).await.is_some(),
        "a follower still copying keeps its copy"
    );
    assert!(
        d.copies_audited()
            .contains(&(E2.to_owned(), "copy.update".to_owned(), true))
    );
    d.ok(
        "orders.cancel",
        json!({ "accountId": LEAD, "orderId": entry }),
    )
    .await;
    for a in [LEAD, E1, E2] {
        assert!(d.working(a).await.is_empty(), "{a}: nothing works");
    }

    d.ok("orders.submit", limit(LEAD, 1, "20630.00")).await;
    assert!(d.resting_entry(E1).await.is_some());
    assert!(
        d.working(E2).await.is_empty(),
        "a paused follower gets no copy"
    );
    let out = d.ok("copy.disable", json!({ "groupId": id })).await;
    assert!(
        out["said"].as_array().unwrap().iter().any(|s| s
            .as_str()
            .unwrap()
            .starts_with("Cancelled Eval 1's working copy")),
        "{out}"
    );
    assert!(d.working(E1).await.is_empty());
    assert!(
        d.resting_entry(LEAD).await.is_some(),
        "the leader's own order stays"
    );
}

#[tokio::test(start_paused = true)]
async fn a_resting_entrys_new_size_is_what_it_means_at_each_followers_size() {
    let d = desk().await;
    d.group(json!([
        { "accountId": E1, "multiplier": 0.5 },
        { "accountId": E2, "multiplier": 0.25 },
    ]))
    .await;
    let out = d.ok("orders.submit", limit(LEAD, 4, "20630.00")).await;
    all_copied(&out, &[E1, E2]);
    let entry = out["order"]["id"].as_str().unwrap().to_owned();
    assert_eq!(d.resting_entry(E1).await.unwrap().request.qty, Qty::from(2));
    assert_eq!(d.resting_entry(E2).await.unwrap().request.qty, Qty::from(1));
    let out = d
        .ok(
            "orders.modify",
            json!({ "accountId": LEAD, "orderId": entry, "qty": 1 }),
        )
        .await;
    all_copied(&out, &[E1, E2]);
    assert_eq!(d.resting_entry(E1).await.unwrap().request.qty, Qty::from(1));
    assert!(
        d.working(E2).await.is_empty(),
        "1 at 0.25× adds nothing: its copy goes"
    );
    assert!(
        out["copies"]["results"][1]["text"]
            .as_str()
            .unwrap()
            .ends_with("at 0.25× the new quantity adds nothing"),
        "{out}"
    );
    d.ok(
        "orders.cancel",
        json!({ "accountId": LEAD, "orderId": entry }),
    )
    .await;

    d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    d.all_become(&[E1, E2], &[1, 1, 0]).await;
    let out = d.ok("orders.submit", limit(LEAD, 2, "20630.00")).await;
    all_copied(&out, &[E1, E2]);
    let entry = out["order"]["id"].as_str().unwrap().to_owned();
    assert_eq!(d.resting_entry(E1).await.unwrap().request.qty, Qty::from(1));
    let out = d
        .ok(
            "orders.modify",
            json!({ "accountId": LEAD, "orderId": entry, "qty": 1 }),
        )
        .await;
    assert_eq!(
        outcomes(&out),
        vec![
            (E1.to_owned(), "copied".to_owned()),
            (E2.to_owned(), "nothing".to_owned()),
        ],
        "{out}"
    );
    assert!(
        d.resting_entry(E1).await.is_none(),
        "long 1 to 2 at 0.5× adds nothing: its copy goes"
    );
    assert_eq!(d.resting_entry(E2).await.unwrap().request.qty, Qty::from(1));
}

#[tokio::test(start_paused = true)]
async fn an_account_of_unknown_type_makes_every_copied_action_ask_first() {
    let d = desk().await;
    let id = d.group(json!([{ "accountId": E1 }])).await;
    assert_eq!(
        d.module.service().gate_environment(LEAD),
        Some(Environment::Paper)
    );
    d.wrap_paper(false, Some(E1));
    assert_eq!(d.module.service().gate_environment(LEAD), None);
    let r = d.user("orders.submit", order(LEAD, "buy", 1, None)).await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    let r = d.user("copy.resync", json!({ "groupId": id })).await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    d.all_become(&[E1], &[0, 0]).await;
    let r = d.user("copy.flatten", json!({ "groupId": id })).await;
    assert_eq!(r.status, ToolOutcome::Ok, "an exit: {r:?}");
}

#[tokio::test(start_paused = true)]
async fn an_approved_group_flatten_reaches_only_the_accounts_its_preview_named() {
    let d = desk().await;
    let id = d.group(json!([{ "accountId": E1 }])).await;
    d.ok("orders.submit", order(LEAD, "buy", 1, None)).await;
    d.ok("orders.submit", order(E2, "buy", 1, None)).await;
    d.all_become(&[E1, E2], &[1, 1, 1]).await;
    let r = d
        .inv
        .invoke(InvokeRequest::new(
            "copy.flatten",
            json!({ "groupId": id }),
            agent(),
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    let pending = r.approval.unwrap();
    let approval = d.inv.approvals().get(&pending.approval_id).unwrap();
    assert_eq!(
        approval.preview["restatement"],
        "Flatten Lead and Eval 1 (Evals): cancel their working orders and close every position \
         at market"
    );
    d.ok(
        "copy.update",
        json!({ "groupId": id, "followers": [{ "accountId": E1 }, { "accountId": E2 }] }),
    )
    .await;
    let done = d
        .inv
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
    let result = done.result.unwrap();
    assert!(result.ok, "{result:?}");
    let accounts: Vec<&str> = result.output.as_ref().unwrap()["report"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["accountId"].as_str().unwrap())
        .collect();
    assert_eq!(accounts, [LEAD, E1]);
    d.all_become(&[E1, E2], &[0, 0, 1]).await;
}

#[tokio::test(start_paused = true)]
async fn the_copier_moving_a_followers_leg_says_so_in_activity() {
    let d = desk().await;
    let mut said = d.module.protection().notes();
    d.group(json!([{ "accountId": E1 }])).await;
    let mut limit = order(LEAD, "buy", 1, Some(("20590.00", "20690.00")));
    limit["orderType"] = json!("limit");
    limit["limitPrice"] = json!("20635.00");
    let out = d.ok("orders.submit", limit).await;
    all_copied(&out, &[E1]);
    let stop = d
        .orders(E1)
        .await
        .into_iter()
        .find(|o| o.role == SL)
        .unwrap();
    let r = d
        .user(
            "orders.modify",
            json!({ "accountId": E1, "orderId": stop.id, "stopPrice": "20500.00" }),
        )
        .await;
    assert!(r.ok, "{r:?}");
    d.print("20634.00").await;
    d.legs_become(E1, &[(SL, 1, "20590.00"), (TP, 1, "20690.00")])
        .await;
    let text = "Copy: moved the stop to 20,590.00, the leader's distance from this fill";
    let note = settle(
        "the copier's move in Activity",
        || said.try_recv().ok().map(|n| n.text),
        |n| n.as_deref() == Some(text),
    )
    .await;
    assert_eq!(note.as_deref(), Some(text));
    assert!(
        d.audit
            .finished
            .lock()
            .iter()
            .any(|c| c.tool == PROTECT_TOOL
                && c.input["accountId"] == E1
                && c.summary.as_deref().is_some_and(|s| s.ends_with(text))),
        "audited"
    );
}
