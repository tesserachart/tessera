use std::collections::BTreeMap;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::file::{self, Table};
use super::{Adapted, FileData, HistoryAdapter, LevelDecl, Problem, Record};

/// One column of a wide file that holds a level.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields, rename = "MappingLevelColumn")]
pub struct LevelColumn {
    /// The column.
    pub column: String,
    /// The vendor's name for the level (default: the column's own name).
    #[serde(default)]
    pub level: Option<String>,
    /// Its package, when it differs from the mapping's.
    #[serde(default)]
    pub package: Option<String>,
}

/// What the vendor says about one of its levels.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct VocabularyEntry {
    /// The vendor's own name for it (`Call Wall`).
    #[serde(default)]
    pub label: Option<String>,
    /// Its package, when it differs from the mapping's.
    #[serde(default)]
    pub package: Option<String>,
    /// The vendor request or product it comes from.
    #[serde(default)]
    pub endpoint: Option<String>,
    /// What the vendor says it means.
    #[serde(default)]
    pub description: Option<String>,
}

/// A vendor's flat files, mapped: kept under the vendor's name once it worked.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ImportMapping {
    /// The vendor, as it writes its name (`Acme Levels`). Every series keeps it verbatim.
    pub vendor: String,
    /// The vendor's package or product for every level (unless a level says otherwise).
    #[serde(default)]
    pub package: Option<String>,
    /// The column holding the time.
    pub time: String,
    /// How times are written: `auto` (default: Unix seconds, ms or ns by size, RFC 3339, common
    /// date-times), `unix_s`, `unix_ms`, `unix_ns`, `rfc3339`, or a pattern
    /// (`%Y-%m-%d %H:%M:%S`, `%m/%d/%Y %H:%M`).
    #[serde(default)]
    pub time_format: Option<String>,
    /// The IANA zone of times written without an offset (`America/New_York`). Required for them.
    #[serde(default)]
    pub time_zone: Option<String>,
    /// The column holding the instrument (the vendor's ticker).
    #[serde(default)]
    pub instrument: Option<String>,
    /// The instrument of every row, when the file has no such column (`NDX`).
    #[serde(default)]
    pub instrument_value: Option<String>,
    /// The vendor's tickers as Tessera instruments (`{"NQ_NDX": "NQ"}`); others are kept.
    #[serde(default)]
    pub instruments: BTreeMap<String, String>,
    /// A row per value (long): the column naming the level.
    #[serde(default)]
    pub level: Option<String>,
    /// A row per value (long): the column holding its value.
    #[serde(default)]
    pub value: Option<String>,
    /// A column per level (wide).
    #[serde(default)]
    pub levels: Vec<LevelColumn>,
    /// Long form: only these levels (default: every level the file names).
    #[serde(default)]
    pub only: Vec<String>,
    /// Values the vendor writes for "not applicable" (`0`): stored without a price, never
    /// as price 0.
    #[serde(default)]
    pub na_if: Vec<f64>,
    /// The vendor's vocabulary, by level name.
    #[serde(default)]
    pub vocabulary: BTreeMap<String, VocabularyEntry>,
    /// The price space the values are in (default: the instrument).
    #[serde(default)]
    pub basis: Option<String>,
    /// The CSV delimiter (default: read from the header).
    #[serde(default)]
    pub delimiter: Option<String>,
}

impl ImportMapping {
    pub fn problems(&self) -> Vec<String> {
        let mut p = Vec::new();
        if self.vendor.trim().is_empty() {
            p.push("name the vendor, as it writes its name".to_owned());
        }
        if self.time.trim().is_empty() {
            p.push("say which column holds the time".to_owned());
        }
        if self.instrument.is_none() && self.instrument_value.is_none() {
            p.push("say which column holds the instrument, or the instrument of every row (instrumentValue)".to_owned());
        }
        let long = self.level.is_some() || self.value.is_some();
        match (long, self.levels.is_empty()) {
            (true, false) => p.push("give either level and value (a row per value) or levels (a column per level), not both".to_owned()),
            (false, true) => p.push("say where the levels are: level and value columns, or levels (a column per level)".to_owned()),
            (true, true) if self.level.is_none() || self.value.is_none() => {
                p.push("a row per value needs both the level column and the value column".to_owned());
            }
            _ => {}
        }
        if let Some(z) = &self.time_zone
            && z.parse::<chrono_tz::Tz>().is_err()
        {
            p.push(format!(
                "{z} is not an IANA time zone (America/New_York, UTC)"
            ));
        }
        p
    }

    fn package_of(&self, level: &str, column: Option<&LevelColumn>) -> String {
        column
            .and_then(|c| c.package.clone())
            .or_else(|| self.vocabulary.get(level).and_then(|v| v.package.clone()))
            .or_else(|| self.package.clone())
            .unwrap_or_default()
            .trim()
            .to_owned()
    }

