use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::time::Instant;

use chrono::NaiveDate;
use tessera_core::market::Trade;
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_HOUR, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Timestamp};
use tessera_store::ticks::{Span, TickRow, holes};

use super::gaps::{Gaps, session_parts};
use super::past::Known;
use super::{FILL_SPAN, Flow, REFUSED_AGAIN, REFUSED_AGAIN_MAX};
use crate::provider::MarketDataProvider;
use crate::router::MarketRouter;
use crate::saved::{self, Contract, DayPin, SavedTrades, by_trade_date};

const LOOKBACK: i64 = 24 * NANOS_PER_HOUR;
const SESSION_READ_POLL: Duration = Duration::from_millis(250);

#[derive(Clone, Debug)]
pub(crate) struct Disk {
    pub(crate) saved: Arc<SavedTrades>,
    pub(crate) contract: Contract,
    pub(crate) calendar: SessionCalendar,
}

#[derive(Debug)]
pub(crate) struct Stored {
    pub(crate) rows: Vec<TickRow>,
    pub(crate) covered: Vec<Span>,
    pub(crate) gaps: Gaps,
    pub(crate) refused: Vec<Span>,
    pub(crate) scanned: Span,
}

pub(crate) enum FillStep {
    Saved(Span, Vec<TickRow>),
    Ask(Span),
}

impl Disk {
    pub(crate) fn stored(
        &self,
        from: Option<i64>,
        before: i64,
        limit: Option<usize>,
    ) -> tessera_store::Result<Stored> {
        let store = self.saved.store();
        let key = self.contract.key();
        let floor = match from {
            Some(f) => f.min(before),
            None => store.oldest(key)?.unwrap_or(before).min(before),
        };
        let mut parts = Vec::new();
        let mut held = 0;
        let mut at = before;
        let full = loop {
            let lo = match from {
                Some(_) => floor,
                None => at.saturating_sub(LOOKBACK).max(floor),
            };
            let mut rows = store.read(key, lo, at)?;
            if let Some(l) = limit {
                let left = l.saturating_sub(held);
                rows.drain(..rows.len().saturating_sub(left));
            }
            held += rows.len();
            parts.push(rows);
            at = lo;
            let full = limit.is_some_and(|l| held >= l);
            if full || at <= floor {
                break full;
            }
        };
        parts.reverse();
        let rows = parts.concat();
        let seen_from = match rows.first() {
            Some(r) if full => r.t,
            _ => at,
        };
        let scanned = Span::new(seen_from, before);
        let covered = store.covered(key, scanned.start, scanned.end)?;
        let gaps = Gaps::in_session(Some(self.calendar), holes(&covered, scanned));
        let refused = self.refused(scanned)?;
        Ok(Stored {
            rows,
            covered,
            gaps,
            refused,
            scanned,
        })
    }

    pub(crate) fn refused(&self, span: Span) -> tessera_store::Result<Vec<Span>> {
        let since = self
            .calendar
            .last_sessions(Timestamp::now(), 1)
            .first()
            .map_or(i64::MAX, |s| s.open.0);
        let newest = self
            .saved
            .store()
            .refused_since(self.contract.key(), span.start, since)?
            .iter()
            .map(|r| r.end)
            .max();
        Ok(newest
            .map(|end| Span::new(span.start, end.min(span.end)))
            .filter(|s| !s.is_empty())
            .into_iter()
            .collect())
    }

    pub(crate) fn remember_refused(&self, span: Span) {
        let store = Arc::clone(self.saved.store());
        let (source, instrument) = (
            self.contract.source.clone(),
            self.contract.instrument.clone(),
        );
        tokio::task::spawn_blocking(move || {
            let key = tessera_store::ticks::TickKey {
                source: &source,
                instrument: instrument.as_str(),
            };
            if let Err(e) = store.refuse(key, span, Timestamp::now().0) {
                tracing::warn!(%instrument, error = %e, "a refused span was not remembered");
            }
        });
    }

    pub(crate) fn fill_step(&self, floor: i64, to: i64) -> tessera_store::Result<FillStep> {
        let store = self.saved.store();
        let key = self.contract.key();
        let mut whole_from = to;
        let mut below = floor;
        for c in store.covered(key, floor, to)?.iter().rev() {
            if c.end >= whole_from && c.start < whole_from {
                whole_from = c.start;
            } else if c.end < whole_from {
                below = c.end.max(floor);
                break;
            }
        }
        if whole_from < to {
            let from = whole_from.max(floor);
            return Ok(FillStep::Saved(
                Span::new(from, to),
                store.read(key, from, to)?,
            ));
        }
        Ok(FillStep::Ask(Span::new(below.max(to - FILL_SPAN), to)))
    }

