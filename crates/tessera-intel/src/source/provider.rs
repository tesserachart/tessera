use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::NaiveDate;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde_json::Value;
use tessera_core::backoff::Backoff;
use tessera_core::capabilities::IntelCapabilities;
#[cfg(any(test, feature = "test-support"))]
use tessera_core::catalog::Catalog;
use tessera_core::conversion::ConversionRecord;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::instrument::ContractSpec;
use tessera_core::levels::Level;
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_core::{InstrumentId, SharedClock, Timestamp};

use super::http::{HttpClient, HttpError, HttpRequest};
use super::parse::{self, Parsed, number, to_level};
use super::schedule::{after, in_window, quota_day, schedule_words};
use super::select::{select, text_of};
use super::spec::{
    AuthPlacement, ConvertRequest, ConvertSpec, InstrumentMapping, LevelSourceSpec, OffHours,
    RequestSpec, SessionName, fill,
};
use crate::io::{
    DeclaredLevel, DeclaredPackage, HistoryReach, LevelSourceInfo, PoolCalls, TestSourceOutput,
    TestedRequest,
};
use crate::{HistoryFile, HistoryRequest, IntelError, IntelligenceProvider, LevelSnapshot};

const RATE_LIMITED: Backoff = Backoff::new(Duration::from_secs(60), Duration::from_secs(900));
const REFUSED: Backoff = Backoff::new(
    Duration::from_secs(6 * 3600),
    Duration::from_secs(24 * 3600),
);

pub trait RawSink: Send + Sync + 'static {
    fn put(&self, bytes: &[u8], media_type: &str, source: &str) -> Option<String>;
}

#[async_trait]
pub trait SpecLookup: Send + Sync + 'static {
    async fn contract_spec(&self, instrument: &InstrumentId) -> Option<ContractSpec>;
}

#[cfg(any(test, feature = "test-support"))]
#[async_trait]
impl SpecLookup for Catalog {
    async fn contract_spec(&self, instrument: &InstrumentId) -> Option<ContractSpec> {
        self.spec(instrument).cloned()
    }
}

#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[secret]")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Failure {
    KeyRejected(String),
    Refused(String),
    RateLimited(String),
    Failed(String),
}

impl Failure {
    fn words(&self) -> &str {
        match self {
            Self::KeyRejected(s) | Self::Refused(s) | Self::RateLimited(s) | Self::Failed(s) => s,
        }
    }
}

#[derive(Debug, Default)]
enum Phase {
    #[default]
    Fresh,
    Failing {
        failure: Failure,
        failures: u32,
        retry_at: Timestamp,
    },
}

#[derive(Debug, Default)]
struct Slot {
    body: Option<Arc<Value>>,
    received_at: Option<Timestamp>,
    raw_blob: Option<String>,
    in_window: bool,
    tried_off_hours: bool,
    phase: Phase,
    status: Option<u16>,
}

impl Slot {
    fn waits(&self, now: Timestamp) -> bool {
        matches!(self.phase, Phase::Failing { retry_at, .. } if retry_at > now)
    }

    fn failure(&self) -> Option<&Failure> {
        match &self.phase {
            Phase::Fresh => None,
            Phase::Failing { failure, .. } => Some(failure),
        }
    }

    fn failed(&mut self, failure: Failure, now: Timestamp, backoff: impl Fn(u32) -> Duration) {
        let failures = match &self.phase {
            Phase::Failing { failures, .. } => failures + 1,
            Phase::Fresh => 1,
        };
        let retry_at = after(now, backoff(failures).as_secs());
        self.phase = Phase::Failing {
            failure,
            failures,
            retry_at,
        };
    }
}

#[derive(Debug)]
struct Pool {
    day: NaiveDate,
    used: u32,
    rate_limits: u32,
    retry_at: Option<Timestamp>,
}

#[derive(Debug, Default)]
struct State {
    slots: HashMap<String, Slot>,
    pools: BTreeMap<String, Pool>,
    halted: Option<String>,
    latency_ms: Option<f64>,
    last_as_of: Option<Timestamp>,
    asked: bool,
}

#[derive(Clone, Debug)]
struct Target {
    key: String,
    url: String,
    query: Vec<(String, String)>,
    pool: String,
    every: u64,
}

type Looked = (Option<String>, Option<ContractSpec>);

pub struct HttpLevelSource {
    spec: LevelSourceSpec,
    display_name: String,
    secret: Option<Secret>,
    client: Arc<dyn HttpClient>,
    clock: SharedClock,
    raw: Option<Arc<dyn RawSink>>,
    specs: Option<Arc<dyn SpecLookup>>,
    created_at: Timestamp,
    state: Mutex<State>,
    fetch: tokio::sync::Mutex<()>,
    looked_up: Mutex<HashMap<InstrumentId, Looked>>,
}

impl std::fmt::Debug for HttpLevelSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpLevelSource")
            .field("id", &self.spec.id)
            .field("secret", &self.secret)
            .finish_non_exhaustive()
    }
}

