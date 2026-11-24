//! `LastTrade.aggressor` is the exchange's own aggressor flag.
//! The `LastTrade` answering a subscription (`is_snapshot`) restates the last print.
//! A replayed bar's `marker` is its close in Unix seconds; daily and weekly bars use `YYYYMMDD`.
//! Rithmic's price doubles are not always the double nearest the exchange's price.

use rithmic_rs::rti::{
    BestBidOffer, LastTrade, ResponseTickBarReplay, ResponseTimeBarReplay, TradeStatistics,
};
use rust_decimal::Decimal;
use tessera_core::instrument::InstrumentId;
use tessera_core::market::{Aggressor, AggressorSource, Bar, Quote, SessionStats, Trade};
use tessera_core::money::{Price, Qty, Rounding, decimal_from_f64, quantize};
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_MICRO, NANOS_PER_SEC, Timestamp, local_to_timestamp};

use crate::symbols::parse_yyyymmdd;

const BBO_BID: u32 = 1;
const BBO_ASK: u32 = 2;
const TRADE_LAST: u32 = 1;
const TRADE_VOLUME: u32 = 8;
const STATS_OPEN: u32 = 1;
const STATS_HIGH: u32 = 2;
const STATS_LOW: u32 = 4;

pub fn message_time(
    source: (Option<i32>, Option<i32>, Option<i32>),
    gateway: (Option<i32>, Option<i32>),
) -> Option<Timestamp> {
    let (src_secs, src_usecs, src_nsecs) = source;
    if let Some(secs) = src_secs.filter(|s| *s > 0) {
        let sub = match (src_nsecs, src_usecs) {
            // The live feed sends `source_nsecs` as the whole nanosecond-of-second.
            (Some(ns), _) if (1_000..NANOS_PER_SEC as i32).contains(&ns) => i64::from(ns),
            (Some(ns), Some(us)) if (0..1_000).contains(&ns) => {
                i64::from(us) * NANOS_PER_MICRO + i64::from(ns)
            }
            (_, Some(us)) => i64::from(us) * NANOS_PER_MICRO,
            _ => 0,
        };
        return Some(Timestamp(i64::from(secs) * NANOS_PER_SEC + sub));
    }
    let (secs, usecs) = gateway;
    let secs = secs.filter(|s| *s > 0)?;
    Some(Timestamp(
        i64::from(secs) * NANOS_PER_SEC + i64::from(usecs.unwrap_or(0)) * NANOS_PER_MICRO,
    ))
}

/// The finest futures tick, 1/256, has 8 decimal places.
pub const CLEAN_DECIMALS: u32 = 9;

