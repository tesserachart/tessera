mod consent;
pub mod logs;
mod remote;
mod tracked;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use posthog_rs::{ClientOptions, ClientOptionsBuilder, ErrorTrackingOptionsBuilder, Event};
use serde_json::{Map, Value, json};
use tessera_agent::TurnReport;
use tessera_broker::orders::OrdersService;
use tessera_core::Origin;
use tessera_host::EventBus;
use tessera_protocol::account::{AccountPhase, AccountState};
use tessera_protocol::agent::TurnEnd;
use tessera_protocol::tools::{ToolCallRecord, ToolCallStatus};
use tessera_protocol::topics::names;
use tokio::sync::OnceCell;

use crate::logging::Redactor;
use consent::Gate;
pub use consent::{CONSENT, Consent, Purpose};
use remote::Remote;
pub use tracked::{Field, TRACKED, Tracked};

pub const KEY_ENV: &str = "TESSERA_POSTHOG_KEY";

pub const HOST_ENV: &str = "TESSERA_POSTHOG_HOST";

const MOST_WINDOW_EVENTS: usize = 50;

const ERROR_MAX_CHARS: usize = 200;

const CONFIG_FOR: Duration = Duration::from_secs(30 * 60);

const INSTALL_FILE: &str = "telemetry-id";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Project {
    pub key: Option<String>,
    pub host: String,
}

impl Project {
    pub fn configured() -> Self {
        Self {
            key: chosen(
                std::env::var(KEY_ENV).ok(),
                option_env!("TESSERA_POSTHOG_KEY"),
            ),
            host: chosen(
                std::env::var(HOST_ENV).ok(),
                Some(posthog_rs::EU_INGESTION_ENDPOINT),
            )
            .unwrap_or_default(),
        }
    }
}

fn chosen(now: Option<String>, built: Option<&str>) -> Option<String> {
    [now.as_deref(), built]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|v| !v.is_empty())
        .map(str::to_owned)
}