fn refused_by_vendor(
    st: &mut State,
    failure: &Failure,
    pool: &str,
    now: Timestamp,
    rate_limited: impl Fn(u32) -> Duration,
) {
    match failure {
        Failure::KeyRejected(w) => st.halted = Some(w.clone()),
        Failure::RateLimited(_) => {
            if let Some(p) = st.pools.get_mut(pool) {
                p.rate_limits += 1;
                p.retry_at = Some(after(now, rate_limited(p.rate_limits).as_secs()));
            }
        }
        Failure::Refused(_) | Failure::Failed(_) => {}
    }
}

fn status_words(vendor: &str, status: u16, message: Option<&str>) -> String {
    let said = message
        .map(|m| format!(": {}", m.trim().trim_end_matches('.')))
        .unwrap_or_default();
    match status {
        401 => {
            format!("{vendor} refused the key (401){said}. Change it in Settings › Connections.")
        }
        403 => format!("{vendor} says this account is not entitled to it (403){said}."),
        404 => format!("{vendor} has nothing there (404){said}."),
        429 => format!("{vendor} is rate limiting the requests (429){said}."),
        500..=599 => format!("{vendor} had a problem ({status}){said}."),
        _ => format!("{vendor} answered {status}{said}."),
    }
}

fn guess_root(instrument: &InstrumentId) -> Option<String> {
    instrument.venue()?;
    let s = instrument.symbol();
    let digits = s.chars().rev().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 2 || s.len() < digits + 2 {
        return None;
    }
    let body = &s[..s.len() - digits];
    let month = body.chars().last()?;
    "FGHJKMNQUVXZ"
        .contains(month)
        .then(|| body[..body.len() - 1].to_owned())
        .filter(|r| !r.is_empty())
}

impl HttpLevelSource {
    pub fn new(
        spec: LevelSourceSpec,
        secret: Option<Secret>,
        client: Arc<dyn HttpClient>,
        clock: SharedClock,
    ) -> Result<Self, Vec<String>> {
        let mut problems = spec.problems();
        if spec.auth.is_some() && secret.as_ref().is_none_or(|s| s.expose().is_empty()) {
            problems.push("the spec sends a secret: give it one".into());
        }
        if !problems.is_empty() {
            return Err(problems);
        }
        let now = clock.now();
        Ok(Self {
            display_name: spec.name.clone(),
            spec,
            secret,
            client,
            clock,
            raw: None,
            specs: None,
            created_at: now,
            state: Mutex::new(State::default()),
            fetch: tokio::sync::Mutex::new(()),
            looked_up: Mutex::new(HashMap::new()),
        })
    }

    fn spend(&self, pool: &str, cap: u32) -> Result<(), String> {
        let now = self.clock.now();
        let today = quota_day(&self.spec.limits, now);
        let mut st = self.state.lock();
        if st.halted.is_some() {
            return Err(st.halted.clone().unwrap_or_default());
        }
        let p = st.pools.entry(pool.to_owned()).or_insert(Pool {
            day: today,
            used: 0,
            rate_limits: 0,
            retry_at: None,
        });
        if p.day != today {
            p.day = today;
            p.used = 0;
        }
        if p.retry_at.is_some_and(|r| r > now) {
            return Err(format!(
                "{} is rate limiting {pool}; ask again later",
                self.spec.vendor
            ));
        }
        if p.used >= cap {
            return Err(format!(
                "Tessera's own daily cap of {cap} requests for {pool} on {} is spent; ask again after the reset",
                self.spec.vendor
            ));
        }
        p.used += 1;
        Ok(())
    }

    #[must_use]
    pub fn with_raw(mut self, sink: Option<Arc<dyn RawSink>>) -> Self {
        self.raw = sink;
        self
    }

    #[must_use]
    pub fn with_specs(mut self, lookup: Option<Arc<dyn SpecLookup>>) -> Self {
        self.specs = lookup;
        self
    }

    pub fn spec(&self) -> &LevelSourceSpec {
        &self.spec
    }

    pub fn every(&self) -> u64 {
        u64::from(self.spec.schedule.every_seconds)
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis(u64::from(self.spec.limits.timeout_ms.unwrap_or(8_000)))
    }

    fn cap(&self, pool: &str) -> Option<u32> {
        self.spec
            .limits
            .pools
            .get(pool)
            .copied()
            .or(self.spec.limits.daily_quota)
    }

    fn target(
        &self,
        path: &str,
        query: &BTreeMap<String, String>,
        vars: (&str, &str, &str),
        pool: &str,
        every: Option<u64>,
    ) -> Target {
        let (ticker, instrument, root) = vars;
        let path = fill(path, ticker, instrument, root);
        let query: Vec<(String, String)> = query
            .iter()
            .map(|(k, v)| (k.clone(), fill(v, ticker, instrument, root)))
            .collect();
        let shown = if query.is_empty() {
            path.clone()
        } else {
            let q: Vec<String> = query.iter().map(|(k, v)| format!("{k}={v}")).collect();
            format!("{path}?{}", q.join("&"))
        };
        Target {
            key: shown,
            url: format!("{}{path}", self.spec.base_url.trim().trim_end_matches('/')),
            query,
            pool: pool.to_owned(),
            every: every.unwrap_or_else(|| self.every()),
        }
    }

    fn request_target(&self, req: &RequestSpec, m: &InstrumentMapping, instrument: &str) -> Target {
        self.target(
            &req.path,
            &req.query,
            (&m.ticker, instrument, &m.root),
            req.pool(),
            req.every_seconds.map(u64::from),
        )
    }

