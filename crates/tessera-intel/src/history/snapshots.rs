use rust_decimal::prelude::ToPrimitive;
use serde_json::Value;

use super::file::{self, Shape};
use super::{Adapted, FileData, LevelDecl, Problem, Record, thin};
use crate::source::parse;
use crate::source::select::Selector;
use crate::source::spec::{LevelSourceSpec, RequestSpec};

pub const EVERY_SECONDS: u32 = 60;

fn items(text: &str) -> Result<Vec<(usize, &str)>, String> {
    Ok(match file::shape(text) {
        Shape::Json => {
            let (items, whole) = file::list_items(text.as_bytes(), usize::MAX);
            if !whole {
                return Err("the JSON list does not end (a cut download?)".into());
            }
            items
                .into_iter()
                .enumerate()
                .map(|(i, (s, e))| (i + 1, &text[s..e]))
                .collect()
        }
        Shape::JsonLines => text
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, l)| (i + 1, l))
            .collect(),
        Shape::JsonObject => vec![(1, text)],
        Shape::Csv => {
            return Err("a history API's file is read as JSON snapshots; this is CSV".into());
        }
    })
}

fn absent<'a>(req: &'a RequestSpec, body: &Value) -> Vec<&'a str> {
    req.fields
        .iter()
        .filter(|f| {
            Selector::parse(&f.value_path())
                .ok()
                .and_then(|s| s.select(body).map(|_| ()))
                .is_none()
        })
        .map(|f| f.field.as_str())
        .collect()
}

pub fn read(
    spec: &LevelSourceSpec,
    req: &RequestSpec,
    instrument: &str,
    basis: &str,
    f: &FileData,
    every_seconds: u32,
) -> Result<Adapted, String> {
    if req.as_of.is_none() {
        return Err(format!(
            "{}'s {} request names no snapshot time (asOf), so a history file's snapshots cannot be placed in time",
            spec.vendor, req.id
        ));
    }
    let items = items(f.text()?)?;
    let mut out = Adapted {
        vendor: spec.vendor.clone(),
        rows: items.len(),
        ..Adapted::default()
    };
    for (line, item) in items {
        let body: Value = match serde_json::from_str(item) {
            Ok(v) => v,
            Err(e) => {
                out.problems.push(Problem {
                    line,
                    message: format!("not a snapshot: {e}"),
                });
                continue;
            }
        };
        let parsed = parse::parse(req, &body);
        let Some(time) = parsed.as_of else {
            out.problems.push(Problem {
                line,
                message: "no snapshot time".into(),
            });
            continue;
        };
        let absent = absent(req, &body);
        for v in parsed.values {
            if absent.contains(&v.field.as_str()) {
                continue;
            }
            out.records.push(Record {
                time,
                instrument: instrument.to_owned(),
                package: v.package,
                level: v.field,
                value: v.value.as_ref().ok().and_then(ToPrimitive::to_f64),
                reason: v.value.err(),
                line,
            });
        }
    }
    for x in &req.fields {
        out.declared.insert(
            (req.package.clone(), x.field.clone()),
            LevelDecl {
                label: x.label.clone(),
                endpoint: Some(req.endpoint()),
                basis: Some(basis.to_owned()),
                description: x.description.clone(),
                concept: x
                    .concept
                    .as_ref()
                    .and_then(|c| serde_json::to_value(c).ok()),
            },
        );
    }
    if every_seconds > 0 {
        let before = out.records.len();
        out.records = thin(std::mem::take(&mut out.records), every_seconds);
        if out.records.len() < before {
            out.notes.push(format!(
                "kept the last snapshot of each {every_seconds} s per level ({} of {before} values): exact for bars of {every_seconds} s or more",
                out.records.len()
            ));
        }
    }
    Ok(out)
}
