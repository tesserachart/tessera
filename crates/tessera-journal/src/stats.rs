use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate, Timelike};
use chrono_tz::Tz;

use crate::activity::{ActivitySummary, EndedBy};
use crate::model::{
    Breakdowns, Bucket, DrawdownPeriod, EquityPoint, JournalStats, JournalTrade, Outcome, Overview,
    Sequences, SessionDef, StopBehaviour, Streaks, SymbolMonth, TradeResult, TradeStatus,
};

pub fn cents(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round(v: f64, dp: i32) -> f64 {
    let m = 10f64.powi(dp);
    (v * m).round() / m
}

pub fn bucket<'a>(
    key: impl Into<String>,
    label: impl Into<String>,
    trades: impl IntoIterator<Item = &'a JournalTrade>,
) -> Bucket {
    let mut b = Bucket {
        key: key.into(),
        label: label.into(),
        ..Bucket::default()
    };
    let mut r_sum = 0.0;
    let mut r0_sum = 0.0;
    let mut days = std::collections::BTreeSet::new();
    for t in trades {
        if t.status != TradeStatus::Closed {
            continue;
        }
        b.n += 1;
        b.net += t.net_pnl;
        b.fees += t.fees;
        days.insert(t.trade_date);
        match t.outcome {
            Outcome::Win => {
                b.wins += 1;
                b.gross_profit += t.net_pnl;
            }
            Outcome::Loss => {
                b.losses += 1;
                b.gross_loss += -t.net_pnl;
            }
            _ => b.breakevens += 1,
        }
        if let Some(r) = t.r_multiple {
            b.n_r += 1;
            r_sum += r;
        }
        if let Some(r) = t.activity.as_ref().and_then(|a| a.r_initial) {
            b.n_r_initial += 1;
            r0_sum += r;
        }
    }
    b.days = days.len() as u32;
    if b.n > 0 {
        b.avg = cents(b.net / f64::from(b.n));
    }
    let decided = b.wins + b.losses;
    if decided > 0 {
        b.win_rate = Some(round(f64::from(b.wins) / f64::from(decided) * 100.0, 2));
    }
    if b.wins > 0 {
        b.avg_win = cents(b.gross_profit / f64::from(b.wins));
    }
    if b.losses > 0 {
        b.avg_loss = cents(b.gross_loss / f64::from(b.losses));
    }
    if b.gross_loss > 0.0 {
        b.profit_factor = Some(round(b.gross_profit / b.gross_loss, 2));
    }
    let w = b.win_rate.unwrap_or(0.0) / 100.0;
    b.expectancy = cents(w * b.avg_win - (1.0 - w) * b.avg_loss);
    if b.n_r > 0 {
        b.total_r = Some(round(r_sum, 2));
        b.avg_r = Some(round(r_sum / f64::from(b.n_r), 2));
    }
    if b.n_r_initial > 0 {
        b.avg_r_initial = Some(round(r0_sum / f64::from(b.n_r_initial), 2));
    }
    b.net = cents(b.net);
    b.fees = cents(b.fees);
    b.gross_profit = cents(b.gross_profit);
    b.gross_loss = cents(b.gross_loss);
    b
}

pub fn wilson(wins: u32, n: u32) -> Option<(f64, f64)> {
    if n == 0 {
        return None;
    }
    let z = 1.959_963_984_540_054_f64;
    let n = f64::from(n);
    let p = f64::from(wins) / n;
    let den = 1.0 + z * z / n;
    let centre = (p + z * z / (2.0 * n)) / den;
    let half = z * ((p * (1.0 - p) + z * z / (4.0 * n)) / n).sqrt() / den;
    Some((
        round((centre - half).max(0.0) * 100.0, 1),
        round((centre + half).min(1.0) * 100.0, 1),
    ))
}

