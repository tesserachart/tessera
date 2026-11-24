use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::{Map, Value, json};
use tessera_core::clock::SharedClock;
use tessera_core::hash::hash_json;
use tessera_core::session::SessionCalendar;
use tessera_core::{InstrumentId, Origin, Timestamp};
use tessera_host::{EventBus, TopicKey};
use tessera_market::hub::MarketHub;
use tessera_market::io::SessionFilter;
use tessera_market::{MarketDataProvider, MarketRouter, market_error};
use tessera_protocol::indicators::{
    CustomIndicators, IndicatorGroup, IndicatorPlacement, IndicatorSpec, indicator_specs,
};
use tessera_protocol::layers::LayerKind;
use tessera_script::{IndicatorManifest, MAX_CODE, ScriptError};
use tessera_store::{CustomIndicatorRecord, CustomIndicatorVersion, Store, StoreError};
use tessera_tools::ToolError;
use tokio::sync::{Semaphore, broadcast};

use crate::cache::{FrameKey, INDICATOR_CACHE_BYTES, IndicatorCache, Lead, Resolved, Want};
use crate::frame::{BarKind, Grid, StudyId, StudyKey, Values};
use crate::io::{
    BuiltinIndicator, CatalogUpdate, ComputeInput, CustomIndicator, IndicatorDetail,
    IndicatorSeries, IndicatorVersionInfo, PreviewInput, SandboxStatus, SeriesPlot,
};
use crate::series::{SERIES_TOPIC, update_of};
use crate::studies::{ScriptStudy, native};

pub const CATALOG_TOPIC: &str = "indicators.catalog";
pub const MAX_BARS: u32 = 20_000;
const DEFAULT_LIMIT: u32 = 500;
const MAX_CONCURRENT_COMPUTATIONS: usize = 4;

#[derive(Clone, Debug)]
struct Entry {
    record: CustomIndicatorRecord,
    code: String,
    manifest: IndicatorManifest,
}

#[derive(Clone, Debug)]
pub(crate) struct Code {
    pub version: u32,
    pub code: String,
    pub manifest: IndicatorManifest,
}

pub fn spec_of(m: &IndicatorManifest) -> IndicatorSpec {
    IndicatorSpec {
        kind: LayerKind::Custom,
        title: m.title.clone(),
        short: m.short.clone(),
        group: IndicatorGroup::Custom,
        placement: m.placement,
        inputs: m.inputs.clone(),
        plots: m.plots.clone(),
        fills: m.fills.clone(),
        range: m.range.clone(),
        height: (m.placement == IndicatorPlacement::Pane).then_some(0.2),
        session_reset: false,
        reset_by: None,
        format: m.format,
    }
}

fn who(origin: &Origin) -> String {
    match origin {
        Origin::User => "user".into(),
        Origin::Agent { .. } => "agent".into(),
        Origin::External { .. } => "external".into(),
    }
}

pub fn script_error(e: ScriptError) -> ToolError {
    match &e {
        ScriptError::Internal { .. } => ToolError::internal(e.to_string()),
        ScriptError::Code { error } => ToolError::invalid_input(e.to_string()).with_details(json!({
            "kind": error.kind,
            "line": error.line,
            "column": error.column,
            "text": error.text,
            "frames": error.frames,
            "logs": error.logs,
        })),
        _ => ToolError::invalid_input(e.to_string())
            .with_details(json!({ "kind": serde_json::to_value(&e).ok().and_then(|v| v.get("kind").cloned()), "line": e.line() })),
    }
}

fn store_error(e: StoreError) -> ToolError {
    ToolError::internal(format!("indicator storage: {e}"))
}

pub struct IndicatorsService {
    store: Store,
    market: Arc<MarketRouter>,
    bus: Arc<EventBus>,
    permits: Arc<Semaphore>,
    cache: Arc<IndicatorCache>,
    calendars: RwLock<HashMap<InstrumentId, SessionCalendar>>,
    catalog: RwLock<BTreeMap<String, Entry>>,
    changes: broadcast::Sender<String>,
}

impl std::fmt::Debug for IndicatorsService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndicatorsService")
            .field("custom", &self.catalog.read().len())
            .finish_non_exhaustive()
    }
}

