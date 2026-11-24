use rust_decimal::Decimal;
use serde_json::{Map, Value, json};
use tessera_core::market::Bar;
use tessera_core::session::SessionCalendar;
use tessera_core::{Price, Qty, Timeframe, Timestamp};
use tessera_indicators::{BarKind, Grid, builtin_series};
use tessera_market::io::SessionFilter;
use tessera_protocol::layers::LayerKind;
use tessera_script::{BarArrays, Limits, call};

const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/builtins.json");
const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;

const TA: &str = r#"
const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'];
const source = (bars, name) => bars[SOURCES.includes(name) ? name : 'close'];
const zip = (a, b, f) => a.map((x, i) => f(x, b[i]));
const KINDS = {
  sma: (b, i) => ({ ma: ta.sma(source(b, i.source), i.length) }),
  ema: (b, i) => ({ ma: ta.ema(source(b, i.source), i.length) }),
  wma: (b, i) => ({ ma: ta.wma(source(b, i.source), i.length) }),
  volume: (b, i) => ({ volume: b.volume, ma: ta.sma(b.volume, i.maLength) }),
  rsi: (b, i) => ({ rsi: ta.rsi(source(b, i.source), i.length) }),
  atr: (b, i) => ({ atr: ta.atr(b, i.length, i.smoothing) }),
  bollinger(b, i) {
    const x = source(b, i.source);
    const basis = ta.sma(x, i.length);
    const sd = ta.stdev(x, i.length);
    return { basis, upper: zip(basis, sd, (m, s) => m + i.mult * s), lower: zip(basis, sd, (m, s) => m - i.mult * s) };
  },
  macd(b, i) {
    const x = source(b, i.source);
    const m = zip(ta.ema(x, i.fast), ta.ema(x, i.slow), (f, s) => f - s);
    const signal = ta.ema(m, i.signal);
    return { hist: zip(m, signal, (a, s) => a - s), macd: m, signal };
  },
  stochastic(b, i) {
    const hh = ta.highest(b.high, i.length);
    const ll = ta.lowest(b.low, i.length);
    const raw = b.close.map((c, j) => (hh[j] > ll[j] ? (100 * (c - ll[j])) / (hh[j] - ll[j]) : NaN));
    const k = ta.sma(raw, i.smoothK);
    return { k, d: ta.sma(k, i.smoothD) };
  },
};
export function run(bars, p) {
  return KINDS[p.kind](bars, p.inputs);
}
"#;

fn bars() -> Value {
    let mut seed: u64 = 0x5eed_1234;
    let mut next = || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((seed >> 33) as f64) / f64::from(u32::MAX)
    };
    let (mut o, mut h, mut l, mut c, mut v) = (vec![], vec![], vec![], vec![], vec![]);
    let mut price = 100.0_f64;
    for i in 0..240 {
        let open = price;
        let flat = (100..116).contains(&i);
        let close = if flat {
            open
        } else {
            open + (next() - 0.48) * 2.0
        };
        let high = if flat { open } else { open.max(close) + next() };
        let low = if flat { open } else { open.min(close) - next() };
        o.push(round(open));
        h.push(round(high));
        l.push(round(low));
        c.push(round(close));
        v.push((next() * 1000.0).round() + 1.0);
        price = close;
    }
    let time: Vec<f64> = (0..240)
        .map(|i| 1_790_625_600.0 + 900.0 * f64::from(i))
        .collect();
    let day =
        arrays(&json!({ "open": o, "high": h, "low": l, "close": c, "volume": v, "time": time }))
            .day_keys();
    json!({ "open": o, "high": h, "low": l, "close": c, "volume": v, "time": time, "day": day })
}

