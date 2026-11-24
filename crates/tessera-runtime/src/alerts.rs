use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tessera_alerts::{AlertAnalyst, AlertDelivery, AlertSources, IndicatorReading, WebhookVault};
use tessera_core::accounts::CredentialRef;
use tessera_core::ids::SessionId;
use tessera_core::{InstrumentId, Timeframe};
use tessera_host::Keepalive;
use tessera_protocol::drawings::Drawing;
use tessera_protocol::topics::{LevelsUpdate, names};
use tessera_store::Store;

use crate::layout::LayoutService;
use crate::modules::core::StateCell;
use crate::secrets::Secrets;
use crate::settings::SettingsService;

pub const DEFAULT_DELIVERY_KEY: &str = "alerts.defaultDelivery";
const REF_COLLECTION: &str = "alert_settings";
const REF_ID: &str = "discord-webhook";
const SECRET_KEY: &str = "tessera.alerts.discord-webhook";
const INDICATOR_BARS: u32 = 1500;

pub struct RuntimeSources {
    state: StateCell,
    layouts: Arc<LayoutService>,
    indicators: Arc<tessera_indicators::IndicatorsService>,
}

impl RuntimeSources {
    pub(crate) fn new(
        state: StateCell,
        layouts: Arc<LayoutService>,
        indicators: Arc<tessera_indicators::IndicatorsService>,
    ) -> Self {
        Self {
            state,
            layouts,
            indicators,
        }
    }
}

#[async_trait]
impl AlertSources for RuntimeSources {
    async fn follow_levels(
        &self,
        instrument: &InstrumentId,
    ) -> (Vec<LevelsUpdate>, Vec<Keepalive>) {
        let Some(state) = self.state.get().and_then(std::sync::Weak::upgrade) else {
            return (Vec::new(), Vec::new());
        };
        let mut now = Vec::new();
        let mut guards = Vec::new();
        for topic in [names::INTEL_LEVELS, tessera_alerts::engine::CONCEPTS_LEVELS] {
            let Some(handler) = state.topics.get(topic) else {
                continue;
            };
            match handler.subscribe(json!({ "instrument": instrument })).await {
                Ok(sub) => {
                    now.extend(
                        sub.snapshot
                            .iter()
                            .filter_map(|raw| serde_json::from_str::<LevelsUpdate>(raw.get()).ok()),
                    );
                    guards.extend(sub.keepalive);
                }
                Err(e) => {
                    tracing::debug!(%instrument, topic, error = %e.message, "alerts: no levels")
                }
            }
        }
        (now, guards)
    }

    async fn drawing(&self, id: &str) -> Option<Drawing> {
        self.layouts.drawing(id)
    }

    async fn indicator(
        &self,
        indicator: &str,
        inputs: &Map<String, Value>,
        instrument: &InstrumentId,
        tf: Timeframe,
    ) -> Result<IndicatorReading, String> {
        let s = self
            .indicators
            .compute(tessera_indicators::io::ComputeInput {
                indicator: indicator.to_owned(),
                version: None,
                inputs: Some(inputs.clone()),
                instrument: instrument.as_str().to_owned(),
                tf,
                from: None,
                to: None,
                limit: Some(INDICATOR_BARS),
                tail: None,
                session: None,
            })
            .await
            .map_err(|e| format!("{indicator}: {}", e.message))?;
        Ok(IndicatorReading {
            time: s.time,
            plots: s.plots.into_iter().map(|p| (p.key, p.values)).collect(),
            lines: s.objects.lines,
        })
    }
}

pub struct SecretVault {
    secrets: Secrets,
    store: Store,
    cached: Mutex<Option<Option<String>>>,
}

impl SecretVault {
    pub(crate) fn new(secrets: Secrets, store: Store) -> Self {
        Self {
            secrets,
            store,
            cached: Mutex::new(None),
        }
    }

    async fn reference(&self) -> Result<Option<CredentialRef>, String> {
        let store = self.store.clone();
        let doc = tokio::task::spawn_blocking(move || store.documents(REF_COLLECTION).get(REF_ID))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok(doc.and_then(|d| serde_json::from_value(d.body).ok()))
    }

    pub(crate) async fn note_kept(&self) {
        if let Ok(Some(r)) = self.reference().await {
            self.secrets.note(&r);
        }
    }

    async fn keep_reference(&self, r: Option<&CredentialRef>) -> Result<(), String> {
        let (store, body) = (self.store.clone(), r.map(|r| json!(r)));
        tokio::task::spawn_blocking(move || {
            let docs = store.documents(REF_COLLECTION);
            match body {
                Some(b) => docs.put(REF_ID, None, &b, tessera_core::Timestamp::now()),
                None => docs.delete(REF_ID).map(|_| ()),
            }
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    }
}

fn redact(url: &str) {
    let r = crate::logging::Redactor::global();
    r.register(url);
    if let Some(token) = url.trim_end_matches('/').rsplit('/').next() {
        r.register(token);
    }
}

#[async_trait]
impl WebhookVault for SecretVault {
    async fn get(&self) -> Result<Option<String>, String> {
        if let Some(c) = self.cached.lock().clone() {
            return Ok(c);
        }
        let url = match self.reference().await? {
            Some(r) => self.secrets.get(&r).await.map_err(|e| e.to_string())?,
            None => None,
        };
        if let Some(u) = &url {
            redact(u);
        }
        *self.cached.lock() = Some(url.clone());
        Ok(url)
    }

    async fn set(&self, url: Option<&str>) -> Result<(), String> {
        match url {
            Some(u) => {
                redact(u);
                let r = self
                    .secrets
                    .put(SECRET_KEY, u)
                    .await
                    .map_err(|e| e.to_string())?;
                self.keep_reference(Some(&r)).await?;
            }
            None => {
                if let Some(r) = self.reference().await? {
                    self.secrets
                        .delete_everywhere(&r)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                self.keep_reference(None).await?;
            }
        }
        *self.cached.lock() = Some(url.map(str::to_owned));
        Ok(())
    }
}

pub struct Analyst {
    pub agents: Arc<tessera_agent::AgentService>,
    pub sessions: Option<Arc<crate::session_runner::SessionRunner>>,
}

#[async_trait]
impl AlertAnalyst for Analyst {
    async fn ask(&self, session: &str, text: &str) -> Result<(), String> {
        if let Some(runner) = self.sessions.as_ref().filter(|r| r.wakes_itself(session)) {
            return runner.wake(session, text).await;
        }
        self.agents
            .send(&SessionId::new(session), text, None, None)
            .await
            .map(|_| ())
            .map_err(|e| e.message)
    }

    fn wakes_itself(&self, session: &str) -> bool {
        self.sessions
            .as_ref()
            .is_some_and(|r| r.wakes_itself(session))
    }
}

pub fn default_delivery(settings: &SettingsService) -> AlertDelivery {
    settings
        .value(DEFAULT_DELIVERY_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}
