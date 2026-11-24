use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_broker::BrokerProvider;
use tessera_broker::orders::Broker;
use tessera_core::SharedClock;
use tessera_core::accounts::{ConnectionKind, ConnectionProvider, CredentialRef, CredentialStore};
use tessera_core::health::{ConnectionPhase, HealthStatus};
use tessera_core::ids::{AccountId, ConnectionId};
use tessera_market::MarketDataProvider;
use tessera_protocol::tools::RiskTier;
use tessera_rithmic::credentials::{gateway_host, gateway_is_safe};
use tessera_rithmic::directory::{DirectoryError, Gateway};
use tessera_rithmic::{OpenError, RithmicBroker, RithmicLogin, RithmicMarket, RithmicOptions};
use tessera_store::{Kept, Store, StoreError};
use tessera_tools::{RateLimit, RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use tokio::task::JoinHandle;
use ts_rs::TS;

use crate::connections::{ConnectionInfo, ConnectionsService};
use crate::logging::Redactor;
use crate::secrets::{Secrets, store_name};

pub const RECORDS_KEY: &str = "connections.configured";

pub const ORDER_ENTRY_KEY: &str = "connections.orderEntry";

const RECORDS: Kept<Vec<ConnectionProvider>> = Kept::new(RECORDS_KEY);
const ORDER_ENTRY: Kept<Vec<OrderEntryRecord>> = Kept::new(ORDER_ENTRY_KEY);

const READING: &str = "Reading the saved login.";
const WAITING: &str = "Waiting for the OS keyring to let Tessera read the saved login.";

fn saved_ref(record: &ConnectionProvider) -> Result<&CredentialRef, (CredentialState, String)> {
    record.credential.as_ref().ok_or_else(|| {
        (
            CredentialState::Missing,
            "No login is saved for this connection. Log in again.".to_owned(),
        )
    })
}

pub const RITHMIC_DIRECTORY_ENV: &str = "TESSERA_RITHMIC_DIRECTORY";

const DIRECTORY_TIMEOUT: Duration = Duration::from_secs(10);

const DIRECTORY_TTL: Duration = Duration::from_secs(10 * 60);

const NO_DIRECTORY: &str =
    "Tessera has no Rithmic address to ask yet: type your gateway's address.";

pub fn configured_directory() -> Vec<String> {
    let now = std::env::var(RITHMIC_DIRECTORY_ENV).ok();
    let built = option_env!("TESSERA_RITHMIC_DIRECTORY");
    now.as_deref()
        .into_iter()
        .chain(built)
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The user's Rithmic login, as typed into Settings › Connections.
#[derive(Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RithmicLoginInput {
    /// The system as Rithmic spells it (`Apex`, `Rithmic Paper Trading`, `Rithmic Test`).
    pub system: String,
    /// The gateway: its name as Rithmic lists it for the system (`Chicago Area`, from
    /// `connections.rithmic_directory`; any case), whose address Tessera looks up, or its `wss://`
    /// URL, from the firm's or Rithmic's instructions.
    pub gateway: String,
    /// The login name.
    pub user: String,
    /// The password.
    pub password: String,
}

impl std::fmt::Debug for RithmicLoginInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RithmicLoginInput")
            .field("system", &self.system)
            .finish_non_exhaustive()
    }
}

impl RithmicLoginInput {
    fn typed(&self) -> Result<RithmicLogin, ToolError> {
        let field = |v: &str, name: &str| {
            let v = v.trim();
            if v.is_empty() {
                Err(ToolError::invalid_input(format!("{name} is required")))
            } else {
                Ok(v.to_owned())
            }
        };
        Ok(RithmicLogin {
            system_name: field(&self.system, "system")?,
            gateway_url: field(&self.gateway, "gateway")?,
            user: field(&self.user, "user")?,
            password: if self.password.is_empty() {
                return Err(ToolError::invalid_input("password is required"));
            } else {
                self.password.clone()
            },
        })
    }
}

/// `connections.rithmic_directory` input: `{}` for the systems alone.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct RithmicDirectoryInput {
    /// A system as Rithmic lists it (`Apex`), for its gateways too.
    #[serde(default)]
    pub system: Option<String>,
}

/// `connections.rithmic_directory` output: what Rithmic lists, by name. A gateway's address never
/// leaves the runtime: a login names its gateway and Tessera looks the address up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RithmicDirectoryOutput {
    /// Every system Rithmic lists (prop firms, brokers, Rithmic's own paper and test systems), in
    /// Rithmic's order; empty when they could not be read.
    pub systems: Vec<String>,
    /// The names of `system`'s gateways (`Chicago Area`, `Europe`), in Rithmic's order; empty
    /// without `system`, or when they could not be read.
    pub gateways: Vec<String>,
    /// Why something could not be read, in plain words; null when everything asked was read.
    pub problem: Option<String>,
}

/// `connections.set_enabled` input: the user's on/off switch for a saved login.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionEnabledInput {
    /// Connection id (`rithmic-apex`).
    pub id: String,
    /// On (connected now and at every start) or off (logged out; its login stays saved).
    pub enabled: bool,
}

/// `connections.set_enabled` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEnabledOutput {
    /// The connection as `connections.list` reports it now.
    pub connection: ConnectionInfo,
}

/// `connections.add_rithmic` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsAddOutput {
    /// The connection as `connections.list` reports it.
    pub connection: ConnectionInfo,
    /// Where the login is kept: the OS keyring, or (in development) the development file.
    pub stored_in: CredentialStore,
}

/// `connections.test_rithmic` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsTestOutput {
    /// Whether Rithmic accepted the login.
    pub ok: bool,
    /// What happened, in plain words (`Logged in to Apex`, or why not).
    pub message: String,
}

/// Names one connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionIdInput {
    /// Connection id (`rithmic-apex`).
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsRemoveOutput {
    /// Whether a connection was removed.
    pub removed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsReconnectOutput {
    /// The connection after the attempt.
    pub connection: ConnectionInfo,
}

/// `connections.set_order_entry` input: the user's order-entry switch for one account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrderEntryInput {
    /// Connection id (`rithmic-apex`).
    pub connection_id: String,
    /// Account id, as the accounts list names it.
    pub account_id: String,
    /// On (the account takes orders) or off (read-only).
    pub enabled: bool,
}

/// `connections.set_order_entry` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrderEntryOutput {
    /// Connection id.
    pub connection_id: String,
    /// Account id.
    pub account_id: String,
    /// Whether order entry is on for it now.
    pub enabled: bool,
}

/// `connections.list_credentials` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialsListInput {}

/// What a saved credential logs in to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    /// A Rithmic login (system, gateway, user, password).
    Rithmic,
    /// The key or secret a source of levels sends.
    LevelSource,
}

/// Whether a saved credential is still where its record says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CredentialState {
    /// It is there.
    Stored,
    /// Its store answered without it, or with something that is not one: it is typed again.
    Missing,
    /// Its store did not answer, or refused (a locked keyring; the macOS Keychain until the user lets Tessera in):
    /// it is asked again.
    Unreadable,
}

/// One saved login or key, never its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInfo {
    /// The connection it logs in (`rithmic-apex`, a level source's id).
    pub connection_id: String,
    /// What it logs in to.
    pub kind: CredentialKind,
    /// The connection's display name (`Apex · Rithmic`, the source's name).
    pub name: String,
    /// The Rithmic system (`Apex`); none for a key.
    pub system: Option<String>,
    /// The Rithmic login's user name, read from the saved login (never its password); none for a key, or when
    /// the login cannot be read.
    pub user: Option<String>,
    /// The Rithmic login's gateway by name (`Chicago Area`), when it was chosen by name; none for a typed
    /// address (never shown), a key, or when the login cannot be read.
    pub gateway: Option<String>,
    /// Which store keeps it: the OS keyring, or (in development) the development file.
    pub store: CredentialStore,
    /// Where, in words: `OS keyring, service tessera, key rithmic.rithmic-apex`, or the development file's full
    /// path.
    pub location: String,
    /// Whether it is still there.
    pub state: CredentialState,
    /// Why it is missing or unreadable, in plain words (never the value).
    pub message: Option<String>,
}