    pub(crate) fn missing(&self, want: Span) -> tessera_store::Result<Vec<Span>> {
        let missing = self
            .saved
            .store()
            .missing(self.contract.key(), want.start, want.end)?;
        let refused = self.refused(want)?;
        Ok(missing
            .into_iter()
            .flat_map(|m| unrefused(&refused, m))
            .collect())
    }

    pub(crate) fn source(&self) -> tessera_core::market::DataSource {
        tessera_core::market::DataSource {
            provider: self.contract.source.clone(),
        }
    }
}

pub(crate) fn unrefused(refused: &[Span], want: Span) -> Vec<Span> {
    let left = holes(refused, want);
    if left == [want] {
        return left;
    }
    left.into_iter()
        .filter(|h| h.end - h.start >= NANOS_PER_SEC)
        .collect()
}

#[derive(Debug)]
pub(crate) struct Saving {
    disk: Disk,
    from: Option<i64>,
    pending: Vec<TickRow>,
}

impl Saving {
    pub(crate) fn new(disk: Disk) -> Self {
        Self {
            disk,
            from: None,
            pending: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, batch: &[Trade]) {
        if self.from.is_none() {
            self.from = batch.iter().map(|t| t.ts.0).min();
        }
        self.pending.extend(batch.iter().map(TickRow::of));
    }

    pub(crate) fn flush(&mut self) {
        let (Some(from), Some(cut)) = (self.from, self.pending.iter().map(|r| r.t).max()) else {
            return;
        };
        if cut <= from {
            return;
        }
        let (rows, held) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|r| r.t < cut);
        self.pending = held;
        self.from = Some(cut);
        self.save(rows, Span::new(from, cut));
    }

    pub(crate) fn end(mut self) {
        let (Some(from), Some(last)) = (self.from, self.pending.iter().map(|r| r.t).max()) else {
            return;
        };
        let rows = std::mem::take(&mut self.pending);
        self.save(rows, Span::new(from, last + 1));
    }

    fn save(&self, rows: Vec<TickRow>, span: Span) {
        let d = &self.disk;
        d.saved.save(d.contract.clone(), d.calendar, rows, span);
    }
}

#[derive(Debug, Default)]
pub(crate) struct Shown {
    pumps: usize,
    pins: HashMap<(Contract, NaiveDate), DayPin>,
}

impl Shown {
    pub(crate) fn open(&mut self) {
        self.pumps += 1;
    }

    #[must_use]
    pub(crate) fn close(&mut self) -> HashMap<(Contract, NaiveDate), DayPin> {
        self.pumps = self.pumps.saturating_sub(1);
        if self.pumps == 0 {
            std::mem::take(&mut self.pins)
        } else {
            HashMap::new()
        }
    }

    pub(crate) fn is_shown(&self) -> bool {
        self.pumps > 0
    }

