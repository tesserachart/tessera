use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use chrono::NaiveDate;
use rusqlite::{Connection, OptionalExtension, ToSql, Transaction, TransactionBehavior, params};
use tessera_core::market::{Aggressor, AggressorSource, DataSource, Trade};
use tessera_core::money::{Price, Qty};
use tessera_core::{InstrumentId, Timestamp};

pub use crate::bars::{Span, holes};
use crate::block::{BlockTable, Rows, SameTime, cover, unpack};
use crate::codec::{Reader, Scales, decimal, mantissa, put, put_head, zigzag};
use crate::error::{Result, StoreError};
use crate::local::{LocalDb, Setup};
use crate::migrate::{Migration, migrate_with};

pub const BLOCK_NS: i64 = 5 * 60 * 1_000_000_000;

const FORMAT: u8 = 1;
const DATE: &str = "%Y-%m-%d";

pub const TICK_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "ticks",
        sql: include_str!("../migrations/ticks/0001_ticks.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 2,
        name: "history",
        sql: include_str!("../migrations/ticks/0002_history.sql"),
        earlier_checksums: &[],
    },
];

const SETUP: Setup = Setup {
    before_wal: "PRAGMA auto_vacuum = INCREMENTAL;",
    schema: |conn: &mut Connection| migrate_with(conn, TICK_MIGRATIONS).map(drop),
};

const BLOCKS: BlockTable = BlockTable {
    name: "tick_blocks",
    count: "prints",
    same_time: SameTime::KeepAll,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TickKey<'a> {
    pub source: &'a str,
    pub instrument: &'a str,
}

