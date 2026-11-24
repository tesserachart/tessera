use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use futures::stream::{self, BoxStream};
use rust_decimal::Decimal;
use tessera_broker::{
    BrokerError, BrokerEvent, BrokerProvider, BrokerSystem, OrderChanges, Verified,
};
use tessera_core::accounts::{
    AccountSummary, Environment, Restrictions, TradingAccount, mask_account_number,
};
use tessera_core::capabilities::BrokerCapabilities;
use tessera_core::health::{ConnectionPhase, HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::{AccountId, BrokerId, ConnectionId, DraftId, OrderId};
use tessera_core::money::{Currency, Money};
use tessera_core::orders::{Fill, Order, OrderPreview, OrderRequest, Position};
use tessera_core::{SharedClock, Timestamp};
use tessera_host::{ModuleContext, ModuleFactory, RuntimeModule};
use tessera_market::mock::MOCK_PROVIDER_ID;
use tessera_rithmic::firms;
use tessera_runtime::connections::ConnectionsService;

pub const FIRM_SYSTEM_VAR: &str = "TESSERA_TEST_FIRM";
pub const FIRM_ACCOUNTS_VAR: &str = "TESSERA_TEST_FIRM_ACCOUNTS";

const READ_ONLY: &str = "the test firm connection is read-only";

#[derive(Clone, Debug)]
pub struct Link {
    state: Arc<Mutex<LinkState>>,
}

#[derive(Debug)]
struct LinkState {
    status: HealthStatus,
    message: Option<String>,
    latency_ms: Option<f64>,
    connection: Option<ConnectionPhase>,
}

impl Link {
    fn state(&self) -> MutexGuard<'_, LinkState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn new(status: HealthStatus) -> Self {
        Self {
            state: Arc::new(Mutex::new(LinkState {
                status,
                message: None,
                latency_ms: None,
                connection: None,
            })),
        }
    }

    pub fn set(&self, status: HealthStatus, message: Option<String>, latency_ms: Option<f64>) {
        *self.state() = LinkState {
            status,
            message,
            latency_ms,
            connection: None,
        };
    }

    pub fn enter(&self, phase: ConnectionPhase, latency_ms: Option<f64>) {
        *self.state() = LinkState {
            status: phase.status(),
            message: None,
            latency_ms,
            connection: Some(phase),
        };
    }

    pub fn status(&self) -> HealthStatus {
        self.state().status
    }

    pub fn health(
        &self,
        provider_id: &str,
        kind: ProviderKind,
        display_name: &str,
        checked_at: Timestamp,
    ) -> ProviderHealth {
        let state = self.state();
        ProviderHealth {
            provider_id: provider_id.to_owned(),
            kind,
            display_name: display_name.to_owned(),
            status: state.status,
            latency_ms: state.latency_ms,
            last_message_at: None,
            message: state.message.clone(),
            connection: state.connection.clone(),
            accounts: None,
            checked_at,
        }
    }
}

pub struct FirmLogin {
    pub system: String,
    pub accounts: Vec<String>,
    pub environment: Option<Environment>,
}

impl FirmLogin {
    pub fn from_env() -> Option<Self> {
        let system = std::env::var(FIRM_SYSTEM_VAR).ok()?;
        let accounts = std::env::var(FIRM_ACCOUNTS_VAR)
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_owned)
            .collect();
        Some(Self {
            system,
            accounts,
            environment: None,
        })
    }

    pub fn module(self) -> ModuleFactory {
        Box::new(move |ctx: &ModuleContext| {
            let connections = ctx
                .services
                .get::<ConnectionsService>()
                .ok_or("the runtime offers no connections")?;
            let firm = FirmBroker::new(self, Arc::clone(&ctx.clock));
            connections
                .add_broker(Arc::new(firm))
                .map_err(|e| e.to_string())?;
            Ok(Arc::new(FirmModule) as Arc<dyn RuntimeModule>)
        })
    }
}

struct FirmModule;

impl RuntimeModule for FirmModule {
    fn name(&self) -> &'static str {
        "test-firm"
    }
}

pub struct FirmBroker {
    id: String,
    display_name: String,
    login: FirmLogin,
    clock: SharedClock,
    link: Link,
    order_entry_switch: bool,
}

