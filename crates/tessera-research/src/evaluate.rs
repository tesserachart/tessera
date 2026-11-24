use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::backtest::{
    BacktestConfig, BarPaths, Bars, EquityPoint, Metrics, Signals, Trade, backtest, measure,
};

/// One way fills can go: the adverse ticks every fill pays.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FillCase {
    /// `base`, `stressed`.
    pub name: String,
    /// Adverse ticks per fill.
    pub slippage_ticks: f64,
}

/// The gates a study must pass, frozen with it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Gates {
    /// Trades the later sessions must hold.
    pub min_trades: u32,
    /// A floor on the later sessions' win rate, if the hypothesis is about it.
    #[serde(default)]
    pub min_win_rate: Option<f64>,
    /// The later mean trade's 5-session block interval must sit above zero.
    #[serde(default = "yes")]
    pub ci_above_zero: bool,
    /// Each half of the later sessions must be positive on its own.
    #[serde(default = "yes")]
    pub each_half_positive: bool,
    /// The development sessions must be positive too.
    #[serde(default = "yes")]
    pub development_positive: bool,
}

fn yes() -> bool {
    true
}

impl Default for Gates {
    fn default() -> Self {
        Self {
            min_trades: 100,
            min_win_rate: None,
            ci_above_zero: true,
            each_half_positive: true,
            development_positive: true,
        }
    }
}

/// What one split of the history measured.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SplitResult {
    /// Sessions in the split.
    pub sessions: u32,
    /// Its first bar's open time.
    #[ts(type = "number")]
    pub from: i64,
    /// Its last bar's open time.
    #[ts(type = "number")]
    pub to: i64,
    /// The trades entered in it.
    pub metrics: Metrics,
    /// Trades per session.
    pub trades_per_session: f64,
    /// The mean trade's 95% interval from a circular bootstrap of 5-session blocks.
    pub mean_ci_block5: Option<(f64, f64)>,
    /// The same with 20-session blocks (wider when sessions are correlated).
    pub mean_ci_block20: Option<(f64, f64)>,
    /// Net P&L of its first and second half of sessions.
    pub halves: (f64, f64),
}

/// One gate's outcome.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GateResult {
    /// What it asks, in words (`Later trades ≥ 100`).
    pub gate: String,
    /// What was measured (`142`).
    pub measured: String,
    /// Whether it passed.
    pub passed: bool,
}

/// The placebo: the same trades (count, side, holding time) entered at random bars.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlaceboResult {
    /// Random runs made.
    pub runs: u32,
    /// The strategy's later mean trade.
    pub real_mean: f64,
    /// The placebo runs' median later mean trade.
    pub placebo_median: f64,
    /// Share of placebo runs the strategy's mean beat (0–1).
    pub percentile: f64,
}

/// One fill case's run over the whole history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    /// The fill case.
    pub case: FillCase,
    /// The development sessions.
    pub development: SplitResult,
    /// The later sessions.
    pub later: SplitResult,
    /// Each gate, judged on this case.
    pub gates: Vec<GateResult>,
    /// The curve over the whole history.
    pub equity: Vec<EquityPoint>,
    /// Every trade (the base case's are shown; others are kept for the audit).
    pub trades: Vec<Trade>,
}

/// The verdict on this history.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Every gate passed in every fill case.
    Qualified,
    /// The later sessions are positive in the base case, but a gate failed.
    Lead,
    /// Neither.
    Rejected,
}

/// A study's run: each fill case, the placebo and the verdict.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    /// Each fill case, the base case first.
    pub cases: Vec<CaseResult>,
    /// The base case against its placebo, when asked for.
    pub placebo: Option<PlaceboResult>,
    /// The verdict on this history.
    pub verdict: Verdict,
    /// Why, in one sentence.
    pub reason: String,
    /// Bars read.
    pub bars: u32,
    /// Sessions read.
    pub sessions: u32,
    /// The first later session's index (development sessions come before it).
    pub later_from_session: u32,
}

