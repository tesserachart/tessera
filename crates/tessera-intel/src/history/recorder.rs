use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use parking_lot::Mutex;
use tessera_core::capabilities::IntelCapabilities;
use tessera_core::health::ProviderHealth;
use tessera_core::levels::Level;
use tessera_core::{InstrumentId, SharedClock, Timestamp};
use tessera_store::Store;
use tessera_store::level_history::{Observation, SeriesInfo, origin};

use crate::io::LevelSourceInfo;
use crate::{
    ConversionRecord, HistoryFile, HistoryRequest, IntelError, IntelligenceProvider, LevelSnapshot,
};

pub struct LevelRecorder {
    store: Store,
    clock: SharedClock,
    seen: Mutex<HashMap<(String, String), Timestamp>>,
    ids: Mutex<HashMap<(String, String, String, String), i64>>,
}

impl std::fmt::Debug for LevelRecorder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LevelRecorder").finish_non_exhaustive()
    }
}

fn number(p: Option<tessera_core::Price>) -> Option<f64> {
    use rust_decimal::prelude::ToPrimitive;
    p.and_then(|p| p.0.to_f64())
}

pub fn series_of(level: &Level) -> SeriesInfo {
    let meta = serde_json::json!({
        "key": level.key,
        "short": level.short,
        "group": level.group,
        "concept": level.concept,
    });
    SeriesInfo {
        vendor: level.source.vendor.clone(),
        package: level.source.package.clone(),
        level: level.source.field.clone(),
        instrument: level.instrument.to_string(),
        label: Some(level.label.clone()),
        endpoint: level.source.endpoint.clone(),
        basis: Some(level.source.basis.clone()),
        meta: Some(meta),
    }
}

impl LevelRecorder {
    pub fn new(store: Store, clock: SharedClock) -> Arc<Self> {
        Arc::new(Self {
            store,
            clock,
            seen: Mutex::new(HashMap::new()),
            ids: Mutex::new(HashMap::new()),
        })
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn observe(
        self: &Arc<Self>,
        provider: &str,
        caps: &IntelCapabilities,
        snap: &LevelSnapshot,
    ) {
        if snap.levels.is_empty() {
            return;
        }
        let key = (provider.to_owned(), snap.instrument.to_string());
        let before = {
            let mut seen = self.seen.lock();
            if seen.get(&key).is_some_and(|t| *t >= snap.as_of) {
                return;
            }
            seen.insert(key.clone(), snap.as_of)
        };
        let as_of = snap.as_of;
        let now = self.clock.now();
        let this = Arc::clone(self);
        let provider = provider.to_owned();
        let vendor = caps.vendor.clone();
        let levels = snap.levels.clone();
        let task = move || {
            if let Err(e) = this.write(&provider, &vendor, &levels, now) {
                tracing::warn!(provider = %provider, error = %e, "could not record a levels snapshot");
                this.unsee(key, as_of, before);
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn_blocking(task);
            }
            Err(_) => task(),
        }
    }

    fn unsee(&self, key: (String, String), as_of: Timestamp, before: Option<Timestamp>) {
        let mut seen = self.seen.lock();
        if seen.get(&key) == Some(&as_of) {
            match before {
                Some(t) => seen.insert(key, t),
                None => seen.remove(&key),
            };
        }
    }

    fn series_id(&self, info: &SeriesInfo, now: Timestamp) -> tessera_store::Result<i64> {
        let key = (
            info.vendor.clone(),
            info.package.clone(),
            info.level.clone(),
            info.instrument.clone(),
        );
        if let Some(id) = self.ids.lock().get(&key) {
            return Ok(*id);
        }
        let id = self.store.level_history().series(info, now)?;
        self.ids.lock().insert(key, id);
        Ok(id)
    }

    pub fn write(
        &self,
        provider: &str,
        vendor: &str,
        levels: &[Level],
        now: Timestamp,
    ) -> tessera_store::Result<usize> {
        let mut rows = Vec::with_capacity(levels.len());
        for l in levels {
            let id = self.series_id(&series_of(l), now)?;
            rows.push((
                id,
                Observation {
                    as_of: l.source.as_of,
                    known_at: now.max(l.source.as_of),
                    value: number(l.price),
                    native_value: number(l.native_price),
                    reason: l.unavailable_reason.clone(),
                    conversion: l
                        .source
                        .conversion
                        .as_ref()
                        .and_then(|c| serde_json::to_value(c).ok()),
                    origin: origin::LIVE.into(),
                    batch: provider.to_owned(),
                },
            ));
        }
        let pairs: Vec<(i64, &Observation)> = rows.iter().map(|(i, o)| (*i, o)).collect();
        let r = self.store.level_history().insert_pairs(&pairs)?;
        if r.inserted > 0 {
            self.store
                .level_history()
                .note_recording(provider, vendor, now)?;
        }
        Ok(r.inserted)
    }
}

pub struct Recorded {
    inner: Arc<dyn IntelligenceProvider>,
    recorder: Arc<LevelRecorder>,
}

impl Recorded {
    pub fn new(inner: Arc<dyn IntelligenceProvider>, recorder: Arc<LevelRecorder>) -> Self {
        Self { inner, recorder }
    }

