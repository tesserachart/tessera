use tessera_core::market::{AggressorSource, FootprintBar};
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_tools::ToolError;

use super::tools::{BarsAsk, footprint_bars};
use super::vwap::PrintSums;
use crate::aggregate::bar_range;
use crate::hub::{MarketHub, Pulls};
use crate::io::CompactFootprint;
use crate::module::market_error;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sides {
    pub volume: f64,
    pub delta: f64,
    pub delta_high: f64,
    pub delta_low: f64,
}

impl Sides {
    pub fn of_update(bar: &CompactFootprint) -> Self {
        Self {
            volume: bar.volume.to_f64(),
            delta: bar.delta.to_f64(),
            delta_high: bar.delta_high.map_or(f64::NAN, |q| q.to_f64()),
            delta_low: bar.delta_low.map_or(f64::NAN, |q| q.to_f64()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BarFlow {
    pub sides: Sides,
    pub sums: PrintSums,
}

impl BarFlow {
    pub const QUIET: Self = Self {
        sides: Sides {
            volume: 0.0,
            delta: 0.0,
            delta_high: 0.0,
            delta_low: 0.0,
        },
        sums: PrintSums {
            volume: 0.0,
            pv: 0.0,
            pv2: 0.0,
        },
    };

    pub fn of(bar: &FootprintBar) -> Self {
        let mut sums = PrintSums::default();
        let (mut sell, mut buy) = (0.0, 0.0);
        for c in &bar.cells {
            let (bid, ask) = (c.bid_volume.to_f64(), c.ask_volume.to_f64());
            sell += bid;
            buy += ask;
            sums.add(c.price.to_f64(), bid + ask);
        }
        Self {
            sides: Sides {
                volume: buy + sell,
                delta: buy - sell,
                delta_high: bar.delta_high.map_or(f64::NAN, |q| q.to_f64()),
                delta_low: bar.delta_low.map_or(f64::NAN, |q| q.to_f64()),
            },
            sums,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FlowRead {
    pub bars: Vec<Option<BarFlow>>,
    pub unread: usize,
    pub filling: bool,
    pub refused: bool,
    pub aggressor_source: Option<AggressorSource>,
}

impl MarketHub {
    pub async fn bar_flows(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        opens: &[Timestamp],
        pulls: bool,
        budget: u64,
        now: Timestamp,
    ) -> Result<FlowRead, ToolError> {
        let provider = self.router().route_async(id).await.map_err(market_error)?;
        let (_, spec) = provider.spec(id).await.map_err(market_error)?;
        let ask = BarsAsk {
            provider: provider.id(),
            id,
            tf,
            calendar: spec.sessions,
            tick: spec.tick_size,
            row_ticks: Some(1),
            base_ticks: 1,
            now,
            budget,
            pulls: if pulls { Pulls::ALWAYS } else { Pulls::Never },
        };
        let built = footprint_bars(self, &ask, opens).await?;
        let mut found = built.bars.iter().peekable();
        let bars = opens
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let bar = found.next_if(|b| b.t == *t);
                let (from, to) = bar_range(spec.sessions, tf, *t);
                let unknown = i < built.unread
                    || built
                        .gaps
                        .touches(tessera_store::ticks::Span::new(from.0, to.0));
                (!unknown).then(|| bar.map_or(BarFlow::QUIET, BarFlow::of))
            })
            .collect();
        Ok(FlowRead {
            bars,
            unread: built.unread,
            filling: built.filling,
            refused: self.refused(id),
            aggressor_source: built.aggressor_source,
        })
    }
}
