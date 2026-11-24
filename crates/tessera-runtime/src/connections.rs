use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_broker::{BrokerError, BrokerProvider, BrokerRouter};
use tessera_core::Timestamp;
use tessera_core::capabilities::{BrokerCapabilities, IntelCapabilities, MarketCapabilities};
use tessera_core::health::{ConnectionPhase, HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::AccountId;
use tessera_host::{RuntimeModule, TsExports};
use tessera_intel::IntelligenceProvider;
use tessera_intel::router::IntelRouterError;
use tessera_market::{MarketDataProvider, MarketRouter, RouterError};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use tokio::sync::watch;
use ts_rs::TS;

use crate::connectors::CredentialState;

pub use tessera_intel::IntelRouter;

/// `connections.list` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionsListInput {}

/// One connection: a market-data provider (with the broker side of the same login, if it has
/// one) or an intelligence provider.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    /// Provider id (`rithmic-apex`, `paper`, a level source's id).
    pub id: String,
    /// What kind of provider it is.
    pub kind: ProviderKind,
    /// Display name.
    pub display_name: String,
    /// Market-data capabilities, for market-data providers.
    pub market: Option<MarketCapabilities>,
    /// Intelligence capabilities, for intelligence providers.
    pub intel: Option<IntelCapabilities>,
    /// Broker capabilities, when the same login also serves accounts (a Rithmic login).
    pub broker: Option<BrokerCapabilities>,
    /// On a connection whose accounts take orders by their own switch (decisions 0009, 0017:
    /// every broker or prop firm's system but a paper one), the accounts the user turned order
    /// entry on for (`connections.set_order_entry`, the user's own switch; off by default); `null`
    /// on any other connection, which has no such switch.
    pub account_order_entry: Option<Vec<AccountId>>,
    /// On a login the user saved (a Rithmic connection they added), whether it is on
    /// (`connections.set_enabled`, the user's own switch: on is connected now and at every start;
    /// off is logged out, its prices and accounts gone, its login kept); `null` on any other
    /// connection (paper, a source of levels, a development credentials file's login).
    pub enabled: Option<bool>,
    /// On a saved login that is not running because its login could not be had from its store: `missing` (the
    /// store has no login Tessera can use: log in again) or `unreadable` (the store did not answer, or refused as
    /// the macOS Keychain does until the user lets Tessera in: try again); `null` on any other connection.
    pub credential: Option<CredentialState>,
    /// Current health; `message` always says it in plain words.
    pub health: ProviderHealth,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsListOutput {
    /// Every connection, market data first, each in priority order.
    pub connections: Vec<ConnectionInfo>,
    /// The connection feeding charts, quotes, depth and order flow now (decision 0010: the user's
    /// `market.dataSource`, or the first one connected when it is `auto`), for every exchange
    /// without a connection of its own in
    /// `market.dataByExchange`; null with none.
    pub data_source: Option<String>,
}

#[derive(Debug)]
pub struct ConnectionsService {
    market: Arc<MarketRouter>,
    intel: Arc<IntelRouter>,
    brokers: Option<Arc<BrokerRouter>>,
    unavailable: RwLock<BTreeMap<String, ConnectionInfo>>,
    saved: RwLock<BTreeMap<String, bool>>,
    changes: watch::Sender<u64>,
}

pub fn plain_words(status: HealthStatus) -> &'static str {
    match status {
        HealthStatus::Ok => "Connected",
        HealthStatus::Degraded => "Connected, with problems",
        HealthStatus::Down => "Not working",
        HealthStatus::Disconnected => "Not connected",
        HealthStatus::Unknown => "Connecting",
        HealthStatus::Disabled => "Off",
    }
}