/// `connections.list_credentials` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsListOutput {
    /// Every saved login and key the stored connections name: Rithmic logins, then level sources.
    pub credentials: Vec<CredentialInfo>,
}

pub(crate) async fn read_credential(
    secrets: &Secrets,
    r: &CredentialRef,
    what: &str,
    again: &str,
) -> Result<String, (CredentialState, String)> {
    credential_from_read(secrets.get(r).await, r, what, again)
}

pub(crate) fn credential_from_read(
    read: Result<Option<String>, crate::secrets::SecretError>,
    r: &CredentialRef,
    what: &str,
    again: &str,
) -> Result<String, (CredentialState, String)> {
    match read {
        Ok(Some(v)) => Ok(v),
        Ok(None) => Err((
            CredentialState::Missing,
            format!(
                "The saved {what} is missing from the {}. {again}",
                store_name(r.store)
            ),
        )),
        Err(e) => Err((
            CredentialState::Unreadable,
            format!("The saved {what} cannot be read: {e}."),
        )),
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderEntryRecord {
    connection_id: String,
    account_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Unreachable(String),
}

impl From<OpenError> for ConnectError {
    fn from(e: OpenError) -> Self {
        match e {
            OpenError::Transport(_) => Self::Unreachable(e.to_string()),
            OpenError::Refused(_) | OpenError::Gate(_) => Self::Refused(e.to_string()),
        }
    }
}

#[async_trait]
pub trait Connector: Send + Sync {
    fn id(&self) -> &str;
    fn market(&self) -> Arc<dyn MarketDataProvider>;
    fn broker(&self) -> Option<Arc<dyn BrokerProvider>>;
    async fn connect(&self) -> Result<(), ConnectError>;
    async fn shutdown(&self);
    fn set_account_order_entry(&self, account: &AccountId, enabled: bool) -> Result<(), String> {
        let _ = account;
        if enabled {
            Err("this connection takes no orders".into())
        } else {
            Ok(())
        }
    }
}

#[async_trait]
pub trait RithmicFactory: Send + Sync {
    fn open(&self, login: RithmicLogin) -> Result<Arc<dyn Connector>, ConnectError>;
    async fn test(&self, login: RithmicLogin) -> Result<(), ConnectError>;
    fn directory(&self) -> Vec<String> {
        configured_directory()
    }
    async fn systems(&self, url: &str) -> Result<Vec<String>, DirectoryError> {
        tessera_rithmic::directory::systems(url, DIRECTORY_TIMEOUT).await
    }
    async fn gateways(&self, url: &str, system: &str) -> Result<Vec<Gateway>, DirectoryError> {
        tessera_rithmic::directory::gateways(url, system, DIRECTORY_TIMEOUT).await
    }
}

#[derive(Debug, Default)]
pub struct LiveRithmic;

pub const NO_RITHMIC_ENV: &str = "TESSERA_NO_RITHMIC";

pub const NO_RITHMIC: &str = "Rithmic logins are off in this Tessera (--no-rithmic): signing in here \
     would end the market data of another session on the same login.";

#[derive(Debug, Default)]
pub struct NoRithmic;

#[async_trait]
impl RithmicFactory for NoRithmic {
    fn open(&self, _login: RithmicLogin) -> Result<Arc<dyn Connector>, ConnectError> {
        Err(ConnectError::Refused(NO_RITHMIC.to_owned()))
    }

    async fn test(&self, _login: RithmicLogin) -> Result<(), ConnectError> {
        Err(ConnectError::Refused(NO_RITHMIC.to_owned()))
    }
}

struct RithmicConnector {
    market: Arc<RithmicMarket>,
    broker: RithmicBroker,
    broker_dyn: Arc<dyn BrokerProvider>,
}

#[async_trait]
impl Connector for RithmicConnector {
    fn id(&self) -> &str {
        MarketDataProvider::id(self.market.as_ref())
    }

    fn market(&self) -> Arc<dyn MarketDataProvider> {
        Arc::clone(&self.market) as _
    }

    fn broker(&self) -> Option<Arc<dyn BrokerProvider>> {
        Some(Arc::clone(&self.broker_dyn))
    }

    async fn connect(&self) -> Result<(), ConnectError> {
        self.market.reconnect().await?;
        let broker = self.broker.clone();
        let id = self.id().to_owned();
        tokio::spawn(async move {
            let phase = broker.phase();
            if phase != ConnectionPhase::Live
                && !phase.coming_back()
                && let Err(e) = broker.reconnect().await
            {
                tracing::warn!(connection = %id, error = %e, "rithmic accounts did not load");
            }
        });
        Ok(())
    }

    async fn shutdown(&self) {
        self.broker.shutdown().await;
        self.market.shutdown().await;
    }

    fn set_account_order_entry(&self, account: &AccountId, enabled: bool) -> Result<(), String> {
        self.broker
            .set_account_order_entry(account, enabled)
            .map_err(|e| e.to_string())
    }
}

#[async_trait]
impl RithmicFactory for LiveRithmic {
    fn open(&self, login: RithmicLogin) -> Result<Arc<dyn Connector>, ConnectError> {
        let opts = RithmicOptions::for_system(&login.system_name);
        let market = RithmicMarket::new(login, opts)?;
        let broker = RithmicBroker::for_market(&market);
        Ok(Arc::new(RithmicConnector {
            broker_dyn: Arc::new(broker.clone()),
            market,
            broker,
        }))
    }

    async fn test(&self, login: RithmicLogin) -> Result<(), ConnectError> {
        let opts = RithmicOptions::for_system(&login.system_name);
        let market = RithmicMarket::connect(login, opts).await?;
        market.shutdown().await;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct StoredLogin {
    system: String,
    gateway: String,
    user: String,
    password: String,
    #[serde(default)]
    gateway_name: Option<String>,
}

impl StoredLogin {
    fn new(login: &RithmicLogin, gateway_name: Option<String>) -> Self {
        Self {
            system: login.system_name.clone(),
            gateway: login.gateway_url.clone(),
            user: login.user.clone(),
            password: login.password.clone(),
            gateway_name,
        }
    }
}

fn guard_login(login: &RithmicLogin) {
    Redactor::global().register(&login.password);
    Redactor::global().register_private(&login.user);
    guard_address(&login.gateway_url);
}

fn guard_address(url: &str) {
    let r = Redactor::global();
    r.register(url);
    if let Some(host) = gateway_host(url) {
        r.register(host);
    }
}

enum Unanswered {
    NoAddress,
    Failed(DirectoryError),
}

impl std::fmt::Display for Unanswered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoAddress => f.write_str("it has no Rithmic address to ask yet"),
            Self::Failed(e) => f.write_str(&Redactor::global().redact(&e.to_string())),
        }
    }
}

#[derive(Default)]
struct Directory {
    seen: Mutex<Vec<String>>,
    systems: Mutex<Option<(Instant, Vec<String>)>>,
    gateways: Mutex<HashMap<String, (Instant, Vec<Gateway>)>>,
}

fn secret_key(id: &str) -> String {
    format!("rithmic.{id}")
}

struct Live {
    connector: Arc<dyn Connector>,
    record: Option<ConnectionProvider>,
    task: Option<JoinHandle<()>>,
}

pub struct Connectors {
    connections: Arc<ConnectionsService>,
    store: Store,
    secrets: Secrets,
    rithmic: Arc<dyn RithmicFactory>,
    clock: SharedClock,
    live: tokio::sync::Mutex<HashMap<String, Live>>,
    logins: tokio::sync::watch::Sender<u64>,
    guard: Option<Arc<Broker>>,
    level_sources: std::sync::OnceLock<Arc<crate::level_sources::LevelSources>>,
    directory: Directory,
}

impl std::fmt::Debug for Connectors {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connectors").finish_non_exhaustive()
    }
}

