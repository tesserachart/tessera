use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde_json::{Value, json};
use tessera_core::ids::CallId;
use tessera_core::time::DisplayZone;
use tessera_core::{InstrumentId, Origin, SharedClock, Timestamp};
use tessera_host::{EventBus, TopicKey};
use tessera_market::{MarketDataProvider, MarketRouter, market_error};
use tessera_protocol::tools::{RiskTier, ToolCallRecord, ToolCallStatus};
use tessera_store::Store;
use tessera_tools::{ToolError, ToolObserver};
use tokio::sync::watch;

use crate::deps::{AlertAnalyst, WebhookSender, WebhookVault};
use crate::discord;
use crate::eval::{Observation, Reading};
use crate::io::{
    ALERTS_MAX, Alert, AlertDelivery, AlertFire, AlertLive, AlertOp, AlertRepeat, AlertStatus,
    AlertStep, AlertsCreateInput, AlertsEvent, AlertsUpdateInput, COOLDOWN_MAX, EvaluateOn,
    FlowSide, MESSAGE_MAX, Operand, STEPS_MAX, WITHIN_MAX, fmt_price,
};

pub const TOPIC: &str = "alerts";
pub const FIRE_TOOL: &str = "alerts.fire";
const ALERTS: &str = "alerts";
const FIRES: &str = "alert_fires";
const FIRES_KEPT: usize = 200;
const RECENT: usize = 50;
const COOLDOWN_DEFAULT: u32 = 60;
const STACK_ROWS_MAX: f64 = 50.0;
const ROW_TICKS_MAX: u32 = 100;

pub struct AlertsService {
    store: Store,
    bus: Arc<EventBus>,
    clock: SharedClock,
    market: Arc<MarketRouter>,
    alerts: RwLock<BTreeMap<String, Alert>>,
    revision: watch::Sender<u64>,
    defaults: RwLock<AlertDelivery>,
    vault: Arc<dyn WebhookVault>,
    sender: Arc<dyn WebhookSender>,
    analyst: RwLock<Option<Arc<dyn AlertAnalyst>>>,
    audit: RwLock<Option<Arc<dyn ToolObserver>>>,
    discord: AtomicBool,
    zone: DisplayZone,
    writes: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for AlertsService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AlertsService")
            .field("alerts", &self.alerts.read().len())
            .finish_non_exhaustive()
    }
}

fn store_error(e: impl std::fmt::Display) -> ToolError {
    ToolError::internal(format!("alerts store: {e}"))
}

impl AlertsService {
    pub fn load(
        store: Store,
        bus: Arc<EventBus>,
        clock: SharedClock,
        market: Arc<MarketRouter>,
        vault: Arc<dyn WebhookVault>,
        sender: Arc<dyn WebhookSender>,
    ) -> Result<Arc<Self>, ToolError> {
        let mut alerts = BTreeMap::new();
        for d in store
            .documents(ALERTS)
            .list(None, ALERTS_MAX * 2)
            .map_err(store_error)?
        {
            match serde_json::from_value::<Alert>(d.body) {
                Ok(mut a) => {
                    a.live = AlertLive::default();
                    alerts.insert(a.id.clone(), a);
                }
                Err(e) => tracing::warn!(alert = %d.id, error = %e, "ignoring an unreadable alert"),
            }
        }
        Ok(Arc::new(Self {
            store,
            bus,
            clock,
            market,
            alerts: RwLock::new(alerts),
            revision: watch::channel(0).0,
            defaults: RwLock::new(AlertDelivery::default()),
            vault,
            sender,
            analyst: RwLock::new(None),
            audit: RwLock::new(None),
            discord: AtomicBool::new(false),
            zone: DisplayZone::default(),
            writes: tokio::sync::Mutex::new(()),
        }))
    }

    pub fn set_analyst(&self, analyst: Option<Arc<dyn AlertAnalyst>>) {
        *self.analyst.write() = analyst;
    }

