mod common;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_broker::{
    BrokerError, BrokerEvent, BrokerProvider, BrokerSystem, OrderChanges, SendRefused, Verified,
};
use tessera_core::accounts::{
    AccountSummary, CredentialRef, CredentialStore, Environment, Restrictions, TradingAccount,
};
use tessera_core::capabilities::{BrokerCapabilities, MarketCapabilities};
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::{AccountId, BrokerId, ConnectionId, DraftId, OrderId};
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{AggressorSource, BookSnapshot, Quote, Trade};
use tessera_core::orders::{
    Fill, Order, OrderPreview, OrderRequest, OrderType, Position, Side, TimeInForce,
};
use tessera_core::settle::settle;
use tessera_core::{
    Currency, InstrumentId, Money, Origin, Price, Qty, SharedClock, Timeframe, Timestamp,
};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream, MockConfig,
    MockMarket,
};
use tessera_rithmic::RithmicLogin;
use tessera_rithmic::directory::{DirectoryError, Gateway as ListedGateway};
use tessera_runtime::connectors::{
    ConnectError, Connector, NO_RITHMIC, NoRithmic, ORDER_ENTRY_KEY, RECORDS_KEY, RithmicFactory,
};
use tessera_runtime::secrets::{Adopter, NotKept, Secrets};
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::ShiftedClock;
use tessera_tools::{Audience, InvokeRequest};

use common::Client;
use common::keychain::{Answer, Keychain};

const ID: &str = "rithmic-test";
const GOOD: &str = "correct-horse-battery";
const GOOD2: &str = "another-accepted-secret";
const GATEWAY: &str = "wss://gateway.invalid:443";
const DIRECTORY: &str = "wss://directory.invalid:443";
const CHICAGO: &str = "wss://chicago.invalid:443";
const EUROPE: &str = "wss://europe.invalid:443";
const SYSTEMS: [&str; 3] = ["Apex", "Test", "Rithmic Paper Trading"];
const NQ: &str = "NQZ6.CME-RITHMIC";
const ACCOUNT: &str = "rithmic-test-000001";
const QUOTES_PER_LOGIN: i64 = 1_000_000_000;

fn clock() -> SharedClock {
    Arc::new(ShiftedClock::starting_at(
        Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap(),
    ))
}

async fn nq_template() -> (Instrument, ContractSpec) {
    let mut cfg = MockConfig::new(clock());
    cfg.intraday_sessions = 1;
    let mock = MockMarket::new(cfg);
    let id = mock.resolve("NQ").await.unwrap();
    let (mut instrument, mut spec) = mock.spec(&id).await.unwrap();
    let id = InstrumentId::new(NQ).unwrap();
    instrument.id = id.clone();
    spec.instrument = id;
    (instrument, spec)
}

#[derive(Default)]
struct Gateway {
    unreachable: AtomicU32,
    attempts: AtomicU32,
    sent: AtomicU32,
    last_login: Mutex<Option<RithmicLogin>>,
    directory: Mutex<Vec<String>>,
    directory_down: AtomicBool,
    directory_asks: AtomicU32,
    refuse_order_entry: AtomicBool,
    opened: AtomicU32,
    resolves: AtomicU32,
    last_opened: Mutex<Weak<FakeConnector>>,
}

impl Gateway {
    fn login_holders(&self) -> (usize, usize) {
        let connector = self.last_opened.lock().clone();
        let while_connecting = connector
            .upgrade()
            .map_or(0, |c| c.held_while_connecting.load(Ordering::SeqCst));
        (connector.strong_count(), while_connecting)
    }

    fn last_gateway(&self) -> Option<String> {
        self.last_login
            .lock()
            .as_ref()
            .map(|l| l.gateway_url.clone())
    }

    fn directory_answers(&self, url: &str) -> Result<(), DirectoryError> {
        self.directory_asks.fetch_add(1, Ordering::SeqCst);
        if self.directory_down.load(Ordering::SeqCst) || (url != DIRECTORY && url != GATEWAY) {
            return Err(DirectoryError::Unreachable("connection refused".into()));
        }
        Ok(())
    }
}

struct FakeFactory {
    gateway: Arc<Gateway>,
    nq: (Instrument, ContractSpec),
}

impl FakeFactory {
    fn login(&self, login: &RithmicLogin) -> Result<(), ConnectError> {
        self.gateway.attempts.fetch_add(1, Ordering::SeqCst);
        *self.gateway.last_login.lock() = Some(login.clone());
        if self
            .gateway
            .unreachable
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            return Err(ConnectError::Unreachable(format!(
                "cannot reach Rithmic: {} timed out",
                login.gateway_url
            )));
        }
        if login.password == GOOD || login.password == GOOD2 {
            Ok(())
        } else {
            Err(ConnectError::Refused(format!(
                "Rithmic refused the login: permission denied (tried {})",
                login.password
            )))
        }
    }
}

#[async_trait]
impl RithmicFactory for FakeFactory {
    fn open(&self, login: RithmicLogin) -> Result<Arc<dyn Connector>, ConnectError> {
        let state = Arc::new(Mutex::new((HealthStatus::Disconnected, None::<String>)));
        let closed = Arc::new(AtomicBool::new(false));
        let generation = i64::from(self.gateway.opened.fetch_add(1, Ordering::SeqCst) + 1);
        let connector = Arc::new_cyclic(|me| FakeConnector {
            factory: FakeFactory {
                gateway: Arc::clone(&self.gateway),
                nq: self.nq.clone(),
            },
            login,
            market: Arc::new(FakeMarket {
                state: Arc::clone(&state),
                closed: Arc::clone(&closed),
                nq: self.nq.clone(),
                gateway: Arc::clone(&self.gateway),
                generation,
            }),
            closed,
            broker: Arc::new(FakeBroker {
                state: Arc::clone(&state),
                gateway: Arc::clone(&self.gateway),
                order_entry: AtomicBool::new(false),
            }),
            state,
            me: me.clone(),
            held_while_connecting: AtomicUsize::new(0),
        });
        *self.gateway.last_opened.lock() = Arc::downgrade(&connector);
        Ok(connector)
    }

    async fn test(&self, login: RithmicLogin) -> Result<(), ConnectError> {
        self.login(&login)
    }

    fn directory(&self) -> Vec<String> {
        self.gateway.directory.lock().clone()
    }

    async fn systems(&self, url: &str) -> Result<Vec<String>, DirectoryError> {
        self.gateway.directory_answers(url)?;
        Ok(SYSTEMS.map(String::from).to_vec())
    }

    async fn gateways(
        &self,
        url: &str,
        system: &str,
    ) -> Result<Vec<ListedGateway>, DirectoryError> {
        self.gateway.directory_answers(url)?;
        if system != "Test" {
            return Err(DirectoryError::Refused("no such system (code 7)".into()));
        }
        Ok(vec![
            ListedGateway {
                name: "Chicago Area".into(),
                uri: CHICAGO.into(),
            },
            ListedGateway {
                name: "Europe".into(),
                uri: EUROPE.into(),
            },
        ])
    }
}

struct FakeConnector {
    factory: FakeFactory,
    login: RithmicLogin,
    market: Arc<FakeMarket>,
    broker: Arc<FakeBroker>,
    state: Arc<Mutex<(HealthStatus, Option<String>)>>,
    closed: Arc<AtomicBool>,
    me: Weak<FakeConnector>,
    held_while_connecting: AtomicUsize,
}

#[async_trait]
impl Connector for FakeConnector {
    fn id(&self) -> &str {
        ID
    }
    fn market(&self) -> Arc<dyn MarketDataProvider> {
        Arc::clone(&self.market) as _
    }
    fn broker(&self) -> Option<Arc<dyn BrokerProvider>> {
        Some(Arc::clone(&self.broker) as _)
    }
    async fn connect(&self) -> Result<(), ConnectError> {
        self.held_while_connecting
            .fetch_max(self.me.strong_count(), Ordering::SeqCst);
        *self.state.lock() = (HealthStatus::Unknown, None);
        let r = self.factory.login(&self.login);
        *self.state.lock() = match &r {
            Ok(()) => (HealthStatus::Ok, None),
            Err(e) => (HealthStatus::Down, Some(self.login.redact(&e.to_string()))),
        };
        r
    }
    async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        *self.state.lock() = (HealthStatus::Disconnected, None);
    }
    fn set_account_order_entry(&self, account: &AccountId, enabled: bool) -> Result<(), String> {
        if account.as_str() != ACCOUNT {
            return Err("not an evaluation account of this login".into());
        }
        if self
            .factory
            .gateway
            .refuse_order_entry
            .load(Ordering::SeqCst)
        {
            return Err("the firm keeps order entry off".into());
        }
        self.broker.order_entry.store(enabled, Ordering::SeqCst);
        Ok(())
    }
}

fn health(state: &Mutex<(HealthStatus, Option<String>)>, kind: ProviderKind) -> ProviderHealth {
    let (status, message) = state.lock().clone();
    ProviderHealth {
        provider_id: ID.into(),
        kind,
        display_name: "Test · Rithmic".into(),
        status,
        latency_ms: None,
        last_message_at: None,
        message,
        connection: None,
        accounts: None,
        checked_at: Timestamp(0),
    }
}

struct FakeMarket {
    state: Arc<Mutex<(HealthStatus, Option<String>)>>,
    closed: Arc<AtomicBool>,
    nq: (Instrument, ContractSpec),
    gateway: Arc<Gateway>,
    generation: i64,
}

impl FakeMarket {
    fn live(&self) -> Result<(), MarketError> {
        if self.state.lock().0 == HealthStatus::Ok {
            Ok(())
        } else {
            Err(MarketError::Unavailable("not logged in".into()))
        }
    }
}

