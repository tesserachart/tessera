use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::Duration;

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use tessera_core::InstrumentId;
use tessera_core::market::BookSnapshot;

pub const COLUMN_NS: i64 = 1_000_000_000;
pub const LEVELS: usize = 100;
pub const MEMORY_SPAN: Duration = Duration::from_secs(2 * 60 * 60);
pub const MEMORY_SPAN_ALONE: Duration = Duration::from_secs(6 * 60 * 60);
pub const MEMORY_BYTES: usize = 24 << 20;
pub const ARCHIVE_SESSIONS: usize = 5;
const MEAN_STEPS_PER_LOT: f64 = 16.0;
pub(crate) const MINUTE_NS: i64 = 60 * COLUMN_NS;

pub fn tick_range(tick: f64, lo: Option<f64>, hi: Option<f64>) -> (i64, i64) {
    const SNAP: f64 = 1e-6;
    (
        lo.map_or(i64::MIN, |p| (p / tick - SNAP).ceil() as i64),
        hi.map_or(i64::MAX, |p| (p / tick + SNAP).floor() as i64),
    )
}

fn put(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push((v as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

fn get(buf: &[u8], at: &mut usize) -> u64 {
    let mut v = 0u64;
    let mut shift = 0;
    while let Some(&b) = buf.get(*at) {
        *at += 1;
        v |= u64::from(b & 0x7f) << shift;
        if b < 0x80 {
            break;
        }
        shift += 7;
    }
    v
}

fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

pub trait DepthArchive: Send + Sync + std::fmt::Debug {
    fn put(
        &self,
        provider: &str,
        instrument: &InstrumentId,
        minute: i64,
        columns: &[u8],
    ) -> Result<(), String>;
    fn get(
        &self,
        provider: &str,
        instrument: &InstrumentId,
        from: i64,
        to: i64,
    ) -> Result<Vec<(i64, Vec<u8>)>, String>;
    fn first(&self, provider: &str, instrument: &InstrumentId) -> Result<Option<i64>, String>;
    fn prune(&self, provider: &str, instrument: &InstrumentId, before: i64) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DepthCell {
    pub tick: i64,
    pub bid: bool,
    pub mean: f64,
    pub decreases: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DepthColumn {
    pub t: i64,
    pub ended: bool,
    pub cells: Vec<DepthCell>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Packed {
    t: i64,
    ended: bool,
    data: Box<[u8]>,
}

impl Packed {
    fn of(c: &DepthColumn) -> Self {
        let mut data = Vec::with_capacity(c.cells.len() * 4 + 4);
        put(&mut data, c.cells.len() as u64);
        let mut prev = c.cells.first().map_or(0, |x| x.tick);
        put(&mut data, zigzag(prev));
        for x in &c.cells {
            put(&mut data, (x.tick - prev) as u64);
            prev = x.tick;
            put(&mut data, (u64::from(x.decreases) << 1) | u64::from(x.bid));
            put(&mut data, quantize(x.mean));
        }
        Self {
            t: c.t,
            ended: c.ended,
            data: data.into_boxed_slice(),
        }
    }

    fn column(&self) -> DepthColumn {
        let d = &self.data;
        let mut at = 0;
        let n = get(d, &mut at) as usize;
        let mut tick = unzigzag(get(d, &mut at));
        let mut cells = Vec::with_capacity(n);
        for _ in 0..n {
            tick += get(d, &mut at) as i64;
            let flags = get(d, &mut at);
            let mean = get(d, &mut at) as f64 / MEAN_STEPS_PER_LOT;
            cells.push(DepthCell {
                tick,
                bid: flags & 1 == 1,
                mean,
                decreases: (flags >> 1) as u32,
            });
        }
        DepthColumn {
            t: self.t,
            ended: self.ended,
            cells,
        }
    }

    fn bytes(&self) -> usize {
        std::mem::size_of::<Self>() + self.data.len()
    }
}

fn quantize(mean: f64) -> u64 {
    (mean * MEAN_STEPS_PER_LOT).round().max(0.0) as u64
}

pub fn encode_minute(minute: i64, columns: &[DepthColumn]) -> Vec<u8> {
    let mut out = Vec::new();
    for c in columns {
        let p = Packed::of(c);
        put(&mut out, (c.t - minute).max(0) as u64);
        out.push(u8::from(c.ended));
        put(&mut out, p.data.len() as u64);
        out.extend_from_slice(&p.data);
    }
    out
}

pub fn decode_minute(minute: i64, blob: &[u8]) -> Vec<DepthColumn> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < blob.len() {
        let t = minute + get(blob, &mut at) as i64;
        let Some(&ended) = blob.get(at) else { break };
        at += 1;
        let len = get(blob, &mut at) as usize;
        let Some(data) = blob.get(at..at + len) else {
            break;
        };
        at += len;
        out.push(
            Packed {
                t,
                ended: ended == 1,
                data: data.into(),
            }
            .column(),
        );
    }
    out
}

fn second_of(t: i64) -> i64 {
    t.div_euclid(COLUMN_NS) * COLUMN_NS
}

type Book = HashMap<(bool, i64), f64>;

#[derive(Clone, Copy, Debug, Default)]
struct LevelSum {
    size_ns: f64,
    decreases: u32,
}

#[derive(Debug, Default)]
struct Accum {
    sec: Option<i64>,
    sums: HashMap<(bool, i64), LevelSum>,
    known: i64,
    held: Option<(i64, Book)>,
}

impl Accum {
    fn close(&mut self, out: &mut Vec<DepthColumn>) {
        let Some(sec) = self.sec.take() else { return };
        let known = std::mem::take(&mut self.known);
        let sums = std::mem::take(&mut self.sums);
        if known <= 0 {
            return;
        }
        let mut cells: Vec<DepthCell> = sums
            .into_iter()
            .map(|((bid, tick), sum)| DepthCell {
                tick,
                bid,
                mean: sum.size_ns / known as f64,
                decreases: sum.decreases,
            })
            .filter(|c| quantize(c.mean) > 0 || c.decreases > 0)
            .collect();
        cells.sort_by_key(|c| (c.tick, !c.bid));
        out.push(DepthColumn {
            t: sec,
            ended: false,
            cells,
        });
    }

    fn enter(&mut self, sec: i64, out: &mut Vec<DepthColumn>) {
        if self.sec != Some(sec) {
            self.close(out);
            self.sec = Some(sec);
        }
    }

    fn integrate(&mut self, until: i64, out: &mut Vec<DepthColumn>) {
        let Some((mut t, book)) = self.held.take() else {
            return;
        };
        while t < until {
            let sec = second_of(t);
            self.enter(sec, out);
            let end = until.min(sec + COLUMN_NS);
            self.hold(&book, end - t);
            t = end;
            if t == sec + COLUMN_NS && until - t >= 2 * COLUMN_NS {
                t = self.skip_repeated_seconds(&book, t, until, out);
            }
        }
        self.held = Some((t.max(until), book));
    }

    fn hold(&mut self, book: &Book, dt: i64) {
        for (k, size) in book {
            self.sums.entry(*k).or_default().size_ns += size * dt as f64;
        }
        self.known += dt;
    }

    fn skip_repeated_seconds(
        &mut self,
        book: &Book,
        sec: i64,
        until: i64,
        out: &mut Vec<DepthColumn>,
    ) -> i64 {
        self.enter(sec, out);
        self.hold(book, COLUMN_NS);
        self.close(out);
        second_of(until)
    }
}

#[derive(Debug, Default)]
pub struct DepthRecorder {
    tick: Option<Decimal>,
    acc: Accum,
    columns: VecDeque<Packed>,
    bytes: usize,
    last: Option<Packed>,
    outbox: Vec<DepthColumn>,
    archived: bool,
    recording: bool,
    feed: Option<u64>,
    generations: u64,
}

impl DepthRecorder {
    pub fn begin(&mut self) -> u64 {
        self.generations += 1;
        self.feed = Some(self.generations);
        self.generations
    }

    pub fn end(&mut self, generation: u64, at: i64) {
        if self.feed == Some(generation) {
            self.feed = None;
            self.on_lost(at);
        }
    }

    pub fn set_tick(&mut self, tick: Decimal) {
        if self.tick != Some(tick) && !tick.is_zero() {
            *self = Self {
                tick: Some(tick),
                archived: self.archived,
                feed: self.feed,
                generations: self.generations,
                ..Self::default()
            };
        }
    }

    pub fn tick(&self) -> Option<Decimal> {
        self.tick
    }

    pub fn set_archived(&mut self, archived: bool) {
        self.archived = archived;
    }

    pub fn is_recording(&self) -> bool {
        self.recording
    }

    fn ticks(&self, p: tessera_core::Price) -> Option<i64> {
        (p.0 / self.tick?).round().to_i64()
    }

    pub fn on_book(&mut self, book: &BookSnapshot) {
        if self.tick.is_none() {
            return;
        }
        let mut levels: Book = HashMap::with_capacity(2 * LEVELS);
        for (bid, side) in [(true, &book.bids), (false, &book.asks)] {
            for l in side.iter().take(LEVELS) {
                if let Some(t) = self.ticks(l.price) {
                    *levels.entry((bid, t)).or_default() += l.size.to_f64();
                }
            }
        }
        let mut out = Vec::new();
        let t = book
            .ts
            .0
            .max(self.acc.held.as_ref().map_or(i64::MIN, |h| h.0));
        self.acc.integrate(t, &mut out);
        self.acc.enter(second_of(t), &mut out);
        if let Some((_, old)) = &self.acc.held {
            for (k, before) in old {
                if levels.get(k).copied().unwrap_or(0.0) < *before {
                    self.acc.sums.entry(*k).or_default().decreases += 1;
                }
            }
        }
        self.acc.held = Some((t, levels));
        self.recording = true;
        self.store(out);
    }

    pub fn on_lost(&mut self, at: i64) {
        let mut out = Vec::new();
        let was = self.acc.held.is_some();
        let at = at.max(self.acc.held.as_ref().map_or(i64::MIN, |h| h.0));
        self.acc.integrate(at, &mut out);
        self.acc.close(&mut out);
        self.acc.held = None;
        self.recording = false;
        if was {
            out.push(DepthColumn {
                t: at,
                ended: true,
                cells: Vec::new(),
            });
        }
        self.store(out);
    }

    fn store(&mut self, columns: Vec<DepthColumn>) {
        for c in columns {
            let p = Packed::of(&c);
            if !c.ended
                && let Some(last) = &self.last
                && !last.ended
                && last.data == p.data
            {
                continue;
            }
            self.last = Some(p.clone());
            if self.archived {
                self.outbox.push(c);
            }
            self.bytes += p.bytes();
            self.columns.push_back(p);
        }
        let span = if self.archived {
            MEMORY_SPAN
        } else {
            MEMORY_SPAN_ALONE
        };
        let newest = self.columns.back().map_or(i64::MIN, |c| c.t);
        while let Some(first) = self.columns.front() {
            let old = first.t < newest - span.as_nanos() as i64;
            if !(old || self.bytes > MEMORY_BYTES) {
                break;
            }
            self.bytes -= first.bytes();
            self.columns.pop_front();
        }
    }

    pub fn take_minutes(&mut self, now: i64) -> Vec<(i64, Vec<u8>)> {
        let current = now.div_euclid(MINUTE_NS) * MINUTE_NS;
        let done = self.outbox.partition_point(|c| c.t < current);
        let mut out: BTreeMap<i64, Vec<DepthColumn>> = BTreeMap::new();
        for c in self.outbox.drain(..done) {
            out.entry(c.t.div_euclid(MINUTE_NS) * MINUTE_NS)
                .or_default()
                .push(c);
        }
        out.into_iter()
            .map(|(m, cs)| (m, encode_minute(m, &cs)))
            .collect()
    }

    pub fn columns(&self, from: i64, to: i64) -> Vec<DepthColumn> {
        let start = self
            .columns
            .partition_point(|c| c.t <= from)
            .saturating_sub(1);
        self.columns
            .range(start..)
            .take_while(|c| c.t < to)
            .map(Packed::column)
            .collect()
    }

    pub fn first(&self) -> Option<i64> {
        self.columns.front().map(|c| c.t)
    }

    pub fn last_t(&self) -> Option<i64> {
        self.columns.back().map(|c| c.t)
    }

    pub fn held_until(&self) -> Option<i64> {
        self.acc.held.as_ref().map(|h| h.0)
    }

    pub fn len(&self) -> usize {
        self.columns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.columns.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

fn holds(columns: &[DepthColumn], end: i64) -> impl Iterator<Item = (&DepthColumn, i64, i64)> {
    columns.iter().enumerate().filter_map(move |(i, c)| {
        if c.ended {
            return None;
        }
        let to = columns.get(i + 1).map_or(end, |n| n.t);
        (to > c.t).then_some((c, c.t, to))
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LevelStat {
    pub tick: i64,
    pub bid: bool,
    pub mean: f64,
    pub max: f64,
    pub decreases: u64,
    pub present: i64,
}

pub fn level_stats(columns: &[DepthColumn], end: i64, from: i64, to: i64) -> (Vec<LevelStat>, i64) {
    let mut by: HashMap<(bool, i64), LevelStat> = HashMap::new();
    let mut known = 0i64;
    for (c, a, b) in holds(columns, end) {
        let (a, b) = (a.max(from), b.min(to));
        if a >= b {
            continue;
        }
        let dt = b - a;
        known += dt;
        let column_second_in_span = c.t >= from && c.t < to;
        for cell in &c.cells {
            let s = by.entry((cell.bid, cell.tick)).or_insert(LevelStat {
                tick: cell.tick,
                bid: cell.bid,
                mean: 0.0,
                max: 0.0,
                decreases: 0,
                present: 0,
            });
            s.mean += cell.mean * dt as f64;
            s.max = s.max.max(cell.mean);
            if column_second_in_span {
                s.decreases += u64::from(cell.decreases);
            }
            if cell.mean > 0.0 {
                s.present += dt;
            }
        }
    }
    let mut out: Vec<LevelStat> = by
        .into_values()
        .map(|mut s| {
            s.mean = if known > 0 {
                s.mean / known as f64
            } else {
                0.0
            };
            s
        })
        .collect();
    out.sort_by(|a, b| b.mean.total_cmp(&a.mean).then(a.tick.cmp(&b.tick)));
    (out, known)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::market::DepthLevel;
    use tessera_core::{Price, Qty, Timestamp};

    const S: i64 = COLUMN_NS;

    #[test]
    fn varints_round_trip() {
        let mut buf = Vec::new();
        for v in [0i64, 1, -1, 63, -64, 300, -70_000, i64::from(i32::MAX)] {
            put(&mut buf, zigzag(v));
        }
        let mut at = 0;
        for v in [0i64, 1, -1, 63, -64, 300, -70_000, i64::from(i32::MAX)] {
            assert_eq!(unzigzag(get(&buf, &mut at)), v);
        }
    }

    /// In f64, `4.35 / 0.01` is `434.99999999999994`.
    #[test]
    fn price_bounds_snap_to_their_tick() {
        assert_eq!(tick_range(0.01, Some(4.35), Some(4.35)), (435, 435));
        assert_eq!(tick_range(0.01, Some(1.13), Some(0.29 + 1.0)), (113, 129));
        assert_eq!(tick_range(0.01, Some(0.29), None), (29, i64::MAX));
        assert_eq!(
            tick_range(0.25, Some(20641.1), Some(20641.9)),
            (82565, 82567)
        );
    }

    fn book(t: i64, bids: &[(&str, i64)], asks: &[(&str, i64)]) -> BookSnapshot {
        let side = |ls: &[(&str, i64)]| {
            ls.iter()
                .map(|(p, s)| DepthLevel {
                    price: Price::from_str(p).unwrap(),
                    size: Qty::from(*s),
                    orders: None,
                })
                .collect()
        };
        BookSnapshot {
            instrument: InstrumentId::new("ESZ6.CME").unwrap(),
            ts: Timestamp(t),
            bids: side(bids),
            asks: side(asks),
        }
    }

    fn recorder() -> DepthRecorder {
        let mut r = DepthRecorder::default();
        r.set_tick(Decimal::from_str("0.25").unwrap());
        r
    }

    fn cell(c: &DepthColumn, tick: i64, bid: bool) -> Option<DepthCell> {
        c.cells
            .iter()
            .find(|x| x.tick == tick && x.bid == bid)
            .copied()
    }

    #[test]
    fn columns_are_time_weighted_means_with_decreases() {
        let mut r = recorder();
        r.on_book(&book(10 * S, &[("100.00", 10)], &[("100.25", 7)]));
        r.on_book(&book(10 * S + S / 4, &[("100.00", 40)], &[("100.25", 7)]));
        r.on_book(&book(11 * S, &[("100.00", 10)], &[("100.25", 7)]));
        r.on_book(&book(11 * S + S / 2, &[], &[("100.25", 7)]));
        r.on_book(&book(12 * S, &[], &[("100.25", 7)]));
        let cols = r.columns(0, 20 * S);
        assert_eq!(cols.len(), 2, "{cols:#?}");
        let (a, b) = (&cols[0], &cols[1]);
        assert_eq!(a.t, 10 * S);
        assert_eq!(cell(a, 400, true).unwrap().mean, 32.5);
        assert_eq!(cell(a, 400, true).unwrap().decreases, 0);
        assert_eq!(cell(a, 401, false).unwrap().mean, 7.0);
        assert_eq!(b.t, 11 * S);
        let bid = cell(b, 400, true).unwrap();
        assert_eq!(
            (bid.mean, bid.decreases),
            (5.0, 2),
            "fell at 11 s and at 11.5 s"
        );
        assert!(
            b.cells
                .windows(2)
                .all(|w| (w[0].tick, !w[0].bid) < (w[1].tick, !w[1].bid))
        );
    }

    #[test]
    fn a_quiet_book_holds_and_a_stop_ends_the_recording() {
        let mut r = recorder();
        r.on_book(&book(100 * S, &[("100.00", 10)], &[]));
        r.on_book(&book(3_700 * S, &[("100.00", 10)], &[]));
        assert_eq!(r.len(), 1);
        r.on_lost(3_700 * S + S / 2);
        assert!(!r.is_recording());
        let cols = r.columns(0, i64::MAX);
        assert_eq!(cols.len(), 2);
        assert!(cols[1].ended && cols[1].t == 3_700 * S + S / 2);
        r.on_book(&book(5_000 * S, &[("101.00", 3)], &[]));
        r.on_book(&book(5_001 * S, &[("101.00", 3)], &[]));
        let cols = r.columns(0, i64::MAX);
        assert_eq!(cols.len(), 3);
        let (_, known) = level_stats(&cols, 5_002 * S, 0, i64::MAX);
        assert_eq!(known, 3_600 * S + S / 2 + 2 * S);
        let (_, known) = level_stats(&cols, 5_002 * S, 3_800 * S, 4_000 * S);
        assert_eq!(known, 0, "unknown across the gap");
    }

    #[test]
    fn levels_weigh_time_and_keep_the_largest_mean() {
        let mut r = recorder();
        r.on_book(&book(0, &[("100.00", 2)], &[]));
        r.on_book(&book(S, &[("100.00", 50)], &[]));
        r.on_book(&book(2 * S, &[("100.00", 2)], &[]));
        r.on_book(&book(4 * S, &[("100.00", 2)], &[]));
        let cols = r.columns(0, i64::MAX);
        let (stats, known) = level_stats(&cols, 4 * S, 0, 4 * S);
        assert_eq!(known, 4 * S);
        let s = stats[0];
        assert_eq!(
            (s.mean, s.max, s.decreases, s.present),
            (14.0, 50.0, 1, 4 * S)
        );
    }

    #[test]
    fn minutes_round_trip_and_are_archived_once() {
        let mut r = recorder();
        r.set_archived(true);
        r.on_book(&book(59 * S, &[("100.00", 2)], &[("100.50", 1)]));
        r.on_book(&book(61 * S, &[("100.25", 3)], &[]));
        r.on_book(&book(62 * S, &[("100.25", 4)], &[]));
        let minutes = r.take_minutes(62 * S);
        assert_eq!(minutes.len(), 1);
        let (m, blob) = &minutes[0];
        assert_eq!(*m, 0);
        let back = decode_minute(*m, blob);
        assert_eq!(back, r.columns(0, 60 * S));
        assert!(r.take_minutes(62 * S).is_empty());
        assert_eq!(r.take_minutes(200 * S).len(), 1);
    }
}