    fn wakes_itself(&self, session: Option<&str>) -> bool {
        let analyst = self.analyst.read().clone();
        session.zip(analyst).is_some_and(|(s, a)| a.wakes_itself(s))
    }

    pub fn set_audit(&self, audit: Arc<dyn ToolObserver>) {
        *self.audit.write() = Some(audit);
    }

    pub fn set_default_delivery(&self, d: AlertDelivery) {
        *self.defaults.write() = d;
    }

    pub fn set_display_zone(&self, zone: chrono_tz::Tz) {
        self.zone.set(zone);
    }

    pub fn market(&self) -> &Arc<MarketRouter> {
        &self.market
    }

    pub fn clock(&self) -> &SharedClock {
        &self.clock
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    pub async fn refresh_discord(&self) {
        let set = matches!(self.vault.get().await, Ok(Some(_)));
        self.discord.store(set, Ordering::SeqCst);
    }

    pub fn discord_configured(&self) -> bool {
        self.discord.load(Ordering::SeqCst)
    }

    pub fn all(&self) -> Vec<Alert> {
        let mut v: Vec<Alert> = self.alerts.read().values().cloned().collect();
        v.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        v
    }

    pub fn get(&self, id: &str) -> Option<Alert> {
        self.alerts.read().get(id).cloned()
    }

    pub fn active_by_instrument(&self) -> BTreeMap<InstrumentId, Vec<Alert>> {
        let mut out: BTreeMap<InstrumentId, Vec<Alert>> = BTreeMap::new();
        for a in self.alerts.read().values().filter(|a| a.is_active()) {
            out.entry(a.instrument.clone()).or_default().push(a.clone());
        }
        out
    }

    pub async fn snapshot(&self) -> AlertsEvent {
        AlertsEvent::Snapshot {
            alerts: self.all(),
            recent: self.history(None, RECENT).await.unwrap_or_default(),
            discord: self.discord_configured(),
        }
    }

    fn publish(&self, ev: &AlertsEvent) {
        self.bus.publish(TOPIC, TopicKey::None, ev);
    }

    async fn insert(&self, a: Alert) -> Result<Alert, ToolError> {
        let _turn = self.writes.lock().await;
        let (store, body, now) = (
            self.store.clone(),
            Alert {
                live: AlertLive::default(),
                ..a.clone()
            },
            self.clock.now(),
        );
        tokio::task::spawn_blocking(move || {
            store.docs::<Alert>(ALERTS).put(&body.id, None, &body, now)
        })
        .await
        .map_err(store_error)?
        .map_err(store_error)?;
        self.alerts.write().insert(a.id.clone(), a.clone());
        self.revision.send_modify(|r| *r += 1);
        self.publish(&AlertsEvent::Changed { alert: a.clone() });
        Ok(a)
    }

    async fn change(
        &self,
        id: &str,
        edit: impl FnOnce(&mut Alert) -> Result<(), ToolError> + Send + 'static,
    ) -> Result<Option<Alert>, ToolError> {
        let _turn = self.writes.lock().await;
        Ok(self.apply(id, edit).await?.map(|(a, ())| a))
    }

    async fn apply<R: Send + 'static>(
        &self,
        id: &str,
        edit: impl FnOnce(&mut Alert) -> Result<R, ToolError> + Send + 'static,
    ) -> Result<Option<(Alert, R)>, ToolError> {
        let (store, key, now) = (self.store.clone(), id.to_owned(), self.clock.now());
        let stored = tokio::task::spawn_blocking(move || {
            store.docs::<Alert>(ALERTS).change(&key, now, |a| {
                let out = edit(a)?;
                a.live = AlertLive::default();
                Ok::<_, ToolError>((a.clone(), out))
            })
        })
        .await
        .map_err(store_error)??;
        let Some((mut a, out)) = stored else {
            if self.alerts.write().remove(id).is_some() {
                self.revision.send_modify(|r| *r += 1);
                self.publish(&AlertsEvent::Removed { id: id.to_owned() });
            }
            return Ok(None);
        };
        let same = {
            let mut all = self.alerts.write();
            if let Some(held) = all.get(id) {
                a.live = held.live.clone();
            }
            let same = all.get(id) == Some(&a);
            all.insert(id.to_owned(), a.clone());
            same
        };
        if !same {
            self.revision.send_modify(|r| *r += 1);
            self.publish(&AlertsEvent::Changed { alert: a.clone() });
        }
        Ok(Some((a, out)))
    }

