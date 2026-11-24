use std::collections::{BTreeMap, BTreeSet};

use chrono::{NaiveDate, TimeZone, Timelike};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::ids::slug;
use tessera_core::initial_balance::InitialBalance;
use tessera_core::market::Bar;
use tessera_core::session::SessionCalendar;
use tessera_core::{Price, Qty, Timeframe, Timestamp};
use tessera_store::Store;
use tessera_store::level_history::{LevelName, Series};
use ts_rs::TS;

use crate::study::Frame;

/// A daily time-of-day window a study trades in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TimeWindow {
    /// Start, `HH:MM` (inclusive): the first bar that may hold a position opens at or after it.
    pub start: String,
    /// End, `HH:MM` (exclusive): positions are closed at the first bar's open at or after it.
    pub end: String,
    /// IANA zone (default `America/New_York`).
    #[serde(default)]
    pub time_zone: Option<String>,
}

fn hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

#[derive(Clone, Copy, Debug)]
pub struct Window {
    start: u32,
    end: u32,
    tz: Tz,
}

impl TimeWindow {
    pub fn parse(&self) -> Result<Window, String> {
        let start = hhmm(&self.start)
            .ok_or_else(|| format!("window start {:?} is not HH:MM", self.start))?;
        let end =
            hhmm(&self.end).ok_or_else(|| format!("window end {:?} is not HH:MM", self.end))?;
        if end <= start {
            return Err(
                "the window ends before it starts (one crossing midnight is not supported)".into(),
            );
        }
        let zone = self.time_zone.as_deref().unwrap_or("America/New_York");
        let tz = zone
            .parse::<Tz>()
            .map_err(|_| format!("{zone} is not an IANA time zone"))?;
        Ok(Window { start, end, tz })
    }
}

impl Window {
    pub fn contains(&self, t: i64) -> bool {
        let local = self.tz.timestamp_nanos(t);
        let m = local.hour() * 60 + local.minute();
        (self.start..self.end).contains(&m)
    }

