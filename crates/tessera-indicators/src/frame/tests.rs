use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::NaiveDate;
use serde_json::{Value, json};
use tessera_core::market::Bar;
use tessera_core::session::SessionCalendar;
use tessera_core::{Price, Qty, Timeframe, Timestamp};
use tessera_market::io::SessionFilter;
use tessera_market::orderflow::flow::{BarFlow, Sides};
use tessera_market::orderflow::vwap::PrintSums;
use tessera_protocol::compact::CompactBar;
use tessera_protocol::indicators::{indicator_spec, normalize_params};
use tessera_protocol::layers::LayerKind;
use tokio::time::Instant;

use super::*;
use crate::studies::{Pulls, ScriptStudy, Study, native};

const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;
const EMA_CROSS: &str = include_str!("../../js/ema_cross.js");

struct Rng(u64);

impl Rng {
    fn unit(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 32) as f64) / (f64::from(u32::MAX) + 1.0)
    }

    fn below(&mut self, n: usize) -> usize {
        ((self.unit() * n as f64) as usize).min(n.saturating_sub(1))
    }
}

fn grid() -> Grid {
    Grid {
        calendar: CAL,
        bars: BarKind::Time(Timeframe::M5),
        session: SessionFilter::All,
    }
}

fn price(x: f64) -> Price {
    Price::from_f64((x * 4.0).round() / 4.0).unwrap()
}

fn compact(bars: &[Bar]) -> Vec<CompactBar> {
    bars.iter().map(CompactBar::from).collect()
}

struct Market {
    bars: Vec<Bar>,
    flows: Vec<Option<BarFlow>>,
}

fn market(sessions: u32, seed: u64, gaps: bool) -> Market {
    let last = NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    let first = last - chrono::Duration::days(2 * i64::from(sessions) + 3);
    let mut days = CAL.sessions_between(first, last);
    days.drain(..days.len() - sessions as usize);
    let mut rng = Rng(seed);
    let mut p = 5_000.0;
    let mut bars = Vec::new();
    let mut flows = Vec::new();
    for s in &days {
        for t in s
            .minutes()
            .filter(|t| CAL.bucket_start(*t, Timeframe::M5) == *t)
        {
            let o = p;
            let c = o + (rng.unit() - 0.5) * 6.0;
            let h = o.max(c) + rng.unit() * 2.0;
            let l = o.min(c) - rng.unit() * 2.0;
            p = c;
            let v = (rng.unit() * 900.0).round() + 10.0;
            bars.push(Bar {
                t,
                o: price(o),
                h: price(h),
                l: price(l),
                c: price(c),
                v: Qty::from(v as i64),
                bv: None,
            });
            let delta = ((rng.unit() - 0.5) * v).round();
            let extremes = rng.unit() > 0.2;
            let at = (o + c) / 2.0 + (rng.unit() - 0.5);
            let printed = rng.unit() > 0.03 || !gaps;
            flows.push(printed.then(|| BarFlow {
                sides: Sides {
                    volume: v,
                    delta,
                    delta_high: if extremes {
                        delta.max(0.0) + (rng.unit() * 30.0).round()
                    } else {
                        f64::NAN
                    },
                    delta_low: if extremes {
                        delta.min(0.0) - (rng.unit() * 30.0).round()
                    } else {
                        f64::NAN
                    },
                },
                sums: PrintSums {
                    volume: v,
                    pv: at * v,
                    pv2: at * at * v + rng.unit() * v,
                },
            }));
        }
    }
    Market { bars, flows }
}

fn built(kind: &str, inputs: Value) -> (StudyKey, Arc<dyn Study>) {
    let kind = LayerKind::parse(kind).unwrap();
    let spec = indicator_spec(kind).unwrap();
    let normalized = normalize_params(&spec, &json!({ "inputs": inputs })).unwrap();
    let inputs = normalized["inputs"].as_object().unwrap().clone();
    let key = StudyKey {
        id: StudyId::Builtin(kind),
        params: tessera_core::hash::hash_json(&Value::Object(inputs.clone())),
    };
    (key, native(kind, &inputs).unwrap())
}

fn script() -> (StudyKey, Arc<dyn Study>) {
    let manifest = tessera_script::describe(EMA_CROSS).unwrap();
    let columns = manifest
        .series_keys()
        .iter()
        .map(|k| (*k).to_owned())
        .collect();
    let key = StudyKey {
        id: StudyId::Custom {
            id: "ci_cross".into(),
            version: 1,
        },
        params: "{}".into(),
    };
    (
        key,
        Arc::new(ScriptStudy::new(EMA_CROSS, serde_json::Map::new(), columns)),
    )
}

fn every_study() -> Vec<(StudyKey, Arc<dyn Study>)> {
    vec![
        built("sma", json!({"length": 20, "source": "close"})),
        built("sma", json!({"length": 7, "source": "hl2"})),
        built("ema", json!({"length": 9, "source": "hlc3"})),
        built("ema", json!({"length": 50, "source": "ohlc4"})),
        built("wma", json!({"length": 10, "source": "open"})),
        built("wma", json!({"length": 4, "source": "low"})),
        built("vwap", json!({"band1": true, "band3": true, "mult3": 2.5})),
        built("vwap", json!({})),
        built("volume", json!({"maLength": 20})),
        built("rsi", json!({"length": 14, "source": "close"})),
        built("rsi", json!({"length": 3, "source": "high"})),
        built("atr", json!({"length": 14, "smoothing": "rma"})),
        built("atr", json!({"length": 10, "smoothing": "sma"})),
        built("atr", json!({"length": 10, "smoothing": "ema"})),
        built("atr", json!({"length": 5, "smoothing": "wma"})),
        built(
            "bollinger",
            json!({"length": 20, "mult": 2.0, "source": "close"}),
        ),
        built(
            "macd",
            json!({"fast": 12, "slow": 26, "signal": 9, "source": "close"}),
        ),
        built(
            "stochastic",
            json!({"length": 14, "smoothK": 1, "smoothD": 3}),
        ),
        built(
            "stochastic",
            json!({"length": 9, "smoothK": 3, "smoothD": 2}),
        ),
        built("delta", json!({"reset": "session"})),
        built("delta", json!({"reset": "chart"})),
        built("effort", json!({"maxBarSeconds": 0})),
        script(),
    ]
}

