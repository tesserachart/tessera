pub mod copy;
pub mod guard;
pub mod guarded;
pub mod limits;
pub mod lockout;
pub mod module;
pub mod orders;
pub mod paper;
pub mod protect;
pub mod router;

use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use tessera_core::accounts::{AccountSummary, Environment, RiskStatus, TradingAccount};
use tessera_core::capabilities::BrokerCapabilities;
use tessera_core::health::ProviderHealth;
use tessera_core::ids::{AccountId, DraftId, OrderId};
use tessera_core::instrument::{ContractSpec, ExchangeContract, Instrument, InstrumentId};
use tessera_core::orders::{Bracket, Fill, Order, OrderPreview, OrderRequest, Position};
use tessera_core::{Price, Qty, Timestamp};

pub use guard::SendRefused;
pub use guarded::{GuardedBroker, Route, Verified};
pub use module::{BrokerModule, publish_account_event, ts_exports};
pub use router::BrokerRouter;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerSystem {
    pub name: String,
    pub environment: Environment,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrokerConnection {
    pub id: String,
    pub system: BrokerSystem,
    pub capabilities: BrokerCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BrokerError {
    #[error(transparent)]
    Refused(#[from] SendRefused),
    #[error("rejected by broker: {0}")]
    Rejected(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
    #[error("not found: {0}")]
    NotFound(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderChanges {
    pub qty: Option<Qty>,
    pub limit_price: Option<Price>,
    pub stop_price: Option<Price>,
}

#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrokerEvent {
    Order(Order),
    Fill(Fill),
    Position(Position),
    Account(AccountSummary),
    Disconnected { reason: String },
}

#[async_trait]
pub trait BrokerProvider: Send + Sync + 'static {
    fn id(&self) -> &str;

    fn capabilities(&self) -> BrokerCapabilities;

    fn system(&self) -> BrokerSystem;

    fn health(&self) -> ProviderHealth;

    async fn connection_of(&self, account: &AccountId) -> Result<BrokerConnection, BrokerError> {
        let _ = account;
        Ok(BrokerConnection {
            id: self.id().to_owned(),
            system: self.system(),
            capabilities: self.capabilities(),
        })
    }

    fn environment_of(&self, account: &AccountId) -> Option<Environment> {
        let _ = account;
        None
    }

    fn order_of(&self, order: &OrderId) -> Option<Order> {
        let _ = order;
        None
    }

    fn account_order_entry(&self) -> Option<Vec<AccountId>> {
        None
    }

    async fn contract_for(
        &self,
        account: &AccountId,
        want: &ExchangeContract,
    ) -> Result<Option<(Instrument, ContractSpec)>, BrokerError> {
        let _ = (account, want);
        Err(BrokerError::Unsupported(format!(
            "{} names no contracts of its own",
            self.id()
        )))
    }

    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError>;

    async fn summary(&self, account: &AccountId) -> Result<AccountSummary, BrokerError>;

    async fn positions(&self, account: &AccountId) -> Result<Vec<Position>, BrokerError>;

    async fn fresh_position(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
    ) -> Result<Qty, BrokerError> {
        Ok(self
            .positions(account)
            .await?
            .into_iter()
            .find(|p| &p.instrument == instrument)
            .map_or(Qty::ZERO, |p| p.qty))
    }

    async fn orders(&self, account: &AccountId) -> Result<Vec<Order>, BrokerError>;

    async fn fills(&self, account: &AccountId, since: Timestamp) -> Result<Vec<Fill>, BrokerError>;

    async fn preview(&self, request: &OrderRequest) -> Result<OrderPreview, BrokerError>;

    async fn risk(&self, account: &AccountId) -> Result<Option<RiskStatus>, BrokerError> {
        let _ = account;
        Ok(None)
    }

    async fn submit(
        &self,
        verified: &Verified,
        request: OrderRequest,
        draft: Option<DraftId>,
    ) -> Result<Order, BrokerError>;

    async fn modify(
        &self,
        verified: &Verified,
        order: &OrderId,
        changes: OrderChanges,
    ) -> Result<Order, BrokerError>;

    async fn cancel(&self, verified: &Verified, order: &OrderId) -> Result<Order, BrokerError>;

    async fn attach_bracket(
        &self,
        verified: &Verified,
        entry: &OrderId,
        bracket: Bracket,
        qty: Qty,
    ) -> Result<Vec<Order>, BrokerError> {
        let _ = (verified, entry, bracket, qty);
        Err(BrokerError::Unsupported(format!(
            "{} cannot attach a stop and a target to a filled entry",
            self.id()
        )))
    }

    fn events(&self) -> BoxStream<'static, BrokerEvent>;
}
