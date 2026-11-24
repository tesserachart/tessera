use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Datelike, Duration, NaiveDate};
use parking_lot::Mutex;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::catalog::seed_futures_products;
use tessera_core::clock::ManualClock;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::{
    AssetClass, ContractSpec, ExchangeContract, FuturesMonth, Instrument, cme_equity_index_expiry,
    cme_equity_index_roll_date,
};
use tessera_core::market::{Bar, Quote, Trade};
use tessera_core::origin::Origin;
use tessera_core::session::SessionCalendar;
use tessera_core::time::local_to_timestamp;
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::{EventBus, RuntimeModule};
use tessera_market::history::BarCache;
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketModule, MarketRouter,
    MarketStream, MockConfig, MockMarket,
};
use tessera_store::bars::BarStore;
use tessera_tools::{ToolCtx, ToolRegistry};

const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;

fn now() -> Timestamp {
    Timestamp::parse("2026-10-07T12:00:00-04:00").unwrap()
}

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

fn day_start(d: NaiveDate) -> i64 {
    local_to_timestamp(CAL.tz(), d, 0, 0).0
}

fn roll_2026(month: FuturesMonth) -> NaiveDate {
    cme_equity_index_roll_date(cme_equity_index_expiry(2026, month))
}

struct Contract {
    instrument: Instrument,
    spec: ContractSpec,
    bars: Vec<Bar>,
}

fn nq(year: i32, month: FuturesMonth, base: i64, with_bars: bool) -> Contract {
    let product = seed_futures_products()
        .into_iter()
        .find(|p| p.root == "NQ")
        .unwrap();
    let (instrument, spec) = product.contract(year, month, month == FuturesMonth::Z);
    let expiry = spec.expiry.unwrap();
    let today = CAL.trade_date(now());
    let mut bars = Vec::new();
    let mut d = expiry - Duration::days(280);
    while with_bars && d <= expiry.min(today) {
        if CAL.is_trade_date(d) {
            let p = Decimal::from(base + i64::from(d.ordinal() % 50));
            bars.push(Bar {
                t: Timestamp(day_start(d)),
                o: Price(p),
                h: Price(p + Decimal::from(5)),
                l: Price(p - Decimal::from(5)),
                c: Price(p + Decimal::ONE),
                v: Qty::from(1000 + i64::from(d.ordinal())),
                bv: None,
            });
        }
        d += Duration::days(1);
    }
    Contract {
        instrument,
        spec,
        bars,
    }
}

struct Quarterlies {
    contracts: Vec<Contract>,
    lookup: bool,
    log: Mutex<Vec<BarsRequest>>,
}

impl Quarterlies {
    fn new(lookup: bool, expired_bars: bool) -> Self {
        Self {
            contracts: vec![
                nq(2026, FuturesMonth::M, 20_000, expired_bars),
                nq(2026, FuturesMonth::U, 20_300, expired_bars),
                nq(2026, FuturesMonth::Z, 20_600, true),
            ],
            lookup,
            log: Mutex::new(Vec::new()),
        }
    }

    fn find(&self, id: &InstrumentId) -> Result<&Contract, MarketError> {
        self.contracts
            .iter()
            .find(|c| &c.instrument.id == id)
            .ok_or_else(|| MarketError::UnknownInstrument(id.to_string()))
    }

    fn asked(&self) -> Vec<String> {
        self.log
            .lock()
            .iter()
            .map(|r| r.instrument.to_string())
            .collect()
    }

    fn forget(&self) {
        self.log.lock().clear();
    }
}