    async fn persist_fire(&self, f: &AlertFire) -> Result<(), ToolError> {
        let (store, body, id, parent, now) = (
            self.store.clone(),
            serde_json::to_value(f).map_err(store_error)?,
            f.id.clone(),
            f.alert_id.clone(),
            self.clock.now(),
        );
        tokio::task::spawn_blocking(move || {
            let repo = store.documents(FIRES);
            repo.put(&id, Some(&parent), &body, now)?;
            let kept = repo.list(Some(&parent), FIRES_KEPT + 1)?;
            if kept.len() > FIRES_KEPT
                && let Some(old) = kept.last()
            {
                repo.delete(&old.id)?;
            }
            Ok::<_, tessera_store::StoreError>(())
        })
        .await
        .map_err(store_error)?
        .map_err(store_error)
    }

    async fn record_deliveries(&self, f: &AlertFire) -> Result<bool, ToolError> {
        let (store, id, discord, analyst, now) = (
            self.store.clone(),
            f.id.clone(),
            f.discord.clone(),
            f.analyst.clone(),
            self.clock.now(),
        );
        let kept = tokio::task::spawn_blocking(move || {
            store.docs::<AlertFire>(FIRES).change(&id, now, |kept| {
                kept.discord = discord;
                kept.analyst = analyst;
                Ok::<_, ToolError>(())
            })
        })
        .await
        .map_err(store_error)??;
        Ok(kept.is_some())
    }

    pub async fn create(
        &self,
        origin: &Origin,
        input: AlertsCreateInput,
    ) -> Result<Alert, ToolError> {
        if self.alerts.read().len() >= ALERTS_MAX {
            return Err(ToolError::invalid_input(format!(
                "at most {ALERTS_MAX} alerts are kept; delete spent ones first"
            )));
        }
        let symbol = input.instrument.trim().to_owned();
        let instrument = self.resolve(&symbol).await?;
        let interval = input.interval.unwrap_or(tessera_core::Timeframe::M1);
        validate_steps(&input.steps)?;
        let within = check_within(&input.steps, input.within_bars)?;
        let cooldown = input
            .cooldown_secs
            .unwrap_or(COOLDOWN_DEFAULT)
            .min(COOLDOWN_MAX);
        let message = check_message(input.message)?;
        let now = self.clock.now();
        if let Some(e) = input.expires_at
            && e <= now
        {
            return Err(ToolError::invalid_input("expiresAt is already past"));
        }
        let session_id = origin.session_id().map(ToString::to_string);
        let wakes = self.wakes_itself(session_id.as_deref());
        let ask_analyst = input.ask_analyst.unwrap_or(wakes);
        check_ask(origin, ask_analyst, session_id.as_deref(), wakes)?;
        let a = Alert {
            id: tessera_core::ids::unique("al_"),
            title: Alert::describe(&symbol, interval, &input.steps, within),
            symbol,
            instrument,
            interval,
            steps: input.steps,
            within_bars: within,
            repeat: input.repeat.unwrap_or_default(),
            cooldown_secs: cooldown,
            expires_at: input.expires_at,
            message,
            deliver: input.deliver.unwrap_or(*self.defaults.read()),
            ask_analyst,
            status: AlertStatus::Active,
            created_by: origin.kind_str().to_owned(),
            session_id,
            created_at: now,
            updated_at: now,
            fired_at: None,
            fire_count: 0,
            live: AlertLive::default(),
        };
        self.insert(a).await
    }

