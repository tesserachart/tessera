use chrono::{Datelike, NaiveDate, Timelike, Weekday};
use chrono_tz::Tz;
use tessera_core::Timestamp;
use tessera_core::session::SessionCalendar;
use tessera_core::time::NANOS_PER_SEC;

use super::spec::{LimitsSpec, SessionName, WindowSpec, parse_hhmm};

pub const NEW_YORK: Tz = Tz::America__New_York;

fn local(tz: Tz, at: Timestamp) -> chrono::DateTime<Tz> {
    at.in_tz(tz)
}

pub fn in_window(window: Option<&WindowSpec>, at: Timestamp) -> bool {
    let Some(w) = window else {
        return true;
    };
    if let Some(SessionName::UsRth) = w.session {
        return SessionCalendar::UsEquities.is_rth(at);
    }
    let tz = w
        .time_zone
        .as_deref()
        .and_then(|z| z.parse::<Tz>().ok())
        .unwrap_or(NEW_YORK);
    let (Some(start), Some(end)) = (
        w.start.as_deref().and_then(parse_hhmm),
        w.end.as_deref().and_then(parse_hhmm),
    ) else {
        return true;
    };
    let t = local(tz, at);
    if w.weekdays_only.unwrap_or(true) && matches!(t.weekday(), Weekday::Sat | Weekday::Sun) {
        return false;
    }
    let m = t.hour() * 60 + t.minute();
    if start < end {
        (start..end).contains(&m)
    } else {
        m >= start || m < end
    }
}

pub fn quota_day(limits: &LimitsSpec, at: Timestamp) -> NaiveDate {
    let tz = limits
        .time_zone
        .as_deref()
        .and_then(|z| z.parse::<Tz>().ok())
        .unwrap_or(NEW_YORK);
    let reset = limits.reset_at.as_deref().and_then(parse_hhmm).unwrap_or(0);
    let t = local(tz, Timestamp(at.0 - i64::from(reset) * 60 * NANOS_PER_SEC));
    t.date_naive()
}

pub fn after(at: Timestamp, secs: u64) -> Timestamp {
    Timestamp(
        at.0.saturating_add(
            i64::try_from(secs).unwrap_or(i64::MAX / NANOS_PER_SEC) * NANOS_PER_SEC,
        ),
    )
}

pub fn schedule_words(every: u64, window: Option<&WindowSpec>) -> String {
    let every = if every.is_multiple_of(60) {
        let m = every / 60;
        if m == 1 {
            "Every minute".to_owned()
        } else {
            format!("Every {m} min")
        }
    } else {
        format!("Every {every} s")
    };
    match window {
        None => every,
        Some(w) if w.session == Some(SessionName::UsRth) => format!("{every}, US market hours"),
        Some(w) => format!(
            "{every}, {}–{} {}",
            w.start.as_deref().unwrap_or("?"),
            w.end.as_deref().unwrap_or("?"),
            w.time_zone.as_deref().unwrap_or("America/New_York")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    #[test]
    fn the_rth_window_follows_the_us_calendar() {
        let rth = WindowSpec {
            session: Some(SessionName::UsRth),
            time_zone: None,
            start: None,
            end: None,
            weekdays_only: None,
        };
        assert!(in_window(Some(&rth), ts("2026-10-08T15:05:00-04:00")));
        assert!(!in_window(Some(&rth), ts("2026-10-08T16:00:00-04:00")));
        assert!(!in_window(Some(&rth), ts("2026-10-08T09:29:00-04:00")));
        assert!(!in_window(Some(&rth), ts("2026-10-10T11:00:00-04:00")));
        assert!(!in_window(Some(&rth), ts("2026-11-26T11:00:00-05:00")));
        assert!(!in_window(Some(&rth), ts("2026-11-27T13:30:00-05:00")));
        assert!(in_window(None, ts("2026-10-10T11:00:00-04:00")));
    }

    #[test]
    fn a_custom_window_and_the_quota_day() {
        let w = WindowSpec {
            session: None,
            time_zone: Some("Europe/London".into()),
            start: Some("08:00".into()),
            end: Some("16:30".into()),
            weekdays_only: None,
        };
        assert!(in_window(Some(&w), ts("2026-10-08T08:00:00+01:00")));
        assert!(!in_window(Some(&w), ts("2026-10-08T16:30:00+01:00")));
        assert!(!in_window(Some(&w), ts("2026-10-11T10:00:00+01:00")));
        let overnight = WindowSpec {
            start: Some("18:00".into()),
            end: Some("17:00".into()),
            time_zone: None,
            ..w
        };
        assert!(in_window(Some(&overnight), ts("2026-10-08T20:00:00-04:00")));
        assert!(!in_window(
            Some(&overnight),
            ts("2026-10-08T17:30:00-04:00")
        ));

        let mut l = LimitsSpec::default();
        assert_eq!(
            quota_day(&l, ts("2026-10-08T23:59:00-04:00")),
            NaiveDate::from_ymd_opt(2026, 10, 8).unwrap()
        );
        assert_eq!(
            quota_day(&l, ts("2026-10-09T00:00:00-04:00")),
            NaiveDate::from_ymd_opt(2026, 10, 9).unwrap()
        );
        l.reset_at = Some("17:00".into());
        assert_eq!(
            quota_day(&l, ts("2026-10-09T16:59:00-04:00")),
            NaiveDate::from_ymd_opt(2026, 10, 8).unwrap()
        );
        assert_eq!(schedule_words(120, None), "Every 2 min");
        assert_eq!(
            schedule_words(
                60,
                Some(&WindowSpec {
                    session: Some(SessionName::UsRth),
                    time_zone: None,
                    start: None,
                    end: None,
                    weekdays_only: None
                })
            ),
            "Every minute, US market hours"
        );
    }
}
