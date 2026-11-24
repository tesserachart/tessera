use std::collections::BTreeMap;

use chrono::Duration;
use rust_decimal::Decimal;
use tessera_core::session::SessionCalendar;
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_core::{Price, Timestamp};

use super::profile::{ProfileBuilder, TickRange, point_of_control, value_area_band};

pub const DEFAULT_TPO_MINUTES: u32 = 30;
pub const MAX_TPO_MINUTES: u32 = 240;
pub const INITIAL_BALANCE_MINUTES: i64 = 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TpoClock {
    pub opens: Vec<Timestamp>,
    pub balance_from: Option<Timestamp>,
}

pub fn tpo_clock(calendar: SessionCalendar, from: Timestamp, to: Timestamp, rth: bool) -> TpoClock {
    let first = calendar.trade_date(from) - Duration::days(1);
    let last = calendar.trade_date(to) + Duration::days(1);
    let mut opens = Vec::new();
    let mut balance_from = None;
    for s in calendar.sessions_between(first, last) {
        let (start, end) = match (rth, s.rth) {
            (true, Some(w)) => (w.start, w.end),
            (true, None) => continue,
            (false, _) => (s.open, s.close),
        };
        if end <= from || start >= to {
            continue;
        }
        if opens.is_empty() {
            let regular = s.rth.map_or(s.open, |w| w.start);
            balance_from = (regular >= from && regular < to).then_some(regular);
        }
        opens.push(start.max(from));
    }
    if opens.is_empty() {
        opens.push(from);
    }
    opens.sort_unstable();
    opens.dedup();
    TpoClock {
        opens,
        balance_from,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TpoBracket {
    pub start: Timestamp,
    pub letter: u32,
    pub low: i64,
    pub high: i64,
}

pub fn brackets(
    minutes: &BTreeMap<i64, TickRange>,
    clock: &TpoClock,
    bracket_minutes: u32,
) -> Vec<TpoBracket> {
    let len = i64::from(bracket_minutes.max(1)) * NANOS_PER_MINUTE;
    let mut out: Vec<TpoBracket> = Vec::new();
    for (m, r) in minutes {
        let t = m * NANOS_PER_MINUTE;
        let k = clock.opens.partition_point(|o| o.0 <= t);
        let anchor = clock.opens[k.saturating_sub(1)].0;
        let letter = (t - anchor).div_euclid(len).max(0);
        let start = Timestamp(anchor + letter * len);
        match out.last_mut() {
            Some(b) if b.start == start => {
                b.low = b.low.min(r.low);
                b.high = b.high.max(r.high);
            }
            _ => out.push(TpoBracket {
                start,
                letter: u32::try_from(letter).unwrap_or(u32::MAX),
                low: r.low,
                high: r.high,
            }),
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct TpoProfile {
    pub tick: Price,
    pub minutes: u32,
    pub brackets: Vec<TpoBracket>,
    pub poc: Option<Price>,
    pub vah: Option<Price>,
    pub val: Option<Price>,
    pub ib_from: Option<Timestamp>,
    pub ib_high: Option<Price>,
    pub ib_low: Option<Price>,
}

fn tick_price(tick: Decimal, i: i64) -> Price {
    let mut d = Decimal::from(i) * tick;
    d.rescale(tick.scale());
    Price(d)
}

fn initial_balance(
    minutes: &BTreeMap<i64, TickRange>,
    from: Option<Timestamp>,
) -> Option<TickRange> {
    let from = from?.0.div_euclid(NANOS_PER_MINUTE);
    minutes
        .range(from..from + INITIAL_BALANCE_MINUTES)
        .map(|(_, r)| *r)
        .reduce(|a, b| TickRange {
            low: a.low.min(b.low),
            high: a.high.max(b.high),
        })
}

pub fn tpo_profile(
    b: &ProfileBuilder,
    clock: &TpoClock,
    bracket_minutes: u32,
    row_ticks: u32,
    value_area: f64,
) -> TpoProfile {
    let tick = b.tick().0;
    let brackets = brackets(b.minutes(), clock, bracket_minutes);
    let ib = initial_balance(b.minutes(), clock.balance_from);
    let mut out = TpoProfile {
        tick: b.tick(),
        minutes: bracket_minutes,
        brackets,
        poc: None,
        vah: None,
        val: None,
        ib_from: ib.and(clock.balance_from),
        ib_high: ib.map(|r| tick_price(tick, r.high)),
        ib_low: ib.map(|r| tick_price(tick, r.low)),
    };
    let (Some(low), Some(high)) = (
        out.brackets.iter().map(|x| x.low).min(),
        out.brackets.iter().map(|x| x.high).max(),
    ) else {
        return out;
    };
    let n = i64::from(row_ticks.max(1));
    let (lo, hi) = (low.div_euclid(n), high.div_euclid(n));
    let mut counts = vec![Decimal::ZERO; usize::try_from(hi - lo + 1).unwrap_or(0)];
    for x in &out.brackets {
        for r in x.low.div_euclid(n)..=x.high.div_euclid(n) {
            counts[(r - lo) as usize] += Decimal::ONE;
        }
    }
    let poc = point_of_control(&counts);
    let (a, z, _) = value_area_band(&counts, poc, value_area);
    out.poc = Some(tick_price(tick, (lo + poc as i64) * n));
    out.val = Some(tick_price(tick, ((lo + a as i64) * n).max(low)));
    out.vah = Some(tick_price(tick, ((lo + z as i64 + 1) * n - 1).min(high)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::prelude::ToPrimitive;
    use std::str::FromStr;
    use tessera_core::market::{Aggressor, AggressorSource, Trade};
    use tessera_core::{InstrumentId, Qty};

    fn ts(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    fn p(s: &str) -> Price {
        Price::from_str(s).unwrap()
    }

    fn print(at: &str, price: &str) -> Trade {
        Trade {
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            ts: ts(at),
            price: p(price),
            size: Qty::from(1),
            aggressor: Aggressor::Buy,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        }
    }

    const CME: SessionCalendar = SessionCalendar::CmeEquityIndex;

    fn session_of(prints: &[(&str, &str)]) -> ProfileBuilder {
        let mut b = ProfileBuilder::new(p("0.25"));
        for (at, price) in prints {
            b.push_trade(&print(at, price));
        }
        b
    }

    #[test]
    fn brackets_count_from_each_session_open_and_cover_their_range() {
        let b = session_of(&[
            ("2026-10-06T09:30:10-04:00", "100.00"),
            ("2026-10-06T09:45:00-04:00", "101.00"),
            ("2026-10-06T10:05:00-04:00", "100.50"),
            ("2026-10-06T10:29:59-04:00", "99.75"),
            ("2026-10-06T11:10:00-04:00", "100.25"),
        ]);
        let clock = tpo_clock(
            CME,
            ts("2026-10-06T09:30:00-04:00"),
            ts("2026-10-06T16:00:00-04:00"),
            true,
        );
        assert_eq!(clock.opens, vec![ts("2026-10-06T09:30:00-04:00")]);
        let got = brackets(b.minutes(), &clock, 30);
        let tick = |s: &str| (p(s).0 * Decimal::from(4)).to_i64().unwrap();
        assert_eq!(
            got,
            vec![
                TpoBracket {
                    start: ts("2026-10-06T09:30:00-04:00"),
                    letter: 0,
                    low: tick("100.00"),
                    high: tick("101.00"),
                },
                TpoBracket {
                    start: ts("2026-10-06T10:00:00-04:00"),
                    letter: 1,
                    low: tick("99.75"),
                    high: tick("100.50"),
                },
                TpoBracket {
                    start: ts("2026-10-06T11:00:00-04:00"),
                    letter: 3,
                    low: tick("100.25"),
                    high: tick("100.25"),
                },
            ]
        );
    }

    #[test]
    fn letters_restart_at_each_session_and_survive_a_split_read() {
        let from = ts("2026-10-05T18:00:00-04:00");
        let to = ts("2026-10-07T17:00:00-04:00");
        let clock = tpo_clock(CME, from, to, false);
        assert_eq!(
            clock.opens,
            vec![from, ts("2026-10-06T18:00:00-04:00")],
            "a week reads each session from its own open"
        );
        let mut first = session_of(&[("2026-10-05T18:40:00-04:00", "100.00")]);
        let second = session_of(&[
            ("2026-10-05T18:50:00-04:00", "102.00"),
            ("2026-10-06T18:05:00-04:00", "105.00"),
        ]);
        first.merge(&second);
        let got = brackets(first.minutes(), &clock, 30);
        assert_eq!(got.len(), 2, "two pieces of one bracket are one bracket");
        assert_eq!((got[0].letter, got[0].high - got[0].low), (1, 8));
        assert_eq!(
            (got[1].start, got[1].letter),
            (ts("2026-10-06T18:00:00-04:00"), 0)
        );
    }

    #[test]
    fn the_tpo_poc_is_the_price_most_brackets_visited_and_the_ib_its_first_hour() {
        let b = session_of(&[
            ("2026-10-06T09:31:00-04:00", "100.00"),
            ("2026-10-06T09:40:00-04:00", "100.75"),
            ("2026-10-06T10:01:00-04:00", "100.25"),
            ("2026-10-06T10:20:00-04:00", "101.50"),
            ("2026-10-06T10:31:00-04:00", "100.50"),
            ("2026-10-06T10:45:00-04:00", "100.25"),
            ("2026-10-06T11:15:00-04:00", "102.00"),
        ]);
        let clock = tpo_clock(
            CME,
            ts("2026-10-05T18:00:00-04:00"),
            ts("2026-10-06T17:00:00-04:00"),
            false,
        );
        assert_eq!(clock.balance_from, Some(ts("2026-10-06T09:30:00-04:00")));
        let tpo = tpo_profile(&b, &clock, 30, 1, 0.7);
        assert_eq!(tpo.brackets.len(), 4);
        assert_eq!(tpo.poc, Some(p("100.50")));
        assert_eq!(
            (tpo.ib_low, tpo.ib_high),
            (Some(p("100.00")), Some(p("101.50")))
        );
        let (val, vah) = (tpo.val.unwrap(), tpo.vah.unwrap());
        assert!(val <= p("100.25") && vah >= p("100.75"), "{val} {vah}");
        assert!(val >= p("100.00") && vah <= p("102.00"));
    }

    #[test]
    fn coarse_rows_keep_the_value_area_inside_the_traded_range() {
        let b = session_of(&[
            ("2026-10-06T09:31:00-04:00", "100.25"),
            ("2026-10-06T10:01:00-04:00", "100.50"),
        ]);
        let clock = tpo_clock(
            CME,
            ts("2026-10-06T09:30:00-04:00"),
            ts("2026-10-06T16:00:00-04:00"),
            true,
        );
        let tpo = tpo_profile(&b, &clock, 30, 4, 0.7);
        assert_eq!(tpo.poc, Some(p("100.00")));
        assert_eq!((tpo.val, tpo.vah), (Some(p("100.25")), Some(p("100.50"))));
    }

    #[test]
    fn no_prints_draw_no_profile() {
        let empty = ProfileBuilder::new(p("0.25"));
        let clock = tpo_clock(
            CME,
            ts("2026-10-06T09:30:00-04:00"),
            ts("2026-10-06T16:00:00-04:00"),
            true,
        );
        let tpo = tpo_profile(&empty, &clock, 30, 1, 0.7);
        assert!(tpo.brackets.is_empty() && tpo.poc.is_none() && tpo.ib_high.is_none());
    }
}
