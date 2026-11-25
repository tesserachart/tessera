use std::collections::BTreeMap;
use std::fmt::Write as _;

use chrono::DateTime;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::orders::Side;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use ts_rs::TS;

use crate::evaluate::Gates;
use crate::experiment::ExperimentState;
use crate::study::{Execution, Strategy, Study, StudyData};

const DAY: i64 = 86_400_000_000_000;

/// A closed trade to replay.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplayTrade {
    /// The exact instrument (`NQZ6.CME`).
    #[ts(type = "string")]
    pub instrument: InstrumentId,
    /// `buy` for a long, `sell` for a short.
    pub side: Side,
    /// Contracts.
    pub qty: f64,
    /// The entry.
    #[ts(type = "number")]
    pub opened_at: Timestamp,
    /// The exit.
    #[ts(type = "number")]
    pub closed_at: Timestamp,
}

/// `research.study_trades` input: trades to measure as a study.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyTradesInput {
    /// The study's name.
    pub name: String,
    /// What is expected of these trades; none: that they pay after costs and beat the same trades
    /// at random bars.
    #[serde(default)]
    pub hypothesis: Option<String>,
    /// Closed trades, from `journal.list_trades` (`instrument`, `side`, `qty`, `openedAt`,
    /// `closedAt`).
    pub trades: Vec<ReplayTrade>,
}

pub fn replay_study(input: &StudyTradesInput) -> Result<Study, String> {
    let mut by_instrument: BTreeMap<&InstrumentId, Vec<&ReplayTrade>> = BTreeMap::new();
    for t in input.trades.iter().filter(|t| t.closed_at > t.opened_at) {
        by_instrument.entry(&t.instrument).or_default().push(t);
    }
    let (instrument, mut trades) = by_instrument
        .into_iter()
        .max_by_key(|(_, ts)| ts.len())
        .ok_or("there are no closed trades to study")?;
    trades.sort_by_key(|t| t.opened_at);
    let first = trades[0].opened_at;
    let last = trades.iter().map(|t| t.closed_at).max().unwrap_or(first);
    let tf = timeframe_for(last.0 - first.0);
    let (kept, one_bar): (Vec<&ReplayTrade>, Vec<&ReplayTrade>) = trades
        .iter()
        .partition(|t| bar_of(t.opened_at, tf) != bar_of(t.closed_at, tf));
    if kept.is_empty() {
        return Err(format!(
            "every trade opened and closed inside one {tf} bar: there is nothing for bars to replay"
        ));
    }
    let other = input.trades.len() - trades.len();
    let hypothesis = input
        .hypothesis
        .clone()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "These {} journaled trades make money after costs, and more than the same trades placed at random bars.",
                kept.len()
            )
        });
    Ok(Study {
        id: String::new(),
        name: input.name.trim().to_owned(),
        family: format!("journal/{}", instrument.symbol()),
        hypothesis,
        notes: Some(notes(&kept, instrument, tf, other, one_bar.len())),
        data: StudyData {
            instrument: instrument.clone(),
            tf,
            from: Some(Timestamp(first.0 - DAY)),
            to: Some(Timestamp(last.0 + DAY)),
            rth_only: false,
            development_share: 0.5,
            levels: Vec::new(),
            window: None,
        },
        strategy: Strategy::Script {
            code: replay_code(&kept),
            inputs: serde_json::Map::new(),
            free_parameters: 0,
        },
        execution: Execution::default(),
        gates: Gates::default(),
        placebo_runs: 100,
        state: ExperimentState::Draft,
        generation: 1,
        manifest_hash: None,
        frozen_at: None,
        last_verdict: None,
        origin: None,
    })
}

fn timeframe_for(span: i64) -> Timeframe {
    match span / DAY {
        ..=45 => Timeframe::M1,
        46..=220 => Timeframe::M5,
        _ => Timeframe::M15,
    }
}

fn bar_of(t: Timestamp, tf: Timeframe) -> i64 {
    t.0.div_euclid(tf.nanos())
}

