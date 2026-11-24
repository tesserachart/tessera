use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde_json::Value;
use tessera_core::market::{Aggressor, DataSource};
use tessera_core::{InstrumentId, Price, Timeframe, Timestamp};
use tessera_host::{EventBus, Keepalive, TopicKey};
use tessera_market::hub::{MarketHub, MarketPumpGuard, PumpKey};
use tessera_market::io::{BarUpdate, TradesUpdate};
use tessera_market::orderflow::imbalance::Rule;
use tessera_market::orderflow::zones::{Zone, ZonesAsk, stacked_zones};
use tessera_market::{MarketDataProvider, MarketRouter, exchange_contract};
use tessera_protocol::drawings::Drawing;
use tessera_protocol::topics::{LevelsUpdate, names};
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;

use crate::deps::{AlertSources, IndicatorReading};
use crate::eval::{Observation, Outcome, Tracker, Values, drawing_at, indicator_line_at};
use crate::flow::FlowEvents;
use crate::io::{Alert, AlertLive, Operand};
use crate::service::AlertsService;

pub const CONCEPTS_LEVELS: &str = "concepts.levels";
const TICK: Duration = Duration::from_secs(1);
const IDLE_ORDER: Duration = Duration::from_millis(250);
const EXPIRY: Duration = Duration::from_secs(5);

pub struct AlertEngine {
    service: Arc<AlertsService>,
    hub: Arc<MarketHub>,
    bus: Arc<EventBus>,
    sources: Arc<dyn AlertSources>,
}

impl std::fmt::Debug for AlertEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AlertEngine").finish_non_exhaustive()
    }
}

impl AlertEngine {
    pub fn new(
        service: Arc<AlertsService>,
        hub: Arc<MarketHub>,
        bus: Arc<EventBus>,
        sources: Arc<dyn AlertSources>,
    ) -> Arc<Self> {
        Arc::new(Self {
            service,
            hub,
            bus,
            sources,
        })
    }

