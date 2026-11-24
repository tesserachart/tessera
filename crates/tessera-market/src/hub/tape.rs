use std::collections::VecDeque;

use tessera_core::market::{Aggressor, AggressorSource, DataSource, Trade};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};
use tessera_store::ticks::TickRow;

pub const TAPE_MAX: usize = 100_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Cut {
    pub(crate) recording: Option<(u64, u64)>,
    pub(crate) held: u64,
    pub(crate) first: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Print {
    pub(crate) t: i64,
    price: f64,
    size: f64,
    order: u32,
    side: i8,
    keyed: bool,
    replayed: bool,
}

impl Print {
    pub(crate) fn of(t: &Trade) -> Self {
        Self {
            t: t.ts.0,
            price: t.price.to_f64(),
            size: t.size.to_f64(),
            order: t.order_key.unwrap_or(0),
            side: t.aggressor.sign(),
            keyed: t.order_key.is_some(),
            replayed: t.aggressor_source == AggressorSource::ReplayMapped,
        }
    }

    pub(crate) fn of_row(r: &TickRow) -> Self {
        Self {
            t: r.t,
            price: r.price.to_f64(),
            size: r.size.to_f64(),
            order: r.order_key.unwrap_or(0),
            side: r.aggressor.sign(),
            keyed: r.order_key.is_some(),
            replayed: r.aggressor_source == AggressorSource::ReplayMapped,
        }
    }

    pub(crate) fn trade(
        &self,
        instrument: &InstrumentId,
        recorded: Option<AggressorSource>,
        source: Option<&DataSource>,
    ) -> Trade {
        Trade {
            instrument: instrument.clone(),
            ts: Timestamp(self.t),
            price: Price::from_f64(self.price).unwrap_or_default(),
            size: Qty::from_f64(self.size).unwrap_or_default(),
            aggressor: Aggressor::from_sign(self.side),
            aggressor_source: if self.replayed {
                AggressorSource::ReplayMapped
            } else {
                recorded.unwrap_or(AggressorSource::Inferred)
            },
            order_key: self.keyed.then_some(self.order),
            source: source.cloned(),
        }
    }
}

#[derive(Debug)]
pub struct Tape {
    instrument: InstrumentId,
    prints: VecDeque<Print>,
    cap: usize,
    count: u64,
    segment: Option<u64>,
    segment_first: Option<i64>,
    generation: u64,
    evicted: Option<i64>,
    aggressor_source: Option<AggressorSource>,
    source: Option<DataSource>,
}

impl Tape {
    pub fn new(instrument: InstrumentId, cap: usize) -> Self {
        Self {
            instrument,
            prints: VecDeque::new(),
            cap: cap.max(1),
            count: 0,
            segment: None,
            segment_first: None,
            generation: 0,
            evicted: None,
            aggressor_source: None,
            source: None,
        }
    }

    pub fn begin(&mut self, source: DataSource) -> u64 {
        self.segment = Some(self.count + 1);
        self.segment_first = None;
        self.source = Some(source);
        self.generation += 1;
        self.generation
    }

    pub fn end(&mut self, generation: u64) {
        if generation == self.generation {
            self.segment = None;
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn is_recording(&self) -> bool {
        self.segment.is_some()
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn aggressor_source(&self) -> Option<AggressorSource> {
        self.aggressor_source
    }

    fn first(&self) -> u64 {
        self.count + 1 - self.prints.len() as u64
    }

    pub(crate) fn push(&mut self, trades: &[Trade], recorded: &mut Vec<Print>) -> u64 {
        for t in trades {
            if self.prints.len() == self.cap {
                let seq = self.first();
                if let Some(gone) = self.prints.pop_front() {
                    self.evicted = Some(gone.t);
                    if self.segment.is_some_and(|s| seq >= s) {
                        recorded.push(gone);
                    }
                }
            } else if self.prints.len() == self.prints.capacity() {
                // `VecDeque` doubles its capacity when it is full.
                let want = (self.prints.capacity() * 2).max(1024).min(self.cap);
                self.prints.reserve_exact(want - self.prints.len());
            }
            self.prints.push_back(Print::of(t));
            self.count += 1;
            if self.segment == Some(self.count) {
                self.segment_first = Some(t.ts.0);
            }
            if t.aggressor != Aggressor::Unknown {
                self.aggressor_source = Some(t.aggressor_source);
            }
        }
        self.count
    }

    pub fn complete_since(&self) -> Option<Timestamp> {
        let seg = self.segment?;
        let first = self.first();
        let held = if seg >= first {
            self.prints.get((seg - first) as usize)
        } else {
            let after = self.evicted?;
            self.prints.iter().find(|p| p.t > after)
        };
        held.map(|p| Timestamp(p.t))
    }

    pub(crate) fn cut(&self) -> Cut {
        let held = self.first();
        Cut {
            recording: self.segment.map(|s| (self.generation, s)),
            held,
            first: self.segment_first,
        }
    }

    pub(crate) fn segment_prints(&self) -> Vec<Print> {
        let Some(seg) = self.segment else {
            return Vec::new();
        };
        let skip = seg.saturating_sub(self.first()) as usize;
        self.prints.iter().skip(skip).copied().collect()
    }

    pub fn source(&self) -> Option<&DataSource> {
        self.source.as_ref()
    }

    pub fn last_ts(&self) -> Option<Timestamp> {
        self.prints.back().map(|p| Timestamp(p.t))
    }

    pub fn read(
        &self,
        after: u64,
        from: Option<Timestamp>,
        to: Option<Timestamp>,
        limit: Option<usize>,
    ) -> Vec<Trade> {
        let skip = (after + 1).saturating_sub(self.first()) as usize;
        let (lo, hi) = (from.map_or(i64::MIN, |t| t.0), to.map_or(i64::MAX, |t| t.0));
        let limit = limit.unwrap_or(usize::MAX);
        let mut out: Vec<Trade> = self
            .prints
            .iter()
            .skip(skip)
            .rev()
            .filter(|p| p.t >= lo && p.t < hi)
            .take(limit)
            .map(|p| self.trade(p))
            .collect();
        out.reverse();
        out
    }

    pub fn read_segment(
        &self,
        from: Option<Timestamp>,
        to: Option<Timestamp>,
        limit: Option<usize>,
    ) -> Vec<Trade> {
        match self.segment {
            Some(seg) => self.read(seg - 1, from, to, limit),
            None => Vec::new(),
        }
    }

    fn trade(&self, p: &Print) -> Trade {
        p.trade(
            &self.instrument,
            self.aggressor_source,
            self.source.as_ref(),
        )
    }

    pub fn is_empty(&self) -> bool {
        self.prints.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.prints.capacity() * std::mem::size_of::<Print>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn src() -> DataSource {
        DataSource {
            provider: "feed".into(),
        }
    }

    fn push(tape: &mut Tape, trades: &[Trade]) -> u64 {
        tape.push(trades, &mut Vec::new())
    }

    fn print(t: i64, price: &str, size: &str, aggressor: Aggressor) -> Trade {
        Trade {
            instrument: InstrumentId::new("BTCUSD").unwrap(),
            ts: Timestamp(t),
            price: Price::from_str(price).unwrap(),
            size: Qty::from_str(size).unwrap(),
            aggressor,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: Some(src()),
        }
    }

    #[test]
    fn prints_round_trip_exactly_and_are_numbered() {
        let mut tape = Tape::new(InstrumentId::new("BTCUSD").unwrap(), 4);
        assert_eq!(tape.complete_since(), None);
        let first = tape.begin(src());
        let a = [
            print(10, "98412.37", "0.0123", Aggressor::Buy),
            Trade {
                order_key: Some(0),
                ..print(20, "98411.5", "1", Aggressor::Sell)
            },
        ];
        assert_eq!(push(&mut tape, &a), 2);
        assert_eq!(tape.read(0, None, None, None), a);
        assert_eq!(tape.complete_since(), Some(Timestamp(10)));
        let b = [
            print(30, "98410", "2.5", Aggressor::Unknown),
            print(40, "98413.25", "0.5", Aggressor::Buy),
            print(50, "98414", "3", Aggressor::Sell),
        ];
        assert_eq!(push(&mut tape, &b), 5);
        assert_eq!(tape.read(0, None, None, None).len(), 4);
        assert_eq!(tape.read(3, None, None, None), b[1..]);
        assert_eq!(
            tape.read(0, Some(Timestamp(30)), Some(Timestamp(50)), None),
            b[..2]
        );
        assert_eq!(tape.read(0, None, None, Some(2)), b[1..]);
        assert_eq!(tape.complete_since(), Some(Timestamp(20)));

        tape.end(first);
        assert_eq!(tape.complete_since(), None);
        assert!(tape.read_segment(None, None, None).is_empty());
        let second = tape.begin(src());
        tape.end(first);
        assert!(tape.is_recording(), "a late cleanup of the old feed");
        assert_eq!(tape.complete_since(), None, "nothing recorded yet");
        push(&mut tape, &[print(90, "98415", "1", Aggressor::Buy)]);
        assert_eq!(tape.complete_since(), Some(Timestamp(90)));
        assert_eq!(tape.read_segment(None, None, None).len(), 1);
        assert_eq!(tape.aggressor_source(), Some(AggressorSource::Exchange));
        tape.end(second);
        assert!(!tape.is_recording());
    }

    #[test]
    fn a_partly_dropped_sweep_is_not_counted_complete() {
        let mut tape = Tape::new(InstrumentId::new("BTCUSD").unwrap(), 2);
        tape.begin(src());
        push(
            &mut tape,
            &[
                print(10, "98410", "1", Aggressor::Buy),
                print(20, "98411", "1", Aggressor::Buy),
                print(20, "98412", "1", Aggressor::Buy),
                print(20, "98413", "1", Aggressor::Buy),
            ],
        );
        assert_eq!(tape.read(0, None, None, None).len(), 2);
        assert_eq!(tape.complete_since(), None, "nothing after the sweep yet");
        push(&mut tape, &[print(30, "98414", "1", Aggressor::Sell)]);
        assert_eq!(tape.complete_since(), Some(Timestamp(30)));
        let mut big = Tape::new(InstrumentId::new("BTCUSD").unwrap(), TAPE_MAX);
        big.begin(src());
        let p = print(1, "98410", "1", Aggressor::Buy);
        for _ in 0..(TAPE_MAX / 1000 + 3) {
            push(&mut big, &vec![p.clone(); 1000]);
        }
        assert_eq!(big.bytes(), TAPE_MAX * std::mem::size_of::<Print>());
        assert_eq!(
            std::mem::size_of::<Print>(),
            32,
            "the order key costs no room"
        );
    }
}
