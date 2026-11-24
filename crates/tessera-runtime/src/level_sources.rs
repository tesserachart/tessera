use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::accounts::{CredentialRef, CredentialStore};
use tessera_core::capabilities::IntelCapabilities;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::ContractSpec;
use tessera_core::{InstrumentId, SharedClock, Timestamp};
use tessera_intel::io::{LevelSourceInfo, TestSourceOutput};
use tessera_intel::source::http::HttpClient;
use tessera_intel::source::{
    HttpLevelSource, LevelSourceSpec, RawSink, Secret, SourceDrafts, SpecLookup,
};
use tessera_intel::{ConversionRecord, IntelError, IntelligenceProvider, LevelSnapshot};
use tessera_market::{MarketDataProvider, MarketRouter};
use tessera_protocol::tools::RiskTier;
use tessera_store::Store;
use tessera_store::blobs::BlobStore;
use tessera_tools::{RateLimit, RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use ts_rs::TS;

use crate::connections::{ConnectionInfo, ConnectionsService};
use crate::connectors::{
    ConnectionsRemoveOutput, ConnectionsTestOutput, CredentialInfo, CredentialKind,
    CredentialState, read_credential,
};
use crate::logging::Redactor;
use crate::secrets::{Secrets, store_name};
use crate::settings::SettingsService;

pub const RECORDS_KEY: &str = "connections.levelSources";

const SPEC_KIND: &str = "spec";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceRecord {
    id: String,
    kind: String,
    display_name: String,
    #[serde(default)]
    spec: Option<LevelSourceSpec>,
    #[serde(default)]
    credential: Option<CredentialRef>,
}

impl SourceRecord {
    fn retired_words(&self) -> String {
        format!(
            "{} was built into an earlier Tessera and is no longer. Add it again with Any API, with the analyst… in Settings › Connections, from the vendor's docs; with the id {} it keeps the key saved here.",
            self.display_name, self.id
        )
    }
}

/// `connections.add_level_source` input: a spec and the secret it sends.
#[derive(Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AddLevelSourceInput {
    /// The source's spec (`intel.test_source` tries one).
    pub spec: LevelSourceSpec,
    /// The key or secret it sends, kept in the OS keyring. Editing a spec without it keeps the
    /// one saved.
    #[serde(default)]
    pub secret: Option<String>,
}

impl std::fmt::Debug for AddLevelSourceInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddLevelSourceInput")
            .field("spec", &self.spec.id)
            .finish_non_exhaustive()
    }
}

/// `connections.test_level_source` input: a dry run of a spec with its secret.
#[derive(Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TestLevelSourceInput {
    /// The spec to try.
    pub spec: LevelSourceSpec,
    /// The key or secret it sends.
    #[serde(default)]
    pub secret: Option<String>,
    /// Sample responses by request id; a request without one is asked live.
    #[serde(default)]
    pub samples: BTreeMap<String, Value>,
    /// The root or symbol to try (default: the first mapped).
    #[serde(default)]
    pub instrument: Option<String>,
}

impl std::fmt::Debug for TestLevelSourceInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestLevelSourceInput")
            .field("spec", &self.spec.id)
            .finish_non_exhaustive()
    }
}

/// `connections.add_level_source` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LevelSourceAddOutput {
    /// The connection as `connections.list` reports it.
    pub connection: ConnectionInfo,
    /// Where its secret is kept; none for an open API.
    pub stored_in: Option<CredentialStore>,
}

#[derive(Debug)]
pub struct BlobSink(pub BlobStore);

impl RawSink for BlobSink {
    fn put(&self, bytes: &[u8], media_type: &str, source: &str) -> Option<String> {
        match self.0.put(bytes, media_type, Some(source)) {
            Ok(b) => Some(b.sha256),
            Err(e) => {
                tracing::warn!(error = %e, "a raw levels response was not kept");
                None
            }
        }
    }
}

#[derive(Debug)]
pub struct MarketSpecs(pub Arc<MarketRouter>);

#[async_trait]
impl SpecLookup for MarketSpecs {
    async fn contract_spec(&self, instrument: &InstrumentId) -> Option<ContractSpec> {
        MarketDataProvider::spec(self.0.as_ref(), instrument)
            .await
            .ok()
            .map(|(_, s)| s)
    }
}

struct Live {
    record: Option<SourceRecord>,
}

