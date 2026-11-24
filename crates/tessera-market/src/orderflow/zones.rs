use rust_decimal::Decimal;
use tessera_core::market::{Aggressor, Bar, FootprintBar};
use tessera_core::session::SessionCalendar;
use tessera_core::{InstrumentId, Price, Timeframe, Timestamp};
use tessera_tools::ToolError;

use super::bars::base_row_ticks;
use super::imbalance::{Rule, imbalances, stacks};
use super::tools::{BarsAsk, MAX_BAR_PRINTS, footprint_bars};
use crate::hub::{MarketHub, Pulls};
use crate::module::{market_error, refuse_index};
use crate::provider::BarsRequest;
use crate::router::effective;

pub const ZONE_TRADE_DATES: usize = 3;
pub const ZONE_BARS: usize = 1500;
const NEWEST_BARS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Zone {
    pub t: Timestamp,
    pub side: Aggressor,
    pub low: Price,
    pub top: Price,
    pub rows: u32,
    pub expires_at: Timestamp,
}

impl Zone {
    pub fn holds(&self, price: Price) -> bool {
        price >= self.low && price < self.top
    }

    pub fn touched_by(&self, low: Price, high: Price) -> bool {
        low < self.top && high >= self.low
    }
}

pub fn zone_expiry(calendar: SessionCalendar, t: Timestamp) -> Timestamp {
    let mut date = calendar.trade_date(t);
    for _ in 1..ZONE_TRADE_DATES {
        date = calendar.next_trade_date(date);
    }
    calendar.trade_date_end(date)
}

pub fn open_zones(
    footprints: &[FootprintBar],
    later: &[Bar],
    rule: &Rule,
    stack_rows: u32,
    calendar: SessionCalendar,
    now: Timestamp,
) -> Vec<Zone> {
    let mut out = Vec::new();
    for fb in footprints {
        let found = imbalances(fb, rule);
        let expires_at = zone_expiry(calendar, fb.t);
        for s in stacks(fb, &found, stack_rows as usize) {
            let zone = Zone {
                t: fb.t,
                side: s.side,
                low: s.low,
                top: Price(s.high.0 + fb.bucket.0),
                rows: s.rows,
                expires_at,
            };
            let ended = later
                .iter()
                .filter(|b| b.t > fb.t)
                .any(|b| b.t >= expires_at || zone.touched_by(b.l, b.h));
            if !ended && now < expires_at {
                out.push(zone);
            }
        }
    }
    out
}

pub struct ZonesAsk<'a> {
    pub instrument: &'a InstrumentId,
    pub tf: Timeframe,
    pub rule: Rule,
    pub stack_rows: u32,
    pub row_ticks: u32,
    pub from: Option<Timestamp>,
    pub now: Timestamp,
}

pub async fn stacked_zones(hub: &MarketHub, ask: ZonesAsk<'_>) -> Result<Vec<Zone>, ToolError> {
    let id = ask.instrument;
    let provider = hub.router().route_async(id).await.map_err(market_error)?;
    if !effective(provider.capabilities()).footprint {
        return Err(ToolError::unsupported(format!(
            "{} offers no prints for {id}",
            provider.id()
        )));
    }
    let (_, spec) = provider.spec(id).await.map_err(market_error)?;
    refuse_index(id, &spec)?;
    let calendar = spec.sessions;
    let oldest = match ask.from {
        Some(t) => t,
        None => {
            let mut date = calendar.trade_date(ask.now);
            for _ in 0..ZONE_TRADE_DATES {
                date = calendar.prev_trade_date(date);
            }
            calendar.trade_date_end(date)
        }
    };
    let limit = if ask.from.is_some() {
        NEWEST_BARS
    } else {
        ZONE_BARS
    };
    let series = hub
        .router()
        .bars_from(
            &provider,
            BarsRequest::latest(id.clone(), ask.tf, limit),
            crate::history::Read::Recent,
        )
        .await
        .map_err(market_error)?;
    let bars: Vec<Bar> = series.bars.into_iter().filter(|b| b.t >= oldest).collect();
    let closed: Vec<Timestamp> = bars
        .iter()
        .filter(|b| bar_closed(calendar, ask.tf, b.t, ask.now))
        .map(|b| b.t)
        .collect();
    if closed.is_empty() {
        return Ok(Vec::new());
    }
    let tick = spec.tick_size.0;
    let widest = bars
        .iter()
        .map(|b| {
            if tick.is_zero() {
                1
            } else {
                ((b.h.0 - b.l.0) / tick).round().try_into().unwrap_or(1_i64) + 1
            }
        })
        .max()
        .unwrap_or(1);
    let row_ticks = ask.row_ticks.max(1);
    let fetch = BarsAsk {
        provider: provider.id(),
        id,
        tf: ask.tf,
        calendar,
        tick: spec.tick_size,
        row_ticks: Some(row_ticks),
        base_ticks: base_row_ticks(row_ticks, widest),
        now: ask.now,
        budget: MAX_BAR_PRINTS,
        pulls: Pulls::ALWAYS,
    };
    let built = footprint_bars(hub, &fetch, &closed).await?;
    let row = Price(spec.tick_size.0 * Decimal::from(row_ticks));
    let footprints: Vec<FootprintBar> = built
        .bars
        .into_iter()
        .map(|mut b| {
            if b.bucket != row {
                b = crate::aggregate::regroup(&b, row);
            }
            b
        })
        .collect();
    Ok(open_zones(
        &footprints,
        &bars,
        &ask.rule,
        ask.stack_rows,
        calendar,
        ask.now,
    ))
}

