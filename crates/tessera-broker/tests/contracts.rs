use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use async_trait::async_trait;
use chrono::NaiveDate;
use futures::StreamExt;
use futures::stream::BoxStream;
use rust_decimal::Decimal;
use serde_json::json;
use tessera_broker::orders::OrdersService;
use tessera_broker::orders::io::{ContractForInput, OrderInput};
use tessera_broker::paper::{PaperBroker, PaperConfig, test_seeds};
use tessera_broker::{
    BrokerError, BrokerEvent, BrokerProvider, BrokerRouter, BrokerSystem, GuardedBroker,
    OrderChanges, Verified,
};
use tessera_core::accounts::{AccountSummary, Environment, Restrictions, TradingAccount};
use tessera_core::capabilities::{BrokerCapabilities, MarketCapabilities};
use tessera_core::clock::ManualClock;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::{AccountId, BrokerId, ConnectionId, DraftId, OrderId};
use tessera_core::instrument::{
    AssetClass, ContractMonth, ContractSpec, ExchangeContract, Instrument,
};
use tessera_core::market::{Quote, Trade};
use tessera_core::money::{Currency, Money, Price, Qty};
use tessera_core::orders::{Fill, Order, OrderPreview, OrderRequest, OrderType, Position};
use tessera_core::session::SessionCalendar;
use tessera_core::time::ExchangeTz;
use tessera_core::{InstrumentId, SharedClock, Timeframe, Timestamp};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket,
};
use tessera_protocol::tools::ToolErrorCode;

const FAKE: &str = "rithmic-fake";
const ACCOUNT: &str = "fake-eval-1";
const EXEC: &str = "exec-only";
const EXEC_ACCOUNT: &str = "exec-1";

fn t0() -> Timestamp {
    Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap()
}

struct FakeMarket {
    list: Vec<Instrument>,
}

fn future(id: &str, symbol: &str, root: &str) -> Instrument {
    Instrument {
        id: InstrumentId::new(id).unwrap(),
        symbol: symbol.into(),
        name: symbol.into(),
        asset_class: AssetClass::Future,
        exchange: "CME".into(),
        currency: Currency::Usd,
        root: Some(root.into()),
        expiry: NaiveDate::from_ymd_opt(2026, 12, 18),
        is_front: true,
        tradable: true,
    }
}

fn spec(i: &Instrument) -> ContractSpec {
    let micro = i.root.as_deref() == Some("MNQ");
    let multiplier = if micro {
        Decimal::from(2)
    } else {
        Decimal::from(20)
    };
    ContractSpec {
        instrument: i.id.clone(),
        asset_class: AssetClass::Future,
        root: i.root.clone(),
        tick_size: Price(Decimal::new(25, 2)),
        tick_value: Money::usd(Decimal::new(25, 2) * multiplier),
        multiplier,
        currency: Currency::Usd,
        price_decimals: 2,
        qty_step: Qty::from(1),
        min_qty: Qty::from(1),
        sessions: SessionCalendar::CmeEquityIndex,
        tz: ExchangeTz::CHICAGO,
        expiry: i.expiry,
        last_trade: None,
        roll_date: None,
        micro_of: micro.then(|| "NQ".to_owned()),
    }
}

#[async_trait]
impl MarketDataProvider for FakeMarket {
    fn id(&self) -> &str {
        FAKE
    }
    fn display_name(&self) -> &str {
        "Fake · Rithmic"
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: vec![Timeframe::M1],
            live_timeframes: vec![Timeframe::M1],
            quotes: true,
            trades: true,
            depth_levels: None,
            footprint: false,
            asset_classes: vec![AssetClass::Future],
            max_intraday_history_days: None,
            max_daily_history_days: None,
            realtime: true,
            aggressor_source: None,
        }
    }
    fn health(&self) -> ProviderHealth {
        health(ProviderKind::MarketData)
    }
    async fn search(
        &self,
        query: &str,
        _: Option<AssetClass>,
        _: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        let q = query.trim().to_ascii_uppercase();
        Ok(self
            .list
            .iter()
            .filter(|i| i.root.as_deref() == Some(q.as_str()))
            .cloned()
            .collect())
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        let q = input.trim().to_ascii_uppercase();
        self.list
            .iter()
            .find(|i| i.id.as_str() == q || i.root.as_deref() == Some(q.as_str()))
            .map(|i| i.id.clone())
            .ok_or(MarketError::UnknownInstrument(q))
    }
    async fn spec(&self, id: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.list
            .iter()
            .find(|i| &i.id == id)
            .map(|i| (i.clone(), spec(i)))
            .ok_or_else(|| MarketError::UnknownInstrument(id.to_string()))
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
        Err(MarketError::Unavailable(id.to_string()))
    }
    fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Ok(futures::stream::pending().boxed())
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
}

