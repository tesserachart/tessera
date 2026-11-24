mod openings;
mod rows;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;

use tessera_core::market::{AggressorSource, Bar};
use tessera_core::time::NANOS_PER_DAY;
use tessera_core::{Timeframe, Timestamp};
use tessera_market::io::PrintsLoaded;
use tessera_market::orderflow::flow::FlowRead;
use tessera_protocol::compact::CompactBar;
use tessera_protocol::layers::LayerKind;
use tessera_script::ScriptError;
use tokio::time::Instant;

pub(crate) use openings::{Minutes, MinutesAsk, Opening, bar_of, date_of};
pub use rows::{BarKind, Grid};
pub(crate) use rows::{Flow, Period, Rows, Span};
use tessera_market::orderflow::flow::Sides;

use crate::studies::{Drawn, Needs, Pulls, Study};

pub(crate) const FLOW_PULL_SESSIONS: usize = 5;
const PENDING_FLOWS: usize = 8;
const IDLE_STUDIES: usize = 8;

pub fn builtin_series(
    kind: LayerKind,
    inputs: &serde_json::Map<String, serde_json::Value>,
    bars: &[Bar],
    grid: Grid,
) -> Option<Vec<(String, Vec<f64>)>> {
    let study = crate::studies::native(kind, inputs)?;
    let key = StudyKey {
        id: StudyId::Builtin(kind),
        params: String::new(),
    };
    let mut f = Frame::new(grid);
    let bars: Vec<CompactBar> = bars.iter().map(CompactBar::from).collect();
    f.put_bars(Span::everything(), &bars);
    f.attach(&key, &study);
    let n = f.rows.len();
    f.values(&key, 0..n).map(|v| v.columns)
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum StudyId {
    Builtin(LayerKind),
    Custom { id: String, version: u32 },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct StudyKey {
    pub id: StudyId,
    pub params: String,
}

impl StudyKey {
    pub fn version(&self) -> Option<u32> {
        match &self.id {
            StudyId::Builtin(_) => None,
            StudyId::Custom { version, .. } => Some(*version),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct WatchKey(pub String);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Changed {
    pub at: usize,
    pub day: Option<f64>,
}

impl Changed {
    fn in_place(rows: &Rows, at: usize) -> Self {
        Self {
            at,
            day: rows.iter().nth(at).map(|r| r.day),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Due {
    Idle,
    Forming,
    Now,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Replaced {
    All,
    Span { from: i64, to: i64 },
}

#[derive(Clone, Debug)]
pub(crate) struct Change {
    pub replaces: Replaced,
    pub time: Vec<i64>,
    pub columns: Vec<(String, Vec<f64>)>,
    pub drawn: Option<Arc<Drawn>>,
    pub facts: Facts,
    pub error: Option<ScriptError>,
    pub compute_ms: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Facts {
    pub aggressor: Option<AggressorSource>,
    pub loaded: Option<PrintsLoaded>,
    pub filling: bool,
}

fn facts_of(flow: &FlowState, rows: &Rows, needs: Needs) -> Facts {
    let Needs::Flow(pulls) = needs else {
        return Facts::default();
    };
    let sessions = match pulls {
        Pulls::No => 0,
        Pulls::Sessions(n) => n as usize,
    };
    Facts {
        aggressor: flow.aggressor,
        loaded: (sessions > 0).then(|| loaded_of(flow, rows, sessions)),
        filling: flow.filling,
    }
}

fn loaded_of(flow: &FlowState, rows: &Rows, sessions: usize) -> PrintsLoaded {
    let mut days: Vec<(f64, bool)> = Vec::new();
    for row in rows.iter().rev() {
        let known = row.flow.sides.is_some();
        let full = days.len() == sessions;
        match days.last_mut() {
            Some((day, held)) if *day == row.day => *held &= known,
            _ if full => break,
            _ => days.push((row.day, known)),
        }
    }
    let held = days.iter().filter(|(_, held)| *held).count() as u32;
    let asked = days.len() as u32;
    PrintsLoaded {
        sessions: asked,
        held,
        refused: flow.refused && !flow.filling && held < asked,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Published {
    pub watch: WatchKey,
    pub indicator: String,
    pub tf: Timeframe,
    pub version: Option<u32>,
    pub rev: u64,
    pub change: Arc<Change>,
}

pub(crate) struct Snapshot {
    pub this: Published,
    pub others: Vec<Published>,
}

pub(crate) struct Values {
    pub time: Vec<i64>,
    pub columns: Vec<(String, Vec<f64>)>,
    pub drawn: Option<Arc<Drawn>>,
    pub error: Option<ScriptError>,
    pub computed_from: Option<i64>,
    pub rows: usize,
    pub compute_ms: f64,
}

struct Was {
    after: Option<i64>,
    time: Vec<i64>,
    columns: Vec<Vec<f64>>,
}

struct Entry {
    study: Arc<dyn Study>,
    cols: Vec<Vec<f64>>,
    upto: usize,
    held: Option<i64>,
    was: Option<Was>,
    all: bool,
    due: Due,
    ran_at: Option<Instant>,
    drawn: Option<Arc<Drawn>>,
    held_drawn: Option<Arc<Drawn>>,
    held_facts: Facts,
    error: Option<ScriptError>,
    compute_ms: f64,
    used: u64,
}

impl Entry {
    fn new(study: Arc<dyn Study>, used: u64) -> Self {
        let width = study.columns().len() + study.state();
        Self {
            study,
            cols: vec![Vec::new(); width],
            upto: 0,
            held: None,
            was: None,
            all: false,
            due: Due::Now,
            ran_at: None,
            drawn: None,
            held_drawn: None,
            held_facts: Facts::default(),
            error: None,
            compute_ms: 0.0,
            used,
        }
    }

    fn outputs(&self) -> usize {
        self.study.columns().len()
    }

    fn reset(&mut self) {
        self.upto = 0;
        self.was = None;
        self.all = self.held.is_some();
        self.due = Due::Now;
        for c in &mut self.cols {
            c.clear();
        }
    }

    fn invalidate(&mut self, rows: &Rows, changed: Changed, due: Due) {
        self.due = self.due.max(due);
        let r = self.study.restart(rows, changed).min(self.upto);
        if r >= self.upto {
            return;
        }
        if let Some(held) = self.held
            && !self.all
        {
            let after = r.checked_sub(1).map(|i| rows.time(i));
            let held_end = self.upto.min(rows.at_or_after(held.saturating_add(1)));
            let end = match &self.was {
                Some(w) => held_end.min(rows.at_or_after(w.time[0])),
                None => held_end,
            };
            let outputs = self.outputs();
            let mut time: Vec<i64> = (r..end.max(r)).map(|i| rows.time(i)).collect();
            let mut columns: Vec<Vec<f64>> = self.cols[..outputs]
                .iter()
                .map(|c| c[r..end.max(r)].to_vec())
                .collect();
            match self.was.take() {
                Some(w) => {
                    time.extend(w.time);
                    for (mine, theirs) in columns.iter_mut().zip(w.columns) {
                        mine.extend(theirs);
                    }
                    let after = match (after, w.after) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        _ => None,
                    };
                    self.was = Some(Was {
                        after,
                        time,
                        columns,
                    });
                }
                None if !time.is_empty() => {
                    self.was = Some(Was {
                        after,
                        time,
                        columns,
                    });
                }
                None => {}
            }
        }
        self.upto = r;
        for c in &mut self.cols {
            c.truncate(r);
        }
    }

    fn run(&mut self, rows: &Rows) {
        let n = rows.len();
        if self.upto >= n && self.cols.iter().all(|c| c.len() == n) {
            return;
        }
        for c in &mut self.cols {
            c.resize(n, f64::NAN);
        }
        let from = self
            .study
            .restart(rows, Changed::in_place(rows, self.upto))
            .min(self.upto);
        let started = std::time::Instant::now();
        let out = self.study.run(rows, &mut self.cols, from);
        self.compute_ms = started.elapsed().as_secs_f64() * 1000.0;
        self.upto = n;
        match out {
            Ok(drawn) => {
                if self.error.take().is_some() {
                    self.all = self.held.is_some();
                }
                self.drawn = drawn.map(Arc::new);
            }
            Err(e) => {
                for c in &mut self.cols {
                    c.fill(f64::NAN);
                }
                if self.error.as_ref() != Some(&e) {
                    self.all = self.held.is_some();
                }
                self.error = Some(e);
                self.drawn = None;
            }
        }
    }

    fn columns(&self, range: Range<usize>) -> Vec<(String, Vec<f64>)> {
        self.study
            .columns()
            .iter()
            .zip(&self.cols)
            .map(|(k, c)| (k.clone(), c[range.clone()].to_vec()))
            .collect()
    }

    fn whole(&mut self, rows: &Rows, from: usize, facts: Facts) -> Change {
        let drawn = self.drawn.clone().filter(|d| !d.objects.is_empty());
        Change {
            replaces: Replaced::All,
            time: (from..rows.len()).map(|i| rows.time(i)).collect(),
            columns: self.columns(from..rows.len()),
            drawn,
            facts,
            error: self.error.clone(),
            compute_ms: self.compute_ms,
        }
    }

    fn diff(&mut self, rows: &Rows, facts: Facts) -> Option<Change> {
        let held = self.held?;
        let n = rows.len();
        if self.all {
            self.all = false;
            self.was = None;
            self.held = Some(rows.last().unwrap_or(i64::MIN));
            self.held_drawn = self.drawn.clone();
            self.held_facts = facts;
            return Some(self.whole(rows, 0, facts));
        }
        let mut span: Option<(i64, i64)> = None;
        let mark = |span: &mut Option<(i64, i64)>, t: i64| {
            *span = Some(span.map_or((t, t), |(a, b)| (a.min(t), b.max(t))));
        };
        if let Some(w) = self.was.take() {
            let mut i = w.after.map_or(0, |a| rows.at_or_after(a.saturating_add(1)));
            let mut j = 0;
            let held_row = |i: usize| i < n && rows.time(i) <= held;
            while j < w.time.len() || held_row(i) {
                let ti = held_row(i).then(|| rows.time(i));
                let tj = w.time.get(j).copied();
                match (ti, tj) {
                    (Some(a), Some(b)) if a == b => {
                        let differs = w
                            .columns
                            .iter()
                            .zip(&self.cols)
                            .any(|(old, now)| old[j].to_bits() != now[i].to_bits());
                        if differs {
                            mark(&mut span, a);
                        }
                        i += 1;
                        j += 1;
                    }
                    (Some(a), Some(b)) if a < b => {
                        mark(&mut span, a);
                        i += 1;
                    }
                    (Some(a), None) => {
                        mark(&mut span, a);
                        i += 1;
                    }
                    (_, Some(b)) => {
                        mark(&mut span, b);
                        j += 1;
                    }
                    (None, None) => break,
                }
            }
        }
        let new_from = rows.at_or_after(held.saturating_add(1));
        if new_from < n {
            mark(&mut span, rows.time(new_from));
            mark(&mut span, rows.time(n - 1));
        }
        let drawn_changed = objects(&self.drawn) != objects(&self.held_drawn);
        let facts_changed = facts != self.held_facts;
        if span.is_none() && (drawn_changed || facts_changed) && n > 0 {
            mark(&mut span, rows.time(n - 1));
        }
        let (from, to) = span?;
        self.held = Some(rows.last().unwrap_or(i64::MIN));
        self.held_drawn = self.drawn.clone();
        self.held_facts = facts;
        let range = rows.at_or_after(from)..rows.at_or_after(to.saturating_add(1));
        Some(Change {
            replaces: Replaced::Span { from, to },
            time: range.clone().map(|i| rows.time(i)).collect(),
            columns: self.columns(range),
            drawn: drawn_changed.then(|| self.drawn.clone().unwrap_or_default()),
            facts,
            error: self.error.clone(),
            compute_ms: self.compute_ms,
        })
    }

    fn bytes(&self) -> usize {
        let cols: usize = self.cols.iter().map(|c| c.capacity() * 8).sum();
        let was = self
            .was
            .as_ref()
            .map_or(0, |w| w.time.len() * 8 * (1 + w.columns.len()));
        let drawn = self.drawn.as_ref().map_or(0, |d| d.bytes());
        let held = match (&self.held_drawn, &self.drawn) {
            (Some(h), Some(d)) if Arc::ptr_eq(h, d) => 0,
            (Some(h), _) => h.bytes(),
            (None, _) => 0,
        };
        cols + was + drawn + held
    }
}

fn objects(d: &Option<Arc<Drawn>>) -> Option<&tessera_protocol::indicators::IndicatorObjects> {
    d.as_ref().map(|d| &d.objects)
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Asked {
    pub indicator: String,
    pub tf: Timeframe,
    pub version: Option<u32>,
    pub inputs: serde_json::Map<String, serde_json::Value>,
}

struct Watch {
    study: StudyKey,
    asked: Asked,
    count: usize,
    rev: u64,
    all: bool,
    served: Option<i64>,
}

#[derive(Default)]
struct FlowState {
    filling: bool,
    edits: u64,
    aggressor: Option<AggressorSource>,
    refused: bool,
    pending: Vec<(i64, Sides)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FlowAsk {
    pub day: i64,
    pub edit: u64,
    pub opens: Vec<Timestamp>,
    pub pulls: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reached {
    Since(i64),
    Everything,
}

impl Reached {
    pub fn covers(self, t: i64) -> bool {
        match self {
            Reached::Since(from) => from <= t,
            Reached::Everything => true,
        }
    }
}

pub(crate) struct Frame {
    rows: Rows,
    source: Option<String>,
    settled_to: Option<i64>,
    stale: Vec<Span>,
    reached: Option<Reached>,
    flow: FlowState,
    entries: HashMap<StudyKey, Entry>,
    watches: HashMap<WatchKey, Watch>,
    uses: u64,
    generation: u64,
    live: Live,
}

const LIVE_KEPT: usize = 4;

#[derive(Default)]
struct Live {
    seq: u64,
    bars: Vec<(u64, CompactBar, bool)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReadMark {
    generation: u64,
    source: Option<String>,
    live: u64,
}

impl Frame {
    pub fn new(grid: Grid) -> Self {
        Self {
            rows: Rows::new(grid),
            source: None,
            settled_to: None,
            stale: Vec::new(),
            reached: None,
            flow: FlowState::default(),
            entries: HashMap::new(),
            watches: HashMap::new(),
            uses: 0,
            generation: 0,
            live: Live::default(),
        }
    }

    pub fn mark(&self) -> ReadMark {
        ReadMark {
            generation: self.generation,
            source: self.source.clone(),
            live: self.live.seq,
        }
    }

    pub fn holds(&self, mark: &ReadMark) -> bool {
        mark.generation == self.generation && mark.source == self.source
    }

    pub fn put_read(&mut self, span: Span, bars: &[CompactBar], mark: &ReadMark) -> Option<usize> {
        if !self.holds(mark) {
            return None;
        }
        let k = self.put_bars(span, bars);
        let since: Vec<(CompactBar, bool)> = self
            .live
            .bars
            .iter()
            .filter(|(seq, bar, _)| *seq > mark.live && span.contains(bar.0))
            .map(|(_, bar, closed)| (*bar, *closed))
            .collect();
        let again = since
            .iter()
            .filter_map(|(bar, closed)| self.upsert(bar, *closed))
            .min();
        match (k, again) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    pub fn rows(&self) -> &Rows {
        &self.rows
    }

    pub fn grid(&self) -> Grid {
        *self.rows.grid()
    }

    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    pub fn reached(&self) -> Option<Reached> {
        self.reached
    }

    pub fn settled_to(&self) -> Option<i64> {
        self.settled_to
    }

    pub fn reset(&mut self, source: String) {
        self.generation += 1;
        self.live = Live::default();
        self.source = Some(source);
        self.rows.clear();
        self.settled_to = None;
        self.stale.clear();
        self.reached = None;
        self.flow = FlowState::default();
        for e in self.entries.values_mut() {
            e.reset();
        }
    }

    pub fn put_bars(&mut self, span: Span, bars: &[CompactBar]) -> Option<usize> {
        self.flow.edits += 1;
        let edit = self.flow.edits;
        self.splice(span, bars, None, Some(edit), Due::Now)
    }

    pub fn put_built(
        &mut self,
        bars: &[CompactBar],
        flows: &[Flow],
        first_opens_session: bool,
    ) -> Option<usize> {
        let moved = self.rows.set_first_opens(first_opens_session);
        let k = self.splice(Span::everything(), bars, Some(flows), None, Due::Now);
        if moved {
            for e in self.entries.values_mut() {
                e.invalidate(&self.rows, Changed::in_place(&self.rows, 0), Due::Now);
            }
            return Some(0);
        }
        k
    }

    pub fn upsert(&mut self, bar: &CompactBar, closed: bool) -> Option<usize> {
        self.live.seq += 1;
        self.live.bars.retain(|(_, b, _)| b.0 != bar.0);
        self.live.bars.push((self.live.seq, *bar, closed));
        if self.live.bars.len() > LIVE_KEPT {
            self.live.bars.remove(0);
        }
        let t = bar.0;
        let forming = !closed && self.rows.last() == Some(t);
        let due = if forming { Due::Forming } else { Due::Now };
        let k = self.splice(Span::new(t, t), std::slice::from_ref(bar), None, None, due);
        if let Some(at) = self.flow.pending.iter().position(|(p, _)| *p == t) {
            let (_, sides) = self.flow.pending.remove(at);
            self.put_live_flow(t, sides);
        }
        k
    }

    fn splice(
        &mut self,
        span: Span,
        bars: &[CompactBar],
        flows: Option<&[Flow]>,
        unread: Option<u64>,
        due: Due,
    ) -> Option<usize> {
        let s = self.rows.splice_of(span, bars, flows, unread)?;
        let k = s.first_change;
        let changed = Changed {
            at: k,
            day: s.day_after(&self.rows),
        };
        for e in self.entries.values_mut() {
            e.invalidate(&self.rows, changed, due);
        }
        self.rows.splice(s);
        Some(k)
    }

    pub fn reached_to(&mut self, to: Reached) {
        self.reached = Some(match (self.reached, to) {
            (Some(Reached::Since(was)), Reached::Since(t)) => Reached::Since(was.min(t)),
            (Some(Reached::Everything), _) | (_, Reached::Everything) => Reached::Everything,
            (None, t) => t,
        });
    }

    pub fn settle(&mut self, edge_open: i64) {
        self.settled_to = Some(edge_open);
    }

    pub fn mark_stale(&mut self, span: Span) {
        let (Some(first), Some(last)) = (self.rows.first(), self.rows.last()) else {
            return;
        };
        self.rows
            .openings_mut()
            .forget_within(span.from, span.to.saturating_add(NANOS_PER_DAY));
        let span = Span::new(span.from.max(first), span.to.min(last));
        if span.from <= span.to && !self.stale.contains(&span) {
            self.stale.push(span);
        }
    }

    pub fn stale(&self) -> &[Span] {
        &self.stale
    }

    pub fn reread(&mut self, span: Span) {
        self.stale.retain(|s| *s != span);
    }

    pub fn flow_pulls(&self) -> Option<Pulls> {
        self.entries
            .values()
            .filter_map(|e| match e.study.needs() {
                Needs::Bars => None,
                Needs::Flow(pulls) => Some(pulls),
            })
            .max()
    }

    pub fn provisional_flow(&self, from: i64) -> Option<FlowAsk> {
        if matches!(self.grid().bars, BarKind::Print(_)) {
            return None;
        }
        let pulls = self.flow_pulls()? != Pulls::No;
        let start = self.rows.at_or_after(from);
        let last = self.rows.iter().next_back()?;
        (start < self.rows.len()).then(|| FlowAsk {
            day: last.day as i64,
            edit: self.flow.edits,
            opens: (start..self.rows.len())
                .map(|i| Timestamp(self.rows.time(i)))
                .collect(),
            pulls,
        })
    }

    pub fn trim(&mut self, max: usize) -> bool {
        let n = self.rows.len();
        if n <= max + max / 4 {
            return false;
        }
        self.rows.drop_front(n - max);
        self.reached = self.rows.first().map(Reached::Since);
        for e in self.entries.values_mut() {
            e.reset();
        }
        true
    }

    pub fn opening_asks(&self, now: i64, also: Option<Opening>) -> Vec<MinutesAsk> {
        let mut wanted: Vec<Opening> = Vec::new();
        for o in self
            .entries
            .values()
            .filter_map(|e| e.study.opening())
            .chain(also)
        {
            if !wanted.contains(&o) {
                wanted.push(o);
            }
        }
        if wanted.is_empty() {
            return Vec::new();
        }
        self.rows
            .openings()
            .asks(&self.rows.sessions(), &wanted, self.rows.grid(), now)
    }

    pub fn put_minutes(&mut self, reads: Vec<(MinutesAsk, Minutes)>) -> Option<usize> {
        let mut first: Option<usize> = None;
        for (ask, minutes) in reads {
            if self.rows.openings_mut().put(ask.start, minutes) {
                let k = self.rows.at_or_after(ask.start).saturating_sub(1);
                first = Some(first.map_or(k, |f| f.min(k)));
            }
        }
        let k = first.filter(|k| *k < self.rows.len())?;
        for e in self.entries.values_mut() {
            if e.study.opening().is_some() {
                e.invalidate(&self.rows, Changed::in_place(&self.rows, k), Due::Now);
            }
        }
        Some(k)
    }

    pub fn put_flow(&mut self, flows: &[(i64, Flow)], forming: bool) -> Option<usize> {
        let mut first = None;
        for (t, f) in flows {
            if self.rows.find(*t).is_err() {
                continue;
            }
            if let Some(k) = self.rows.put_flow(&[(*t, *f)]) {
                first = Some(first.map_or(k, |a: usize| a.min(k)));
            }
        }
        let k = first?;
        let due = if forming { Due::Forming } else { Due::Now };
        for e in self.entries.values_mut() {
            if e.study.needs().reads_flow() {
                e.invalidate(&self.rows, Changed::in_place(&self.rows, k), due);
            }
        }
        Some(k)
    }

    pub fn put_live_flow(&mut self, t: i64, sides: Sides) -> Option<usize> {
        let Ok(i) = self.rows.find(t) else {
            self.flow.pending.retain(|(p, _)| *p != t);
            self.flow.pending.push((t, sides));
            if self.flow.pending.len() > PENDING_FLOWS {
                self.flow.pending.remove(0);
            }
            return None;
        };
        let forming = i + 1 == self.rows.len();
        let flow = self.rows[i].flow.with_sides(sides);
        self.put_flow(&[(t, flow)], forming)
    }

    pub fn wants_flow(&self) -> Option<Pulls> {
        self.watches
            .values()
            .filter_map(|w| self.entries.get(&w.study))
            .filter_map(|e| match e.study.needs() {
                Needs::Bars => None,
                Needs::Flow(pulls) => Some(pulls),
            })
            .max()
    }

    pub fn flow_tail(&self) -> Option<FlowAsk> {
        if matches!(self.grid().bars, BarKind::Print(_)) {
            return None;
        }
        let n = self.rows.len();
        let last = self.rows.iter().next_back()?;
        Some(FlowAsk {
            day: last.day as i64,
            edit: self.flow.edits,
            opens: (n.saturating_sub(2)..n)
                .map(|i| Timestamp(self.rows.time(i)))
                .collect(),
            pulls: false,
        })
    }

    pub fn flow_asks(&self, from: i64, pulls: Pulls) -> Vec<FlowAsk> {
        let pulled = match pulls {
            Pulls::No => 0,
            Pulls::Sessions(n) => n as usize,
        };
        if matches!(self.grid().bars, BarKind::Print(_)) {
            return Vec::new();
        }
        let mut asks = Vec::new();
        let mut end = self.rows.len();
        let mut sessions = 0;
        while end > 0 && self.rows.time(end - 1) >= from {
            let day = self.rows[end - 1].day;
            let mut start = end - 1;
            while start > 0 && self.rows[start - 1].day == day {
                start -= 1;
            }
            sessions += 1;
            let opens: Vec<Timestamp> = (start..end)
                .filter(|&i| self.rows[i].unread.is_some() && self.rows.time(i) >= from)
                .map(|i| Timestamp(self.rows.time(i)))
                .collect();
            if !opens.is_empty() {
                asks.push(FlowAsk {
                    day: day as i64,
                    edit: self.flow.edits,
                    opens,
                    pulls: sessions <= pulled,
                });
            }
            end = start;
        }
        asks
    }

    pub fn put_flow_reads(&mut self, reads: &[(FlowAsk, FlowRead)]) -> Option<usize> {
        let mut flows: Vec<(i64, Flow)> = Vec::new();
        for (ask, read) in reads {
            flows.extend(
                ask.opens
                    .iter()
                    .zip(&read.bars)
                    .filter_map(|(t, f)| f.map(|f| (t.0, Flow::of(f)))),
            );
            self.flow.aggressor = read.aggressor_source.or(self.flow.aggressor);
            self.flow.filling |= read.filling;
            self.flow.refused = read.refused;
            let answered = ask.opens.get(read.unread..).unwrap_or_default();
            self.rows.read(answered.iter().map(|t| t.0), ask.edit);
        }
        flows.sort_by_key(|(t, _)| *t);
        let k = self.put_flow(&flows, false);
        if k.is_none() {
            for e in self.entries.values_mut() {
                if e.study.needs().reads_flow() {
                    e.due = Due::Now;
                }
            }
        }
        k
    }

    pub fn put_flow_tail(&mut self, ask: &FlowAsk, read: &FlowRead) -> Option<usize> {
        let flows: Vec<(i64, Flow)> = ask
            .opens
            .iter()
            .zip(&read.bars)
            .filter_map(|(t, f)| f.map(|f| (t.0, Flow::of(f))))
            .collect();
        self.flow.aggressor = read.aggressor_source.or(self.flow.aggressor);
        self.rows.read(flows.iter().map(|(t, _)| *t), ask.edit);
        self.put_flow(&flows, true)
    }

    pub fn refill_unknown(&mut self) {
        self.flow.edits += 1;
        self.flow.filling = false;
        self.rows.unread_again(self.flow.edits, |r| !r.flow.known());
    }

    pub fn flow_filling(&self) -> bool {
        self.flow.filling
    }

    pub fn attach(&mut self, key: &StudyKey, study: &Arc<dyn Study>) {
        self.uses += 1;
        let used = self.uses;
        match self.entries.get_mut(key) {
            Some(e) => e.used = used,
            None => {
                self.entries
                    .insert(key.clone(), Entry::new(Arc::clone(study), used));
                self.forget_idle_studies();
            }
        }
    }

    fn forget_idle_studies(&mut self) {
        let watched: Vec<&StudyKey> = self.watches.values().map(|w| &w.study).collect();
        let mut idle: Vec<(u64, StudyKey)> = self
            .entries
            .iter()
            .filter(|(k, _)| !watched.contains(k))
            .map(|(k, e)| (e.used, k.clone()))
            .collect();
        if idle.len() <= IDLE_STUDIES {
            return;
        }
        idle.sort_by_key(|(used, _)| *used);
        for (_, k) in &idle[..idle.len() - IDLE_STUDIES] {
            self.entries.remove(k);
        }
    }

    pub fn watch(
        &mut self,
        watch: &WatchKey,
        asked: Asked,
        key: &StudyKey,
        study: &Arc<dyn Study>,
    ) {
        self.attach(key, study);
        let w = self.watches.entry(watch.clone()).or_insert_with(|| Watch {
            study: key.clone(),
            asked,
            count: 0,
            rev: 0,
            all: false,
            served: None,
        });
        w.count += 1;
        if w.study != *key {
            w.study = key.clone();
            w.all = true;
        }
    }

    pub fn rebind(&mut self, watch: &WatchKey, key: &StudyKey, study: &Arc<dyn Study>) {
        self.attach(key, study);
        if let Some(w) = self.watches.get_mut(watch)
            && w.study != *key
        {
            w.study = key.clone();
            w.all = true;
        }
        if let Some(e) = self.entries.get_mut(key) {
            e.due = Due::Now;
        }
    }

    pub fn unwatch(&mut self, watch: &WatchKey) {
        let Some(w) = self.watches.get_mut(watch) else {
            return;
        };
        w.count -= 1;
        if w.count > 0 {
            return;
        }
        let study = w.study.clone();
        self.watches.remove(watch);
        if !self.watches.values().any(|w| w.study == study)
            && let Some(e) = self.entries.get_mut(&study)
        {
            e.held = None;
            e.was = None;
            e.all = false;
        }
        self.forget_idle_studies();
    }

    #[cfg(test)]
    pub fn is_watched(&self, watch: &WatchKey) -> bool {
        self.watches.contains_key(watch)
    }

    pub fn watched_custom(&self) -> Vec<(WatchKey, Asked)> {
        self.watches
            .iter()
            .filter(|(_, w)| matches!(w.study.id, StudyId::Custom { .. }))
            .map(|(k, w)| (k.clone(), w.asked.clone()))
            .collect()
    }

    pub fn snapshot(&mut self, watch: &WatchKey, from: Option<i64>) -> Option<Snapshot> {
        let key = self.watches.get(watch)?.study.clone();
        let facts = self
            .entries
            .get(&key)
            .map(|e| facts_of(&self.flow, &self.rows, e.study.needs()))
            .unwrap_or_default();
        let rows = &self.rows;
        let e = self.entries.get_mut(&key)?;
        e.run(rows);
        let caught_up = match e.held {
            Some(_) => e.diff(rows, facts).map(Arc::new),
            None => {
                e.held = Some(rows.last().unwrap_or(i64::MIN));
                e.held_drawn = e.drawn.clone();
                e.held_facts = facts;
                e.was = None;
                e.all = false;
                None
            }
        };
        let start = from.map_or(0, |t| rows.at_or_after(t));
        let first = if start < rows.len() {
            rows.time(start)
        } else {
            i64::MAX
        };
        let change = Arc::new(e.whole(rows, start, facts));
        let mut others = Vec::new();
        for (wk, w) in &mut self.watches {
            if w.study != key {
                continue;
            }
            if let Some(c) = &caught_up {
                w.rev += 1;
                others.push(Published {
                    watch: wk.clone(),
                    indicator: w.asked.indicator.clone(),
                    tf: w.asked.tf,
                    version: key.version(),
                    rev: w.rev,
                    change: Arc::clone(c),
                });
            }
        }
        let w = self.watches.get_mut(watch)?;
        w.served = Some(w.served.map_or(first, |s| s.max(first)));
        Some(Snapshot {
            this: Published {
                watch: watch.clone(),
                indicator: w.asked.indicator.clone(),
                tf: w.asked.tf,
                version: key.version(),
                rev: w.rev,
                change,
            },
            others,
        })
    }

    pub fn advance(&mut self, now: Instant) -> Vec<Published> {
        let watched: std::collections::HashSet<StudyKey> =
            self.watches.values().map(|w| w.study.clone()).collect();
        let mut changes: HashMap<StudyKey, Arc<Change>> = HashMap::new();
        let rebound: Vec<StudyKey> = self
            .watches
            .values()
            .filter(|w| w.all)
            .map(|w| w.study.clone())
            .collect();
        for key in watched {
            let Some(e) = self.entries.get_mut(&key) else {
                continue;
            };
            let due = match e.due {
                Due::Idle => false,
                Due::Now => true,
                Due::Forming => e.ran_at.is_none_or(|r| now >= r + e.study.forming_every()),
            };
            if !due && !rebound.contains(&key) {
                continue;
            }
            e.run(&self.rows);
            if due {
                e.due = Due::Idle;
                e.ran_at = Some(now);
            }
            let facts = facts_of(&self.flow, &self.rows, e.study.needs());
            if e.held.is_none() {
                e.held = Some(self.rows.last().unwrap_or(i64::MIN));
                e.held_drawn = e.drawn.clone();
                e.held_facts = facts;
                e.all = false;
                e.was = None;
                continue;
            }
            if let Some(c) = e.diff(&self.rows, facts) {
                changes.insert(key, Arc::new(c));
            }
        }
        let mut out = Vec::new();
        for (wk, w) in &mut self.watches {
            let change = if w.all {
                let Some(e) = self.entries.get_mut(&w.study) else {
                    continue;
                };
                w.all = false;
                let facts = facts_of(&self.flow, &self.rows, e.study.needs());
                Arc::new(e.whole(&self.rows, 0, facts))
            } else {
                match changes.get(&w.study) {
                    Some(c) => Arc::clone(c),
                    None => continue,
                }
            };
            match change.replaces {
                Replaced::All => w.served = self.rows.first(),
                Replaced::Span { from, to } => {
                    if let Some(served) = w.served
                        && from < served
                        && self.rows.at_or_after(to.saturating_add(1))
                            >= self.rows.at_or_after(served)
                    {
                        w.served = Some(from);
                    }
                }
            }
            w.rev += 1;
            out.push(Published {
                watch: wk.clone(),
                indicator: w.asked.indicator.clone(),
                tf: w.asked.tf,
                version: w.study.version(),
                rev: w.rev,
                change,
            });
        }
        out
    }

    pub fn serve_from(&mut self, from: i64) -> Vec<Published> {
        let Frame {
            rows,
            entries,
            watches,
            ..
        } = self;
        let a = rows.at_or_after(from);
        let mut out = Vec::new();
        for (wk, w) in watches.iter_mut() {
            let b = w.served.map_or(0, |t| rows.at_or_after(t));
            if a >= b {
                continue;
            }
            let Some(e) = entries.get_mut(&w.study) else {
                continue;
            };
            e.run(rows);
            let change = Change {
                replaces: Replaced::Span {
                    from: rows.time(a),
                    to: rows.time(b - 1),
                },
                time: (a..b).map(|i| rows.time(i)).collect(),
                columns: e.columns(a..b),
                drawn: None,
                facts: Facts::default(),
                error: e.error.clone(),
                compute_ms: e.compute_ms,
            };
            w.served = Some(rows.time(a));
            w.rev += 1;
            out.push(Published {
                watch: wk.clone(),
                indicator: w.asked.indicator.clone(),
                tf: w.asked.tf,
                version: w.study.version(),
                rev: w.rev,
                change: Arc::new(change),
            });
        }
        out
    }

    pub fn next_due(&self) -> Option<Instant> {
        self.watches
            .values()
            .filter_map(|w| self.entries.get(&w.study))
            .filter(|e| e.due == Due::Forming)
            .map(|e| {
                e.ran_at
                    .map_or_else(Instant::now, |r| r + e.study.forming_every())
            })
            .min()
    }

    pub fn values(&mut self, key: &StudyKey, range: Range<usize>) -> Option<Values> {
        let rows = &self.rows;
        let e = self.entries.get_mut(key)?;
        e.run(rows);
        let range = range.start.min(rows.len())..range.end.min(rows.len());
        Some(Values {
            time: range.clone().map(|i| rows.time(i)).collect(),
            columns: e.columns(range),
            drawn: e.drawn.clone(),
            error: e.error.clone(),
            computed_from: rows.first(),
            rows: rows.len(),
            compute_ms: e.compute_ms,
        })
    }

    pub fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.rows.bytes()
            + self.entries.values().map(Entry::bytes).sum::<usize>()
    }
}