impl IndicatorsService {
    pub fn load(
        store: Store,
        market: Arc<MarketRouter>,
        hub: Option<Arc<MarketHub>>,
        bus: Arc<EventBus>,
        clock: SharedClock,
    ) -> Result<Arc<Self>, StoreError> {
        let mut catalog = BTreeMap::new();
        for (record, v) in store.custom_indicators().list()? {
            let read = serde_json::from_value::<IndicatorManifest>(v.manifest.clone())
                .map_err(|e| e.to_string())
                .and_then(|m| {
                    tessera_script::describe(&v.code)
                        .map(|_| m)
                        .map_err(|e| e.to_string())
                });
            match read {
                Ok(manifest) => {
                    catalog.insert(
                        record.id.clone(),
                        Entry {
                            record,
                            code: v.code,
                            manifest,
                        },
                    );
                }
                Err(e) => {
                    tracing::warn!(id = %record.id, error = %e, "skipping an unreadable custom indicator")
                }
            }
        }
        let (changes, _) = broadcast::channel(64);
        let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_COMPUTATIONS));
        let publisher = Arc::clone(&bus);
        let cache = IndicatorCache::new(
            Arc::clone(&market),
            hub,
            clock,
            Arc::clone(&permits),
            INDICATOR_CACHE_BYTES,
            Arc::new(move |key, provider, p| {
                publisher.publish(
                    SERIES_TOPIC,
                    TopicKey::Id(p.watch.0.clone()),
                    &update_of(key, provider, p),
                );
            }),
        );
        cache.spawn_written_listener();
        Ok(Arc::new(Self {
            store,
            market,
            bus,
            permits,
            cache,
            calendars: RwLock::new(HashMap::new()),
            catalog: RwLock::new(catalog),
            changes,
        }))
    }

    pub(crate) fn cache(&self) -> &Arc<IndicatorCache> {
        &self.cache
    }

    pub(crate) fn bus(&self) -> &Arc<EventBus> {
        &self.bus
    }

    pub fn market(&self) -> &Arc<MarketRouter> {
        &self.market
    }

    pub fn status(&self) -> SandboxStatus {
        SandboxStatus {
            available: true,
            reason: None,
            engine: tessera_script::ENGINE.to_owned(),
            walls: tessera_script::walls(),
        }
    }

    async fn engine<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> Result<T, ScriptError> + Send + 'static,
    ) -> Result<T, ScriptError> {
        let _permit = Arc::clone(&self.permits)
            .acquire_owned()
            .await
            .map_err(|e| ScriptError::internal(e.to_string()))?;
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| ScriptError::internal(e.to_string()))?
    }

    pub(crate) async fn calendar(&self, id: &InstrumentId) -> SessionCalendar {
        if let Some(c) = self.calendars.read().get(id) {
            return *c;
        }
        match self.market.spec(id).await {
            Ok((_, spec)) => {
                self.calendars.write().insert(id.clone(), spec.sessions);
                spec.sessions
            }
            Err(_) => SessionCalendar::CmeGlobex,
        }
    }

    pub fn builtins() -> Vec<BuiltinIndicator> {
        indicator_specs()
            .into_iter()
            .map(|spec| BuiltinIndicator {
                kind: spec.kind,
                description: spec.kind.spec().description,
                spec,
            })
            .collect()
    }

    fn summary(
        record: &CustomIndicatorRecord,
        version: u32,
        manifest: &IndicatorManifest,
    ) -> CustomIndicator {
        CustomIndicator {
            id: record.id.clone(),
            version,
            latest: record.latest,
            spec: spec_of(manifest),
            description: manifest.description.clone(),
            created_at: record.created_at,
            updated_at: record.updated_at,
            created_by: record.created_by.clone(),
        }
    }

    pub fn custom(&self) -> Vec<CustomIndicator> {
        let mut v: Vec<CustomIndicator> = self
            .catalog
            .read()
            .values()
            .map(|e| Self::summary(&e.record, e.record.latest, &e.manifest))
            .collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        v
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<String> {
        self.changes.subscribe()
    }

    fn changed(&self, id: &str) {
        let _ = self.changes.send(id.to_owned());
        self.bus.publish(
            CATALOG_TOPIC,
            TopicKey::Id("catalog".into()),
            &CatalogUpdate {
                custom: self.custom(),
            },
        );
    }

    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(Store) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, ToolError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || f(store))
            .await
            .map_err(|e| ToolError::internal(e.to_string()))?
            .map_err(store_error)
    }

    pub(crate) async fn code_of(&self, id: &str, version: Option<u32>) -> Result<Code, ToolError> {
        let latest = self.catalog.read().get(id).cloned();
        let Some(entry) = latest else {
            return Err(ToolError::not_found(format!(
                "no custom indicator {id}; indicators.list lists them"
            )));
        };
        match version {
            Some(v) if v != entry.record.latest => {
                let id2 = id.to_owned();
                let found = self
                    .blocking(move |s| s.custom_indicators().version(&id2, Some(v)))
                    .await?
                    .ok_or_else(|| ToolError::not_found(format!("{id} has no version {v}")))?;
                let manifest = serde_json::from_value(found.manifest)
                    .map_err(|e| ToolError::internal(format!("version {v} of {id}: {e}")))?;
                Ok(Code {
                    version: v,
                    code: found.code,
                    manifest,
                })
            }
            _ => Ok(Code {
                version: entry.record.latest,
                code: entry.code,
                manifest: entry.manifest,
            }),
        }
    }

    pub async fn get(&self, id: &str, version: Option<u32>) -> Result<IndicatorDetail, ToolError> {
        if let Some(kind) = LayerKind::parse(id)
            && let Some(b) = Self::builtins().into_iter().find(|b| b.kind == kind)
        {
            return Ok(IndicatorDetail {
                builtin: Some(b),
                custom: None,
                code: None,
                versions: Vec::new(),
            });
        }
        let Code {
            version: v,
            code,
            manifest,
        } = self.code_of(id, version).await?;
        let record = self
            .catalog
            .read()
            .get(id)
            .map(|e| e.record.clone())
            .ok_or_else(|| ToolError::not_found(format!("no custom indicator {id}")))?;
        let id2 = id.to_owned();
        let versions = self
            .blocking(move |s| s.custom_indicators().versions(&id2))
            .await?
            .into_iter()
            .map(|v: CustomIndicatorVersion| IndicatorVersionInfo {
                version: v.version,
                created_at: v.created_at,
                created_by: v.created_by,
                note: v.note,
            })
            .collect();
        Ok(IndicatorDetail {
            builtin: None,
            custom: Some(Self::summary(&record, v, &manifest)),
            code: Some(code),
            versions,
        })
    }

    async fn describe(&self, code: &str) -> Result<IndicatorManifest, ToolError> {
        if code.len() > MAX_CODE {
            return Err(ToolError::invalid_input("the code is longer than 256 KB"));
        }
        let code = code.to_owned();
        self.engine(move || tessera_script::describe(&code))
            .await
            .map_err(script_error)
    }

    pub async fn create(
        &self,
        code: &str,
        note: Option<String>,
        origin: &Origin,
        now: Timestamp,
    ) -> Result<IndicatorDetail, ToolError> {
        let manifest = self.describe(code).await?;
        let id = tessera_core::ids::unique("ci_");
        let by = who(origin);
        let (id2, code2, m2, by2, note2) = (
            id.clone(),
            code.to_owned(),
            serde_json::to_value(&manifest).map_err(|e| ToolError::internal(e.to_string()))?,
            by.clone(),
            note.clone(),
        );
        let title = manifest.title.clone();
        self.blocking(move |s| {
            s.custom_indicators()
                .create(&id2, &title, &code2, &m2, note2.as_deref(), &by2, now)
        })
        .await?;
        self.catalog.write().insert(
            id.clone(),
            Entry {
                record: CustomIndicatorRecord {
                    id: id.clone(),
                    name: manifest.title.clone(),
                    latest: 1,
                    created_at: now,
                    updated_at: now,
                    created_by: by,
                },
                code: code.to_owned(),
                manifest,
            },
        );
        self.changed(&id);
        self.get(&id, None).await
    }

    pub async fn update(
        &self,
        id: &str,
        code: &str,
        note: Option<String>,
        base: Option<u32>,
        origin: &Origin,
        now: Timestamp,
    ) -> Result<IndicatorDetail, ToolError> {
        if !self.catalog.read().contains_key(id) {
            return Err(ToolError::not_found(format!(
                "no custom indicator {id}; indicators.list lists them"
            )));
        }
        let manifest = self.describe(code).await?;
        let by = who(origin);
        let (id2, code2, m2, by2, title) = (
            id.to_owned(),
            code.to_owned(),
            serde_json::to_value(&manifest).map_err(|e| ToolError::internal(e.to_string()))?,
            by.clone(),
            manifest.title.clone(),
        );
        let saved = {
            let store = self.store.clone();
            tokio::task::spawn_blocking(move || {
                store.custom_indicators().add_version(
                    &id2,
                    base,
                    &title,
                    &code2,
                    &m2,
                    note.as_deref(),
                    &by2,
                    now,
                )
            })
            .await
            .map_err(|e| ToolError::internal(e.to_string()))?
        };
        let version = match saved {
            Ok(Some(v)) => v,
            Ok(None) => return Err(ToolError::not_found(format!("no custom indicator {id}"))),
            Err(StoreError::Conflict { expected, actual }) => {
                return Err(ToolError::conflict(format!(
                    "{id} was saved as version {actual} since version {expected}; get it again and reapply the change"
                )));
            }
            Err(e) => return Err(store_error(e)),
        };
        {
            let mut cache = self.catalog.write();
            if let Some(e) = cache.get_mut(id) {
                e.record.latest = version;
                e.record.name = manifest.title.clone();
                e.record.updated_at = now;
                e.code = code.to_owned();
                e.manifest = manifest;
            }
        }
        self.changed(id);
        self.get(id, None).await
    }

    pub async fn delete(&self, id: &str) -> Result<bool, ToolError> {
        let id2 = id.to_owned();
        let deleted = self
            .blocking(move |s| s.custom_indicators().delete(&id2))
            .await?;
        self.catalog.write().remove(id);
        if deleted {
            self.changed(id);
        }
        Ok(deleted)
    }

    pub(crate) async fn grid(&self, key: &FrameKey) -> Grid {
        Grid {
            calendar: self.calendar(&key.instrument).await,
            bars: key.bars,
            session: key.session,
        }
    }

    pub(crate) async fn resolve(
        &self,
        indicator: &str,
        version: Option<u32>,
        inputs: &Map<String, Value>,
    ) -> Result<(Resolved, Described), ToolError> {
        if let Some(kind) = LayerKind::parse(indicator) {
            return builtin(kind, inputs);
        }
        let code = self.code_of(indicator, version).await?;
        let used = used_inputs(&code.manifest, inputs);
        let columns = code
            .manifest
            .series_keys()
            .iter()
            .map(|k| (*k).to_owned())
            .collect();
        let resolved = Resolved {
            key: StudyKey {
                id: StudyId::Custom {
                    id: indicator.to_owned(),
                    version: code.version,
                },
                params: hash_json(&Value::Object(used.clone())),
            },
            study: Arc::new(ScriptStudy::new(&code.code, used.clone(), columns)),
        };
        Ok((
            resolved,
            Described {
                spec: spec_of(&code.manifest),
                description: code.manifest.description.clone(),
                used,
            },
        ))
    }

    pub async fn compute(&self, input: ComputeInput) -> Result<IndicatorSeries, ToolError> {
        let instrument = self
            .market
            .resolve(&input.instrument)
            .await
            .map_err(market_error)?;
        let key = FrameKey {
            instrument,
            bars: BarKind::Time(input.tf),
            session: input.session.unwrap_or_default(),
        };
        let grid = self.grid(&key).await;
        let inputs = input.inputs.unwrap_or_default();
        let (study, described) = self
            .resolve(&input.indicator, input.version, &inputs)
            .await?;
        let want = Want {
            from: input.from.map(|t| t.0),
            to: input.to.map(|t| t.0),
            limit: input.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_BARS) as usize,
        };
        let version = study.key.version();
        let keys = plot_keys(&study);
        let (provider, values) = self.cache.read(&key, grid, study, want).await?;
        series_of(
            &input.indicator,
            version,
            &key,
            described,
            values,
            &keys,
            provider,
            input.tail,
        )
    }

    pub async fn preview(&self, input: PreviewInput) -> Result<IndicatorSeries, ToolError> {
        let manifest = self.describe(&input.code).await?;
        let instrument = self
            .market
            .resolve(&input.instrument)
            .await
            .map_err(market_error)?;
        let key = FrameKey {
            instrument,
            bars: BarKind::Time(input.tf),
            session: SessionFilter::All,
        };
        let grid = self.grid(&key).await;
        let used = used_inputs(&manifest, &input.inputs.unwrap_or_default());
        let columns = manifest
            .series_keys()
            .iter()
            .map(|k| (*k).to_owned())
            .collect();
        let study = Resolved {
            key: StudyKey {
                id: StudyId::Custom {
                    id: String::new(),
                    version: 0,
                },
                params: String::new(),
            },
            study: Arc::new(ScriptStudy::new(&input.code, used.clone(), columns)),
        };
        let want = Want {
            from: None,
            to: None,
            limit: input.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_BARS) as usize,
        };
        let keys = plot_keys(&study);
        let (provider, values) = self
            .cache
            .transient(&key, grid, study, want, Lead::None)
            .await?;
        let described = Described {
            spec: spec_of(&manifest),
            description: manifest.description.clone(),
            used,
        };
        series_of(
            "", None, &key, described, values, &keys, provider, input.tail,
        )
    }
}