    fn instrument_of(&self, raw: &str) -> String {
        let raw = raw.trim();
        self.instruments
            .get(raw)
            .cloned()
            .unwrap_or_else(|| raw.to_owned())
    }

    pub fn apply(&self, table: &Table) -> Result<Adapted, String> {
        let problems = self.problems();
        if !problems.is_empty() {
            return Err(problems.join("; "));
        }
        let col = |name: &str, what: &str| {
            table.column(name).ok_or_else(|| {
                format!(
                    "no column {name:?} for the {what}; the file has {}",
                    table.header.join(", ")
                )
            })
        };
        let time_col = col(&self.time, "time")?;
        let inst_col = self
            .instrument
            .as_deref()
            .map(|c| col(c, "instrument"))
            .transpose()?;
        let format = self.time_format.as_deref().unwrap_or("auto");
        let tz = self.time_zone.as_deref();
        let mut out = Adapted {
            vendor: self.vendor.trim().to_owned(),
            rows: table.rows.len(),
            ..Adapted::default()
        };
        let wide: Vec<(String, String, usize)> = self
            .levels
            .iter()
            .map(|c| {
                let level = c.level.clone().unwrap_or_else(|| c.column.clone());
                let pkg = self.package_of(&level, Some(c));
                col(&c.column, "level").map(|i| (level, pkg, i))
            })
            .collect::<Result<_, _>>()?;
        let long = match (&self.level, &self.value) {
            (Some(l), Some(v)) => Some((col(l, "level name")?, col(v, "value")?)),
            _ => None,
        };
        for (line, cells) in &table.rows {
            let get = |i: usize| cells.get(i).map(String::as_str).unwrap_or_default();
            let time = match file::parse_time(get(time_col), format, tz) {
                Ok(t) => t,
                Err(e) => {
                    out.problems.push(Problem {
                        line: *line,
                        message: e,
                    });
                    continue;
                }
            };
            let instrument = match (inst_col, &self.instrument_value) {
                (Some(i), _) => self.instrument_of(get(i)),
                (None, Some(v)) => self.instrument_of(v),
                (None, None) => String::new(),
            };
            if instrument.is_empty() {
                out.problems.push(Problem {
                    line: *line,
                    message: "no instrument".into(),
                });
                continue;
            }
            let push = |level: &str, package: &str, raw: &str, out: &mut Adapted| match file::number(
                raw,
            ) {
                Ok(None) => {}
                Ok(Some(v)) => {
                    let na = self.na_if.iter().any(|x| (x - v).abs() < 1e-12);
                    out.records.push(Record {
                        time,
                        instrument: instrument.clone(),
                        package: package.to_owned(),
                        level: level.to_owned(),
                        value: (!na).then_some(v),
                        reason: na
                            .then(|| format!("{} marks it not applicable", self.vendor.trim())),
                        line: *line,
                    });
                }
                Err(e) => out.problems.push(Problem {
                    line: *line,
                    message: format!("{level}: {e}"),
                }),
            };
            if let Some((lc, vc)) = long {
                let level = get(lc).trim();
                if level.is_empty() {
                    out.problems.push(Problem {
                        line: *line,
                        message: "no level name".into(),
                    });
                    continue;
                }
                if !self.only.is_empty() && !self.only.iter().any(|o| o == level) {
                    continue;
                }
                let pkg = self.package_of(level, None);
                push(level, &pkg, get(vc), &mut out);
            } else {
                for (level, pkg, i) in &wide {
                    push(level, pkg, get(*i), &mut out);
                }
            }
        }
        let mut seen: Vec<(String, String)> = out
            .records
            .iter()
            .map(|r| (r.package.clone(), r.level.clone()))
            .collect();
        seen.sort();
        seen.dedup();
        for (pkg, level) in seen {
            let v = self.vocabulary.get(&level).cloned().unwrap_or_default();
            out.declared.insert(
                (pkg, level),
                LevelDecl {
                    label: v.label,
                    endpoint: v.endpoint,
                    basis: self.basis.clone(),
                    description: v.description,
                    concept: None,
                },
            );
        }
        Ok(out)
    }
}

#[derive(Clone, Debug)]
pub struct MappingAdapter {
    pub mapping: ImportMapping,
}

