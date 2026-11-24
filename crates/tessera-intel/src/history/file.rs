use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone};
use chrono_tz::Tz;
use serde_json::Value;
use tessera_core::{Timestamp, csv};

use super::FileData;
use super::io::{ColumnGuess, PreviewFileOutput};

pub const MAX_BYTES: u64 = 768 << 20;
pub const PREVIEW_BYTES: u64 = 1 << 20;
pub const PREVIEW_ROWS: usize = 20;
const MAX_UTF8_CHAR_LEN: usize = 4;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Roots {
    pub home: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
}

impl Roots {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            home: std::env::var_os("HOME").map(PathBuf::from),
            data_dir,
        }
    }

    pub fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let raw = path.trim();
        if raw.is_empty() {
            return Err("give the file's path".into());
        }
        let expanded = match (raw.strip_prefix("~/"), &self.home) {
            (Some(rest), Some(h)) => h.join(rest),
            _ => PathBuf::from(raw),
        };
        if !expanded.is_absolute() {
            return Err(format!(
                "{raw}: give the full path (or one starting with ~/)"
            ));
        }
        let real = expanded
            .canonicalize()
            .map_err(|e| format!("{raw}: {}", plain_io(&e)))?;
        let inside = [&self.home, &self.data_dir]
            .into_iter()
            .flatten()
            .filter_map(|r| r.canonicalize().ok())
            .any(|r| real.starts_with(&r));
        if !inside {
            return Err(format!(
                "{raw} is outside your home and Tessera's data directory; files are only read from there"
            ));
        }
        if !real.is_file() {
            return Err(format!("{raw} is not a file"));
        }
        Ok(real)
    }
}

fn plain_io(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "no such file".into(),
        std::io::ErrorKind::PermissionDenied => "not readable".into(),
        _ => e.to_string(),
    }
}

pub fn is_gzip(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1f, 0x8b])
}

fn read_limited(reader: impl Read, gz: bool, limit: u64) -> Result<(Vec<u8>, bool), String> {
    let mut out = Vec::new();
    let mut r: Box<dyn Read> = if gz {
        Box::new(flate2::read::MultiGzDecoder::new(reader))
    } else {
        Box::new(reader)
    };
    let n = (&mut r)
        .take(limit + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("could not read it: {e}"))?;
    let whole = n as u64 <= limit;
    out.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    Ok((out, whole))
}

pub fn from_bytes(name: &str, bytes: Vec<u8>) -> Result<FileData, String> {
    if !is_gzip(&bytes) {
        return Ok(FileData {
            name: name.to_owned(),
            bytes,
        });
    }
    let (out, whole) = read_limited(&bytes[..], true, MAX_BYTES)?;
    if !whole {
        return Err(format!(
            "{name} is larger than {} MB once decompressed",
            MAX_BYTES >> 20
        ));
    }
    Ok(FileData {
        name: name.trim_end_matches(".gz").to_owned(),
        bytes: out,
    })
}

pub fn read(path: &Path) -> Result<FileData, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut f = std::fs::File::open(path).map_err(|e| format!("{name}: {}", plain_io(&e)))?;
    let mut head = [0u8; 2];
    let gz = f
        .read(&mut head)
        .map(|n| n == 2 && is_gzip(&head))
        .unwrap_or(false);
    let f = std::fs::File::open(path).map_err(|e| format!("{name}: {}", plain_io(&e)))?;
    let (bytes, whole) = read_limited(f, gz, MAX_BYTES)?;
    if !whole {
        return Err(format!(
            "{name} is larger than {} MB; split it",
            MAX_BYTES >> 20
        ));
    }
    Ok(FileData {
        name: if gz {
            name.trim_end_matches(".gz").to_owned()
        } else {
            name
        },
        bytes,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Table {
    pub format: String,
    pub delimiter: Option<char>,
    pub header: Vec<String>,
    pub rows: Vec<(usize, Vec<String>)>,
}

impl Table {
    pub fn column(&self, name: &str) -> Option<usize> {
        let norm = |s: &str| -> String {
            s.chars()
                .filter(char::is_ascii_alphanumeric)
                .map(|c| c.to_ascii_lowercase())
                .collect()
        };
        self.header
            .iter()
            .position(|h| h == name)
            .or_else(|| self.header.iter().position(|h| norm(h) == norm(name)))
    }
}

fn lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .enumerate()
        .map(|(i, l)| (i + 1, l))
}

fn filled_records(
    text: &str,
    delimiter: char,
    from_line: usize,
) -> impl Iterator<Item = csv::Record<'_>> {
    csv::records(text, delimiter)
        .skip_while(move |r| r.line < from_line)
        .filter(|r| !r.is_blank())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Csv,
    Json,
    JsonLines,
    JsonObject,
}