    async fn resolve(&self, symbol: &str) -> Result<InstrumentId, ToolError> {
        if symbol.is_empty() {
            return Err(ToolError::invalid_input("instrument is required"));
        }
        self.market.resolve(symbol).await.map_err(market_error)
    }

    fn existing(&self, id: &str) -> Result<Alert, ToolError> {
        self.get(id).ok_or_else(|| missing(id))
    }

    pub async fn update(
        &self,
        origin: &Origin,
        input: AlertsUpdateInput,
    ) -> Result<Alert, ToolError> {
        self.existing(&input.id)?;
        let moved = match &input.instrument {
            Some(sym) => {
                let sym = sym.trim().to_owned();
                Some((self.resolve(&sym).await?, sym))
            }
            None => None,
        };
        let (origin, now, analyst) = (
            origin.clone(),
            self.clock.now(),
            self.analyst.read().clone(),
        );
        let id = input.id.clone();
        self.change(&id, move |a| {
            let wakes = origin.session_id().map(ToString::to_string) == a.session_id
                && a.session_id
                    .as_deref()
                    .zip(analyst)
                    .is_some_and(|(s, an)| an.wakes_itself(s));
            edit(a, input, moved, now, &origin, wakes)
        })
        .await?
        .ok_or_else(|| missing(&id))
    }

    pub async fn pause(&self, id: &str, paused: bool) -> Result<Alert, ToolError> {
        self.existing(id)?;
        let now = self.clock.now();
        self.change(id, move |a| {
            a.status = if paused {
                AlertStatus::Paused
            } else {
                if a.expires_at.is_some_and(|e| e <= now) {
                    a.expires_at = None;
                }
                AlertStatus::Active
            };
            a.updated_at = now;
            Ok(())
        })
        .await?
        .ok_or_else(|| missing(id))
    }

    pub async fn delete(&self, id: &str) -> Result<bool, ToolError> {
        let _turn = self.writes.lock().await;
        if self.get(id).is_none() {
            return Ok(false);
        }
        let (store, key) = (self.store.clone(), id.to_owned());
        tokio::task::spawn_blocking(move || {
            store.documents(FIRES).delete_children(&key)?;
            store.documents(ALERTS).delete(&key)
        })
        .await
        .map_err(store_error)?
        .map_err(store_error)?;
        self.alerts.write().remove(id);
        self.revision.send_modify(|r| *r += 1);
        self.publish(&AlertsEvent::Removed { id: id.to_owned() });
        Ok(true)
    }

    pub async fn history(
        &self,
        alert: Option<&str>,
        limit: usize,
    ) -> Result<Vec<AlertFire>, ToolError> {
        let (store, parent) = (self.store.clone(), alert.map(str::to_owned));
        let docs = tokio::task::spawn_blocking(move || {
            store.documents(FIRES).list(parent.as_deref(), limit)
        })
        .await
        .map_err(store_error)?
        .map_err(store_error)?;
        let mut fires: Vec<AlertFire> = docs
            .into_iter()
            .filter_map(|d| serde_json::from_value(d.body).ok())
            .collect();
        fires.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
        Ok(fires)
    }

    pub fn set_live(&self, id: &str, live: AlertLive) {
        let changed = {
            let mut all = self.alerts.write();
            match all.get_mut(id) {
                Some(a) if a.live != live => {
                    a.live = live;
                    Some(a.clone())
                }
                _ => None,
            }
        };
        if let Some(alert) = changed {
            self.publish(&AlertsEvent::Changed { alert });
        }
    }

    pub async fn move_to(&self, id: &str, instrument: InstrumentId) -> Result<(), ToolError> {
        if self.existing(id)?.instrument == instrument {
            return Ok(());
        }
        let now = self.clock.now();
        self.change(id, move |a| {
            if a.instrument == instrument {
                return Ok(());
            }
            tracing::info!(alert = %a.id, from = %a.instrument, to = %instrument, "an alert follows the chosen market data");
            if a.symbol == a.instrument.as_str() {
                a.symbol = instrument.as_str().to_owned();
            }
            a.instrument = instrument;
            a.updated_at = now;
            Ok(())
        })
        .await
        .map(|_| ())
    }

