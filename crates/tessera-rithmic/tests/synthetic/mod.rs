use std::collections::{BTreeMap, HashMap};

use rithmic_rs::rti::messages::RithmicMessage;
use rithmic_rs::rti::response_time_bar_replay::BarType;
use rithmic_rs::rti::{
    BestBidOffer, DepthByOrder, LastTrade, ResponseDepthByOrderSnapshot,
    ResponseFrontMonthContract, ResponseReferenceData, ResponseTimeBarReplay, TradeStatistics,
    best_bid_offer, depth_by_order, last_trade, trade_statistics,
};

use tessera_market::orderflow::big_trades::CONTINUATION_NS;

use super::frames::{FrameWriter, compress, read_recording};

const ROOT: &str = "ES";
const SYMBOL: &str = "ESZ6";
const EXCHANGE: &str = "CME";
const TICK: f64 = 0.25;
const SEED: u64 = 0x2026_1007_5EED_00E5;

const NANOS_PER_SEC: i64 = 1_000_000_000;
const NANOS_PER_MICRO: i64 = 1_000;
const LIVE_FROM_SECS: i64 = 1_791_384_310;
const MINUTE_BARS: i64 = 30;

const OPENING_BID_TICKS: i64 = 27_400;
const BOOK_LEVELS: i64 = 150;
const STRAY_BID_TICKS: [i64; 3] = [6_000, 16_000, 24_000];
const STRAY_ASK_TICKS: [i64; 2] = [30_000, 32_000];
const SESSION_OPEN_ABOVE_TICKS: i64 = 92;
const SESSION_HIGH_ABOVE_OPEN_TICKS: i64 = 14;
const SESSION_LOW_BELOW_BARS_TICKS: i64 = 37;
const SETTLEMENT_ABOVE_TICKS: i64 = 101;
const VOLUME_BEFORE_BARS: u64 = 702_118;

const LIVE_EVENTS: usize = 760;
const EVENTS_COVERED_BY_SNAPSHOT: usize = 6;
const EVENTS_BEFORE_SNAPSHOT_ARRIVES: usize = 14;
const SWEEP_REACH_TICKS: i64 = 2;
const EVERY_NTH_JOIN_AT_THE_TOUCH_IS_QUOTED_FIRST: u32 = 6;

const FIRST_ORDER_ID: u64 = 7_390_412_000_000;
const FIRST_PRIORITY: u64 = 24_810_000_000;
const FIRST_AGGRESSOR_ID: u64 = 7_390_499_000_000;
const FIRST_SEQUENCE: u64 = 41_027_300;

pub fn recording() -> Vec<RithmicMessage> {
    let session = session();
    let mut writer = FrameWriter::new(Vec::new());
    for m in &session {
        assert!(writer.write(m).expect("a frame writes to memory"));
    }
    let packed = compress(&writer.into_inner()).expect("the session compresses");
    let decoded = read_recording(&packed).expect("the synthetic session decodes");
    assert_eq!(decoded, session, "the frame codec is lossless");
    decoded
}

