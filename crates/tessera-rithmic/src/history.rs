//! A Rithmic time-bar replay returns at most 10,000 rows and says nothing when it stops there.
//! Rithmic's intraday time bars are aligned to the clock.

use std::collections::VecDeque;
use std::time::Duration;

use rithmic_rs::TimeBarType;
use tessera_core::market::Bar;
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_DAY, NANOS_PER_SEC, Timestamp};
use tessera_core::timeframe::{TimeUnit, Timeframe};
use tessera_market::aggregate::aggregate;

use crate::map::BarUnit;

pub const MAX_ROWS_PER_PAGE: usize = 10_000;

pub const TARGET_ROWS_PER_PAGE: i64 = 9_000;

pub const LONG_PULL_ROWS: i64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BarPlan {
    pub bar_type: TimeBarType,
    pub period: i32,
    pub unit: BarUnit,
}

impl BarPlan {
    pub fn for_timeframe(tf: Timeframe) -> Self {
        let aligned = |count: u32| gcd(count, 60) as i32;
        match tf.unit() {
            TimeUnit::Second => {
                let period = aligned(tf.count());
                BarPlan {
                    bar_type: TimeBarType::SecondBar,
                    period,
                    unit: BarUnit::Seconds(i64::from(period)),
                }
            }
            TimeUnit::Minute | TimeUnit::Hour => {
                let period = aligned(tf.minutes() as u32);
                BarPlan {
                    bar_type: TimeBarType::MinuteBar,
                    period,
                    unit: BarUnit::Seconds(i64::from(period) * 60),
                }
            }
            TimeUnit::Day => BarPlan {
                bar_type: TimeBarType::DailyBar,
                period: 1,
                unit: BarUnit::Days,
            },
        }
    }

