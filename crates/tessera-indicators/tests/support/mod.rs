#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value};
use tessera_core::Timeframe;
use tessera_host::{BusEvent, EventBus, TopicHandler, TopicKey};
use tessera_indicators::io::{PreviewInput, SeriesUpdate};
use tessera_indicators::{IndicatorsModule, SERIES_TOPIC};

pub fn f64s(values: &str) -> Vec<f64> {
    let bytes = STANDARD.decode(values).unwrap();
    bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|b| f64::from_le_bytes(*b))
        .collect()
}

pub fn times_ms(u: &SeriesUpdate) -> Vec<i64> {
    f64s(&u.time).into_iter().map(|t| t as i64).collect()
}

pub fn column(u: &SeriesUpdate, key: &str) -> Vec<f64> {
    let n = times_ms(u).len();
    let c = u
        .columns
        .iter()
        .find(|c| c.key == key)
        .unwrap_or_else(|| panic!("no column {key}"));
    c.values.as_deref().map_or_else(|| vec![f64::NAN; n], f64s)
}

pub fn series(module: &IndicatorsModule) -> Arc<dyn TopicHandler> {
    module
        .topic_handlers()
        .into_iter()
        .find(|t| t.name() == SERIES_TOPIC)
        .unwrap()
}

pub async fn next(
    rx: &mut tokio::sync::broadcast::Receiver<Arc<BusEvent>>,
    key: &str,
) -> SeriesUpdate {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(60), rx.recv())
            .await
            .expect("an update in time")
            .unwrap();
        if ev.key == TopicKey::Id(key.to_owned()) {
            return serde_json::from_str(ev.data.get()).unwrap();
        }
    }
}

pub fn subscribe_bus(bus: &EventBus) -> tokio::sync::broadcast::Receiver<Arc<BusEvent>> {
    bus.subscribe(SERIES_TOPIC).unwrap().0
}

pub fn preview(
    code: &str,
    instrument: &str,
    tf: Timeframe,
    limit: u32,
    tail: Option<u32>,
) -> PreviewInput {
    PreviewInput {
        code: code.to_owned(),
        inputs: Some(Map::<String, Value>::new()),
        instrument: instrument.to_owned(),
        tf,
        limit: Some(limit),
        tail,
    }
}
