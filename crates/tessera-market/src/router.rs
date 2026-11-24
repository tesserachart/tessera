use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use parking_lot::RwLock;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::{AssetClass, ContractSpec, ExchangeContract, Instrument};
use tessera_core::market::{BookSnapshot, DataSource, Quote, Trade};
use tessera_core::{InstrumentId, Timeframe};
use tessera_host::{InstrumentResolver, UnknownInstrument};
use tokio::sync::watch;

use crate::history::{BarCache, Gate, Read};
use crate::io::ListedConnection;
use crate::orderbook::OrderBookBuilder;
use crate::pace::Paces;
use crate::provider::{
    BarSeries, BarsRequest, ConnectionRef, LiveBar, MarketDataProvider, MarketError, MarketStream,
    OrderBookEvent, TradesRequest, exchange_contract,
};
use crate::replay::Replays;

const ORDER_DRAIN: usize = 1 << 16;

const IMAGE_GRACE: std::time::Duration = crate::hub::CONFLATION;

pub fn derived_depth(
    orders: MarketStream<OrderBookEvent>,
    instrument: &InstrumentId,
    levels: u32,
) -> MarketStream<BookSnapshot> {
    use tokio::time::Instant;
    let levels = levels.max(1) as usize;
    let state = Derived {
        orders,
        book: OrderBookBuilder::new(instrument.clone()),
        last: None,
        ended: false,
    };
    futures::stream::unfold(state, move |mut st| async move {
        loop {
            if st.ended {
                let last = st.book.take_snapshot(levels);
                return last.map(|b| (b, st));
            }
            let due = st
                .last
                .map(|t| t + crate::hub::CONFLATION)
                .filter(|d| *d > Instant::now());
            let mut quiet = false;
            if !st.book.has_news() {
                let event = st.orders.next().await;
                st.take(event);
            } else if st.book.is_reloading() {
                quiet = st.image_went_quiet().await;
            } else if let Some(due) = due {
                tokio::select! {
                    event = st.orders.next() => st.take(event),
                    () = tokio::time::sleep_until(due) => {}
                }
            }
            st.drain_ready();
            if st.book.is_reloading() && !quiet && !st.ended {
                continue;
            }
            let now = Instant::now();
            if due.is_some_and(|d| d > now) {
                continue;
            }
            if let Some(b) = st.book.take_snapshot(levels) {
                st.last = Some(now);
                return Some((b, st));
            }
        }
    })
    .boxed()
}

struct Derived {
    orders: MarketStream<OrderBookEvent>,
    book: OrderBookBuilder,
    last: Option<tokio::time::Instant>,
    ended: bool,
}

impl Derived {
    fn take(&mut self, event: Option<OrderBookEvent>) {
        match event {
            Some(e) => self.book.apply(e),
            None => self.ended = true,
        }
    }

    async fn image_went_quiet(&mut self) -> bool {
        match tokio::time::timeout(IMAGE_GRACE, self.orders.next()).await {
            Ok(event) => {
                self.take(event);
                false
            }
            Err(_) => true,
        }
    }

