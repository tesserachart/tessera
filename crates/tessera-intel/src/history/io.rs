use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::Timestamp;
use ts_rs::TS;

use super::mapping::ImportMapping;

/// `intel.get_level_history` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetLevelHistoryInput {
    /// The instrument (`NQ`, `NQZ6`, `NDX`): its series, and its root's (`NQ`) for a dated
    /// contract.
    pub instrument: String,
    /// Levels by name, `vendor.level` or `vendor.package.level` (`acme.call_wall`,
    /// `acme.gamma.call_wall`); every level stored on the instrument when omitted.
    #[serde(default)]
    pub levels: Option<Vec<String>>,
    /// From this vendor time (inclusive).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// To this vendor time (inclusive).
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Most observations per series (default 500, at most 5000); the earliest are returned.
    #[serde(default)]
    pub limit: Option<u32>,
}

/// One stored value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LevelObservation {
    /// The vendor's time of the value.
    pub as_of: Timestamp,
    /// When Tessera could first have known it (its arrival; the vendor's time for an import).
    pub known_at: Timestamp,
    /// The price; none when the vendor marks it not applicable.
    pub value: Option<f64>,
    /// The vendor's value before a price conversion (NDX before NQ).
    pub native_value: Option<f64>,
    /// Why there is no value.
    pub reason: Option<String>,
    /// `live`, `import` or `backfill`.
    pub origin: String,
}

/// A series and its history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeriesCoverageInfo {
    /// Its full name (`acme.gamma.call_wall`); `vendor.level` finds it too.
    pub name: String,
    /// The vendor, verbatim (`Acme`).
    pub vendor: String,
    /// The vendor's package, verbatim (`State`).
    pub package: String,
    /// The vendor's level name, verbatim (`major_long_gamma`).
    pub level: String,
    /// The vendor's own label (`Major Long Gamma`).
    pub label: Option<String>,
    /// What its price applies to (`NQZ6.CME`, `NDX`).
    pub instrument: String,
    /// The vendor request it comes from (`state/gamma_zero`).
    pub endpoint: Option<String>,
    /// The price space the vendor computed it in (`NDX`).
    pub basis: Option<String>,
    /// Its first vendor time.
    pub first: Timestamp,
    /// Its last.
    pub last: Timestamp,
    /// Its first New York date (`2026-10-07`).
    pub first_date: String,
    /// Its last.
    pub last_date: String,
    /// New York dates with at least one value.
    pub days: u32,
    /// Values stored.
    #[ts(type = "number")]
    pub observations: u64,
    /// Values by origin: `live` (recorded), `import`, `backfill`.
    #[ts(type = "Record<string, number>")]
    pub origins: BTreeMap<String, u64>,
}

/// `intel.get_level_history`: one series.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LevelHistorySeries {
    /// The series and its coverage.
    pub series: SeriesCoverageInfo,
    /// Its values in the range, oldest first.
    pub observations: Vec<LevelObservation>,
    /// More values exist in the range than were returned.
    pub truncated: bool,
}

/// `intel.get_level_history` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetLevelHistoryOutput {
    /// The instrument as resolved.
    pub instrument: String,
    /// The series found.
    pub series: Vec<LevelHistorySeries>,
    /// What to know (nothing stored yet, since when recording runs).
    pub notes: Vec<String>,
}

/// A provider whose snapshots are recorded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    /// Provider id (`acme`).
    pub provider: String,
    /// Its vendor.
    pub vendor: String,
    /// Its first snapshot recorded.
    pub since: Timestamp,
    /// Its latest.
    pub last: Timestamp,
    /// Snapshots recorded.
    #[ts(type = "number")]
    pub snapshots: u64,
}

/// An import, as kept.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LevelImportInfo {
    /// Id (`imp-…`); `intel.undo_level_import` takes it.
    pub id: String,
    /// The vendor.
    pub vendor: String,
    /// The file's name.
    pub file_name: Option<String>,
    /// How it was read (`mapping:acme`, `script:acme`, `backfill:acme`).
    pub adapter: String,
    /// Values the file gave.
    #[ts(type = "number")]
    pub records: u64,
    /// Stored.
    #[ts(type = "number")]
    pub imported: u64,
    /// Already there.
    #[ts(type = "number")]
    pub skipped: u64,
    /// The first value's vendor time.
    pub from: Option<Timestamp>,
    /// The last.
    pub to: Option<Timestamp>,
    /// When.
    pub at: Timestamp,
    /// Who (`user`, the analyst's session).
    pub by: String,
}

/// An adapter a file can be read with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    /// What picks it: a saved adapter's vendor key.
    pub name: String,
    /// The vendor it reads.
    pub vendor: String,
    /// `mapping` or `script`.
    pub kind: String,
    /// What it reads, in plain words.
    pub description: String,
}