pub(crate) struct Described {
    pub spec: IndicatorSpec,
    pub description: Option<String>,
    pub used: Map<String, Value>,
}

fn used_inputs(manifest: &IndicatorManifest, given: &Map<String, Value>) -> Map<String, Value> {
    manifest
        .inputs
        .iter()
        .map(|i| {
            let v = given
                .get(&i.key)
                .cloned()
                .unwrap_or_else(|| i.default.clone());
            (i.key.clone(), v)
        })
        .collect()
}

fn builtin(
    kind: LayerKind,
    inputs: &Map<String, Value>,
) -> Result<(Resolved, Described), ToolError> {
    let spec = tessera_protocol::indicators::indicator_spec(kind)
        .ok_or_else(|| ToolError::unsupported(format!("{kind} is not an indicator")))?;
    let normalized =
        tessera_protocol::indicators::normalize_params(&spec, &json!({ "inputs": inputs }))
            .map_err(|e| ToolError::invalid_input(format!("{kind} inputs: {e}")))?;
    let used = normalized
        .get("inputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let study = native(kind, &used).ok_or_else(|| {
        ToolError::unsupported(format!(
            "{kind} is drawn on the chart from data it reads itself; read it with the market and concepts tools (market.get_footprint, market.get_volume_profile, market.get_big_trades, concepts.get_levels)"
        ))
    })?;
    let resolved = Resolved {
        key: StudyKey {
            id: StudyId::Builtin(kind),
            params: tessera_core::hash::sha256_hex(format!("{study:?}").as_bytes()),
        },
        study,
    };
    Ok((
        resolved,
        Described {
            description: Some(kind.spec().description),
            spec,
            used,
        },
    ))
}

