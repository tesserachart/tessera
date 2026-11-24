use std::collections::HashMap;
use std::str::FromStr;

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use tessera_core::Timestamp;
use tessera_core::csv::{Record, records};

pub fn normalize_header(header: &str) -> String {
    header
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

pub fn has_headers(headers: &[String], required: &[&str]) -> bool {
    let have: Vec<String> = headers.iter().map(|h| normalize_header(h)).collect();
    required
        .iter()
        .all(|r| have.iter().any(|h| *h == normalize_header(r)))
}

pub fn rows(content: &str) -> impl Iterator<Item = Record<'_>> {
    records(content, ',')
}

pub type Row = HashMap<String, String>;

#[derive(Clone, Debug, Default)]
pub struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<(usize, Row)>,
}

pub fn table_at(content: &str, header_line: usize, stop_at_section: bool) -> Table {
    let mut all = rows(content).skip_while(|r| r.line < header_line);
    let Some(header) = all.next().filter(|r| r.line == header_line) else {
        return Table::default();
    };
    let headers = header.fields;
    let keys: Vec<String> = headers.iter().map(|h| normalize_header(h)).collect();
    let mut rows = Vec::new();
    for record in all {
        if record.is_blank() {
            continue;
        }
        if stop_at_section && !record.raw.contains(',') {
            break;
        }
        let values = record.fields;
        let mut row = Row::new();
        for (col, key) in keys.iter().enumerate() {
            if key.is_empty() {
                continue;
            }
            let v = values.get(col).map(|s| s.trim()).unwrap_or_default();
            if row.get(key).is_some_and(|old| !old.is_empty()) && v.is_empty() {
                continue;
            }
            row.insert(key.clone(), v.to_owned());
        }
        rows.push((record.line, row));
    }
    Table { headers, rows }
}

pub fn table(content: &str) -> Table {
    let at = rows(content).find(|r| !r.is_blank()).map_or(1, |r| r.line);
    table_at(content, at, false)
}

pub fn field<'a>(row: &'a Row, candidates: &[&str]) -> Option<&'a str> {
    candidates.iter().find_map(|c| {
        row.get(&normalize_header(c))
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
    })
}

pub fn decimal(value: Option<&str>) -> Option<Decimal> {
    let v = value?.trim();
    if v.is_empty() {
        return None;
    }
    let (neg, v) = match v.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        Some(inner) => (true, inner),
        None => (false, v),
    };
    let clean: String = v
        .chars()
        .filter(|c| !matches!(c, '$' | ',' | '%' | ' '))
        .collect();
    if clean.is_empty() {
        return None;
    }
    let d = Decimal::from_str(&clean)
        .or_else(|_| Decimal::from_scientific(&clean))
        .ok()?;
    Some(if neg { -d } else { d })
}

pub fn side(value: Option<&str>) -> Option<tessera_core::orders::Side> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "b" | "buy" | "bot" | "bought" => Some(tessera_core::orders::Side::Buy),
        "s" | "sell" | "sld" | "sold" => Some(tessera_core::orders::Side::Sell),
        _ => None,
    }
}

pub fn is_filled(status: Option<&str>) -> bool {
    matches!(
        status.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("filled" | "fill")
    )
}

fn local(tz: Tz, dt: NaiveDateTime) -> Option<Timestamp> {
    tz.from_local_datetime(&dt)
        .earliest()
        .map(Timestamp::from_datetime)
}

pub fn instant(value: Option<&str>, tz: Tz) -> Option<Timestamp> {
    let v = value?.trim();
    if v.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(v) {
        return Some(Timestamp::from_datetime(dt));
    }
    if let Some((head, off)) = v.rsplit_once(' ')
        && (off.starts_with('+') || off.starts_with('-'))
        && off.contains(':')
    {
        for fmt in ["%m/%d/%Y %H:%M:%S %:z", "%Y-%m-%d %H:%M:%S %:z"] {
            if let Ok(dt) = DateTime::parse_from_str(&format!("{head} {off}"), fmt) {
                return Some(Timestamp::from_datetime(dt));
            }
        }
    }
    let upper = v.to_ascii_uppercase();
    for fmt in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%m/%d/%Y %I:%M:%S %p",
        "%m/%d/%Y %I:%M %p",
        "%m/%d/%y %I:%M:%S %p",
        "%m/%d/%Y %H:%M:%S%.f",
        "%m/%d/%Y %H:%M",
        "%m/%d/%y %H:%M:%S",
        "%m/%d/%y %H:%M",
    ] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(&upper, fmt) {
            return local(tz, dt);
        }
    }
    for fmt in ["%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"] {
        if let Ok(d) = NaiveDate::parse_from_str(v, fmt) {
            return local(tz, d.and_hms_opt(0, 0, 0)?);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_fields_and_headers() {
        assert_eq!(normalize_header(" Update Time (EDT) "), "updatetimeedt");
        assert_eq!(normalize_header("E/X"), "ex");
        let t = table("\u{feff}A,B,B\r\n1,,2\r\n\r\n3,4,\r\n");
        assert_eq!(t.headers, vec!["A", "B", "B"]);
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0].1["b"], "2");
        assert_eq!(t.rows[1].1["b"], "4");
        assert_eq!(t.rows[1].0, 4);
    }

    #[test]
    fn a_quoted_newline_in_a_note_keeps_the_row_whole() {
        let t = table("Symbol,Note,Qty\n\"NQZ6\",\"entered late,\nheld\",2\nESZ6,,1\n");
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0].1["note"], "entered late,\nheld");
        assert_eq!(t.rows[0].1["qty"], "2");
        assert_eq!((t.rows[1].0, t.rows[1].1["symbol"].as_str()), (4, "ESZ6"));
        let rithmic = "Completed Orders\nAccount,Status\nA1,\"Filled\nlate\"\nA2,Filled\nOpen Orders\nA3,Working\n";
        let at = rows(rithmic).find(|r| r.raw.contains(',')).unwrap().line;
        let t = table_at(rithmic, at, true);
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[1].1["account"], "A2");
    }

    #[test]
    fn numbers_and_instants() {
        assert_eq!(decimal(Some("$1,234.50")), Some(Decimal::new(123_450, 2)));
        assert_eq!(decimal(Some("(3.25)")), Some(Decimal::new(-325, 2)));
        assert_eq!(decimal(Some("")), None);
        let ny = chrono_tz::America::New_York;
        let t = |s: &str| instant(Some(s), ny);
        let utc = |s: &str| Some(Timestamp::parse(s).unwrap());
        assert_eq!(t("2024-04-24 10:30:05"), utc("2024-04-24T14:30:05Z"));
        assert_eq!(t("1/17/2024 1:10:38 PM"), utc("2024-01-17T18:10:38Z"));
        assert_eq!(t("05/07/2024 13:33:37 +00:00"), utc("2024-05-07T13:33:37Z"));
        assert_eq!(t("04/23/2024 09:11:54"), utc("2024-04-23T13:11:54Z"));
        assert_eq!(t("nonsense"), None);
    }
}
