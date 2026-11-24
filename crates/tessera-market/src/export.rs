use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDate};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::InstrumentId;
use tessera_core::instrument::{ContractSpec, FuturesContractCode, Instrument};
use tessera_core::market::Aggressor;
use tessera_core::session::SessionCalendar;
use tessera_store::ticks::{SavedDay, TickKey, TickRow, TickStore};
use ts_rs::TS;

use crate::pull::{Scope, day_spans};

pub const CSV_HEADER: &str = "ts_ns,price,size,side";

/// `market.export_trades` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ExportTradesInput {
    /// A dated contract (`NQZ6`, `NQZ6.CME`) or a futures root (`NQ`). For a root, each day is
    /// written from the saved contract that was the front month that day (by its roll date).
    pub instrument: String,
    /// First trade date, `YYYY-MM-DD`.
    #[ts(type = "string")]
    pub from: NaiveDate,
    /// Last trade date, `YYYY-MM-DD` (inclusive).
    #[ts(type = "string")]
    pub to: NaiveDate,
    /// `rth` writes the regular trading hours of each day, `session` the whole session.
    pub scope: Scope,
    /// The folder the files go into, created when missing. A file of the same name is replaced.
    pub dir: String,
    /// Only the prints saved from this connection (`rithmic-apex`, `mock`); default any.
    #[serde(default)]
    pub source: Option<String>,
}

/// One file written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportedDay {
    /// The trade date.
    #[ts(type = "string")]
    pub date: NaiveDate,
    /// The file's full path (`<dir>/NQ-2026-10-01.csv`).
    pub path: String,
    /// The dated contract its prints are from.
    pub contract: String,
    /// The connection that served them.
    pub source: String,
    /// Rows written.
    #[ts(type = "number")]
    pub prints: u64,
    /// True when every minute of the day's hours is saved; false when part of it was never
    /// recorded or pulled.
    pub complete: bool,
}

/// `market.export_trades` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportTradesOutput {
    /// The folder written into.
    pub dir: String,
    /// One file per trade date, oldest first. Each is CSV with the header `ts_ns,price,size,side`:
    /// the print's time in UTC nanoseconds, its price, its size, and 1 when the buyer aggressed,
    /// -1 when the seller did, 0 when unknown; rows in time order.
    pub files: Vec<ExportedDay>,
    /// Trading days of the range with no saved prints in those hours: no file is written for them.
    #[ts(type = "string[]")]
    pub missing: Vec<NaiveDate>,
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] tessera_store::StoreError),
    #[error("writing {path}: {error}")]
    Io {
        path: PathBuf,
        error: std::io::Error,
    },
}

struct Saved {
    source: String,
    instrument: String,
    root: String,
    calendar: SessionCalendar,
    roll: Option<NaiveDate>,
    days: BTreeMap<NaiveDate, SavedDay>,
}

impl Saved {
    fn key(&self) -> TickKey<'_> {
        TickKey {
            source: &self.source,
            instrument: &self.instrument,
        }
    }
}

fn saved_contracts(
    store: &TickStore,
    input: &ExportTradesInput,
) -> Result<Vec<Saved>, ExportError> {
    let wanted = input.instrument.trim().to_ascii_uppercase();
    let mut out = Vec::new();
    for c in store.contracts()? {
        if input.source.as_deref().is_some_and(|s| s != c.source) {
            continue;
        }
        let key = TickKey {
            source: &c.source,
            instrument: &c.instrument,
        };
        let spec: Option<(Instrument, ContractSpec)> = store
            .contract(key)?
            .and_then(|json| serde_json::from_str(&json).ok());
        let Ok(id) = InstrumentId::new(&c.instrument) else {
            continue;
        };
        let code = FuturesContractCode::parse(id.symbol(), chrono::Utc::now().year());
        let root = spec
            .as_ref()
            .and_then(|(_, s)| s.root.clone())
            .or_else(|| code.as_ref().map(|c| c.root.clone()))
            .unwrap_or_else(|| id.symbol().to_owned())
            .to_ascii_uppercase();
        let named = [root.as_str(), id.as_str(), id.symbol()]
            .iter()
            .any(|n| n.eq_ignore_ascii_case(&wanted));
        if !named {
            continue;
        }
        let calendar = match (&spec, &code) {
            (Some((_, s)), _) => s.sessions,
            (None, Some(c)) => SessionCalendar::of_cme_root(&c.root),
            (None, None) => continue,
        };
        let days = store
            .days(key)?
            .into_iter()
            .filter(|d| d.trade_date >= input.from && d.trade_date <= input.to)
            .map(|d| (d.trade_date, d))
            .collect();
        out.push(Saved {
            roll: spec.as_ref().and_then(|(_, s)| s.roll_date),
            source: c.source,
            instrument: c.instrument,
            root,
            calendar,
            days,
        });
    }
    Ok(out)
}