impl TickKey<'_> {
    fn columns(&self) -> [(&'static str, &dyn ToSql); 2] {
        [("source", &self.source), ("instrument", &self.instrument)]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickRow {
    pub t: i64,
    pub price: Price,
    pub size: Qty,
    pub aggressor: Aggressor,
    pub aggressor_source: AggressorSource,
    pub order_key: Option<u32>,
}

impl TickRow {
    pub fn of(t: &Trade) -> Self {
        Self {
            t: t.ts.0,
            price: t.price,
            size: t.size,
            aggressor: t.aggressor,
            aggressor_source: t.aggressor_source,
            order_key: t.order_key,
        }
    }

    pub fn trade(&self, instrument: &InstrumentId, source: Option<&DataSource>) -> Trade {
        Trade {
            instrument: instrument.clone(),
            ts: Timestamp(self.t),
            price: self.price,
            size: self.size,
            aggressor: self.aggressor,
            aggressor_source: self.aggressor_source,
            order_key: self.order_key,
            source: source.cloned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedDay {
    pub trade_date: NaiveDate,
    pub prints: u64,
    pub bytes: u64,
    pub covered: Vec<Span>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryDay {
    pub source: String,
    pub day: NaiveDate,
    pub requests: u64,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedContract {
    pub source: String,
    pub instrument: String,
    pub days: usize,
    pub prints: u64,
    pub bytes: u64,
}

#[derive(Debug)]
pub struct TickStore {
    db: LocalDb,
}

impl TickStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            db: LocalDb::open(path.as_ref(), &SETUP)?,
        })
    }

    pub fn open_in_dir(data_dir: impl AsRef<Path>) -> Result<Self> {
        Self::open(crate::DataDir::new(data_dir.as_ref()).ticks())
    }

    pub fn open_in_memory() -> Result<Self> {
        Ok(Self {
            db: LocalDb::open_in_memory(&SETUP)?,
        })
    }

    pub fn path(&self) -> Option<&Path> {
        self.db.path()
    }

    pub fn write(
        &self,
        key: TickKey<'_>,
        trade_date: NaiveDate,
        rows: &[TickRow],
        span: Span,
    ) -> Result<usize> {
        if span.is_empty() {
            return Ok(0);
        }
        let mut conn = self.db.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let open = holes(&covered_within(&tx, key, span)?, span);
        let mut by_block: BTreeMap<i64, Vec<TickRow>> = BTreeMap::new();
        let mut kept = 0;
        for r in rows.iter().filter(|r| open.iter().any(|h| h.contains(r.t))) {
            by_block
                .entry(r.t.div_euclid(BLOCK_NS) * BLOCK_NS)
                .or_default()
                .push(*r);
            kept += 1;
        }
        let date = trade_date.format(DATE).to_string();
        for (block, new) in by_block {
            BLOCKS.merge(&tx, &key.columns(), &[("trade_date", &date)], block, new)?;
        }
        cover(
            &tx,
            "tick_coverage",
            &[
                ("source", &key.source),
                ("instrument", &key.instrument),
                ("trade_date", &date),
            ],
            span,
        )?;
        tx.commit()?;
        Ok(kept)
    }

    pub fn read(&self, key: TickKey<'_>, from: i64, to: i64) -> Result<Vec<TickRow>> {
        if to <= from {
            return Ok(Vec::new());
        }
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT data FROM tick_blocks
             WHERE source = ?1 AND instrument = ?2 AND block < ?4 AND last_t >= ?3
             ORDER BY block",
        )?;
        let rows = stmt.query_map(params![key.source, key.instrument, from, to], |r| {
            r.get::<_, Vec<u8>>(0)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.extend(
                unpack::<TickRow>(&row?)?
                    .into_iter()
                    .filter(|p| p.t >= from && p.t < to),
            );
        }
        Ok(out)
    }

    pub fn covered(&self, key: TickKey<'_>, from: i64, to: i64) -> Result<Vec<Span>> {
        let conn = self.db.lock();
        let tx = conn.unchecked_transaction()?;
        covered_within(&tx, key, Span::new(from, to))
    }

    pub fn oldest(&self, key: TickKey<'_>) -> Result<Option<i64>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT min(start) FROM tick_coverage WHERE source = ?1 AND instrument = ?2",
        )?;
        Ok(stmt.query_row(params![key.source, key.instrument], |r| r.get(0))?)
    }

    pub fn missing(&self, key: TickKey<'_>, from: i64, to: i64) -> Result<Vec<Span>> {
        Ok(holes(&self.covered(key, from, to)?, Span::new(from, to)))
    }

    pub fn days(&self, key: TickKey<'_>) -> Result<Vec<SavedDay>> {
        let conn = self.db.lock();
        let mut days: BTreeMap<NaiveDate, SavedDay> = BTreeMap::new();
        let mut stmt = conn.prepare_cached(
            "SELECT trade_date, start, end FROM tick_coverage
             WHERE source = ?1 AND instrument = ?2 ORDER BY start",
        )?;
        let spans = stmt.query_map(params![key.source, key.instrument], |r| {
            Ok((r.get::<_, String>(0)?, Span::new(r.get(1)?, r.get(2)?)))
        })?;
        for row in spans {
            let (date, span) = row?;
            day_entry(&mut days, &date)?.covered.push(span);
        }
        let mut stmt = conn.prepare_cached(
            "SELECT trade_date, sum(prints), sum(length(data)) FROM tick_blocks
             WHERE source = ?1 AND instrument = ?2 GROUP BY trade_date",
        )?;
        let sizes = stmt.query_map(params![key.source, key.instrument], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in sizes {
            let (date, prints, bytes) = row?;
            let d = day_entry(&mut days, &date)?;
            d.prints = prints as u64;
            d.bytes = bytes as u64;
        }
        Ok(days.into_values().collect())
    }

    pub fn contracts(&self) -> Result<Vec<SavedContract>> {
        let conn = self.db.lock();
        let mut out: BTreeMap<(String, String), SavedContract> = BTreeMap::new();
        let mut stmt = conn.prepare_cached(
            "SELECT source, instrument, count(DISTINCT trade_date) FROM tick_coverage
             GROUP BY source, instrument",
        )?;
        let days = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in days {
            let (source, instrument, days) = row?;
            out.insert(
                (source.clone(), instrument.clone()),
                SavedContract {
                    source,
                    instrument,
                    days: days as usize,
                    prints: 0,
                    bytes: 0,
                },
            );
        }
        let mut stmt = conn.prepare_cached(
            "SELECT source, instrument, sum(prints), sum(length(data)) FROM tick_blocks
             GROUP BY source, instrument",
        )?;
        let sizes = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        for row in sizes {
            let (source, instrument, prints, bytes) = row?;
            if let Some(c) = out.get_mut(&(source, instrument)) {
                c.prints = prints as u64;
                c.bytes = bytes as u64;
            }
        }
        Ok(out.into_values().collect())
    }

    pub fn prune(
        &self,
        key: TickKey<'_>,
        keep: usize,
        protected: &BTreeSet<NaiveDate>,
    ) -> Result<Vec<NaiveDate>> {
        let mut conn = self.db.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let dates: Vec<String> = {
            let mut stmt = tx.prepare_cached(
                "SELECT trade_date FROM tick_coverage WHERE source = ?1 AND instrument = ?2
                 UNION
                 SELECT trade_date FROM tick_blocks WHERE source = ?1 AND instrument = ?2
                 ORDER BY 1 DESC",
            )?;
            stmt.query_map(params![key.source, key.instrument], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut gone = Vec::new();
        for date in dates.iter().skip(keep) {
            let d = parse_date(date)?;
            if protected.contains(&d) {
                continue;
            }
            tx.execute(
                "DELETE FROM tick_blocks WHERE source = ?1 AND instrument = ?2 AND trade_date = ?3",
                params![key.source, key.instrument, date],
            )?;
            tx.execute(
                "DELETE FROM tick_coverage WHERE source = ?1 AND instrument = ?2 AND trade_date = ?3",
                params![key.source, key.instrument, date],
            )?;
            gone.push(d);
        }
        tx.commit()?;
        if !gone.is_empty() {
            let mut vacuum = conn.prepare("PRAGMA incremental_vacuum")?;
            let mut freeing = vacuum.query([])?;
            while freeing.next()?.is_some() {}
            drop(freeing);
            drop(vacuum);
            if self.db.path().is_some() {
                conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            }
        }
        gone.sort();
        Ok(gone)
    }

    pub fn disk_bytes(&self) -> Result<u64> {
        match self.db.path() {
            Some(path) => {
                let mut total = 0;
                for suffix in ["", "-wal", "-shm"] {
                    let mut p = path.as_os_str().to_owned();
                    p.push(suffix);
                    if let Ok(m) = std::fs::metadata(&p) {
                        total += m.len();
                    }
                }
                Ok(total)
            }
            None => {
                let conn = self.db.lock();
                let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
                let size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
                Ok((pages * size) as u64)
            }
        }
    }

    pub fn set_contract(&self, key: TickKey<'_>, contract: &str) -> Result<()> {
        self.db.lock().execute(
            "INSERT INTO tick_contracts (source, instrument, contract) VALUES (?1, ?2, ?3)
             ON CONFLICT (source, instrument) DO UPDATE SET contract = excluded.contract",
            params![key.source, key.instrument, contract],
        )?;
        Ok(())
    }

    pub fn contract(&self, key: TickKey<'_>) -> Result<Option<String>> {
        Ok(self
            .db
            .lock()
            .query_row(
                "SELECT contract FROM tick_contracts WHERE source = ?1 AND instrument = ?2",
                params![key.source, key.instrument],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn refuse(&self, key: TickKey<'_>, span: Span, at: i64) -> Result<()> {
        self.db.lock().execute(
            "INSERT INTO tick_refusals (source, instrument, start, end, refused_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (source, instrument, start)
             DO UPDATE SET end = excluded.end, refused_at = excluded.refused_at",
            params![key.source, key.instrument, span.start, span.end, at],
        )?;
        Ok(())
    }

    pub fn refused_since(&self, key: TickKey<'_>, after: i64, since: i64) -> Result<Vec<Span>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT start, end FROM tick_refusals
             WHERE source = ?1 AND instrument = ?2 AND end > ?3 AND refused_at >= ?4
             ORDER BY start",
        )?;
        let rows = stmt.query_map(params![key.source, key.instrument, after, since], |r| {
            Ok(Span::new(r.get(0)?, r.get(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_history_use(
        &self,
        source: &str,
        day: NaiveDate,
        requests: u64,
        bytes: u64,
    ) -> Result<()> {
        self.db.lock().execute(
            "INSERT INTO history_use (source, day, requests, bytes) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (source, day) DO UPDATE SET
               requests = requests + excluded.requests, bytes = bytes + excluded.bytes",
            params![
                source,
                day.format(DATE).to_string(),
                i64::try_from(requests).unwrap_or(i64::MAX),
                i64::try_from(bytes).unwrap_or(i64::MAX)
            ],
        )?;
        Ok(())
    }

    pub fn history_use(&self) -> Result<Vec<HistoryDay>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT source, day, requests, bytes FROM history_use ORDER BY source, day",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (source, day, requests, bytes) = row?;
            out.push(HistoryDay {
                source,
                day: parse_date(&day)?,
                requests: requests.max(0) as u64,
                bytes: bytes.max(0) as u64,
            });
        }
        Ok(out)
    }

    pub fn put_pull(&self, id: &str, body: &str, updated: i64) -> Result<()> {
        self.db.lock().execute(
            "INSERT INTO tick_pulls (id, body, updated) VALUES (?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated = excluded.updated",
            params![id, body, updated],
        )?;
        Ok(())
    }

    pub fn pulls(&self) -> Result<Vec<(String, String)>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached("SELECT id, body FROM tick_pulls ORDER BY updated")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn delete_pull(&self, id: &str) -> Result<bool> {
        Ok(self
            .db
            .lock()
            .execute("DELETE FROM tick_pulls WHERE id = ?1", params![id])?
            > 0)
    }
}

fn parse_date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, DATE)
        .map_err(|_| StoreError::Invalid(format!("a saved trade date is malformed: {s}")))
}

fn day_entry<'a>(
    days: &'a mut BTreeMap<NaiveDate, SavedDay>,
    date: &str,
) -> Result<&'a mut SavedDay> {
    let d = parse_date(date)?;
    Ok(days.entry(d).or_insert_with(|| SavedDay {
        trade_date: d,
        prints: 0,
        bytes: 0,
        covered: Vec::new(),
    }))
}

fn covered_within(tx: &Transaction<'_>, key: TickKey<'_>, span: Span) -> Result<Vec<Span>> {
    let mut stmt = tx.prepare_cached(
        "SELECT start, end FROM tick_coverage
         WHERE source = ?1 AND instrument = ?2 AND start < ?4 AND end > ?3 ORDER BY start",
    )?;
    let rows = stmt.query_map(
        params![key.source, key.instrument, span.start, span.end],
        |r| Ok(Span::new(r.get(0)?, r.get(1)?)),
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn aggressor_code(a: Aggressor) -> u8 {
    match a {
        Aggressor::Buy => 0,
        Aggressor::Sell => 1,
        Aggressor::Unknown => 2,
    }
}

fn source_code(s: AggressorSource) -> u8 {
    match s {
        AggressorSource::Exchange => 0,
        AggressorSource::ReplayMapped => 1,
        AggressorSource::Inferred => 2,
    }
}

const KEYED: u8 = 1 << 4;

impl Rows for TickRow {
    const WHAT: &'static str = "a tick block";

    fn t(&self) -> i64 {
        self.t
    }

    fn encode(rows: &[Self]) -> Result<Vec<u8>> {
        encode(rows)
    }

    fn decode(raw: &[u8]) -> Result<Vec<Self>> {
        decode(raw)
    }
}

fn encode(rows: &[TickRow]) -> Result<Vec<u8>> {
    let scales = Scales::of(
        rows.iter().map(|r| r.price.0),
        rows.iter().map(|r| r.size.0),
    );
    let int = |d, scale| mantissa(d, scale, TickRow::WHAT);
    let mut out = Vec::with_capacity(rows.len() * 6 + 8);
    let times: Vec<i64> = rows.iter().map(|r| r.t).collect();
    put_head(&mut out, FORMAT, scales, &times);
    let mut prev = 0i64;
    for r in rows {
        let p = int(r.price.0, scales.price)?;
        put(&mut out, zigzag(p - prev));
        prev = p;
    }
    for r in rows {
        put(&mut out, zigzag(int(r.size.0, scales.qty)?));
    }
    for r in rows {
        let keyed = if r.order_key.is_some() { KEYED } else { 0 };
        out.push(aggressor_code(r.aggressor) | (source_code(r.aggressor_source) << 2) | keyed);
    }
    for k in rows.iter().filter_map(|r| r.order_key) {
        put(&mut out, u64::from(k));
    }
    Ok(out)
}

fn decode(raw: &[u8]) -> Result<Vec<TickRow>> {
    let mut r = Reader::new(raw, TickRow::WHAT);
    let (scales, t) = r.head(FORMAT)?;
    let n = t.len();
    let mut price = Vec::with_capacity(n);
    let mut prev = 0i64;
    for _ in 0..n {
        prev += r.signed()?;
        price.push(prev);
    }
    let mut size = Vec::with_capacity(n);
    for _ in 0..n {
        size.push(r.signed()?);
    }
    let mut flags = Vec::with_capacity(n);
    for _ in 0..n {
        flags.push(r.byte()?);
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let f = flags[i];
        let aggressor = match f & 0b11 {
            0 => Aggressor::Buy,
            1 => Aggressor::Sell,
            2 => Aggressor::Unknown,
            _ => return Err(r.malformed("aggressor")),
        };
        let aggressor_source = match (f >> 2) & 0b11 {
            0 => AggressorSource::Exchange,
            1 => AggressorSource::ReplayMapped,
            2 => AggressorSource::Inferred,
            _ => return Err(r.malformed("aggressor source")),
        };
        let order_key = if f & KEYED != 0 {
            Some(u32::try_from(r.varint()?).map_err(|_| r.malformed("order key"))?)
        } else {
            None
        };
        out.push(TickRow {
            t: t[i],
            price: Price(decimal(price[i], scales.price)),
            size: Qty(decimal(size[i], scales.qty)),
            aggressor,
            aggressor_source,
            order_key,
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

    use super::*;
    use crate::block::pack;

    const KEY: TickKey<'static> = TickKey {
        source: "rithmic-apex",
        instrument: "NQZ6.CME",
    };
    const T0: i64 = 1_791_379_800_000_000_000;
    const SEC: i64 = 1_000_000_000;

    fn date(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, d).unwrap()
    }

    fn rows(from: i64, n: usize, every: i64) -> Vec<TickRow> {
        let tick = Decimal::from_str("0.25").unwrap();
        (0..n)
            .map(|i| TickRow {
                t: from + i as i64 * every,
                price: Price(Decimal::from(24_810) + tick * Decimal::from((i as i64 * 7) % 13 - 6)),
                size: Qty::from(1 + (i as i64 * 5) % 40),
                aggressor: if i % 3 == 0 {
                    Aggressor::Sell
                } else {
                    Aggressor::Buy
                },
                aggressor_source: if i % 11 == 0 {
                    AggressorSource::ReplayMapped
                } else {
                    AggressorSource::Exchange
                },
                order_key: (i % 4 != 0).then_some((i as u32).wrapping_mul(2_654_435_761)),
            })
            .collect()
    }

    #[test]
    fn a_block_keeps_every_field_of_every_print() {
        let mut want = rows(T0, 500, 7_919);
        want[3].size = Qty(Decimal::from_str("0.5").unwrap());
        want[4].aggressor = Aggressor::Unknown;
        want[5].aggressor_source = AggressorSource::Inferred;
        want[6].t = want[5].t;
        assert_eq!(unpack::<TickRow>(&pack(&want).unwrap()).unwrap(), want);
        assert!(
            unpack::<TickRow>(&pack::<TickRow>(&[]).unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_write_keeps_only_prints_not_already_known_whole() {
        let s = TickStore::open_in_memory().unwrap();
        let first = rows(T0, 600, SEC);
        let span = Span::new(T0, T0 + 600 * SEC);
        assert_eq!(s.write(KEY, date(2), &first, span).unwrap(), 600);
        let again = rows(T0 + 300 * SEC, 600, SEC);
        let wider = Span::new(T0 + 300 * SEC, T0 + 900 * SEC);
        assert_eq!(
            s.write(KEY, date(2), &again, wider).unwrap(),
            300,
            "the half already kept is not kept twice"
        );
        let got = s.read(KEY, T0, T0 + 900 * SEC).unwrap();
        assert_eq!(got.len(), 900);
        assert!(got.windows(2).all(|w| w[0].t < w[1].t));
        assert_eq!(&got[..600], &first[..]);
        assert_eq!(&got[600..], &again[300..]);
        assert_eq!(
            s.covered(KEY, 0, i64::MAX).unwrap(),
            vec![Span::new(T0, T0 + 900 * SEC)]
        );
    }

    #[test]
    fn a_partial_day_misses_only_what_was_not_recorded() {
        let s = TickStore::open_in_memory().unwrap();
        let open = T0;
        let close = T0 + 3_600 * SEC;
        s.write(
            KEY,
            date(2),
            &rows(open, 60, SEC),
            Span::new(open, open + 60 * SEC),
        )
        .unwrap();
        s.write(KEY, date(2), &[], Span::new(open + 600 * SEC, close))
            .unwrap();
        assert_eq!(
            s.missing(KEY, open, close).unwrap(),
            vec![Span::new(open + 60 * SEC, open + 600 * SEC)]
        );
        s.write(
            KEY,
            date(2),
            &[],
            Span::new(open + 60 * SEC, open + 600 * SEC),
        )
        .unwrap();
        assert!(s.missing(KEY, open, close).unwrap().is_empty());
        assert_eq!(
            s.covered(KEY, open, close).unwrap(),
            vec![Span::new(open, close)]
        );
    }

    #[test]
    fn spans_of_two_trade_dates_stay_apart() {
        let s = TickStore::open_in_memory().unwrap();
        s.write(KEY, date(2), &[], Span::new(0, 10)).unwrap();
        s.write(KEY, date(5), &[], Span::new(10, 20)).unwrap();
        assert_eq!(
            s.covered(KEY, 0, 20).unwrap(),
            vec![Span::new(0, 10), Span::new(10, 20)]
        );
        let days = s.days(KEY).unwrap();
        assert_eq!(
            days.iter().map(|d| d.trade_date).collect::<Vec<_>>(),
            vec![date(2), date(5)]
        );
    }

    #[test]
    fn the_prune_keeps_the_newest_sessions_and_every_protected_day() {
        let dir = tempfile::tempdir().unwrap();
        let s = TickStore::open_in_dir(dir.path()).unwrap();
        let day = 86_400 * SEC;
        for d in 1..=9u32 {
            let from = T0 + i64::from(d) * day;
            s.write(
                KEY,
                date(d),
                &rows(from, 20_000, SEC / 10),
                Span::new(from, from + 2_000 * SEC),
            )
            .unwrap();
        }
        let other = TickKey {
            source: KEY.source,
            instrument: "ESZ6.CME",
        };
        s.write(
            other,
            date(1),
            &rows(T0, 10, SEC),
            Span::new(T0, T0 + 10 * SEC),
        )
        .unwrap();
        let pragma = |q: &str| {
            s.db.lock()
                .query_row(q, [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        let main_file = || {
            std::fs::metadata(crate::DataDir::new(dir.path()).ticks())
                .unwrap()
                .len()
        };
        pragma("PRAGMA wal_checkpoint(TRUNCATE)");
        let before = main_file();
        let protected = BTreeSet::from([date(2)]);
        let gone = s.prune(KEY, 5, &protected).unwrap();
        assert_eq!(gone, vec![date(1), date(3), date(4)]);
        let kept: Vec<NaiveDate> = s.days(KEY).unwrap().iter().map(|d| d.trade_date).collect();
        assert_eq!(
            kept,
            vec![date(2), date(5), date(6), date(7), date(8), date(9)]
        );
        assert_eq!(
            s.days(other).unwrap().len(),
            1,
            "another contract keeps its own"
        );
        assert!(s.prune(KEY, 5, &protected).unwrap().is_empty());
        assert_eq!(pragma("PRAGMA freelist_count"), 0, "no page is left free");
        let used = pragma("PRAGMA page_count") * pragma("PRAGMA page_size");
        assert_eq!(
            main_file(),
            used as u64,
            "the file holds only the pages in use"
        );
        assert!(main_file() < before, "the pruned days give their room back");
    }

    #[test]
    fn contracts_count_their_days_prints_and_bytes() {
        let s = TickStore::open_in_memory().unwrap();
        s.write(
            KEY,
            date(2),
            &rows(T0, 100, SEC),
            Span::new(T0, T0 + 100 * SEC),
        )
        .unwrap();
        s.write(
            KEY,
            date(3),
            &[],
            Span::new(T0 + 86_400 * SEC, T0 + 86_401 * SEC),
        )
        .unwrap();
        let c = s.contracts().unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].days, c[0].prints), (2, 100));
        assert!(c[0].bytes > 0);
    }

    #[test]
    fn pulls_and_contracts_are_kept() {
        let s = TickStore::open_in_memory().unwrap();
        s.set_contract(KEY, "{\"tick\":0.25}").unwrap();
        assert_eq!(s.contract(KEY).unwrap().as_deref(), Some("{\"tick\":0.25}"));
        s.put_pull("a", "{}", 1).unwrap();
        s.put_pull("b", "{}", 2).unwrap();
        s.put_pull("a", "{\"x\":1}", 3).unwrap();
        assert_eq!(
            s.pulls().unwrap(),
            vec![("b".into(), "{}".into()), ("a".into(), "{\"x\":1}".into())]
        );
        assert!(s.delete_pull("a").unwrap());
        assert_eq!(s.pulls().unwrap().len(), 1);
    }

    #[test]
    fn a_refused_span_is_remembered_with_when() {
        let dir = tempfile::tempdir().unwrap();
        let span = Span::new(100, 200);
        TickStore::open_in_dir(dir.path())
            .unwrap()
            .refuse(KEY, span, 50)
            .unwrap();
        let s = TickStore::open_in_dir(dir.path()).unwrap();
        assert_eq!(s.refused_since(KEY, 0, 50).unwrap(), vec![span]);
        assert_eq!(s.refused_since(KEY, 0, 51).unwrap(), vec![]);
        assert_eq!(s.refused_since(KEY, 200, 0).unwrap(), vec![]);
        s.refuse(KEY, Span::new(100, 250), 60).unwrap();
        assert_eq!(
            s.refused_since(KEY, 0, 51).unwrap(),
            vec![Span::new(100, 250)]
        );
    }

    #[test]
    fn history_use_adds_up_per_connection_and_day() {
        let s = TickStore::open_in_memory().unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
        s.add_history_use("a", day, 2, 100).unwrap();
        s.add_history_use("a", day, 1, 50).unwrap();
        s.add_history_use("b", day, 1, 7).unwrap();
        assert_eq!(
            s.history_use().unwrap(),
            vec![
                HistoryDay {
                    source: "a".into(),
                    day,
                    requests: 3,
                    bytes: 150
                },
                HistoryDay {
                    source: "b".into(),
                    day,
                    requests: 1,
                    bytes: 7
                },
            ]
        );
    }
}