fn session() -> Vec<RithmicMessage> {
    let mut tape = Tape::new();
    let bars = tape.minute_bars(OPENING_BID_TICKS + 1);
    tape.open(&bars);
    tape.trade_live();
    tape.out
        .extend(bars.into_iter().map(RithmicMessage::ResponseTimeBarReplay));
    tape.out
        .push(RithmicMessage::ResponseTimeBarReplay(end_of_bars()));
    tape.out
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn between(&mut self, lo: i64, hi: i64) -> i64 {
        lo + self.below((hi - lo + 1) as u64) as i64
    }

    fn percent(&mut self, p: u64) -> bool {
        self.below(100) < p
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Bid,
    Ask,
}

impl Side {
    fn code(self) -> i32 {
        match self {
            Side::Bid => depth_by_order::TransactionType::Buy as i32,
            Side::Ask => depth_by_order::TransactionType::Sell as i32,
        }
    }

    fn other(self) -> Self {
        match self {
            Side::Bid => Side::Ask,
            Side::Ask => Side::Bid,
        }
    }

    fn away(self, ticks: i64, by: i64) -> i64 {
        match self {
            Side::Bid => ticks - by,
            Side::Ask => ticks + by,
        }
    }

    fn toward(self, ticks: i64, by: i64) -> i64 {
        self.away(ticks, -by)
    }

    fn beyond(self, ticks: i64, limit: i64) -> bool {
        match self {
            Side::Bid => ticks < limit,
            Side::Ask => ticks > limit,
        }
    }
}

fn price(ticks: i64) -> f64 {
    ticks as f64 * TICK
}

fn clock(nanos: i64) -> (Option<i32>, Option<i32>, Option<i32>) {
    let secs = nanos.div_euclid(NANOS_PER_SEC);
    let within = nanos.rem_euclid(NANOS_PER_SEC);
    (
        Some(secs as i32),
        Some((within / NANOS_PER_MICRO) as i32),
        Some(within as i32),
    )
}

#[derive(Clone, Copy, Debug)]
struct Resting {
    side: Side,
    ticks: i64,
    size: i32,
    priority: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Touch {
    ticks: i64,
    size: i32,
    orders: i32,
}

#[derive(Default)]
struct Book {
    orders: HashMap<u64, Resting>,
    bids: BTreeMap<i64, Vec<u64>>,
    asks: BTreeMap<i64, Vec<u64>>,
    issued: u64,
    prioritised: u64,
}

impl Book {
    fn queues(&self, side: Side) -> &BTreeMap<i64, Vec<u64>> {
        match side {
            Side::Bid => &self.bids,
            Side::Ask => &self.asks,
        }
    }

    fn queues_mut(&mut self, side: Side) -> &mut BTreeMap<i64, Vec<u64>> {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }

    fn outward(&self, side: Side) -> Box<dyn Iterator<Item = (&i64, &Vec<u64>)> + '_> {
        match side {
            Side::Bid => Box::new(self.bids.iter().rev()),
            Side::Ask => Box::new(self.asks.iter()),
        }
    }

    fn best(&self, side: Side) -> i64 {
        *self.outward(side).next().expect("both sides stay deep").0
    }

    fn level(&self, side: Side, from_best: usize) -> i64 {
        let deepest = self.queues(side).len() - 1;
        *self
            .outward(side)
            .nth(from_best.min(deepest))
            .expect("both sides stay deep")
            .0
    }

    fn touch(&self, side: Side) -> Touch {
        let ticks = self.best(side);
        let queue = &self.queues(side)[&ticks];
        Touch {
            ticks,
            size: queue.iter().map(|id| self.orders[id].size).sum(),
            orders: queue.len() as i32,
        }
    }

    fn priority(&mut self) -> u64 {
        self.prioritised += 1;
        FIRST_PRIORITY + self.prioritised
    }

    fn rest(&mut self, side: Side, ticks: i64, size: i32) -> u64 {
        self.issued += 1;
        let id = FIRST_ORDER_ID + self.issued;
        let priority = self.priority();
        self.queue(
            id,
            Resting {
                side,
                ticks,
                size,
                priority,
            },
        );
        id
    }

    fn queue(&mut self, id: u64, order: Resting) {
        self.orders.insert(id, order);
        self.queues_mut(order.side)
            .entry(order.ticks)
            .or_default()
            .push(id);
    }

    fn take(&mut self, id: u64) -> Resting {
        let order = self.orders.remove(&id).expect("a resting order");
        let levels = self.queues_mut(order.side);
        let queue = levels.get_mut(&order.ticks).expect("its level");
        queue.retain(|o| *o != id);
        if queue.is_empty() {
            levels.remove(&order.ticks);
        }
        order
    }
}

struct Entry {
    kind: depth_by_order::UpdateType,
    id: u64,
    order: Resting,
    moved_from: Option<i64>,
}

struct Tape {
    rng: Rng,
    book: Book,
    out: Vec<RithmicMessage>,
    now: i64,
    sequence: u64,
    aggressors: u64,
    settlement: i64,
    quoted: Option<(Touch, Touch)>,
    joins_at_the_touch: u32,
}

impl Tape {
    fn new() -> Self {
        Self {
            rng: Rng(SEED),
            book: Book::default(),
            out: Vec::new(),
            now: LIVE_FROM_SECS * NANOS_PER_SEC,
            sequence: FIRST_SEQUENCE,
            aggressors: 0,
            settlement: 0,
            quoted: None,
            joins_at_the_touch: 0,
        }
    }

    fn gateway(&mut self) -> (Option<i32>, Option<i32>) {
        let (secs, usecs, _) = clock(self.now + self.rng.between(30, 250) * NANOS_PER_MICRO);
        (secs, usecs)
    }

    fn order_size(&mut self) -> i32 {
        match self.rng.below(100) {
            0..=57 => 1,
            58..=84 => self.rng.between(2, 4) as i32,
            85..=96 => self.rng.between(5, 15) as i32,
            _ => self.rng.between(20, 60) as i32,
        }
    }

    fn aggressor_size(&mut self) -> i32 {
        match self.rng.below(100) {
            0..=49 => self.rng.between(1, 2) as i32,
            50..=89 => self.rng.between(3, 10) as i32,
            _ => self.rng.between(15, 60) as i32,
        }
    }

    fn levels_from_best(&mut self) -> i64 {
        if self.rng.percent(70) {
            self.rng.between(0, 3)
        } else if self.rng.percent(75) {
            self.rng.between(4, 10)
        } else {
            self.rng.between(11, 60)
        }
    }

    fn side(&mut self) -> Side {
        if self.rng.percent(50) {
            Side::Bid
        } else {
            Side::Ask
        }
    }

    fn minute_bars(&mut self, last_ticks: i64) -> Vec<ResponseTimeBarReplay> {
        let mut closes = vec![last_ticks];
        for _ in 1..MINUTE_BARS {
            let newer = *closes.last().expect("a close");
            closes.push(newer + self.rng.between(-6, 6));
        }
        closes.reverse();
        let first_open_secs = LIVE_FROM_SECS - LIVE_FROM_SECS.rem_euclid(60) - 60 * MINUTE_BARS;
        let mut bars = Vec::with_capacity(closes.len());
        for (i, close) in closes.iter().copied().enumerate() {
            let open = match i {
                0 => close + self.rng.between(-4, 4),
                _ => closes[i - 1] + self.rng.between(-1, 1),
            };
            let volume = self.rng.between(1_400, 4_600) as u64;
            let bought = volume * self.rng.between(42, 58) as u64 / 100;
            let mut b = ResponseTimeBarReplay::default();
            b.template_id = 203;
            b.user_msg = vec!["2".into()];
            b.rq_handler_rp_code = vec!["0".into()];
            b.symbol = Some(SYMBOL.into());
            b.exchange = Some(EXCHANGE.into());
            b.r#type = Some(BarType::MinuteBar as i32);
            b.period = Some("60".into());
            b.marker = Some((first_open_secs + 60 * (i as i64 + 1)) as i32);
            b.num_trades = Some(volume * self.rng.between(70, 90) as u64 / 100);
            b.volume = Some(volume);
            b.bid_volume = Some(bought);
            b.ask_volume = Some(volume - bought);
            b.open_price = Some(price(open));
            b.close_price = Some(price(close));
            b.high_price = Some(price(open.max(close) + self.rng.between(0, 3)));
            b.low_price = Some(price(open.min(close) - self.rng.between(0, 3)));
            b.has_settlement_price = Some(true);
            b.must_clear_settlement_price = Some(true);
            bars.push(b);
        }
        bars
    }

    fn open(&mut self, bars: &[ResponseTimeBarReplay]) {
        self.fill_book();
        self.out
            .push(RithmicMessage::ResponseFrontMonthContract(front_month()));
        self.out
            .push(RithmicMessage::ResponseReferenceData(reference_data()));
        self.quote(true);

        let last = self.book.best(Side::Ask);
        let bars_low = bars
            .iter()
            .filter_map(|b| b.low_price)
            .map(|p| (p / TICK) as i64)
            .min()
            .unwrap_or(last);
        let open = last + SESSION_OPEN_ABOVE_TICKS;
        self.settlement = last + SETTLEMENT_ABOVE_TICKS;
        let volume = VOLUME_BEFORE_BARS + bars.iter().filter_map(|b| b.volume).sum::<u64>();

        let mut t = self.print(last, 1, Side::Bid);
        t.is_snapshot = Some(true);
        t.presence_bits = Some(
            last_trade::PresenceBits::LastTrade as u32
                | last_trade::PresenceBits::NetChange as u32
                | last_trade::PresenceBits::PrecentChange as u32
                | last_trade::PresenceBits::Volume as u32,
        );
        t.volume = Some(volume);
        (t.source_ssboe, t.source_usecs, t.source_nsecs) = (None, None, None);
        (t.ssboe, t.usecs) = (clock(self.now).0, None);
        self.out.push(RithmicMessage::LastTrade(t));

        let mut s = TradeStatistics::default();
        s.template_id = 152;
        s.symbol = Some(SYMBOL.into());
        s.exchange = Some(EXCHANGE.into());
        s.is_snapshot = Some(true);
        s.presence_bits = Some(
            trade_statistics::PresenceBits::Open as u32
                | trade_statistics::PresenceBits::High as u32
                | trade_statistics::PresenceBits::Low as u32,
        );
        s.open_price = Some(price(open));
        s.high_price = Some(price(open + SESSION_HIGH_ABOVE_OPEN_TICKS));
        s.low_price = Some(price(bars_low.min(last) - SESSION_LOW_BELOW_BARS_TICKS));
        self.out.push(RithmicMessage::TradeStatistics(s));
    }

    fn fill_book(&mut self) {
        for level in 0..BOOK_LEVELS {
            for side in [Side::Bid, Side::Ask] {
                let ticks = side.away(
                    match side {
                        Side::Bid => OPENING_BID_TICKS,
                        Side::Ask => OPENING_BID_TICKS + 1,
                    },
                    level,
                );
                let base = (10 + 5 * level).min(36) as u64;
                for _ in 0..base + self.rng.below(base / 2 + 1) {
                    let size = self.order_size();
                    self.book.rest(side, ticks, size);
                }
            }
        }
        for ticks in STRAY_BID_TICKS {
            self.book.rest(Side::Bid, ticks, 25);
        }
        for ticks in STRAY_ASK_TICKS {
            self.book.rest(Side::Ask, ticks, 25);
        }
    }

    fn trade_live(&mut self) {
        let mut snapshot = None;
        for event in 1..=LIVE_EVENTS {
            self.now += if self.rng.percent(15) {
                self.rng.between(NANOS_PER_MICRO, 200 * NANOS_PER_MICRO)
            } else {
                self.rng
                    .between(200 * NANOS_PER_MICRO, 9_000 * NANOS_PER_MICRO)
            };
            self.sequence += 1;
            match self.rng.below(100) {
                0..=37 => self.join(),
                38..=65 => self.cancel(),
                66..=73 => self.resize(),
                74..=79 => self.reprice(),
                _ => self.take_liquidity(),
            }
            if self.quoted != Some(self.touches()) {
                self.quote(false);
            }
            if event == EVENTS_COVERED_BY_SNAPSHOT {
                snapshot = Some(self.snapshot());
            }
            if event == EVENTS_BEFORE_SNAPSHOT_ARRIVES {
                self.out.extend(snapshot.take().into_iter().flatten());
            }
        }
    }

    fn touches(&self) -> (Touch, Touch) {
        (self.book.touch(Side::Bid), self.book.touch(Side::Ask))
    }

    fn pick(&mut self, side: Side) -> u64 {
        let from_best = self.levels_from_best() as usize;
        let ticks = self.book.level(side, from_best);
        let queue = &self.book.queues(side)[&ticks];
        queue[self.rng.below(queue.len() as u64) as usize]
    }

    fn join(&mut self) {
        let side = self.side();
        let best = self.book.best(side);
        let spread = self.book.best(Side::Ask) - self.book.best(Side::Bid);
        let ticks = if spread > 1 && self.rng.percent(30) {
            side.toward(best, 1)
        } else {
            let from_best = self.levels_from_best();
            side.away(best, from_best)
        };
        let size = self.order_size();
        let id = self.book.rest(side, ticks, size);
        if ticks == best {
            self.joins_at_the_touch += 1;
            if self
                .joins_at_the_touch
                .is_multiple_of(EVERY_NTH_JOIN_AT_THE_TOUCH_IS_QUOTED_FIRST)
            {
                self.quote(false);
            }
        }
        let order = self.book.orders[&id];
        self.depth(Entry {
            kind: depth_by_order::UpdateType::New,
            id,
            order,
            moved_from: None,
        });
    }

    fn cancel(&mut self) {
        let side = self.side();
        let id = self.pick(side);
        let order = self.book.take(id);
        self.depth(Entry {
            kind: depth_by_order::UpdateType::Delete,
            id,
            order,
            moved_from: None,
        });
    }

    fn resize(&mut self) {
        let side = self.side();
        let id = self.pick(side);
        let mut order = self.book.orders[&id];
        order.size = if order.size > 1 {
            self.rng.between(1, i64::from(order.size) - 1) as i32
        } else {
            self.rng.between(2, 5) as i32
        };
        self.book.orders.insert(id, order);
        self.depth(Entry {
            kind: depth_by_order::UpdateType::Change,
            id,
            order,
            moved_from: None,
        });
    }

    fn reprice(&mut self) {
        let side = self.side();
        let id = self.pick(side);
        let was = self.book.take(id);
        let by = self.rng.between(1, 3);
        let opposite = self.book.best(side.other());
        let mut ticks = if self.rng.percent(50) {
            side.toward(was.ticks, by)
        } else {
            side.away(was.ticks, by)
        };
        if !side.other().beyond(opposite, ticks) {
            ticks = side.away(opposite, 1);
        }
        if ticks == was.ticks {
            ticks = side.away(was.ticks, 1);
        }
        let order = Resting {
            ticks,
            priority: self.book.priority(),
            ..was
        };
        self.book.queue(id, order);
        self.depth(Entry {
            kind: depth_by_order::UpdateType::Change,
            id,
            order,
            moved_from: Some(was.ticks),
        });
    }

    fn take_liquidity(&mut self) {
        let side = self.side();
        self.sweep(side);
        if self.rng.percent(35) {
            if self.rng.percent(50) {
                self.now += self.rng.between(CONTINUATION_NS / 10, CONTINUATION_NS);
            }
            self.sequence += 1;
            self.sweep(side);
        }
    }

    fn sweep(&mut self, aggressor: Side) {
        self.aggressors += 1;
        let key = FIRST_AGGRESSOR_ID + self.aggressors;
        let resting = aggressor.other();
        let limit = resting.away(self.book.best(resting), SWEEP_REACH_TICKS);
        let mut left = self.aggressor_size();
        let mut prints = Vec::new();
        let mut fills = Vec::new();
        while left > 0 {
            let ticks = self.book.best(resting);
            if resting.beyond(ticks, limit) {
                break;
            }
            let id = self.book.queues(resting)[&ticks][0];
            let mut order = self.book.orders[&id];
            let filled = left.min(order.size);
            left -= filled;
            let mut print = self.print(ticks, filled, aggressor);
            print.exchange_order_id = Some(id.to_string());
            print.aggressor_exchange_order_id = Some(key.to_string());
            prints.push(print);
            if filled == order.size {
                self.book.take(id);
                fills.push(Entry {
                    kind: depth_by_order::UpdateType::Delete,
                    id,
                    order,
                    moved_from: None,
                });
            } else {
                order.size -= filled;
                self.book.orders.insert(id, order);
                fills.push(Entry {
                    kind: depth_by_order::UpdateType::Change,
                    id,
                    order,
                    moved_from: None,
                });
            }
        }
        self.out
            .extend(prints.into_iter().map(RithmicMessage::LastTrade));
        for fill in fills {
            self.depth(fill);
        }
    }

    fn print(&mut self, ticks: i64, size: i32, aggressor: Side) -> LastTrade {
        let net_change = price(ticks - self.settlement);
        let mut t = LastTrade::default();
        t.template_id = 150;
        t.symbol = Some(SYMBOL.into());
        t.exchange = Some(EXCHANGE.into());
        t.presence_bits = Some(
            last_trade::PresenceBits::LastTrade as u32
                | last_trade::PresenceBits::NetChange as u32
                | last_trade::PresenceBits::PrecentChange as u32,
        );
        t.trade_price = Some(price(ticks));
        t.trade_size = Some(size);
        t.aggressor = Some(match aggressor {
            Side::Bid => last_trade::TransactionType::Buy as i32,
            Side::Ask => last_trade::TransactionType::Sell as i32,
        });
        t.net_change = Some(net_change);
        t.percent_change = Some((net_change / price(self.settlement) * 10_000.0).round() / 100.0);
        (t.source_ssboe, t.source_usecs, t.source_nsecs) = clock(self.now);
        (t.ssboe, t.usecs) = self.gateway();
        t
    }

    fn depth(&mut self, e: Entry) {
        let mut u = DepthByOrder::default();
        u.template_id = 160;
        u.symbol = Some(SYMBOL.into());
        u.exchange = Some(EXCHANGE.into());
        u.sequence_number = Some(self.sequence);
        u.update_type = vec![e.kind as i32];
        u.transaction_type = vec![e.order.side.code()];
        u.depth_price = vec![price(e.order.ticks)];
        u.prev_depth_price = vec![e.moved_from.map_or(0.0, price)];
        u.prev_depth_price_flag = vec![e.moved_from.is_some()];
        u.depth_size = vec![e.order.size];
        u.depth_order_priority = vec![e.order.priority];
        u.exchange_order_id = vec![e.id.to_string()];
        (u.source_ssboe, u.source_usecs, u.source_nsecs) = clock(self.now);
        (u.ssboe, u.usecs) = self.gateway();
        self.out.push(RithmicMessage::DepthByOrder(u));
    }

    fn quote(&mut self, is_snapshot: bool) {
        let (bid, ask) = self.touches();
        let mut b = BestBidOffer::default();
        b.template_id = 151;
        b.symbol = Some(SYMBOL.into());
        b.exchange = Some(EXCHANGE.into());
        b.presence_bits = Some(
            best_bid_offer::PresenceBits::Bid as u32 | best_bid_offer::PresenceBits::Ask as u32,
        );
        b.bid_price = Some(price(bid.ticks));
        b.bid_size = Some(bid.size);
        b.bid_orders = Some(bid.orders);
        b.bid_implicit_size = Some(0);
        b.ask_price = Some(price(ask.ticks));
        b.ask_size = Some(ask.size);
        b.ask_orders = Some(ask.orders);
        b.ask_implicit_size = Some(0);
        if is_snapshot {
            b.is_snapshot = Some(true);
            b.ssboe = clock(self.now).0;
        } else {
            (b.ssboe, b.usecs) = self.gateway();
        }
        self.out.push(RithmicMessage::BestBidOffer(b));
        self.quoted = Some((bid, ask));
    }

    fn snapshot(&self) -> Vec<RithmicMessage> {
        let frames = |side: Side| -> Vec<ResponseDepthByOrderSnapshot> {
            self.book
                .outward(side)
                .map(|(ticks, queue)| {
                    let mut f = ResponseDepthByOrderSnapshot::default();
                    f.template_id = 116;
                    f.user_msg = vec!["7".into()];
                    f.rq_handler_rp_code = vec!["0".into()];
                    f.symbol = Some(SYMBOL.into());
                    f.exchange = Some(EXCHANGE.into());
                    f.sequence_number = Some(self.sequence);
                    f.depth_side = Some(side.code());
                    f.depth_price = Some(price(*ticks));
                    for id in queue {
                        let order = self.book.orders[id];
                        f.depth_size.push(order.size);
                        f.depth_order_priority.push(order.priority);
                        f.exchange_order_id.push(id.to_string());
                    }
                    f
                })
                .collect()
        };
        let (bids, asks) = (frames(Side::Bid), frames(Side::Ask));
        let mut out = Vec::with_capacity(bids.len() + asks.len() + 1);
        let mut asks = asks.into_iter();
        for bid in bids {
            out.push(RithmicMessage::ResponseDepthByOrderSnapshot(bid));
            out.extend(
                asks.next()
                    .map(RithmicMessage::ResponseDepthByOrderSnapshot),
            );
        }
        out.extend(asks.map(RithmicMessage::ResponseDepthByOrderSnapshot));
        let mut end = ResponseDepthByOrderSnapshot::default();
        end.template_id = 116;
        end.user_msg = vec!["7".into()];
        end.rp_code = vec!["0".into()];
        out.push(RithmicMessage::ResponseDepthByOrderSnapshot(end));
        out
    }
}

fn front_month() -> ResponseFrontMonthContract {
    let mut f = ResponseFrontMonthContract::default();
    f.template_id = 114;
    f.user_msg = vec!["2".into()];
    f.rp_code = vec!["0".into()];
    f.symbol = Some(ROOT.into());
    f.exchange = Some(EXCHANGE.into());
    f.is_front_month_symbol = Some(true);
    f.symbol_name = Some(format!("Front Month for {ROOT} - {SYMBOL}.{EXCHANGE}"));
    f.trading_symbol = Some(SYMBOL.into());
    f.trading_exchange = Some(EXCHANGE.into());
    f
}

fn reference_data() -> ResponseReferenceData {
    let mut r = ResponseReferenceData::default();
    r.template_id = 15;
    r.user_msg = vec!["3".into()];
    r.rp_code = vec!["0".into()];
    r.symbol = Some(SYMBOL.into());
    r.exchange = Some(EXCHANGE.into());
    r.exchange_symbol = Some(SYMBOL.into());
    r.symbol_name = Some("E-Mini S&P 500".into());
    r.product_code = Some(ROOT.into());
    r.instrument_type = Some("Future".into());
    r.expiration_date = Some("20261218".into());
    r.currency = Some("USD".into());
    r.min_qprice_change = Some(TICK);
    r.single_point_value = Some(50.0);
    r.min_qprice_change_precision = Some(2);
    r
}

fn end_of_bars() -> ResponseTimeBarReplay {
    let mut b = ResponseTimeBarReplay::default();
    b.template_id = 203;
    b.user_msg = vec!["2".into()];
    b.rp_code = vec!["0".into()];
    b
}
