mod common;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_core::capabilities::{IntelCapabilities, MarketCapabilities};
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::levels::{Level, VendorRef};
use tessera_core::market::{Aggressor, AggressorSource, BookSnapshot, DepthLevel, Quote, Trade};
use tessera_core::settle::settle;
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::ToolStatus;
use tessera_intel::{ConversionRecord, IntelError, IntelligenceProvider, LevelSnapshot};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream,
};
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::Fakes;
use tessera_testkit::ShiftedClock;
use tessera_tools::Audience;

use common::Client;

fn config() -> RuntimeConfig {
    RuntimeConfig {
        clock: Arc::new(ShiftedClock::starting_at(
            Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap(),
        )),
        ..RuntimeConfig::default()
    }
}

async fn start() -> RuntimeHandle {
    Runtime::build(
        config(),
        vec![
            Fakes {
                intraday_sessions: 2,
                tick: Some(Duration::from_millis(50)),
                ..Fakes::default()
            }
            .module(),
        ],
    )
    .await
    .unwrap()
    .spawn()
}

const FAKE: &str = "FAKE";

struct FakeFeed {
    instrument: Instrument,
    spec: ContractSpec,
}

impl FakeFeed {
    fn new(qqq: (Instrument, ContractSpec)) -> Self {
        let id = InstrumentId::new(FAKE).unwrap();
        let (mut instrument, mut spec) = qqq;
        instrument.id = id.clone();
        instrument.symbol = FAKE.into();
        instrument.name = "Fake feed instrument".into();
        spec.instrument = id;
        Self { instrument, spec }
    }

    fn id_of(&self) -> InstrumentId {
        self.instrument.id.clone()
    }

    fn ticks<T: Send + 'static>(f: impl Fn(u64) -> T + Send + 'static) -> MarketStream<T> {
        let n = AtomicU64::new(0);
        tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(Duration::from_millis(
            20,
        )))
        .map(move |_| f(n.fetch_add(1, Ordering::Relaxed)))
        .boxed()
    }
}

fn p(v: i64) -> Price {
    Price(Decimal::new(v, 2))
}

#[async_trait]
impl MarketDataProvider for FakeFeed {
    fn id(&self) -> &str {
        "fake-feed"
    }
    fn display_name(&self) -> &str {
        "Fake feed"
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: vec![Timeframe::M1],
            live_timeframes: vec![Timeframe::M1],
            quotes: true,
            trades: true,
            depth_levels: Some(10),
            footprint: true,
            asset_classes: vec![AssetClass::Equity],
            max_intraday_history_days: Some(1),
            max_daily_history_days: None,
            realtime: true,
            aggressor_source: Some(AggressorSource::Exchange),
        }
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.id().into(),
            kind: ProviderKind::MarketData,
            display_name: self.display_name().into(),
            status: HealthStatus::Ok,
            latency_ms: None,
            last_message_at: None,
            message: None,
            connection: None,
            accounts: None,
            checked_at: Timestamp(0),
        }
    }
    async fn search(
        &self,
        query: &str,
        _asset_class: Option<AssetClass>,
        _limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        Ok(if FAKE.contains(&query.to_ascii_uppercase()) {
            vec![self.instrument.clone()]
        } else {
            vec![]
        })
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        if input.eq_ignore_ascii_case(FAKE) {
            Ok(self.id_of())
        } else {
            Err(MarketError::UnknownInstrument(input.into()))
        }
    }
    async fn spec(&self, id: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        if *id == self.id_of() {
            Ok((self.instrument.clone(), self.spec.clone()))
        } else {
            Err(MarketError::UnknownInstrument(id.to_string()))
        }
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
        Ok(Quote {
            instrument: id.clone(),
            ts: Timestamp(1),
            bid: Some(p(10_000)),
            bid_size: Some(Qty::from(5)),
            ask: Some(p(10_001)),
            ask_size: Some(Qty::from(7)),
            last: Some(p(10_000)),
            last_size: Some(Qty::from(1)),
            session: None,
            source: None,
        })
    }
    fn subscribe_quotes(&self, ids: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        let id = ids[0].clone();
        Ok(Self::ticks(move |n| Quote {
            instrument: id.clone(),
            ts: Timestamp(n as i64),
            bid: Some(p(10_000)),
            bid_size: None,
            ask: Some(p(10_001)),
            ask_size: None,
            last: Some(p(10_000)),
            last_size: None,
            session: None,
            source: None,
        }))
    }
    fn subscribe_trades(&self, ids: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        let id = ids[0].clone();
        Ok(Self::ticks(move |n| Trade {
            instrument: id.clone(),
            ts: Timestamp(n as i64),
            price: p(10_000),
            size: Qty::from(1),
            aggressor: Aggressor::Buy,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        }))
    }
    fn subscribe_bars(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        let id = id.clone();
        Ok(Self::ticks(move |n| LiveBar {
            instrument: id.clone(),
            tf,
            bar: tessera_core::Bar::flat(Timestamp(n as i64), p(10_000), Qty::from(1)),
            closed: false,
        }))
    }
    fn subscribe_depth(
        &self,
        id: &InstrumentId,
        levels: u32,
    ) -> Result<MarketStream<BookSnapshot>, MarketError> {
        let id = id.clone();
        Ok(Self::ticks(move |n| {
            let side = |base: i64, step: i64| {
                (0..levels as i64)
                    .map(|i| DepthLevel {
                        price: p(base + step * i),
                        size: Qty::from(10 + i),
                        orders: None,
                    })
                    .collect()
            };
            BookSnapshot {
                instrument: id.clone(),
                ts: Timestamp(n as i64),
                bids: side(10_000, -1),
                asks: side(10_001, 1),
            }
        }))
    }
}