    fn drain_ready(&mut self) {
        use futures::FutureExt;
        for _ in 0..ORDER_DRAIN {
            match self.orders.next().now_or_never() {
                Some(event) => self.take(event),
                None => break,
            }
            if self.ended {
                break;
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RouterError {
    #[error("a market-data provider with id {0:?} is already connected")]
    Duplicate(String),
}

type Group = (Arc<dyn MarketDataProvider>, Vec<InstrumentId>);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum DataChoice {
    #[default]
    Auto,
    Connection(String),
}

impl DataChoice {
    pub fn from_setting(v: &str) -> Self {
        match v.trim() {
            "" | "auto" => Self::Auto,
            id => Self::Connection(id.to_owned()),
        }
    }
}

fn exchange_code(exchange: &str) -> String {
    exchange.trim().to_ascii_uppercase()
}

#[derive(Clone, Debug)]
struct Binding {
    provider: String,
    exchange: Option<String>,
}

impl Binding {
    fn survives_reroute(&self, before: &Routing, after: &Routing) -> bool {
        self.exchange.as_deref().is_some_and(|e| {
            !before.moves(after, e) || after.target(e) == Some(self.provider.as_str())
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Routing {
    default: Option<String>,
    exchanges: BTreeMap<String, Option<String>>,
}

impl Routing {
    fn target(&self, exchange: &str) -> Option<&str> {
        self.exchanges
            .get(exchange)
            .map_or(self.default.as_deref(), Option::as_deref)
    }

    fn moves(&self, after: &Self, exchange: &str) -> bool {
        self.target(exchange) != after.target(exchange)
    }

    fn differs(&self, after: &Self) -> bool {
        self.default != after.default
            || self
                .exchanges
                .keys()
                .chain(after.exchanges.keys())
                .any(|e| self.moves(after, e))
    }
}

#[derive(Default)]
struct State {
    providers: Vec<Arc<dyn MarketDataProvider>>,
    bindings: HashMap<InstrumentId, Binding>,
    data: DataChoice,
    exchanges: BTreeMap<String, String>,
}

impl State {
    fn get(&self, id: &str) -> Option<Arc<dyn MarketDataProvider>> {
        self.providers.iter().find(|p| p.id() == id).cloned()
    }

    fn data(&self) -> Option<Arc<dyn MarketDataProvider>> {
        let auto = || self.providers.first().cloned();
        match &self.data {
            DataChoice::Connection(id) => self
                .providers
                .iter()
                .find(|p| p.id() == id)
                .cloned()
                .or_else(auto),
            DataChoice::Auto => auto(),
        }
    }

    fn data_for(&self, exchange: &str) -> Option<Arc<dyn MarketDataProvider>> {
        self.exchanges
            .get(exchange)
            .and_then(|id| self.get(id))
            .or_else(|| self.data())
    }

    fn data_connections(&self) -> Vec<Arc<dyn MarketDataProvider>> {
        let mut out: Vec<_> = self.data().into_iter().collect();
        for p in &self.providers {
            if !out.iter().any(|d| d.id() == p.id()) && self.exchanges.values().any(|c| c == p.id())
            {
                out.push(Arc::clone(p));
            }
        }
        out
    }

    fn routing(&self) -> Routing {
        let id = |p: Arc<dyn MarketDataProvider>| p.id().to_owned();
        Routing {
            default: self.data().map(id),
            exchanges: self
                .exchanges
                .keys()
                .map(|e| (e.clone(), self.data_for(e).map(id)))
                .collect(),
        }
    }

    fn reroute(&mut self, before: &Routing) -> bool {
        let after = self.routing();
        if !before.differs(&after) {
            return false;
        }
        self.bindings
            .retain(|_, b| b.survives_reroute(before, &after));
        true
    }

    fn ordered(&self) -> Vec<Arc<dyn MarketDataProvider>> {
        let first = self.data();
        let mut out: Vec<_> = first.iter().cloned().collect();
        out.extend(
            self.providers
                .iter()
                .filter(|p| first.as_ref().is_none_or(|f| f.id() != p.id()))
                .cloned(),
        );
        out
    }
}

fn same_exchange(a: &Instrument, b: &Instrument) -> bool {
    exchange_code(&a.exchange) == exchange_code(&b.exchange)
}

pub struct MarketRouter {
    state: RwLock<State>,
    changes: watch::Sender<u64>,
    bars: RwLock<Option<Arc<BarCache>>>,
    replays: RwLock<Option<Arc<Replays>>>,
    paces: Paces,
    foreground: Gate,
}

impl std::fmt::Debug for MarketRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let st = self.state.read();
        f.debug_struct("MarketRouter")
            .field(
                "providers",
                &st.providers.iter().map(|p| p.id()).collect::<Vec<_>>(),
            )
            .field("bindings", &st.bindings.len())
            .finish()
    }
}

pub fn source_of(p: &dyn MarketDataProvider) -> DataSource {
    DataSource {
        provider: p.id().to_owned(),
    }
}

pub fn effective(mut caps: MarketCapabilities) -> MarketCapabilities {
    caps.footprint |= caps.order_flow();
    caps
}

fn push_all<T: PartialEq>(into: &mut Vec<T>, from: Vec<T>) {
    for x in from {
        if !into.contains(&x) {
            into.push(x);
        }
    }
}

fn union(caps: impl IntoIterator<Item = MarketCapabilities>) -> MarketCapabilities {
    let mut out = MarketCapabilities {
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
    };
    for c in caps {
        push_all(&mut out.history_timeframes, c.history_timeframes);
        push_all(&mut out.live_timeframes, c.live_timeframes);
        push_all(&mut out.asset_classes, c.asset_classes);
        out.quotes |= c.quotes;
        out.trades |= c.trades;
        out.footprint |= c.footprint;
        out.realtime |= c.realtime;
        out.depth_levels = out.depth_levels.max(c.depth_levels);
        out.max_intraday_history_days = out
            .max_intraday_history_days
            .max(c.max_intraday_history_days);
        out.max_daily_history_days = out.max_daily_history_days.max(c.max_daily_history_days);
        out.aggressor_source = out.aggressor_source.or(c.aggressor_source);
    }
    out.history_timeframes.sort();
    out.live_timeframes.sort();
    out
}

impl MarketRouter {
    pub const ID: &'static str = "market";

    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: RwLock::new(State::default()),
            changes: watch::channel(0).0,
            bars: RwLock::new(None),
            replays: RwLock::new(None),
            paces: Paces::default(),
            foreground: Gate::default(),
        })
    }

    pub fn foreground(&self) -> &Gate {
        &self.foreground
    }

    pub fn paces(&self) -> &Paces {
        &self.paces
    }

    pub fn set_replays(&self, replays: Arc<Replays>) {
        *self.replays.write() = Some(replays);
    }

    pub fn replays(&self) -> Option<Arc<Replays>> {
        self.replays.read().clone()
    }

    fn replay_of(&self, instrument: &InstrumentId) -> Option<Arc<dyn MarketDataProvider>> {
        let replays = self.replays.read();
        let r = replays.as_ref().filter(|r| r.owns(instrument))?;
        Some(Arc::clone(r) as Arc<dyn MarketDataProvider>)
    }

    pub fn set_bar_cache(&self, cache: Arc<BarCache>) {
        *self.bars.write() = Some(cache);
    }

    pub fn bar_cache(&self) -> Option<Arc<BarCache>> {
        self.bars.read().clone()
    }

    pub async fn bars_from(
        &self,
        conn: &Arc<dyn MarketDataProvider>,
        req: BarsRequest,
        read: Read,
    ) -> Result<BarSeries, MarketError> {
        let _foreground = (read != Read::Kept).then(|| self.foreground.enter());
        if !conn.cache_bars() {
            return conn.get_bars(req).await;
        }
        match (self.bar_cache(), read) {
            (Some(cache), _) => cache.get_bars(conn, req, read).await,
            (None, Read::Through | Read::Recent) => conn.get_bars(req).await,
            (None, Read::Kept) => Ok(BarSeries {
                instrument: req.instrument,
                tf: req.tf,
                bars: Vec::new(),
                last_bar_open: false,
            }),
        }
    }

    fn changed(&self) {
        self.changes.send_modify(|v| *v += 1);
    }

    pub fn add(&self, provider: Arc<dyn MarketDataProvider>) -> Result<(), RouterError> {
        {
            let mut st = self.state.write();
            if st.providers.iter().any(|p| p.id() == provider.id()) {
                return Err(RouterError::Duplicate(provider.id().to_owned()));
            }
            let before = st.routing();
            st.providers.push(provider);
            st.reroute(&before);
        }
        self.changed();
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Option<Arc<dyn MarketDataProvider>> {
        let removed = {
            let mut st = self.state.write();
            let i = st.providers.iter().position(|p| p.id() == id)?;
            let before = st.routing();
            st.bindings.retain(|_, b| b.provider != id);
            let removed = st.providers.remove(i);
            st.reroute(&before);
            removed
        };
        self.changed();
        Some(removed)
    }

    pub fn providers(&self) -> Vec<Arc<dyn MarketDataProvider>> {
        self.state.read().providers.clone()
    }

    pub fn prices_down(&self) -> Vec<String> {
        self.providers()
            .iter()
            .filter(|p| !p.prices_flowing())
            .map(|p| p.id().to_owned())
            .collect()
    }

    pub fn ordered(&self) -> Vec<Arc<dyn MarketDataProvider>> {
        self.state.read().ordered()
    }

    pub fn set_data_choice(&self, choice: DataChoice) {
        let routing_changed = {
            let mut st = self.state.write();
            let before = st.routing();
            st.data = choice;
            st.reroute(&before)
        };
        if routing_changed {
            self.changed();
        }
    }

    pub fn data_choice(&self) -> DataChoice {
        self.state.read().data.clone()
    }

    pub fn set_exchange_choices(&self, choices: BTreeMap<String, String>) {
        let choices = choices
            .into_iter()
            .map(|(e, c)| (exchange_code(&e), c.trim().to_owned()))
            .filter(|(e, c)| !e.is_empty() && !c.is_empty())
            .collect();
        let routing_changed = {
            let mut st = self.state.write();
            let before = st.routing();
            st.exchanges = choices;
            st.reroute(&before)
        };
        if routing_changed {
            self.changed();
        }
    }

    pub fn exchange_choices(&self) -> BTreeMap<String, String> {
        self.state.read().exchanges.clone()
    }

    pub fn data_source(&self) -> Option<ConnectionRef> {
        self.state
            .read()
            .data()
            .map(|p| ConnectionRef::of(p.as_ref()))
    }

    pub fn data_source_for(&self, exchange: &str) -> Option<ConnectionRef> {
        self.state
            .read()
            .data_for(&exchange_code(exchange))
            .map(|p| ConnectionRef::of(p.as_ref()))
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn MarketDataProvider>> {
        self.state.read().get(id)
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn binding(&self, instrument: &InstrumentId) -> Option<String> {
        self.state
            .read()
            .bindings
            .get(instrument)
            .map(|b| b.provider.clone())
    }

    fn bind(&self, instrument: &InstrumentId, provider: &str) {
        self.bind_on(instrument, provider, None);
    }

    fn bind_listed(&self, instrument: &Instrument, provider: &str) {
        self.bind_on(&instrument.id, provider, Some(&instrument.exchange));
    }

    fn bind_on(&self, instrument: &InstrumentId, provider: &str, exchange: Option<&str>) {
        let moved = {
            let mut st = self.state.write();
            let exchange = exchange
                .map(exchange_code)
                .filter(|e| !e.is_empty())
                .or_else(|| st.bindings.get(instrument).and_then(|b| b.exchange.clone()));
            let routed = exchange
                .as_deref()
                .and_then(|e| st.data_for(e))
                .is_some_and(|p| p.id() == provider);
            let bound = Binding {
                provider: provider.to_owned(),
                exchange,
            };
            match st.bindings.entry(instrument.clone()) {
                Entry::Vacant(v) => {
                    v.insert(bound);
                    false
                }
                Entry::Occupied(mut o) => {
                    let b = o.get_mut();
                    if b.provider == provider {
                        b.exchange = b.exchange.take().or(bound.exchange);
                        false
                    } else if routed {
                        *b = bound;
                        true
                    } else {
                        false
                    }
                }
            }
        };
        if moved {
            self.changed();
        }
    }

    fn learn(&self, instrument: &Instrument, provider: &str) {
        let unknown = |b: &Binding| b.provider == provider && b.exchange.is_none();
        if !self
            .state
            .read()
            .bindings
            .get(&instrument.id)
            .is_some_and(unknown)
        {
            return;
        }
        let mut st = self.state.write();
        if let Some(b) = st.bindings.get_mut(&instrument.id).filter(|b| unknown(b)) {
            b.exchange = Some(exchange_code(&instrument.exchange)).filter(|e| !e.is_empty());
        }
    }

    pub fn route(
        &self,
        instrument: &InstrumentId,
    ) -> Result<Arc<dyn MarketDataProvider>, MarketError> {
        if let Some(r) = self.replay_of(instrument) {
            return Ok(r);
        }
        let st = self.state.read();
        if let Some(b) = st.bindings.get(instrument)
            && let Some(p) = st.get(&b.provider)
        {
            return Ok(p);
        }
        match st.providers.as_slice() {
            [] => Err(MarketError::Unavailable(
                "no market-data connection is configured".into(),
            )),
            [only] => Ok(Arc::clone(only)),
            _ => Err(MarketError::UnknownInstrument(format!(
                "{instrument} (not resolved on any connection yet)"
            ))),
        }
    }

    pub async fn route_async(
        &self,
        instrument: &InstrumentId,
    ) -> Result<Arc<dyn MarketDataProvider>, MarketError> {
        if let Ok(p) = self.route(instrument) {
            return Ok(p);
        }
        self.find_owner(instrument).await
    }

    async fn find_owner(
        &self,
        instrument: &InstrumentId,
    ) -> Result<Arc<dyn MarketDataProvider>, MarketError> {
        let mut first_still_connecting = None;
        let providers = self.ordered();
        for (n, p) in providers.iter().enumerate() {
            match p.spec(instrument).await {
                Ok((found, _)) => {
                    let (owner, found) = match self.routed_elsewhere(&found, p, &providers[..n]) {
                        Some(r) => match r.spec(instrument).await {
                            Ok((theirs, _)) if same_exchange(&theirs, &found) => (r, theirs),
                            _ => (Arc::clone(p), found),
                        },
                        None => (Arc::clone(p), found),
                    };
                    self.bind_listed(&found, owner.id());
                    return Ok(owner);
                }
                Err(MarketError::Unavailable(_)) if first_still_connecting.is_none() => {
                    first_still_connecting = Some(Arc::clone(p));
                }
                Err(_) => {}
            }
        }
        let p = first_still_connecting
            .ok_or_else(|| MarketError::UnknownInstrument(instrument.to_string()))?;
        self.bind(instrument, p.id());
        Ok(p)
    }

    async fn resolve_exact_id(&self, input: &str) -> Option<InstrumentId> {
        let exact = input.trim();
        if !exact.contains('.') {
            return None;
        }
        let id = InstrumentId::new(exact).ok()?;
        (self.binding(&id).is_some() || self.find_owner(&id).await.is_ok()).then_some(id)
    }

    fn routed_elsewhere(
        &self,
        found: &Instrument,
        p: &Arc<dyn MarketDataProvider>,
        asked: &[Arc<dyn MarketDataProvider>],
    ) -> Option<Arc<dyn MarketDataProvider>> {
        let st = self.state.read();
        if st.exchanges.is_empty() {
            return None;
        }
        st.data_for(&exchange_code(&found.exchange))
            .filter(|r| r.id() != p.id() && !asked.iter().any(|a| a.id() == r.id()))
    }

    async fn resolve_routed(
        &self,
        input: &str,
        id: InstrumentId,
        p: &Arc<dyn MarketDataProvider>,
        asked: &[Arc<dyn MarketDataProvider>],
    ) -> InstrumentId {
        let Ok((found, _)) = p.spec(&id).await else {
            self.bind(&id, p.id());
            return id;
        };
        if let Some(r) = self.routed_elsewhere(&found, p, asked)
            && let Ok(theirs) = r.resolve(input).await
            && let Ok((theirs, _)) = r.spec(&theirs).await
            && same_exchange(&theirs, &found)
        {
            self.bind_listed(&theirs, r.id());
            return theirs.id;
        }
        self.bind_listed(&found, p.id());
        id
    }

    pub async fn capabilities_for(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(DataSource, MarketCapabilities), MarketError> {
        let p = self.route_async(instrument).await?;
        Ok((source_of(p.as_ref()), effective(p.capabilities())))
    }

    pub async fn list_by_connection(
        &self,
        connection: Option<&str>,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Vec<ListedConnection> {
        let feeding = self.state.read().data().map(|d| d.id().to_owned());
        let mut out = Vec::new();
        for p in self.ordered() {
            if connection.is_some_and(|c| c != p.id()) {
                continue;
            }
            let (instruments, error) = match p.search("", asset_class, limit).await {
                Ok(mut found) => {
                    found.truncate(limit);
                    for i in &found {
                        self.bind_listed(i, p.id());
                    }
                    (found, None)
                }
                Err(e) => (Vec::new(), Some(e.to_string())),
            };
            out.push(ListedConnection {
                id: p.id().to_owned(),
                display_name: p.display_name().to_owned(),
                feeds_desk: feeding.as_deref() == Some(p.id()),
                instruments,
                error,
            });
        }
        out
    }

    fn group(&self, instruments: &[InstrumentId]) -> Result<Vec<Group>, MarketError> {
        let mut groups: Vec<Group> = Vec::new();
        for id in instruments {
            let p = self.route(id)?;
            match groups.iter_mut().find(|(g, _)| g.id() == p.id()) {
                Some((_, ids)) => ids.push(id.clone()),
                None => groups.push((p, vec![id.clone()])),
            }
        }
        Ok(groups)
    }
}

#[async_trait]
impl MarketDataProvider for MarketRouter {
    fn id(&self) -> &str {
        Self::ID
    }

    fn prices_down_for(&self, instrument: &InstrumentId) -> Option<ProviderHealth> {
        self.route(instrument).ok()?.prices_down_for(instrument)
    }

    fn last_message_for(&self, instrument: &InstrumentId) -> Option<tessera_core::Timestamp> {
        self.route(instrument).ok()?.last_message_for(instrument)
    }

    fn display_name(&self) -> &str {
        "Market data"
    }

    fn capabilities(&self) -> MarketCapabilities {
        union(self.providers().iter().map(|p| effective(p.capabilities())))
    }

    fn health(&self) -> ProviderHealth {
        let all: Vec<ProviderHealth> = self.providers().iter().map(|p| p.health()).collect();
        let rank = |s: HealthStatus| match s {
            HealthStatus::Ok => 0,
            HealthStatus::Unknown => 1,
            HealthStatus::Degraded => 2,
            HealthStatus::Disconnected => 3,
            HealthStatus::Down => 4,
            HealthStatus::Disabled => 5,
        };
        let worst = all
            .iter()
            .map(|h| h.status)
            .max_by_key(|s| rank(*s))
            .unwrap_or(HealthStatus::Disconnected);
        ProviderHealth {
            provider_id: Self::ID.to_owned(),
            kind: ProviderKind::MarketData,
            display_name: self.display_name().to_owned(),
            status: worst,
            latency_ms: None,
            last_message_at: all.iter().filter_map(|h| h.last_message_at).max(),
            message: Some(format!("{} connection(s)", all.len())),
            connection: None,
            accounts: None,
            checked_at: all
                .iter()
                .map(|h| h.checked_at)
                .max()
                .unwrap_or(tessera_core::Timestamp(0)),
        }
    }

    async fn search(
        &self,
        query: &str,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        let (routing, data, ordered) = {
            let st = self.state.read();
            (st.routing(), st.data_connections(), st.ordered())
        };
        let mut last_err = None;
        let mut answers: Vec<(Arc<dyn MarketDataProvider>, Option<Vec<Instrument>>)> = Vec::new();
        for p in data {
            let found = match p.search(query, asset_class, limit).await {
                Ok(found) => Some(found),
                Err(e) => {
                    last_err = Some(e);
                    None
                }
            };
            answers.push((p, found));
        }
        let failed: Vec<String> = answers
            .iter()
            .filter(|(_, a)| a.is_none())
            .map(|(p, _)| p.id().to_owned())
            .collect();
        let in_full = |p: &str, i: &Instrument| {
            routing
                .target(&exchange_code(&i.exchange))
                .is_none_or(|t| t == p || failed.iter().any(|f| f == t))
        };
        let mut out: Vec<Instrument> = Vec::new();
        let list = |out: &mut Vec<Instrument>, p: &str, i: &Instrument, twins_only: bool| {
            if out.iter().any(|o| o.id == i.id) {
                return;
            }
            if twins_only {
                let twin = exchange_contract(i);
                if twin.is_none() || out.iter().all(|o| exchange_contract(o) != twin) {
                    return;
                }
            }
            self.bind_listed(i, p);
            out.push(i.clone());
        };
        for (p, found) in &answers {
            for i in found.iter().flatten().filter(|i| in_full(p.id(), i)) {
                list(&mut out, p.id(), i, false);
            }
        }
        for (p, found) in &answers {
            for i in found.iter().flatten().filter(|i| !in_full(p.id(), i)) {
                list(&mut out, p.id(), i, true);
            }
        }
        for p in ordered
            .iter()
            .filter(|p| !answers.iter().any(|(d, _)| d.id() == p.id()))
        {
            if out.len() >= limit {
                break;
            }
            match p.search(query, asset_class, limit).await {
                Ok(found) => {
                    for i in &found {
                        list(&mut out, p.id(), i, !in_full(p.id(), i));
                    }
                }
                Err(e) => last_err = Some(e),
            }
        }
        out.truncate(limit);
        match (out.is_empty(), last_err) {
            (true, Some(e)) => Err(e),
            _ => Ok(out),
        }
    }

    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        if let Some(id) = InstrumentId::new(input)
            .ok()
            .filter(|id| self.replay_of(id).is_some())
        {
            return Ok(id);
        }
        let providers = self.ordered();
        if providers.is_empty() {
            return Err(MarketError::Unavailable(
                "no market-data connection is configured".into(),
            ));
        }
        if let Some(id) = self.resolve_exact_id(input).await {
            return Ok(id);
        }
        let routes = !self.state.read().exchanges.is_empty();
        let mut unexpected = None;
        for (n, p) in providers.iter().enumerate() {
            match p.resolve(input).await {
                Ok(id) if routes => {
                    return Ok(self.resolve_routed(input, id, p, &providers[..n]).await);
                }
                Ok(id) => {
                    self.bind(&id, p.id());
                    return Ok(id);
                }
                Err(MarketError::UnknownInstrument(_)) => {}
                Err(e) => unexpected = Some(e),
            }
        }
        Err(unexpected.unwrap_or_else(|| MarketError::UnknownInstrument(input.to_owned())))
    }

    async fn contract_for(
        &self,
        want: &ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        let data = self.state.read().data_for(&exchange_code(&want.exchange));
        match data {
            Some(d) => self.contract_on(d.id(), want).await,
            None => Err(MarketError::Unavailable(
                "no market-data connection is configured".into(),
            )),
        }
    }

    async fn contract_on(
        &self,
        connection: &str,
        want: &ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        let p = self
            .get(connection)
            .ok_or_else(|| MarketError::Unavailable(format!("{connection} is not connected")))?;
        let found = p.contract_for(want).await?;
        if let Some(i) = &found {
            self.bind_listed(i, p.id());
        }
        Ok(found)
    }

    fn connection(&self, id: &str) -> Option<ConnectionRef> {
        self.get(id).map(|p| ConnectionRef::of(p.as_ref()))
    }

    async fn serving(&self, instrument: &InstrumentId) -> Result<ConnectionRef, MarketError> {
        let p = self.route_async(instrument).await?;
        Ok(ConnectionRef::of(p.as_ref()))
    }

    async fn spec(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(Instrument, ContractSpec), MarketError> {
        let p = self.route_async(instrument).await?;
        let out = p.spec(instrument).await?;
        self.learn(&out.0, p.id());
        Ok(out)
    }

    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        let conn = self.route_async(&req.instrument).await?;
        self.bars_from(&conn, req, Read::Through).await
    }

    async fn quote(&self, instrument: &InstrumentId) -> Result<Quote, MarketError> {
        let p = self.route_async(instrument).await?;
        let mut q = p.quote(instrument).await?;
        q.source = Some(source_of(p.as_ref()));
        Ok(q)
    }

    fn subscribe_quotes(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Quote>, MarketError> {
        let mut streams = Vec::new();
        for (p, ids) in self.group(instruments)? {
            let src = source_of(p.as_ref());
            let s = p.subscribe_quotes(&ids)?.map(move |mut q| {
                q.source = Some(src.clone());
                q
            });
            streams.push(s.boxed());
        }
        Ok(futures::stream::select_all(streams).boxed())
    }

    fn subscribe_trades(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Trade>, MarketError> {
        let mut streams = Vec::new();
        for (p, ids) in self.group(instruments)? {
            let src = source_of(p.as_ref());
            let s = p.subscribe_trades(&ids)?.map(move |mut t| {
                t.source = Some(src.clone());
                t
            });
            streams.push(s.boxed());
        }
        Ok(futures::stream::select_all(streams).boxed())
    }

    fn subscribe_bars(
        &self,
        instrument: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.route(instrument)?.subscribe_bars(instrument, tf)
    }

    fn subscribe_depth(
        &self,
        instrument: &InstrumentId,
        levels: u32,
    ) -> Result<MarketStream<BookSnapshot>, MarketError> {
        let p = self.route(instrument)?;
        match p.subscribe_depth(instrument, levels) {
            Err(MarketError::Unsupported(why)) if p.capabilities().depth_levels.is_some() => {
                match p.subscribe_order_book(instrument) {
                    Ok(orders) => Ok(derived_depth(orders, instrument, levels)),
                    Err(_) => Err(MarketError::Unsupported(why)),
                }
            }
            other => other,
        }
    }

    fn subscribe_order_book(
        &self,
        instrument: &InstrumentId,
    ) -> Result<MarketStream<OrderBookEvent>, MarketError> {
        self.route(instrument)?.subscribe_order_book(instrument)
    }

    async fn get_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let p = self.route_async(&req.instrument).await?;
        let src = source_of(p.as_ref());
        let mut out = p.get_trades(req).await?;
        for t in &mut out {
            t.source = Some(src.clone());
        }
        Ok(out)
    }

    async fn replay_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let p = self.route_async(&req.instrument).await?;
        let src = source_of(p.as_ref());
        let mut out = p.replay_trades(req).await?;
        for t in &mut out {
            t.source = Some(src.clone());
        }
        Ok(out)
    }
}

#[async_trait]
impl InstrumentResolver for MarketRouter {
    async fn resolve_instrument(&self, input: &str) -> Result<InstrumentId, UnknownInstrument> {
        self.resolve(input).await.map_err(|e| match e {
            MarketError::UnknownInstrument(s) => UnknownInstrument(s),
            other => UnknownInstrument(format!("{input}: {other}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tessera_core::health::HealthStatus;
    use tessera_core::instrument::ContractMonth;
    use tessera_core::money::{Currency, Money, Price, Qty};
    use tessera_core::session::SessionCalendar;
    use tessera_core::time::{ExchangeTz, Timestamp};

    struct Listed {
        id: &'static str,
        instruments: Vec<Instrument>,
        down: std::sync::atomic::AtomicBool,
    }

    fn inst(id: &str, symbol: &str, root: Option<&str>, exchange: &str, front: bool) -> Instrument {
        let expiry = root.and_then(|r| {
            let m = tessera_core::instrument::contract_month(symbol, r, 2026)?;
            NaiveDate::from_ymd_opt(m.year, m.month.number(), 18)
        });
        Instrument {
            id: InstrumentId::new(id).unwrap(),
            symbol: symbol.into(),
            name: symbol.into(),
            asset_class: if root.is_some() {
                AssetClass::Future
            } else {
                AssetClass::Etf
            },
            exchange: exchange.into(),
            currency: Currency::Usd,
            root: root.map(str::to_owned),
            expiry,
            is_front: front,
            tradable: true,
        }
    }

    fn spec_of(i: &Instrument) -> ContractSpec {
        ContractSpec {
            instrument: i.id.clone(),
            asset_class: i.asset_class,
            root: i.root.clone(),
            tick_size: Price(rust_decimal::Decimal::new(25, 2)),
            tick_value: Money::usd(rust_decimal::Decimal::new(5, 0)),
            multiplier: rust_decimal::Decimal::new(20, 0),
            currency: Currency::Usd,
            price_decimals: 2,
            qty_step: Qty::from(1),
            min_qty: Qty::from(1),
            sessions: SessionCalendar::CmeEquityIndex,
            tz: ExchangeTz::CHICAGO,
            expiry: i.expiry,
            last_trade: None,
            roll_date: None,
            micro_of: None,
        }
    }

    #[async_trait]
    impl MarketDataProvider for Listed {
        fn id(&self) -> &str {
            self.id
        }
        fn display_name(&self) -> &str {
            self.id
        }
        fn capabilities(&self) -> MarketCapabilities {
            union([])
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth {
                provider_id: self.id.into(),
                kind: ProviderKind::MarketData,
                display_name: self.id.into(),
                status: if self.down.load(std::sync::atomic::Ordering::SeqCst) {
                    HealthStatus::Down
                } else {
                    HealthStatus::Ok
                },
                latency_ms: None,
                last_message_at: None,
                message: None,
                connection: None,
                accounts: None,
                checked_at: Timestamp(0),
            }
        }
        async fn search(
            &self,
            query: &str,
            _: Option<AssetClass>,
            limit: usize,
        ) -> Result<Vec<Instrument>, MarketError> {
            if self.down.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(MarketError::Unavailable("logging in".into()));
            }
            let q = query.trim().to_ascii_uppercase();
            Ok(self
                .instruments
                .iter()
                .filter(|i| i.symbol.starts_with(&q))
                .take(limit)
                .cloned()
                .collect())
        }
        async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
            let q = input.trim().to_ascii_uppercase();
            self.instruments
                .iter()
                .find(|i| {
                    i.id.as_str() == q
                        || i.symbol == q
                        || (i.is_front && i.root.as_deref() == Some(q.as_str()))
                })
                .map(|i| i.id.clone())
                .ok_or(MarketError::UnknownInstrument(q))
        }
        async fn spec(&self, id: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
            self.instruments
                .iter()
                .find(|i| &i.id == id)
                .map(|i| (i.clone(), spec_of(i)))
                .ok_or_else(|| MarketError::UnknownInstrument(id.to_string()))
        }
        async fn get_bars(&self, _: BarsRequest) -> Result<BarSeries, MarketError> {
            Err(MarketError::Unsupported("bars".into()))
        }
        async fn quote(&self, id: &InstrumentId) -> Result<Quote, MarketError> {
            Err(MarketError::Unsupported(id.to_string()))
        }
        fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
            Ok(futures::stream::pending().boxed())
        }
        fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
            Ok(futures::stream::pending().boxed())
        }
        fn subscribe_bars(
            &self,
            _: &InstrumentId,
            _: Timeframe,
        ) -> Result<MarketStream<LiveBar>, MarketError> {
            Ok(futures::stream::pending().boxed())
        }
    }

    fn other() -> Arc<Listed> {
        Arc::new(Listed {
            id: "other",
            instruments: vec![
                inst("NQZ6.CME", "NQZ6", Some("NQ"), "CME", true),
                inst("NQH7.CME", "NQH7", Some("NQ"), "CME", false),
                inst("QQQ", "QQQ", None, "NASDAQ", false),
            ],
            down: Default::default(),
        })
    }

    fn desk() -> Arc<MarketRouter> {
        let r = MarketRouter::new();
        r.add(Arc::new(Listed {
            id: "real",
            instruments: vec![
                inst("NQ-2026-12.REAL", "NQZ6", Some("NQ"), "CME", false),
                inst("NQ-2027-03.REAL", "NQH7", Some("NQ"), "CME", true),
                inst("MNQ-2026-12.REAL", "MNQZ6", Some("MNQ"), "CME", false),
            ],
            down: Default::default(),
        }))
        .unwrap();
        r.add(other()).unwrap();
        r
    }

    #[test]
    fn names_the_connections_whose_prices_stopped_coming_in() {
        let r = desk();
        assert!(r.prices_down().is_empty());
        let out = Arc::new(Listed {
            id: "out",
            instruments: vec![],
            down: std::sync::atomic::AtomicBool::new(true),
        });
        r.add(Arc::clone(&out) as Arc<dyn MarketDataProvider>)
            .unwrap();
        assert_eq!(r.prices_down(), ["out"]);
        out.down.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(r.prices_down().is_empty());
    }

    async fn ids(r: &MarketRouter, q: &str) -> Vec<String> {
        r.search(q, None, 20)
            .await
            .unwrap()
            .into_iter()
            .map(|i| i.id.to_string())
            .collect()
    }

    #[tokio::test]
    async fn the_data_choice_decides_what_a_root_resolves_to() {
        let r = desk();
        assert_eq!(r.data_choice(), DataChoice::Auto);
        assert_eq!(r.data_source().unwrap().id, "real");
        assert_eq!(r.resolve("NQ").await.unwrap().as_str(), "NQ-2027-03.REAL");
        let changes = r.changes();
        r.set_data_choice(DataChoice::from_setting("other"));
        assert!(
            changes.has_changed().unwrap(),
            "a change of source is announced"
        );
        assert_eq!(r.data_source().unwrap().id, "other");
        assert_eq!(r.resolve("NQ").await.unwrap().as_str(), "NQZ6.CME");
        assert_eq!(
            r.resolve("NQ-2026-12.REAL").await.unwrap().as_str(),
            "NQ-2026-12.REAL"
        );
        r.set_data_choice(DataChoice::from_setting("real"));
        assert_eq!(r.resolve("NQ").await.unwrap().as_str(), "NQ-2027-03.REAL");
        r.set_data_choice(DataChoice::from_setting("gone"));
        assert_eq!(r.data_source().unwrap().id, "real");
        assert_eq!(r.resolve("QQQ").await.unwrap().as_str(), "QQQ");
        r.remove("real");
        r.set_data_choice(DataChoice::Auto);
        assert_eq!(r.data_source().unwrap().id, "other");
    }

    #[tokio::test]
    async fn search_lists_the_data_connections_instruments_and_others_only_as_twins() {
        let r = desk();
        assert_eq!(
            ids(&r, "").await,
            [
                "NQ-2026-12.REAL",
                "NQ-2027-03.REAL",
                "MNQ-2026-12.REAL",
                "NQZ6.CME",
                "NQH7.CME"
            ]
        );
        assert!(
            ids(&r, "Q").await.is_empty(),
            "the other one's QQQ has no twin"
        );
        let down = MarketRouter::new();
        down.add(Arc::new(Listed {
            id: "real",
            instruments: vec![],
            down: std::sync::atomic::AtomicBool::new(true),
        }))
        .unwrap();
        down.add(r.get("other").unwrap()).unwrap();
        assert_eq!(ids(&down, "Q").await, ["QQQ"]);
        r.set_data_choice(DataChoice::from_setting("other"));
        assert_eq!(ids(&r, "Q").await, ["QQQ"]);
        assert_eq!(
            ids(&r, "").await,
            [
                "NQZ6.CME",
                "NQH7.CME",
                "QQQ",
                "NQ-2026-12.REAL",
                "NQ-2027-03.REAL"
            ]
        );
    }

    #[tokio::test]
    async fn every_connection_lists_what_it_serves_labelled_and_one_that_cannot_says_why() {
        let r = desk();
        let down = Arc::new(Listed {
            id: "down",
            instruments: vec![inst("ES-2026-12.DOWN", "ESZ6", Some("ES"), "CME", true)],
            down: std::sync::atomic::AtomicBool::new(true),
        });
        r.add(down).unwrap();
        let qqq = InstrumentId::new("QQQ").unwrap();
        r.bind(&qqq, "real");
        let listed = r.list_by_connection(None, None, 500).await;
        let brief: Vec<(&str, bool, usize, bool)> = listed
            .iter()
            .map(|c| {
                (
                    c.id.as_str(),
                    c.feeds_desk,
                    c.instruments.len(),
                    c.error.is_some(),
                )
            })
            .collect();
        assert_eq!(
            brief,
            [
                ("real", true, 3, false),
                ("other", false, 3, false),
                ("down", false, 0, true),
            ]
        );
        assert!(listed[2].error.as_deref().unwrap().contains("logging in"));
        assert!(listed[1].instruments.iter().any(|i| i.id == qqq));
        assert_eq!(r.binding(&qqq).as_deref(), Some("real"), "not moved");
        let dec = InstrumentId::new("NQ-2026-12.REAL").unwrap();
        assert_eq!(r.binding(&dec).as_deref(), Some("real"));
        assert_eq!(
            r.binding(&InstrumentId::new("NQH7.CME").unwrap())
                .as_deref(),
            Some("other")
        );
        let one = r.list_by_connection(Some("other"), None, 2).await;
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].instruments.len(), 2);
        assert!(
            r.list_by_connection(Some("gone"), None, 10)
                .await
                .is_empty()
        );
        r.set_data_choice(DataChoice::from_setting("other"));
        let listed = r.list_by_connection(None, None, 500).await;
        assert_eq!(listed[0].id, "other");
        assert!(listed[0].feeds_desk && !listed[1].feeds_desk);
    }

    #[tokio::test]
    async fn a_connection_is_asked_for_its_own_instrument_of_an_exchange_contract() {
        let r = desk();
        let dec = ContractMonth::parse("2026-12");
        let nq = ExchangeContract::new("CME", "NQ", dec);
        let real = r.contract_on("real", &nq).await.unwrap().unwrap();
        assert_eq!(real.id.as_str(), "NQ-2026-12.REAL");
        assert_eq!(r.binding(&real.id).as_deref(), Some("real"));
        let mnq = r.contract_on("real", &nq.with_root("MNQ")).await.unwrap();
        assert_eq!(mnq.unwrap().id.as_str(), "MNQ-2026-12.REAL");
        let theirs = r.contract_on("other", &nq).await.unwrap().unwrap();
        assert_eq!(theirs.id.as_str(), "NQZ6.CME");
        assert_eq!(
            r.contract_on("other", &nq.with_root("MNQ")).await.unwrap(),
            None
        );
        let undated = ExchangeContract::new("NASDAQ", "QQQ", None);
        assert_eq!(r.contract_on("real", &undated).await.unwrap(), None);
        assert!(matches!(
            r.contract_on("gone", &nq).await,
            Err(MarketError::Unavailable(_))
        ));
        assert_eq!(r.serving(&theirs.id).await.unwrap().id, "other");
        assert_eq!(r.connection("real").unwrap().display_name, "real");
        assert_eq!(
            r.contract_for(&nq).await.unwrap().unwrap().id.as_str(),
            "NQ-2026-12.REAL"
        );
    }

    fn routes(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(e, c)| ((*e).to_owned(), (*c).to_owned()))
            .collect()
    }

    #[tokio::test]
    async fn an_exchange_takes_the_connection_chosen_for_it() {
        let r = desk();
        let mut changes = r.changes();
        changes.borrow_and_update();
        r.set_exchange_choices(routes(&[("cme", "other")]));
        assert!(changes.has_changed().unwrap(), "CME's data moved");
        assert_eq!(r.exchange_choices(), routes(&[("CME", "other")]));
        assert_eq!(r.data_source().unwrap().id, "real", "the default stays");
        assert_eq!(r.data_source_for("CME").unwrap().id, "other");
        assert_eq!(r.data_source_for("nasdaq").unwrap().id, "real");
        assert_eq!(r.resolve("NQ").await.unwrap().as_str(), "NQZ6.CME");
        assert_eq!(
            r.binding(&InstrumentId::new("NQZ6.CME").unwrap())
                .as_deref(),
            Some("other")
        );
        assert_eq!(
            ids(&r, "").await,
            ["NQZ6.CME", "NQH7.CME", "NQ-2026-12.REAL", "NQ-2027-03.REAL"]
        );
        let dec = ContractMonth::parse("2026-12");
        let nq = ExchangeContract::new("CME", "NQ", dec);
        let qqq = ExchangeContract::new("NASDAQ", "QQQ", None);
        assert_eq!(
            r.contract_for(&nq).await.unwrap().unwrap().id.as_str(),
            "NQZ6.CME"
        );
        assert_eq!(r.contract_for(&qqq).await.unwrap(), None);
        r.set_exchange_choices(routes(&[("CME", "other"), ("NASDAQ", "other")]));
        assert_eq!(
            r.contract_for(&qqq).await.unwrap().unwrap().id.as_str(),
            "QQQ"
        );
        r.set_exchange_choices(routes(&[("CME", "gone")]));
        assert_eq!(r.data_source_for("CME").unwrap().id, "real");
        assert_eq!(r.resolve("NQ").await.unwrap().as_str(), "NQ-2027-03.REAL");
        changes.borrow_and_update();
        r.set_exchange_choices(routes(&[("CME", "gone"), ("COMEX", "real")]));
        r.set_exchange_choices(BTreeMap::new());
        assert!(!changes.has_changed().unwrap());
    }

    #[tokio::test]
    async fn an_exchange_whose_connection_cannot_answer_is_listed_from_the_others() {
        let r = MarketRouter::new();
        let real = Arc::new(Listed {
            id: "real",
            instruments: vec![
                inst("NQ-2026-12.REAL", "NQZ6", Some("NQ"), "CME", false),
                inst("NQ-2027-03.REAL", "NQH7", Some("NQ"), "CME", true),
                inst("MNQ-2026-12.REAL", "MNQZ6", Some("MNQ"), "CME", false),
            ],
            down: Default::default(),
        });
        r.add(Arc::clone(&real) as Arc<dyn MarketDataProvider>)
            .unwrap();
        r.add(other()).unwrap();
        r.set_data_choice(DataChoice::from_setting("other"));
        r.set_exchange_choices(routes(&[("CME", "real")]));
        assert_eq!(
            ids(&r, "").await,
            [
                "QQQ",
                "NQ-2026-12.REAL",
                "NQ-2027-03.REAL",
                "MNQ-2026-12.REAL",
                "NQZ6.CME",
                "NQH7.CME"
            ]
        );
        real.down.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(ids(&r, "").await, ["NQZ6.CME", "NQH7.CME", "QQQ"]);
    }

    #[tokio::test]
    async fn an_exchange_routed_to_the_default_changes_nothing() {
        let r = desk();
        let mut changes = r.changes();
        changes.borrow_and_update();
        r.set_exchange_choices(routes(&[("CME", "real"), ("NASDAQ", "real")]));
        assert!(!changes.has_changed().unwrap());
        assert_eq!(r.resolve("NQ").await.unwrap().as_str(), "NQ-2027-03.REAL");
        assert_eq!(
            ids(&r, "").await,
            [
                "NQ-2026-12.REAL",
                "NQ-2027-03.REAL",
                "MNQ-2026-12.REAL",
                "NQZ6.CME",
                "NQH7.CME"
            ]
        );
    }

    fn two_logins() -> Arc<MarketRouter> {
        let r = MarketRouter::new();
        for id in ["apex", "bulenox"] {
            r.add(Arc::new(Listed {
                id,
                instruments: vec![
                    inst("NQZ6.CME-RITHMIC", "NQZ6", Some("NQ"), "CME", true),
                    inst("GCZ6.COMEX-RITHMIC", "GCZ6", Some("GC"), "COMEX", true),
                ],
                down: Default::default(),
            }))
            .unwrap();
        }
        r
    }

    #[tokio::test]
    async fn two_logins_issuing_the_same_ids_each_serve_what_is_routed_to_them() {
        let r = two_logins();
        let nq = InstrumentId::new("NQZ6.CME-RITHMIC").unwrap();
        let gc = InstrumentId::new("GCZ6.COMEX-RITHMIC").unwrap();
        let want = ExchangeContract::new("CME", "NQ", ContractMonth::parse("2026-12"));
        assert_eq!(ids(&r, "").await, [nq.as_str(), gc.as_str()]);
        assert_eq!(r.binding(&nq).as_deref(), Some("apex"));
        assert_eq!(r.binding(&gc).as_deref(), Some("apex"));
        r.set_exchange_choices(routes(&[("CME", "bulenox")]));
        assert_eq!(r.serving(&nq).await.unwrap().id, "bulenox");
        assert_eq!(r.binding(&gc).as_deref(), Some("apex"));
        assert_eq!(r.resolve("NQ").await.unwrap(), nq);
        assert_eq!(ids(&r, "").await, [gc.as_str(), nq.as_str()]);
        assert_eq!(r.binding(&nq).as_deref(), Some("bulenox"));
        assert_eq!(r.contract_on("apex", &want).await.unwrap().unwrap().id, nq);
        assert_eq!(r.binding(&nq).as_deref(), Some("bulenox"));
        assert_eq!(r.contract_for(&want).await.unwrap().unwrap().id, nq);
        r.set_data_choice(DataChoice::from_setting("bulenox"));
        assert_eq!(r.serving(&gc).await.unwrap().id, "bulenox");
        assert_eq!(r.binding(&nq).as_deref(), Some("bulenox"));
        r.set_exchange_choices(routes(&[("CME", "apex")]));
        assert_eq!(r.spec(&nq).await.unwrap().0.id, nq);
        assert_eq!(r.binding(&nq).as_deref(), Some("apex"));
        assert_eq!(r.binding(&gc).as_deref(), Some("bulenox"));
        r.set_data_choice(DataChoice::Auto);
        r.set_exchange_choices(BTreeMap::new());
        assert_eq!(r.resolve("GC").await.unwrap(), gc);
        assert_eq!(r.binding(&gc).as_deref(), Some("apex"));
    }

    #[tokio::test]
    async fn the_login_an_exchange_is_routed_to_takes_over_its_instruments() {
        let r = two_logins();
        let nq = InstrumentId::new("NQZ6.CME-RITHMIC").unwrap();
        r.set_exchange_choices(routes(&[("CME", "bulenox")]));
        r.bind(&nq, "apex");
        let mut changes = r.changes();
        changes.borrow_and_update();
        let want = ExchangeContract::new("CME", "NQ", ContractMonth::parse("2026-12"));
        r.contract_on("bulenox", &want).await.unwrap();
        assert_eq!(r.binding(&nq).as_deref(), Some("bulenox"));
        assert!(changes.has_changed().unwrap());
    }
}