    pub async fn expire_due(&self, now: Timestamp) {
        let due: Vec<String> = self
            .alerts
            .read()
            .values()
            .filter(|a| a.is_active() && a.expires_at.is_some_and(|e| e <= now))
            .map(|a| a.id.clone())
            .collect();
        for id in due {
            self.expire(&id).await;
        }
    }

    pub async fn expire(&self, id: &str) {
        if self.get(id).filter(Alert::is_active).is_none() {
            return;
        }
        let now = self.clock.now();
        let expired = self.change(id, move |a| {
            if a.is_active() {
                a.status = AlertStatus::Expired;
                a.updated_at = now;
            }
            Ok(())
        });
        if let Err(e) = expired.await {
            tracing::warn!(alert = %id, error = %e.message, "could not mark an alert expired");
        }
    }

    pub async fn fire(
        self: &Arc<Self>,
        id: &str,
        reading: Reading,
        obs: &Observation,
        source_name: &str,
    ) -> Option<AlertFire> {
        let (me, id, obs, source) = (
            Arc::clone(self),
            id.to_owned(),
            *obs,
            source_name.to_owned(),
        );
        tokio::spawn(async move { me.fire_through(&id, reading, &obs, &source).await })
            .await
            .ok()
            .flatten()
    }

    async fn fire_through(
        self: &Arc<Self>,
        id: &str,
        reading: Reading,
        obs: &Observation,
        source_name: &str,
    ) -> Option<AlertFire> {
        self.get(id).filter(Alert::is_active)?;
        let (now, at) = (self.clock.now(), obs.at);
        let turn = self.writes.lock().await;
        let counted = self.apply(id, move |a| {
            if !a.is_active() {
                return Ok(false);
            }
            a.fire_count += 1;
            a.fired_at = Some(at);
            if a.repeat == AlertRepeat::Once {
                a.status = AlertStatus::Triggered;
            }
            a.updated_at = now;
            Ok(true)
        });
        let a = match counted.await {
            Ok(Some((a, true))) => a,
            Ok(_) => return None,
            Err(e) => {
                tracing::warn!(alert = %id, error = %e.message, "could not store a fired alert");
                return None;
            }
        };
        let price = match a.steps.last().map(|s| &s.subject) {
            Some(Operand::Price) | None => reading.subject,
            Some(_) => obs.price,
        };
        let last = a.steps.last().map(|s| &s.subject);
        let flow = last.is_some_and(Operand::is_flow);
        let event = last.is_some_and(Operand::is_event);
        let fire = AlertFire {
            id: tessera_core::ids::unique("af_"),
            alert_id: a.id.clone(),
            symbol: a.symbol.clone(),
            instrument: a.instrument.clone(),
            title: a.title.clone(),
            message: a.message.clone(),
            price,
            target: Some(reading.target),
            at: obs.at,
            bar_time: obs.bar.or_else(|| {
                let step = a.interval.nanos();
                Some(Timestamp(obs.at.0 - obs.at.0.rem_euclid(step)))
            }),
            source: source_name.to_owned(),
            deliver: a.deliver,
            discord: None,
            analyst: None,
            size: flow.then_some(reading.subject),
            side: event.then_some(if obs.side > 0 {
                FlowSide::Ask
            } else {
                FlowSide::Bid
            }),
        };
        if let Err(e) = self.persist_fire(&fire).await {
            tracing::warn!(alert = %id, error = %e.message, "could not keep a firing");
        }
        drop(turn);
        self.publish(&AlertsEvent::Fired { fire: fire.clone() });
        self.audit_fire(&a, &fire);
        tracing::info!(alert = %a.id, instrument = %a.instrument, price = fire.price, "alert fired");
        let wants_discord = a.deliver.discord;
        let wants_analyst = a.ask_analyst && a.session_id.is_some();
        if wants_discord || wants_analyst {
            let me = Arc::clone(self);
            let fire = fire.clone();
            tokio::spawn(async move { me.deliver(a, fire, wants_discord, wants_analyst).await });
        }
        Some(fire)
    }

