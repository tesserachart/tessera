use std::collections::{BTreeMap, BTreeSet};

use chrono::TimeZone;
use tessera_core::Timestamp;
use tessera_core::ids::CallId;
use tessera_core::ids::slug;
use tessera_store::Store;
use tessera_store::level_history::{ImportRecord, Observation, SeriesInfo};

use super::io::{ImportLevelHistoryOutput, ImportedSeries, RowProblem, SampleRecord};
use super::{Adapted, LevelDecl, Record};

const PROBLEMS: usize = 50;
const SAMPLES: usize = 8;

pub fn ny_date(t: Timestamp) -> String {
    ny(t).format("%Y-%m-%d").to_string()
}

fn ny(t: Timestamp) -> chrono::DateTime<chrono_tz::Tz> {
    chrono_tz::America::New_York.timestamp_nanos(t.0)
}

pub fn full_name(vendor: &str, package: &str, level: &str) -> String {
    if package.trim().is_empty() {
        format!("{}.{level}", slug(vendor))
    } else {
        format!("{}.{}.{level}", slug(vendor), slug(package))
    }
}

#[derive(Clone, Debug)]
pub struct Plan<'a> {
    pub adapter: String,
    pub file_name: Option<String>,
    pub dry_run: bool,
    pub origin: &'a str,
    pub instrument: Option<String>,
    pub by: String,
    pub now: Timestamp,
}

type SeriesKey = (String, String, String);

