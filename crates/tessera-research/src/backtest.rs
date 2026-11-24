use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::stats::wilson_interval;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Bars {
    pub time: Vec<i64>,
    pub open: Vec<f64>,
    pub high: Vec<f64>,
    pub low: Vec<f64>,
    pub close: Vec<f64>,
}

impl Bars {
    pub fn len(&self) -> usize {
        self.time.len()
    }

    pub fn is_empty(&self) -> bool {
        self.time.is_empty()
    }

    fn check(&self) -> Result<(), String> {
        let n = self.time.len();
        if [
            self.open.len(),
            self.high.len(),
            self.low.len(),
            self.close.len(),
        ]
        .iter()
        .any(|l| *l != n)
        {
            return Err("bars have columns of different lengths".into());
        }
        if self.time.windows(2).any(|w| w[1] <= w[0]) {
            return Err("bar times must increase".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Signals {
    pub position: Vec<f64>,
    pub stop_distance: Vec<f64>,
    pub target_distance: Vec<f64>,
}

impl Signals {
    pub fn positions(position: Vec<f64>) -> Self {
        Self {
            position,
            ..Self::default()
        }
    }

    fn check(&self, n: usize) -> Result<(), String> {
        if self.position.len() != n {
            return Err(format!(
                "the strategy gave {} targets for {} bars",
                self.position.len(),
                n
            ));
        }
        for (what, v) in [
            ("stop distances", &self.stop_distance),
            ("target distances", &self.target_distance),
        ] {
            if !v.is_empty() && v.len() != n {
                return Err(format!("the strategy gave {} {what} for {n} bars", v.len()));
            }
        }
        Ok(())
    }

    pub(crate) fn distance(v: &[f64], at: usize) -> Option<f64> {
        v.get(at).copied().filter(|d| d.is_finite() && *d > 0.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Extreme {
    High(f64),
    Low(f64),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BarPaths(pub Vec<Option<Vec<Extreme>>>);

impl BarPaths {
    pub fn path(prices: impl IntoIterator<Item = f64>) -> Vec<Extreme> {
        let mut out = Vec::new();
        let (mut high, mut low) = (f64::NEG_INFINITY, f64::INFINITY);
        for p in prices {
            if p < low {
                low = p;
                out.push(Extreme::Low(p));
            }
            if p > high {
                high = p;
                out.push(Extreme::High(p));
            }
        }
        out
    }

    fn at(&self, i: usize) -> Option<&[Extreme]> {
        self.0.get(i)?.as_deref()
    }
}

fn first_on(
    path: &[Extreme],
    side: f64,
    stop: Option<f64>,
    target: Option<f64>,
) -> Option<(f64, ExitReason)> {
    for e in path {
        let (p, up) = match *e {
            Extreme::High(p) => (p, true),
            Extreme::Low(p) => (p, false),
        };
        let adverse = (side > 0.0) != up;
        if adverse
            && let Some(s) = stop
            && side * (p - s) <= 0.0
        {
            return Some((p, ExitReason::Stop));
        }
        if !adverse
            && let Some(t) = target
            && side * (p - t) >= 0.0
        {
            return Some((t, ExitReason::Target));
        }
    }
    None
}

/// How a run trades: the contract's arithmetic, costs and an optional bracket.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BacktestConfig {
    /// The contract's tick (`0.25` on NQ).
    pub tick: f64,
    /// Money per 1.0 of price for one contract (`20` on NQ).
    pub point_value: f64,
    /// Commission per contract per side.
    #[serde(default)]
    pub commission_per_contract: f64,
    /// Adverse ticks paid on every fill.
    #[serde(default)]
    pub slippage_ticks: f64,
    /// A protective stop this many ticks from each entry's fill.
    #[serde(default)]
    pub stop_ticks: Option<f64>,
    /// A target this many ticks from each entry's fill.
    #[serde(default)]
    pub target_ticks: Option<f64>,
    /// Starting equity, for the curve and the drawdown in percent.
    #[serde(default = "default_equity")]
    pub initial_equity: f64,
}

fn default_equity() -> f64 {
    100_000.0
}

/// Why a trade ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[ts(rename = "BacktestExitReason")]
pub enum ExitReason {
    /// The strategy's target position changed.
    Signal,
    /// The bracket's stop.
    Stop,
    /// The bracket's target.
    Target,
    /// The data ended with the position open (closed at the last close).
    EndOfData,
}

/// One round trip.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "BacktestTrade")]
pub struct Trade {
    /// Contracts, positive long, negative short.
    pub qty: f64,
    /// The entry bar's open time.
    #[ts(type = "number")]
    pub entry_time: i64,
    /// The entry's fill, slippage included.
    pub entry_price: f64,
    /// The exit bar's open time.
    #[ts(type = "number")]
    pub exit_time: i64,
    /// The exit's fill, slippage included.
    pub exit_price: f64,
    /// Net of costs.
    pub pnl: f64,
    /// Commission and slippage paid.
    pub costs: f64,
    /// Bars from the entry bar to the exit bar.
    pub bars: u32,
    /// Most adverse excursion while open, in money (≤ 0).
    pub mae: f64,
    /// Most favourable excursion while open, in money (≥ 0).
    pub mfe: f64,
    /// Why it ended.
    pub exit: ExitReason,
    /// Its stop, as placed at the entry.
    #[serde(default)]
    pub stop: Option<f64>,
    /// Its target, the same.
    #[serde(default)]
    pub target: Option<f64>,
    /// Its stop or target exit was found on the bar's high and low because the session has no
    /// saved prints: which of the two came first in that bar, and the fill, are approximate.
    #[serde(default)]
    pub approximate: bool,
}

/// A point of the equity curve: at a bar's close.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "BacktestEquityPoint")]
pub struct EquityPoint {
    /// The bar's open time.
    #[ts(type = "number")]
    pub time: i64,
    /// Starting equity plus realized and open P&L at the bar's close.
    pub equity: f64,
}

/// What a run measured.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "BacktestMetrics")]
pub struct Metrics {
    /// Round trips.
    pub trades: u32,
    /// Trades with a positive net P&L.
    pub wins: u32,
    /// Trades with a net P&L of zero or less.
    pub losses: u32,
    /// Fraction of trades with a positive net P&L.
    pub win_rate: Option<f64>,
    /// Wilson 95% interval of the win rate.
    pub win_rate_ci: Option<(f64, f64)>,
    /// The sum of every trade's net P&L.
    pub net_pnl: f64,
    /// Mean net P&L per trade.
    pub avg_trade: Option<f64>,
    /// Normal 95% interval of the mean trade (None under 2 trades).
    pub avg_trade_ci: Option<(f64, f64)>,
    /// Mean of the winning trades.
    pub avg_win: Option<f64>,
    /// Mean of the losing trades.
    pub avg_loss: Option<f64>,
    /// Gross wins over gross losses (None without a loss).
    pub profit_factor: Option<f64>,
    /// The deepest fall of the equity curve from a high, in money (≤ 0).
    pub max_drawdown: f64,
    /// The same, as a fraction of the high it fell from (≤ 0).
    pub max_drawdown_pct: f64,
    /// The best trade.
    pub largest_win: Option<f64>,
    /// The worst trade.
    pub largest_loss: Option<f64>,
    /// Mean bars held.
    pub avg_bars: Option<f64>,
    /// Fraction of bars with a position open.
    pub exposure: f64,
    /// Long round trips.
    pub long_trades: u32,
    /// Short round trips.
    pub short_trades: u32,
    /// Commission and slippage paid over the run.
    pub costs: f64,
    /// Stop and target exits found on the bars' highs and lows, not on prints (approximate).
    #[serde(default)]
    pub approximate_exits: u32,
}

/// A run's outcome.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BacktestResult {
    /// Every round trip, in order.
    pub trades: Vec<Trade>,
    /// The curve, one point per bar.
    pub equity: Vec<EquityPoint>,
    /// What the run measured.
    pub metrics: Metrics,
}

#[derive(Clone, Copy, Debug)]
struct Open {
    qty: f64,
    entry_bar: usize,
    entry_price: f64,
    costs: f64,
    stop: Option<f64>,
    target: Option<f64>,
    mae: f64,
    mfe: f64,
}

impl Open {
    fn side(&self) -> f64 {
        self.qty.signum()
    }
}

#[allow(clippy::needless_range_loop)]
pub fn backtest(
    bars: &Bars,
    signals: &Signals,
    paths: &BarPaths,
    cfg: &BacktestConfig,
) -> Result<BacktestResult, String> {
    bars.check()?;
    signals.check(bars.len())?;
    if cfg.tick.is_nan() || cfg.tick <= 0.0 || cfg.point_value.is_nan() || cfg.point_value <= 0.0 {
        return Err("tick and point value must be positive".into());
    }
    let slip = cfg.slippage_ticks.max(0.0) * cfg.tick;
    let fee = cfg.commission_per_contract.max(0.0);
    let n = bars.len();
    let mut trades = Vec::new();
    let mut equity = Vec::with_capacity(n);
    let mut realized = 0.0;
    let mut open: Option<Open> = None;
    let mut pending: Option<(f64, usize)> = None;
    let mut bars_open = 0usize;

    let close_at = |o: &Open,
                    bar: usize,
                    price: f64,
                    exit: ExitReason,
                    approximate: bool,
                    trades: &mut Vec<Trade>|
     -> f64 {
        let fill = price - o.side() * slip;
        let costs = o.costs + fee * o.qty.abs() + slip * o.qty.abs() * cfg.point_value;
        let gross = (fill - o.entry_price) * o.qty * cfg.point_value;
        let pnl = gross - fee * o.qty.abs() * 2.0;
        trades.push(Trade {
            qty: o.qty,
            entry_time: bars.time[o.entry_bar],
            entry_price: o.entry_price,
            exit_time: bars.time[bar],
            exit_price: fill,
            pnl,
            costs,
            bars: (bar - o.entry_bar) as u32,
            mae: o.mae,
            mfe: o.mfe,
            exit,
            stop: o.stop,
            target: o.target,
            approximate,
        });
        pnl
    };

    for i in 0..n {
        if let Some((want, decided)) = pending.take() {
            let have = open.map_or(0.0, |o| o.qty);
            if want != have {
                if let Some(o) = open.take() {
                    realized +=
                        close_at(&o, i, bars.open[i], ExitReason::Signal, false, &mut trades);
                }
                if want != 0.0 {
                    let side = want.signum();
                    let fill = bars.open[i] + side * slip;
                    let ticks = |t: Option<f64>| t.filter(|t| *t > 0.0).map(|t| t * cfg.tick);
                    let on_ticks = |d: f64| (d / cfg.tick).round().max(1.0) * cfg.tick;
                    let stop = Signals::distance(&signals.stop_distance, decided)
                        .map(on_ticks)
                        .or_else(|| ticks(cfg.stop_ticks));
                    let target = Signals::distance(&signals.target_distance, decided)
                        .map(on_ticks)
                        .or_else(|| ticks(cfg.target_ticks));
                    open = Some(Open {
                        qty: want,
                        entry_bar: i,
                        entry_price: fill,
                        costs: fee * want.abs() + slip * want.abs() * cfg.point_value,
                        stop: stop.map(|d| fill - side * d),
                        target: target.map(|d| fill + side * d),
                        mae: 0.0,
                        mfe: 0.0,
                    });
                }
            }
        }
        if let Some(mut o) = open {
            let side = o.side();
            let (worst, best) = if side > 0.0 {
                (bars.low[i], bars.high[i])
            } else {
                (bars.high[i], bars.low[i])
            };
            o.mae = o.mae.min((worst - o.entry_price) * o.qty * cfg.point_value);
            o.mfe = o.mfe.max((best - o.entry_price) * o.qty * cfg.point_value);
            let hit = |level: f64, adverse: bool| {
                if adverse {
                    side * (worst - level) <= 0.0
                } else {
                    side * (best - level) >= 0.0
                }
            };
            let on_bars = || match (o.stop, o.target) {
                (Some(s), _) if hit(s, true) => {
                    let at = if side * (bars.open[i] - s) < 0.0 && i > o.entry_bar {
                        bars.open[i]
                    } else {
                        s
                    };
                    Some((at, ExitReason::Stop))
                }
                (_, Some(t)) if hit(t, false) => Some((t, ExitReason::Target)),
                _ => None,
            };
            let bracketed = o.stop.is_some() || o.target.is_some();
            let (exit, approximate) = match paths.at(i) {
                Some(path) if bracketed => (first_on(path, side, o.stop, o.target), false),
                _ => (on_bars(), true),
            };
            open = Some(o);
            if let Some((at, why)) = exit {
                realized += close_at(&o, i, at, why, approximate, &mut trades);
                open = None;
            }
        }
        if open.is_some() {
            bars_open += 1;
        }
        let t = signals.position[i];
        if t.is_finite() {
            pending = Some((t.round(), i));
        }
        let unrealized = open.map_or(0.0, |o| {
            (bars.close[i] - o.entry_price) * o.qty * cfg.point_value
        });
        equity.push(EquityPoint {
            time: bars.time[i],
            equity: cfg.initial_equity + realized + unrealized,
        });
    }
    if let Some(o) = open.take() {
        let last = n - 1;
        realized += close_at(
            &o,
            last,
            bars.close[last],
            ExitReason::EndOfData,
            false,
            &mut trades,
        );
        if let Some(p) = equity.last_mut() {
            p.equity = cfg.initial_equity + realized;
        }
    }
    let metrics = measure(&trades, &equity, cfg.initial_equity, bars_open, n);
    Ok(BacktestResult {
        trades,
        equity,
        metrics,
    })
}

pub fn measure(
    trades: &[Trade],
    equity: &[EquityPoint],
    initial: f64,
    bars_open: usize,
    bars: usize,
) -> Metrics {
    let n = trades.len();
    let pnls: Vec<f64> = trades.iter().map(|t| t.pnl).collect();
    let wins: Vec<f64> = pnls.iter().copied().filter(|p| *p > 0.0).collect();
    let losses: Vec<f64> = pnls.iter().copied().filter(|p| *p <= 0.0).collect();
    let mean = |v: &[f64]| (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64);
    let avg = mean(&pnls);
    let ci = avg.filter(|_| n >= 2).map(|m| {
        let var = pnls.iter().map(|p| (p - m).powi(2)).sum::<f64>() / (n - 1) as f64;
        let half = 1.96 * (var / n as f64).sqrt();
        (m - half, m + half)
    });
    let gross_win: f64 = wins.iter().sum();
    let gross_loss: f64 = -losses.iter().sum::<f64>();
    let (mut high, mut dd, mut dd_pct) = (initial, 0.0f64, 0.0f64);
    for p in equity {
        high = high.max(p.equity);
        dd = dd.min(p.equity - high);
        if high > 0.0 {
            dd_pct = dd_pct.min((p.equity - high) / high);
        }
    }
    Metrics {
        trades: n as u32,
        wins: wins.len() as u32,
        losses: losses.len() as u32,
        win_rate: (n > 0).then(|| wins.len() as f64 / n as f64),
        win_rate_ci: wilson_interval(wins.len() as u64, n as u64, 1.96),
        net_pnl: pnls.iter().sum(),
        avg_trade: avg,
        avg_trade_ci: ci,
        avg_win: mean(&wins),
        avg_loss: mean(&losses),
        profit_factor: (gross_loss > 0.0).then(|| gross_win / gross_loss),
        max_drawdown: dd,
        max_drawdown_pct: dd_pct,
        largest_win: wins.iter().copied().reduce(f64::max),
        largest_loss: losses.iter().copied().reduce(f64::min),
        avg_bars: mean(&trades.iter().map(|t| f64::from(t.bars)).collect::<Vec<_>>()),
        exposure: if bars > 0 {
            bars_open as f64 / bars as f64
        } else {
            0.0
        },
        long_trades: trades.iter().filter(|t| t.qty > 0.0).count() as u32,
        short_trades: trades.iter().filter(|t| t.qty < 0.0).count() as u32,
        costs: trades.iter().map(|t| t.costs).sum(),
        approximate_exits: trades.iter().filter(|t| t.approximate).count() as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars(rows: &[(f64, f64, f64, f64)]) -> Bars {
        let mut b = Bars::default();
        for (i, (o, h, l, c)) in rows.iter().enumerate() {
            b.time.push(i as i64 * 60_000_000_000);
            b.open.push(*o);
            b.high.push(*h);
            b.low.push(*l);
            b.close.push(*c);
        }
        b
    }

    fn cfg() -> BacktestConfig {
        BacktestConfig {
            tick: 0.25,
            point_value: 20.0,
            commission_per_contract: 0.0,
            slippage_ticks: 0.0,
            stop_ticks: None,
            target_ticks: None,
            initial_equity: 100_000.0,
        }
    }

    #[test]
    fn a_target_acts_at_the_next_open_never_at_the_bar_that_decided_it() {
        let b = bars(&[
            (100.0, 101.0, 99.0, 100.0),
            (102.0, 103.0, 101.0, 102.5),
            (104.0, 105.0, 103.0, 104.0),
        ]);
        let r = backtest(
            &b,
            &Signals::positions(vec![1.0, 0.0, f64::NAN]),
            &BarPaths::default(),
            &cfg(),
        )
        .unwrap();
        assert_eq!(r.trades.len(), 1);
        let t = &r.trades[0];
        assert_eq!(
            (t.entry_price, t.exit_price),
            (102.0, 104.0),
            "the opens after each decision"
        );
        assert_eq!(t.pnl, 40.0);
        assert_eq!(t.exit, ExitReason::Signal);
        assert_eq!(r.metrics.trades, 1);
        assert_eq!(r.metrics.win_rate, Some(1.0));
    }

    #[test]
    fn costs_are_paid_on_both_fills() {
        let b = bars(&[
            (100.0, 100.0, 100.0, 100.0),
            (100.0, 100.0, 100.0, 100.0),
            (100.0, 100.0, 100.0, 100.0),
        ]);
        let c = BacktestConfig {
            commission_per_contract: 2.0,
            slippage_ticks: 1.0,
            ..cfg()
        };
        let r = backtest(
            &b,
            &Signals::positions(vec![2.0, 0.0, f64::NAN]),
            &BarPaths::default(),
            &c,
        )
        .unwrap();
        let t = &r.trades[0];
        assert_eq!((t.entry_price, t.exit_price), (100.25, 99.75));
        assert_eq!(t.pnl, -28.0);
        assert_eq!(t.costs, 28.0);
    }

    #[test]
    fn a_flip_closes_and_opens_at_the_same_open() {
        let b = bars(&[
            (100.0, 100.0, 100.0, 100.0),
            (101.0, 101.0, 101.0, 101.0),
            (99.0, 99.0, 99.0, 99.0),
            (98.0, 98.0, 98.0, 98.0),
        ]);
        let r = backtest(
            &b,
            &Signals::positions(vec![1.0, -1.0, f64::NAN, f64::NAN]),
            &BarPaths::default(),
            &cfg(),
        )
        .unwrap();
        assert_eq!(r.trades.len(), 2);
        assert_eq!((r.trades[0].qty, r.trades[0].exit_price), (1.0, 99.0));
        assert_eq!((r.trades[1].qty, r.trades[1].entry_price), (-1.0, 99.0));
        assert_eq!(r.trades[1].exit, ExitReason::EndOfData);
        assert_eq!(r.trades[1].pnl, 20.0);
        assert_eq!(r.metrics.long_trades, 1);
        assert_eq!(r.metrics.short_trades, 1);
    }

    #[test]
    fn a_bar_touching_stop_and_target_takes_the_stop() {
        let b = bars(&[
            (100.0, 100.0, 100.0, 100.0),
            (100.0, 100.5, 99.5, 100.0),
            (100.0, 102.0, 98.0, 100.0),
        ]);
        let c = BacktestConfig {
            stop_ticks: Some(4.0),
            target_ticks: Some(4.0),
            ..cfg()
        };
        let r = backtest(
            &b,
            &Signals::positions(vec![1.0, f64::NAN, f64::NAN]),
            &BarPaths::default(),
            &c,
        )
        .unwrap();
        assert_eq!(r.trades.len(), 1);
        assert_eq!(r.trades[0].exit, ExitReason::Stop);
        assert_eq!(r.trades[0].exit_price, 99.0);
        assert_eq!(r.trades[0].mae, -40.0);
    }

    #[test]
    fn a_trade_takes_the_bracket_decided_with_it_and_others_keep_the_runs() {
        let b = bars(&[
            (100.0, 100.0, 100.0, 100.0),
            (100.0, 100.5, 99.9, 100.0),
            (100.0, 101.2, 99.9, 101.0),
            (101.0, 101.0, 101.0, 101.0),
            (101.0, 101.0, 101.0, 101.0),
            (101.0, 102.0, 101.0, 101.0),
        ]);
        let c = BacktestConfig {
            target_ticks: Some(4.0),
            ..cfg()
        };
        let nan = f64::NAN;
        let s = Signals {
            position: vec![1.0, nan, nan, 1.0, nan, nan],
            stop_distance: Vec::new(),
            target_distance: vec![1.1, nan, nan, nan, nan, nan],
        };
        let r = backtest(&b, &s, &BarPaths::default(), &c).unwrap();
        assert_eq!(r.trades.len(), 2);
        let first = &r.trades[0];
        assert_eq!(first.target, Some(101.0), "1.1 rounds to whole ticks");
        assert_eq!((first.exit, first.exit_price), (ExitReason::Target, 101.0));
        assert_eq!(
            (r.trades[1].target, r.trades[1].exit),
            (Some(102.0), ExitReason::Target),
            "the run's 4 ticks"
        );
        let short = Signals {
            target_distance: vec![1.0],
            ..Signals::positions(vec![1.0, nan, nan, nan, nan, nan])
        };
        assert!(
            backtest(&b, &short, &BarPaths::default(), &c)
                .unwrap_err()
                .contains("1 target distances")
        );
    }

    #[test]
    fn a_bar_with_prints_exits_on_whichever_level_traded_first() {
        let b = bars(&[
            (100.0, 100.0, 100.0, 100.0),
            (100.0, 100.0, 100.0, 100.0),
            (100.0, 102.0, 98.0, 100.0),
        ]);
        let c = BacktestConfig {
            stop_ticks: Some(4.0),
            target_ticks: Some(4.0),
            ..cfg()
        };
        let longs = Signals::positions(vec![1.0, f64::NAN, f64::NAN]);
        let up_first = BarPaths(vec![
            None,
            Some(BarPaths::path([100.0])),
            Some(BarPaths::path([100.0, 100.5, 101.25, 98.0, 100.0])),
        ]);
        let r = backtest(&b, &longs, &up_first, &c).unwrap();
        let t = &r.trades[0];
        assert_eq!(
            (t.exit, t.exit_price, t.approximate),
            (ExitReason::Target, 101.0, false)
        );
        assert_eq!(r.metrics.approximate_exits, 0);

        let down_through = BarPaths(vec![
            None,
            Some(BarPaths::path([100.0])),
            Some(BarPaths::path([100.0, 99.5, 98.75, 102.0])),
        ]);
        let t = &backtest(&b, &longs, &down_through, &c).unwrap().trades[0];
        assert_eq!(
            (t.exit, t.exit_price),
            (ExitReason::Stop, 98.75),
            "the print that went through"
        );

        let r = backtest(&b, &longs, &BarPaths::default(), &c).unwrap();
        let t = &r.trades[0];
        assert_eq!(
            (t.exit, t.approximate),
            (ExitReason::Stop, true),
            "bars alone guess the stop"
        );
        assert_eq!(r.metrics.approximate_exits, 1);
    }

    #[test]
    fn a_gap_through_the_stop_fills_at_the_open() {
        let b = bars(&[
            (100.0, 100.0, 100.0, 100.0),
            (100.0, 100.0, 100.0, 100.0),
            (97.0, 97.5, 96.0, 97.0),
        ]);
        let c = BacktestConfig {
            stop_ticks: Some(4.0),
            ..cfg()
        };
        let r = backtest(
            &b,
            &Signals::positions(vec![1.0, f64::NAN, f64::NAN]),
            &BarPaths::default(),
            &c,
        )
        .unwrap();
        assert_eq!(r.trades[0].exit_price, 97.0);
        assert_eq!(r.trades[0].pnl, -60.0);
    }

    #[test]
    fn the_curve_and_its_drawdown_are_measured_bar_by_bar() {
        let b = bars(&[
            (100.0, 100.0, 100.0, 100.0),
            (100.0, 100.0, 100.0, 105.0),
            (105.0, 105.0, 95.0, 95.0),
            (95.0, 95.0, 95.0, 95.0),
        ]);
        let r = backtest(
            &b,
            &Signals::positions(vec![1.0, f64::NAN, 0.0, f64::NAN]),
            &BarPaths::default(),
            &cfg(),
        )
        .unwrap();
        assert_eq!(r.equity.len(), 4);
        assert_eq!(r.equity[1].equity, 100_100.0);
        assert_eq!(r.equity[2].equity, 99_900.0);
        assert_eq!(r.metrics.max_drawdown, -200.0);
        assert!(r.metrics.exposure > 0.0);
    }

    #[test]
    fn mismatched_inputs_are_refused_in_words() {
        let b = bars(&[(1.0, 1.0, 1.0, 1.0)]);
        assert!(
            backtest(
                &b,
                &Signals::positions(vec![]),
                &BarPaths::default(),
                &cfg()
            )
            .unwrap_err()
            .contains("1 bars")
        );
        let bad = BacktestConfig { tick: 0.0, ..cfg() };
        assert!(
            backtest(
                &b,
                &Signals::positions(vec![0.0]),
                &BarPaths::default(),
                &bad
            )
            .is_err()
        );
    }
}