fn plot_keys(study: &Resolved) -> Vec<String> {
    study
        .study
        .columns()
        .iter()
        .map(|c| study.study.plot_key(c).to_owned())
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn series_of(
    indicator: &str,
    version: Option<u32>,
    key: &FrameKey,
    described: Described,
    values: Values,
    keys: &[String],
    provider: String,
    tail: Option<u32>,
) -> Result<IndicatorSeries, ToolError> {
    if let Some(e) = values.error {
        return Err(script_error(e));
    }
    let n = values.time.len();
    let skip = tail.map_or(0, |t| n.saturating_sub(t as usize));
    let label = |k: &str| {
        described
            .spec
            .plots
            .iter()
            .find(|p| p.key == k)
            .map_or_else(|| k.to_owned(), |p| p.label.clone())
    };
    let plots = values
        .columns
        .iter()
        .zip(keys)
        .map(|((_, v), k)| SeriesPlot {
            key: k.clone(),
            label: label(k),
            values: v[skip..]
                .iter()
                .map(|x| x.is_finite().then_some(*x))
                .collect(),
        })
        .collect();
    let drawn = values.drawn.as_deref().cloned().unwrap_or_default();
    let objects = match values.time.get(skip) {
        Some(first) if skip > 0 => drawn.objects.since(Timestamp(*first)),
        _ => drawn.objects,
    };
    Ok(IndicatorSeries {
        indicator: indicator.to_owned(),
        version,
        spec: described.spec,
        description: described.description,
        instrument: key.instrument.clone(),
        tf: key.tf().unwrap_or(tessera_core::Timeframe::M1),
        inputs: described.used,
        time: values.time[skip..].iter().map(|t| Timestamp(*t)).collect(),
        plots,
        objects,
        bars: values.rows as u32,
        computed_from: values.computed_from.map(Timestamp),
        compute_ms: values.compute_ms,
        cpu_ms: values.compute_ms,
        logs: drawn.logs,
        provider,
    })
}

impl CustomIndicators for IndicatorsService {
    fn custom_spec(&self, id: &str, version: Option<u32>) -> Result<IndicatorSpec, String> {
        let entry = self
            .catalog
            .read()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no custom indicator {id}; indicators.list lists them"))?;
        match version {
            None => Ok(spec_of(&entry.manifest)),
            Some(v) if v == entry.record.latest => Ok(spec_of(&entry.manifest)),
            Some(v) => {
                let found = self
                    .store
                    .custom_indicators()
                    .version(id, Some(v))
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("{id} has no version {v}"))?;
                let manifest: IndicatorManifest =
                    serde_json::from_value(found.manifest).map_err(|e| e.to_string())?;
                Ok(spec_of(&manifest))
            }
        }
    }
}