#[derive(Clone, Debug)]
pub struct EvalSpec<'a> {
    pub config: &'a BacktestConfig,
    pub paths: &'a BarPaths,
    pub cases: &'a [FillCase],
    pub gates: &'a Gates,
    pub development_share: f64,
    pub placebo_runs: u32,
    pub seed: u64,
}

pub fn evaluate(
    bars: &Bars,
    session: &[u32],
    signals: &Signals,
    spec: &EvalSpec<'_>,
) -> Result<Evaluation, String> {
    if session.len() != bars.len() {
        return Err("every bar needs its session".into());
    }
    if session.windows(2).any(|w| w[1] < w[0]) {
        return Err("sessions must not go backwards".into());
    }
    if spec.cases.is_empty() {
        return Err("a study needs at least one fill case".into());
    }
    let sessions = session.last().map_or(0, |s| s + 1);
    if sessions < 4 {
        return Err(format!(
            "{sessions} sessions are too few to split; widen the dates"
        ));
    }
    let share = spec.development_share.clamp(0.1, 0.9);
    let later_from = ((f64::from(sessions) * share).round() as u32).clamp(1, sessions - 1);
    let mut cases = Vec::with_capacity(spec.cases.len());
    for case in spec.cases {
        let cfg = BacktestConfig {
            slippage_ticks: case.slippage_ticks,
            ..spec.config.clone()
        };
        let run = backtest(bars, signals, spec.paths, &cfg)?;
        let of = |t: &Trade| session_of(bars, session, t.entry_time);
        let (dev, later): (Vec<Trade>, Vec<Trade>) =
            run.trades.iter().cloned().partition(|t| of(t) < later_from);
        let development = split(
            bars,
            session,
            &dev,
            0,
            later_from,
            cfg.initial_equity,
            spec.seed,
        );
        let later_split = split(
            bars,
            session,
            &later,
            later_from,
            sessions,
            cfg.initial_equity,
            spec.seed,
        );
        let gates = gate(spec.gates, &development, &later_split);
        cases.push(CaseResult {
            case: case.clone(),
            development,
            later: later_split,
            gates,
            equity: run.equity,
            trades: run.trades,
        });
    }
    let placebo = (spec.placebo_runs > 0)
        .then(|| placebo(bars, session, &cases[0], later_from, spec))
        .transpose()?;
    let all_pass = cases.iter().all(|c| c.gates.iter().all(|g| g.passed));
    let base_later = cases[0].later.metrics.net_pnl;
    let (verdict, reason) = if all_pass {
        (
            Verdict::Qualified,
            "Every gate passed in every fill case.".to_owned(),
        )
    } else {
        let total: usize = cases.iter().map(|c| c.gates.len()).sum();
        let failed: usize = cases
            .iter()
            .map(|c| c.gates.iter().filter(|g| !g.passed).count())
            .sum();
        let first = cases
            .iter()
            .flat_map(|c| c.gates.iter().filter(|g| !g.passed))
            .next()
            .map(|g| format!("{} ({})", lower_first(&g.gate), g.measured))
            .unwrap_or_default();
        if base_later > 0.0 {
            (
                Verdict::Lead,
                format!(
                    "The later sessions made money in the base case, but {failed} of {total} gates failed, first: {first}."
                ),
            )
        } else {
            (
                Verdict::Rejected,
                format!(
                    "The later sessions lost money in the base case; {failed} of {total} gates failed."
                ),
            )
        }
    };
    Ok(Evaluation {
        cases,
        placebo,
        verdict,
        reason,
        bars: bars.len() as u32,
        sessions,
        later_from_session: later_from,
    })
}

fn session_of(bars: &Bars, session: &[u32], time: i64) -> u32 {
    let i = bars.time.partition_point(|t| *t <= time).saturating_sub(1);
    session[i]
}