pub fn shape(text: &str) -> Shape {
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with('[') {
        Shape::Json
    } else if t.starts_with('{') {
        let mut ls = t.lines().map(str::trim).filter(|l| !l.is_empty());
        let first = ls.next().unwrap_or_default();
        if first.ends_with('}') && ls.next().is_some_and(|l| l.starts_with('{')) {
            Shape::JsonLines
        } else {
            Shape::JsonObject
        }
    } else {
        Shape::Csv
    }
}

fn cell(v: &Value) -> Option<String> {
    match v {
        Value::Null => Some(String::new()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        Value::Array(_) | Value::Object(_) => None,
    }
}

fn records_table(format: &str, records: &[(usize, Value)]) -> Result<Table, String> {
    let mut header: Vec<String> = Vec::new();
    for (_, r) in records.iter().take(200) {
        let Value::Object(m) = r else {
            continue;
        };
        for (k, v) in m {
            if cell(v).is_some() && !header.contains(k) {
                header.push(k.clone());
            }
        }
    }
    if header.is_empty() {
        return Err("the JSON holds no records with plain values (a nested format needs the vendor's adapter or a JavaScript one)".into());
    }
    let rows = records
        .iter()
        .map(|(line, r)| {
            let cells = header
                .iter()
                .map(|h| r.get(h).and_then(cell).unwrap_or_default())
                .collect();
            (*line, cells)
        })
        .collect();
    Ok(Table {
        format: format.into(),
        delimiter: None,
        header,
        rows,
    })
}

pub fn list_items(bytes: &[u8], max: usize) -> (Vec<(usize, usize)>, bool) {
    let mut out = Vec::new();
    let Some(open) = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace() && *b != 0xef && *b != 0xbb && *b != 0xbf)
    else {
        return (out, true);
    };
    if bytes[open] != b'[' {
        return (out, false);
    }
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    let mut start: Option<usize> = None;
    for (i, &b) in bytes.iter().enumerate().skip(open + 1) {
        if in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => {
                in_str = true;
                start.get_or_insert(i);
            }
            b'{' | b'[' => {
                start.get_or_insert(i);
                depth += 1;
            }
            b'}' | b']' if depth > 0 => depth -= 1,
            b']' => {
                if let Some(s) = start.take() {
                    out.push((s, i));
                }
                return (out, true);
            }
            b',' if depth == 0 => {
                if let Some(s) = start.take() {
                    out.push((s, i));
                    if out.len() >= max {
                        return (out, false);
                    }
                }
            }
            c if !c.is_ascii_whitespace() => {
                start.get_or_insert(i);
            }
            _ => {}
        }
    }
    (out, false)
}

pub fn json_records(text: &str) -> Result<Vec<(usize, Value)>, String> {
    match shape(text) {
        Shape::Json => {
            let (items, whole) = list_items(text.as_bytes(), usize::MAX);
            if !whole {
                return Err("the JSON list does not end".into());
            }
            items
                .iter()
                .enumerate()
                .map(|(i, (s, e))| {
                    serde_json::from_str(&text[*s..*e])
                        .map(|v| (i + 1, v))
                        .map_err(|err| format!("record {}: {err}", i + 1))
                })
                .collect()
        }
        Shape::JsonLines => lines(text)
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(n, l)| {
                serde_json::from_str(l)
                    .map(|v| (n, v))
                    .map_err(|e| format!("line {n}: {e}"))
            })
            .collect(),
        Shape::JsonObject => {
            let v: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
            Ok(vec![(1, v)])
        }
        Shape::Csv => Err("not JSON".into()),
    }
}

pub fn table(text: &str, delimiter: Option<char>) -> Result<Table, String> {
    let text = text.trim_start_matches('\u{feff}');
    match shape(text) {
        Shape::Csv => {
            let Some(head) = csv::records(text, ',').find(|r| !r.is_blank()) else {
                return Err("the file is empty".into());
            };
            let d = delimiter.unwrap_or_else(|| csv::sniff_delimiter(head.raw));
            let mut it = filled_records(text, d, head.line);
            let header = it.next().map(|r| r.fields).unwrap_or_default();
            let rows = it.map(|r| (r.line, r.fields)).collect();
            Ok(Table {
                format: "csv".into(),
                delimiter: Some(d),
                header,
                rows,
            })
        }
        Shape::Json => records_table("json", &json_records(text)?),
        Shape::JsonLines => records_table("jsonl", &json_records(text)?),
        Shape::JsonObject => Err("the file is one JSON object, not a list of records: read it with the vendor's adapter, or a JavaScript one".into()),
    }
}

