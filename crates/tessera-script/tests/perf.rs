use std::time::Instant;

use serde_json::Map;
use tessera_core::Timestamp;
use tessera_core::session::SessionCalendar;
use tessera_script::{BarArrays, Limits, run_indicator};

const EMA_CROSS: &str = include_str!("../../tessera-indicators/js/ema_cross.js");
const SESSION_LEVELS: &str = include_str!("../../tessera-indicators/js/session_levels.js");
const EMPTY: &str = "export const indicator = { plots: [] };\nexport function compute() {}\n";
const GLOBEX_BREAK_UTC_HOUR_EDT: i64 = 21;

fn bars(n: usize) -> BarArrays {
    let mut seed: u64 = 0x5eed_7a11;
    let mut next = || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((seed >> 33) as f64) / f64::from(u32::MAX)
    };
    let mut t = Timestamp::parse("2026-09-27T22:00:00Z").unwrap().secs() as f64;
    let (mut time, mut o, mut h, mut l, mut c, mut v) =
        (vec![], vec![], vec![], vec![], vec![], vec![]);
    let mut price = 24_000.0_f64;
    while time.len() < n {
        if (t / 3600.0).floor() as i64 % 24 != GLOBEX_BREAK_UTC_HOUR_EDT {
            let open = price;
            let close = open + (next() - 0.5) * 20.0;
            time.push(t);
            o.push(open);
            h.push(open.max(close) + next() * 6.0);
            l.push(open.min(close) - next() * 6.0);
            c.push(close);
            v.push((next() * 900.0).round() + 50.0);
            price = close;
        }
        t += 300.0;
    }
    BarArrays {
        time,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
        buy_volume: None,
        calendar: SessionCalendar::CmeEquityIndex,
    }
}

fn measure(code: &str, b: &BarArrays, runs: usize) -> (f64, f64, usize) {
    let mut times = Vec::new();
    let mut objects = 0;
    for _ in 0..runs {
        let t0 = Instant::now();
        let r = run_indicator(code, b, &Map::new(), Limits::INDICATOR).unwrap();
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
        objects = r.objects.lines.len();
    }
    times.sort_by(f64::total_cmp);
    (times[times.len() / 2], times[times.len() - 1], objects)
}

#[test]
#[ignore = "a measurement, not a check"]
fn two_thousand_bars_are_quick() {
    let b = bars(2000);
    let (empty, _, _) = measure(EMPTY, &b, 21);
    let (ema, ema_max, _) = measure(EMA_CROSS, &b, 21);
    let (levels, levels_max, lines) = measure(SESSION_LEVELS, &b, 21);
    println!(
        "2000 bars, median (worst) of 21 fresh runs: engine start {empty:.2} ms; EMA cross {ema:.2} ms ({ema_max:.2}); session levels {levels:.2} ms ({levels_max:.2}), {lines} levels"
    );
    assert!(lines > 0);
    let slack = if cfg!(debug_assertions) { 6.0 } else { 1.0 };
    assert!(ema < 10.0 * slack, "EMA cross: {ema:.2} ms");
    assert!(levels < 50.0 * slack, "session levels: {levels:.2} ms");
}
