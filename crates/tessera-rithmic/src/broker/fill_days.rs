use chrono::{Datelike, Days, NaiveDate};
use tessera_core::session::SessionCalendar;
use tessera_core::time::Timestamp;

// Rithmic numbers fill history by CME trade date in Chicago, and answers at most 30 days of it per request.
const RITHMIC_DATES: SessionCalendar = SessionCalendar::CmeGlobex;
pub(super) const WINDOW_DAYS: u64 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TradeDays {
    pub first: NaiveDate,
    pub last: NaiveDate,
}

impl TradeDays {
    pub fn count(self) -> u64 {
        u64::try_from((self.last - self.first).num_days() + 1).unwrap_or(0)
    }

    pub fn windows(self) -> Vec<TradeDays> {
        let mut out = Vec::new();
        let mut first = self.first;
        while first <= self.last {
            let last = (first + Days::new(WINDOW_DAYS - 1)).min(self.last);
            out.push(TradeDays { first, last });
            first = last + Days::new(1);
        }
        out
    }

    pub fn halves(self) -> Option<[TradeDays; 2]> {
        let count = self.count();
        if count < 2 {
            return None;
        }
        let split = self.first + Days::new(count / 2 - 1);
        Some([
            TradeDays {
                first: self.first,
                last: split,
            },
            TradeDays {
                first: split + Days::new(1),
                last: self.last,
            },
        ])
    }

    pub fn yyyymmdd(self) -> (i32, i32) {
        (yyyymmdd(self.first), yyyymmdd(self.last))
    }
}

fn yyyymmdd(d: NaiveDate) -> i32 {
    d.year() * 10_000 + d.month() as i32 * 100 + d.day() as i32
}

pub(super) fn trade_date(ts: Timestamp) -> NaiveDate {
    RITHMIC_DATES.trade_date(ts)
}