const PATTERNS: &[&str] = &[
    "%Y-%m-%d %H:%M:%S%.f",
    "%Y-%m-%dT%H:%M:%S%.f",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",
    "%Y%m%d %H:%M:%S",
];

fn epoch(n: f64, unit: &str) -> Option<Timestamp> {
    if !n.is_finite() {
        return None;
    }
    let ns = match unit {
        "unix_s" => n * 1e9,
        "unix_ms" => n * 1e6,
        "unix_us" => n * 1e3,
        _ => n,
    };
    (ns.abs() < 9.2e18).then(|| Timestamp(ns.round() as i64))
}

pub fn epoch_unit(n: f64) -> &'static str {
    let a = n.abs();
    if a < 1e11 {
        "unix_s"
    } else if a < 1e14 {
        "unix_ms"
    } else if a < 1e17 {
        "unix_us"
    } else {
        "unix_ns"
    }
}

fn zone(tz: Option<&str>) -> Result<Option<Tz>, String> {
    tz.filter(|z| !z.trim().is_empty())
        .map(|z| {
            z.trim()
                .parse::<Tz>()
                .map_err(|_| format!("{z} is not an IANA time zone (America/New_York, UTC)"))
        })
        .transpose()
}

fn local(n: NaiveDateTime, tz: Option<Tz>, what: &str) -> Result<Timestamp, String> {
    let tz = tz.ok_or_else(|| {
        format!("{what} has no zone or offset: say the file's timeZone (America/New_York, UTC)")
    })?;
    let t = tz
        .from_local_datetime(&n)
        .earliest()
        .ok_or_else(|| format!("{what} does not exist in {tz} (a clock change)"))?;
    t.timestamp_nanos_opt()
        .map(Timestamp)
        .ok_or_else(|| format!("{what} is out of range"))
}

pub fn parse_time(s: &str, format: &str, tz: Option<&str>) -> Result<Timestamp, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("no time".into());
    }
    let tz = zone(tz)?;
    let bad = || format!("{s:?} is not a time in {format}");
    match format {
        "unix_s" | "unix_ms" | "unix_us" | "unix_ns" => {
            let n: f64 = s.parse().map_err(|_| bad())?;
            epoch(n, format).ok_or_else(bad)
        }
        "rfc3339" => DateTime::parse_from_rfc3339(s)
            .ok()
            .and_then(|t| t.timestamp_nanos_opt())
            .map(Timestamp)
            .ok_or_else(bad),
        "" | "auto" => {
            if let Ok(n) = s.parse::<f64>() {
                return epoch(n, epoch_unit(n)).ok_or_else(bad);
            }
            if let Some(t) = DateTime::parse_from_rfc3339(s)
                .ok()
                .or_else(|| DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f%:z").ok())
                .or_else(|| DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f%z").ok())
            {
                return t.timestamp_nanos_opt().map(Timestamp).ok_or_else(bad);
            }
            for p in PATTERNS {
                if let Ok(n) = NaiveDateTime::parse_from_str(s, p) {
                    return local(n, tz, s);
                }
            }
            if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                return local(d.and_hms_opt(0, 0, 0).unwrap_or_default(), tz, s);
            }
            Err(format!(
                "{s:?} is not a time Tessera reads by itself: give the timeFormat (a pattern such as %Y-%m-%d %H:%M:%S)"
            ))
        }
        pattern => {
            if let Ok(t) = DateTime::parse_from_str(s, pattern) {
                return t.timestamp_nanos_opt().map(Timestamp).ok_or_else(bad);
            }
            NaiveDateTime::parse_from_str(s, pattern)
                .map_err(|_| bad())
                .and_then(|n| local(n, tz, s))
        }
    }
}

