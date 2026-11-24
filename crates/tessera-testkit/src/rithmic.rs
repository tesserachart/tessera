use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use tessera_broker::BrokerProvider;
use tessera_core::accounts::Environment;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::health::{ConnectionPhase, HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{DataSource, Quote, Trade};
use tessera_core::{InstrumentId, SharedClock, Timeframe};
use tessera_market::mock::DEFAULT_SEED;
use tessera_market::provider::HistoryUse;
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream, MockConfig,
    MockMarket, TradesRequest,
};
use tessera_rithmic::directory::{DirectoryError, Gateway};
use tessera_rithmic::{OpenError, RithmicLogin, RithmicOptions};
use tessera_runtime::connectors::{ConnectError, Connector, RithmicFactory};

use crate::firm::{FirmBroker, FirmLogin, Link};

pub const SYSTEM: &str = "Tessera Test";
pub const GOOD_PASSWORD: &str = "demo";
pub const LATENCY_MS: f64 = 18.0;
pub const REFUSAL: &str = "permission denied (code 13)";
pub const REPLAY_PAUSE: Duration = Duration::from_millis(40);
pub const CONNECTION_ID: &str = "rithmic-tessera-test";
pub const GATEWAYS: [(&str, &str); 2] = [
    ("Chicago Area", "wss://chicago.tessera-test.invalid:443"),
    ("Europe", "wss://europe.tessera-test.invalid:443"),
];
const DIRECTORY: &str = "wss://directory.tessera-test.invalid:443";

pub fn account_name(user: &str) -> String {
    format!("SIM-{}", user.to_ascii_uppercase())
}

pub const TICK_ROW_BYTES: u64 = 64;
pub const BAR_ROW_BYTES: u64 = 96;

type Asked = (InstrumentId, i64, i64);
type AskedBars = (InstrumentId, Timeframe, i64, i64);

#[derive(Clone, Debug, Default)]
pub struct ReplayLog {
    ticks: Arc<Mutex<Vec<Asked>>>,
    bars: Arc<Mutex<Vec<AskedBars>>>,
}