    fn convert_target(
        &self,
        c: &ConvertRequest,
        m: &InstrumentMapping,
        instrument: &str,
    ) -> Target {
        self.target(
            &c.path,
            &c.query,
            (&m.ticker, instrument, &m.root),
            c.pool.as_deref().unwrap_or(super::spec::DEFAULT_POOL),
            c.every_seconds.map(u64::from),
        )
    }

    fn due(&self, st: &State, t: &Target, now: Timestamp) -> bool {
        if st.halted.is_some() {
            return false;
        }
        let slot = st.slots.get(&t.key);
        if let Some(s) = slot
            && s.waits(now)
        {
            return false;
        }
        if let Some(p) = st.pools.get(&t.pool) {
            if p.retry_at.is_some_and(|r| r > now) {
                return false;
            }
            let today = quota_day(&self.spec.limits, now);
            if p.day == today && self.cap(&t.pool).is_some_and(|cap| p.used >= cap) {
                return false;
            }
        }
        let received = slot.and_then(|s| s.received_at);
        let older_than = |secs: u64| received.is_none_or(|r| after(r, secs) <= now);
        let sched = &self.spec.schedule;
        if in_window(sched.window.as_ref(), now) {
            return older_than(t.every);
        }
        match sched.off_hours {
            OffHours::Never => false,
            OffHours::Once => {
                let s = slot;
                !s.is_some_and(|s| s.tried_off_hours)
                    && (received.is_none() || s.is_some_and(|s| s.in_window))
            }
            OffHours::Poll => older_than(u64::from(sched.off_hours_every_seconds.unwrap_or(900))),
        }
    }

    async fn ensure(&self, t: &Target) {
        if !self.due(&self.state.lock(), t, self.clock.now()) {
            return;
        }
        let _one_at_a_time = self.fetch.lock().await;
        let now = self.clock.now();
        {
            let mut st = self.state.lock();
            if !self.due(&st, t, now) {
                return;
            }
            let today = quota_day(&self.spec.limits, now);
            let pool = st.pools.entry(t.pool.clone()).or_insert(Pool {
                day: today,
                used: 0,
                rate_limits: 0,
                retry_at: None,
            });
            if pool.day != today {
                pool.day = today;
                pool.used = 0;
            }
            pool.used += 1;
            st.asked = true;
        }
        let req = self.http_request(t);
        let started = Instant::now();
        let result = self.client.get(req).await;
        let latency = started.elapsed().as_secs_f64() * 1000.0;
        let now = self.clock.now();
        let inside = in_window(self.spec.schedule.window.as_ref(), now);
        let vendor = self.spec.vendor.clone();
        let mut keep_raw = None;
        {
            let mut st = self.state.lock();
            st.latency_ms = Some(latency);
            let status = result.as_ref().ok().map(|r| r.status);
            st.slots.entry(t.key.clone()).or_default().status = status;
            let first = u64::from(self.spec.limits.backoff_seconds.unwrap_or(2)).max(1);
            let max = u64::from(self.spec.limits.backoff_max_seconds.unwrap_or(900));
            let doubling_from = |first: u64| {
                Backoff::new(
                    Duration::from_secs(first),
                    Duration::from_secs(max.max(first)),
                )
            };
            let failure = match result {
                Ok(resp) if (200..300).contains(&resp.status) => {
                    match serde_json::from_slice::<Value>(&resp.body) {
                        Ok(v) => {
                            if let Some(p) = st.pools.get_mut(&t.pool) {
                                p.rate_limits = 0;
                            }
                            let slot = st.slots.entry(t.key.clone()).or_default();
                            slot.body = Some(Arc::new(v));
                            slot.received_at = Some(now);
                            slot.in_window = inside;
                            slot.tried_off_hours = !inside;
                            slot.phase = Phase::Fresh;
                            slot.raw_blob = None;
                            if self.spec.record_raw {
                                keep_raw = Some(resp.body);
                            }
                            None
                        }
                        Err(_) => Some(Failure::Failed(format!(
                            "{vendor} sent something that is not JSON."
                        ))),
                    }
                }
                Ok(resp) => {
                    let message = serde_json::from_slice::<Value>(&resp.body)
                        .ok()
                        .and_then(|v| {
                            let sel = self.spec.limits.error_message.as_deref().unwrap_or("error");
                            select(sel, &v)
                                .map(text_of)
                                .filter(|s| !s.trim().is_empty())
                        });
                    let words = status_words(&vendor, resp.status, message.as_deref());
                    Some(match resp.status {
                        401 => Failure::KeyRejected(words),
                        400 | 403 => Failure::Refused(words),
                        429 => Failure::RateLimited(words),
                        _ => Failure::Failed(words),
                    })
                }
                Err(HttpError::Timeout) => Some(Failure::Failed(format!(
                    "{vendor} did not answer within {} s.",
                    self.timeout().as_secs_f64()
                ))),
                Err(HttpError::Transport(why)) => {
                    Some(Failure::Failed(format!("Could not reach {vendor}: {why}.")))
                }
            };
            if let Some(f) = failure {
                refused_by_vendor(&mut st, &f, &t.pool, now, |n| {
                    doubling_from(first.max(60)).delay(n)
                });
                tracing::warn!(source = %self.spec.id, request = %t.key, why = f.words(), "levels source request failed");
                let slot = st.slots.entry(t.key.clone()).or_default();
                if !inside {
                    slot.tried_off_hours = true;
                }
                let backoff = match &f {
                    Failure::Refused(_) => REFUSED,
                    Failure::RateLimited(_) => Backoff::new(Duration::ZERO, Duration::ZERO),
                    _ => doubling_from(first),
                };
                slot.failed(f, now, |n| backoff.delay(n));
            }
        }
        if let (Some(bytes), Some(sink)) = (keep_raw, &self.raw) {
            let sink = Arc::clone(sink);
            let source = format!("{}:{}", self.spec.id, t.key);
            let sha =
                tokio::task::spawn_blocking(move || sink.put(&bytes, "application/json", &source))
                    .await
                    .ok()
                    .flatten();
            if let Some(slot) = self.state.lock().slots.get_mut(&t.key) {
                slot.raw_blob = sha;
            }
        }
    }