fn date(t: Timestamp) -> String {
    DateTime::from_timestamp_nanos(t.0)
        .format("%Y-%m-%d")
        .to_string()
}

fn notes(
    kept: &[&ReplayTrade],
    instrument: &InstrumentId,
    tf: Timeframe,
    other: usize,
    one_bar: usize,
) -> String {
    let first = kept.first().map_or(Timestamp(0), |t| t.opened_at);
    let last = kept.iter().map(|t| t.closed_at).max().unwrap_or(first);
    let mut s = format!(
        "Replays {} journaled trades of {instrument}, {} to {}, on {tf} bars: each enters at the open of the bar its entry fell in and exits at the open of the bar its exit fell in, so its prices differ from the fills by up to a bar. The placebo places the same trades at random bars.",
        kept.len(),
        date(first),
        date(last),
    );
    if other > 0 {
        let _ = write!(
            s,
            " Left out: {other} trade{} still open or on other instruments.",
            if other == 1 { "" } else { "s" }
        );
    }
    if one_bar > 0 {
        let _ = write!(
            s,
            " Left out: {one_bar} trade{} that opened and closed inside one bar.",
            if one_bar == 1 { "" } else { "s" }
        );
    }
    s
}

pub fn replay_code(trades: &[&ReplayTrade]) -> String {
    let mut rows = String::new();
    for t in trades {
        let sign = match t.side {
            Side::Buy => 1.0,
            Side::Sell => -1.0,
        };
        let _ = writeln!(
            rows,
            "  [{}, {}, {}],",
            t.opened_at.0.div_euclid(1_000_000_000),
            t.closed_at.0.div_euclid(1_000_000_000),
            sign * t.qty
        );
    }
    format!(
        r"export const strategy = {{ inputs: {{}} }};

const TRADES = [
{rows}];

function barOf(time, t) {{
  let lo = 0;
  let hi = time.length - 1;
  let at = -1;
  while (lo <= hi) {{
    const mid = (lo + hi) >> 1;
    if (time[mid] <= t) {{
      at = mid;
      lo = mid + 1;
    }} else {{
      hi = mid - 1;
    }}
  }}
  return at;
}}

export function positions(bars) {{
  const change = new Float64Array(bars.length);
  for (const [open, close, qty] of TRADES) {{
    const entry = barOf(bars.time, open);
    const exit = barOf(bars.time, close);
    if (entry < 1 || exit <= entry) continue;
    change[entry - 1] += qty;
    change[exit - 1] -= qty;
  }}
  const position = new Float64Array(bars.length).fill(NaN);
  let held = 0;
  for (let i = 0; i < bars.length; i++) {{
    if (change[i] === 0) continue;
    held += change[i];
    position[i] = held;
  }}
  return position;
}}
"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backtest::Bars;

    const MIN: i64 = 60_000_000_000;
    const T0: i64 = 1_759_399_980 * 1_000_000_000;

    fn trade(instrument: &str, side: Side, qty: f64, open_min: i64, close_min: i64) -> ReplayTrade {
        ReplayTrade {
            instrument: InstrumentId::new(instrument).unwrap(),
            side,
            qty,
            opened_at: Timestamp(T0 + open_min * MIN + 20_000_000_000),
            closed_at: Timestamp(T0 + close_min * MIN + 20_000_000_000),
        }
    }

    fn input(trades: Vec<ReplayTrade>) -> StudyTradesInput {
        StudyTradesInput {
            name: "Opening drive".into(),
            hypothesis: None,
            trades,
        }
    }

    fn minute_bars(n: usize) -> tessera_script::BarArrays {
        let mut b = Bars::default();
        for i in 0..n {
            b.time.push(T0 + i as i64 * MIN);
            for v in [&mut b.open, &mut b.high, &mut b.low, &mut b.close] {
                v.push(100.0 + i as f64);
            }
        }
        tessera_script::BarArrays {
            time: b.time.iter().map(|t| *t as f64 / 1e9).collect(),
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: vec![1.0; n],
            buy_volume: None,
            calendar: tessera_core::session::SessionCalendar::CmeEquityIndex,
        }
    }

    #[test]
    fn the_replay_holds_each_trade_from_its_entry_bar_to_its_exit_bar() {
        let s = replay_study(&input(vec![
            trade("NQZ6.CME", Side::Buy, 2.0, 10, 15),
            trade("NQZ6.CME", Side::Sell, 1.0, 30, 31),
            trade("NQZ6.CME", Side::Buy, 1.0, 11, 13),
        ]))
        .unwrap();
        let Strategy::Script { code, .. } = &s.strategy else {
            panic!("a replay is a script");
        };
        let d = tessera_script::run_strategy(
            code,
            &minute_bars(60),
            &tessera_script::StudyColumns {
                session: vec![0.0; 60],
                levels: Vec::new(),
            },
            &serde_json::Map::new(),
            tessera_script::Limits::STUDY,
        )
        .unwrap();
        let held: Vec<(usize, f64)> = d
            .position
            .iter()
            .enumerate()
            .filter(|(_, p)| p.is_finite())
            .map(|(i, p)| (i, *p))
            .collect();
        assert_eq!(
            held,
            vec![
                (9, 2.0),
                (10, 3.0),
                (12, 2.0),
                (14, 0.0),
                (29, -1.0),
                (30, 0.0)
            ],
            "overlapping trades add up"
        );
        assert_eq!(s.data.tf, Timeframe::M1);
        assert_eq!(s.data.instrument.as_str(), "NQZ6.CME");
        assert!(
            s.hypothesis
                .starts_with("These 3 journaled trades make money")
        );
    }

    #[test]
    fn the_most_traded_instrument_is_studied_and_the_rest_are_named_as_left_out() {
        let s = replay_study(&input(vec![
            trade("NQZ6.CME", Side::Buy, 1.0, 10, 15),
            trade("NQZ6.CME", Side::Buy, 1.0, 20, 25),
            trade("ESZ6.CME", Side::Buy, 1.0, 20, 25),
            trade("NQZ6.CME", Side::Buy, 1.0, 40, 40),
        ]))
        .unwrap();
        assert_eq!(s.data.instrument.as_str(), "NQZ6.CME");
        let notes = s.notes.unwrap();
        assert!(notes.contains("Replays 2 journaled trades"), "{notes}");
        assert!(
            notes.contains("2 trades still open or on other instruments"),
            "{notes}"
        );
    }

    fn inside_one_bar() -> ReplayTrade {
        let mut t = trade("NQZ6.CME", Side::Buy, 1.0, 20, 20);
        t.closed_at = Timestamp(t.closed_at.0 + 30_000_000_000);
        t
    }

    #[test]
    fn trades_inside_one_bar_are_left_out_and_none_left_is_refused() {
        let s = replay_study(&input(vec![
            trade("NQZ6.CME", Side::Buy, 1.0, 10, 15),
            inside_one_bar(),
        ]))
        .unwrap();
        let notes = s.notes.unwrap();
        assert!(
            notes.contains("1 trade that opened and closed inside one bar"),
            "{notes}"
        );
        assert!(!notes.contains("still open"), "{notes}");
        let e = replay_study(&input(vec![inside_one_bar()])).unwrap_err();
        assert!(e.contains("inside one 1m bar"), "{e}");
        assert!(replay_study(&input(vec![])).is_err());
    }

    #[test]
    fn a_long_history_reads_coarser_bars() {
        let mut far = trade("NQZ6.CME", Side::Buy, 1.0, 0, 30);
        far.closed_at = Timestamp(far.opened_at.0 + 100 * DAY);
        let s = replay_study(&input(vec![trade("NQZ6.CME", Side::Buy, 1.0, 0, 30), far])).unwrap();
        assert_eq!(s.data.tf, Timeframe::M5);
    }
}