#[async_trait]
impl MarketDataProvider for Quarterlies {
    fn id(&self) -> &str {
        "quarterlies"
    }
    fn display_name(&self) -> &str {
        "Quarterlies"
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: vec![Timeframe::D1],
            live_timeframes: vec![],
            quotes: false,
            trades: false,
            depth_levels: None,
            footprint: false,
            asset_classes: vec![AssetClass::Future],
            max_intraday_history_days: Some(30),
            max_daily_history_days: Some(4_000),
            realtime: false,
            aggressor_source: None,
        }
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.id().to_owned(),
            kind: ProviderKind::MarketData,
            display_name: self.display_name().to_owned(),
            status: HealthStatus::Ok,
            latency_ms: None,
            last_message_at: None,
            message: None,
            connection: None,
            accounts: None,
            checked_at: now(),
        }
    }
    async fn search(
        &self,
        _q: &str,
        _a: Option<AssetClass>,
        _n: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        Ok(self
            .contracts
            .iter()
            .filter(|c| c.instrument.is_front)
            .map(|c| c.instrument.clone())
            .collect())
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        let id = InstrumentId::new(input)
            .map_err(|_| MarketError::UnknownInstrument(input.to_owned()))?;
        Ok(self.find(&id)?.instrument.id.clone())
    }
    async fn spec(&self, id: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        let c = self.find(id)?;
        Ok((c.instrument.clone(), c.spec.clone()))
    }
    async fn contract_for(
        &self,
        want: &ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        if !self.lookup {
            return Ok(None);
        }
        Ok(self
            .contracts
            .iter()
            .find(|c| ExchangeContract::of(&c.instrument, 2026).as_ref() == Some(want))
            .map(|c| c.instrument.clone()))
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.log.lock().push(req.clone());
        if req.tf != Timeframe::D1 {
            return Err(MarketError::Unsupported("daily bars only".into()));
        }
        let mut bars: Vec<Bar> = self
            .find(&req.instrument)?
            .bars
            .iter()
            .filter(|b| req.from.is_none_or(|f| b.t >= f) && req.to.is_none_or(|t| b.t <= t))
            .copied()
            .collect();
        if let Some(n) = req.limit
            && bars.len() > n
        {
            bars.drain(..bars.len() - n);
        }
        Ok(BarSeries {
            instrument: req.instrument,
            tf: req.tf,
            bars,
            last_bar_open: false,
        })
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        Err(MarketError::Unsupported(format!("no quotes for {i}")))
    }
    fn subscribe_quotes(&self, _i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Err(MarketError::Unsupported("no quotes".into()))
    }
    fn subscribe_trades(&self, _i: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        Err(MarketError::Unsupported("no trades".into()))
    }
    fn subscribe_bars(
        &self,
        _i: &InstrumentId,
        _tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        Err(MarketError::Unsupported("no live bars".into()))
    }
}

struct Desk {
    tools: ToolRegistry,
    at: Timestamp,
}

impl Desk {
    fn over(conn: Arc<dyn MarketDataProvider>, at: Timestamp) -> Self {
        let router = MarketRouter::new();
        router.add(conn).unwrap();
        let store = Arc::new(BarStore::open_in_memory().unwrap());
        let clock = Arc::new(ManualClock::new(at));
        router.set_bar_cache(BarCache::new(store as _, clock as _));
        let module = MarketModule::new(router, Arc::new(EventBus::new()));
        let mut tools = ToolRegistry::new();
        module.register_tools(&mut tools).unwrap();
        Self { tools, at }
    }

    async fn candles(&self, input: Value) -> Value {
        self.tools
            .get("market.get_candles")
            .unwrap()
            .call_json(&ToolCtx::new(Origin::User, self.at), input)
            .await
            .unwrap()
            .value
    }

    async fn own(&self, instrument: &str) -> Vec<Value> {
        let out = self
            .candles(json!({"instrument": instrument, "tf": "1D", "limit": 5000}))
            .await;
        out["bars"].as_array().unwrap().clone()
    }
}

fn t(bar: &Value) -> i64 {
    bar[0].as_i64().unwrap()
}

fn between(bars: &[Value], from: Option<i64>, to: Option<i64>) -> Vec<Value> {
    bars.iter()
        .filter(|b| from.is_none_or(|f| t(b) >= f) && to.is_none_or(|e| t(b) < e))
        .cloned()
        .collect()
}

fn newest(mut bars: Vec<Value>, n: usize) -> Vec<Value> {
    bars.drain(..bars.len().saturating_sub(n));
    bars
}

fn run(instrument: &str, bars: &[Value]) -> Value {
    json!({"instrument": instrument, "from": t(&bars[0]), "to": t(bars.last().unwrap())})
}

fn of<'a>(bars: &'a [Value], first: &Value, last: &Value) -> &'a [Value] {
    let a = bars.iter().position(|b| b == first).unwrap();
    let z = bars.iter().position(|b| b == last).unwrap();
    &bars[a..=z]
}

async fn quarterlies(lookup: bool, expired_bars: bool) -> (Desk, Arc<Quarterlies>) {
    let fake = Arc::new(Quarterlies::new(lookup, expired_bars));
    (
        Desk::over(Arc::clone(&fake) as Arc<dyn MarketDataProvider>, now()),
        fake,
    )
}