fn round(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn cases() -> Vec<(&'static str, Value)> {
    vec![
        ("sma", json!({"length": 20, "source": "close"})),
        ("sma", json!({"length": 5, "source": "hl2"})),
        ("ema", json!({"length": 9, "source": "close"})),
        ("ema", json!({"length": 21, "source": "hlc3"})),
        ("wma", json!({"length": 10, "source": "close"})),
        ("volume", json!({"maLength": 20})),
        ("rsi", json!({"length": 14, "source": "close"})),
        ("rsi", json!({"length": 7, "source": "ohlc4"})),
        ("atr", json!({"length": 14, "smoothing": "rma"})),
        ("atr", json!({"length": 10, "smoothing": "sma"})),
        ("atr", json!({"length": 10, "smoothing": "ema"})),
        ("atr", json!({"length": 10, "smoothing": "wma"})),
        (
            "bollinger",
            json!({"length": 20, "mult": 2.0, "source": "close"}),
        ),
        (
            "macd",
            json!({"fast": 12, "slow": 26, "signal": 9, "source": "close"}),
        ),
        (
            "stochastic",
            json!({"length": 14, "smoothK": 1, "smoothD": 3}),
        ),
        (
            "stochastic",
            json!({"length": 14, "smoothK": 3, "smoothD": 3}),
        ),
    ]
}

fn column(bars: &Value, k: &str) -> Vec<f64> {
    bars[k]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}

fn arrays(bars: &Value) -> BarArrays {
    BarArrays {
        time: column(bars, "time"),
        open: column(bars, "open"),
        high: column(bars, "high"),
        low: column(bars, "low"),
        close: column(bars, "close"),
        volume: column(bars, "volume"),
        buy_volume: None,
        calendar: CAL,
    }
}

fn exact(x: f64) -> Price {
    Price(Decimal::from_str_exact(&x.to_string()).unwrap())
}

fn as_bars(bars: &Value) -> Vec<Bar> {
    let a = arrays(bars);
    (0..a.len())
        .map(|i| Bar {
            t: Timestamp((a.time[i] as i64) * 1_000_000_000),
            o: exact(a.open[i]),
            h: exact(a.high[i]),
            l: exact(a.low[i]),
            c: exact(a.close[i]),
            v: Qty::from(a.volume[i] as i64),
            bv: None,
        })
        .collect()
}

fn as_json(series: Vec<(String, Vec<f64>)>) -> Value {
    let mut map = Map::new();
    for (k, values) in series {
        let values: Vec<Value> = values
            .iter()
            .map(|v| if v.is_finite() { json!(v) } else { Value::Null })
            .collect();
        map.insert(k, Value::Array(values));
    }
    Value::Object(map)
}

fn native(bars: &Value, kind: &str, inputs: &Value) -> Value {
    let grid = Grid {
        calendar: CAL,
        bars: BarKind::Time(Timeframe::M15),
        session: SessionFilter::All,
    };
    let kind = LayerKind::parse(kind).unwrap();
    let series = builtin_series(kind, inputs.as_object().unwrap(), &as_bars(bars), grid)
        .unwrap_or_else(|| panic!("{kind} is computed"));
    as_json(series)
}

fn normalized(kind: &str, inputs: &Value) -> Value {
    let spec =
        tessera_protocol::indicators::indicator_spec(LayerKind::parse(kind).unwrap()).unwrap();
    tessera_protocol::indicators::normalize_params(&spec, &json!({ "inputs": inputs })).unwrap()
        ["inputs"]
        .clone()
}

fn script(bars: &Value, kind: &str, inputs: &Value) -> Value {
    let (out, _) = call(
        TA,
        "run",
        &arrays(bars),
        &json!({"kind": kind, "inputs": normalized(kind, inputs)}),
        Limits::INDICATOR,
    )
    .unwrap_or_else(|e| panic!("{kind}: {e}"));
    as_json(out)
}

fn close(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0),
        (None, None) => a.is_null() && b.is_null(),
        _ => false,
    }
}

fn agree(kind: &str, inputs: &Value, got: &Value, want: &Value, by: &str) {
    for (key, have) in got.as_object().unwrap() {
        let want = want[key]
            .as_array()
            .unwrap_or_else(|| panic!("{kind}: the vectors have no {key}"));
        let have = have.as_array().unwrap();
        assert_eq!(have.len(), want.len(), "{kind}.{key}");
        for (i, (h, w)) in have.iter().zip(want).enumerate() {
            assert!(close(h, w), "{by}: {kind} {inputs} .{key}[{i}]: {h} vs {w}");
        }
    }
}

#[test]
fn built_in_indicators_and_scripts_ta_give_the_same_numbers() {
    if std::env::var_os("TESSERA_UPDATE_VECTORS").is_some() {
        let bars = bars();
        let mut out = Vec::new();
        for (kind, inputs) in cases() {
            let outputs = native(&bars, kind, &inputs);
            out.push(json!({"kind": kind, "inputs": inputs, "outputs": outputs}));
        }
        let doc = json!({
            "about": "Built-in indicators over the same bars: written by crates/tessera-indicators/tests/builtins.rs from the runtime's own studies, which the script engine's ta (custom indicators and research studies) is checked against. The session VWAP is measured from prints, so it has no vector here. bars.day is each bar's Globex trading day.",
            "bars": bars,
            "cases": out,
        });
        std::fs::write(VECTORS, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
    }
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(VECTORS).unwrap()).unwrap();
    let bars = &doc["bars"];
    assert_eq!(
        arrays(bars).day_keys(),
        column(bars, "day"),
        "the vectors' trading days are the engine's"
    );
    let all = doc["cases"].as_array().unwrap();
    assert_eq!(all.len(), cases().len());
    for case in all {
        let kind = case["kind"].as_str().unwrap();
        let inputs = &case["inputs"];
        let want = &case["outputs"];
        agree(kind, inputs, &native(bars, kind, inputs), want, "the study");
        agree(kind, inputs, &script(bars, kind, inputs), want, "ta");
        let first = want.as_object().unwrap().values().next().unwrap();
        assert!(
            first
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .take(50)
                .any(Value::is_number),
            "{kind}"
        );
    }
}
