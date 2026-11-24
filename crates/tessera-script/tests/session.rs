use serde_json::{Map, Value, json};
use tessera_core::Timestamp;
use tessera_core::session::SessionCalendar;
use tessera_protocol::indicators::InputType;
use tessera_script::{BarArrays, Limits, ScriptError, describe, run_indicator};

const SESSION_LEVELS: &str = include_str!("../../tessera-indicators/js/session_levels.js");
const FIVE_MINUTES: f64 = 300.0;

fn secs(at: &str) -> f64 {
    Timestamp::parse(at).unwrap().secs() as f64
}

fn bars(from: &str, to: &str) -> BarArrays {
    let (from, to) = (secs(from), secs(to));
    let time: Vec<f64> = (0_u32..)
        .map(|i| from + FIVE_MINUTES * f64::from(i))
        .take_while(|t| *t < to)
        .collect();
    let n = time.len();
    BarArrays {
        time,
        open: vec![100.0; n],
        high: vec![101.0; n],
        low: vec![99.0; n],
        close: vec![100.0; n],
        volume: vec![10.0; n],
        buy_volume: None,
        calendar: SessionCalendar::CmeEquityIndex,
    }
}

fn plots(code: &str, b: &BarArrays) -> Vec<(String, Vec<f64>)> {
    run_indicator(code, b, &Map::new(), Limits::INDICATOR)
        .unwrap()
        .series
}

fn logged(body: &str) -> String {
    let code = format!(
        "export const indicator = {{ plots: [] }};\nexport function compute(bars) {{\n  {body}\n}}\n"
    );
    let b = bars("2026-03-09T00:00:00Z", "2026-03-09T01:00:00Z");
    run_indicator(&code, &b, &Map::new(), Limits::INDICATOR)
        .unwrap()
        .logs
}

fn refused(code: &str, inputs: Value) -> String {
    let b = bars("2026-03-09T00:00:00Z", "2026-03-09T01:00:00Z");
    let inputs = inputs.as_object().cloned().unwrap_or_default();
    match run_indicator(code, &b, &inputs, Limits::INDICATOR) {
        Err(ScriptError::Code { error }) => error.message,
        other => panic!("expected a code error, got {other:?}"),
    }
}

fn utc_minute(t: f64) -> f64 {
    t.rem_euclid(86_400.0) / 60.0
}

fn inside(b: &BarArrays, ids: &[f64]) -> Vec<f64> {
    b.time
        .iter()
        .zip(ids)
        .filter(|(_, id)| !id.is_nan())
        .map(|(t, _)| *t)
        .collect()
}

#[test]
fn hours_without_a_zone_are_read_in_utc() {
    let b = bars("2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z");
    let out = plots(
        "export const indicator = { plots: ['ids', 'high'] };\nexport function compute(bars) {\n  return { ids: session.ids(bars, '07:00-10:00'), high: session.high(bars, '07:00-10:00') };\n}\n",
        &b,
    );
    let (ids, high) = (&out[0].1, &out[1].1);
    for (i, t) in b.time.iter().enumerate() {
        let m = utc_minute(*t);
        assert_eq!(
            !ids[i].is_nan(),
            (420.0..600.0).contains(&m),
            "bar at {m} min UTC"
        );
        assert_eq!(ids[i].is_nan(), high[i].is_nan());
    }
    let days: Vec<f64> = ids.iter().copied().filter(|v| !v.is_nan()).collect();
    assert_eq!(
        (days[0], days[days.len() - 1]),
        (
            (secs("2026-10-05T00:00:00Z") / 86_400.0),
            (secs("2026-10-06T00:00:00Z") / 86_400.0)
        ),
        "an occurrence is named by the UTC day it began on"
    );
}

#[test]
fn a_zone_after_the_hours_reads_them_on_that_zones_clock() {
    let b = bars("2026-10-05T00:00:00Z", "2026-10-08T00:00:00Z");
    let out = plots(
        "export const indicator = { plots: ['london', 'asia', 'high', 'prior'] };\nexport function compute(bars) {\n  return {\n    london: session.ids(bars, '07:00-10:00', 'Europe/London'),\n    asia: session.ids(bars, '20:00-00:00', 'America/New_York'),\n    high: session.high(bars, '07:00-10:00', 'Europe/London'),\n    prior: session.prior(bars, '07:00-10:00', 'Europe/London').high,\n  };\n}\n",
        &b,
    );
    let (london, asia, high, prior) = (&out[0].1, &out[1].1, &out[2].1, &out[3].1);
    let london_at = inside(&b, london);
    assert_eq!(london_at[0], secs("2026-10-05T06:00:00Z"), "07:00 BST");
    assert!(
        london_at
            .iter()
            .all(|t| (360.0..540.0).contains(&utc_minute(*t))),
        "07:00-10:00 London is 06:00-09:00 UTC in October"
    );
    let asia_at = inside(&b, asia);
    assert_eq!(asia_at[0], secs("2026-10-05T00:00:00Z"), "20:00 EDT");
    assert!(
        asia_at
            .iter()
            .all(|t| (0.0..240.0).contains(&utc_minute(*t))),
        "20:00-00:00 New York is 00:00-04:00 UTC in October"
    );
    assert_eq!(
        asia[0],
        secs("2026-10-04T00:00:00Z") / 86_400.0,
        "an evening session is named by the day it began on in its zone"
    );
    assert!(
        london
            .iter()
            .zip(high)
            .all(|(id, h)| id.is_nan() == h.is_nan())
    );
    let after = b
        .time
        .iter()
        .position(|t| *t == secs("2026-10-05T09:00:00Z"))
        .unwrap();
    assert!(prior[..after].iter().all(|v| v.is_nan()));
    assert_eq!(prior[after], 101.0, "the morning before, once it is over");

    let e = refused(
        "export const indicator = { plots: [] };\nexport function compute(bars) { session.prior(bars, 'day', 'Europe/London'); }\n",
        json!({}),
    );
    assert!(
        e.contains("'day' is the instrument's trading day, which no zone changes"),
        "{e}"
    );
}