fn health(kind: ProviderKind) -> ProviderHealth {
    ProviderHealth {
        provider_id: FAKE.into(),
        kind,
        display_name: "Fake · Rithmic".into(),
        status: HealthStatus::Ok,
        latency_ms: None,
        last_message_at: None,
        message: None,
        connection: None,
        accounts: None,
        checked_at: Timestamp(0),
    }
}

#[derive(Default)]
struct FakeBroker {
    reached: AtomicU32,
    previewed: parking_lot::Mutex<Vec<InstrumentId>>,
}

#[async_trait]
impl BrokerProvider for FakeBroker {
    fn id(&self) -> &str {
        FAKE
    }
    fn capabilities(&self) -> BrokerCapabilities {
        BrokerCapabilities {
            order_types: vec![OrderType::Market, OrderType::Limit],
            time_in_force: vec![],
            brackets: false,
            oco: false,
            modify: false,
            read_only: false,
            environments: vec![Environment::Eval],
            fractional_qty: false,
            stop_rules: false,
        }
    }
    fn system(&self) -> BrokerSystem {
        BrokerSystem {
            name: "Apex".into(),
            environment: Environment::Eval,
        }
    }
    fn health(&self) -> ProviderHealth {
        health(ProviderKind::Broker)
    }
    fn environment_of(&self, account: &AccountId) -> Option<Environment> {
        (account.as_str() == ACCOUNT).then_some(Environment::Eval)
    }
    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        Ok(vec![TradingAccount {
            id: AccountId::new(ACCOUNT),
            display_name: "TEST-000001".into(),
            environment: Environment::Eval,
            broker_id: BrokerId::new(FAKE),
            connection_id: ConnectionId::new(FAKE),
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
        Ok(vec![])
    }
    async fn orders(&self, _: &AccountId) -> Result<Vec<Order>, BrokerError> {
        Ok(vec![])
    }
    async fn fills(&self, _: &AccountId, _: Timestamp) -> Result<Vec<Fill>, BrokerError> {
        Ok(vec![])
    }
    async fn preview(&self, r: &OrderRequest) -> Result<OrderPreview, BrokerError> {
        self.reached.fetch_add(1, Ordering::SeqCst);
        self.previewed.lock().push(r.instrument.clone());
        Err(BrokerError::Rejected(
            "the fake firm previews nothing".into(),
        ))
    }
    async fn submit(
        &self,
        _: &Verified,
        _: OrderRequest,
        _: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        self.reached.fetch_add(1, Ordering::SeqCst);
        Err(BrokerError::Rejected("the fake firm takes nothing".into()))
    }
    async fn modify(
        &self,
        _: &Verified,
        _: &OrderId,
        _: OrderChanges,
    ) -> Result<Order, BrokerError> {
        self.reached.fetch_add(1, Ordering::SeqCst);
        Err(BrokerError::Rejected("no".into()))
    }
    async fn cancel(&self, _: &Verified, _: &OrderId) -> Result<Order, BrokerError> {
        self.reached.fetch_add(1, Ordering::SeqCst);
        Err(BrokerError::Rejected("no".into()))
    }
    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        futures::stream::pending().boxed()
    }
}

struct ExecOnly;

#[async_trait]
impl BrokerProvider for ExecOnly {
    fn id(&self) -> &str {
        EXEC
    }
    fn capabilities(&self) -> BrokerCapabilities {
        FakeBroker::default().capabilities()
    }
    fn system(&self) -> BrokerSystem {
        BrokerSystem {
            name: "Some Broker".into(),
            environment: Environment::Sim,
        }
    }
    fn health(&self) -> ProviderHealth {
        health(ProviderKind::Broker)
    }
    async fn contract_for(
        &self,
        _: &AccountId,
        want: &ExchangeContract,
    ) -> Result<Option<(Instrument, ContractSpec)>, BrokerError> {
        let dec = ContractMonth::parse("2026-12");
        Ok(
            (want.exchange == "CME" && want.expiry == dec && want.root == "MNQ").then(|| {
                let mut i = future("E-77.EXEC", "MNQZ6", "MNQ");
                i.name = "Micro Nasdaq Dec26".into();
                let s = spec(&i);
                (i, s)
            }),
        )
    }
    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        Ok(vec![TradingAccount {
            id: AccountId::new(EXEC_ACCOUNT),
            display_name: "SIM-1".into(),
            environment: Environment::Sim,
            broker_id: BrokerId::new(EXEC),
            connection_id: ConnectionId::new(EXEC),
            program_id: None,
            rule_set_id: None,
            currency: Currency::Usd,
            restrictions: Restrictions::default(),
            group_id: None,
            external_ref_masked: None,
        }])
    }
    async fn summary(&self, a: &AccountId) -> Result<AccountSummary, BrokerError> {
        FakeBroker::default().summary(a).await
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
        Err(BrokerError::Rejected("no".into()))
    }
    async fn submit(
        &self,
        _: &Verified,
        _: OrderRequest,
        _: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        Err(BrokerError::Rejected("no".into()))
    }
    async fn modify(
        &self,
        _: &Verified,
        _: &OrderId,
        _: OrderChanges,
    ) -> Result<Order, BrokerError> {
        Err(BrokerError::Rejected("no".into()))
    }
    async fn cancel(&self, _: &Verified, _: &OrderId) -> Result<Order, BrokerError> {
        Err(BrokerError::Rejected("no".into()))
    }
    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        futures::stream::pending().boxed()
    }
}