pub fn store(
    store: &Store,
    mut a: Adapted,
    plan: &Plan<'_>,
) -> Result<ImportLevelHistoryOutput, String> {
    let vendor = a.vendor.trim().to_owned();
    if vendor.is_empty() {
        return Err("name the vendor, as it writes its name".into());
    }
    if let Some(i) = &plan.instrument {
        for r in &mut a.records {
            r.instrument.clone_from(i);
        }
    }
    let mut problems: Vec<RowProblem> = a
        .problems
        .iter()
        .map(|p| RowProblem {
            line: p.line as u64,
            message: p.message.clone(),
        })
        .collect();
    let unreadable = problems.len() as u64;
    let mut by_series: BTreeMap<SeriesKey, Vec<Record>> = BTreeMap::new();
    let mut seen: BTreeSet<(SeriesKey, i64)> = BTreeSet::new();
    let mut repeated = 0u64;
    let total = a.records.len() as u64;
    for r in a.records {
        let key = (
            r.instrument.trim().to_owned(),
            r.package.trim().to_owned(),
            r.level.trim().to_owned(),
        );
        if key.0.is_empty() || key.2.is_empty() {
            continue;
        }
        if !seen.insert((key.clone(), r.time.0)) {
            repeated += 1;
            continue;
        }
        by_series.entry(key).or_default().push(r);
    }
    let h = store.level_history();
    let decl = |pkg: &str, level: &str| -> LevelDecl {
        a.declared
            .get(&(pkg.to_owned(), level.to_owned()))
            .cloned()
            .unwrap_or_default()
    };
    let info = |(inst, pkg, level): &SeriesKey| -> SeriesInfo {
        let d = decl(pkg, level);
        let meta = (d.description.is_some() || d.concept.is_some())
            .then(|| serde_json::json!({"description": d.description, "concept": d.concept}));
        SeriesInfo {
            vendor: vendor.clone(),
            package: pkg.clone(),
            level: level.clone(),
            instrument: inst.clone(),
            label: d.label,
            endpoint: d.endpoint,
            basis: d.basis.or_else(|| Some(inst.clone())),
            meta,
        }
    };
    for key in by_series.keys() {
        let i = info(key);
        if let Some(s) = h.get_series(&i).map_err(|e| e.to_string())?
            && let (Some(have), Some(new)) = (&s.info.endpoint, &i.endpoint)
            && have != new
        {
            return Err(format!(
                "{} {} on {} is stored from {have}; this file is {new}, a different request: it is not stored under the same names",
                vendor, key.2, key.0
            ));
        }
    }
    let mut out = ImportLevelHistoryOutput {
        dry_run: plan.dry_run,
        import_id: None,
        vendor: vendor.clone(),
        adapter: plan.adapter.clone(),
        rows: a.rows as u64,
        records: total,
        imported: 0,
        duplicates: repeated,
        unreadable,
        problems: Vec::new(),
        series: Vec::new(),
        instruments: Vec::new(),
        first_date: None,
        last_date: None,
        days: 0,
        samples: Vec::new(),
        saved: None,
        notes: a.notes,
    };
    let mut all: Vec<&Record> = by_series.values().flatten().collect();
    all.sort_by_key(|r| (r.time, r.line));
    out.samples = all
        .iter()
        .take(SAMPLES)
        .map(|r| SampleRecord {
            line: r.line as u64,
            time: r.time,
            new_york: ny(r.time).format("%Y-%m-%d %H:%M:%S").to_string(),
            instrument: r.instrument.clone(),
            name: full_name(&vendor, &r.package, &r.level),
            value: r.value,
        })
        .collect();
    let dates: BTreeSet<String> = all.iter().map(|r| ny_date(r.time)).collect();
    out.days = dates.len() as u32;
    out.first_date = dates.first().cloned();
    out.last_date = dates.last().cloned();
    out.instruments = by_series
        .keys()
        .map(|k| k.0.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let id = format!("imp-{}", CallId::generate().0);
    let mut new_total = 0u64;
    for (key, records) in &by_series {
        let i = info(key);
        let first = records.iter().map(|r| r.time).min().unwrap_or(Timestamp(0));
        let last = records.iter().map(|r| r.time).max().unwrap_or(Timestamp(0));
        let new = if plan.dry_run {
            let times: Vec<i64> = records.iter().map(|r| r.time.0).collect();
            let have = h.count_existing(&i, &times).map_err(|e| e.to_string())?;
            (records.len() - have) as u64
        } else {
            let sid = h.series(&i, plan.now).map_err(|e| e.to_string())?;
            let rows: Vec<Observation> = records
                .iter()
                .map(|r| Observation {
                    as_of: r.time,
                    known_at: r.time,
                    value: r.value,
                    native_value: None,
                    reason: r.reason.clone(),
                    conversion: None,
                    origin: plan.origin.to_owned(),
                    batch: id.clone(),
                })
                .collect();
            h.insert(sid, &rows).map_err(|e| e.to_string())?.inserted as u64
        };
        new_total += new;
        out.duplicates += records.len() as u64 - new;
        out.series.push(ImportedSeries {
            name: full_name(&vendor, &key.1, &key.2),
            package: key.1.clone(),
            level: key.2.clone(),
            label: i.label.clone(),
            instrument: key.0.clone(),
            records: records.len() as u64,
            new,
            first_date: ny_date(first),
            last_date: ny_date(last),
        });
    }
    out.imported = new_total;
    if !plan.dry_run && new_total > 0 {
        h.record_import(&ImportRecord {
            id: id.clone(),
            vendor: vendor.clone(),
            file_name: plan.file_name.clone(),
            adapter: plan.adapter.clone(),
            records: total,
            imported: new_total,
            skipped: total - new_total,
            first_as_of: all.first().map(|r| r.time),
            last_as_of: all.last().map(|r| r.time),
            at: plan.now,
            by: plan.by.clone(),
        })
        .map_err(|e| e.to_string())?;
        out.import_id = Some(id);
    }
    if total == 0 {
        out.notes
            .push("the file gave no values: check the mapping against the preview".into());
    } else if new_total == 0 {
        out.notes
            .push("every value is already stored: nothing new".into());
    }
    if plan.dry_run && new_total > 0 {
        out.notes.push(
            "a dry run: nothing was stored; the same call with dryRun false stores it".into(),
        );
    }
    problems.truncate(PROBLEMS);
    out.problems = problems;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(t: i64, level: &str, v: Option<f64>, line: usize) -> Record {
        Record {
            time: Timestamp(t * 1_000_000_000),
            instrument: "NDX".into(),
            package: "Daily".into(),
            level: level.into(),
            value: v,
            reason: None,
            line,
        }
    }

    fn adapted(records: Vec<Record>) -> Adapted {
        Adapted {
            vendor: "Acme Levels".into(),
            rows: records.len(),
            records,
            ..Adapted::default()
        }
    }

    fn plan(dry: bool) -> Plan<'static> {
        Plan {
            adapter: "mapping:acme-levels".into(),
            file_name: Some("acme.csv".into()),
            dry_run: dry,
            origin: "import",
            instrument: None,
            by: "user".into(),
            now: Timestamp(1),
        }
    }

    #[test]
    fn a_dry_run_describes_and_writes_nothing_then_an_import_dedupes() {
        let s = Store::open_in_memory().unwrap();
        let base = 1_791_379_860;
        let a = adapted(vec![
            rec(base, "call_wall", Some(20_850.0), 2),
            rec(base, "call_wall", Some(1.0), 3),
            rec(base + 86_400, "call_wall", Some(20_900.0), 4),
            rec(base, "put_wall", None, 5),
        ]);
        let dry = store(&s, a.clone(), &plan(true)).unwrap();
        assert!(dry.dry_run);
        assert_eq!((dry.records, dry.imported, dry.duplicates), (4, 3, 1));
        assert_eq!(dry.days, 2);
        assert_eq!(dry.first_date.as_deref(), Some("2026-10-07"));
        assert_eq!(dry.samples[0].name, "acme-levels.daily.call_wall");
        assert_eq!(dry.samples[0].new_york, "2026-10-07 09:31:00");
        assert!(
            s.level_history().all_series().unwrap().is_empty(),
            "a dry run writes nothing"
        );

        let done = store(&s, a.clone(), &plan(false)).unwrap();
        assert_eq!(done.imported, 3);
        assert!(done.import_id.is_some());
        let again = store(&s, a, &plan(true)).unwrap();
        assert_eq!(again.imported, 0, "everything is stored already");
        let h = s.level_history();
        assert_eq!(h.imports().unwrap()[0].imported, 3);
        let series = h.all_series().unwrap();
        assert_eq!(series.len(), 2);
        let obs = h.observations(series[0].id, None, None, 10).unwrap();
        assert_eq!(obs[0].known_at, obs[0].as_of, "known at the vendor's time");
        assert_eq!(obs[0].origin, "import");
    }

    #[test]
    fn another_request_is_not_stored_under_the_same_names() {
        let s = Store::open_in_memory().unwrap();
        let mut a = adapted(vec![rec(1_791_379_860, "zero_gamma", Some(1.0), 1)]);
        a.declared.insert(
            ("Daily".into(), "zero_gamma".into()),
            LevelDecl {
                endpoint: Some("classic/gex_full".into()),
                ..LevelDecl::default()
            },
        );
        store(&s, a.clone(), &plan(false)).unwrap();
        a.declared.insert(
            ("Daily".into(), "zero_gamma".into()),
            LevelDecl {
                endpoint: Some("classic/gex_zero".into()),
                ..LevelDecl::default()
            },
        );
        let e = store(&s, a, &plan(true)).unwrap_err();
        assert!(e.contains("different request"), "{e}");
    }
}
