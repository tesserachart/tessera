use async_trait::async_trait;
use serde_json::Value;

use super::file;
use super::{Adapted, FileData, HistoryAdapter, Problem, Record};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptAdapter {
    pub vendor: String,
    pub code: String,
}

enum Column {
    Values(Vec<Value>),
    One(Value),
}

impl Column {
    fn of(out: &Value, key: &str) -> Option<Self> {
        match out.get(key)? {
            Value::Array(a) => Some(Self::Values(a.clone())),
            v => Some(Self::One(v.clone())),
        }
    }

    fn len(&self) -> Option<usize> {
        match self {
            Self::Values(a) => Some(a.len()),
            Self::One(_) => None,
        }
    }

    fn at(&self, i: usize) -> Value {
        match self {
            Self::Values(a) => a.get(i).cloned().unwrap_or(Value::Null),
            Self::One(v) => v.clone(),
        }
    }
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.trim().to_owned()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub fn adapt(vendor: &str, out: &Value, logs: &str) -> Result<Adapted, String> {
    let need = |k: &str| {
        Column::of(out, k).ok_or_else(|| {
            format!(
                "records() returned no {k:?}; return an object with time, instrument, level and value"
            )
        })
    };
    let (time, instrument, level, value) = (
        need("time")?,
        need("instrument")?,
        need("level")?,
        need("value")?,
    );
    let package = Column::of(out, "package");
    let lens: Vec<usize> = [&time, &instrument, &level, &value]
        .into_iter()
        .chain(package.as_ref())
        .filter_map(Column::len)
        .collect();
    let n = lens.first().copied().unwrap_or(1);
    if lens.iter().any(|l| *l != n) {
        return Err(format!(
            "records() returned lists of different lengths ({lens:?})"
        ));
    }
    let mut a = Adapted {
        vendor: vendor.trim().to_owned(),
        rows: n,
        ..Adapted::default()
    };
    for i in 0..n {
        let line = i + 1;
        let t = match time.at(i) {
            Value::Number(x) => x
                .as_f64()
                .ok_or_else(|| "not a number".to_owned())
                .and_then(|x| file::parse_time(&x.to_string(), "auto", None)),
            Value::String(s) => file::parse_time(&s, "auto", None),
            other => Err(format!("{other} is not a time")),
        };
        let t = match t {
            Ok(t) => t,
            Err(e) => {
                a.problems.push(Problem {
                    line,
                    message: format!("time: {e}"),
                });
                continue;
            }
        };
        let (Some(inst), Some(lvl)) = (text(&instrument.at(i)), text(&level.at(i))) else {
            a.problems.push(Problem {
                line,
                message: "no instrument or level name".into(),
            });
            continue;
        };
        let v = match value.at(i) {
            Value::Null => None,
            Value::Number(x) => x.as_f64().filter(|x| x.is_finite()),
            Value::String(s) => match file::number(&s) {
                Ok(v) => v,
                Err(e) => {
                    a.problems.push(Problem {
                        line,
                        message: format!("{lvl}: {e}"),
                    });
                    continue;
                }
            },
            other => {
                a.problems.push(Problem {
                    line,
                    message: format!("{lvl}: {other} is not a number"),
                });
                continue;
            }
        };
        let pkg = package
            .as_ref()
            .and_then(|p| text(&p.at(i)))
            .unwrap_or_default();
        a.declared.entry((pkg.clone(), lvl.clone())).or_default();
        a.records.push(Record {
            time: t,
            instrument: inst,
            package: pkg,
            level: lvl,
            value: v,
            reason: v
                .is_none()
                .then(|| format!("{} gives no value", vendor.trim())),
            line,
        });
    }
    if !logs.trim().is_empty() {
        a.notes.push(format!(
            "it printed: {}",
            logs.trim().chars().take(400).collect::<String>()
        ));
    }
    Ok(a)
}

#[async_trait]
impl HistoryAdapter for ScriptAdapter {
    fn describe(&self) -> String {
        format!("{} files, read by a JavaScript adapter", self.vendor)
    }

    async fn read(&self, f: &FileData, every_seconds: Option<u32>) -> Result<Adapted, String> {
        let (code, text, name) = (self.code.clone(), f.text()?.to_owned(), f.name.clone());
        let (out, logs) = tokio::task::spawn_blocking(move || {
            tessera_script::read_records(&code, &text, &name, tessera_script::Limits::IMPORT)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("the adapter's code: {e}"))?;
        let mut a = adapt(&self.vendor, &out, &logs)?;
        if let Some(e) = every_seconds.filter(|e| *e > 0) {
            a.records = super::thin(std::mem::take(&mut a.records), e);
        }
        Ok(a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_output_of_lists_and_single_values_reads_as_records() {
        let out = json!({
            "time": [1_791_379_860, "2026-10-07T09:32:00-04:00"],
            "instrument": "NDX",
            "level": ["call_wall", "put_wall"],
            "value": [20_850.0, null],
            "package": "Daily",
        });
        let a = adapt("Acme", &out, "").unwrap();
        assert_eq!(a.records.len(), 2);
        assert_eq!(a.records[0].instrument, "NDX");
        assert_eq!(a.records[0].package, "Daily");
        assert_eq!(a.records[1].value, None);
        assert_eq!(
            a.records[1].time,
            tessera_core::Timestamp::parse("2026-10-07T09:32:00-04:00").unwrap()
        );
        let bad = json!({"time": [1], "instrument": "NDX", "level": ["a", "b"], "value": [1, 2]});
        assert!(
            adapt("Acme", &bad, "")
                .unwrap_err()
                .contains("different lengths")
        );
        assert!(adapt("Acme", &json!({}), "").is_err());
    }
}