    fn keep(&self, snap: &LevelSnapshot) {
        self.recorder
            .observe(self.inner.id(), &self.inner.capabilities(), snap);
    }
}

#[async_trait]
impl IntelligenceProvider for Recorded {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn display_name(&self) -> &str {
        self.inner.display_name()
    }

    fn capabilities(&self) -> IntelCapabilities {
        self.inner.capabilities()
    }

    fn health(&self) -> ProviderHealth {
        self.inner.health()
    }

    async fn levels(
        &self,
        instrument: &InstrumentId,
        as_of: Option<Timestamp>,
    ) -> Result<LevelSnapshot, IntelError> {
        let snap = self.inner.levels(instrument, as_of).await?;
        self.keep(&snap);
        Ok(snap)
    }

    async fn conversion(
        &self,
        from: &str,
        to: &InstrumentId,
    ) -> Result<ConversionRecord, IntelError> {
        self.inner.conversion(from, to).await
    }

    fn subscribe_levels(
        &self,
        instrument: &InstrumentId,
    ) -> Result<BoxStream<'static, LevelSnapshot>, IntelError> {
        let stream = self.inner.subscribe_levels(instrument)?;
        let recorder = Arc::clone(&self.recorder);
        let id = self.inner.id().to_owned();
        let caps = self.inner.capabilities();
        Ok(stream
            .inspect(move |snap| recorder.observe(&id, &caps, snap))
            .boxed())
    }

    fn poll_interval(&self) -> std::time::Duration {
        self.inner.poll_interval()
    }

    fn level_source(&self) -> Option<LevelSourceInfo> {
        self.inner.level_source()
    }

