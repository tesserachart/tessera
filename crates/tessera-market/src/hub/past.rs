use std::collections::VecDeque;
use std::ops::Range;
use std::sync::Arc;

use tessera_core::market::{AggressorSource, DataSource, Trade};
use tessera_core::{InstrumentId, Timestamp};

use super::tape::{Cut, Print};

const CHUNK: usize = 4096;
pub const PAST_MAX: usize = 2_500_000;

#[derive(Debug)]
struct Run {
    chunks: VecDeque<Arc<[Print]>>,
    from: i64,
    to: i64,
    len: usize,
}

impl Run {
    fn empty(at: i64) -> Self {
        Self {
            chunks: VecDeque::new(),
            from: at,
            to: at,
            len: 0,
        }
    }

    fn prepend(&mut self, from: i64, prints: &[Print]) {
        for c in prints.chunks(CHUNK).rev() {
            self.chunks.push_front(Arc::from(c));
        }
        self.len += prints.len();
        self.from = from.min(self.from);
    }

    fn append(&mut self, to: i64, prints: &[Print]) {
        for c in prints.chunks(CHUNK) {
            self.chunks.push_back(Arc::from(c));
        }
        self.len += prints.len();
        self.to = to.max(self.to);
    }

    fn join(&mut self, newer: Run) {
        self.len += newer.len;
        self.chunks.extend(newer.chunks);
        self.to = newer.to;
    }

    fn drop_before(&mut self, at: i64) {
        while let Some(first) = self.chunks.front() {
            if first.last().is_some_and(|p| p.t < at) {
                self.len -= first.len();
                self.chunks.pop_front();
            } else {
                break;
            }
        }
        self.from = self.from.max(at);
    }
}

#[derive(Debug, Default)]
struct Evicted {
    generation: u64,
    dropped: usize,
    whole_from: Option<i64>,
    frozen: VecDeque<Arc<[Print]>>,
    open: Vec<Print>,
}

impl Evicted {
    fn len(&self) -> usize {
        self.frozen.len() * CHUNK + self.open.len()
    }

    fn drop_oldest(&mut self) -> bool {
        let Some(gone) = self.frozen.pop_front() else {
            return false;
        };
        self.dropped += gone.len();
        let next = self
            .frozen
            .front()
            .and_then(|c| c.first())
            .or(self.open.first());
        self.whole_from = next.map(|p| p.t).or_else(|| gone.last().map(|p| p.t + 1));
        true
    }

    fn push(&mut self, p: Print) {
        self.open.push(p);
        if self.open.len() == CHUNK {
            self.frozen
                .push_back(Arc::from(std::mem::take(&mut self.open)));
        }
    }