    pub fn spawn(self: &Arc<Self>) -> JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move { me.run().await })
    }

    async fn run(self: Arc<Self>) {
        self.service.refresh_discord().await;
        let mut changes = self.service.changes();
        let mut sources = self.service.market().changes();
        let mut expiry = tokio::time::interval(EXPIRY);
        expiry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut watches: HashMap<InstrumentId, JoinHandle<()>> = HashMap::new();
        self.follow_sources().await;
        loop {
            let wanted = self.service.active_by_instrument();
            watches.retain(|id, task| {
                let keep = wanted.contains_key(id) && !task.is_finished();
                if !keep {
                    task.abort();
                }
                keep
            });
            for id in wanted.keys() {
                if !watches.contains_key(id) {
                    let me = Arc::clone(&self);
                    let id2 = id.clone();
                    watches.insert(id.clone(), tokio::spawn(async move { me.watch(id2).await }));
                }
            }
            tokio::select! {
                r = changes.changed() => if r.is_err() { break },
                r = sources.changed() => {
                    if r.is_err() { break }
                    self.follow_sources().await;
                }
                _ = expiry.tick() => {
                    self.service.expire_due(self.service.clock().now()).await;
                }
            }
        }
        for (_, t) in watches {
            t.abort();
        }
    }

    async fn follow_sources(&self) {
        let market = Arc::clone(self.service.market());
        for alerts in self.service.active_by_instrument().into_values() {
            let Some(from) = alerts.first().map(|a| a.instrument.clone()) else {
                continue;
            };
            if let Some(to) = contract_on_chosen_data_source(&market, &from).await {
                for a in alerts {
                    if let Err(e) = self.service.move_to(&a.id, to.clone()).await {
                        tracing::warn!(alert = %a.id, error = %e.message, "could not move an alert onto the chosen market data");
                    }
                }
            }
        }
    }

    async fn watch(self: Arc<Self>, id: InstrumentId) {
        let Some((mut trades, _)) = self.bus.subscribe(names::MARKET_TRADES) else {
            tracing::warn!("alerts: no market.trades topic; nothing is evaluated");
            return;
        };
        let Some((mut bars, _)) = self.bus.subscribe(names::MARKET_BARS) else {
            return;
        };
        let mut levels = self.bus.subscribe(names::INTEL_LEVELS).map(|(rx, _)| rx);
        let mut computed = self.bus.subscribe(CONCEPTS_LEVELS).map(|(rx, _)| rx);
        let _trades = match self.hub.acquire(PumpKey::Trades(id.clone())) {
            Ok(g) => Some(g),
            Err(e) => {
                tracing::warn!(instrument = %id, error = %e, "alerts: no trade feed");
                None
            }
        };
        let mut changes = self.service.changes();
        let mut w = Watch::new(id.clone());
        self.reload(&mut w).await;
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                r = trades.recv() => match r {
                    Ok(ev) if ev.key == TopicKey::Instrument(id.clone()) => {
                        if let Ok(u) = serde_json::from_str::<TradesUpdate>(ev.data.get()) {
                            self.on_trades(&mut w, u).await;
                        }
                    }
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => return,
                },
                r = bars.recv() => match r {
                    Ok(ev) => {
                        if let TopicKey::Bars(i, tf) = &ev.key
                            && *i == id
                            && w.bar_feeds.contains_key(tf)
                            && let Ok(u) = serde_json::from_str::<BarUpdate>(ev.data.get())
                            && u.closed
                        {
                            self.on_close(&mut w, u).await;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => return,
                },
                Some(u) = recv_levels(&mut levels, &id) => w.put_levels(u),
                Some(u) = recv_levels(&mut computed, &id) => w.put_levels(u),
                r = changes.changed() => {
                    if r.is_err() { return }
                    self.reload(&mut w).await;
                }
                _ = tick.tick() => {
                    self.close_idle_order(&mut w).await;
                    self.refresh_drawings(&mut w).await;
                    self.announce(&w);
                }
            }
        }
    }

    async fn reload(&self, w: &mut Watch) {
        let alerts: Vec<Alert> = self
            .service
            .active_by_instrument()
            .remove(&w.id)
            .unwrap_or_default();
        let keep: HashSet<&str> = alerts.iter().map(|a| a.id.as_str()).collect();
        w.alerts.retain(|k, _| keep.contains(k.as_str()));
        for a in &alerts {
            let fresh = w
                .alerts
                .get(&a.id)
                .is_none_or(|(old, _)| old.updated_at != a.updated_at || old.steps != a.steps);
            if fresh {
                let mut t = Tracker::new(a);
                if let Some((price, at)) = w.last {
                    t.prime(a, &Observation::trade(at, price), &w.values(a.interval));
                }
                w.alerts.insert(a.id.clone(), (a.clone(), t));
            } else if let Some((old, _)) = w.alerts.get_mut(&a.id) {
                *old = a.clone();
            }
        }
        let need: HashSet<Timeframe> = alerts
            .iter()
            .filter(|a| a.needs_bars())
            .map(|a| a.interval)
            .collect();
        w.bar_feeds.retain(|tf, _| need.contains(tf));
        for tf in need {
            if let std::collections::hash_map::Entry::Vacant(e) = w.bar_feeds.entry(tf) {
                match self.hub.acquire(PumpKey::Bars(w.id.clone(), tf)) {
                    Ok(g) => {
                        e.insert(g);
                    }
                    Err(err) => {
                        tracing::warn!(instrument = %w.id, %tf, error = %err, "alerts: no bar feed")
                    }
                }
            }
        }
        let wants_levels = alerts
            .iter()
            .flat_map(operands)
            .any(|o| matches!(o, Operand::Level { .. }));
        if wants_levels && w.level_guards.is_none() {
            let (now, guards) = self.sources.follow_levels(&w.id).await;
            for u in now {
                w.put_levels(u);
            }
            w.level_guards = Some(guards);
        }
        let wants_orders = alerts
            .iter()
            .flat_map(|a| &a.steps)
            .any(|s| matches!(s.subject, Operand::BigTrade { .. }));
        if !wants_orders {
            w.flow = None;
        } else if w.flow.is_none() {
            match self.service.market().spec(&w.id).await {
                Ok((_, spec)) => w.flow = Some(FlowEvents::new(w.id.clone(), spec.tick_size)),
                Err(e) => {
                    tracing::warn!(instrument = %w.id, error = %e, "alerts: no tick size to join big trades")
                }
            }
        }
        let books: HashSet<ZoneKey> = alerts.iter().filter_map(zone_key).collect();
        w.zones.retain(|k, _| books.contains(k));
        for k in books {
            if !w.zones.contains_key(&k) {
                let book = match self.read_zones(&w.id, &k, None).await {
                    Ok(zones) => ZoneBook::open(zones),
                    Err(e) => ZoneBook::failed(e),
                };
                w.zones.insert(k, book);
            }
        }
        let wanted: Vec<IndicatorKey> = alerts.iter().flat_map(indicator_keys).collect();
        w.readings.retain(|k, _| wanted.contains(k));
        for k in wanted {
            if !w.readings.contains_key(&k) {
                let r = self.read_indicator(&w.id, &k).await;
                w.readings.insert(k, r);
            }
        }
        self.refresh_drawings(w).await;
        self.announce(w);
    }

    async fn read_indicator(
        &self,
        id: &InstrumentId,
        k: &IndicatorKey,
    ) -> Result<IndicatorReading, String> {
        let inputs = match &k.inputs {
            Value::Object(m) => m.clone(),
            _ => Default::default(),
        };
        self.sources
            .indicator(&k.indicator, &inputs, id, k.tf)
            .await
    }

    async fn refresh_drawings(&self, w: &mut Watch) {
        let ids: HashSet<String> = w
            .alerts
            .values()
            .flat_map(|(a, _)| operands(a))
            .filter_map(|o| match o {
                Operand::Drawing { drawing_id, .. } => Some(drawing_id.clone()),
                _ => None,
            })
            .collect();
        w.drawings.retain(|k, _| ids.contains(k));
        for d in ids {
            let found = self.sources.drawing(&d).await;
            w.drawings.insert(d, found);
        }
    }

    async fn on_trades(&self, w: &mut Watch, u: TradesUpdate) {
        w.source = Some(u.source.clone());
        for t in &u.trades {
            let (obs, order) = match w.flow.as_mut() {
                Some(f) => f.print(t),
                None => (Observation::print(Timestamp(t.0), t.1, t.2, t.3), None),
            };
            w.last = Some((t.1, obs.at));
            if let Some(order) = order {
                self.observe(w, &order, |_| true).await;
            }
            self.observe(w, &obs, |_| true).await;
            for (key, zone) in w.touch_zones(t.1, obs.at) {
                let side = if zone.side == Aggressor::Buy { 1 } else { -1 };
                let hit = Observation::zone(obs.at, t.1, zone.rows, side);
                self.observe(w, &hit, |a| zone_key(a).as_ref() == Some(&key))
                    .await;
            }
        }
        if !u.trades.is_empty() {
            w.last_print = Some(std::time::Instant::now());
        }
    }

    async fn close_idle_order(&self, w: &mut Watch) {
        if w.last_print.is_none_or(|t| t.elapsed() < IDLE_ORDER) {
            return;
        }
        if let Some(order) = w.flow.as_mut().and_then(FlowEvents::idle) {
            self.observe(w, &order, |_| true).await;
        }
    }

    async fn on_close(&self, w: &mut Watch, u: BarUpdate) {
        let t = u.bar.0;
        if w.closed.get(&u.tf).is_some_and(|last| *last >= t) {
            return;
        }
        w.closed.insert(u.tf, t);
        w.source = Some(u.source.clone());
        let keys: Vec<IndicatorKey> = w
            .readings
            .keys()
            .filter(|k| k.tf == u.tf)
            .cloned()
            .collect();
        for k in keys {
            let r = self.read_indicator(&w.id, &k).await;
            w.readings.insert(k, r);
        }
        let books: Vec<ZoneKey> = w.zones.keys().filter(|k| k.tf == u.tf).cloned().collect();
        for k in books {
            match self.read_zones(&w.id, &k, Some(Timestamp(t))).await {
                Ok(fresh) => {
                    if let Some(book) = w.zones.get_mut(&k) {
                        book.arm(fresh);
                    }
                }
                Err(e) => {
                    tracing::debug!(instrument = %w.id, error = %e, "alerts: no stacked imbalances for a closed bar")
                }
            }
        }
        let obs = Observation::close(Timestamp(t), u.tf, u.bar.4);
        self.observe(w, &obs, |a| a.interval == u.tf).await;
    }

    async fn read_zones(
        &self,
        id: &InstrumentId,
        k: &ZoneKey,
        from: Option<Timestamp>,
    ) -> Result<Vec<Zone>, String> {
        stacked_zones(
            &self.hub,
            ZonesAsk {
                instrument: id,
                tf: k.tf,
                rule: k.rule(),
                stack_rows: k.stack_rows,
                row_ticks: k.row_ticks,
                from,
                now: self.service.clock().now(),
            },
        )
        .await
        .map_err(|e| e.message)
    }

    async fn observe(&self, w: &mut Watch, obs: &Observation, scope: impl Fn(&Alert) -> bool) {
        let mut outcomes = Vec::new();
        {
            let Watch {
                alerts,
                levels,
                drawings,
                readings,
                closed,
                ..
            } = w;
            for (id, (a, t)) in alerts.iter_mut() {
                if !scope(a) {
                    continue;
                }
                let values = Reader {
                    levels,
                    drawings,
                    readings,
                    closed,
                    interval: a.interval,
                };
                let o = t.observe(a, obs, &values);
                if o != Outcome::Quiet {
                    outcomes.push((id.clone(), o));
                }
            }
        }
        if outcomes.is_empty() {
            return;
        }
        let provider = w
            .source
            .as_ref()
            .map(|s| s.provider.clone())
            .unwrap_or_default();
        let name = self
            .service
            .market()
            .get(&provider)
            .map(|p| p.display_name().to_owned())
            .unwrap_or(provider);
        for (id, o) in outcomes {
            match o {
                Outcome::Fired(r) => {
                    self.service.fire(&id, r, obs, &name).await;
                }
                Outcome::Expired => self.service.expire(&id).await,
                Outcome::Advanced(_) | Outcome::Reset | Outcome::Quiet => {}
            }
        }
        self.announce(w);
    }

    fn announce(&self, w: &Watch) {
        for (id, (a, t)) in &w.alerts {
            let values = w.values(a.interval);
            let step = t.step().min(a.steps.len().saturating_sub(1));
            let s = &a.steps[step];
            let (price, at) = w.last.unwrap_or((f64::NAN, Timestamp(0)));
            let obs = Observation {
                bar: w.closed.get(&a.interval).map(|t| Timestamp(*t)),
                ..Observation::trade(at, price)
            };
            let target = match &s.target {
                _ if s.subject.is_event() => None,
                Operand::Value { value } => Some(*value),
                Operand::Price => None,
                o => values.value(o, &obs),
            };
            let live = AlertLive {
                price: target.map(|p| (p * 1e6).round() / 1e6),
                step: step as u32,
                bars: t.closes_since_first_step(),
                problem: w.problem(a),
            };
            self.service.set_live(id, live);
        }
    }
}