struct MovingLevels {
    polls: AtomicU64,
}

#[async_trait]
impl IntelligenceProvider for MovingLevels {
    fn id(&self) -> &str {
        "test-intel"
    }
    fn display_name(&self) -> &str {
        "Test intelligence"
    }
    fn capabilities(&self) -> IntelCapabilities {
        IntelCapabilities {
            vendor: "TestVendor".into(),
            packages: vec!["Basic".into()],
            levels: true,
            profiles: false,
            conversions: false,
            history: false,
            realtime: false,
            rth_only: false,
        }
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.id().into(),
            kind: ProviderKind::Intelligence,
            display_name: self.display_name().into(),
            status: HealthStatus::Ok,
            latency_ms: None,
            last_message_at: None,
            message: None,
            connection: None,
            accounts: None,
            checked_at: Timestamp(0),
        }
    }
    async fn levels(
        &self,
        instrument: &InstrumentId,
        _as_of: Option<Timestamp>,
    ) -> Result<LevelSnapshot, IntelError> {
        if instrument.as_str() != "QQQ" {
            return Err(IntelError::NotCovered(instrument.to_string()));
        }
        let n = self.polls.fetch_add(1, Ordering::Relaxed) as i64;
        let as_of = Timestamp(1_000 + n);
        Ok(LevelSnapshot {
            instrument: instrument.clone(),
            as_of,
            levels: vec![Level {
                key: "test.basic.pivot".into(),
                instrument: instrument.clone(),
                label: "Pivot".into(),
                short: Some("PV".into()),
                group: "test".into(),
                price: Some(p(48_000 + n)),
                unavailable_reason: None,
                native_price: None,
                source: VendorRef {
                    vendor: "TestVendor".into(),
                    package: "Basic".into(),
                    field: "pivot".into(),
                    basis: "QQQ".into(),
                    endpoint: None,
                    as_of,
                    conversion: None,
                },
                concept: None,
            }],
            raw_blob: None,
        })
    }
    async fn conversion(
        &self,
        from: &str,
        to: &InstrumentId,
    ) -> Result<ConversionRecord, IntelError> {
        Err(IntelError::NotCovered(format!("{from} → {to}")))
    }
    fn poll_interval(&self) -> Duration {
        Duration::from_millis(30)
    }
}