    pub(crate) fn pin(&mut self, disk: &Disk, span: Span) {
        if !self.is_shown() {
            return;
        }
        for (date, _) in by_trade_date(disk.calendar, span) {
            self.pins
                .entry((disk.contract.clone(), date))
                .or_insert_with(|| disk.saved.pin(&disk.contract, date));
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Pull {
    #[default]
    Idle,
    Pulling {
        want: Span,
    },
    Refused {
        floor: i64,
        again: Instant,
    },
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Reach {
    pull: Pull,
    asked: Vec<Span>,
    refusals: u32,
    held_back: bool,
}

pub(crate) struct Wanted {
    pub(crate) start: bool,
    pub(crate) loading: bool,
}

impl Reach {
    pub(crate) fn want(&mut self, want: Span, work: bool) -> Wanted {
        if !work {
            return Wanted {
                start: false,
                loading: false,
            };
        }
        match self.pull {
            Pull::Idle => self.start(want),
            Pull::Refused { again, .. } if Instant::now() >= again => self.start(want),
            Pull::Pulling { want: held } => {
                self.pull = Pull::Pulling {
                    want: Span::new(held.start.min(want.start), held.end.max(want.end)),
                };
                Wanted {
                    start: false,
                    loading: true,
                }
            }
            Pull::Refused { .. } => Wanted {
                start: false,
                loading: false,
            },
        }
    }

    fn start(&mut self, want: Span) -> Wanted {
        self.pull = Pull::Pulling { want };
        Wanted {
            start: true,
            loading: true,
        }
    }

    pub(crate) fn next(
        &self,
        calendar: SessionCalendar,
        missing: &[Span],
        within: Span,
    ) -> Option<Span> {
        let floor = match self.pull {
            Pull::Refused { floor, again } if Instant::now() < again => floor,
            Pull::Idle | Pull::Pulling { .. } | Pull::Refused { .. } => i64::MIN,
        };
        missing
            .iter()
            .rev()
            .filter_map(|m| {
                let s = Span::new(m.start.max(within.start).max(floor), m.end.min(within.end));
                (!s.is_empty()).then_some(s)
            })
            .flat_map(|m| holes(&self.asked, m).into_iter().rev())
            .find_map(|h| session_parts(calendar, h).pop())
            .map(|p| Span::new(p.start.max(p.end - FILL_SPAN), p.end))
    }

    pub(crate) fn is_refused(&self) -> bool {
        self.held_back || matches!(self.pull, Pull::Refused { .. })
    }

    pub(crate) fn hold_back(&mut self, refused: bool) {
        self.held_back = refused;
    }

    pub(crate) fn is_pulling(&self) -> bool {
        self.wanted().is_some()
    }

    fn wanted(&self) -> Option<Span> {
        match self.pull {
            Pull::Pulling { want } => Some(want),
            Pull::Idle | Pull::Refused { .. } => None,
        }
    }

    fn mark(&mut self, chunk: Span) {
        self.refusals = 0;
        let i = self.asked.partition_point(|s| s.start < chunk.start);
        self.asked.insert(i, chunk);
        let mut merged: Vec<Span> = Vec::with_capacity(self.asked.len());
        for s in self.asked.drain(..) {
            match merged.last_mut() {
                Some(last) if last.end >= s.start => last.end = last.end.max(s.end),
                _ => merged.push(s),
            }
        }
        self.asked = merged;
    }

    fn settle(&mut self, want: Span) -> bool {
        if self.wanted() == Some(want) {
            self.pull = Pull::Idle;
            return true;
        }
        false
    }

    fn refuse(&mut self, floor: i64) {
        self.refusals = self.refusals.saturating_add(1);
        let wait = tessera_core::backoff::Backoff::new(REFUSED_AGAIN, REFUSED_AGAIN_MAX)
            .delay(self.refusals);
        self.pull = Pull::Refused {
            floor,
            again: Instant::now() + wait,
        };
    }

    pub(crate) fn reopen(&mut self) {
        self.refusals = 0;
        if let Pull::Refused { .. } = self.pull {
            self.pull = Pull::Idle;
        }
    }
}

pub(crate) async fn pull_after_session_read(
    flow: &Arc<Flow>,
    router: Arc<MarketRouter>,
    disk: Disk,
    id: InstrumentId,
    want: Span,
) -> bool {
    let Some(held) = flow.held() else {
        return false;
    };
    let weak = Arc::downgrade(flow);
    if !held.loading {
        return pull_unheld(&weak, router, disk, id, want, held).await;
    }
    let waiting = WaitingPull::new(flow);
    tokio::spawn(async move {
        let _waiting = waiting;
        if let Some(held) = after_session_read(&weak).await {
            pull_unheld(&weak, router, disk, id, want, held).await;
        }
    });
    true
}

async fn after_session_read(flow: &Weak<Flow>) -> Option<Known> {
    loop {
        let held = flow.upgrade().and_then(|f| f.held())?;
        if !held.loading {
            return Some(held);
        }
        tokio::time::sleep(SESSION_READ_POLL).await;
    }
}

async fn pull_unheld(
    flow: &Weak<Flow>,
    router: Arc<MarketRouter>,
    disk: Disk,
    id: InstrumentId,
    want: Span,
    held: Known,
) -> bool {
    let want = match held.from {
        Some(from) => Span::new(want.start, want.end.min(from.0)),
        None => want,
    };
    if want.is_empty() {
        return false;
    }
    let missing = {
        let d = disk.clone();
        match tokio::task::spawn_blocking(move || d.missing(want)).await {
            Ok(Ok(m)) => m,
            _ => return false,
        }
    };
    let Some(f) = flow.upgrade() else {
        return false;
    };
    let wanted = {
        let shown = f.shown.lock().is_shown();
        let mut r = f.reach.lock();
        let work = shown && r.next(disk.calendar, &missing, want).is_some();
        r.want(want, work)
    };
    if wanted.start {
        spawn_reach(&f, router, disk, id);
    }
    wanted.loading
}

struct WaitingPull(Weak<Flow>);

impl WaitingPull {
    fn new(flow: &Arc<Flow>) -> Self {
        flow.pulls_waiting.fetch_add(1, Ordering::Relaxed);
        Self(Arc::downgrade(flow))
    }
}

impl Drop for WaitingPull {
    fn drop(&mut self) {
        if let Some(f) = self.0.upgrade() {
            f.pulls_waiting.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

pub(crate) fn spawn_reach(
    flow: &Arc<Flow>,
    router: Arc<MarketRouter>,
    disk: Disk,
    id: InstrumentId,
) {
    let flow = Arc::downgrade(flow);
    tokio::spawn(async move {
        let now = router
            .quote(&id)
            .await
            .map_or_else(|_| Timestamp::now(), |q| q.ts);
        reach(&flow, &router, &disk, &id, now).await;
    });
}

async fn reach(
    flow: &Weak<Flow>,
    router: &MarketRouter,
    disk: &Disk,
    id: &InstrumentId,
    now: Timestamp,
) {
    pull(flow, router, disk, id, now).await;
    if let Some(f) = flow.upgrade() {
        f.filled.send_modify(|n| *n += 1);
    }
}

async fn pull(
    flow: &Weak<Flow>,
    router: &MarketRouter,
    disk: &Disk,
    id: &InstrumentId,
    now: Timestamp,
) {
    let _foreground = router.foreground().enter();
    loop {
        let Some(want) = flow.upgrade().and_then(|f| f.reach.lock().wanted()) else {
            return;
        };
        let missing = {
            let d = disk.clone();
            match tokio::task::spawn_blocking(move || d.missing(want)).await {
                Ok(Ok(m)) => m,
                _ => Vec::new(),
            }
        };
        let Some(f) = flow.upgrade() else { return };
        let shown = f.shown.lock().is_shown();
        let chunk = {
            let mut r = f.reach.lock();
            if !shown {
                r.pull = Pull::Idle;
                return;
            }
            match r.next(disk.calendar, &missing, want) {
                Some(c) => c,
                None if r.settle(want) => return,
                None => continue,
            }
        };
        f.shown.lock().pin(disk, chunk);
        drop(f);
        let answer = super::once_served(router, id, || saved::ask(router, id, chunk)).await;
        let Some(f) = flow.upgrade() else { return };
        match answer {
            Ok(rows) => {
                let (d, c) = (disk.clone(), disk.contract.clone());
                let kept = tokio::task::spawn_blocking(move || {
                    d.saved.save_answer(&c, d.calendar, &rows, chunk, now)
                })
                .await;
                if let Ok(Err(e)) = kept {
                    tracing::warn!(%id, error = %e, "older trades were not saved");
                }
                f.reach.lock().mark(chunk);
                if opens_its_session(disk.calendar, chunk) {
                    f.filled.send_modify(|n| *n += 1);
                }
            }
            Err(e) => {
                tracing::info!(%id, error = %e, "the connection gave no older trades");
                if matches!(e, crate::provider::MarketError::Unsupported(_)) {
                    disk.remember_refused(chunk);
                }
                f.reach.lock().refuse(chunk.end);
            }
        }
    }
}

fn opens_its_session(calendar: SessionCalendar, chunk: Span) -> bool {
    calendar
        .session(calendar.trade_date(Timestamp(chunk.start)))
        .is_some_and(|s| s.open.0 == chunk.start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::time::local_to_timestamp;

    fn at(d: u32, h: u32, m: u32) -> i64 {
        let cal = SessionCalendar::CmeEquityIndex;
        local_to_timestamp(
            cal.tz(),
            NaiveDate::from_ymd_opt(2026, 10, d).unwrap(),
            h,
            m,
        )
        .0
    }

    #[test]
    fn a_reach_asks_the_newest_unasked_session_time_in_half_hours() {
        let cal = SessionCalendar::CmeEquityIndex;
        let mut r = Reach::default();
        let want = Span::new(at(1, 15, 0), at(2, 9, 0));
        let missing = [Span::new(at(1, 15, 0), at(1, 18, 30))];
        assert_eq!(
            r.next(cal, &missing, want),
            Some(Span::new(at(1, 18, 0), at(1, 18, 30)))
        );
        r.mark(Span::new(at(1, 18, 0), at(1, 18, 30)));
        assert_eq!(
            r.next(cal, &missing, want),
            Some(Span::new(at(1, 16, 30), at(1, 17, 0))),
            "the maintenance hour is skipped"
        );
        r.refuse(at(1, 17, 0));
        assert_eq!(r.next(cal, &missing, want), None);
        r.reopen();
        assert!(r.next(cal, &missing, want).is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_reach_asks_again_after_a_wait_that_doubles_with_each_refusal() {
        let cal = SessionCalendar::CmeEquityIndex;
        let mut r = Reach::default();
        let want = Span::new(at(1, 15, 0), at(2, 9, 0));
        let missing = [Span::new(at(1, 15, 0), at(1, 18, 30))];
        assert!(r.want(want, true).start);
        r.refuse(at(1, 18, 30));
        assert_eq!(r.next(cal, &missing, want), None);
        assert!(!r.want(want, true).loading, "a refusal settles the read");
        tokio::time::advance(REFUSED_AGAIN).await;
        assert!(r.next(cal, &missing, want).is_some());
        assert!(r.want(want, true).start, "the next read asks again");
        r.refuse(at(1, 18, 30));
        tokio::time::advance(REFUSED_AGAIN).await;
        assert_eq!(r.next(cal, &missing, want), None, "twice as long after two");
        tokio::time::advance(REFUSED_AGAIN).await;
        assert!(r.want(want, true).start);
        for _ in 0..12 {
            r.refuse(at(1, 18, 30));
        }
        tokio::time::advance(REFUSED_AGAIN_MAX).await;
        assert!(
            r.want(want, true).start,
            "never longer than the longest wait"
        );
        r.mark(Span::new(at(1, 18, 0), at(1, 18, 30)));
        r.refuse(at(1, 18, 0));
        tokio::time::advance(REFUSED_AGAIN).await;
        assert!(r.want(want, true).start, "an answer starts the waits over");
    }

    fn disk_holding(spans: &[Span]) -> Disk {
        let calendar = SessionCalendar::CmeEquityIndex;
        let saved = SavedTrades::new(Arc::new(
            tessera_store::ticks::TickStore::open_in_memory().unwrap(),
        ));
        let contract = Contract::new("test", &InstrumentId::new("NQZ6.CME").unwrap());
        for s in spans {
            let rows: Vec<TickRow> = (s.start..s.end)
                .step_by(NANOS_PER_HOUR as usize / 4)
                .filter(|t| calendar.is_open(Timestamp(*t)))
                .map(|t| TickRow {
                    t,
                    price: tessera_core::Price(rust_decimal::Decimal::from(24_000)),
                    size: tessera_core::Qty::from(1),
                    aggressor: tessera_core::market::Aggressor::Buy,
                    aggressor_source: tessera_core::market::AggressorSource::Exchange,
                    order_key: None,
                })
                .collect();
            saved.save_now(&contract, calendar, &rows, *s).unwrap();
        }
        Disk {
            saved,
            contract,
            calendar,
        }
    }

    #[test]
    fn a_stored_read_holds_every_row_around_its_holes_and_names_each_one() {
        let disk = disk_holding(&[
            Span::new(at(26, 18, 0), at(27, 17, 0)),
            Span::new(at(27, 18, 0), at(28, 10, 0)),
            Span::new(at(28, 11, 0), at(28, 17, 0)),
        ]);
        let read = disk
            .stored(Some(at(26, 18, 0)), at(29, 17, 0), None)
            .unwrap();
        assert_eq!(read.rows.first().map(|r| r.t), Some(at(26, 18, 0)));
        assert_eq!(read.rows.last().map(|r| r.t), Some(at(28, 16, 45)));
        assert_eq!(read.rows.len(), 23 * 4 + 16 * 4 + 6 * 4);
        assert_eq!(
            read.gaps.spans(),
            &[
                Span::new(at(28, 10, 0), at(28, 11, 0)),
                Span::new(at(28, 18, 0), at(29, 17, 0)),
            ],
            "the hole inside a day and the day not stored, never the closed hours"
        );
    }

    #[test]
    fn a_newest_read_walks_back_past_a_hole_until_it_holds_enough() {
        let disk = disk_holding(&[
            Span::new(at(26, 18, 0), at(27, 17, 0)),
            Span::new(at(28, 18, 0), at(29, 17, 0)),
        ]);
        let read = disk.stored(None, at(29, 17, 0), Some(100)).unwrap();
        assert_eq!(read.rows.len(), 100);
        assert_eq!(read.rows.last().map(|r| r.t), Some(at(29, 16, 45)));
        assert_eq!(
            read.gaps.spans(),
            &[Span::new(at(27, 18, 0), at(28, 17, 0))],
            "the day between them"
        );
        let all = disk.stored(None, at(29, 17, 0), Some(1_000)).unwrap();
        assert_eq!(
            all.rows.len(),
            2 * 23 * 4,
            "it stops at the oldest saved day"
        );
    }
}