/// `intel.list_level_history` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListLevelHistoryInput {}

/// `intel.list_level_history` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListLevelHistoryOutput {
    /// Every series with history, by vendor, package, level and instrument.
    pub series: Vec<SeriesCoverageInfo>,
    /// Providers recorded live, and since when.
    pub recordings: Vec<RecordingInfo>,
    /// Imports and backfills, newest first.
    pub imports: Vec<LevelImportInfo>,
    /// The saved adapters files can be read with.
    pub adapters: Vec<AdapterInfo>,
}

/// `intel.preview_file` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewFileInput {
    /// The file, inside the user's home or Tessera's data directory (`~/Downloads/acme.csv`).
    pub path: String,
}

/// One column of a previewed file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ColumnGuess {
    /// The column (a JSON record's key).
    pub name: String,
    /// `number`, `time`, `text` or `empty`, from the rows read.
    pub kind: String,
    /// For a time: how it is written (`unix_s`, `unix_ms`, `unix_ns`, `rfc3339`, or a pattern
    /// such as `%Y-%m-%d %H:%M:%S`), and whether it carries a zone.
    pub time_format: Option<String>,
    /// A time without a zone or offset: the mapping must say its `timeZone`.
    pub needs_zone: bool,
    /// Up to three values as written.
    pub examples: Vec<String>,
}

/// `intel.preview_file` output: the head of a file, never the whole of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFileOutput {
    /// The file, resolved.
    pub path: String,
    /// Its name.
    pub file_name: String,
    /// Its size on disk.
    #[ts(type = "number")]
    pub bytes: u64,
    /// It is gzip-compressed (read through).
    pub compressed: bool,
    /// `csv`, `json` (a list of records), `jsonl` (a record a line) or `text`.
    pub format: String,
    /// The CSV delimiter.
    pub delimiter: Option<String>,
    /// The header (a CSV's first line; the first JSON record's keys).
    pub header: Vec<String>,
    /// Up to 20 rows after the header, as written (long cells cut).
    pub rows: Vec<Vec<String>>,
    /// Each column, guessed from those rows.
    pub columns: Vec<ColumnGuess>,
    /// The first JSON record, long lists cut to three items.
    pub sample: Option<serde_json::Value>,
    /// Saved adapters that recognise the file.
    pub adapters: Vec<AdapterInfo>,
    /// The preview read only the file's head.
    pub partial: bool,
}

/// How a file is read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportAdapter {
    /// A declarative mapping given now.
    Mapping {
        /// The mapping.
        mapping: Box<ImportMapping>,
    },
    /// The mapping or JavaScript adapter saved under a vendor's name.
    Saved {
        /// The vendor (`Acme Levels`, or its key `acme-levels`).
        vendor: String,
    },
    /// JavaScript run by Tessera's own engine: `export function records(text, file)` reads the
    /// file's text (`file.name` is its name) and returns an object with `time` (Unix seconds, or
    /// ISO strings with an offset), `instrument`, `level` and `value` (arrays of one length, or a
    /// single string for all), and optionally `package`. A value of null or NaN is "not
    /// applicable".
    Script {
        /// The vendor, as it writes its name.
        vendor: String,
        /// The code.
        code: String,
    },
}

/// `intel.import_level_history` input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ImportLevelHistoryInput {
    /// The file, inside the user's home or Tessera's data directory.
    #[serde(default)]
    pub path: Option<String>,
    /// The file's text instead of a path (the Settings file picker).
    #[serde(default)]
    pub text: Option<String>,
    /// The file's name, with `text`.
    #[serde(default)]
    pub file_name: Option<String>,
    /// How it is read.
    pub adapter: ImportAdapter,
    /// Only say what would be stored (default true). Nothing is written until a call with
    /// `dryRun: false`.
    #[serde(default)]
    pub dry_run: Option<bool>,
    /// After a successful import (not a dry run), keep the mapping or JavaScript adapter under the
    /// vendor's name for next time.
    #[serde(default)]
    pub save: Option<bool>,
    /// Per series, keep only the last value of each interval of this many seconds (the one
    /// standing when the next begins): exact for bars of that size or more. Default: every
    /// value (a snapshot a second: 60).
    #[serde(default)]
    pub every_seconds: Option<u32>,
}