fn asked(indicator: &str) -> Asked {
    Asked {
        indicator: indicator.to_owned(),
        tf: Timeframe::M5,
        version: None,
        inputs: serde_json::Map::new(),
    }
}

fn watch_name(key: &StudyKey) -> WatchKey {
    WatchKey(format!("{:?}{}", key.id, key.params))
}

type Bits = Vec<u64>;

#[derive(Default)]
struct Mirror {
    rev: u64,
    rows: BTreeMap<i64, Bits>,
}

impl Mirror {
    fn apply(&mut self, p: &Published) {
        assert_eq!(
            p.rev,
            self.rev + 1,
            "{:?}: revisions follow each other",
            p.watch
        );
        self.rev = p.rev;
        match p.change.replaces {
            Replaced::All => self.rows.clear(),
            Replaced::Span { from, to } => {
                let gone: Vec<i64> = self.rows.range(from..=to).map(|(t, _)| *t).collect();
                for t in gone {
                    self.rows.remove(&t);
                }
            }
        }
        for (i, t) in p.change.time.iter().enumerate() {
            let bits = p
                .change
                .columns
                .iter()
                .map(|(_, c)| c[i].to_bits())
                .collect();
            self.rows.insert(*t, bits);
        }
    }
}

fn bits_of(v: &Values) -> BTreeMap<i64, Bits> {
    v.time
        .iter()
        .enumerate()
        .map(|(i, t)| (*t, v.columns.iter().map(|(_, c)| c[i].to_bits()).collect()))
        .collect()
}

fn recomputed(f: &Frame, key: &StudyKey, study: &Arc<dyn Study>) -> BTreeMap<i64, Bits> {
    let mut fresh = Frame::new(f.grid());
    fresh.rows = f.rows.clone();
    fresh.attach(key, study);
    let n = fresh.rows.len();
    bits_of(&fresh.values(key, 0..n).unwrap())
}

fn next_ask(f: &Frame) -> Option<FlowAsk> {
    f.flow_asks(i64::MIN, Pulls::Sessions(5)).into_iter().next()
}

fn put_read(f: &mut Frame, ask: &FlowAsk, read: FlowRead) {
    f.put_flow_reads(&[(ask.clone(), read)]);
}

fn read_of(m: &Market, ask: &FlowAsk) -> FlowRead {
    FlowRead {
        bars: ask
            .opens
            .iter()
            .map(|t| m.flows[m.bars.iter().position(|b| b.t == *t).unwrap()])
            .collect(),
        ..FlowRead::default()
    }
}

#[test]
fn every_study_cached_equals_a_full_recompute() {
    let m = market(4, 7, true);
    let studies = every_study();
    let mut rng = Rng(42);
    let mut f = Frame::new(grid());
    let start = m.bars.len() - 300;
    let mut next = start + 200;
    f.put_bars(
        Span::new(m.bars[start].t.0, m.bars[next - 1].t.0),
        &compact(&m.bars[start..next]),
    );
    let mut mirrors: HashMap<WatchKey, Mirror> = HashMap::new();
    for (key, study) in &studies {
        let w = watch_name(key);
        f.watch(&w, asked("x"), key, study);
        let snap = f.snapshot(&w, None).unwrap().this;
        let mut mirror = Mirror::default();
        for (i, t) in snap.change.time.iter().enumerate() {
            let bits = snap
                .change
                .columns
                .iter()
                .map(|(_, c)| c[i].to_bits())
                .collect();
            mirror.rows.insert(*t, bits);
        }
        mirrors.insert(w, mirror);
    }
    let mut now = Instant::now();
    let mut forming: Option<Bar> = None;
    let mut ops = BTreeMap::<&str, usize>::new();
    for step in 0..400 {
        let op = rng.below(10);
        let first = f.rows.first().unwrap();
        let name = match op {
            0 | 1 => {
                let mut b = forming.unwrap_or(m.bars[next - 1]);
                let c = b.c.to_f64() + (rng.unit() - 0.5) * 2.0;
                b.c = price(c);
                b.h = price(b.h.to_f64().max(c));
                b.l = price(b.l.to_f64().min(c));
                b.v = Qty::from(b.v.to_f64() as i64 + 1);
                forming = Some(b);
                f.upsert(&CompactBar::from(&b), false);
                if rng.unit() < 0.5 {
                    let sides = Sides {
                        volume: b.v.to_f64(),
                        delta: (rng.unit() * 50.0).round(),
                        delta_high: 60.0,
                        delta_low: -5.0,
                    };
                    f.put_live_flow(b.t.0, sides);
                }
                "forming tick"
            }
            2 => {
                if let Some(b) = forming.take() {
                    f.upsert(&CompactBar::from(&b), true);
                }
                "close"
            }
            3 if next < m.bars.len() => {
                forming = None;
                f.upsert(&CompactBar::from(&m.bars[next]), false);
                next += 1;
                "append"
            }
            4 => {
                let older: Vec<&Bar> = m.bars.iter().filter(|b| b.t.0 < first).collect();
                if older.is_empty() {
                    continue;
                }
                let take = 1 + rng.below(older.len().min(150));
                let page: Vec<Bar> = older[older.len() - take..].iter().map(|b| **b).collect();
                f.put_bars(Span::new(page[0].t.0, first - 1), &compact(&page));
                f.reached_to(Reached::Since(page[0].t.0));
                "prepend"
            }
            5 => {
                let n = f.rows.len();
                let a = rng.below(n);
                let b = (a + 1 + rng.below(20)).min(n);
                let span = Span::new(f.rows.time(a), f.rows.time(b - 1));
                let mut fixed: Vec<Bar> = m
                    .bars
                    .iter()
                    .filter(|x| span.contains(x.t.0))
                    .copied()
                    .collect();
                let at = rng.below(fixed.len().max(1));
                if let Some(x) = fixed.get_mut(at) {
                    x.c = price(x.c.to_f64() + 1.0);
                    x.h = price(x.h.to_f64().max(x.c.to_f64()));
                }
                if fixed.len() > 2 && rng.unit() < 0.3 {
                    fixed.remove(1);
                }
                if b == n && forming.is_some() {
                    forming = None;
                }
                f.put_bars(span, &compact(&fixed));
                "correction"
            }
            6 => {
                match next_ask(&f) {
                    Some(ask) => put_read(&mut f, &ask, read_of(&m, &ask)),
                    None => continue,
                }
                "flow, newest session first"
            }
            7 if f.rows.len() > 700 => {
                f.trim(560);
                "trim"
            }
            8 => {
                now += Duration::from_millis(rng.below(300) as u64);
                for p in f.advance(now) {
                    mirrors.get_mut(&p.watch).unwrap().apply(&p);
                }
                "advance"
            }
            _ => "checkpoint",
        };
        *ops.entry(name).or_default() += 1;
        if name != "checkpoint" && step != 399 {
            continue;
        }
        now += Duration::from_secs(10);
        for p in f.advance(now) {
            mirrors.get_mut(&p.watch).unwrap().apply(&p);
        }
        let n = f.rows.len();
        for (key, study) in &studies {
            assert_eq!(f.entries[key].upto, n, "{key:?} was brought up to date");
            let cached = bits_of(&f.values(key, 0..n).unwrap());
            assert_eq!(
                cached,
                recomputed(&f, key, study),
                "{key:?} after step {step} ({name}) equals a full recompute"
            );
            assert_eq!(
                mirrors[&watch_name(key)].rows,
                cached,
                "{key:?}: the updates sent rebuild the values exactly"
            );
        }
    }
    for op in [
        "forming tick",
        "close",
        "append",
        "prepend",
        "correction",
        "flow, newest session first",
        "trim",
        "advance",
        "checkpoint",
    ] {
        assert!(ops.get(op).is_some_and(|n| *n > 2), "{op} ran: {ops:?}");
    }
}