#[async_trait]
impl HistoryAdapter for MappingAdapter {
    fn describe(&self) -> String {
        let m = &self.mapping;
        let shape = if m.levels.is_empty() {
            "a row per value".to_owned()
        } else {
            format!(
                "a column per level ({})",
                m.levels
                    .iter()
                    .map(|c| c.column.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        format!("{} files: time in {:?}, {shape}", m.vendor, m.time)
    }

    fn recognises(&self, columns: &[String]) -> bool {
        let has = |c: &str| columns.iter().any(|h| h.eq_ignore_ascii_case(c));
        has(&self.mapping.time)
            && self.mapping.levels.iter().all(|c| has(&c.column))
            && self.mapping.value.as_deref().is_none_or(has)
    }

    async fn read(&self, file: &FileData, every_seconds: Option<u32>) -> Result<Adapted, String> {
        let delim = self.mapping.delimiter.as_deref().and_then(|d| {
            if d == "\\t" {
                Some('\t')
            } else {
                d.chars().next()
            }
        });
        let table = file::table(file.text()?, delim)?;
        let mut out = self.mapping.apply(&table)?;
        if let Some(e) = every_seconds.filter(|e| *e > 0) {
            let before = out.records.len();
            out.records = super::thin(std::mem::take(&mut out.records), e);
            out.notes.push(format!(
                "kept the last value of each {e} s per series: {} of {before}",
                out.records.len()
            ));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::Timestamp;

    fn long() -> ImportMapping {
        ImportMapping {
            vendor: "Acme Levels".into(),
            package: Some("Daily".into()),
            time: "when".into(),
            time_format: None,
            time_zone: Some("America/New_York".into()),
            instrument: Some("symbol".into()),
            instrument_value: None,
            instruments: BTreeMap::from([("NQ1!".to_owned(), "NQ".to_owned())]),
            level: Some("kind".into()),
            value: Some("price".into()),
            levels: Vec::new(),
            only: Vec::new(),
            na_if: vec![0.0],
            vocabulary: BTreeMap::from([(
                "CW".to_owned(),
                VocabularyEntry {
                    label: Some("Call Wall".into()),
                    ..VocabularyEntry::default()
                },
            )]),
            basis: None,
            delimiter: None,
        }
    }

    #[test]
    fn a_long_file_reads_one_value_a_row() {
        let t = file::table(
            "when,symbol,kind,price\n2026-10-07 09:31:00,NQ1!,CW,20850\n2026-10-07 09:31:00,NQ1!,PW,0\nbad,NQ1!,CW,1\n2026-10-07 09:32:00,NQ1!,CW,abc\n",
            None,
        )
        .unwrap();
        let a = long().apply(&t).unwrap();
        assert_eq!(a.vendor, "Acme Levels");
        assert_eq!(a.records.len(), 2);
        let cw = &a.records[0];
        assert_eq!(
            (
                cw.instrument.as_str(),
                cw.package.as_str(),
                cw.level.as_str(),
                cw.value
            ),
            ("NQ", "Daily", "CW", Some(20_850.0))
        );
        assert_eq!(
            cw.time,
            Timestamp::parse("2026-10-07T09:31:00-04:00").unwrap()
        );
        assert_eq!(a.records[1].value, None, "the vendor's 0 is not applicable");
        assert_eq!(a.problems.len(), 2);
        assert_eq!(a.problems[0].line, 4);
        assert_eq!(
            a.declared
                .get(&("Daily".to_owned(), "CW".to_owned()))
                .and_then(|d| d.label.clone())
                .as_deref(),
            Some("Call Wall")
        );
    }

    #[test]
    fn a_wide_file_reads_a_column_per_level() {
        let m = ImportMapping {
            time: "timestamp".into(),
            time_zone: None,
            instrument: None,
            instrument_value: Some("NDX".into()),
            level: None,
            value: None,
            levels: vec![
                LevelColumn {
                    column: "zero_gamma".into(),
                    level: None,
                    package: None,
                },
                LevelColumn {
                    column: "mlg".into(),
                    level: Some("major_long_gamma".into()),
                    package: Some("State".into()),
                },
            ],
            ..long()
        };
        let t = file::table(
            r#"[{"timestamp": 1791379860, "zero_gamma": 20610, "mlg": 20850}, {"timestamp": 1791379920, "zero_gamma": null, "mlg": 20900}]"#,
            None,
        )
        .unwrap();
        let a = m.apply(&t).unwrap();
        assert_eq!(a.records.len(), 3, "an empty cell is no value at that time");
        assert_eq!(a.records[1].level, "major_long_gamma");
        assert_eq!(a.records[1].package, "State");
        assert_eq!(a.records[0].package, "Daily");
        assert!(a.problems.is_empty());
    }

    #[test]
    fn a_mapping_says_what_is_missing() {
        let m = ImportMapping {
            level: None,
            ..long()
        };
        assert!(m.problems()[0].contains("both"));
        let t = file::table("x,y\n1,2\n", None).unwrap();
        let e = long().apply(&t).unwrap_err();
        assert!(e.contains("no column \"when\""), "{e}");
    }
}
