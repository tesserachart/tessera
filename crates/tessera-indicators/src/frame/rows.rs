use chrono::{Datelike, NaiveDate};
use tessera_core::session::SessionCalendar;
use tessera_core::timeframe::PrintBars;
use tessera_core::{Timeframe, Timestamp};
use tessera_market::io::SessionFilter;
use tessera_market::orderflow::flow::{BarFlow, Sides};
use tessera_market::orderflow::vwap::PrintSums;
use tessera_protocol::compact::CompactBar;
use tessera_protocol::indicators::PriceSource;
use tessera_script::BarArrays;

use super::openings::Openings;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub from: i64,
    pub to: i64,
}

impl Span {
    pub fn new(from: i64, to: i64) -> Self {
        Self { from, to }
    }

    pub fn contains(&self, t: i64) -> bool {
        self.from <= t && t <= self.to
    }

    pub fn everything() -> Self {
        Self::new(i64::MIN, i64::MAX)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BarKind {
    Time(Timeframe),
    Print(PrintBars),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Period {
    #[default]
    Session,
    Week,
    Month,
}

impl Period {
    pub fn named(name: Option<&str>) -> Self {
        match name {
            Some("week") => Period::Week,
            Some("month") => Period::Month,
            _ => Period::Session,
        }
    }

    fn of_date(self, date: NaiveDate) -> i64 {
        match self {
            Period::Session => i64::from(date.num_days_from_ce()),
            Period::Week => {
                let w = date.iso_week();
                i64::from(w.year()) * 100 + i64::from(w.week())
            }
            Period::Month => i64::from(date.year()) * 100 + i64::from(date.month()),
        }
    }

    pub fn of_day(self, day: f64) -> i64 {
        let ymd = day as i64;
        match self {
            Period::Session => ymd,
            Period::Month => ymd / 100,
            Period::Week => NaiveDate::from_ymd_opt(
                (ymd / 10_000) as i32,
                (ymd / 100 % 100) as u32,
                (ymd % 100) as u32,
            )
            .map_or(ymd, |d| self.of_date(d)),
        }
    }
}

const LONGEST_PERIOD_DAYS: usize = 31;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grid {
    pub calendar: SessionCalendar,
    pub bars: BarKind,
    pub session: SessionFilter,
}

impl Grid {
    fn day(&self, t: i64) -> f64 {
        let d = self.calendar.trade_date(Timestamp(t));
        f64::from(d.year() * 10_000 + d.month() as i32 * 100 + d.day() as i32)
    }

    pub(crate) fn first_date(&self, t: i64, period: Period) -> NaiveDate {
        let cal = self.calendar;
        let mut date = cal.trade_date(Timestamp(t));
        if period == Period::Session {
            return date;
        }
        let key = period.of_date(date);
        for _ in 0..LONGEST_PERIOD_DAYS {
            let prev = cal.prev_trade_date(date);
            if prev >= date || period.of_date(prev) != key {
                break;
            }
            date = prev;
        }
        date
    }

    pub(crate) fn session_open(&self, t: i64) -> Option<i64> {
        self.period_open(t, Period::Session)
    }

    pub(crate) fn period_open(&self, t: i64, period: Period) -> Option<i64> {
        let BarKind::Time(tf) = self.bars else {
            return None;
        };
        let cal = self.calendar;
        let session = cal.session(self.first_date(t, period))?;
        let open = match self.session {
            SessionFilter::All => session.open,
            SessionFilter::Rth => session.rth?.start,
        };
        Some(cal.bucket_start(open, tf).0)
    }

    fn opens_day(&self, t: i64, first_opens: bool) -> bool {
        match self.bars {
            BarKind::Print(_) => first_opens,
            BarKind::Time(_) => self.session_open(t) == Some(t),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Flow {
    pub sides: Option<Sides>,
    pub sums: Option<PrintSums>,
}

impl Flow {
    pub const UNKNOWN: Self = Self {
        sides: None,
        sums: None,
    };

    pub fn of(f: BarFlow) -> Self {
        Self {
            sides: Some(f.sides),
            sums: Some(f.sums),
        }
    }

    pub fn with_sides(self, sides: Sides) -> Self {
        Self {
            sides: Some(sides),
            ..self
        }
    }

    pub fn known(&self) -> bool {
        self.sides.is_some()
    }

    fn bits(&self) -> [u64; 7] {
        let none = u64::MAX;
        let s = self.sides.map_or([none; 4], |s| {
            [s.volume, s.delta, s.delta_high, s.delta_low].map(f64::to_bits)
        });
        let p = self
            .sums
            .map_or([none; 3], |p| [p.volume, p.pv, p.pv2].map(f64::to_bits));
        [s[0], s[1], s[2], s[3], p[0], p[1], p[2]]
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Row {
    pub t: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub buy_volume: f64,
    pub day: f64,
    pub opens_day: bool,
    pub flow: Flow,
    pub unread: Option<u64>,
}

impl Row {
    fn of(bar: &CompactBar, grid: &Grid, flow: Flow) -> Self {
        Self {
            t: bar.0,
            open: bar.1,
            high: bar.2,
            low: bar.3,
            close: bar.4,
            volume: bar.5,
            buy_volume: bar.6.unwrap_or(f64::NAN),
            day: grid.day(bar.0),
            opens_day: false,
            flow,
            unread: None,
        }
    }

    fn same(&self, o: &Row) -> bool {
        self.t == o.t
            && [
                self.open,
                self.high,
                self.low,
                self.close,
                self.volume,
                self.buy_volume,
            ]
            .map(f64::to_bits)
                == [o.open, o.high, o.low, o.close, o.volume, o.buy_volume].map(f64::to_bits)
            && self.flow.bits() == o.flow.bits()
    }

    pub fn price(&self, source: PriceSource) -> f64 {
        match source {
            PriceSource::Open => self.open,
            PriceSource::High => self.high,
            PriceSource::Low => self.low,
            PriceSource::Close => self.close,
            PriceSource::Hl2 => (self.high + self.low) / 2.0,
            PriceSource::Hlc3 => (self.high + self.low + self.close) / 3.0,
            PriceSource::Ohlc4 => (self.open + self.high + self.low + self.close) / 4.0,
        }
    }
}

pub(crate) struct Splice {
    replace: std::ops::Range<usize>,
    fresh: Vec<Row>,
    pub first_change: usize,
}

impl Splice {
    pub fn day_after(&self, rows: &Rows) -> Option<f64> {
        let into = self.first_change - self.replace.start;
        match self.fresh.get(into) {
            Some(r) => Some(r.day),
            None => rows
                .iter()
                .nth(self.replace.end + into - self.fresh.len())
                .map(|r| r.day),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Rows {
    grid: Grid,
    rows: Vec<Row>,
    first_opens: bool,
    openings: Openings,
}

impl std::ops::Index<usize> for Rows {
    type Output = Row;

    fn index(&self, i: usize) -> &Row {
        &self.rows[i]
    }
}

impl Rows {
    pub fn new(grid: Grid) -> Self {
        Self {
            grid,
            rows: Vec::new(),
            first_opens: false,
            openings: Openings::default(),
        }
    }

    pub fn openings(&self) -> &Openings {
        &self.openings
    }

    pub fn openings_mut(&mut self) -> &mut Openings {
        &mut self.openings
    }

    pub fn sessions(&self) -> Vec<tessera_core::session::TradingSession> {
        let mut days: Vec<f64> = self.rows.iter().map(|r| r.day).collect();
        days.dedup();
        days.into_iter()
            .filter_map(super::openings::date_of)
            .filter_map(|d| self.grid.calendar.session(d))
            .collect()
    }

    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn time(&self, i: usize) -> i64 {
        self.rows[i].t
    }

    pub fn first(&self) -> Option<i64> {
        self.rows.first().map(|r| r.t)
    }

    pub fn last(&self) -> Option<i64> {
        self.rows.last().map(|r| r.t)
    }

    pub fn iter(&self) -> std::slice::Iter<'_, Row> {
        self.rows.iter()
    }

    pub fn find(&self, t: i64) -> Result<usize, usize> {
        self.rows.binary_search_by_key(&t, |r| r.t)
    }

    pub fn at_or_after(&self, t: i64) -> usize {
        self.find(t).unwrap_or_else(|i| i)
    }

    pub fn splice_of(
        &self,
        span: Span,
        bars: &[CompactBar],
        flows: Option<&[Flow]>,
        unread: Option<u64>,
    ) -> Option<Splice> {
        let a = self.at_or_after(span.from);
        let b = match span.to {
            i64::MAX => self.rows.len(),
            to => self.at_or_after(to.saturating_add(1)),
        };
        let mut fresh: Vec<Row> = bars
            .iter()
            .enumerate()
            .filter(|(_, bar)| span.contains(bar.0))
            .map(|(k, bar)| {
                let old = self
                    .find(bar.0)
                    .ok()
                    .filter(|i| (a..b).contains(i))
                    .map(|i| self.rows[i]);
                let flow = match flows {
                    Some(f) => f.get(k).copied().unwrap_or(Flow::UNKNOWN),
                    None => old.map_or(Flow::UNKNOWN, |o| o.flow),
                };
                let mut row = Row::of(bar, &self.grid, flow);
                row.unread = match old {
                    Some(o) if o.same(&row) => o.unread,
                    Some(o) => unread.or(o.unread),
                    None => unread,
                };
                row
            })
            .collect();
        fresh.sort_by_key(|r| r.t);
        fresh.dedup_by_key(|r| r.t);
        let old = &self.rows[a..b];
        let same = old
            .iter()
            .zip(&fresh)
            .take_while(|(o, n)| o.same(n))
            .count();
        if same == old.len() && same == fresh.len() {
            return None;
        }
        Some(Splice {
            replace: a..b,
            fresh,
            first_change: a + same,
        })
    }

    pub fn splice(&mut self, s: Splice) {
        let a = s.replace.start;
        let end = a + s.fresh.len();
        self.rows.splice(s.replace, s.fresh);
        self.mark_days(a, end + 1);
    }

    pub fn opens_period(&self, i: usize, period: Period) -> bool {
        let row = &self.rows[i];
        match i {
            0 => {
                row.opens_day
                    && self.grid.first_date(row.t, period)
                        == self.grid.calendar.trade_date(Timestamp(row.t))
            }
            _ => period.of_day(row.day) != period.of_day(self.rows[i - 1].day),
        }
    }

    pub fn starts_cut(&self) -> bool {
        matches!(self.grid.bars, BarKind::Print(_)) && !self.first_opens
    }

    pub fn set_first_opens(&mut self, first_opens: bool) -> bool {
        let moved = self.first_opens != first_opens;
        self.first_opens = first_opens;
        if moved {
            self.mark_days(0, 1);
        }
        moved
    }

    pub fn read(&mut self, times: impl IntoIterator<Item = i64>, asked: u64) {
        for t in times {
            if let Ok(i) = self.find(t)
                && self.rows[i].unread.is_some_and(|edit| edit <= asked)
            {
                self.rows[i].unread = None;
            }
        }
    }

    pub fn unread_again(&mut self, edit: u64, of: impl Fn(&Row) -> bool) {
        for r in self.rows.iter_mut().filter(|r| of(r)) {
            r.unread = Some(edit);
        }
    }

    pub fn put_flow(&mut self, flows: &[(i64, Flow)]) -> Option<usize> {
        let mut first: Option<usize> = None;
        for (t, f) in flows {
            let Ok(i) = self.find(*t) else {
                continue;
            };
            if self.rows[i].flow.bits() != f.bits() {
                self.rows[i].flow = *f;
                first = Some(first.map_or(i, |k| k.min(i)));
            }
        }
        first
    }

    pub fn drop_front(&mut self, n: usize) {
        self.rows.drain(..n.min(self.rows.len()));
        self.mark_days(0, 1);
        if let Some(first) = self.first() {
            self.openings.forget_before(first);
        }
    }

    pub fn clear(&mut self) {
        self.rows.clear();
        self.first_opens = false;
        self.openings.clear();
    }

    fn mark_days(&mut self, from: usize, to: usize) {
        for i in from..to.min(self.rows.len()) {
            self.rows[i].opens_day = match i {
                0 => self.grid.opens_day(self.rows[0].t, self.first_opens),
                _ => self.rows[i].day != self.rows[i - 1].day,
            };
        }
    }

    pub fn arrays(&self) -> BarArrays {
        let col = |f: fn(&Row) -> f64| self.rows.iter().map(f).collect::<Vec<_>>();
        let has_bv = self.rows.iter().any(|r| !r.buy_volume.is_nan());
        BarArrays {
            time: self.rows.iter().map(|r| r.t as f64 / 1e9).collect(),
            open: col(|r| r.open),
            high: col(|r| r.high),
            low: col(|r| r.low),
            close: col(|r| r.close),
            volume: col(|r| r.volume),
            buy_volume: has_bv.then(|| col(|r| r.buy_volume)),
            calendar: self.grid.calendar,
        }
    }

    pub fn bytes(&self) -> usize {
        self.rows.capacity() * std::mem::size_of::<Row>() + self.openings.bytes()
    }
}