fn frame_over(m: &Market, from: usize) -> Frame {
    let mut f = Frame::new(grid());
    let bars = &m.bars[from..];
    f.put_bars(
        Span::new(bars[0].t.0, bars[bars.len() - 1].t.0),
        &compact(bars),
    );
    let flows: Vec<(i64, Flow)> = bars
        .iter()
        .zip(&m.flows[from..])
        .map(|(b, fl)| (b.t.0, fl.map_or(Flow::UNKNOWN, Flow::of)))
        .collect();
    f.put_flow(&flows, false);
    f
}

fn prepend(f: &mut Frame, m: &Market, from: usize) {
    let first = f.rows.first().unwrap();
    let older: Vec<Bar> = m.bars[from..]
        .iter()
        .filter(|b| b.t.0 < first)
        .copied()
        .collect();
    f.put_bars(Span::new(older[0].t.0, first - 1), &compact(&older));
    let flows: Vec<(i64, Flow)> = m.bars[from..]
        .iter()
        .zip(&m.flows[from..])
        .filter(|(b, _)| b.t.0 < first)
        .map(|(b, fl)| (b.t.0, fl.map_or(Flow::UNKNOWN, Flow::of)))
        .collect();
    f.put_flow(&flows, false);
}

fn column<'a>(v: &'a Values, key: &str) -> &'a [f64] {
    &v.columns.iter().find(|(k, _)| k == key).unwrap().1
}

#[test]
fn cvd_is_continuous_across_a_prepend_join() {
    let m = market(3, 11, false);
    let day_of = |t: i64| CAL.trade_date(Timestamp(t));
    let starts: Vec<usize> = (0..m.bars.len())
        .filter(|i| *i == 0 || day_of(m.bars[*i].t.0) != day_of(m.bars[*i - 1].t.0))
        .collect();
    assert_eq!(starts.len(), 3);
    let join = starts[1] + 40;
    for reset in ["session", "chart"] {
        let (key, study) = built("delta", json!({ "reset": reset }));
        let mut f = frame_over(&m, join);
        let w = WatchKey(reset.into());
        f.watch(&w, asked("delta"), &key, &study);
        let before = f.snapshot(&w, None).unwrap().this;
        let first_day = f.rows[0].day;
        let partial = f.rows.iter().take_while(|r| r.day == first_day).count();
        let close_before = &before
            .change
            .columns
            .iter()
            .find(|(k, _)| k == "close")
            .unwrap()
            .1;
        assert!(
            close_before[..partial].iter().all(|v| !v.is_nan()),
            "a session held from the chart's first bar counts from there"
        );
        let open_before = &before
            .change
            .columns
            .iter()
            .find(|(k, _)| k == "open")
            .unwrap()
            .1;
        assert_eq!(open_before[0], 0.0);
        prepend(&mut f, &m, 0);
        f.advance(Instant::now());
        let n = f.rows.len();
        let v = f.values(&key, 0..n).unwrap();
        assert_eq!(bits_of(&v), recomputed(&f, &key, &study), "{reset}");
        let j = f.rows.find(m.bars[join].t.0).unwrap();
        let (open, close) = (column(&v, "open"), column(&v, "close"));
        assert_eq!(
            open[j].to_bits(),
            close[j - 1].to_bits(),
            "{reset}: the CVD runs on through the join"
        );
        assert!(!open[j].is_nan());
        let session_start = (0..j).rev().find(|i| f.rows[*i].opens_day).unwrap();
        if reset == "session" {
            assert_eq!(
                open[session_start], 0.0,
                "the join's session counts from its first bar"
            );
            assert!(close[session_start..j].iter().all(|c| !c.is_nan()));
        }
    }
}