    fn http_request(&self, t: &Target) -> HttpRequest {
        let mut headers: Vec<(String, String)> = self
            .spec
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut query = t.query.clone();
        if let (Some(a), Some(secret)) = (&self.spec.auth, &self.secret) {
            let value = format!("{}{}", a.prefix, secret.expose());
            match a.placement {
                AuthPlacement::Header => headers.push((a.name.trim().to_owned(), value)),
                AuthPlacement::Query => query.push((a.name.trim().to_owned(), value)),
            }
        }
        HttpRequest {
            url: t.url.clone(),
            query,
            headers,
            timeout: self.timeout(),
        }
    }

    async fn lookup(&self, instrument: &InstrumentId) -> Looked {
        if let Some(hit) = self.looked_up.lock().get(instrument) {
            return hit.clone();
        }
        let spec = match &self.specs {
            Some(l) => l.contract_spec(instrument).await,
            None => None,
        };
        let root = spec
            .as_ref()
            .and_then(|s| s.root.clone())
            .or_else(|| guess_root(instrument));
        if spec.is_some() {
            self.looked_up
                .lock()
                .insert(instrument.clone(), (root.clone(), spec.clone()));
        }
        (root, spec)
    }

    async fn conversion_for(
        &self,
        m: &InstrumentMapping,
        instrument: &InstrumentId,
    ) -> Result<Option<ConversionRecord>, String> {
        let Some(c) = &m.convert else {
            return Ok(None);
        };
        let basis = m.basis.clone().unwrap_or_else(|| m.ticker.clone());
        let id = format!(
            "{}-{}-{}",
            self.spec.id,
            basis.to_ascii_lowercase(),
            instrument.symbol().to_ascii_lowercase()
        );
        let d = |x: f64| Decimal::from_f64(x).unwrap_or_default();
        let fixed = |mult: Decimal, add: Decimal, method: &str| {
            ConversionRecord::model(
                &id,
                &basis,
                instrument.clone(),
                mult,
                add,
                method,
                &self.spec.id,
                self.created_at,
            )
            .map(Some)
            .map_err(|e| e.to_string())
        };
        match c {
            ConvertSpec::Ratio { ratio } => fixed(d(*ratio), Decimal::ZERO, "ratio"),
            ConvertSpec::Additive { additive } => fixed(Decimal::ONE, d(*additive), "additive"),
            ConvertSpec::Affine {
                multiplier,
                additive,
            } => fixed(d(*multiplier), d(*additive), "affine"),
            ConvertSpec::Request(r) => {
                let t = self.convert_target(r, m, instrument.symbol());
                self.ensure(&t).await;
                let st = self.state.lock();
                let slot = st.slots.get(&t.key);
                let Some(body) = slot.and_then(|s| s.body.clone()) else {
                    let why = slot
                        .and_then(|s| s.failure().map(|f| f.words().to_owned()))
                        .unwrap_or_else(|| "not asked yet".into());
                    return Err(why);
                };
                terms(
                    r,
                    &body,
                    &id,
                    &basis,
                    instrument,
                    &self.spec.id,
                    slot.and_then(|s| s.received_at).unwrap_or(self.created_at),
                )
                .map(Some)
            }
        }
    }

    fn why_empty(&self, keys: &[String]) -> String {
        let st = self.state.lock();
        if let Some(h) = &st.halted {
            return h.clone();
        }
        for k in keys {
            if let Some(f) = st.slots.get(k).and_then(Slot::failure) {
                return f.words().to_owned();
            }
        }
        if let Some((pool, _)) = st.pools.iter().find(|(name, p)| {
            self.cap(name).is_some_and(|c| p.used >= c)
                && p.day == quota_day(&self.spec.limits, self.clock.now())
        }) {
            return format!(
                "Tessera's own daily cap for {} on {} is spent; it asks again after the reset.",
                pool, self.spec.vendor
            );
        }
        match &self.spec.schedule.window {
            Some(w) if w.session == Some(SessionName::UsRth) => {
                format!(
                    "No levels from {} yet: it is asked during US market hours.",
                    self.spec.vendor
                )
            }
            Some(_) => format!(
                "No levels from {} yet: it is asked inside its window.",
                self.spec.vendor
            ),
            None => format!("No levels from {} yet.", self.spec.vendor),
        }
    }