#[derive(Debug)]
struct Retired {
    vendor: String,
    sends_secret: bool,
    health: ProviderHealth,
}

impl Retired {
    fn new(r: &SourceRecord, now: Timestamp) -> Self {
        Self {
            health: ProviderHealth {
                provider_id: r.id.clone(),
                kind: ProviderKind::Intelligence,
                display_name: r.display_name.clone(),
                status: HealthStatus::Down,
                latency_ms: None,
                last_message_at: None,
                message: Some(r.retired_words()),
                connection: None,
                accounts: None,
                checked_at: now,
            },
            vendor: r.display_name.clone(),
            sends_secret: r.credential.is_some(),
        }
    }

    fn refusal(&self) -> IntelError {
        IntelError::Unavailable(self.health.message.clone().unwrap_or_default())
    }
}

#[async_trait]
impl IntelligenceProvider for Retired {
    fn id(&self) -> &str {
        &self.health.provider_id
    }

    fn display_name(&self) -> &str {
        &self.health.display_name
    }

    fn capabilities(&self) -> IntelCapabilities {
        IntelCapabilities {
            vendor: self.vendor.clone(),
            packages: Vec::new(),
            levels: false,
            profiles: false,
            conversions: false,
            history: false,
            realtime: false,
            rth_only: false,
        }
    }

    fn health(&self) -> ProviderHealth {
        self.health.clone()
    }

    async fn levels(
        &self,
        _instrument: &InstrumentId,
        _as_of: Option<Timestamp>,
    ) -> Result<LevelSnapshot, IntelError> {
        Err(self.refusal())
    }

    async fn conversion(
        &self,
        _from: &str,
        _to: &InstrumentId,
    ) -> Result<ConversionRecord, IntelError> {
        Err(self.refusal())
    }

    fn level_source(&self) -> Option<LevelSourceInfo> {
        Some(LevelSourceInfo {
            provider_id: self.health.provider_id.clone(),
            display_name: self.health.display_name.clone(),
            vendor: self.vendor.clone(),
            packages: Vec::new(),
            instruments: Vec::new(),
            schedule: None,
            calls_today: Vec::new(),
            spec: None,
            editable: false,
            sends_secret: self.sends_secret,
            history: None,
            health: self.health.clone(),
        })
    }
}

pub struct LevelSources {
    connections: Arc<ConnectionsService>,
    store: Store,
    secrets: Secrets,
    http: Arc<dyn HttpClient>,
    raw: Option<Arc<dyn RawSink>>,
    specs: Option<Arc<dyn SpecLookup>>,
    vendor_clock: SharedClock,
    clock: SharedClock,
    drafts: Option<Arc<SourceDrafts>>,
    live: tokio::sync::Mutex<HashMap<String, Live>>,
}

impl std::fmt::Debug for LevelSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LevelSources").finish_non_exhaustive()
    }
}

fn secret_of(s: Option<&str>) -> Option<&str> {
    let s = s.map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = s {
        Redactor::global().register(s);
    }
    s
}

fn problems(p: Vec<String>) -> ToolError {
    ToolError::invalid_input(p.join("; "))
}

pub struct LevelSourcesDeps {
    pub connections: Arc<ConnectionsService>,
    pub store: Store,
    pub secrets: Secrets,
    pub http: Arc<dyn HttpClient>,
    pub raw: Option<Arc<dyn RawSink>>,
    pub specs: Option<Arc<dyn SpecLookup>>,
    pub vendor_clock: SharedClock,
    pub clock: SharedClock,
    pub drafts: Option<Arc<SourceDrafts>>,
}

