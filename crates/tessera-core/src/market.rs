use chrono::NaiveDate;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::instrument::InstrumentId;
use crate::money::{Price, Qty};
use crate::time::Timestamp;

/// Which side initiated a trade.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Aggressor {
    /// Buyer lifted the offer.
    Buy,
    /// Seller hit the bid.
    Sell,
    /// Unknown (kept explicitly, never guessed).
    Unknown,
}

impl Aggressor {
    pub fn sign(self) -> i8 {
        match self {
            Aggressor::Buy => 1,
            Aggressor::Sell => -1,
            Aggressor::Unknown => 0,
        }
    }

    pub fn from_sign(s: i8) -> Self {
        match s.signum() {
            1 => Aggressor::Buy,
            -1 => Aggressor::Sell,
            _ => Aggressor::Unknown,
        }
    }
}

/// Where a trade's aggressor side came from. Order-flow views must show it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AggressorSource {
    /// The exchange's own flag (e.g. live `LastTrade.aggressor`).
    Exchange,
    /// Inferred from replayed bid/ask volume.
    ReplayMapped,
    /// Inferred from quote at time of trade (tick rule / quote rule).
    Inferred,
}

/// An OHLCV bar. `t` is the bucket **open** time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Bar {
    /// Bucket open time.
    pub t: Timestamp,
    /// Open.
    pub o: Price,
    /// High.
    pub h: Price,
    /// Low.
    pub l: Price,
    /// Close (or last, for a forming bar).
    pub c: Price,
    /// Volume.
    pub v: Qty,
    /// Aggressive buy volume, when known (delta = 2·bv − v).
    pub bv: Option<Qty>,
}

impl Bar {
    pub fn flat(t: Timestamp, price: Price, v: Qty) -> Self {
        Self {
            t,
            o: price,
            h: price,
            l: price,
            c: price,
            v,
            bv: None,
        }
    }

    pub fn merge(&mut self, later: &Bar) {
        self.h = self.h.max(later.h);
        self.l = self.l.min(later.l);
        self.c = later.c;
        self.v = self.v + later.v;
        self.bv = match (self.bv, later.bv) {
            (Some(a), Some(b)) => Some(a + b),
            (a, None) => a,
            (None, b) => b,
        };
    }

    pub fn apply_trade(&mut self, price: Price, size: Qty, aggressor: Aggressor) {
        self.h = self.h.max(price);
        self.l = self.l.min(price);
        self.c = price;
        self.v = self.v + size;
        if aggressor == Aggressor::Buy {
            self.bv = Some(self.bv.unwrap_or_default() + size);
        } else if self.bv.is_none() && aggressor == Aggressor::Sell {
            self.bv = Some(Qty::ZERO);
        }
    }

    pub fn is_consistent(&self) -> bool {
        self.l <= self.o
            && self.l <= self.c
            && self.h >= self.o
            && self.h >= self.c
            && self.v >= Qty::ZERO
            && self.bv.is_none_or(|b| b >= Qty::ZERO && b <= self.v)
    }
}

/// Which connection a market record came from, so every series is labelled on its own.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DataSource {
    /// Provider (connection) id (`rithmic-apex`).
    pub provider: String,
}

/// One print.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    /// Instrument.
    pub instrument: InstrumentId,
    /// Exchange (or provider) time.
    pub ts: Timestamp,
    /// Price.
    pub price: Price,
    /// Size.
    pub size: Qty,
    /// Aggressor side.
    pub aggressor: Aggressor,
    /// Where the aggressor flag came from.
    pub aggressor_source: AggressorSource,
    /// Key of the aggressor order the print filled, when the feed names that order (Rithmic's
    /// `aggressor_exchange_order_id`, hashed by [`order_key`]): the prints of one order share it,
    /// so a 60-lot that filled against twelve resting orders reads as the one order it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub order_key: Option<u32>,
    /// The connection the print came from (set by the runtime's market router).
    #[serde(default)]
    pub source: Option<DataSource>,
}

const FNV1A_32_OFFSET_BASIS: u32 = 0x811c_9dc5;
const FNV1A_32_PRIME: u32 = 0x0100_0193;

pub fn order_key(order_id: &str) -> u32 {
    let mut h = FNV1A_32_OFFSET_BASIS;
    for b in order_id.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(FNV1A_32_PRIME);
    }
    h
}

/// Session statistics shown next to a quote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// Trade date the stats cover (CME session date for futures).
    #[ts(type = "string")]
    pub trade_date: NaiveDate,
    /// Session open.
    pub open: Option<Price>,
    /// Session high.
    pub high: Option<Price>,
    /// Session low.
    pub low: Option<Price>,
    /// Prior session close (or settlement for futures).
    pub prev_close: Option<Price>,
    /// Session volume so far; `None` while the feed has not said it (a subscription that just
    /// started), never a zero that would read as a market where nothing traded.
    pub volume: Option<Qty>,
}

