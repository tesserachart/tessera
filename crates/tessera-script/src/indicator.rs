use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;

use rquickjs::{Function, Object, TypedArray, Value as JsValue};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tessera_core::Timestamp;
use tessera_core::session::SessionCalendar;
use tessera_protocol::indicators::{
    IndicatorFill, IndicatorInput, IndicatorObjects, IndicatorPlacement, IndicatorPlot, PlotKind,
    ValueFormat,
};
use ts_rs::TS;

use crate::engine::{self, Host, Limits, ScriptError};

/// An indicator's declaration, read from its code.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorManifest {
    /// `title` (`EMA cross`).
    pub title: String,
    /// `short`, the start of its legend label (the title when not given).
    pub short: String,
    /// `description`, or the comment the module opens with: what it computes, in the author's words.
    #[serde(default)]
    pub description: Option<String>,
    /// `placement`: on the price (`overlay`) or in its own pane (`pane`, the default).
    pub placement: IndicatorPlacement,
    /// `format`: how values read (price on the price pane, numbers in a pane by default).
    pub format: ValueFormat,
    /// `range`: a fixed pane scale (`[0, 100]`).
    pub range: Option<Vec<f64>>,
    /// `inputs`, in declaration order.
    pub inputs: Vec<IndicatorInput>,
    /// `plots`, in declaration order.
    pub plots: Vec<IndicatorPlot>,
    /// `fills`.
    pub fills: Vec<IndicatorFill>,
}