/// One series an import gives.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSeries {
    /// `vendor.package.level` (`acme-levels.call_wall` when no package).
    pub name: String,
    /// The vendor's package, verbatim.
    pub package: String,
    /// The vendor's level, verbatim.
    pub level: String,
    /// Its label, when the vendor declares one.
    pub label: Option<String>,
    /// The instrument.
    pub instrument: String,
    /// Values read.
    #[ts(type = "number")]
    pub records: u64,
    /// Values new to the store.
    #[ts(type = "number")]
    pub new: u64,
    /// First New York date.
    pub first_date: String,
    /// Last.
    pub last_date: String,
}

/// A record as it would be stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SampleRecord {
    /// The file's line.
    #[ts(type = "number")]
    pub line: u64,
    /// The vendor's time.
    pub time: Timestamp,
    /// The same in New York (`2026-10-07 09:31:00`).
    pub new_york: String,
    /// The instrument.
    pub instrument: String,
    /// `vendor.package.level`.
    pub name: String,
    /// The value; none when not applicable.
    pub value: Option<f64>,
}

/// A row that could not be read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RowProblem {
    /// Line (or record), 1-based; 0 for the whole file.
    #[ts(type = "number")]
    pub line: u64,
    /// Why.
    pub message: String,
}

/// `intel.import_level_history` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportLevelHistoryOutput {
    /// Nothing was written.
    pub dry_run: bool,
    /// The import's id when written (`intel.undo_level_import` takes it).
    pub import_id: Option<String>,
    /// The vendor.
    pub vendor: String,
    /// How the file was read (`mapping:acme-levels`, `script:acme-levels`, `backfill:acme`).
    pub adapter: String,
    /// Rows (or snapshots) in the file.
    #[ts(type = "number")]
    pub rows: u64,
    /// Values read.
    #[ts(type = "number")]
    pub records: u64,
    /// Values stored (would be, on a dry run).
    #[ts(type = "number")]
    pub imported: u64,
    /// Values already stored at the same vendor time: kept as they were.
    #[ts(type = "number")]
    pub duplicates: u64,
    /// Rows that could not be read.
    #[ts(type = "number")]
    pub unreadable: u64,
    /// The first of them, and why.
    pub problems: Vec<RowProblem>,
    /// Each series.
    pub series: Vec<ImportedSeries>,
    /// The instruments.
    pub instruments: Vec<String>,
    /// The first value's New York date.
    pub first_date: Option<String>,
    /// The last.
    pub last_date: Option<String>,
    /// New York dates covered.
    pub days: u32,
    /// A few records as they would be stored.
    pub samples: Vec<SampleRecord>,
    /// The vendor key the adapter was saved under.
    pub saved: Option<String>,
    /// What to know.
    pub notes: Vec<String>,
}

/// `intel.undo_level_import` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoLevelImportInput {
    /// The import (`imp-…`, from `intel.list_level_history`).
    pub import_id: String,
}

/// `intel.undo_level_import` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UndoLevelImportOutput {
    /// Values removed.
    #[ts(type = "number")]
    pub removed: u64,
}

/// `intel.backfill_level_history` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct BackfillLevelHistoryInput {
    /// The provider whose history is read (default: the first connected one that offers it).
    #[serde(default)]
    pub provider: Option<String>,
    /// The vendor's ticker (`NDX`, `SPX`, a futures-scale `NQ_NDX`).
    pub ticker: String,
    /// The instrument to file it under (default: the ticker; `NQ` for `NQ_NDX`).
    #[serde(default)]
    pub instrument: Option<String>,
    /// First trading day, `YYYY-MM-DD`.
    pub from: String,
    /// Last trading day, `YYYY-MM-DD` (default: `from`).
    #[serde(default)]
    pub to: Option<String>,
    /// The vendor's packages (default: every package the key reads, `Classic` and `State`).
    #[serde(default)]
    pub packages: Option<Vec<String>>,
    /// Only list the files it would ask for (default true). Each file spends one request of the
    /// vendor's history quota.
    #[serde(default)]
    pub dry_run: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackfillFile {
    /// The trading day.
    pub date: String,
    /// The vendor's package.
    pub package: String,
    /// `would_ask`, `stored`, `already` (stored before), `failed` or `later` (past this call's
    /// limit: ask again).
    pub status: String,
    /// Values stored.
    #[ts(type = "number")]
    pub imported: u64,
    /// Why it failed.
    pub message: Option<String>,
}

/// `intel.backfill_level_history` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackfillLevelHistoryOutput {
    /// Nothing was asked.
    pub dry_run: bool,
    /// The provider.
    pub provider: String,
    /// The vendor's ticker.
    pub ticker: String,
    /// The instrument it is filed under.
    pub instrument: String,
    /// Each file.
    pub files: Vec<BackfillFile>,
    /// Values stored.
    #[ts(type = "number")]
    pub imported: u64,
    /// What to know (quota, how far back the vendor keeps it).
    pub notes: Vec<String>,
}