impl LevelSources {
    pub fn new(deps: LevelSourcesDeps) -> Arc<Self> {
        let LevelSourcesDeps {
            connections,
            store,
            secrets,
            http,
            raw,
            specs,
            vendor_clock,
            clock,
            drafts,
        } = deps;
        Arc::new(Self {
            connections,
            store,
            secrets,
            http,
            raw,
            specs,
            vendor_clock,
            clock,
            drafts,
            live: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    async fn records(&self) -> Vec<SourceRecord> {
        let store = self.store.clone();
        match tokio::task::spawn_blocking(move || store.settings().get(RECORDS_KEY)).await {
            Ok(Ok(Some(v))) => serde_json::from_value(v).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "ignoring unreadable level source records");
                Vec::new()
            }),
            Ok(Ok(None)) => Vec::new(),
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "cannot read level source records");
                Vec::new()
            }
            Err(e) => {
                tracing::warn!(error = %e, "cannot read level source records");
                Vec::new()
            }
        }
    }

    async fn saved_secret(&self, id: &str) -> Option<String> {
        let credential = self
            .records()
            .await
            .into_iter()
            .find(|r| r.id == id)
            .and_then(|r| r.credential)?;
        self.secrets.get(&credential).await.ok().flatten()
    }

    async fn save_records(&self, records: Vec<SourceRecord>) -> Result<(), ToolError> {
        let store = self.store.clone();
        let now = self.clock.now();
        let value =
            serde_json::to_value(records).map_err(|e| ToolError::internal(e.to_string()))?;
        tokio::task::spawn_blocking(move || store.settings().set(RECORDS_KEY, &value, now))
            .await
            .map_err(|e| ToolError::internal(e.to_string()))?
            .map_err(|e| ToolError::internal(format!("cannot save the source: {e}")))
    }

    fn build_spec(
        &self,
        spec: LevelSourceSpec,
        secret: Option<&str>,
    ) -> Result<Arc<HttpLevelSource>, ToolError> {
        HttpLevelSource::new(
            spec,
            secret.map(Secret::new),
            Arc::clone(&self.http),
            Arc::clone(&self.vendor_clock),
        )
        .map(|s| Arc::new(s.with_raw(self.raw.clone()).with_specs(self.specs.clone())))
        .map_err(problems)
    }

    async fn connect(
        &self,
        provider: Arc<HttpLevelSource>,
        record: Option<SourceRecord>,
    ) -> Result<(), ToolError> {
        self.register(provider, Live { record }).await
    }

    async fn register(
        &self,
        provider: Arc<dyn IntelligenceProvider>,
        entry: Live,
    ) -> Result<(), ToolError> {
        let id = provider.id().to_owned();
        let mut live = self.live.lock().await;
        if live.contains_key(&id) {
            return Err(ToolError::conflict(format!(
                "{} is already connected",
                provider.display_name()
            )));
        }
        self.connections
            .add_intel(provider)
            .map_err(|e| ToolError::conflict(e.to_string()))?;
        live.insert(id, entry);
        Ok(())
    }

    async fn retire(&self, r: SourceRecord) {
        let retired = Retired::new(&r, self.clock.now());
        let id = r.id.clone();
        let entry = Live { record: Some(r) };
        match self.register(Arc::new(retired), entry).await {
            Ok(()) => {
                tracing::warn!(source = %id, "a level source saved as a built-in waits to be added again")
            }
            Err(e) => {
                tracing::warn!(source = %id, error = %e.message, "a retired level source is not shown")
            }
        }
    }

    pub async fn owns(&self, id: &str) -> bool {
        self.live.lock().await.contains_key(id) || self.records().await.iter().any(|r| r.id == id)
    }

    pub fn restore(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            for r in me.records().await {
                if let Some(c) = &r.credential {
                    me.secrets.note(c);
                }
                let Some(spec) = r.spec.clone().filter(|_| r.kind == SPEC_KIND) else {
                    me.retire(r).await;
                    continue;
                };
                let secret = match &r.credential {
                    None => None,
                    Some(c) => match me.secrets.get_patiently(c, || {}).await {
                        Ok(Some(s)) => {
                            Redactor::global().register(&s);
                            Some(s)
                        }
                        Ok(None) => {
                            tracing::warn!(source = %r.id, store = store_name(c.store), "a level source's secret is missing; add it again");
                            continue;
                        }
                        Err(e) => {
                            tracing::warn!(source = %r.id, error = %e, "a level source's secret cannot be read");
                            continue;
                        }
                    },
                };
                match me.build_spec(spec, secret.as_deref()) {
                    Ok(p) => match me.connect(p, Some(r.clone())).await {
                        Ok(()) => tracing::info!(source = %r.id, "level source connected"),
                        Err(e) => {
                            tracing::warn!(source = %r.id, error = %e.message, "level source not connected")
                        }
                    },
                    Err(e) => {
                        tracing::warn!(source = %r.id, error = %e.message, "level source not connected")
                    }
                }
            }
        })
    }

    async fn finish_add(
        &self,
        provider: Arc<HttpLevelSource>,
        record: SourceRecord,
        credential: Option<CredentialRef>,
    ) -> Result<LevelSourceAddOutput, ToolError> {
        let id = record.id.clone();
        let mut records = self.records().await;
        let replaced: Vec<SourceRecord> = records.iter().filter(|r| r.id == id).cloned().collect();
        records.retain(|r| r.id != id);
        records.push(record.clone());
        if let Err(e) = self.save_records(records).await {
            if let Some(c) = &credential
                && let Err(e) = self.secrets.delete_everywhere(c).await
            {
                tracing::warn!(source = %id, error = %e, "the secret of a source that was not saved could not be deleted");
            }
            return Err(e);
        }
        if self.live.lock().await.remove(&id).is_some() {
            self.connections.remove_intel(&id);
        }
        for old in replaced {
            if let Some(c) = old.credential
                && Some(&c) != credential.as_ref()
                && let Err(e) = self.secrets.delete_everywhere(&c).await
            {
                tracing::warn!(source = %id, error = %e, "the replaced secret could not be deleted");
            }
        }
        self.connect(provider, Some(record)).await?;
        tracing::info!(source = %id, "level source added");
        if let Some(d) = &self.drafts
            && let Err(e) = d.discard(&id)
        {
            tracing::warn!(source = %id, error = %e, "the source's draft could not be discarded");
        }
        let connection = self
            .connections
            .info(&id)
            .ok_or_else(|| ToolError::internal("the source vanished after it was added"))?;
        Ok(LevelSourceAddOutput {
            connection,
            stored_in: credential.map(|c| c.store),
        })
    }

    pub async fn add_level_source(
        &self,
        input: &AddLevelSourceInput,
    ) -> Result<LevelSourceAddOutput, ToolError> {
        let secret = secret_of(input.secret.as_deref());
        let spec = input.spec.clone();
        let taken = self.connections.intel().get(&spec.id).is_some()
            && !self
                .live
                .lock()
                .await
                .get(&spec.id)
                .is_some_and(|l| l.record.is_some());
        if taken {
            return Err(ToolError::conflict(format!(
                "a source with id {} is already connected",
                spec.id
            )));
        }
        let saved = match (&spec.auth, secret) {
            (Some(_), None) => self.saved_secret(&spec.id).await,
            _ => None,
        };
        let secret = secret.or(saved.as_deref());
        let provider = self.build_spec(spec.clone(), secret)?;
        let credential = match (&spec.auth, secret) {
            (Some(_), Some(s)) => Some(
                self.secrets
                    .put(&format!("levels.{}", spec.id), s)
                    .await
                    .map_err(|e| {
                        ToolError::unavailable(format!("The secret cannot be kept: {e}"))
                    })?,
            ),
            _ => None,
        };
        let record = SourceRecord {
            id: spec.id.clone(),
            kind: SPEC_KIND.into(),
            display_name: spec.name.clone(),
            spec: Some(spec),
            credential: credential.clone(),
        };
        self.finish_add(provider, record, credential).await
    }

    pub async fn test_level_source(
        &self,
        input: &TestLevelSourceInput,
    ) -> Result<TestSourceOutput, ToolError> {
        let secret = secret_of(input.secret.as_deref());
        Ok(tessera_intel::source::test_spec(
            &input.spec,
            secret,
            Some(Arc::clone(&self.http)),
            Arc::clone(&self.vendor_clock),
            &input.samples,
            input.instrument.as_deref(),
        )
        .await)
    }

    pub(crate) async fn credentials(&self) -> Vec<CredentialInfo> {
        let mut out = Vec::new();
        for r in self.records().await {
            let Some(c) = r.credential.clone() else {
                continue;
            };
            let kind = CredentialKind::LevelSource;
            let (state, message) =
                match read_credential(&self.secrets, &c, "secret", "Add the source again.").await {
                    Ok(_) => (CredentialState::Stored, None),
                    Err((state, why)) => (state, Some(why)),
                };
            out.push(CredentialInfo {
                connection_id: r.id.clone(),
                kind,
                name: r.display_name.clone(),
                system: None,
                user: None,
                gateway: None,
                store: c.store,
                location: self.secrets.location(&c),
                state,
                message,
            });
        }
        out
    }

    pub(crate) async fn test_saved(&self, id: &str) -> Option<ConnectionsTestOutput> {
        let r = self.records().await.into_iter().find(|r| r.id == id)?;
        let failed = |message: String| ConnectionsTestOutput { ok: false, message };
        let Some(spec) = r.spec.as_ref().filter(|_| r.kind == SPEC_KIND) else {
            return Some(failed(r.retired_words()));
        };
        let secret = match &r.credential {
            None => None,
            Some(c) => {
                match read_credential(&self.secrets, c, "secret", "Add the source again.").await {
                    Ok(s) => {
                        Redactor::global().register(&s);
                        Some(s)
                    }
                    Err((_, why)) => return Some(failed(why)),
                }
            }
        };
        let out = tessera_intel::source::test_spec(
            spec,
            secret.as_deref(),
            Some(Arc::clone(&self.http)),
            Arc::clone(&self.vendor_clock),
            &BTreeMap::new(),
            None,
        )
        .await;
        let levels: usize = out.requests.iter().map(|q| q.levels.len()).sum();
        if out.ok {
            return Some(ConnectionsTestOutput {
                ok: true,
                message: format!(
                    "{} answered with its saved secret: {levels} level{}.",
                    r.display_name,
                    if levels == 1 { "" } else { "s" }
                ),
            });
        }
        let why: Vec<String> = out
            .requests
            .iter()
            .filter_map(|q| q.message.clone())
            .chain(out.problems)
            .collect();
        Some(failed(if why.is_empty() {
            format!("{} gave no levels.", r.display_name)
        } else {
            why.join("; ")
        }))
    }

    pub async fn remove(&self, id: &str) -> Result<ConnectionsRemoveOutput, ToolError> {
        let entry = self.live.lock().await.remove(id);
        let mut records = self.records().await;
        let stored = records.iter().position(|r| r.id == id);
        let record = stored.map(|i| records.remove(i));
        if entry.is_none() && record.is_none() {
            return Ok(ConnectionsRemoveOutput { removed: false });
        }
        self.connections.remove_intel(id);
        let record = record.or_else(|| entry.and_then(|e| e.record));
        if let Some(c) = record.as_ref().and_then(|r| r.credential.as_ref())
            && let Err(e) = self.secrets.delete_everywhere(c).await
        {
            tracing::warn!(source = id, error = %e, "the source's secret could not be deleted");
        }
        if stored.is_some() {
            self.save_records(records).await?;
        }
        tracing::info!(source = id, "level source removed");
        Ok(ConnectionsRemoveOutput { removed: true })
    }

    pub fn register_tools(self: &Arc<Self>, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(AddLevelSource(Arc::clone(self)))?;
        r.register(TestLevelSource(Arc::clone(self)))?;
        Ok(())
    }
}

