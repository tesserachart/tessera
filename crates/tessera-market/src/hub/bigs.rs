use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use tessera_core::Timestamp;
use tessera_core::market::Trade;
use tessera_core::time::NANOS_PER_MILLI;
use tessera_tools::ToolError;

use crate::io::BigTrade;
use crate::orderflow::big_trades::{
    AggressorOrder, BigTradeModel, Closed, Contract, EventCloser, Grouping, to_wire,
};
use crate::orderflow::tools::PARTIAL_MODEL_TTL;

const RECENT_BIGS: usize = 2000;
const WAITING_MAX: usize = 10_000;
const CLOCK_SLACK_NS: i64 = 150 * NANOS_PER_MILLI;
const RETRY: Duration = Duration::from_secs(30);
const WHILE_PULLING: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug)]
struct Loaded {
    at: Instant,
    partial: bool,
    pulling: bool,
    failed: bool,
}

#[derive(Debug, Default)]
pub struct LiveBigs {
    closer: Option<EventCloser>,
    model: Option<Arc<BigTradeModel>>,
    loaded: Option<Loaded>,
    loading: bool,
    waiting: VecDeque<(AggressorOrder, Option<u64>)>,
    recent: VecDeque<BigTrade>,
    last: Option<(Timestamp, Instant)>,
}

impl LiveBigs {
    pub fn start(&mut self, contract: Contract) {
        self.closer = Some(EventCloser::new(contract, Grouping::default()));
        self.waiting.clear();
        self.last = None;
    }

    pub fn restart(&mut self) {
        if let Some(c) = &self.closer {
            self.closer = Some(EventCloser::new(c.contract(), Grouping::default()));
        }
        self.last = None;
    }

    pub fn wants_model(&mut self, now: Instant) -> Option<Timestamp> {
        if self.loading || self.closer.is_none() {
            return None;
        }
        let at = self
            .waiting
            .front()
            .map(|(o, _)| o.t)
            .or_else(|| self.last.map(|(t, _)| t))?;
        let since = |when: Instant| now.duration_since(when);
        let due = match (&self.model, self.loaded) {
            (_, Some(l)) if l.pulling => since(l.at) >= WHILE_PULLING,
            (None, l) => l.is_none_or(|l| since(l.at) >= RETRY),
            (_, Some(l)) if l.failed => since(l.at) >= RETRY,
            (Some(m), l) => {
                m.trade_date(at) != m.date
                    || l.is_some_and(|l| l.partial && since(l.at) >= PARTIAL_MODEL_TTL)
            }
        };
        if due {
            self.loading = true;
            return Some(at);
        }
        None
    }

    pub fn set_model(&mut self, model: Result<Arc<BigTradeModel>, ToolError>) {
        self.loading = false;
        let partial = model.as_ref().map_or(true, |m| m.partial);
        let pulling = model.as_ref().is_ok_and(|m| m.pulling);
        let failed = model.is_err();
        if let Ok(m) = model
            && !pulling
        {
            self.model = Some(m);
        }
        self.loaded = Some(Loaded {
            at: Instant::now(),
            partial,
            pulling,
            failed,
        });
    }

    pub fn clock(&self) -> Option<Timestamp> {
        let (t, at) = self.last?;
        let lag = i64::try_from(at.elapsed().as_nanos()).unwrap_or(i64::MAX);
        Some(Timestamp(
            t.0.saturating_add(lag).saturating_sub(CLOCK_SLACK_NS),
        ))
    }

    pub fn on_prints(&mut self, trades: &[Trade], first: u64) -> Vec<BigTrade> {
        let Some(closer) = &mut self.closer else {
            return Vec::new();
        };
        let mut out = Closed::default();
        for (i, t) in trades.iter().enumerate() {
            closer.push(t, Some(first + i as u64), &mut out);
        }
        if let Some(t) = trades.last() {
            self.last = Some((t.ts, Instant::now()));
        }
        self.emit(out)
    }

    pub fn on_clock(&mut self) -> Vec<BigTrade> {
        let Some(now) = self.clock() else {
            return Vec::new();
        };
        let Some(closer) = &mut self.closer else {
            return Vec::new();
        };
        let mut out = Closed::default();
        closer.advance(now, &mut out);
        self.emit(out)
    }

    fn emit(&mut self, out: Closed) -> Vec<BigTrade> {
        let Some(contract) = self.closer.as_ref().map(EventCloser::contract) else {
            return Vec::new();
        };
        self.waiting.extend(out.big);
        while self.waiting.len() > WAITING_MAX {
            self.waiting.pop_front();
        }
        let mut sent = Vec::new();
        while let Some((o, _)) = self.waiting.front() {
            let Some(model) = self.model_for(o.t).cloned() else {
                break;
            };
            let Some((o, seq)) = self.waiting.pop_front() else {
                break;
            };
            let t = to_wire(&o, seq, &contract, Some(&model));
            if t.tier.is_some() {
                sent.push(t);
            }
        }
        for t in &sent {
            if self.recent.len() == RECENT_BIGS {
                self.recent.pop_front();
            }
            self.recent.push_back(t.clone());
        }
        sent
    }

    fn model_for(&self, t: Timestamp) -> Option<&BigTradeModel> {
        let m = self.model.as_deref()?;
        (m.trade_date(t) == m.date).then_some(m)
    }

    pub fn recent(&self) -> Vec<BigTrade> {
        self.recent.iter().cloned().collect()
    }
}

pub const CLOCK_EVERY: Duration = Duration::from_millis(250);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orderflow::big_trades::{ModelBuilder, ModelCoverage};
    use tessera_core::market::{Aggressor, AggressorSource};
    use tessera_core::session::SessionCalendar;
    use tessera_core::{InstrumentId, Price, Qty};

    fn contract() -> Contract {
        Contract {
            tick: Price::from(1),
            lot: 1.0,
            floor: Qty::from(1),
            multiplier: 1.0,
            min_notional: 0.0,
        }
    }

    fn print(at: &str) -> Trade {
        Trade {
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            ts: Timestamp::parse(at).unwrap(),
            price: Price::from(100),
            size: Qty::from(1),
            aggressor: Aggressor::Buy,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_model_that_failed_to_build_after_the_day_rolled_waits_before_trying_again() {
        let mut bigs = LiveBigs::default();
        bigs.start(contract());
        bigs.on_prints(&[print("2026-10-01T10:00:00-04:00")], 0);
        assert!(bigs.wants_model(Instant::now()).is_some());
        let yesterday = Timestamp::parse("2026-10-01T10:00:00-04:00").unwrap();
        let date = SessionCalendar::CmeEquityIndex.trade_date(yesterday);
        let model = ModelBuilder::new(SessionCalendar::CmeEquityIndex, contract())
            .build(date, ModelCoverage::default());
        bigs.set_model(Ok(Arc::new(model)));

        bigs.on_prints(&[print("2026-10-02T10:00:00-04:00")], 1);
        assert!(bigs.wants_model(Instant::now()).is_some(), "a new day");
        bigs.set_model(Err(ToolError::unavailable("no history yet")));
        assert!(
            bigs.wants_model(Instant::now()).is_none(),
            "not again on the next pass"
        );
        tokio::time::advance(RETRY).await;
        assert!(bigs.wants_model(Instant::now()).is_some());
    }
}