impl Connectors {
    pub fn new(
        connections: Arc<ConnectionsService>,
        store: Store,
        secrets: Secrets,
        rithmic: Arc<dyn RithmicFactory>,
        clock: SharedClock,
        guard: Option<Arc<Broker>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            connections,
            store,
            secrets,
            rithmic,
            clock,
            live: tokio::sync::Mutex::new(HashMap::new()),
            logins: tokio::sync::watch::channel(0).0,
            guard,
            level_sources: std::sync::OnceLock::new(),
            directory: Directory::default(),
        })
    }

    pub fn set_level_sources(&self, sources: Arc<crate::level_sources::LevelSources>) {
        let _ = self.level_sources.set(sources);
    }

    pub fn logins(&self) -> tokio::sync::watch::Receiver<u64> {
        self.logins.subscribe()
    }

    pub async fn records(&self) -> Vec<ConnectionProvider> {
        let store = self.store.clone();
        let read = tokio::task::spawn_blocking(move || store.settings().get(RECORDS_KEY)).await;
        match read {
            Ok(Ok(Some(v))) => serde_json::from_value(v).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "ignoring unreadable connection records");
                Vec::new()
            }),
            Ok(Ok(None)) => Vec::new(),
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "cannot read connection records");
                Vec::new()
            }
            Err(e) => {
                tracing::warn!(error = %e, "cannot read connection records");
                Vec::new()
            }
        }
    }

    async fn update_records<R: Send + 'static>(
        &self,
        change: impl FnOnce(&mut Vec<ConnectionProvider>) -> R + Send + 'static,
    ) -> Result<R, ToolError> {
        self.update(&RECORDS, change)
            .await
            .map_err(|e| ToolError::internal(format!("cannot save the connection: {e}")))
    }

    async fn update<T, R>(
        &self,
        kept: &'static Kept<T>,
        change: impl FnOnce(&mut T) -> R + Send + 'static,
    ) -> Result<R, String>
    where
        T: Serialize + serde::de::DeserializeOwned + Default + 'static,
        R: Send + 'static,
    {
        let store = self.store.clone();
        let now = self.clock.now();
        tokio::task::spawn_blocking(move || {
            store
                .settings()
                .update(kept, now, |v| Ok::<_, StoreError>(change(v)))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    }

    async fn order_entry_records(&self) -> Vec<OrderEntryRecord> {
        let store = self.store.clone();
        match tokio::task::spawn_blocking(move || store.settings().get(ORDER_ENTRY_KEY)).await {
            Ok(Ok(Some(v))) => serde_json::from_value(v).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "ignoring unreadable order-entry switches");
                Vec::new()
            }),
            Ok(Ok(None)) => Vec::new(),
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "cannot read the order-entry switches");
                Vec::new()
            }
            Err(e) => {
                tracing::warn!(error = %e, "cannot read the order-entry switches");
                Vec::new()
            }
        }
    }

    async fn update_order_entry<R: Send + 'static>(
        &self,
        change: impl FnOnce(&mut Vec<OrderEntryRecord>) -> R + Send + 'static,
    ) -> Result<R, ToolError> {
        self.update(&ORDER_ENTRY, change)
            .await
            .map_err(|e| ToolError::internal(format!("cannot save the switch: {e}")))
    }

    async fn restore_order_entry(&self, connector: &Arc<dyn Connector>) {
        let id = connector.id().to_owned();
        for r in self
            .order_entry_records()
            .await
            .into_iter()
            .filter(|r| r.connection_id == id)
        {
            let account = AccountId::new(&r.account_id);
            match connector.set_account_order_entry(&account, true) {
                Ok(()) => {
                    if let Some(g) = &self.guard {
                        g.set_account_order_entry(&id, &account, true);
                    }
                }
                Err(why) => {
                    tracing::warn!(connection = %id, %why, "an order-entry switch was not restored");
                }
            }
        }
    }

    pub async fn set_order_entry(
        &self,
        input: &OrderEntryInput,
    ) -> Result<OrderEntryOutput, ToolError> {
        let id = input.connection_id.trim();
        let account = AccountId::new(input.account_id.trim());
        let connector = self
            .live
            .lock()
            .await
            .get(id)
            .map(|l| Arc::clone(&l.connector));
        if input.enabled {
            let connector = connector
                .as_ref()
                .ok_or_else(|| ToolError::not_found(format!("no connection {id}")))?;
            let broker = connector
                .broker()
                .ok_or_else(|| ToolError::rejected("This connection has no accounts."))?;
            let system = broker.system().name;
            if broker.account_order_entry().is_none() {
                return Err(ToolError::rejected(format!(
                    "{system} has no per-account switch: its accounts take orders once order \
                     routing is on for the connection."
                )));
            }
            let accounts = broker
                .accounts()
                .await
                .map_err(|e| ToolError::unavailable(e.to_string()))?;
            if !accounts.iter().any(|a| a.id == account) {
                return Err(ToolError::not_found(format!(
                    "no account {account} on {id}"
                )));
            }
        }
        if let Some(c) = &connector {
            c.set_account_order_entry(&account, input.enabled)
                .map_err(ToolError::rejected)?;
        }
        if let Some(g) = &self.guard {
            g.set_account_order_entry(id, &account, input.enabled);
        }
        let switch = OrderEntryRecord {
            connection_id: id.to_owned(),
            account_id: account.to_string(),
        };
        let enabled = input.enabled;
        let saved = self
            .update_order_entry(move |records| {
                records.retain(|r| r != &switch);
                if enabled {
                    records.push(switch);
                }
            })
            .await;
        if let Err(e) = saved {
            if input.enabled {
                if let Some(c) = &connector {
                    let _ = c.set_account_order_entry(&account, false);
                }
                if let Some(g) = &self.guard {
                    g.set_account_order_entry(id, &account, false);
                }
            }
            return Err(e);
        }
        tracing::info!(
            connection = id,
            enabled = input.enabled,
            "account order entry switched"
        );
        Ok(OrderEntryOutput {
            connection_id: id.to_owned(),
            account_id: account.to_string(),
            enabled: input.enabled,
        })
    }

    fn register(&self, connector: &Arc<dyn Connector>) -> Result<(), ToolError> {
        let id = connector.id().to_owned();
        self.connections
            .add_market(connector.market())
            .map_err(|e| ToolError::conflict(e.to_string()))?;
        if let Some(b) = connector.broker()
            && let Err(e) = self.connections.add_broker(b)
        {
            self.connections.remove_market(&id);
            return Err(ToolError::conflict(e.to_string()));
        }
        self.connections.clear_unavailable(&id);
        Ok(())
    }

    fn unregister(&self, id: &str) {
        self.connections.remove_broker(id);
        self.connections.remove_market(id);
        self.connections.clear_unavailable(id);
    }

    fn spawn_login(&self, connector: Arc<dyn Connector>) -> JoinHandle<()> {
        let logins = self.logins.clone();
        tokio::spawn(async move {
            let id = connector.id().to_owned();
            let mut attempt = 0u32;
            loop {
                match connector.connect().await {
                    Ok(()) => {
                        tracing::info!(connection = %id, "connection logged in");
                        logins.send_modify(|n| *n += 1);
                        return;
                    }
                    Err(ConnectError::Refused(why)) => {
                        tracing::warn!(connection = %id, %why, "login refused; not retrying");
                        return;
                    }
                    Err(ConnectError::Unreachable(why)) => {
                        attempt += 1;
                        let wait = tessera_rithmic::session::RECONNECT.delay(attempt);
                        tracing::warn!(
                            connection = %id,
                            %why,
                            attempt,
                            retry_in_ms = wait.as_millis() as u64,
                            "cannot reach the gateway; trying again"
                        );
                        tokio::time::sleep(wait).await;
                    }
                }
            }
        })
    }

    fn note_login(&self, login: &RithmicLogin) {
        guard_login(login);
        let mut seen = self.directory.seen.lock();
        if !seen.contains(&login.gateway_url) {
            seen.push(login.gateway_url.clone());
        }
    }

    fn directory_addresses(&self) -> Vec<String> {
        let seen = self.directory.seen.lock().clone();
        let mut out: Vec<String> = Vec::new();
        for url in self.rithmic.directory().into_iter().chain(seen) {
            if !out.contains(&url) {
                guard_address(&url);
                out.push(url);
            }
        }
        out
    }

    async fn ask_directory<T, F, Fut>(&self, ask: F) -> Result<T, Unanswered>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<T, DirectoryError>>,
    {
        let mut why = Unanswered::NoAddress;
        for url in self.directory_addresses() {
            match ask(url).await {
                Ok(answer) => return Ok(answer),
                Err(e @ DirectoryError::Refused(_)) => return Err(Unanswered::Failed(e)),
                Err(e) => {
                    why = Unanswered::Failed(e);
                    tracing::debug!(why = %why, "a rithmic directory address did not answer");
                }
            }
        }
        Err(why)
    }

    async fn rithmic_systems(&self) -> Result<Vec<String>, Unanswered> {
        let kept = self
            .directory
            .systems
            .lock()
            .as_ref()
            .filter(|(at, _)| at.elapsed() < DIRECTORY_TTL)
            .map(|(_, systems)| systems.clone());
        if let Some(systems) = kept {
            return Ok(systems);
        }
        let systems = self
            .ask_directory(|url| async move { self.rithmic.systems(&url).await })
            .await?;
        *self.directory.systems.lock() = Some((Instant::now(), systems.clone()));
        Ok(systems)
    }

    async fn rithmic_gateways(&self, system: &str) -> Result<Vec<Gateway>, Unanswered> {
        let kept = self
            .directory
            .gateways
            .lock()
            .get(system)
            .filter(|(at, _)| at.elapsed() < DIRECTORY_TTL)
            .map(|(_, gateways)| gateways.clone());
        if let Some(gateways) = kept {
            return Ok(gateways);
        }
        let gateways = self
            .ask_directory(|url| async move { self.rithmic.gateways(&url, system).await })
            .await?;
        self.directory
            .gateways
            .lock()
            .insert(system.to_owned(), (Instant::now(), gateways.clone()));
        Ok(gateways)
    }

    pub async fn rithmic_directory(&self, input: &RithmicDirectoryInput) -> RithmicDirectoryOutput {
        let systems = match self.rithmic_systems().await {
            Ok(systems) => systems,
            Err(why) => {
                return RithmicDirectoryOutput {
                    systems: Vec::new(),
                    gateways: Vec::new(),
                    problem: Some(match why {
                        Unanswered::NoAddress => NO_DIRECTORY.to_owned(),
                        Unanswered::Failed(_) => format!(
                            "Tessera cannot ask Rithmic for its systems ({why}). Type the system \
                             and the gateway's address instead."
                        ),
                    }),
                };
            }
        };
        let system = input.system.as_deref().map(str::trim);
        let Some(system) = system.filter(|s| !s.is_empty()) else {
            return RithmicDirectoryOutput {
                systems,
                gateways: Vec::new(),
                problem: None,
            };
        };
        let (gateways, problem) = match self.rithmic_gateways(system).await {
            Ok(gateways) if gateways.is_empty() => (
                Vec::new(),
                Some(format!(
                    "Rithmic lists no gateways for {system}. Type the gateway's address instead."
                )),
            ),
            Ok(gateways) => (gateways.into_iter().map(|g| g.name).collect(), None),
            Err(why) => (
                Vec::new(),
                Some(format!(
                    "Tessera cannot ask Rithmic for {system}'s gateways ({why}). Type the \
                     gateway's address instead."
                )),
            ),
        };
        RithmicDirectoryOutput {
            systems,
            gateways,
            problem,
        }
    }

    async fn login(
        &self,
        input: &RithmicLoginInput,
    ) -> Result<(RithmicLogin, Option<String>), ToolError> {
        let mut login = input.typed()?;
        let mut name = None;
        if !login.gateway_url.contains("://") {
            let gateway = self
                .gateway_named(&login.system_name, &login.gateway_url)
                .await?;
            login.gateway_url = gateway.uri;
            name = Some(gateway.name);
        }
        if !gateway_is_safe(&login.gateway_url) {
            return Err(ToolError::invalid_input(
                "gateway must be a wss:// URL (the firm's Rithmic gateway)",
            ));
        }
        self.note_login(&login);
        Ok((login, name))
    }

    async fn gateway_named(&self, system: &str, name: &str) -> Result<Gateway, ToolError> {
        let gateways = self.rithmic_gateways(system).await.map_err(|why| {
            ToolError::unavailable(format!(
                "Tessera cannot ask Rithmic for {system}'s gateways ({why}). Type the gateway's \
                 address instead."
            ))
        })?;
        gateways
            .into_iter()
            .find(|g| g.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                ToolError::invalid_input(format!("Rithmic lists no gateway “{name}” for {system}."))
            })
    }

    pub async fn set_enabled(
        &self,
        input: &ConnectionEnabledInput,
    ) -> Result<ConnectionEnabledOutput, ToolError> {
        let id = input.id.trim();
        let mut live = self.live.lock().await;
        let (key, enabled) = (id.to_owned(), input.enabled);
        let switched = self
            .update_records(move |records| {
                let r = records
                    .iter_mut()
                    .find(|r| r.id.as_str() == key && r.kind == ConnectionKind::Rithmic)?;
                r.enabled = enabled;
                Some(r.clone())
            })
            .await?;
        let Some(record) = switched else {
            return Err(ToolError::not_found(format!("no saved login for {id}")));
        };
        let name = record.display_name.clone();
        self.connections.set_saved(id, input.enabled);
        if input.enabled {
            if !live.contains_key(id) {
                self.start_saved_in(&mut live, record).await;
            }
        } else {
            if let Some(entry) = live.remove(id) {
                if let Some(t) = &entry.task {
                    t.abort();
                }
                if tokio::time::timeout(Duration::from_secs(6), entry.connector.shutdown())
                    .await
                    .is_err()
                {
                    tracing::warn!(connection = %id, "logout did not finish in time");
                }
            }
            self.unregister(id);
            if let Some(g) = &self.guard {
                for r in self
                    .order_entry_records()
                    .await
                    .iter()
                    .filter(|r| r.connection_id == id)
                {
                    g.set_account_order_entry(id, &AccountId::new(&r.account_id), false);
                }
            }
            self.connections.set_off(id, &name, self.clock.now());
        }
        drop(live);
        tracing::info!(
            connection = id,
            enabled = input.enabled,
            "connection switched"
        );
        let connection = self
            .connections
            .info(id)
            .ok_or_else(|| ToolError::internal("the connection vanished after it was switched"))?;
        Ok(ConnectionEnabledOutput { connection })
    }

    pub async fn list_saved(&self) -> Vec<ConnectionProvider> {
        let records: Vec<ConnectionProvider> = self
            .records()
            .await
            .into_iter()
            .filter(|r| r.kind == ConnectionKind::Rithmic)
            .collect();
        let now = self.clock.now();
        for record in &records {
            if let Some(r) = &record.credential {
                self.secrets.note(r);
            }
            let id = record.id.as_str();
            self.connections.set_saved(id, record.enabled);
            if record.enabled {
                self.connections
                    .set_reading(id, &record.display_name, READING.into(), now);
            } else {
                self.connections.set_off(id, &record.display_name, now);
            }
        }
        records.into_iter().filter(|r| r.enabled).collect()
    }

    pub fn log_in_saved(self: &Arc<Self>, saved: Vec<ConnectionProvider>) -> JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            futures::future::join_all(saved.into_iter().map(|r| me.log_in_one(r))).await;
        })
    }

    async fn log_in_one(&self, record: ConnectionProvider) {
        let id = record.id.to_string();
        let name = record.display_name.clone();
        let waiting = || {
            if self.connections.market().get(&id).is_none() {
                self.connections
                    .set_reading(&id, &name, WAITING.into(), self.clock.now());
            }
        };
        let login = self.read_login_patiently(&record, waiting).await;
        let mut live = self.live.lock().await;
        let still_on = self
            .records()
            .await
            .iter()
            .any(|r| r.id == record.id && r.enabled);
        if still_on && !live.contains_key(&id) {
            self.start_login_in(&mut live, record, login).await;
        }
    }

    async fn start_saved_in(&self, live: &mut HashMap<String, Live>, record: ConnectionProvider) {
        let login = self.read_login(&record).await;
        self.start_login_in(live, record, login).await;
    }

    async fn start_login_in(
        &self,
        live: &mut HashMap<String, Live>,
        record: ConnectionProvider,
        login: Result<RithmicLogin, (CredentialState, String)>,
    ) {
        let id = record.id.to_string();
        let name = record.display_name.clone();
        let started = match login {
            Ok(login) => self
                .start_in(live, login, Some(record))
                .await
                .map(|_| ())
                .map_err(|e| (None, e.message)),
            Err((state, why)) => Err((Some(state), why)),
        };
        if let Err((state, why)) = started {
            tracing::warn!(connection = %id, %why, "saved connection not started");
            self.connections
                .set_unavailable(&id, &name, why, state, self.clock.now());
        }
    }

    pub fn add_dev_file(self: &Arc<Self>, path: PathBuf) -> JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let login = match RithmicLogin::from_file(&path) {
                Ok(login) => login,
                Err(e) => {
                    tracing::warn!(file = %path.display(), error = %e, "rithmic credentials file not used");
                    return;
                }
            };
            me.note_login(&login);
            if !tessera_core::private::is_private(&path) {
                tracing::warn!(file = %path.display(), "the credentials file is readable by others; {MAKE_IT_PRIVATE}");
            }
            match me.start(login, None).await {
                Ok(id) => {
                    tracing::info!(connection = %id, "rithmic connection added from the credentials file")
                }
                Err(e) => tracing::warn!(error = %e.message, "rithmic credentials file not used"),
            }
        })
    }

    async fn read_login(
        &self,
        record: &ConnectionProvider,
    ) -> Result<RithmicLogin, (CredentialState, String)> {
        self.read_login_state(record).await.map(|(login, _)| login)
    }

    async fn read_login_patiently(
        &self,
        record: &ConnectionProvider,
        waiting: impl FnOnce(),
    ) -> Result<RithmicLogin, (CredentialState, String)> {
        let r = saved_ref(record)?;
        let read = self.secrets.get_patiently(r, waiting).await;
        self.login_from(credential_from_read(read, r, "login", "Log in again."))
            .map(|(login, _)| login)
    }

    async fn read_login_state(
        &self,
        record: &ConnectionProvider,
    ) -> Result<(RithmicLogin, Option<String>), (CredentialState, String)> {
        let r = saved_ref(record)?;
        self.login_from(read_credential(&self.secrets, r, "login", "Log in again.").await)
    }

    fn login_from(
        &self,
        raw: Result<String, (CredentialState, String)>,
    ) -> Result<(RithmicLogin, Option<String>), (CredentialState, String)> {
        let s: StoredLogin = serde_json::from_str(&raw?).map_err(|_| {
            (
                CredentialState::Missing,
                "The saved login is unreadable. Log in again.".to_owned(),
            )
        })?;
        let login = RithmicLogin {
            user: s.user,
            password: s.password,
            system_name: s.system,
            gateway_url: s.gateway,
        };
        self.note_login(&login);
        Ok((login, s.gateway_name))
    }

    async fn start(
        &self,
        login: RithmicLogin,
        record: Option<ConnectionProvider>,
    ) -> Result<String, ToolError> {
        let mut live = self.live.lock().await;
        self.start_in(&mut live, login, record).await
    }

    async fn start_in(
        &self,
        live: &mut HashMap<String, Live>,
        login: RithmicLogin,
        record: Option<ConnectionProvider>,
    ) -> Result<String, ToolError> {
        let connector = self
            .rithmic
            .open(login)
            .map_err(|e| ToolError::unavailable(e.to_string()))?;
        let id = connector.id().to_owned();
        if live.contains_key(&id) {
            return Err(ToolError::conflict(format!("{id} is already connected")));
        }
        self.register(&connector)?;
        if let Some(r) = &record {
            self.connections.set_saved(&id, r.enabled);
        }
        self.restore_order_entry(&connector).await;
        let task = Some(self.spawn_login(Arc::clone(&connector)));
        live.insert(
            id.clone(),
            Live {
                connector,
                record,
                task,
            },
        );
        Ok(id)
    }

    pub async fn add_rithmic(
        &self,
        input: &RithmicLoginInput,
    ) -> Result<ConnectionsAddOutput, ToolError> {
        let (login, gateway_name) = self.login(input).await?;
        let connector = self
            .rithmic
            .open(login.clone())
            .map_err(|e| ToolError::unavailable(login.redact(&e.to_string())))?;
        let id = connector.id().to_owned();
        let mut live = self.live.lock().await;
        if live.contains_key(&id) || self.connections.market().get(&id).is_some() {
            return Err(ToolError::conflict(format!(
                "{} is already connected. Remove it first to change its login.",
                connector.market().display_name()
            )));
        }
        if let Some(off) = self
            .records()
            .await
            .into_iter()
            .find(|r| r.id.as_str() == id && r.kind == ConnectionKind::Rithmic && !r.enabled)
        {
            return Err(ToolError::conflict(format!(
                "{} is saved and off: turn it on, or change its login.",
                off.display_name
            )));
        }
        if let Err(e) = connector.connect().await {
            connector.shutdown().await;
            let message = login.redact(&e.to_string());
            return Err(match e {
                ConnectError::Refused(_) => ToolError::rejected(message),
                ConnectError::Unreachable(_) => ToolError::unavailable(message),
            });
        }
        let secret = serde_json::to_string(&StoredLogin::new(&login, gateway_name))
            .map_err(|e| ToolError::internal(e.to_string()))?;
        let credential = match self.secrets.put(&secret_key(&id), &secret).await {
            Ok(r) => r,
            Err(e) => {
                connector.shutdown().await;
                return Err(ToolError::unavailable(format!(
                    "The login worked but cannot be kept: {e}"
                )));
            }
        };
        let stored_in = credential.store;
        let record = ConnectionProvider {
            id: ConnectionId::new(&id),
            kind: ConnectionKind::Rithmic,
            display_name: connector.market().display_name().to_owned(),
            system_name: Some(login.system_name.clone()),
            credential: Some(credential),
            enabled: true,
        };
        let kept = record.clone();
        let saved = self
            .update_records(move |records| {
                records.retain(|r| r.id != kept.id);
                records.push(kept);
            })
            .await;
        if let Err(e) = saved {
            connector.shutdown().await;
            if let Some(r) = &record.credential
                && let Err(e) = self.secrets.delete_everywhere(r).await
            {
                tracing::warn!(connection = %id, error = %e, "the login of a connection that was not saved could not be deleted");
            }
            return Err(e);
        }
        if let Err(e) = self.register(&connector) {
            connector.shutdown().await;
            return Err(e);
        }
        self.connections.set_saved(&id, true);
        self.restore_order_entry(&connector).await;
        live.insert(
            id.clone(),
            Live {
                connector,
                record: Some(record),
                task: None,
            },
        );
        drop(live);
        self.logins.send_modify(|n| *n += 1);
        tracing::info!(connection = %id, stored_in = store_name(stored_in), "rithmic connection added");
        let connection = self
            .connections
            .info(&id)
            .ok_or_else(|| ToolError::internal("the connection vanished after it was added"))?;
        Ok(ConnectionsAddOutput {
            connection,
            stored_in,
        })
    }

    /// Rithmic answers a second session of the same login with a ForcedLogout.
    pub async fn test_rithmic(
        &self,
        input: &RithmicLoginInput,
    ) -> Result<ConnectionsTestOutput, ToolError> {
        let (login, _) = self.login(input).await?;
        let id = RithmicOptions::for_system(&login.system_name).provider_id;
        if self.live.lock().await.contains_key(&id) {
            return Ok(ConnectionsTestOutput {
                ok: false,
                message: format!(
                    "{} is already connected; reconnect it instead of testing a second session.",
                    login.system_name
                ),
            });
        }
        let system = login.system_name.clone();
        Ok(match self.rithmic.test(login.clone()).await {
            Ok(()) => ConnectionsTestOutput {
                ok: true,
                message: format!("Logged in to {system}."),
            },
            Err(e) => ConnectionsTestOutput {
                ok: false,
                message: login.redact(&e.to_string()),
            },
        })
    }

    pub async fn remove(&self, id: &str) -> Result<ConnectionsRemoveOutput, ToolError> {
        if let Some(ls) = self.level_sources.get()
            && ls.owns(id).await
        {
            return ls.remove(id).await;
        }
        let (entry, record) = {
            let mut live = self.live.lock().await;
            let key = id.to_owned();
            let record = self
                .update_records(move |records| {
                    let at = records.iter().position(|r| r.id.as_str() == key)?;
                    Some(records.remove(at))
                })
                .await?;
            (live.remove(id), record)
        };
        if entry.is_none() && record.is_none() {
            return Ok(ConnectionsRemoveOutput { removed: false });
        }
        self.unregister(id);
        self.connections.forget_saved(id);
        if let Some(e) = &entry {
            if let Some(t) = &e.task {
                t.abort();
            }
            e.connector.shutdown().await;
        }
        let record = record.or_else(|| entry.and_then(|e| e.record));
        if let Some(r) = record.as_ref().and_then(|r| r.credential.as_ref())
            && let Err(e) = self.secrets.delete_everywhere(r).await
        {
            tracing::warn!(connection = id, error = %e, "the saved login could not be deleted");
        }
        let key = id.to_owned();
        let switched_off = self
            .update_order_entry(move |switches| {
                let (off, kept) = std::mem::take(switches)
                    .into_iter()
                    .partition(|r| r.connection_id == key);
                *switches = kept;
                off
            })
            .await?;
        if let Some(g) = &self.guard {
            for r in &switched_off {
                g.set_account_order_entry(id, &AccountId::new(&r.account_id), false);
            }
        }
        tracing::info!(connection = id, "connection removed");
        Ok(ConnectionsRemoveOutput { removed: true })
    }

    pub async fn reconnect(&self, id: &str) -> Result<ConnectionsReconnectOutput, ToolError> {
        let connector = {
            let mut live = self.live.lock().await;
            match live.get(id) {
                Some(e) => {
                    if let Some(t) = &e.task {
                        t.abort();
                    }
                    Some(Arc::clone(&e.connector))
                }
                None => {
                    let record = self
                        .records()
                        .await
                        .into_iter()
                        .find(|r| r.id.as_str() == id && r.kind == ConnectionKind::Rithmic);
                    match record {
                        Some(r) if r.enabled => self.start_saved_in(&mut live, r).await,
                        Some(_) => return Err(ToolError::conflict("It is off: turn it on.")),
                        None => return Err(ToolError::not_found(format!("no connection {id}"))),
                    }
                    None
                }
            }
        };
        if let Some(connector) = connector {
            match connector.connect().await {
                Ok(()) => self.logins.send_modify(|n| *n += 1),
                Err(ConnectError::Unreachable(why)) => {
                    tracing::warn!(connection = id, %why, "reconnect failed; trying again");
                    if let Some(e) = self.live.lock().await.get_mut(id)
                        && Arc::ptr_eq(&e.connector, &connector)
                    {
                        e.task = Some(self.spawn_login(connector));
                    }
                }
                Err(e) => tracing::warn!(connection = id, error = %e, "reconnect failed"),
            }
        }
        let connection = self
            .connections
            .info(id)
            .ok_or_else(|| ToolError::not_found(format!("no connection {id}")))?;
        Ok(ConnectionsReconnectOutput { connection })
    }

    pub async fn list_credentials(&self) -> CredentialsListOutput {
        let mut credentials = Vec::new();
        for record in self.records().await {
            let Some(r) = record.credential.clone() else {
                continue;
            };
            if record.kind != ConnectionKind::Rithmic {
                continue;
            }
            let (state, message, user, gateway) = match self.read_login_state(&record).await {
                Ok((login, gateway)) => (CredentialState::Stored, None, Some(login.user), gateway),
                Err((state, why)) => (state, Some(why), None, None),
            };
            credentials.push(CredentialInfo {
                connection_id: record.id.to_string(),
                kind: CredentialKind::Rithmic,
                name: record.display_name.clone(),
                system: record.system_name.clone(),
                user,
                gateway,
                store: r.store,
                location: self.secrets.location(&r),
                state,
                message,
            });
        }
        if let Some(ls) = self.level_sources.get() {
            credentials.extend(ls.credentials().await);
        }
        CredentialsListOutput { credentials }
    }

    /// Rithmic answers a second session of the same login with a ForcedLogout.
    pub async fn test_credential(&self, id: &str) -> Result<ConnectionsTestOutput, ToolError> {
        let id = id.trim();
        if let Some(ls) = self.level_sources.get()
            && let Some(out) = ls.test_saved(id).await
        {
            return Ok(out);
        }
        let record = self.records().await.into_iter().find(|r| {
            r.id.as_str() == id && r.kind == ConnectionKind::Rithmic && r.credential.is_some()
        });
        let Some(record) = record else {
            return Err(ToolError::not_found(format!(
                "no saved login or key for {id}"
            )));
        };
        let system = record
            .system_name
            .clone()
            .unwrap_or_else(|| record.display_name.clone());
        let connector = self
            .live
            .lock()
            .await
            .get(id)
            .map(|l| Arc::clone(&l.connector));
        if let Some(c) = &connector {
            match c.market().health().status {
                HealthStatus::Ok => {
                    return Ok(ConnectionsTestOutput {
                        ok: true,
                        message: format!("{system} is connected with this login."),
                    });
                }
                HealthStatus::Unknown => {
                    return Ok(ConnectionsTestOutput {
                        ok: false,
                        message: format!(
                            "{system} is logging in with this login now; test it again in a moment."
                        ),
                    });
                }
                _ => {}
            }
        }
        let login = match self.read_login(&record).await {
            Ok(login) => login,
            Err((_, why)) => {
                return Ok(ConnectionsTestOutput {
                    ok: false,
                    message: why,
                });
            }
        };
        Ok(match self.rithmic.test(login.clone()).await {
            Ok(()) => ConnectionsTestOutput {
                ok: true,
                message: format!("Logged in to {system}."),
            },
            Err(e) => ConnectionsTestOutput {
                ok: false,
                message: login.redact(&e.to_string()),
            },
        })
    }

    /// Rithmic answers a second session of the same login with a ForcedLogout.
    pub async fn replace_rithmic(
        &self,
        input: &RithmicLoginInput,
    ) -> Result<ConnectionsAddOutput, ToolError> {
        let (login, gateway_name) = self.login(input).await?;
        let connector = self
            .rithmic
            .open(login.clone())
            .map_err(|e| ToolError::unavailable(login.redact(&e.to_string())))?;
        let id = connector.id().to_owned();
        let mut live = self.live.lock().await;
        let records = self.records().await;
        let Some(at) = records.iter().position(|r| {
            r.id.as_str() == id && r.kind == ConnectionKind::Rithmic && r.credential.is_some()
        }) else {
            return Err(ToolError::not_found(format!(
                "No {} connection is saved: add it instead.",
                login.system_name
            )));
        };
        let old = records[at].clone();
        let Some(old_ref) = old.credential.clone() else {
            return Err(ToolError::internal("a saved connection without its login"));
        };
        let old_secret = self.secrets.get(&old_ref).await.ok().flatten();
        let stored = StoredLogin::new(&login, gateway_name);
        let mut record = ConnectionProvider {
            id: ConnectionId::new(&id),
            kind: ConnectionKind::Rithmic,
            display_name: connector.market().display_name().to_owned(),
            system_name: Some(login.system_name.clone()),
            credential: None,
            enabled: old.enabled,
        };
        if !old.enabled {
            connector.shutdown().await;
            if let Err(e) = self.rithmic.test(login.clone()).await {
                let message = format!("{} Nothing changed.", login.redact(&e.to_string()));
                return Err(match e {
                    ConnectError::Refused(_) => ToolError::rejected(message),
                    ConnectError::Unreachable(_) => ToolError::unavailable(message),
                });
            }
            let stored_in = self
                .keep_replacement(&stored, &mut record, records, at, old_secret.as_deref())
                .await?;
            self.connections
                .set_off(&id, &record.display_name, self.clock.now());
            drop(live);
            tracing::info!(connection = %id, stored_in = store_name(stored_in), "rithmic login replaced");
            let connection = self.connections.info(&id).ok_or_else(|| {
                ToolError::internal("the connection vanished after its login changed")
            })?;
            return Ok(ConnectionsAddOutput {
                connection,
                stored_in,
            });
        }
        let previous = live.remove(&id);
        if let Some(p) = &previous {
            if let Some(t) = &p.task {
                t.abort();
            }
            if tokio::time::timeout(std::time::Duration::from_secs(6), p.connector.shutdown())
                .await
                .is_err()
            {
                tracing::warn!(connection = %id, "logout did not finish in time");
            }
            self.unregister(&id);
        }
        let restart = previous.is_some();
        if let Err(e) = connector.connect().await {
            connector.shutdown().await;
            self.restart_saved(&mut live, &old, restart).await;
            let message = format!("{} Nothing changed.", login.redact(&e.to_string()));
            return Err(match e {
                ConnectError::Refused(_) => ToolError::rejected(message),
                ConnectError::Unreachable(_) => ToolError::unavailable(message),
            });
        }
        if let Err(e) = self.register(&connector) {
            connector.shutdown().await;
            self.restart_saved(&mut live, &old, restart).await;
            return Err(ToolError::conflict(format!(
                "{} Nothing changed.",
                e.message
            )));
        }
        let stored_in = match self
            .keep_replacement(&stored, &mut record, records, at, old_secret.as_deref())
            .await
        {
            Ok(stored_in) => stored_in,
            Err(e) => {
                self.unregister(&id);
                connector.shutdown().await;
                self.restart_saved(&mut live, &old, restart).await;
                return Err(e);
            }
        };
        self.restore_order_entry(&connector).await;
        live.insert(
            id.clone(),
            Live {
                connector,
                record: Some(record),
                task: None,
            },
        );
        drop(live);
        self.logins.send_modify(|n| *n += 1);
        tracing::info!(connection = %id, stored_in = store_name(stored_in), "rithmic login replaced");
        let connection = self.connections.info(&id).ok_or_else(|| {
            ToolError::internal("the connection vanished after its login changed")
        })?;
        Ok(ConnectionsAddOutput {
            connection,
            stored_in,
        })
    }

    async fn keep_replacement(
        &self,
        stored: &StoredLogin,
        record: &mut ConnectionProvider,
        records: Vec<ConnectionProvider>,
        at: usize,
        old_secret: Option<&str>,
    ) -> Result<CredentialStore, ToolError> {
        let id = record.id.to_string();
        let Some(old_ref) = records[at].credential.clone() else {
            return Err(ToolError::internal("a saved connection without its login"));
        };
        let secret =
            serde_json::to_string(stored).map_err(|e| ToolError::internal(e.to_string()))?;
        let credential = self
            .secrets
            .put(&secret_key(&id), &secret)
            .await
            .map_err(|e| {
                ToolError::unavailable(format!(
                    "The new login worked but cannot be kept: {e}. Nothing changed."
                ))
            })?;
        record.credential = Some(credential.clone());
        let kept = record.clone();
        let saved = self
            .update_records(move |records| {
                if let Some(r) = records.iter_mut().find(|r| r.id == kept.id) {
                    *r = kept;
                }
            })
            .await;
        if let Err(e) = saved {
            if credential != old_ref {
                let _ = self.secrets.delete_in_own_store(&credential).await;
            }
            if let Some(v) = old_secret
                && let Err(e) = self.secrets.put(&old_ref.key, v).await
            {
                tracing::warn!(connection = %id, error = %e, "the previous login could not be put back");
            }
            return Err(ToolError::internal(format!(
                "{} Nothing changed.",
                e.message
            )));
        }
        if credential.store != old_ref.store
            && let Err(e) = self.secrets.delete_in_own_store(&old_ref).await
        {
            tracing::warn!(connection = %id, error = %e, "the replaced login could not be deleted");
        }
        Ok(credential.store)
    }

    async fn restart_saved(
        &self,
        live: &mut HashMap<String, Live>,
        record: &ConnectionProvider,
        restart: bool,
    ) {
        if !restart {
            return;
        }
        let id = record.id.to_string();
        let started = match self.read_login(record).await {
            Ok(login) => self
                .rithmic
                .open(login)
                .map_err(|e| (None, e.to_string()))
                .and_then(|c| self.register(&c).map(|()| c).map_err(|e| (None, e.message))),
            Err((state, why)) => Err((Some(state), why)),
        };
        match started {
            Ok(connector) => {
                self.restore_order_entry(&connector).await;
                let task = Some(self.spawn_login(Arc::clone(&connector)));
                live.insert(
                    id,
                    Live {
                        connector,
                        record: Some(record.clone()),
                        task,
                    },
                );
            }
            Err((state, why)) => {
                tracing::warn!(connection = %id, %why, "the previous login was not started again");
                self.connections.set_unavailable(
                    &id,
                    &record.display_name,
                    why,
                    state,
                    self.clock.now(),
                );
            }
        }
    }

    pub async fn shutdown(&self) {
        let all: Vec<Live> = self.live.lock().await.drain().map(|(_, l)| l).collect();
        for l in all {
            if let Some(t) = &l.task {
                t.abort();
            }
            let id = l.connector.id().to_owned();
            if tokio::time::timeout(std::time::Duration::from_secs(6), l.connector.shutdown())
                .await
                .is_err()
            {
                tracing::warn!(connection = %id, "logout did not finish in time");
            }
        }
    }

    pub fn register_tools(self: &Arc<Self>, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(AddRithmic(Arc::clone(self)))?;
        r.register(TestRithmic(Arc::clone(self)))?;
        r.register(Remove(Arc::clone(self)))?;
        r.register(Reconnect(Arc::clone(self)))?;
        r.register(SetOrderEntry(Arc::clone(self)))?;
        r.register(ListCredentials(Arc::clone(self)))?;
        r.register(TestCredential(Arc::clone(self)))?;
        r.register(ReplaceRithmic(Arc::clone(self)))?;
        r.register(SetEnabled(Arc::clone(self)))?;
        r.register(RithmicDirectory(Arc::clone(self)))?;
        Ok(())
    }
}