impl IndicatorManifest {
    pub fn series_keys(&self) -> Vec<&str> {
        self.plots
            .iter()
            .filter(|p| p.kind != PlotKind::Hline)
            .map(|p| p.key.as_str())
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BarArrays {
    pub time: Vec<f64>,
    pub open: Vec<f64>,
    pub high: Vec<f64>,
    pub low: Vec<f64>,
    pub close: Vec<f64>,
    pub volume: Vec<f64>,
    pub buy_volume: Option<Vec<f64>>,
    pub calendar: SessionCalendar,
}

impl BarArrays {
    pub fn len(&self) -> usize {
        self.time.len()
    }

    pub fn is_empty(&self) -> bool {
        self.time.is_empty()
    }

    pub(crate) fn check(&self) -> Result<(), ScriptError> {
        let n = self.len();
        let mut cols = vec![
            ("open", self.open.len()),
            ("high", self.high.len()),
            ("low", self.low.len()),
            ("close", self.close.len()),
            ("volume", self.volume.len()),
        ];
        if let Some(b) = &self.buy_volume {
            cols.push(("buy_volume", b.len()));
        }
        match cols.into_iter().find(|(_, l)| *l != n) {
            Some((k, l)) => Err(ScriptError::invalid(format!(
                "bars: {k} has {l} values, time has {n}"
            ))),
            None => Ok(()),
        }
    }

    pub fn day_keys(&self) -> Vec<f64> {
        use chrono::Datelike;
        let mut memo: HashMap<i64, f64> = HashMap::new();
        self.time
            .iter()
            .map(|&t| {
                let hour = (t / 3600.0).floor() as i64;
                *memo.entry(hour).or_insert_with(|| {
                    let d = self
                        .calendar
                        .trade_date(Timestamp(hour.saturating_mul(3_600_000_000_000)));
                    f64::from(d.year() * 10_000 + d.month() as i32 * 100 + d.day() as i32)
                })
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndicatorRun {
    pub manifest: IndicatorManifest,
    pub series: Vec<(String, Vec<f64>)>,
    pub objects: IndicatorObjects,
    pub logs: String,
    pub compute_ms: f64,
    pub wall_ms: f64,
}

pub const MAX_CODE: usize = 256 * 1024;

pub type Series = Vec<(String, Vec<f64>)>;

pub(crate) fn check_code(source: &str) -> Result<(), ScriptError> {
    if source.len() > MAX_CODE {
        return Err(ScriptError::invalid("the code is longer than 256 KB"));
    }
    Ok(())
}

pub fn describe(source: &str) -> Result<IndicatorManifest, ScriptError> {
    check_code(source)?;
    let (json, _) = engine::run(source, Limits::DESCRIBE, Host::default(), |_, loaded| {
        let describe: Function<'_> = loaded.runner.get("describe")?;
        let decl: JsValue<'_> = loaded.module.get("indicator")?;
        let compute: JsValue<'_> = loaded.module.get("compute")?;
        describe.call::<_, String>((decl, compute))
    })?;
    manifest(&json, source)
}

fn manifest(json: &str, source: &str) -> Result<IndicatorManifest, ScriptError> {
    let mut m: IndicatorManifest = serde_json::from_str(json).map_err(|e| {
        ScriptError::internal(format!("the indicator's declaration is unreadable: {e}"))
    })?;
    if m.description.is_none() {
        m.description = leading_comment(source);
    }
    Ok(m)
}

pub(crate) fn columns<'js>(
    ctx: &rquickjs::Ctx<'js>,
    bars: &BarArrays,
) -> rquickjs::Result<Object<'js>> {
    let cols = Object::new(ctx.clone())?;
    let col = |v: &Vec<f64>| TypedArray::<f64>::new(ctx.clone(), v.clone());
    cols.set("time", col(&bars.time)?)?;
    cols.set("open", col(&bars.open)?)?;
    cols.set("high", col(&bars.high)?)?;
    cols.set("low", col(&bars.low)?)?;
    cols.set("close", col(&bars.close)?)?;
    cols.set("volume", col(&bars.volume)?)?;
    cols.set("day", col(&bars.day_keys())?)?;
    if let Some(b) = &bars.buy_volume {
        cols.set("buyVolume", col(b)?)?;
    }
    Ok(cols)
}

pub(crate) fn host(bars: &BarArrays) -> Host {
    Host {
        times: Rc::new(bars.time.clone()),
    }
}

pub fn run_indicator(
    source: &str,
    bars: &BarArrays,
    inputs: &Map<String, Value>,
    limits: Limits,
) -> Result<IndicatorRun, ScriptError> {
    check_code(source)?;
    bars.check()?;
    let given = serde_json::to_string(inputs).map_err(|e| ScriptError::internal(e.to_string()))?;
    let start = Instant::now();
    let ((manifest_json, series, objects, compute_ms), logs) =
        engine::run(source, limits, host(bars), |ctx, loaded| {
            let run: Function<'_> = loaded.runner.get("run")?;
            let decl: JsValue<'_> = loaded.module.get("indicator")?;
            let compute: JsValue<'_> = loaded.module.get("compute")?;
            let cols = columns(ctx, bars)?;
            let given = ctx.json_parse(given.clone())?;
            let t0 = Instant::now();
            let out: Object<'_> = run.call((decl, compute, cols, given))?;
            let manifest: String = out.get("manifest")?;
            let keys: Vec<String> = out.get("keys")?;
            let values: Vec<Vec<f64>> = out.get("values")?;
            let objects: Option<String> = out.get("objects")?;
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            Ok((
                manifest,
                keys.into_iter().zip(values).collect::<Vec<_>>(),
                objects,
                ms,
            ))
        })?;
    let manifest = manifest(&manifest_json, source)?;
    let objects = match objects {
        Some(json) => drawn(&json)?,
        None => IndicatorObjects::default(),
    };
    Ok(IndicatorRun {
        manifest,
        series,
        objects,
        logs,
        compute_ms,
        wall_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

pub fn call(
    source: &str,
    entry: &str,
    bars: &BarArrays,
    params: &Value,
    limits: Limits,
) -> Result<(Series, f64), ScriptError> {
    check_code(source)?;
    bars.check()?;
    let params = serde_json::to_string(params).map_err(|e| ScriptError::internal(e.to_string()))?;
    let (out, _) = engine::run(source, limits, host(bars), |ctx, loaded| {
        let call: Function<'_> = loaded.runner.get("call")?;
        let f: JsValue<'_> = loaded.module.get(entry)?;
        let cols = columns(ctx, bars)?;
        let params = ctx.json_parse(params.clone())?;
        let t0 = Instant::now();
        let out: Object<'_> = call.call((f, cols, params))?;
        let keys: Vec<String> = out.get("keys")?;
        let values: Vec<Vec<f64>> = out.get("values")?;
        Ok((
            keys.into_iter().zip(values).collect::<Vec<_>>(),
            t0.elapsed().as_secs_f64() * 1000.0,
        ))
    })?;
    Ok(out)
}

fn ns(t: f64) -> i64 {
    let whole = t.floor();
    (whole as i64)
        .saturating_mul(1_000_000_000)
        .saturating_add(((t - whole) * 1e9).round() as i64)
}

fn drawn(json: &str) -> Result<IndicatorObjects, ScriptError> {
    let unreadable = |e: String| {
        ScriptError::internal(format!("the lines, labels and boxes are unreadable: {e}"))
    };
    let mut v: Value = serde_json::from_str(json).map_err(|e| unreadable(e.to_string()))?;
    let times = |items: Option<&mut Value>, keys: &[&str]| {
        for o in items.and_then(Value::as_array_mut).into_iter().flatten() {
            for k in keys {
                if let Some(t) = o.get(*k).and_then(Value::as_f64) {
                    o[*k] = Value::from(ns(t));
                }
            }
        }
    };
    times(v.get_mut("lines"), &["time1", "time2"]);
    times(v.get_mut("boxes"), &["time1", "time2"]);
    times(v.get_mut("labels"), &["time"]);
    let mut o: IndicatorObjects =
        serde_json::from_value(v).map_err(|e| unreadable(e.to_string()))?;
    o.check().map_err(unreadable)?;
    o.cap();
    Ok(o)
}

fn leading_comment(source: &str) -> Option<String> {
    let rest = source.trim_start().strip_prefix("/*")?;
    let body = &rest[..rest.find("*/")?];
    let text = body
        .lines()
        .map(|l| l.trim().trim_start_matches('*').trim())
        .collect::<Vec<_>>()
        .join(" ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then(|| text.chars().take(400).collect())
}

pub(crate) fn declaration_line(source: &str, path: &[String]) -> Option<u32> {
    let lines: Vec<&str> = source.lines().collect();
    let mut at = lines
        .iter()
        .position(|l| l.contains("export") && (l.contains("indicator") || l.contains("strategy")))
        .or_else(|| {
            lines
                .iter()
                .position(|l| names(l, "indicator") || names(l, "strategy"))
        })?;
    for part in path.iter().filter(|p| !p.is_empty()) {
        match (at..lines.len()).find(|&i| names(lines[i], part)) {
            Some(i) => at = i,
            None => break,
        }
    }
    Some(at as u32 + 1)
}

fn names(line: &str, word: &str) -> bool {
    if line.contains(&format!("\"{word}\"")) || line.contains(&format!("'{word}'")) {
        return true;
    }
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    line.match_indices(word).any(|(i, _)| {
        let before = line[..i].chars().next_back();
        let after = line[i + word.len()..].trim_start();
        before.is_none_or(|c| !ident(c)) && after.starts_with(':')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declaration_problems_find_their_line() {
        let src = "/** A test. */\nexport const indicator = {\n  title: 'x',\n  inputs: {\n    fast: 9,\n    length: { type: 'int', default: 0, min: 1 },\n  },\n  plots: ['v', { name: 'w', kind: 'nope' }],\n};\n";
        let at = |p: &[&str]| {
            declaration_line(src, &p.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())
        };
        assert_eq!(at(&[]), Some(2));
        assert_eq!(at(&["inputs", "length"]), Some(6));
        assert_eq!(at(&["plots", "w"]), Some(8));
        assert_eq!(at(&["title"]), Some(3));
        assert_eq!(leading_comment(src).as_deref(), Some("A test."));
    }

    #[test]
    fn every_bar_is_keyed_by_its_calendars_trade_date() {
        let start = Timestamp::parse("2026-01-01T00:00:00Z").unwrap().secs();
        let time: Vec<f64> = (0..366 * 24 * 4)
            .map(|i| (start + i * 900) as f64)
            .collect();
        for calendar in SessionCalendar::ALL {
            let bars = BarArrays {
                time: time.clone(),
                open: Vec::new(),
                high: Vec::new(),
                low: Vec::new(),
                close: Vec::new(),
                volume: Vec::new(),
                buy_volume: None,
                calendar,
            };
            let yyyymmdd = |t: f64| {
                let date = calendar.trade_date(Timestamp::from_secs(t as i64));
                date.format("%Y%m%d").to_string().parse::<f64>().unwrap()
            };
            let wrong = time
                .iter()
                .zip(bars.day_keys())
                .find(|&(&t, key)| key != yyyymmdd(t));
            assert_eq!(wrong, None, "{calendar:?}");
        }
    }

    #[test]
    fn times_become_nanoseconds() {
        assert_eq!(ns(1_700_000_000.0), 1_700_000_000_000_000_000);
        assert_eq!(ns(1_700_000_000.5), 1_700_000_000_500_000_000);
    }
}
