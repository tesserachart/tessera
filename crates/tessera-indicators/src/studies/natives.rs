use serde_json::{Map, Value};
use tessera_protocol::indicators::PriceSource;
use tessera_script::ScriptError;

use super::{Drawn, Study, columns};
use crate::frame::Rows;

const NAN: f64 = f64::NAN;

pub(crate) struct Inputs<'a>(pub &'a Map<String, Value>);

impl Inputs<'_> {
    pub fn num(&self, key: &str, fallback: f64) -> f64 {
        self.0
            .get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(fallback)
    }

    pub fn len(&self, key: &str, fallback: f64, min: usize) -> usize {
        (self.num(key, fallback).round().max(min as f64)) as usize
    }

    pub fn flag(&self, key: &str, fallback: bool) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(fallback)
    }

    pub fn text(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn source(&self, fallback: PriceSource) -> PriceSource {
        self.0
            .get("source")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or(fallback)
    }
}

pub(crate) fn window_mean(x: impl Fn(usize) -> f64, i: usize, n: usize) -> f64 {
    if i + 1 < n {
        return NAN;
    }
    (i + 1 - n..=i).map(x).sum::<f64>() / n as f64
}

fn window_wma(x: impl Fn(usize) -> f64, i: usize, n: usize) -> f64 {
    if i + 1 < n {
        return NAN;
    }
    let s: f64 = (0..n).map(|k| (n - k) as f64 * x(i - k)).sum();
    s / ((n * (n + 1)) as f64 / 2.0)
}

fn smooth_step(x: impl Fn(usize) -> f64, prev: f64, i: usize, n: usize, alpha: f64) -> f64 {
    let v = x(i);
    if v.is_nan() {
        return NAN;
    }
    if prev.is_nan() {
        return window_mean(x, i, n);
    }
    alpha * v + (1.0 - alpha) * prev
}

fn before(col: &[f64], i: usize) -> f64 {
    if i > 0 { col[i - 1] } else { NAN }
}

#[derive(Debug)]
pub(crate) struct Sma {
    columns: Vec<String>,
    source: PriceSource,
    n: usize,
}

impl Sma {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["ma"]),
            source: i.source(PriceSource::Close),
            n: i.len("length", 20.0, 1),
        }
    }
}

impl Study for Sma {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        for (i, ma) in cols[0].iter_mut().enumerate().skip(from) {
            *ma = window_mean(|k| rows[k].price(self.source), i, self.n);
        }
        Ok(None)
    }
}

#[derive(Debug)]
pub(crate) struct Ema {
    columns: Vec<String>,
    source: PriceSource,
    n: usize,
}

impl Ema {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["ma"]),
            source: i.source(PriceSource::Close),
            n: i.len("length", 9.0, 1),
        }
    }
}

impl Study for Ema {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let alpha = 2.0 / (self.n as f64 + 1.0);
        for i in from..rows.len() {
            let prev = before(&cols[0], i);
            cols[0][i] = smooth_step(|k| rows[k].price(self.source), prev, i, self.n, alpha);
        }
        Ok(None)
    }
}

#[derive(Debug)]
pub(crate) struct Wma {
    columns: Vec<String>,
    source: PriceSource,
    n: usize,
}

impl Wma {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["ma"]),
            source: i.source(PriceSource::Close),
            n: i.len("length", 20.0, 1),
        }
    }
}

impl Study for Wma {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        for (i, ma) in cols[0].iter_mut().enumerate().skip(from) {
            *ma = window_wma(|k| rows[k].price(self.source), i, self.n);
        }
        Ok(None)
    }
}

#[derive(Debug)]
pub(crate) struct Volume {
    columns: Vec<String>,
    n: usize,
}

impl Volume {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["volume", "ma"]),
            n: i.len("maLength", 20.0, 1),
        }
    }
}

impl Study for Volume {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        for i in from..rows.len() {
            cols[0][i] = rows[i].volume;
            cols[1][i] = window_mean(|k| rows[k].volume, i, self.n);
        }
        Ok(None)
    }
}

#[derive(Debug)]
pub(crate) struct Rsi {
    columns: Vec<String>,
    source: PriceSource,
    n: usize,
}

impl Rsi {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["rsi"]),
            source: i.source(PriceSource::Close),
            n: i.len("length", 14.0, 2),
        }
    }
}

impl Study for Rsi {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn state(&self) -> usize {
        2
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let (gain, loss) = (1, 2);
        let n = self.n;
        let x = |k: usize| rows[k].price(self.source);
        let up = |k: usize| {
            if k < 1 {
                NAN
            } else {
                (x(k) - x(k - 1)).max(0.0)
            }
        };
        let down = |k: usize| {
            if k < 1 {
                NAN
            } else {
                (x(k - 1) - x(k)).max(0.0)
            }
        };
        let alpha = 1.0 / n as f64;
        for i in from..rows.len() {
            let g = if i >= n {
                smooth_step(up, before(&cols[gain], i), i, n, alpha)
            } else {
                NAN
            };
            let l = if i >= n {
                smooth_step(down, before(&cols[loss], i), i, n, alpha)
            } else {
                NAN
            };
            cols[gain][i] = g;
            cols[loss][i] = l;
            cols[0][i] = if g.is_nan() || l.is_nan() {
                NAN
            } else if l == 0.0 {
                100.0
            } else if g == 0.0 {
                0.0
            } else {
                100.0 - 100.0 / (1.0 + g / l)
            };
        }
        Ok(None)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Smoothing {
    Rma,
    Sma,
    Ema,
    Wma,
}

#[derive(Debug)]
pub(crate) struct Atr {
    columns: Vec<String>,
    n: usize,
    smoothing: Smoothing,
}

impl Atr {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["atr"]),
            n: i.len("length", 14.0, 1),
            smoothing: match i.text("smoothing") {
                Some("sma") => Smoothing::Sma,
                Some("ema") => Smoothing::Ema,
                Some("wma") => Smoothing::Wma,
                _ => Smoothing::Rma,
            },
        }
    }
}