impl ConnectionsService {
    pub fn new(market: Arc<MarketRouter>, intel: Arc<IntelRouter>) -> Self {
        Self {
            market,
            intel,
            brokers: None,
            unavailable: RwLock::new(BTreeMap::new()),
            saved: RwLock::new(BTreeMap::new()),
            changes: watch::channel(0).0,
        }
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    #[must_use]
    pub fn with_brokers(mut self, brokers: Arc<BrokerRouter>) -> Self {
        self.brokers = Some(brokers);
        self
    }

    pub fn brokers(&self) -> Option<&Arc<BrokerRouter>> {
        self.brokers.as_ref()
    }

    pub fn market(&self) -> &Arc<MarketRouter> {
        &self.market
    }

    pub fn intel(&self) -> &Arc<IntelRouter> {
        &self.intel
    }

    pub fn add_market(&self, provider: Arc<dyn MarketDataProvider>) -> Result<(), RouterError> {
        let id = provider.id().to_owned();
        self.market.add(provider)?;
        tracing::info!(provider = %id, "market-data connection added");
        Ok(())
    }

    pub fn remove_market(&self, id: &str) -> bool {
        let removed = self.market.remove(id).is_some();
        if removed {
            tracing::info!(provider = id, "market-data connection removed");
        }
        removed
    }

    pub fn add_broker(&self, provider: Arc<dyn BrokerProvider>) -> Result<(), BrokerError> {
        let brokers = self.brokers.as_ref().ok_or_else(|| {
            BrokerError::Unavailable("this runtime hosts no broker connections".into())
        })?;
        let id = provider.id().to_owned();
        brokers.add(provider)?;
        tracing::info!(provider = %id, "broker connection added");
        Ok(())
    }

    pub fn remove_broker(&self, id: &str) -> bool {
        let removed = self
            .brokers
            .as_ref()
            .is_some_and(|b| b.remove(id).is_some());
        if removed {
            tracing::info!(provider = id, "broker connection removed");
        }
        removed
    }

    pub fn set_unavailable(
        &self,
        id: &str,
        display_name: &str,
        message: String,
        credential: Option<CredentialState>,
        now: Timestamp,
    ) {
        self.set_not_running(
            id,
            display_name,
            HealthStatus::Down,
            message,
            credential,
            now,
        );
    }

    pub fn set_reading(&self, id: &str, display_name: &str, message: String, now: Timestamp) {
        self.set_not_running(id, display_name, HealthStatus::Unknown, message, None, now);
    }

    pub fn set_off(&self, id: &str, display_name: &str, now: Timestamp) {
        self.set_not_running(
            id,
            display_name,
            HealthStatus::Disconnected,
            "Off.".to_owned(),
            None,
            now,
        );
    }

    pub fn set_saved(&self, id: &str, enabled: bool) {
        if self.saved.write().insert(id.to_owned(), enabled) != Some(enabled) {
            self.changes.send_modify(|v| *v += 1);
        }
    }

    pub fn forget_saved(&self, id: &str) {
        if self.saved.write().remove(id).is_some() {
            self.changes.send_modify(|v| *v += 1);
        }
    }

    fn set_not_running(
        &self,
        id: &str,
        display_name: &str,
        status: HealthStatus,
        message: String,
        credential: Option<CredentialState>,
        now: Timestamp,
    ) {
        let info = ConnectionInfo {
            id: id.to_owned(),
            kind: ProviderKind::MarketData,
            display_name: display_name.to_owned(),
            market: None,
            intel: None,
            broker: None,
            account_order_entry: None,
            enabled: None,
            credential,
            health: ProviderHealth {
                provider_id: id.to_owned(),
                kind: ProviderKind::MarketData,
                display_name: display_name.to_owned(),
                status,
                latency_ms: None,
                last_message_at: None,
                message: Some(message),
                connection: None,
                accounts: None,
                checked_at: now,
            },
        };
        self.unavailable.write().insert(id.to_owned(), info);
        self.changes.send_modify(|v| *v += 1);
    }

    pub fn clear_unavailable(&self, id: &str) {
        if self.unavailable.write().remove(id).is_some() {
            self.changes.send_modify(|v| *v += 1);
        }
    }

    pub fn unavailable_health(&self) -> Vec<ProviderHealth> {
        self.unavailable
            .read()
            .values()
            .map(|c| c.health.clone())
            .collect()
    }

    pub fn info(&self, id: &str) -> Option<ConnectionInfo> {
        self.list().into_iter().find(|c| c.id == id)
    }

    pub fn add_intel(
        &self,
        provider: Arc<dyn IntelligenceProvider>,
    ) -> Result<(), IntelRouterError> {
        let id = provider.id().to_owned();
        self.intel.add(provider)?;
        tracing::info!(provider = %id, "intelligence connection added");
        Ok(())
    }

    pub fn remove_intel(&self, id: &str) -> bool {
        let removed = self.intel.remove(id).is_some();
        if removed {
            tracing::info!(provider = id, "intelligence connection removed");
        }
        removed
    }

    pub fn list(&self) -> Vec<ConnectionInfo> {
        let market = self.market.providers().into_iter().map(|p| {
            let caps = tessera_market::router::effective(p.capabilities());
            let broker = self.brokers.as_ref().and_then(|b| b.get(p.id()));
            let mut health = p.health();
            if let Some(b) = &broker {
                fold_broker_health(&mut health, &b.health());
            }
            ConnectionInfo {
                id: p.id().to_owned(),
                kind: ProviderKind::MarketData,
                display_name: p.display_name().to_owned(),
                market: Some(caps),
                intel: None,
                account_order_entry: broker.as_ref().and_then(|b| b.account_order_entry()),
                broker: broker.map(|b| b.capabilities()),
                enabled: None,
                credential: None,
                health,
            }
        });
        let unavailable: Vec<ConnectionInfo> = self.unavailable.read().values().cloned().collect();
        let saved = self.saved.read().clone();
        let intel = self.intel.providers().into_iter().map(|p| {
            let caps = p.capabilities();
            ConnectionInfo {
                id: p.id().to_owned(),
                kind: ProviderKind::Intelligence,
                display_name: p.display_name().to_owned(),
                market: None,
                intel: Some(caps),
                broker: None,
                account_order_entry: None,
                enabled: None,
                credential: None,
                health: p.health(),
            }
        });
        market
            .chain(unavailable)
            .map(|mut c| {
                c.enabled = saved.get(&c.id).copied();
                c
            })
            .chain(intel)
            .map(|mut c| {
                if c.health.message.is_none() && c.health.connection.is_none() {
                    c.health.message = Some(plain_words(c.health.status).to_owned());
                }
                c
            })
            .collect()
    }
}

pub fn one_per_connection(healths: Vec<ProviderHealth>) -> Vec<ProviderHealth> {
    let market: std::collections::HashSet<String> = healths
        .iter()
        .filter(|h| h.kind == ProviderKind::MarketData)
        .map(|h| h.provider_id.clone())
        .collect();
    let (shared, mut out): (Vec<_>, Vec<_>) = healths
        .into_iter()
        .partition(|h| h.kind == ProviderKind::Broker && market.contains(&h.provider_id));
    for b in &shared {
        if let Some(m) = out
            .iter_mut()
            .find(|h| h.kind == ProviderKind::MarketData && h.provider_id == b.provider_id)
        {
            fold_broker_health(m, b);
        }
    }
    out
}

fn ended_sentence(words: &str) -> String {
    let words = words.trim_end();
    if words.ends_with(['.', '!', '?']) {
        words.to_owned()
    } else {
        format!("{words}.")
    }
}

fn fold_broker_health(health: &mut ProviderHealth, broker: &ProviderHealth) {
    if matches!(broker.status, HealthStatus::Ok | HealthStatus::Unknown) {
        return;
    }
    let typed = health.connection.is_some() && broker.connection.is_some();
    if typed && broker.connection != Some(ConnectionPhase::Live) {
        if broker.connection != health.connection {
            health.accounts.clone_from(&broker.connection);
        }
    } else {
        let accounts = broker
            .message
            .clone()
            .unwrap_or_else(|| plain_words(broker.status).to_owned());
        let prices = health
            .message
            .clone()
            .unwrap_or_else(|| plain_words(health.status).to_owned());
        if prices != accounts {
            health.message = Some(format!("{} Accounts: {accounts}", ended_sentence(&prices)));
        }
    }
    let rank = |s: HealthStatus| match s {
        HealthStatus::Ok => 0,
        HealthStatus::Unknown => 1,
        HealthStatus::Degraded => 2,
        HealthStatus::Disconnected | HealthStatus::Down | HealthStatus::Disabled => 3,
    };
    if rank(broker.status) > rank(health.status) {
        health.status = HealthStatus::Degraded;
    }
}

#[derive(Debug)]
pub struct ConnectionsModule {
    service: Arc<ConnectionsService>,
    connectors: Option<Arc<crate::connectors::Connectors>>,
    level_sources: Option<Arc<crate::level_sources::LevelSources>>,
}

impl ConnectionsModule {
    pub fn new(service: Arc<ConnectionsService>) -> Self {
        Self {
            service,
            connectors: None,
            level_sources: None,
        }
    }