    async fn deliver(&self, a: Alert, mut fire: AlertFire, discord: bool, analyst: bool) {
        if discord {
            fire.discord = Some(
                match self
                    .post_discord(&discord::fire_message(&fire, self.zone.get()))
                    .await
                {
                    Ok(()) => "sent".to_owned(),
                    Err(e) => {
                        tracing::warn!(alert = %a.id, error = %e, "Discord did not take the alert");
                        e
                    }
                },
            );
        }
        if analyst && let Some(session) = a.session_id.as_deref() {
            let analyst = self.analyst.read().clone();
            let asked = match analyst {
                Some(an) => {
                    let text = analyst_prompt(&a, &fire, an.wakes_itself(session));
                    an.ask(session, &text).await
                }
                None => Err("the analyst is not running".to_owned()),
            };
            fire.analyst = Some(match asked {
                Ok(()) => "asked".to_owned(),
                Err(e) => e,
            });
        }
        match self.record_deliveries(&fire).await {
            Ok(true) => self.publish(&AlertsEvent::Delivered { fire }),
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(alert = %a.id, error = %e.message, "could not keep a firing's deliveries");
            }
        }
    }

    async fn post_discord(&self, body: &Value) -> Result<(), String> {
        let url = match self.vault.get().await {
            Ok(Some(u)) => u,
            Ok(None) => {
                return Err("no Discord webhook is set (Settings › Alerts and sounds)".into());
            }
            Err(e) => return Err(format!("the Discord webhook could not be read: {e}")),
        };
        self.sender.post(&url, body).await
    }

    pub async fn set_discord(&self, url: Option<String>) -> Result<bool, ToolError> {
        let url = url.map(|u| u.trim().to_owned()).filter(|u| !u.is_empty());
        if let Some(u) = &url {
            discord::check_webhook(u).map_err(ToolError::invalid_input)?;
        }
        self.vault
            .set(url.as_deref())
            .await
            .map_err(|e| ToolError::unavailable(format!("the secret store: {e}")))?;
        let configured = url.is_some();
        self.discord.store(configured, Ordering::SeqCst);
        self.publish(&AlertsEvent::Discord { configured });
        Ok(configured)
    }

    pub async fn test_discord(&self) -> Result<(), ToolError> {
        self.post_discord(&discord::test_message())
            .await
            .map_err(ToolError::unavailable)
    }

    fn audit_fire(&self, a: &Alert, f: &AlertFire) {
        let Some(audit) = self.audit.read().clone() else {
            return;
        };
        let input = json!({
            "alertId": a.id,
            "instrument": f.instrument,
            "price": f.price,
            "target": f.target,
            "at": f.at,
            "createdBy": a.created_by,
        });
        let now = self.clock.now();
        let record = ToolCallRecord {
            call_id: CallId::generate(),
            tool: FIRE_TOOL.to_owned(),
            risk: RiskTier::Read,
            origin: Origin::User,
            session_id: None,
            input_hash: tessera_core::hash::hash_json(&input),
            input,
            status: ToolCallStatus::Ok,
            started_at: now,
            finished_at: Some(now),
            duration_ms: Some(0.0),
            error: None,
            approval_id: None,
            deduped: false,
            idempotency_key: None,
            summary: Some(format!("{} at {}", f.title, fmt_price(f.price))),
            approved_by: None,
        };
        audit.call_finished(&record);
    }
}

fn missing(id: &str) -> ToolError {
    ToolError::not_found(format!("no alert {id}; alerts.list shows them"))
}