    pub fn bar_secs(&self) -> i64 {
        match self.unit {
            BarUnit::Seconds(s) => s,
            BarUnit::Days => NANOS_PER_DAY / NANOS_PER_SEC,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub start: i64,
    pub end: i64,
}

impl Window {
    pub fn len(&self) -> i64 {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }

    pub fn split(&self, bar_secs: i64) -> Option<(Window, Window)> {
        let bars = self.len() / bar_secs.max(1);
        if bars < 2 {
            return None;
        }
        let mid = self.start + (bars / 2) * bar_secs;
        Some((
            Window {
                start: self.start,
                end: mid,
            },
            Window {
                start: mid,
                end: self.end,
            },
        ))
    }
}

pub fn pages(window: Window, bar_secs: i64) -> Vec<Window> {
    let span = TARGET_ROWS_PER_PAGE * bar_secs.max(1);
    let mut out = Vec::new();
    let mut start = window.start;
    while start < window.end {
        let end = (start + span).min(window.end);
        out.push(Window { start, end });
        start = end;
    }
    out
}

pub fn max_rows(window: Window, bar_secs: i64) -> i64 {
    window.len().max(0) / bar_secs.max(1)
}

pub fn check_long_pull(rows: i64, now: Timestamp) -> Result<(), String> {
    if rows > LONG_PULL_ROWS && SessionCalendar::UsEquities.is_rth(now) {
        return Err(format!(
            "this history pull needs up to {rows} rows; pulls over {LONG_PULL_ROWS} run outside \
             US cash hours (after 16:00 ET)"
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub struct Pager {
    queue: VecDeque<Window>,
    bar_secs: i64,
    pub splits: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PageVerdict {
    Keep,
    Split,
    KeepCapped,
}

impl Pager {
    pub fn new(window: Window, bar_secs: i64) -> Self {
        Self {
            queue: pages(window, bar_secs).into(),
            bar_secs,
            splits: 0,
        }
    }

    pub fn next_window(&mut self) -> Option<Window> {
        self.queue.pop_front()
    }

    pub fn judge(&mut self, window: Window, rows: usize) -> PageVerdict {
        if rows < MAX_ROWS_PER_PAGE {
            return PageVerdict::Keep;
        }
        match window.split(self.bar_secs) {
            Some((a, b)) => {
                self.queue.push_front(b);
                self.queue.push_front(a);
                self.splits += 1;
                PageVerdict::Split
            }
            None => PageVerdict::KeepCapped,
        }
    }
}

pub const TICK_TARGET_ROWS: i64 = 8_000;

pub const TICK_PAUSE: Duration = Duration::from_millis(250);

pub const FIRST_TICK_SECS: i64 = 120;

pub const MAX_TICK_SECS: i64 = 3_600;

const MAX_TICK_GROWTH: i64 = 4;

#[derive(Debug)]
pub struct TickPager {
    start: i64,
    end: i64,
    secs: i64,
}

impl TickPager {
    pub fn new(window: Window) -> Self {
        Self {
            start: window.start,
            end: window.end,
            secs: FIRST_TICK_SECS,
        }
    }

    pub fn next_window(&self) -> Option<Window> {
        (self.end > self.start).then(|| Window {
            start: (self.end - self.secs).max(self.start),
            end: self.end,
        })
    }

    pub fn judge(&mut self, window: Window, rows: usize) -> PageVerdict {
        if rows >= MAX_ROWS_PER_PAGE {
            if window.len() > 1 {
                self.secs = (window.len() / 2).max(1);
                return PageVerdict::Split;
            }
            self.end = window.start;
            return PageVerdict::KeepCapped;
        }
        self.end = window.start;
        let fit = window.len() * TICK_TARGET_ROWS / i64::try_from(rows).unwrap_or(i64::MAX).max(1);
        self.secs = fit.clamp(1, (window.len() * MAX_TICK_GROWTH).min(MAX_TICK_SECS));
        PageVerdict::Keep
    }
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

pub fn finish(
    mut bars: Vec<Bar>,
    tf: Timeframe,
    calendar: SessionCalendar,
    from: Option<Timestamp>,
    to: Option<Timestamp>,
    limit: Option<usize>,
    rth_only: bool,
) -> Vec<Bar> {
    bars.sort_by_key(|b| b.t);
    bars.dedup_by_key(|b| b.t);
    if rth_only && !tf.is_session() {
        bars.retain(|b| calendar.is_rth(b.t));
    }
    let mut out = if tf == Timeframe::D1 {
        bars
    } else {
        aggregate(&bars, tf, calendar)
    };
    out.retain(|b| from.is_none_or(|f| b.t >= f) && to.is_none_or(|t| b.t <= t));
    if let Some(n) = limit
        && out.len() > n
    {
        out.drain(..out.len() - n);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::money::{Price, Qty};

    #[test]
    fn plans_match_tessera_buckets() {
        assert_eq!(BarPlan::for_timeframe(Timeframe::M5).period, 5);
        assert_eq!(BarPlan::for_timeframe(Timeframe::H4).period, 60);
        assert_eq!(BarPlan::for_timeframe(Timeframe::S1).bar_secs(), 1);
        assert_eq!(BarPlan::for_timeframe(Timeframe::D1).unit, BarUnit::Days);
        let plan = |s: &str| BarPlan::for_timeframe(s.parse().unwrap());
        assert_eq!(plan("15s").period, 15);
        assert_eq!(plan("15s").bar_type, TimeBarType::SecondBar);
        assert_eq!(
            plan("7s").period,
            1,
            "7s buckets start at the session anchor"
        );
        assert_eq!(plan("45s").period, 15);
        assert_eq!(plan("7m").period, 1);
        assert_eq!(plan("90m").period, 30);
        assert_eq!(plan("3h").period, 60);
        assert_eq!(plan("2D").unit, BarUnit::Days);
    }

    #[test]
    fn pages_stay_under_the_cap() {
        let two_days = Window {
            start: 0,
            end: 2 * 86_400,
        };
        assert_eq!(pages(two_days, 60), vec![two_days]);
        let ten = Window {
            start: 0,
            end: 10 * 86_400,
        };
        let p = pages(ten, 60);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].end, 9_000 * 60);
        assert_eq!(p[1].start, p[0].end);
        assert_eq!(p[1].end, ten.end);
        assert!(p.iter().all(|w| max_rows(*w, 60) <= TARGET_ROWS_PER_PAGE));
    }

    #[test]
    fn a_full_page_is_split_and_asked_again() {
        let w = Window {
            start: 0,
            end: 9_000,
        };
        let mut pager = Pager::new(w, 1);
        let first = pager.next_window().unwrap();
        assert_eq!(pager.judge(first, 9_999), PageVerdict::Keep);
        let mut pager = Pager::new(w, 1);
        let first = pager.next_window().unwrap();
        assert_eq!(pager.judge(first, MAX_ROWS_PER_PAGE), PageVerdict::Split);
        assert_eq!(
            pager.next_window(),
            Some(Window {
                start: 0,
                end: 4_500
            })
        );
        assert_eq!(
            pager.next_window(),
            Some(Window {
                start: 4_500,
                end: 9_000
            })
        );
        assert_eq!(pager.next_window(), None);
        let one = Window { start: 0, end: 1 };
        assert_eq!(pager.judge(one, MAX_ROWS_PER_PAGE), PageVerdict::KeepCapped);
        assert_eq!(pager.splits, 1);
    }

    #[test]
    fn tick_pages_walk_back_without_overlap_split_on_the_cap_and_widen_when_sparse() {
        let session = Window {
            start: 0,
            end: 6 * 3_600,
        };
        let opening = 3_600;
        let busy = |w: Window| -> usize {
            let dense = (w.end.min(opening) - w.start).max(0);
            let quiet = (w.end - w.start.max(opening)).max(0);
            usize::try_from(dense * 20 + quiet / 2).unwrap()
        };
        let mut pager = TickPager::new(session);
        let mut kept: Vec<Window> = Vec::new();
        let (mut asked, mut splits) = (0, 0);
        while let Some(w) = pager.next_window() {
            asked += 1;
            let rows = busy(w);
            match pager.judge(w, rows) {
                PageVerdict::Keep => kept.push(w),
                PageVerdict::Split => {
                    assert!(rows >= MAX_ROWS_PER_PAGE);
                    splits += 1;
                }
                PageVerdict::KeepCapped => panic!("{w:?} held {rows} rows"),
            }
        }
        assert!(splits > 0, "the busy opening hour was asked in halves");
        assert_eq!(
            kept.first().map(|w| w.end),
            Some(session.end),
            "newest first"
        );
        assert_eq!(kept.last().map(|w| w.start), Some(session.start));
        for pair in kept.windows(2) {
            assert_eq!(pair[1].end, pair[0].start, "{pair:?}");
        }
        assert!(kept.iter().all(|w| busy(*w) < MAX_ROWS_PER_PAGE));
        assert!(
            kept.iter().any(|w| w.len() == MAX_TICK_SECS),
            "the quiet hours go an hour a page"
        );
        assert!(asked < 40, "{asked} pages for {} kept", kept.len());

        let mut sweep = TickPager::new(Window { start: 0, end: 10 });
        let w = sweep.next_window().unwrap();
        assert_eq!(sweep.judge(w, MAX_ROWS_PER_PAGE), PageVerdict::Split);
        let one = Window { start: 9, end: 10 };
        let mut sweep = TickPager::new(one);
        assert_eq!(sweep.judge(one, MAX_ROWS_PER_PAGE), PageVerdict::KeepCapped);
        assert_eq!(sweep.next_window(), None);
    }

    #[test]
    fn long_pulls_wait_for_the_cash_close() {
        let midday = Timestamp::parse("2026-10-07T12:00:00-04:00").unwrap();
        let evening = Timestamp::parse("2026-10-07T18:30:00-04:00").unwrap();
        assert!(check_long_pull(2_880, midday).is_ok());
        assert!(check_long_pull(LONG_PULL_ROWS + 1, midday).is_err());
        assert!(check_long_pull(LONG_PULL_ROWS + 1, evening).is_ok());
    }

    #[test]
    fn finish_dedups_aggregates_and_limits() {
        let t0 = Timestamp::parse("2026-10-07T10:00:00-04:00").unwrap();
        let bar = |i: i64| {
            let mut b = Bar::flat(
                t0.add_nanos(i * 60 * NANOS_PER_SEC),
                Price::from(100 + i),
                Qty::from(1),
            );
            b.h = Price::from(101 + i);
            b
        };
        let mut bars: Vec<Bar> = (0..10).map(bar).collect();
        bars.push(bar(3));
        bars.reverse();
        let out = finish(
            bars,
            Timeframe::M5,
            SessionCalendar::CmeEquityIndex,
            None,
            None,
            Some(1),
            false,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].t, t0.add_nanos(5 * 60 * NANOS_PER_SEC));
        assert_eq!(out[0].v, Qty::from(5));
        assert_eq!(out[0].h, Price::from(110));
    }
}
