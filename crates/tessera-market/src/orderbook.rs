use std::collections::{BTreeMap, HashMap};

use tessera_core::market::{BookSnapshot, DepthLevel};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};

use crate::provider::{BookSide, OrderBookEvent};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Level {
    size: Qty,
    orders: u32,
}

#[derive(Clone, Debug)]
pub struct OrderBookBuilder {
    instrument: InstrumentId,
    orders: HashMap<(BookSide, String), (Price, Qty)>,
    bids: BTreeMap<Price, Level>,
    asks: BTreeMap<Price, Level>,
    ts: Timestamp,
    synced: bool,
    changed: bool,
    published: bool,
    dropped: bool,
}

impl OrderBookBuilder {
    pub fn new(instrument: InstrumentId) -> Self {
        Self {
            instrument,
            orders: HashMap::new(),
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            ts: Timestamp(0),
            synced: true,
            changed: false,
            published: false,
            dropped: false,
        }
    }

    fn side(&mut self, side: BookSide) -> &mut BTreeMap<Price, Level> {
        match side {
            BookSide::Bid => &mut self.bids,
            BookSide::Ask => &mut self.asks,
        }
    }

    fn add_to_level(&mut self, side: BookSide, price: Price, size: Qty) {
        let l = self.side(side).entry(price).or_default();
        l.size = l.size + size;
        l.orders += 1;
    }

    fn take_from_level(&mut self, side: BookSide, price: Price, size: Qty) {
        let levels = self.side(side);
        if let Some(l) = levels.get_mut(&price) {
            l.size = l.size - size;
            l.orders = l.orders.saturating_sub(1);
            if l.orders == 0 || l.size <= Qty::ZERO {
                levels.remove(&price);
            }
        }
    }

    fn place(&mut self, side: BookSide, order: String, price: Price, size: Qty) {
        if let Some((old_price, old_size)) = self.orders.remove(&(side, order.clone())) {
            self.take_from_level(side, old_price, old_size);
        }
        if size > Qty::ZERO {
            self.add_to_level(side, price, size);
            self.orders.insert((side, order), (price, size));
        }
    }

    pub fn apply(&mut self, event: OrderBookEvent) {
        match event {
            OrderBookEvent::Clear { ts } => {
                self.orders.clear();
                self.bids.clear();
                self.asks.clear();
                self.ts = ts;
                self.synced = false;
                self.dropped |= std::mem::take(&mut self.published);
            }
            OrderBookEvent::Synced { ts } => {
                self.ts = self.ts.max(ts);
                self.synced = true;
            }
            OrderBookEvent::Add {
                ts,
                order,
                side,
                price,
                size,
            }
            | OrderBookEvent::Modify {
                ts,
                order,
                side,
                price,
                size,
            } => {
                self.ts = self.ts.max(ts);
                self.place(side, order, price, size);
            }
            OrderBookEvent::Remove { ts, order, side } => {
                self.ts = self.ts.max(ts);
                if let Some((price, size)) = self.orders.remove(&(side, order)) {
                    self.take_from_level(side, price, size);
                }
            }
        }
        self.changed = true;
    }

    pub fn is_synced(&self) -> bool {
        self.synced
    }

    pub fn has_news(&self) -> bool {
        (self.synced && self.changed) || (!self.synced && self.dropped)
    }

    pub fn is_reloading(&self) -> bool {
        !self.synced && self.dropped
    }

    pub fn order_count(&self) -> usize {
        self.orders.len()
    }

    pub fn snapshot(&self, levels: usize) -> BookSnapshot {
        let level = |(price, l): (&Price, &Level)| DepthLevel {
            price: *price,
            size: l.size,
            orders: Some(l.orders),
        };
        BookSnapshot {
            instrument: self.instrument.clone(),
            ts: self.ts,
            bids: self.bids.iter().rev().take(levels).map(level).collect(),
            asks: self.asks.iter().take(levels).map(level).collect(),
        }
    }