const CHECK_RATE: RateLimit = RateLimit {
    per_second: 1.0 / 10.0,
    burst: 4,
};

const SECRET_FIELDS: [&str; 2] = ["key", "secret"];

struct AddLevelSource(Arc<LevelSources>);

#[async_trait]
impl Tool for AddLevelSource {
    type Input = AddLevelSourceInput;
    type Output = LevelSourceAddOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("connections.add_level_source", "Add a level source", RiskTier::Modify)
            .description("Connects a source of levels from its spec ({spec, secret?}: an HTTP API that returns levels: base URL, where the secret goes, the vendor ticker for each instrument and any conversion to the futures price, the requests and how each response field becomes a level, its schedule and limits, and the vendor's history API when it has one; intel.test_source tries one; the analyst's draft of the same id is discarded). Without secret, a source of the same id keeps the one it saved, including one an earlier Tessera saved for a provider it had built in. The key or secret is kept in the OS keyring, never in the spec. Its levels show on the charts of the instruments it maps, under the vendor's own field names, without a restart.")
            .user_only()
            .quiet()
            .redact(&SECRET_FIELDS)
            .rate_limit(CHECK_RATE)
            .timeout_ms(30_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AddLevelSourceInput,
    ) -> Result<LevelSourceAddOutput, ToolError> {
        self.0.add_level_source(&input).await
    }

