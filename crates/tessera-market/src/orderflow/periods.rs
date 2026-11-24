use chrono::{Datelike, Duration, NaiveDate};
use tessera_core::Timestamp;
use tessera_core::session::{SessionCalendar, TradingSession};
use tessera_core::time::local_to_timestamp;

use crate::io::ProfilePeriod;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Piece {
    pub from: Timestamp,
    pub to: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeriodSpan {
    pub from: Timestamp,
    pub to: Timestamp,
    pub end: Timestamp,
    pub date: NaiveDate,
    pub whole: bool,
    pub pieces: Vec<Piece>,
}

fn window(s: &TradingSession, rth: bool) -> Option<(Timestamp, Timestamp)> {
    match (rth, s.rth) {
        (true, Some(w)) => Some((w.start, w.end)),
        (true, None) => None,
        (false, _) => Some((s.open, s.close)),
    }
}

fn group_of(period: ProfilePeriod, date: NaiveDate) -> (i32, u32) {
    match period {
        ProfilePeriod::Week => {
            let w = date.iso_week();
            (w.year(), w.week())
        }
        ProfilePeriod::Month => (date.year(), date.month()),
        ProfilePeriod::Session | ProfilePeriod::Day => (date.year(), date.ordinal()),
    }
}

fn span_of(pieces: Vec<Piece>, end: Timestamp, date: NaiveDate, at: Timestamp) -> PeriodSpan {
    PeriodSpan {
        from: pieces.first().map_or(end, |p| p.from),
        to: end.min(at),
        end,
        date,
        whole: end <= at,
        pieces,
    }
}

fn clipped(from: Timestamp, to: Timestamp, at: Timestamp) -> Option<Piece> {
    (from <= at && from < to).then(|| Piece {
        from,
        to: to.min(at),
    })
}

fn session_groups(
    calendar: SessionCalendar,
    period: ProfilePeriod,
    at: Timestamp,
    n: usize,
    rth: bool,
) -> Vec<PeriodSpan> {
    let mut date = calendar.trade_date(at);
    if !calendar.is_trade_date(date) {
        date = calendar.prev_trade_date(date);
    }
    let mut groups: Vec<Vec<(NaiveDate, Timestamp, Timestamp)>> = Vec::new();
    let mut key = None;
    let mut misses = 0;
    while misses < 60 {
        let Some(s) = calendar.session(date) else {
            date = calendar.prev_trade_date(date);
            misses += 1;
            continue;
        };
        let Some((start, end)) = window(&s, rth).filter(|(start, _)| *start <= at) else {
            date = calendar.prev_trade_date(date);
            misses += 1;
            continue;
        };
        misses = 0;
        let k = group_of(period, date);
        if key != Some(k) {
            if groups.len() == n {
                break;
            }
            groups.push(Vec::new());
            key = Some(k);
        }
        groups
            .last_mut()
            .expect("a group was pushed")
            .push((date, start, end));
        date = calendar.prev_trade_date(date);
    }
    groups.reverse();
    groups
        .into_iter()
        .map(|mut g| {
            g.reverse();
            let (first, _, _) = g[0];
            let (newest, _, newest_end) = *g.last().expect("a group holds a session");
            let mut end = newest_end;
            let mut next = calendar.next_trade_date(newest);
            for _ in 0..40 {
                if group_of(period, next) != group_of(period, newest) {
                    break;
                }
                if let Some(w) = calendar.session(next).and_then(|s| window(&s, rth)) {
                    end = w.1;
                }
                next = calendar.next_trade_date(next);
            }
            let pieces = g
                .iter()
                .filter_map(|(_, from, to)| clipped(*from, *to, at))
                .collect();
            span_of(pieces, end, first, at)
        })
        .collect()
}

fn calendar_days(calendar: SessionCalendar, at: Timestamp, n: usize, rth: bool) -> Vec<PeriodSpan> {
    let tz = calendar.tz();
    let mut day = at.in_tz(tz).date_naive();
    let mut out = Vec::with_capacity(n);
    for _ in 0..(n * 4 + 14) {
        if out.len() == n {
            break;
        }
        let midnight = local_to_timestamp(tz, day, 0, 0);
        let next = local_to_timestamp(tz, day + Duration::days(1), 0, 0);
        let mut pieces = Vec::new();
        let mut end = None;
        for s in calendar.sessions_between(day - Duration::days(1), day + Duration::days(2)) {
            let Some((start, stop)) = window(&s, rth) else {
                continue;
            };
            let (a, b) = (start.max(midnight), stop.min(next));
            if a >= b {
                continue;
            }
            end = Some(b);
            pieces.extend(clipped(a, b, at));
        }
        if let (Some(end), false) = (end, pieces.is_empty()) {
            out.push(span_of(pieces, end, day, at));
        }
        day -= Duration::days(1);
    }
    out.reverse();
    out
}

const CALENDAR_YEARS: usize = 50;

fn calendar_reach(period: ProfilePeriod) -> usize {
    CALENDAR_YEARS
        * match period {
            ProfilePeriod::Session | ProfilePeriod::Day => 366,
            ProfilePeriod::Week => 53,
            ProfilePeriod::Month => 12,
        }
}

pub fn recent_periods(
    calendar: SessionCalendar,
    period: ProfilePeriod,
    at: Timestamp,
    n: usize,
    rth: bool,
) -> Vec<PeriodSpan> {
    let n = n.min(calendar_reach(period));
    if n == 0 {
        return Vec::new();
    }
    match period {
        ProfilePeriod::Day => calendar_days(calendar, at, n, rth),
        _ => session_groups(calendar, period, at, n, rth),
    }
}

pub fn range_pieces(
    calendar: SessionCalendar,
    from: Timestamp,
    to: Timestamp,
    rth: bool,
) -> Vec<Piece> {
    if rth {
        return rth_pieces(calendar, from, to);
    }
    let first = calendar.trade_date(from) - Duration::days(1);
    let last = calendar.trade_date(to) + Duration::days(1);
    let mut out = Vec::new();
    let mut cursor = from;
    let mut leading = true;
    for s in calendar.sessions_between(first, last) {
        if s.open < cursor || s.close > to {
            continue;
        }
        if leading && cursor < s.open {
            out.push(Piece {
                from: cursor,
                to: s.open,
            });
        }
        leading = false;
        out.push(Piece {
            from: s.open,
            to: s.close,
        });
        cursor = s.close;
    }
    if cursor < to {
        out.push(Piece { from: cursor, to });
    }
    out
}

fn rth_pieces(calendar: SessionCalendar, from: Timestamp, to: Timestamp) -> Vec<Piece> {
    let first = calendar.trade_date(from) - Duration::days(1);
    let last = calendar.trade_date(to) + Duration::days(1);
    calendar
        .sessions_between(first, last)
        .iter()
        .filter_map(|s| window(s, true))
        .filter_map(|(a, b)| {
            let (a, b) = (a.max(from), b.min(to));
            (a < b).then_some(Piece { from: a, to: b })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    fn date(m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, m, d).unwrap()
    }

    const CME: SessionCalendar = SessionCalendar::CmeEquityIndex;

    #[test]
    fn a_week_is_its_sessions_from_the_sunday_open() {
        let at = ts("2026-10-07T11:00:00-04:00");
        let weeks = recent_periods(CME, ProfilePeriod::Week, at, 2, false);
        assert_eq!(weeks.len(), 2);
        let (prior, this) = (&weeks[0], &weeks[1]);
        assert_eq!(prior.date, date(9, 28));
        assert_eq!(prior.pieces.len(), 5);
        assert_eq!(prior.from, ts("2026-09-27T18:00:00-04:00"));
        assert_eq!(
            (prior.to, prior.end),
            (prior.end, ts("2026-10-02T17:00:00-04:00"))
        );
        assert!(prior.whole);
        assert_eq!(this.date, date(10, 5));
        assert_eq!(this.from, ts("2026-10-04T18:00:00-04:00"));
        assert_eq!(this.pieces.len(), 3);
        assert_eq!(this.pieces[2].to, at);
        assert_eq!(this.to, at);
        assert_eq!(this.end, ts("2026-10-09T17:00:00-04:00"));
        assert!(!this.whole);
    }

    #[test]
    fn a_month_holds_every_trade_date_in_it() {
        let at = ts("2026-11-03T10:00:00-05:00");
        let months = recent_periods(CME, ProfilePeriod::Month, at, 2, false);
        let october = &months[0];
        assert_eq!(october.date, date(10, 1));
        assert_eq!(october.pieces.len(), 22);
        assert_eq!(october.from, ts("2026-09-30T18:00:00-04:00"));
        assert_eq!(october.end, ts("2026-10-30T17:00:00-04:00"));
        let november = &months[1];
        assert_eq!(november.date, date(11, 2));
        assert_eq!(november.pieces.len(), 2);
        assert!(!november.whole);
        let rth = recent_periods(CME, ProfilePeriod::Month, at, 1, true);
        assert_eq!(rth[0].from, ts("2026-11-02T09:30:00-05:00"));
        assert_eq!(rth[0].pieces.len(), 2);
    }

    #[test]
    fn a_day_is_midnight_to_midnight_in_the_exchange_zone() {
        let at = ts("2026-10-07T11:00:00-04:00");
        let days = recent_periods(CME, ProfilePeriod::Day, at, 2, false);
        assert_eq!(days[0].date, date(10, 6));
        assert_eq!(
            days[0].pieces,
            vec![
                Piece {
                    from: ts("2026-10-06T00:00:00-04:00"),
                    to: ts("2026-10-06T17:00:00-04:00")
                },
                Piece {
                    from: ts("2026-10-06T18:00:00-04:00"),
                    to: ts("2026-10-07T00:00:00-04:00")
                },
            ]
        );
        assert_eq!(days[1].from, ts("2026-10-07T00:00:00-04:00"));
        assert_eq!(days[1].to, at);
        let sunday = recent_periods(
            CME,
            ProfilePeriod::Day,
            ts("2026-10-05T01:00:00-04:00"),
            2,
            false,
        );
        assert_eq!(sunday[0].date, date(10, 4));
        assert_eq!(sunday[0].from, ts("2026-10-04T18:00:00-04:00"));
    }

    #[test]
    fn sessions_are_periods_of_one() {
        let at = ts("2026-10-05T10:00:00-04:00");
        let s = recent_periods(CME, ProfilePeriod::Session, at, 2, false);
        assert_eq!(s[0].date, date(10, 2));
        assert_eq!(s[1].date, date(10, 5));
        assert_eq!(
            s[1].pieces,
            vec![Piece {
                from: ts("2026-10-04T18:00:00-04:00"),
                to: at
            }]
        );
    }

    #[test]
    fn a_range_reads_whole_sessions_and_its_two_edges() {
        let from = ts("2026-10-01T12:00:00-04:00");
        let to = ts("2026-10-07T11:00:00-04:00");
        let p = range_pieces(CME, from, to, false);
        assert_eq!(
            p.first(),
            Some(&Piece {
                from,
                to: ts("2026-10-01T18:00:00-04:00")
            })
        );
        assert_eq!(
            p.last(),
            Some(&Piece {
                from: ts("2026-10-06T17:00:00-04:00"),
                to
            })
        );
        let whole: Vec<_> = p[1..p.len() - 1].iter().map(|x| x.from).collect();
        assert_eq!(
            whole,
            vec![
                ts("2026-10-01T18:00:00-04:00"),
                ts("2026-10-04T18:00:00-04:00"),
                ts("2026-10-05T18:00:00-04:00"),
            ]
        );
        let inside = range_pieces(
            CME,
            ts("2026-10-01T10:00:00-04:00"),
            ts("2026-10-01T11:00:00-04:00"),
            false,
        );
        assert_eq!(inside.len(), 1);
    }

    #[test]
    fn a_range_in_regular_hours_reads_each_session_from_09_30_to_16_00() {
        let p = range_pieces(
            CME,
            ts("2026-10-01T12:00:00-04:00"),
            ts("2026-10-05T11:00:00-04:00"),
            true,
        );
        assert_eq!(
            p,
            vec![
                Piece {
                    from: ts("2026-10-01T12:00:00-04:00"),
                    to: ts("2026-10-01T16:00:00-04:00")
                },
                Piece {
                    from: ts("2026-10-02T09:30:00-04:00"),
                    to: ts("2026-10-02T16:00:00-04:00")
                },
                Piece {
                    from: ts("2026-10-05T09:30:00-04:00"),
                    to: ts("2026-10-05T11:00:00-04:00")
                },
            ]
        );
    }

    #[test]
    fn thirteen_weeks_reach_back_a_quarter() {
        let at = ts("2026-10-07T11:00:00-04:00");
        let weeks = recent_periods(CME, ProfilePeriod::Week, at, 13, false);
        assert_eq!(weeks.len(), 13);
        assert_eq!(weeks[0].date, date(7, 13));
        assert!(weeks.windows(2).all(|w| w[0].end <= w[1].from));
    }
}