const LOGIN_RATE: RateLimit = RateLimit {
    per_second: 1.0 / 10.0,
    burst: 4,
};

const DIRECTORY_RATE: RateLimit = RateLimit {
    per_second: 1.0 / 2.0,
    burst: 10,
};

const LOGIN_FIELDS: [&str; 4] = ["system", "gateway", "user", "password"];

struct AddRithmic(Arc<Connectors>);

#[async_trait]
impl Tool for AddRithmic {
    type Input = RithmicLoginInput;
    type Output = ConnectionsAddOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("connections.add_rithmic", "Add a Rithmic connection", RiskTier::Modify)
            .description("Logs in to Rithmic with the user's own login (system, gateway by name as connections.rithmic_directory lists it or by wss:// address, user, password) and, once it is accepted, adds it: prices, charts and the login's accounts appear without a restart (orders only to an evaluation account the user turns order entry on for). The login is kept in the OS keyring (in development, else the development file), never in the database or logs. A refused login is not stored.")
            .user_only()
            .quiet()
            .redact(&LOGIN_FIELDS)
            .rate_limit(LOGIN_RATE)
            .timeout_ms(60_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: RithmicLoginInput,
    ) -> Result<ConnectionsAddOutput, ToolError> {
        self.0.add_rithmic(&input).await
    }