    pub fn calls_today(&self) -> Vec<PoolCalls> {
        let today = quota_day(&self.spec.limits, self.clock.now());
        let st = self.state.lock();
        let mut pools: Vec<String> = self
            .spec
            .requests
            .iter()
            .map(|r| r.pool().to_owned())
            .chain(self.spec.instruments.iter().filter_map(|m| {
                match &m.convert {
                    Some(ConvertSpec::Request(r)) => Some(
                        r.pool
                            .clone()
                            .unwrap_or_else(|| super::spec::DEFAULT_POOL.into()),
                    ),
                    _ => None,
                }
            }))
            .collect();
        pools.extend(self.spec.history.iter().map(|h| h.pool().to_owned()));
        pools.sort();
        pools.dedup();
        pools
            .into_iter()
            .map(|pool| PoolCalls {
                used: st
                    .pools
                    .get(&pool)
                    .filter(|p| p.day == today)
                    .map_or(0, |p| p.used),
                cap: match &self.spec.history {
                    Some(h) if h.pool() == pool => Some(h.daily_cap),
                    _ => self.cap(&pool),
                },
                pool,
            })
            .collect()
    }

    pub fn info(&self) -> LevelSourceInfo {
        let mut packages: Vec<DeclaredPackage> = Vec::new();
        for r in &self.spec.requests {
            let key = self.spec.package_key(&r.package);
            let idx = match packages.iter().position(|p| p.key == key) {
                Some(i) => i,
                None => {
                    packages.push(DeclaredPackage {
                        key: key.clone(),
                        vendor: self.spec.vendor.clone(),
                        package: r.package.clone(),
                        levels: Vec::new(),
                        open: false,
                    });
                    packages.len() - 1
                }
            };
            let group = r
                .group
                .clone()
                .unwrap_or_else(|| parse::DEFAULT_GROUP.into());
            let p = &mut packages[idx];
            p.open |= r.items.is_some();
            for f in &r.fields {
                p.levels.push(DeclaredLevel {
                    key: format!("{key}.{}", f.field),
                    field: f.field.clone(),
                    label: f.label.clone().unwrap_or_else(|| f.field.clone()),
                    short: f.short.clone(),
                    group: f.group.clone().unwrap_or_else(|| group.clone()),
                    endpoint: Some(r.endpoint()),
                    description: f.description.clone(),
                    concept: f.concept.clone(),
                    style: f.style.clone(),
                });
            }
        }
        LevelSourceInfo {
            provider_id: self.spec.id.clone(),
            display_name: self.display_name.clone(),
            vendor: self.spec.vendor.clone(),
            packages,
            instruments: self
                .spec
                .instruments
                .iter()
                .map(|m| m.root.clone())
                .collect(),
            schedule: Some(schedule_words(
                self.every(),
                self.spec.schedule.window.as_ref(),
            )),
            calls_today: self.calls_today(),
            spec: Some(self.spec.clone()),
            editable: true,
            sends_secret: self.spec.auth.is_some(),
            history: self.spec.history.as_ref().map(|h| HistoryReach {
                days_back: h.days_back,
                pool: h.pool().to_owned(),
                daily_cap: h.daily_cap,
                tickers: self.spec.history_tickers(),
            }),
            health: self.health(),
        }
    }
}

fn terms(
    r: &ConvertRequest,
    body: &Value,
    id: &str,
    basis: &str,
    to: &InstrumentId,
    source: &str,
    as_of: Timestamp,
) -> Result<ConversionRecord, String> {
    let mult = select(&r.multiplier, body)
        .and_then(number)
        .ok_or_else(|| format!("no multiplier at {} in the conversion", r.multiplier))?;
    let add = match &r.additive {
        Some(s) => select(s, body)
            .and_then(number)
            .ok_or_else(|| format!("no additive at {s} in the conversion"))?,
        None => Decimal::ZERO,
    };
    let contract = r
        .contract
        .as_deref()
        .and_then(|s| select(s, body))
        .map(text_of)
        .filter(|c| !c.is_empty());
    ConversionRecord::model(
        id,
        basis,
        to.clone(),
        mult,
        add,
        r.method.as_deref().unwrap_or("vendor"),
        source,
        as_of,
    )
    .map(|c| c.with_contract(contract))
    .map_err(|e| e.to_string())
}

fn assemble(
    spec: &LevelSourceSpec,
    bodies: &[(&RequestSpec, Arc<Value>, Timestamp)],
    basis: &str,
    native: &InstrumentId,
) -> (Vec<Level>, Option<Timestamp>, Vec<String>) {
    let mut levels = Vec::new();
    let mut latest: Option<Timestamp> = None;
    let mut problems = Vec::new();
    for (req, body, received) in bodies {
        let Parsed {
            as_of,
            values,
            problems: p,
            ..
        } = parse::parse(req, body);
        let at = as_of.unwrap_or(*received);
        latest = Some(latest.map_or(at, |l| l.max(at)));
        problems.extend(p);
        levels.extend(
            values
                .iter()
                .map(|v| to_level(&spec.id, &spec.vendor, basis, native, at, v)),
        );
    }
    (levels, latest, problems)
}