pub fn guess_time(name: &str, values: &[&str]) -> Option<(String, bool)> {
    let first = values.iter().find(|v| !v.trim().is_empty())?;
    let named = {
        let n = name.to_ascii_lowercase();
        [
            "time",
            "date",
            "timestamp",
            "ts",
            "datetime",
            "as_of",
            "asof",
        ]
        .iter()
        .any(|k| n == *k || n.contains("time") || n.contains("date"))
    };
    if let Ok(n) = first.trim().parse::<f64>() {
        let unit = epoch_unit(n);
        let plausible = match unit {
            "unix_s" => (9e8..4.2e9).contains(&n),
            "unix_ms" => (9e11..4.2e12).contains(&n),
            "unix_us" => (9e14..4.2e15).contains(&n),
            _ => (9e17..4.2e18).contains(&n),
        };
        return (plausible && (named || unit != "unix_s"))
            .then(|| (unit.to_owned(), false))
            .or_else(|| (plausible && named).then(|| (unit.to_owned(), false)));
    }
    let s = first.trim();
    if DateTime::parse_from_rfc3339(s).is_ok() {
        return Some(("rfc3339".into(), false));
    }
    for p in PATTERNS {
        if NaiveDateTime::parse_from_str(s, p).is_ok() {
            return Some(((*p).to_owned(), true));
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .map(|_| ("%Y-%m-%d".to_owned(), true))
}

pub fn number(s: &str) -> Result<Option<f64>, String> {
    let t = s.trim();
    if t.is_empty()
        || ["nan", "null", "none", "n/a", "na", "-", "—"].contains(&t.to_ascii_lowercase().as_str())
    {
        return Ok(None);
    }
    let cleaned: String = t
        .chars()
        .filter(|c| !matches!(c, ',' | '$' | ' ' | '_'))
        .collect();
    cleaned
        .parse::<f64>()
        .map(|v| v.is_finite().then_some(v))
        .map_err(|_| format!("{t:?} is not a number"))
}

fn cut(s: &str) -> String {
    if s.chars().count() > 120 {
        format!("{}…", s.chars().take(119).collect::<String>())
    } else {
        s.to_owned()
    }
}

fn shorten(v: &Value) -> Value {
    match v {
        Value::Array(a) => {
            let mut out: Vec<Value> = a.iter().take(3).map(shorten).collect();
            if a.len() > 3 {
                out.push(Value::String(format!("… {} more", a.len() - 3)));
            }
            Value::Array(out)
        }
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), shorten(v))).collect()),
        Value::String(s) => Value::String(cut(s)),
        other => other.clone(),
    }
}

fn guess_columns(header: &[String], rows: &[Vec<String>]) -> Vec<ColumnGuess> {
    header
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let values: Vec<&str> = rows
                .iter()
                .filter_map(|r| r.get(i).map(String::as_str))
                .filter(|v| !v.trim().is_empty())
                .collect();
            let examples = values.iter().take(3).map(|v| cut(v)).collect();
            if values.is_empty() {
                return ColumnGuess {
                    name: name.clone(),
                    kind: "empty".into(),
                    time_format: None,
                    needs_zone: false,
                    examples,
                };
            }
            if let Some((fmt, needs_zone)) = guess_time(name, &values) {
                return ColumnGuess {
                    name: name.clone(),
                    kind: "time".into(),
                    time_format: Some(fmt),
                    needs_zone,
                    examples,
                };
            }
            let numeric = values.iter().all(|v| number(v).is_ok());
            ColumnGuess {
                name: name.clone(),
                kind: if numeric { "number" } else { "text" }.into(),
                time_format: None,
                needs_zone: false,
                examples,
            }
        })
        .collect()
}