    async fn preview(
        &self,
        _ctx: &ToolCtx,
        input: &AddLevelSourceInput,
    ) -> Result<Value, ToolError> {
        Ok(serde_json::json!({ "id": input.spec.id, "name": input.spec.name }))
    }

    fn summarize(&self, out: &LevelSourceAddOutput) -> Option<String> {
        Some(format!("Added {}", out.connection.display_name))
    }
}

struct TestLevelSource(Arc<LevelSources>);

#[async_trait]
impl Tool for TestLevelSource {
    type Input = TestLevelSourceInput;
    type Output = TestSourceOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("connections.test_level_source", "Test a level source", RiskTier::Read)
            .description("Tries a source of levels without keeping anything: a dry run of a spec with its secret ({spec, secret?, samples?}: each request without a sample is asked live once; the levels each gives). Problems in plain words. Nothing is stored.")
            .user_only()
            .quiet()
            .redact(&SECRET_FIELDS)
            .rate_limit(CHECK_RATE)
            .timeout_ms(45_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: TestLevelSourceInput,
    ) -> Result<TestSourceOutput, ToolError> {
        self.0.test_level_source(&input).await
    }

    async fn preview(
        &self,
        _ctx: &ToolCtx,
        input: &TestLevelSourceInput,
    ) -> Result<Value, ToolError> {
        Ok(serde_json::json!({ "id": input.spec.id }))
    }
}

