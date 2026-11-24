use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, Row, params};
use serde_json::Value;
use tessera_core::Timestamp;
use tessera_core::ids::slug;

use crate::Store;
use crate::error::{Result, StoreError};

#[derive(Clone, Debug, PartialEq)]
pub struct SeriesInfo {
    pub vendor: String,
    pub package: String,
    pub level: String,
    pub instrument: String,
    pub label: Option<String>,
    pub endpoint: Option<String>,
    pub basis: Option<String>,
    pub meta: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub id: i64,
    pub vendor_key: String,
    pub info: SeriesInfo,
}

impl Series {
    pub fn full_name(&self) -> String {
        if self.info.package.is_empty() {
            format!("{}.{}", self.vendor_key, self.info.level)
        } else {
            format!(
                "{}.{}.{}",
                self.vendor_key,
                slug(&self.info.package),
                self.info.level
            )
        }
    }
}

pub mod origin {
    pub const LIVE: &str = "live";
    pub const IMPORT: &str = "import";
    pub const BACKFILL: &str = "backfill";
}

#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub as_of: Timestamp,
    pub known_at: Timestamp,
    pub value: Option<f64>,
    pub native_value: Option<f64>,
    pub reason: Option<String>,
    pub conversion: Option<Value>,
    pub origin: String,
    pub batch: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Inserted {
    pub inserted: usize,
    pub duplicates: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SeriesCoverage {
    pub series: Series,
    pub first: Timestamp,
    pub last: Timestamp,
    pub observations: u64,
    pub origins: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recording {
    pub provider: String,
    pub vendor: String,
    pub first_at: Timestamp,
    pub last_at: Timestamp,
    pub snapshots: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportRecord {
    pub id: String,
    pub vendor: String,
    pub file_name: Option<String>,
    pub adapter: String,
    pub records: u64,
    pub imported: u64,
    pub skipped: u64,
    pub first_as_of: Option<Timestamp>,
    pub last_as_of: Option<Timestamp>,
    pub at: Timestamp,
    pub by: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LevelName {
    pub vendor_key: String,
    pub package_key: Option<String>,
    pub level: String,
    pub instrument: Option<String>,
}

impl LevelName {
    pub fn parse(name: &str) -> std::result::Result<Self, String> {
        let name = name.trim();
        let (body, instrument) = match name.rsplit_once('@') {
            Some((b, i)) if !i.trim().is_empty() => (b, Some(i.trim().to_owned())),
            Some(_) => return Err(format!("{name:?}: nothing after @")),
            None => (name, None),
        };
        let parts: Vec<&str> = body.splitn(3, '.').collect();
        let bad = || {
            format!(
                "{name:?} is not a level name: write vendor.level (acme.major_long_gamma) or vendor.package.level (acme.state.major_long_gamma)"
            )
        };
        let (vendor, package, level) = match parts.as_slice() {
            [v, l] => (*v, None, *l),
            [v, p, l] => (*v, Some(*p), *l),
            _ => return Err(bad()),
        };
        if vendor.trim().is_empty() || level.trim().is_empty() {
            return Err(bad());
        }
        Ok(Self {
            vendor_key: slug(vendor),
            package_key: package.map(slug),
            level: level.trim().to_owned(),
            instrument,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LevelHistoryRepo<'a> {
    store: &'a Store,
}

const SERIES: &str = "SELECT series_id, vendor, vendor_key, package, level, instrument, label, endpoint, basis, meta FROM level_series";
const OBS: &str = "SELECT as_of, known_at, value, native_value, reason, conversion, origin, batch FROM level_observations";

fn series_row(r: &Row<'_>) -> rusqlite::Result<(Series, Option<String>)> {
    Ok((
        Series {
            id: r.get(0)?,
            vendor_key: r.get(2)?,
            info: SeriesInfo {
                vendor: r.get(1)?,
                package: r.get(3)?,
                level: r.get(4)?,
                instrument: r.get(5)?,
                label: r.get(6)?,
                endpoint: r.get(7)?,
                basis: r.get(8)?,
                meta: None,
            },
        },
        r.get(9)?,
    ))
}

fn parsed_series((mut s, meta): (Series, Option<String>)) -> Series {
    s.info.meta = meta.and_then(|m| serde_json::from_str(&m).ok());
    s
}

fn obs_row(r: &Row<'_>) -> rusqlite::Result<Observation> {
    let conversion: Option<String> = r.get(5)?;
    Ok(Observation {
        as_of: Timestamp(r.get(0)?),
        known_at: Timestamp(r.get(1)?),
        value: r.get(2)?,
        native_value: r.get(3)?,
        reason: r.get(4)?,
        conversion: conversion.and_then(|c| serde_json::from_str(&c).ok()),
        origin: r.get(6)?,
        batch: r.get(7)?,
    })
}

fn finite(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite())
}

impl<'a> LevelHistoryRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn series(&self, info: &SeriesInfo, now: Timestamp) -> Result<i64> {
        if info.vendor.trim().is_empty() || info.level.trim().is_empty() {
            return Err(StoreError::Invalid(
                "a level series needs its vendor and its level name".into(),
            ));
        }
        if info.instrument.trim().is_empty() {
            return Err(StoreError::Invalid(format!(
                "{} {}: no instrument",
                info.vendor, info.level
            )));
        }
        let conn = self.store.conn()?;
        let meta = info.meta.as_ref().map(Value::to_string);
        conn.execute(
            "INSERT INTO level_series (vendor, vendor_key, package, level, instrument, label, endpoint, basis, meta, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (vendor_key, package, level, instrument) DO UPDATE SET
               label = coalesce(level_series.label, excluded.label),
               endpoint = coalesce(level_series.endpoint, excluded.endpoint),
               basis = coalesce(level_series.basis, excluded.basis),
               meta = coalesce(level_series.meta, excluded.meta)",
            params![
                info.vendor.trim(),
                slug(&info.vendor),
                info.package.trim(),
                info.level.trim(),
                info.instrument.trim(),
                info.label,
                info.endpoint,
                info.basis,
                meta,
                now.0
            ],
        )?;
        Ok(conn.query_row(
            "SELECT series_id FROM level_series WHERE vendor_key = ?1 AND package = ?2 AND level = ?3 AND instrument = ?4",
            params![
                slug(&info.vendor),
                info.package.trim(),
                info.level.trim(),
                info.instrument.trim()
            ],
            |r| r.get(0),
        )?)
    }

    pub fn get_series(&self, info: &SeriesInfo) -> Result<Option<Series>> {
        let conn = self.store.conn()?;
        let row = conn
            .query_row(
                &format!(
                    "{SERIES} WHERE vendor_key = ?1 AND package = ?2 AND level = ?3 AND instrument = ?4"
                ),
                params![
                    slug(&info.vendor),
                    info.package.trim(),
                    info.level.trim(),
                    info.instrument.trim()
                ],
                series_row,
            )
            .optional()?;
        Ok(row.map(parsed_series))
    }

    pub fn all_series(&self) -> Result<Vec<Series>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(&format!(
            "{SERIES} ORDER BY vendor_key, package, level, instrument"
        ))?;
        let rows = stmt
            .query_map([], series_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(parsed_series).collect())
    }

    pub fn find(&self, name: &LevelName, instruments: &[String]) -> Result<Vec<Series>> {
        let wanted: Vec<String> = match &name.instrument {
            Some(i) => vec![i.clone()],
            None => instruments.to_vec(),
        };
        Ok(self
            .all_series()?
            .into_iter()
            .filter(|s| {
                s.vendor_key == name.vendor_key
                    && s.info.level == name.level
                    && name
                        .package_key
                        .as_ref()
                        .is_none_or(|p| *p == slug(&s.info.package))
                    && wanted
                        .iter()
                        .any(|i| i.eq_ignore_ascii_case(&s.info.instrument))
            })
            .collect())
    }

    pub fn insert(&self, series_id: i64, rows: &[Observation]) -> Result<Inserted> {
        let pairs: Vec<(i64, &Observation)> = rows.iter().map(|o| (series_id, o)).collect();
        self.insert_pairs(&pairs)
    }

    pub fn insert_pairs(&self, rows: &[(i64, &Observation)]) -> Result<Inserted> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        let mut out = Inserted::default();
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO level_observations
                   (series_id, as_of, known_at, value, native_value, reason, conversion, origin, batch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for (id, o) in rows {
                let n = stmt.execute(params![
                    id,
                    o.as_of.0,
                    o.known_at.0,
                    finite(o.value),
                    finite(o.native_value),
                    o.reason,
                    o.conversion.as_ref().map(Value::to_string),
                    o.origin,
                    o.batch
                ])?;
                if n == 0 {
                    out.duplicates += 1;
                } else {
                    out.inserted += 1;
                }
            }
        }
        tx.commit()?;
        Ok(out)
    }

    pub fn count_existing(&self, info: &SeriesInfo, as_ofs: &[i64]) -> Result<usize> {
        let Some(s) = self.get_series(info)? else {
            return Ok(0);
        };
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT 1 FROM level_observations WHERE series_id = ?1 AND as_of = ?2",
        )?;
        let mut n = 0;
        for t in as_ofs {
            if stmt.exists(params![s.id, t])? {
                n += 1;
            }
        }
        Ok(n)
    }

    pub fn observations(
        &self,
        series_id: i64,
        from: Option<Timestamp>,
        to: Option<Timestamp>,
        limit: usize,
    ) -> Result<Vec<Observation>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare_cached(&format!(
            "{OBS} WHERE series_id = ?1 AND as_of >= ?2 AND as_of <= ?3 ORDER BY as_of LIMIT ?4"
        ))?;
        let rows = stmt.query_map(
            params![
                series_id,
                from.map_or(i64::MIN, |t| t.0),
                to.map_or(i64::MAX, |t| t.0),
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            obs_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn known(
        &self,
        series_id: i64,
        from: Timestamp,
        to: Timestamp,
    ) -> Result<Vec<Observation>> {
        let conn = self.store.conn()?;
        let standing = conn
            .query_row(
                &format!(
                    "{OBS} WHERE series_id = ?1 AND known_at < ?2 ORDER BY as_of DESC LIMIT 1"
                ),
                params![series_id, from.0],
                obs_row,
            )
            .optional()?;
        let mut stmt = conn.prepare_cached(&format!(
            "{OBS} WHERE series_id = ?1 AND known_at >= ?2 AND known_at <= ?3 ORDER BY known_at, as_of"
        ))?;
        let rows = stmt
            .query_map(params![series_id, from.0, to.0], obs_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(standing.into_iter().chain(rows).collect())
    }

    pub fn coverage(&self, ids: Option<&[i64]>) -> Result<Vec<SeriesCoverage>> {
        let all = self.all_series()?;
        let conn = self.store.conn()?;
        let mut span = conn.prepare_cached(
            "SELECT min(as_of), max(as_of), count(*) FROM level_observations WHERE series_id = ?1",
        )?;
        let mut by_origin = conn.prepare_cached(
            "SELECT origin, count(*) FROM level_observations WHERE series_id = ?1 GROUP BY origin",
        )?;
        let mut out = Vec::new();
        for s in all {
            if ids.is_some_and(|ids| !ids.contains(&s.id)) {
                continue;
            }
            let (first, last, n): (Option<i64>, Option<i64>, i64) =
                span.query_row(params![s.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            let (Some(first), Some(last)) = (first, last) else {
                continue;
            };
            let origins = by_origin
                .query_map(params![s.id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(|(o, n)| (o, u64::try_from(n).unwrap_or(0)))
                .collect();
            out.push(SeriesCoverage {
                series: s,
                first: Timestamp(first),
                last: Timestamp(last),
                observations: u64::try_from(n).unwrap_or(0),
                origins,
            });
        }
        Ok(out)
    }

    pub fn known_hours(
        &self,
        series_id: i64,
        from: Timestamp,
        to: Timestamp,
    ) -> Result<Vec<Timestamp>> {
        const HOUR: i64 = 3_600_000_000_000;
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT known_at / ?4 * ?4 FROM level_observations
             WHERE series_id = ?1 AND known_at >= ?2 AND known_at <= ?3 ORDER BY 1",
        )?;
        let rows = stmt.query_map(params![series_id, from.0, to.0, HOUR], |r| {
            Ok(Timestamp(r.get(0)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<Timestamp>>>()?)
    }

    pub fn note_recording(&self, provider: &str, vendor: &str, at: Timestamp) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO level_recordings (provider, vendor, first_at, last_at, snapshots)
             VALUES (?1, ?2, ?3, ?3, 1)
             ON CONFLICT (provider) DO UPDATE SET
               vendor = excluded.vendor, last_at = max(last_at, excluded.last_at),
               snapshots = snapshots + 1",
            params![provider, vendor, at.0],
        )?;
        Ok(())
    }

    pub fn recordings(&self) -> Result<Vec<Recording>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT provider, vendor, first_at, last_at, snapshots FROM level_recordings ORDER BY first_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Recording {
                provider: r.get(0)?,
                vendor: r.get(1)?,
                first_at: Timestamp(r.get(2)?),
                last_at: Timestamp(r.get(3)?),
                snapshots: u64::try_from(r.get::<_, i64>(4)?).unwrap_or(0),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn record_import(&self, rec: &ImportRecord) -> Result<()> {
        let n = |v: u64| i64::try_from(v).unwrap_or(i64::MAX);
        self.store.conn()?.execute(
            "INSERT INTO level_imports (import_id, vendor, file_name, adapter, records, imported, skipped, first_as_of, last_as_of, at, by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                rec.id,
                rec.vendor,
                rec.file_name,
                rec.adapter,
                n(rec.records),
                n(rec.imported),
                n(rec.skipped),
                rec.first_as_of.map(|t| t.0),
                rec.last_as_of.map(|t| t.0),
                rec.at.0,
                rec.by
            ],
        )?;
        Ok(())
    }

    pub fn imports(&self) -> Result<Vec<ImportRecord>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT import_id, vendor, file_name, adapter, records, imported, skipped, first_as_of, last_as_of, at, by
             FROM level_imports ORDER BY at DESC",
        )?;
        let u = |v: i64| u64::try_from(v).unwrap_or(0);
        let rows = stmt.query_map([], |r| {
            Ok(ImportRecord {
                id: r.get(0)?,
                vendor: r.get(1)?,
                file_name: r.get(2)?,
                adapter: r.get(3)?,
                records: u(r.get(4)?),
                imported: u(r.get(5)?),
                skipped: u(r.get(6)?),
                first_as_of: r.get::<_, Option<i64>>(7)?.map(Timestamp),
                last_as_of: r.get::<_, Option<i64>>(8)?.map(Timestamp),
                at: Timestamp(r.get(9)?),
                by: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_import(&self, import_id: &str) -> Result<usize> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        let n = tx.execute(
            "DELETE FROM level_observations WHERE batch = ?1",
            params![import_id],
        )?;
        let found = tx.execute(
            "DELETE FROM level_imports WHERE import_id = ?1",
            params![import_id],
        )?;
        if found == 0 {
            return Err(StoreError::NotFound(format!("no import {import_id}")));
        }
        tx.execute(
            "DELETE FROM level_series WHERE NOT EXISTS
               (SELECT 1 FROM level_observations o WHERE o.series_id = level_series.series_id)",
            [],
        )?;
        tx.commit()?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(level: &str, instrument: &str) -> SeriesInfo {
        SeriesInfo {
            vendor: "Acme".into(),
            package: "State".into(),
            level: level.into(),
            instrument: instrument.into(),
            label: Some("Major Long Gamma".into()),
            endpoint: Some("state/gamma_zero".into()),
            basis: Some("NDX".into()),
            meta: None,
        }
    }

    fn obs(as_of: i64, known_at: i64, value: Option<f64>, origin_: &str) -> Observation {
        Observation {
            as_of: Timestamp(as_of),
            known_at: Timestamp(known_at),
            value,
            native_value: None,
            reason: value.is_none().then(|| "not applicable".to_owned()),
            conversion: None,
            origin: origin_.into(),
            batch: "acme".into(),
        }
    }

    #[test]
    fn names_parse_with_and_without_a_package() {
        let n = LevelName::parse("acme.major_long_gamma").unwrap();
        assert_eq!(
            (n.vendor_key.as_str(), n.package_key, n.level.as_str()),
            ("acme", None, "major_long_gamma")
        );
        let n = LevelName::parse("Acme.State.major_long_gamma@NDX").unwrap();
        assert_eq!(n.vendor_key, "acme");
        assert_eq!(n.package_key.as_deref(), Some("state"));
        assert_eq!(n.instrument.as_deref(), Some("NDX"));
        assert!(LevelName::parse("major_long_gamma").is_err());
        assert!(LevelName::parse("acme.").is_err());
    }

    #[test]
    fn series_are_one_per_vendor_level_and_instrument_and_observations_dedupe() {
        let store = Store::open_in_memory().unwrap();
        let h = store.level_history();
        let a = h
            .series(&info("major_long_gamma", "NDX"), Timestamp(1))
            .unwrap();
        assert_eq!(
            h.series(&info("major_long_gamma", "NDX"), Timestamp(2))
                .unwrap(),
            a
        );
        let b = h
            .series(&info("major_long_gamma", "NQZ6.CME"), Timestamp(1))
            .unwrap();
        assert_ne!(a, b);
        let r = h
            .insert(
                a,
                &[
                    obs(100, 105, Some(20_850.0), origin::LIVE),
                    obs(200, 205, None, origin::LIVE),
                ],
            )
            .unwrap();
        assert_eq!(
            r,
            Inserted {
                inserted: 2,
                duplicates: 0
            }
        );
        let r = h
            .insert(
                a,
                &[
                    obs(200, 200, Some(1.0), origin::IMPORT),
                    obs(300, 300, Some(20_900.0), origin::IMPORT),
                ],
            )
            .unwrap();
        assert_eq!(
            r,
            Inserted {
                inserted: 1,
                duplicates: 1
            }
        );
        let all = h.observations(a, None, None, 100).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[1].value, None);
        assert_eq!(all[1].origin, "live");
        assert_eq!(
            h.count_existing(&info("major_long_gamma", "NDX"), &[100, 150, 300])
                .unwrap(),
            2
        );
        assert_eq!(
            h.count_existing(&info("zero_gamma", "NDX"), &[100])
                .unwrap(),
            0
        );

        let name = LevelName::parse("acme.major_long_gamma").unwrap();
        assert_eq!(h.find(&name, &["NDX".into()]).unwrap().len(), 1);
        assert_eq!(
            h.find(&name, &["NDX".into(), "NQZ6.CME".into()])
                .unwrap()
                .len(),
            2
        );
        let other = LevelName::parse("acme.classic.major_long_gamma").unwrap();
        assert!(h.find(&other, &["NDX".into()]).unwrap().is_empty());
        let s = &h.find(&name, &["ndx".into()]).unwrap()[0];
        assert_eq!(s.full_name(), "acme.state.major_long_gamma");

        let cov = h.coverage(Some(&[a])).unwrap();
        assert_eq!(cov.len(), 1);
        assert_eq!(
            (cov[0].first, cov[0].last),
            (Timestamp(100), Timestamp(300))
        );
        assert_eq!(cov[0].origins.get("live"), Some(&2));
        assert_eq!(cov[0].origins.get("import"), Some(&1));
    }

    #[test]
    fn known_reads_what_stood_at_the_start_then_what_became_known() {
        let store = Store::open_in_memory().unwrap();
        let h = store.level_history();
        let a = h
            .series(&info("major_long_gamma", "NDX"), Timestamp(1))
            .unwrap();
        h.insert(
            a,
            &[
                obs(10, 11, Some(1.0), origin::LIVE),
                obs(20, 21, Some(2.0), origin::LIVE),
                obs(30, 31, Some(3.0), origin::LIVE),
                obs(40, 45, Some(4.0), origin::LIVE),
            ],
        )
        .unwrap();
        let k = h.known(a, Timestamp(25), Timestamp(40)).unwrap();
        let values: Vec<f64> = k.iter().filter_map(|o| o.value).collect();
        assert_eq!(
            values,
            [2.0, 3.0],
            "21 stood at 25; 31 became known; 45 is after"
        );
        let hours = h.known_hours(a, Timestamp(0), Timestamp(i64::MAX)).unwrap();
        assert_eq!(hours, [Timestamp(0)]);
    }

    #[test]
    fn known_hours_are_the_utc_hours_with_a_value_known_in_range() {
        const HOUR: i64 = 3_600_000_000_000;
        let store = Store::open_in_memory().unwrap();
        let h = store.level_history();
        let a = h
            .series(&info("major_long_gamma", "NDX"), Timestamp(1))
            .unwrap();
        h.insert(
            a,
            &[
                obs(1, 5, Some(1.0), origin::LIVE),
                obs(2, HOUR - 1, Some(2.0), origin::LIVE),
                obs(3, HOUR + 5, Some(3.0), origin::LIVE),
                obs(4, 3 * HOUR, Some(4.0), origin::LIVE),
                obs(5, 5 * HOUR + 7, Some(5.0), origin::LIVE),
            ],
        )
        .unwrap();
        let hours = h
            .known_hours(a, Timestamp(HOUR - 1), Timestamp(3 * HOUR))
            .unwrap();
        assert_eq!(hours, [Timestamp(0), Timestamp(HOUR), Timestamp(3 * HOUR)]);
    }

    #[test]
    fn recordings_and_imports_are_kept_and_an_import_can_be_undone() {
        let store = Store::open_in_memory().unwrap();
        let h = store.level_history();
        h.note_recording("acme", "Acme", Timestamp(10)).unwrap();
        h.note_recording("acme", "Acme", Timestamp(20)).unwrap();
        let r = h.recordings().unwrap();
        assert_eq!(
            (r[0].first_at, r[0].last_at, r[0].snapshots),
            (Timestamp(10), Timestamp(20), 2)
        );
        let a = h
            .series(&info("major_long_gamma", "NDX"), Timestamp(1))
            .unwrap();
        let mut o = obs(10, 10, Some(1.0), origin::IMPORT);
        o.batch = "imp-1".into();
        h.insert(a, &[o]).unwrap();
        h.record_import(&ImportRecord {
            id: "imp-1".into(),
            vendor: "Acme".into(),
            file_name: Some("ndx.csv".into()),
            adapter: "mapping:acme".into(),
            records: 1,
            imported: 1,
            skipped: 0,
            first_as_of: Some(Timestamp(10)),
            last_as_of: Some(Timestamp(10)),
            at: Timestamp(50),
            by: "user".into(),
        })
        .unwrap();
        assert_eq!(h.imports().unwrap().len(), 1);
        assert_eq!(h.delete_import("imp-1").unwrap(), 1);
        assert!(h.imports().unwrap().is_empty());
        assert!(h.all_series().unwrap().is_empty(), "an emptied series goes");
        assert!(h.delete_import("imp-1").is_err());
    }
}