fn edit(
    a: &mut Alert,
    input: AlertsUpdateInput,
    moved: Option<(InstrumentId, String)>,
    now: Timestamp,
    origin: &Origin,
    wakes: bool,
) -> Result<(), ToolError> {
    if let Some((instrument, symbol)) = moved {
        a.instrument = instrument;
        a.symbol = symbol;
    }
    if let Some(steps) = input.steps {
        validate_steps(&steps)?;
        a.steps = steps;
    }
    if let Some(price) = input.price {
        if !price.is_finite() {
            return Err(ToolError::invalid_input("price must be a number"));
        }
        match a.steps.as_mut_slice() {
            [s] if matches!(s.target, Operand::Value { .. }) => {
                s.target = Operand::Value { value: price };
            }
            _ => {
                return Err(ToolError::invalid_input(
                    "only a one-step alert at a fixed price moves to a price; change its steps instead",
                ));
            }
        }
    }
    if let Some(tf) = input.interval {
        a.interval = tf;
    }
    if let Some(w) = input.within_bars {
        a.within_bars = (w > 0).then_some(w);
    }
    a.within_bars = check_within(&a.steps, a.within_bars)?;
    if let Some(r) = input.repeat {
        a.repeat = r;
    }
    if let Some(c) = input.cooldown_secs {
        a.cooldown_secs = c.min(COOLDOWN_MAX);
    }
    if let Some(e) = input.expires_at {
        if e.0 == 0 {
            a.expires_at = None;
        } else if e <= now {
            return Err(ToolError::invalid_input("expiresAt is already past"));
        } else {
            a.expires_at = Some(e);
            if a.status == AlertStatus::Expired {
                a.status = AlertStatus::Active;
            }
        }
    }
    if let Some(m) = input.message {
        a.message = check_message(Some(m))?;
    }
    if let Some(d) = input.deliver {
        a.deliver = d;
    }
    if let Some(ask) = input.ask_analyst {
        check_ask(origin, ask, a.session_id.as_deref(), wakes)?;
        a.ask_analyst = ask;
    }
    a.title = Alert::describe(&a.symbol, a.interval, &a.steps, a.within_bars);
    a.updated_at = now;
    Ok(())
}

fn analyst_prompt(a: &Alert, f: &AlertFire, trading: bool) -> String {
    let mut s = format!(
        "Alert {} fired: {} at {} ({}).",
        a.id,
        a.title,
        fmt_price(f.price),
        f.at.to_rfc3339(),
    );
    if let Some(m) = &a.message {
        s.push_str(&format!(" Its note: {}.", m.trim_end_matches('.')));
    }
    s.push_str(if trading {
        " Look now and act on it as your session's instructions say."
    } else {
        " Look at the chart now and tell me what you see; place nothing."
    });
    s
}

fn validate_steps(steps: &[AlertStep]) -> Result<(), ToolError> {
    if steps.is_empty() || steps.len() > STEPS_MAX {
        return Err(ToolError::invalid_input(format!(
            "an alert has 1 to {STEPS_MAX} steps"
        )));
    }
    for (i, s) in steps.iter().enumerate() {
        let n = i + 1;
        if !matches!(
            s.subject,
            Operand::Price
                | Operand::Plot { .. }
                | Operand::BigTrade { .. }
                | Operand::Print { .. }
                | Operand::StackedImbalance { .. }
        ) {
            return Err(ToolError::invalid_input(format!(
                "step {n}: the subject is the price, an indicator's plot, a big trade, a print or a stacked imbalance"
            )));
        }
        if s.target.is_event() {
            return Err(ToolError::invalid_input(format!(
                "step {n}: a big trade, a print or a stacked imbalance is a subject, compared at_least with a value"
            )));
        }
        if s.subject.is_event() != (s.op == AlertOp::AtLeast) {
            return Err(ToolError::invalid_input(format!(
                "step {n}: a big trade or a print is compared at_least with a size, a stacked imbalance at_least with a stack in rows, and at_least compares only those"
            )));
        }
        if matches!(s.subject, Operand::StackedImbalance { .. })
            && !matches!(s.target, Operand::Value { value } if value.fract() == 0.0 && (1.0..=STACK_ROWS_MAX).contains(&value))
        {
            return Err(ToolError::invalid_input(format!(
                "step {n}: a stacked imbalance is compared with its minimum stack, 1 to {STACK_ROWS_MAX} rows"
            )));
        }
        if s.subject.is_flow() && !matches!(s.target, Operand::Value { value } if value > 0.0) {
            return Err(ToolError::invalid_input(format!(
                "step {n}: a big trade or a print is compared with a size in contracts, more than 0"
            )));
        }
        if s.target == Operand::Price && !matches!(s.subject, Operand::Plot { .. }) {
            return Err(ToolError::invalid_input(format!(
                "step {n}: the price is compared with a value, a level, a line or a plot, not with itself"
            )));
        }
        if (s.subject.needs_bar_close() || s.target.needs_bar_close())
            && s.on != EvaluateOn::BarClose
        {
            return Err(ToolError::invalid_input(format!(
                "step {n}: an indicator's plot is read at bar close; set on: bar_close"
            )));
        }
        for o in [&s.subject, &s.target] {
            check_operand(n, o)?;
        }
    }
    Ok(())
}