/// Top of book plus last trade and session stats.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// Instrument.
    pub instrument: InstrumentId,
    /// Quote time.
    pub ts: Timestamp,
    /// Best bid.
    pub bid: Option<Price>,
    /// Size at best bid.
    pub bid_size: Option<Qty>,
    /// Best ask.
    pub ask: Option<Price>,
    /// Size at best ask.
    pub ask_size: Option<Qty>,
    /// Last trade (or index value).
    pub last: Option<Price>,
    /// Size of the last trade.
    pub last_size: Option<Qty>,
    /// Session statistics, when known.
    pub session: Option<SessionStats>,
    /// The connection the quote came from (set by the runtime's market router).
    #[serde(default)]
    pub source: Option<DataSource>,
}

impl Quote {
    pub fn change(&self) -> Option<Price> {
        let s = self.session.as_ref()?;
        Some(self.last? - s.prev_close?)
    }
}

/// One price level of a book.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DepthLevel {
    /// Price.
    pub price: Price,
    /// Resting size.
    pub size: Qty,
    /// Number of orders, when the feed provides it.
    pub orders: Option<u32>,
}

/// A depth snapshot, best levels first on each side.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BookSnapshot {
    /// Instrument.
    pub instrument: InstrumentId,
    /// Snapshot time.
    pub ts: Timestamp,
    /// Bids, best (highest) first.
    pub bids: Vec<DepthLevel>,
    /// Asks, best (lowest) first.
    pub asks: Vec<DepthLevel>,
}

/// Volume traded at one price inside one bar, split by aggressor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FootprintCell {
    /// Price row (bucket floor).
    pub price: Price,
    /// Volume from sellers hitting the bid.
    pub bid_volume: Qty,
    /// Volume from buyers lifting the offer.
    pub ask_volume: Qty,
    /// Prints at this price: each trade the feed reported counts once, whatever its size.
    #[serde(default)]
    pub trades: u32,
}

impl FootprintCell {
    pub fn delta(&self) -> Qty {
        self.ask_volume - self.bid_volume
    }
}

/// A footprint bar: per-price aggressor volume for one bar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FootprintBar {
    /// Bar open time.
    pub t: Timestamp,
    /// Row bucket size in price units.
    pub bucket: Price,
    /// Rows, lowest price first.
    pub cells: Vec<FootprintCell>,
    /// Point of control (row with the most volume).
    pub poc: Option<Price>,
    /// The highest the bar's running delta (ask minus bid volume, from 0 at the open, print by
    /// print) reached: with `delta_low` and the closing delta, a delta candle that opens at 0.
    /// `None` when the path is not known (a provider's own footprints).
    #[serde(default)]
    pub delta_high: Option<Qty>,
    /// The lowest the bar's running delta reached (see `delta_high`).
    #[serde(default)]
    pub delta_low: Option<Qty>,
    /// Where the aggressor split came from.
    pub aggressor_source: AggressorSource,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn p(s: &str) -> Price {
        Price(Decimal::from_str(s).unwrap())
    }

    #[test]
    fn bar_merge_and_trades() {
        let mut b = Bar::flat(Timestamp(0), p("487.84"), Qty::from(100));
        b.apply_trade(p("488.01"), Qty::from(50), Aggressor::Buy);
        b.apply_trade(p("487.69"), Qty::from(30), Aggressor::Sell);
        b.apply_trade(p("487.85"), Qty::from(20), Aggressor::Unknown);
        assert_eq!(
            (b.o, b.h, b.l, b.c),
            (p("487.84"), p("488.01"), p("487.69"), p("487.85"))
        );
        assert_eq!(b.v, Qty::from(200));
        assert_eq!(b.bv, Some(Qty::from(50)));
        assert!(b.is_consistent());
        let mut agg = Bar::flat(Timestamp(0), p("1"), Qty::from(1));
        agg.merge(&b);
        assert_eq!(agg.h, p("488.01"));
        assert_eq!(agg.v, Qty::from(201));
        assert_eq!(
            Aggressor::from_sign(Aggressor::Sell.sign()),
            Aggressor::Sell
        );
    }

    #[test]
    fn order_keys_are_fnv1a_32_hashes() {
        assert_eq!(order_key(""), 0x811c_9dc5);
        assert_eq!(order_key("a"), 0xe40c_292c);
        assert_eq!(order_key("6702193041"), order_key("6702193041"));
        assert_ne!(order_key("6702193041"), order_key("6702193042"));
    }

    #[test]
    fn quote_change() {
        let q = Quote {
            instrument: InstrumentId::new("QQQ").unwrap(),
            ts: Timestamp(0),
            bid: Some(p("487.84")),
            bid_size: Some(Qty::from(1200)),
            ask: Some(p("487.86")),
            ask_size: Some(Qty::from(900)),
            last: Some(p("487.85")),
            last_size: None,
            session: Some(SessionStats {
                trade_date: NaiveDate::from_ymd_opt(2026, 10, 2).unwrap(),
                open: Some(p("486.70")),
                high: Some(p("489.22")),
                low: Some(p("485.52")),
                prev_close: Some(p("487.10")),
                volume: Some(Qty::from(30_400_000)),
            }),
            source: None,
        };
        assert_eq!(q.change(), Some(p("0.75")));
        let json = serde_json::to_value(&q).unwrap();
        assert_eq!(json["bidSize"], serde_json::json!(1200));
        assert_eq!(json["session"]["tradeDate"], "2026-10-02");
    }
}