pub fn clean(v: f64) -> Option<Decimal> {
    if !v.is_finite() {
        return None;
    }
    Some(decimal_from_f64(v)?.round_dp(CLEAN_DECIMALS).normalize())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Grid(Option<Decimal>);

impl Grid {
    pub fn of(tick: Decimal) -> Self {
        Self(Some(tick.normalize()).filter(|t| *t > Decimal::ZERO))
    }

    pub fn tick(self) -> Option<Decimal> {
        self.0
    }

    pub fn price(self, v: Option<f64>) -> Option<Price> {
        let d = clean(v?)?;
        let d = match self.0 {
            Some(tick) => quantize(d, tick, Rounding::Nearest).ok()?.normalize(),
            None => d,
        };
        Some(Price(d))
    }
}

pub fn price(v: Option<f64>) -> Option<Price> {
    Grid::default().price(v)
}

fn qty(v: Option<i32>) -> Option<Qty> {
    v.map(|s| Qty::from(i64::from(s)))
}

fn has(bits: Option<u32>, bit: u32) -> bool {
    bits.is_some_and(|b| b & bit != 0)
}

pub fn aggressor(flag: Option<i32>) -> Aggressor {
    match flag {
        Some(1) => Aggressor::Buy,
        Some(2) => Aggressor::Sell,
        _ => Aggressor::Unknown,
    }
}

pub fn trade_time(t: &LastTrade) -> Option<Timestamp> {
    message_time(
        (t.source_ssboe, t.source_usecs, t.source_nsecs),
        (t.ssboe, t.usecs),
    )
}

pub fn trade(instrument: &InstrumentId, t: &LastTrade, grid: Grid) -> Option<Trade> {
    if t.is_snapshot == Some(true) || !has(t.presence_bits, TRADE_LAST) {
        return None;
    }
    let size = qty(t.trade_size).filter(|s| *s > Qty::ZERO)?;
    Some(Trade {
        instrument: instrument.clone(),
        ts: trade_time(t)?,
        price: grid.price(t.trade_price)?,
        size,
        aggressor: aggressor(t.aggressor),
        aggressor_source: AggressorSource::Exchange,
        order_key: t
            .aggressor_exchange_order_id
            .as_deref()
            .filter(|o| !o.is_empty())
            .map(tessera_core::market::order_key),
        source: None,
    })
}

pub fn replayed_trade(
    instrument: &InstrumentId,
    t: &ResponseTickBarReplay,
    grid: Grid,
) -> Option<Trade> {
    let at = |i: usize| {
        let secs = i64::from(*t.data_bar_ssboe.get(i)?);
        let usecs = i64::from(*t.data_bar_usecs.get(i).unwrap_or(&0));
        (secs > 0).then(|| Timestamp(secs * NANOS_PER_SEC + usecs * NANOS_PER_MICRO))
    };
    let ts = at(1).or_else(|| at(0))?;
    let size = t
        .volume
        .and_then(|v| i64::try_from(v).ok())
        .filter(|v| *v > 0)
        .map(Qty::from)?;
    let (bought, sold) = (t.bid_volume.unwrap_or(0), t.ask_volume.unwrap_or(0));
    Some(Trade {
        instrument: instrument.clone(),
        ts,
        price: grid.price(t.close_price)?,
        size,
        aggressor: match (bought > 0, sold > 0) {
            (true, false) => Aggressor::Buy,
            (false, true) => Aggressor::Sell,
            _ => Aggressor::Unknown,
        },
        aggressor_source: AggressorSource::ReplayMapped,
        order_key: None,
        source: None,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuoteState {
    pub ts: Option<Timestamp>,
    pub bid: Option<(Price, Qty)>,
    pub ask: Option<(Price, Qty)>,
    pub last: Option<(Price, Qty)>,
    pub open: Option<Price>,
    pub high: Option<Price>,
    pub low: Option<Price>,
    /// Rithmic's `net_change` is the last price minus the prior settlement.
    pub prev_close: Option<Price>,
    pub volume: Option<Qty>,
    pub grid: Grid,
}

impl QuoteState {
    pub fn apply_bbo(&mut self, b: &BestBidOffer) {
        let grid = self.grid;
        let side = |present: bool, cleared: bool, px: Option<f64>, sz: Option<i32>, cur| {
            if cleared {
                None
            } else if present {
                grid.price(px).zip(qty(sz)).or(cur)
            } else {
                cur
            }
        };
        self.bid = side(
            has(b.presence_bits, BBO_BID),
            has(b.clear_bits, BBO_BID),
            b.bid_price,
            b.bid_size,
            self.bid,
        );
        self.ask = side(
            has(b.presence_bits, BBO_ASK),
            has(b.clear_bits, BBO_ASK),
            b.ask_price,
            b.ask_size,
            self.ask,
        );
        if let Some(ts) = message_time((None, None, None), (b.ssboe, b.usecs)) {
            self.ts = Some(ts);
        }
    }

    pub fn apply_trade(&mut self, t: &LastTrade) {
        if has(t.presence_bits, TRADE_LAST)
            && let (Some(px), Some(sz)) = (self.grid.price(t.trade_price), qty(t.trade_size))
        {
            self.last = Some((px, sz));
            // Settlement prices may sit between ticks.
            if let Some(nc) = t.net_change.and_then(clean).map(Price) {
                self.prev_close = Some(px - nc);
            }
            if has(t.presence_bits, TRADE_VOLUME)
                && let Some(v) = t.volume.and_then(|v| i64::try_from(v).ok())
            {
                self.volume = Some(Qty::from(v));
            } else if t.is_snapshot != Some(true) {
                self.volume = self.volume.map(|v| v + sz);
            }
            self.high = self.high.map(|h| h.max(px));
            self.low = self.low.map(|l| l.min(px));
        }
        if let Some(ts) = trade_time(t) {
            self.ts = Some(ts);
        }
    }

    pub fn apply_stats(&mut self, s: &TradeStatistics) {
        if has(s.presence_bits, STATS_OPEN) {
            self.open = self.grid.price(s.open_price).or(self.open);
        }
        if has(s.presence_bits, STATS_HIGH) {
            self.high = self.grid.price(s.high_price).or(self.high);
        }
        if has(s.presence_bits, STATS_LOW) {
            self.low = self.grid.price(s.low_price).or(self.low);
        }
    }

    pub fn is_known(&self) -> bool {
        self.bid.is_some() || self.ask.is_some() || self.last.is_some()
    }

    pub fn to_quote(
        &self,
        instrument: &InstrumentId,
        calendar: SessionCalendar,
        now: Timestamp,
    ) -> Quote {
        let ts = self.ts.unwrap_or(now);
        Quote {
            instrument: instrument.clone(),
            ts,
            bid: self.bid.map(|b| b.0),
            bid_size: self.bid.map(|b| b.1),
            ask: self.ask.map(|a| a.0),
            ask_size: self.ask.map(|a| a.1),
            last: self.last.map(|l| l.0),
            last_size: self.last.map(|l| l.1),
            session: Some(SessionStats {
                trade_date: calendar.trade_date(ts),
                open: self.open,
                high: self.high,
                low: self.low,
                prev_close: self.prev_close,
                volume: self.volume,
            }),
            source: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarUnit {
    Seconds(i64),
    Days,
}

pub fn time_bar(
    b: &ResponseTimeBarReplay,
    unit: BarUnit,
    calendar: SessionCalendar,
    grid: Grid,
) -> Option<Bar> {
    let marker = b.marker?;
    let t = match unit {
        BarUnit::Seconds(len) => Timestamp((i64::from(marker) - len) * NANOS_PER_SEC),
        BarUnit::Days => {
            let date = parse_yyyymmdd(&marker.to_string())?;
            local_to_timestamp(calendar.tz(), date, 0, 0)
        }
    };
    let bar = Bar {
        t,
        o: grid.price(b.open_price)?,
        h: grid.price(b.high_price)?,
        l: grid.price(b.low_price)?,
        c: grid.price(b.close_price)?,
        v: Qty::from(i64::try_from(b.volume.unwrap_or(0)).unwrap_or(i64::MAX)),
        bv: None,
    };
    bar.is_consistent().then_some(bar)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> InstrumentId {
        InstrumentId::new("ESZ6.CME-RITHMIC").unwrap()
    }

    #[test]
    fn exchange_nanoseconds_are_the_full_fraction() {
        let ts = message_time(
            (Some(1_791_388_297), Some(409_905), Some(409_905_707)),
            (Some(1_791_388_297), Some(411_095)),
        );
        assert_eq!(ts, Some(Timestamp(1_791_388_297_409_905_707)));
        let ts = message_time((Some(10), Some(5), Some(123)), (None, None));
        assert_eq!(ts, Some(Timestamp(10_000_005_123)));
        let ts = message_time((None, None, None), (Some(10), Some(7)));
        assert_eq!(ts, Some(Timestamp(10_000_007_000)));
        assert_eq!(message_time((None, None, None), (None, None)), None);
    }

    #[test]
    fn prints_keep_the_exchange_aggressor_and_skip_snapshots() {
        let mut t = LastTrade::default();
        t.presence_bits = Some(TRADE_LAST);
        t.trade_price = Some(7845.25);
        t.trade_size = Some(3);
        t.aggressor = Some(2);
        t.source_ssboe = Some(1_791_388_297);
        t.source_nsecs = Some(409_905_707);
        let tr = trade(&id(), &t, Grid::default()).unwrap();
        assert_eq!(tr.aggressor, Aggressor::Sell);
        assert_eq!(tr.aggressor_source, AggressorSource::Exchange);
        assert_eq!(tr.price, "7845.25".parse().unwrap());
        t.aggressor = None;
        assert_eq!(
            trade(&id(), &t, Grid::default()).unwrap().aggressor,
            Aggressor::Unknown
        );
        t.is_snapshot = Some(true);
        assert_eq!(trade(&id(), &t, Grid::default()), None);
    }

    fn tick(volume: u64, bid_volume: u64, ask_volume: u64) -> ResponseTickBarReplay {
        let mut t = ResponseTickBarReplay::default();
        t.close_price = Some(29_683.000_000_001);
        t.volume = Some(volume);
        t.bid_volume = Some(bid_volume);
        t.ask_volume = Some(ask_volume);
        t.data_bar_ssboe = vec![1_791_388_297, 1_791_388_297];
        t.data_bar_usecs = vec![0, 409_905];
        t
    }

    #[test]
    fn a_replayed_tick_is_one_print_whose_bid_volume_is_the_buyers_as_audited_against_exchange_flags()
     {
        let grid = Grid::of("0.25".parse().unwrap());
        let bought = replayed_trade(&id(), &tick(3, 3, 0), grid).unwrap();
        assert_eq!(bought.aggressor, Aggressor::Buy);
        assert_eq!(bought.aggressor_source, AggressorSource::ReplayMapped);
        assert_eq!(bought.size, Qty::from(3));
        assert_eq!(bought.price, "29683".parse().unwrap());
        assert_eq!(
            bought.ts,
            Timestamp(1_791_388_297 * NANOS_PER_SEC + 409_905 * NANOS_PER_MICRO),
            "the trade's own time, not the second asked for"
        );
        assert_eq!(bought.order_key, None);
        assert_eq!(
            replayed_trade(&id(), &tick(2, 0, 2), grid)
                .unwrap()
                .aggressor,
            Aggressor::Sell
        );
        assert_eq!(
            replayed_trade(&id(), &tick(2, 1, 1), grid)
                .unwrap()
                .aggressor,
            Aggressor::Unknown
        );
        assert_eq!(replayed_trade(&id(), &tick(0, 0, 0), grid), None);
        let mut first = tick(1, 1, 0);
        first.data_bar_ssboe.truncate(1);
        first.data_bar_usecs.truncate(1);
        assert_eq!(
            replayed_trade(&id(), &first, grid).unwrap().ts,
            Timestamp(1_791_388_297 * NANOS_PER_SEC)
        );
    }

    #[test]
    fn quote_state_folds_partial_bbo_and_trades() {
        let mut q = QuoteState::default();
        let mut b = BestBidOffer::default();
        b.presence_bits = Some(BBO_BID | BBO_ASK);
        b.bid_price = Some(7845.25);
        b.bid_size = Some(76);
        b.ask_price = Some(7845.5);
        b.ask_size = Some(40);
        b.ssboe = Some(1_791_388_296);
        q.apply_bbo(&b);
        let mut b2 = BestBidOffer::default();
        b2.presence_bits = Some(BBO_ASK);
        b2.ask_price = Some(7845.75);
        b2.ask_size = Some(5);
        q.apply_bbo(&b2);
        assert_eq!(q.bid, Some(("7845.25".parse().unwrap(), Qty::from(76))));
        assert_eq!(q.ask, Some(("7845.75".parse().unwrap(), Qty::from(5))));
        let mut snap = LastTrade::default();
        snap.is_snapshot = Some(true);
        snap.presence_bits = Some(TRADE_LAST | TRADE_VOLUME);
        snap.trade_price = Some(7845.25);
        snap.trade_size = Some(5);
        snap.net_change = Some(-28.75);
        snap.volume = Some(800_975);
        q.apply_trade(&snap);
        let mut print = snap.clone();
        print.is_snapshot = None;
        print.presence_bits = Some(TRADE_LAST);
        print.trade_size = Some(2);
        q.apply_trade(&print);
        let mut s = TradeStatistics::default();
        s.presence_bits = Some(STATS_OPEN | STATS_HIGH | STATS_LOW);
        s.open_price = Some(7881.5);
        s.high_price = Some(7884.5);
        s.low_price = Some(7815.75);
        q.apply_stats(&s);
        let quote = q.to_quote(&id(), SessionCalendar::CmeEquityIndex, Timestamp(0));
        let stats = quote.session.unwrap();
        assert_eq!(stats.volume, Some(Qty::from(800_977)));
        assert_eq!(stats.prev_close, Some("7874".parse().unwrap()));
        assert_eq!(stats.low, Some("7815.75".parse().unwrap()));
        assert_eq!(quote.last_size, Some(Qty::from(2)));
        let mut cleared = BestBidOffer::default();
        cleared.clear_bits = Some(BBO_BID);
        q.apply_bbo(&cleared);
        assert_eq!(q.bid, None);
    }

    #[test]
    fn bars_open_one_period_before_their_marker() {
        let mut b = ResponseTimeBarReplay::default();
        b.marker = Some(1_791_386_520);
        b.open_price = Some(7828.75);
        b.high_price = Some(7828.75);
        b.low_price = Some(7825.0);
        b.close_price = Some(7825.0);
        b.volume = Some(2485);
        b.bid_volume = Some(1008);
        b.ask_volume = Some(1477);
        let bar = time_bar(
            &b,
            BarUnit::Seconds(60),
            SessionCalendar::CmeEquityIndex,
            Grid::default(),
        )
        .unwrap();
        assert_eq!(bar.t, Timestamp::from_secs(1_791_386_460));
        assert_eq!(bar.v, Qty::from(2485));
        assert_eq!(bar.bv, None);
        b.marker = Some(20_261_007);
        let day = time_bar(
            &b,
            BarUnit::Days,
            SessionCalendar::CmeEquityIndex,
            Grid::default(),
        )
        .unwrap();
        assert_eq!(
            day.t,
            SessionCalendar::CmeEquityIndex.bucket_start(
                Timestamp::parse("2026-10-07T12:00:00-04:00").unwrap(),
                tessera_core::Timeframe::D1
            )
        );
        assert_eq!(
            time_bar(
                &ResponseTimeBarReplay::default(),
                BarUnit::Seconds(60),
                SessionCalendar::CmeEquityIndex,
                Grid::default()
            ),
            None
        );
    }

    fn px(s: &str) -> Price {
        s.parse().unwrap()
    }

    #[test]
    fn feed_prices_land_on_the_tick() {
        let gc = Grid::of("0.1".parse().unwrap());
        let cl = Grid::of("0.01".parse().unwrap());
        assert_eq!(gc.price(Some(4134.900000000001)), Some(px("4134.9")));
        assert_eq!(gc.price(Some(4135.400000000001)), Some(px("4135.4")));
        assert_eq!(cl.price(Some(88.85000000000001)), Some(px("88.85")));
        assert_eq!(cl.price(Some(88.85)), cl.price(Some(88.85000000000001)));
        assert_eq!(cl.price(Some(88.8549)), Some(px("88.85")));
        assert_eq!(cl.price(Some(88.855)), Some(px("88.86")));
        assert_eq!(price(Some(2812.7000000000003)), Some(px("2812.7")));
        assert_eq!(price(Some(7845.25)), Some(px("7845.25")));
        assert_eq!(price(Some(104.12890625)), Some(px("104.12890625")));
        assert_eq!(price(Some(f64::NAN)), None);
        assert_eq!(Grid::of(Decimal::ZERO), Grid::default());
    }

    #[test]
    fn prints_quotes_and_bars_use_the_grid() {
        let grid = Grid::of("0.1".parse().unwrap());
        let mut t = LastTrade::default();
        t.presence_bits = Some(TRADE_LAST);
        t.trade_price = Some(4135.400000000001);
        t.trade_size = Some(1);
        t.source_ssboe = Some(1_791_388_297);
        assert_eq!(trade(&id(), &t, grid).unwrap().price, px("4135.4"));
        let mut q = QuoteState {
            grid,
            ..QuoteState::default()
        };
        let mut b = BestBidOffer::default();
        b.presence_bits = Some(BBO_BID | BBO_ASK);
        b.bid_price = Some(4135.3);
        b.bid_size = Some(1);
        b.ask_price = Some(4135.400000000001);
        b.ask_size = Some(2);
        q.apply_bbo(&b);
        let mut s = TradeStatistics::default();
        s.presence_bits = Some(STATS_OPEN);
        s.open_price = Some(4139.900000000001);
        q.apply_stats(&s);
        t.net_change = Some(-4.500000000000455);
        q.apply_trade(&t);
        assert_eq!(q.ask.map(|a| a.0), Some(px("4135.4")));
        assert_eq!(q.open, Some(px("4139.9")));
        assert_eq!(q.prev_close, Some(px("4139.9")));
        let mut r = ResponseTimeBarReplay::default();
        r.marker = Some(1_791_399_660);
        r.open_price = Some(4135.6);
        r.high_price = Some(4136.5);
        r.low_price = Some(4134.900000000001);
        r.close_price = Some(4136.400000000001);
        r.volume = Some(43);
        let bar = time_bar(
            &r,
            BarUnit::Seconds(60),
            SessionCalendar::CmeEquityIndex,
            grid,
        )
        .unwrap();
        assert_eq!(
            (bar.o, bar.h, bar.l, bar.c),
            (px("4135.6"), px("4136.5"), px("4134.9"), px("4136.4"))
        );
    }
}