fn check_operand(n: usize, o: &Operand) -> Result<(), ToolError> {
    let bad = |what: &str| Err(ToolError::invalid_input(format!("step {n}: {what}")));
    match o {
        Operand::Value { value } if !value.is_finite() => bad("the value must be a number"),
        Operand::Level { key, .. } if key.trim().is_empty() => bad("a level needs its key"),
        Operand::IndicatorLine {
            indicator, label, ..
        } if indicator.trim().is_empty() || label.trim().is_empty() => {
            bad("an indicator's line needs the indicator and the line's label")
        }
        Operand::Drawing { drawing_id, .. } if drawing_id.trim().is_empty() => {
            bad("a drawing needs its id")
        }
        Operand::Plot {
            indicator, plot, ..
        } if indicator.trim().is_empty() || plot.trim().is_empty() => {
            bad("a plot needs the indicator and the plot's key")
        }
        Operand::StackedImbalance {
            ratio,
            min_volume,
            min_difference,
            row_ticks,
            ..
        } => {
            if !(1.5..=20.0).contains(ratio) {
                bad("a stacked imbalance's ratio is 1.5 to 20")
            } else if !(min_volume.is_finite() && *min_volume >= 0.0) {
                bad("a stacked imbalance's minVolume is zero or more")
            } else if !(min_difference.is_finite() && *min_difference >= 0.0) {
                bad("a stacked imbalance's minDifference is zero or more")
            } else if !(1..=ROW_TICKS_MAX).contains(row_ticks) {
                bad(&format!(
                    "a stacked imbalance's rowTicks is 1 to {ROW_TICKS_MAX}"
                ))
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}

fn check_within(steps: &[AlertStep], within: Option<u32>) -> Result<Option<u32>, ToolError> {
    match within {
        Some(n) if !(1..=WITHIN_MAX).contains(&n) => Err(ToolError::invalid_input(format!(
            "withinBars is 1 to {WITHIN_MAX}"
        ))),
        Some(n) if steps.len() > 1 => Ok(Some(n)),
        _ => Ok(None),
    }
}

fn check_message(m: Option<String>) -> Result<Option<String>, ToolError> {
    let m = m.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty());
    if m.as_ref().is_some_and(|m| m.chars().count() > MESSAGE_MAX) {
        return Err(ToolError::invalid_input(format!(
            "a message is at most {MESSAGE_MAX} characters"
        )));
    }
    Ok(m)
}

fn check_ask(
    origin: &Origin,
    ask: bool,
    session: Option<&str>,
    wakes: bool,
) -> Result<(), ToolError> {
    if !ask {
        return Ok(());
    }
    if !origin.is_user() && !wakes {
        return Err(ToolError::permission_denied(
            "only the user turns on asking the analyst when an alert fires",
        ));
    }
    if session.is_none() {
        return Err(ToolError::invalid_input(
            "only an alert the analyst created can ask it to look; this one has no analyst session",
        ));
    }
    Ok(())
}