    async fn preview(
        &self,
        _ctx: &ToolCtx,
        input: &RithmicLoginInput,
    ) -> Result<serde_json::Value, ToolError> {
        Ok(serde_json::json!({ "system": input.system }))
    }

    fn summarize(&self, out: &ConnectionsAddOutput) -> Option<String> {
        Some(format!("Added {}", out.connection.display_name))
    }
}

struct TestRithmic(Arc<Connectors>);

#[async_trait]
impl Tool for TestRithmic {
    type Input = RithmicLoginInput;
    type Output = ConnectionsTestOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("connections.test_rithmic", "Test a Rithmic login", RiskTier::Read)
            .description("Logs in to Rithmic with the given login and straight out again, and says whether it was accepted. Nothing is stored.")
            .user_only()
            .quiet()
            .redact(&LOGIN_FIELDS)
            .rate_limit(LOGIN_RATE)
            .timeout_ms(45_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: RithmicLoginInput,
    ) -> Result<ConnectionsTestOutput, ToolError> {
        self.0.test_rithmic(&input).await
    }

    async fn preview(
        &self,
        _ctx: &ToolCtx,
        input: &RithmicLoginInput,
    ) -> Result<serde_json::Value, ToolError> {
        Ok(serde_json::json!({ "system": input.system }))
    }
}