    pub fn flatten(&self, times: &[i64], targets: &mut [f64]) {
        let n = times.len().min(targets.len());
        for i in 0..n {
            if i + 1 >= n || !self.contains(times[i + 1]) {
                targets[i] = 0.0;
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LevelColumn {
    pub name: String,
    pub values: Vec<f64>,
    pub as_of: Vec<f64>,
}

/// What one level input covers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LevelInputCoverage {
    /// The name the study gave.
    pub name: String,
    /// The series read (`acme.state.major_long_gamma`).
    pub series: String,
    /// The vendor, verbatim.
    pub vendor: String,
    /// Its label, as the vendor writes it.
    pub label: Option<String>,
    /// The instrument it is stored on.
    pub instrument: String,
    /// The price space the vendor computed it in.
    pub basis: Option<String>,
    /// Its first value's New York date in the study's range.
    pub first_date: Option<String>,
    /// Its last.
    pub last_date: Option<String>,
    /// Sessions read with a value of it known during them.
    pub sessions: u32,
}

/// The level inputs' coverage of a run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LevelCoverage {
    /// Each input.
    pub inputs: Vec<LevelInputCoverage>,
    /// Sessions of bars in the range.
    pub sessions_read: u32,
    /// Sessions every input covers: the ones the study ran on.
    pub sessions_used: u32,
    /// The first session used.
    pub used_from: Option<String>,
    /// The last.
    pub used_to: Option<String>,
    /// Sessions left out for lack of level history (the first 20 of them).
    pub excluded_dates: Vec<String>,
}

pub fn align(times: &[i64], obs: &[(i64, i64, Option<f64>)]) -> (Vec<f64>, Vec<f64>) {
    let mut values = Vec::with_capacity(times.len());
    let mut as_ofs = Vec::with_capacity(times.len());
    let mut j = 0;
    let mut current: Option<(i64, Option<f64>)> = None;
    for &t in times {
        while j < obs.len() && obs[j].0 <= t {
            let (_, as_of, v) = obs[j];
            if current.is_none_or(|(a, _)| as_of >= a) {
                current = Some((as_of, v));
            }
            j += 1;
        }
        match current {
            Some((a, v)) => {
                values.push(v.unwrap_or(f64::NAN));
                as_ofs.push(a as f64 / 1e9);
            }
            None => {
                values.push(f64::NAN);
                as_ofs.push(f64::NAN);
            }
        }
    }
    (values, as_ofs)
}

fn ny_date(t: i64) -> String {
    chrono_tz::America::New_York
        .timestamp_nanos(t)
        .format("%Y-%m-%d")
        .to_string()
}

fn recording_words(store: &Store) -> String {
    let rec = store.level_history().recordings().unwrap_or_default();
    let recorded = if rec.is_empty() {
        "Nothing has been recorded yet: Tessera records a provider's levels as they arrive, while a chart shows an instrument it covers.".to_owned()
    } else {
        format!(
            "Recording began {}.",
            rec.iter()
                .map(|r| format!("{} for {}", ny_date(r.first_at.0), r.vendor))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "{recorded} Earlier history can be imported from a file (intel.preview_file, intel.import_level_history) or backfilled from a vendor whose plan includes it (intel.backfill_level_history)."
    )
}

pub fn find(store: &Store, raw: &str, instruments: &[String]) -> Result<Series, String> {
    let name = LevelName::parse(raw)?;
    let h = store.level_history();
    let found = h
        .find(&name, instruments)
        .map_err(|e| format!("the level history could not be read: {e}"))?;
    match found.len() {
        1 => Ok(found.into_iter().next().unwrap_or_else(|| unreachable!())),
        0 => {
            let elsewhere: Vec<String> = h
                .all_series()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s.vendor_key == name.vendor_key && s.info.level == name.level)
                .map(|s| format!("{}@{}", s.full_name(), s.info.instrument))
                .collect();
            let hint = if elsewhere.is_empty() {
                String::new()
            } else {
                format!(
                    " It is stored as {} (name one with @).",
                    elsewhere.join(", ")
                )
            };
            Err(format!(
                "There is no level history of {raw} on {} yet, so this study cannot run on it.{hint} {}",
                instruments.join(" or "),
                recording_words(store)
            ))
        }
        _ => Err(format!(
            "{raw} names more than one series: {}. Name one (vendor.package.level, @INSTRUMENT).",
            found
                .iter()
                .map(|s| format!("{}@{}", s.full_name(), s.info.instrument))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub fn prepare(
    store: &Store,
    names: &[String],
    instruments: &[String],
    frame: Frame,
    tf: Timeframe,
) -> Result<(Frame, LevelCoverage), String> {
    let n = frame.bars.len();
    if n == 0 || names.is_empty() {
        return Ok((
            frame,
            LevelCoverage {
                inputs: Vec::new(),
                sessions_read: 0,
                sessions_used: 0,
                used_from: None,
                used_to: None,
                excluded_dates: Vec::new(),
            },
        ));
    }
    let times = &frame.bars.time;
    let bar = tf.nanos().max(1);
    let (start, end) = (times[0], times[n - 1] + bar);
    let sessions = frame.session.last().map_or(0, |s| *s as usize + 1);
    let mut spans = vec![(i64::MAX, i64::MIN); sessions];
    for (i, s) in frame.session.iter().enumerate() {
        let sp = &mut spans[*s as usize];
        sp.0 = sp.0.min(times[i]);
        sp.1 = sp.1.max(times[i] + bar);
    }
    let mut columns = Vec::new();
    let mut inputs = Vec::new();
    let mut covered = vec![true; sessions];
    let mut seen_names = BTreeSet::new();
    for raw in names {
        if !seen_names.insert(raw.trim().to_owned()) {
            continue;
        }
        let series = find(store, raw, instruments)?;
        let obs = store
            .level_history()
            .known(series.id, Timestamp(start), Timestamp(end))
            .map_err(|e| format!("the level history could not be read: {e}"))?;
        let rows: Vec<(i64, i64, Option<f64>)> = obs
            .iter()
            .map(|o| (o.known_at.0, o.as_of.0, o.value))
            .collect();
        let (values, as_of) = align(times, &rows);
        let mut has = vec![false; sessions];
        for (known, _, _) in &rows {
            if let Some(s) = spans.iter().position(|(a, b)| known >= a && known < b) {
                has[s] = true;
            }
        }
        let in_range: Vec<&(i64, i64, Option<f64>)> =
            rows.iter().filter(|r| r.0 >= start && r.0 < end).collect();
        inputs.push(LevelInputCoverage {
            name: raw.trim().to_owned(),
            series: series.full_name(),
            vendor: series.info.vendor.clone(),
            label: series.info.label.clone(),
            instrument: series.info.instrument.clone(),
            basis: series.info.basis.clone(),
            first_date: in_range.first().map(|r| ny_date(r.1)),
            last_date: in_range.last().map(|r| ny_date(r.1)),
            sessions: has.iter().filter(|h| **h).count() as u32,
        });
        for (c, h) in covered.iter_mut().zip(&has) {
            *c &= *h;
        }
        columns.push(LevelColumn {
            name: raw.trim().to_owned(),
            values,
            as_of,
        });
    }
    let used: Vec<usize> = (0..sessions).filter(|s| covered[*s]).collect();
    let date_of = |s: usize| frame.session_dates.get(s).cloned().unwrap_or_default();
    let coverage = LevelCoverage {
        sessions_read: sessions as u32,
        sessions_used: used.len() as u32,
        used_from: used.first().map(|s| date_of(*s)),
        used_to: used.last().map(|s| date_of(*s)),
        excluded_dates: (0..sessions)
            .filter(|s| !covered[*s])
            .take(20)
            .map(date_of)
            .collect(),
        inputs,
    };
    if used.is_empty() {
        let each: Vec<String> = coverage
            .inputs
            .iter()
            .map(|i| match (&i.first_date, &i.last_date) {
                (Some(a), Some(b)) => format!("{} has values from {a} to {b}", i.name),
                _ => format!("{} has no values in these dates", i.name),
            })
            .collect();
        return Err(format!(
            "No session of {} sessions in the study's range has history of every level input ({}), so it cannot run: nothing is filled in. {}",
            sessions,
            each.join("; "),
            recording_words(store)
        ));
    }
    let mut out = Frame {
        levels: Vec::new(),
        ..Frame::default()
    };
    let mut keep = Vec::with_capacity(n);
    let mut new_session = vec![u32::MAX; sessions];
    for (k, s) in used.iter().enumerate() {
        new_session[*s] = k as u32;
        out.session_dates.push(date_of(*s));
    }
    for i in 0..n {
        let s = frame.session[i] as usize;
        if !covered[s] {
            continue;
        }
        keep.push(i);
        out.bars.time.push(frame.bars.time[i]);
        out.bars.open.push(frame.bars.open[i]);
        out.bars.high.push(frame.bars.high[i]);
        out.bars.low.push(frame.bars.low[i]);
        out.bars.close.push(frame.bars.close[i]);
        out.volume.push(frame.volume[i]);
        out.buy_volume.push(frame.buy_volume[i]);
        out.session.push(new_session[s]);
    }
    out.levels = columns
        .into_iter()
        .map(|c| LevelColumn {
            values: keep.iter().map(|i| c.values[*i]).collect(),
            as_of: keep.iter().map(|i| c.as_of[*i]).collect(),
            name: c.name,
        })
        .collect();
    Ok((out, coverage))
}

const INITIAL_BALANCE_PREFIX: &str = "tessera.ib.";
const INITIAL_BALANCE_LINES: [&str; 7] =
    ["high", "low", "mid", "high50", "low50", "high100", "low100"];

pub fn is_initial_balance(name: &str) -> bool {
    name.trim()
        .to_ascii_lowercase()
        .starts_with(INITIAL_BALANCE_PREFIX)
}

fn initial_balance_line(name: &str) -> Result<&'static str, String> {
    let line = name.trim().to_ascii_lowercase();
    let line = line
        .strip_prefix(INITIAL_BALANCE_PREFIX)
        .unwrap_or_default();
    INITIAL_BALANCE_LINES
        .into_iter()
        .find(|l| *l == line)
        .ok_or_else(|| {
            format!(
                "{name} is not an initial balance line; use tessera.ib. with one of {}",
                INITIAL_BALANCE_LINES.join(", ")
            )
        })
}

fn line_price(ib: &InitialBalance, line: &str) -> Price {
    let half = Decimal::new(5, 1);
    match line {
        "high" => ib.high,
        "low" => ib.low,
        "mid" => ib.mid(),
        "high50" => ib.above(half),
        "low50" => ib.below(half),
        "high100" => ib.above(Decimal::ONE),
        _ => ib.below(Decimal::ONE),
    }
}

pub fn initial_balance_columns(
    names: &[String],
    frame: &Frame,
    calendar: SessionCalendar,
    tf: Timeframe,
    minutes: u32,
    instrument: &str,
) -> Result<(Vec<LevelColumn>, Vec<LevelInputCoverage>), String> {
    let times = &frame.bars.time;
    let price = |v: f64| Price(Decimal::from_f64(v).unwrap_or_default());
    let mut days: BTreeMap<NaiveDate, Vec<usize>> = BTreeMap::new();
    for (i, t) in times.iter().enumerate() {
        days.entry(calendar.trade_date(Timestamp(*t)))
            .or_default()
            .push(i);
    }
    let balances: BTreeMap<NaiveDate, InitialBalance> = days
        .iter()
        .filter_map(|(date, idx)| {
            let session = calendar.session(*date)?;
            let bars: Vec<Bar> = idx
                .iter()
                .map(|&i| Bar {
                    t: Timestamp(times[i]),
                    o: price(frame.bars.open[i]),
                    h: price(frame.bars.high[i]),
                    l: price(frame.bars.low[i]),
                    c: price(frame.bars.close[i]),
                    v: Qty(Decimal::ZERO),
                    bv: None,
                })
                .collect();
            let ib =
                InitialBalance::measure(&session, minutes, &bars, tf.nanos(), Timestamp(i64::MAX))?;
            Some((*date, ib))
        })
        .collect();
    if balances.is_empty() {
        return Err(format!(
            "no session in range has an initial balance: it needs a market with a regular session and bars of at most {minutes} minutes, not {tf}"
        ));
    }
    let mut columns = Vec::new();
    let mut inputs = Vec::new();
    for name in names {
        let line = initial_balance_line(name)?;
        let mut values = Vec::with_capacity(times.len());
        let mut as_of = Vec::with_capacity(times.len());
        for t in times {
            let standing = balances
                .get(&calendar.trade_date(Timestamp(*t)))
                .filter(|ib| *t >= ib.end.0);
            values.push(standing.map_or(f64::NAN, |ib| {
                line_price(ib, line).0.to_f64().unwrap_or(f64::NAN)
            }));
            as_of.push(standing.map_or(f64::NAN, |ib| ib.end.0 as f64 / 1e9));
        }
        let dates: Vec<&NaiveDate> = balances.keys().collect();
        inputs.push(LevelInputCoverage {
            name: name.trim().to_owned(),
            series: format!("{INITIAL_BALANCE_PREFIX}{line} ({minutes} min)"),
            vendor: "Tessera".to_owned(),
            label: Some(format!(
                "Initial balance {line}, {minutes} minutes from the RTH open"
            )),
            instrument: instrument.to_owned(),
            basis: None,
            first_date: dates.first().map(|d| d.format("%Y-%m-%d").to_string()),
            last_date: dates.last().map(|d| d.format("%Y-%m-%d").to_string()),
            sessions: balances.len() as u32,
        });
        columns.push(LevelColumn {
            name: name.trim().to_owned(),
            values,
            as_of,
        });
    }
    Ok((columns, inputs))
}

pub fn check(names: &[String], window: Option<&TimeWindow>, tf: Timeframe) -> Result<(), String> {
    for n in names {
        if is_initial_balance(n) {
            initial_balance_line(n)?;
        } else {
            LevelName::parse(n)?;
        }
    }
    if let Some(w) = window {
        w.parse()?;
        if tf.is_session() {
            return Err(format!(
                "a time-of-day window needs intraday bars, not {tf}"
            ));
        }
    }
    Ok(())
}

pub fn vendor_key(vendor: &str) -> String {
    slug(vendor)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000_000_000;

    #[test]
    fn a_level_that_changes_mid_bar_is_not_seen_by_that_bar() {
        let times = [0, MIN, 2 * MIN, 3 * MIN];
        let obs = [
            (-MIN, -MIN, Some(100.0)),
            (MIN + MIN / 2, MIN + MIN / 2, Some(200.0)),
        ];
        let (v, a) = align(&times, &obs);
        assert_eq!(
            v,
            [100.0, 100.0, 200.0, 200.0],
            "the bar opening at 1 min never sees 200"
        );
        assert_eq!(a[1], -60.0);
        assert_eq!(a[2], 90.0);
        let (v, _) = align(&times, &[(2 * MIN, 2 * MIN, Some(7.0))]);
        assert!(v[0].is_nan() && v[1].is_nan(), "NaN before the first value");
        assert_eq!(v[2], 7.0);
    }

    #[test]
    fn the_newest_vendor_time_known_stands_and_not_applicable_is_nan() {
        let times = [10 * MIN];
        let obs = [(2 * MIN, 2 * MIN, Some(2.0)), (3 * MIN, MIN, Some(1.0))];
        assert_eq!(align(&times, &obs).0, [2.0]);
        let (v, a) = align(&times, &[(MIN, MIN, None)]);
        assert!(v[0].is_nan());
        assert_eq!(a[0], 60.0, "its time is known even without a value");
    }

    #[test]
    fn a_window_keeps_positions_inside_it() {
        let w = TimeWindow {
            start: "09:30".into(),
            end: "11:30".into(),
            time_zone: None,
        }
        .parse()
        .unwrap();
        let t = |h: i64, m: i64| (1_791_331_200 + 4 * 3600 + h * 3600 + m * 60) * 1_000_000_000;
        assert!(w.contains(t(9, 30)) && w.contains(t(11, 29)));
        assert!(!w.contains(t(9, 29)) && !w.contains(t(11, 30)));
        let times = [t(9, 29), t(9, 30), t(11, 29), t(11, 30), t(11, 31)];
        let mut targets = [1.0, 1.0, 1.0, 1.0, 1.0];
        w.flatten(&times, &mut targets);
        assert_eq!(targets, [1.0, 1.0, 0.0, 0.0, 0.0]);
        assert!(
            TimeWindow {
                start: "11:30".into(),
                end: "09:30".into(),
                time_zone: None
            }
            .parse()
            .is_err()
        );
        assert!(
            TimeWindow {
                start: "9".into(),
                end: "10:00".into(),
                time_zone: None
            }
            .parse()
            .is_err()
        );
        assert!(
            check(
                &[],
                Some(&TimeWindow {
                    start: "09:30".into(),
                    end: "10:00".into(),
                    time_zone: None
                }),
                Timeframe::D1
            )
            .is_err()
        );
        assert!(check(&["acme".into()], None, Timeframe::M5).is_err());
    }

    fn five_minute_day() -> Vec<Bar> {
        let open = Timestamp::parse("2026-10-02T09:30:00-04:00").unwrap();
        let price = |v: f64| Price(Decimal::from_f64(v).unwrap());
        (-6..24)
            .map(|k: i64| {
                let (h, l) = match k {
                    -3 => (21000.0, 20000.0),
                    1 => (20712.5, 20650.0),
                    4 => (20660.25, 20601.75),
                    9 => (20750.0, 20580.25),
                    _ => (20655.0, 20640.0),
                };
                Bar {
                    t: Timestamp(open.0 + k * 5 * MIN),
                    o: price(l),
                    h: price(h),
                    l: price(l),
                    c: price(h),
                    v: Qty(Decimal::ONE),
                    bv: None,
                }
            })
            .collect()
    }

    #[test]
    fn studies_read_the_initial_balance_from_the_bar_after_its_window() {
        let cal = SessionCalendar::UsEquities;
        let frame = crate::study::frame_of(&five_minute_day(), cal);
        let names = vec!["tessera.ib.high".to_owned(), "tessera.ib.low50".to_owned()];
        let (cols, inputs) =
            initial_balance_columns(&names, &frame, cal, Timeframe::M5, 30, "QQQ").unwrap();
        let at = |c: &LevelColumn, k: i64| c.values[(k + 6) as usize];
        assert!(at(&cols[0], 5).is_nan(), "still inside the window at 09:55");
        assert_eq!(at(&cols[0], 6), 20712.5);
        assert_eq!(at(&cols[0], 23), 20712.5);
        assert_eq!(at(&cols[1], 6), 20601.75 - 0.5 * (20712.5 - 20601.75));
        assert_eq!(
            cols[0].as_of[12],
            Timestamp::parse("2026-10-02T10:00:00-04:00").unwrap().0 as f64 / 1e9
        );
        assert_eq!(inputs[0].series, "tessera.ib.high (30 min)");
        assert_eq!(inputs[0].sessions, 1);
        let (hour, _) =
            initial_balance_columns(&names[..1], &frame, cal, Timeframe::M5, 60, "QQQ").unwrap();
        assert!(at(&hour[0], 11).is_nan());
        assert_eq!(at(&hour[0], 12), 20750.0);
        assert!(
            initial_balance_columns(
                &["tessera.ib.top".into()],
                &frame,
                cal,
                Timeframe::M5,
                30,
                "QQQ"
            )
            .is_err()
        );
        assert!(check(&["tessera.ib.mid".into()], None, Timeframe::M5).is_ok());
        assert!(check(&["tessera.ib.top".into()], None, Timeframe::M5).is_err());
    }
}
