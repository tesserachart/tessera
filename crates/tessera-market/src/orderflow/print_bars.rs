use chrono::NaiveDate;
use rust_decimal::Decimal;
use tessera_core::market::{Aggressor, Bar, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::time::NANOS_PER_MILLI;
pub use tessera_core::timeframe::{PRINT_BAR_SIZE_MAX, PrintBars};
use tessera_core::{Price, Qty, Timestamp};

use super::flow::BarFlow;

pub type FlowBar = (Bar, BarFlow);

struct Forming {
    date: NaiveDate,
    bar: Bar,
    flow: BarFlow,
    prints: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Way {
    Up,
    Down,
}

#[derive(Clone, Copy)]
struct Brick {
    open: Decimal,
    close: Decimal,
    way: Way,
}

impl Brick {
    fn way(open: Decimal, close: Decimal) -> Way {
        if close > open { Way::Up } else { Way::Down }
    }
}

const BRICK_STEP_NANOS: i64 = NANOS_PER_MILLI;

pub struct PrintBarBuilder {
    bars: PrintBars,
    tick: Decimal,
    calendar: SessionCalendar,
    closed: Vec<FlowBar>,
    forming: Option<Forming>,
    brick: Option<Brick>,
}

impl PrintBarBuilder {
    pub fn new(bars: PrintBars, tick: Price, calendar: SessionCalendar) -> Self {
        Self {
            bars,
            tick: tick.0,
            calendar,
            closed: Vec::new(),
            forming: None,
            brick: None,
        }
    }

    pub fn push(&mut self, t: &Trade) {
        if let PrintBars::Renko { size } = self.bars {
            self.push_brick(t, self.tick * Decimal::from(size));
            return;
        }
        let date = self.calendar.trade_date(t.ts);
        let joins = self
            .forming
            .as_ref()
            .is_some_and(|f| f.date == date && !self.outside_range(&f.bar, t.price));
        if joins {
            if let Some(f) = self.forming.as_mut() {
                add(&mut f.bar, t);
                flow(&mut f.flow, t);
                f.prints += 1;
            }
        } else {
            self.close();
            let mut first = BarFlow::QUIET;
            flow(&mut first, t);
            self.forming = Some(Forming {
                date,
                bar: start(t),
                flow: first,
                prints: 1,
            });
        }
        if self.forming.as_ref().is_some_and(|f| self.full(f)) {
            self.close();
        }
    }

    pub fn finish(self) -> (Vec<Bar>, Option<Bar>) {
        let (closed, forming) = self.finish_with_flow();
        (
            closed.into_iter().map(|(b, _)| b).collect(),
            forming.map(|(b, _)| b),
        )
    }

    pub fn finish_with_flow(mut self) -> (Vec<FlowBar>, Option<FlowBar>) {
        let forming = self.forming.take().map(|mut f| {
            if matches!(self.bars, PrintBars::Renko { .. }) {
                f.bar.t = self.after_last(f.bar.t);
            }
            (f.bar, f.flow)
        });
        (self.closed, forming)
    }

    fn push_brick(&mut self, t: &Trade, box_size: Decimal) {
        match self.forming.as_mut() {
            Some(f) => {
                add(&mut f.bar, t);
                flow(&mut f.flow, t);
                f.prints += 1;
            }
            None => {
                let mut bar = start(t);
                if let Some(b) = self.brick {
                    bar.o = Price(b.close);
                    bar.h = bar.h.max(bar.o);
                    bar.l = bar.l.min(bar.o);
                }
                let mut first = BarFlow::QUIET;
                flow(&mut first, t);
                self.forming = Some(Forming {
                    date: self.calendar.trade_date(t.ts),
                    bar,
                    flow: first,
                    prints: 1,
                });
            }
        }
        let anchor = match (self.brick, self.forming.as_ref()) {
            (Some(b), _) => b.close,
            (None, Some(f)) => f.bar.o.0,
            (None, None) => return,
        };
        let up = match self.brick {
            Some(b) if b.way == Way::Down => b.open,
            _ => anchor,
        } + box_size;
        let down = match self.brick {
            Some(b) if b.way == Way::Up => b.open,
            _ => anchor,
        } - box_size;
        let price = t.price.0;
        if price >= up {
            self.lay_bricks(t.ts, up - box_size, box_size, price);
        } else if price <= down {
            self.lay_bricks(t.ts, down + box_size, -box_size, price);
        }
    }

    fn lay_bricks(&mut self, ts: Timestamp, mut open: Decimal, step: Decimal, price: Decimal) {
        let reached = |close: Decimal| {
            if step > Decimal::ZERO {
                price >= close
            } else {
                price <= close
            }
        };
        let mut close = open + step;
        if let Some(mut f) = self.forming.take() {
            body(&mut f.bar, open, close);
            f.bar.t = self.after_last(f.bar.t);
            self.closed.push((f.bar, f.flow));
        }
        self.brick = Some(Brick {
            open,
            close,
            way: Brick::way(open, close),
        });
        loop {
            open = close;
            close = open + step;
            if !reached(close) {
                break;
            }
            let t = self.after_last(ts);
            let mut bar = Bar {
                t,
                o: Price(open),
                h: Price(open),
                l: Price(open),
                c: Price(open),
                v: Qty(Decimal::ZERO),
                bv: Some(Qty(Decimal::ZERO)),
            };
            body(&mut bar, open, close);
            self.closed.push((bar, BarFlow::QUIET));
            self.brick = Some(Brick {
                open,
                close,
                way: Brick::way(open, close),
            });
        }
    }

    fn after_last(&self, t: Timestamp) -> Timestamp {
        match self.closed.last() {
            Some((last, _)) => Timestamp(t.0.max(last.t.0 + BRICK_STEP_NANOS)),
            None => t,
        }
    }

    fn outside_range(&self, bar: &Bar, price: Price) -> bool {
        let PrintBars::Range { size } = self.bars else {
            return false;
        };
        let high = bar.h.0.max(price.0);
        let low = bar.l.0.min(price.0);
        high - low > self.tick * Decimal::from(size)
    }

    fn full(&self, f: &Forming) -> bool {
        match self.bars {
            PrintBars::Tick { size } => f.prints >= size,
            PrintBars::Volume { size } => f.bar.v.0 >= Decimal::from(size),
            PrintBars::Delta { size } => f.flow.sides.delta.abs() >= f64::from(size),
            PrintBars::Range { .. } | PrintBars::Renko { .. } => false,
        }
    }

    fn close(&mut self) {
        if let Some(f) = self.forming.take() {
            self.closed.push((f.bar, f.flow));
        }
    }
}

fn start(t: &Trade) -> Bar {
    Bar {
        t: t.ts,
        o: t.price,
        h: t.price,
        l: t.price,
        c: t.price,
        v: t.size,
        bv: Some(buy_size(t)),
    }
}

fn body(bar: &mut Bar, open: Decimal, close: Decimal) {
    bar.o = Price(open);
    bar.c = Price(close);
    bar.h = Price(open.max(close));
    bar.l = Price(open.min(close));
}

fn add(bar: &mut Bar, t: &Trade) {
    bar.h = bar.h.max(t.price);
    bar.l = bar.l.min(t.price);
    bar.c = t.price;
    bar.v = Qty(bar.v.0 + t.size.0);
    bar.bv = Some(Qty(bar.bv.map_or(Decimal::ZERO, |q| q.0) + buy_size(t).0));
}

fn flow(f: &mut BarFlow, t: &Trade) {
    let size = t.size.to_f64();
    let signed = match t.aggressor {
        Aggressor::Buy => size,
        Aggressor::Sell => -size,
        Aggressor::Unknown => return,
    };
    let s = &mut f.sides;
    s.volume += size;
    s.delta += signed;
    s.delta_high = s.delta_high.max(s.delta);
    s.delta_low = s.delta_low.min(s.delta);
    f.sums.add(t.price.to_f64(), size);
}

fn buy_size(t: &Trade) -> Qty {
    if t.aggressor == Aggressor::Buy {
        t.size
    } else {
        Qty(Decimal::ZERO)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::market::AggressorSource;
    use tessera_core::time::NANOS_PER_SEC;
    use tessera_core::{InstrumentId, Timestamp};

    fn tape(start: &str, prints: &[(f64, u32, i8)]) -> Vec<Trade> {
        let t0 = Timestamp::parse(start).unwrap().0;
        prints
            .iter()
            .enumerate()
            .map(|(i, (price, size, side))| Trade {
                instrument: InstrumentId::new("NQZ6.CME").unwrap(),
                ts: Timestamp(t0 + i as i64 * NANOS_PER_SEC),
                price: Price(Decimal::try_from(*price).unwrap()),
                size: Qty(Decimal::from(*size)),
                aggressor: Aggressor::from_sign(*side),
                aggressor_source: AggressorSource::Exchange,
                order_key: None,
                source: None,
            })
            .collect()
    }

    const NQ: &[(f64, u32, i8)] = &[
        (20641.00, 2, 1),
        (20641.25, 5, 1),
        (20641.50, 1, -1),
        (20641.25, 3, -1),
        (20640.75, 4, -1),
        (20640.50, 6, 1),
        (20641.00, 2, 1),
        (20641.75, 1, 1),
    ];

    fn build(bars: PrintBars, prints: &[Trade]) -> (Vec<Bar>, Option<Bar>) {
        let cal = tessera_core::catalog::seed_futures_products()
            .into_iter()
            .find(|p| p.root == "NQ")
            .map(|p| {
                p.contract(2026, tessera_core::instrument::FuturesMonth::Z, true)
                    .1
                    .sessions
            })
            .unwrap();
        let mut b = PrintBarBuilder::new(bars, Price(Decimal::new(25, 2)), cal);
        for t in prints {
            b.push(t);
        }
        b.finish()
    }

    fn ohlcv(b: &Bar) -> (String, String, String, String, String, String) {
        (
            b.o.0.normalize().to_string(),
            b.h.0.normalize().to_string(),
            b.l.0.normalize().to_string(),
            b.c.0.normalize().to_string(),
            b.v.0.normalize().to_string(),
            b.bv.unwrap().0.normalize().to_string(),
        )
    }

    fn row(
        o: &str,
        h: &str,
        l: &str,
        c: &str,
        v: &str,
        bv: &str,
    ) -> (String, String, String, String, String, String) {
        (o.into(), h.into(), l.into(), c.into(), v.into(), bv.into())
    }

    #[test]
    fn tick_bars_close_every_n_prints() {
        let prints = tape("2026-10-02T14:42:00-04:00", NQ);
        let (closed, forming) = build(PrintBars::Tick { size: 3 }, &prints);
        assert_eq!(
            closed.iter().map(ohlcv).collect::<Vec<_>>(),
            vec![
                row("20641", "20641.5", "20641", "20641.5", "8", "7"),
                row("20641.25", "20641.25", "20640.5", "20640.5", "13", "6"),
            ]
        );
        assert_eq!(
            forming.map(|b| ohlcv(&b)),
            Some(row("20641", "20641.75", "20641", "20641.75", "3", "3"))
        );
        assert_eq!(closed[1].t, prints[3].ts);
    }

    #[test]
    fn each_bar_carries_the_order_flow_of_its_own_prints() {
        let prints = tape("2026-10-02T14:42:00-04:00", NQ);
        let cal = tessera_core::session::SessionCalendar::CmeEquityIndex;
        let mut b =
            PrintBarBuilder::new(PrintBars::Tick { size: 3 }, Price(Decimal::new(25, 2)), cal);
        for t in &prints {
            b.push(t);
        }
        let (closed, forming) = b.finish_with_flow();
        let (bar, flow) = &closed[0];
        assert_eq!(flow.sides.volume, bar.v.to_f64());
        assert_eq!(
            flow.sides.delta,
            2.0 * bar.bv.unwrap().to_f64() - bar.v.to_f64()
        );
        assert_eq!((flow.sides.delta_high, flow.sides.delta_low), (7.0, 0.0));
        assert_eq!(flow.sums.volume, 8.0);
        assert_eq!(flow.sums.pv, 20641.00 * 2.0 + 20641.25 * 5.0 + 20641.50);
        let (_, second) = &closed[1];
        assert_eq!(
            (second.sides.delta_high, second.sides.delta_low),
            (0.0, -7.0)
        );
        assert_eq!(forming.unwrap().1.sides.delta, 3.0);
    }

    #[test]
    fn range_bars_hold_their_high_and_low_within_n_ticks() {
        let prints = tape("2026-10-02T14:42:00-04:00", NQ);
        let (closed, forming) = build(PrintBars::Range { size: 2 }, &prints);
        assert_eq!(
            closed.iter().map(ohlcv).collect::<Vec<_>>(),
            vec![
                row("20641", "20641.5", "20641", "20641.25", "11", "7"),
                row("20640.75", "20641", "20640.5", "20641", "12", "8"),
            ]
        );
        assert_eq!(
            forming.map(|b| ohlcv(&b)),
            Some(row(
                "20641.75", "20641.75", "20641.75", "20641.75", "1", "1"
            ))
        );
        for b in &closed {
            assert!(b.h.0 - b.l.0 <= Decimal::new(50, 2));
        }
    }

    #[test]
    fn volume_bars_close_on_the_print_that_reaches_n() {
        let prints = tape("2026-10-02T14:42:00-04:00", NQ);
        let (closed, forming) = build(PrintBars::Volume { size: 10 }, &prints);
        assert_eq!(
            closed
                .iter()
                .map(|b| b.v.0.normalize().to_string())
                .collect::<Vec<_>>(),
            vec!["11", "10"]
        );
        assert_eq!(
            forming.map(|b| b.v.0.normalize().to_string()),
            Some("3".into())
        );
    }

    #[test]
    fn every_kind_starts_again_at_the_session_open() {
        let mut prints = tape("2026-10-02T16:59:58-04:00", &NQ[..2]);
        prints.extend(tape("2026-10-04T18:00:00-04:00", &NQ[2..4]));
        for bars in [
            PrintBars::Tick { size: 3 },
            PrintBars::Range { size: 8 },
            PrintBars::Volume { size: 100 },
            PrintBars::Delta { size: 100 },
        ] {
            let (closed, forming) = build(bars, &prints);
            assert_eq!(closed.len(), 1, "{bars:?}");
            assert_eq!(closed[0].v, Qty(Decimal::from(7)), "{bars:?}");
            assert_eq!(forming.unwrap().t, prints[2].ts, "{bars:?}");
        }
    }

    #[test]
    fn delta_bars_close_on_the_print_that_takes_net_delta_to_n_either_way() {
        let prints = tape("2026-10-02T14:42:00-04:00", NQ);
        let (closed, forming) = build(PrintBars::Delta { size: 5 }, &prints);
        assert_eq!(
            closed.iter().map(ohlcv).collect::<Vec<_>>(),
            vec![
                row("20641", "20641.25", "20641", "20641.25", "7", "7"),
                row("20641.5", "20641.5", "20640.75", "20640.75", "8", "0"),
                row("20640.5", "20640.5", "20640.5", "20640.5", "6", "6"),
            ]
        );
        assert_eq!(
            forming.map(|b| ohlcv(&b)),
            Some(row("20641", "20641.75", "20641", "20641.75", "3", "3"))
        );
        assert_eq!(closed[1].t, prints[2].ts);
    }

    #[test]
    fn delta_bars_leave_prints_without_a_side_out_of_the_delta() {
        let prints = tape(
            "2026-10-02T14:42:00-04:00",
            &[(20641.00, 4, 1), (20641.25, 9, 0), (20641.50, 1, 1)],
        );
        let (closed, forming) = build(PrintBars::Delta { size: 5 }, &prints);
        assert_eq!(
            closed.iter().map(ohlcv).collect::<Vec<_>>(),
            vec![row("20641", "20641.5", "20641", "20641.5", "14", "5")]
        );
        assert!(forming.is_none());
    }

    #[test]
    fn renko_bricks_are_n_ticks_tall_and_turn_after_two() {
        let prints = tape("2026-10-02T14:42:00-04:00", NQ);
        let (closed, forming) = build(PrintBars::Renko { size: 2 }, &prints);
        assert_eq!(
            closed.iter().map(ohlcv).collect::<Vec<_>>(),
            vec![
                row("20641", "20641.5", "20641", "20641.5", "8", "7"),
                row("20641", "20641", "20640.5", "20640.5", "13", "6"),
                row("20641", "20641.5", "20641", "20641.5", "3", "3"),
            ]
        );
        assert!(forming.is_none());
        assert_eq!(
            closed.iter().map(|b| b.t).collect::<Vec<_>>(),
            vec![prints[0].ts, prints[3].ts, prints[6].ts]
        );
        for b in &closed {
            assert_eq!((b.c.0 - b.o.0).abs(), Decimal::new(50, 2));
            assert_eq!((b.h, b.l), (b.o.max(b.c), b.o.min(b.c)));
        }
    }

    #[test]
    fn a_renko_brick_still_forming_opens_at_the_last_close() {
        let prints = tape("2026-10-02T14:42:00-04:00", &NQ[..5]);
        let (closed, forming) = build(PrintBars::Renko { size: 2 }, &prints);
        assert_eq!(closed.len(), 1);
        assert_eq!(
            forming.map(|b| ohlcv(&b)),
            Some(row("20641.5", "20641.5", "20640.75", "20640.75", "7", "0"))
        );
    }

    #[test]
    fn a_print_that_jumps_boxes_leaves_a_brick_for_each() {
        let prints = tape(
            "2026-10-02T14:42:00-04:00",
            &[(20641.00, 1, 1), (20643.00, 2, 1), (20641.75, 1, -1)],
        );
        let (closed, forming) = build(PrintBars::Renko { size: 2 }, &prints);
        assert_eq!(
            closed.iter().map(ohlcv).collect::<Vec<_>>(),
            vec![
                row("20641", "20641.5", "20641", "20641.5", "3", "3"),
                row("20641.5", "20642", "20641.5", "20642", "0", "0"),
                row("20642", "20642.5", "20642", "20642.5", "0", "0"),
                row("20642.5", "20643", "20642.5", "20643", "0", "0"),
                row("20642.5", "20642.5", "20642", "20642", "1", "0"),
            ]
        );
        assert!(forming.is_none());
        let after_jump: Vec<i64> = closed.iter().map(|b| b.t.0 - prints[1].ts.0).collect();
        assert_eq!(
            after_jump,
            vec![
                prints[0].ts.0 - prints[1].ts.0,
                0,
                NANOS_PER_MILLI,
                2 * NANOS_PER_MILLI,
                prints[2].ts.0 - prints[1].ts.0,
            ]
        );
    }

    #[test]
    fn renko_bricks_run_on_across_the_session_open() {
        let mut prints = tape(
            "2026-10-02T16:59:58-04:00",
            &[(20641.00, 2, 1), (20641.25, 5, 1)],
        );
        prints.extend(tape(
            "2026-10-04T18:00:00-04:00",
            &[(20641.50, 1, -1), (20641.25, 3, -1)],
        ));
        let (closed, forming) = build(PrintBars::Renko { size: 2 }, &prints);
        assert_eq!(
            closed.iter().map(ohlcv).collect::<Vec<_>>(),
            vec![row("20641", "20641.5", "20641", "20641.5", "8", "7")]
        );
        assert_eq!(closed[0].t, prints[0].ts);
        assert_eq!(
            forming.map(|b| ohlcv(&b)),
            Some(row("20641.5", "20641.5", "20641.25", "20641.25", "3", "0"))
        );
    }
}