#[test]
fn window_studies_change_only_their_warm_up_on_a_prepend() {
    let m = market(4, 5, false);
    let from = m.bars.len() - 400;
    for (kind, inputs) in [
        ("sma", json!({"length": 20})),
        ("wma", json!({"length": 30})),
        ("bollinger", json!({"length": 20})),
        (
            "stochastic",
            json!({"length": 14, "smoothK": 3, "smoothD": 3}),
        ),
        ("volume", json!({"maLength": 50})),
    ] {
        let (key, study) = built(kind, inputs);
        let mut f = frame_over(&m, from);
        let w = WatchKey(kind.into());
        f.watch(&w, asked(kind), &key, &study);
        let before = f.snapshot(&w, None).unwrap().this;
        let warm_up = (0..before.change.time.len())
            .rev()
            .find(|i| before.change.columns.iter().any(|(_, c)| c[*i].is_nan()))
            .map(|i| before.change.time[i])
            .unwrap();
        prepend(&mut f, &m, from - 500);
        let sent = f.advance(Instant::now());
        assert_eq!(sent.len(), 1);
        let Replaced::Span { from: a, to: b } = sent[0].change.replaces else {
            panic!("{kind}: a span")
        };
        assert_eq!(a, f.rows.first().unwrap(), "{kind}: from the new first bar");
        assert_eq!(b, warm_up, "{kind}: through the old warm-up only");

        let mut last = m.bars[m.bars.len() - 1];
        last.c = price(last.c.to_f64() + 0.25);
        last.h = price(last.h.to_f64().max(last.c.to_f64()));
        last.v = Qty::from(last.v.to_f64() as i64 + 3);
        f.upsert(&CompactBar::from(&last), false);
        let sent = f.advance(Instant::now() + Duration::from_secs(1));
        assert_eq!(
            sent[0].change.time,
            [last.t.0],
            "{kind}: a tick sends one bar"
        );
    }
}

fn vwap_of(f: &mut Frame, inputs: Value) -> Values {
    let (key, study) = built("vwap", inputs);
    f.attach(&key, &study);
    let n = f.rows.len();
    f.values(&key, 0..n).unwrap()
}

fn sessions(f: &Frame) -> Vec<std::ops::Range<usize>> {
    let mut out: Vec<std::ops::Range<usize>> = Vec::new();
    for i in 0..f.rows.len() {
        match out.last_mut() {
            Some(r) if f.rows[r.start].day == f.rows[i].day => r.end = i + 1,
            _ => out.push(i..i + 1),
        }
    }
    out
}

