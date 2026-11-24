use serde_json::{Map, json};
use tessera_core::session::SessionCalendar;
use tessera_script::{BarArrays, Limits, ScriptError, describe, run_indicator};

fn bars(n: usize) -> BarArrays {
    let t0 = 1_790_861_400.0;
    let close: Vec<f64> = (0..n)
        .map(|i| 100.0 + (i as f64 * 0.7).sin() * 3.0 + i as f64 * 0.01)
        .collect();
    BarArrays {
        time: (0..n).map(|i| t0 + 300.0 * i as f64).collect(),
        open: close.iter().map(|c| c - 0.2).collect(),
        high: close.iter().map(|c| c + 0.5).collect(),
        low: close.iter().map(|c| c - 0.6).collect(),
        volume: (0..n).map(|i| 100.0 + (i % 7) as f64 * 10.0).collect(),
        close,
        buy_volume: None,
        calendar: SessionCalendar::CmeEquityIndex,
    }
}

fn run(code: &str) -> Result<tessera_script::IndicatorRun, ScriptError> {
    run_indicator(code, &bars(50), &Map::new(), Limits::INDICATOR)
}

fn code_error(code: &str) -> tessera_script::CodeError {
    match run(code) {
        Err(ScriptError::Code { error }) => *error,
        other => panic!("expected a code error, got {other:?}"),
    }
}

const HEAD: &str = "export const indicator = { plots: ['v'] };\n";

#[test]
fn a_loop_that_never_ends_is_stopped_at_the_time_limit() {
    let code = format!("{HEAD}export function compute(bars) {{\n  while (true) {{}}\n}}\n");
    let limits = Limits {
        time: std::time::Duration::from_millis(200),
        ..Limits::INDICATOR
    };
    let e = run_indicator(&code, &bars(10), &Map::new(), limits).unwrap_err();
    assert!(matches!(e, ScriptError::Timeout { ms: 200, .. }), "{e:?}");
    assert!(matches!(e.line(), Some(2 | 3)), "{e:?}");
    assert!(
        e.to_string()
            .starts_with("ran longer than 0.2 s (the time limit)"),
        "{e}"
    );
    let code = format!(
        "{HEAD}export function compute(bars) {{\n  try {{ for (;;) {{}} }} catch (e) {{ return {{ v: bars.close }} }}\n}}\n"
    );
    let e = run_indicator(&code, &bars(10), &Map::new(), limits).unwrap_err();
    assert!(matches!(e, ScriptError::Timeout { .. }), "{e:?}");
    assert_eq!(
        ScriptError::Timeout {
            ms: 2000,
            line: None
        }
        .to_string(),
        "ran longer than 2 s (the time limit); look for a loop that never ends"
    );
}

#[test]
fn memory_past_the_limit_stops_the_run() {
    let code = format!(
        "{HEAD}export function compute(bars) {{\n  const keep = [];\n  for (;;) keep.push(new Float64Array(1 << 20));\n}}\n"
    );
    let e = run(&code).unwrap_err();
    assert!(matches!(e, ScriptError::Memory { .. }), "{e:?}");
    assert!(
        e.to_string().starts_with("used more than 64 MB of memory"),
        "{e}"
    );
    assert_eq!(e.line(), Some(4));
}

#[test]
fn the_code_reaches_nothing_of_the_host() {
    let code = format!(
        "{HEAD}export function compute(bars) {{\n  console.log([typeof require, typeof process, typeof std, typeof os, typeof fetch, typeof XMLHttpRequest, typeof setTimeout, typeof setInterval, typeof WebAssembly, typeof Deno, typeof Bun, typeof __log, typeof __zoneOffset, typeof __barOffsets, typeof performance].join(' '));\n  return {{ v: bars.close }};\n}}\n"
    );
    let r = run(&code).unwrap();
    assert_eq!(
        r.logs.trim(),
        "undefined undefined undefined undefined undefined undefined undefined undefined undefined undefined undefined undefined undefined undefined undefined"
    );
    let e = code_error(&format!(
        "import * as os from 'os';\n{HEAD}export function compute(b) {{ return {{ v: b.close }} }}\n"
    ));
    assert_eq!(e.line, Some(1));
    assert!(
        e.message.starts_with("imports are not available"),
        "{}",
        e.message
    );
    let e = code_error(&format!(
        "{HEAD}const fs = await import('fs');\nexport function compute(b) {{ return {{ v: b.close }} }}\n"
    ));
    assert_eq!(e.line, Some(2));
    assert!(
        e.message.starts_with("imports are not available"),
        "{}",
        e.message
    );
    let e = code_error(&format!(
        "{HEAD}globalThis.ta = 1;\nexport function compute(b) {{ return {{ v: b.close }} }}\n"
    ));
    assert_eq!(e.line, Some(2));
    assert_eq!(e.kind, "TypeError");
}

