use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::value::RawValue;
use tessera_core::{InstrumentId, Timeframe};
use tokio::sync::broadcast;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TopicKey {
    None,
    Instrument(InstrumentId),
    Bars(InstrumentId, Timeframe),
    Depth(InstrumentId, u32),
    Call {
        origin: &'static str,
        session: Option<String>,
    },
    Layout(String),
    Account(String),
    Id(String),
}

#[derive(Debug)]
pub struct BusEvent {
    pub topic: &'static str,
    pub key: TopicKey,
    pub seq: u64,
    pub data: Box<RawValue>,
}

pub type Subscription = (broadcast::Receiver<Arc<BusEvent>>, Vec<Arc<BusEvent>>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TopicSizing {
    pub capacity: usize,
    pub replay: usize,
}

impl TopicSizing {
    pub const MARKET: Self = Self {
        capacity: 8192,
        replay: 0,
    };

    pub const SNAPSHOT: Self = Self {
        capacity: 256,
        replay: 0,
    };

    pub const LOW_RATE: Self = Self {
        capacity: 512,
        replay: 32,
    };
}

impl Default for TopicSizing {
    fn default() -> Self {
        Self::LOW_RATE
    }
}

struct Family {
    tx: broadcast::Sender<Arc<BusEvent>>,
    seq: AtomicU64,
    replay: Mutex<VecDeque<Arc<BusEvent>>>,
    replay_cap: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BusError {
    #[error("topic {0:?} is already registered")]
    Duplicate(&'static str),
}

#[derive(Default)]
pub struct EventBus {
    families: RwLock<HashMap<&'static str, Arc<Family>>>,
}

impl std::fmt::Debug for EventBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut names: Vec<&str> = self.families.read().keys().copied().collect();
        names.sort_unstable();
        f.debug_struct("EventBus")
            .field("families", &names)
            .finish()
    }
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, topic: &'static str, sizing: TopicSizing) -> Result<(), BusError> {
        let mut families = self.families.write();
        if families.contains_key(topic) {
            return Err(BusError::Duplicate(topic));
        }
        let (tx, _) = broadcast::channel(sizing.capacity.max(1));
        families.insert(
            topic,
            Arc::new(Family {
                tx,
                seq: AtomicU64::new(0),
                replay: Mutex::new(VecDeque::with_capacity(sizing.replay)),
                replay_cap: sizing.replay,
            }),
        );
        Ok(())
    }

    pub fn topic(&self, name: &str) -> Option<&'static str> {
        self.families.read().get_key_value(name).map(|(k, _)| *k)
    }

    pub fn topics(&self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = self.families.read().keys().copied().collect();
        names.sort_unstable();
        names
    }

    fn family(&self, topic: &str) -> Option<Arc<Family>> {
        self.families.read().get(topic).cloned()
    }

    pub fn publish<T: Serialize + ?Sized>(&self, topic: &str, key: TopicKey, data: &T) -> u64 {
        let Some((name, fam)) = self
            .families
            .read()
            .get_key_value(topic)
            .map(|(k, f)| (*k, Arc::clone(f)))
        else {
            tracing::warn!(topic, "publish to unregistered topic");
            return 0;
        };
        let raw = match serde_json::value::to_raw_value(data) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(topic, error = %e, "event serialization failed");
                return 0;
            }
        };
        let mut replay = fam.replay.lock();
        let seq = fam.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let ev = Arc::new(BusEvent {
            topic: name,
            key,
            seq,
            data: raw,
        });
        if fam.replay_cap > 0 {
            if replay.len() == fam.replay_cap {
                replay.pop_front();
            }
            replay.push_back(Arc::clone(&ev));
        }
        let _ = fam.tx.send(ev);
        seq
    }

    pub fn subscribe(&self, topic: &str) -> Option<Subscription> {
        let fam = self.family(topic)?;
        let replay = fam.replay.lock();
        let rx = fam.tx.subscribe();
        Some((rx, replay.iter().cloned().collect()))
    }

    pub fn last_seq(&self, topic: &str) -> u64 {
        self.family(topic)
            .map_or(0, |f| f.seq.load(Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bus() -> EventBus {
        let bus = EventBus::new();
        bus.register(
            "tool.calls",
            TopicSizing {
                capacity: 1024,
                replay: 100,
            },
        )
        .unwrap();
        bus.register("market.quotes", TopicSizing::MARKET).unwrap();
        bus
    }

    #[test]
    fn sequence_replay_and_live_delivery() {
        let bus = bus();
        let topic = bus.topic("tool.calls").unwrap();
        assert!(bus.topic("nope").is_none());
        for i in 0..3 {
            bus.publish(topic, TopicKey::None, &json!({"i": i}));
        }
        let (mut rx, replay) = bus.subscribe(topic).unwrap();
        assert_eq!(
            replay.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        bus.publish(topic, TopicKey::None, &json!({"i": 3}));
        let live = rx.try_recv().unwrap();
        assert_eq!(live.seq, 4);
        assert_eq!(live.data.get(), r#"{"i":3}"#);
        assert_eq!(bus.last_seq("tool.calls"), 4);
        bus.publish("market.quotes", TopicKey::None, &json!(1));
        assert!(bus.subscribe("market.quotes").unwrap().1.is_empty());
        assert_eq!(bus.publish("nope", TopicKey::None, &json!(1)), 0);
        assert_eq!(
            bus.register("tool.calls", TopicSizing::LOW_RATE),
            Err(BusError::Duplicate("tool.calls"))
        );
        assert_eq!(bus.topics(), ["market.quotes", "tool.calls"]);
    }

    #[test]
    fn replay_is_bounded() {
        let bus = bus();
        for i in 0..150 {
            bus.publish("tool.calls", TopicKey::None, &i);
        }
        let (_, replay) = bus.subscribe("tool.calls").unwrap();
        assert_eq!(replay.len(), 100);
        assert_eq!(replay[0].seq, 51);
    }

    #[test]
    fn a_subscriber_during_publishing_gets_the_next_event_live_once() {
        const EVENTS: usize = 100_000;
        let bus = Arc::new(EventBus::new());
        bus.register(
            "tool.calls",
            TopicSizing {
                capacity: EVENTS,
                replay: 32,
            },
        )
        .unwrap();
        let publisher = {
            let bus = Arc::clone(&bus);
            std::thread::spawn(move || {
                for i in 0..EVENTS {
                    bus.publish("tool.calls", TopicKey::None, &i);
                }
            })
        };
        while !publisher.is_finished() {
            let (mut rx, replay) = bus.subscribe("tool.calls").unwrap();
            let next = replay.last().map_or(1, |e| e.seq + 1);
            loop {
                match rx.try_recv() {
                    Ok(live) => {
                        assert_eq!(live.seq, next, "replayed up to {}", next - 1);
                        break;
                    }
                    Err(broadcast::error::TryRecvError::Empty) if !publisher.is_finished() => {
                        std::hint::spin_loop();
                    }
                    Err(broadcast::error::TryRecvError::Empty) => break,
                    Err(e) => panic!("{e}"),
                }
            }
        }
        publisher.join().unwrap();
    }
}