struct Desk {
    orders: OrdersService,
    broker: Arc<FakeBroker>,
    market: Arc<MarketRouter>,
}

async fn desk() -> Desk {
    let clock: SharedClock = Arc::new(ManualClock::new(t0()));
    let mut cfg = MockConfig::new(Arc::clone(&clock));
    cfg.intraday_sessions = 1;
    let market = MarketRouter::new();
    market
        .add(Arc::new(FakeMarket {
            list: vec![
                future("X1.FAKE", "NQZ6", "NQ"),
                future("X7.FAKE", "MNQZ6", "MNQ"),
            ],
        }))
        .unwrap();
    market.add(Arc::new(MockMarket::new(cfg))).unwrap();
    let paper = PaperBroker::open(
        Arc::clone(&market) as Arc<dyn MarketDataProvider>,
        Arc::clone(&clock),
        None,
        PaperConfig::default(),
        &test_seeds(),
    )
    .await
    .unwrap();
    let brokers = BrokerRouter::new();
    brokers.add(paper as Arc<dyn BrokerProvider>).unwrap();
    let broker = Arc::new(FakeBroker::default());
    brokers
        .add(Arc::clone(&broker) as Arc<dyn BrokerProvider>)
        .unwrap();
    brokers
        .add(Arc::new(ExecOnly) as Arc<dyn BrokerProvider>)
        .unwrap();
    let guarded = GuardedBroker::new(brokers as Arc<dyn BrokerProvider>);
    Desk {
        orders: OrdersService::new(
            Arc::new(guarded),
            Arc::clone(&market) as Arc<dyn MarketDataProvider>,
            clock,
        ),
        broker,
        market,
    }
}

fn ask(account: &str, instrument: &str, root: Option<&str>) -> ContractForInput {
    ContractForInput {
        account_id: account.into(),
        instrument: Some(instrument.into()),
        exchange: None,
        root: root.map(str::to_owned),
        expiry: None,
    }
}

fn buy(account: &str, instrument: &str) -> OrderInput {
    serde_json::from_value(json!({
        "accountId": account,
        "instrument": instrument,
        "side": "buy",
        "qty": 1,
        "orderType": "market",
    }))
    .unwrap()
}

