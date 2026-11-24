use std::path::Path;

use rusqlite::{Connection, OptionalExtension, ToSql, params};
use tessera_core::Timestamp;
use tessera_core::market::Bar;
use tessera_core::money::{Price, Qty};

use crate::block::{BlockTable, Rows, SameTime, cover, pack, unpack};
use crate::codec::{Reader, Scales, decimal, mantissa, put, put_head, unzigzag, zigzag};
use crate::error::Result;
use crate::local::{LocalDb, Setup};
use crate::migrate::{Migration, migrate_with};

const FORMAT: u8 = 1;

pub const BAR_MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "bars",
    sql: include_str!("../migrations/bars/0001_bars.sql"),
    earlier_checksums: &[],
}];

const SETUP: Setup = Setup {
    before_wal: "",
    schema: |conn: &mut Connection| migrate_with(conn, BAR_MIGRATIONS).map(drop),
};

const BLOCKS: BlockTable = BlockTable {
    name: "bar_blocks",
    count: "bars",
    same_time: SameTime::NewestWins,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SeriesKey<'a> {
    pub source: &'a str,
    pub instrument: &'a str,
    pub series: &'a str,
}

impl SeriesKey<'_> {
    fn columns(&self) -> [(&'static str, &dyn ToSql); 3] {
        [
            ("source", &self.source),
            ("instrument", &self.instrument),
            ("series", &self.series),
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Span {
    pub start: i64,
    pub end: i64,
}

impl Span {
    pub const fn new(start: i64, end: i64) -> Self {
        Self { start, end }
    }

    pub const fn is_empty(&self) -> bool {
        self.end <= self.start
    }

    pub const fn contains(&self, t: i64) -> bool {
        t >= self.start && t < self.end
    }

    pub const fn len(&self) -> i64 {
        self.end - self.start
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockInfo {
    pub block: i64,
    pub bars: usize,
    pub bytes: usize,
}

#[derive(Debug)]
pub struct BarStore {
    db: LocalDb,
}

impl BarStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            db: LocalDb::open(path.as_ref(), &SETUP)?,
        })
    }

    pub fn open_in_dir(dir: impl AsRef<Path>) -> Result<Self> {
        Self::open(crate::DataDir::new(dir.as_ref()).bars())
    }

    pub fn open_in_memory() -> Result<Self> {
        Ok(Self {
            db: LocalDb::open_in_memory(&SETUP)?,
        })
    }

    pub fn write(
        &self,
        key: SeriesKey<'_>,
        bars: &[Bar],
        block_of: impl Fn(Timestamp) -> i64,
        covered: Option<Span>,
    ) -> Result<()> {
        let mut by_block: std::collections::BTreeMap<i64, Vec<Bar>> = Default::default();
        for b in bars {
            by_block.entry(block_of(b.t)).or_default().push(*b);
        }
        let mut conn = self.db.lock();
        let tx = conn.transaction()?;
        for (block, new) in by_block {
            BLOCKS.merge(&tx, &key.columns(), &[], block, new)?;
        }
        if let Some(span) = covered.filter(|s| !s.is_empty()) {
            cover(&tx, "bar_coverage", &key.columns(), span)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn read(&self, key: SeriesKey<'_>, from: i64, to: i64) -> Result<Vec<Bar>> {
        if to <= from {
            return Ok(Vec::new());
        }
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT data FROM bar_blocks
             WHERE source = ?1 AND instrument = ?2 AND series = ?3 AND last_t >= ?4 AND first_t < ?5
             ORDER BY first_t",
        )?;
        let rows = stmt.query_map(
            params![key.source, key.instrument, key.series, from, to],
            |r| r.get::<_, Vec<u8>>(0),
        )?;
        let mut out = Vec::new();
        for row in rows {
            let bars = unpack::<Bar>(&row?)?;
            out.extend(bars.into_iter().filter(|b| b.t.0 >= from && b.t.0 < to));
        }
        out.sort_by_key(|b| b.t);
        Ok(out)
    }

    pub fn covered(&self, key: SeriesKey<'_>) -> Result<Vec<Span>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT start, end FROM bar_coverage
             WHERE source = ?1 AND instrument = ?2 AND series = ?3 ORDER BY start",
        )?;
        let rows = stmt.query_map(params![key.source, key.instrument, key.series], |r| {
            Ok(Span::new(r.get(0)?, r.get(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn missing(&self, key: SeriesKey<'_>, from: i64, to: i64) -> Result<Vec<Span>> {
        Ok(holes(&self.covered(key)?, Span::new(from, to)))
    }

    pub fn covering(&self, key: SeriesKey<'_>, t: i64) -> Result<Option<Span>> {
        Ok(self
            .db
            .lock()
            .query_row(
                "SELECT start, end FROM bar_coverage
                 WHERE source = ?1 AND instrument = ?2 AND series = ?3 AND start <= ?4
                 ORDER BY start DESC LIMIT 1",
                params![key.source, key.instrument, key.series, t],
                |r| Ok(Span::new(r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .filter(|s| s.contains(t)))
    }

    pub fn blocks(&self, key: SeriesKey<'_>) -> Result<Vec<BlockInfo>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT block, bars, length(data) FROM bar_blocks
             WHERE source = ?1 AND instrument = ?2 AND series = ?3 ORDER BY block",
        )?;
        let rows = stmt.query_map(params![key.source, key.instrument, key.series], |r| {
            Ok(BlockInfo {
                block: r.get(0)?,
                bars: r.get::<_, i64>(1)? as usize,
                bytes: r.get::<_, i64>(2)? as usize,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn forget_before(&self, key: SeriesKey<'_>, t: i64) -> Result<usize> {
        let mut conn = self.db.lock();
        let tx = conn.transaction()?;
        let at = params![key.source, key.instrument, key.series, t];
        let series = "source = ?1 AND instrument = ?2 AND series = ?3";
        let straddling: Vec<(i64, Vec<u8>)> = tx
            .prepare(&format!(
                "SELECT block, data FROM bar_blocks WHERE {series} AND first_t < ?4 AND last_t >= ?4"
            ))?
            .query_map(at, |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut gone: i64 = tx.query_row(
            &format!(
                "SELECT coalesce(sum(bars), 0) FROM bar_blocks WHERE {series} AND last_t < ?4"
            ),
            at,
            |r| r.get(0),
        )?;
        tx.execute(
            &format!("DELETE FROM bar_blocks WHERE {series} AND last_t < ?4"),
            at,
        )?;
        for (block, data) in straddling {
            let held = unpack::<Bar>(&data)?;
            let kept: Vec<Bar> = held.iter().filter(|b| b.t.0 >= t).copied().collect();
            gone += (held.len() - kept.len()) as i64;
            let first_t = kept.first().map_or(t, |b| b.t.0);
            tx.execute(
                &format!(
                    "UPDATE bar_blocks SET first_t = ?5, bars = ?6, data = ?7 WHERE {series} AND block = ?4"
                ),
                params![
                    key.source,
                    key.instrument,
                    key.series,
                    block,
                    first_t,
                    kept.len() as i64,
                    pack(&kept)?
                ],
            )?;
        }
        tx.execute(
            &format!("DELETE FROM bar_coverage WHERE {series} AND end <= ?4"),
            at,
        )?;
        tx.execute(
            &format!("UPDATE bar_coverage SET start = ?4 WHERE {series} AND start < ?4"),
            at,
        )?;
        tx.commit()?;
        Ok(gone as usize)
    }

    pub fn clear(&self, source: Option<&str>) -> Result<usize> {
        let mut conn = self.db.lock();
        let tx = conn.transaction()?;
        let n = match source {
            Some(s) => {
                tx.execute("DELETE FROM bar_coverage WHERE source = ?1", params![s])?;
                tx.execute("DELETE FROM bar_blocks WHERE source = ?1", params![s])?
            }
            None => {
                tx.execute("DELETE FROM bar_coverage", [])?;
                tx.execute("DELETE FROM bar_blocks", [])?
            }
        };
        tx.commit()?;
        Ok(n)
    }
}

pub fn holes(covered: &[Span], want: Span) -> Vec<Span> {
    let mut out = Vec::new();
    if want.is_empty() {
        return out;
    }
    let mut at = want.start;
    for s in covered {
        if s.end <= at {
            continue;
        }
        if s.start >= want.end {
            break;
        }
        if s.start > at {
            out.push(Span::new(at, s.start.min(want.end)));
        }
        at = at.max(s.end);
        if at >= want.end {
            break;
        }
    }
    if at < want.end {
        out.push(Span::new(at, want.end));
    }
    out
}

impl Rows for Bar {
    const WHAT: &'static str = "a bar block";

    fn t(&self) -> i64 {
        self.t.0
    }

    fn encode(bars: &[Self]) -> Result<Vec<u8>> {
        encode(bars)
    }

    fn decode(raw: &[u8]) -> Result<Vec<Self>> {
        decode(raw)
    }
}

fn encode(bars: &[Bar]) -> Result<Vec<u8>> {
    let scales = Scales::of(
        bars.iter().flat_map(|b| [b.o.0, b.h.0, b.l.0, b.c.0]),
        bars.iter()
            .flat_map(|b| [Some(b.v), b.bv])
            .flatten()
            .map(|q| q.0),
    );
    let int = |d, scale| mantissa(d, scale, Bar::WHAT);
    let mut out = Vec::with_capacity(bars.len() * 12 + 8);
    let times: Vec<i64> = bars.iter().map(|b| b.t.0).collect();
    put_head(&mut out, FORMAT, scales, &times);
    let mut ohlc = Vec::with_capacity(bars.len());
    for b in bars {
        ohlc.push([
            int(b.o.0, scales.price)?,
            int(b.h.0, scales.price)?,
            int(b.l.0, scales.price)?,
            int(b.c.0, scales.price)?,
        ]);
    }
    let mut close = 0i64;
    for [o, _, _, c] in &ohlc {
        put(&mut out, zigzag(o - close));
        close = *c;
    }
    for [o, h, _, _] in &ohlc {
        put(&mut out, zigzag(h - o));
    }
    for [o, _, l, _] in &ohlc {
        put(&mut out, zigzag(o - l));
    }
    for [_, _, l, c] in &ohlc {
        put(&mut out, zigzag(c - l));
    }
    for b in bars {
        put(&mut out, zigzag(int(b.v.0, scales.qty)?));
    }
    for b in bars {
        match b.bv {
            Some(bv) => put(&mut out, zigzag(int(bv.0, scales.qty)?) + 1),
            None => put(&mut out, 0),
        }
    }
    Ok(out)
}

fn decode(raw: &[u8]) -> Result<Vec<Bar>> {
    let mut r = Reader::new(raw, Bar::WHAT);
    let (scales, t) = r.head(FORMAT)?;
    let n = t.len();
    let mut o = Vec::with_capacity(n);
    let mut h = Vec::with_capacity(n);
    let mut l = Vec::with_capacity(n);
    let mut c = Vec::with_capacity(n);
    let mut open_steps = Vec::with_capacity(n);
    for _ in 0..n {
        open_steps.push(r.signed()?);
    }
    let mut high_steps = Vec::with_capacity(n);
    for _ in 0..n {
        high_steps.push(r.signed()?);
    }
    let mut low_steps = Vec::with_capacity(n);
    for _ in 0..n {
        low_steps.push(r.signed()?);
    }
    let mut close_steps = Vec::with_capacity(n);
    for _ in 0..n {
        close_steps.push(r.signed()?);
    }
    let mut close = 0i64;
    for i in 0..n {
        let open = close + open_steps[i];
        let low = open - low_steps[i];
        close = low + close_steps[i];
        o.push(open);
        h.push(open + high_steps[i]);
        l.push(low);
        c.push(close);
    }
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        v.push(r.signed()?);
    }
    let price = |m| Price(decimal(m, scales.price));
    let qty = |m| Qty(decimal(m, scales.qty));
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let bv = match r.varint()? {
            0 => None,
            x => Some(qty(unzigzag(x - 1))),
        };
        out.push(Bar {
            t: Timestamp(t[i]),
            o: price(o[i]),
            h: price(h[i]),
            l: price(l[i]),
            c: price(c[i]),
            v: qty(v[i]),
            bv,
        });
    }
    if !r.done() {
        return Err(r.malformed("trailing bytes"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use rust_decimal::Decimal;
    use tessera_core::time::NANOS_PER_MINUTE;

    use super::*;

    const KEY: SeriesKey<'static> = SeriesKey {
        source: "rithmic-apex",
        instrument: "NQZ6.CME",
        series: "1m",
    };
    const T0: i64 = 1_791_379_800_000_000_000;

    fn price(s: &str) -> Price {
        Price(Decimal::from_str(s).unwrap())
    }

    fn minutes(start: i64, n: usize) -> Vec<Bar> {
        let mut px = Decimal::from_str("24810.25").unwrap();
        let q = Decimal::from_str("0.25").unwrap();
        (0..n)
            .map(|i| {
                let step = Decimal::from(((i * 7) % 5) as i64 - 2) * q;
                let o = px;
                let c = px + step;
                px = c;
                Bar {
                    t: Timestamp(start + i as i64 * NANOS_PER_MINUTE),
                    o: Price(o),
                    h: Price(o.max(c) + q * Decimal::from(i as i64 % 3)),
                    l: Price(o.min(c) - q),
                    c: Price(c),
                    v: Qty::from(100 + (i as i64 * 37) % 900),
                    bv: (i % 4 != 0).then(|| Qty::from(40 + (i as i64 * 13) % 50)),
                }
            })
            .collect()
    }

    fn day(t: Timestamp) -> i64 {
        t.0.div_euclid(86_400_000_000_000)
    }

    #[test]
    fn blocks_round_trip_bar_for_bar() {
        let s = BarStore::open_in_memory().unwrap();
        let bars = minutes(T0, 3_000);
        s.write(KEY, &bars, day, None).unwrap();
        let back = s.read(KEY, T0, T0 + 3_000 * NANOS_PER_MINUTE).unwrap();
        assert_eq!(back, bars);
        let odd = vec![Bar {
            t: Timestamp(T0),
            o: price("64123.5"),
            h: price("64130.125"),
            l: price("64100"),
            c: price("64129.0001"),
            v: Qty(Decimal::from_str("0.0042").unwrap()),
            bv: Some(Qty(Decimal::from_str("0.001").unwrap())),
        }];
        let other = SeriesKey {
            instrument: "BTCUSD",
            ..KEY
        };
        s.write(other, &odd, day, None).unwrap();
        assert_eq!(s.read(other, T0, T0 + 1).unwrap(), odd);
        let cut = s
            .read(KEY, T0 + 10 * NANOS_PER_MINUTE, T0 + 20 * NANOS_PER_MINUTE)
            .unwrap();
        assert_eq!(cut, bars[10..20]);
    }

    #[test]
    fn blocks_are_small() {
        let s = BarStore::open_in_memory().unwrap();
        let bars = minutes(T0, 1_380);
        s.write(KEY, &bars, |_| 20261007, None).unwrap();
        let blocks = s.blocks(KEY).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].bars, 1_380);
        let per_bar = blocks[0].bytes as f64 / 1_380.0;
        assert!(per_bar < 8.0, "{per_bar:.1} bytes a bar");
    }

    #[test]
    fn a_block_written_again_merges_and_the_new_bar_wins() {
        let s = BarStore::open_in_memory().unwrap();
        let bars = minutes(T0, 10);
        s.write(KEY, &bars[..6], day, None).unwrap();
        let mut changed = bars[5];
        changed.c = changed.h;
        let mut later = vec![changed];
        later.extend_from_slice(&bars[6..]);
        s.write(KEY, &later, day, None).unwrap();
        let back = s.read(KEY, T0, T0 + 10 * NANOS_PER_MINUTE).unwrap();
        assert_eq!(back.len(), 10);
        assert_eq!(back[5], changed);
        assert_eq!(back[..5], bars[..5]);
        assert_eq!(s.blocks(KEY).unwrap().len(), 1);
    }

    #[test]
    fn coverage_merges_and_names_the_holes() {
        let s = BarStore::open_in_memory().unwrap();
        let m = NANOS_PER_MINUTE;
        assert_eq!(s.missing(KEY, 0, 100 * m).unwrap(), [Span::new(0, 100 * m)]);
        s.write(KEY, &[], day, Some(Span::new(10 * m, 20 * m)))
            .unwrap();
        s.write(KEY, &[], day, Some(Span::new(40 * m, 50 * m)))
            .unwrap();
        assert_eq!(
            s.missing(KEY, 0, 100 * m).unwrap(),
            [
                Span::new(0, 10 * m),
                Span::new(20 * m, 40 * m),
                Span::new(50 * m, 100 * m)
            ]
        );
        assert_eq!(s.missing(KEY, 12 * m, 18 * m).unwrap(), []);
        assert_eq!(
            s.missing(KEY, 15 * m, 45 * m).unwrap(),
            [Span::new(20 * m, 40 * m)]
        );
        s.write(KEY, &[], day, Some(Span::new(20 * m, 25 * m)))
            .unwrap();
        assert_eq!(
            s.covered(KEY).unwrap(),
            [Span::new(10 * m, 25 * m), Span::new(40 * m, 50 * m)]
        );
        s.write(KEY, &[], day, Some(Span::new(5 * m, 60 * m)))
            .unwrap();
        assert_eq!(s.covered(KEY).unwrap(), [Span::new(5 * m, 60 * m)]);
        assert_eq!(
            s.covering(KEY, 59 * m).unwrap(),
            Some(Span::new(5 * m, 60 * m))
        );
        assert_eq!(s.covering(KEY, 60 * m).unwrap(), None);
        assert_eq!(s.covering(KEY, 0).unwrap(), None);
        let daily = SeriesKey {
            series: "1D",
            ..KEY
        };
        assert_eq!(s.covered(daily).unwrap(), []);
    }

    #[test]
    fn a_partial_day_is_kept_and_completed_later() {
        let s = BarStore::open_in_memory().unwrap();
        let m = NANOS_PER_MINUTE;
        let bars = minutes(T0, 600);
        s.write(KEY, &bars[..200], day, Some(Span::new(T0, T0 + 200 * m)))
            .unwrap();
        let hole = s.missing(KEY, T0, T0 + 600 * m).unwrap();
        assert_eq!(hole, [Span::new(T0 + 200 * m, T0 + 600 * m)]);
        s.write(KEY, &bars[200..], day, Some(hole[0])).unwrap();
        assert_eq!(s.missing(KEY, T0, T0 + 600 * m).unwrap(), []);
        assert_eq!(s.blocks(KEY).unwrap().len(), 1);
        assert_eq!(s.read(KEY, T0, T0 + 600 * m).unwrap(), bars);
    }

    #[test]
    fn clearing_forgets_a_source() {
        let s = BarStore::open_in_memory().unwrap();
        let other = SeriesKey {
            source: "rithmic-topstep",
            ..KEY
        };
        let span = Some(Span::new(T0, T0 + NANOS_PER_MINUTE));
        s.write(KEY, &minutes(T0, 1), day, span).unwrap();
        s.write(other, &minutes(T0, 1), day, span).unwrap();
        assert_eq!(s.clear(Some("rithmic-apex")).unwrap(), 1);
        assert_eq!(s.covered(KEY).unwrap(), []);
        assert_eq!(s.read(other, T0, T0 + 1).unwrap().len(), 1);
        assert_eq!(s.clear(None).unwrap(), 1);
    }

    #[test]
    fn forgetting_before_a_time_drops_older_bars_and_coverage_and_keeps_the_rest() {
        let s = BarStore::open_in_memory().unwrap();
        let m = NANOS_PER_MINUTE;
        let bars = minutes(T0, 3_000);
        s.write(KEY, &bars, day, Some(Span::new(T0, T0 + 3_000 * m)))
            .unwrap();
        s.write(KEY, &[], day, Some(Span::new(T0 - 500 * m, T0 - 100 * m)))
            .unwrap();
        let other = SeriesKey {
            instrument: "ESZ6.CME",
            ..KEY
        };
        s.write(other, &bars, day, Some(Span::new(T0, T0 + 3_000 * m)))
            .unwrap();
        let cut = T0 + 2_000 * m;
        let held_before = s.blocks(KEY).unwrap().len();
        assert_eq!(s.forget_before(KEY, cut).unwrap(), 2_000);
        assert_eq!(s.read(KEY, 0, i64::MAX).unwrap(), bars[2_000..]);
        assert_eq!(s.covered(KEY).unwrap(), [Span::new(cut, T0 + 3_000 * m)]);
        assert!(s.blocks(KEY).unwrap().len() < held_before);
        assert_eq!(
            s.blocks(KEY).unwrap().iter().map(|b| b.bars).sum::<usize>(),
            1_000
        );
        assert_eq!(s.read(other, 0, i64::MAX).unwrap(), bars);
        assert_eq!(s.forget_before(KEY, cut).unwrap(), 0);
    }

    #[test]
    fn a_file_store_keeps_bars_between_opens_and_refuses_a_bad_block() {
        let dir = tempfile::tempdir().unwrap();
        let bars = minutes(T0, 5);
        BarStore::open_in_dir(dir.path())
            .unwrap()
            .write(KEY, &bars, day, None)
            .unwrap();
        let s = BarStore::open_in_dir(dir.path()).unwrap();
        assert_eq!(s.read(KEY, T0, T0 + 5 * NANOS_PER_MINUTE).unwrap(), bars);
        assert!(decode(&[9, 0, 0, 0]).is_err());
        assert!(decode(&encode(&bars).unwrap()[..20]).is_err());
    }

    #[test]
    fn holes_of_unsorted_edges() {
        let c = [Span::new(0, 10), Span::new(20, 30)];
        assert_eq!(holes(&c, Span::new(0, 30)), [Span::new(10, 20)]);
        assert_eq!(holes(&c, Span::new(25, 40)), [Span::new(30, 40)]);
        assert_eq!(holes(&c, Span::new(-5, 5)), [Span::new(-5, 0)]);
        assert_eq!(holes(&c, Span::new(5, 5)), []);
        assert_eq!(holes(&[], Span::new(1, 2)), [Span::new(1, 2)]);
    }
}
