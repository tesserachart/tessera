use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tessera_core::ids::SessionId;
use tessera_core::{InstrumentId, Origin, SharedClock, Timeframe, Timestamp};
use tessera_host::{EventBus, TopicKey};
use tessera_market::{
    ConnectionRef, MarketDataProvider, MarketError, MarketRouter, exchange_contract,
};
use tessera_protocol::indicators::merge_patch;
use tessera_protocol::indicators::{CustomIndicators, custom_ref, normalize_custom_params};
use tessera_protocol::io::{
    ChartAddLayerInput, ChartAnnotateInput, ChartChangeOutput, ChartClearAnnotationsInput,
    ChartStateOutput, ChartUpdateLayerInput, LayerKindEntry, LayerKindsInput, LayerKindsOutput,
    LayoutChartBrief, LayoutDeleteOutput, LayoutListOutput, LayoutSaveInput, LayoutSaveOutput,
    LayoutSummary, OpenTileKind, RemovedOutput, TileRequest, TileRequestParams,
    WorkspaceOpenTileInput, WorkspaceOpenTileOutput,
};
use tessera_protocol::layers::{LayerKind, LayerRequirement};
use tessera_protocol::layout::{
    Annotation, AnnotationKind, ChartHours, ChartLayer, ChartState, ChartType, Layout, LayoutEvent,
    OverlayNamespace, Viewport,
};
use tessera_protocol::templates::{self, ChartTemplate};
use tessera_protocol::topics::names;
use tessera_store::Store;
use tessera_tools::ToolError;

mod dock;
mod document;
mod drawings;

pub use dock::{MARKETS_IS_AN_AREA, MAX_CHARTS, dock_requests, dock_tiles};

pub const DEFAULT_LAYOUT: &str = "default";

pub const DOCK_VIEW_KEY: &str = "tessera";

pub const ORDER_FLOW_TEMPLATE: &str = "Order flow";
pub const ORDER_FLOW_TEMPLATE_ID: &str = "order-flow";

pub fn order_flow_template() -> tessera_protocol::templates::ChartTemplate {
    tessera_protocol::templates::ChartTemplate {
        id: ORDER_FLOW_TEMPLATE_ID.into(),
        name: ORDER_FLOW_TEMPLATE.into(),
        chart_type: None,
        layers: ["footprint", "volume_profile", "big_trades", "delta"]
            .into_iter()
            .map(|k| tessera_protocol::templates::TemplateLayer {
                kind: k.to_owned(),
                params: Value::Null,
                visible: true,
            })
            .collect(),
    }
}

pub fn shares_interval(dock: &Value) -> bool {
    dock.get(DOCK_VIEW_KEY)
        .and_then(|v| v.get("syncInterval"))
        .and_then(Value::as_bool)
        == Some(true)
}

const LINK_GROUPS: [&str; 4] = ["1", "2", "3", "4"];

