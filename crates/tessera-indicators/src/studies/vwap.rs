use chrono::NaiveDate;
use tessera_core::Timestamp;
use tessera_market::orderflow::vwap::{SessionBar, session_vwap};
use tessera_script::ScriptError;

use super::natives::Inputs;
use super::{Drawn, Needs, Pulls, Study, columns, period_restart};
use crate::frame::{Changed, Period, Rows};

#[derive(Debug)]
pub(crate) struct Vwap {
    columns: Vec<String>,
    period: Period,
    bands: [Option<f64>; 3],
}

impl Vwap {
    pub fn of(i: Inputs<'_>) -> Self {
        let band = |n: usize| {
            i.flag(&format!("band{n}"), false)
                .then(|| i.num(&format!("mult{n}"), n as f64))
        };
        Self {
            columns: columns(&[
                "vwap", "upper1", "lower1", "upper2", "lower2", "upper3", "lower3",
            ]),
            period: Period::named(i.text("period")),
            bands: [band(1), band(2), band(3)],
        }
    }
}

impl Study for Vwap {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn needs(&self) -> Needs {
        Needs::Flow(Pulls::No)
    }

    fn restart(&self, rows: &Rows, changed: Changed) -> usize {
        period_restart(rows, changed, self.period)
    }

    fn period(&self) -> Option<Period> {
        Some(self.period)
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let n = rows.len();
        let mut start = from;
        let period_of = |k: usize| self.period.of_day(rows[k].day);
        while start < n {
            let period = period_of(start);
            let end = (start..n).find(|k| period_of(*k) != period).unwrap_or(n);
            if !rows.opens_period(start, self.period) {
                for c in cols.iter_mut().take(self.columns.len()) {
                    c[start..end].fill(f64::NAN);
                }
                start = end;
                continue;
            }
            let measured_before = (start..end.min(n - 1)).all(|k| {
                rows[k].volume <= 0.0 || rows[k].flow.sums.is_some_and(|s| s.volume > 0.0)
            });
            let bars: Vec<SessionBar> = (start..end)
                .map(|k| {
                    let r = &rows[k];
                    let unmeasured_forming = k + 1 == n && r.flow.sums.is_none() && measured_before;
                    SessionBar {
                        t: Timestamp(r.t),
                        session: NaiveDate::MIN,
                        high: r.high,
                        low: r.low,
                        close: r.close,
                        volume: if unmeasured_forming { 0.0 } else { r.volume },
                    }
                })
                .collect();
            let points = session_vwap(&bars, |t| {
                rows.find(t.0).ok().and_then(|i| rows[i].flow.sums)
            });
            for (k, p) in (start..end).zip(&points) {
                cols[0][k] = p.vwap;
                for (b, band) in self.bands.iter().enumerate() {
                    let (upper, lower) = match band {
                        Some(m) => (p.vwap + m * p.sd, p.vwap - m * p.sd),
                        None => (f64::NAN, f64::NAN),
                    };
                    cols[1 + 2 * b][k] = upper;
                    cols[2 + 2 * b][k] = lower;
                }
            }
            start = end;
        }
        Ok(None)
    }
}
