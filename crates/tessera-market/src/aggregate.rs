use std::collections::{BTreeMap, BTreeSet};

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use tessera_core::market::{Aggressor, AggressorSource, Bar, FootprintBar, FootprintCell, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::{Price, Qty, Timeframe, Timestamp};

fn bucket_range(calendar: SessionCalendar, tf: Timeframe, ts: Timestamp) -> (i64, i64) {
    let (open, close) = calendar.bucket_span(ts, tf);
    (open.0, close.0)
}

/// A CME trade date opens at 18:00 ET the evening before that date.
pub fn bar_range(calendar: SessionCalendar, tf: Timeframe, t: Timestamp) -> (Timestamp, Timestamp) {
    let (start, end) = bucket_range(calendar, tf, t);
    (Timestamp(start.min(t.0)), Timestamp(end))
}

pub fn aggregate(bars: &[Bar], tf: Timeframe, calendar: SessionCalendar) -> Vec<Bar> {
    let mut out: Vec<Bar> = Vec::with_capacity(bars.len() / tf.minutes().max(1) as usize + 1);
    let mut range: Option<(i64, i64)> = None;
    for b in bars {
        if let (Some((start, end)), Some(cur)) = (range, out.last_mut())
            && b.t.0 >= start
            && b.t.0 < end
        {
            cur.merge(b);
            continue;
        }
        let key = calendar.bucket_start(b.t, tf);
        range = Some(bucket_range(calendar, tf, b.t));
        match out.last_mut() {
            Some(cur) if cur.t == key => cur.merge(b),
            _ => out.push(Bar { t: key, ..*b }),
        }
    }
    out
}

#[derive(Clone, Debug)]
pub struct TradeBarBuilder {
    tf: Timeframe,
    calendar: SessionCalendar,
    current: Option<Bar>,
}

impl TradeBarBuilder {
    pub fn new(tf: Timeframe, calendar: SessionCalendar) -> Self {
        Self {
            tf,
            calendar,
            current: None,
        }
    }

    pub fn push(
        &mut self,
        ts: Timestamp,
        price: Price,
        size: Qty,
        aggressor: Aggressor,
    ) -> Option<Bar> {
        let key = self.calendar.bucket_start(ts, self.tf);
        match &mut self.current {
            Some(cur) if cur.t == key => {
                cur.apply_trade(price, size, aggressor);
                None
            }
            slot => {
                let mut bar = Bar::flat(key, price, Qty::ZERO);
                bar.apply_trade(price, size, aggressor);
                slot.replace(bar)
            }
        }
    }

    pub fn push_bar(&mut self, bar: &Bar) -> Option<Bar> {
        let key = self.calendar.bucket_start(bar.t, self.tf);
        match &mut self.current {
            Some(cur) if cur.t == key => {
                cur.merge(bar);
                None
            }
            slot => slot.replace(Bar { t: key, ..*bar }),
        }
    }

    pub fn current(&self) -> Option<&Bar> {
        self.current.as_ref()
    }
}

#[derive(Clone, Copy, Debug)]
struct RowVolume {
    bid: Qty,
    ask: Qty,
    trades: u32,
}

impl RowVolume {
    const ZERO: Self = Self {
        bid: Qty::ZERO,
        ask: Qty::ZERO,
        trades: 0,
    };
}

#[derive(Clone, Debug)]
struct Forming {
    t: Timestamp,
    source: AggressorSource,
    cells: BTreeMap<i64, RowVolume>,
    changed: BTreeSet<i64>,
    bid: Qty,
    ask: Qty,
    delta_high: Qty,
    delta_low: Qty,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FootprintChanges {
    pub bar: FootprintBar,
    pub bid: Qty,
    pub ask: Qty,
}

#[derive(Clone, Debug)]
pub struct FootprintBuilder {
    tf: Timeframe,
    calendar: SessionCalendar,
    row: Price,
    current: Option<Forming>,
    range: Option<(i64, i64)>,
}

impl FootprintBuilder {
    pub fn new(tf: Timeframe, calendar: SessionCalendar, row: Price) -> Self {
        Self {
            tf,
            calendar,
            row,
            current: None,
            range: None,
        }
    }

    pub fn row(&self) -> Price {
        self.row
    }

    fn row_of(&self, price: Price) -> i64 {
        if self.row.0.is_zero() {
            return 0;
        }
        (price.0 / self.row.0).floor().to_i64().unwrap_or(0)
    }

    fn key_of(&mut self, ts: Timestamp) -> Timestamp {
        if let (Some((start, end)), Some(cur)) = (self.range, &self.current)
            && ts.0 >= start
            && ts.0 < end
        {
            return cur.t;
        }
        let key = self.calendar.bucket_start(ts, self.tf);
        self.range = Some(bucket_range(self.calendar, self.tf, ts));
        key
    }

    pub fn push(&mut self, trade: &Trade) -> Option<FootprintBar> {
        let side = match trade.aggressor {
            Aggressor::Buy => true,
            Aggressor::Sell => false,
            Aggressor::Unknown => return None,
        };
        let key = self.key_of(trade.ts);
        let closed = match &self.current {
            Some(cur) if cur.t == key => None,
            _ => self.current.take().map(|c| self.bar_of(&c, None)),
        };
        let row = self.row_of(trade.price);
        let cur = self.current.get_or_insert_with(|| Forming {
            t: key,
            source: trade.aggressor_source,
            cells: BTreeMap::new(),
            changed: BTreeSet::new(),
            bid: Qty::ZERO,
            ask: Qty::ZERO,
            delta_high: Qty::ZERO,
            delta_low: Qty::ZERO,
        });
        if cur.source == AggressorSource::Exchange {
            cur.source = trade.aggressor_source;
        }
        let cell = cur.cells.entry(row).or_insert(RowVolume::ZERO);
        cell.trades = cell.trades.saturating_add(1);
        if side {
            cell.ask = cell.ask + trade.size;
            cur.ask = cur.ask + trade.size;
        } else {
            cell.bid = cell.bid + trade.size;
            cur.bid = cur.bid + trade.size;
        }
        let delta = cur.ask - cur.bid;
        cur.delta_high = cur.delta_high.max(delta);
        cur.delta_low = cur.delta_low.min(delta);
        cur.changed.insert(row);
        closed
    }

    fn price_of(&self, row: i64) -> Price {
        let mut d = Decimal::from(row) * self.row.0;
        d.rescale(self.row.0.scale());
        Price(d)
    }

    fn bar_of(&self, f: &Forming, only: Option<&BTreeSet<i64>>) -> FootprintBar {
        let cell = |(&row, &v): (&i64, &RowVolume)| FootprintCell {
            price: self.price_of(row),
            bid_volume: v.bid,
            ask_volume: v.ask,
            trades: v.trades,
        };
        let cells: Vec<FootprintCell> = match only {
            Some(rows) => rows
                .iter()
                .filter_map(|r| f.cells.get_key_value(r))
                .map(cell)
                .collect(),
            None => f.cells.iter().map(cell).collect(),
        };
        let poc =
            poc_index(f.cells.iter().map(|(&r, v)| (r, v.bid + v.ask))).map(|r| self.price_of(r));
        FootprintBar {
            t: f.t,
            bucket: self.row,
            poc,
            cells,
            delta_high: Some(f.delta_high),
            delta_low: Some(f.delta_low),
            aggressor_source: f.source,
        }
    }

    pub fn current(&self) -> Option<FootprintBar> {
        self.current.as_ref().map(|c| self.bar_of(c, None))
    }

    pub fn take_changes(&mut self) -> Option<FootprintChanges> {
        let cur = self.current.as_ref()?;
        if cur.changed.is_empty() {
            return None;
        }
        let out = FootprintChanges {
            bar: self.bar_of(cur, Some(&cur.changed)),
            bid: cur.bid,
            ask: cur.ask,
        };
        if let Some(cur) = self.current.as_mut() {
            cur.changed.clear();
        }
        Some(out)
    }

    pub fn current_t(&self) -> Option<Timestamp> {
        self.current.as_ref().map(|c| c.t)
    }

    pub fn build(mut self, trades: &[Trade]) -> Vec<FootprintBar> {
        let mut out = Vec::new();
        for t in trades {
            if let Some(closed) = self.push(t) {
                out.push(closed);
            }
        }
        out.extend(self.current());
        out
    }
}

fn poc_index<V: Ord + Copy>(rows: impl Iterator<Item = (i64, V)> + Clone) -> Option<i64> {
    let (lo, hi) = (rows.clone().next()?.0, rows.clone().last()?.0);
    let max = rows.clone().map(|(_, v)| v).max()?;
    rows.filter(|&(_, v)| v == max)
        .min_by_key(|&(r, _)| ((2 * r - lo - hi).abs(), r))
        .map(|(r, _)| r)
}

pub fn point_of_control(cells: &[FootprintCell]) -> Option<Price> {
    let (Some(first), Some(last)) = (cells.first(), cells.last()) else {
        return None;
    };
    let max = cells.iter().map(|c| c.bid_volume + c.ask_volume).max()?;
    let mid2 = first.price.0 + last.price.0;
    cells
        .iter()
        .filter(|c| c.bid_volume + c.ask_volume == max)
        .min_by_key(|c| ((c.price.0 + c.price.0 - mid2).abs(), c.price))
        .map(|c| c.price)
}

pub fn regroup(bar: &FootprintBar, row: Price) -> FootprintBar {
    if row.0.is_zero() || row == bar.bucket {
        return bar.clone();
    }
    let mut rows: BTreeMap<i64, RowVolume> = BTreeMap::new();
    for c in &bar.cells {
        let r = (c.price.0 / row.0).floor().to_i64().unwrap_or(0);
        let e = rows.entry(r).or_insert(RowVolume::ZERO);
        e.bid = e.bid + c.bid_volume;
        e.ask = e.ask + c.ask_volume;
        e.trades = e.trades.saturating_add(c.trades);
    }
    let scale = row.0.scale().max(bar.bucket.0.scale());
    let cells: Vec<FootprintCell> = rows
        .into_iter()
        .map(|(r, v)| {
            let mut d = Decimal::from(r) * row.0;
            d.rescale(scale);
            FootprintCell {
                price: Price(d),
                bid_volume: v.bid,
                ask_volume: v.ask,
                trades: v.trades,
            }
        })
        .collect();
    FootprintBar {
        t: bar.t,
        bucket: row,
        poc: point_of_control(&cells),
        cells,
        delta_high: bar.delta_high,
        delta_low: bar.delta_low,
        aggressor_source: bar.aggressor_source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::time::{NANOS_PER_DAY, NANOS_PER_MINUTE};

    fn p(s: &str) -> Price {
        Price::from_str(s).unwrap()
    }

    fn minute_bars(start: &str, n: usize) -> Vec<Bar> {
        let t0 = Timestamp::parse(start).unwrap();
        (0..n)
            .map(|i| {
                let base = 100 + i as i64;
                Bar {
                    t: t0.add_nanos(i as i64 * NANOS_PER_MINUTE),
                    o: Price::from(base),
                    h: Price::from(base + 2),
                    l: Price::from(base - 1),
                    c: Price::from(base + 1),
                    v: Qty::from(10),
                    bv: Some(Qty::from(4)),
                }
            })
            .collect()
    }

    #[test]
    fn equities_hour_bars_start_at_half_past() {
        let bars = minute_bars("2026-10-02T09:30:00-04:00", 390);
        let h1 = aggregate(&bars, Timeframe::H1, SessionCalendar::UsEquities);
        assert_eq!(h1.len(), 7, "09:30 10:30 … 15:30");
        assert_eq!(
            h1[0].t,
            Timestamp::parse("2026-10-02T09:30:00-04:00").unwrap()
        );
        assert_eq!(
            h1[6].t,
            Timestamp::parse("2026-10-02T15:30:00-04:00").unwrap()
        );
        assert_eq!(h1[0].v, Qty::from(600));
        assert_eq!(h1[6].v, Qty::from(300));
        assert_eq!(h1[0].o, Price::from(100));
        assert_eq!(h1[0].c, Price::from(160));
        assert_eq!(h1[0].h, Price::from(161));
        assert_eq!(h1[0].l, Price::from(99));
        assert_eq!(h1[0].bv, Some(Qty::from(240)));
        let total: Qty = h1.iter().fold(Qty::ZERO, |a, b| a + b.v);
        assert_eq!(total, Qty::from(3900));
        let d1 = aggregate(&bars, Timeframe::D1, SessionCalendar::UsEquities);
        assert_eq!(d1.len(), 1);
        assert_eq!(
            d1[0].t,
            Timestamp::parse("2026-10-02T00:00:00-04:00").unwrap()
        );
        let m5 = aggregate(&bars, Timeframe::M5, SessionCalendar::UsEquities);
        assert_eq!(m5.len(), 78);
        let m30 = aggregate(&bars, Timeframe::M30, SessionCalendar::UsEquities);
        assert_eq!(m30.len(), 13);
        let h4 = aggregate(&bars, Timeframe::H4, SessionCalendar::UsEquities);
        assert_eq!(h4.len(), 2, "09:30–13:30 and 13:30–16:00");
    }

    #[test]
    fn any_count_of_minutes_or_sessions_aggregates() {
        let tf = |s: &str| s.parse::<Timeframe>().unwrap();
        let bars = minute_bars("2026-10-02T09:30:00-04:00", 390);
        let m7 = aggregate(&bars, tf("7m"), SessionCalendar::UsEquities);
        assert_eq!(
            m7.len(),
            56,
            "390 minutes is 55 whole 7m bars and a 5m stub"
        );
        assert_eq!(
            m7[1].t,
            Timestamp::parse("2026-10-02T09:37:00-04:00").unwrap()
        );
        assert_eq!(m7[0].v, Qty::from(70));
        assert_eq!(m7[55].v, Qty::from(50));
        let m90 = aggregate(&bars, tf("90m"), SessionCalendar::UsEquities);
        assert_eq!(m90.len(), 5);
        assert_eq!(
            m90[1].t,
            Timestamp::parse("2026-10-02T11:00:00-04:00").unwrap()
        );
        let cal = SessionCalendar::CmeEquityIndex;
        let week: Vec<Bar> = (0..5)
            .flat_map(|d| minute_bars(&format!("2026-10-{:02}T10:00:00-04:00", 5 + d), 3))
            .collect();
        let daily = aggregate(&week, Timeframe::D1, cal);
        assert_eq!(daily.len(), 5);
        let two = aggregate(&week, tf("2D"), cal);
        let from_daily = aggregate(&daily, tf("2D"), cal);
        assert_eq!(two, from_daily);
        assert_eq!(two.iter().fold(Qty::ZERO, |a, b| a + b.v), Qty::from(150));
        assert_eq!(two.len(), 3);
        let (open, close) = bar_range(cal, tf("2D"), two[1].t);
        assert!(open < close && close.0 - open.0 > NANOS_PER_DAY);
    }

    #[test]
    fn futures_daily_uses_cme_session_date() {
        let mut bars = minute_bars("2026-10-01T16:58:00-04:00", 2);
        bars.extend(minute_bars("2026-10-01T18:00:00-04:00", 2));
        let d1 = aggregate(&bars, Timeframe::D1, SessionCalendar::CmeEquityIndex);
        assert_eq!(d1.len(), 2);
        assert_eq!(
            d1[0].t,
            Timestamp::parse("2026-10-01T00:00:00-04:00").unwrap()
        );
        assert_eq!(
            d1[1].t,
            Timestamp::parse("2026-10-02T00:00:00-04:00").unwrap()
        );
        let h4 = aggregate(&bars, Timeframe::H4, SessionCalendar::CmeEquityIndex);
        assert_eq!(h4.len(), 2);
        assert_eq!(
            h4[1].t,
            Timestamp::parse("2026-10-01T18:00:00-04:00").unwrap()
        );
    }

    fn print(ts: Timestamp, price: &str, size: i64, aggressor: Aggressor) -> Trade {
        Trade {
            instrument: tessera_core::InstrumentId::new("NQZ6.CME").unwrap(),
            ts,
            price: p(price),
            size: Qty::from(size),
            aggressor,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        }
    }

    #[test]
    fn footprints_split_prints_by_side_and_price() {
        let mut b =
            FootprintBuilder::new(Timeframe::M1, SessionCalendar::CmeEquityIndex, p("0.25"));
        let t0 = Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap();
        let at = |s: i64| t0.add_nanos(s * 1_000_000_000);
        assert!(
            b.push(&print(at(1), "20641.25", 3, Aggressor::Buy))
                .is_none()
        );
        b.push(&print(at(2), "20641.25", 2, Aggressor::Sell));
        b.push(&print(at(3), "20641.50", 7, Aggressor::Buy));
        b.push(&print(at(4), "20641.00", 4, Aggressor::Sell));
        b.push(&print(at(5), "20641.00", 9, Aggressor::Unknown));
        let cur = b.current().unwrap();
        assert_eq!(cur.t, t0);
        assert_eq!(cur.bucket, p("0.25"));
        let rows: Vec<(String, i64, i64, u32)> = cur
            .cells
            .iter()
            .map(|c| {
                (
                    c.price.to_string(),
                    c.bid_volume.to_f64() as i64,
                    c.ask_volume.to_f64() as i64,
                    c.trades,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("20641.00".to_owned(), 4, 0, 1),
                ("20641.25".to_owned(), 2, 3, 2),
                ("20641.50".to_owned(), 0, 7, 1),
            ],
            "each print counts once at its price, whatever its size; a print with no side counts nowhere"
        );
        assert_eq!(cur.poc, Some(p("20641.50")));
        assert_eq!(cur.aggressor_source, AggressorSource::Exchange);
        let closed = b
            .push(&print(at(61), "20642.00", 1, Aggressor::Buy))
            .unwrap();
        assert_eq!(closed, cur);
        assert_eq!(b.current().unwrap().t, at(60));
        let mut b = FootprintBuilder::new(Timeframe::M1, SessionCalendar::CmeEquityIndex, p("1"));
        b.push(&print(at(1), "20641.75", 2, Aggressor::Buy));
        b.push(&print(at(2), "20641.25", 2, Aggressor::Buy));
        let cur = b.current().unwrap();
        assert_eq!(cur.cells.len(), 1);
        assert_eq!(cur.cells[0].price, p("20641"));
        assert_eq!(cur.cells[0].ask_volume, Qty::from(4));
    }

    #[test]
    fn footprints_build_from_a_tape_and_regroup() {
        let t0 = Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap();
        let at = |s: i64| t0.add_nanos(s * 1_000_000_000);
        let tape = [
            print(at(1), "20641.25", 3, Aggressor::Buy),
            print(at(2), "20641.50", 2, Aggressor::Sell),
            print(at(61), "20642.00", 5, Aggressor::Buy),
            print(at(62), "20642.75", 1, Aggressor::Sell),
            print(at(185), "20640.00", 1, Aggressor::Sell),
        ];
        let bars = FootprintBuilder::new(Timeframe::M1, SessionCalendar::CmeEquityIndex, p("0.25"))
            .build(&tape);
        assert_eq!(
            bars.iter().map(|b| b.t).collect::<Vec<_>>(),
            [t0, at(60), at(180)],
            "an empty minute has no bar"
        );
        assert_eq!(bars[1].cells.len(), 2);
        let one_point = regroup(&bars[1], p("1"));
        assert_eq!(one_point.cells.len(), 1);
        assert_eq!(one_point.cells[0].price, p("20642.00"));
        assert_eq!(
            (
                one_point.cells[0].bid_volume,
                one_point.cells[0].ask_volume,
                one_point.cells[0].trades
            ),
            (Qty::from(1), Qty::from(5), 2)
        );
        assert_eq!(one_point.poc, Some(p("20642.00")));
        assert_eq!(regroup(&bars[0], p("0.25")), bars[0]);
    }

    #[test]
    fn footprint_poc_ties_follow_the_profile_rule() {
        let t0 = Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap();
        let tape: Vec<Trade> = [
            ("100.00", 9),
            ("100.25", 1),
            ("100.50", 2),
            ("100.75", 9),
            ("101.00", 1),
        ]
        .iter()
        .map(|&(price, size)| print(t0, price, size, Aggressor::Buy))
        .collect();
        let bar = FootprintBuilder::new(Timeframe::M1, SessionCalendar::CmeEquityIndex, p("0.25"))
            .build(&tape)
            .remove(0);
        assert_eq!(bar.poc, Some(p("100.75")));
        let mut profile = crate::orderflow::profile::ProfileBuilder::new(p("0.25"));
        for t in &tape {
            profile.push_trade(t);
        }
        assert_eq!(profile.finish(1, 0.7).poc, bar.poc);
        let even: Vec<FootprintCell> = [("1", 1), ("2", 7), ("3", 7), ("4", 1)]
            .iter()
            .map(|&(price, v)| FootprintCell {
                price: p(price),
                bid_volume: Qty::from(v),
                ask_volume: Qty::ZERO,
                trades: 1,
            })
            .collect();
        assert_eq!(point_of_control(&even), Some(p("2")));
    }

    #[test]
    fn footprints_keep_the_running_deltas_extremes() {
        let mut b =
            FootprintBuilder::new(Timeframe::M1, SessionCalendar::CmeEquityIndex, p("0.25"));
        let t0 = Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap();
        let at = |s: i64| t0.add_nanos(s * 1_000_000_000);
        for (s, size, side) in [
            (1, 5, Aggressor::Buy),
            (2, 8, Aggressor::Sell),
            (3, 2, Aggressor::Buy),
            (4, 1, Aggressor::Sell),
            (5, 50, Aggressor::Unknown),
        ] {
            b.push(&print(at(s), "20641.25", size, side));
        }
        let bar = b.current().unwrap();
        assert_eq!(bar.delta_high, Some(Qty::from(5)));
        assert_eq!(bar.delta_low, Some(Qty::from(-3)));
        let close = bar
            .cells
            .iter()
            .fold(Qty::ZERO, |a, c| a + c.ask_volume - c.bid_volume);
        assert_eq!(close, Qty::from(-2));
        let changes = b.take_changes().unwrap();
        assert_eq!(changes.bar.delta_high, Some(Qty::from(5)));
        let wide = regroup(&bar, p("1"));
        assert_eq!(
            (wide.delta_high, wide.delta_low),
            (bar.delta_high, bar.delta_low)
        );
        let closed = b
            .push(&print(at(61), "20641.25", 4, Aggressor::Sell))
            .unwrap();
        assert_eq!(closed.delta_low, Some(Qty::from(-3)));
        let next = b.current().unwrap();
        assert_eq!(
            (next.delta_high, next.delta_low),
            (Some(Qty::ZERO), Some(Qty::from(-4)))
        );
    }

    #[test]
    fn forming_bars_report_their_changed_rows() {
        let t0 = Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap();
        let at = |s: i64| t0.add_nanos(s * 1_000_000_000);
        let mut b =
            FootprintBuilder::new(Timeframe::M1, SessionCalendar::CmeEquityIndex, p("0.25"));
        assert!(b.take_changes().is_none());
        b.push(&print(at(1), "20641.25", 3, Aggressor::Buy));
        b.push(&print(at(2), "20641.50", 2, Aggressor::Sell));
        let first = b.take_changes().unwrap();
        assert_eq!(first.bar.cells.len(), 2);
        assert!(b.take_changes().is_none(), "nothing new");
        b.push(&print(at(3), "20641.50", 4, Aggressor::Buy));
        let next = b.take_changes().unwrap();
        assert_eq!(next.bar.cells.len(), 1);
        assert_eq!(next.bar.cells[0].price, p("20641.50"));
        assert_eq!(
            (next.bar.cells[0].bid_volume, next.bar.cells[0].ask_volume),
            (Qty::from(2), Qty::from(4))
        );
        assert_eq!((next.bid, next.ask), (Qty::from(2), Qty::from(7)));
        assert_eq!(next.bar.poc, Some(p("20641.50")), "the whole bar's");
        b.push(&print(at(61), "20642.00", 1, Aggressor::Buy));
        let new = b.take_changes().unwrap();
        assert_eq!(new.bar.t, at(60));
        assert_eq!(new.bar.cells.len(), 1);
    }

    #[test]
    fn merging_a_forming_bars_changes_by_the_larger_volume_rebuilds_it() {
        let t0 = Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap();
        let at = |s: i64| t0.add_nanos(s * 1_000_000_000);
        let mut b =
            FootprintBuilder::new(Timeframe::M1, SessionCalendar::CmeEquityIndex, p("0.25"));
        let mut merged: BTreeMap<Price, (Qty, Qty)> = BTreeMap::new();
        for (s, price, size, side) in [
            (1, "20641.25", 3, Aggressor::Buy),
            (2, "20641.50", 2, Aggressor::Sell),
            (3, "20641.25", 4, Aggressor::Sell),
            (4, "20641.25", 9, Aggressor::Unknown),
            (5, "20641.50", 1, Aggressor::Buy),
            (6, "20641.25", 2, Aggressor::Buy),
        ] {
            b.push(&print(at(s), price, size, side));
            for c in b.take_changes().into_iter().flat_map(|c| c.bar.cells) {
                let kept = merged.entry(c.price).or_insert((Qty::ZERO, Qty::ZERO));
                assert!(c.bid_volume >= kept.0 && c.ask_volume >= kept.1);
                *kept = (kept.0.max(c.bid_volume), kept.1.max(c.ask_volume));
            }
        }
        let bar: BTreeMap<Price, (Qty, Qty)> = b
            .current()
            .unwrap()
            .cells
            .iter()
            .map(|c| (c.price, (c.bid_volume, c.ask_volume)))
            .collect();
        assert_eq!(merged, bar);
    }

    #[test]
    fn a_footprint_with_one_inferred_print_reports_inferred() {
        let t0 = Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap();
        let mut inferred = print(t0, "20641.25", 1, Aggressor::Buy);
        inferred.aggressor_source = AggressorSource::Inferred;
        let tape = [
            print(t0, "20641.25", 1, Aggressor::Buy),
            inferred,
            print(t0, "20641.25", 1, Aggressor::Sell),
        ];
        let bar = FootprintBuilder::new(Timeframe::M1, SessionCalendar::CmeEquityIndex, p("0.25"))
            .build(&tape)
            .remove(0);
        assert_eq!(bar.aggressor_source, AggressorSource::Inferred);
    }

    #[test]
    fn trade_builder_rolls_buckets() {
        let mut b = TradeBarBuilder::new(Timeframe::S1, SessionCalendar::Crypto24x7);
        let t0 = Timestamp::parse("2026-10-03T12:00:00Z").unwrap();
        assert!(
            b.push(t0, p("98412.00"), Qty::from(1), Aggressor::Buy)
                .is_none()
        );
        assert!(
            b.push(
                t0.add_nanos(500_000_000),
                p("98413.50"),
                Qty::from(2),
                Aggressor::Sell
            )
            .is_none()
        );
        let closed = b
            .push(
                t0.add_nanos(1_000_000_000),
                p("98411.00"),
                Qty::from(1),
                Aggressor::Sell,
            )
            .unwrap();
        assert_eq!(closed.t, t0);
        assert_eq!(
            (closed.o, closed.h, closed.c),
            (p("98412.00"), p("98413.50"), p("98413.50"))
        );
        assert_eq!(closed.v, Qty::from(3));
        assert_eq!(closed.bv, Some(Qty::from(1)));
        assert_eq!(b.current().unwrap().o, p("98411.00"));
    }
}