#[test]
fn errors_name_the_line_in_the_users_code() {
    let e = code_error(&format!(
        "{HEAD}function slope(x) {{\n  return x.nope.length;\n}}\nexport function compute(bars) {{\n  return {{ v: slope(bars) }};\n}}\n"
    ));
    assert_eq!(e.kind, "TypeError");
    assert_eq!(e.line, Some(3));
    assert_eq!(e.text, "return x.nope.length;");
    assert_eq!(
        e.frames
            .iter()
            .map(|f| (f.line, f.function.as_str()))
            .collect::<Vec<_>>(),
        [(6, "compute"), (3, "slope")],
        "outermost first"
    );
    assert!(e.to_string().starts_with("line 3: TypeError: "), "{e}");

    let e = code_error(
        "export const indicator = { plots: ['v'] };\nexport function compute(bars) {\n  return 1 +;\n}\n",
    );
    assert_eq!((e.kind.as_str(), e.line), ("SyntaxError", Some(3)));
    assert!(e.column.is_some());

    let e = code_error(&format!(
        "{HEAD}export function compute(bars) {{\n  return {{ v: ta.ema(bars.close, 0) }};\n}}\n"
    ));
    assert_eq!(e.line, Some(3));
    assert_eq!(
        e.to_string(),
        "line 3: ta.ema: the length is a whole number of at least 1, not 0"
    );

    let e = code_error(&format!(
        "{HEAD}export function compute(bars) {{\n  console.log('n', bars.length);\n  throw new Error('stop');\n}}\n"
    ));
    assert_eq!(e.logs, "n 50\n");
    assert_eq!(e.line, Some(4));
}

#[test]
fn bad_declarations_are_refused_with_their_line() {
    let code = "export const indicator = {\n  title: 'x',\n  inputs: {\n    n: { type: 'int', default: 0, min: 1 },\n  },\n  plots: ['v'],\n};\nexport function compute(bars) { return { v: bars.close } }\n";
    let e = match describe(code) {
        Err(ScriptError::Code { error }) => error,
        other => panic!("{other:?}"),
    };
    assert_eq!(e.to_string(), "line 4: inputs.n: default 0 is below min 1");
    let e = describe("export const indicator = { plots: ['v'] };\n").unwrap_err();
    assert!(e.to_string().contains("define the computation"), "{e}");
    let e = describe("export function compute() {}\n").unwrap_err();
    assert!(e.to_string().contains("declare the indicator"), "{e}");
    let e = describe("export const indicator = {\n  plots: [\n    { name: 'v', colour: 'teal' },\n  ],\n};\nexport function compute() {}\n").unwrap_err();
    assert_eq!(e.line(), Some(3), "{e}");
    assert!(e.to_string().contains("unknown fields: colour"), "{e}");
}

#[test]
fn a_declaration_reads_like_a_built_in() {
    let m = describe(
        "/** Two averages. */\nexport const indicator = {\n  title: 'EMA cross',\n  short: 'EMA×',\n  placement: 'overlay',\n  inputs: { fastLength: { type: 'int', default: 9, min: 1, max: 500 }, source: 'close', mult: 2.5, on: true, mode: { options: ['a', { value: 'b', label: 'Bee' }] } },\n  plots: ['fast', { name: 'hist', kind: 'histogram', colorBy: 'sign' }, { name: 'zero', kind: 'hline', value: 0 }],\n  fills: [{ from: 'fast', to: 'hist' }],\n};\nexport function compute() {}\n",
    )
    .unwrap();
    assert_eq!(m.title, "EMA cross");
    assert_eq!(m.description.as_deref(), Some("Two averages."));
    let inputs = serde_json::to_value(&m.inputs).unwrap();
    assert_eq!(inputs[0]["label"], "Fast length");
    assert_eq!(inputs[0]["type"], "int");
    assert_eq!(inputs[1]["type"], "source");
    assert_eq!(inputs[2]["type"], "number");
    assert_eq!(inputs[3]["type"], "bool");
    assert_eq!(
        inputs[4]["options"][1],
        json!({"value": "b", "label": "Bee"})
    );
    assert_eq!(m.series_keys(), ["fast", "hist"]);
    let plots = serde_json::to_value(&m.plots).unwrap();
    assert_eq!(plots[1]["default"]["downColor"], "down");
    assert_eq!(plots[2]["default"]["line"], "dash");
}

#[test]
fn outputs_are_checked() {
    let e = code_error(
        "export const indicator = { plots: ['a', 'b'] };\nexport function compute(bars) { return { a: bars.close, c: bars.close } }\n",
    );
    assert!(
        e.message.contains("'c', which plots does not declare"),
        "{}",
        e.message
    );
    let e = code_error(
        "export const indicator = { plots: ['a'] };\nexport function compute(bars) { return { a: bars.close.slice(1) } }\n",
    );
    assert_eq!(e.message, "plot 'a' has 49 values; there are 50 bars");
    let e = code_error(
        "export const indicator = { plots: ['a'] };\nexport function compute(bars) { return { a: 3 } }\n",
    );
    assert!(e.message.contains("returned one number"), "{}", e.message);
    let r = run("export const indicator = { plots: ['a'] };\nexport function compute(bars) { const x = Array.from(bars.close); x[0] = Infinity; return x }\n").unwrap();
    assert!(r.series[0].1[0].is_nan());
    assert_eq!(r.series[0].1[1], bars(50).close[1]);
    let e = run_indicator(
        "export const indicator = { inputs: { n: { type: 'int', default: 3, min: 1 } }, plots: ['a'] };\nexport function compute(bars, inputs) { return { a: ta.sma(bars.close, inputs.n) } }\n",
        &bars(20),
        &Map::from_iter([("n".into(), json!(0))]),
        Limits::INDICATOR,
    )
    .unwrap_err();
    assert_eq!(e.to_string(), "input n is 0; it must be at least 1");
}