#[tokio::test]
async fn daily_bars_before_the_roll_are_the_earlier_contracts_own() {
    let (d, fake) = quarterlies(true, true).await;
    let ask = json!({"instrument": "NQZ6.CME", "tf": "1D", "limit": 120, "frontMonths": true});
    let out = d.candles(ask.clone()).await;
    let asked = fake.asked();
    for earlier in ["NQU6.CME", "NQM6.CME"] {
        assert!(asked.iter().any(|i| i == earlier), "{asked:?}");
    }

    fake.forget();
    let again = d.candles(ask).await;
    assert_eq!(again, out);
    let asked = fake.asked();
    assert!(
        asked.iter().all(|i| i == "NQZ6.CME"),
        "earlier contracts are read from the kept bars: {asked:?}"
    );

    let (z6, u6, m6) = (
        d.own("NQZ6.CME").await,
        d.own("NQU6.CME").await,
        d.own("NQM6.CME").await,
    );
    let u6_roll = day_start(roll_2026(FuturesMonth::U));
    let m6_roll = day_start(roll_2026(FuturesMonth::M));
    let stitched: Vec<Value> = [
        between(&m6, None, Some(m6_roll)),
        between(&u6, Some(m6_roll), Some(u6_roll)),
        between(&z6, Some(u6_roll), None),
    ]
    .concat();
    let bars = out["bars"].as_array().unwrap();
    assert_eq!(bars, &newest(stitched, 120));
    assert_eq!(out["instrument"], "NQZ6.CME");
    let from_m6 = between(bars, None, Some(m6_roll));
    let from_u6 = between(bars, Some(m6_roll), Some(u6_roll));
    let from_z6 = between(bars, Some(u6_roll), None);
    assert_eq!(from_m6, of(&m6, &from_m6[0], from_m6.last().unwrap()));
    assert_eq!(from_u6, of(&u6, &from_u6[0], from_u6.last().unwrap()));
    assert_eq!(from_z6[0][0].as_i64(), Some(u6_roll));
    assert_eq!(
        out["contracts"],
        json!([
            run("NQM6.CME", &from_m6),
            run("NQU6.CME", &from_u6),
            run("NQZ6.CME", &from_z6),
        ])
    );

    let plain = d
        .candles(json!({"instrument": "NQZ6.CME", "tf": "1D", "limit": 120}))
        .await;
    assert_eq!(plain["bars"].as_array().unwrap(), &newest(z6, 120));
    assert!(plain.get("contracts").is_none(), "{plain}");
}

#[tokio::test]
async fn an_older_page_continues_through_the_earlier_contracts() {
    let (d, _) = quarterlies(true, true).await;
    let (z6, u6, m6) = (
        d.own("NQZ6.CME").await,
        d.own("NQU6.CME").await,
        d.own("NQM6.CME").await,
    );
    let u6_roll = day_start(roll_2026(FuturesMonth::U));
    let m6_roll = day_start(roll_2026(FuturesMonth::M));
    let stitched: Vec<Value> = [
        between(&m6, None, Some(m6_roll)),
        between(&u6, Some(m6_roll), Some(u6_roll)),
        between(&z6, Some(u6_roll), None),
    ]
    .concat();

    let first = d
        .candles(json!({"instrument": "NQZ6.CME", "tf": "1D", "limit": 30, "frontMonths": true}))
        .await;
    let first_t = t(&first["bars"][0]);
    assert!(first_t > m6_roll && first_t < u6_roll, "{first_t}");

    let page = d
        .candles(json!({
            "instrument": "NQZ6.CME",
            "tf": "1D",
            "limit": 100,
            "to": first_t - 1,
            "frontMonths": true,
        }))
        .await;
    let bars = page["bars"].as_array().unwrap();
    assert_eq!(bars, &newest(between(&stitched, None, Some(first_t)), 100));
    let from_m6 = between(bars, None, Some(m6_roll));
    let from_u6 = between(bars, Some(m6_roll), None);
    assert_eq!(
        page["contracts"],
        json!([run("NQM6.CME", &from_m6), run("NQU6.CME", &from_u6)])
    );

    let deeper = d
        .candles(json!({
            "instrument": "NQZ6.CME",
            "tf": "1D",
            "limit": 40,
            "to": t(&bars[0]) - 1,
            "frontMonths": true,
        }))
        .await;
    let deeper_bars = deeper["bars"].as_array().unwrap();
    assert_eq!(
        deeper_bars,
        &newest(between(&stitched, None, Some(t(&bars[0]))), 40)
    );
    assert_eq!(deeper["contracts"], json!([run("NQM6.CME", deeper_bars)]));
}