fn split(
    bars: &Bars,
    session: &[u32],
    trades: &[Trade],
    from: u32,
    to: u32,
    initial: f64,
    seed: u64,
) -> SplitResult {
    let first = session.partition_point(|s| *s < from);
    let last = session
        .partition_point(|s| *s < to)
        .saturating_sub(1)
        .max(first);
    let mut eq = initial;
    let curve: Vec<EquityPoint> = trades
        .iter()
        .map(|t| {
            eq += t.pnl;
            EquityPoint {
                time: t.exit_time,
                equity: eq,
            }
        })
        .collect();
    let bars_in = last + 1 - first;
    let metrics = measure(trades, &curve, initial, 0, bars_in);
    let n = (to - from) as usize;
    let mut per = vec![(0.0f64, 0u32); n];
    for t in trades {
        let s = session_of(bars, session, t.entry_time).saturating_sub(from) as usize;
        if let Some(slot) = per.get_mut(s) {
            slot.0 += t.pnl;
            slot.1 += 1;
        }
    }
    let half = n / 2;
    let halves = (
        per[..half].iter().map(|p| p.0).sum::<f64>(),
        per[half..].iter().map(|p| p.0).sum::<f64>(),
    );
    SplitResult {
        sessions: n as u32,
        from: bars.time[first],
        to: bars.time[last],
        trades_per_session: if n > 0 {
            trades.len() as f64 / n as f64
        } else {
            0.0
        },
        mean_ci_block5: block_ci(&per, 5, 2000, seed),
        mean_ci_block20: block_ci(&per, 20, 2000, seed ^ 0x9e37_79b9),
        halves,
        metrics,
    }
}

fn block_ci(per: &[(f64, u32)], block: usize, draws: u32, seed: u64) -> Option<(f64, f64)> {
    let n = per.len();
    let trades: u32 = per.iter().map(|p| p.1).sum();
    if n < 2 || trades < 2 {
        return None;
    }
    let block = block.clamp(1, n);
    let mut rng = SplitMix64(seed);
    let mut means = Vec::with_capacity(draws as usize);
    for _ in 0..draws {
        let (mut pnl, mut count, mut taken) = (0.0, 0u32, 0usize);
        while taken < n {
            let start = (rng.next() % n as u64) as usize;
            for k in 0..block.min(n - taken) {
                let (p, c) = per[(start + k) % n];
                pnl += p;
                count += c;
            }
            taken += block;
        }
        if count > 0 {
            means.push(pnl / f64::from(count));
        }
    }
    if means.len() < 20 {
        return None;
    }
    means.sort_by(f64::total_cmp);
    let at = |q: f64| means[((means.len() - 1) as f64 * q).round() as usize];
    Some((at(0.025), at(0.975)))
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_lowercase().chain(c).collect())
        .unwrap_or_default()
}

fn money(v: f64) -> String {
    let whole = v.abs().round() as u64;
    let digits = whole.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    format!("{}${out}", if v < 0.0 && whole > 0 { "−" } else { "" })
}

fn gate(g: &Gates, dev: &SplitResult, later: &SplitResult) -> Vec<GateResult> {
    let mut out = vec![GateResult {
        gate: format!("Later trades ≥ {}", g.min_trades),
        measured: later.metrics.trades.to_string(),
        passed: later.metrics.trades >= g.min_trades,
    }];
    if let Some(w) = g.min_win_rate {
        let wr = later.metrics.win_rate.unwrap_or(0.0);
        out.push(GateResult {
            gate: format!("Later win rate ≥ {:.0}%", w * 100.0),
            measured: format!("{:.1}%", wr * 100.0),
            passed: wr >= w,
        });
    }
    if g.ci_above_zero {
        let lo = later.mean_ci_block5.map(|c| c.0);
        out.push(GateResult {
            gate: "Later mean trade's interval above zero".into(),
            measured: lo.map_or_else(|| "too few trades".into(), |l| format!("low {}", money(l))),
            passed: lo.is_some_and(|l| l > 0.0),
        });
    }
    if g.each_half_positive {
        out.push(GateResult {
            gate: "Each half of the later sessions positive".into(),
            measured: format!("{} · {}", money(later.halves.0), money(later.halves.1)),
            passed: later.halves.0 > 0.0 && later.halves.1 > 0.0,
        });
    }
    if g.development_positive {
        out.push(GateResult {
            gate: "Development sessions positive".into(),
            measured: money(dev.metrics.net_pnl),
            passed: dev.metrics.net_pnl > 0.0,
        });
    }
    out
}