#[async_trait]
impl IntelligenceProvider for HttpLevelSource {
    fn id(&self) -> &str {
        &self.spec.id
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn capabilities(&self) -> IntelCapabilities {
        let mut packages: Vec<String> = Vec::new();
        for r in &self.spec.requests {
            if !packages.contains(&r.package) {
                packages.push(r.package.clone());
            }
        }
        IntelCapabilities {
            vendor: self.spec.vendor.clone(),
            packages,
            levels: true,
            profiles: false,
            conversions: self.spec.instruments.iter().any(|m| m.convert.is_some()),
            history: self.spec.history.is_some(),
            realtime: false,
            rth_only: self
                .spec
                .schedule
                .window
                .as_ref()
                .is_some_and(|w| w.session == Some(SessionName::UsRth)),
        }
    }

    fn health(&self) -> ProviderHealth {
        let now = self.clock.now();
        let st = self.state.lock();
        let rate_limited = st
            .pools
            .values()
            .filter_map(|p| p.retry_at.filter(|r| *r > now))
            .max();
        let any_body = st.slots.values().any(|s| s.body.is_some());
        let failing = st
            .slots
            .values()
            .find_map(|s| s.failure().map(|f| f.words().to_owned()));
        let (status, message) = if let Some(h) = &st.halted {
            (HealthStatus::Down, Some(h.clone()))
        } else if let Some(until) = rate_limited {
            (
                HealthStatus::Degraded,
                Some(format!(
                    "{} is rate limiting the requests; asking again in {} min.",
                    self.spec.vendor,
                    ((until.0 - now.0 + NANOS_PER_MINUTE - 1) / NANOS_PER_MINUTE).max(1)
                )),
            )
        } else if !st.asked {
            (
                HealthStatus::Ok,
                Some("Asked when a chart shows an instrument it covers.".into()),
            )
        } else if !any_body {
            (
                HealthStatus::Down,
                failing.or_else(|| Some("No answer yet.".into())),
            )
        } else if let Some(f) = failing {
            (HealthStatus::Degraded, Some(f))
        } else if !in_window(self.spec.schedule.window.as_ref(), now) {
            (
                HealthStatus::Ok,
                st.last_as_of
                    .map(|_| "Market closed; showing the last levels it sent.".to_owned()),
            )
        } else {
            (HealthStatus::Ok, None)
        };
        ProviderHealth {
            provider_id: self.spec.id.clone(),
            kind: ProviderKind::Intelligence,
            display_name: self.display_name.clone(),
            status,
            latency_ms: st
                .latency_ms
                .filter(|_| status == HealthStatus::Ok && message.is_none()),
            last_message_at: st.last_as_of,
            message,
            connection: None,
            accounts: None,
            checked_at: now,
        }
    }

    async fn levels(
        &self,
        instrument: &InstrumentId,
        as_of: Option<Timestamp>,
    ) -> Result<LevelSnapshot, IntelError> {
        let (root, contract) = self.lookup(instrument).await;
        let m = self
            .spec
            .mapping(root.as_deref(), instrument.symbol())
            .ok_or_else(|| IntelError::NotCovered(instrument.to_string()))?
            .clone();
        let targets: Vec<(&RequestSpec, Target)> = self
            .spec
            .requests
            .iter()
            .map(|r| (r, self.request_target(r, &m, instrument.symbol())))
            .collect();
        for (_, t) in &targets {
            self.ensure(t).await;
        }
        let conversion = self.conversion_for(&m, instrument).await;
        let (bodies, blob) = {
            let st = self.state.lock();
            let bodies: Vec<(&RequestSpec, Arc<Value>, Timestamp)> = targets
                .iter()
                .filter_map(|(r, t)| {
                    let s = st.slots.get(&t.key)?;
                    Some((*r, s.body.clone()?, s.received_at?))
                })
                .collect();
            let blob = targets
                .iter()
                .find_map(|(_, t)| st.slots.get(&t.key)?.raw_blob.clone());
            (bodies, blob)
        };
        if bodies.is_empty() {
            let keys: Vec<String> = targets.iter().map(|(_, t)| t.key.clone()).collect();
            return Err(IntelError::Unavailable(self.why_empty(&keys)));
        }
        let basis = m.basis.clone().unwrap_or_else(|| m.ticker.clone());
        let native_id = if m.convert.is_some() {
            InstrumentId::new(&basis).unwrap_or_else(|_| instrument.clone())
        } else {
            instrument.clone()
        };
        let (mut levels, snapshot_at, _) = assemble(&self.spec, &bodies, &basis, &native_id);
        let snapshot_at = snapshot_at.unwrap_or(self.created_at);
        {
            let mut st = self.state.lock();
            st.last_as_of = Some(st.last_as_of.map_or(snapshot_at, |t| t.max(snapshot_at)));
        }
        if let Some(t) = as_of
            && t < snapshot_at
        {
            return Err(IntelError::NoSnapshot(t));
        }
        if m.convert.is_some() {
            levels = match conversion {
                Ok(Some(rec)) => levels
                    .iter()
                    .map(|l| parse::convert(l, &rec, contract.as_ref()))
                    .collect(),
                Ok(None) => levels,
                Err(why) => levels
                    .into_iter()
                    .map(|mut l| {
                        l.instrument = instrument.clone();
                        l.native_price = l.price.take();
                        if l.unavailable_reason.is_none() {
                            l.unavailable_reason = Some(format!(
                                "no {basis} → {} conversion yet: {why}",
                                instrument.symbol()
                            ));
                        }
                        l
                    })
                    .collect(),
            };
        }
        Ok(LevelSnapshot {
            instrument: instrument.clone(),
            as_of: snapshot_at,
            levels,
            raw_blob: blob,
        })
    }

    async fn conversion(
        &self,
        from: &str,
        to: &InstrumentId,
    ) -> Result<ConversionRecord, IntelError> {
        let (root, _) = self.lookup(to).await;
        let m = self
            .spec
            .mapping(root.as_deref(), to.symbol())
            .filter(|m| {
                m.basis
                    .as_deref()
                    .unwrap_or(&m.ticker)
                    .eq_ignore_ascii_case(from)
            })
            .ok_or_else(|| IntelError::NotCovered(format!("{from} → {to}")))?
            .clone();
        match self.conversion_for(&m, to).await {
            Ok(Some(rec)) => Ok(rec),
            Ok(None) => Err(IntelError::NotCovered(format!(
                "{from} → {to}: the prices are already {to}'s"
            ))),
            Err(why) => Err(IntelError::Unavailable(why)),
        }
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_secs(self.every().clamp(1, 15))
    }

    fn level_source(&self) -> Option<LevelSourceInfo> {
        Some(self.info())
    }

    async fn history_file(&self, request: &HistoryRequest) -> Result<HistoryFile, IntelError> {
        let Some(h) = &self.spec.history else {
            return Err(IntelError::Unsupported(format!(
                "{}'s spec here declares no history API",
                self.spec.vendor
            )));
        };
        let req = self
            .spec
            .requests
            .iter()
            .find(|r| r.package.eq_ignore_ascii_case(&request.package))
            .ok_or_else(|| {
                IntelError::NotCovered(format!(
                    "{} has no {} package here",
                    self.spec.vendor, request.package
                ))
            })?;
        let endpoint = req.endpoint();
        let pkg = req.package.to_ascii_lowercase();
        let ticker = request.ticker.trim().to_ascii_uppercase();
        let date = request.date.format("%Y-%m-%d").to_string();
        let path = h
            .path
            .replace("{ticker}", &ticker)
            .replace("{package}", &pkg)
            .replace("{endpoint}", &endpoint)
            .replace("{request}", &req.id)
            .replace("{date}", &date);
        let t = Target {
            key: path.clone(),
            url: format!("{}{path}", self.spec.base_url.trim().trim_end_matches('/')),
            query: h.query.clone().into_iter().collect(),
            pool: h.pool().to_owned(),
            every: 0,
        };
        self.spend(h.pool(), h.daily_cap)
            .map_err(IntelError::Unavailable)?;
        let mut asked = self.http_request(&t);
        asked.timeout = Duration::from_secs(60);
        let vendor = self.spec.vendor.clone();
        let fail = |e: HttpError| match e {
            HttpError::Timeout => {
                IntelError::Unavailable(format!("{vendor} did not answer in time"))
            }
            HttpError::Transport(why) => {
                IntelError::Unavailable(format!("could not reach {vendor}: {why}"))
            }
        };
        let resp = self.client.get(asked).await.map_err(fail)?;
        if !(200..300).contains(&resp.status) {
            let message = serde_json::from_slice::<Value>(&resp.body)
                .ok()
                .and_then(|v| select("error", &v).map(text_of));
            let words = status_words(&vendor, resp.status, message.as_deref());
            let now = self.clock.now();
            let refusal = match resp.status {
                401 => Some(Failure::KeyRejected(words.clone())),
                429 => Some(Failure::RateLimited(words.clone())),
                _ => None,
            };
            if let Some(f) = refusal {
                refused_by_vendor(&mut self.state.lock(), &f, h.pool(), now, |n| {
                    RATE_LIMITED.delay(n)
                });
            }
            return Err(match resp.status {
                401 | 403 => IntelError::Unsupported(words),
                404 => IntelError::NotCovered(format!(
                    "{vendor} has no {ticker} {endpoint} for {date}: not a trading day, or older than it keeps ({} days)",
                    h.days_back
                )),
                _ => IntelError::Unavailable(words),
            });
        }
        let bytes = match &h.link {
            None => resp.body,
            Some(sel) => {
                let v: Value = serde_json::from_slice(&resp.body).map_err(|_| {
                    IntelError::Unavailable(format!("{vendor} sent no download link"))
                })?;
                let link = select(sel, &v)
                    .map(text_of)
                    .filter(|u| u.starts_with("https://"))
                    .ok_or_else(|| {
                        IntelError::Unavailable(format!("{vendor} sent no https download link"))
                    })?;
                // the signed link's signature covers its query, so it is sent exactly as received
                let (url, query) = (link, Vec::new());
                let got = self
                    .client
                    .get(HttpRequest {
                        url,
                        query,
                        headers: vec![(
                            "User-Agent".into(),
                            self.spec
                                .headers
                                .get("User-Agent")
                                .cloned()
                                .unwrap_or_else(|| "Tessera".into()),
                        )],
                        timeout: Duration::from_secs(300),
                    })
                    .await
                    .map_err(fail)?;
                if !(200..300).contains(&got.status) {
                    return Err(IntelError::Unavailable(format!(
                        "the download of {ticker} {endpoint} {date} answered {}",
                        got.status
                    )));
                }
                got.body
            }
        };
        Ok(HistoryFile {
            name: format!("{date}_{ticker}_{pkg}_{}.json.gz", req.id),
            endpoint,
            bytes,
        })
    }
}

pub async fn test_spec(
    spec: &LevelSourceSpec,
    secret: Option<&str>,
    client: Option<Arc<dyn HttpClient>>,
    clock: SharedClock,
    samples: &BTreeMap<String, Value>,
    instrument: Option<&str>,
) -> TestSourceOutput {
    let mut problems = spec.problems();
    let mut out = TestSourceOutput {
        ok: false,
        problems: Vec::new(),
        requests: Vec::new(),
        conversion: None,
    };
    if !problems.is_empty() {
        out.problems = problems;
        return out;
    }
    let m = match instrument {
        Some(i) => spec.mapping(Some(i), i),
        None => spec.instruments.first(),
    };
    let Some(m) = m.cloned() else {
        out.problems = vec![format!(
            "{} is not mapped to a ticker",
            instrument.unwrap_or("The instrument")
        )];
        return out;
    };
    let live = client.unwrap_or_else(|| Arc::new(NoNetwork));
    let src = match HttpLevelSource::new(
        LevelSourceSpec {
            schedule: super::spec::ScheduleSpec {
                window: None,
                ..spec.schedule.clone()
            },
            auth: spec.auth.clone().filter(|_| secret.is_some()),
            record_raw: false,
            ..spec.clone()
        },
        secret.map(Secret::new),
        live,
        clock,
    ) {
        Ok(s) => s,
        Err(p) => {
            out.problems = p;
            return out;
        }
    };
    let instrument_symbol = m.root.to_ascii_uppercase();
    let basis = m.basis.clone().unwrap_or_else(|| m.ticker.clone());
    let native =
        InstrumentId::new(&basis).unwrap_or_else(|_| InstrumentId::from_parts("SAMPLE", None));
    let mut any_price = false;
    let mut all_read = true;
    for r in &spec.requests {
        let t = src.request_target(r, &m, &instrument_symbol);
        let (body, url, status, message) = match samples.get(&r.id) {
            Some(b) => (Some(b.clone()), "sample".to_owned(), None, None),
            None => {
                src.ensure(&t).await;
                let st = src.state.lock();
                let slot = st.slots.get(&t.key);
                let failure = slot.and_then(|s| s.failure().map(|f| f.words().to_owned()));
                (
                    slot.and_then(|s| s.body.as_deref().cloned()),
                    t.key.clone(),
                    slot.and_then(|s| s.status),
                    failure.or(st.halted.clone()),
                )
            }
        };
        let mut tested = TestedRequest {
            id: r.id.clone(),
            url,
            status,
            message,
            as_of: None,
            levels: Vec::new(),
        };
        match body {
            Some(b) => {
                let p = parse::parse(r, &b);
                tested.as_of = p.as_of;
                let at = p.as_of.unwrap_or_else(Timestamp::now);
                tested.levels = p
                    .values
                    .iter()
                    .map(|v| to_level(&spec.id, &spec.vendor, &basis, &native, at, v))
                    .collect();
                any_price |= tested.levels.iter().any(|l| l.price.is_some());
                problems.extend(p.problems);
            }
            None => {
                all_read = false;
                if tested.message.is_none() {
                    tested.message = Some("No sample and no live answer.".into());
                }
            }
        }
        out.requests.push(tested);
    }
    if let Some(ConvertSpec::Request(c)) = &m.convert {
        let to = InstrumentId::from_parts(&instrument_symbol, None);
        let t = src.convert_target(c, &m, &instrument_symbol);
        let body = match samples.get("convert") {
            Some(b) => Some(b.clone()),
            None => {
                src.ensure(&t).await;
                src.state
                    .lock()
                    .slots
                    .get(&t.key)
                    .and_then(|s| s.body.as_deref().cloned())
            }
        };
        match body {
            Some(b) => match terms(c, &b, "test", &basis, &to, &spec.id, Timestamp::now()) {
                Ok(rec) => out.conversion = Some(rec),
                Err(why) => problems.push(format!("convert: {why}")),
            },
            None => problems.push(format!("convert: no answer for {}", t.key)),
        }
    } else if m.convert.is_some() {
        out.conversion = src
            .conversion_for(&m, &InstrumentId::from_parts(&instrument_symbol, None))
            .await
            .ok()
            .flatten();
    }
    out.ok = all_read && any_price;
    out.problems = problems;
    out
}

struct NoNetwork;

#[async_trait]
impl HttpClient for NoNetwork {
    async fn get(&self, _req: HttpRequest) -> Result<HttpResponse, HttpError> {
        Err(HttpError::Transport(
            "a live request is not available here; paste a sample response".into(),
        ))
    }
}

use super::http::HttpResponse;

#[cfg(test)]
mod tests;