fn bar_closed(calendar: SessionCalendar, tf: Timeframe, t: Timestamp, now: Timestamp) -> bool {
    crate::aggregate::bar_range(calendar, tf, t).1 <= now
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::Qty;
    use tessera_core::market::{AggressorSource, FootprintCell};

    const MIN: i64 = 60_000_000_000;

    fn p(s: &str) -> Price {
        Price::from_str(s).unwrap()
    }

    fn calendar() -> SessionCalendar {
        SessionCalendar::CmeEquityIndex
    }

    fn t0() -> Timestamp {
        Timestamp::parse("2026-10-06T14:30:00Z").unwrap()
    }

    fn footprint(t: Timestamp, rows: &[(&str, i64, i64)]) -> FootprintBar {
        FootprintBar {
            t,
            bucket: p("0.25"),
            cells: rows
                .iter()
                .map(|(price, bid, ask)| FootprintCell {
                    price: p(price),
                    bid_volume: Qty::from(*bid),
                    ask_volume: Qty::from(*ask),
                    trades: 1,
                })
                .collect(),
            poc: None,
            delta_high: None,
            delta_low: None,
            aggressor_source: AggressorSource::Exchange,
        }
    }

    fn bar(t: Timestamp, low: &str, high: &str) -> Bar {
        Bar {
            t,
            o: p(low),
            h: p(high),
            l: p(low),
            c: p(high),
            v: Qty::from(10),
            bv: None,
        }
    }

    fn buy_stack(t: Timestamp) -> FootprintBar {
        footprint(
            t,
            &[
                ("100.00", 10, 2),
                ("100.25", 4, 30),
                ("100.50", 3, 12),
                ("100.75", 1, 9),
            ],
        )
    }

    #[test]
    fn a_stack_stays_open_until_a_later_bar_trades_back_into_it() {
        let t = t0();
        let fb = buy_stack(t);
        let rule = Rule::default();
        let above = [
            bar(t, "100.00", "100.75"),
            bar(Timestamp(t.0 + MIN), "101.25", "102.00"),
        ];
        let zones = open_zones(
            std::slice::from_ref(&fb),
            &above,
            &rule,
            3,
            calendar(),
            above[1].t,
        );
        assert_eq!(zones.len(), 1);
        let z = zones[0];
        assert_eq!(
            (z.side, z.low, z.top, z.rows),
            (Aggressor::Buy, p("100.25"), p("101.00"), 3)
        );
        assert!(z.holds(p("100.75")) && !z.holds(p("101.00")) && !z.holds(p("100.00")));

        let back = [
            above[0],
            above[1],
            bar(Timestamp(t.0 + 2 * MIN), "100.75", "101.50"),
        ];
        assert!(
            open_zones(
                std::slice::from_ref(&fb),
                &back,
                &rule,
                3,
                calendar(),
                back[2].t
            )
            .is_empty()
        );
        assert!(
            open_zones(&[fb], &above, &rule, 4, calendar(), above[1].t).is_empty(),
            "a three-row stack is under a minimum stack of four"
        );
    }

    #[test]
    fn a_zone_lasts_its_trading_day_and_the_next_two() {
        let t = t0();
        let expires = zone_expiry(calendar(), t);
        assert_eq!(expires, Timestamp::parse("2026-10-08T22:00:00Z").unwrap());
        let fb = buy_stack(t);
        let rule = Rule::default();
        let quiet = [bar(Timestamp(expires.0 - MIN), "105.00", "106.00")];
        assert_eq!(
            open_zones(
                std::slice::from_ref(&fb),
                &quiet,
                &rule,
                3,
                calendar(),
                quiet[0].t
            )
            .len(),
            1
        );
        let after = [bar(expires, "105.00", "106.00")];
        assert!(open_zones(&[fb], &after, &rule, 3, calendar(), after[0].t).is_empty());
    }
}