async fn contract_on_chosen_data_source(
    market: &MarketRouter,
    from: &InstrumentId,
) -> Option<InstrumentId> {
    let on = market.serving(from).await.ok()?;
    let (inst, _) = market.spec(from).await.ok()?;
    let target = market.data_source_for(&inst.exchange)?;
    if on.id == target.id {
        return None;
    }
    let want = exchange_contract(&inst)?;
    market
        .contract_on(&target.id, &want)
        .await
        .ok()
        .flatten()
        .map(|i| i.id)
        .filter(|to| to != from)
}

async fn recv_levels(
    rx: &mut Option<tokio::sync::broadcast::Receiver<Arc<tessera_host::BusEvent>>>,
    id: &InstrumentId,
) -> Option<LevelsUpdate> {
    let r = rx.as_mut()?;
    loop {
        match r.recv().await {
            Ok(ev) if ev.key == TopicKey::Instrument(id.clone()) => {
                if let Ok(u) = serde_json::from_str::<LevelsUpdate>(ev.data.get()) {
                    return Some(u);
                }
            }
            Ok(_) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => {
                *rx = None;
                return None;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct IndicatorKey {
    indicator: String,
    inputs: Value,
    tf: Timeframe,
}

fn operands(a: &Alert) -> impl Iterator<Item = &Operand> {
    a.steps.iter().flat_map(|s| [&s.subject, &s.target])
}

fn indicator_keys(a: &Alert) -> Vec<IndicatorKey> {
    operands(a)
        .filter_map(|o| match o {
            Operand::Plot {
                indicator, inputs, ..
            }
            | Operand::IndicatorLine {
                indicator, inputs, ..
            } => Some(IndicatorKey {
                indicator: indicator.clone(),
                inputs: Value::Object(inputs.clone()),
                tf: a.interval,
            }),
            _ => None,
        })
        .collect()
}

struct Watch {
    id: InstrumentId,
    alerts: BTreeMap<String, (Alert, Tracker)>,
    bar_feeds: HashMap<Timeframe, MarketPumpGuard>,
    level_guards: Option<Vec<Keepalive>>,
    levels: HashMap<String, LevelsUpdate>,
    drawings: HashMap<String, Option<Drawing>>,
    readings: HashMap<IndicatorKey, Result<IndicatorReading, String>>,
    closed: HashMap<Timeframe, i64>,
    last: Option<(f64, Timestamp)>,
    source: Option<DataSource>,
    flow: Option<FlowEvents>,
    last_print: Option<std::time::Instant>,
    zones: HashMap<ZoneKey, ZoneBook>,
}

impl Watch {
    fn new(id: InstrumentId) -> Self {
        Self {
            id,
            alerts: BTreeMap::new(),
            bar_feeds: HashMap::new(),
            level_guards: None,
            levels: HashMap::new(),
            drawings: HashMap::new(),
            readings: HashMap::new(),
            closed: HashMap::new(),
            last: None,
            source: None,
            flow: None,
            last_print: None,
            zones: HashMap::new(),
        }
    }

    fn touch_zones(&mut self, price: f64, at: Timestamp) -> Vec<(ZoneKey, Zone)> {
        let Some(price) = Decimal::from_f64(price).map(Price) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (k, book) in &mut self.zones {
            out.extend(book.touch(price, at).into_iter().map(|z| (k.clone(), z)));
        }
        out
    }

    fn put_levels(&mut self, u: LevelsUpdate) {
        if u.levels.is_empty() {
            self.levels.remove(&u.provider);
        } else {
            self.levels.insert(u.provider.clone(), u);
        }
    }

    fn values(&self, interval: Timeframe) -> Reader<'_> {
        Reader {
            levels: &self.levels,
            drawings: &self.drawings,
            readings: &self.readings,
            closed: &self.closed,
            interval,
        }
    }

    fn problem(&self, a: &Alert) -> Option<String> {
        for o in operands(a) {
            match o {
                Operand::Level { key, provider, .. } => {
                    if find_level(&self.levels, key, provider.as_deref()).is_none() {
                        return Some(format!("no level {key} on {} now", self.id));
                    }
                }
                Operand::Drawing { drawing_id, .. } => match self.drawings.get(drawing_id) {
                    Some(Some(d)) if crate::eval::is_line(d.kind) => {}
                    Some(Some(_)) => return Some("the drawing is not a line".into()),
                    _ => return Some("the drawing is gone".into()),
                },
                Operand::IndicatorLine {
                    indicator,
                    inputs,
                    label,
                    ..
                } => match self.reading(indicator, inputs, a.interval) {
                    Some(Ok(r)) => {
                        if !r
                            .lines
                            .iter()
                            .any(|l| l.label.as_ref().is_some_and(|t| &t.text == label))
                        {
                            return Some(format!(
                                "the indicator draws no line labelled {label} now"
                            ));
                        }
                    }
                    Some(Err(e)) => return Some(e.clone()),
                    None => {}
                },
                Operand::Plot {
                    indicator, inputs, ..
                } => {
                    if let Some(Err(e)) = self.reading(indicator, inputs, a.interval) {
                        return Some(e.clone());
                    }
                }
                Operand::StackedImbalance { .. } => {
                    if let Some(e) = zone_key(a)
                        .and_then(|k| self.zones.get(&k))
                        .and_then(|b| b.problem.as_ref())
                    {
                        return Some(e.clone());
                    }
                }
                Operand::Price
                | Operand::Value { .. }
                | Operand::BigTrade { .. }
                | Operand::Print { .. } => {}
            }
        }
        None
    }

    fn reading(
        &self,
        indicator: &str,
        inputs: &serde_json::Map<String, Value>,
        tf: Timeframe,
    ) -> Option<&Result<IndicatorReading, String>> {
        self.readings.get(&IndicatorKey {
            indicator: indicator.to_owned(),
            inputs: Value::Object(inputs.clone()),
            tf,
        })
    }
}

fn find_level<'a>(
    levels: &'a HashMap<String, LevelsUpdate>,
    key: &str,
    provider: Option<&str>,
) -> Option<&'a tessera_core::levels::Level> {
    levels
        .values()
        .filter(|u| provider.is_none_or(|p| p == u.provider))
        .flat_map(|u| u.levels.iter())
        .find(|l| l.key == key && l.price.is_some())
}

struct Reader<'a> {
    levels: &'a HashMap<String, LevelsUpdate>,
    drawings: &'a HashMap<String, Option<Drawing>>,
    readings: &'a HashMap<IndicatorKey, Result<IndicatorReading, String>>,
    closed: &'a HashMap<Timeframe, i64>,
    interval: Timeframe,
}