impl FirmBroker {
    pub fn new(login: FirmLogin, clock: SharedClock) -> Self {
        Self {
            id: MOCK_PROVIDER_ID.to_owned(),
            display_name: format!("{} · test", login.system),
            login,
            clock,
            link: Link::new(HealthStatus::Ok),
            order_entry_switch: false,
        }
    }

    pub fn linked(
        id: &str,
        display_name: &str,
        login: FirmLogin,
        clock: SharedClock,
        link: Link,
    ) -> Self {
        Self {
            id: id.to_owned(),
            display_name: display_name.to_owned(),
            login,
            clock,
            link,
            order_entry_switch: true,
        }
    }

    fn system_environment(&self) -> Environment {
        self.login
            .environment
            .unwrap_or_else(|| firms::system_environment(&self.login.system))
    }

    fn account(&self, name: &str) -> TradingAccount {
        TradingAccount {
            id: AccountId::new(format!("{}-{}", self.id, name.to_ascii_lowercase())),
            display_name: name.to_owned(),
            environment: self
                .login
                .environment
                .unwrap_or_else(|| firms::environment(&self.login.system, name, None)),
            broker_id: BrokerId::new(&self.id),
            connection_id: ConnectionId::new(&self.id),
            program_id: None,
            rule_set_id: None,
            currency: Currency::Usd,
            restrictions: Restrictions::default(),
            group_id: None,
            external_ref_masked: Some(mask_account_number(name)),
        }
    }

    fn all(&self) -> Vec<TradingAccount> {
        self.login
            .accounts
            .iter()
            .map(|a| self.account(a))
            .collect()
    }
}

fn usd(v: i64) -> Money {
    Money::usd(Decimal::from(v))
}

#[async_trait]
impl BrokerProvider for FirmBroker {
    fn id(&self) -> &str {
        &self.id
    }

    fn capabilities(&self) -> BrokerCapabilities {
        BrokerCapabilities {
            order_types: vec![],
            time_in_force: vec![],
            brackets: false,
            oco: false,
            modify: false,
            read_only: true,
            environments: vec![self.system_environment()],
            fractional_qty: false,
            stop_rules: false,
        }
    }

    fn system(&self) -> BrokerSystem {
        BrokerSystem {
            name: self.login.system.clone(),
            environment: self.system_environment(),
        }
    }

    fn account_order_entry(&self) -> Option<Vec<AccountId>> {
        self.order_entry_switch.then(Vec::new)
    }

    fn health(&self) -> ProviderHealth {
        self.link.health(
            &self.id,
            ProviderKind::Broker,
            &self.display_name,
            self.clock.now(),
        )
    }

    fn environment_of(&self, account: &AccountId) -> Option<Environment> {
        self.all()
            .into_iter()
            .find(|a| &a.id == account)
            .map(|a| a.environment)
    }

    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        if self.link.status() != HealthStatus::Ok {
            return Err(BrokerError::Unavailable("not logged in".into()));
        }
        Ok(self.all())
    }

    async fn summary(&self, account: &AccountId) -> Result<AccountSummary, BrokerError> {
        Ok(AccountSummary {
            account_id: account.clone(),
            balance: usd(50_000),
            net_liq: usd(50_000),
            day_pnl: usd(0),
            realized_today: usd(0),
            fees_today: usd(0),
            unrealized_today: usd(0),
            open_pnl: usd(0),
            buying_power: usd(50_000),
            as_of: self.clock.now(),
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
        Err(BrokerError::Unsupported(READ_ONLY.into()))
    }

    async fn submit(
        &self,
        _: &Verified,
        _: OrderRequest,
        _: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        Err(BrokerError::Unsupported(READ_ONLY.into()))
    }

    async fn modify(
        &self,
        _: &Verified,
        _: &OrderId,
        _: OrderChanges,
    ) -> Result<Order, BrokerError> {
        Err(BrokerError::Unsupported(READ_ONLY.into()))
    }

    async fn cancel(&self, _: &Verified, _: &OrderId) -> Result<Order, BrokerError> {
        Err(BrokerError::Unsupported(READ_ONLY.into()))
    }

    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        Box::pin(stream::pending())
    }
}
