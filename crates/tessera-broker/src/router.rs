use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use parking_lot::RwLock;
use tessera_core::Qty;
use tessera_core::Timestamp;
use tessera_core::accounts::{AccountSummary, Environment, RiskStatus, TradingAccount};
use tessera_core::capabilities::BrokerCapabilities;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::{AccountId, DraftId, OrderId};
use tessera_core::instrument::{ContractSpec, ExchangeContract, Instrument, InstrumentId};
use tessera_core::orders::{Bracket, Fill, Order, OrderPreview, OrderRequest, Position};
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use crate::{
    BrokerConnection, BrokerError, BrokerEvent, BrokerProvider, BrokerSystem, OrderChanges,
    Verified,
};

struct Child {
    provider: Arc<dyn BrokerProvider>,
    pump: JoinHandle<()>,
}

pub struct BrokerRouter {
    children: RwLock<Vec<Child>>,
    account_types: RwLock<BTreeMap<AccountId, Environment>>,
    events: broadcast::Sender<BrokerEvent>,
    changes: watch::Sender<u64>,
}

impl std::fmt::Debug for BrokerRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrokerRouter")
            .field(
                "connections",
                &self
                    .children
                    .read()
                    .iter()
                    .map(|c| c.provider.id().to_owned())
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl Drop for BrokerRouter {
    fn drop(&mut self) {
        for c in self.children.get_mut().drain(..) {
            c.pump.abort();
        }
    }
}

impl BrokerRouter {
    pub const ID: &'static str = "brokers";

    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            children: RwLock::new(Vec::new()),
            account_types: RwLock::new(BTreeMap::new()),
            events: broadcast::channel(4_096).0,
            changes: watch::channel(0).0,
        })
    }

    pub fn add(&self, provider: Arc<dyn BrokerProvider>) -> Result<(), BrokerError> {
        {
            let mut children = self.children.write();
            if children.iter().any(|c| c.provider.id() == provider.id()) {
                return Err(BrokerError::Rejected(format!(
                    "a broker connection with id {:?} is already connected",
                    provider.id()
                )));
            }
            let mut stream = provider.events();
            let tx = self.events.clone();
            let pump = tokio::spawn(async move {
                while let Some(e) = stream.next().await {
                    let _ = tx.send(e);
                }
            });
            children.push(Child { provider, pump });
        }
        self.changes.send_modify(|v| *v += 1);
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Option<Arc<dyn BrokerProvider>> {
        let removed = {
            let mut children = self.children.write();
            let i = children.iter().position(|c| c.provider.id() == id)?;
            children.remove(i)
        };
        removed.pump.abort();
        self.changes.send_modify(|v| *v += 1);
        Some(removed.provider)
    }

    pub fn providers(&self) -> Vec<Arc<dyn BrokerProvider>> {
        self.children
            .read()
            .iter()
            .map(|c| Arc::clone(&c.provider))
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn BrokerProvider>> {
        self.children
            .read()
            .iter()
            .find(|c| c.provider.id() == id)
            .map(|c| Arc::clone(&c.provider))
    }

    pub fn set_account_types(&self, types: BTreeMap<AccountId, Environment>) {
        *self.account_types.write() = types;
    }

    fn typed(&self, account: &AccountId, reported: Environment) -> Environment {
        self.account_types
            .read()
            .get(account)
            .copied()
            .unwrap_or(reported)
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn healths(&self) -> Vec<ProviderHealth> {
        self.providers().iter().map(|p| p.health()).collect()
    }

    async fn owner(&self, account: &AccountId) -> Result<Arc<dyn BrokerProvider>, BrokerError> {
        let all = self.providers();
        if let Some(p) = all.iter().find(|p| p.environment_of(account).is_some()) {
            return Ok(Arc::clone(p));
        }
        for p in all {
            if let Ok(accounts) = p.accounts().await
                && accounts.iter().any(|a| &a.id == account)
            {
                return Ok(p);
            }
        }
        Err(BrokerError::NotFound(format!("account {account}")))
    }

    async fn order_owner(&self, order: &OrderId) -> Result<Arc<dyn BrokerProvider>, BrokerError> {
        let (p, o) = self
            .providers()
            .into_iter()
            .find_map(|p| p.order_of(order).map(|o| (p, o)))
            .ok_or_else(|| BrokerError::NotFound(format!("order {order}")))?;
        let account_owner = self.owner(&o.request.account_id).await?;
        if account_owner.id() != p.id() {
            return Err(BrokerError::Refused(crate::SendRefused::Mismatch(format!(
                "order {order} is on {} but its account {} is on {}",
                p.id(),
                o.request.account_id,
                account_owner.id()
            ))));
        }
        Ok(p)
    }
}

#[async_trait]
impl BrokerProvider for BrokerRouter {
    fn id(&self) -> &str {
        Self::ID
    }

    fn capabilities(&self) -> BrokerCapabilities {
        let all: Vec<BrokerCapabilities> =
            self.providers().iter().map(|p| p.capabilities()).collect();
        let mut out = BrokerCapabilities {
            order_types: Vec::new(),
            time_in_force: Vec::new(),
            brackets: false,
            oco: false,
            modify: false,
            read_only: true,
            environments: Vec::new(),
            fractional_qty: false,
            stop_rules: false,
        };
        for c in all {
            for t in c.order_types {
                if !out.order_types.contains(&t) {
                    out.order_types.push(t);
                }
            }
            for t in c.time_in_force {
                if !out.time_in_force.contains(&t) {
                    out.time_in_force.push(t);
                }
            }
            for e in c.environments {
                if !out.environments.contains(&e) {
                    out.environments.push(e);
                }
            }
            out.brackets |= c.brackets;
            out.oco |= c.oco;
            out.modify |= c.modify;
            out.read_only &= c.read_only;
            out.fractional_qty |= c.fractional_qty;
            out.stop_rules |= c.stop_rules;
        }
        out
    }

    fn system(&self) -> BrokerSystem {
        self.providers().first().map_or_else(
            || BrokerSystem {
                name: "none".into(),
                environment: Environment::Live,
            },
            |p| p.system(),
        )
    }

    fn health(&self) -> ProviderHealth {
        let all = self.healths();
        let rank = |s: HealthStatus| match s {
            HealthStatus::Ok => 0,
            HealthStatus::Unknown => 1,
            HealthStatus::Degraded => 2,
            HealthStatus::Disconnected => 3,
            HealthStatus::Down => 4,
            HealthStatus::Disabled => 5,
        };
        ProviderHealth {
            provider_id: Self::ID.to_owned(),
            kind: ProviderKind::Broker,
            display_name: "Brokers".into(),
            status: all
                .iter()
                .map(|h| h.status)
                .max_by_key(|s| rank(*s))
                .unwrap_or(HealthStatus::Disconnected),
            latency_ms: None,
            last_message_at: all.iter().filter_map(|h| h.last_message_at).max(),
            message: Some(format!("{} connection(s)", all.len())),
            connection: None,
            accounts: None,
            checked_at: all
                .iter()
                .map(|h| h.checked_at)
                .max()
                .unwrap_or(Timestamp(0)),
        }
    }

    async fn connection_of(&self, account: &AccountId) -> Result<BrokerConnection, BrokerError> {
        self.owner(account).await?.connection_of(account).await
    }

    fn environment_of(&self, account: &AccountId) -> Option<Environment> {
        self.providers()
            .iter()
            .find_map(|p| p.environment_of(account))
            .map(|e| self.typed(account, e))
    }

    fn order_of(&self, order: &OrderId) -> Option<Order> {
        self.providers().iter().find_map(|p| p.order_of(order))
    }

    async fn contract_for(
        &self,
        account: &AccountId,
        want: &ExchangeContract,
    ) -> Result<Option<(Instrument, ContractSpec)>, BrokerError> {
        self.owner(account).await?.contract_for(account, want).await
    }

    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        let mut out = Vec::new();
        let mut last_err = None;
        let mut answered = false;
        for p in self.providers() {
            match p.accounts().await {
                Ok(accounts) => {
                    answered = true;
                    out.extend(accounts.into_iter().map(|mut a| {
                        a.environment = self.typed(&a.id, a.environment);
                        a
                    }));
                }
                Err(e) => {
                    tracing::debug!(connection = p.id(), error = %e, "accounts unavailable");
                    last_err = Some(e);
                }
            }
        }
        match (answered, last_err) {
            (false, Some(e)) => Err(e),
            _ => Ok(out),
        }
    }

    async fn summary(&self, account: &AccountId) -> Result<AccountSummary, BrokerError> {
        self.owner(account).await?.summary(account).await
    }

    async fn positions(&self, account: &AccountId) -> Result<Vec<Position>, BrokerError> {
        self.owner(account).await?.positions(account).await
    }

    async fn fresh_position(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
    ) -> Result<Qty, BrokerError> {
        self.owner(account)
            .await?
            .fresh_position(account, instrument)
            .await
    }

    async fn orders(&self, account: &AccountId) -> Result<Vec<Order>, BrokerError> {
        self.owner(account).await?.orders(account).await
    }

    async fn fills(&self, account: &AccountId, since: Timestamp) -> Result<Vec<Fill>, BrokerError> {
        self.owner(account).await?.fills(account, since).await
    }

    async fn preview(&self, request: &OrderRequest) -> Result<OrderPreview, BrokerError> {
        self.owner(&request.account_id)
            .await?
            .preview(request)
            .await
    }

    async fn risk(&self, account: &AccountId) -> Result<Option<RiskStatus>, BrokerError> {
        self.owner(account).await?.risk(account).await
    }

    async fn submit(
        &self,
        verified: &Verified,
        request: OrderRequest,
        draft: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        self.owner(&request.account_id)
            .await?
            .submit(verified, request, draft)
            .await
    }

    async fn modify(
        &self,
        verified: &Verified,
        order: &OrderId,
        changes: OrderChanges,
    ) -> Result<Order, BrokerError> {
        self.order_owner(order)
            .await?
            .modify(verified, order, changes)
            .await
    }

    async fn cancel(&self, verified: &Verified, order: &OrderId) -> Result<Order, BrokerError> {
        self.order_owner(order).await?.cancel(verified, order).await
    }

    async fn attach_bracket(
        &self,
        verified: &Verified,
        entry: &OrderId,
        bracket: Bracket,
        qty: Qty,
    ) -> Result<Vec<Order>, BrokerError> {
        self.order_owner(entry)
            .await?
            .attach_bracket(verified, entry, bracket, qty)
            .await
    }

    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        tokio_stream::wrappers::BroadcastStream::new(self.events.subscribe())
            .filter_map(|e| async move {
                match e {
                    Ok(e) => Some(e),
                    Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
                        tracing::warn!(dropped = n, "broker events lagged");
                        None
                    }
                }
            })
            .boxed()
    }
}