fn placebo(
    bars: &Bars,
    session: &[u32],
    base: &CaseResult,
    later_from: u32,
    spec: &EvalSpec<'_>,
) -> Result<PlaceboResult, String> {
    let n = bars.len();
    let real_mean = base.later.metrics.avg_trade.unwrap_or(0.0);
    let cfg = BacktestConfig {
        slippage_ticks: spec.cases[0].slippage_ticks,
        ..spec.config.clone()
    };
    let distance =
        |t: &Trade, level: Option<f64>| level.map_or(f64::NAN, |l| (l - t.entry_price).abs());
    let shapes: Vec<(f64, usize, f64, f64)> = base
        .trades
        .iter()
        .map(|t| {
            (
                t.qty,
                (t.bars as usize).max(1),
                distance(t, t.stop),
                distance(t, t.target),
            )
        })
        .collect();
    let mut rng = SplitMix64(spec.seed ^ 0x5eed);
    let mut means = Vec::with_capacity(spec.placebo_runs as usize);
    for _ in 0..spec.placebo_runs {
        let mut signals = Signals {
            position: vec![f64::NAN; n],
            stop_distance: vec![f64::NAN; n],
            target_distance: vec![f64::NAN; n],
        };
        let mut taken = vec![false; n];
        for &(qty, hold, stop, target) in &shapes {
            if n < hold + 2 {
                continue;
            }
            for _ in 0..8 {
                let at = (rng.next() % (n - hold - 1) as u64) as usize;
                if taken[at..=at + hold].iter().any(|t| *t) {
                    continue;
                }
                taken[at..=at + hold].iter_mut().for_each(|t| *t = true);
                signals.position[at] = qty;
                signals.position[at + hold] = 0.0;
                signals.stop_distance[at] = stop;
                signals.target_distance[at] = target;
                break;
            }
        }
        let run = backtest(bars, &signals, spec.paths, &cfg)?;
        let later: Vec<f64> = run
            .trades
            .iter()
            .filter(|t| session_of(bars, session, t.entry_time) >= later_from)
            .map(|t| t.pnl)
            .collect();
        if !later.is_empty() {
            means.push(later.iter().sum::<f64>() / later.len() as f64);
        }
    }
    if means.is_empty() {
        return Err("the placebo found no room for the strategy's trades".into());
    }
    means.sort_by(f64::total_cmp);
    let median = means[means.len() / 2];
    let beaten = means.iter().filter(|m| **m < real_mean).count();
    Ok(PlaceboResult {
        runs: means.len() as u32,
        real_mean,
        placebo_median: median,
        percentile: beaten as f64 / means.len() as f64,
    })
}

struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(days: u32, per: u32, drift: f64) -> (Bars, Vec<u32>) {
        let mut b = Bars::default();
        let mut s = Vec::new();
        let mut px = 100.0;
        for d in 0..days {
            for k in 0..per {
                let i = d * per + k;
                let wiggle = if i.is_multiple_of(2) { 0.25 } else { -0.25 };
                let open = px;
                px += drift + wiggle;
                b.time.push(i64::from(i) * 60_000_000_000);
                b.open.push(open);
                b.close.push(px);
                b.high.push(open.max(px) + 0.25);
                b.low.push(open.min(px) - 0.25);
                s.push(d);
            }
        }
        (b, s)
    }

    fn cfg() -> BacktestConfig {
        BacktestConfig {
            tick: 0.25,
            point_value: 20.0,
            commission_per_contract: 1.0,
            slippage_ticks: 0.0,
            stop_ticks: None,
            target_ticks: None,
            initial_equity: 100_000.0,
        }
    }

    fn cases() -> Vec<FillCase> {
        vec![
            FillCase {
                name: "base".into(),
                slippage_ticks: 1.0,
            },
            FillCase {
                name: "stressed".into(),
                slippage_ticks: 2.0,
            },
        ]
    }

    fn session_longs(s: &[u32]) -> Vec<f64> {
        let mut t = vec![f64::NAN; s.len()];
        for i in 0..s.len() {
            let start = i == 0 || s[i] != s[i - 1];
            if start {
                t[i] = 1.0;
                if i + 4 < s.len() {
                    t[i + 4] = 0.0;
                }
            }
        }
        t
    }

    #[test]
    fn a_rule_that_wins_everywhere_qualifies_and_beats_its_placebo() {
        let (bars, s) = history(60, 20, 0.5);
        let gates = Gates {
            min_trades: 20,
            ..Gates::default()
        };
        let spec = EvalSpec {
            config: &cfg(),
            paths: &BarPaths::default(),
            cases: &cases(),
            gates: &gates,
            development_share: 0.5,
            placebo_runs: 50,
            seed: 7,
        };
        let e = evaluate(&bars, &s, &Signals::positions(session_longs(&s)), &spec).unwrap();
        assert_eq!(e.sessions, 60);
        assert_eq!(e.later_from_session, 30);
        assert_eq!(e.cases.len(), 2);
        let base = &e.cases[0];
        assert_eq!(base.later.sessions, 30);
        assert_eq!(base.later.metrics.trades, 30);
        assert!(base.later.mean_ci_block5.unwrap().0 > 0.0);
        assert_eq!(e.verdict, Verdict::Qualified, "{:?}", base.gates);
        let p = e.placebo.unwrap();
        assert!(p.runs > 0);
        assert!(p.placebo_median > 0.0);
    }

    #[test]
    fn costs_that_eat_the_edge_reject_it_and_say_why() {
        let (bars, s) = history(40, 20, 0.0);
        let spec = EvalSpec {
            config: &cfg(),
            paths: &BarPaths::default(),
            cases: &cases(),
            gates: &Gates::default(),
            development_share: 0.5,
            placebo_runs: 0,
            seed: 1,
        };
        let e = evaluate(&bars, &s, &Signals::positions(session_longs(&s)), &spec).unwrap();
        assert_eq!(e.verdict, Verdict::Rejected);
        assert!(e.reason.contains("lost money"), "{}", e.reason);
        assert!(e.cases[0].gates.iter().any(|g| !g.passed));
    }

    #[test]
    fn the_same_seed_draws_the_same_interval() {
        let (bars, s) = history(30, 10, 0.2);
        let spec = EvalSpec {
            config: &cfg(),
            paths: &BarPaths::default(),
            cases: &cases()[..1],
            gates: &Gates::default(),
            development_share: 0.5,
            placebo_runs: 0,
            seed: 42,
        };
        let a = evaluate(&bars, &s, &Signals::positions(session_longs(&s)), &spec).unwrap();
        let b = evaluate(&bars, &s, &Signals::positions(session_longs(&s)), &spec).unwrap();
        assert_eq!(
            a.cases[0].later.mean_ci_block5,
            b.cases[0].later.mean_ci_block5
        );
    }

    #[test]
    fn too_little_history_is_refused_in_words() {
        let (bars, s) = history(3, 10, 0.2);
        let spec = EvalSpec {
            config: &cfg(),
            paths: &BarPaths::default(),
            cases: &cases(),
            gates: &Gates::default(),
            development_share: 0.5,
            placebo_runs: 0,
            seed: 1,
        };
        assert!(
            evaluate(&bars, &s, &Signals::positions(session_longs(&s)), &spec)
                .unwrap_err()
                .contains("too few")
        );
    }
}
