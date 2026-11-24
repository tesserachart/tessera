use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;
use tessera_protocol::cards::{Card, CardParams};
use tessera_protocol::rpc::RpcError;
use tessera_protocol::topics::names;

use crate::{EventBus, KeyFilter, Subscribed, TopicHandler, TopicKey, TopicSizing, parse_params};

pub const KEPT: usize = 200;

#[derive(Default)]
struct Held {
    cards: HashMap<String, Card>,
    order: VecDeque<String>,
}

pub struct Cards {
    bus: Arc<EventBus>,
    held: Mutex<Held>,
}

impl std::fmt::Debug for Cards {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cards")
            .field("held", &self.held.lock().cards.len())
            .finish()
    }
}

impl Cards {
    pub fn new(bus: Arc<EventBus>) -> Arc<Self> {
        Arc::new(Self {
            bus,
            held: Mutex::default(),
        })
    }

    pub fn show(&self, card: Card) -> Card {
        {
            let mut h = self.held.lock();
            if h.cards.insert(card.id.clone(), card.clone()).is_none() {
                h.order.push_back(card.id.clone());
            }
            while h.order.len() > KEPT {
                if let Some(old) = h.order.pop_front() {
                    h.cards.remove(&old);
                }
            }
        }
        self.bus
            .publish(names::CARDS, TopicKey::Id(card.id.clone()), &card);
        card
    }

    pub fn get(&self, id: &str) -> Option<Card> {
        self.held.lock().cards.get(id).cloned()
    }

    pub fn topic(self: &Arc<Self>) -> Arc<dyn TopicHandler> {
        Arc::new(CardsTopic(Arc::clone(self)))
    }
}

struct CardsTopic(Arc<Cards>);

#[async_trait]
impl TopicHandler for CardsTopic {
    fn name(&self) -> &'static str {
        names::CARDS
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::LOW_RATE
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: CardParams = parse_params(params)?;
        let now = self.0.get(&p.card_id);
        let sub = Subscribed::new(KeyFilter::Id(p.card_id));
        Ok(match now {
            Some(card) => sub.snapshot(&card),
            None => sub,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tessera_core::Timestamp;
    use tessera_protocol::cards::{CardBody, DataCoverage};

    use super::*;

    fn card(id: &str, symbol: &str) -> Card {
        Card {
            id: id.into(),
            body: CardBody::DataCoverage(DataCoverage {
                symbol: symbol.into(),
                scope: "rth".into(),
                from: "2026-10-01".into(),
                to: "2026-10-02".into(),
                days: Vec::new(),
                download: None,
            }),
            actions: Vec::new(),
            updated_at: Timestamp(0),
        }
    }

    #[tokio::test]
    async fn a_card_updates_in_place_for_its_subscribers_and_a_late_one_gets_the_latest() {
        let bus = Arc::new(EventBus::new());
        let cards = Cards::new(Arc::clone(&bus));
        let topic = cards.topic();
        bus.register(names::CARDS, topic.sizing()).unwrap();
        let (mut rx, _) = bus.subscribe(names::CARDS).unwrap();
        cards.show(card("card-1", "NQ"));
        cards.show(card("card-1", "ES"));
        let first = rx.try_recv().unwrap();
        let second = rx.try_recv().unwrap();
        assert_eq!(first.key, TopicKey::Id("card-1".into()));
        assert_ne!(first.data.get(), second.data.get());

        let late = topic.subscribe(json!({"cardId": "card-1"})).await.unwrap();
        assert!(late.filter.matches(&TopicKey::Id("card-1".into())));
        assert!(!late.filter.matches(&TopicKey::Id("card-2".into())));
        let snapshot: Card = serde_json::from_str(late.snapshot[0].get()).unwrap();
        assert_eq!(snapshot, card("card-1", "ES"));
    }

    #[test]
    fn only_the_newest_cards_are_kept() {
        let cards = Cards::new(Arc::new(EventBus::new()));
        for i in 0..=KEPT {
            cards.show(card(&format!("card-{i}"), "NQ"));
        }
        assert!(cards.get("card-0").is_none());
        assert!(cards.get(&format!("card-{KEPT}")).is_some());
    }
}