    async fn history_file(&self, request: &HistoryRequest) -> Result<HistoryFile, IntelError> {
        self.inner.history_file(request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use tessera_core::health::{HealthStatus, ProviderKind};
    use tessera_core::levels::VendorRef;
    use tessera_core::settle::settle;
    use tessera_core::{Price, SystemClock};

    fn level(field: &str, price: Option<i64>, as_of: Timestamp) -> Level {
        Level {
            key: format!("acme.state.{field}"),
            instrument: InstrumentId::new("NDX").unwrap(),
            label: field.into(),
            short: None,
            group: "gamma".into(),
            price: price.map(|p| Price(Decimal::from(p))),
            unavailable_reason: price
                .is_none()
                .then(|| "Acme marks it not applicable".into()),
            native_price: None,
            source: VendorRef {
                vendor: "Acme".into(),
                package: "State".into(),
                field: field.into(),
                basis: "NDX".into(),
                endpoint: Some("state/gamma_zero".into()),
                as_of,
                conversion: None,
            },
            concept: None,
        }
    }

    struct Fixed(Mutex<LevelSnapshot>);

    #[async_trait]
    impl IntelligenceProvider for Fixed {
        fn id(&self) -> &str {
            "acme"
        }
        fn display_name(&self) -> &str {
            "Acme"
        }
        fn capabilities(&self) -> IntelCapabilities {
            IntelCapabilities {
                vendor: "Acme".into(),
                packages: vec!["State".into()],
                levels: true,
                profiles: false,
                conversions: false,
                history: false,
                realtime: false,
                rth_only: true,
            }
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth {
                provider_id: "acme".into(),
                kind: ProviderKind::Intelligence,
                display_name: "Acme".into(),
                status: HealthStatus::Ok,
                latency_ms: None,
                last_message_at: None,
                message: None,
                connection: None,
                accounts: None,
                checked_at: Timestamp(0),
            }
        }
        async fn levels(
            &self,
            _: &InstrumentId,
            _: Option<Timestamp>,
        ) -> Result<LevelSnapshot, IntelError> {
            Ok(self.0.lock().clone())
        }
        async fn conversion(
            &self,
            f: &str,
            _: &InstrumentId,
        ) -> Result<ConversionRecord, IntelError> {
            Err(IntelError::Unsupported(f.into()))
        }
    }

    fn snap(as_of: Timestamp, mlg: Option<i64>) -> LevelSnapshot {
        LevelSnapshot {
            instrument: InstrumentId::new("NDX").unwrap(),
            as_of,
            levels: vec![
                level("major_long_gamma", mlg, as_of),
                level("major_short_gamma", Some(20_300), as_of),
            ],
            raw_blob: None,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn snapshots_are_recorded_once() {
        let store = Store::open_in_memory().unwrap();
        let rec = LevelRecorder::new(store.clone(), Arc::new(SystemClock));
        let t1 = Timestamp(1_000_000_000_000);
        let fixed = Arc::new(Fixed(Mutex::new(snap(t1, Some(20_850)))));
        let p = Recorded::new(Arc::clone(&fixed) as _, Arc::clone(&rec));
        let ndx = InstrumentId::new("NDX").unwrap();
        for _ in 0..3 {
            p.levels(&ndx, None).await.unwrap();
        }
        *fixed.0.lock() = snap(Timestamp(t1.0 + 120_000_000_000), None);
        p.levels(&ndx, None).await.unwrap();
        settle(
            "two snapshots recorded",
            || {
                let h = store.level_history();
                let snapshots = h.recordings().unwrap().first().map(|r| r.snapshots);
                let written: Vec<usize> = h
                    .all_series()
                    .unwrap()
                    .iter()
                    .map(|s| h.observations(s.id, None, None, 10).unwrap().len())
                    .collect();
                (snapshots, written)
            },
            |(snapshots, written)| *snapshots == Some(2) && *written == [2, 2],
        )
        .await;
        let h = store.level_history();
        let series = h.all_series().unwrap();
        assert_eq!(series.len(), 2);
        let mlg = series
            .iter()
            .find(|s| s.info.level == "major_long_gamma")
            .unwrap();
        assert_eq!(mlg.info.vendor, "Acme");
        assert_eq!(mlg.info.package, "State");
        assert_eq!(mlg.info.endpoint.as_deref(), Some("state/gamma_zero"));
        let obs = h.observations(mlg.id, None, None, 10).unwrap();
        assert_eq!(obs.len(), 2);
        assert_eq!(obs[0].value, Some(20_850.0));
        assert!(obs[0].known_at >= obs[0].as_of, "known when it arrived");
        assert_eq!(obs[1].value, None, "not applicable stays without a value");
        assert!(obs[1].reason.is_some());
        assert_eq!(obs[0].origin, "live");
        assert_eq!(h.recordings().unwrap()[0].provider, "acme");
    }

    #[test]
    fn a_snapshot_that_could_not_be_written_is_written_when_it_comes_again() {
        let store = Store::open_in_memory().unwrap();
        let rec = LevelRecorder::new(store.clone(), Arc::new(SystemClock));
        let caps = Fixed(Mutex::new(snap(Timestamp(0), None))).capabilities();
        let t1 = Timestamp(1_000_000_000_000);
        let conn = store.conn().unwrap();
        conn.execute_batch("ALTER TABLE level_observations RENAME TO held_aside")
            .unwrap();
        rec.observe("acme", &caps, &snap(t1, Some(20_850)));
        conn.execute_batch("ALTER TABLE held_aside RENAME TO level_observations")
            .unwrap();
        rec.observe("acme", &caps, &snap(t1, Some(20_850)));
        let h = store.level_history();
        let written: usize = h
            .all_series()
            .unwrap()
            .iter()
            .map(|s| h.observations(s.id, None, None, 10).unwrap().len())
            .sum();
        assert_eq!(written, 2, "both levels of the snapshot are kept");
    }
}
