use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use tessera_core::market::Bar;
use tessera_core::session::SessionCalendar;
use tessera_core::{Qty, Timestamp};

/// Where cumulative delta starts again.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    ts_rs::TS,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum DeltaReset {
    /// At the start of each trading session.
    #[default]
    Session,
    /// Never: one running total from the first bar.
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeltaBar {
    pub t: Timestamp,
    pub volume: Qty,
    pub buy: Qty,
    pub sell: Qty,
    pub delta: Qty,
    pub cumulative: Qty,
}

#[derive(Clone, Debug)]
pub struct CumulativeDelta {
    calendar: SessionCalendar,
    reset: DeltaReset,
    session: Option<NaiveDate>,
    total: Qty,
}

impl CumulativeDelta {
    pub fn new(calendar: SessionCalendar, reset: DeltaReset) -> Self {
        Self {
            calendar,
            reset,
            session: None,
            total: Qty::ZERO,
        }
    }

    pub fn push(&mut self, t: Timestamp, volume: Qty, buy: Qty, sell: Qty) -> DeltaBar {
        if self.reset == DeltaReset::Session {
            let date = self.calendar.trade_date(t);
            if self.session != Some(date) {
                self.session = Some(date);
                self.total = Qty::ZERO;
            }
        }
        let delta = buy - sell;
        self.total = self.total + delta;
        DeltaBar {
            t,
            volume,
            buy,
            sell,
            delta,
            cumulative: self.total,
        }
    }

    pub fn push_bar(&mut self, b: &Bar) -> Option<DeltaBar> {
        let bv = b.bv?;
        Some(self.push(b.t, b.v, bv, b.v - bv))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::Price;

    fn bar(t: &str, v: i64, bv: Option<i64>) -> Bar {
        let p = Price::from_str("100").unwrap();
        Bar {
            t: Timestamp::parse(t).unwrap(),
            o: p,
            h: p,
            l: p,
            c: p,
            v: Qty::from(v),
            bv: bv.map(Qty::from),
        }
    }

    #[test]
    fn session_reset_by_hand() {
        let mut c = CumulativeDelta::new(SessionCalendar::CmeEquityIndex, DeltaReset::Session);
        let a = c
            .push_bar(&bar("2026-10-02T15:00:00-04:00", 100, Some(60)))
            .unwrap();
        let q = Qty::from;
        assert_eq!(
            (a.buy, a.sell, a.delta, a.cumulative),
            (q(60), q(40), q(20), q(20))
        );
        let b = c
            .push_bar(&bar("2026-10-02T16:00:00-04:00", 50, Some(10)))
            .unwrap();
        assert_eq!((b.delta, b.cumulative), (Qty::from(-30), Qty::from(-10)));
        assert_eq!(c.push_bar(&bar("2026-10-02T16:30:00-04:00", 5, None)), None);
        let n = c
            .push_bar(&bar("2026-10-04T18:00:00-04:00", 30, Some(25)))
            .unwrap();
        assert_eq!((n.delta, n.cumulative), (Qty::from(20), Qty::from(20)));

        let mut run = CumulativeDelta::new(SessionCalendar::CmeEquityIndex, DeltaReset::None);
        for (t, v, bv) in [
            ("2026-10-02T15:00:00-04:00", 100, 60),
            ("2026-10-02T16:00:00-04:00", 50, 10),
            ("2026-10-04T18:00:00-04:00", 30, 25),
        ] {
            run.push_bar(&bar(t, v, Some(bv)));
        }
        assert_eq!(run.total, Qty::from(10));
    }
}