pub fn build() -> &'static str {
    if cfg!(debug_assertions) || option_env!("TESSERA_POSTHOG_KEY").is_none() {
        "dev"
    } else {
        "release"
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowEvent {
    pub event: String,
    pub properties: Map<String, Value>,
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Unavailable,
    NotSharing,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteSettings {
    pub asked: bool,
    pub flags: BTreeMap<String, Value>,
    pub replay: Option<Replay>,
    pub surveys: Vec<Survey>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Replay {
    pub sample_rate: Option<f64>,
    pub minimum_duration_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Survey {
    pub id: String,
    pub name: String,
    pub questions: Vec<SurveyQuestion>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurveyQuestion {
    pub id: String,
    pub kind: SurveyKind,
    pub question: String,
    pub description: Option<String>,
    pub choices: Vec<String>,
    pub optional: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurveyKind {
    Open,
    SingleChoice,
}

enum Outlet {
    Global,
    Client(Box<posthog_rs::Client>),
}

impl Outlet {
    fn capture(&self, event: Event) {
        match self {
            Outlet::Global => posthog_rs::capture(event),
            Outlet::Client(c) => c.capture(event),
        }
    }

    async fn flush(&self) {
        match self {
            Outlet::Global => posthog_rs::flush().await,
            Outlet::Client(c) => c.flush().await,
        }
    }
}

type UserSource = Box<dyn Fn() -> Option<String> + Send + Sync>;

struct Span {
    tool: String,
    seconds: f64,
    status: ToolCallStatus,
}

struct Remembered {
    who: String,
    at: Instant,
    settings: RemoteSettings,
}

struct Inner {
    project: Project,
    global: bool,
    consent: Gate,
    outlet: OnceCell<Outlet>,
    remote: OnceLock<Option<Remote>>,
    user: OnceLock<UserSource>,
    install_dir: Option<PathBuf>,
    install: OnceLock<String>,
    window_session: Mutex<Option<String>>,
    turn_spans: Mutex<HashMap<String, Vec<Span>>>,
    settings: tokio::sync::Mutex<Option<Remembered>>,
    logs_shipping: AtomicBool,
}

#[derive(Clone)]
pub struct Telemetry(Arc<Inner>);

impl std::fmt::Debug for Telemetry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Telemetry")
            .field("available", &self.available())
            .field("consent", &self.consent())
            .finish_non_exhaustive()
    }
}

impl Default for Telemetry {
    fn default() -> Self {
        Self::local(Project::default())
    }
}

impl Telemetry {
    pub fn new(project: Project, data_dir: Option<&Path>) -> Self {
        Self::build(project, true, data_dir.map(Path::to_path_buf))
    }

    pub fn local(project: Project) -> Self {
        Self::build(project, false, None)
    }

    fn build(project: Project, global: bool, install_dir: Option<PathBuf>) -> Self {
        Self(Arc::new(Inner {
            project,
            global,
            consent: Gate::default(),
            outlet: OnceCell::new(),
            remote: OnceLock::new(),
            user: OnceLock::new(),
            install_dir,
            install: OnceLock::new(),
            window_session: Mutex::new(None),
            turn_spans: Mutex::new(HashMap::new()),
            settings: tokio::sync::Mutex::new(None),
            logs_shipping: AtomicBool::new(false),
        }))
    }

    pub fn available(&self) -> bool {
        self.0.project.key.is_some()
    }

    pub fn consent(&self) -> Consent {
        self.0.consent.get()
    }

    pub fn allows(&self, purpose: Purpose) -> bool {
        self.0.consent.allows(purpose)
    }

    pub fn identify_with(&self, user: impl Fn() -> Option<String> + Send + Sync + 'static) {
        let _ = self.0.user.set(Box::new(user));
    }

    pub fn set_consent(&self, consent: Consent) {
        let was = self.0.consent.set(consent);
        let usage = consent.allows(Purpose::Usage);
        if self.0.global {
            logs::set_on(usage && self.available());
        }
        if !self.available() {
            return;
        }
        if consent.crashes != was.crashes {
            tracing::info!(on = consent.crashes, "crash reports");
        }
        if consent.any() && !was.any() {
            self.spawn(|_| {});
        }
        if usage && !was.allows(Purpose::Usage) {
            tracing::info!("usage analytics are shared");
            self.ship_logs();
        } else if !usage && was.allows(Purpose::Usage) {
            tracing::info!("usage analytics are not shared");
            *self.0.window_session.lock() = None;
            if let Ok(mut s) = self.0.settings.try_lock() {
                *s = None;
            }
        }
    }

    pub async fn start(&self) {
        if self.consent().any() {
            let _ = Inner::outlet(&self.0).await;
        }
    }

    pub async fn flush(&self) {
        if let Some(outlet) = self.0.outlet.get() {
            outlet.flush().await;
        }
    }

    fn spawn(&self, then: impl FnOnce(&Outlet) + Send + 'static) {
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let inner = Arc::clone(&self.0);
        rt.spawn(async move {
            if let Some(outlet) = Inner::outlet(&inner).await {
                then(outlet);
            }
        });
    }

    fn remote(&self) -> Option<&Remote> {
        self.0
            .remote
            .get_or_init(|| {
                let key = self.0.project.key.clone()?;
                Remote::new(&self.0.project, key)
                    .inspect_err(
                        |e| tracing::warn!(error = %e.0, "PostHog's HTTP client did not start"),
                    )
                    .ok()
            })
            .as_ref()
    }

    fn send(&self, event: Event) {
        if self.available() && self.allows(Purpose::of(event.event_name())) {
            self.spawn(move |outlet| outlet.capture(event));
        }
    }

    fn install_id(&self) -> String {
        self.0
            .install
            .get_or_init(|| {
                let Some(dir) = &self.0.install_dir else {
                    return uuid::Uuid::now_v7().to_string();
                };
                let path = dir.join(INSTALL_FILE);
                if let Ok(kept) = std::fs::read_to_string(&path)
                    && uuid::Uuid::parse_str(kept.trim()).is_ok()
                {
                    return kept.trim().to_owned();
                }
                let id = uuid::Uuid::now_v7().to_string();
                if let Err(e) =
                    std::fs::write(&path, &id).and_then(|()| tessera_core::private::restrict(&path))
                {
                    tracing::warn!(error = %e, "the install's telemetry id is not kept");
                }
                id
            })
            .clone()
    }

    fn distinct_id(&self) -> (String, bool) {
        match self.0.user.get().and_then(|user| user()) {
            Some(id) => (id, true),
            None => (self.install_id(), false),
        }
    }

    fn event(&self, name: &str) -> Event {
        let (id, known) = self.distinct_id();
        self.event_as(name, id, known)
    }

    fn event_as(&self, name: &str, id: String, known: bool) -> Event {
        let mut event = Event::new(name.to_owned(), id);
        if !known {
            let _ = event.insert_prop("$process_person_profile", false);
        }
        let _ = event.insert_prop("runtime_version", crate::VERSION);
        let _ = event.insert_prop("build", build());
        if let Some(sid) = self.0.window_session.lock().clone() {
            let _ = event.insert_prop("$session_id", sid);
        }
        event
    }

    fn anonymous(&self, name: &str) -> Event {
        let mut event = Event::new(name.to_owned(), self.install_id());
        let _ = event.insert_prop("$process_person_profile", false);
        let _ = event.insert_prop("runtime_version", crate::VERSION);
        let _ = event.insert_prop("build", build());
        event
    }

    pub fn tool_call(&self, record: &ToolCallRecord) {
        if !self.allows(Purpose::Usage) {
            return;
        }
        if let Some(sid) = record.origin.session_id() {
            self.0
                .turn_spans
                .lock()
                .entry(sid.as_str().to_owned())
                .or_default()
                .push(Span {
                    tool: record.tool.clone(),
                    seconds: record.duration_ms.unwrap_or_default() / 1000.0,
                    status: record.status,
                });
        }
        if let Some(event) = self.product_event(record) {
            self.send(event);
        }
    }

    fn product_event(&self, record: &ToolCallRecord) -> Option<Event> {
        let tracked = tracked::tracked(&record.tool)?;
        let mut event = self.event(tracked.event);
        let _ = event.insert_prop("origin", record.origin.kind_str());
        let _ = event.insert_prop("outcome", outcome(record.status));
        if let Origin::Agent { provider, .. } = &record.origin {
            let _ = event.insert_prop("agent_provider", provider);
        }
        for (key, value) in tracked.set {
            let _ = event.insert_prop(*key, *value);
        }
        for field in tracked.fields {
            if let Some(v) = field.read(&record.input) {
                let _ = event.insert_prop(field.name(), v);
            }
        }
        Some(event)
    }

    pub fn turn(&self, report: &TurnReport) {
        let spans = self
            .0
            .turn_spans
            .lock()
            .remove(report.session.as_str())
            .unwrap_or_default();
        if !self.allows(Purpose::Usage) {
            return;
        }
        for event in self.trace(report, &spans) {
            self.send(event);
        }
    }

    fn trace(&self, report: &TurnReport, spans: &[Span]) -> Vec<Event> {
        let trace = uuid::Uuid::now_v7().to_string();
        let failed = report.end == TurnEnd::Failed;
        let error: Option<String> = report
            .error
            .as_deref()
            .map(|e| e.chars().take(ERROR_MAX_CHARS).collect());
        let tools: Vec<&str> = spans.iter().map(|s| s.tool.as_str()).collect();
        let common = [
            ("$ai_trace_id", json!(trace)),
            ("$ai_session_id", json!(report.session.as_str())),
            ("agent_provider", json!(report.provider)),
        ];
        let mut turn = self.event("$ai_trace");
        let mut generation = self.event("$ai_generation");
        for (key, value) in &common {
            let _ = turn.insert_prop(*key, value.clone());
            let _ = generation.insert_prop(*key, value.clone());
        }
        let turn_props = [
            ("$ai_span_name", json!("analyst turn")),
            ("$ai_latency", json!(report.latency.as_secs_f64())),
            ("$ai_is_error", json!(failed)),
            ("$ai_error", json!(error)),
            ("turn_end", json!(report.end)),
            ("tool_calls", json!(spans.len())),
            ("tools_called", json!(tools)),
        ];
        for (key, value) in turn_props {
            let _ = turn.insert_prop(key, value);
        }
        let generation_props = [
            ("$ai_parent_id", json!(trace)),
            ("$ai_span_id", json!(uuid::Uuid::now_v7().to_string())),
            ("$ai_span_name", json!("model")),
            ("$ai_provider", json!(ai_provider(&report.provider))),
            ("$ai_model", json!(report.model)),
            ("$ai_latency", json!(report.latency.as_secs_f64())),
            ("$ai_is_error", json!(failed)),
            ("$ai_error", json!(error)),
            ("effort", json!(report.effort)),
            ("turn_end", json!(report.end)),
            ("tool_calls", json!(spans.len())),
            ("tools_called", json!(tools)),
        ];
        for (key, value) in generation_props {
            let _ = generation.insert_prop(key, value);
        }
        if let Some(usage) = report.usage {
            let _ = generation.insert_prop("$ai_input_tokens", usage.input_tokens);
            let _ = generation.insert_prop("$ai_output_tokens", usage.output_tokens);
            let _ =
                generation.insert_prop("$ai_cache_read_input_tokens", usage.cached_input_tokens);
            let _ = generation.insert_prop("$ai_reasoning_tokens", usage.reasoning_tokens);
        }
        let mut events = vec![turn, generation];
        for s in spans {
            let mut span = self.event("$ai_span");
            for (key, value) in &common {
                let _ = span.insert_prop(*key, value.clone());
            }
            let props = [
                ("$ai_parent_id", json!(trace)),
                ("$ai_span_id", json!(uuid::Uuid::now_v7().to_string())),
                ("$ai_span_name", json!(s.tool)),
                ("$ai_latency", json!(s.seconds)),
                ("$ai_is_error", json!(s.status != ToolCallStatus::Ok)),
                ("outcome", outcome(s.status)),
            ];
            for (key, value) in props {
                let _ = span.insert_prop(key, value);
            }
            events.push(span);
        }
        events
    }

    pub fn trading_session_ended(&self, issues: usize) {
        let mut event = self.event("analyst session ended");
        let _ = event.insert_prop("kind", "trading");
        let _ = event.insert_prop("issues", issues);
        self.send(event);
    }

    pub fn window(&self, events: Vec<WindowEvent>) -> Result<usize, Refusal> {
        self.ready()?;
        let mut sent = 0;
        let mut snapshots = Vec::new();
        for w in events.into_iter().take(MOST_WINDOW_EVENTS) {
            let purpose = Purpose::of(&w.event);
            if !self.allows(purpose) {
                continue;
            }
            if purpose == Purpose::Usage
                && let Some(Value::String(sid)) = w.properties.get("$session_id")
            {
                *self.0.window_session.lock() = Some(sid.clone());
            }
            if w.event == "$snapshot" {
                snapshots.push(self.snapshot(w));
            } else {
                self.send(self.window_event(w));
            }
            sent += 1;
        }
        if !snapshots.is_empty() {
            self.send_snapshots(snapshots);
        }
        Ok(sent)
    }

    fn window_event(&self, w: WindowEvent) -> Event {
        let mut event = match Purpose::of(&w.event) {
            Purpose::Crashes => self.anonymous(&w.event),
            Purpose::Usage => self.event(&w.event),
        };
        for (key, value) in w.properties {
            match key.as_str() {
                "$set" => {
                    if let Some(set) = person_set(value) {
                        let _ = event.insert_prop(key, set);
                    }
                }
                k if WINDOW_OWN_PROPS.contains(&k) => {}
                _ => {
                    let _ = event.insert_prop(key, value);
                }
            }
        }
        if let Some(at) = w.timestamp {
            let _ = event.set_timestamp(at);
        }
        event
    }

    fn snapshot(&self, w: WindowEvent) -> Value {
        let (id, known) = self.distinct_id();
        let mut properties: Map<String, Value> = w
            .properties
            .into_iter()
            .filter(|(k, _)| !WINDOW_OWN_PROPS.contains(&k.as_str()) && k != "$set")
            .collect();
        properties.insert("distinct_id".into(), json!(id));
        if !known {
            properties.insert("$process_person_profile".into(), json!(false));
        }
        let mut snapshot = json!({
            "event": "$snapshot",
            "distinct_id": id,
            "properties": properties,
            "timestamp": w.timestamp.unwrap_or_else(chrono::Utc::now).to_rfc3339(),
        });
        scrub(&mut snapshot, Redactor::global());
        snapshot
    }

    fn send_snapshots(&self, snapshots: Vec<Value>) {
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let t = self.clone();
        rt.spawn(async move {
            if !t.allows(Purpose::Usage) {
                return;
            }
            if let Some(remote) = t.remote()
                && let Err(e) = remote.recordings(snapshots).await
            {
                tracing::debug!(error = %e.0, "a session recording batch did not go through");
            }
        });
    }

    fn ready(&self) -> Result<(), Refusal> {
        if !self.available() {
            Err(Refusal::Unavailable)
        } else if !self.consent().any() {
            Err(Refusal::NotSharing)
        } else {
            Ok(())
        }
    }

    pub async fn remote_settings(&self) -> RemoteSettings {
        if !self.available() || !self.allows(Purpose::Usage) {
            return RemoteSettings::default();
        }
        let (who, known) = self.distinct_id();
        let mut kept = self.0.settings.lock().await;
        if let Some(r) = kept.as_ref()
            && r.who == who
            && r.at.elapsed() < CONFIG_FOR
        {
            return r.settings.clone();
        }
        let Some(remote) = self.remote() else {
            return RemoteSettings {
                asked: true,
                ..RemoteSettings::default()
            };
        };
        let person = BTreeMap::from([
            ("app_version", json!(crate::VERSION)),
            ("build", json!(build())),
            ("os", json!(std::env::consts::OS)),
            ("signed_in", json!(known)),
        ]);
        let (flags, config, surveys) = tokio::join!(
            remote.flags(&who, &person),
            remote.config(),
            remote.surveys()
        );
        let flags = flags
            .inspect_err(|e| tracing::debug!(error = %e.0, "PostHog's flags did not load"))
            .unwrap_or_default();
        let config = config.unwrap_or_default();
        let surveys = surveys.unwrap_or_default();
        let settings = RemoteSettings {
            asked: true,
            replay: replay_of(&config, &flags),
            surveys: due_surveys(&surveys, &flags),
            flags,
        };
        if self.allows(Purpose::Usage) {
            *kept = Some(Remembered {
                who,
                at: Instant::now(),
                settings: settings.clone(),
            });
        }
        settings
    }

    fn ship_logs(&self) {
        if !self.0.global || self.0.logs_shipping.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            self.0.logs_shipping.store(false, Ordering::SeqCst);
            return;
        };
        let mut rx = logs::listen();
        let weak = Arc::downgrade(&self.0);
        rt.spawn(async move {
            while let Some(first) = rx.recv().await {
                let mut batch = vec![first];
                let until = tokio::time::Instant::now() + logs::EVERY;
                while batch.len() < logs::BATCH {
                    match tokio::time::timeout_at(until, rx.recv()).await {
                        Ok(Some(r)) => batch.push(r),
                        Ok(None) | Err(_) => break,
                    }
                }
                let Some(inner) = weak.upgrade() else { break };
                let t = Telemetry(inner);
                if !t.allows(Purpose::Usage) {
                    continue;
                }
                let (id, _) = t.distinct_id();
                let session = t.0.window_session.lock().clone();
                let who = logs::Who {
                    distinct_id: &id,
                    session_id: session.as_deref(),
                    build: build(),
                };
                let r = Redactor::global();
                let body = logs::otlp(&batch, &who, |s| r.redact_shared(s).into_owned());
                if let Some(remote) = t.remote()
                    && let Err(e) = remote.logs(&body).await
                {
                    tracing::debug!(error = %e.0, "a batch of logs did not go through");
                }
            }
        });
    }

    pub fn shape(&self, event: Event) -> Option<Event> {
        shape(self.consent(), event)
    }

    pub fn watch_accounts(&self, bus: &EventBus, orders: Arc<OrdersService>) {
        let changes = bus.subscribe(names::ACCOUNTS);
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        rt.spawn(async move {
            if let Ok(all) = orders.accounts().await {
                for u in all {
                    Redactor::global().register_private(u.account.id.as_ref());
                }
            }
            let Some((mut rx, replay)) = changes else {
                return;
            };
            for e in &replay {
                remember_account(&e.data);
            }
            loop {
                match rx.recv().await {
                    Ok(e) => remember_account(&e.data),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    pub fn watch_sign_in(&self, bus: &EventBus) {
        let Some((mut rx, replay)) = bus.subscribe(names::ACCOUNT) else {
            return;
        };
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let t = self.clone();
        rt.spawn(async move {
            let mut was: Option<AccountState> = replay
                .last()
                .and_then(|e| serde_json::from_str(e.data.get()).ok());
            let mut user: Option<String> = t.0.user.get().and_then(|u| u());
            loop {
                let e = match rx.recv().await {
                    Ok(e) => e,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let Ok(now) = serde_json::from_str::<AccountState>(e.data.get()) else {
                    continue;
                };
                let before = was.as_ref().map(|s| (s.phase, s.signing_in));
                if now.phase == AccountPhase::SignedIn {
                    let fresh = matches!(before, Some((p, signing)) if p != AccountPhase::SignedIn && (signing || now.signing_in));
                    if fresh && let Some(id) = t.0.user.get().and_then(|u| u()) {
                        t.signed_in(&id);
                    }
                    user = t.0.user.get().and_then(|u| u()).or(user);
                } else if now.phase == AccountPhase::SignedOut
                    && matches!(before, Some((AccountPhase::SignedIn, _)))
                    && let Some(id) = user.take()
                {
                    t.send(t.event_as("signed out", id, true));
                }
                was = Some(now);
            }
        });
    }

    fn signed_in(&self, id: &str) {
        if !self.allows(Purpose::Usage) {
            return;
        }
        let mut identify = self.event_as("$identify", id.to_owned(), true);
        let _ = identify.insert_prop("$anon_distinct_id", self.install_id());
        let _ = identify.insert_prop(
            "$set",
            json!({"app_version": crate::VERSION, "os": std::env::consts::OS, "build": build()}),
        );
        let _ = identify.insert_prop("$set_once", json!({"first_app_version": crate::VERSION}));
        self.send(identify);
        self.send(self.event_as("signed in", id.to_owned(), true));
    }
}

fn remember_account(data: &serde_json::value::RawValue) {
    if let Ok(v) = serde_json::from_str::<Value>(data.get())
        && let Some(id) = v.pointer("/account/id").and_then(Value::as_str)
    {
        Redactor::global().register_private(id);
    }
}

const WINDOW_OWN_PROPS: &[&str] = &[
    "token",
    "distinct_id",
    "$device_id",
    "$user_id",
    "$ip",
    "$process_person_profile",
    "$is_identified",
    "$set_once",
];

fn person_set(value: Value) -> Option<Value> {
    let Value::Object(set) = value else {
        return None;
    };
    let kept: Map<String, Value> = set
        .into_iter()
        .filter(|(k, _)| k.starts_with("$survey_"))
        .collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

fn replay_of(config: &Value, flags: &BTreeMap<String, Value>) -> Option<Replay> {
    let r = config.get("sessionRecording")?.as_object()?;
    if let Some(flag) = r.get("linkedFlag").and_then(linked_flag)
        && !flags.get(&flag).is_some_and(truthy)
    {
        return None;
    }
    let number = |v: &Value| v.as_f64().or_else(|| v.as_str()?.parse().ok());
    Some(Replay {
        sample_rate: r.get("sampleRate").and_then(number),
        minimum_duration_ms: r
            .get("minimumDurationMilliseconds")
            .and_then(number)
            .map(|ms| ms.max(0.0) as u64),
    })
}

fn linked_flag(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Object(o) => o.get("flag").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        _ => false,
    }
}

fn due_surveys(surveys: &[Value], flags: &BTreeMap<String, Value>) -> Vec<Survey> {
    let flag_ok = |s: &Value, key: &str| match s.get(key).and_then(Value::as_str) {
        Some(flag) => flags.get(flag).is_some_and(truthy),
        None => true,
    };
    surveys
        .iter()
        .filter(|s| s.get("type").and_then(Value::as_str) == Some("api"))
        .filter(|s| s.get("start_date").is_some_and(|d| !d.is_null()))
        .filter(|s| s.get("end_date").is_none_or(Value::is_null))
        .filter(|s| {
            [
                "linked_flag_key",
                "targeting_flag_key",
                "internal_targeting_flag_key",
            ]
            .iter()
            .all(|k| flag_ok(s, k))
        })
        .filter_map(|s| {
            let questions = s
                .get("questions")?
                .as_array()?
                .iter()
                .map(question_of)
                .collect::<Option<Vec<_>>>()?;
            let id = s.get("id")?.as_str()?.to_owned();
            let name = s
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            (!questions.is_empty()).then_some(Survey {
                id,
                name,
                questions,
            })
        })
        .collect()
}

fn question_of(q: &Value) -> Option<SurveyQuestion> {
    let kind = match q.get("type")?.as_str()? {
        "open" => SurveyKind::Open,
        "single_choice" => SurveyKind::SingleChoice,
        _ => return None,
    };
    let text = |k: &str| q.get(k).and_then(Value::as_str).map(str::to_owned);
    Some(SurveyQuestion {
        id: text("id")?,
        kind,
        question: text("question")?,
        description: text("description").filter(|d| !d.trim().is_empty()),
        choices: q
            .get("choices")
            .and_then(Value::as_array)
            .map(|c| {
                c.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        optional: q.get("optional").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn outcome(status: ToolCallStatus) -> Value {
    serde_json::to_value(status).unwrap_or(Value::Null)
}

fn ai_provider(provider: &str) -> &str {
    match provider {
        "codex" => "openai",
        "claude-code" => "anthropic",
        other => other,
    }
}

fn shape(consent: Consent, mut event: Event) -> Option<Event> {
    if !consent.allows(Purpose::of(event.event_name())) {
        return None;
    }
    for (key, value) in [("runtime_version", crate::VERSION), ("build", build())] {
        if !event.properties().contains_key(key) {
            let _ = event.insert_prop(key, value);
        }
    }
    let r = Redactor::global();
    let keys: Vec<String> = event.properties().keys().cloned().collect();
    for key in keys {
        if let Some(mut value) = event.remove_prop(&key) {
            scrub(&mut value, r);
            let _ = event.insert_prop(key, value);
        }
    }
    Some(event)
}

fn scrub(value: &mut Value, r: &Redactor) {
    match value {
        Value::String(s) => {
            if let std::borrow::Cow::Owned(clean) = r.redact_shared(s) {
                *s = clean;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| scrub(v, r)),
        Value::Object(map) => map.values_mut().for_each(|v| scrub(v, r)),
        _ => {}
    }
}

impl Inner {
    async fn outlet(inner: &Arc<Inner>) -> Option<&Outlet> {
        let key = inner.project.key.clone()?;
        Some(
            inner
                .outlet
                .get_or_init(|| Inner::connect(Arc::clone(inner), key))
                .await,
        )
    }

    async fn connect(inner: Arc<Inner>, key: String) -> Outlet {
        tessera_http::install_crypto();
        let global = inner.global;
        let options = Inner::options(inner, key);
        if global {
            if let Err(e) = posthog_rs::init_global(options).await {
                tracing::warn!(error = %e, "PostHog did not start: nothing is sent");
            }
            Outlet::Global
        } else {
            Outlet::Client(Box::new(posthog_rs::client(options).await))
        }
    }

    fn options(inner: Arc<Inner>, key: String) -> ClientOptions {
        let host = inner.project.host.clone();
        let error_tracking = ErrorTrackingOptionsBuilder::default()
            .capture_panics(true)
            .build()
            .unwrap_or_default();
        let gate = Arc::clone(&inner);
        let mut options = ClientOptionsBuilder::default();
        options
            .api_key(key)
            .host(host)
            .is_server(false)
            .disable_geoip(true)
            .error_tracking(error_tracking)
            .before_send(move |event| shape(gate.consent.get(), event));
        options.build().unwrap_or_else(|e| {
            tracing::warn!(error = %e, "PostHog's options are invalid: nothing is sent");
            ClientOptions::from("")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::ids::SessionId;
    use tessera_protocol::tools::RiskTier;

    fn record(tool: &str, origin: Origin, input: Value) -> ToolCallRecord {
        ToolCallRecord {
            call_id: tessera_core::ids::CallId::new("C-1"),
            tool: tool.into(),
            risk: RiskTier::Financial,
            origin,
            session_id: None,
            input_hash: String::new(),
            input,
            status: ToolCallStatus::Ok,
            started_at: tessera_core::Timestamp::from_nanos(0),
            finished_at: None,
            duration_ms: Some(12.0),
            error: None,
            approval_id: None,
            deduped: false,
            idempotency_key: None,
            summary: None,
            approved_by: None,
        }
    }

    fn sharing() -> Telemetry {
        let t = Telemetry::local(Project {
            key: Some("phc_test".into()),
            host: "http://127.0.0.1:9".into(),
        });
        t.0.consent.set(EVERYTHING);
        t
    }

    const EVERYTHING: Consent = Consent {
        crashes: true,
        usage: Some(true),
    };

    const NOTHING: Consent = Consent {
        crashes: false,
        usage: Some(false),
    };

    fn props(event: &Event) -> &HashMap<String, Value> {
        event.properties()
    }

    #[test]
    fn an_order_event_carries_what_was_ordered_and_by_whom_but_never_the_account() {
        let t = sharing();
        t.identify_with(|| Some("usr_42".into()));
        let rec = record(
            "orders.submit",
            Origin::Agent {
                session_id: SessionId::new("S-1"),
                provider: "codex".into(),
            },
            json!({"accountId": "APEX-123456", "instrument": "NQZ6", "side": "buy", "qty": 3,
                   "orderType": "limit", "limitPrice": 20641.25, "bracket": {"stopTicks": 8}}),
        );
        let event = t.product_event(&rec).unwrap();
        assert_eq!(event.event_name(), "order placed");
        assert_eq!(event.distinct_id(), "usr_42");
        let p = props(&event);
        assert_eq!(p["origin"], "agent");
        assert_eq!(p["agent_provider"], "codex");
        assert_eq!(p["outcome"], "ok");
        assert_eq!(p["instrument"], "NQZ6");
        assert_eq!(p["orderType"], "limit");
        assert_eq!(p["bracket"], true);
        assert_eq!(p["build"], build());
        let text = serde_json::to_string(p).unwrap();
        for leak in ["APEX-123456", "20641", "qty", "accountId"] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
        assert!(
            t.product_event(&record("orders.get", Origin::User, json!({})))
                .is_none()
        );
    }

    #[test]
    fn copy_and_journal_moments_say_how_much_not_what() {
        let t = sharing();
        let created = t
            .product_event(&record(
                "copy.create",
                Origin::User,
                json!({"name": "Evals", "leaderId": "APEX-1", "followers": [{"accountId": "APEX-2"}, {"accountId": "APEX-3"}]}),
            ))
            .unwrap();
        assert_eq!(created.event_name(), "copy group created");
        assert_eq!(props(&created)["followers"], 2);
        let reviewed = t
            .product_event(&record(
                "journal.update_trade",
                Origin::User,
                json!({"id": "T-1", "notes": "chased the open again", "rating": 2, "stopPrice": 20600.5}),
            ))
            .unwrap();
        let text = serde_json::to_string(props(&reviewed)).unwrap();
        assert_eq!(props(&reviewed)["notes"], true);
        assert_eq!(props(&reviewed)["rating"], true);
        for leak in ["chased", "20600", "stopPrice", "T-1"] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
    }

    #[test]
    fn before_sign_in_events_are_the_install_and_make_no_person() {
        let dir = tempfile::tempdir().unwrap();
        let t = Telemetry::build(
            Project {
                key: Some("phc_test".into()),
                ..Project::default()
            },
            false,
            Some(dir.path().to_path_buf()),
        );
        let event = t
            .product_event(&record(
                "research.run_study",
                Origin::User,
                json!({"id": "st-1"}),
            ))
            .unwrap();
        assert_eq!(props(&event)["$process_person_profile"], false);
        let kept = std::fs::read_to_string(dir.path().join(INSTALL_FILE)).unwrap();
        assert_eq!(event.distinct_id(), kept);
        let again = Telemetry::build(Project::default(), false, Some(dir.path().to_path_buf()));
        assert_eq!(
            again.install_id(),
            kept,
            "the next launch is the same install"
        );
    }

    #[test]
    fn nothing_leaves_while_sharing_is_off_and_what_leaves_is_redacted() {
        let token = tessera_core::token::mint(tessera_core::token::SESSION).unwrap();
        Redactor::global().register("rithmic-pw-telemetry-1");
        Redactor::global().register_private("APEX-777001");
        let mut event = Event::new("$exception", "usr_1");
        event
            .insert_prop(
                "$exception_list",
                json!([{"value": format!("login rithmic-pw-telemetry-1 on APEX-777001 at /ws?token={}", token.expose()),
                        "stacktrace": {"frames": [{"filename": "http://127.0.0.1:4100/?token=x"}]}}]),
            )
            .unwrap();
        event
            .insert_prop(
                "$current_url",
                format!("http://127.0.0.1:4100/?token={}", token.expose()),
            )
            .unwrap();
        assert!(shape(NOTHING, event.clone()).is_none());
        let shaped = shape(Consent::FRESH, event).unwrap();
        let text = serde_json::to_string(shaped.properties()).unwrap();
        assert!(!text.contains("rithmic-pw-telemetry-1"), "{text}");
        assert!(!text.contains("APEX-777001"), "{text}");
        assert!(!text.contains(&token.expose()[4..]), "{text}");
        assert!(text.contains("login [redacted] on [private]"), "{text}");
        assert_eq!(
            shaped.properties()["build"],
            build(),
            "a panic says its build too"
        );
    }

    fn report(sid: &SessionId, end: TurnEnd, error: Option<&str>) -> TurnReport {
        TurnReport {
            session: sid.clone(),
            provider: "claude-code".into(),
            model: Some("claude-opus-5-5".into()),
            effort: Some("high".into()),
            latency: std::time::Duration::from_millis(2500),
            end,
            error: error.map(str::to_owned),
            usage: Some(tessera_agent::TurnUsage {
                input_tokens: 1200,
                output_tokens: 300,
                cached_input_tokens: 800,
                reasoning_tokens: 0,
            }),
        }
    }

    #[test]
    fn a_turn_is_a_trace_of_its_model_call_and_tool_spans_without_words() {
        let t = sharing();
        let sid = SessionId::new("S-9");
        let agent = Origin::Agent {
            session_id: sid.clone(),
            provider: "claude-code".into(),
        };
        t.tool_call(&record(
            "market.get_bars",
            agent.clone(),
            json!({"instrument": "NQZ6"}),
        ));
        let mut denied = record("orders.create_draft", agent, json!({"qty": 2}));
        denied.status = ToolCallStatus::Denied;
        t.tool_call(&denied);
        let spans = t.0.turn_spans.lock().remove(sid.as_str()).unwrap();
        let events = t.trace(&report(&sid, TurnEnd::Completed, None), &spans);
        let names: Vec<&str> = events.iter().map(Event::event_name).collect();
        assert_eq!(
            names,
            ["$ai_trace", "$ai_generation", "$ai_span", "$ai_span"]
        );
        let trace = props(&events[0])["$ai_trace_id"].clone();
        assert!(events.iter().all(|e| props(e)["$ai_trace_id"] == trace));
        assert!(
            events[1..]
                .iter()
                .all(|e| props(e)["$ai_parent_id"] == trace)
        );
        assert_eq!(props(&events[0])["$ai_session_id"], "S-9");
        assert_eq!(props(&events[1])["$ai_provider"], "anthropic");
        assert_eq!(props(&events[1])["$ai_input_tokens"], 1200);
        assert_eq!(props(&events[3])["$ai_span_name"], "orders.create_draft");
        assert_eq!(props(&events[3])["$ai_is_error"], true);
        for e in &events {
            let p = props(e);
            for words in [
                "$ai_input",
                "$ai_output_choices",
                "$ai_input_state",
                "$ai_output_state",
            ] {
                assert!(!p.contains_key(words), "{} carries {words}", e.event_name());
            }
            assert!(!serde_json::to_string(p).unwrap().contains("NQZ6"));
        }
        let long = "x".repeat(500);
        let failed = t.trace(&report(&sid, TurnEnd::Failed, Some(&long)), &[]);
        assert_eq!(
            props(&failed[0])["$ai_error"].as_str().unwrap().len(),
            ERROR_MAX_CHARS
        );
    }

    #[test]
    fn the_window_may_send_only_what_the_consent_allows_in_a_build_with_a_project() {
        assert_eq!(
            Telemetry::default().window(vec![]),
            Err(Refusal::Unavailable)
        );
        let t = sharing();
        t.0.consent.set(NOTHING);
        assert_eq!(t.window(vec![]), Err(Refusal::NotSharing));
        t.0.consent.set(EVERYTHING);
        let window = WindowEvent {
            event: "area opened".into(),
            properties: json!({"area": "journal", "token": "phc_window", "distinct_id": "x",
                               "$process_person_profile": false, "$is_identified": false,
                               "$session_id": "0192-window", "$set_once": {"$initial_current_url": "x"},
                               "$set": {"$survey_responded/s-1": true, "email": "a@b.c"}})
            .as_object()
            .cloned()
            .unwrap(),
            timestamp: None,
        };
        t.identify_with(|| Some("usr_7".into()));
        let event = t.window_event(window.clone());
        assert_eq!(event.distinct_id(), "usr_7");
        let p = props(&event);
        assert_eq!(p["area"], "journal");
        assert_eq!(p["$set"], json!({"$survey_responded/s-1": true}));
        for theirs in [
            "token",
            "distinct_id",
            "$process_person_profile",
            "$is_identified",
            "$set_once",
        ] {
            assert!(!p.contains_key(theirs), "{theirs}: {p:?}");
        }
        assert_eq!(t.window(vec![window; 60]), Ok(MOST_WINDOW_EVENTS));
        let later = t.event("order placed");
        assert_eq!(
            props(&later)["$session_id"],
            "0192-window",
            "runtime events join the window's session"
        );
    }

    #[test]
    fn a_crash_report_goes_without_usage_and_never_names_the_person() {
        let t = sharing();
        t.0.consent.set(Consent::FRESH);
        t.identify_with(|| Some("usr_7".into()));
        let usage = WindowEvent {
            event: "area opened".into(),
            properties: Map::new(),
            timestamp: None,
        };
        let crash = WindowEvent {
            event: "$exception".into(),
            properties:
                json!({"$exception_list": [{"type": "TypeError", "value": "no instrument"}]})
                    .as_object()
                    .cloned()
                    .unwrap(),
            timestamp: None,
        };
        assert_eq!(t.window(vec![usage.clone(), crash.clone()]), Ok(1));
        let report = t.window_event(crash.clone());
        assert_eq!(report.distinct_id(), t.install_id());
        assert_eq!(props(&report)["$process_person_profile"], false);
        assert_eq!(
            props(&report)["$exception_list"][0]["value"],
            "no instrument"
        );
        t.0.consent.set(Consent {
            crashes: false,
            usage: Some(true),
        });
        assert_eq!(t.window(vec![usage, crash]), Ok(1));
        assert!(t.shape(Event::new_anon("$exception")).is_none());
        assert!(t.shape(Event::new_anon("area opened")).is_some());
    }

    #[test]
    fn a_snapshot_goes_as_a_recording_with_private_words_taken_out() {
        let t = sharing();
        Redactor::global().register_private("APEX-555123");
        let w = WindowEvent {
            event: "$snapshot".into(),
            properties: json!({"$session_id": "s", "$window_id": "w", "token": "phc_window",
                               "$snapshot_data": [{"type": 2, "data": {"node": {"textContent": "APEX-555123 ****"}}}]})
            .as_object()
            .cloned()
            .unwrap(),
            timestamp: None,
        };
        let s = t.snapshot(w);
        assert_eq!(s["event"], "$snapshot");
        assert_eq!(s["properties"]["distinct_id"], s["distinct_id"]);
        assert_eq!(s["properties"]["$process_person_profile"], false);
        assert!(s["properties"].get("token").is_none());
        let text = s.to_string();
        assert!(!text.contains("APEX-555123"), "{text}");
        assert!(text.contains("[private] ****"), "{text}");
    }

    #[test]
    fn replay_follows_the_project_and_its_linked_flag() {
        let flags = BTreeMap::from([("replay-alpha".to_owned(), json!(true))]);
        assert_eq!(replay_of(&json!({"sessionRecording": false}), &flags), None);
        let on = json!({"sessionRecording": {"endpoint": "/s/", "sampleRate": "0.50", "minimumDurationMilliseconds": 2000}});
        assert_eq!(
            replay_of(&on, &flags),
            Some(Replay {
                sample_rate: Some(0.5),
                minimum_duration_ms: Some(2000)
            })
        );
        let linked = json!({"sessionRecording": {"linkedFlag": "replay-beta"}});
        assert_eq!(replay_of(&linked, &flags), None);
        let linked =
            json!({"sessionRecording": {"linkedFlag": {"flag": "replay-alpha", "variant": null}}});
        assert!(replay_of(&linked, &flags).is_some());
    }

    #[test]
    fn a_survey_is_due_when_running_targeted_here_and_askable() {
        let survey = |id: &str, extra: Value| {
            let mut s = json!({"id": id, "name": id, "type": "api", "start_date": "2026-10-31T00:00:00Z", "end_date": null,
                "internal_targeting_flag_key": format!("survey-targeting-{id}"),
                "questions": [{"id": "q1", "type": "single_choice", "question": "How would you feel?", "choices": ["Very", "Somewhat", "Not"]},
                              {"id": "q2", "type": "open", "question": "Why?", "optional": true}]});
            for (k, v) in extra.as_object().unwrap() {
                s[k] = v.clone();
            }
            s
        };
        let flags = BTreeMap::from([
            ("survey-targeting-a".to_owned(), json!(true)),
            ("survey-targeting-b".to_owned(), json!(false)),
            ("survey-targeting-c".to_owned(), json!(true)),
            ("survey-targeting-d".to_owned(), json!(true)),
        ]);
        let all = [
            survey("a", json!({})),
            survey("b", json!({})),
            survey("c", json!({"type": "popover"})),
            survey("d", json!({"end_date": "2026-10-31T00:00:00Z"})),
            survey("e", json!({})),
        ];
        let due = due_surveys(&all, &flags);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "a");
        assert_eq!(due[0].questions[0].kind, SurveyKind::SingleChoice);
        assert_eq!(due[0].questions[0].choices, ["Very", "Somewhat", "Not"]);
        assert!(due[0].questions[1].optional);
        let rating = json!([{"id": "q", "type": "rating", "question": "?"}]);
        assert!(due_surveys(&[survey("a", json!({"questions": rating}))], &flags).is_empty());
    }

    #[test]
    fn the_built_project_takes_the_environment_first_and_ignores_blanks() {
        assert_eq!(
            chosen(Some(" phc_now ".into()), Some("phc_built")).as_deref(),
            Some("phc_now")
        );
        assert_eq!(
            chosen(None, Some("phc_built")).as_deref(),
            Some("phc_built")
        );
        assert_eq!(
            chosen(Some("  ".into()), Some("phc_built")).as_deref(),
            Some("phc_built")
        );
        assert_eq!(chosen(Some("  ".into()), None), None);
        assert_eq!(chosen(None, Some("")), None);
    }
}