    pub fn take_snapshot(&mut self, levels: usize) -> Option<BookSnapshot> {
        if !self.synced {
            return std::mem::take(&mut self.dropped).then(|| self.snapshot(levels));
        }
        if !self.changed {
            return None;
        }
        self.changed = false;
        self.dropped = false;
        self.published = true;
        Some(self.snapshot(levels))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn p(s: &str) -> Price {
        Price::from_str(s).unwrap()
    }

    fn add(order: &str, side: BookSide, price: &str, size: i64) -> OrderBookEvent {
        OrderBookEvent::Add {
            ts: Timestamp(1),
            order: order.into(),
            side,
            price: p(price),
            size: Qty::from(size),
        }
    }

    fn rows(levels: &[DepthLevel]) -> Vec<(String, i64, u32)> {
        levels
            .iter()
            .map(|l| {
                (
                    l.price.to_string(),
                    l.size.to_f64() as i64,
                    l.orders.unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn orders_add_up_to_levels() {
        use BookSide::{Ask, Bid};
        let mut b = OrderBookBuilder::new(InstrumentId::new("ESZ6.CME").unwrap());
        b.apply(OrderBookEvent::Clear { ts: Timestamp(0) });
        for e in [
            add("1", Bid, "5000.00", 3),
            add("2", Bid, "5000.00", 2),
            add("3", Bid, "4999.75", 7),
            add("4", Ask, "5000.25", 4),
            add("5", Ask, "5000.50", 1),
        ] {
            b.apply(e);
        }
        assert!(b.take_snapshot(10).is_none());
        b.apply(OrderBookEvent::Synced { ts: Timestamp(2) });
        let s = b.take_snapshot(10).unwrap();
        assert_eq!(
            rows(&s.bids),
            [("5000.00".into(), 5, 2), ("4999.75".into(), 7, 1)]
        );
        assert_eq!(
            rows(&s.asks),
            [("5000.25".into(), 4, 1), ("5000.50".into(), 1, 1)]
        );
        assert!(b.take_snapshot(10).is_none(), "unchanged");

        b.apply(OrderBookEvent::Modify {
            ts: Timestamp(3),
            order: "1".into(),
            side: Bid,
            price: p("5000.00"),
            size: Qty::from(1),
        });
        b.apply(OrderBookEvent::Modify {
            ts: Timestamp(4),
            order: "5".into(),
            side: Ask,
            price: p("5000.25"),
            size: Qty::from(6),
        });
        b.apply(OrderBookEvent::Remove {
            ts: Timestamp(5),
            order: "3".into(),
            side: Bid,
        });
        b.apply(OrderBookEvent::Remove {
            ts: Timestamp(5),
            order: "nope".into(),
            side: Bid,
        });
        b.apply(add("2", Bid, "5000.00", 4));
        let s = b.take_snapshot(1).unwrap();
        assert_eq!(s.ts, Timestamp(5));
        assert_eq!(rows(&s.bids), [("5000.00".into(), 5, 2)]);
        assert_eq!(rows(&s.asks), [("5000.25".into(), 10, 2)]);
        assert_eq!(b.order_count(), 4);

        b.apply(OrderBookEvent::Clear { ts: Timestamp(9) });
        assert_eq!(b.order_count(), 0);
        assert!(!b.is_synced());
        let gone = b.take_snapshot(5).expect("the dropped book, empty");
        assert!(gone.bids.is_empty() && gone.asks.is_empty());
        assert_eq!(gone.ts, Timestamp(9));
        b.apply(add("6", Bid, "4999.00", 1));
        assert!(b.take_snapshot(5).is_none());
        b.apply(OrderBookEvent::Synced { ts: Timestamp(10) });
        assert_eq!(
            rows(&b.take_snapshot(5).unwrap().bids),
            [("4999.00".into(), 1, 1)]
        );
        b.apply(OrderBookEvent::Clear { ts: Timestamp(11) });
        b.apply(add("7", Ask, "5001.00", 2));
        b.apply(OrderBookEvent::Synced { ts: Timestamp(11) });
        let s = b.take_snapshot(5).unwrap();
        assert!(s.bids.is_empty() && s.asks.len() == 1);
        assert!(b.take_snapshot(5).is_none());
    }
}