    fn take(&mut self) -> Vec<Print> {
        let mut out = Vec::with_capacity(self.len());
        for c in self.frozen.drain(..) {
            out.extend_from_slice(&c);
        }
        out.append(&mut self.open);
        out
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Slice {
    prints: Arc<[Print]>,
    range: Range<usize>,
}

impl Slice {
    fn whole(prints: Arc<[Print]>) -> Self {
        let range = 0..prints.len();
        Self { prints, range }
    }

    fn prints(&self) -> &[Print] {
        &self.prints[self.range.clone()]
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Known {
    pub(crate) from: Option<Timestamp>,
    pub(crate) loading: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Past {
    active: bool,
    kept: Option<Run>,
    joins: Option<u64>,
    fill: Option<(u64, Run)>,
    evicted: Evicted,
    filling: Option<u64>,
}

impl Past {
    pub(crate) fn activate(&mut self) {
        self.active = true;
    }

    pub(crate) fn is_active(&self) -> bool {
        self.active
    }

    pub(crate) fn len(&self) -> usize {
        self.kept.as_ref().map_or(0, |r| r.len)
            + self.fill.as_ref().map_or(0, |(_, r)| r.len)
            + self.evicted.len()
    }

    pub(crate) fn bytes(&self) -> usize {
        self.len() * std::mem::size_of::<Print>()
    }

    pub(crate) fn absorb(&mut self, generation: u64, gone: Vec<Print>) {
        if !self.active || gone.is_empty() {
            return;
        }
        if self.evicted.generation != generation {
            self.evicted = Evicted {
                generation,
                ..Evicted::default()
            };
        }
        for p in gone {
            self.evicted.push(p);
        }
        self.cap();
    }

    pub(crate) fn end_segment(&mut self, generation: u64, held: Vec<Print>) {
        if !self.active {
            return;
        }
        let mut prints = if self.evicted.generation == generation {
            self.evicted.take()
        } else {
            Vec::new()
        };
        self.evicted = Evicted::default();
        prints.extend(held);
        prints.sort_by_key(|p| p.t);
        if self.filling == Some(generation) {
            self.filling = None;
        }
        let fill = self.fill.take().filter(|(g, _)| *g == generation);
        let joined = self.joins.take() == Some(generation);
        let Some((first, last)) = prints.first().zip(prints.last()).map(|(a, b)| (a.t, b.t)) else {
            if let Some((_, run)) = fill {
                self.keep_older(run);
            }
            return;
        };
        let mut run = match (fill, joined) {
            (Some((_, fill)), _) => {
                self.keep_older(fill);
                self.kept.take().unwrap_or_else(|| Run::empty(first))
            }
            (None, true) => self.kept.take().unwrap_or_else(|| Run::empty(first)),
            (None, false) => Run::empty(first),
        };
        let at = run.to;
        let newer: Vec<Print> = prints.into_iter().filter(|p| p.t >= at).collect();
        run.append(last + 1, &newer);
        self.kept = Some(run);
        self.cap();
    }

    fn keep_older(&mut self, fill: Run) {
        match self.kept.take() {
            Some(mut kept) if kept.to >= fill.from => {
                kept.join(fill);
                self.kept = Some(kept);
            }
            _ => self.kept = Some(fill),
        }
    }

    pub(crate) fn start_fill(&mut self, generation: u64) {
        if self.active {
            self.filling = Some(generation);
        }
    }

    pub(crate) fn end_fill(&mut self, generation: u64) {
        if self.filling == Some(generation) {
            self.filling = None;
        }
    }

    pub(crate) fn next_gap(
        &mut self,
        generation: u64,
        session_open: i64,
        join_at: i64,
    ) -> Option<(i64, i64)> {
        if let Some(kept) = &mut self.kept {
            kept.drop_before(session_open);
            if kept.to <= session_open {
                self.kept = None;
                self.joins = None;
            }
        }
        if self.joins == Some(generation) {
            let from = self.kept.as_ref()?.from;
            return (from > session_open).then_some((session_open, from));
        }
        let floor = self
            .kept
            .as_ref()
            .map_or(session_open, |k| k.to.max(session_open));
        if !self.fill.as_ref().is_some_and(|(g, _)| *g == generation) {
            self.fill = Some((generation, Run::empty(join_at)));
        }
        let fill_from = self.fill.as_ref().map(|(_, r)| r.from)?;
        if fill_from <= floor {
            self.close_fill(generation);
            return self.next_gap(generation, session_open, join_at);
        }
        Some((floor, fill_from))
    }

    pub(crate) fn commit(&mut self, generation: u64, from: i64, prints: &[Print]) {
        if self.joins == Some(generation) {
            if let Some(kept) = &mut self.kept {
                kept.prepend(from, prints);
            }
        } else if let Some((g, fill)) = &mut self.fill
            && *g == generation
        {
            fill.prepend(from, prints);
            let floor = self.kept.as_ref().map_or(i64::MIN, |k| k.to);
            if from <= floor {
                self.close_fill(generation);
            }
        }
        self.cap();
    }

    fn close_fill(&mut self, generation: u64) {
        if let Some((_, fill)) = self.fill.take() {
            self.keep_older(fill);
            self.joins = Some(generation);
        }
    }

    fn cap(&mut self) {
        while self.len() > PAST_MAX {
            let oldest = match (&mut self.kept, &mut self.fill) {
                (Some(kept), _) if !kept.chunks.is_empty() => kept,
                (_, Some((_, fill))) if !fill.chunks.is_empty() => fill,
                _ => {
                    self.kept = None;
                    self.joins = None;
                    if let Some((_, fill)) = &mut self.fill {
                        fill.from = fill.to;
                    }
                    if self.evicted.drop_oldest() {
                        continue;
                    }
                    return;
                }
            };
            if let Some(first) = oldest.chunks.pop_front() {
                oldest.len -= first.len();
            }
            oldest.from = oldest
                .chunks
                .front()
                .and_then(|c| c.first())
                .map_or(oldest.to, |p| p.t);
        }
    }

    pub(crate) fn known(&self, cut: &Cut) -> Known {
        let Some((generation, _)) = cut.recording else {
            return Known::default();
        };
        let loading = self.filling == Some(generation);
        let from = if self.joins == Some(generation) {
            self.kept.as_ref().map(|k| k.from)
        } else if let Some((_, fill)) = self
            .fill
            .as_ref()
            .filter(|(g, r)| *g == generation && r.from < r.to)
        {
            Some(fill.from)
        } else {
            cut.first
        };
        let lost = (self.evicted.generation == generation)
            .then_some(self.evicted.whole_from)
            .flatten();
        Known {
            from: from.max(lost).map(Timestamp),
            loading,
        }
    }

    pub(crate) fn slices(&self, cut: &Cut) -> Vec<Slice> {
        let mut out: Vec<Slice> = self
            .kept
            .iter()
            .chain(self.fill.iter().map(|(_, r)| r))
            .flat_map(|r| r.chunks.iter().cloned().map(Slice::whole))
            .collect();
        let Some((generation, seg)) = cut.recording else {
            return out;
        };
        let before = cut.first.unwrap_or(i64::MAX);
        for s in &mut out {
            let keep = s.prints().partition_point(|p| p.t < before);
            s.range.end = s.range.start + keep;
        }
        if self.evicted.generation == generation {
            let mut left = usize::try_from(cut.held.saturating_sub(seg))
                .unwrap_or(usize::MAX)
                .saturating_sub(self.evicted.dropped);
            for c in &self.evicted.frozen {
                let n = c.len().min(left);
                out.push(Slice {
                    prints: Arc::clone(c),
                    range: 0..n,
                });
                left -= n;
            }
            let n = self.evicted.open.len().min(left);
            if n > 0 {
                out.push(Slice::whole(Arc::from(&self.evicted.open[..n])));
            }
        }
        out.retain(|s| !s.range.is_empty());
        out
    }
}

pub(crate) fn trades_of(
    slices: &[Slice],
    from: Option<Timestamp>,
    to: Option<Timestamp>,
    limit: Option<usize>,
    instrument: &InstrumentId,
    recorded: Option<AggressorSource>,
    source: Option<&DataSource>,
) -> Vec<Trade> {
    let (lo, hi) = (from.map_or(i64::MIN, |t| t.0), to.map_or(i64::MAX, |t| t.0));
    let mut out: Vec<Trade> = Vec::new();
    let mut left = limit.unwrap_or(usize::MAX);
    for s in slices.iter().rev() {
        if left == 0 {
            break;
        }
        let prints = s.prints();
        let a = prints.partition_point(|p| p.t < lo);
        let b = prints.partition_point(|p| p.t < hi);
        let take = (b - a.min(b)).min(left);
        out.extend(
            prints[b - take..b]
                .iter()
                .rev()
                .map(|p| p.trade(instrument, recorded, source)),
        );
        left -= take;
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::tape::Tape;
    use tessera_core::market::Aggressor;
    use tessera_core::{Price, Qty};

    fn id() -> InstrumentId {
        InstrumentId::new("NQZ6.CME").unwrap()
    }

    fn print(t: i64, aggressor_source: AggressorSource) -> Trade {
        Trade {
            instrument: id(),
            ts: Timestamp(t),
            price: Price::from(100),
            size: Qty::from(1),
            aggressor: Aggressor::Buy,
            aggressor_source,
            order_key: None,
            source: None,
        }
    }

    struct Desk {
        tape: Tape,
        past: Past,
    }

    impl Desk {
        fn new(cap: usize) -> Self {
            let mut past = Past::default();
            past.activate();
            Self {
                tape: Tape::new(id(), cap),
                past,
            }
        }

        fn begin(&mut self) -> u64 {
            let g = self.tape.begin(DataSource {
                provider: "feed".into(),
            });
            self.past.start_fill(g);
            g
        }

        fn record(&mut self, times: std::ops::Range<i64>) {
            let trades: Vec<Trade> = times.map(|t| print(t, AggressorSource::Exchange)).collect();
            let mut gone = Vec::new();
            self.tape.push(&trades, &mut gone);
            self.past.absorb(self.tape.generation(), gone);
        }

        fn lose(&mut self, g: u64) {
            self.past.end_segment(g, self.tape.segment_prints());
            self.tape.end(g);
        }

        fn replay(&mut self, g: u64, open: i64, join: i64, every: i64) {
            while let Some((floor, to)) = self.past.next_gap(g, open, join) {
                let from = floor.max(to - 25);
                let first = from + (every - from.rem_euclid(every)) % every;
                let prints: Vec<Print> = (first..to)
                    .step_by(every as usize)
                    .map(|t| Print::of(&print(t, AggressorSource::ReplayMapped)))
                    .collect();
                self.past.commit(g, from, &prints);
            }
            self.past.end_fill(g);
        }

        fn read(&self) -> (Vec<(i64, AggressorSource)>, Known) {
            let cut = self.tape.cut();
            let mut out = trades_of(
                &self.past.slices(&cut),
                None,
                None,
                None,
                &id(),
                self.tape.aggressor_source(),
                None,
            );
            out.extend(self.tape.read_segment(None, None, None));
            let known = self.past.known(&cut);
            (
                out.iter().map(|t| (t.ts.0, t.aggressor_source)).collect(),
                known,
            )
        }
    }

    fn replayed(times: impl Iterator<Item = i64>) -> Vec<(i64, AggressorSource)> {
        times.map(|t| (t, AggressorSource::ReplayMapped)).collect()
    }

    fn recorded(times: std::ops::Range<i64>) -> Vec<(i64, AggressorSource)> {
        times.map(|t| (t, AggressorSource::Exchange)).collect()
    }

    #[test]
    fn a_reconnect_keeps_what_was_recorded_and_its_gap_fills_back_to_the_session_open() {
        let mut d = Desk::new(10);
        let first = d.begin();
        d.record(100..130);
        let (_, known) = d.read();
        assert_eq!(known.from, Some(Timestamp(100)));
        assert!(
            known.loading,
            "the session before the recording is being read"
        );
        d.replay(first, 0, 100, 10);
        let (got, known) = d.read();
        let mut want = replayed((0..100).step_by(10));
        want.extend(recorded(100..130));
        assert_eq!(
            got, want,
            "the tape let 20 prints go, the session keeps them"
        );
        assert_eq!(known.from, Some(Timestamp(0)));
        assert!(!known.loading);

        d.lose(first);
        let second = d.begin();
        d.record(160..170);
        let (got, known) = d.read();
        assert_eq!(known.from, Some(Timestamp(160)), "the gap is not known yet");
        assert_eq!(&got[..want.len()], &want[..], "nothing recorded is lost");
        d.replay(second, 0, 160, 5);
        let (got, known) = d.read();
        want.extend(replayed((130..160).step_by(5)));
        want.extend(recorded(160..170));
        assert_eq!(got, want);
        assert_eq!(
            known.from,
            Some(Timestamp(0)),
            "whole again from the session's open"
        );
    }

    #[test]
    fn a_session_read_that_finds_nothing_leaves_the_recording_known_from_its_start() {
        let mut d = Desk::new(10);
        let g = d.begin();
        d.record(500..505);
        assert_eq!(
            d.past.next_gap(g, 0, 400),
            Some((0, 400)),
            "the session closed at 400"
        );
        d.past.end_fill(g);
        let (got, known) = d.read();
        assert_eq!(got, recorded(500..505));
        assert_eq!(known.from, Some(Timestamp(500)));
        assert!(!known.loading);
        d.lose(g);
        let (got, known) = d.read();
        assert_eq!(got, recorded(500..505), "a stopped recording still answers");
        assert_eq!(known, Known::default(), "but says nothing is whole");
    }
}