fn true_range(rows: &Rows, i: usize) -> f64 {
    let (h, l) = (rows[i].high, rows[i].low);
    if i == 0 {
        return h - l;
    }
    let pc = rows[i - 1].close;
    (h - l).max((h - pc).abs()).max((l - pc).abs())
}

impl Study for Atr {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let n = self.n;
        let tr = |k: usize| true_range(rows, k);
        for i in from..rows.len() {
            let prev = before(&cols[0], i);
            cols[0][i] = match self.smoothing {
                Smoothing::Sma => window_mean(tr, i, n),
                Smoothing::Ema => smooth_step(tr, prev, i, n, 2.0 / (n as f64 + 1.0)),
                Smoothing::Wma => window_wma(tr, i, n),
                Smoothing::Rma => smooth_step(tr, prev, i, n, 1.0 / n as f64),
            };
        }
        Ok(None)
    }
}

#[derive(Debug)]
pub(crate) struct Bollinger {
    columns: Vec<String>,
    source: PriceSource,
    n: usize,
    k: f64,
}

impl Bollinger {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["basis", "upper", "lower"]),
            source: i.source(PriceSource::Close),
            n: i.len("length", 20.0, 2),
            k: i.num("mult", 2.0),
        }
    }
}

impl Study for Bollinger {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let n = self.n;
        let x = |k: usize| rows[k].price(self.source);
        for i in from..rows.len() {
            let (mean, sd) = if i + 1 < n {
                (NAN, NAN)
            } else {
                let mean = window_mean(x, i, n);
                let ss: f64 = (i + 1 - n..=i).map(|j| (x(j) - mean).powi(2)).sum();
                (mean, (ss / n as f64).sqrt())
            };
            let band = [mean, mean + self.k * sd, mean - self.k * sd];
            for (col, v) in cols.iter_mut().zip(band) {
                col[i] = v;
            }
        }
        Ok(None)
    }
}

#[derive(Debug)]
pub(crate) struct Macd {
    columns: Vec<String>,
    source: PriceSource,
    fast: usize,
    slow: usize,
    signal: usize,
}

impl Macd {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["hist", "macd", "signal"]),
            source: i.source(PriceSource::Close),
            fast: i.len("fast", 12.0, 1),
            slow: i.len("slow", 26.0, 1),
            signal: i.len("signal", 9.0, 1),
        }
    }
}

impl Study for Macd {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn state(&self) -> usize {
        2
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let (hist, macd, signal, fast, slow) = (0, 1, 2, 3, 4);
        let x = |k: usize| rows[k].price(self.source);
        let alpha = |n: usize| 2.0 / (n as f64 + 1.0);
        for i in from..rows.len() {
            let f = smooth_step(x, before(&cols[fast], i), i, self.fast, alpha(self.fast));
            let s = smooth_step(x, before(&cols[slow], i), i, self.slow, alpha(self.slow));
            cols[fast][i] = f;
            cols[slow][i] = s;
            cols[macd][i] = f - s;
            let m = &cols[macd];
            let sig = smooth_step(
                |k| m[k],
                before(&cols[signal], i),
                i,
                self.signal,
                alpha(self.signal),
            );
            cols[signal][i] = sig;
            cols[hist][i] = cols[macd][i] - sig;
        }
        Ok(None)
    }
}

#[derive(Debug)]
pub(crate) struct Stochastic {
    columns: Vec<String>,
    n: usize,
    smooth_k: usize,
    smooth_d: usize,
}

impl Stochastic {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["k", "d"]),
            n: i.len("length", 14.0, 1),
            smooth_k: i.len("smoothK", 1.0, 1),
            smooth_d: i.len("smoothD", 3.0, 1),
        }
    }
}

impl Study for Stochastic {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn state(&self) -> usize {
        1
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let (k, d, raw) = (0, 1, 2);
        let n = self.n;
        for i in from..rows.len() {
            cols[raw][i] = if i + 1 < n {
                NAN
            } else {
                let window = i + 1 - n..=i;
                let hh = window
                    .clone()
                    .map(|j| rows[j].high)
                    .fold(f64::NEG_INFINITY, f64::max);
                let ll = window.map(|j| rows[j].low).fold(f64::INFINITY, f64::min);
                if hh > ll {
                    100.0 * (rows[i].close - ll) / (hh - ll)
                } else {
                    NAN
                }
            };
            let r = &cols[raw];
            let kv = window_mean(|j| r[j], i, self.smooth_k);
            cols[k][i] = kv;
            let kc = &cols[k];
            cols[d][i] = window_mean(|j| kc[j], i, self.smooth_d);
        }
        Ok(None)
    }
}
