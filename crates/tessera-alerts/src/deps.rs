use async_trait::async_trait;
use serde_json::{Map, Value};
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_host::Keepalive;
use tessera_protocol::drawings::Drawing;
use tessera_protocol::indicators::IndicatorLineObject;
use tessera_protocol::topics::LevelsUpdate;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IndicatorReading {
    pub time: Vec<Timestamp>,
    pub plots: Vec<(String, Vec<Option<f64>>)>,
    pub lines: Vec<IndicatorLineObject>,
}

impl IndicatorReading {
    pub fn plot_at(&self, plot: &str, bar: Option<Timestamp>) -> Option<f64> {
        let (_, values) = self.plots.iter().find(|(k, _)| k == plot)?;
        let i = match bar {
            Some(b) => self.time.iter().rposition(|t| *t == b)?,
            None => self.time.len().checked_sub(1)?,
        };
        values.get(i).copied().flatten()
    }
}

#[async_trait]
pub trait AlertSources: Send + Sync + 'static {
    async fn follow_levels(&self, instrument: &InstrumentId)
    -> (Vec<LevelsUpdate>, Vec<Keepalive>);

    async fn drawing(&self, id: &str) -> Option<Drawing>;

    async fn indicator(
        &self,
        indicator: &str,
        inputs: &Map<String, Value>,
        instrument: &InstrumentId,
        tf: Timeframe,
    ) -> Result<IndicatorReading, String>;
}

#[async_trait]
pub trait WebhookVault: Send + Sync + 'static {
    async fn get(&self) -> Result<Option<String>, String>;
    async fn set(&self, url: Option<&str>) -> Result<(), String>;
}

#[async_trait]
pub trait WebhookSender: Send + Sync + 'static {
    async fn post(&self, url: &str, body: &Value) -> Result<(), String>;
}

#[async_trait]
pub trait AlertAnalyst: Send + Sync + 'static {
    async fn ask(&self, session: &str, text: &str) -> Result<(), String>;

    fn wakes_itself(&self, _session: &str) -> bool {
        false
    }
}