#[tokio::test]
async fn an_nq_chart_trades_the_micro_the_accounts_connection_lists() {
    let d = desk().await;
    let own = d
        .orders
        .contract_for(&ask(ACCOUNT, "X1.FAKE", None))
        .await
        .unwrap();
    assert_eq!(own.instrument.unwrap().id.as_str(), "X1.FAKE");
    assert_eq!(own.account, "TEST-000001 (Fake · Rithmic)");
    let micro = d
        .orders
        .contract_for(&ask(ACCOUNT, "X1.FAKE", Some("MNQ")))
        .await
        .unwrap();
    assert_eq!(micro.refused, None);
    assert_eq!(micro.instrument.unwrap().id.as_str(), "X7.FAKE");
    assert_eq!(micro.spec.unwrap().tick_value.amount, Decimal::new(50, 2));
    assert_eq!(micro.wanted.unwrap().to_string(), "MNQ Dec 2026");
    let root = d
        .orders
        .contract_for(&ask(ACCOUNT, "MNQ", None))
        .await
        .unwrap();
    assert_eq!(root.instrument.unwrap().id.as_str(), "X7.FAKE");
    let by_parts = d
        .orders
        .contract_for(&ContractForInput {
            account_id: ACCOUNT.into(),
            instrument: None,
            exchange: Some("cme".into()),
            root: Some("MNQ".into()),
            expiry: ContractMonth::parse("2026-12"),
        })
        .await
        .unwrap();
    assert_eq!(by_parts.instrument.unwrap().id.as_str(), "X7.FAKE");
    let e = d
        .orders
        .submit(&buy(ACCOUNT, "MNQ"), None, None)
        .await
        .unwrap_err();
    assert_eq!(
        *d.broker.previewed.lock(),
        [InstrumentId::new("X7.FAKE").unwrap()]
    );
    assert!(
        e.message.starts_with("TEST-000001 (Fake · Rithmic): "),
        "{}",
        e.message
    );
}

#[tokio::test]
async fn a_contract_the_accounts_connection_does_not_list_is_refused_in_words_naming_the_account() {
    let d = desk().await;
    let out = d
        .orders
        .contract_for(&ask(ACCOUNT, "X1.FAKE", Some("MES")))
        .await
        .unwrap();
    assert_eq!(out.instrument, None);
    assert_eq!(
        out.refused.as_deref(),
        Some("TEST-000001 (Fake · Rithmic) has no MES Dec 2026")
    );
    let e = d
        .orders
        .submit(&buy(ACCOUNT, "MNQH7.CME"), None, None)
        .await
        .unwrap_err();
    assert_eq!(e.code, ToolErrorCode::Rejected);
    assert_eq!(
        e.message,
        "TEST-000001 (Fake · Rithmic) has no MNQ Mar 2027"
    );
    assert_eq!(e.details.unwrap()["sent"], false);
    assert_eq!(
        d.broker.reached.load(Ordering::SeqCst),
        0,
        "nothing reached it"
    );
}

#[tokio::test]
async fn a_chart_on_another_connection_trades_the_accounts_own_contract() {
    let d = desk().await;
    let out = d
        .orders
        .contract_for(&ask(ACCOUNT, "NQZ6.CME", Some("MNQ")))
        .await
        .unwrap();
    assert_eq!(out.refused, None);
    assert_eq!(out.instrument.unwrap().id.as_str(), "X7.FAKE");
    let own = d
        .orders
        .contract_for(&ask(ACCOUNT, "NQZ6.CME", None))
        .await
        .unwrap();
    assert_eq!(own.instrument.unwrap().id.as_str(), "X1.FAKE");
    let e = d
        .orders
        .submit(&buy(ACCOUNT, "NQZ6.CME"), None, None)
        .await
        .unwrap_err();
    assert_eq!(
        *d.broker.previewed.lock(),
        [InstrumentId::new("X1.FAKE").unwrap()]
    );
    assert!(
        e.message.starts_with("TEST-000001 (Fake · Rithmic)"),
        "{}",
        e.message
    );
    let root = d
        .orders
        .contract_for(&ask(ACCOUNT, "NQ", None))
        .await
        .unwrap();
    assert_eq!(root.instrument.unwrap().id.as_str(), "X1.FAKE");
}