const RETIRED_LEVEL_KEYS: [&str; 5] = [
    "call_wall",
    "put_wall",
    "max_positive_gamma",
    "zero_gamma",
    "gamma_flip",
];

const RENAMED_LEVEL_KEYS: [(&str, &str); 3] = [
    ("pdh", "tessera.concepts.pdh"),
    ("pdl", "tessera.concepts.pdl"),
    ("pdc", "tessera.concepts.pdc"),
];

pub fn migrated_chart_levels(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut changed = false;
    let mut out = o.clone();
    if let Some(levels) = o.get("levels").and_then(Value::as_object) {
        let mut next = serde_json::Map::new();
        for (k, x) in levels {
            if RETIRED_LEVEL_KEYS.contains(&k.as_str()) {
                changed = true;
            } else if !RENAMED_LEVEL_KEYS.iter().any(|(old, _)| old == k) {
                next.insert(k.clone(), x.clone());
            }
        }
        for (old, new) in RENAMED_LEVEL_KEYS {
            if let Some(x) = levels.get(old) {
                changed = true;
                next.entry(new.to_owned()).or_insert_with(|| x.clone());
            }
        }
        out.insert("levels".into(), Value::Object(next));
    }
    if let Some(sources) = o.get("sources").and_then(Value::as_object) {
        let mut next = serde_json::Map::new();
        for (k, x) in sources {
            match k.as_str() {
                "gamma" => changed = true,
                "prior" => {
                    changed = true;
                    next.entry("tessera.concepts".to_owned())
                        .or_insert_with(|| x.clone());
                }
                _ => {
                    next.insert(k.clone(), x.clone());
                }
            }
        }
        out.insert("sources".into(), Value::Object(next));
    }
    changed.then_some(Value::Object(out))
}

pub async fn migrate_chart_levels(settings: &Arc<SettingsService>) -> Result<(), ToolError> {
    let Some(stored) = settings.stored("chart.levels") else {
        return Ok(());
    };
    if let Some(next) = migrated_chart_levels(&stored) {
        settings
            .set("chart.levels", next, &tessera_core::Origin::User)
            .await?;
        tracing::info!("level settings moved onto level keys");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn old_level_settings_move_onto_level_keys() {
        let old = json!({
            "sources": {"gamma": false, "prior": true, "vwap": false},
            "levels": {
                "call_wall": {"color": "brass"},
                "gamma_flip": {"line": "dot"},
                "zero_gamma": {"on": false},
                "pdc": {"on": false},
                "vwap": {"color": "teal"},
                "acme.main.x": {"on": true}
            },
            "vwapBands": true
        });
        let new = migrated_chart_levels(&old).unwrap();
        assert_eq!(
            new,
            json!({
                "sources": {"tessera.concepts": true, "vwap": false},
                "levels": {
                    "tessera.concepts.pdc": {"on": false},
                    "vwap": {"color": "teal"},
                    "acme.main.x": {"on": true}
                },
                "vwapBands": true
            })
        );
        assert_eq!(migrated_chart_levels(&new), None);
        assert_eq!(
            migrated_chart_levels(&json!({"sources": {}, "levels": {}})),
            None
        );
        let schema = (crate::settings::SETTINGS
            .iter()
            .find(|d| d.key == "chart.levels")
            .unwrap()
            .schema)();
        assert!(crate::settings::validate(&schema, &new).is_ok());
    }
}
