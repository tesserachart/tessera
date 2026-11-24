use std::collections::BTreeMap;

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use tessera_core::market::{Aggressor, FootprintCell, Trade};
use tessera_core::money::decimal_from_f64;
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_core::{Price, Qty, Timestamp};

pub const DEFAULT_VALUE_AREA: f64 = 0.70;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TickVolume {
    buy: Qty,
    sell: Qty,
    unknown: Qty,
}

impl TickVolume {
    fn total(&self) -> Qty {
        self.buy + self.sell + self.unknown
    }

    fn add(&mut self, o: &TickVolume) {
        self.buy = self.buy + o.buy;
        self.sell = self.sell + o.sell;
        self.unknown = self.unknown + o.unknown;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileBuilder {
    tick: Decimal,
    ticks: BTreeMap<i64, TickVolume>,
    minutes: BTreeMap<i64, TickRange>,
    prints: u64,
    first: Option<Timestamp>,
    last: Option<Timestamp>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickRange {
    pub low: i64,
    pub high: i64,
}

impl TickRange {
    fn widen(&mut self, o: TickRange) {
        self.low = self.low.min(o.low);
        self.high = self.high.max(o.high);
    }
}

impl tessera_host::Weigh for ProfileBuilder {
    fn weight(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.ticks.len() * (std::mem::size_of::<i64>() + std::mem::size_of::<TickVolume>())
            + self.minutes.len() * (std::mem::size_of::<i64>() + std::mem::size_of::<TickRange>())
    }
}

impl ProfileBuilder {
    pub fn new(tick: Price) -> Self {
        Self {
            tick: if tick.0.is_zero() {
                Decimal::ONE
            } else {
                tick.0
            },
            ticks: BTreeMap::new(),
            minutes: BTreeMap::new(),
            prints: 0,
            first: None,
            last: None,
        }
    }

    pub fn tick(&self) -> Price {
        Price(self.tick)
    }

    fn index(&self, price: Price) -> i64 {
        (price.0 / self.tick).round().to_i64().unwrap_or(0)
    }

    pub fn push_trade(&mut self, t: &Trade) {
        let i = self.index(t.price);
        let v = self.ticks.entry(i).or_default();
        match t.aggressor {
            Aggressor::Buy => v.buy = v.buy + t.size,
            Aggressor::Sell => v.sell = v.sell + t.size,
            Aggressor::Unknown => v.unknown = v.unknown + t.size,
        }
        let at = TickRange { low: i, high: i };
        self.minutes
            .entry(t.ts.0.div_euclid(NANOS_PER_MINUTE))
            .and_modify(|r| r.widen(at))
            .or_insert(at);
        self.prints += 1;
        self.first = Some(self.first.map_or(t.ts, |f| f.min(t.ts)));
        self.last = Some(self.last.map_or(t.ts, |l| l.max(t.ts)));
    }

    pub fn push_cell(&mut self, c: &FootprintCell) {
        let i = self.index(c.price);
        let v = self.ticks.entry(i).or_default();
        v.buy = v.buy + c.ask_volume;
        v.sell = v.sell + c.bid_volume;
    }

    pub fn merge(&mut self, other: &ProfileBuilder) {
        debug_assert_eq!(self.tick, other.tick, "profiles on different grids");
        for (i, v) in &other.ticks {
            self.ticks.entry(*i).or_default().add(v);
        }
        for (m, r) in &other.minutes {
            self.minutes
                .entry(*m)
                .and_modify(|held| held.widen(*r))
                .or_insert(*r);
        }
        self.prints += other.prints;
        self.first = match (self.first, other.first) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        self.last = match (self.last, other.last) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }

    pub fn minutes(&self) -> &BTreeMap<i64, TickRange> {
        &self.minutes
    }

    pub fn is_empty(&self) -> bool {
        self.ticks.is_empty()
    }

    pub fn prints(&self) -> u64 {
        self.prints
    }

    pub fn span_ticks(&self) -> i64 {
        match (self.ticks.first_key_value(), self.ticks.last_key_value()) {
            (Some((lo, _)), Some((hi, _))) => hi - lo + 1,
            _ => 0,
        }
    }

    pub fn finish(&self, row_ticks: u32, value_area: f64) -> VolumeProfile {
        let n = i64::from(row_ticks.max(1));
        let mut rows: BTreeMap<i64, TickVolume> = BTreeMap::new();
        for (i, v) in &self.ticks {
            rows.entry(i.div_euclid(n)).or_default().add(v);
        }
        let row = self.tick * Decimal::from(n);
        let price = |r: i64| {
            let mut d = Decimal::from(r) * row;
            d.rescale(self.tick.scale());
            Price(d)
        };
        let (buy, sell, unknown) = rows
            .values()
            .fold((Qty::ZERO, Qty::ZERO, Qty::ZERO), |(b, s, u), v| {
                (b + v.buy, s + v.sell, u + v.unknown)
            });
        let volume = buy + sell + unknown;
        let mut out = VolumeProfile {
            row: Price(row),
            rows: rows
                .iter()
                .map(|(r, v)| ProfileRow {
                    price: price(*r),
                    volume: v.total(),
                    buy: v.buy,
                    sell: v.sell,
                })
                .collect(),
            volume,
            buy,
            sell,
            poc: None,
            value_area: None,
            high: None,
            low: None,
            prints: self.prints,
            first: self.first,
            last: self.last,
        };
        let (Some((&lo, _)), Some((&hi, _))) = (rows.first_key_value(), rows.last_key_value())
        else {
            return out;
        };
        let tick_price = |i: i64| {
            let mut d = Decimal::from(i) * self.tick;
            d.rescale(self.tick.scale());
            Price(d)
        };
        let (low, high) = match (self.ticks.first_key_value(), self.ticks.last_key_value()) {
            (Some((&l, _)), Some((&h, _))) => (tick_price(l), tick_price(h)),
            _ => return out,
        };
        out.low = Some(low);
        out.high = Some(high);
        let dense: Vec<Decimal> = (lo..=hi)
            .map(|r| rows.get(&r).map_or(Decimal::ZERO, |v| v.total().0))
            .collect();
        let poc = point_of_control(&dense);
        let (a, b, held) = value_area_band(&dense, poc, value_area);
        out.poc = Some(price(lo + poc as i64));
        let top = |r: i64| tick_price((r + 1) * n - 1);
        out.value_area = Some(ValueArea {
            low: price(lo + a as i64).max(low),
            high: top(lo + b as i64).min(high),
            volume: Qty(held),
            share: value_area.clamp(0.0, 1.0),
        });
        out
    }
}

pub fn point_of_control(volumes: &[Decimal]) -> usize {
    let Some(max) = volumes.iter().copied().max() else {
        return 0;
    };
    let mid = volumes.len() as i64 - 1;
    volumes
        .iter()
        .enumerate()
        .filter(|(_, v)| **v == max)
        .min_by_key(|(i, _)| ((2 * *i as i64) - mid).abs())
        .map_or(0, |(i, _)| i)
}

pub fn value_area_band(volumes: &[Decimal], poc: usize, share: f64) -> (usize, usize, Decimal) {
    let total: Decimal = volumes.iter().copied().sum();
    let target = total * decimal_from_f64(share.clamp(0.0, 1.0)).unwrap_or(Decimal::ZERO);
    let (mut a, mut b) = (poc, poc);
    let mut held = volumes.get(poc).copied().unwrap_or_default();
    while held < target {
        let up = volumes.get(b + 1).copied();
        let down = a.checked_sub(1).map(|i| volumes[i]);
        let take_up = match (up, down) {
            (None, None) => break,
            (Some(u), Some(d)) if u == d => {
                a -= 1;
                b += 1;
                held += u + d;
                continue;
            }
            (Some(u), Some(d)) => u > d,
            (Some(_), None) => true,
            (None, Some(_)) => false,
        };
        if take_up {
            b += 1;
            held += volumes[b];
        } else {
            a -= 1;
            held += volumes[a];
        }
    }
    (a, b, held)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfileRow {
    pub price: Price,
    pub volume: Qty,
    pub buy: Qty,
    pub sell: Qty,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ValueArea {
    pub low: Price,
    pub high: Price,
    pub volume: Qty,
    pub share: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VolumeProfile {
    pub row: Price,
    pub rows: Vec<ProfileRow>,
    pub volume: Qty,
    pub buy: Qty,
    pub sell: Qty,
    pub poc: Option<Price>,
    pub value_area: Option<ValueArea>,
    pub high: Option<Price>,
    pub low: Option<Price>,
    pub prints: u64,
    pub first: Option<Timestamp>,
    pub last: Option<Timestamp>,
}

impl VolumeProfile {
    pub fn delta(&self) -> Qty {
        self.buy - self.sell
    }
}

const ROW_STEPS: [u32; 5] = [10, 20, 25, 40, 50];

pub fn auto_row_ticks(span_ticks: i64, max_rows: u32) -> u32 {
    let need = (span_ticks.max(1) as u64).div_ceil(u64::from(max_rows.max(1)));
    if need <= 1 {
        return 1;
    }
    if need <= 2 {
        return 2;
    }
    let mut scale: u64 = 1;
    loop {
        for s in ROW_STEPS {
            let step = u64::from(s) * scale / 10;
            if step >= need {
                return u32::try_from(step).unwrap_or(u32::MAX);
            }
        }
        scale = scale.saturating_mul(10);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::InstrumentId;
    use tessera_core::market::AggressorSource;

    fn p(s: &str) -> Price {
        Price::from_str(s).unwrap()
    }

    fn print(t: i64, price: &str, size: i64, side: Aggressor) -> Trade {
        Trade {
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            ts: Timestamp(t),
            price: p(price),
            size: Qty::from(size),
            aggressor: side,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        }
    }

    fn d(v: &[i64]) -> Vec<Decimal> {
        v.iter().map(|&x| Decimal::from(x)).collect()
    }

    #[test]
    fn poc_and_value_area_by_hand() {
        let mut b = ProfileBuilder::new(p("0.25"));
        let s = Aggressor::Sell;
        let u = Aggressor::Buy;
        for (price, size, side) in [
            ("100.00", 5, s),
            ("100.25", 10, s),
            ("100.50", 18, u),
            ("100.50", 12, s),
            ("100.75", 20, u),
            ("101.00", 15, u),
        ] {
            b.push_trade(&print(1, price, size, side));
        }
        let vp = b.finish(1, 0.70);
        assert_eq!(vp.volume, Qty::from(80));
        assert_eq!(vp.buy, Qty::from(53));
        assert_eq!(vp.sell, Qty::from(27));
        assert_eq!(vp.delta(), Qty::from(26));
        assert_eq!(vp.poc, Some(p("100.50")));
        let va = vp.value_area.unwrap();
        assert_eq!((va.low, va.high), (p("100.50"), p("101.00")));
        assert_eq!(va.volume, Qty::from(65));
        assert_eq!(vp.rows.len(), 5);
        assert_eq!(
            vp.rows[2],
            ProfileRow {
                price: p("100.50"),
                volume: Qty::from(30),
                buy: Qty::from(18),
                sell: Qty::from(12)
            }
        );
        assert_eq!(vp.prints, 6);
    }

    #[test]
    fn grouped_rows_and_ties_take_both_sides() {
        let mut b = ProfileBuilder::new(p("0.25"));
        for (price, size) in [
            ("100.00", 5),
            ("100.25", 10),
            ("100.50", 30),
            ("100.75", 20),
            ("101.00", 15),
        ] {
            b.push_trade(&print(1, price, size, Aggressor::Buy));
        }
        let vp = b.finish(2, 0.70);
        assert_eq!(vp.row, p("0.50"));
        let rows: Vec<(Price, Qty)> = vp.rows.iter().map(|r| (r.price, r.volume)).collect();
        assert_eq!(
            rows,
            vec![
                (p("100.00"), Qty::from(15)),
                (p("100.50"), Qty::from(50)),
                (p("101.00"), Qty::from(15)),
            ]
        );
        assert_eq!(vp.poc, Some(p("100.50")));
        let va = vp.value_area.unwrap();
        assert_eq!(
            (va.low, va.high, va.volume),
            (p("100.00"), p("101.00"), Qty::from(80))
        );
    }

    #[test]
    fn value_area_and_extremes_are_prices_not_row_floors() {
        let mut b = ProfileBuilder::new(p("0.25"));
        for (price, size) in [
            ("100.00", 5),
            ("100.25", 10),
            ("100.50", 30),
            ("100.75", 20),
        ] {
            b.push_trade(&print(1, price, size, Aggressor::Buy));
        }
        let vp = b.finish(2, 0.70);
        assert_eq!(vp.poc, Some(p("100.50")));
        let va = vp.value_area.unwrap();
        assert_eq!((va.low, va.high), (p("100.50"), p("100.75")));
        assert_eq!((vp.low, vp.high), (Some(p("100.00")), Some(p("100.75"))));
        let mut c = ProfileBuilder::new(p("0.25"));
        c.push_trade(&print(1, "100.25", 1, Aggressor::Sell));
        c.push_trade(&print(1, "100.50", 1, Aggressor::Sell));
        let vp = c.finish(4, 0.70);
        let va = vp.value_area.unwrap();
        assert_eq!((va.low, va.high), (p("100.25"), p("100.50")));
        assert_eq!(vp.rows[0].price, p("100.00"));
    }

    #[test]
    fn gaps_count_as_zero_and_poc_alone_can_suffice() {
        let v = d(&[10, 0, 0, 40, 5]);
        assert_eq!(point_of_control(&v), 3);
        assert_eq!(value_area_band(&v, 3, 0.70), (3, 3, Decimal::from(40)));
        assert_eq!(value_area_band(&v, 3, 0.90), (0, 4, Decimal::from(55)));
    }

    #[test]
    fn poc_ties_go_to_the_middle_then_lower() {
        assert_eq!(point_of_control(&d(&[9, 1, 2, 9, 1])), 3);
        assert_eq!(point_of_control(&d(&[1, 7, 7, 1])), 1);
    }

    #[test]
    fn composites_merge_and_cells_count() {
        let mut a = ProfileBuilder::new(p("0.25"));
        a.push_trade(&print(10, "100.00", 4, Aggressor::Buy));
        let mut b = ProfileBuilder::new(p("0.25"));
        b.push_trade(&print(5, "100.00", 6, Aggressor::Unknown));
        b.push_cell(&FootprintCell {
            price: p("100.25"),
            bid_volume: Qty::from(3),
            ask_volume: Qty::from(2),
            trades: 2,
        });
        a.merge(&b);
        let vp = a.finish(1, 0.7);
        assert_eq!(vp.rows[0].volume, Qty::from(10));
        assert_eq!(vp.rows[0].buy, Qty::from(4));
        assert_eq!(vp.rows[1].sell, Qty::from(3));
        assert_eq!(vp.volume, Qty::from(15));
        assert_eq!(
            (vp.first, vp.last),
            (Some(Timestamp(5)), Some(Timestamp(10)))
        );
        assert_eq!(vp.prints, 2);
        assert_eq!(a.span_ticks(), 2);
    }

    #[test]
    fn empty_profile_has_no_poc() {
        let vp = ProfileBuilder::new(p("0.01")).finish(1, 0.7);
        assert!(vp.rows.is_empty());
        assert_eq!(vp.poc, None);
        assert_eq!(vp.value_area, None);
    }

    #[test]
    fn negative_prices_floor_into_rows() {
        let mut b = ProfileBuilder::new(p("1"));
        b.push_trade(&print(1, "-3", 1, Aggressor::Buy));
        b.push_trade(&print(1, "-1", 1, Aggressor::Buy));
        let vp = b.finish(2, 0.7);
        let prices: Vec<Price> = vp.rows.iter().map(|r| r.price).collect();
        assert_eq!(prices, vec![p("-4"), p("-2")]);
    }

    #[test]
    fn auto_rows_are_round() {
        assert_eq!(auto_row_ticks(50, 60), 1);
        assert_eq!(auto_row_ticks(100, 60), 2);
        assert_eq!(auto_row_ticks(130, 60), 4);
        assert_eq!(auto_row_ticks(250, 60), 5);
        assert_eq!(auto_row_ticks(400, 60), 10);
        assert_eq!(auto_row_ticks(1500, 60), 25);
        assert_eq!(auto_row_ticks(2000, 60), 40);
        assert_eq!(auto_row_ticks(50_000, 60), 1000);
        assert_eq!(auto_row_ticks(0, 60), 1);
    }
}