impl ReplayLog {
    pub fn asked(&self) -> Vec<Asked> {
        self.ticks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn asked_bars(&self) -> Vec<AskedBars> {
        self.bars
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn requests(&self) -> usize {
        self.asked().len() + self.asked_bars().len()
    }

    fn push(&self, req: &TradesRequest) {
        self.ticks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((
                req.instrument.clone(),
                req.from.map_or(i64::MIN, |t| t.0),
                req.to.map_or(i64::MAX, |t| t.0),
            ));
    }

    fn push_bars(&self, req: &BarsRequest) {
        self.bars
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((
                req.instrument.clone(),
                req.tf,
                req.from.map_or(i64::MIN, |t| t.0),
                req.to.map_or(i64::MAX, |t| t.0),
            ));
    }
}

#[derive(Clone, Debug)]
pub struct Serves {
    pub seed: u64,
    pub intraday_sessions: usize,
    pub replay_pause: Duration,
    pub replays: ReplayLog,
    pub refuses_replays: bool,
}

impl Default for Serves {
    fn default() -> Self {
        Self {
            seed: DEFAULT_SEED,
            intraday_sessions: 20,
            replay_pause: REPLAY_PAUSE,
            replays: ReplayLog::default(),
            refuses_replays: false,
        }
    }
}

pub fn factory(clock: SharedClock) -> Option<Arc<dyn RithmicFactory>> {
    factory_with(clock, None, AfterLogin::Stays)
}

pub fn factory_serving_mock(clock: SharedClock, serves: Serves) -> Option<Arc<dyn RithmicFactory>> {
    factory_with(clock, Some(serves), AfterLogin::Stays)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterLogin {
    Stays,
    DropsOnItsSecondTry,
}

pub const DROPPED: &str = "connection closed";

pub fn factory_with(
    clock: SharedClock,
    serves: Option<Serves>,
    after_login: AfterLogin,
) -> Option<Arc<dyn RithmicFactory>> {
    Some(Arc::new(FakeRithmic {
        clock,
        serves,
        after_login,
        mock: OnceLock::new(),
    }))
}

fn check(login: &RithmicLogin) -> Result<(), ConnectError> {
    if login.password == GOOD_PASSWORD {
        Ok(())
    } else {
        Err(OpenError::Refused(REFUSAL.to_owned()).into())
    }
}

#[derive(Debug)]
struct FakeRithmic {
    clock: SharedClock,
    serves: Option<Serves>,
    after_login: AfterLogin,
    mock: OnceLock<MockMarket>,
}

impl FakeRithmic {
    fn market(&self, id: String, display_name: String, link: Link) -> Arc<dyn MarketDataProvider> {
        match &self.serves {
            None => Arc::new(ServesNothing {
                id,
                display_name,
                link,
                clock: Arc::clone(&self.clock),
            }),
            Some(serves) => {
                let mock = self.mock.get_or_init(|| {
                    let mut config = MockConfig::new(Arc::clone(&self.clock));
                    config.seed = serves.seed;
                    config.intraday_sessions = serves.intraday_sessions;
                    config.keeps_trade_history = false;
                    config.refuses_replays = serves.refuses_replays;
                    MockMarket::new(config)
                });
                Arc::new(ServesMock {
                    id,
                    display_name,
                    link,
                    clock: Arc::clone(&self.clock),
                    mock: mock.clone(),
                    replay_pause: serves.replay_pause,
                    replays: serves.replays.clone(),
                    used: Mutex::default(),
                })
            }
        }
    }
}

#[async_trait]
impl RithmicFactory for FakeRithmic {
    fn open(&self, login: RithmicLogin) -> Result<Arc<dyn Connector>, ConnectError> {
        let options = RithmicOptions::for_system(&login.system_name);
        let link = Link::new(HealthStatus::Disconnected);
        let broker = FirmBroker::linked(
            &options.provider_id,
            &options.display_name,
            FirmLogin {
                system: login.system_name.clone(),
                accounts: vec![account_name(&login.user)],
                environment: Some(Environment::Eval),
            },
            Arc::clone(&self.clock),
            link.clone(),
        );
        let market = self.market(options.provider_id, options.display_name, link.clone());
        Ok(Arc::new(FakeConnector {
            login,
            link,
            after_login: self.after_login,
            market,
            broker: Arc::new(broker),
        }))
    }

    async fn test(&self, login: RithmicLogin) -> Result<(), ConnectError> {
        check(&login)
    }

    fn directory(&self) -> Vec<String> {
        vec![DIRECTORY.to_owned()]
    }

    async fn systems(&self, _url: &str) -> Result<Vec<String>, DirectoryError> {
        Ok(vec![SYSTEM.to_owned()])
    }

    async fn gateways(&self, _url: &str, system: &str) -> Result<Vec<Gateway>, DirectoryError> {
        if system != SYSTEM {
            return Err(DirectoryError::Refused("no such system (code 7)".into()));
        }
        Ok(GATEWAYS
            .map(|(name, uri)| Gateway {
                name: name.to_owned(),
                uri: uri.to_owned(),
            })
            .to_vec())
    }
}

struct FakeConnector {
    login: RithmicLogin,
    link: Link,
    after_login: AfterLogin,
    market: Arc<dyn MarketDataProvider>,
    broker: Arc<FirmBroker>,
}

#[async_trait]
impl Connector for FakeConnector {
    fn id(&self) -> &str {
        self.market.id()
    }

    fn market(&self) -> Arc<dyn MarketDataProvider> {
        Arc::clone(&self.market)
    }

    fn broker(&self) -> Option<Arc<dyn BrokerProvider>> {
        Some(Arc::clone(&self.broker) as _)
    }

    async fn connect(&self) -> Result<(), ConnectError> {
        self.link.enter(ConnectionPhase::Connecting, None);
        match (check(&self.login), self.after_login) {
            (Ok(()), AfterLogin::Stays) => {
                self.link.enter(ConnectionPhase::Live, Some(LATENCY_MS));
                Ok(())
            }
            (Ok(()), AfterLogin::DropsOnItsSecondTry) => {
                let second_try = ConnectionPhase::Reconnecting {
                    attempt: 2,
                    reason: DROPPED.to_owned(),
                };
                self.link.enter(second_try, None);
                Ok(())
            }
            (Err(e), _) => {
                let refused = ConnectionPhase::Refused {
                    reason: REFUSAL.to_owned(),
                };
                self.link.enter(refused, None);
                Err(e)
            }
        }
    }

    async fn shutdown(&self) {
        self.link.enter(ConnectionPhase::Stopped, None);
    }
}

struct ServesNothing {
    id: String,
    display_name: String,
    link: Link,
    clock: SharedClock,
}

fn not_served(what: impl std::fmt::Display) -> MarketError {
    MarketError::UnknownInstrument(what.to_string())
}

fn no_stream() -> MarketError {
    MarketError::Unsupported("the test Rithmic login serves no instruments".into())
}

#[async_trait]
impl MarketDataProvider for ServesNothing {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: Vec::new(),
            live_timeframes: Vec::new(),
            quotes: false,
            trades: false,
            depth_levels: None,
            footprint: false,
            asset_classes: Vec::new(),
            max_intraday_history_days: None,
            max_daily_history_days: None,
            realtime: false,
            aggressor_source: None,
        }
    }

    fn health(&self) -> ProviderHealth {
        self.link.health(
            &self.id,
            ProviderKind::MarketData,
            &self.display_name,
            self.clock.now(),
        )
    }

    async fn search(
        &self,
        _query: &str,
        _asset_class: Option<AssetClass>,
        _limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        Ok(Vec::new())
    }

    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        Err(not_served(input))
    }

