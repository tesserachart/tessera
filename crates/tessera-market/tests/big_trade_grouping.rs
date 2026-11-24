use std::str::FromStr;

use tessera_core::market::{Aggressor, AggressorSource, Trade};
use tessera_core::time::{NANOS_PER_MILLI, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};
use tessera_market::orderflow::big_trades::{AggressorOrder, Grouping, OrderAggregator};

use Aggressor::{Buy, Sell, Unknown};

const S: i64 = NANOS_PER_SEC;
const MS: i64 = NANOS_PER_MILLI;

fn price(p: &str) -> Price {
    Price::from_str(p).unwrap()
}

fn print(t: i64, p: &str, size: i64, side: Aggressor, key: Option<u32>) -> Trade {
    Trade {
        instrument: InstrumentId::new("ESZ6.CME").unwrap(),
        ts: Timestamp(t),
        price: price(p),
        size: Qty::from(size),
        aggressor: side,
        aggressor_source: AggressorSource::Exchange,
        order_key: key,
        source: None,
    }
}

#[derive(Debug, PartialEq)]
struct Event {
    t: i64,
    last_t: i64,
    side: Aggressor,
    size: Qty,
    prints: u32,
    orders: u32,
    levels: u32,
    first: Price,
    last: Price,
    average: Price,
}

#[allow(clippy::too_many_arguments)]
fn event(
    t: i64,
    last_t: i64,
    side: Aggressor,
    size: i64,
    prints: u32,
    orders: u32,
    levels: u32,
    first: &str,
    last: &str,
    average: &str,
) -> Event {
    Event {
        t,
        last_t,
        side,
        size: Qty::from(size),
        prints,
        orders,
        levels,
        first: price(first),
        last: price(last),
        average: price(average),
    }
}

fn seen(o: &AggressorOrder) -> Event {
    Event {
        t: o.t.0,
        last_t: o.last_t.0,
        side: o.aggressor,
        size: o.size,
        prints: o.prints,
        orders: o.orders,
        levels: o.levels,
        first: o.first,
        last: o.last,
        average: Price(o.average_price().0.normalize()),
    }
}

fn tape() -> Vec<Trade> {
    vec![
        print(S, "5000.00", 2, Buy, None),
        print(S + 4 * MS, "5000.25", 1, Buy, None),
        print(S + 8 * MS, "5000.50", 1, Buy, None),
        print(S + 14 * MS, "5000.50", 3, Buy, None),
        print(2 * S, "4999.00", 5, Sell, Some(7)),
        print(2 * S + 50 * MS, "4999.25", 3, Sell, Some(7)),
        print(3 * S, "5001.00", 1, Buy, None),
        print(3 * S + MS, "5001.50", 1, Buy, None),
        print(3 * S + 2 * MS, "5002.25", 2, Buy, None),
        print(4 * S, "5003.00", 2, Buy, None),
        print(4 * S + MS, "5002.75", 2, Buy, None),
        print(5 * S, "5004.00", 6, Unknown, None),
        print(5 * S, "5004.00", 2, Unknown, None),
        print(5 * S, "5004.25", 1, Unknown, None),
        print(5 * S + MS, "5004.25", 1, Unknown, None),
        print(6 * S, "4990.00", 2, Sell, None),
        print(6 * S, "4989.50", 2, Sell, Some(12)),
        print(6 * S, "4989.50", 4, Sell, Some(13)),
        print(6 * S, "4989.50", 1, Buy, None),
    ]
}

fn grouped(grouping: Grouping) -> Vec<Event> {
    let mut agg = OrderAggregator::new(price("0.25"), grouping);
    let mut got: Vec<Event> = tape()
        .iter()
        .filter_map(|t| agg.push(t))
        .map(|o| seen(&o))
        .collect();
    got.extend(agg.finish().map(|o| seen(&o)));
    got
}

#[test]
fn prints_group_into_events_by_order_side_time_and_reach() {
    let got = grouped(Grouping::default());
    let want = vec![
        event(
            S,
            S + 8 * MS,
            Buy,
            4,
            3,
            3,
            3,
            "5000.00",
            "5000.50",
            "5000.1875",
        ),
        event(
            S + 14 * MS,
            S + 14 * MS,
            Buy,
            3,
            1,
            1,
            1,
            "5000.50",
            "5000.50",
            "5000.5",
        ),
        event(
            2 * S,
            2 * S + 50 * MS,
            Sell,
            8,
            2,
            1,
            2,
            "4999.00",
            "4999.25",
            "4999.09375",
        ),
        event(
            3 * S,
            3 * S + MS,
            Buy,
            2,
            2,
            2,
            2,
            "5001.00",
            "5001.50",
            "5001.25",
        ),
        event(
            3 * S + 2 * MS,
            3 * S + 2 * MS,
            Buy,
            2,
            1,
            1,
            1,
            "5002.25",
            "5002.25",
            "5002.25",
        ),
        event(4 * S, 4 * S, Buy, 2, 1, 1, 1, "5003.00", "5003.00", "5003"),
        event(
            4 * S + MS,
            4 * S + MS,
            Buy,
            2,
            1,
            1,
            1,
            "5002.75",
            "5002.75",
            "5002.75",
        ),
        event(
            5 * S,
            5 * S,
            Unknown,
            8,
            2,
            1,
            1,
            "5004.00",
            "5004.00",
            "5004",
        ),
        event(
            5 * S,
            5 * S,
            Unknown,
            1,
            1,
            1,
            1,
            "5004.25",
            "5004.25",
            "5004.25",
        ),
        event(
            5 * S + MS,
            5 * S + MS,
            Unknown,
            1,
            1,
            1,
            1,
            "5004.25",
            "5004.25",
            "5004.25",
        ),
        event(
            6 * S,
            6 * S,
            Sell,
            8,
            3,
            2,
            2,
            "4990.00",
            "4989.50",
            "4989.625",
        ),
        event(
            6 * S,
            6 * S,
            Buy,
            1,
            1,
            1,
            1,
            "4989.50",
            "4989.50",
            "4989.5",
        ),
    ];
    assert_eq!(got, want);
}

#[test]
fn with_both_settings_off_prints_join_by_the_chain_alone_however_far_a_sweep_walks() {
    let chain_only = Grouping {
        join_orders: false,
        reach_limit: false,
    };
    let unchanged = |t: i64| grouped(Grouping::default()).into_iter().find(|e| e.t == t);
    let want = [
        unchanged(S).unwrap(),
        unchanged(S + 14 * MS).unwrap(),
        event(2 * S, 2 * S, Sell, 5, 1, 1, 1, "4999.00", "4999.00", "4999"),
        event(
            2 * S + 50 * MS,
            2 * S + 50 * MS,
            Sell,
            3,
            1,
            1,
            1,
            "4999.25",
            "4999.25",
            "4999.25",
        ),
        event(
            3 * S,
            3 * S + 2 * MS,
            Buy,
            4,
            3,
            3,
            3,
            "5001.00",
            "5002.25",
            "5001.75",
        ),
        unchanged(4 * S).unwrap(),
        unchanged(4 * S + MS).unwrap(),
    ];
    let got = grouped(chain_only);
    assert_eq!(
        got[..want.len()],
        want[..],
        "one order's fills 50 ms apart are two trades, and a sweep walks past two ticks"
    );
    assert_eq!(
        got[want.len()..],
        grouped(Grouping::default())[want.len()..],
        "the rest group as before: no side, one time, a sell the same order continued"
    );
}