pub fn preview(path: &Path) -> Result<PreviewFileOutput, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let size = std::fs::metadata(path)
        .map_err(|e| format!("{name}: {}", plain_io(&e)))?
        .len();
    let mut f = std::fs::File::open(path).map_err(|e| format!("{name}: {}", plain_io(&e)))?;
    let mut head = [0u8; 2];
    let gz = f
        .read(&mut head)
        .map(|n| n == 2 && is_gzip(&head))
        .unwrap_or(false);
    let f = std::fs::File::open(path).map_err(|e| format!("{name}: {}", plain_io(&e)))?;
    let (bytes, whole) = read_limited(f, gz, PREVIEW_BYTES)?;
    let text = match std::str::from_utf8(&bytes) {
        Ok(t) => t,
        Err(e) if !whole && e.valid_up_to() + MAX_UTF8_CHAR_LEN >= bytes.len() => {
            std::str::from_utf8(&bytes[..e.valid_up_to()]).unwrap_or_default()
        }
        Err(_) => return Err(format!("{name} is not text (nor gzip-compressed text)")),
    };
    let text = text.trim_start_matches('\u{feff}');
    let mut out = PreviewFileOutput {
        path: path.display().to_string(),
        file_name: name,
        bytes: size,
        compressed: gz,
        format: "text".into(),
        delimiter: None,
        header: Vec::new(),
        rows: Vec::new(),
        columns: Vec::new(),
        sample: None,
        adapters: Vec::new(),
        partial: !whole,
    };
    match shape(text) {
        Shape::Csv => {
            if let Some(head) = csv::records(text, ',').find(|r| !r.is_blank()) {
                let d = csv::sniff_delimiter(head.raw);
                let mut it = filled_records(text, d, head.line);
                out.format = "csv".into();
                out.delimiter = Some(if d == '\t' {
                    "\\t".into()
                } else {
                    d.to_string()
                });
                out.header = it.next().map(|r| r.fields).unwrap_or_default();
                let rows: Vec<Vec<String>> = it.take(PREVIEW_ROWS + 1).map(|r| r.fields).collect();
                let keep = if whole {
                    rows.len()
                } else {
                    rows.len().saturating_sub(1)
                };
                out.rows = rows.into_iter().take(keep.min(PREVIEW_ROWS)).collect();
            }
        }
        shape @ (Shape::Json | Shape::JsonLines | Shape::JsonObject) => {
            let records: Vec<Value> = match shape {
                Shape::Json => {
                    let (items, _) = list_items(text.as_bytes(), PREVIEW_ROWS);
                    items
                        .iter()
                        .filter_map(|(s, e)| serde_json::from_str(&text[*s..*e]).ok())
                        .collect()
                }
                Shape::JsonLines => lines(text)
                    .filter(|(_, l)| !l.trim().is_empty())
                    .take(PREVIEW_ROWS)
                    .filter_map(|(_, l)| serde_json::from_str(l).ok())
                    .collect(),
                _ => serde_json::from_str(text).ok().into_iter().collect(),
            };
            out.format = match shape {
                Shape::Json => "json",
                Shape::JsonLines => "jsonl",
                _ => "json_object",
            }
            .into();
            out.sample = records.first().map(shorten);
            let numbered: Vec<(usize, Value)> = records.into_iter().enumerate().collect();
            if let Ok(t) = records_table(&out.format, &numbered) {
                out.header = t.header;
                out.rows = t
                    .rows
                    .into_iter()
                    .map(|(_, r)| r.iter().map(|c| cut(c)).collect())
                    .collect();
            } else if let Some(Value::Object(m)) = &out.sample {
                out.header = m.keys().cloned().collect();
            }
        }
    }
    out.columns = guess_columns(&out.header, &out.rows);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_and_json_read_as_tables() {
        let t = table(
            "time;level;value\n2026-10-07 09:31:00;\"call, wall\";20850\n",
            None,
        )
        .unwrap();
        assert_eq!(t.delimiter, Some(';'));
        assert_eq!(t.header, ["time", "level", "value"]);
        assert_eq!(t.rows[0].1[1], "call, wall");
        assert_eq!(t.column("Value"), Some(2));
        let j = table(r#"[{"timestamp": 1, "zero_gamma": 2, "strikes": [[1,2]]}, {"timestamp": 3, "zero_gamma": null}]"#, None).unwrap();
        assert_eq!(j.header, ["timestamp", "zero_gamma"]);
        assert_eq!(j.rows[1], (2, vec!["3".to_owned(), String::new()]));
        let l = table("{\"t\": 1}\n{\"t\": 2}\n", None).unwrap();
        assert_eq!(l.format, "jsonl");
        assert_eq!(l.rows.len(), 2);
        assert!(table(r#"{"data": {"x": 1}}"#, None).is_err());
    }

    #[test]
    fn a_quoted_newline_keeps_a_csv_row_whole() {
        let t = table(
            "time,label,value\r\n2026-10-07 09:31:00,\"call wall,\nfront month\",20850\r\n2026-10-07 09:32:00,put wall,20700\r\n",
            None,
        )
        .unwrap();
        assert_eq!(t.rows.len(), 2);
        assert_eq!(
            t.rows[0],
            (
                2,
                vec![
                    "2026-10-07 09:31:00".to_owned(),
                    "call wall,\nfront month".to_owned(),
                    "20850".to_owned()
                ]
            )
        );
        assert_eq!(t.rows[1].0, 4);
    }

    #[test]
    fn list_items_scan_without_parsing_the_whole_list() {
        let s = br#" [ {"a": "x,]}"}, {"b": [1, {"c": 2}]}, 3 ] "#;
        let (items, whole) = list_items(s, 10);
        assert!(whole);
        let got: Vec<&str> = items
            .iter()
            .map(|(a, b)| std::str::from_utf8(&s[*a..*b]).unwrap().trim())
            .collect();
        assert_eq!(got, [r#"{"a": "x,]}"}"#, r#"{"b": [1, {"c": 2}]}"#, "3"]);
        let (two, whole) = list_items(s, 2);
        assert_eq!(two.len(), 2);
        assert!(!whole);
    }

    #[test]
    fn times_read_in_the_ways_vendors_write_them() {
        let ny = Some("America/New_York");
        let at = parse_time("2026-10-07 09:31:00", "auto", ny).unwrap();
        assert_eq!(at, Timestamp::parse("2026-10-07T09:31:00-04:00").unwrap());
        assert_eq!(
            parse_time("1791379860", "auto", None).unwrap(),
            Timestamp(1_791_379_860_000_000_000)
        );
        assert_eq!(
            parse_time("1791379860000", "auto", None).unwrap(),
            Timestamp(1_791_379_860_000_000_000)
        );
        assert_eq!(
            parse_time("2026-10-07T13:31:00Z", "auto", None).unwrap(),
            at
        );
        assert_eq!(
            parse_time("07.10.2026 09:31", "%d.%m.%Y %H:%M", ny).unwrap(),
            at
        );
        let e = parse_time("2026-10-07 09:31:00", "auto", None).unwrap_err();
        assert!(e.contains("timeZone"), "{e}");
        assert!(parse_time("x", "unix_s", None).is_err());
        assert_eq!(
            guess_time("timestamp", &["1791379860"]),
            Some(("unix_s".into(), false))
        );
        assert_eq!(guess_time("strike", &["20850"]), None);
        assert_eq!(
            guess_time("when", &["2026-10-07 09:31:00"]),
            Some(("%Y-%m-%d %H:%M:%S%.f".into(), true))
        );
        assert_eq!(number("20,850.25").unwrap(), Some(20_850.25));
        assert_eq!(number("N/A").unwrap(), None);
        assert!(number("abc").is_err());
    }

    #[test]
    fn paths_are_read_only_inside_the_roots_and_previews_read_the_head() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let roots = Roots {
            home: Some(home.path().to_path_buf()),
            data_dir: None,
        };
        let inside = home.path().join("acme.csv");
        let mut csv = String::from("ts,ticker,call_wall\n");
        for i in 0..100 {
            csv.push_str(&format!("{},NDX,{}\n", 1_791_379_860 + i * 60, 20_800 + i));
        }
        std::fs::write(&inside, &csv).unwrap();
        let outside = other.path().join("x.csv");
        std::fs::write(&outside, "a\n").unwrap();
        assert!(roots.resolve(inside.to_str().unwrap()).is_ok());
        assert!(roots.resolve("~/acme.csv").is_ok());
        assert!(
            roots
                .resolve(outside.to_str().unwrap())
                .unwrap_err()
                .contains("outside")
        );
        assert!(roots.resolve("~/../../etc/passwd").is_err());
        assert!(roots.resolve("relative.csv").is_err());

        let p = preview(&inside).unwrap();
        assert_eq!(p.format, "csv");
        assert_eq!(p.rows.len(), PREVIEW_ROWS);
        assert_eq!(p.columns[0].kind, "time");
        assert_eq!(p.columns[0].time_format.as_deref(), Some("unix_s"));
        assert_eq!(p.columns[1].kind, "text");
        assert_eq!(p.columns[2].kind, "number");

        let gz = home.path().join("acme.json.gz");
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut enc, br#"[{"timestamp": 1791379860, "zero_gamma": 20610, "strikes": [[1,2,3],[4,5,6],[7,8,9],[1,1,1]]}]"#).unwrap();
        std::fs::write(&gz, enc.finish().unwrap()).unwrap();
        let p = preview(&gz).unwrap();
        assert!(p.compressed);
        assert_eq!(p.format, "json");
        assert_eq!(p.header, ["timestamp", "zero_gamma"]);
        assert_eq!(p.sample.unwrap()["strikes"].as_array().unwrap().len(), 4);
        let f = read(&gz).unwrap();
        assert_eq!(f.name, "acme.json");
        assert!(f.text().unwrap().starts_with('['));
    }
}