pub fn tile_requests(dock: &Value) -> Vec<TileRequest> {
    dock.get(DOCK_VIEW_KEY)
        .and_then(|v| v.get("open"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| serde_json::from_value(r.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn with_tile_request(dock: &Value, request: &TileRequest) -> Result<Value, ToolError> {
    let entry = serde_json::to_value(request).map_err(|e| ToolError::internal(e.to_string()))?;
    Ok(push_view_entry(dock, "open", entry))
}

fn push_view_entry(dock: &Value, list: &str, entry: Value) -> Value {
    let mut root = match dock {
        Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };
    let mut view = match root.remove(DOCK_VIEW_KEY) {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    let mut entries = match view.remove(list) {
        Some(Value::Array(a)) => a,
        _ => Vec::new(),
    };
    entries.push(entry);
    view.insert(list.into(), Value::Array(entries));
    root.insert(DOCK_VIEW_KEY.into(), Value::Object(view));
    Value::Object(root)
}

pub const PENDING_KEY: &str = "layout.pendingCharts";

pub const CHARTS_SOURCE_KEY: &str = "layout.chartsDataSource";

pub fn charts_routing(market: &MarketRouter) -> Option<String> {
    let default = market.data_source()?.id;
    let mut out = default.clone();
    for exchange in market.exchange_choices().keys() {
        if let Some(c) = market.data_source_for(exchange)
            && c.id != default
        {
            out.push_str(&format!(" {exchange}={}", c.id));
        }
    }
    Some(out)
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PendingChart {
    pub tile: String,
    pub root: String,
}

const DEFAULT_CHARTS: [(&str, &str); 2] = [("chart-1", "NQ"), ("chart-2", "ES")];

fn default_chart(tile: &str, instrument: InstrumentId) -> ChartState {
    let (title, timeframe) = if tile == "chart-1" {
        ("Chart 1", Timeframe::M5)
    } else {
        ("Chart 2", Timeframe::M1)
    };
    chart(tile, title, instrument, timeframe, Vec::new())
}

pub struct LayoutService {
    store: Store,
    bus: Arc<EventBus>,
    market: Arc<MarketRouter>,
    clock: SharedClock,
    layouts: Mutex<HashMap<String, Layout>>,
    saved: Mutex<HashMap<String, Layout>>,
    recovered: Mutex<HashSet<String>>,
    active: Mutex<String>,
    writes: Arc<tokio::sync::Mutex<()>>,
    pending: Mutex<Vec<PendingChart>>,
    charts_source: Mutex<Option<String>>,
    custom: Mutex<Option<Arc<dyn CustomIndicators>>>,
    drawn: Mutex<HashSet<(String, String)>>,
    viewport_reports: tokio::sync::Notify,
}

impl std::fmt::Debug for LayoutService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LayoutService")
            .field("active", &*self.active.lock())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
fn layer(id: &str, kind: &str, params: Value) -> ChartLayer {
    ChartLayer {
        id: id.into(),
        kind: kind.into(),
        params,
        visible: true,
        namespace: OverlayNamespace::User,
        session_id: None,
    }
}

fn chart(
    tile: &str,
    title: &str,
    instrument: InstrumentId,
    tf: Timeframe,
    layers: Vec<ChartLayer>,
) -> ChartState {
    ChartState {
        tile_id: tile.into(),
        title: title.into(),
        instrument,
        timeframe: tf,
        print_bars: None,
        layers,
        annotations: Vec::new(),
        viewport: None,
        link_group: None,
        chart_type: None,
        hours: None,
        drawings: Vec::new(),
        drawings_from: Vec::new(),
    }
}

async fn read_pending(store: &Store) -> Vec<PendingChart> {
    let s = store.clone();
    match tokio::task::spawn_blocking(move || s.settings().get(PENDING_KEY)).await {
        Ok(Ok(Some(v))) => serde_json::from_value(v).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "ignoring unreadable waiting charts");
            Vec::new()
        }),
        _ => Vec::new(),
    }
}

async fn persist_layout(
    store: Store,
    layout: Layout,
    saved: Option<Layout>,
) -> Result<(), ToolError> {
    tokio::task::spawn_blocking(move || store.layouts().put(&layout, saved.as_ref()))
        .await
        .map_err(|e| ToolError::internal(e.to_string()))?
        .map_err(|e| ToolError::internal(format!("could not store layout: {e}")))
}

fn publish_layout(bus: &EventBus, event: &LayoutEvent) {
    bus.publish(
        names::LAYOUT,
        TopicKey::Layout(event.layout_id.clone()),
        event,
    );
}

enum ChartRoute {
    Stays,
    Waits,
    MovesTo(InstrumentId),
}

impl ChartRoute {
    fn waits_if_unavailable(e: &MarketError) -> Self {
        if matches!(e, MarketError::Unavailable(_)) {
            ChartRoute::Waits
        } else {
            ChartRoute::Stays
        }
    }
}

async fn persist_and_publish(
    _serial: tokio::sync::OwnedMutexGuard<()>,
    store: Store,
    bus: Arc<EventBus>,
    event: LayoutEvent,
    saved: Option<Layout>,
) -> Result<(), ToolError> {
    persist_layout(store, event.layout.clone(), saved).await?;
    publish_layout(&bus, &event);
    Ok(())
}

struct Placeholder<'a> {
    layouts: &'a Mutex<HashMap<String, Layout>>,
    id: String,
}

impl Drop for Placeholder<'_> {
    fn drop(&mut self) {
        let mut layouts = self.layouts.lock();
        if layouts.get(&self.id).is_some_and(|l| l.revision == 0) {
            layouts.remove(&self.id);
        }
    }
}

fn drop_unknown_layers(charts: &mut BTreeMap<String, ChartState>) {
    for c in charts.values_mut() {
        c.layers.retain(|l| LayerKind::parse(&l.kind).is_some());
    }
}

fn normalize_layers(charts: &mut BTreeMap<String, ChartState>) {
    for c in charts.values_mut() {
        for l in &mut c.layers {
            let Some(kind) = LayerKind::parse(&l.kind) else {
                continue;
            };
            if kind.indicator().is_none() {
                continue;
            }
            if let Ok(p) = kind.validate_params(&l.params) {
                l.params = p;
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LegacyVwapLevels {
    pub hidden: bool,
    pub color: Option<String>,
    pub bands: bool,
}

impl LegacyVwapLevels {
    pub fn from_setting(levels: Option<&Value>) -> Self {
        let Some(l) = levels else {
            return Self::default();
        };
        let vwap = &l["levels"]["vwap"];
        Self {
            hidden: l["sources"]["vwap"] == json!(false) || vwap["on"] == json!(false),
            color: vwap["color"]
                .as_str()
                .filter(|c| *c != "mist" && tessera_protocol::indicators::is_color(c))
                .map(str::to_owned),
            bands: l["vwapBands"] == json!(true),
        }
    }
}

fn carry_legacy_vwap(charts: &mut BTreeMap<String, ChartState>, legacy: &LegacyVwapLevels) {
    for c in charts.values_mut() {
        for l in c.layers.iter_mut().filter(|l| l.kind == "vwap") {
            let legacy_shape = match &l.params {
                Value::Null => true,
                Value::Object(o) => !o.contains_key("inputs") && !o.contains_key("style"),
                _ => false,
            };
            if !legacy_shape {
                continue;
            }
            let listed = l.params.get("bands").map_or(0, |b| {
                tessera_protocol::indicators::legacy_vwap_mults(b).len()
            });
            let mut params = tessera_protocol::indicators::migrate_legacy(
                LayerKind::Vwap,
                &if l.params.is_null() {
                    json!({})
                } else {
                    l.params.clone()
                },
            );
            if legacy.bands {
                for n in 1..=listed {
                    params["inputs"][format!("band{n}")] = json!(true);
                }
            }
            if let Some(color) = &legacy.color {
                for key in [
                    "vwap", "upper1", "lower1", "upper2", "lower2", "upper3", "lower3",
                ] {
                    params["style"]["plots"][key] = json!({ "color": color });
                }
            }
            l.params = params;
            if legacy.hidden {
                l.visible = false;
            }
        }
    }
}

fn namespace_of(origin: &Origin) -> (OverlayNamespace, Option<SessionId>) {
    match origin {
        Origin::User => (OverlayNamespace::User, None),
        Origin::Agent { session_id, .. } => (OverlayNamespace::Agent, Some(session_id.clone())),
        Origin::External { .. } => (OverlayNamespace::Agent, None),
    }
}

impl LayoutService {
    pub async fn load(
        store: Store,
        bus: Arc<EventBus>,
        market: Arc<MarketRouter>,
        clock: SharedClock,
        active: String,
        legacy_vwap: LegacyVwapLevels,
    ) -> Result<Arc<Self>, ToolError> {
        let s = store.clone();
        let stored: Vec<(Layout, Option<Layout>)> = tokio::task::spawn_blocking(move || {
            let repo = s.layouts();
            let mut out = Vec::new();
            for (id, _, _) in repo.list()? {
                if let Some(l) = repo.get(&id)? {
                    out.push((l, repo.saved(&id)?));
                }
            }
            Ok::<_, tessera_store::StoreError>(out)
        })
        .await
        .map_err(|e| ToolError::internal(e.to_string()))?
        .map_err(|e| ToolError::internal(e.to_string()))?;
        let pending = read_pending(&store).await;
        let charts_source = {
            let s = store.clone();
            match tokio::task::spawn_blocking(move || s.settings().get(CHARTS_SOURCE_KEY)).await {
                Ok(Ok(Some(Value::String(id)))) => Some(id),
                _ => None,
            }
        };
        let mut migrated = Vec::new();
        let mut saved = HashMap::new();
        let mut layouts = HashMap::new();
        for (mut l, kept) in stored {
            let before = l.charts.clone();
            Self::migrate_charts(&mut l, &legacy_vwap);
            if l.charts != before {
                migrated.push(l.id.clone());
            }
            let kept = kept
                .map(|mut k| {
                    Self::migrate_charts(&mut k, &legacy_vwap);
                    k
                })
                .filter(|k| !document::same_document(k, &l));
            l.unsaved = kept.is_some();
            if let Some(k) = kept {
                saved.insert(l.id.clone(), k);
            }
            layouts.insert(l.id.clone(), l);
        }
        let recovered: HashSet<String> = saved.keys().cloned().collect();
        let svc = Arc::new(Self {
            store,
            bus,
            market,
            clock,
            layouts: Mutex::new(layouts),
            saved: Mutex::new(saved),
            recovered: Mutex::new(recovered),
            active: Mutex::new(active),
            writes: Arc::new(tokio::sync::Mutex::new(())),
            pending: Mutex::new(pending),
            charts_source: Mutex::new(charts_source),
            custom: Mutex::new(None),
            drawn: Mutex::new(HashSet::new()),
            viewport_reports: tokio::sync::Notify::new(),
        });
        for id in migrated {
            svc.persist(&id).await?;
        }
        if !svc.layouts.lock().contains_key(DEFAULT_LAYOUT) {
            let l = svc.default_layout();
            svc.layouts.lock().insert(l.id.clone(), l.clone());
            svc.persist(&l.id).await?;
            *svc.pending.lock() = DEFAULT_CHARTS
                .iter()
                .map(|(tile, root)| PendingChart {
                    tile: (*tile).to_owned(),
                    root: (*root).to_owned(),
                })
                .collect();
            svc.save_pending().await;
        }
        Ok(svc)
    }

    fn migrate_charts(l: &mut Layout, legacy_vwap: &LegacyVwapLevels) {
        drop_unknown_layers(&mut l.charts);
        carry_legacy_vwap(&mut l.charts, legacy_vwap);
        normalize_layers(&mut l.charts);
        drawings::normalize_drawings(&mut l.charts);
    }

    fn default_layout(&self) -> Layout {
        Layout {
            id: DEFAULT_LAYOUT.into(),
            name: "Day · NQ/ES".into(),
            revision: 1,
            updated_at: self.clock.now(),
            active_chart_id: None,
            dock: Value::Null,
            charts: BTreeMap::new(),
            trade: Value::Null,
            unsaved: false,
        }
    }

    pub async fn place_pending_charts(&self) -> bool {
        let pending = self.pending.lock().clone();
        if pending.is_empty() {
            return false;
        }
        let before = pending.len();
        for PendingChart { tile, root } in pending {
            let free = self
                .layouts
                .lock()
                .get(DEFAULT_LAYOUT)
                .is_some_and(|l| !l.charts.contains_key(&tile));
            if free {
                let Ok(id) = self.market.resolve(&root).await else {
                    continue;
                };
                let chart = default_chart(&tile, id);
                let placed = self
                    .mutate_kept(
                        Some(DEFAULT_LAYOUT),
                        "layout.save",
                        &Origin::User,
                        Some(&tile),
                        |l| {
                            if l.charts.contains_key(&tile) {
                                return Err(ToolError::conflict("the tile was filled meanwhile"));
                            }
                            l.charts.insert(tile.clone(), chart.clone());
                            if l.active_chart_id.is_none() {
                                l.active_chart_id = Some(tile.clone());
                            }
                            Ok(())
                        },
                    )
                    .await;
                if let Err(e) = placed
                    && e.code != tessera_protocol::tools::ToolErrorCode::Conflict
                {
                    tracing::warn!(tile, error = %e.message, "could not place a chart of the default layout");
                    continue;
                }
            }
            self.pending.lock().retain(|c| c.tile != tile);
        }
        if self.pending.lock().len() != before {
            self.save_pending().await;
        }
        !self.pending.lock().is_empty()
    }

    async fn chart_route(
        &self,
        from: &InstrumentId,
        default: &ConnectionRef,
        by_exchange: bool,
    ) -> ChartRoute {
        let on = match self.market.serving(from).await {
            Ok(c) => c,
            Err(e) => return ChartRoute::waits_if_unavailable(&e),
        };
        if !by_exchange && on.id == default.id {
            return ChartRoute::Stays;
        }
        let instrument = match self.market.spec(from).await {
            Ok((i, _)) => i,
            Err(e) => return ChartRoute::waits_if_unavailable(&e),
        };
        let Some(target) = self.market.data_source_for(&instrument.exchange) else {
            return ChartRoute::Stays;
        };
        if on.id == target.id {
            return ChartRoute::Stays;
        }
        let Some(want) = exchange_contract(&instrument) else {
            return ChartRoute::Stays;
        };
        match self.market.contract_on(&target.id, &want).await {
            Ok(Some(i)) if i.id == *from => ChartRoute::Stays,
            Ok(Some(i)) => ChartRoute::MovesTo(i.id),
            Ok(None) => ChartRoute::Stays,
            Err(e) => ChartRoute::waits_if_unavailable(&e),
        }
    }

    pub async fn follow_data_source(&self) -> bool {
        let Some(routing) = charts_routing(&self.market) else {
            return false;
        };
        if self.charts_source.lock().as_deref() == Some(routing.as_str()) {
            return false;
        }
        let Some(default) = self.market.data_source() else {
            return false;
        };
        let by_exchange = !self.market.exchange_choices().is_empty();
        let charts: Vec<(String, String, InstrumentId)> = self
            .layouts
            .lock()
            .values()
            .filter(|l| l.revision > 0)
            .flat_map(|l| {
                l.charts
                    .values()
                    .map(|c| (l.id.clone(), c.tile_id.clone(), c.instrument.clone()))
            })
            .collect();
        let mut waiting = false;
        for (layout, tile, from) in charts {
            let to = match self.chart_route(&from, &default, by_exchange).await {
                ChartRoute::Stays => continue,
                ChartRoute::Waits => {
                    waiting = true;
                    continue;
                }
                ChartRoute::MovesTo(to) => to,
            };
            let moved = self
                .mutate_kept(
                    Some(&layout),
                    "chart.set_symbol",
                    &Origin::User,
                    Some(&tile),
                    |l| match l.charts.get_mut(&tile) {
                        Some(c) if c.instrument == from => {
                            c.instrument = to.clone();
                            c.viewport = None;
                            for d in c.drawings.iter_mut().filter(|d| d.instrument == from) {
                                d.instrument = to.clone();
                            }
                            for a in c.annotations.iter_mut() {
                                if a.instrument.as_ref() == Some(&from) {
                                    a.instrument = Some(to.clone());
                                }
                            }
                            Ok(())
                        }
                        _ => Err(ToolError::conflict("the chart moved meanwhile")),
                    },
                )
                .await;
            if let Err(e) = moved
                && e.code != tessera_protocol::tools::ToolErrorCode::Conflict
            {
                tracing::warn!(tile, error = %e.message, "could not move a chart onto the chosen market data");
                waiting = true;
            }
        }
        if !waiting {
            *self.charts_source.lock() = Some(routing.clone());
            let (store, now) = (self.store.clone(), self.clock.now());
            let kept = routing.clone();
            let saved = tokio::task::spawn_blocking(move || {
                store.settings().set(CHARTS_SOURCE_KEY, &json!(kept), now)
            })
            .await;
            if let Ok(Err(e)) = saved {
                tracing::warn!(error = %e, "could not store the charts' market data");
            }
            tracing::info!(routing = %routing, "charts follow the chosen market data");
        }
        waiting
    }

    async fn save_pending(&self) {
        let pending = self.pending.lock().clone();
        let (store, now) = (self.store.clone(), self.clock.now());
        let saved = tokio::task::spawn_blocking(move || {
            if pending.is_empty() {
                store.settings().delete(PENDING_KEY).map(|_| ())
            } else {
                store.settings().set(PENDING_KEY, &json!(pending), now)
            }
        })
        .await;
        if let Ok(Err(e)) = saved {
            tracing::warn!(error = %e, "could not store the waiting charts");
        }
    }

    pub fn active_id(&self) -> String {
        self.active.lock().clone()
    }

    pub fn active_chart_instrument(&self) -> Option<InstrumentId> {
        let active = self.active.lock().clone();
        self.layouts
            .lock()
            .get(&active)
            .and_then(|l| l.resolve_chart(None))
            .map(|c| c.instrument.clone())
    }

    pub fn last_chart_instrument(&self) -> Option<InstrumentId> {
        self.active_chart_instrument().or_else(|| {
            self.layouts
                .lock()
                .values()
                .filter(|l| l.revision > 0)
                .max_by_key(|l| l.updated_at)
                .and_then(|l| l.resolve_chart(None))
                .map(|c| c.instrument.clone())
        })
    }

    pub fn set_active(&self, id: &str) -> bool {
        if !self.layouts.lock().contains_key(id) {
            return false;
        }
        *self.active.lock() = id.to_owned();
        true
    }

    pub fn list(&self) -> LayoutListOutput {
        let recovered = self.recovered.lock().clone();
        let mut layouts: Vec<LayoutSummary> = self
            .layouts
            .lock()
            .values()
            .filter(|l| l.revision > 0)
            .map(|l| LayoutSummary {
                unsaved: l.unsaved,
                recovered: recovered.contains(&l.id),
                id: l.id.clone(),
                name: l.name.clone(),
                revision: l.revision,
                updated_at: l.updated_at,
                charts: l
                    .charts
                    .values()
                    .map(|c| LayoutChartBrief {
                        tile_id: c.tile_id.clone(),
                        instrument: c.instrument.clone(),
                        timeframe: c.timeframe,
                    })
                    .collect(),
            })
            .collect();
        layouts.sort_by(|a, b| a.id.cmp(&b.id));
        LayoutListOutput {
            layouts,
            active_id: self.active_id(),
        }
    }

    pub async fn delete(&self, id: &str) -> Result<LayoutDeleteOutput, ToolError> {
        let _serial = Arc::clone(&self.writes).lock_owned().await;
        if id == self.active_id() {
            return Err(ToolError::invalid_input(format!(
                "layout {id} is the default; make another layout the default first"
            )));
        }
        if !self.layouts.lock().contains_key(id) {
            return Err(ToolError::not_found(format!("layout {id} not found")));
        }
        let (store, key) = (self.store.clone(), id.to_owned());
        tokio::task::spawn_blocking(move || store.layouts().delete(&key))
            .await
            .map_err(|e| ToolError::internal(e.to_string()))?
            .map_err(|e| ToolError::internal(format!("could not delete layout: {e}")))?;
        self.layouts.lock().remove(id);
        self.saved.lock().remove(id);
        self.recovered.lock().remove(id);
        Ok(LayoutDeleteOutput {
            layout_id: id.to_owned(),
        })
    }

    pub async fn open_tile(
        &self,
        input: WorkspaceOpenTileInput,
        origin: &Origin,
    ) -> Result<WorkspaceOpenTileOutput, ToolError> {
        if input.kind == OpenTileKind::Markets {
            return Err(ToolError::invalid_input(MARKETS_IS_AN_AREA));
        }
        let pins = |field: &str, given: &Option<String>| -> Result<(), ToolError> {
            let given = given.as_deref().is_some_and(|s| !s.trim().is_empty());
            let takes = match input.kind {
                OpenTileKind::Dom | OpenTileKind::Tape => true,
                OpenTileKind::Chart => field == "instrument",
                _ => false,
            };
            if given && !takes {
                let how = if input.kind == OpenTileKind::Chart {
                    "chart.set_link puts it in a group once it is open"
                } else {
                    "it shows what the desk shows"
                };
                return Err(ToolError::invalid_input(format!(
                    "{} takes no {field}: {how}",
                    input.kind.words()
                )));
            }
            Ok(())
        };
        pins("instrument", &input.instrument)?;
        pins("link", &input.link)?;
        let beside = input
            .beside
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if input.kind != OpenTileKind::Chart && (input.placement.is_some() || beside.is_some()) {
            return Err(ToolError::invalid_input(format!(
                "{} takes no placement or beside: only a chart opens as a tab or a split",
                input.kind.words()
            )));
        }
        if input.kind == OpenTileKind::Chart {
            let layout = self.get(input.layout_id.as_deref())?;
            let asked = tile_requests(&layout.dock)
                .iter()
                .filter(|r| r.kind == OpenTileKind::Chart)
                .count();
            let charts = layout.charts.len() + asked;
            if charts >= MAX_CHARTS {
                return Err(ToolError::invalid_input(format!(
                    "the workspace holds {charts} charts, the most it can: close one (workspace.close_tile) or change a chart's symbol (chart.set_symbol)"
                )));
            }
            if let Some(b) = beside
                && !layout.charts.contains_key(b)
            {
                return Err(ToolError::not_found(format!(
                    "no chart {b} in the workspace (workspace.list_tiles lists its charts)"
                )));
            }
        }
        let beside = beside.map(str::to_owned);
        let placement = input.placement;
        let instrument = match input.instrument.as_deref().map(str::trim) {
            Some("") | None => None,
            Some(s) => Some(self.resolve(s).await?),
        };
        let link = match input.link.as_deref().map(str::trim) {
            Some("") | None => None,
            Some(l) if LINK_GROUPS.contains(&l) => Some(l.to_owned()),
            Some(l) => {
                return Err(ToolError::invalid_input(format!(
                    "link must be one of 1, 2, 3 or 4, not {l}"
                )));
            }
        };
        let settings = match input.settings {
            None | Some(serde_json::Value::Null) => None,
            Some(v @ serde_json::Value::Object(_)) => Some(v),
            Some(_) => {
                return Err(ToolError::invalid_input(
                    "settings must be an object of the tile's settings",
                ));
            }
        };
        let (layout, request) = self
            .mutate(
                input.layout_id.as_deref(),
                "workspace.open_tile",
                origin,
                None,
                |l| {
                    let request = TileRequest {
                        id: format!("open-{}", l.revision + 1),
                        kind: input.kind,
                        params: TileRequestParams {
                            instrument,
                            link,
                            settings: settings.clone(),
                            placement,
                            beside: beside.clone(),
                        },
                    };
                    l.dock = with_tile_request(&l.dock, &request)?;
                    Ok(request)
                },
            )
            .await?;
        Ok(WorkspaceOpenTileOutput {
            layout_id: layout.id,
            revision: layout.revision,
            request,
        })
    }

    pub async fn resolve_instrument(&self, input: &str) -> Result<InstrumentId, ToolError> {
        self.resolve(input).await
    }

    async fn resolve(&self, input: &str) -> Result<InstrumentId, ToolError> {
        self.market
            .resolve(input)
            .await
            .map_err(|e| ToolError::not_found(e.to_string()))
    }

    fn layout_id(&self, id: Option<&str>) -> String {
        id.map_or_else(|| self.active_id(), str::to_owned)
    }

    fn chart_instrument(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
    ) -> Result<InstrumentId, ToolError> {
        let layout = self.get(layout_id)?;
        let tile = Self::tile_of(&layout, tile)?;
        Ok(layout.charts[&tile].instrument.clone())
    }

    async fn capabilities_for(
        &self,
        instrument: &InstrumentId,
    ) -> Result<
        (
            tessera_core::DataSource,
            tessera_core::capabilities::MarketCapabilities,
        ),
        ToolError,
    > {
        self.market
            .capabilities_for(instrument)
            .await
            .map_err(tessera_market::market_error)
    }

    pub fn get(&self, id: Option<&str>) -> Result<Layout, ToolError> {
        let id = self.layout_id(id);
        self.layouts
            .lock()
            .get(&id)
            .cloned()
            .ok_or_else(|| ToolError::not_found(format!("layout {id} not found")))
    }

    async fn persist(&self, id: &str) -> Result<(), ToolError> {
        let Some(layout) = self.layouts.lock().get(id).cloned() else {
            return Ok(());
        };
        let saved = self.saved.lock().get(id).cloned();
        persist_layout(self.store.clone(), layout, saved).await
    }

    pub fn drawing(&self, id: &str) -> Option<tessera_protocol::drawings::Drawing> {
        self.layouts
            .lock()
            .values()
            .flat_map(|l| l.charts.values())
            .flat_map(|c| c.drawings.iter())
            .find(|d| d.id == id)
            .cloned()
    }

    pub fn snapshot_event(&self, id: Option<&str>) -> Result<LayoutEvent, ToolError> {
        let layout = self.get(id)?;
        Ok(LayoutEvent {
            layout_id: layout.id.clone(),
            revision: layout.revision,
            reason: "snapshot".into(),
            origin: Origin::User,
            tile_id: None,
            layout,
        })
    }

    async fn mutate<T>(
        &self,
        layout_id: Option<&str>,
        reason: &str,
        origin: &Origin,
        tile: Option<&str>,
        f: impl FnOnce(&mut Layout) -> Result<T, ToolError>,
    ) -> Result<(Layout, T), ToolError> {
        self.write(layout_id, reason, origin, tile, |l, _| f(l))
            .await
    }

    async fn mutate_kept<T>(
        &self,
        layout_id: Option<&str>,
        reason: &str,
        origin: &Origin,
        tile: Option<&str>,
        mut f: impl FnMut(&mut Layout) -> Result<T, ToolError>,
    ) -> Result<(Layout, T), ToolError> {
        self.write(layout_id, reason, origin, tile, |l, saved| {
            let out = f(l)?;
            if let Some(s) = saved {
                let mut next = s.clone();
                if f(&mut next).is_ok() {
                    *s = next;
                }
            }
            Ok(out)
        })
        .await
    }

    async fn write<T>(
        &self,
        layout_id: Option<&str>,
        reason: &str,
        origin: &Origin,
        tile: Option<&str>,
        f: impl FnOnce(&mut Layout, Option<&mut Layout>) -> Result<T, ToolError>,
    ) -> Result<(Layout, T), ToolError> {
        let serial = Arc::clone(&self.writes).lock_owned().await;
        let id = self.layout_id(layout_id);
        let (snapshot, saved, out) = {
            let mut layouts = self.layouts.lock();
            let mut saved = self.saved.lock();
            let layout = layouts
                .get_mut(&id)
                .ok_or_else(|| ToolError::not_found(format!("layout {id} not found")))?;
            let mut draft = layout.clone();
            let mut base = saved
                .get(&id)
                .cloned()
                .or_else(|| (layout.revision > 0).then(|| layout.clone()));
            let out = f(&mut draft, base.as_mut())?;
            draft.id.clone_from(&id);
            draft.revision = layout.revision + 1;
            draft.updated_at = self.clock.now();
            let kept = base
                .map(|mut b| {
                    b.name.clone_from(&draft.name);
                    b.trade.clone_from(&draft.trade);
                    b.unsaved = false;
                    b
                })
                .filter(|b| !document::same_document(b, &draft));
            draft.unsaved = kept.is_some();
            match &kept {
                Some(b) => {
                    saved.insert(id.clone(), b.clone());
                }
                None => {
                    saved.remove(&id);
                    self.recovered.lock().remove(&id);
                }
            }
            *layout = draft.clone();
            (draft, kept, out)
        };
        let (store, bus) = (self.store.clone(), Arc::clone(&self.bus));
        let event = LayoutEvent {
            layout_id: snapshot.id.clone(),
            revision: snapshot.revision,
            reason: reason.to_owned(),
            origin: origin.clone(),
            tile_id: tile.map(str::to_owned),
            layout: snapshot.clone(),
        };
        tokio::spawn(persist_and_publish(serial, store, bus, event, saved))
            .await
            .map_err(|e| ToolError::internal(e.to_string()))??;
        Ok((snapshot, out))
    }

    pub async fn save_changes(
        &self,
        layout_id: Option<&str>,
        origin: &Origin,
    ) -> Result<LayoutSaveOutput, ToolError> {
        let (layout, ()) = self
            .write(layout_id, "workspace.save", origin, None, |l, saved| {
                if let Some(s) = saved {
                    s.clone_from(l);
                }
                Ok(())
            })
            .await?;
        Ok(LayoutSaveOutput {
            layout_id: layout.id,
            revision: layout.revision,
        })
    }

    pub async fn revert(
        &self,
        layout_id: Option<&str>,
        origin: &Origin,
    ) -> Result<LayoutSaveOutput, ToolError> {
        let (layout, ()) = self
            .write(layout_id, "workspace.revert", origin, None, |l, saved| {
                if let Some(s) = saved {
                    l.clone_from(s);
                }
                Ok(())
            })
            .await?;
        Ok(LayoutSaveOutput {
            layout_id: layout.id,
            revision: layout.revision,
        })
    }

    pub fn check_trade_writer(input: &LayoutSaveInput, origin: &Origin) -> Result<(), ToolError> {
        if input.trade.is_some() && !origin.is_user() {
            return Err(ToolError::permission_denied(
                "a workspace's trade setup (the account its tickets trade, the quantity, the entry and the OCO) is the user's alone: save the layout without `trade`",
            ));
        }
        Ok(())
    }

    pub async fn save(
        &self,
        input: LayoutSaveInput,
        origin: &Origin,
    ) -> Result<LayoutSaveOutput, ToolError> {
        Self::check_trade_writer(&input, origin)?;
        let charts = match input.charts {
            Some(mut charts) => {
                for (key, c) in charts.iter_mut() {
                    if c.tile_id != *key {
                        return Err(ToolError::invalid_input(format!(
                            "chart key {key} does not match tileId {}",
                            c.tile_id
                        )));
                    }
                    c.instrument = self.resolve(c.instrument.as_str()).await?;
                }
                normalize_layers(&mut charts);
                drawings::normalize_drawings(&mut charts);
                Some(charts)
            }
            None => None,
        };
        let id = self.layout_id(input.layout_id.as_deref());
        let exists = self.layouts.lock().contains_key(&id);
        let _placeholder = (!exists).then(|| Placeholder {
            layouts: &self.layouts,
            id: id.clone(),
        });
        if !exists {
            let now = self.clock.now();
            let l = Layout {
                id: id.clone(),
                name: input.name.clone().unwrap_or_else(|| id.clone()),
                revision: 0,
                updated_at: now,
                active_chart_id: None,
                dock: Value::Null,
                charts: BTreeMap::new(),
                trade: Value::Null,
                unsaved: false,
            };
            self.layouts.lock().insert(id.clone(), l);
        }
        let expected = input.expected_revision;
        let result = self
            .mutate(Some(&id), "layout.save", origin, None, |l| {
                if let Some(e) = expected
                    && e != l.revision
                {
                    return Err(ToolError::conflict(format!(
                        "layout {} is at revision {}, expected {e}",
                        l.id, l.revision
                    ))
                    .with_details(json!({"revision": l.revision})));
                }
                if let Some(n) = input.name {
                    l.name = n;
                }
                if let Some(d) = input.dock {
                    l.dock = d;
                }
                if let Some(t) = input.trade {
                    l.trade = t;
                }
                if let Some(c) = charts {
                    l.charts = c;
                    if l.active_chart_id
                        .as_ref()
                        .is_some_and(|a| !l.charts.contains_key(a))
                    {
                        l.active_chart_id = None;
                    }
                }
                if let Some(a) = input.active_chart_id {
                    if !l.charts.contains_key(&a) {
                        return Err(ToolError::invalid_input(format!("no chart tile {a}")));
                    }
                    l.active_chart_id = Some(a);
                }
                Ok(())
            })
            .await;
        let (layout, ()) = match result {
            Ok(r) => r,
            Err(e) => {
                if !exists {
                    self.layouts.lock().remove(&id);
                }
                return Err(e);
            }
        };
        Ok(LayoutSaveOutput {
            layout_id: layout.id,
            revision: layout.revision,
        })
    }

    fn chart_output(layout: &Layout, tile: &str) -> Result<ChartChangeOutput, ToolError> {
        let chart = layout
            .charts
            .get(tile)
            .cloned()
            .ok_or_else(|| ToolError::not_found(format!("no chart tile {tile}")))?;
        Ok(ChartChangeOutput {
            layout_id: layout.id.clone(),
            revision: layout.revision,
            chart,
        })
    }

    fn tile_of(layout: &Layout, tile: Option<&str>) -> Result<String, ToolError> {
        layout
            .resolve_chart(tile)
            .map(|c| c.tile_id.clone())
            .ok_or_else(|| match tile {
                Some(t) => ToolError::not_found(format!("no chart tile {t}")),
                None => ToolError::not_found("the layout has no chart tiles"),
            })
    }

    pub fn chart_state(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
    ) -> Result<ChartStateOutput, ToolError> {
        let layout = self.get(layout_id)?;
        let tile = Self::tile_of(&layout, tile)?;
        Ok(ChartStateOutput {
            layout_id: layout.id.clone(),
            revision: layout.revision,
            chart: layout.charts[&tile].clone(),
            pulled: drawings::pulled(&layout, &tile),
        })
    }

    pub async fn set_drawing_sources(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
        from: Vec<String>,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let mut target = String::new();
        let (layout, ()) = self
            .mutate(layout_id, "chart.set_drawing_sources", origin, tile, |l| {
                target = Self::tile_of(l, tile)?;
                if let Some(missing) = from.iter().find(|t| !l.charts.contains_key(*t)) {
                    return Err(ToolError::not_found(format!("no chart tile {missing}")));
                }
                if from.contains(&target) {
                    return Err(ToolError::invalid_input(format!(
                        "{target} always shows its own drawings: list only other charts"
                    )));
                }
                let mut sources = Vec::new();
                for t in &from {
                    if !sources.contains(t) {
                        sources.push(t.clone());
                    }
                }
                l.charts
                    .get_mut(&target)
                    .expect("tile exists")
                    .drawings_from = sources;
                Ok(())
            })
            .await?;
        Self::chart_output(&layout, &target)
    }

    pub async fn set_symbol(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
        instrument: &str,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let id = self.resolve(instrument).await?;
        let mut target = String::new();
        let (layout, ()) = self
            .mutate(layout_id, "chart.set_symbol", origin, tile, |l| {
                target = Self::tile_of(l, tile)?;
                let group = l.charts[&target].link_group.clone();
                for c in l.charts.values_mut() {
                    let linked = group.is_some() && c.link_group == group;
                    if c.tile_id == target || linked {
                        c.instrument = id.clone();
                        c.viewport = None;
                    }
                }
                Ok(())
            })
            .await?;
        Self::chart_output(&layout, &target)
    }

    pub async fn set_timeframe(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
        tf: Timeframe,
        print_bars: Option<tessera_core::timeframe::PrintBars>,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        if print_bars.is_some_and(|b| {
            b.size() == 0 || b.size() > tessera_core::timeframe::PRINT_BAR_SIZE_MAX
        }) {
            return Err(ToolError::invalid_input(format!(
                "a print bar's size is 1 to {}",
                tessera_core::timeframe::PRINT_BAR_SIZE_MAX
            )));
        }
        let instrument = self.chart_instrument(layout_id, tile)?;
        let (source, caps) = self.capabilities_for(&instrument).await?;
        if !caps.serves_history(tf) {
            return Err(ToolError::unsupported(format!(
                "{tf} charts need history at {tf}, which {} does not offer for {instrument}",
                source.provider
            )));
        }
        let shown = self.get(layout_id)?;
        let mut sharing: Vec<String> = Vec::new();
        if shares_interval(&shown.dock) {
            let target = Self::tile_of(&shown, tile)?;
            for c in shown.charts.values() {
                if c.tile_id == target || c.timeframe == tf {
                    continue;
                }
                if self
                    .capabilities_for(&c.instrument)
                    .await
                    .is_ok_and(|(_, caps)| caps.serves_history(tf))
                {
                    sharing.push(c.tile_id.clone());
                }
            }
        }
        let mut target = String::new();
        let (layout, ()) = self
            .mutate(layout_id, "chart.set_timeframe", origin, tile, |l| {
                target = Self::tile_of(l, tile)?;
                for id in sharing.iter().chain(std::iter::once(&target)) {
                    if let Some(c) = l.charts.get_mut(id) {
                        c.timeframe = tf;
                        c.print_bars = if *id == target { print_bars } else { None };
                        c.viewport = None;
                    }
                }
                Ok(())
            })
            .await?;
        Self::chart_output(&layout, &target)
    }

    pub async fn set_chart_type(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
        chart_type: ChartType,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let mut target = String::new();
        let (layout, ()) = self
            .mutate(layout_id, "chart.set_chart_type", origin, tile, |l| {
                target = Self::tile_of(l, tile)?;
                let c = l.charts.get_mut(&target).expect("tile exists");
                c.chart_type = Some(chart_type);
                Ok(())
            })
            .await?;
        Self::chart_output(&layout, &target)
    }

    pub async fn set_hours(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
        hours: ChartHours,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let mut target = String::new();
        let (layout, ()) = self
            .mutate(layout_id, "chart.set_hours", origin, tile, |l| {
                target = Self::tile_of(l, tile)?;
                let c = l.charts.get_mut(&target).expect("tile exists");
                c.hours = (hours != ChartHours::default()).then_some(hours);
                Ok(())
            })
            .await?;
        Self::chart_output(&layout, &target)
    }

    pub fn set_custom_indicators(&self, custom: Arc<dyn CustomIndicators>) {
        *self.custom.lock() = Some(custom);
    }

    fn validate_with(
        custom: Option<&Arc<dyn CustomIndicators>>,
        kind: LayerKind,
        params: &Value,
    ) -> Result<Value, String> {
        if kind == LayerKind::Custom
            && let Some(c) = custom
        {
            let (id, version) = custom_ref(params)?;
            let spec = c.custom_spec(&id, version)?;
            return normalize_custom_params(Some(&spec), params);
        }
        kind.validate_params(params)
    }

    pub async fn add_layer(
        &self,
        input: ChartAddLayerInput,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let kind = input.kind;
        let instrument =
            self.chart_instrument(input.layout_id.as_deref(), input.tile_id.as_deref())?;
        if let Some(reason) = self.unavailable(kind, &instrument).await? {
            return Err(ToolError::unsupported(reason));
        }
        let custom = self.custom.lock().clone();
        let params =
            Self::validate_with(custom.as_ref(), kind, &input.params.unwrap_or(Value::Null))
                .map_err(|e| ToolError::invalid_input(format!("{kind} params: {e}")))?;
        let kind = kind.as_str().to_owned();
        let (namespace, session_id) = namespace_of(origin);
        let mut target = String::new();
        let tile = input.tile_id.clone();
        let (layout, ()) = self
            .mutate(
                input.layout_id.as_deref(),
                "chart.add_layer",
                origin,
                tile.as_deref(),
                |l| {
                    target = Self::tile_of(l, tile.as_deref())?;
                    let c = l.charts.get_mut(&target).expect("tile exists");
                    let id = match input.id {
                        Some(id) => {
                            if c.layers.iter().any(|x| x.id == id) {
                                return Err(ToolError::conflict(format!(
                                    "layer id {id} already exists"
                                )));
                            }
                            id
                        }
                        None => (1..)
                            .map(|n| format!("{kind}-{n}"))
                            .find(|cand| c.layers.iter().all(|x| &x.id != cand))
                            .expect("unbounded"),
                    };
                    c.layers.push(ChartLayer {
                        id,
                        kind,
                        params,
                        visible: true,
                        namespace,
                        session_id,
                    });
                    Ok(())
                },
            )
            .await?;
        Self::chart_output(&layout, &target)
    }

    async fn unavailable(
        &self,
        kind: LayerKind,
        instrument: &InstrumentId,
    ) -> Result<Option<String>, ToolError> {
        if kind.drawn().is_none() {
            return Ok(Some(format!(
                "{kind} layers are not drawn yet; chart.list_layer_kinds lists the kinds that are"
            )));
        }
        let Some(req) = kind.requires() else {
            return Ok(None);
        };
        let (source, caps) = self.capabilities_for(instrument).await?;
        let missing = match req {
            LayerRequirement::Footprint => (!caps.footprint).then_some("footprint data"),
        };
        Ok(missing.map(|what| {
            format!(
                "{kind} needs {what}, which {} does not offer for {instrument}",
                source.provider
            )
        }))
    }

    pub async fn layer_kinds(&self, input: LayerKindsInput) -> Result<LayerKindsOutput, ToolError> {
        let instrument = self
            .chart_instrument(input.layout_id.as_deref(), input.tile_id.as_deref())
            .ok();
        let words = input.kind.as_deref().unwrap_or_default();
        let matched: Vec<LayerKind> = LayerKind::ALL
            .into_iter()
            .filter(|k| k.spec().matches(words))
            .collect();
        if matched.is_empty() {
            return Err(ToolError::not_found(format!(
                "no layer kind matches {words:?}; chart.list_layer_kinds with no kind lists them all"
            )));
        }
        let limit = input.limit.map_or(matched.len(), |n| n.max(1) as usize);
        let full = input.full.unwrap_or(matched.len() == 1);
        let omitted = u32::try_from(matched.len().saturating_sub(limit)).unwrap_or(u32::MAX);
        let mut kinds = Vec::with_capacity(limit.min(matched.len()));
        for kind in matched.into_iter().take(limit) {
            let reason = match &instrument {
                Some(i) => self.unavailable(kind, i).await?,
                None => kind
                    .drawn()
                    .is_none()
                    .then(|| format!("{kind} layers are not drawn yet")),
            };
            let spec = kind.spec();
            kinds.push(LayerKindEntry {
                spec: if full { spec } else { spec.compact() },
                available: reason.is_none(),
                reason,
            });
        }
        Ok(LayerKindsOutput { kinds, omitted })
    }

    pub async fn remove_layer(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
        layer_id: &str,
        origin: &Origin,
    ) -> Result<RemovedOutput, ToolError> {
        let (layout, removed) = self
            .mutate(layout_id, "chart.remove_layer", origin, tile, |l| {
                let target = Self::tile_of(l, tile)?;
                let c = l.charts.get_mut(&target).expect("tile exists");
                let before = c.layers.len();
                c.layers.retain(|x| x.id != layer_id);
                let removed = (before - c.layers.len()) as u32;
                if removed == 0 {
                    return Err(ToolError::not_found(format!(
                        "no layer {layer_id} on {target}"
                    )));
                }
                Ok(removed)
            })
            .await?;
        Ok(RemovedOutput {
            removed,
            revision: layout.revision,
        })
    }

    pub async fn update_layer(
        &self,
        input: ChartUpdateLayerInput,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        if input.params.is_none() && input.visible.is_none() {
            return Err(ToolError::invalid_input(
                "nothing to change: give params and/or visible",
            ));
        }
        let mut target = String::new();
        let tile = input.tile_id.clone();
        let layer_id = input.layer_id.clone();
        let custom = self.custom.lock().clone();
        let (layout, ()) = self
            .mutate(
                input.layout_id.as_deref(),
                "chart.update_layer",
                origin,
                tile.as_deref(),
                |l| {
                    target = Self::tile_of(l, tile.as_deref())?;
                    let c = l.charts.get_mut(&target).expect("tile exists");
                    let layer =
                        c.layers
                            .iter_mut()
                            .find(|x| x.id == layer_id)
                            .ok_or_else(|| {
                                ToolError::not_found(format!("no layer {layer_id} on {target}"))
                            })?;
                    if let Some(patch) = &input.params {
                        let kind = LayerKind::parse(&layer.kind).ok_or_else(|| {
                            ToolError::unsupported(format!(
                                "{} layers cannot be edited",
                                layer.kind
                            ))
                        })?;
                        let mut params = if layer.params.is_object() {
                            layer.params.clone()
                        } else {
                            Value::Object(Default::default())
                        };
                        if let Some(spec) = kind.indicator() {
                            params =
                                tessera_protocol::indicators::migrate_legacy(spec.kind, &params);
                        }
                        merge_patch(&mut params, patch);
                        layer.params = Self::validate_with(custom.as_ref(), kind, &params)
                            .map_err(|e| ToolError::invalid_input(format!("{kind} params: {e}")))?;
                    }
                    if let Some(v) = input.visible {
                        layer.visible = v;
                    }
                    Ok(())
                },
            )
            .await?;
        Self::chart_output(&layout, &target)
    }

    pub async fn annotate(
        &self,
        input: ChartAnnotateInput,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let need = match input.kind {
            AnnotationKind::Box | AnnotationKind::Arrow | AnnotationKind::Zone => 2,
            AnnotationKind::Marker | AnnotationKind::Hline | AnnotationKind::Text => 1,
        };
        if input.points.len() != need {
            return Err(ToolError::invalid_input(format!(
                "{:?} annotations take {need} point(s), got {}",
                input.kind,
                input.points.len()
            )));
        }
        let needs_price = matches!(input.kind, AnnotationKind::Zone | AnnotationKind::Hline);
        let needs_both = matches!(input.kind, AnnotationKind::Box | AnnotationKind::Arrow);
        for p in &input.points {
            if (needs_price || needs_both) && p.price.is_none() {
                return Err(ToolError::invalid_input("each point needs a price"));
            }
            if needs_both && p.t.is_none() {
                return Err(ToolError::invalid_input("each point needs a time"));
            }
            if p.t.is_none() && p.price.is_none() {
                return Err(ToolError::invalid_input("a point needs a time or a price"));
            }
        }
        let (namespace, session_id) = namespace_of(origin);
        let now: Timestamp = self.clock.now();
        let mut target = String::new();
        let tile = input.tile_id.clone();
        let (layout, ()) = self
            .mutate(
                input.layout_id.as_deref(),
                "chart.annotate",
                origin,
                tile.as_deref(),
                |l| {
                    target = Self::tile_of(l, tile.as_deref())?;
                    let c = l.charts.get_mut(&target).expect("tile exists");
                    c.annotations.push(Annotation {
                        id: format!(
                            "ann_{}",
                            tessera_core::ids::CallId::generate()
                                .0
                                .trim_start_matches("call_")
                        ),
                        kind: input.kind,
                        namespace,
                        session_id,
                        instrument: Some(c.instrument.clone()),
                        label: input.label,
                        note: input.note,
                        points: input.points,
                        style: input.style,
                        created_at: now,
                    });
                    Ok(())
                },
            )
            .await?;
        Self::chart_output(&layout, &target)
    }

    pub async fn clear_annotations(
        &self,
        input: ChartClearAnnotationsInput,
        origin: &Origin,
    ) -> Result<RemovedOutput, ToolError> {
        let ns = input.namespace.unwrap_or(OverlayNamespace::Agent);
        if ns == OverlayNamespace::User && !origin.is_user() {
            return Err(ToolError::permission_denied(
                "agents can only clear agent annotations",
            ));
        }
        let session = input.session_id.clone();
        let tile = input.tile_id.clone();
        let (layout, removed) = self
            .mutate(
                input.layout_id.as_deref(),
                "chart.clear_annotations",
                origin,
                tile.as_deref(),
                |l| {
                    let target = Self::tile_of(l, tile.as_deref())?;
                    let c = l.charts.get_mut(&target).expect("tile exists");
                    let before = c.annotations.len();
                    c.annotations.retain(|a| {
                        let hit = a.namespace == ns
                            && session.as_deref().is_none_or(|s| {
                                a.session_id.as_ref().is_some_and(|x| x.as_str() == s)
                            });
                        !hit
                    });
                    Ok((before - c.annotations.len()) as u32)
                },
            )
            .await?;
        Ok(RemovedOutput {
            removed,
            revision: layout.revision,
        })
    }

    pub async fn apply_template(
        &self,
        layout_id: Option<&str>,
        tile: Option<&str>,
        template: &ChartTemplate,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let instrument = self.chart_instrument(layout_id, tile)?;
        let mut checked: Vec<LayerKind> = Vec::new();
        for l in &template.layers {
            let Some(kind) = LayerKind::parse(&l.kind) else {
                continue;
            };
            if checked.contains(&kind) {
                continue;
            }
            checked.push(kind);
            if let Some(reason) = self.unavailable(kind, &instrument).await? {
                return Err(ToolError::unsupported(format!(
                    "template {}: {reason}",
                    template.name
                )));
            }
        }
        let (_, session_id) = namespace_of(origin);
        let namespace = OverlayNamespace::User;
        let mut target = String::new();
        let (layout, ()) = self
            .mutate(layout_id, "chart.apply_template", origin, tile, |l| {
                target = Self::tile_of(l, tile)?;
                let c = l.charts.get_mut(&target).expect("tile exists");
                templates::apply(c, template, namespace, session_id)
                    .map_err(ToolError::invalid_input)
            })
            .await?;
        Self::chart_output(&layout, &target)
    }

    pub fn report_viewport(
        &self,
        layout_id: Option<&str>,
        tile: &str,
        viewport: Viewport,
    ) -> Result<(), ToolError> {
        let id = self.layout_id(layout_id);
        let mut layouts = self.layouts.lock();
        let layout = layouts
            .get_mut(&id)
            .ok_or_else(|| ToolError::not_found(format!("layout {id} not found")))?;
        let c = layout
            .charts
            .get_mut(tile)
            .ok_or_else(|| ToolError::not_found(format!("no chart tile {tile}")))?;
        c.viewport = Some(viewport);
        drop(layouts);
        self.drawn.lock().insert((id, tile.to_owned()));
        self.viewport_reports.notify_waiters();
        Ok(())
    }

    pub async fn viewport_answer(
        &self,
        layout_id: &str,
        tile: &str,
        request: &str,
        wait: std::time::Duration,
    ) -> Option<Viewport> {
        if !self
            .drawn
            .lock()
            .contains(&(layout_id.to_owned(), tile.to_owned()))
        {
            return None;
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let reported = self.viewport_reports.notified();
            tokio::pin!(reported);
            reported.as_mut().enable();
            let answer = self
                .layouts
                .lock()
                .get(layout_id)
                .and_then(|l| l.charts.get(tile))
                .and_then(|c| c.viewport.clone())
                .filter(|v| v.answers.as_deref() == Some(request));
            if answer.is_some() {
                return answer;
            }
            tokio::time::timeout_at(deadline, reported).await.ok()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quoted<'a>(items: impl IntoIterator<Item = &'a str>) -> String {
        let items: Vec<String> = items.into_iter().map(|i| format!("'{i}'")).collect();
        items.join(", ")
    }

    #[test]
    fn the_desk_keeps_its_dock_view_under_the_same_key() {
        let desk = include_str!("../../../apps/desktop/src/state/layouts.ts");
        assert!(desk.contains(&format!("const DOCK_VIEW_KEY = '{DOCK_VIEW_KEY}';")));
    }

    #[test]
    fn the_desk_offers_the_same_link_groups() {
        let desk = include_str!("../../../apps/desktop/src/workspace/dock/links.ts");
        let groups = quoted(LINK_GROUPS);
        assert!(desk.contains(&format!("const LINK_GROUPS = [{groups}] as const;")));
    }

    #[test]
    fn the_desk_names_and_builds_the_order_flow_template_as_the_runtime_does() {
        let desk = include_str!("../../../apps/desktop/src/chart/templates/orderFlow.ts");
        assert!(desk.contains(&format!(
            "const ORDER_FLOW_TEMPLATE = '{ORDER_FLOW_TEMPLATE}';"
        )));
        let template = order_flow_template();
        let kinds = quoted(template.layers.iter().map(|l| l.kind.as_str()));
        assert!(desk.contains(&format!(
            "const ORDER_FLOW_KINDS: readonly string[] = [{kinds}];"
        )));
    }

    #[test]
    fn the_default_charts_start_with_no_studies_and_no_levels() {
        for (tile, root) in DEFAULT_CHARTS {
            let c = default_chart(tile, InstrumentId::new(root).unwrap());
            assert!(c.layers.is_empty(), "{tile}");
        }
    }

    #[test]
    fn stored_layers_are_migrated_and_bad_ones_kept() {
        let mut c = chart(
            "chart-1",
            "Chart 1",
            InstrumentId::new("QQQ").unwrap(),
            Timeframe::M5,
            vec![
                layer("sma-1", "sma", json!({"period": 50})),
                layer("vwap-1", "vwap", json!({"bands": [1]})),
                layer("rsi-1", "rsi", json!({"inputs": {"length": 0}})),
                layer("lv", "levels", json!({"group": "pd"})),
                layer("x", "from_a_newer_build", json!({"a": 1})),
            ],
        );
        c.layers[0].visible = false;
        let mut charts = BTreeMap::from([("chart-1".to_owned(), c)]);
        normalize_layers(&mut charts);
        let ls = &charts["chart-1"].layers;
        assert_eq!(ls[0].params["inputs"]["length"], 50);
        assert!(!ls[0].visible, "visibility is untouched");
        assert_eq!(
            ls[1].params["inputs"]["band1"], false,
            "legacy bands stay off"
        );
        assert_eq!(ls[1].params["inputs"]["mult1"], 1.0);
        assert_eq!(
            ls[2].params,
            json!({"inputs": {"length": 0}}),
            "invalid: kept"
        );
        assert_eq!(ls[3].params, json!({"group": "pd"}), "levels: untouched");
        assert_eq!(ls[4].params, json!({"a": 1}), "unknown kinds: untouched");
    }

    fn vwaps(params: [Value; 3]) -> BTreeMap<String, ChartState> {
        let [a, b, c] = params;
        let layers = vec![
            layer("vwap-1", "vwap", a),
            layer("vwap-2", "vwap", b),
            layer("vwap-3", "vwap", c),
        ];
        BTreeMap::from([(
            "chart-1".to_owned(),
            chart(
                "chart-1",
                "Chart 1",
                InstrumentId::new("QQQ").unwrap(),
                Timeframe::M5,
                layers,
            ),
        )])
    }

    #[test]
    fn old_levels_settings_move_onto_old_vwaps_once() {
        let setting = json!({
            "sources": {"gamma": true},
            "levels": {"vwap": {"color": "brass"}, "pdh": {"on": false}},
            "vwapBands": true,
        });
        let legacy = LegacyVwapLevels::from_setting(Some(&setting));
        assert_eq!(
            legacy,
            LegacyVwapLevels {
                hidden: false,
                color: Some("brass".into()),
                bands: true
            }
        );
        let current = json!({"inputs": {"band1": false}, "style": {}});
        let mut charts = vwaps([json!({"bands": [1, 2]}), json!({}), current.clone()]);
        carry_legacy_vwap(&mut charts, &legacy);
        normalize_layers(&mut charts);
        let ls = &charts["chart-1"].layers;
        let i = &ls[0].params["inputs"];
        assert_eq!(
            (&i["band1"], &i["band2"], &i["band3"]),
            (&json!(true), &json!(true), &json!(false))
        );
        assert_eq!(ls[0].params["style"]["plots"]["vwap"]["color"], "brass");
        assert_eq!(ls[0].params["style"]["plots"]["upper2"]["color"], "brass");
        assert_eq!(ls[1].params["inputs"]["band1"], false, "no list: no bands");
        assert_eq!(ls[1].params["style"]["plots"]["vwap"]["color"], "brass");
        assert_eq!(
            ls[2].params["inputs"]["band1"], false,
            "already migrated: untouched"
        );
        assert_eq!(ls[2].params["style"]["plots"]["vwap"]["color"], "mist");
        assert!(ls.iter().all(|l| l.visible));

        let off = LegacyVwapLevels::from_setting(Some(&json!({"sources": {"vwap": false}})));
        assert!(off.hidden && off.color.is_none() && !off.bands);
        let mut charts = vwaps([json!({"bands": [1]}), json!(null), current]);
        carry_legacy_vwap(&mut charts, &off);
        assert!(!charts["chart-1"].layers[0].visible && !charts["chart-1"].layers[1].visible);
        assert!(charts["chart-1"].layers[2].visible);
        let mut charts = vwaps([json!({"bands": [1]}), json!({}), json!({})]);
        carry_legacy_vwap(&mut charts, &LegacyVwapLevels::from_setting(None));
        normalize_layers(&mut charts);
        let l = &charts["chart-1"].layers[0];
        assert!(l.visible);
        assert_eq!(l.params["inputs"]["band1"], false);
    }
}