impl Values for Reader<'_> {
    fn value(&self, operand: &Operand, obs: &Observation) -> Option<f64> {
        match operand {
            Operand::Price => Some(obs.price),
            Operand::Value { value } => Some(*value),
            Operand::Level { key, provider, .. } => {
                find_level(self.levels, key, provider.as_deref())
                    .and_then(|l| l.price)
                    .map(|p| p.to_f64())
            }
            Operand::Drawing { drawing_id, .. } => {
                drawing_at(self.drawings.get(drawing_id)?.as_ref()?, obs.at)
            }
            Operand::IndicatorLine {
                indicator,
                inputs,
                label,
                ..
            } => {
                let r = self.reading(indicator, inputs)?;
                indicator_line_at(&r.lines, label, obs.at)
            }
            Operand::Plot {
                indicator,
                inputs,
                plot,
                ..
            } => {
                let r = self.reading(indicator, inputs)?;
                let bar = obs
                    .bar
                    .or_else(|| self.closed.get(&self.interval).map(|t| Timestamp(*t)));
                r.plot_at(plot, bar)
            }
            Operand::BigTrade { .. } | Operand::Print { .. } | Operand::StackedImbalance { .. } => {
                None
            }
        }
    }
}

impl Reader<'_> {
    fn reading(
        &self,
        indicator: &str,
        inputs: &serde_json::Map<String, Value>,
    ) -> Option<&IndicatorReading> {
        self.readings
            .get(&IndicatorKey {
                indicator: indicator.to_owned(),
                inputs: Value::Object(inputs.clone()),
                tf: self.interval,
            })?
            .as_ref()
            .ok()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ZoneKey {
    tf: Timeframe,
    ratio: u64,
    min_volume: u64,
    min_difference: u64,
    include_zero: bool,
    row_ticks: u32,
    stack_rows: u32,
}

impl ZoneKey {
    fn rule(&self) -> Rule {
        Rule {
            ratio: f64::from_bits(self.ratio),
            min_volume: f64::from_bits(self.min_volume),
            min_difference: f64::from_bits(self.min_difference),
            include_zero: self.include_zero,
        }
    }
}

fn zone_key(a: &Alert) -> Option<ZoneKey> {
    a.steps.iter().find_map(|s| match (&s.subject, &s.target) {
        (
            Operand::StackedImbalance {
                ratio,
                min_volume,
                min_difference,
                include_zero,
                row_ticks,
                ..
            },
            Operand::Value { value },
        ) => Some(ZoneKey {
            tf: a.interval,
            ratio: ratio.to_bits(),
            min_volume: min_volume.to_bits(),
            min_difference: min_difference.to_bits(),
            include_zero: *include_zero,
            row_ticks: *row_ticks,
            stack_rows: value.max(1.0) as u32,
        }),
        _ => None,
    })
}

#[derive(Debug, Default)]
struct ZoneBook {
    zones: Vec<Zone>,
    problem: Option<String>,
}

impl ZoneBook {
    fn open(zones: Vec<Zone>) -> Self {
        Self {
            zones,
            problem: None,
        }
    }

    fn failed(problem: String) -> Self {
        Self {
            zones: Vec::new(),
            problem: Some(problem),
        }
    }

    fn arm(&mut self, fresh: Vec<Zone>) {
        for z in fresh {
            if !self
                .zones
                .iter()
                .any(|o| o.t == z.t && o.side == z.side && o.low == z.low)
            {
                self.zones.push(z);
            }
        }
    }

    fn touch(&mut self, price: Price, at: Timestamp) -> Vec<Zone> {
        let mut hit = Vec::new();
        self.zones.retain(|z| {
            if at >= z.expires_at {
                return false;
            }
            if z.holds(price) {
                hit.push(*z);
                return false;
            }
            true
        });
        hit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::Outcome;
    use crate::io::{
        AlertDelivery, AlertOp, AlertRepeat, AlertStatus, AlertStep, EvaluateOn, FlowSide,
    };
    use std::str::FromStr;

    fn p(s: &str) -> Price {
        Price::from_str(s).unwrap()
    }

    fn zone(t: i64, side: Aggressor, low: &str, top: &str) -> Zone {
        Zone {
            t: Timestamp(t),
            side,
            low: p(low),
            top: p(top),
            rows: 3,
            expires_at: Timestamp(1_000),
        }
    }

    fn alert(side: FlowSide, rows: f64) -> Alert {
        Alert {
            id: "al_zone".into(),
            symbol: "NQ".into(),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            interval: Timeframe::M5,
            steps: vec![AlertStep {
                subject: Operand::StackedImbalance {
                    side,
                    ratio: 3.0,
                    min_volume: 5.0,
                    min_difference: 0.0,
                    include_zero: false,
                    row_ticks: 4,
                },
                op: AlertOp::AtLeast,
                target: Operand::Value { value: rows },
                on: EvaluateOn::Trade,
            }],
            within_bars: None,
            repeat: AlertRepeat::Every,
            cooldown_secs: 0,
            expires_at: None,
            message: None,
            deliver: AlertDelivery::default(),
            ask_analyst: false,
            status: AlertStatus::Active,
            title: String::new(),
            created_by: "user".into(),
            session_id: None,
            created_at: Timestamp(0),
            updated_at: Timestamp(0),
            fired_at: None,
            fire_count: 0,
            live: AlertLive::default(),
        }
    }

    #[test]
    fn a_zone_is_spent_by_the_first_trade_inside_it_and_gone_once_it_expires() {
        let mut book = ZoneBook::open(vec![
            zone(1, Aggressor::Buy, "100.00", "101.00"),
            zone(2, Aggressor::Sell, "105.00", "106.00"),
        ]);
        assert!(
            book.touch(p("101.00"), Timestamp(10)).is_empty(),
            "the top row ends below 101"
        );
        let hit = book.touch(p("100.75"), Timestamp(11));
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].side, Aggressor::Buy);
        assert!(book.touch(p("100.50"), Timestamp(12)).is_empty(), "spent");
        book.arm(vec![
            zone(2, Aggressor::Sell, "105.00", "106.00"),
            zone(3, Aggressor::Buy, "99.00", "99.50"),
        ]);
        assert_eq!(
            book.zones.len(),
            2,
            "a zone already held is not armed twice"
        );
        assert!(
            book.touch(p("105.25"), Timestamp(1_000)).is_empty(),
            "expired"
        );
        assert!(book.zones.is_empty());
    }

    #[test]
    fn a_stacked_imbalance_alert_keys_its_rule_and_fires_on_its_side_only() {
        let buy = alert(FlowSide::Ask, 3.0);
        let k = zone_key(&buy).unwrap();
        assert_eq!((k.tf, k.row_ticks, k.stack_rows), (Timeframe::M5, 4, 3));
        assert_eq!(k.rule().ratio, 3.0);
        assert_ne!(zone_key(&alert(FlowSide::Ask, 4.0)), Some(k.clone()));
        assert_eq!(
            Alert::describe("NQZ6.CME", buy.interval, &buy.steps, None),
            "NQ Z6 returns to a buy stacked imbalance of at least 3 rows"
        );

        let none = |_: &Operand, _: &Observation| None;
        let mut t = Tracker::new(&buy);
        let trade = Observation::trade(Timestamp(5), 100.5);
        assert_eq!(t.observe(&buy, &trade, &none), Outcome::Quiet);
        let sell = Observation::zone(Timestamp(6), 105.25, 3, -1);
        assert_eq!(t.observe(&buy, &sell, &none), Outcome::Quiet);
        let back = Observation::zone(Timestamp(7), 100.5, 3, 1);
        assert!(matches!(t.observe(&buy, &back, &none), Outcome::Fired(r) if r.subject == 3.0));
    }
}
