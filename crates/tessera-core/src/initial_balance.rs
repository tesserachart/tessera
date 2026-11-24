use chrono::NaiveDate;
use rust_decimal::Decimal;

use crate::market::Bar;
use crate::money::Price;
use crate::session::{SessionWindow, TradingSession};
use crate::time::{NANOS_PER_MINUTE, Timestamp};

pub const INITIAL_BALANCE_MINUTES: [u32; 2] = [30, 60];
pub const DEFAULT_INITIAL_BALANCE_MINUTES: u32 = 30;
pub const MINUTES_SETTING: &str = "chart.initialBalanceMinutes";

pub fn minutes_setting(value: Option<&serde_json::Value>) -> u32 {
    value
        .and_then(serde_json::Value::as_u64)
        .and_then(|m| u32::try_from(m).ok())
        .filter(|m| INITIAL_BALANCE_MINUTES.contains(m))
        .unwrap_or(DEFAULT_INITIAL_BALANCE_MINUTES)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OpensAt {
    #[default]
    Regular,
    Session,
}

impl OpensAt {
    pub fn named(name: Option<&str>) -> Self {
        match name {
            Some("session") => OpensAt::Session,
            _ => OpensAt::Regular,
        }
    }

    pub fn within(self, session: &TradingSession) -> SessionWindow {
        match (self, session.rth) {
            (OpensAt::Regular, Some(rth)) => rth,
            _ => SessionWindow {
                start: session.open,
                end: session.close,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitialBalance {
    pub trade_date: NaiveDate,
    pub minutes: u32,
    pub start: Timestamp,
    pub end: Timestamp,
    pub high: Price,
    pub low: Price,
    pub through: Timestamp,
}

impl InitialBalance {
    pub fn measure(
        session: &TradingSession,
        minutes: u32,
        bars: &[Bar],
        bar_nanos: i64,
        now: Timestamp,
    ) -> Option<InitialBalance> {
        Self::measure_in(session, session.rth?, minutes, bars, bar_nanos, now)
    }

    pub fn measure_in(
        session: &TradingSession,
        within: SessionWindow,
        minutes: u32,
        bars: &[Bar],
        bar_nanos: i64,
        now: Timestamp,
    ) -> Option<InitialBalance> {
        let start = within.start;
        let end = Timestamp((start.0 + i64::from(minutes) * NANOS_PER_MINUTE).min(within.end.0));
        let through = now.min(end);
        let inside = |b: &&Bar| b.t >= start && b.t < through && b.t.0 + bar_nanos <= end.0;
        let (high, low) = bars.iter().filter(inside).fold(None, |hl, b| match hl {
            None => Some((b.h, b.l)),
            Some((h, l)) => Some((h.max(b.h), l.min(b.l))),
        })?;
        Some(InitialBalance {
            trade_date: session.trade_date,
            minutes,
            start,
            end,
            high,
            low,
            through,
        })
    }

    pub fn complete(&self) -> bool {
        self.through >= self.end
    }

    pub fn minutes_in(&self) -> i64 {
        (self.through.0 - self.start.0) / NANOS_PER_MINUTE
    }

    pub fn range(&self) -> Price {
        Price(self.high.0 - self.low.0)
    }

    pub fn mid(&self) -> Price {
        Price((self.high.0 + self.low.0) / Decimal::TWO)
    }

    pub fn above(&self, share_of_range: Decimal) -> Price {
        Price(self.high.0 + self.range().0 * share_of_range)
    }

    pub fn below(&self, share_of_range: Decimal) -> Price {
        Price(self.low.0 - self.range().0 * share_of_range)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::Qty;
    use crate::session::SessionCalendar;
    use chrono::NaiveDate;

    const MIN: i64 = NANOS_PER_MINUTE;

    fn p(v: &str) -> Price {
        Price(v.parse().unwrap())
    }

    fn bar(t: Timestamp, h: &str, l: &str) -> Bar {
        Bar {
            t,
            o: p(l),
            h: p(h),
            l: p(l),
            c: p(h),
            v: Qty::from(10),
            bv: None,
        }
    }

    fn friday() -> TradingSession {
        SessionCalendar::UsEquities
            .session(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap())
            .unwrap()
    }

    fn tape(session: &TradingSession) -> Vec<Bar> {
        let open = session.rth.unwrap().start;
        let at = |m: i64| Timestamp(open.0 + m * MIN);
        let mut bars = vec![bar(at(-5), "20990.00", "20900.00")];
        for m in 0..90 {
            let (h, l) = match m {
                3 => ("20712.50", "20650.00"),
                17 => ("20660.25", "20601.75"),
                45 => ("20750.00", "20640.00"),
                59 => ("20700.00", "20580.25"),
                _ => ("20655.00", "20640.00"),
            };
            bars.push(bar(at(m), h, l));
        }
        bars
    }

    #[test]
    fn the_first_thirty_minutes_after_the_rth_open_set_the_balance() {
        let s = friday();
        let open = s.rth.unwrap().start;
        let ib =
            InitialBalance::measure(&s, 30, &tape(&s), MIN, Timestamp(open.0 + 120 * MIN)).unwrap();
        assert_eq!(
            ib.start,
            Timestamp::parse("2026-10-02T09:30:00-04:00").unwrap()
        );
        assert_eq!(
            ib.end,
            Timestamp::parse("2026-10-02T10:00:00-04:00").unwrap()
        );
        assert_eq!((ib.high, ib.low), (p("20712.50"), p("20601.75")));
        assert_eq!(ib.mid(), p("20657.125"));
        assert_eq!(ib.range(), p("110.75"));
        assert_eq!(ib.above(Decimal::new(5, 1)), p("20767.875"));
        assert_eq!(ib.below(Decimal::ONE), p("20491.00"));
        assert!(ib.complete());
        assert_eq!(ib.minutes_in(), 30);
    }

    #[test]
    fn a_sixty_minute_window_takes_the_whole_hour() {
        let s = friday();
        let open = s.rth.unwrap().start;
        let ib =
            InitialBalance::measure(&s, 60, &tape(&s), MIN, Timestamp(open.0 + 120 * MIN)).unwrap();
        assert_eq!((ib.high, ib.low), (p("20750.00"), p("20580.25")));
        assert!(ib.complete());
    }

    #[test]
    fn a_window_still_running_measures_what_has_traded_so_far() {
        let s = friday();
        let open = s.rth.unwrap().start;
        let now = Timestamp(open.0 + 12 * MIN + 30 * 1_000_000_000);
        let ib = InitialBalance::measure(&s, 30, &tape(&s), MIN, now).unwrap();
        assert_eq!((ib.high, ib.low), (p("20712.50"), p("20640.00")));
        assert!(!ib.complete());
        assert_eq!(ib.minutes_in(), 12);
        assert_eq!(ib.end, Timestamp(open.0 + 30 * MIN));
        assert!(InitialBalance::measure(&s, 30, &tape(&s), MIN, open).is_none());
    }

    #[test]
    fn bars_longer_than_the_window_cannot_measure_it() {
        let s = friday();
        let open = s.rth.unwrap().start;
        let hourly = vec![bar(open, "20750.00", "20580.25")];
        let later = Timestamp(open.0 + 180 * MIN);
        assert!(InitialBalance::measure(&s, 30, &hourly, 60 * MIN, later).is_none());
        assert!(InitialBalance::measure(&s, 60, &hourly, 60 * MIN, later).is_some());
    }

    #[test]
    fn the_window_setting_takes_thirty_or_sixty_minutes() {
        assert_eq!(minutes_setting(Some(&serde_json::json!(60))), 60);
        assert_eq!(minutes_setting(Some(&serde_json::json!(30))), 30);
        assert_eq!(minutes_setting(Some(&serde_json::json!(45))), 30);
        assert_eq!(minutes_setting(Some(&serde_json::json!("60"))), 30);
        assert_eq!(minutes_setting(None), 30);
    }

    #[test]
    fn a_window_from_the_session_open_measures_the_overnight_open() {
        let s = friday();
        let globex = s.open;
        let at = |m: i64| Timestamp(globex.0 + m * MIN);
        let bars = vec![
            bar(at(0), "20500.00", "20490.00"),
            bar(at(1), "20510.00", "20495.00"),
            bar(at(2), "20999.00", "20000.00"),
        ];
        let within = OpensAt::Session.within(&s);
        let ib = InitialBalance::measure_in(&s, within, 2, &bars, MIN, s.close).unwrap();
        assert_eq!((ib.start, ib.end), (globex, at(2)));
        assert_eq!((ib.high, ib.low), (p("20510.00"), p("20490.00")));
        assert_eq!(OpensAt::Regular.within(&s), s.rth.unwrap());
    }

    #[test]
    fn a_market_without_a_regular_session_opens_at_its_session_open() {
        let mut s = friday();
        s.rth = None;
        assert_eq!(OpensAt::Regular.within(&s).start, s.open);
        assert_eq!(OpensAt::named(Some("session")), OpensAt::Session);
        assert_eq!(OpensAt::named(Some("rth")), OpensAt::Regular);
    }

    #[test]
    fn a_window_never_runs_past_the_close_it_opens_in() {
        let s = friday();
        let rth = s.rth.unwrap();
        let bars = vec![bar(rth.start, "20750.00", "20580.25")];
        let ib = InitialBalance::measure(&s, 24 * 60, &bars, MIN, s.close).unwrap();
        assert_eq!(ib.end, rth.end);
    }

    #[test]
    fn a_market_without_a_regular_session_has_no_initial_balance() {
        let mut s = friday();
        s.rth = None;
        assert!(InitialBalance::measure(&s, 30, &tape(&friday()), MIN, s.close).is_none());
    }
}