#[tokio::test]
async fn declarations_match_what_the_modules_serve() {
    let h = start().await;
    let declared = tessera_runtime::modules::ts_exports();
    tessera_host::check_declarations(&declared).unwrap();
    let registry = h.state.invoker.registry();
    let registered: BTreeSet<String> = registry.names().map(str::to_owned).collect();
    let mut served = BTreeSet::new();
    for t in declared.iter().flat_map(|e| &e.tools) {
        match t.status {
            ToolStatus::Served => {
                served.insert(t.name.to_owned());
                let tool = registry
                    .get(t.name)
                    .unwrap_or_else(|| panic!("{} is declared served but not registered", t.name));
                let d = tool.descriptor();
                assert_eq!(
                    Some(d.input_schema.clone()),
                    t.input.schema(true),
                    "{}: input type differs from the declaration",
                    t.name
                );
                assert_eq!(
                    Some(d.output_schema.clone()),
                    t.output.schema(false),
                    "{}: output type differs from the declaration",
                    t.name
                );
            }
            ToolStatus::Planned => assert!(
                registry.get(t.name).is_none(),
                "{} is registered: declare it served",
                t.name
            ),
        }
    }
    assert_eq!(
        registered, served,
        "registered tools vs served declarations"
    );
    let topics: BTreeSet<&str> = h.state.topics.keys().copied().collect();
    let declared_topics: BTreeSet<&str> = declared
        .iter()
        .flat_map(|e| e.topics.iter().map(|t| t.name))
        .collect();
    assert_eq!(topics, declared_topics);
    assert!(
        registry
            .descriptors(Audience::User, None, true)
            .iter()
            .any(|d| d.name == "connections.list")
    );
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn depth_and_footprint_plug_in_behind_a_connection_that_offers_them() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let hello = c.ok("session.hello", json!({})).await;
    let topics = |v: &Value| -> Vec<String> {
        v["topics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap().to_owned())
            .collect()
    };
    let offered = topics(&hello["capabilities"]);
    assert!(offered.contains(&"market.depth".to_owned()));
    assert!(offered.contains(&"market.footprint".to_owned()));
    let mock_depth = c
        .ok(
            "subscribe",
            json!({"topic": "market.depth", "params": {"instrument": "QQQ", "levels": 10}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ev = c
        .event(&mock_depth, |e| e["data"]["instrument"] == "QQQ")
        .await;
    assert_eq!(ev["data"]["bids"].as_array().unwrap().len(), 10);
    assert_eq!(ev["data"]["source"], json!({"provider": "mock"}));
    let r = c
        .call(
            "subscribe",
            json!({"topic": "market.depth", "params": {"instrument": "NDX"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], -32014, "{r}");

    let caps = c
        .ok("subscribe", json!({"topic": "capabilities", "params": {}}))
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    c.event(&caps, |e| e["seq"] == 0).await;

    let (qqq_instrument, qqq_spec) = h
        .state
        .connections
        .market()
        .spec(&InstrumentId::new("QQQ").unwrap())
        .await
        .unwrap();
    h.state
        .connections
        .add_market(Arc::new(FakeFeed::new((qqq_instrument, qqq_spec))))
        .unwrap();
    let update = c
        .event(&caps, |e| {
            e["data"]["market"]
                .as_array()
                .is_some_and(|m| m.iter().any(|p| p["providerId"] == "fake-feed"))
        })
        .await;
    let offered = topics(&update["data"]);
    assert!(offered.contains(&"market.depth".to_owned()), "{offered:?}");
    assert!(offered.contains(&"market.footprint".to_owned()));

    let depth = c
        .ok(
            "subscribe",
            json!({"topic": "market.depth", "params": {"instrument": "FAKE", "levels": 5}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ev = c.event(&depth, |e| e["seq"].as_u64() >= Some(1)).await;
    assert_eq!(ev["data"]["instrument"], "FAKE");
    assert_eq!(ev["data"]["bids"].as_array().unwrap().len(), 5);
    assert_eq!(ev["data"]["asks"][0], json!([100.01, 10]));
    assert_eq!(ev["data"]["source"], json!({"provider": "fake-feed"}));

    let fp = c
        .ok(
            "subscribe",
            json!({"topic": "market.footprint", "params": {"instrument": "FAKE", "tf": "1m"}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ev = c.event(&fp, |e| e["seq"].as_u64() >= Some(1)).await;
    assert_eq!(ev["data"]["bar"]["aggressorSource"], "exchange");
    assert_eq!(ev["data"]["source"]["provider"], "fake-feed");

    let quotes = c
        .ok(
            "subscribe",
            json!({"topic": "market.quotes", "params": {"instruments": ["QQQ", "FAKE"]}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mocked = c
        .event(&quotes, |e| {
            e["seq"] == 0 && e["data"]["instrument"] == "QQQ"
        })
        .await;
    assert_eq!(mocked["data"]["source"], json!({"provider": "mock"}));
    let fed = c
        .event(&quotes, |e| {
            e["seq"] == 0 && e["data"]["instrument"] == "FAKE"
        })
        .await;
    assert_eq!(fed["data"]["source"], json!({"provider": "fake-feed"}));
    let listed = c
        .ok(
            "tools.invoke",
            json!({"name": "connections.list", "input": {}}),
        )
        .await;
    let ids: Vec<&str> = listed["output"]["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["mock", "fake-feed", "mock-gamma"]);
    let mock = listed["output"]["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "mock")
        .unwrap();
    assert_eq!(mock["market"]["footprint"], true);

    assert!(h.state.connections.remove_market("fake-feed"));
    let r = c
        .call(
            "subscribe",
            json!({"topic": "market.depth", "params": {"instrument": "FAKE"}}),
        )
        .await;
    assert!(r.get("error").is_some(), "{r}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn intelligence_connects_without_a_restart_and_streams_live_levels() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let get_qqq = json!({"name": "intel.get_levels", "input": {"instrument": "QQQ"}});
    assert!(h.state.connections.remove_intel("mock-gamma"));
    let r = c.ok("tools.invoke", get_qqq.clone()).await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["error"]["code"], "unsupported", "{r}");
    let hello = c.ok("session.hello", json!({})).await;
    assert!(
        !hello["capabilities"]["topics"]
            .as_array()
            .unwrap()
            .contains(&json!("intel.levels"))
    );

    h.state
        .connections
        .add_intel(Arc::new(MovingLevels {
            polls: AtomicU64::new(0),
        }))
        .unwrap();
    let r = c.ok("tools.invoke", get_qqq.clone()).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["provider"], "test-intel");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "intel.get_levels", "input": {"instrument": "SPY"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");

    let sub = c
        .ok(
            "subscribe",
            json!({"topic": "intel.levels", "params": {"instrument": "QQQ"}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let snap = c.event(&sub, |e| e["seq"] == 0).await;
    assert_eq!(snap["data"]["provider"], "test-intel");
    let first = snap["data"]["levels"][0]["price"].as_f64().unwrap();
    let live = c.event(&sub, |e| e["seq"].as_u64() >= Some(1)).await;
    assert_eq!(live["data"]["provider"], "test-intel");
    assert!(live["data"]["levels"][0]["price"].as_f64().unwrap() > first);
    assert_eq!(h.state.intel.hub().pump_count(), 1);
    c.ok("unsubscribe", json!({"subscriptionId": sub})).await;
    settle(
        "the last release stops the pump",
        || h.state.intel.hub().pump_count(),
        |&pumps| pumps == 0,
    )
    .await;
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn computed_levels_have_their_own_source() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let sub = c
        .ok(
            "subscribe",
            json!({"topic": "concepts.levels", "params": {"instrument": "QQQ"}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let snap = c.event(&sub, |e| e["seq"] == 0).await;
    assert_eq!(snap["data"]["provider"], "tessera-concepts");
    let fields: Vec<&str> = snap["data"]["levels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["source"]["field"].as_str().unwrap())
        .collect();
    assert_eq!(fields[..3], ["pdh", "pdl", "pdc"]);
    let pdh = &snap["data"]["levels"][0];
    assert_eq!(pdh["source"]["vendor"], "Tessera");
    assert_eq!(pdh["source"]["package"], "Concepts");
    assert_eq!(pdh["group"], "pd");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "concepts.get_levels", "input": {"instrument": "QQQ"}}),
        )
        .await;
    let levels = r["output"]["levels"].as_array().unwrap();
    assert_eq!(levels[..3], snap["data"]["levels"].as_array().unwrap()[..3]);
    let profile: Vec<&str> = levels
        .iter()
        .filter(|l| l["group"] == "vp")
        .map(|l| l["source"]["field"].as_str().unwrap())
        .collect();
    assert_eq!(
        profile,
        [
            "poc", "vah", "val", "ppoc", "pvah", "pval", "cpoc", "cvah", "cval", "wpoc", "wvah",
            "wval", "mpoc", "mvah", "mval"
        ],
        "the sim holds no prints of the week or month before, so no pw* or pm*"
    );
    assert!(levels.iter().all(|l| l["source"]["vendor"] == "Tessera"));
    let intel = c
        .ok(
            "subscribe",
            json!({"topic": "intel.levels", "params": {"instrument": "QQQ"}}),
        )
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ev = c.event(&intel, |e| e["seq"] == 0).await;
    assert!(
        ev["data"]["levels"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l["source"]["vendor"] != "Tessera")
    );
    h.shutdown().await.unwrap();
}