fn close_to(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

#[test]
fn the_session_vwap_is_what_each_sessions_prints_work_out_to() {
    let m = market(3, 21, false);
    let start = m
        .bars
        .iter()
        .position(|b| CAL.session(CAL.trade_date(b.t)).unwrap().open == b.t)
        .unwrap();
    let mut f = frame_over(&m, start);
    let v = vwap_of(&mut f, json!({"band1": true, "mult1": 2.0}));
    let (mid, upper, lower2) = (
        column(&v, "vwap"),
        column(&v, "upper1"),
        column(&v, "lower2"),
    );
    assert!(lower2.iter().all(|x| x.is_nan()), "band 2 is off");
    for s in sessions(&f) {
        assert!(f.rows[s.start].opens_day);
        let (mut vol, mut pv, mut pv2) = (0.0, 0.0, 0.0);
        for i in s {
            let p = m.flows[start + i].unwrap().sums;
            vol += p.volume;
            pv += p.pv;
            pv2 += p.pv2;
            let want = pv / vol;
            let sd = (pv2 / vol - want * want).max(0.0).sqrt();
            assert!(close_to(mid[i], want), "bar {i}: {} vs {want}", mid[i]);
            assert!(close_to(upper[i], want + 2.0 * sd), "bar {i}");
        }
    }
}

fn periods(f: &Frame, of: impl Fn(NaiveDate) -> u32) -> Vec<std::ops::Range<usize>> {
    let key = |i: usize| of(CAL.trade_date(Timestamp(f.rows.time(i))));
    let mut out: Vec<std::ops::Range<usize>> = Vec::new();
    for i in 0..f.rows.len() {
        match out.last_mut() {
            Some(r) if key(r.start) == key(i) => r.end = i + 1,
            _ => out.push(i..i + 1),
        }
    }
    out
}

fn session_opens(m: &Market) -> Vec<usize> {
    (0..m.bars.len())
        .filter(|i| CAL.session(CAL.trade_date(m.bars[*i].t)).unwrap().open == m.bars[*i].t)
        .collect()
}

#[test]
fn a_weekly_or_monthly_vwap_runs_over_every_print_of_its_period_and_starts_over_with_the_next() {
    use chrono::Datelike;
    let m = market(30, 25, false);
    let first_of = |from: NaiveDate| {
        m.bars
            .iter()
            .position(|b| CAL.trade_date(b.t) >= from)
            .unwrap()
    };
    let by_week = |d: NaiveDate| d.iso_week().week();
    for (period, from, of) in [
        (
            "week",
            NaiveDate::from_ymd_opt(2026, 9, 28).unwrap(),
            &by_week as &dyn Fn(NaiveDate) -> u32,
        ),
        (
            "month",
            NaiveDate::from_ymd_opt(2026, 9, 1).unwrap(),
            &|d: NaiveDate| d.month(),
        ),
    ] {
        let start = first_of(from);
        let mut f = frame_over(&m, start);
        let v = vwap_of(
            &mut f,
            json!({"period": period, "band1": true, "mult1": 2.0}),
        );
        let (mid, upper) = (column(&v, "vwap"), column(&v, "upper1"));
        let spans = periods(&f, of);
        assert_eq!(spans.len(), 2, "{period}: two of them");
        assert!(
            spans
                .iter()
                .all(|s| sessions(&f).iter().filter(|d| s.contains(&d.start)).count() > 1),
            "{period}: each runs over several sessions"
        );
        for s in spans {
            let (mut vol, mut pv, mut pv2) = (0.0, 0.0, 0.0);
            for i in s {
                let p = m.flows[start + i].unwrap().sums;
                vol += p.volume;
                pv += p.pv;
                pv2 += p.pv2;
                let want = pv / vol;
                let sd = (pv2 / vol - want * want).max(0.0).sqrt();
                assert!(close_to(mid[i], want), "{period} bar {i}");
                assert!(close_to(upper[i], want + 2.0 * sd), "{period} bar {i}");
            }
        }
    }
}

#[test]
fn a_week_not_held_from_its_first_session_has_no_vwap_until_it_is() {
    let m = market(8, 26, false);
    let opens = session_opens(&m);
    let mut f = frame_over(&m, opens[1]);
    let (key, study) = built("vwap", json!({"period": "week"}));
    let w = WatchKey("vwap".into());
    f.watch(&w, asked("vwap"), &key, &study);
    let before = f.snapshot(&w, None).unwrap().this;
    let next_week = opens[5] - opens[1];
    let mid = &before.change.columns[0].1;
    assert!(
        mid[..next_week].iter().all(|x| x.is_nan()),
        "its Monday is not held"
    );
    assert!(mid[next_week..].iter().all(|x| !x.is_nan()));
    let session = vwap_of(&mut f, json!({}));
    assert!(
        column(&session, "vwap").iter().all(|x| !x.is_nan()),
        "each session is held from its open"
    );
    prepend(&mut f, &m, opens[0]);
    let sent = f.advance(Instant::now());
    let Replaced::Span { from, to } = sent[0].change.replaces else {
        panic!("a span")
    };
    assert_eq!(
        (from, to),
        (m.bars[opens[0]].t.0, m.bars[opens[5] - 1].t.0),
        "that week only"
    );
    assert!(sent[0].change.columns[0].1.iter().all(|x| !x.is_nan()));
}

#[test]
fn a_session_short_of_a_bars_prints_is_weighed_by_typical_price() {
    let m = market(2, 22, false);
    let first_open = |f: &Frame| (0..f.rows.len()).find(|i| f.rows[*i].opens_day).unwrap();
    let start = m
        .bars
        .iter()
        .position(|b| CAL.session(CAL.trade_date(b.t)).unwrap().open == b.t)
        .unwrap();
    let mut f = frame_over(&m, start);
    let all = sessions(&f);
    assert_eq!(all.len(), 2);
    let gap = all[0].start + 7;
    f.put_flow(&[(f.rows.time(gap), Flow::UNKNOWN)], false);
    let v = vwap_of(&mut f, json!({}));
    let mid = column(&v, "vwap");
    let (mut vol, mut pv) = (0.0, 0.0);
    for i in all[0].clone() {
        let r = &f.rows[i];
        let typical = (r.high + r.low + r.close) / 3.0;
        vol += r.volume;
        pv += typical * r.volume;
        assert!(
            close_to(mid[i], pv / vol),
            "bar {i} weighs its typical price"
        );
    }
    let first = all[1].start;
    assert_eq!(first_open(&f), 0);
    let p = m.flows[start + first].unwrap().sums;
    assert!(
        close_to(mid[first], p.pv / p.volume),
        "the next session is measured again"
    );
}

#[test]
fn a_session_not_held_from_its_open_has_no_vwap_until_it_is() {
    let m = market(3, 23, false);
    let opens: Vec<usize> = (0..m.bars.len())
        .filter(|i| CAL.session(CAL.trade_date(m.bars[*i].t)).unwrap().open == m.bars[*i].t)
        .collect();
    let mut f = frame_over(&m, opens[1] + 30);
    let (key, study) = built("vwap", json!({}));
    let w = WatchKey("vwap".into());
    f.watch(&w, asked("vwap"), &key, &study);
    let before = f.snapshot(&w, None).unwrap().this;
    let partial = opens[2] - opens[1] - 30;
    let mid = &before.change.columns[0].1;
    assert!(
        mid[..partial].iter().all(|x| x.is_nan()),
        "its open is not held"
    );
    assert!(mid[partial..].iter().all(|x| !x.is_nan()));
    prepend(&mut f, &m, opens[1]);
    let sent = f.advance(Instant::now());
    let Replaced::Span { from, to } = sent[0].change.replaces else {
        panic!("a span")
    };
    assert_eq!(
        (from, to),
        (m.bars[opens[1]].t.0, m.bars[opens[2] - 1].t.0),
        "that session only"
    );
    assert!(sent[0].change.columns[0].1.iter().all(|x| !x.is_nan()));
}

#[test]
fn the_forming_bar_weighs_nothing_until_its_prints_are_read() {
    let m = market(2, 24, false);
    let open = m
        .bars
        .iter()
        .position(|b| CAL.session(CAL.trade_date(b.t)).unwrap().open == b.t)
        .unwrap();
    let held = m.bars.len() - 1;
    let mut f = Frame::new(grid());
    let bars = compact(&m.bars[open..held]);
    f.put_bars(Span::new(bars[0].0, bars[bars.len() - 1].0), &bars);
    let flows: Vec<(i64, Flow)> = (open..held)
        .map(|i| (m.bars[i].t.0, Flow::of(m.flows[i].unwrap())))
        .collect();
    f.put_flow(&flows, false);
    let n = f.rows.len();
    f.upsert(&CompactBar::from(&m.bars[held]), false);
    assert_eq!(f.rows[n].day, f.rows[n - 1].day, "the same session");
    let v = vwap_of(&mut f, json!({}));
    let mid = column(&v, "vwap").to_vec();
    assert_eq!(
        mid[n].to_bits(),
        mid[n - 1].to_bits(),
        "the new bar has no prints yet"
    );
    let mut read = m.flows[held].unwrap();
    read.sums = PrintSums {
        volume: 10.0,
        pv: 10.0 * (mid[n - 1] + 40.0),
        pv2: 10.0 * (mid[n - 1] + 40.0).powi(2),
    };
    let ask = FlowAsk {
        day: f.rows[n].day as i64,
        edit: f.flow.edits,
        opens: vec![Timestamp(f.rows.time(n))],
        pulls: false,
    };
    let flows = FlowRead {
        bars: vec![Some(read)],
        ..FlowRead::default()
    };
    f.put_flow_tail(&ask, &flows);
    let v = vwap_of(&mut f, json!({}));
    assert!(
        column(&v, "vwap")[n] > mid[n - 1],
        "its prints count once read"
    );
}

const LAST_CLOSE_LABEL: &str = "export const indicator = { plots: ['c'] };\nexport function compute(bars) {\n  const n = bars.length;\n  draw.label(bars.time[n - 1], bars.close[n - 1], 'last');\n  return { c: bars.close };\n}\n";

#[test]
fn a_watcher_that_joins_late_is_kept_as_right_as_the_others() {
    let m = market(2, 31, false);
    let mut f = frame_over(&m, m.bars.len() - 200);
    let key = StudyKey {
        id: StudyId::Custom {
            id: "ci_label".into(),
            version: 1,
        },
        params: String::new(),
    };
    let study: Arc<dyn Study> = Arc::new(ScriptStudy::new(
        LAST_CLOSE_LABEL,
        serde_json::Map::new(),
        vec!["c".to_owned()],
    ));
    let (a, b) = (WatchKey("a".into()), WatchKey("b".into()));
    let label = |p: &Published| p.change.drawn.as_ref().map(|d| d.objects.labels[0].price);
    let mut held: HashMap<WatchKey, Option<f64>> = HashMap::new();
    f.watch(&a, asked("ci_label"), &key, &study);
    held.insert(a.clone(), label(&f.snapshot(&a, None).unwrap().this));
    let last = m.bars[m.bars.len() - 1];
    let moved = |c: f64| {
        let mut bar = last;
        bar.c = price(c);
        bar.h = price(bar.h.to_f64().max(c));
        bar.l = price(bar.l.to_f64().min(c));
        CompactBar::from(&bar)
    };
    f.upsert(&moved(last.c.to_f64() + 5.0), false);
    f.watch(&b, asked("ci_label"), &key, &study);
    let joined = f.snapshot(&b, None).unwrap();
    held.insert(b.clone(), label(&joined.this));
    for p in &joined.others {
        if let Some(price) = label(p) {
            held.insert(p.watch.clone(), Some(price));
        }
    }
    f.upsert(&moved(last.c.to_f64()), false);
    for p in f.advance(Instant::now() + Duration::from_secs(10)) {
        if let Some(price) = label(&p) {
            held.insert(p.watch.clone(), Some(price));
        }
    }
    let now = Some(f.rows[f.rows.len() - 1].close);
    assert_eq!(
        held[&a], now,
        "the first watcher's label sits on the last close"
    );
    assert_eq!(held[&b], now, "so does the late one's");
}

#[test]
fn a_bar_put_back_at_the_end_of_a_session_resends_that_whole_session() {
    let m = market(2, 32, false);
    let opens: Vec<usize> = (0..m.bars.len())
        .filter(|i| CAL.session(CAL.trade_date(m.bars[*i].t)).unwrap().open == m.bars[*i].t)
        .collect();
    let missing = opens[1] - 1;
    let mut f = Frame::new(grid());
    let held: Vec<usize> = (0..m.bars.len()).filter(|i| *i != missing).collect();
    let bars: Vec<CompactBar> = held.iter().map(|i| CompactBar::from(&m.bars[*i])).collect();
    f.put_bars(Span::new(bars[0].0, bars[bars.len() - 1].0), &bars);
    let flows: Vec<(i64, Flow)> = held
        .iter()
        .map(|i| (m.bars[*i].t.0, Flow::of(m.flows[*i].unwrap())))
        .collect();
    f.put_flow(&flows, false);
    let (key, study) = built("vwap", json!({}));
    let w = WatchKey("vwap".into());
    f.watch(&w, asked("vwap"), &key, &study);
    let snap = f.snapshot(&w, None).unwrap().this;
    let mut mirror = Mirror {
        rev: snap.rev,
        ..Mirror::default()
    };
    for (i, t) in snap.change.time.iter().enumerate() {
        let bits = snap
            .change
            .columns
            .iter()
            .map(|(_, c)| c[i].to_bits())
            .collect();
        mirror.rows.insert(*t, bits);
    }
    let back = CompactBar::from(&m.bars[missing]);
    f.put_bars(Span::new(back.0, back.0), &[back]);
    for p in f.advance(Instant::now()) {
        mirror.apply(&p);
    }
    let n = f.rows.len();
    let now = bits_of(&f.values(&key, 0..n).unwrap());
    let first = f.rows.time(0);
    assert_ne!(
        snap.change.columns[0].1[0].to_bits(),
        now[&first][0],
        "the session's first bar changed: it is now weighed by typical price"
    );
    assert_eq!(
        mirror.rows, now,
        "the session the bar belongs to is resent whole"
    );
}

#[test]
fn a_frame_weighs_what_its_scripts_drew_and_printed() {
    let m = market(1, 33, false);
    let script = |code: &str| -> (StudyKey, Arc<dyn Study>) {
        let key = StudyKey {
            id: StudyId::Custom {
                id: "ci_heavy".into(),
                version: 1,
            },
            params: code.len().to_string(),
        };
        let study: Arc<dyn Study> = Arc::new(ScriptStudy::new(
            code,
            serde_json::Map::new(),
            vec!["c".to_owned()],
        ));
        (key, study)
    };
    let quiet = "export const indicator = { plots: ['c'] };\nexport function compute(bars) {\n  return { c: bars.close };\n}\n";
    let busy = "export const indicator = { plots: ['c'] };\nexport function compute(bars) {\n  for (let i = 0; i < bars.length; i++) {\n    draw.label(bars.time[i], bars.close[i], 'a label carrying some text ' + i);\n  }\n  console.log('x'.repeat(60000));\n  return { c: bars.close };\n}\n";
    let weigh = |code: &str| {
        let mut f = frame_over(&m, 0);
        let (key, study) = script(code);
        f.attach(&key, &study);
        let n = f.rows.len();
        f.values(&key, 0..n).unwrap();
        f.bytes()
    };
    let (light, heavy) = (weigh(quiet), weigh(busy));
    assert!(
        heavy >= light + 60_000 + 200 * 26,
        "{heavy} bytes against {light}: the logs and the labels count"
    );
}

#[test]
fn a_read_never_puts_back_bars_older_than_the_live_feed_gave_since_it_began() {
    let m = market(1, 34, false);
    let n = m.bars.len();
    let mut f = Frame::new(grid());
    f.reset("mock".into());
    let bars = compact(&m.bars[..n - 1]);
    f.put_bars(Span::new(bars[0].0, i64::MAX), &bars);
    let mut forming = m.bars[n - 2];
    forming.c = price(forming.c.to_f64() - 3.0);
    let read_began = f.mark();
    let mut closed = m.bars[n - 2];
    closed.v = Qty::from(closed.v.to_f64() as i64 + 7);
    f.upsert(&CompactBar::from(&closed), true);
    f.upsert(&CompactBar::from(&m.bars[n - 1]), false);
    let mut older = compact(&m.bars[n - 40..n - 2]);
    older.push(CompactBar::from(&forming));
    f.put_read(Span::new(older[0].0, i64::MAX), &older, &read_began);
    assert_eq!(f.rows.len(), n, "the bar the feed opened stays");
    let at = f.rows.find(closed.t.0).unwrap();
    assert_eq!(
        f.rows[at].volume,
        closed.v.to_f64(),
        "the closed bar stays closed"
    );
    assert_eq!(f.rows[at].close, closed.c.to_f64());
}

#[test]
fn a_read_begun_before_a_reset_puts_nothing() {
    let m = market(1, 35, false);
    let mut f = Frame::new(grid());
    f.reset("first".into());
    let read_began = f.mark();
    f.reset("second".into());
    let bars = compact(&m.bars);
    f.put_read(Span::new(bars[0].0, i64::MAX), &bars, &read_began);
    assert!(f.rows.is_empty(), "the first connection's bars stay out");
}

fn cvd_snapshot(f: &mut Frame, key: &StudyKey, study: &Arc<dyn Study>) -> (Vec<f64>, Vec<f64>) {
    let w = WatchKey("cvd".into());
    f.watch(&w, asked("delta"), key, study);
    let snap = f.snapshot(&w, None).unwrap().this;
    let col = |k: &str| {
        snap.change
            .columns
            .iter()
            .find(|(c, _)| c == k)
            .unwrap()
            .1
            .clone()
    };
    (col("open"), col("close"))
}

fn known_except(m: &Market, unknown: std::ops::Range<usize>) -> Frame {
    let mut f = Frame::new(grid());
    let bars = compact(&m.bars);
    f.put_bars(Span::new(bars[0].0, i64::MAX), &bars);
    let ask = FlowAsk {
        day: f.rows[m.bars.len() - 1].day as i64,
        edit: f.flow.edits,
        opens: m.bars.iter().map(|b| b.t).collect(),
        pulls: true,
    };
    let read = FlowRead {
        bars: (0..m.bars.len())
            .map(|i| (!unknown.contains(&i)).then(|| m.flows[i].unwrap()))
            .collect(),
        ..FlowRead::default()
    };
    put_read(&mut f, &ask, read);
    f
}

#[test]
fn each_session_counts_its_cvd_from_its_first_known_bar() {
    let m = market(2, 36, false);
    let opens: Vec<usize> = (0..m.bars.len())
        .filter(|i| CAL.session(CAL.trade_date(m.bars[*i].t)).unwrap().open == m.bars[*i].t)
        .collect();
    let recorded = opens[1] + 90;
    let (key, study) = built("delta", json!({"reset": "session"}));
    let mut f = known_except(&m, opens[1]..recorded);
    let (open, close) = cvd_snapshot(&mut f, &key, &study);
    assert!(
        close[opens[1]..recorded].iter().all(|v| v.is_nan()),
        "a bar with no known prints has no CVD"
    );
    assert_eq!(open[recorded], 0.0, "it counts from the first bar it knows");
    let mut total = 0.0;
    for (i, (cvd, flow)) in close.iter().zip(&m.flows).enumerate().skip(recorded) {
        total += flow.unwrap().sides.delta;
        assert_eq!(*cvd, total, "bar {i}");
    }
    assert_eq!(open[0], 0.0, "the session before counts from its open");
    let n = f.rows.len();
    assert_eq!(
        bits_of(&f.values(&key, 0..n).unwrap()),
        recomputed(&f, &key, &study),
        "and equals a full recompute"
    );
}

#[test]
fn a_hole_in_a_session_leaves_its_bars_without_cvd_and_carries_the_total_past_it() {
    let m = market(2, 36, false);
    let opens: Vec<usize> = (0..m.bars.len())
        .filter(|i| CAL.session(CAL.trade_date(m.bars[*i].t)).unwrap().open == m.bars[*i].t)
        .collect();
    let hole = opens[1] + 20..opens[1] + 50;
    let (key, study) = built("delta", json!({"reset": "session"}));
    let mut f = known_except(&m, hole.clone());
    let (_, close) = cvd_snapshot(&mut f, &key, &study);
    let mut total = 0.0;
    for (i, (cvd, flow)) in close.iter().zip(&m.flows).enumerate().skip(opens[1]) {
        if hole.contains(&i) {
            assert!(cvd.is_nan(), "bar {i} in the hole");
            continue;
        }
        total += flow.unwrap().sides.delta;
        assert_eq!(*cvd, total, "bar {i}");
    }
}

#[test]
fn a_read_session_reads_again_exactly_the_bars_put_in_or_changed_since() {
    let m = market(3, 41, false);
    let opens: Vec<usize> = (0..m.bars.len())
        .filter(|i| CAL.session(CAL.trade_date(m.bars[*i].t)).unwrap().open == m.bars[*i].t)
        .collect();
    let mut f = Frame::new(grid());
    let bars = compact(&m.bars);
    f.put_bars(Span::new(bars[0].0, i64::MAX), &bars);
    let (key, study) = built("delta", json!({"reset": "session"}));
    f.watch(&WatchKey("cvd".into()), asked("delta"), &key, &study);
    let read_all = |f: &mut Frame| {
        while let Some(ask) = next_ask(f) {
            put_read(f, &ask, read_of(&m, &ask));
        }
    };
    let due = |f: &Frame| next_ask(f).map(|a| a.opens);
    read_all(&mut f);
    assert_eq!(due(&f), None);

    let changed = opens[1] + 30;
    let mut fixed = bars[changed];
    fixed.5 += 1.0;
    f.put_bars(Span::new(fixed.0, fixed.0), &[fixed]);
    let ask = next_ask(&f).unwrap();
    assert_eq!(ask.opens, vec![m.bars[changed].t], "the changed bar alone");
    fixed.5 += 1.0;
    f.put_bars(Span::new(fixed.0, fixed.0), &[fixed]);
    put_read(&mut f, &ask, read_of(&m, &ask));
    assert_eq!(
        due(&f),
        Some(vec![m.bars[changed].t]),
        "a read asked before the bar changed again leaves it due"
    );
    read_all(&mut f);

    let gone = opens[1] + 60;
    f.put_bars(Span::new(bars[gone].0, bars[gone].0), &[]);
    assert_eq!(due(&f), None, "a bar taken out has no prints to read");
    f.put_bars(Span::new(bars[gone].0, bars[gone].0), &bars[gone..=gone]);
    assert_eq!(
        due(&f),
        Some(vec![m.bars[gone].t]),
        "the bar put back alone"
    );
    read_all(&mut f);

    let cut = opens[1] + 40;
    f.trim(m.bars.len() - cut);
    assert_eq!(f.rows.first(), Some(m.bars[cut].t.0));
    f.put_bars(
        Span::new(m.bars[opens[1]].t.0, m.bars[cut].t.0 - 1),
        &bars[opens[1]..cut],
    );
    assert_eq!(
        due(&f),
        Some(m.bars[opens[1]..cut].iter().map(|b| b.t).collect()),
        "a trimmed session's front, reached back"
    );
    read_all(&mut f);
    assert!(f.rows.iter().all(|r| r.flow.known()));
    let n = f.rows.len();
    assert_eq!(
        bits_of(&f.values(&key, 0..n).unwrap()),
        recomputed(&f, &key, &study)
    );
}

#[test]
fn a_bar_read_again_after_a_sessions_gap_keeps_the_gap() {
    let m = market(2, 36, false);
    let opens: Vec<usize> = (0..m.bars.len())
        .filter(|i| CAL.session(CAL.trade_date(m.bars[*i].t)).unwrap().open == m.bars[*i].t)
        .collect();
    let recorded = opens[1] + 90;
    let mut f = Frame::new(grid());
    let bars = compact(&m.bars);
    f.put_bars(Span::new(bars[0].0, i64::MAX), &bars);
    let (key, study) = built("delta", json!({"reset": "session"}));
    f.watch(&WatchKey("cvd".into()), asked("delta"), &key, &study);
    while let Some(ask) = next_ask(&f) {
        let mut read = read_of(&m, &ask);
        if ask.opens[0] <= m.bars[opens[1]].t {
            for (t, bar) in ask.opens.iter().zip(&mut read.bars) {
                if *t < m.bars[recorded].t {
                    *bar = None;
                }
            }
        }
        put_read(&mut f, &ask, read);
    }
    let cvd = |f: &mut Frame| {
        let n = f.rows.len();
        column(&f.values(&key, 0..n).unwrap(), "close").to_vec()
    };
    let gapped = cvd(&mut f);
    assert_eq!(gapped[recorded], m.flows[recorded].unwrap().sides.delta);
    let mut fixed = bars[recorded + 30];
    fixed.5 += 1.0;
    f.put_bars(Span::new(fixed.0, fixed.0), &[fixed]);
    let ask = next_ask(&f).unwrap();
    assert_eq!(ask.opens, vec![m.bars[recorded + 30].t]);
    put_read(&mut f, &ask, read_of(&m, &ask));
    f.advance(Instant::now());
    assert_eq!(
        cvd(&mut f)[recorded..]
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        gapped[recorded..]
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        "the session still counts from the bar its prints are known from"
    );
}