    async fn spec(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(Instrument, ContractSpec), MarketError> {
        Err(not_served(instrument))
    }

    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        Err(not_served(req.instrument))
    }

    async fn quote(&self, instrument: &InstrumentId) -> Result<Quote, MarketError> {
        Err(not_served(instrument))
    }

    fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        Err(no_stream())
    }

    fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        Err(no_stream())
    }

    fn subscribe_bars(
        &self,
        _: &InstrumentId,
        _: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        Err(no_stream())
    }
}

struct ServesMock {
    id: String,
    display_name: String,
    link: Link,
    clock: SharedClock,
    mock: MockMarket,
    replay_pause: Duration,
    replays: ReplayLog,
    used: Mutex<HistoryUse>,
}

impl ServesMock {
    fn sent(&self) {
        self.used
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .requests += 1;
    }

    fn answered(&self, rows: usize, row_bytes: u64) {
        self.used
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .bytes += rows as u64 * row_bytes;
    }

    fn up(&self) -> Result<(), MarketError> {
        match self.link.status() {
            HealthStatus::Ok => Ok(()),
            _ => Err(MarketError::Unavailable(format!(
                "{} is not connected",
                self.display_name
            ))),
        }
    }
}

#[async_trait]
impl MarketDataProvider for ServesMock {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn capabilities(&self) -> MarketCapabilities {
        self.mock.capabilities()
    }

    fn health(&self) -> ProviderHealth {
        self.link.health(
            &self.id,
            ProviderKind::MarketData,
            &self.display_name,
            self.clock.now(),
        )
    }

    async fn search(
        &self,
        query: &str,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.up()?;
        self.mock.search(query, asset_class, limit).await
    }

    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.up()?;
        self.mock.resolve(input).await
    }

    async fn spec(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(Instrument, ContractSpec), MarketError> {
        self.up()?;
        self.mock.spec(instrument).await
    }

    async fn contract_for(
        &self,
        want: &tessera_core::instrument::ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        self.up()?;
        self.mock.contract_for(want).await
    }

    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.up()?;
        self.replays.push_bars(&req);
        self.sent();
        tokio::time::sleep(self.replay_pause).await;
        let series = self.mock.get_bars(req).await?;
        self.answered(series.bars.len(), BAR_ROW_BYTES);
        Ok(series)
    }

    async fn quote(&self, instrument: &InstrumentId) -> Result<Quote, MarketError> {
        self.up()?;
        self.mock.quote(instrument).await
    }

    fn history_use(&self) -> HistoryUse {
        *self.used.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn subscribe_quotes(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Quote>, MarketError> {
        self.mock.subscribe_quotes(instruments)
    }

    fn subscribe_trades(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Trade>, MarketError> {
        let source = DataSource {
            provider: self.id.clone(),
        };
        Ok(self
            .mock
            .subscribe_trades(instruments)?
            .map(move |mut t| {
                t.source = Some(source.clone());
                t
            })
            .boxed())
    }

    fn subscribe_bars(
        &self,
        instrument: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.mock.subscribe_bars(instrument, tf)
    }

    fn subscribe_depth(
        &self,
        instrument: &InstrumentId,
        levels: u32,
    ) -> Result<MarketStream<tessera_core::market::BookSnapshot>, MarketError> {
        self.mock.subscribe_depth(instrument, levels)
    }

    fn keeps_trade_history(&self) -> bool {
        false
    }

    async fn replay_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        self.up()?;
        self.replays.push(&req);
        self.sent();
        tokio::time::sleep(self.replay_pause).await;
        let trades = self.mock.replay_trades(req).await?;
        self.answered(trades.len(), TICK_ROW_BYTES);
        Ok(trades)
    }
}