struct Remove(Arc<Connectors>);

#[async_trait]
impl Tool for Remove {
    type Input = ConnectionIdInput;
    type Output = ConnectionsRemoveOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("connections.remove", "Remove a connection", RiskTier::Modify)
            .description("Logs a connection out, takes its prices and accounts off the desk and deletes its saved login; for a source of levels (a source from a spec), takes its levels off the charts and deletes its key.")
            .user_only()
            .timeout_ms(20_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ConnectionIdInput,
    ) -> Result<ConnectionsRemoveOutput, ToolError> {
        self.0.remove(&input.id).await
    }
}

struct Reconnect(Arc<Connectors>);

#[async_trait]
impl Tool for Reconnect {
    type Input = ConnectionIdInput;
    type Output = ConnectionsReconnectOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("connections.reconnect", "Reconnect", RiskTier::Modify)
            .description("Logs a connection in again: after the vendor ended the session (ForcedLogout), refused the login or could not be reached.")
            .user_only()
            .rate_limit(LOGIN_RATE)
            .timeout_ms(45_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ConnectionIdInput,
    ) -> Result<ConnectionsReconnectOutput, ToolError> {
        self.0.reconnect(&input.id).await
    }

    fn summarize(&self, out: &ConnectionsReconnectOutput) -> Option<String> {
        out.connection.health.message.clone()
    }
}