    #[must_use]
    pub fn with_level_sources(mut self, sources: Arc<crate::level_sources::LevelSources>) -> Self {
        if let Some(c) = &self.connectors {
            c.set_level_sources(Arc::clone(&sources));
        }
        self.level_sources = Some(sources);
        self
    }

    #[must_use]
    pub fn with_connectors(mut self, connectors: Arc<crate::connectors::Connectors>) -> Self {
        self.connectors = Some(connectors);
        self
    }
}

impl RuntimeModule for ConnectionsModule {
    fn name(&self) -> &'static str {
        "connections"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(ListConnections(Arc::clone(&self.service)))?;
        if let Some(c) = &self.connectors {
            c.register_tools(r)?;
        }
        if let Some(l) = &self.level_sources {
            l.register_tools(r)?;
        }
        Ok(())
    }

    fn health(&self) -> Vec<ProviderHealth> {
        self.service.unavailable_health()
    }
}

pub fn ts_exports() -> TsExports {
    use crate::connectors::{
        ConnectionEnabledInput, ConnectionEnabledOutput, ConnectionIdInput, ConnectionsAddOutput,
        ConnectionsReconnectOutput, ConnectionsRemoveOutput, ConnectionsTestOutput,
        CredentialsListInput, CredentialsListOutput, OrderEntryInput, OrderEntryOutput,
        RithmicDirectoryInput, RithmicDirectoryOutput, RithmicLoginInput,
    };
    use crate::level_sources::{AddLevelSourceInput, LevelSourceAddOutput, TestLevelSourceInput};
    TsExports::new("tessera-runtime (connections)")
        .tool::<ConnectionsListInput, ConnectionsListOutput>("connections.list")
        .tool::<RithmicLoginInput, ConnectionsAddOutput>("connections.add_rithmic")
        .tool::<RithmicLoginInput, ConnectionsTestOutput>("connections.test_rithmic")
        .tool::<ConnectionIdInput, ConnectionsRemoveOutput>("connections.remove")
        .tool::<ConnectionIdInput, ConnectionsReconnectOutput>("connections.reconnect")
        .tool::<OrderEntryInput, OrderEntryOutput>("connections.set_order_entry")
        .tool::<CredentialsListInput, CredentialsListOutput>("connections.list_credentials")
        .tool::<ConnectionIdInput, ConnectionsTestOutput>("connections.test_credential")
        .tool::<RithmicLoginInput, ConnectionsAddOutput>("connections.replace_rithmic")
        .tool::<ConnectionEnabledInput, ConnectionEnabledOutput>("connections.set_enabled")
        .tool::<RithmicDirectoryInput, RithmicDirectoryOutput>("connections.rithmic_directory")
        .tool::<AddLevelSourceInput, LevelSourceAddOutput>("connections.add_level_source")
        .tool::<TestLevelSourceInput, tessera_intel::io::TestSourceOutput>(
            "connections.test_level_source",
        )
}