#[tokio::test]
async fn the_paper_account_trades_what_the_charts_connection_lists() {
    let d = desk().await;
    let own = d
        .orders
        .contract_for(&ask("eval-50k", "NQZ6.CME", None))
        .await
        .unwrap();
    assert_eq!(own.instrument.unwrap().id.as_str(), "NQZ6.CME");
    assert_eq!(own.account, "Eval 50K (Tessera Paper)");
    let micro = d
        .orders
        .contract_for(&ask("eval-50k", "NQZ6.CME", Some("MNQ")))
        .await
        .unwrap();
    assert_eq!(micro.instrument.unwrap().id.as_str(), "MNQZ6.CME");
    let real = d
        .orders
        .contract_for(&ask("eval-50k", "X1.FAKE", Some("MNQ")))
        .await
        .unwrap();
    assert_eq!(real.instrument.unwrap().id.as_str(), "X7.FAKE");
    let none = d
        .orders
        .contract_for(&ask("eval-50k", "NQZ6.CME", Some("MYM")))
        .await
        .unwrap();
    assert_eq!(
        none.refused.as_deref(),
        Some("Eval 50K (Tessera Paper) has no MYM Dec 2026")
    );
}

#[tokio::test]
async fn an_execution_only_connection_names_its_contracts_with_its_own_lookup() {
    let d = desk().await;
    let micro = d
        .orders
        .contract_for(&ask(EXEC_ACCOUNT, "X1.FAKE", Some("MNQ")))
        .await
        .unwrap();
    assert_eq!(micro.refused, None, "{micro:?}");
    assert_eq!(micro.account, "SIM-1 (Some Broker)");
    let i = micro.instrument.unwrap();
    assert_eq!(
        (i.id.as_str(), i.name.as_str()),
        ("E-77.EXEC", "Micro Nasdaq Dec26")
    );
    assert_eq!(micro.spec.unwrap().instrument.as_str(), "E-77.EXEC");
    let none = d
        .orders
        .contract_for(&ask(EXEC_ACCOUNT, "X1.FAKE", None))
        .await
        .unwrap();
    assert_eq!(
        none.refused.as_deref(),
        Some("SIM-1 (Some Broker) has no NQ Dec 2026")
    );
    let other = d
        .orders
        .contract_for(&ask(EXEC_ACCOUNT, "MNQZ6.CME", None))
        .await
        .unwrap();
    assert_eq!(other.refused, None, "{other:?}");
    assert_eq!(other.instrument.unwrap().id.as_str(), "E-77.EXEC");
}

#[tokio::test]
async fn no_account_takes_an_order_on_a_replay_of_a_saved_day() {
    use tessera_market::replay::Replays;
    use tessera_market::saved::{Contract, SavedTrades};
    use tessera_store::ticks::{Span, TickRow, TickStore};

    let d = desk().await;
    let nq = InstrumentId::new("NQZ6.CME").unwrap();
    let (instrument, spec) = d.market.spec(&nq).await.unwrap();
    let saved = SavedTrades::new(Arc::new(TickStore::open_in_memory().unwrap()));
    saved.remember_contract("mock", &instrument, &spec);
    let contract = Contract::new("mock", &nq);
    let day = Span::new(t0().0 - 60_000_000_000, t0().0);
    let print = Trade {
        instrument: nq.clone(),
        ts: Timestamp(day.start + 1),
        price: Price::from(Decimal::new(21_000, 0)),
        size: Qty::from(1),
        aggressor: tessera_core::market::Aggressor::Buy,
        aggressor_source: tessera_core::market::AggressorSource::Exchange,
        order_key: None,
        source: None,
    };
    saved
        .save_now(&contract, spec.sessions, &[TickRow::of(&print)], day)
        .unwrap();
    let replays = Replays::new(saved);
    d.market.set_replays(Arc::clone(&replays));
    let replay = replays
        .open(
            &d.market,
            contract,
            spec.sessions.trade_date(t0()),
            None,
            1,
            true,
        )
        .await
        .unwrap()
        .instrument;
    for account in ["eval-50k", ACCOUNT] {
        let e = d
            .orders
            .submit(&buy(account, replay.as_str()), None, None)
            .await
            .unwrap_err();
        assert_eq!(e.code, ToolErrorCode::Rejected, "{account}: {}", e.message);
        assert!(e.message.contains("replays a saved day"), "{}", e.message);
        let named = d
            .orders
            .contract_for(&ask(account, replay.as_str(), None))
            .await
            .unwrap();
        assert!(named.instrument.is_none(), "{account} named a contract");
    }
    assert_eq!(
        d.broker.reached.load(Ordering::SeqCst),
        0,
        "nothing reached it"
    );
    let live = d
        .orders
        .contract_for(&ask("eval-50k", "NQZ6.CME", None))
        .await
        .unwrap();
    assert_eq!(
        live.instrument.unwrap().id,
        nq,
        "the live contract still trades"
    );
}