#[tokio::test]
async fn the_plain_answer_stands_when_no_earlier_contract_is_found() {
    let (d, _) = quarterlies(false, true).await;
    let plain = d
        .candles(json!({"instrument": "NQZ6.CME", "tf": "1D", "limit": 120}))
        .await;
    let out = d
        .candles(json!({"instrument": "NQZ6.CME", "tf": "1D", "limit": 120, "frontMonths": true}))
        .await;
    assert_eq!(out, plain);
    assert!(out.get("contracts").is_none());
}

#[tokio::test]
async fn the_plain_answer_stands_when_earlier_contracts_have_no_bars() {
    let (d, _) = quarterlies(true, false).await;
    let plain = d
        .candles(json!({"instrument": "NQZ6.CME", "tf": "1D", "limit": 120}))
        .await;
    let out = d
        .candles(json!({"instrument": "NQZ6.CME", "tf": "1D", "limit": 120, "frontMonths": true}))
        .await;
    assert_eq!(out, plain);
    assert!(out.get("contracts").is_none());
}

#[tokio::test]
async fn intraday_bars_ignore_front_months() {
    let mock = MockMarket::new(MockConfig::new(Arc::new(ManualClock::new(sim_now())) as _));
    let d = Desk::over(Arc::new(mock) as Arc<dyn MarketDataProvider>, sim_now());
    let plain = d
        .candles(json!({"instrument": "ES", "tf": "1h", "limit": 50}))
        .await;
    let out = d
        .candles(json!({"instrument": "ES", "tf": "1h", "limit": 50, "frontMonths": true}))
        .await;
    assert_eq!(out, plain);
}

fn sim_now() -> Timestamp {
    Timestamp::parse(tessera_market::mock::FROZEN_AT).unwrap()
}

#[tokio::test]
async fn the_sim_charts_es_daily_through_its_earlier_quarterlies() {
    let mock = MockMarket::new(MockConfig::new(Arc::new(ManualClock::new(sim_now())) as _));
    let listed: Vec<String> = mock
        .search("ES", None, 50)
        .await
        .unwrap()
        .iter()
        .map(|i| i.id.to_string())
        .collect();
    assert!(!listed.iter().any(|i| i == "ESU6.CME"), "{listed:?}");
    let d = Desk::over(Arc::new(mock) as Arc<dyn MarketDataProvider>, sim_now());
    let out = d
        .candles(json!({"instrument": "ES", "tf": "1D", "limit": 300, "frontMonths": true}))
        .await;
    assert_eq!(out["instrument"], "ESZ6.CME");
    assert_eq!(out["bars"].as_array().unwrap().len(), 300);
    let runs = out["contracts"].as_array().unwrap();
    let names: Vec<&str> = runs
        .iter()
        .map(|r| r["instrument"].as_str().unwrap())
        .collect();
    assert_eq!(
        &names[names.len() - 4..],
        ["ESH6.CME", "ESM6.CME", "ESU6.CME", "ESZ6.CME"]
    );
    let z6 = &runs[runs.len() - 1];
    let u6 = &runs[runs.len() - 2];
    assert_eq!(
        z6["from"].as_i64(),
        Some(day_start(roll_2026(FuturesMonth::U)))
    );
    assert_eq!(
        u6["from"].as_i64(),
        Some(day_start(roll_2026(FuturesMonth::M)))
    );
    assert_eq!(
        u6["to"].as_i64(),
        Some(day_start(CAL.prev_trade_date(roll_2026(FuturesMonth::U))))
    );
    let own = d.own("ESU6.CME").await;
    let last = own.last().unwrap();
    assert!(
        t(last) <= day_start(date(2026, 9, 18)),
        "U6 ends at its last trade"
    );
    let from_u6 = between(
        out["bars"].as_array().unwrap(),
        Some(day_start(roll_2026(FuturesMonth::M))),
        Some(day_start(roll_2026(FuturesMonth::U))),
    );
    assert_eq!(from_u6, of(&own, &from_u6[0], from_u6.last().unwrap()));
}

#[tokio::test]
async fn the_sim_keeps_an_expired_quarterly_for_its_history_but_not_for_trading() {
    let mock = MockMarket::new(MockConfig::new(Arc::new(ManualClock::new(sim_now())) as _));
    let (expired, _) = mock
        .spec(&InstrumentId::new("ESU6.CME").unwrap())
        .await
        .unwrap();
    assert!(!expired.tradable, "an expired contract takes no orders");
    let (front, _) = mock
        .spec(&InstrumentId::new("ESZ6.CME").unwrap())
        .await
        .unwrap();
    assert!(front.tradable);
}
