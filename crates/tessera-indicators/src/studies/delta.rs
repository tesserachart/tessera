use tessera_script::ScriptError;

use tessera_market::io::{DEFAULT_DAYS_TO_LOAD, MAX_DAYS_TO_LOAD};

use super::natives::Inputs;
use super::{Drawn, Needs, Pulls, Study, columns, session_restart};
use crate::frame::{Changed, Rows};

const NAN: f64 = f64::NAN;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reset {
    Session,
    Chart,
}

#[derive(Debug)]
pub(crate) struct Delta {
    columns: Vec<String>,
    reset: Reset,
    days_to_load: u32,
}

impl Delta {
    pub fn of(i: Inputs<'_>) -> Self {
        Self {
            columns: columns(&["delta", "volume", "open", "high", "low", "close", "candle"]),
            reset: match i.text("reset") {
                Some("chart") => Reset::Chart,
                _ => Reset::Session,
            },
            days_to_load: i
                .num("daysToLoad", f64::from(DEFAULT_DAYS_TO_LOAD))
                .clamp(1.0, f64::from(MAX_DAYS_TO_LOAD)) as u32,
        }
    }
}

impl Study for Delta {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn state(&self) -> usize {
        1
    }

    fn plot_key<'a>(&self, column: &'a str) -> &'a str {
        match column {
            "close" => "cvd",
            other => other,
        }
    }

    fn restart(&self, rows: &Rows, changed: Changed) -> usize {
        match self.reset {
            Reset::Chart => changed.at,
            Reset::Session => session_restart(rows, changed),
        }
    }

    fn needs(&self) -> Needs {
        Needs::Flow(Pulls::Sessions(self.days_to_load))
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let (delta, volume, open, high, low, close, candle, carry) = (0, 1, 2, 3, 4, 5, 6, 7);
        for i in from..rows.len() {
            let row = &rows[i];
            let starts = match self.reset {
                Reset::Chart => i == 0,
                Reset::Session => i == 0 || row.day != rows[i - 1].day,
            };
            let total = match (starts, self.reset) {
                (false, _) => cols[carry][i - 1],
                (true, Reset::Session) if i == 0 && rows.starts_cut() => NAN,
                (true, _) => 0.0,
            };
            let Some(f) = row.flow.sides.filter(|_| !total.is_nan()) else {
                for c in [delta, volume, open, high, low, close] {
                    cols[c][i] = NAN;
                }
                cols[candle][i] = 0.0;
                cols[carry][i] = total;
                continue;
            };
            let end = total + f.delta;
            cols[delta][i] = f.delta;
            cols[volume][i] = f.volume;
            cols[open][i] = total;
            cols[close][i] = end;
            if f.delta_high.is_nan() || f.delta_low.is_nan() {
                cols[candle][i] = 0.0;
                cols[high][i] = total.max(end);
                cols[low][i] = total.min(end);
            } else {
                cols[candle][i] = 1.0;
                cols[high][i] = total + 0.0_f64.max(f.delta_high).max(f.delta);
                cols[low][i] = total + 0.0_f64.min(f.delta_low).min(f.delta);
            }
            cols[carry][i] = end;
        }
        Ok(None)
    }
}
