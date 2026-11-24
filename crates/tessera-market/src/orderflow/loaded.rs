use tessera_core::Timestamp;
use tessera_core::session::SessionCalendar;
use tessera_store::ticks::Span;
use tessera_tools::ToolError;

use crate::hub::{Gaps, Pulls};
use crate::io::{DEFAULT_DAYS_TO_LOAD, MAX_DAYS_TO_LOAD, PrintsLoaded};
use crate::saved::by_trade_date;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DaysToLoad(u32);

impl DaysToLoad {
    pub const DEFAULT: Self = Self(DEFAULT_DAYS_TO_LOAD);

    pub fn of(asked: Option<u32>) -> Result<Self, ToolError> {
        match asked {
            None => Ok(Self::DEFAULT),
            Some(n @ 1..=MAX_DAYS_TO_LOAD) => Ok(Self(n)),
            Some(_) => Err(ToolError::invalid_input(format!(
                "daysToLoad must be 1..={MAX_DAYS_TO_LOAD}"
            ))),
        }
    }

    pub fn sessions(self) -> u32 {
        self.0
    }

    pub fn floor(self, calendar: SessionCalendar, now: Timestamp) -> Timestamp {
        calendar
            .last_sessions(now, self.0 as usize)
            .first()
            .map_or(now, |s| s.open)
    }

    pub fn pulls(self, calendar: SessionCalendar, now: Timestamp) -> Pulls {
        Pulls::Since(self.floor(calendar, now))
    }
}

pub fn loaded(calendar: SessionCalendar, gaps: &Gaps, window: Span, refused: bool) -> PrintsLoaded {
    let mut sessions = 0;
    let mut held = 0;
    for (_, part) in by_trade_date(calendar, window) {
        let open: Vec<Span> = crate::hub::session_time(calendar, part);
        if open.is_empty() {
            continue;
        }
        sessions += 1;
        if !open.iter().any(|s| gaps.touches(*s)) {
            held += 1;
        }
    }
    PrintsLoaded {
        sessions,
        held,
        refused: refused && held < sessions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tessera_core::time::local_to_timestamp;

    const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;

    fn at(d: u32, h: u32, m: u32) -> Timestamp {
        let (month, day) = if d > 20 { (9, d) } else { (10, d) };
        local_to_timestamp(
            CAL.tz(),
            NaiveDate::from_ymd_opt(2026, month, day).unwrap(),
            h,
            m,
        )
    }

    #[test]
    fn two_days_load_from_the_open_of_the_session_before_this_one() {
        let friday = at(2, 14, 42);
        assert_eq!(DaysToLoad::DEFAULT.floor(CAL, friday), at(30, 18, 0));
        let saturday = at(3, 12, 0);
        assert_eq!(
            DaysToLoad::DEFAULT.floor(CAL, saturday),
            at(30, 18, 0),
            "closed, the current session is the last one"
        );
        assert_eq!(
            DaysToLoad::of(Some(1)).unwrap().floor(CAL, friday),
            at(1, 18, 0)
        );
        assert!(DaysToLoad::of(Some(0)).is_err());
        assert!(DaysToLoad::of(Some(MAX_DAYS_TO_LOAD + 1)).is_err());
    }

    #[test]
    fn a_session_is_held_when_no_gap_touches_its_open_hours() {
        let window = Span::new(at(30, 18, 0).0, at(2, 14, 42).0);
        let none = Gaps::default();
        assert_eq!(
            loaded(CAL, &none, window, false),
            PrintsLoaded {
                sessions: 2,
                held: 2,
                refused: false
            }
        );
        let hole = Gaps::in_session(Some(CAL), [Span::new(at(1, 10, 0).0, at(1, 10, 30).0)]);
        assert_eq!(
            loaded(CAL, &hole, window, true),
            PrintsLoaded {
                sessions: 2,
                held: 1,
                refused: true
            }
        );
        let maintenance = Span::new(at(1, 17, 0).0, at(1, 18, 0).0);
        assert_eq!(loaded(CAL, &none, maintenance, true).sessions, 0);
    }
}