struct ListConnections(Arc<ConnectionsService>);

#[async_trait]
impl Tool for ListConnections {
    type Input = ConnectionsListInput;
    type Output = ConnectionsListOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("connections.list", "List connections", RiskTier::Read)
            .description("Every data connection the runtime uses: market-data providers (the user's prop or broker connections) and intelligence providers (sources of levels the user added from a spec), with their capabilities and health. An empty list means the user has connected nothing yet.")
            .activity("Listed connections")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: ConnectionsListInput,
    ) -> Result<ConnectionsListOutput, ToolError> {
        Ok(ConnectionsListOutput {
            connections: self.0.list(),
            data_source: self.0.market().data_source().map(|c| c.id),
        })
    }

    fn summarize(&self, out: &ConnectionsListOutput) -> Option<String> {
        Some(format!("{} connections", out.connections.len()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health(
        id: &str,
        kind: ProviderKind,
        status: HealthStatus,
        msg: Option<&str>,
    ) -> ProviderHealth {
        ProviderHealth {
            provider_id: id.into(),
            kind,
            display_name: id.into(),
            status,
            latency_ms: None,
            last_message_at: None,
            message: msg.map(str::to_owned),
            connection: None,
            accounts: None,
            checked_at: Timestamp(0),
        }
    }

    #[test]
    fn a_login_with_prices_and_accounts_reports_once() {
        let forced = "Rithmic ended the session. Reconnect to continue.";
        let out = one_per_connection(vec![
            health(
                "rithmic-topstep",
                ProviderKind::MarketData,
                HealthStatus::Ok,
                None,
            ),
            health(
                "rithmic-apex",
                ProviderKind::MarketData,
                HealthStatus::Down,
                Some(forced),
            ),
            health("paper", ProviderKind::Broker, HealthStatus::Ok, None),
            health(
                "rithmic-apex",
                ProviderKind::Broker,
                HealthStatus::Down,
                Some(forced),
            ),
        ]);
        let ids: Vec<(&str, ProviderKind)> = out
            .iter()
            .map(|h| (h.provider_id.as_str(), h.kind))
            .collect();
        assert_eq!(
            ids,
            [
                ("rithmic-topstep", ProviderKind::MarketData),
                ("rithmic-apex", ProviderKind::MarketData),
                ("paper", ProviderKind::Broker),
            ]
        );
        assert_eq!(out[1].message.as_deref(), Some(forced));
        assert_eq!(out[1].status, HealthStatus::Down);

        let out = one_per_connection(vec![
            health(
                "rithmic-apex",
                ProviderKind::MarketData,
                HealthStatus::Ok,
                None,
            ),
            health(
                "rithmic-apex",
                ProviderKind::Broker,
                HealthStatus::Down,
                Some("refused"),
            ),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, HealthStatus::Degraded);
        assert_eq!(
            out[0].message.as_deref(),
            Some("Connected. Accounts: refused")
        );
    }

    #[test]
    fn accounts_follow_the_prices_sentence_after_one_period() {
        let out = one_per_connection(vec![
            health(
                "rithmic-apex",
                ProviderKind::MarketData,
                HealthStatus::Degraded,
                Some("Connection lost (connection closed). Reconnecting, attempt 4."),
            ),
            health(
                "rithmic-apex",
                ProviderKind::Broker,
                HealthStatus::Down,
                Some("Cannot reach Rithmic: connection closed"),
            ),
        ]);
        assert_eq!(
            out[0].message.as_deref(),
            Some(
                "Connection lost (connection closed). Reconnecting, attempt 4. Accounts: Cannot reach Rithmic: connection closed"
            )
        );
    }

    fn phased(kind: ProviderKind, phase: ConnectionPhase) -> ProviderHealth {
        ProviderHealth {
            status: phase.status(),
            connection: Some(phase),
            ..health("rithmic-apex", kind, HealthStatus::Ok, None)
        }
    }

    #[test]
    fn a_logins_accounts_keep_their_own_phase_beside_the_prices() {
        let dropped = ConnectionPhase::Reconnecting {
            attempt: 2,
            reason: "connection closed".into(),
        };
        let out = one_per_connection(vec![
            phased(ProviderKind::MarketData, ConnectionPhase::Live),
            phased(ProviderKind::Broker, dropped.clone()),
        ]);
        assert_eq!(
            (
                out[0].status,
                &out[0].connection,
                &out[0].accounts,
                &out[0].message
            ),
            (
                HealthStatus::Degraded,
                &Some(ConnectionPhase::Live),
                &Some(dropped.clone()),
                &None
            )
        );

        let out = one_per_connection(vec![
            phased(ProviderKind::MarketData, dropped.clone()),
            phased(ProviderKind::Broker, dropped.clone()),
        ]);
        assert_eq!(
            (&out[0].connection, &out[0].accounts, &out[0].message),
            (&Some(dropped), &None, &None),
            "one drop of the login reads once"
        );
    }
}