fn front_for(saved: &[Saved], date: NaiveDate) -> Option<&Saved> {
    let having: Vec<&Saved> = saved
        .iter()
        .filter(|s| s.days.get(&date).is_some_and(|d| d.prints > 0))
        .collect();
    having
        .iter()
        .filter(|s| s.roll.is_some_and(|r| r > date))
        .min_by_key(|s| s.roll)
        .or_else(|| having.iter().max_by_key(|s| s.days[&date].prints))
        .copied()
}

pub fn side(a: Aggressor) -> i8 {
    match a {
        Aggressor::Buy => 1,
        Aggressor::Sell => -1,
        Aggressor::Unknown => 0,
    }
}

fn write_csv(path: &Path, rows: &[TickRow]) -> Result<(), ExportError> {
    let io = |error| ExportError::Io {
        path: path.to_owned(),
        error,
    };
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    let file = std::fs::File::create(&part).map_err(io)?;
    let mut w = std::io::BufWriter::with_capacity(1 << 20, file);
    writeln!(w, "{CSV_HEADER}").map_err(io)?;
    for r in rows {
        writeln!(
            w,
            "{},{},{},{}",
            r.t,
            r.price.0.normalize(),
            r.size.0.normalize(),
            side(r.aggressor)
        )
        .map_err(io)?;
    }
    w.into_inner()
        .map_err(|e| io(e.into_error()))?
        .sync_all()
        .map_err(io)?;
    std::fs::rename(&part, path).map_err(io)
}

pub fn export_trades(
    store: &TickStore,
    input: &ExportTradesInput,
) -> Result<ExportTradesOutput, ExportError> {
    if input.from > input.to {
        return Err(ExportError::Invalid(format!(
            "from {} is after to {}",
            input.from, input.to
        )));
    }
    let dir = PathBuf::from(input.dir.trim());
    if dir.as_os_str().is_empty() {
        return Err(ExportError::Invalid("name a folder to write into".into()));
    }
    let saved = saved_contracts(store, input)?;
    let calendar = saved
        .first()
        .map_or(SessionCalendar::CmeGlobex, |s| s.calendar);
    let mut files = Vec::new();
    let mut missing = Vec::new();
    for session in calendar.sessions_between(input.from, input.to) {
        let date = session.trade_date;
        let Some(front) = front_for(&saved, date) else {
            missing.push(date);
            continue;
        };
        let spans = day_spans(front.calendar, date, input.scope);
        let mut rows = Vec::new();
        let mut complete = true;
        for span in &spans {
            rows.extend(store.read(front.key(), span.start, span.end)?);
            complete &= store.missing(front.key(), span.start, span.end)?.is_empty();
        }
        if rows.is_empty() {
            missing.push(date);
            continue;
        }
        if files.is_empty() {
            std::fs::create_dir_all(&dir).map_err(|error| ExportError::Io {
                path: dir.clone(),
                error,
            })?;
        }
        let path = dir.join(format!("{}-{date}.csv", front.root));
        write_csv(&path, &rows)?;
        files.push(ExportedDay {
            date,
            path: path.display().to_string(),
            contract: front.instrument.clone(),
            source: front.source.clone(),
            prints: rows.len() as u64,
            complete,
        });
    }
    Ok(ExportTradesOutput {
        dir: dir.display().to_string(),
        files,
        missing,
    })
}
