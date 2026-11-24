use async_trait::async_trait;
use chrono::Datelike;
use futures::stream::BoxStream;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::health::{HealthStatus, ProviderHealth};
use tessera_core::instrument::{AssetClass, ContractSpec, ExchangeContract, Instrument};
use tessera_core::market::{Bar, BookSnapshot, Quote, Trade};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MarketError {
    #[error("unknown instrument {0}")]
    UnknownInstrument(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
}

/// What a connection's history replays have sent: requests asked and the bytes of their answers.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    serde::Serialize,
    serde::Deserialize,
    ts_rs::TS,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub struct HistoryUse {
    /// Requests to the history service.
    #[ts(type = "number")]
    pub requests: u64,
    /// Bytes of their answers.
    #[ts(type = "number")]
    pub bytes: u64,
}

impl HistoryUse {
    pub fn add(&mut self, other: Self) {
        self.requests += other.requests;
        self.bytes += other.bytes;
    }

    #[must_use]
    pub fn since(self, before: Self) -> Self {
        if self.requests < before.requests || self.bytes < before.bytes {
            return self;
        }
        Self {
            requests: self.requests - before.requests,
            bytes: self.bytes - before.bytes,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BarsRequest {
    pub instrument: InstrumentId,
    pub tf: Timeframe,
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    pub limit: Option<usize>,
    pub rth_only: bool,
}

impl BarsRequest {
    pub fn latest(instrument: InstrumentId, tf: Timeframe, limit: usize) -> Self {
        Self {
            instrument,
            tf,
            from: None,
            to: None,
            limit: Some(limit),
            rth_only: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BarSeries {
    pub instrument: InstrumentId,
    pub tf: Timeframe,
    pub bars: Vec<Bar>,
    pub last_bar_open: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveBar {
    pub instrument: InstrumentId,
    pub tf: Timeframe,
    pub bar: Bar,
    pub closed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradesRequest {
    pub instrument: InstrumentId,
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    pub limit: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BookSide {
    Bid,
    Ask,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderBookEvent {
    Clear {
        ts: Timestamp,
    },
    Synced {
        ts: Timestamp,
    },
    Add {
        ts: Timestamp,
        order: String,
        side: BookSide,
        price: Price,
        size: Qty,
    },
    Modify {
        ts: Timestamp,
        order: String,
        side: BookSide,
        price: Price,
        size: Qty,
    },
    Remove {
        ts: Timestamp,
        order: String,
        side: BookSide,
    },
}

pub type MarketStream<T> = BoxStream<'static, T>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionRef {
    pub id: String,
    pub display_name: String,
}

impl ConnectionRef {
    pub fn of(p: &(impl MarketDataProvider + ?Sized)) -> Self {
        Self {
            id: p.id().to_owned(),
            display_name: p.display_name().to_owned(),
        }
    }
}

pub fn exchange_contract(instrument: &Instrument) -> Option<ExchangeContract> {
    ExchangeContract::of(instrument, chrono::Utc::now().year())
}

#[async_trait]
pub trait MarketDataProvider: Send + Sync + 'static {
    fn id(&self) -> &str;

    fn display_name(&self) -> &str;

    fn capabilities(&self) -> MarketCapabilities;

    fn health(&self) -> ProviderHealth;

    fn prices_flowing(&self) -> bool {
        matches!(
            self.health().status,
            HealthStatus::Ok | HealthStatus::Degraded
        )
    }

    fn history_blocked(&self) -> Option<String> {
        match self.health().status {
            HealthStatus::Ok | HealthStatus::Degraded => None,
            HealthStatus::Unknown => Some("connecting".into()),
            HealthStatus::Down => Some(format!("{} is not answering", self.display_name())),
            HealthStatus::Disconnected | HealthStatus::Disabled => {
                Some(format!("{} is not connected", self.display_name()))
            }
        }
    }

    fn prices_down_for(&self, _instrument: &InstrumentId) -> Option<ProviderHealth> {
        (!self.prices_flowing()).then(|| self.health())
    }

    fn last_message_for(&self, _instrument: &InstrumentId) -> Option<Timestamp> {
        self.health().last_message_at
    }

    async fn search(
        &self,
        query: &str,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError>;

    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError>;

    async fn spec(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(Instrument, ContractSpec), MarketError>;

    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError>;

    async fn quote(&self, instrument: &InstrumentId) -> Result<Quote, MarketError>;

    fn subscribe_quotes(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Quote>, MarketError>;

    fn subscribe_trades(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Trade>, MarketError>;

    fn subscribe_bars(
        &self,
        instrument: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError>;

    async fn contract_for(
        &self,
        want: &ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        let reference_year = want
            .expiry
            .map_or_else(|| chrono::Utc::now().year(), |m| m.year);
        let found = self.search(&want.root, None, 64).await?;
        Ok(found
            .into_iter()
            .find(|i| ExchangeContract::of(i, reference_year).as_ref() == Some(want)))
    }

    async fn contract_on(
        &self,
        connection: &str,
        want: &ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        if connection == self.id() {
            self.contract_for(want).await
        } else {
            Err(MarketError::Unavailable(format!(
                "no market-data connection {connection}"
            )))
        }
    }

    fn connection(&self, id: &str) -> Option<ConnectionRef> {
        (id == self.id()).then(|| ConnectionRef::of(self))
    }

    async fn serving(&self, instrument: &InstrumentId) -> Result<ConnectionRef, MarketError> {
        self.spec(instrument).await?;
        Ok(ConnectionRef::of(self))
    }

    fn subscribe_depth(
        &self,
        instrument: &InstrumentId,
        levels: u32,
    ) -> Result<MarketStream<BookSnapshot>, MarketError> {
        let _ = levels;
        Err(MarketError::Unsupported(format!(
            "{} offers no depth for {instrument}",
            self.id()
        )))
    }

    fn subscribe_order_book(
        &self,
        instrument: &InstrumentId,
    ) -> Result<MarketStream<OrderBookEvent>, MarketError> {
        Err(MarketError::Unsupported(format!(
            "{} offers no order-by-order book for {instrument}",
            self.id()
        )))
    }

    async fn get_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        Err(MarketError::Unsupported(format!(
            "{} keeps no trade history for {}",
            self.id(),
            req.instrument
        )))
    }

    fn keeps_trade_history(&self) -> bool {
        false
    }

    fn cache_bars(&self) -> bool {
        true
    }

    fn history_use(&self) -> HistoryUse {
        HistoryUse::default()
    }

    async fn replay_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        Err(MarketError::Unsupported(format!(
            "{} replays no prints of {}",
            self.id(),
            req.instrument
        )))
    }
}