#[async_trait]
impl MarketDataProvider for FakeMarket {
    fn id(&self) -> &str {
        ID
    }
    fn display_name(&self) -> &str {
        "Test · Rithmic"
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: vec![Timeframe::M1],
            live_timeframes: vec![Timeframe::M1],
            quotes: true,
            trades: true,
            depth_levels: Some(100),
            footprint: false,
            asset_classes: vec![AssetClass::Future],
            max_intraday_history_days: Some(30),
            max_daily_history_days: None,
            realtime: true,
            aggressor_source: Some(AggressorSource::Exchange),
        }
    }
    fn health(&self) -> ProviderHealth {
        health(&self.state, ProviderKind::MarketData)
    }
    async fn search(
        &self,
        query: &str,
        _: Option<AssetClass>,
        _: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.live()?;
        Ok(if query.eq_ignore_ascii_case("NQ") {
            vec![self.nq.0.clone()]
        } else {
            vec![]
        })
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.gateway.resolves.fetch_add(1, Ordering::SeqCst);
        self.live()?;
        let s = input.trim().to_ascii_uppercase();
        if s == "NQ" || s == NQ {
            Ok(self.nq.0.id.clone())
        } else {
            Err(MarketError::UnknownInstrument(input.into()))
        }
    }
    async fn spec(&self, id: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        if *id != self.nq.0.id {
            return Err(MarketError::UnknownInstrument(id.to_string()));
        }
        self.live()?;
        Ok(self.nq.clone())
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        Ok(BarSeries {
            instrument: req.instrument,
            tf: req.tf,
            bars: vec![],
            last_bar_open: false,
        })
    }
    async fn quote(&self, id: &InstrumentId) -> Result<Quote, MarketError> {
        self.live()?;
        Ok(quote(id.clone(), 0))
    }
    fn subscribe_quotes(&self, ids: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        let id = ids[0].clone();
        let (state, closed) = (Arc::clone(&self.state), Arc::clone(&self.closed));
        let mut n = self.generation * QUOTES_PER_LOGIN;
        Ok(
            tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(
                Duration::from_millis(20),
            ))
            .take_while(move |_| futures::future::ready(!closed.load(Ordering::SeqCst)))
            .map(move |_| state.lock().0)
            .filter(|s| futures::future::ready(*s == HealthStatus::Ok))
            .map(move |_| {
                n += 1;
                quote(id.clone(), n)
            })
            .boxed(),
        )
    }
    fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        Ok(futures::stream::pending().boxed())
    }
    fn subscribe_bars(
        &self,
        _: &InstrumentId,
        _: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        Ok(futures::stream::pending().boxed())
    }
    fn subscribe_depth(
        &self,
        _: &InstrumentId,
        _: u32,
    ) -> Result<MarketStream<BookSnapshot>, MarketError> {
        Ok(futures::stream::pending().boxed())
    }
}

fn quote(instrument: InstrumentId, n: i64) -> Quote {
    let p = |v: i64| Some(Price(Decimal::new(v, 2)));
    Quote {
        instrument,
        ts: Timestamp(n),
        bid: p(2_000_000),
        bid_size: Some(Qty::from(3)),
        ask: p(2_000_025),
        ask_size: Some(Qty::from(4)),
        last: p(2_000_025),
        last_size: Some(Qty::from(1)),
        session: None,
        source: None,
    }
}

struct FakeBroker {
    state: Arc<Mutex<(HealthStatus, Option<String>)>>,
    gateway: Arc<Gateway>,
    order_entry: AtomicBool,
}

fn usd(v: i64) -> Money {
    Money {
        amount: Decimal::from(v),
        currency: Currency::Usd,
    }
}

#[async_trait]
impl BrokerProvider for FakeBroker {
    fn id(&self) -> &str {
        ID
    }
    fn capabilities(&self) -> BrokerCapabilities {
        let on = self.order_entry.load(Ordering::SeqCst);
        BrokerCapabilities {
            order_types: if on { vec![OrderType::Market] } else { vec![] },
            time_in_force: vec![TimeInForce::Day],
            brackets: false,
            oco: false,
            modify: on,
            read_only: !on,
            environments: vec![Environment::Eval],
            fractional_qty: false,
            stop_rules: false,
        }
    }
    fn account_order_entry(&self) -> Option<Vec<AccountId>> {
        Some(if self.order_entry.load(Ordering::SeqCst) {
            vec![AccountId::new(ACCOUNT)]
        } else {
            vec![]
        })
    }
    fn system(&self) -> BrokerSystem {
        BrokerSystem {
            name: "Apex".into(),
            environment: Environment::Eval,
        }
    }
    fn health(&self) -> ProviderHealth {
        health(&self.state, ProviderKind::Broker)
    }
    fn environment_of(&self, account: &AccountId) -> Option<Environment> {
        (account.as_str() == ACCOUNT).then_some(Environment::Eval)
    }
    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        if self.state.lock().0 != HealthStatus::Ok {
            return Err(BrokerError::Unavailable("not logged in".into()));
        }
        Ok(vec![TradingAccount {
            id: AccountId::new(ACCOUNT),
            display_name: "TEST-000001".into(),
            environment: Environment::Eval,
            broker_id: BrokerId::new(ID),
            connection_id: ConnectionId::new(ID),
            program_id: None,
            rule_set_id: None,
            currency: Currency::Usd,
            restrictions: Restrictions::default(),
            group_id: None,
            external_ref_masked: Some("0001".into()),
        }])
    }
    async fn summary(&self, account: &AccountId) -> Result<AccountSummary, BrokerError> {
        Ok(AccountSummary {
            account_id: account.clone(),
            balance: usd(25_000),
            net_liq: usd(25_000),
            day_pnl: usd(0),
            realized_today: usd(0),
            fees_today: usd(0),
            unrealized_today: usd(0),
            open_pnl: usd(0),
            buying_power: usd(25_000),
            as_of: Timestamp(0),
        })
    }
    async fn positions(&self, _: &AccountId) -> Result<Vec<Position>, BrokerError> {
        Ok(vec![])
    }
    async fn orders(&self, _: &AccountId) -> Result<Vec<Order>, BrokerError> {
        Ok(vec![])
    }
    async fn fills(&self, _: &AccountId, _: Timestamp) -> Result<Vec<Fill>, BrokerError> {
        Ok(vec![])
    }
    async fn preview(&self, _: &OrderRequest) -> Result<OrderPreview, BrokerError> {
        Err(BrokerError::Unsupported("read-only".into()))
    }
    async fn submit(
        &self,
        _: &Verified,
        _: OrderRequest,
        _: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        self.gateway.sent.fetch_add(1, Ordering::SeqCst);
        Err(BrokerError::Unsupported("read-only".into()))
    }
    async fn modify(
        &self,
        _: &Verified,
        _: &OrderId,
        _: OrderChanges,
    ) -> Result<Order, BrokerError> {
        self.gateway.sent.fetch_add(1, Ordering::SeqCst);
        Err(BrokerError::Unsupported("read-only".into()))
    }
    async fn cancel(&self, _: &Verified, _: &OrderId) -> Result<Order, BrokerError> {
        self.gateway.sent.fetch_add(1, Ordering::SeqCst);
        Err(BrokerError::Unsupported("read-only".into()))
    }
    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        futures::stream::pending().boxed()
    }
}

struct Setup {
    gateway: Arc<Gateway>,
    secrets: Secrets,
    factory: Arc<FakeFactory>,
}

impl Setup {
    async fn new() -> Self {
        let gateway = Arc::new(Gateway::default());
        Self {
            factory: Arc::new(FakeFactory {
                gateway: Arc::clone(&gateway),
                nq: nq_template().await,
            }),
            gateway,
            secrets: Secrets::in_memory(),
        }
    }

    fn config(&self) -> RuntimeConfig {
        RuntimeConfig {
            clock: clock(),
            secrets: Some(self.secrets.clone()),
            rithmic: Some(Arc::clone(&self.factory) as Arc<dyn RithmicFactory>),
            ..RuntimeConfig::default()
        }
    }

    async fn start(&self, config: RuntimeConfig) -> RuntimeHandle {
        Runtime::build(config, Vec::new()).await.unwrap().spawn()
    }
}

fn login(password: &str) -> Value {
    login_at(GATEWAY, password)
}

fn login_at(gateway: &str, password: &str) -> Value {
    json!({"system": "Test", "gateway": gateway, "user": "someone", "password": password})
}

async fn directory(c: &mut Client, input: Value) -> Value {
    let r = invoke(c, "connections.rithmic_directory", input).await;
    assert_eq!(r["ok"], true, "{r}");
    r["output"].clone()
}

async fn invoke(c: &mut Client, name: &str, input: Value) -> Value {
    c.ok("tools.invoke", json!({"name": name, "input": input}))
        .await
}

async fn listed(c: &mut Client) -> Vec<Value> {
    invoke(c, "connections.list", json!({})).await["output"]["connections"]
        .as_array()
        .unwrap()
        .clone()
}

async fn served(h: &RuntimeHandle, input: &str) -> bool {
    h.state.connections.market().resolve(input).await.is_ok()
}

fn add_second_connection(h: &RuntimeHandle) {
    let mut cfg = MockConfig::new(Arc::clone(&h.state.clock));
    cfg.intraday_sessions = 1;
    h.state
        .connections
        .add_market(Arc::new(MockMarket::new(cfg)))
        .unwrap();
}

async fn resolve(h: &RuntimeHandle, input: &str) -> String {
    h.state
        .connections
        .market()
        .resolve(input)
        .await
        .unwrap()
        .to_string()
}

fn health_of(h: &RuntimeHandle) -> Option<(HealthStatus, Option<String>)> {
    h.state
        .connections
        .info(ID)
        .map(|i| (i.health.status, i.health.message))
}