struct SetOrderEntry(Arc<Connectors>);

#[async_trait]
impl Tool for SetOrderEntry {
    type Input = OrderEntryInput;
    type Output = OrderEntryOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "connections.set_order_entry",
            "Turn order entry on or off for an account",
            RiskTier::Modify,
        )
        .description("The user's own switch, per account, off by default: an account on a broker or prop firm's system (an evaluation, a funded or a live account) takes orders only while it is on. Orders still go through the usual approval.")
        .user_only()
        .timeout_ms(10_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: OrderEntryInput,
    ) -> Result<OrderEntryOutput, ToolError> {
        self.0.set_order_entry(&input).await
    }

    fn summarize(&self, out: &OrderEntryOutput) -> Option<String> {
        Some(format!(
            "Order entry {} for {}",
            if out.enabled { "on" } else { "off" },
            out.account_id
        ))
    }
}

struct ListCredentials(Arc<Connectors>);

#[async_trait]
impl Tool for ListCredentials {
    type Input = CredentialsListInput;
    type Output = CredentialsListOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "connections.list_credentials",
            "List saved logins and keys",
            RiskTier::Read,
        )
        .description("Every login and key Tessera keeps for the user's connections (Rithmic logins, the secrets level sources send): which connection it is for, where it is kept (the OS keyring or, in development, the development secrets file) and whether it is still there. Never a password, key or secret; a Rithmic login shows its user name.")
        .user_only()
        .quiet()
        .timeout_ms(60_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: CredentialsListInput,
    ) -> Result<CredentialsListOutput, ToolError> {
        Ok(self.0.list_credentials().await)
    }

    fn summarize(&self, out: &CredentialsListOutput) -> Option<String> {
        Some(format!("{} saved", out.credentials.len()))
    }
}

