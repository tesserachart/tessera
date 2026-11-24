use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use rithmic_rs::rti::messages::RithmicMessage;
use rithmic_rs::{
    ConnectStrategy, RithmicConfig, RithmicEnv, RithmicError, RithmicHistoryPlant,
    RithmicHistoryPlantHandle, RithmicResponse, RithmicTickerPlant, RithmicTickerPlantHandle,
};
use tessera_core::backoff::Backoff;
use tessera_core::health::{ConnectionPhase, HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::time::Timestamp;
use tessera_market::MarketError;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::watch;
use tracing::{info, warn};

use crate::credentials::{APP_NAME, RithmicLogin};
use crate::feeds::Feeds;
use crate::link::{Event, Link};
use crate::plant::Owned;
use crate::templates::{GateRefused, Template, TemplateGate};

#[derive(Clone, Debug)]
pub struct RithmicOptions {
    pub provider_id: String,
    pub display_name: String,
    pub connect_timeout: Duration,
    /// `rithmic-rs` sets no request deadline of its own.
    pub request_timeout: Duration,
    pub linger: Duration,
    pub clash_window: Duration,
}

impl RithmicOptions {
    pub fn for_system(system: &str) -> Self {
        let slug = tessera_core::ids::slug(system);
        let provider_id = if slug.starts_with("rithmic") {
            slug
        } else {
            format!("rithmic-{slug}")
        };
        let display_name = if system.to_ascii_lowercase().contains("rithmic") {
            system.to_owned()
        } else {
            format!("{system} · Rithmic")
        };
        Self {
            provider_id,
            display_name,
            connect_timeout: Duration::from_secs(20),
            request_timeout: Duration::from_secs(20),
            linger: Duration::from_secs(30),
            clash_window: CLASH_WINDOW,
        }
    }
}

pub const CLASH_WINDOW: Duration = Duration::from_secs(10 * 60);
pub const LOGGED_OUT: &str = "logged out by Rithmic";
pub const TAKEN_OVER: &str = "Another session of this Rithmic login took over: R Trader, another Tessera or \
                              another app signed in as the same user. Tessera stays logged out so the two do \
                              not keep logging each other out. Close the other session, then reconnect.";

pub const HISTORY_REFUSED: &str =
    "Rithmic refused history for this login. Prices stay live; charts show only what is saved.";

pub const RECONNECT: Backoff =
    Backoff::new(Duration::from_secs(1), Duration::from_secs(60)).with_jitter(0.2);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Forced {
    #[default]
    Never,
    LoggingInAgain,
    LoggedInAgain(tokio::time::Instant),
    TakenOver,
}

impl Forced {
    fn on_forced_logout(&mut self, now: tokio::time::Instant, window: Duration) -> AfterForced {
        let (next, after) = match *self {
            Self::LoggingInAgain => (Self::LoggingInAgain, AfterForced::AlreadyLoggingIn),
            Self::TakenOver => (Self::TakenOver, AfterForced::StayDown),
            Self::LoggedInAgain(at) if now.duration_since(at) < window => {
                (Self::TakenOver, AfterForced::StayDown)
            }
            Self::Never | Self::LoggedInAgain(_) => (Self::LoggingInAgain, AfterForced::LogInOnce),
        };
        *self = next;
        after
    }

    fn logged_in_again(&mut self, now: tokio::time::Instant) {
        if *self == Self::LoggingInAgain {
            *self = Self::LoggedInAgain(now);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AfterForced {
    LogInOnce,
    AlreadyLoggingIn,
    StayDown,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpenError {
    #[error("Rithmic refused the login: {0}")]
    Refused(String),
    #[error("cannot reach Rithmic: {0}")]
    Transport(String),
    #[error(transparent)]
    Gate(#[from] GateRefused),
}

struct History {
    generation: u64,
    _plant: Owned<RithmicHistoryPlant>,
    handle: RithmicHistoryPlantHandle,
    alive: watch::Receiver<bool>,
}

pub struct Session {
    pub(crate) login: RithmicLogin,
    pub(crate) opts: RithmicOptions,
    pub(crate) gate: TemplateGate,
    pub(crate) feeds: Feeds,
    pub(crate) history_use: Mutex<tessera_market::provider::HistoryUse>,
    ticker_config: RithmicConfig,
    history_config: RithmicConfig,
    link: Mutex<Link>,
    ticker: RwLock<Option<Arc<RithmicTickerPlantHandle>>>,
    history: tokio::sync::Mutex<Option<History>>,
    history_handle: Mutex<Option<RithmicHistoryPlantHandle>>,
    starting: tokio::sync::Mutex<()>,
    history_failed_at: Mutex<Option<std::time::Instant>>,
    history_refused: Mutex<Option<(u64, String)>>,
    forced: Mutex<Forced>,
    last_data: AtomicI64,
    latency_us: AtomicI64,
    runtime: tokio::runtime::Handle,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("login", &self.login)
            .field("provider_id", &self.opts.provider_id)
            .field("phase", self.link.lock().phase())
            .finish_non_exhaustive()
    }
}

pub(crate) fn config(login: &RithmicLogin, capacity: usize) -> Result<RithmicConfig, OpenError> {
    RithmicConfig::builder(RithmicEnv::Live)
        .url(login.gateway_url.clone())
        // rithmic-rs requires a second URL even when only one is used.
        .beta_url(login.gateway_url.clone())
        .user(login.user.clone())
        .password(login.password.clone())
        .system_name(login.system_name.clone())
        .app_name(APP_NAME)
        .app_version(env!("CARGO_PKG_VERSION"))
        .subscription_capacity(capacity)
        .build()
        .map_err(|e| OpenError::Transport(e.to_string()))
}

impl Session {
    pub fn new(login: RithmicLogin, opts: RithmicOptions) -> Result<Arc<Self>, OpenError> {
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| OpenError::Transport("no tokio runtime to run the plants on".into()))?;
        let ticker_config = config(&login, 1 << 16)?;
        let history_config = config(&login, 1 << 10)?;
        Ok(Arc::new(Self {
            gate: TemplateGate::new(login.system_name.clone()),
            login,
            opts,
            feeds: Feeds::default(),
            history_use: Mutex::default(),
            ticker_config,
            history_config,
            link: Mutex::new(Link::default()),
            ticker: RwLock::new(None),
            history: tokio::sync::Mutex::new(None),
            history_handle: Mutex::new(None),
            starting: tokio::sync::Mutex::new(()),
            history_failed_at: Mutex::new(None),
            history_refused: Mutex::new(None),
            forced: Mutex::new(Forced::Never),
            last_data: AtomicI64::new(0),
            latency_us: AtomicI64::new(-1),
            runtime,
        }))
    }

    pub(crate) fn runtime(&self) -> &tokio::runtime::Handle {
        &self.runtime
    }

    pub fn phase(&self) -> ConnectionPhase {
        self.link.lock().phase().clone()
    }

    pub(crate) fn generation(&self) -> u64 {
        self.link.lock().generation()
    }

    fn advance(&self, generation: u64, event: Event) -> bool {
        self.link.lock().advance(generation, event)
    }

    #[cfg(test)]
    pub(crate) fn assume(&self, phase: ConnectionPhase) -> u64 {
        self.link.lock().assume(phase)
    }

    fn history_refused(&self) -> Option<String> {
        let generation = self.generation();
        self.history_refused
            .lock()
            .as_ref()
            .filter(|(refused_in, _)| *refused_in == generation)
            .map(|(_, why)| why.clone())
    }

    pub(crate) fn redact(&self, e: impl std::fmt::Display) -> String {
        self.login.redact(&e.to_string())
    }

    pub(crate) fn saw_data(&self, exchange_ts: Option<Timestamp>) {
        let now = Timestamp::now();
        self.last_data.store(now.0, Ordering::Relaxed);
        if let Some(ts) = exchange_ts {
            let sample = (now.0 - ts.0) / 1_000;
            if (0..60_000_000).contains(&sample) {
                let prev = self.latency_us.load(Ordering::Relaxed);
                let next = if prev < 0 {
                    sample
                } else {
                    (prev * 7 + sample) / 8
                };
                self.latency_us.store(next, Ordering::Relaxed);
            }
        }
    }

    pub(crate) fn ticker(&self) -> Result<Arc<RithmicTickerPlantHandle>, MarketError> {
        if let Some(h) = self.ticker.read().as_ref() {
            return Ok(Arc::clone(h));
        }
        Err(MarketError::Unavailable(self.unavailable_reason()))
    }

    fn unavailable_reason(&self) -> String {
        match self.phase() {
            ConnectionPhase::Stopped => "the Rithmic connection is not started".into(),
            ConnectionPhase::Connecting => "connecting to Rithmic".into(),
            ConnectionPhase::Live => "the Rithmic ticker plant is not ready".into(),
            ConnectionPhase::Reconnecting { attempt, reason } => {
                format!("Rithmic connection lost ({reason}); reconnecting, attempt {attempt}")
            }
            ConnectionPhase::Waiting => "Logged out by Rithmic; logging in again".into(),
            ConnectionPhase::LoggedOut => {
                "Rithmic ended the session (ForcedLogout); reconnect to continue".into()
            }
            ConnectionPhase::TakenOver => TAKEN_OVER.into(),
            ConnectionPhase::Refused { reason } => format!("Rithmic refused the login: {reason}"),
            ConnectionPhase::Unreachable { reason } => format!("cannot reach Rithmic: {reason}"),
        }
    }

    pub(crate) fn forced_out_words(&self) -> String {
        match self.phase() {
            ConnectionPhase::TakenOver => TAKEN_OVER.into(),
            p if p == ConnectionPhase::Live || p.coming_back() => {
                "Logged out by Rithmic. Logging in again.".into()
            }
            _ => "Rithmic ended the session. Reconnect to continue.".into(),
        }
    }

    pub(crate) async fn request<T>(
        &self,
        template: Template,
        fut: impl std::future::Future<Output = Result<T, RithmicError>>,
    ) -> Result<T, MarketError> {
        self.gate
            .allow(template)
            .map_err(|e| MarketError::Unavailable(e.to_string()))?;
        match tokio::time::timeout(self.opts.request_timeout, fut).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(MarketError::Unavailable(self.redact(e))),
            Err(_) => Err(MarketError::Unavailable(format!(
                "Rithmic did not answer template {} within {:?}",
                template.id(),
                self.opts.request_timeout
            ))),
        }
    }

    pub async fn start(self: &Arc<Self>) -> Result<(), OpenError> {
        let _one = self.starting.lock().await;
        *self.forced.lock() = Forced::Never;
        self.start_locked().await
    }

    async fn start_locked(self: &Arc<Self>) -> Result<(), OpenError> {
        let generation = self.link.lock().start();
        self.drop_ticker();
        match self.open_ticker().await {
            Ok((plant, handle)) => {
                let rx = plant.get_handle().subscription_receiver;
                if !self.install(handle, generation) {
                    return Err(OpenError::Transport(
                        "the connection was stopped while it logged in".into(),
                    ));
                }
                info!(
                    provider = %self.opts.provider_id,
                    system = %self.login.system_name,
                    "rithmic ticker plant logged in",
                );
                let me = Arc::clone(self);
                self.runtime
                    .spawn(async move { me.supervise(plant, rx, generation).await });
                Ok(())
            }
            Err(e) => {
                self.advance(generation, Event::failed(&e));
                Err(e)
            }
        }
    }

    pub async fn reconnect(self: &Arc<Self>) -> Result<(), OpenError> {
        let _one = self.starting.lock().await;
        *self.forced.lock() = Forced::Never;
        self.gate.reopen();
        self.drop_ticker();
        self.drop_history().await;
        self.start_locked().await
    }

    pub async fn shutdown(&self) {
        let ticker = {
            let mut slot = self.ticker.write();
            self.link.lock().stop();
            slot.take()
        };
        if let Some(h) = ticker {
            let _ = tokio::time::timeout(Duration::from_secs(5), h.disconnect()).await;
            h.abort();
        }
        let history = self.history.lock().await.take();
        *self.history_handle.lock() = None;
        if let Some(h) = history {
            let _ = tokio::time::timeout(Duration::from_secs(5), h.handle.disconnect()).await;
        }
        self.feeds.close_all();
    }

    async fn drop_history(&self) {
        if let Some(h) = self.history_handle.lock().take() {
            h.abort();
        }
        *self.history.lock().await = None;
    }

    fn current(&self, generation: u64) -> bool {
        self.link.lock().current(generation)
    }

    fn install(self: &Arc<Self>, handle: RithmicTickerPlantHandle, generation: u64) -> bool {
        {
            let mut slot = self.ticker.write();
            if !self.advance(generation, Event::LoggedIn) {
                return false;
            }
            if let Some(old) = slot.replace(Arc::new(handle)) {
                old.abort();
            }
        }
        self.feeds.reset_all();
        for key in self.feeds.keys() {
            crate::feeds::spawn_reconcile(self, key);
        }
        true
    }

    fn drop_ticker(&self) {
        if let Some(h) = self.ticker.write().take() {
            h.abort();
        }
    }

    async fn open_ticker(
        &self,
    ) -> Result<(Owned<RithmicTickerPlant>, RithmicTickerPlantHandle), OpenError> {
        self.gate.allow(Template::Login)?;
        let plant = tokio::time::timeout(
            self.opts.connect_timeout,
            RithmicTickerPlant::connect(&self.ticker_config, ConnectStrategy::Simple),
        )
        .await
        .map_err(|_| OpenError::Transport("connect timed out".into()))?
        .map_err(|e| OpenError::Transport(self.redact(e)))?;
        let plant = Owned::new(plant);
        let handle = plant.get_handle();
        match tokio::time::timeout(self.opts.connect_timeout, handle.login()).await {
            Ok(Ok(_)) => Ok((plant, handle)),
            Ok(Err(e)) => Err(login_error(&e, |x| self.redact(x))),
            Err(_) => Err(OpenError::Transport("login timed out".into())),
        }
    }

    async fn supervise(
        self: Arc<Self>,
        mut plant: Owned<RithmicTickerPlant>,
        mut rx: tokio::sync::broadcast::Receiver<RithmicResponse>,
        generation: u64,
    ) {
        loop {
            let ended = loop {
                if !self.current(generation) {
                    break End::Stopped;
                }
                match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
                    Err(_) => continue,
                    Ok(Ok(update)) => {
                        if let Some(end) = self.handle_update(update) {
                            break end;
                        }
                    }
                    Ok(Err(RecvError::Lagged(n))) => {
                        warn!(
                            provider = %self.opts.provider_id,
                            missed = n,
                            "rithmic ticker updates missed; rebuilding books",
                        );
                        self.feeds.resync_books(&self);
                    }
                    Ok(Err(RecvError::Closed)) => break End::Lost("the plant stopped".into()),
                }
            };
            match ended {
                End::Stopped => return,
                End::Forced => {
                    self.forced_logout("ticker", generation);
                    return;
                }
                End::Lost(_) if !self.current(generation) => return,
                End::Lost(reason) => {
                    warn!(
                        provider = %self.opts.provider_id,
                        %reason,
                        "rithmic ticker connection lost",
                    );
                    self.drop_ticker();
                    self.feeds.reset_all();
                    match self.reconnect_with_backoff(generation, reason).await {
                        Some((p, r)) => {
                            drop(std::mem::replace(&mut plant, p));
                            rx = r;
                        }
                        None => return,
                    }
                }
            }
        }
    }

    fn handle_update(self: &Arc<Self>, update: RithmicResponse) -> Option<End> {
        match connection_end(&update.message, update.error.as_ref()) {
            Some(End::Lost(reason)) => Some(End::Lost(self.redact(reason))),
            Some(end) => Some(end),
            None => {
                self.feeds.dispatch(self, update.message);
                None
            }
        }
    }

    async fn reconnect_with_backoff(
        self: &Arc<Self>,
        generation: u64,
        reason: String,
    ) -> Option<(
        Owned<RithmicTickerPlant>,
        tokio::sync::broadcast::Receiver<RithmicResponse>,
    )> {
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let retrying = Event::Retrying {
                attempt,
                reason: reason.clone(),
            };
            if !self.advance(generation, retrying) {
                return None;
            }
            tokio::time::sleep(RECONNECT.delay(attempt)).await;
            let _one = self.starting.lock().await;
            if !self.current(generation) {
                return None;
            }
            self.gate.reopen();
            match self.open_ticker().await {
                Ok((plant, handle)) => {
                    let rx = plant.get_handle().subscription_receiver;
                    if !self.install(handle, generation) {
                        return None;
                    }
                    info!(
                        provider = %self.opts.provider_id,
                        attempt,
                        "rithmic ticker plant reconnected",
                    );
                    return Some((plant, rx));
                }
                Err(OpenError::Refused(m)) => {
                    warn!(
                        provider = %self.opts.provider_id,
                        "rithmic refused the login on reconnect; not retrying",
                    );
                    self.advance(generation, Event::Refused(m));
                    return None;
                }
                Err(OpenError::Gate(_)) => {
                    self.advance(generation, Event::LoggedOut);
                    return None;
                }
                Err(OpenError::Transport(m)) => {
                    warn!(
                        provider = %self.opts.provider_id,
                        attempt,
                        reason = %m,
                        "rithmic reconnect failed",
                    );
                }
            }
        }
    }

    pub(crate) fn forced_logout(self: &Arc<Self>, plant: &str, generation: u64) {
        let (after, next, ticker) = {
            let mut slot = self.ticker.write();
            let mut link = self.link.lock();
            if !link.running(generation) {
                return;
            }
            let after = self
                .forced
                .lock()
                .on_forced_logout(tokio::time::Instant::now(), self.opts.clash_window);
            let event = match after {
                AfterForced::StayDown => Event::TakenOver,
                AfterForced::LogInOnce | AfterForced::AlreadyLoggingIn => Event::Retrying {
                    attempt: 1,
                    reason: LOGGED_OUT.into(),
                },
            };
            let Some(next) = link.supersede(generation, event) else {
                return;
            };
            self.gate.close();
            (after, next, slot.take())
        };
        warn!(
            provider = %self.opts.provider_id,
            plant,
            ?after,
            "rithmic forced logout",
        );
        if let Some(h) = ticker {
            h.abort();
        }
        if let Some(h) = self.history_handle.lock().take() {
            h.abort();
        }
        if let Ok(mut h) = self.history.try_lock() {
            *h = None;
        }
        self.feeds.reset_all();
        if after != AfterForced::StayDown {
            let me = Arc::clone(self);
            self.runtime.spawn(me.log_in_again(next));
        }
    }

    fn log_in_again(self: Arc<Self>, generation: u64) -> futures::future::BoxFuture<'static, ()> {
        Box::pin(async move {
            let Some((plant, rx)) = self
                .reconnect_with_backoff(generation, LOGGED_OUT.into())
                .await
            else {
                return;
            };
            self.forced
                .lock()
                .logged_in_again(tokio::time::Instant::now());
            self.supervise(plant, rx, generation).await;
        })
    }

    pub(crate) async fn with_history<T, F, Fut>(self: &Arc<Self>, f: F) -> Result<T, MarketError>
    where
        F: FnOnce(RithmicHistoryPlantHandle) -> Fut,
        Fut: std::future::Future<Output = Result<T, MarketError>>,
    {
        if self.gate.is_closed() {
            return Err(MarketError::Unavailable(GateRefused::Closed.to_string()));
        }
        let generation = {
            let link = self.link.lock();
            if !matches!(
                link.phase(),
                ConnectionPhase::Live | ConnectionPhase::Reconnecting { .. }
            ) {
                drop(link);
                return Err(MarketError::Unavailable(self.unavailable_reason()));
            }
            link.generation()
        };
        if let Some(why) = self.history_refused() {
            return Err(MarketError::Unavailable(format!(
                "Rithmic refused the history login: {why}"
            )));
        }
        let mut slot = self.history.lock().await;
        if slot
            .as_ref()
            .is_some_and(|h| !*h.alive.borrow() || h.generation != generation)
        {
            *slot = None;
            *self.history_handle.lock() = None;
        }
        if slot.is_none() {
            if let Some(at) = *self.history_failed_at.lock()
                && at.elapsed() < Duration::from_secs(5)
            {
                return Err(MarketError::Unavailable(
                    "the Rithmic history plant failed moments ago; try again shortly".into(),
                ));
            }
            match self.open_history(generation).await {
                Ok(h) => {
                    *self.history_handle.lock() = Some(h.handle.clone());
                    *slot = Some(h);
                }
                Err(e) => {
                    *self.history_failed_at.lock() = Some(std::time::Instant::now());
                    if let OpenError::Refused(m) = &e {
                        warn!(
                            provider = %self.opts.provider_id,
                            reason = %m,
                            "rithmic refused the history login; prices go on",
                        );
                        *self.history_refused.lock() = Some((generation, m.clone()));
                        return Err(MarketError::Unavailable(format!(
                            "Rithmic refused the history login: {m}"
                        )));
                    }
                    return Err(MarketError::Unavailable(e.to_string()));
                }
            }
        }
        let handle = slot.as_ref().map(|h| h.handle.clone()).ok_or_else(|| {
            MarketError::Unavailable("the Rithmic history plant is not connected".into())
        })?;
        f(handle).await
    }

    async fn open_history(self: &Arc<Self>, generation: u64) -> Result<History, OpenError> {
        self.gate.allow(Template::Login)?;
        let plant = tokio::time::timeout(
            self.opts.connect_timeout,
            RithmicHistoryPlant::connect(&self.history_config, ConnectStrategy::Simple),
        )
        .await
        .map_err(|_| OpenError::Transport("connect timed out".into()))?
        .map_err(|e| OpenError::Transport(self.redact(e)))?;
        let plant = Owned::new(plant);
        let handle = plant.get_handle();
        match tokio::time::timeout(self.opts.connect_timeout, handle.login()).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(login_error(&e, |x| self.redact(x))),
            Err(_) => return Err(OpenError::Transport("login timed out".into())),
        }
        let (alive_tx, alive) = watch::channel(true);
        let mut rx = plant.get_handle().subscription_receiver;
        let me = Arc::clone(self);
        self.runtime.spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(u) => match connection_end(&u.message, u.error.as_ref()) {
                        Some(End::Forced) => {
                            let _ = alive_tx.send(false);
                            me.forced_logout("history", generation);
                            return;
                        }
                        Some(_) => {
                            let _ = alive_tx.send(false);
                            return;
                        }
                        None => {}
                    },
                    Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => {
                        let _ = alive_tx.send(false);
                        return;
                    }
                }
            }
        });
        Ok(History {
            generation,
            _plant: plant,
            handle,
            alive,
        })
    }

    pub fn health(&self) -> ProviderHealth {
        let phase = self.phase();
        let message = if phase == ConnectionPhase::Live {
            let depth = match self.feeds.unavailable_books(self.opts.linger).as_slice() {
                [] => None,
                [(id, why)] => Some(format!("No depth for {id}: {why}.")),
                [(id, why), rest @ ..] => {
                    Some(format!("No depth for {id} and {} more: {why}.", rest.len()))
                }
            };
            let history = self.history_refused().map(|_| HISTORY_REFUSED.to_owned());
            match (history, depth) {
                (Some(h), Some(d)) => Some(format!("{h} {d}")),
                (h, d) => h.or(d),
            }
        } else {
            None
        };
        let status = match (phase.status(), &message) {
            (HealthStatus::Ok, Some(_)) => HealthStatus::Degraded,
            (status, _) => status,
        };
        let last = self.last_data.load(Ordering::Relaxed);
        let lat = self.latency_us.load(Ordering::Relaxed);
        ProviderHealth {
            provider_id: self.opts.provider_id.clone(),
            kind: ProviderKind::MarketData,
            display_name: self.opts.display_name.clone(),
            status,
            latency_ms: (lat >= 0).then(|| (lat as f64 / 1_000.0).round()),
            last_message_at: (last > 0).then_some(Timestamp(last)),
            message,
            connection: Some(phase),
            accounts: None,
            checked_at: Timestamp::now(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum End {
    Stopped,
    Forced,
    Lost(String),
}

pub(crate) fn connection_end(
    message: &RithmicMessage,
    error: Option<&RithmicError>,
) -> Option<End> {
    if matches!(message, RithmicMessage::ForcedLogout(_))
        || matches!(error, Some(RithmicError::ForcedLogout(_)))
    {
        return Some(End::Forced);
    }
    error
        .filter(|e| e.is_connection_issue())
        .map(|e| End::Lost(e.to_string()))
}

pub(crate) fn login_error(e: &RithmicError, redact: impl Fn(&RithmicError) -> String) -> OpenError {
    match e {
        RithmicError::RequestRejected(r) => {
            OpenError::Refused(refusal_words(r.code.as_deref(), r.message.as_deref()))
        }
        other if other.is_connection_issue() => OpenError::Transport(redact(other)),
        other => OpenError::Refused(redact(other)),
    }
}

pub(crate) fn refusal_words(code: Option<&str>, message: Option<&str>) -> String {
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    match (message, code) {
        (Some(m), Some(c)) => format!("{m} (code {c})"),
        (Some(m), None) => m.to_owned(),
        (None, Some(c)) => format!("code {c}"),
        (None, None) => "no reason given".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_a_minute_with_jitter() {
        for (attempt, base) in [
            (1u32, 1_000u64),
            (2, 2_000),
            (4, 8_000),
            (7, 60_000),
            (30, 60_000),
        ] {
            let d = RECONNECT.delay(attempt).as_millis() as u64;
            assert!(
                d >= base * 8 / 10 && d <= base * 12 / 10,
                "attempt {attempt}: {d} ms"
            );
        }
    }

    #[test]
    fn a_refused_login_says_rithmic_s_words_then_its_code() {
        assert_eq!(
            refusal_words(Some("13"), Some("permission denied")),
            "permission denied (code 13)"
        );
        assert_eq!(refusal_words(Some("13"), None), "code 13");
        assert_eq!(refusal_words(None, Some(" bad app ")), "bad app");
        assert_eq!(refusal_words(Some("13"), Some(" ")), "code 13");
        assert_eq!(refusal_words(None, None), "no reason given");
    }

    #[test]
    fn forced_logout_ends_the_session_and_drops_reconnect() {
        let forced = RithmicMessage::ForcedLogout(Default::default());
        assert_eq!(connection_end(&forced, None), Some(End::Forced));
        let err = RithmicError::ForcedLogout("server".into());
        assert_eq!(
            connection_end(&RithmicMessage::ConnectionError, Some(&err)),
            Some(End::Forced)
        );
        assert!(matches!(
            connection_end(
                &RithmicMessage::HeartbeatTimeout,
                Some(&RithmicError::HeartbeatTimeout)
            ),
            Some(End::Lost(_))
        ));
        assert!(matches!(
            connection_end(
                &RithmicMessage::ConnectionError,
                Some(&RithmicError::ConnectionClosed)
            ),
            Some(End::Lost(_))
        ));
        let refused = RithmicError::ProtocolError("bad frame".into());
        assert_eq!(
            connection_end(&RithmicMessage::HeartbeatTimeout, Some(&refused)),
            None
        );
        assert_eq!(connection_end(&RithmicMessage::Unknown, None), None);
    }

    #[test]
    fn one_more_login_per_forced_logout_until_another_session_takes_the_seat_back() {
        let window = Duration::from_secs(600);
        let t0 = tokio::time::Instant::now();
        let mut f = Forced::Never;
        assert_eq!(f.on_forced_logout(t0, window), AfterForced::LogInOnce);
        assert_eq!(
            f.on_forced_logout(t0, window),
            AfterForced::AlreadyLoggingIn,
            "every plant of one logout is one logout"
        );
        f.logged_in_again(t0 + Duration::from_secs(2));
        assert_eq!(
            f.on_forced_logout(t0 + Duration::from_secs(30), window),
            AfterForced::StayDown
        );
        assert_eq!(
            f.on_forced_logout(t0 + Duration::from_secs(3_600), window),
            AfterForced::StayDown,
            "taken over until the user reconnects"
        );

        let mut f = Forced::Never;
        f.on_forced_logout(t0, window);
        f.logged_in_again(t0);
        assert_eq!(
            f.on_forced_logout(t0 + window, window),
            AfterForced::LogInOnce,
            "a logout long after is a new one"
        );
    }

    #[test]
    fn the_desk_reads_the_takeover_in_the_words_the_shared_fixture_pins() {
        let pinned = include_str!("../../../fixtures/connections/taken-over.json");
        assert!(
            pinned.contains(&format!("\"rithmic\": \"{TAKEN_OVER}\"")),
            "fixtures/connections/taken-over.json holds the session's words"
        );
    }

    #[test]
    fn ids_and_names_come_from_the_system() {
        let o = RithmicOptions::for_system("Apex");
        assert_eq!(o.provider_id, "rithmic-apex");
        assert_eq!(o.display_name, "Apex · Rithmic");
        let o = RithmicOptions::for_system("Rithmic Paper Trading");
        assert_eq!(o.provider_id, "rithmic-paper-trading");
        assert_eq!(o.display_name, "Rithmic Paper Trading");
    }
}