async fn health_becomes(h: &RuntimeHandle, status: HealthStatus) {
    settle(
        &format!("{ID} becomes {status:?}"),
        || health_of(h),
        |seen| seen.as_ref().is_some_and(|(now, _)| *now == status),
    )
    .await;
}

fn secret_ref() -> CredentialRef {
    CredentialRef {
        store: CredentialStore::Keyring,
        key: format!("rithmic.{ID}"),
    }
}

#[tokio::test]
async fn a_rithmic_login_is_tested_added_routed_and_removed_without_a_restart() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;

    let registry = h.state.invoker.registry();
    for name in [
        "connections.add_rithmic",
        "connections.test_rithmic",
        "connections.remove",
        "connections.reconnect",
    ] {
        assert!(
            registry
                .descriptors(Audience::Agent, None, true)
                .iter()
                .all(|d| d.name != name),
            "{name} is visible to agents"
        );
        let r = h
            .state
            .invoker
            .invoke(InvokeRequest::new(
                name,
                login(GOOD),
                Origin::External {
                    client_id: "mcp-client".into(),
                },
            ))
            .await;
        let r = serde_json::to_value(r).unwrap();
        assert_eq!(r["error"]["code"], "permission_denied", "{name}: {r}");
    }
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), 0);

    let t = invoke(
        &mut c,
        "connections.test_rithmic",
        login("wrong-password-1"),
    )
    .await;
    assert_eq!(t["output"]["ok"], false, "{t}");
    let m = t["output"]["message"].as_str().unwrap();
    assert!(
        m.contains("refused") && !m.contains("wrong-password-1"),
        "{m}"
    );
    let r = invoke(&mut c, "connections.add_rithmic", login("wrong-password-1")).await;
    assert_eq!(r["error"]["code"], "rejected", "{r}");
    assert!(!r.to_string().contains("wrong-password-1"), "{r}");
    assert!(listed(&mut c).await.iter().all(|x| x["id"] != ID));
    assert_eq!(s.secrets.get(&secret_ref()).await.unwrap(), None);
    let t = invoke(&mut c, "connections.test_rithmic", login(GOOD)).await;
    assert_eq!(
        t["output"],
        json!({"ok": true, "message": "Logged in to Test."})
    );

    assert!(!served(&h, "NQ").await, "nothing serves NQ before a login");
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    assert_eq!(added["output"]["storedIn"], "keyring");
    let conn = &added["output"]["connection"];
    assert_eq!(conn["id"], ID);
    assert_eq!(conn["broker"]["readOnly"], true);
    assert_eq!(conn["health"]["message"], "Connected");
    assert_eq!(conn["enabled"], true, "a saved login is on");
    assert!(s.secrets.get(&secret_ref()).await.unwrap().is_some());
    let record = h.state.store.settings().get(RECORDS_KEY).unwrap().unwrap();
    let text = record.to_string();
    for secret in [GOOD, "gateway.invalid", "someone"] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
    assert_eq!(record[0]["credential"]["store"], "keyring");
    let audit = h.state.store.tool_calls().recent(100, None).unwrap();
    let logins: Vec<_> = audit
        .iter()
        .filter(|r| r.tool.ends_with("_rithmic"))
        .collect();
    assert_eq!(logins.len(), 2);
    for r in logins {
        assert!(!r.origin.is_user());
        assert_eq!(
            r.input,
            json!({"system": "[redacted]", "gateway": "[redacted]", "user": "[redacted]", "password": "[redacted]"})
        );
    }

    let ids: Vec<Value> = listed(&mut c)
        .await
        .iter()
        .map(|x| x["id"].clone())
        .collect();
    assert_eq!(ids[0], json!(ID));
    assert_eq!(resolve(&h, "NQ").await, NQ);
    assert!(!served(&h, "QQQ").await);

    let sub = c
        .ok(
            "subscribe",
            json!({"topic": "market.quotes", "params": {"instruments": [NQ]}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let q = c.event(&sub, |e| e["seq"].as_u64() >= Some(2)).await;
    assert_eq!(q["data"]["instrument"], NQ);
    assert_eq!(q["data"]["source"], json!({"provider": ID}));

    let accounts = invoke(&mut c, "portfolio.get_accounts", json!({})).await;
    let names: Vec<&str> = accounts["output"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["account"]["id"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&ACCOUNT) && names.contains(&"paper-main"),
        "{names:?}"
    );
    let req = OrderRequest {
        account_id: AccountId::new(ACCOUNT),
        instrument: InstrumentId::new(NQ).unwrap(),
        side: Side::Buy,
        qty: Qty::from(1),
        order_type: OrderType::Market,
        limit_price: None,
        stop_price: None,
        tif: TimeInForce::Day,
        bracket: None,
        client_order_id: None,
        reduce_only: false,
    };
    let refused = h
        .state
        .broker
        .service()
        .broker()
        .route(&req.account_id)
        .await;
    assert!(
        matches!(
            refused,
            Err(BrokerError::Refused(SendRefused::OrderEntryOff))
        ),
        "{refused:?}"
    );
    assert_eq!(conn["accountOrderEntry"], json!([]));

    let before = s.gateway.attempts.load(Ordering::SeqCst);
    let again = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(again["error"]["code"], "conflict", "{again}");
    let t = invoke(&mut c, "connections.test_rithmic", login(GOOD)).await;
    assert_eq!(t["output"]["ok"], false);
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), before);

    let r = invoke(&mut c, "connections.remove", json!({"id": ID})).await;
    assert_eq!(r["output"]["removed"], true, "{r}");
    assert!(listed(&mut c).await.iter().all(|x| x["id"] != ID));
    assert!(!served(&h, "NQ").await);
    assert_eq!(s.secrets.get(&secret_ref()).await.unwrap(), None);
    assert_eq!(
        h.state.store.settings().get(RECORDS_KEY).unwrap(),
        Some(json!([]))
    );
    let accounts = invoke(&mut c, "portfolio.get_accounts", json!({})).await;
    assert!(!accounts.to_string().contains(ACCOUNT));
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_password_reaches_rithmic_exactly_as_typed() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;
    let typed = json!({"system": " Test ", "gateway": format!(" {GATEWAY} "), "user": " someone ",
        "password": "  pass word  "});
    invoke(&mut c, "connections.test_rithmic", typed).await;
    let login = s
        .gateway
        .last_login
        .lock()
        .clone()
        .expect("the login reached Rithmic");
    assert_eq!(login.password, "  pass word  ");
    assert_eq!(login.system_name, "Test");
    assert_eq!(login.gateway_url, GATEWAY);
    assert_eq!(login.user, "someone");
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_saved_chart_on_the_connection_waits_for_its_login_after_a_restart() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let config = || RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        ..s.config()
    };
    let h = s.start(config()).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    drop(c);
    h.shutdown().await.unwrap();

    s.gateway.unreachable.store(2, Ordering::SeqCst);
    let h = s.start(config()).await;
    let mut c = Client::new(&h).await;
    let sub = c
        .call(
            "subscribe",
            json!({"topic": "market.quotes", "params": {"instruments": [NQ]}}),
        )
        .await;
    assert!(sub.get("error").is_none(), "{sub}");
    assert_ne!(
        h.state.connections.info(ID).unwrap().health.status,
        HealthStatus::Ok,
        "the test needs the subscription to come first"
    );
    let quote = invoke(&mut c, "market.get_quote", json!({"instrument": NQ})).await;
    assert_eq!(quote["error"]["code"], "unavailable", "{quote}");
    let sub = sub["result"]["subscriptionId"].as_str().unwrap().to_owned();
    let q = c.event(&sub, |e| e["data"]["instrument"] == NQ).await;
    assert_eq!(q["data"]["source"], json!({"provider": ID}));
    assert_eq!(
        h.state.connections.info(ID).unwrap().health.status,
        HealthStatus::Ok
    );
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_connection_removed_and_added_again_resumes_open_streams() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    let sub = c
        .ok(
            "subscribe",
            json!({"topic": "market.quotes", "params": {"instruments": [NQ]}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    c.event(&sub, |e| e["data"]["instrument"] == NQ).await;

    let r = invoke(&mut c, "connections.remove", json!({"id": ID})).await;
    assert_eq!(r["output"]["removed"], true, "{r}");
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    let again = i64::from(s.gateway.opened.load(Ordering::SeqCst)) * QUOTES_PER_LOGIN;
    let q = c
        .event(&sub, |e| {
            e["data"]["instrument"] == NQ && e["data"]["ts"].as_i64() > Some(again)
        })
        .await;
    assert_eq!(q["data"]["source"], json!({"provider": ID}));
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn configured_connections_reconnect_at_startup() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let config = || RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        ..s.config()
    };
    let h = s.start(config()).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    drop(c);
    h.shutdown().await.unwrap();

    s.gateway.unreachable.store(1, Ordering::SeqCst);
    let h = s.start(config()).await;
    let c = Client::new(&h).await;
    health_becomes(&h, HealthStatus::Ok).await;
    assert_eq!(s.gateway.unreachable.load(Ordering::SeqCst), 0);
    assert_eq!(resolve(&h, "NQ").await, NQ);
    drop(c);
    h.shutdown().await.unwrap();

    let h = s
        .start(RuntimeConfig {
            secrets: Some(Secrets::in_memory()),
            ..config()
        })
        .await;
    let mut c = Client::new(&h).await;
    settle(
        "the saved connection is listed",
        || health_of(&h),
        Option::is_some,
    )
    .await;
    let row = listed(&mut c)
        .await
        .into_iter()
        .find(|x| x["id"] == ID)
        .unwrap();
    assert_eq!(row["health"]["status"], "down");
    let m = row["health"]["message"].as_str().unwrap();
    assert!(m.contains("missing from the OS keyring"), "{m}");
    let health = c
        .ok("subscribe", json!({"topic": "health", "params": {}}))
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ev = c
        .event(&health, |e| {
            e["data"]["providers"]
                .as_array()
                .is_some_and(|ps| ps.iter().any(|p| p["providerId"] == ID))
        })
        .await;
    let entry = ev["data"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["providerId"] == ID)
        .unwrap()
        .clone();
    assert_eq!(entry["status"], "down", "{entry}");
    assert_eq!(entry["kind"], "market_data", "{entry}");
    assert!(
        entry["message"]
            .as_str()
            .unwrap()
            .contains("missing from the OS keyring"),
        "{entry}"
    );
    assert!(!served(&h, "NQ").await);
    let r = invoke(&mut c, "connections.remove", json!({"id": ID})).await;
    assert_eq!(r["output"]["removed"], true, "{r}");
    assert!(listed(&mut c).await.iter().all(|x| x["id"] != ID));
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_dev_credentials_file_connects_for_one_run_and_a_refusal_is_not_retried() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("credentials.env");
    let write = |password: &str| {
        std::fs::write(
            &file,
            format!(
                "RITHMIC_USERNAME='someone'\nRITHMIC_PASSWORD='{password}'\n\
                 RITHMIC_SYSTEM='Test'\nRITHMIC_GATEWAY='{GATEWAY}'\n"
            ),
        )
        .unwrap();
    };

    write(GOOD);
    let h = s
        .start(RuntimeConfig {
            rithmic_credentials: Some(file.clone()),
            ..s.config()
        })
        .await;
    health_becomes(&h, HealthStatus::Ok).await;
    assert_eq!(resolve(&h, "NQ").await, NQ);
    assert_eq!(h.state.connections.info(ID).unwrap().enabled, None);
    assert_eq!(h.state.store.settings().get(RECORDS_KEY).unwrap(), None);
    assert_eq!(s.secrets.get(&secret_ref()).await.unwrap(), None);
    h.shutdown().await.unwrap();

    write("wrong-password-2");
    let before = s.gateway.attempts.load(Ordering::SeqCst);
    let h = s
        .start(RuntimeConfig {
            rithmic_credentials: Some(file.clone()),
            ..s.config()
        })
        .await;
    health_becomes(&h, HealthStatus::Down).await;
    settle(
        "the refused login's task ends",
        || s.gateway.login_holders(),
        |&(now, while_connecting)| now < while_connecting,
    )
    .await;
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), before + 1);
    let info = h.state.connections.info(ID).unwrap();
    let m = info.health.message.unwrap();
    assert!(
        m.contains("refused") && !m.contains("wrong-password-2"),
        "{m}"
    );
    let mut c = Client::new(&h).await;
    let r = invoke(&mut c, "connections.reconnect", json!({"id": ID})).await;
    assert_eq!(r["output"]["connection"]["health"]["status"], "down", "{r}");
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), before + 2);
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_runtime_without_rithmic_refuses_every_login() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("credentials.env");
    std::fs::write(
        &file,
        format!(
            "RITHMIC_USERNAME='someone'\nRITHMIC_PASSWORD='{GOOD}'\n\
             RITHMIC_SYSTEM='Test'\nRITHMIC_GATEWAY='{GATEWAY}'\n"
        ),
    )
    .unwrap();
    let h = s
        .start(RuntimeConfig {
            rithmic_credentials: Some(file),
            rithmic: Some(Arc::new(NoRithmic)),
            ..s.config()
        })
        .await;
    let mut c = Client::new(&h).await;
    let tested = invoke(&mut c, "connections.test_rithmic", login(GOOD)).await;
    assert_eq!(tested["output"]["ok"], false, "{tested}");
    assert_eq!(tested["output"]["message"], NO_RITHMIC, "{tested}");
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["error"]["code"], "unavailable", "{added}");
    assert!(added.to_string().contains(NO_RITHMIC), "{added}");
    assert!(listed(&mut c).await.iter().all(|x| x["id"] != ID));
    assert!(h.state.connections.info(ID).is_none());
    assert_eq!(h.state.store.settings().get(RECORDS_KEY).unwrap(), None);
    assert_eq!(s.secrets.get(&secret_ref()).await.unwrap(), None);
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), 0);
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_fresh_desk_opens_its_charts_on_the_users_connection() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("rithmic.env");
    std::fs::write(
        &file,
        format!(
            "RITHMIC_USERNAME=someone\nRITHMIC_PASSWORD={GOOD}\nRITHMIC_SYSTEM=Test\nRITHMIC_GATEWAY={GATEWAY}\n"
        ),
    )
    .unwrap();
    let config = || RuntimeConfig {
        rithmic_credentials: Some(file.clone()),
        ..s.config()
    };
    let chart = |h: &RuntimeHandle, tile: &str| {
        h.state
            .layouts
            .get(Some("default"))
            .unwrap()
            .charts
            .get(tile)
            .map(|c| (c.instrument.to_string(), c.timeframe))
    };

    s.gateway.unreachable.store(2, Ordering::SeqCst);
    let h = s.start(config()).await;
    let layout = h.state.layouts.get(Some("default")).unwrap();
    assert_eq!(layout.name, "Day · NQ/ES");
    assert!(
        layout.charts.is_empty(),
        "nothing to chart before the login lands"
    );
    settle(
        "chart-1 opens on the login",
        || chart(&h, "chart-1"),
        |c| c.as_ref().is_some_and(|(i, _)| i == NQ),
    )
    .await;
    assert_eq!(chart(&h, "chart-1").unwrap().1, Timeframe::M5);
    assert_eq!(
        h.state
            .layouts
            .get(Some("default"))
            .unwrap()
            .active_chart_id
            .as_deref(),
        Some("chart-1")
    );
    assert_eq!(
        chart(&h, "chart-2"),
        None,
        "a root the connection does not serve waits"
    );
    h.shutdown().await.unwrap();

    s.gateway.unreachable.store(2, Ordering::SeqCst);
    let h = s.start(config()).await;
    let mut c = Client::new(&h).await;
    let mine = json!({"chart-1": {"tileId": "chart-1", "title": "Mine", "instrument": NQ,
        "timeframe": "15m", "layers": [], "annotations": [], "drawings": []}});
    let r = invoke(
        &mut c,
        "layout.save",
        json!({"layoutId": "default", "charts": mine}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    health_becomes(&h, HealthStatus::Ok).await;
    settle(
        "the login's pass over the waiting charts leaves the user's chart-1",
        || {
            h.state
                .store
                .settings()
                .get(tessera_runtime::layout::PENDING_KEY)
                .unwrap()
        },
        |pending| {
            pending
                .as_ref()
                .and_then(Value::as_array)
                .is_none_or(|p| p.iter().all(|c| c["tile"] != "chart-1"))
        },
    )
    .await;
    assert_eq!(chart(&h, "chart-1"), Some((NQ.to_owned(), Timeframe::M15)));
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_default_charts_wait_for_the_users_connection_across_a_restart() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("rithmic.env");
    std::fs::write(
        &file,
        format!(
            "RITHMIC_USERNAME=someone\nRITHMIC_PASSWORD={GOOD}\nRITHMIC_SYSTEM=Test\nRITHMIC_GATEWAY={GATEWAY}\n"
        ),
    )
    .unwrap();
    let data = dir.path().join("data");
    let config = || RuntimeConfig {
        rithmic_credentials: Some(file.clone()),
        data_dir: Some(data.clone()),
        ..s.config()
    };
    let chart = |h: &RuntimeHandle| {
        h.state
            .layouts
            .get(Some("default"))
            .unwrap()
            .charts
            .get("chart-1")
            .map(|c| c.instrument.to_string())
    };

    s.gateway.unreachable.store(u32::MAX, Ordering::SeqCst);
    let h = s.start(config()).await;
    settle(
        "the waiting charts ask the connection that cannot log in",
        || s.gateway.resolves.load(Ordering::SeqCst),
        |&asked| asked >= 1,
    )
    .await;
    assert_eq!(chart(&h), None);
    h.shutdown().await.unwrap();

    s.gateway.unreachable.store(0, Ordering::SeqCst);
    let h = s.start(config()).await;
    settle(
        "chart-1 opens once the login lands",
        || chart(&h),
        |c| c.as_deref() == Some(NQ),
    )
    .await;
    h.shutdown().await.unwrap();
}

fn order_request() -> OrderRequest {
    OrderRequest {
        account_id: AccountId::new(ACCOUNT),
        instrument: InstrumentId::new(NQ).unwrap(),
        side: Side::Buy,
        qty: Qty::from(1),
        order_type: OrderType::Market,
        limit_price: None,
        stop_price: None,
        tif: TimeInForce::Day,
        bracket: None,
        client_order_id: None,
        reduce_only: false,
    }
}

#[tokio::test]
async fn order_entry_on_an_evaluation_is_the_users_own_switch() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let config = || RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        ..s.config()
    };
    let h = s.start(config()).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    let switch =
        |enabled: bool| json!({"connectionId": ID, "accountId": ACCOUNT, "enabled": enabled});
    let guard = || Arc::clone(h.state.broker.service().broker());

    let registry = h.state.invoker.registry();
    assert!(
        registry
            .descriptors(Audience::Agent, None, true)
            .iter()
            .all(|d| d.name != "connections.set_order_entry")
    );
    let r = h
        .state
        .invoker
        .invoke(InvokeRequest::new(
            "connections.set_order_entry",
            switch(true),
            Origin::External {
                client_id: "mcp-client".into(),
            },
        ))
        .await;
    let r = serde_json::to_value(r).unwrap();
    assert_eq!(r["error"]["code"], "permission_denied", "{r}");
    assert!(matches!(
        guard().route(&order_request().account_id).await,
        Err(BrokerError::Refused(SendRefused::OrderEntryOff))
    ));

    let r = invoke(&mut c, "connections.set_order_entry", switch(true)).await;
    assert_eq!(r["output"]["enabled"], true, "{r}");
    let row = listed(&mut c)
        .await
        .into_iter()
        .find(|x| x["id"] == ID)
        .unwrap();
    assert_eq!(row["accountOrderEntry"], json!([ACCOUNT]));
    assert_eq!(row["broker"]["readOnly"], false);
    assert_eq!(
        guard()
            .route(&order_request().account_id)
            .await
            .unwrap()
            .environment,
        Environment::Eval
    );
    let _ = guard().submit(order_request(), None).await;
    assert_eq!(s.gateway.sent.load(Ordering::SeqCst), 1);
    let kept = h
        .state
        .store
        .settings()
        .get(ORDER_ENTRY_KEY)
        .unwrap()
        .unwrap();
    assert_eq!(kept, json!([{"connectionId": ID, "accountId": ACCOUNT}]));
    let r = invoke(
        &mut c,
        "connections.set_order_entry",
        json!({"connectionId": ID, "accountId": "rithmic-test-nope", "enabled": true}),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    drop(c);
    h.shutdown().await.unwrap();

    let h = s.start(config()).await;
    health_becomes(&h, HealthStatus::Ok).await;
    let guard = || Arc::clone(h.state.broker.service().broker());
    assert!(guard().route(&order_request().account_id).await.is_ok());

    let mut c = Client::new(&h).await;
    let r = invoke(&mut c, "connections.set_order_entry", switch(false)).await;
    assert_eq!(r["output"]["enabled"], false, "{r}");
    assert!(matches!(
        guard().route(&order_request().account_id).await,
        Err(BrokerError::Refused(SendRefused::OrderEntryOff))
    ));
    let r = invoke(&mut c, "connections.set_order_entry", switch(true)).await;
    assert_eq!(r["ok"], true, "{r}");
    let r = invoke(&mut c, "connections.remove", json!({"id": ID})).await;
    assert_eq!(r["output"]["removed"], true, "{r}");
    assert_eq!(
        h.state.store.settings().get(ORDER_ENTRY_KEY).unwrap(),
        Some(json!([]))
    );
    assert!(!guard().account_order_entry(ID, &AccountId::new(ACCOUNT)));
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_switch_the_connection_refuses_turns_nothing_on() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    let on = json!({"connectionId": ID, "accountId": ACCOUNT, "enabled": true});
    let guard = || Arc::clone(h.state.broker.service().broker());

    s.gateway.refuse_order_entry.store(true, Ordering::SeqCst);
    let r = invoke(&mut c, "connections.set_order_entry", on.clone()).await;
    assert_eq!(r["error"]["code"], "rejected", "{r}");
    assert!(matches!(
        guard().route(&order_request().account_id).await,
        Err(BrokerError::Refused(SendRefused::OrderEntryOff))
    ));
    let row = listed(&mut c)
        .await
        .into_iter()
        .find(|x| x["id"] == ID)
        .unwrap();
    assert_eq!(row["accountOrderEntry"], json!([]), "{row}");
    assert_eq!(h.state.store.settings().get(ORDER_ENTRY_KEY).unwrap(), None);

    s.gateway.refuse_order_entry.store(false, Ordering::SeqCst);
    let r = invoke(&mut c, "connections.set_order_entry", on).await;
    assert_eq!(r["output"]["enabled"], true, "{r}");
    assert!(guard().route(&order_request().account_id).await.is_ok());
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_users_market_data_choice_moves_charts_and_decides_what_trades() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    let chart = |h: &RuntimeHandle, tile: &str| {
        h.state
            .layouts
            .get(Some("default"))
            .unwrap()
            .charts
            .get(tile)
            .cloned()
    };
    let on = |h: &RuntimeHandle, tile: &str, id: &str| {
        chart(h, tile).is_some_and(|c| c.instrument.as_str() == id)
    };
    settle(
        "chart-1 moves to NQ",
        || chart(&h, "chart-1").map(|c| c.instrument.to_string()),
        |c| c.as_deref() == Some(NQ),
    )
    .await;
    add_second_connection(&h);
    settle(
        "chart-2 moves to ESZ6.CME",
        || chart(&h, "chart-2").map(|c| c.instrument.to_string()),
        |c| c.as_deref() == Some("ESZ6.CME"),
    )
    .await;
    let list = invoke(&mut c, "connections.list", json!({})).await;
    assert_eq!(list["output"]["dataSource"], ID, "{list}");
    let r = invoke(
        &mut c,
        "chart.add_drawing",
        json!({"layoutId": "default", "tileId": "chart-1", "kind": "horizontal_line",
               "points": [{"t": "2026-10-02T10:00:00-04:00", "price": 20000}]}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    let layers = chart(&h, "chart-1").unwrap().layers;

    for origin in [
        Origin::Agent {
            session_id: tessera_core::ids::SessionId::new("S1"),
            provider: "codex".into(),
        },
        Origin::External {
            client_id: "mcp-client".into(),
        },
    ] {
        let r = h
            .state
            .invoker
            .invoke(InvokeRequest::new(
                "settings.set",
                json!({"key": "market.dataSource", "value": "mock"}),
                origin,
            ))
            .await;
        let r = serde_json::to_value(r).unwrap();
        assert_eq!(r["error"]["code"], "permission_denied", "{r}");
    }
    assert_eq!(h.state.connections.market().data_source().unwrap().id, ID);

    let es = chart(&h, "chart-2").unwrap().instrument;
    let r = invoke(
        &mut c,
        "settings.set",
        json!({"key": "market.dataSource", "value": "mock"}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(resolve(&h, "NQ").await, "NQZ6.CME");
    settle(
        "chart-1 moves to NQZ6.CME",
        || chart(&h, "chart-1").map(|c| c.instrument.to_string()),
        |c| c.as_deref() == Some("NQZ6.CME"),
    )
    .await;
    let moved = chart(&h, "chart-1").unwrap();
    assert_eq!(moved.layers, layers);
    assert_eq!(moved.drawings.len(), 1);
    assert_eq!(moved.drawings[0].instrument.as_str(), "NQZ6.CME");
    assert_eq!(chart(&h, "chart-2").unwrap().instrument, es);
    let list = invoke(&mut c, "connections.list", json!({})).await;
    assert_eq!(list["output"]["dataSource"], "mock");

    let r = invoke(
        &mut c,
        "connections.set_order_entry",
        json!({"connectionId": ID, "accountId": ACCOUNT, "enabled": true}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    let r = invoke(
        &mut c,
        "orders.contract_for",
        json!({"accountId": ACCOUNT, "instrument": "NQZ6.CME"}),
    )
    .await;
    assert_eq!(r["output"]["instrument"]["id"], NQ, "{r}");
    assert_eq!(r["output"]["refused"], Value::Null);
    assert_eq!(r["output"]["account"], "TEST-000001 (Test · Rithmic)");

    let r = invoke(
        &mut c,
        "settings.set",
        json!({"key": "market.dataSource", "value": ID}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    settle(
        "chart-1 moves to NQ",
        || chart(&h, "chart-1").map(|c| c.instrument.to_string()),
        |c| c.as_deref() == Some(NQ),
    )
    .await;
    assert_eq!(
        chart(&h, "chart-1").unwrap().drawings[0]
            .instrument
            .as_str(),
        NQ
    );
    let r = invoke(
        &mut c,
        "orders.contract_for",
        json!({"accountId": ACCOUNT, "instrument": NQ}),
    )
    .await;
    assert_eq!(r["output"]["instrument"]["id"], NQ, "{r}");
    assert_eq!(r["output"]["refused"], Value::Null);

    let r = invoke(
        &mut c,
        "chart.set_symbol",
        json!({"layoutId": "default", "tileId": "chart-1", "instrument": "NQZ6.CME"}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    let before = s.gateway.attempts.load(Ordering::SeqCst);
    let r = invoke(&mut c, "connections.reconnect", json!({"id": ID})).await;
    assert_eq!(r["ok"], true, "{r}");
    settle(
        "the reconnect logs in again",
        || (s.gateway.attempts.load(Ordering::SeqCst), health_of(&h)),
        |(attempts, health)| {
            *attempts > before
                && health
                    .as_ref()
                    .is_some_and(|(now, _)| *now == HealthStatus::Ok)
        },
    )
    .await;
    assert!(on(&h, "chart-1", "NQZ6.CME"));
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_exchanges_own_market_data_moves_its_charts_alone() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    let chart = |h: &RuntimeHandle, tile: &str| {
        h.state
            .layouts
            .get(Some("default"))
            .unwrap()
            .charts
            .get(tile)
            .cloned()
    };
    let on = |h: &RuntimeHandle, tile: &str, id: &str| {
        chart(h, tile).is_some_and(|c| c.instrument.as_str() == id)
    };
    let routing = |h: &RuntimeHandle| {
        h.state
            .store
            .settings()
            .get(tessera_runtime::layout::CHARTS_SOURCE_KEY)
            .unwrap()
    };
    let login_routing = json!(ID);
    settle(
        "chart-1 opens on the login and the routing names it",
        || {
            (
                chart(&h, "chart-1").map(|c| c.instrument.to_string()),
                routing(&h),
            )
        },
        |(c, r)| c.as_deref() == Some(NQ) && r.as_ref() == Some(&login_routing),
    )
    .await;
    add_second_connection(&h);
    settle(
        "chart-2 opens on the second connection",
        || chart(&h, "chart-2").map(|c| c.instrument.to_string()),
        Option::is_some,
    )
    .await;
    let r = invoke(
        &mut c,
        "chart.set_symbol",
        json!({"layoutId": "default", "tileId": "chart-2", "instrument": "QQQ"}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    let qqq = chart(&h, "chart-2").unwrap().instrument;
    assert_eq!(qqq.as_str(), "QQQ");

    for (key, value) in [
        ("market.dataByExchange", json!({"CME": "mock"})),
        ("trade.accountByExchange", json!({"CME": ACCOUNT})),
    ] {
        for origin in [
            Origin::Agent {
                session_id: tessera_core::ids::SessionId::new("S1"),
                provider: "codex".into(),
            },
            Origin::External {
                client_id: "mcp-client".into(),
            },
        ] {
            let r = h
                .state
                .invoker
                .invoke(InvokeRequest::new(
                    "settings.set",
                    json!({"key": key, "value": value}),
                    origin,
                ))
                .await;
            let r = serde_json::to_value(r).unwrap();
            assert_eq!(r["error"]["code"], "permission_denied", "{key}: {r}");
        }
    }
    let market = h.state.connections.market();
    assert!(market.exchange_choices().is_empty());

    let set = |key: &'static str, value: Value| json!({"key": key, "value": value});
    let r = invoke(
        &mut c,
        "settings.set",
        set("market.dataSource", json!("mock")),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    settle(
        "chart-1 moves to NQZ6.CME",
        || chart(&h, "chart-1").map(|c| c.instrument.to_string()),
        |c| c.as_deref() == Some("NQZ6.CME"),
    )
    .await;
    let r = invoke(
        &mut c,
        "chart.add_drawing",
        json!({"layoutId": "default", "tileId": "chart-1", "kind": "horizontal_line",
               "points": [{"t": "2026-10-02T10:00:00-04:00", "price": 20000}]}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    let layers = chart(&h, "chart-1").unwrap().layers;

    let r = invoke(
        &mut c,
        "settings.set",
        set("market.dataByExchange", json!({"NASDAQ": ID})),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    let followed = json!(format!("mock NASDAQ={ID}"));
    settle(
        "the routing follows NASDAQ to the login",
        || routing(&h),
        |r| r.as_ref() == Some(&followed),
    )
    .await;
    assert!(on(&h, "chart-1", "NQZ6.CME"));
    assert_eq!(chart(&h, "chart-2").unwrap().instrument, qqq);

    let r = invoke(
        &mut c,
        "settings.set",
        set("market.dataByExchange", json!({"CME": ID})),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    settle(
        "chart-1 moves to NQ",
        || chart(&h, "chart-1").map(|c| c.instrument.to_string()),
        |c| c.as_deref() == Some(NQ),
    )
    .await;
    let moved = chart(&h, "chart-1").unwrap();
    assert_eq!(moved.layers, layers);
    assert_eq!(moved.drawings[0].instrument.as_str(), NQ);
    assert_eq!(chart(&h, "chart-2").unwrap().instrument, qqq);
    assert_eq!(market.data_source_for("CME").unwrap().id, ID);
    assert_eq!(market.data_source().unwrap().id, "mock");
    assert_eq!(resolve(&h, "NQ").await, NQ);
    assert_eq!(resolve(&h, "ES").await, "ESZ6.CME", "the login lists no ES");
    let list = invoke(&mut c, "connections.list", json!({})).await;
    assert_eq!(list["output"]["dataSource"], "mock", "{list}");

    let r = invoke(
        &mut c,
        "settings.set",
        set("market.dataByExchange", json!({"cme": ID})),
    )
    .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");
    let r = invoke(
        &mut c,
        "settings.set",
        set("trade.accountByExchange", json!({"CME": ACCOUNT})),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(market.data_source_for("CME").unwrap().id, ID, "unchanged");

    let r = invoke(
        &mut c,
        "settings.set",
        set("market.dataByExchange", json!({})),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    settle(
        "chart-1 moves to NQZ6.CME",
        || chart(&h, "chart-1").map(|c| c.instrument.to_string()),
        |c| c.as_deref() == Some("NQZ6.CME"),
    )
    .await;
    assert_eq!(
        chart(&h, "chart-1").unwrap().drawings[0]
            .instrument
            .as_str(),
        "NQZ6.CME"
    );
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn saved_logins_are_listed_tested_and_replaced_by_the_user_alone() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;
    let health = |h: &RuntimeHandle| h.state.connections.info(ID).map(|i| i.health.status);

    let registry = h.state.invoker.registry();
    for (name, input) in [
        ("connections.list_credentials", json!({})),
        ("connections.test_credential", json!({"id": ID})),
        ("connections.replace_rithmic", login(GOOD2)),
    ] {
        assert!(
            registry
                .descriptors(Audience::Agent, None, true)
                .iter()
                .all(|d| d.name != name),
            "{name} is visible to agents"
        );
        for origin in [
            Origin::External {
                client_id: "mcp-client".into(),
            },
            Origin::Agent {
                session_id: tessera_core::ids::SessionId::new("S1"),
                provider: "codex".into(),
            },
        ] {
            let r = h
                .state
                .invoker
                .invoke(InvokeRequest::new(name, input.clone(), origin))
                .await;
            let r = serde_json::to_value(r).unwrap();
            assert_eq!(r["error"]["code"], "permission_denied", "{name}: {r}");
        }
    }
    let replaced = || {
        h.state
            .store
            .tool_calls()
            .recent(100, None)
            .unwrap()
            .into_iter()
            .filter(|r| r.tool == "connections.replace_rithmic")
            .collect::<Vec<_>>()
    };
    settle(
        "both replacements are recorded",
        || replaced().len(),
        |&n| n == 2,
    )
    .await;
    let replaced = replaced();
    for r in replaced {
        assert_eq!(
            r.input,
            json!({"system": "[redacted]", "gateway": "[redacted]", "user": "[redacted]", "password": "[redacted]"})
        );
    }

    let out = invoke(&mut c, "connections.list_credentials", json!({})).await;
    assert_eq!(out["output"], json!({"credentials": []}), "{out}");
    let r = invoke(&mut c, "connections.test_credential", json!({"id": ID})).await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    let r = invoke(&mut c, "connections.replace_rithmic", login(GOOD2)).await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("add it instead"),
        "{r}"
    );
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), 0);

    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    let out = invoke(&mut c, "connections.list_credentials", json!({})).await;
    assert_eq!(
        out["output"]["credentials"],
        json!([{
            "connectionId": ID,
            "kind": "rithmic",
            "name": "Test · Rithmic",
            "system": "Test",
            "user": "someone",
            "gateway": null,
            "store": "keyring",
            "location": format!("OS keyring, service tessera, key rithmic.{ID}"),
            "state": "stored",
            "message": null,
        }]),
        "{out}"
    );
    assert!(!out.to_string().contains(GOOD), "{out}");
    assert!(!out.to_string().contains("gateway.invalid"), "{out}");

    let before = s.gateway.attempts.load(Ordering::SeqCst);
    let t = invoke(&mut c, "connections.test_credential", json!({"id": ID})).await;
    assert_eq!(
        t["output"],
        json!({"ok": true, "message": "Test is connected with this login."}),
        "{t}"
    );
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), before);

    s.gateway.unreachable.store(1, Ordering::SeqCst);
    let r = invoke(&mut c, "connections.reconnect", json!({"id": ID})).await;
    assert_eq!(r["output"]["connection"]["health"]["status"], "down", "{r}");
    health_becomes(&h, HealthStatus::Ok).await;
    let t = invoke(&mut c, "connections.test_credential", json!({"id": ID})).await;
    assert_eq!(
        t["output"],
        json!({"ok": true, "message": "Test is connected with this login."}),
        "{t}"
    );
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), before + 2);
    let r = invoke(&mut c, "connections.reconnect", json!({"id": ID})).await;
    assert_eq!(r["output"]["connection"]["health"]["status"], "ok", "{r}");

    let saved = s.secrets.get(&secret_ref()).await.unwrap().unwrap();
    let r = invoke(
        &mut c,
        "connections.replace_rithmic",
        login("wrong-password-3"),
    )
    .await;
    assert_eq!(r["error"]["code"], "rejected", "{r}");
    let m = r["error"]["message"].as_str().unwrap();
    assert!(
        m.ends_with("Nothing changed.") && !m.contains("wrong-password-3"),
        "{m}"
    );
    assert_eq!(s.secrets.get(&secret_ref()).await.unwrap().unwrap(), saved);
    health_becomes(&h, HealthStatus::Ok).await;
    assert_eq!(resolve(&h, "NQ").await, NQ);

    let r = invoke(&mut c, "connections.replace_rithmic", login(GOOD2)).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["storedIn"], "keyring");
    assert_eq!(r["output"]["connection"]["id"], ID);
    assert_eq!(r["output"]["connection"]["health"]["message"], "Connected");
    assert!(!r.to_string().contains(GOOD2), "{r}");
    let now = s.secrets.get(&secret_ref()).await.unwrap().unwrap();
    assert!(
        now.contains(GOOD2) && !now.contains(GOOD),
        "the new login is kept"
    );
    let record = h.state.store.settings().get(RECORDS_KEY).unwrap().unwrap();
    assert_eq!(record.as_array().unwrap().len(), 1, "{record}");
    assert!(!record.to_string().contains(GOOD2), "{record}");
    assert_eq!(health(&h), Some(HealthStatus::Ok));
    assert_eq!(resolve(&h, "NQ").await, NQ);

    s.gateway.unreachable.store(u32::MAX, Ordering::SeqCst);
    let r = invoke(&mut c, "connections.reconnect", json!({"id": ID})).await;
    assert_eq!(r["output"]["connection"]["health"]["status"], "down", "{r}");
    s.secrets.delete_everywhere(&secret_ref()).await.unwrap();
    let out = invoke(&mut c, "connections.list_credentials", json!({})).await;
    let row = &out["output"]["credentials"][0];
    assert_eq!(row["state"], "missing", "{out}");
    assert_eq!(row["user"], Value::Null);
    assert!(
        row["message"]
            .as_str()
            .unwrap()
            .contains("missing from the OS keyring"),
        "{out}"
    );
    let t = invoke(&mut c, "connections.test_credential", json!({"id": ID})).await;
    assert_eq!(t["output"]["ok"], false, "{t}");
    assert!(
        t["output"]["message"]
            .as_str()
            .unwrap()
            .contains("missing from the OS keyring"),
        "{t}"
    );
    drop(c);
    h.shutdown().await.unwrap();
}

async fn assert_users_alone(h: &RuntimeHandle, name: &str, input: Value) {
    let registry = h.state.invoker.registry();
    assert!(
        registry
            .descriptors(Audience::Agent, None, true)
            .iter()
            .all(|d| d.name != name),
        "{name} is visible to agents"
    );
    for origin in [
        Origin::External {
            client_id: "mcp-client".into(),
        },
        Origin::Agent {
            session_id: tessera_core::ids::SessionId::new("S1"),
            provider: "codex".into(),
        },
    ] {
        let r = h
            .state
            .invoker
            .invoke(InvokeRequest::new(name, input.clone(), origin))
            .await;
        let r = serde_json::to_value(r).unwrap();
        assert_eq!(r["error"]["code"], "permission_denied", "{name}: {r}");
    }
}

#[tokio::test]
async fn a_gateway_is_chosen_by_name_from_rithmics_directory() {
    let s = Setup::new().await;
    *s.gateway.directory.lock() = vec![DIRECTORY.into()];
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;
    assert_users_alone(
        &h,
        "connections.rithmic_directory",
        json!({"system": "Test"}),
    )
    .await;
    assert_eq!(s.gateway.directory_asks.load(Ordering::SeqCst), 0);

    let out = directory(&mut c, json!({})).await;
    assert_eq!(
        out,
        json!({"systems": SYSTEMS, "gateways": [], "problem": null})
    );
    let out = directory(&mut c, json!({"system": "Test"})).await;
    assert_eq!(
        out,
        json!({"systems": SYSTEMS, "gateways": ["Chicago Area", "Europe"], "problem": null})
    );
    assert_eq!(s.gateway.directory_asks.load(Ordering::SeqCst), 2);
    directory(&mut c, json!({"system": "Test"})).await;
    assert_eq!(s.gateway.directory_asks.load(Ordering::SeqCst), 2);
    let out = directory(&mut c, json!({"system": "Nowhere"})).await;
    assert_eq!(out["systems"], json!(SYSTEMS));
    assert_eq!(out["gateways"], json!([]));
    assert_eq!(
        out["problem"],
        "Tessera cannot ask Rithmic for Nowhere's gateways (Rithmic refused the request: no such \
         system (code 7)). Type the gateway's address instead."
    );

    let r = invoke(&mut c, "connections.add_rithmic", login_at("Mars", GOOD)).await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");
    assert_eq!(
        r["error"]["message"],
        "Rithmic lists no gateway “Mars” for Test."
    );
    let r = invoke(
        &mut c,
        "connections.test_rithmic",
        json!({"system": "Nowhere", "gateway": "Chicago Area", "user": "someone", "password": GOOD}),
    )
    .await;
    assert_eq!(r["error"]["code"], "unavailable", "{r}");
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Tessera cannot ask Rithmic for Nowhere's gateways"),
        "{r}"
    );
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), 0);

    let added = invoke(
        &mut c,
        "connections.add_rithmic",
        login_at("chicago area", GOOD),
    )
    .await;
    assert_eq!(added["ok"], true, "{added}");
    assert_eq!(s.gateway.last_gateway().as_deref(), Some(CHICAGO));
    let saved = s.secrets.get(&secret_ref()).await.unwrap().unwrap();
    assert!(
        saved.contains(CHICAGO) && saved.contains("Chicago Area"),
        "the address and the name are kept"
    );
    let named = invoke(&mut c, "connections.list_credentials", json!({})).await;
    assert_eq!(
        named["output"]["credentials"][0]["gateway"], "Chicago Area",
        "{named}"
    );
    let replaced = invoke(&mut c, "connections.replace_rithmic", login(GOOD2)).await;
    assert_eq!(replaced["ok"], true, "{replaced}");
    assert_eq!(s.gateway.last_gateway().as_deref(), Some(GATEWAY));
    let typed = invoke(&mut c, "connections.list_credentials", json!({})).await;
    assert_eq!(
        typed["output"]["credentials"][0]["gateway"],
        Value::Null,
        "{typed}"
    );

    let record = h.state.store.settings().get(RECORDS_KEY).unwrap().unwrap();
    let listing = invoke(&mut c, "connections.list", json!({})).await;
    for text in [
        record.to_string(),
        added.to_string(),
        named.to_string(),
        replaced.to_string(),
        listing.to_string(),
        out.to_string(),
    ] {
        assert!(!text.contains(".invalid"), "{text}");
    }
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_directory_out_of_reach_is_said_in_plain_words() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;

    let out = directory(&mut c, json!({"system": "Test"})).await;
    assert_eq!(
        out,
        json!({"systems": [], "gateways": [], "problem": "Tessera has no Rithmic address to ask yet: type your gateway's address."})
    );
    let r = invoke(
        &mut c,
        "connections.add_rithmic",
        login_at("Chicago Area", GOOD),
    )
    .await;
    assert_eq!(r["error"]["code"], "unavailable", "{r}");
    assert_eq!(
        r["error"]["message"],
        "Tessera cannot ask Rithmic for Test's gateways (it has no Rithmic address to ask yet). \
         Type the gateway's address instead."
    );

    s.gateway.directory_down.store(true, Ordering::SeqCst);
    let t = invoke(&mut c, "connections.test_rithmic", login(GOOD)).await;
    assert_eq!(t["output"]["ok"], true, "{t}");
    let asked = s.gateway.directory_asks.load(Ordering::SeqCst);
    let out = directory(&mut c, json!({})).await;
    assert_eq!(s.gateway.directory_asks.load(Ordering::SeqCst), asked + 1);
    assert_eq!(
        out,
        json!({"systems": [], "gateways": [], "problem": "Tessera cannot ask Rithmic for its systems (cannot reach Rithmic: connection refused). Type the system and the gateway's address instead."})
    );
    let r = invoke(
        &mut c,
        "connections.add_rithmic",
        login_at("Chicago Area", GOOD),
    )
    .await;
    assert_eq!(r["error"]["code"], "unavailable", "{r}");
    assert_eq!(
        r["error"]["message"],
        "Tessera cannot ask Rithmic for Test's gateways (cannot reach Rithmic: connection \
         refused). Type the gateway's address instead."
    );
    assert!(listed(&mut c).await.iter().all(|x| x["id"] != ID));

    s.gateway.directory_down.store(false, Ordering::SeqCst);
    let out = directory(&mut c, json!({"system": "Test"})).await;
    assert_eq!(
        out,
        json!({"systems": SYSTEMS, "gateways": ["Chicago Area", "Europe"], "problem": null})
    );
    let added = invoke(&mut c, "connections.add_rithmic", login_at("Europe", GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    assert_eq!(s.gateway.last_gateway().as_deref(), Some(EUROPE));
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_saved_login_is_turned_off_and_on_by_the_user() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let config = || RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        ..s.config()
    };
    let h = s.start(config()).await;
    let mut c = Client::new(&h).await;
    assert_users_alone(
        &h,
        "connections.set_enabled",
        json!({"id": ID, "enabled": false}),
    )
    .await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["output"]["connection"]["enabled"], true, "{added}");
    let r = invoke(
        &mut c,
        "connections.set_order_entry",
        json!({"connectionId": ID, "accountId": ACCOUNT, "enabled": true}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    add_second_connection(&h);
    let other = listed(&mut c)
        .await
        .into_iter()
        .find(|x| x["id"] == "mock")
        .unwrap();
    assert_eq!(other["enabled"], Value::Null);
    assert!(h.state.connections.remove_market("mock"));

    let r = invoke(
        &mut c,
        "connections.set_enabled",
        json!({"id": ID, "enabled": false}),
    )
    .await;
    let conn = r["output"]["connection"].clone();
    assert_eq!(conn["enabled"], false, "{r}");
    assert_eq!(conn["health"]["status"], "disconnected");
    assert_eq!(conn["health"]["message"], "Off.");
    assert_eq!(conn["market"], Value::Null);
    assert_eq!(conn["broker"], Value::Null);
    let row = listed(&mut c)
        .await
        .into_iter()
        .find(|x| x["id"] == ID)
        .unwrap();
    assert_eq!(row, conn);
    assert!(!served(&h, "NQ").await);
    let accounts = invoke(&mut c, "portfolio.get_accounts", json!({})).await;
    assert!(!accounts.to_string().contains(ACCOUNT), "{accounts}");
    let guard = || Arc::clone(h.state.broker.service().broker());
    assert!(!guard().account_order_entry(ID, &AccountId::new(ACCOUNT)));
    let record = h.state.store.settings().get(RECORDS_KEY).unwrap().unwrap();
    assert_eq!(record[0]["enabled"], false, "{record}");
    assert!(s.secrets.get(&secret_ref()).await.unwrap().is_some());
    let switches = json!([{"connectionId": ID, "accountId": ACCOUNT}]);
    assert_eq!(
        h.state.store.settings().get(ORDER_ENTRY_KEY).unwrap(),
        Some(switches.clone())
    );

    let before = s.gateway.attempts.load(Ordering::SeqCst);
    let r = invoke(&mut c, "connections.reconnect", json!({"id": ID})).await;
    assert_eq!(r["error"]["code"], "conflict", "{r}");
    assert_eq!(r["error"]["message"], "It is off: turn it on.");
    let r = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(r["error"]["code"], "conflict", "{r}");
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), before);
    let t = invoke(&mut c, "connections.test_credential", json!({"id": ID})).await;
    assert_eq!(
        t["output"],
        json!({"ok": true, "message": "Logged in to Test."}),
        "{t}"
    );
    let r = invoke(&mut c, "connections.replace_rithmic", login(GOOD2)).await;
    assert_eq!(r["output"]["connection"]["enabled"], false, "{r}");
    assert_eq!(r["output"]["connection"]["health"]["message"], "Off.");
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), before + 2);
    let saved = s.secrets.get(&secret_ref()).await.unwrap().unwrap();
    assert!(saved.contains(GOOD2), "the new login is kept");
    assert!(!served(&h, "NQ").await);
    drop(c);
    h.shutdown().await.unwrap();

    let h = s.start(config()).await;
    let mut c = Client::new(&h).await;
    settle(
        "the saved connection is listed as off",
        || h.state.connections.info(ID).map(|i| i.enabled),
        |enabled| *enabled == Some(Some(false)),
    )
    .await;
    let info = h.state.connections.info(ID).unwrap();
    assert_eq!(info.health.status, HealthStatus::Disconnected);
    assert_eq!(info.health.message.as_deref(), Some("Off."));
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), before + 2);
    assert!(!served(&h, "NQ").await);

    let r = invoke(
        &mut c,
        "connections.set_enabled",
        json!({"id": ID, "enabled": true}),
    )
    .await;
    assert_eq!(r["output"]["connection"]["enabled"], true, "{r}");
    health_becomes(&h, HealthStatus::Ok).await;
    assert_eq!(resolve(&h, "NQ").await, NQ);
    let record = h.state.store.settings().get(RECORDS_KEY).unwrap().unwrap();
    assert_eq!(record[0]["enabled"], true, "{record}");
    let guard = || Arc::clone(h.state.broker.service().broker());
    assert!(guard().route(&order_request().account_id).await.is_ok());
    let accounts = invoke(&mut c, "portfolio.get_accounts", json!({})).await;
    assert!(accounts.to_string().contains(ACCOUNT), "{accounts}");

    let r = invoke(
        &mut c,
        "connections.set_enabled",
        json!({"id": ID, "enabled": false}),
    )
    .await;
    assert_eq!(r["output"]["connection"]["enabled"], false, "{r}");
    let r = invoke(&mut c, "connections.remove", json!({"id": ID})).await;
    assert_eq!(r["output"]["removed"], true, "{r}");
    assert!(listed(&mut c).await.iter().all(|x| x["id"] != ID));
    assert_eq!(
        h.state.store.settings().get(RECORDS_KEY).unwrap(),
        Some(json!([]))
    );
    assert_eq!(s.secrets.get(&secret_ref()).await.unwrap(), None);
    assert_eq!(
        h.state.store.settings().get(ORDER_ENTRY_KEY).unwrap(),
        Some(json!([]))
    );
    let r = invoke(
        &mut c,
        "connections.set_enabled",
        json!({"id": ID, "enabled": true}),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn after_an_update_a_saved_login_is_never_taken_for_none() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let keychain = Keychain::new();
    let config = |build: &str| RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        secrets: Some(
            Secrets::with_stores(Some(keychain.build(build)), None)
                .without_fallback()
                .with_deadline(Duration::from_secs(4)),
        ),
        ..s.config()
    };
    let h = s.start(config("build-1")).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    drop(c);
    h.shutdown().await.unwrap();
    let attempts = s.gateway.attempts.load(Ordering::SeqCst);

    let h = s.start(config("build-2")).await;
    let mut c = Client::new(&h).await;
    let row = listed(&mut c).await.into_iter().find(|x| x["id"] == ID);
    let row = row.expect("the saved login is listed from the runtime's first answer");
    assert_eq!(row["kind"], "market_data", "{row}");
    assert_eq!(row["health"]["status"], "unknown", "{row}");
    settle(
        "the keyring's deadline passes and the login keeps waiting for it",
        || health_of(&h),
        |seen| {
            seen.as_ref().is_some_and(|(_, m)| {
                m.as_deref()
                    .is_some_and(|m| m.starts_with("Waiting for the OS keyring"))
            })
        },
    )
    .await;
    let row = listed(&mut c)
        .await
        .into_iter()
        .find(|x| x["id"] == ID)
        .unwrap();
    assert_eq!(row["health"]["status"], "unknown", "{row}");
    assert_eq!(keychain.asked(), 1);
    keychain.answer(Answer::Allow);
    health_becomes(&h, HealthStatus::Ok).await;
    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), attempts + 1);
    drop(c);
    h.shutdown().await.unwrap();

    keychain.answer(Answer::Deny);
    let h = s.start(config("build-3")).await;
    let mut c = Client::new(&h).await;
    health_becomes(&h, HealthStatus::Down).await;
    let row = listed(&mut c)
        .await
        .into_iter()
        .find(|x| x["id"] == ID)
        .unwrap();
    assert_eq!(row["credential"], "unreadable", "{row}");
    let m = row["health"]["message"].as_str().unwrap();
    assert!(m.contains("cannot be read"), "{m}");
    assert!(!m.contains("Log in again"), "{m}");
    assert!(!served(&h, "NQ").await);
    keychain.answer(Answer::Allow);
    let r = invoke(&mut c, "connections.reconnect", json!({"id": ID})).await;
    assert_eq!(r["ok"], true, "{r}");
    health_becomes(&h, HealthStatus::Ok).await;
    assert_eq!(resolve(&h, "NQ").await, NQ);
    drop(c);
    h.shutdown().await.unwrap();
}

struct NewBuild(Secrets);

#[async_trait]
impl Adopter for NewBuild {
    async fn adopt(&mut self, key: &str, value: &str) -> Result<(), NotKept> {
        self.0
            .adopt(key, value)
            .await
            .map_err(|e| NotKept::Refused(e.to_string()))
    }
}

#[tokio::test]
async fn an_update_hands_the_saved_logins_to_the_new_build() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let keychain = Keychain::new();
    let secrets =
        |build: &str| Secrets::with_stores(Some(keychain.build(build)), None).without_fallback();
    let config = |secrets: &Secrets| RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        secrets: Some(secrets.clone()),
        ..s.config()
    };
    let h = s.start(config(&secrets("build-1"))).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    let off = json!({"id": ID, "enabled": false});
    let r = invoke(&mut c, "connections.set_enabled", off).await;
    assert_eq!(r["ok"], true, "{r}");
    drop(c);
    h.shutdown().await.unwrap();

    let before = secrets("build-1");
    let h = s.start(config(&before)).await;
    h.shutdown().await.unwrap();
    let after = secrets("build-2");
    let out = before.hand_over(&mut NewBuild(after.clone())).await;
    let key = secret_ref().key;
    assert_eq!(out.handed, std::slice::from_ref(&key), "{out:?}");
    assert_eq!(keychain.builds(&key), ["build-2"]);

    let h = s.start(config(&after)).await;
    let mut c = Client::new(&h).await;
    let on = json!({"id": ID, "enabled": true});
    let r = invoke(&mut c, "connections.set_enabled", on).await;
    assert_eq!(r["ok"], true, "{r}");
    health_becomes(&h, HealthStatus::Ok).await;
    assert_eq!(keychain.asked(), 0, "the keychain never asked the user");
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_removed_while_its_login_waits_for_the_keyring_does_not_log_in() {
    let s = Setup::new().await;
    let dir = tempfile::tempdir().unwrap();
    let keychain = Keychain::new();
    let config = |build: &str| RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        secrets: Some(
            Secrets::with_stores(Some(keychain.build(build)), None)
                .without_fallback()
                .with_deadline(Duration::from_secs(20)),
        ),
        ..s.config()
    };
    let h = s.start(config("build-1")).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    drop(c);
    h.shutdown().await.unwrap();
    let attempts = s.gateway.attempts.load(Ordering::SeqCst);

    keychain.hold_deletes(true);
    let h = s.start(config("build-2")).await;
    settle(
        "the login waits for the keyring",
        || keychain.asked(),
        |n| *n == 1,
    )
    .await;
    let remove = {
        let mut c = Client::new(&h).await;
        tokio::spawn(async move { invoke(&mut c, "connections.remove", json!({"id": ID})).await })
    };
    settle(
        "the removal deletes the saved login",
        || keychain.deleting(),
        |n| *n == 1,
    )
    .await;
    keychain.answer(Answer::Allow);
    tokio::time::sleep(Duration::from_millis(500)).await;
    keychain.hold_deletes(false);
    let removed = remove.await.unwrap();
    assert_eq!(removed["output"]["removed"], true, "{removed}");
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(s.gateway.attempts.load(Ordering::SeqCst), attempts);
    assert!(health_of(&h).is_none());
    assert!(!served(&h, "NQ").await);
    let mut c = Client::new(&h).await;
    assert!(listed(&mut c).await.iter().all(|x| x["id"] != ID));
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_reconnect_that_cannot_reach_the_gateway_keeps_trying() {
    let s = Setup::new().await;
    let h = s.start(s.config()).await;
    let mut c = Client::new(&h).await;
    let added = invoke(&mut c, "connections.add_rithmic", login(GOOD)).await;
    assert_eq!(added["ok"], true, "{added}");
    health_becomes(&h, HealthStatus::Ok).await;

    s.gateway.unreachable.store(1, Ordering::SeqCst);
    let r = invoke(&mut c, "connections.reconnect", json!({"id": ID})).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(s.gateway.unreachable.load(Ordering::SeqCst), 0);
    health_becomes(&h, HealthStatus::Ok).await;
    drop(c);
    h.shutdown().await.unwrap();
}
