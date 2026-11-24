use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use futures::stream::{BoxStream, SelectAll};
use tessera_core::InstrumentId;
use tessera_host::{EventBus, PumpGuard, Pumps, TopicKey};
use tessera_protocol::topics::{LevelsUpdate, names};
use tokio::time::{Instant, MissedTickBehavior};

use crate::IntelligenceProvider;
use crate::service::{IntelService, levels_update};

pub struct IntelHub {
    service: Arc<IntelService>,
    bus: Arc<EventBus>,
    pumps: Pumps<InstrumentId>,
}

impl std::fmt::Debug for IntelHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntelHub")
            .field("pumps", &self.pumps.len())
            .finish_non_exhaustive()
    }
}

pub type LevelsGuard = PumpGuard<InstrumentId>;

impl IntelHub {
    pub fn new(service: Arc<IntelService>, bus: Arc<EventBus>) -> Arc<Self> {
        Arc::new(Self {
            service,
            bus,
            pumps: Pumps::new(),
        })
    }

    pub fn pump_count(&self) -> usize {
        self.pumps.len()
    }

    pub fn acquire(&self, instrument: &InstrumentId, seen: &[LevelsUpdate]) -> LevelsGuard {
        let started = self.pumps.acquire(instrument.clone(), || {
            let last = seen
                .iter()
                .map(|u| (u.provider.clone(), u.clone()))
                .collect();
            Ok::<_, std::convert::Infallible>(tokio::spawn(run_pump(
                Arc::clone(&self.service),
                Arc::clone(&self.bus),
                instrument.clone(),
                last,
            )))
        });
        match started {
            Ok(guard) => guard,
            Err(never) => match never {},
        }
    }
}

type Tagged = (Arc<dyn IntelligenceProvider>, crate::LevelSnapshot);

fn publish_if_changed(
    bus: &EventBus,
    instrument: &InstrumentId,
    last: &mut HashMap<String, LevelsUpdate>,
    update: LevelsUpdate,
) {
    let same = last
        .get(&update.provider)
        .is_some_and(|prev| prev.as_of == update.as_of && prev.levels == update.levels);
    if same {
        return;
    }
    bus.publish(
        names::INTEL_LEVELS,
        TopicKey::Instrument(instrument.clone()),
        &update,
    );
    last.insert(update.provider.clone(), update);
}

async fn run_pump(
    service: Arc<IntelService>,
    bus: Arc<EventBus>,
    instrument: InstrumentId,
    mut last: HashMap<String, LevelsUpdate>,
) {
    let mut changes = service.router().changes();
    loop {
        let providers: Vec<_> = service
            .router()
            .providers()
            .into_iter()
            .filter(|p| p.capabilities().levels)
            .collect();
        let gone: Vec<String> = last
            .keys()
            .filter(|id| !providers.iter().any(|p| p.id() == id.as_str()))
            .cloned()
            .collect();
        for id in gone {
            if let Some(prev) = last.remove(&id) {
                bus.publish(
                    names::INTEL_LEVELS,
                    TopicKey::Instrument(instrument.clone()),
                    &LevelsUpdate {
                        levels: Vec::new(),
                        ..prev
                    },
                );
            }
        }
        let mut streams: SelectAll<BoxStream<'static, Tagged>> = SelectAll::new();
        let mut polled = Vec::new();
        for p in providers {
            let stream = p
                .capabilities()
                .realtime
                .then(|| p.subscribe_levels(&instrument).ok())
                .flatten();
            match stream {
                Some(s) => {
                    let tag = Arc::clone(&p);
                    streams.push(s.map(move |snap| (Arc::clone(&tag), snap)).boxed());
                }
                None => polled.push(p),
            }
        }
        let period = polled
            .iter()
            .map(|p| p.poll_interval())
            .min()
            .unwrap_or(Duration::from_secs(3600))
            .max(Duration::from_millis(10));
        let mut tick = tokio::time::interval_at(Instant::now() + period, period);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                Some((p, snap)) = streams.next(), if !streams.is_empty() => {
                    publish_if_changed(&bus, &instrument, &mut last, levels_update(p.as_ref(), snap));
                }
                _ = tick.tick(), if !polled.is_empty() => {
                    for p in &polled {
                        if let Ok(snap) = p.levels(&instrument, None).await {
                            publish_if_changed(&bus, &instrument, &mut last, levels_update(p.as_ref(), snap));
                        }
                    }
                }
                changed = changes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use serde_json::json;
    use tessera_core::Timestamp;
    use tessera_core::clock::{ManualClock, SharedClock};
    use tessera_core::time::NANOS_PER_SEC;
    use tessera_host::{InstrumentResolver, UnknownInstrument};

    use super::*;
    use crate::router::IntelRouter;
    use crate::source::HttpLevelSource;
    use crate::source::fake::FakeHttp;
    use crate::source::http::HttpClient;

    struct NoInstruments;

    #[async_trait]
    impl InstrumentResolver for NoInstruments {
        async fn resolve_instrument(&self, input: &str) -> Result<InstrumentId, UnknownInstrument> {
            Err(UnknownInstrument(input.to_owned()))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn polling_a_source_asks_its_vendor_once_per_request_interval() {
        let http = FakeHttp::new();
        http.route("/v1/levels/QQQ", 200, &json!({"cw": 492.5}));
        let clock = Arc::new(ManualClock::new(
            Timestamp::parse("2026-10-08T15:00:00-04:00").unwrap(),
        ));
        let spec = serde_json::from_value(json!({
            "version": 1, "id": "acme", "name": "Acme levels", "vendor": "Acme",
            "baseUrl": "https://api.acme.test/v1",
            "instruments": [{"root": "QQQ", "ticker": "QQQ"}],
            "requests": [{"id": "main", "package": "Main", "path": "/levels/{ticker}",
                "fields": [{"field": "call_wall", "path": "cw"}]}],
            "schedule": {"everySeconds": 60}
        }))
        .unwrap();
        let source = HttpLevelSource::new(
            spec,
            None,
            Arc::clone(&http) as Arc<dyn HttpClient>,
            Arc::clone(&clock) as SharedClock,
        )
        .unwrap();
        let poll = source.poll_interval();
        let polls_per_request = source.every() / poll.as_secs();
        let router = IntelRouter::new();
        router.add(Arc::new(source)).unwrap();
        let service = Arc::new(IntelService::new(router, Arc::new(NoInstruments)));
        let hub = IntelHub::new(service, Arc::new(EventBus::new()));
        let _pump = hub.acquire(&InstrumentId::new("QQQ").unwrap(), &[]);

        tokio::time::sleep(poll / 2).await;
        for asked in 1..=2 {
            for _ in 0..polls_per_request {
                clock.advance(poll.as_secs() as i64 * NANOS_PER_SEC);
                tokio::time::sleep(poll).await;
            }
            assert_eq!(http.calls().len(), asked);
        }
    }
}
