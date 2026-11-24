use std::collections::BTreeMap;

use chrono::NaiveDate;
use tessera_core::initial_balance::OpensAt;
use tessera_core::market::Bar;
use tessera_core::session::{SessionWindow, TradingSession};
use tessera_core::time::{NANOS_PER_DAY, NANOS_PER_MINUTE};
use tessera_core::{Price, Qty, Timestamp};
use tessera_market::io::SessionFilter;

use super::rows::{BarKind, Grid, Row};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Opening {
    pub opens_at: OpensAt,
    pub minutes: [u32; 2],
}

impl Opening {
    pub fn longest(&self) -> u32 {
        self.minutes.into_iter().max().unwrap_or(0)
    }

    pub fn window(&self, session: &TradingSession) -> SessionWindow {
        let within = self.opens_at.within(session);
        let end = within.start.0 + i64::from(self.longest()) * NANOS_PER_MINUTE;
        SessionWindow {
            start: within.start,
            end: Timestamp(end.min(within.end.0)),
        }
    }

    pub fn read_from_rows(&self, grid: &Grid, session: &TradingSession) -> bool {
        let BarKind::Time(tf) = grid.bars else {
            return false;
        };
        let within = self.opens_at.within(session);
        let shown = match grid.session {
            SessionFilter::All => true,
            SessionFilter::Rth => session.rth.is_some_and(|rth| rth.start <= within.start),
        };
        shown
            && grid.calendar.bucket_start(within.start, tf) == within.start
            && self
                .minutes
                .iter()
                .all(|m| (i64::from(*m) * NANOS_PER_MINUTE) % tf.nanos() == 0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Minutes {
    pub end: i64,
    pub through: i64,
    pub bars: Vec<Bar>,
}

impl Minutes {
    pub fn complete(&self) -> bool {
        self.through >= self.end
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MinutesAsk {
    pub start: i64,
    pub end: i64,
    pub recent: bool,
}

pub(crate) const RECENT_SESSIONS: usize = 30;

#[derive(Clone, Debug, Default)]
pub(crate) struct Openings {
    held: BTreeMap<i64, Minutes>,
}

pub(crate) fn date_of(day: f64) -> Option<NaiveDate> {
    let ymd = day as i64;
    NaiveDate::from_ymd_opt(
        (ymd / 10_000) as i32,
        (ymd / 100 % 100) as u32,
        (ymd % 100) as u32,
    )
}

pub(crate) fn bar_of(row: &Row) -> Option<Bar> {
    Some(Bar {
        t: Timestamp(row.t),
        o: Price::from_f64(row.open)?,
        h: Price::from_f64(row.high)?,
        l: Price::from_f64(row.low)?,
        c: Price::from_f64(row.close)?,
        v: Qty::ZERO,
        bv: None,
    })
}

impl Openings {
    pub fn get(&self, start: Timestamp) -> Option<&Minutes> {
        self.held.get(&start.0)
    }

    pub fn put(&mut self, start: i64, minutes: Minutes) -> bool {
        if self.held.get(&start) == Some(&minutes) {
            return false;
        }
        self.held.insert(start, minutes);
        true
    }

    pub fn asks(
        &self,
        sessions: &[TradingSession],
        wanted: &[Opening],
        grid: &Grid,
        now: i64,
    ) -> Vec<MinutesAsk> {
        let mut asks: Vec<MinutesAsk> = Vec::new();
        for (age, session) in sessions.iter().rev().enumerate() {
            for opening in wanted {
                if opening.read_from_rows(grid, session) {
                    continue;
                }
                let w = opening.window(session);
                let (start, end) = (w.start.0, w.end.0);
                if start > now || end <= start {
                    continue;
                }
                let held = self
                    .held
                    .get(&start)
                    .is_some_and(|m| m.end >= end && m.complete());
                if held {
                    continue;
                }
                match asks.iter_mut().find(|a| a.start == start) {
                    Some(a) => a.end = a.end.max(end),
                    None => asks.push(MinutesAsk {
                        start,
                        end,
                        recent: age < RECENT_SESSIONS,
                    }),
                }
            }
        }
        asks
    }

    pub fn forget_before(&mut self, t: i64) {
        self.held
            .retain(|start, _| *start >= t.saturating_sub(NANOS_PER_DAY));
    }

    pub fn forget_within(&mut self, from: i64, to: i64) {
        self.held.retain(|start, m| m.end <= from || *start > to);
    }

    pub fn clear(&mut self) {
        self.held.clear();
    }

    pub fn bytes(&self) -> usize {
        self.held
            .values()
            .map(|m| {
                std::mem::size_of::<Minutes>() + m.bars.capacity() * std::mem::size_of::<Bar>()
            })
            .sum()
    }
}
