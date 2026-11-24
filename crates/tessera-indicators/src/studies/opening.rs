use rust_decimal::Decimal;
use tessera_core::Timestamp;
use tessera_core::initial_balance::{InitialBalance, OpensAt};
use tessera_core::market::Bar;
use tessera_core::session::{SessionWindow, TradingSession};
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_script::ScriptError;

use super::natives::Inputs;
use super::{Drawn, Study, columns, session_restart};
use crate::frame::{BarKind, Changed, Opening, Period, Rows, bar_of};

const NAN: f64 = f64::NAN;
const KEYS: [&str; 9] = [
    "orHigh", "orLow", "ibHigh", "ibLow", "ibMid", "up50", "up100", "down50", "down100",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Extends {
    Balance,
    Range,
}

#[derive(Debug)]
pub(crate) struct OpeningRange {
    columns: Vec<String>,
    opening: Opening,
    extends: Extends,
}

struct Measured {
    range: Option<InitialBalance>,
    balance: Option<InitialBalance>,
}

struct Source {
    bars: Vec<Bar>,
    bar_nanos: i64,
    through: i64,
}

impl OpeningRange {
    pub fn of(i: Inputs<'_>) -> Self {
        let minutes = |key: &str, fallback: f64| i.len(key, fallback, 1).min(24 * 60) as u32;
        Self {
            columns: columns(&KEYS),
            opening: Opening {
                opens_at: OpensAt::named(i.text("open")),
                minutes: [minutes("minutes", 15.0), minutes("ib", 60.0)],
            },
            extends: match i.text("extensions") {
                Some("range") => Extends::Range,
                _ => Extends::Balance,
            },
        }
    }

    fn source(
        &self,
        rows: &Rows,
        block: std::ops::Range<usize>,
        session: &TradingSession,
    ) -> Option<Source> {
        let grid = rows.grid();
        let window = self.opening.window(session);
        let inside = |t: i64| t >= window.start.0 && t < window.end.0;
        if self.opening.read_from_rows(grid, session) {
            let BarKind::Time(tf) = grid.bars else {
                return None;
            };
            let bars = block
                .filter(|k| inside(rows[*k].t))
                .filter_map(|k| bar_of(&rows[k]))
                .collect();
            return Some(Source {
                bars,
                bar_nanos: tf.nanos(),
                through: i64::MAX,
            });
        }
        let held = rows.openings().get(window.start)?;
        Some(Source {
            bars: held.bars.clone(),
            bar_nanos: NANOS_PER_MINUTE,
            through: held.through,
        })
    }

    fn measure(
        &self,
        session: &TradingSession,
        within: SessionWindow,
        source: &Source,
        now: i64,
    ) -> Measured {
        let [range, balance] = self.opening.minutes.map(|m| {
            InitialBalance::measure_in(
                session,
                within,
                m,
                &source.bars,
                source.bar_nanos,
                Timestamp(now.min(source.through)),
            )
        });
        Measured { range, balance }
    }

    fn write(&self, cols: &mut [Vec<f64>], k: usize, m: &Measured) {
        let f = |p: tessera_core::Price| p.to_f64();
        let half = Decimal::new(5, 1);
        let base = match self.extends {
            Extends::Balance => m.balance,
            Extends::Range => m.range,
        }
        .filter(InitialBalance::complete);
        let values = [
            m.range.map(|r| f(r.high)),
            m.range.map(|r| f(r.low)),
            m.balance.map(|b| f(b.high)),
            m.balance.map(|b| f(b.low)),
            m.balance.map(|b| f(b.mid())),
            base.map(|b| f(b.above(half))),
            base.map(|b| f(b.above(Decimal::ONE))),
            base.map(|b| f(b.below(half))),
            base.map(|b| f(b.below(Decimal::ONE))),
        ];
        for (c, v) in cols.iter_mut().zip(values) {
            c[k] = v.unwrap_or(NAN);
        }
    }

    fn row_end(rows: &Rows, k: usize) -> i64 {
        match rows.grid().bars {
            BarKind::Time(tf) => rows[k].t.saturating_add(tf.nanos()),
            BarKind::Print(_) => match k + 1 < rows.len() {
                true => rows[k + 1].t,
                false => i64::MAX,
            },
        }
    }
}

impl Study for OpeningRange {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn restart(&self, rows: &Rows, changed: Changed) -> usize {
        session_restart(rows, changed)
    }

    fn period(&self) -> Option<Period> {
        Some(Period::Session)
    }

    fn opening(&self) -> Option<Opening> {
        Some(self.opening)
    }

    fn run(
        &self,
        rows: &Rows,
        cols: &mut [Vec<f64>],
        from: usize,
    ) -> Result<Option<Drawn>, ScriptError> {
        let n = rows.len();
        let mut a = from;
        while a < n {
            let day = rows[a].day;
            let b = (a..n).find(|k| rows[*k].day != day).unwrap_or(n);
            for c in cols.iter_mut().take(KEYS.len()) {
                c[a..b].fill(NAN);
            }
            let session = crate::frame::date_of(day).and_then(|d| rows.grid().calendar.session(d));
            if let Some(session) = session
                && let Some(source) = self.source(rows, a..b, &session)
            {
                let within = self.opening.opens_at.within(&session);
                let latest = Self::row_end(rows, b - 1);
                let measured = self.measure(&session, within, &source, latest);
                for k in (a..b).filter(|k| Self::row_end(rows, *k) > within.start.0) {
                    self.write(cols, k, &measured);
                }
            }
            a = b;
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use serde_json::{Map, Value, json};
    use tessera_core::session::SessionCalendar;
    use tessera_core::{Timeframe, Timestamp};
    use tessera_market::io::SessionFilter;
    use tessera_protocol::compact::CompactBar;

    use super::*;
    use crate::frame::{Grid, Minutes, Span};

    const MIN: i64 = NANOS_PER_MINUTE;

    fn friday() -> TradingSession {
        SessionCalendar::CmeEquityIndex
            .session(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap())
            .unwrap()
    }

    fn grid(tf: Timeframe) -> Grid {
        Grid {
            calendar: SessionCalendar::CmeEquityIndex,
            bars: BarKind::Time(tf),
            session: SessionFilter::All,
        }
    }

    fn study(inputs: Value) -> OpeningRange {
        let map: Map<String, Value> = inputs.as_object().cloned().unwrap_or_default();
        OpeningRange::of(Inputs(&map))
    }

    fn minute_tape() -> Vec<CompactBar> {
        let open = friday().rth.unwrap().start.0;
        let mut bars = Vec::new();
        for m in -30..120_i64 {
            let (h, l) = match m {
                -10 => (21000.0, 20000.0),
                3 => (20712.5, 20650.0),
                17 => (20660.25, 20601.75),
                45 => (20750.0, 20640.0),
                59 => (20700.0, 20580.25),
                100 => (20900.0, 20400.0),
                _ => (20655.0, 20640.0),
            };
            bars.push(CompactBar(open + m * MIN, l, h, l, h, 10.0, None));
        }
        bars
    }

    fn rows_of(tf: Timeframe, bars: &[CompactBar]) -> Rows {
        let mut frame = crate::frame::Frame::new(grid(tf));
        frame.put_bars(Span::everything(), bars);
        frame.rows().clone()
    }

    fn hourly(minutes: &[CompactBar]) -> Vec<CompactBar> {
        let cal = SessionCalendar::CmeEquityIndex;
        let mut out: Vec<CompactBar> = Vec::new();
        for b in minutes {
            let t = cal.bucket_start(Timestamp(b.0), Timeframe::H1).0;
            match out.last_mut() {
                Some(h) if h.0 == t => {
                    h.2 = h.2.max(b.2);
                    h.3 = h.3.min(b.3);
                    h.4 = b.4;
                }
                _ => out.push(CompactBar(t, b.1, b.2, b.3, b.4, b.5, None)),
            }
        }
        out
    }

    fn run(s: &OpeningRange, rows: &Rows) -> Vec<Vec<f64>> {
        let mut cols = vec![vec![NAN; rows.len()]; KEYS.len()];
        s.run(rows, &mut cols, 0).unwrap();
        cols
    }

    fn at(rows: &Rows, cols: &[Vec<f64>], t: i64) -> [f64; 9] {
        let k = rows.find(t).unwrap();
        std::array::from_fn(|c| cols[c][k])
    }

    #[test]
    fn one_minute_bars_hold_each_level_flat_from_the_window_open() {
        let rows = rows_of(Timeframe::M1, &minute_tape());
        let s = study(json!({}));
        let cols = run(&s, &rows);
        let open = friday().rth.unwrap().start.0;
        let before = at(&rows, &cols, open - 10 * MIN);
        assert!(before.iter().all(|v| v.is_nan()));
        let held = at(&rows, &cols, open + 110 * MIN);
        for m in 0..120 {
            let row = at(&rows, &cols, open + m * MIN);
            assert_eq!(
                row.map(f64::to_bits),
                held.map(f64::to_bits),
                "minute {m}: every level is one value across the session"
            );
        }
        assert_eq!((held[0], held[1]), (20712.5, 20640.0));
        assert_eq!((held[2], held[3]), (20750.0, 20580.25));
        assert_eq!(held[4], 20665.125);
        let range = 20750.0 - 20580.25;
        assert_eq!(held[5], 20750.0 + range / 2.0);
        assert_eq!(held[6], 20750.0 + range);
        assert_eq!(held[7], 20580.25 - range / 2.0);
        assert_eq!(held[8], 20580.25 - range);
    }

    #[test]
    fn extensions_of_the_opening_range_extend_its_own_width() {
        let rows = rows_of(Timeframe::M1, &minute_tape());
        let s = study(json!({"extensions": "range", "minutes": 30}));
        let cols = run(&s, &rows);
        let open = friday().rth.unwrap().start.0;
        let held = at(&rows, &cols, open + 40 * MIN);
        assert_eq!((held[0], held[1]), (20712.5, 20601.75));
        assert_eq!(held[6], 20712.5 + (20712.5 - 20601.75));
        assert_eq!(at(&rows, &cols, open)[6], held[6]);
    }

    #[test]
    fn a_window_still_trading_holds_its_levels_so_far_flat_with_no_extensions() {
        let open = friday().rth.unwrap().start.0;
        let tape: Vec<CompactBar> = minute_tape()
            .into_iter()
            .filter(|b| b.0 < open + 40 * MIN)
            .collect();
        let rows = rows_of(Timeframe::M1, &tape);
        let cols = run(&study(json!({})), &rows);
        let now = at(&rows, &cols, open + 39 * MIN);
        assert_eq!(now[..4], [20712.5, 20640.0, 20712.5, 20601.75]);
        assert!(
            now[5..].iter().all(|v| v.is_nan()),
            "no extensions while the balance forms"
        );
        for m in 0..40 {
            assert_eq!(
                at(&rows, &cols, open + m * MIN).map(f64::to_bits),
                now.map(f64::to_bits),
                "minute {m}"
            );
        }
    }

    #[test]
    fn five_minute_bars_measure_what_one_minute_bars_measure() {
        let tape = minute_tape();
        let cal = SessionCalendar::CmeEquityIndex;
        let mut fives: Vec<CompactBar> = Vec::new();
        for b in &tape {
            let t = cal.bucket_start(Timestamp(b.0), Timeframe::M5).0;
            match fives.last_mut() {
                Some(f) if f.0 == t => {
                    f.2 = f.2.max(b.2);
                    f.3 = f.3.min(b.3);
                }
                _ => fives.push(CompactBar(t, b.1, b.2, b.3, b.4, b.5, None)),
            }
        }
        let rows = rows_of(Timeframe::M5, &fives);
        let s = study(json!({}));
        assert!(s.opening.read_from_rows(rows.grid(), &friday()));
        let cols = run(&s, &rows);
        let open = friday().rth.unwrap().start.0;
        let held = at(&rows, &cols, open + 90 * MIN);
        assert_eq!(held[..4], [20712.5, 20640.0, 20750.0, 20580.25]);
    }

    #[test]
    fn hourly_bars_draw_nothing_until_the_minutes_of_the_window_are_read() {
        let tape = minute_tape();
        let mut rows = rows_of(Timeframe::H1, &hourly(&tape));
        let s = study(json!({}));
        assert!(!s.opening.read_from_rows(rows.grid(), &friday()));
        assert!(run(&s, &rows).iter().all(|c| c.iter().all(|v| v.is_nan())));

        let open = friday().rth.unwrap().start.0;
        let end = open + 60 * MIN;
        let asks = rows.openings().asks(
            &rows.sessions(),
            &[s.opening],
            rows.grid(),
            end + 3600 * 1_000_000_000,
        );
        assert_eq!(asks.len(), 1);
        assert_eq!((asks[0].start, asks[0].end), (open, end));

        let bars = tape
            .iter()
            .filter(|b| b.0 >= open && b.0 < end)
            .map(|b| tessera_core::market::Bar {
                t: Timestamp(b.0),
                o: tessera_core::Price::from_f64(b.1).unwrap(),
                h: tessera_core::Price::from_f64(b.2).unwrap(),
                l: tessera_core::Price::from_f64(b.3).unwrap(),
                c: tessera_core::Price::from_f64(b.4).unwrap(),
                v: tessera_core::Qty::ZERO,
                bv: None,
            })
            .collect();
        rows.openings_mut().put(
            open,
            Minutes {
                end,
                through: end,
                bars,
            },
        );
        let cols = run(&s, &rows);
        let nine = SessionCalendar::CmeEquityIndex
            .bucket_start(Timestamp(open), Timeframe::H1)
            .0;
        let first = at(&rows, &cols, nine);
        let later = at(&rows, &cols, nine + 2 * 3600 * 1_000_000_000);
        assert_eq!(later[..4], [20712.5, 20640.0, 20750.0, 20580.25]);
        assert_eq!(first.map(f64::to_bits), later.map(f64::to_bits));
        assert!(
            rows.openings()
                .asks(&rows.sessions(), &[s.opening], rows.grid(), end + MIN)
                .is_empty()
        );
    }

    #[test]
    fn a_market_without_a_regular_session_opens_its_range_at_the_session_open() {
        let cal = SessionCalendar::CmeGlobex;
        let session = cal
            .session(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap())
            .unwrap();
        let open = session.open.0;
        let bars: Vec<CompactBar> = (0..30_i64)
            .map(|m| {
                let h = if m == 4 { 101.0 } else { 100.5 };
                CompactBar(open + m * MIN, 100.0, h, 99.0, 100.0, 1.0, None)
            })
            .collect();
        let mut frame = crate::frame::Frame::new(Grid {
            calendar: cal,
            bars: BarKind::Time(Timeframe::M1),
            session: SessionFilter::All,
        });
        frame.put_bars(Span::everything(), &bars);
        let rows = frame.rows().clone();
        let cols = run(&study(json!({})), &rows);
        let held = at(&rows, &cols, open + 20 * MIN);
        assert_eq!((held[0], held[1]), (101.0, 99.0));
    }
}