fn mean(v: &[f64]) -> Option<f64> {
    (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
}

fn minutes(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    let (h, m): (u32, u32) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

pub fn in_session(t: &JournalTrade, s: &SessionDef) -> bool {
    let Ok(zone) = s.timezone.parse::<Tz>() else {
        return false;
    };
    let local = t.opened_at.in_tz(zone);
    let m = local.hour() * 60 + local.minute();
    match (minutes(&s.start), minutes(&s.end)) {
        (Some(a), Some(b)) if a <= b => m >= a && m < b,
        (Some(a), Some(b)) => m >= a || m < b,
        _ => false,
    }
}

pub fn sessions_of(t: &JournalTrade, sessions: &[SessionDef]) -> Vec<String> {
    sessions
        .iter()
        .filter(|s| in_session(t, s))
        .map(|s| s.name.clone())
        .collect()
}

pub fn entry_hour(t: &JournalTrade, tz: Tz) -> u8 {
    t.opened_at.in_tz(tz).hour() as u8
}

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

pub fn day_label(d: NaiveDate) -> String {
    format!(
        "{} {} {}",
        WEEKDAYS[d.weekday().num_days_from_monday() as usize],
        d.day(),
        MONTHS[d.month0() as usize]
    )
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn grouped<'a, K: Ord + Clone>(
    trades: &[&'a JournalTrade],
    key: impl Fn(&JournalTrade) -> Vec<K>,
) -> BTreeMap<K, Vec<&'a JournalTrade>> {
    let mut m: BTreeMap<K, Vec<&'a JournalTrade>> = BTreeMap::new();
    for t in trades {
        for k in key(t) {
            m.entry(k).or_default().push(t);
        }
    }
    m
}

pub fn equity_curve(closed: &[&JournalTrade]) -> Vec<EquityPoint> {
    let mut equity = 0.0;
    let mut peak = 0.0f64;
    closed
        .iter()
        .enumerate()
        .map(|(i, t)| {
            equity += t.net_pnl;
            peak = peak.max(equity);
            EquityPoint {
                i: i as u32 + 1,
                trade_id: t.id.clone(),
                t: t.closed_at.unwrap_or(t.opened_at),
                pnl: t.net_pnl,
                equity: cents(equity),
                peak: cents(peak),
                drawdown: cents(peak - equity),
            }
        })
        .collect()
}

pub fn drawdown_periods(curve: &[EquityPoint]) -> Vec<DrawdownPeriod> {
    let mut out = Vec::new();
    let mut cur: Option<DrawdownPeriod> = None;
    for (i, p) in curve.iter().enumerate() {
        if p.drawdown > 0.0 {
            let c = cur.get_or_insert_with(|| DrawdownPeriod {
                start: if i == 0 { p.t } else { curve[i - 1].t },
                trough: p.t,
                recovered: None,
                peak: p.peak,
                depth: 0.0,
                depth_pct: None,
                trades: 0,
            });
            c.trades += 1;
            if p.drawdown > c.depth {
                c.depth = p.drawdown;
                c.trough = p.t;
            }
        } else if let Some(mut c) = cur.take() {
            c.recovered = Some(p.t);
            out.push(c);
        }
    }
    out.extend(cur);
    out.retain(|d| d.depth >= 1.0);
    for d in &mut out {
        d.depth_pct = (d.peak > 0.0).then(|| round(d.depth / d.peak * 100.0, 2));
    }
    out.sort_by(|a, b| b.depth.total_cmp(&a.depth));
    out
}

fn runs<'a>(closed: &[&'a JournalTrade]) -> Vec<(bool, Vec<&'a JournalTrade>)> {
    let mut out: Vec<(bool, Vec<&'a JournalTrade>)> = Vec::new();
    let mut cur: Option<(bool, Vec<&'a JournalTrade>)> = None;
    for t in closed {
        let w = match t.outcome {
            Outcome::Win => true,
            Outcome::Loss => false,
            _ => {
                out.extend(cur.take());
                continue;
            }
        };
        match &mut cur {
            Some((kind, v)) if *kind == w => v.push(t),
            _ => {
                out.extend(cur.take());
                cur = Some((w, vec![t]));
            }
        }
    }
    out.extend(cur);
    out
}

fn pearson(xs: &[f64], ys: &[f64]) -> Option<f64> {
    let n = xs.len();
    if n < 5 || n != ys.len() {
        return None;
    }
    let (mx, my) = (mean(xs)?, mean(ys)?);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for (x, y) in xs.iter().zip(ys) {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx).powi(2);
        syy += (y - my).powi(2);
    }
    (sxx > 0.0 && syy > 0.0).then(|| round(sxy / (sxx * syy).sqrt(), 3))
}

pub fn compute(
    trades: &[&JournalTrade],
    tz: Tz,
    sessions: &[SessionDef],
    breakeven_threshold: f64,
    compact: bool,
) -> JournalStats {
    let mut closed: Vec<&JournalTrade> = trades
        .iter()
        .copied()
        .filter(|t| t.status == TradeStatus::Closed)
        .collect();
    closed.sort_by(|a, b| {
        a.closed_at
            .cmp(&b.closed_at)
            .then_with(|| a.opened_at.cmp(&b.opened_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let all = bucket("all", "All trades", closed.iter().copied());
    let mut o = Overview {
        open: trades.len() as u32 - closed.len() as u32,
        ..Overview::default()
    };
    if let Some((lo, hi)) = wilson(all.wins, all.wins + all.losses) {
        o.win_rate_low = Some(lo);
        o.win_rate_high = Some(hi);
    }
    if all.avg_loss > 0.0 && all.wins > 0 {
        o.payoff_ratio = Some(round(all.avg_win / all.avg_loss, 2));
    }
    let pnls: Vec<f64> = closed.iter().map(|t| t.net_pnl).collect();
    o.largest_win = pnls.iter().copied().fold(0.0, f64::max);
    o.largest_loss = pnls.iter().copied().fold(0.0, f64::min);
    if pnls.len() > 1 {
        let m = mean(&pnls).unwrap_or(0.0);
        let var = pnls.iter().map(|p| (p - m).powi(2)).sum::<f64>() / (pnls.len() - 1) as f64;
        if var > 0.0 {
            o.sharpe = Some(round(m / var.sqrt(), 2));
        }
        let neg: Vec<f64> = pnls.iter().copied().filter(|p| *p < 0.0).collect();
        if !neg.is_empty() {
            let dd = (neg.iter().map(|p| p * p).sum::<f64>() / neg.len() as f64).sqrt();
            if dd > 0.0 {
                o.sortino = Some(round(m / dd, 2));
            }
        }
    }
    let rs = |want: Outcome| -> Option<f64> {
        let v: Vec<f64> = closed
            .iter()
            .filter(|t| t.outcome == want)
            .filter_map(|t| t.r_multiple)
            .collect();
        mean(&v).map(|m| round(m, 2))
    };
    o.avg_win_r = rs(Outcome::Win);
    o.avg_loss_r = rs(Outcome::Loss);

    let curve = equity_curve(&closed);
    let periods = drawdown_periods(&curve);
    if let Some(d) = periods.first() {
        o.max_drawdown = d.depth;
        o.max_drawdown_pct = d.depth_pct;
        if d.depth > 0.0 {
            o.recovery_factor = Some(round(all.net / d.depth, 2));
            o.calmar = calmar(&closed, all.net, d.depth);
        }
    }
    o.drawdowns = periods.len() as u32;
    if let Some(last) = curve.last() {
        o.current_drawdown = last.drawdown;
    }
    if !curve.is_empty() {
        let pct: Vec<f64> = curve
            .iter()
            .map(|p| {
                if p.peak > 0.0 {
                    p.drawdown / p.peak * 100.0
                } else {
                    0.0
                }
            })
            .collect();
        o.ulcer_index = round(
            (pct.iter().map(|x| x * x).sum::<f64>() / pct.len() as f64).sqrt(),
            2,
        );
        o.time_in_drawdown_pct = round(
            curve.iter().filter(|p| p.drawdown > 0.0).count() as f64 / curve.len() as f64 * 100.0,
            1,
        );
    }
    let holds = |f: &dyn Fn(&JournalTrade) -> bool| -> Option<f64> {
        let v: Vec<f64> = closed
            .iter()
            .filter(|t| f(t))
            .filter_map(|t| t.hold_secs.map(|s| s as f64))
            .collect();
        mean(&v).map(|m| m.round())
    };
    o.avg_hold_secs = holds(&|_| true);
    o.avg_hold_win_secs = holds(&|t| t.outcome == Outcome::Win);
    o.avg_hold_loss_secs = holds(&|t| t.outcome == Outcome::Loss);

    let rr = runs(&closed);
    for (w, v) in &rr {
        let len = v.len() as u32;
        if *w {
            o.max_win_streak = o.max_win_streak.max(len);
        } else {
            o.max_loss_streak = o.max_loss_streak.max(len);
        }
    }
    o.current_streak = match (closed.last().map(|t| t.outcome), rr.last()) {
        (Some(Outcome::Win), Some((true, v))) => v.len() as i32,
        (Some(Outcome::Loss), Some((false, v))) => -(v.len() as i32),
        _ => 0,
    };
    let mut streaks = Streaks::default();
    for (w, v) in &rr {
        let runs = if *w {
            &mut streaks.win_runs
        } else {
            &mut streaks.loss_runs
        };
        if runs.len() < v.len() {
            runs.resize(v.len(), 0);
        }
        runs[v.len() - 1] += 1;
    }
    streaks.in_win_runs = bucket(
        "in_win_runs",
        "In winning runs",
        rr.iter()
            .filter(|(w, v)| *w && v.len() >= 2)
            .flat_map(|(_, v)| v.iter().copied()),
    );
    streaks.in_loss_runs = bucket(
        "in_loss_runs",
        "In losing runs",
        rr.iter()
            .filter(|(w, v)| !*w && v.len() >= 2)
            .flat_map(|(_, v)| v.iter().copied()),
    );

    if all.avg_loss > 0.0 && all.avg_win > 0.0 {
        let b = all.avg_win / all.avg_loss;
        let w = all.win_rate.unwrap_or(0.0) / 100.0;
        o.kelly_pct = Some(round(
            ((w * b - (1.0 - w)) / b * 100.0).clamp(0.0, 100.0),
            1,
        ));
    }

    let by_day = grouped(&closed, |t| vec![t.trade_date]);
    let days: Vec<Bucket> = by_day
        .iter()
        .map(|(d, v)| bucket(d.to_string(), day_label(*d), v.iter().copied()))
        .collect();
    o.green_days = days.iter().filter(|d| d.net > 0.0).count() as u32;
    o.red_days = days.iter().filter(|d| d.net < 0.0).count() as u32;
    if !days.is_empty() {
        o.avg_day = Some(cents(all.net / days.len() as f64));
        o.best_day = days.iter().max_by(|a, b| a.net.total_cmp(&b.net)).cloned();
        o.worst_day = days.iter().min_by(|a, b| a.net.total_cmp(&b.net)).cloned();
    }
    let maes: Vec<f64> = closed.iter().filter_map(|t| t.mae).collect();
    let mfes: Vec<f64> = closed.iter().filter_map(|t| t.mfe).collect();
    o.n_excursion = maes.len() as u32;
    o.avg_mae = mean(&maes).map(cents);
    o.avg_mfe = mean(&mfes).map(cents);
    o.first = closed.iter().map(|t| t.opened_at).min();
    o.last = closed.iter().filter_map(|t| t.closed_at).max();
    o.all = all;

    let mut after_win = Vec::new();
    let mut after_loss = Vec::new();
    let mut after_n: [Vec<&JournalTrade>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    let mut losses_in_row = 0usize;
    for (i, t) in closed.iter().enumerate() {
        if i > 0 {
            match closed[i - 1].outcome {
                Outcome::Win => after_win.push(*t),
                Outcome::Loss => after_loss.push(*t),
                _ => {}
            }
            if losses_in_row > 0 {
                after_n[losses_in_row.min(3) - 1].push(*t);
            }
        }
        losses_in_row = if t.outcome == Outcome::Loss {
            losses_in_row + 1
        } else {
            0
        };
    }
    let counts: Vec<f64> = by_day.values().map(|v| v.len() as f64).collect();
    let nets: Vec<f64> = days.iter().map(|d| d.net).collect();
    let sequences = Sequences {
        after_win: bucket("after_win", "After a winner", after_win),
        after_loss: bucket("after_loss", "After a loser", after_loss),
        after_1_loss: bucket("after_1", "After 1 loser", after_n[0].iter().copied()),
        after_2_losses: bucket("after_2", "After 2 losers", after_n[1].iter().copied()),
        after_3_losses: bucket("after_3", "After 3+ losers", after_n[2].iter().copied()),
        trades_per_day_correlation: pearson(&counts, &nets),
    };

    let by = breakdowns(&closed, &by_day, days, tz, sessions);
    let behaviour = behaviour(&closed);
    let by_symbol_month = symbol_months(&closed);
    let mut stats = JournalStats {
        breakeven_threshold,
        timezone: tz.name().to_owned(),
        overview: o,
        equity: curve,
        drawdowns: periods.into_iter().take(10).collect(),
        by,
        streaks,
        sequences,
        behaviour,
        by_symbol_month,
    };
    if compact {
        stats.equity.clear();
        stats.by.day.clear();
    }
    stats
}

pub fn calmar(closed: &[&JournalTrade], net: f64, depth: f64) -> Option<f64> {
    let first = closed.iter().map(|t| t.opened_at).min()?;
    let last = closed.iter().filter_map(|t| t.closed_at).max()?;
    if depth <= 0.0 {
        return None;
    }
    let days = ((last.0 - first.0) as f64 / 86_400e9).max(1.0);
    Some(round(net * 365.0 / days / depth, 2))
}

pub fn symbol_months(closed: &[&JournalTrade]) -> Vec<SymbolMonth> {
    let mut m: BTreeMap<(String, String), SymbolMonth> = BTreeMap::new();
    for t in closed {
        let month = format!("{}-{:02}", t.trade_date.year(), t.trade_date.month());
        let e = m
            .entry((month.clone(), t.symbol.clone()))
            .or_insert_with(|| SymbolMonth {
                symbol: t.symbol.clone(),
                month,
                ..SymbolMonth::default()
            });
        e.net += t.net_pnl;
        e.n += 1;
    }
    m.into_values()
        .map(|mut e| {
            e.net = cents(e.net);
            e
        })
        .collect()
}

pub fn behaviour(closed: &[&JournalTrade]) -> StopBehaviour {
    type Row<'a> = (&'a JournalTrade, &'a ActivitySummary);
    let with: Vec<Row<'_>> = closed
        .iter()
        .filter_map(|t| t.activity.as_ref().map(|a| (*t, a)))
        .collect();
    let stopped: Vec<Row<'_>> = with
        .iter()
        .copied()
        .filter(|(_, a)| a.initial_stop.is_some())
        .collect();
    let pick =
        |key: &str, label: &str, rows: &[Row<'_>], keep: &dyn Fn(&ActivitySummary) -> bool| {
            bucket(
                key,
                label,
                rows.iter().filter(|(_, a)| keep(a)).map(|(t, _)| *t),
            )
        };
    let reached = |a: &ActivitySummary| a.breakeven_at.is_some();
    let ended = |a: &ActivitySummary, e: EndedBy| a.ended_by == Some(e);
    let un = |a: &ActivitySummary| a.unprotected_secs;
    let first = |a: &ActivitySummary| a.first_move_secs;
    let mean = |v: Vec<f64>| mean(&v);
    let unprotected_pct = (!with.is_empty()).then(|| {
        round(
            with.iter().filter(|(_, a)| un(a) >= 1.0).count() as f64 / with.len() as f64 * 100.0,
            1,
        )
    });
    StopBehaviour {
        n_activity: with.len() as u32,
        n_partial: with
            .iter()
            .filter(|(_, a)| a.coverage == crate::activity::Coverage::Partial)
            .count() as u32,
        n_stop: stopped.len() as u32,
        widened: vec![
            pick("widened", "Widened at least once", &stopped, &|a| {
                a.widened > 0
            }),
            pick("never_widened", "Never widened", &stopped, &|a| {
                a.widened == 0
            }),
        ],
        management: vec![
            pick("fixed", "Never moved", &stopped, &|a| a.stop_moves == 0),
            pick("tightened_once", "Tightened once", &stopped, &|a| {
                a.widened == 0 && a.tightened == 1
            }),
            pick("trailed", "Tightened twice or more", &stopped, &|a| {
                a.widened == 0 && a.tightened >= 2
            }),
            pick("widened", "Widened at least once", &stopped, &|a| {
                a.widened > 0
            }),
        ],
        breakeven: vec![
            pick("reached", "Reached the entry", &stopped, &reached),
            pick(
                "reached_stop",
                "… then stopped at or past it",
                &stopped,
                &|a| reached(a) && ended(a, EndedBy::Stop),
            ),
            pick(
                "reached_target",
                "… then the target filled",
                &stopped,
                &|a| reached(a) && ended(a, EndedBy::Target),
            ),
            pick(
                "reached_other",
                "… then closed otherwise",
                &stopped,
                &|a| reached(a) && !ended(a, EndedBy::Stop) && !ended(a, EndedBy::Target),
            ),
            pick("never", "Never reached the entry", &stopped, &|a| {
                !reached(a)
            }),
        ],
        unprotected: vec![
            pick("always", "A stop all along", &with, &|a| {
                !a.never_protected && un(a) < 1.0
            }),
            pick("lt10", "Without one under 10 s", &with, &|a| {
                !a.never_protected && (1.0..10.0).contains(&un(a))
            }),
            pick("lt60", "10 s to 1 min", &with, &|a| {
                !a.never_protected && (10.0..60.0).contains(&un(a))
            }),
            pick("lt300", "1 to 5 min", &with, &|a| {
                !a.never_protected && (60.0..300.0).contains(&un(a))
            }),
            pick("gt300", "Over 5 min", &with, &|a| {
                !a.never_protected && un(a) >= 300.0
            }),
            pick("never", "No stop at all", &with, &|a| a.never_protected),
        ],
        ended_by: vec![
            pick("stop", "Stop", &with, &|a| ended(a, EndedBy::Stop)),
            pick("target", "Target", &with, &|a| ended(a, EndedBy::Target)),
            pick("manual", "Closed by hand", &with, &|a| {
                ended(a, EndedBy::Manual)
            }),
            pick("liquidation", "Liquidated", &with, &|a| {
                ended(a, EndedBy::Liquidation)
            }),
            pick("unknown", "Closing order not known", &with, &|a| {
                a.ended_by.is_none()
            }),
        ],
        first_move: vec![
            pick("lt60", "Within a minute", &stopped, &|a| {
                first(a).is_some_and(|s| s < 60.0)
            }),
            pick("lt300", "1 to 5 minutes", &stopped, &|a| {
                first(a).is_some_and(|s| (60.0..300.0).contains(&s))
            }),
            pick("gt300", "After 5 minutes", &stopped, &|a| {
                first(a).is_some_and(|s| s >= 300.0)
            }),
            pick("never", "Never moved", &stopped, &|a| first(a).is_none()),
        ],
        avg_initial_risk: mean(stopped.iter().filter_map(|(_, a)| a.initial_risk).collect())
            .map(cents),
        avg_initial_risk_ticks: mean(
            stopped
                .iter()
                .filter_map(|(_, a)| a.initial_risk_ticks)
                .collect(),
        )
        .map(|v| round(v, 1)),
        avg_moves: mean(
            stopped
                .iter()
                .map(|(_, a)| f64::from(a.stop_moves))
                .collect(),
        )
        .map(|v| round(v, 2)),
        avg_unprotected_secs: mean(with.iter().map(|(_, a)| un(a)).collect()).map(|v| round(v, 1)),
        unprotected_pct,
        recorded_since: None,
    }
}

fn labelled<K: Ord + Clone>(
    m: BTreeMap<K, Vec<&JournalTrade>>,
    key: impl Fn(&K) -> (String, String),
) -> Vec<Bucket> {
    m.into_iter()
        .map(|(k, v)| {
            let (key, label) = key(&k);
            bucket(key, label, v)
        })
        .collect()
}

fn by_net(mut v: Vec<Bucket>) -> Vec<Bucket> {
    v.sort_by(|a, b| b.net.total_cmp(&a.net));
    v
}

fn ranged(
    closed: &[&JournalTrade],
    value: impl Fn(&JournalTrade) -> Option<f64>,
    ranges: &[(&str, f64, f64)],
) -> Vec<Bucket> {
    ranges
        .iter()
        .enumerate()
        .map(|(i, (label, lo, hi))| {
            bucket(
                i.to_string(),
                *label,
                closed
                    .iter()
                    .copied()
                    .filter(|t| value(t).is_some_and(|v| v >= *lo && v < *hi)),
            )
        })
        .collect()
}

fn breakdowns(
    closed: &[&JournalTrade],
    by_day: &BTreeMap<NaiveDate, Vec<&JournalTrade>>,
    days: Vec<Bucket>,
    tz: Tz,
    sessions: &[SessionDef],
) -> Breakdowns {
    let monday = |d: NaiveDate| d - Duration::days(i64::from(d.weekday().num_days_from_monday()));
    let week = labelled(grouped(closed, |t| vec![monday(t.trade_date)]), |d| {
        (
            d.to_string(),
            format!("Week of {} {}", d.day(), MONTHS[d.month0() as usize]),
        )
    });
    let month = labelled(
        grouped(closed, |t| {
            vec![(t.trade_date.year(), t.trade_date.month())]
        }),
        |(y, m)| {
            (
                format!("{y}-{m:02}"),
                format!("{} {y}", MONTHS[(*m - 1) as usize]),
            )
        },
    );
    let weekday = (0..7u32)
        .map(|i| {
            bucket(
                (i + 1).to_string(),
                WEEKDAYS[i as usize],
                closed
                    .iter()
                    .copied()
                    .filter(|t| t.trade_date.weekday().num_days_from_monday() == i),
            )
        })
        .filter(|b| b.n > 0 || b.key.parse::<u32>().is_ok_and(|k| k <= 5))
        .collect();
    let hour = labelled(grouped(closed, |t| vec![entry_hour(t, tz)]), |h| {
        (h.to_string(), format!("{h:02}:00"))
    });
    let session = sessions
        .iter()
        .map(|s| {
            bucket(
                s.name.clone(),
                s.name.clone(),
                closed.iter().copied().filter(|t| in_session(t, s)),
            )
        })
        .collect();
    let symbol = by_net(labelled(grouped(closed, |t| vec![t.symbol.clone()]), |s| {
        (s.clone(), s.clone())
    }));
    let side = labelled(
        grouped(closed, |t| vec![t.side == tessera_core::orders::Side::Buy]),
        |long| {
            if *long {
                ("long".into(), "Long".into())
            } else {
                ("short".into(), "Short".into())
            }
        },
    );
    let setup = by_net(labelled(
        grouped(closed, |t| {
            vec![(
                t.setup_id.clone().unwrap_or_default(),
                t.setup_name.clone().unwrap_or_else(|| "No setup".into()),
            )]
        }),
        |(id, name)| {
            (
                if id.is_empty() {
                    "none".into()
                } else {
                    id.clone()
                },
                name.clone(),
            )
        },
    ));
    let tag = by_net(labelled(
        grouped(closed, |t| {
            t.tags
                .iter()
                .map(|g| (g.id.clone(), g.name.clone()))
                .collect()
        }),
        |(id, name)| (id.clone(), name.clone()),
    ));
    let account = by_net(labelled(
        grouped(closed, |t| {
            vec![(t.account_id.clone(), t.account_name.clone())]
        }),
        |(id, name)| (id.clone(), name.clone()),
    ));
    let hold = ranged(
        closed,
        |t| t.hold_secs.map(|s| s as f64 / 60.0),
        &[
            ("Under 5 min", 0.0, 5.0),
            ("5–15 min", 5.0, 15.0),
            ("15–30 min", 15.0, 30.0),
            ("30 min–1 h", 30.0, 60.0),
            ("1–2 h", 60.0, 120.0),
            ("2 h or more", 120.0, f64::INFINITY),
        ],
    );
    let mut size = labelled(
        grouped(closed, |t| vec![(t.max_qty * 1000.0).round() as i64]),
        |q| {
            let q = *q as f64 / 1000.0;
            (
                q.to_string(),
                format!("{q} lot{}", if q == 1.0 { "" } else { "s" }),
            )
        },
    );
    if size.len() > 8 {
        size.sort_by_key(|b| std::cmp::Reverse(b.n));
        size.truncate(8);
        size.sort_by(|a, b| {
            a.key
                .parse::<f64>()
                .unwrap_or(0.0)
                .total_cmp(&b.key.parse::<f64>().unwrap_or(0.0))
        });
    }
    let r = ranged(
        closed,
        |t| t.r_multiple,
        &[
            ("Below −2R", f64::NEG_INFINITY, -2.0),
            ("−2R to −1R", -2.0, -1.0),
            ("−1R to 0", -1.0, 0.0),
            ("0 to 1R", 0.0, 1.0),
            ("1R to 2R", 1.0, 2.0),
            ("2R to 3R", 2.0, 3.0),
            ("3R or more", 3.0, f64::INFINITY),
        ],
    );
    let planned_rr = ranged(
        closed,
        |t| t.planned_rr,
        &[
            ("Under 1:1", 0.0, 1.0),
            ("1:1 to 2:1", 1.0, 2.0),
            ("2:1 to 3:1", 2.0, 3.0),
            ("3:1 or more", 3.0, f64::INFINITY),
        ],
    );
    let mut per_count: BTreeMap<usize, Vec<&JournalTrade>> = BTreeMap::new();
    for v in by_day.values() {
        per_count
            .entry(v.len())
            .or_default()
            .extend(v.iter().copied());
    }
    let trades_per_day = per_count
        .into_iter()
        .map(|(n, v)| {
            bucket(
                n.to_string(),
                format!("{n} trade{} a day", if n == 1 { "" } else { "s" }),
                v,
            )
        })
        .collect();
    let emotion = by_net(labelled(
        grouped(closed, |t| vec![t.emotion.map(|e| e.word()).unwrap_or("")]),
        |e| {
            if e.is_empty() {
                ("none".into(), "No mood noted".into())
            } else {
                (e.to_ascii_lowercase(), (*e).to_owned())
            }
        },
    ));
    let result = labelled(grouped(closed, |t| vec![result_order(t.result)]), |i| {
        let (k, l) = RESULTS[*i];
        (k.to_owned(), l.to_owned())
    });
    Breakdowns {
        day: days,
        week,
        month,
        weekday,
        hour,
        session,
        symbol,
        side,
        setup,
        tag,
        account,
        hold,
        size,
        r,
        planned_rr,
        trades_per_day,
        emotion,
        result,
    }
}

const RESULTS: [(&str, &str); 6] = [
    ("target", "Target"),
    ("trailed", "Trailed stop"),
    ("breakeven", "Breakeven stop"),
    ("manual", "Manual"),
    ("stop", "Stop"),
    ("open", "Open"),
];

fn result_order(r: TradeResult) -> usize {
    match r {
        TradeResult::Target => 0,
        TradeResult::Trailed => 1,
        TradeResult::Breakeven => 2,
        TradeResult::Manual => 3,
        TradeResult::Stop => 4,
        TradeResult::Open => 5,
    }
}