#[test]
fn session_clock_reads_a_time_on_any_zones_clock() {
    let t = secs("2026-03-09T12:34:56Z");
    let logs = logged(&format!(
        "for (const z of [undefined, 'Europe/London', 'America/New_York', 'Asia/Kolkata']) {{ const c = session.clock({t}, z); console.log(c.year, c.month, c.day, c.weekday, c.hour, c.minute, c.second); }}"
    ));
    assert_eq!(
        logs, "2026 3 9 1 12 34 56\n2026 3 9 1 12 34 56\n2026 3 9 1 8 34 56\n2026 3 9 1 18 4 56\n",
        "UTC, London (still GMT), New York (EDT since 8 March), Kolkata (+05:30)"
    );
    let late = secs("2026-03-10T02:30:00Z");
    assert_eq!(
        logged(&format!(
            "const c = session.clock({late}, 'America/Los_Angeles'); console.log(c.day, c.weekday, c.hour, c.minute);"
        )),
        "9 1 19 30\n",
        "the calendar day is the zone's"
    );
}

#[test]
fn an_unknown_zone_is_refused_by_its_name() {
    let compute = |call: &str| {
        format!(
            "export const indicator = {{ plots: [] }};\nexport function compute(bars) {{ {call}; }}\n"
        )
    };
    for (call, what) in [
        (
            "session.list(bars, '07:00-10:00', 'Mars/Olympus')",
            "session.list",
        ),
        (
            "session.ids(bars, '07:00-10:00', 'europe/london')",
            "session.ids",
        ),
        (
            "session.high(bars, '07:00-10:00', 'Mars/Olympus')",
            "session.high",
        ),
        (
            "session.clock(bars.time[0], 'Mars/Olympus')",
            "session.clock",
        ),
        ("session.clock(bars.time[0], 5)", "session.clock"),
    ] {
        let e = refused(&compute(call), json!({}));
        assert!(e.starts_with(&format!("{what}: ")), "{e}");
        assert!(e.contains("is not a time zone"), "{e}");
    }
    let e = refused(
        &compute("session.list(bars, '07:00-10:00', 'Mars/Olympus')"),
        json!({}),
    );
    assert_eq!(
        e,
        "session.list: 'Mars/Olympus' is not a time zone (an IANA name such as 'America/New_York', 'Europe/London' or 'UTC')"
    );
    let e = refused(&compute("session.list(bars, '7am-10am')"), json!({}));
    assert!(
        e.contains("a session is hours of the day as 'HH:MM-HH:MM'"),
        "{e}"
    );
    let e = refused(&compute("session.list(bars, '23:00-24:30')"), json!({}));
    assert!(e.contains("is not a time of day"), "{e}");

    let decl = "export const indicator = {\n  inputs: {\n    zone: { type: 'timezone', default: 'Nowhere/City' },\n  },\n  plots: [],\n};\nexport function compute() {}\n";
    let e = describe(decl).unwrap_err();
    assert_eq!(e.line(), Some(3), "{e}");
    assert!(
        e.to_string()
            .contains("inputs.zone: 'Nowhere/City' is not a time zone"),
        "{e}"
    );
}

