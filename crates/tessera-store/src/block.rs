use rusqlite::{OptionalExtension, ToSql, Transaction, params_from_iter};

use crate::bars::Span;
use crate::error::{Result, StoreError};

const ZSTD_LEVEL: i32 = 3;

pub(crate) type Columns<'a> = &'a [(&'static str, &'a dyn ToSql)];

pub(crate) fn compress(raw: &[u8], what: &str) -> Result<Vec<u8>> {
    zstd::bulk::compress(raw, ZSTD_LEVEL)
        .map_err(|e| StoreError::Invalid(format!("compressing {what}: {e}")))
}

pub(crate) fn decompress(z: &[u8], what: &str) -> Result<Vec<u8>> {
    zstd::stream::decode_all(z)
        .map_err(|e| StoreError::Invalid(format!("{what} does not decompress: {e}")))
}

pub(crate) trait Rows: Sized {
    const WHAT: &'static str;
    fn t(&self) -> i64;
    fn encode(rows: &[Self]) -> Result<Vec<u8>>;
    fn decode(raw: &[u8]) -> Result<Vec<Self>>;
}

pub(crate) fn pack<R: Rows>(rows: &[R]) -> Result<Vec<u8>> {
    compress(&R::encode(rows)?, R::WHAT)
}

pub(crate) fn unpack<R: Rows>(z: &[u8]) -> Result<Vec<R>> {
    R::decode(&decompress(z, R::WHAT)?)
}

#[derive(Clone, Copy)]
pub(crate) enum SameTime {
    NewestWins,
    KeepAll,
}

pub(crate) struct BlockTable {
    pub(crate) name: &'static str,
    pub(crate) count: &'static str,
    pub(crate) same_time: SameTime,
}

impl BlockTable {
    pub(crate) fn merge<R: Rows>(
        &self,
        tx: &Transaction<'_>,
        key: Columns<'_>,
        labels: Columns<'_>,
        block: i64,
        new: Vec<R>,
    ) -> Result<()> {
        let at_block = format!("{} AND block = ?{}", key_equals(key), key.len() + 1);
        let held: Option<Vec<u8>> = tx
            .prepare_cached(&format!("SELECT data FROM {} WHERE {at_block}", self.name))?
            .query_row(
                params_from_iter(values(key).chain([&block as &dyn ToSql])),
                |r| r.get(0),
            )
            .optional()?;
        let mut rows = match held {
            Some(z) => unpack(&z)?,
            None => Vec::new(),
        };
        rows.extend(new);
        rows.sort_by_key(R::t);
        if let SameTime::NewestWins = self.same_time {
            rows = newest_of_each_time(rows);
        }
        let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
            return Ok(());
        };
        let (first_t, last_t, count) = (first.t(), last.t(), rows.len() as i64);
        let packed = pack(&rows)?;
        let keys = names(key);
        let inserted: Vec<&str> = key
            .iter()
            .map(|(c, _)| *c)
            .chain(["block"])
            .chain(labels.iter().map(|(c, _)| *c))
            .chain(["first_t", "last_t", self.count, "data"])
            .collect();
        let sql = format!(
            "INSERT INTO {name} ({columns}) VALUES ({slots})
             ON CONFLICT ({keys}, block) DO UPDATE SET
               first_t = excluded.first_t, last_t = excluded.last_t, {count} = excluded.{count},
               data = excluded.data",
            name = self.name,
            columns = inserted.join(", "),
            slots = slots(inserted.len()),
            count = self.count,
        );
        let tail: [&dyn ToSql; 4] = [&first_t, &last_t, &count, &packed];
        tx.prepare_cached(&sql)?.execute(params_from_iter(
            values(key)
                .chain([&block as &dyn ToSql])
                .chain(values(labels))
                .chain(tail),
        ))?;
        Ok(())
    }
}

fn newest_of_each_time<R: Rows>(sorted: Vec<R>) -> Vec<R> {
    let mut kept: Vec<R> = Vec::with_capacity(sorted.len());
    for r in sorted {
        match kept.last_mut() {
            Some(last) if last.t() == r.t() => *last = r,
            _ => kept.push(r),
        }
    }
    kept
}

pub(crate) fn cover(
    tx: &Transaction<'_>,
    coverage: &str,
    key: Columns<'_>,
    span: Span,
) -> Result<()> {
    let n = key.len();
    let touching = format!(
        "{} AND start <= ?{} AND end >= ?{}",
        key_equals(key),
        n + 2,
        n + 1
    );
    let bounds: [&dyn ToSql; 2] = [&span.start, &span.end];
    let (start, end): (Option<i64>, Option<i64>) = tx
        .prepare_cached(&format!(
            "SELECT min(start), max(end) FROM {coverage} WHERE {touching}"
        ))?
        .query_row(params_from_iter(values(key).chain(bounds)), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    tx.prepare_cached(&format!("DELETE FROM {coverage} WHERE {touching}"))?
        .execute(params_from_iter(values(key).chain(bounds)))?;
    let merged = Span::new(
        start.map_or(span.start, |s| s.min(span.start)),
        end.map_or(span.end, |e| e.max(span.end)),
    );
    let merged_bounds: [&dyn ToSql; 2] = [&merged.start, &merged.end];
    tx.prepare_cached(&format!(
        "INSERT INTO {coverage} ({}, start, end) VALUES ({})",
        names(key),
        slots(n + 2)
    ))?
    .execute(params_from_iter(values(key).chain(merged_bounds)))?;
    Ok(())
}

fn values<'a>(columns: Columns<'a>) -> impl Iterator<Item = &'a dyn ToSql> {
    columns.iter().map(|(_, v)| *v)
}

fn names(columns: Columns<'_>) -> String {
    columns
        .iter()
        .map(|(c, _)| *c)
        .collect::<Vec<_>>()
        .join(", ")
}

fn key_equals(key: Columns<'_>) -> String {
    key.iter()
        .enumerate()
        .map(|(i, (c, _))| format!("{c} = ?{}", i + 1))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn slots(n: usize) -> String {
    (1..=n)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ")
}