pub(super) fn session_open(today: NaiveDate) -> Timestamp {
    RITHMIC_DATES.trade_date_end(RITHMIC_DATES.prev_trade_date(today))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Coverage {
    from: Option<NaiveDate>,
    replayed: bool,
    lost_on: Option<NaiveDate>,
}

impl Coverage {
    pub fn needs_replay(&self) -> bool {
        !self.replayed
    }

    pub fn holds(&self, wanted: NaiveDate) -> bool {
        self.from.is_some_and(|from| from <= wanted)
    }

    pub fn lost(&mut self, at: Timestamp) {
        if self.replayed {
            self.lost_on = Some(trade_date(at));
        }
        self.replayed = false;
    }

    pub fn replayed(&mut self, today: NaiveDate) {
        let unbroken = self.lost_on.is_none_or(|lost| lost >= today);
        self.from = match self.from {
            Some(from) if unbroken => Some(from.min(today)),
            _ => Some(today),
        };
        self.replayed = true;
        self.lost_on = None;
    }

    pub fn missing(&self, wanted: NaiveDate, created: Option<Timestamp>) -> Option<TradeDays> {
        let last = self.from?.pred_opt()?;
        let first = created.map_or(wanted, |c| wanted.max(trade_date(c)));
        (first <= last).then_some(TradeDays { first, last })
    }

    pub fn fetched(&mut self, wanted: NaiveDate) {
        self.from = Some(self.from.map_or(wanted, |from| from.min(wanted)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn span(first: NaiveDate, last: NaiveDate) -> TradeDays {
        TradeDays { first, last }
    }

    fn chicago(date: NaiveDate, hour: u32) -> Timestamp {
        tessera_core::time::local_to_timestamp(chrono_tz::America::Chicago, date, hour, 0)
    }

    #[test]
    fn thirty_days_is_one_window_and_thirty_one_is_two() {
        let first = d(2026, 10, 1);
        let thirty = span(first, d(2026, 10, 30));
        assert_eq!(thirty.count(), 30);
        assert_eq!(thirty.windows(), vec![thirty]);

        let thirty_one = span(first, d(2026, 10, 31));
        assert_eq!(
            thirty_one.windows(),
            vec![thirty, span(d(2026, 10, 31), d(2026, 10, 31))]
        );
    }

    #[test]
    fn one_day_is_one_window_and_an_inverted_span_is_none() {
        let day = span(d(2026, 11, 20), d(2026, 11, 20));
        assert_eq!(day.windows(), vec![day]);
        assert!(span(d(2026, 11, 21), d(2026, 11, 20)).windows().is_empty());
    }

    #[test]
    fn ninety_two_days_go_oldest_first_in_four_touching_windows_of_at_most_thirty() {
        let all = span(d(2026, 8, 23), d(2026, 11, 22));
        assert_eq!(all.count(), 92);
        let w = all.windows();
        assert_eq!(w.len(), 4);
        assert_eq!(w[0].first, all.first);
        assert_eq!(w[3].last, all.last);
        assert!(
            w.iter()
                .all(|x| x.count() <= WINDOW_DAYS && x.first <= x.last)
        );
        assert!(w.windows(2).all(|p| p[0].last + Days::new(1) == p[1].first));
        assert_eq!(w.iter().map(|x| x.count()).sum::<u64>(), 92);
    }

    #[test]
    fn a_full_window_splits_into_touching_halves_down_to_one_day() {
        let w = span(d(2026, 10, 1), d(2026, 10, 30));
        let [a, b] = w.halves().unwrap();
        assert_eq!((a.first, a.last), (d(2026, 10, 1), d(2026, 10, 15)));
        assert_eq!((b.first, b.last), (d(2026, 10, 16), d(2026, 10, 30)));
        let two = span(d(2026, 10, 1), d(2026, 10, 2));
        assert_eq!(
            two.halves(),
            Some([span(two.first, two.first), span(two.last, two.last)])
        );
        assert_eq!(span(two.first, two.first).halves(), None);
    }

    #[test]
    fn dates_go_to_rithmic_as_yyyymmdd() {
        assert_eq!(
            span(d(2026, 8, 1), d(2026, 8, 4)).yyyymmdd(),
            (20_260_801, 20_260_804)
        );
    }

    #[test]
    fn the_evening_session_belongs_to_the_next_trade_date() {
        let friday = d(2026, 11, 20);
        let monday = d(2026, 11, 23);
        assert_eq!(trade_date(chicago(friday, 15)), friday);
        assert_eq!(trade_date(chicago(friday, 18)), monday);
        assert_eq!(trade_date(chicago(d(2026, 11, 22), 18)), monday);
        assert_eq!(session_open(monday), chicago(friday, 17));
        assert_eq!(session_open(d(2026, 11, 24)), chicago(monday, 17));
    }

    #[test]
    fn nothing_is_held_until_today_is_replayed_and_then_only_older_days_are_missing() {
        let today = d(2026, 11, 23);
        let mut c = Coverage::default();
        assert!(c.needs_replay());
        assert!(!c.holds(today));
        assert_eq!(c.missing(d(2026, 11, 1), None), None);

        c.replayed(today);
        assert!(!c.needs_replay());
        assert!(c.holds(today));
        assert_eq!(c.missing(today, None), None);
        assert_eq!(
            c.missing(d(2026, 11, 1), None),
            Some(span(d(2026, 11, 1), d(2026, 11, 22)))
        );

        c.fetched(d(2026, 11, 1));
        assert!(c.holds(d(2026, 11, 1)));
        assert_eq!(c.missing(d(2026, 11, 1), None), None);
        assert_eq!(
            c.missing(d(2026, 10, 1), None),
            Some(span(d(2026, 10, 1), d(2026, 10, 31)))
        );
    }

    #[test]
    fn nothing_before_the_account_was_created_is_asked_for() {
        let mut c = Coverage::default();
        c.replayed(d(2026, 11, 23));
        let created = chicago(d(2026, 11, 10), 9);
        assert_eq!(
            c.missing(d(2026, 8, 1), Some(created)),
            Some(span(d(2026, 11, 10), d(2026, 11, 22)))
        );
        let today_created = chicago(d(2026, 11, 23), 9);
        assert_eq!(c.missing(d(2026, 8, 1), Some(today_created)), None);
    }

    #[test]
    fn a_reconnect_in_the_same_session_keeps_older_days_and_one_across_a_session_does_not() {
        let monday = d(2026, 11, 23);
        let tuesday = d(2026, 11, 24);
        let mut c = Coverage::default();
        c.replayed(monday);
        c.fetched(d(2026, 11, 1));

        c.lost(chicago(monday, 10));
        assert!(c.needs_replay());
        assert!(
            c.holds(d(2026, 11, 1)),
            "what was held stays readable while away"
        );
        c.replayed(monday);
        assert!(c.holds(d(2026, 11, 1)));

        c.lost(chicago(monday, 15));
        c.replayed(tuesday);
        assert!(!c.holds(monday));
        assert!(c.holds(tuesday));
        assert_eq!(
            c.missing(d(2026, 11, 1), None),
            Some(span(d(2026, 11, 1), monday))
        );
    }

    #[test]
    fn a_second_loss_before_the_replay_keeps_the_first() {
        let monday = d(2026, 11, 23);
        let mut c = Coverage::default();
        c.replayed(monday);
        c.fetched(d(2026, 11, 1));
        c.lost(chicago(monday, 10));
        c.lost(chicago(d(2026, 11, 24), 10));
        c.replayed(d(2026, 11, 24));
        assert!(!c.holds(monday));
    }
}