#[test]
fn session_and_timezone_inputs_are_declared_and_checked() {
    let code = "export const indicator = {\n  inputs: {\n    hours: { type: 'session', default: '07:00-10:00', label: 'London hours' },\n    zone: { type: 'timezone', default: 'Europe/London' },\n    evening: '20:00-00:00',\n    tokyo: 'Asia/Tokyo',\n    utc: { type: 'timezone' },\n  },\n  plots: [],\n};\nexport function compute(bars, inputs) {\n  console.log(inputs.hours, inputs.zone, inputs.evening, inputs.tokyo, inputs.utc);\n}\n";
    let m = describe(code).unwrap();
    let declared: Vec<(&str, InputType, &Value, bool)> = m
        .inputs
        .iter()
        .map(|i| (i.key.as_str(), i.ty, &i.default, i.in_label))
        .collect();
    assert_eq!(
        declared,
        [
            ("hours", InputType::Session, &json!("07:00-10:00"), false),
            ("zone", InputType::Timezone, &json!("Europe/London"), false),
            ("evening", InputType::Session, &json!("20:00-00:00"), false),
            ("tokyo", InputType::Timezone, &json!("Asia/Tokyo"), false),
            ("utc", InputType::Timezone, &json!("UTC"), false),
        ]
    );
    let b = bars("2026-03-09T00:00:00Z", "2026-03-09T01:00:00Z");
    let given = json!({"hours": "08:00-09:00", "zone": "America/New_York"});
    let r = run_indicator(code, &b, given.as_object().unwrap(), Limits::INDICATOR).unwrap();
    assert_eq!(
        r.logs,
        "08:00-09:00 America/New_York 20:00-00:00 Asia/Tokyo UTC\n"
    );
    let e = refused(code, json!({"hours": "8am"}));
    assert!(
        e.starts_with("input hours: a session is hours of the day"),
        "{e}"
    );
    let e = refused(code, json!({"zone": "London"}));
    assert_eq!(
        e,
        "input zone: 'London' is not a time zone (an IANA name such as 'America/New_York', 'Europe/London' or 'UTC')"
    );
    let e = describe(
        "export const indicator = {\n  inputs: { hours: { type: 'session' } },\n  plots: [],\n};\nexport function compute() {}\n",
    )
    .unwrap_err();
    assert!(
        e.to_string()
            .contains("inputs.hours: a session is hours of the day"),
        "{e}"
    );
}

fn london_levels(inputs: Value) -> Vec<(String, f64, f64)> {
    let mut b = bars("2026-03-08T23:00:00Z", "2026-03-13T21:00:00Z");
    let at = |b: &BarArrays, when: &str| b.time.iter().position(|t| *t == secs(when)).unwrap();
    for (when, high) in [
        ("2026-03-10T06:30:00Z", 120.0),
        ("2026-03-10T08:00:00Z", 110.0),
        ("2026-03-10T09:30:00Z", 115.0),
    ] {
        let i = at(&b, when);
        b.high[i] = high;
    }
    for (when, low) in [
        ("2026-03-10T06:35:00Z", 80.0),
        ("2026-03-10T07:15:00Z", 90.0),
        ("2026-03-10T09:45:00Z", 85.0),
    ] {
        let i = at(&b, when);
        b.low[i] = low;
    }
    let tuesday = secs("2026-03-10T00:00:00Z")..secs("2026-03-11T00:00:00Z");
    let r = run_indicator(
        SESSION_LEVELS,
        &b,
        inputs.as_object().unwrap(),
        Limits::INDICATOR,
    )
    .unwrap();
    r.objects
        .lines
        .iter()
        .filter_map(|l| {
            let text = l.label.as_ref()?.text.clone();
            let t = l.time1.secs() as f64;
            (text.starts_with("London") && tuesday.contains(&t)).then_some((text, t, l.price1))
        })
        .collect()
}

#[test]
fn session_levels_reads_london_on_londons_clock_in_the_week_only_new_york_has_changed() {
    let levels = london_levels(json!({}));
    assert_eq!(
        levels,
        [
            ("London H".to_owned(), secs("2026-03-10T09:30:00Z"), 115.0),
            ("London L".to_owned(), secs("2026-03-10T09:45:00Z"), 85.0),
        ],
        "07:00-10:00 London (GMT until 29 March) is 03:00-06:00 New York this week: the bars at 06:30 and 06:35 UTC are before it, the ones at 09:30 and 09:45 inside"
    );
    let m = describe(SESSION_LEVELS).unwrap();
    let london: Vec<(&str, InputType, &Value)> = m
        .inputs
        .iter()
        .filter(|i| i.key.starts_with("london"))
        .map(|i| (i.key.as_str(), i.ty, &i.default))
        .collect();
    assert_eq!(
        london,
        [
            ("london", InputType::Bool, &json!(true)),
            ("londonColor", InputType::Color, &json!("t2")),
            ("londonHours", InputType::Session, &json!("07:00-10:00")),
            ("londonZone", InputType::Timezone, &json!("Europe/London")),
        ]
    );
    for (key, hours, zone) in [
        ("asia", "20:00-00:00", "America/New_York"),
        ("nyAm", "09:30-11:00", "America/New_York"),
    ] {
        let default_of = |k: String| {
            m.inputs
                .iter()
                .find(|i| i.key == k)
                .unwrap()
                .default
                .clone()
        };
        assert_eq!(default_of(format!("{key}Hours")), json!(hours));
        assert_eq!(default_of(format!("{key}Zone")), json!(zone));
    }

    let in_new_york =
        london_levels(json!({"londonHours": "02:00-05:00", "londonZone": "America/New_York"}));
    assert_eq!(
        in_new_york,
        [
            ("London H".to_owned(), secs("2026-03-10T06:30:00Z"), 120.0),
            ("London L".to_owned(), secs("2026-03-10T06:35:00Z"), 80.0),
        ],
        "the hours and zone are the inputs: 02:00-05:00 New York is 06:00-09:00 UTC this week"
    );
}
