//! A depth-by-order snapshot comes as one frame per price level, listing its orders.
//! Each snapshot frame carries the sequence number of the last update it includes.
//! Several depth-by-order updates can share one sequence number.

use std::collections::{BTreeMap, HashMap};

use rithmic_rs::rti::{DepthByOrder, ResponseDepthByOrderSnapshot};
use tessera_core::instrument::InstrumentId;
use tessera_core::market::{BookSnapshot, DepthLevel};
use tessera_core::money::{Price, Qty};
use tessera_core::time::Timestamp;
use tessera_market::{BookSide, OrderBookEvent};

use crate::map::{Grid, message_time};

pub const MAX_PENDING_UPDATES: usize = 200_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Bid,
    Ask,
}

impl From<Side> for BookSide {
    fn from(s: Side) -> Self {
        match s {
            Side::Bid => BookSide::Bid,
            Side::Ask => BookSide::Ask,
        }
    }
}

impl Side {
    pub fn from_rithmic(t: Option<i32>) -> Option<Self> {
        match t {
            Some(1) => Some(Side::Bid),
            Some(2) => Some(Side::Ask),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LevelChange {
    pub side: Side,
    pub price: Price,
    pub size: Qty,
    pub orders: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Resting {
    side: Side,
    price: Price,
    size: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Level {
    size: i64,
    orders: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BookStats {
    pub applied: u64,
    pub skipped: u64,
    pub unknown_changes: u64,
    pub unknown_deletes: u64,
}

#[derive(Clone, Debug, Default)]
pub struct MboBook {
    orders: HashMap<String, Resting>,
    bids: BTreeMap<Price, Level>,
    asks: BTreeMap<Price, Level>,
    covered: Option<u64>,
    seq: Option<u64>,
    ts: Option<Timestamp>,
    stats: BookStats,
    grid: Grid,
}

fn order_key(id: Option<&String>, priority: Option<&u64>) -> Option<String> {
    match id.filter(|s| !s.is_empty()) {
        Some(id) => Some(id.clone()),
        None => priority.map(|p| format!("#{p}")),
    }
}

impl MboBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_snapshot<'a>(
        frames: impl IntoIterator<Item = &'a ResponseDepthByOrderSnapshot>,
        grid: Grid,
    ) -> Self {
        let mut book = Self {
            grid,
            ..Self::new()
        };
        let mut scratch = Vec::new();
        for f in frames {
            book.covered = book.covered.max(f.sequence_number);
            book.seq = book.covered;
            let (Some(side), Some(px)) =
                (Side::from_rithmic(f.depth_side), grid.price(f.depth_price))
            else {
                continue;
            };
            for (i, size) in f.depth_size.iter().enumerate() {
                if let Some(key) =
                    order_key(f.exchange_order_id.get(i), f.depth_order_priority.get(i))
                {
                    book.rest(key, side, px, i64::from(*size), &mut scratch);
                }
            }
        }
        book
    }

    pub fn set_grid(&mut self, grid: Grid) {
        self.grid = grid;
    }

    pub fn sequence(&self) -> Option<u64> {
        self.seq
    }

    pub fn time(&self) -> Option<Timestamp> {
        self.ts
    }

    pub fn stats(&self) -> BookStats {
        self.stats
    }

    pub fn order_count(&self) -> usize {
        self.orders.len()
    }

    pub fn depth(&self) -> (usize, usize) {
        (self.bids.len(), self.asks.len())
    }

    fn side_mut(&mut self, side: Side) -> &mut BTreeMap<Price, Level> {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }

    fn touch(&mut self, side: Side, px: Price, size_delta: i64, order_delta: i32) -> LevelChange {
        let levels = self.side_mut(side);
        let level = levels.entry(px).or_default();
        level.size += size_delta;
        level.orders = level.orders.saturating_add_signed(order_delta);
        let now = *level;
        if now.orders == 0 || now.size <= 0 {
            levels.remove(&px);
        }
        let gone = now.orders == 0 || now.size <= 0;
        LevelChange {
            side,
            price: px,
            size: Qty::from(if gone { 0 } else { now.size }),
            orders: if gone { 0 } else { now.orders },
        }
    }

    fn rest(&mut self, key: String, side: Side, px: Price, size: i64, out: &mut Vec<LevelChange>) {
        if let Some(old) = self.orders.remove(&key) {
            out.push(self.touch(old.side, old.price, -old.size, -1));
        }
        if size <= 0 {
            return;
        }
        self.orders.insert(
            key,
            Resting {
                side,
                price: px,
                size,
            },
        );
        out.push(self.touch(side, px, size, 1));
    }

    #[allow(clippy::too_many_arguments)]
    fn rest_and_report(
        &mut self,
        key: String,
        side: Side,
        px: Price,
        size: i64,
        ts: Timestamp,
        change: bool,
        out: &mut Vec<LevelChange>,
        orders: &mut Vec<OrderBookEvent>,
    ) {
        let was = self.orders.get(&key).map(|o| o.side);
        if let Some(old) = was.filter(|s| *s != side) {
            orders.push(OrderBookEvent::Remove {
                ts,
                order: key.clone(),
                side: old.into(),
            });
        }
        let event = if size <= 0 {
            (was == Some(side)).then(|| OrderBookEvent::Remove {
                ts,
                order: key.clone(),
                side: side.into(),
            })
        } else if change {
            Some(OrderBookEvent::Modify {
                ts,
                order: key.clone(),
                side: side.into(),
                price: px,
                size: Qty::from(size),
            })
        } else {
            Some(OrderBookEvent::Add {
                ts,
                order: key.clone(),
                side: side.into(),
                price: px,
                size: Qty::from(size),
            })
        };
        self.rest(key, side, px, size, out);
        orders.extend(event);
    }

    fn cancel(&mut self, key: &str, out: &mut Vec<LevelChange>) -> bool {
        match self.orders.remove(key) {
            Some(old) => {
                out.push(self.touch(old.side, old.price, -old.size, -1));
                true
            }
            None => false,
        }
    }

    pub fn image(&self, now: Timestamp) -> Vec<OrderBookEvent> {
        let ts = self.ts.unwrap_or(now);
        let mut out = Vec::with_capacity(self.orders.len() + 2);
        out.push(OrderBookEvent::Clear { ts });
        out.extend(self.orders.iter().map(|(id, o)| OrderBookEvent::Add {
            ts,
            order: id.clone(),
            side: o.side.into(),
            price: o.price,
            size: Qty::from(o.size),
        }));
        out.push(OrderBookEvent::Synced { ts });
        out
    }

    pub fn apply(&mut self, u: &DepthByOrder) -> Option<Vec<LevelChange>> {
        self.apply_orders(u, &mut Vec::new())
    }

    pub fn apply_orders(
        &mut self,
        u: &DepthByOrder,
        orders: &mut Vec<OrderBookEvent>,
    ) -> Option<Vec<LevelChange>> {
        // A depth-by-order snapshot carries no time of its own.
        if let Some(ts) = message_time(
            (u.source_ssboe, u.source_usecs, u.source_nsecs),
            (u.ssboe, u.usecs),
        ) {
            self.ts = Some(self.ts.map_or(ts, |t| t.max(ts)));
        }
        if let (Some(seq), Some(covered)) = (u.sequence_number, self.covered)
            && seq <= covered
        {
            self.stats.skipped += 1;
            return None;
        }
        let ts = self.ts.unwrap_or_default();
        let mut raw = Vec::with_capacity(u.update_type.len() * 2);
        for (i, kind) in u.update_type.iter().enumerate() {
            let Some(key) = order_key(u.exchange_order_id.get(i), u.depth_order_priority.get(i))
            else {
                continue;
            };
            let side = Side::from_rithmic(u.transaction_type.get(i).copied());
            let px = self.grid.price(u.depth_price.get(i).copied());
            let size = u.depth_size.get(i).map_or(0, |s| i64::from(*s));
            match kind {
                1 => {
                    if let (Some(side), Some(px)) = (side, px) {
                        self.rest_and_report(key, side, px, size, ts, false, &mut raw, orders);
                    }
                }
                2 => {
                    let known = self.orders.get(&key).copied();
                    if known.is_none() {
                        self.stats.unknown_changes += 1;
                    }
                    let side = side.or(known.map(|k| k.side));
                    let px = px.or(known.map(|k| k.price));
                    if let (Some(side), Some(px)) = (side, px) {
                        self.rest_and_report(key, side, px, size, ts, true, &mut raw, orders);
                    }
                }
                3 => {
                    let gone = self.orders.get(&key).map(|o| o.side);
                    let found = self.cancel(&key, &mut raw);
                    self.stats.unknown_deletes += u64::from(!found);
                    if let Some(side) = gone {
                        orders.push(OrderBookEvent::Remove {
                            ts,
                            order: key,
                            side: side.into(),
                        });
                    }
                }
                _ => {}
            }
        }
        self.seq = u.sequence_number.or(self.seq);
        self.stats.applied += 1;
        Some(collapse(raw))
    }

    pub fn best_bid(&self) -> Option<LevelChange> {
        self.bids
            .iter()
            .next_back()
            .map(|(p, l)| level(Side::Bid, *p, *l))
    }

    pub fn best_ask(&self) -> Option<LevelChange> {
        self.asks
            .iter()
            .next()
            .map(|(p, l)| level(Side::Ask, *p, *l))
    }

    pub fn levels(&self, n: usize) -> (Vec<DepthLevel>, Vec<DepthLevel>) {
        let depth = |(p, l): (&Price, &Level)| DepthLevel {
            price: *p,
            size: Qty::from(l.size),
            orders: Some(l.orders),
        };
        (
            self.bids.iter().rev().take(n).map(depth).collect(),
            self.asks.iter().take(n).map(depth).collect(),
        )
    }

    pub fn snapshot(&self, instrument: &InstrumentId, n: usize, now: Timestamp) -> BookSnapshot {
        let (bids, asks) = self.levels(n);
        BookSnapshot {
            instrument: instrument.clone(),
            ts: self.ts.unwrap_or(now),
            bids,
            asks,
        }
    }
}

fn level(side: Side, price: Price, l: Level) -> LevelChange {
    LevelChange {
        side,
        price,
        size: Qty::from(l.size),
        orders: l.orders,
    }
}

fn collapse(raw: Vec<LevelChange>) -> Vec<LevelChange> {
    let mut out: Vec<LevelChange> = Vec::with_capacity(raw.len());
    for c in raw {
        match out
            .iter_mut()
            .find(|o| o.side == c.side && o.price == c.price)
        {
            Some(o) => *o = c,
            None => out.push(c),
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BookEvent {
    Reset,
    Changes(Vec<LevelChange>, Vec<OrderBookEvent>),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BookError {
    #[error("the depth snapshot took too long ({0} updates waiting)")]
    Overflow(usize),
}

#[derive(Clone, Debug)]
pub enum BookFeed {
    Pending(Vec<DepthByOrder>),
    Live(MboBook),
    Unavailable(String),
}

impl Default for BookFeed {
    fn default() -> Self {
        BookFeed::Pending(Vec::new())
    }
}

impl BookFeed {
    pub fn book_mut(&mut self) -> Option<&mut MboBook> {
        match self {
            BookFeed::Live(b) => Some(b),
            BookFeed::Pending(_) | BookFeed::Unavailable(_) => None,
        }
    }

    pub fn book(&self) -> Option<&MboBook> {
        match self {
            BookFeed::Live(b) => Some(b),
            BookFeed::Pending(_) | BookFeed::Unavailable(_) => None,
        }
    }

    pub fn is_pending(&self) -> bool {
        matches!(self, BookFeed::Pending(_))
    }

    pub fn unavailable(&self) -> Option<&str> {
        match self {
            BookFeed::Unavailable(why) => Some(why),
            _ => None,
        }
    }

    pub fn on_update(&mut self, u: DepthByOrder) -> Result<Option<BookEvent>, BookError> {
        match self {
            BookFeed::Unavailable(_) => Ok(None),
            BookFeed::Pending(buf) => {
                if buf.len() >= MAX_PENDING_UPDATES {
                    let n = buf.len();
                    *self = BookFeed::default();
                    return Err(BookError::Overflow(n));
                }
                buf.push(u);
                Ok(None)
            }
            BookFeed::Live(book) => {
                let mut orders = Vec::new();
                Ok(book
                    .apply_orders(&u, &mut orders)
                    .map(|levels| BookEvent::Changes(levels, orders)))
            }
        }
    }

    pub fn on_snapshot(
        &mut self,
        frames: &[ResponseDepthByOrderSnapshot],
        grid: Grid,
    ) -> BookEvent {
        let buffered = match std::mem::take(self) {
            BookFeed::Pending(buf) => buf,
            BookFeed::Live(_) | BookFeed::Unavailable(_) => Vec::new(),
        };
        let mut book = MboBook::from_snapshot(frames, grid);
        for u in &buffered {
            book.apply(u);
        }
        *self = BookFeed::Live(book);
        BookEvent::Reset
    }

    pub fn reset(&mut self) {
        *self = BookFeed::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Price {
        s.parse().unwrap()
    }

    fn snap(seq: u64, side: i32, px: f64, orders: &[(&str, i32)]) -> ResponseDepthByOrderSnapshot {
        let mut f = ResponseDepthByOrderSnapshot::default();
        f.sequence_number = Some(seq);
        f.depth_side = Some(side);
        f.depth_price = Some(px);
        f.depth_size = orders.iter().map(|o| o.1).collect();
        f.exchange_order_id = orders.iter().map(|o| o.0.to_owned()).collect();
        f.depth_order_priority = (0..orders.len() as u64).collect();
        f
    }

    type Entry<'a> = (i32, i32, f64, Option<f64>, i32, &'a str);

    fn upd(seq: u64, entries: &[Entry<'_>]) -> DepthByOrder {
        let mut u = DepthByOrder::default();
        u.sequence_number = Some(seq);
        for (kind, side, px, prev, size, id) in entries {
            u.update_type.push(*kind);
            u.transaction_type.push(*side);
            u.depth_price.push(*px);
            u.prev_depth_price.push(prev.unwrap_or(0.0));
            u.prev_depth_price_flag.push(prev.is_some());
            u.depth_size.push(*size);
            u.exchange_order_id.push((*id).to_owned());
            u.depth_order_priority.push(0);
        }
        u
    }

    fn book() -> MboBook {
        MboBook::from_snapshot(
            &[
                snap(10, 1, 100.0, &[("a", 2), ("b", 3)]),
                snap(10, 1, 99.75, &[("c", 1)]),
                snap(10, 2, 100.25, &[("d", 4)]),
                ResponseDepthByOrderSnapshot::default(),
            ],
            Grid::default(),
        )
    }

    #[test]
    fn snapshot_aggregates_levels_with_order_counts() {
        let b = book();
        assert_eq!(b.sequence(), Some(10));
        assert_eq!(b.order_count(), 4);
        let (bids, asks) = b.levels(5);
        assert_eq!(
            bids.iter()
                .map(|l| (l.price, l.size, l.orders))
                .collect::<Vec<_>>(),
            vec![
                (p("100"), Qty::from(5), Some(2)),
                (p("99.75"), Qty::from(1), Some(1))
            ]
        );
        assert_eq!(asks[0].price, p("100.25"));
    }

    #[test]
    fn new_change_delete_and_price_moves() {
        let mut b = book();
        let ch = b
            .apply(&upd(
                11,
                &[
                    (1, 2, 100.25, None, 6, "e"),
                    (2, 1, 100.0, None, 1, "a"),
                    (3, 1, 99.75, None, 1, "c"),
                ],
            ))
            .unwrap();
        assert_eq!(
            ch,
            vec![
                LevelChange {
                    side: Side::Ask,
                    price: p("100.25"),
                    size: Qty::from(10),
                    orders: 2
                },
                LevelChange {
                    side: Side::Bid,
                    price: p("100"),
                    size: Qty::from(4),
                    orders: 2
                },
                LevelChange {
                    side: Side::Bid,
                    price: p("99.75"),
                    size: Qty::ZERO,
                    orders: 0
                },
            ]
        );
        b.apply(&upd(12, &[(2, 1, 100.25, Some(100.0), 3, "b")]))
            .unwrap();
        let (bids, _) = b.levels(5);
        assert_eq!(bids[0].price, p("100.25"));
        assert_eq!(bids[0].size, Qty::from(3));
        assert_eq!(bids[1].price, p("100"));
        assert_eq!(bids[1].size, Qty::from(1));
        b.apply(&upd(13, &[(3, 1, 0.0, None, 0, "b")])).unwrap();
        assert_eq!(b.best_bid().unwrap().price, p("100"));
        assert_eq!(b.stats().unknown_deletes, 0);
    }

    #[test]
    fn a_price_is_one_level_whatever_its_double() {
        let grid = Grid::of("0.01".parse().unwrap());
        let mut b = MboBook::from_snapshot(
            &[
                snap(5, 1, 88.85000000000001, &[("a", 2)]),
                snap(5, 1, 88.84, &[("b", 1)]),
                ResponseDepthByOrderSnapshot::default(),
            ],
            grid,
        );
        b.apply(&upd(6, &[(1, 1, 88.85, None, 3, "c")])).unwrap();
        let (bids, _) = b.levels(5);
        assert_eq!(
            bids.iter()
                .map(|l| (l.price, l.size, l.orders))
                .collect::<Vec<_>>(),
            vec![
                (p("88.85"), Qty::from(5), Some(2)),
                (p("88.84"), Qty::from(1), Some(1))
            ]
        );
        assert_eq!(b.best_bid().unwrap().price.to_string(), "88.85");
    }

    #[test]
    fn covered_updates_are_skipped_and_strays_counted() {
        let mut b = book();
        assert_eq!(b.apply(&upd(10, &[(3, 1, 100.0, None, 2, "a")])), None);
        assert_eq!(b.stats().skipped, 1);
        b.apply(&upd(11, &[(1, 1, 99.5, None, 1, "r1")])).unwrap();
        b.apply(&upd(11, &[(3, 1, 99.5, None, 1, "r1")])).unwrap();
        assert_eq!(b.stats().applied, 2);
        b.apply(&upd(11, &[(3, 2, 101.0, None, 1, "zz")])).unwrap();
        b.apply(&upd(12, &[(2, 2, 101.0, None, 1, "yy")])).unwrap();
        assert_eq!(b.stats().unknown_deletes, 1);
        assert_eq!(b.stats().unknown_changes, 1);
        assert_eq!(b.best_ask().unwrap().price, p("100.25"));
        assert_eq!(b.depth(), (2, 2));
    }

    #[test]
    fn feed_buffers_until_the_snapshot_then_replays_what_it_lacks() {
        let mut feed = BookFeed::default();
        assert_eq!(
            feed.on_update(upd(10, &[(3, 1, 100.0, None, 2, "a")])),
            Ok(None)
        );
        assert_eq!(
            feed.on_update(upd(11, &[(1, 1, 100.0, None, 7, "n")])),
            Ok(None)
        );
        let frames = [
            snap(10, 1, 100.0, &[("b", 3)]),
            snap(10, 2, 100.25, &[("d", 4)]),
        ];
        assert_eq!(feed.on_snapshot(&frames, Grid::default()), BookEvent::Reset);
        let b = feed.book().unwrap();
        assert_eq!(b.best_bid().unwrap().size, Qty::from(10));
        assert_eq!(b.stats().skipped, 1);
        let ev = feed
            .on_update(upd(12, &[(3, 2, 100.25, None, 4, "d")]))
            .unwrap();
        assert!(
            matches!(ev, Some(BookEvent::Changes(c, o)) if c[0].size == Qty::ZERO && o.len() == 1)
        );
        assert!(feed.book().unwrap().best_ask().is_none());
        feed.reset();
        assert!(feed.book().is_none());
    }

    #[test]
    fn a_book_given_up_on_drops_updates_until_reset() {
        let mut feed = BookFeed::Unavailable("refused".into());
        for seq in 0..(MAX_PENDING_UPDATES as u64 + 10) {
            assert_eq!(
                feed.on_update(upd(seq, &[(1, 1, 100.0, None, 1, "x")])),
                Ok(None)
            );
        }
        assert_eq!(feed.unavailable(), Some("refused"));
        assert!(!feed.is_pending() && feed.book().is_none());
        feed.reset();
        assert!(feed.is_pending());
    }

    #[test]
    fn changes_applied_to_the_whole_book_track_it_exactly() {
        type Model = BTreeMap<(bool, Price), (Qty, u32)>;
        fn whole(b: &MboBook) -> Model {
            let (bids, asks) = b.levels(usize::MAX);
            bids.iter()
                .map(|l| ((true, l.price), (l.size, l.orders.unwrap_or(0))))
                .chain(
                    asks.iter()
                        .map(|l| ((false, l.price), (l.size, l.orders.unwrap_or(0)))),
                )
                .collect()
        }
        let session = crate::synthetic::recording();
        let mut frames = Vec::new();
        let mut book: Option<MboBook> = None;
        let mut model = Model::new();
        let mut steps = 0;
        for m in session {
            match m {
                rithmic_rs::rti::messages::RithmicMessage::ResponseDepthByOrderSnapshot(f) => {
                    let last = f.depth_side.is_none();
                    frames.push(f);
                    if last {
                        let b = MboBook::from_snapshot(&frames, Grid::default());
                        model = whole(&b);
                        book = Some(b);
                    }
                }
                rithmic_rs::rti::messages::RithmicMessage::DepthByOrder(u) => {
                    let Some(b) = book.as_mut() else { continue };
                    for c in b.apply(&u).unwrap_or_default() {
                        let key = (c.side == Side::Bid, c.price);
                        if c.size == Qty::ZERO {
                            model.remove(&key);
                        } else {
                            model.insert(key, (c.size, c.orders));
                        }
                    }
                    steps += 1;
                    assert_eq!(model, whole(b), "after update {steps}");
                }
                _ => {}
            }
        }
        assert!(steps > 100, "the session replays updates ({steps})");
    }

    #[test]
    fn order_events_name_each_order_on_its_side() {
        let mut b = book();
        let mut ev = Vec::new();
        b.apply_orders(
            &upd(
                11,
                &[
                    (1, 2, 100.25, None, 6, "e"),
                    (2, 1, 100.25, Some(100.0), 1, "a"),
                    (3, 1, 0.0, None, 0, "c"),
                    (3, 1, 0.0, None, 0, "nobody"),
                    (2, 2, 100.5, None, 0, "d"),
                ],
            ),
            &mut ev,
        );
        let ask = BookSide::Ask;
        let bid = BookSide::Bid;
        let short: Vec<(&str, &str, BookSide)> = ev
            .iter()
            .map(|e| match e {
                OrderBookEvent::Add { order, side, .. } => ("add", order.as_str(), *side),
                OrderBookEvent::Modify { order, side, .. } => ("modify", order.as_str(), *side),
                OrderBookEvent::Remove { order, side, .. } => ("remove", order.as_str(), *side),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            short,
            vec![
                ("add", "e", ask),
                ("modify", "a", bid),
                ("remove", "c", bid),
                ("remove", "d", ask),
            ]
        );
        let image = b.image(Timestamp(0));
        assert!(matches!(image[0], OrderBookEvent::Clear { .. }));
        assert!(matches!(image.last(), Some(OrderBookEvent::Synced { .. })));
        assert_eq!(image.len(), b.order_count() + 2);
    }

    #[test]
    fn order_events_rebuild_the_whole_book_at_every_step() {
        use tessera_market::orderbook::OrderBookBuilder;
        let id = InstrumentId::new("ESZ6.CME-RITHMIC").unwrap();
        let session = crate::synthetic::recording();
        let mut frames = Vec::new();
        let mut book: Option<MboBook> = None;
        let mut built = OrderBookBuilder::new(id.clone());
        let mut steps = 0;
        let whole = |b: &BookSnapshot| (b.bids.clone(), b.asks.clone());
        for m in session {
            match m {
                rithmic_rs::rti::messages::RithmicMessage::ResponseDepthByOrderSnapshot(f) => {
                    let last = f.depth_side.is_none();
                    frames.push(f);
                    if last {
                        let b = MboBook::from_snapshot(&frames, Grid::default());
                        for e in b.image(Timestamp(0)) {
                            built.apply(e);
                        }
                        assert!(built.is_synced());
                        book = Some(b);
                    }
                }
                rithmic_rs::rti::messages::RithmicMessage::DepthByOrder(u) => {
                    let Some(b) = book.as_mut() else { continue };
                    let mut events = Vec::new();
                    b.apply_orders(&u, &mut events);
                    for e in events {
                        built.apply(e);
                    }
                    steps += 1;
                    assert_eq!(
                        whole(&built.snapshot(usize::MAX)),
                        whole(&b.snapshot(&id, usize::MAX, Timestamp(0))),
                        "after update {steps}"
                    );
                    assert_eq!(built.order_count(), b.order_count());
                }
                _ => {}
            }
        }
        assert!(steps > 100, "the session replays updates ({steps})");
    }
}