struct TestCredential(Arc<Connectors>);

#[async_trait]
impl Tool for TestCredential {
    type Input = ConnectionIdInput;
    type Output = ConnectionsTestOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "connections.test_credential",
            "Test a saved login or key",
            RiskTier::Read,
        )
        .description("Tests a connection's saved login or key without typing it again, and says whether it is accepted: a Rithmic login connected now is not logged in a second time (Rithmic can end the first session for it); otherwise Rithmic is asked with the saved login, a level source's requests with its saved secret. Nothing is stored.")
        .user_only()
        .quiet()
        .rate_limit(LOGIN_RATE)
        .timeout_ms(45_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ConnectionIdInput,
    ) -> Result<ConnectionsTestOutput, ToolError> {
        self.0.test_credential(&input.id).await
    }
}

struct ReplaceRithmic(Arc<Connectors>);

#[async_trait]
impl Tool for ReplaceRithmic {
    type Input = RithmicLoginInput;
    type Output = ConnectionsAddOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "connections.replace_rithmic",
            "Change a Rithmic login",
            RiskTier::Modify,
        )
        .description("Changes the login of a Rithmic connection already added (the same system): logs its session out, logs in with the new login (system, gateway, user, password) and, once Rithmic accepts it, keeps it in place of the old one; prices, charts and accounts carry on. A refused or unreachable new login changes nothing: the old login logs in again and stays saved. A connection the user turned off stays off: the new login logs in and straight out, and is kept once accepted.")
        .user_only()
        .quiet()
        .redact(&LOGIN_FIELDS)
        .rate_limit(LOGIN_RATE)
        .timeout_ms(90_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: RithmicLoginInput,
    ) -> Result<ConnectionsAddOutput, ToolError> {
        self.0.replace_rithmic(&input).await
    }

    async fn preview(
        &self,
        _ctx: &ToolCtx,
        input: &RithmicLoginInput,
    ) -> Result<serde_json::Value, ToolError> {
        Ok(serde_json::json!({ "system": input.system }))
    }

    fn summarize(&self, out: &ConnectionsAddOutput) -> Option<String> {
        Some(format!(
            "Changed the login of {}",
            out.connection.display_name
        ))
    }
}

struct SetEnabled(Arc<Connectors>);

#[async_trait]
impl Tool for SetEnabled {
    type Input = ConnectionEnabledInput;
    type Output = ConnectionEnabledOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "connections.set_enabled",
            "Turn a connection on or off",
            RiskTier::Modify,
        )
        .description("The user's switch for a saved login (\"connect on startup\"), on when it is added: on, it is connected now and at every start; off, it is logged out and its prices and accounts leave the desk, while its saved login, its order-entry switches and its place in the list stay.")
        .user_only()
        .quiet()
        .rate_limit(LOGIN_RATE)
        .timeout_ms(20_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ConnectionEnabledInput,
    ) -> Result<ConnectionEnabledOutput, ToolError> {
        self.0.set_enabled(&input).await
    }

    fn summarize(&self, out: &ConnectionEnabledOutput) -> Option<String> {
        Some(format!(
            "{} {}",
            out.connection.display_name,
            if out.connection.enabled == Some(false) {
                "off"
            } else {
                "on"
            }
        ))
    }
}

struct RithmicDirectory(Arc<Connectors>);

#[async_trait]
impl Tool for RithmicDirectory {
    type Input = RithmicDirectoryInput;
    type Output = RithmicDirectoryOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "connections.rithmic_directory",
            "List Rithmic's systems and gateways",
            RiskTier::Read,
        )
        .description("Every system Rithmic serves (prop firms, brokers, Rithmic's own paper and test systems) and, for one system, its gateways by name (`Chicago Area`), asked of Rithmic without a login, so a login is chosen instead of typed: connections.add_rithmic takes a gateway by name. A gateway's address never leaves the runtime. problem says why something could not be read.")
        .user_only()
        .quiet()
        .rate_limit(DIRECTORY_RATE)
        .timeout_ms(60_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: RithmicDirectoryInput,
    ) -> Result<RithmicDirectoryOutput, ToolError> {
        Ok(self.0.rithmic_directory(&input).await)
    }
}

const MAKE_IT_PRIVATE: &str = if cfg!(windows) {
    "leave only your user and SYSTEM in its access list"
} else {
    "chmod 600 it"
};
