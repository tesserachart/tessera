use super::*;
use std::str::FromStr;
use tessera_core::InstrumentId;
use tessera_core::market::AggressorSource;
use tessera_core::time::NANOS_PER_SEC;

use Aggressor::{Buy, Sell, Unknown};

fn price(p: &str) -> Price {
    Price::from_str(p).unwrap()
}

fn print(t: i64, p: &str, size: i64, side: Aggressor) -> Trade {
    Trade {
        instrument: InstrumentId::new("ESZ6.CME").unwrap(),
        ts: Timestamp(t),
        price: price(p),
        size: Qty::from(size),
        aggressor: side,
        aggressor_source: AggressorSource::Exchange,
        order_key: None,
        source: None,
    }
}

fn grouped(prints: &[Trade], tick: &str, grouping: Grouping) -> Vec<AggressorOrder> {
    let mut a = OrderAggregator::new(price(tick), grouping);
    let mut out: Vec<AggressorOrder> = prints.iter().filter_map(|t| a.push(t)).collect();
    out.extend(a.finish());
    out
}

const EVERY_GROUPING: [Grouping; 4] = [
    Grouping {
        join_orders: true,
        reach_limit: true,
    },
    Grouping {
        join_orders: false,
        reach_limit: true,
    },
    Grouping {
        join_orders: true,
        reach_limit: false,
    },
    Grouping {
        join_orders: false,
        reach_limit: false,
    },
];

const MS: i64 = NANOS_PER_MILLI;
const S: i64 = NANOS_PER_SEC;

#[test]
fn the_shared_aggregation_fixture_under_every_grouping() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/orderflow/aggregate.json"
    ))
    .unwrap();
    let num = |v: &serde_json::Value| v.as_f64().unwrap();
    let mut checked = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let tick = case["tick"].to_string();
        let prints: Vec<Trade> = case["prints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| Trade {
                order_key: p.get(4).map(|o| o.as_u64().unwrap() as u32),
                ..print(
                    p[0].as_i64().unwrap(),
                    &p[1].to_string(),
                    p[2].as_i64().unwrap(),
                    Aggressor::from_sign(p[3].as_i64().unwrap() as i8),
                )
            })
            .collect();
        let mut groupings = vec![(Grouping::default(), &case["events"])];
        for s in case["settings"].as_array().into_iter().flatten() {
            let on = |key: &str| s[key].as_bool().unwrap();
            let grouping = Grouping {
                join_orders: on("joinOrders"),
                reach_limit: on("reachLimit"),
            };
            groupings.push((grouping, &s["events"]));
        }
        for (grouping, want) in groupings {
            let got: Vec<Vec<f64>> = grouped(&prints, &tick, grouping)
                .iter()
                .map(|o| {
                    vec![
                        o.t.0 as f64,
                        o.average_price().to_f64(),
                        o.size.to_f64(),
                        f64::from(o.aggressor.sign()),
                        f64::from(o.prints),
                        f64::from(o.levels),
                        f64::from(o.orders),
                    ]
                })
                .collect();
            let want: Vec<Vec<f64>> = want
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_array().unwrap().iter().map(num).collect())
                .collect();
            assert_eq!(got.len(), want.len(), "{name} {grouping:?}: {got:?}");
            for (g, w) in got.iter().zip(&want) {
                let same = g.iter().zip(w).all(|(a, b)| (a - b).abs() < 1e-9);
                assert!(same, "{name} {grouping:?}: {g:?} vs {w:?}");
            }
            checked.push(grouping);
        }
    }
    for g in EVERY_GROUPING {
        assert!(checked.contains(&g), "the fixture checks {g:?}");
    }
}

#[test]
fn the_chain_joins_within_5_ms_and_breaks_on_a_gap_a_retreat_or_the_other_side() {
    for grouping in EVERY_GROUPING {
        let prints_per_event = |tape: &[Trade]| -> Vec<u32> {
            grouped(tape, "0.25", grouping)
                .iter()
                .map(|o| o.prints)
                .collect()
        };
        let chain = [
            print(S, "5000", 1, Buy),
            print(S + 5 * MS, "5000.25", 1, Buy),
            print(S + 10 * MS, "5000.50", 1, Buy),
        ];
        assert_eq!(prints_per_event(&chain), [3], "a 5 ms chain, {grouping:?}");
        let gap = [print(S, "5000", 1, Buy), print(S + 6 * MS, "5000", 1, Buy)];
        assert_eq!(prints_per_event(&gap), [1, 1], "a 6 ms gap, {grouping:?}");
        let retreat = [print(S, "5000", 1, Buy), print(S + MS, "4999.75", 1, Buy)];
        assert_eq!(
            prints_per_event(&retreat),
            [1, 1],
            "a retreat, {grouping:?}"
        );
        let flip = [print(S, "5000", 1, Buy), print(S + MS, "5000", 1, Sell)];
        assert_eq!(
            prints_per_event(&flip),
            [1, 1],
            "the other side, {grouping:?}"
        );
    }
}

#[test]
fn reach_limit_on_stops_a_print_three_ticks_past_the_extreme_and_off_lets_a_sweep_walk() {
    let sweep: Vec<Trade> = (0..10)
        .map(|k| Trade {
            price: Price(price("5000").0 + Decimal::new(75, 2) * Decimal::from(k)),
            ..print(S + k * MS, "5000", 1, Buy)
        })
        .collect();
    for join_orders in [true, false] {
        let on = grouped(
            &sweep,
            "0.25",
            Grouping {
                join_orders,
                reach_limit: true,
            },
        );
        assert_eq!(on.len(), 10, "each print three ticks on starts a trade");
        let off = grouped(
            &sweep,
            "0.25",
            Grouping {
                join_orders,
                reach_limit: false,
            },
        );
        assert_eq!(
            off.iter()
                .map(|o| (o.size, o.levels, o.range_ticks(price("0.25"))))
                .collect::<Vec<_>>(),
            [(Qty::from(10), 10, 27)],
            "one sweep through ten levels"
        );
    }
}

#[test]
fn join_orders_on_joins_an_orders_fills_after_a_gap_and_off_does_not() {
    let fill = |t: i64| Trade {
        order_key: Some(7),
        ..print(t, "4999", 2, Sell)
    };
    let fills = [fill(S), fill(S + 50 * MS)];
    for reach_limit in [true, false] {
        let on = grouped(
            &fills,
            "0.25",
            Grouping {
                join_orders: true,
                reach_limit,
            },
        );
        assert_eq!(
            on.iter().map(|o| (o.size, o.prints)).collect::<Vec<_>>(),
            [(Qty::from(4), 2)],
            "one order's fills 50 ms apart"
        );
        let off = grouped(
            &fills,
            "0.25",
            Grouping {
                join_orders: false,
                reach_limit,
            },
        );
        assert_eq!(off.len(), 2, "50 ms is past the chain");
    }
}

#[test]
fn an_open_event_closes_once_nothing_can_continue_it() {
    let mut a = OrderAggregator::new(price("0.25"), Grouping::default());
    assert!(a.push(&print(S, "5000", 3, Buy)).is_none());
    assert!(
        a.close_before(Timestamp(S + 5 * MS)).is_none(),
        "still in the window"
    );
    let o = a.close_before(Timestamp(S + 5 * MS + 1)).expect("closed");
    assert_eq!((o.size, o.range_ticks(price("0.25"))), (Qty::from(3), 0));
    assert!(a.open().is_none());
}

fn new_york(date: NaiveDate, h: u32, m: u32) -> Timestamp {
    tessera_core::time::local_to_timestamp(chrono_tz::Tz::America__New_York, date, h, m)
}

fn day(d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, d).unwrap()
}

fn sizing() -> Contract {
    Contract {
        floor: Qty::from(2),
        min_notional: 0.0,
        ..es()
    }
}

fn one_a_minute(b: &mut ModelBuilder, from: Timestamp, sizes: impl IntoIterator<Item = i64>) {
    for (m, size) in sizes.into_iter().enumerate() {
        let t = from.0 + m as i64 * 60 * S;
        b.add(&AggressorOrder::start(&print(t, "5000", size, Buy)));
    }
}

fn model_of(minutes: i64, sizes: impl Fn(i64) -> i64) -> BigTradeModel {
    let mut b = ModelBuilder::new(SessionCalendar::CmeEquityIndex, sizing());
    one_a_minute(&mut b, new_york(day(4), 18, 0), (0..minutes).map(sizes));
    b.build(day(12), ModelCoverage::default())
}

fn session_minutes(calendar: SessionCalendar, date: NaiveDate) -> i64 {
    calendar.session(date).expect("a session").minute_count()
}

fn cut(low: i64, medium: i64, high: i64) -> Option<BigTradeCuts> {
    Some(BigTradeCuts {
        low: Qty::from(low),
        medium: Qty::from(medium),
        high: Qty::from(high),
    })
}

#[test]
fn the_cuts_are_the_120th_45th_and_15th_largest_event_of_a_whole_session() {
    let whole = session_minutes(SessionCalendar::CmeEquityIndex, day(5));
    assert_eq!(whole, 23 * 60, "CME Globex trades 23 hours a day");
    let m = model_of(whole, |k| k + 1);
    assert_eq!(i64::from(m.minutes), whole);
    assert_eq!(
        m.cuts,
        cut(1261, 1336, 1366),
        "sizes 1..=1380, one a minute"
    );
    assert!(m.sized());
    assert_eq!(
        [
            Qty::from(1260),
            Qty::from(1261),
            Qty::from(1336),
            Qty::from(1366)
        ]
        .map(|s| m.tier(s)),
        [
            None,
            Some(BigTradeTier::Low),
            Some(BigTradeTier::Medium),
            Some(BigTradeTier::High)
        ]
    );
}

#[test]
fn the_counts_scale_by_the_minutes_that_held_an_event() {
    assert_eq!(
        model_of(690, |k| k + 1).cuts,
        cut(631, 668, 683),
        "half a session: ranks 60, 23 and 8"
    );
    let mut b = ModelBuilder::new(SessionCalendar::CmeEquityIndex, sizing());
    let from = new_york(day(4), 18, 0);
    for k in 0..690 {
        let t = from.0 + k * 60 * S;
        for (i, side) in [Buy, Sell, Unknown].into_iter().enumerate() {
            b.add(&AggressorOrder::start(&print(
                t + i as i64 * S,
                "5000",
                k + 1,
                side,
            )));
        }
    }
    let m = b.build(day(12), ModelCoverage::default());
    assert_eq!(
        (m.minutes, m.orders(), m.sessions),
        (690, 2 * 690, 1),
        "a minute counts once however many events it holds, and an event without a side not at all"
    );
    assert_eq!(
        m.cuts,
        cut(661, 679, 687),
        "two events a minute: ranks 60, 23 and 8 of the pairs"
    );
}

#[test]
fn under_sixty_minutes_of_events_the_model_is_still_sizing_and_the_floors_decide() {
    let m = model_of(59, |k| k + 1);
    assert_eq!((m.cuts.clone(), m.sized()), (None, false));
    assert_eq!(m.tier(Qty::from(500)), None);
    assert_eq!(m.size_at(BigTradeTier::Low, 20_000.0, 1.0), 2.0);
    assert_eq!(
        m.size_at(BigTradeTier::Low, 1_000.0, 1.0),
        10.0,
        "$500k at 1000 × 50"
    );
    assert_eq!(
        (floor_of(Some("ES")), floor_of(Some("NQ")), floor_of(None)),
        (Qty::from(20), Qty::from(8), Qty::from(1))
    );
    assert_eq!(
        model_of(60, |k| k + 1).cuts,
        cut(56, 59, 60),
        "sixty minutes: ranks 5, 2 and 1"
    );
}

#[test]
fn the_tiers_climb_by_a_lot_at_least_and_the_ranks_stop_at_the_events_there_are() {
    assert_eq!(model_of(1380, |_| 10).cuts, cut(10, 11, 12));
    let m = model_of(120, |k| match k {
        0 => 50,
        1 => 40,
        2 => 30,
        _ => 1,
    });
    assert_eq!(
        m.cuts,
        cut(30, 31, 50),
        "three events over the floor: Low and Medium stop at the third"
    );
    assert_eq!(m.size_at(BigTradeTier::Medium, 5000.0, 1.0), 31.0);
    assert_eq!(
        model_of(120, |_| 1).cuts,
        cut(2, 3, 4),
        "with none over the floor the cuts start at the floor"
    );
}

#[test]
fn a_model_counts_the_sessions_it_read() {
    let mut b = ModelBuilder::new(SessionCalendar::CmeEquityIndex, sizing());
    for d in [5, 6, 7, 8, 9] {
        one_a_minute(&mut b, new_york(day(d), 10, 0), [5, 9]);
    }
    let m = b.build(day(12), ModelCoverage::default());
    assert_eq!((m.sessions, m.orders(), m.minutes), (5, 10, 10));
    assert_eq!(m.cuts, None, "ten minutes is still sizing");
}

fn es() -> Contract {
    Contract {
        tick: price("0.25"),
        lot: 1.0,
        floor: Qty::from(20),
        multiplier: 50.0,
        min_notional: MIN_NOTIONAL,
    }
}

fn bigs_of(prints: &[Trade]) -> Vec<BigTrade> {
    let mut j = EventCloser::new(es(), Grouping::default());
    let mut out = Closed::default();
    for (i, t) in prints.iter().enumerate() {
        j.push(t, Some(i as u64 + 1), &mut out);
    }
    j.finish(&mut out);
    let c = es();
    out.big
        .iter()
        .map(|(o, seq)| to_wire(o, *seq, &c, None))
        .collect()
}

#[test]
fn an_event_carries_what_it_printed() {
    let got = bigs_of(&[
        print(S, "5000.00", 10, Buy),
        print(S, "5000.25", 15, Buy),
        print(S, "5000.75", 5, Buy),
        print(2 * S, "5001.00", 1, Buy),
    ]);
    assert_eq!(got.len(), 1, "only the 30 lots pass the floor");
    let t = &got[0];
    assert_eq!((t.levels, t.range_ticks, t.seq), (3, 3, Some(1)));
    assert_eq!((t.prints, t.orders, t.size), (3, 1, Qty::from(30)));
    assert_eq!(t.tier, None);
    let wire = serde_json::to_value(t).unwrap();
    assert!(wire.get("class").is_none() && wire.get("settled").is_none());
}

#[test]
fn an_event_is_final_once_it_closes() {
    let mut j = EventCloser::new(es(), Grouping::default());
    let mut out = Closed::default();
    j.push(&print(S, "5000.25", 40, Sell), Some(7), &mut out);
    assert!(out.big.is_empty(), "still open");
    j.advance(Timestamp(S + 5 * MS), &mut out);
    assert!(out.big.is_empty(), "another order could still continue it");
    j.advance(Timestamp(S + 5 * MS + 1), &mut out);
    assert_eq!(
        out.big.len(),
        1,
        "passed on as it closes, not after a watch"
    );
    assert_eq!(out.big[0].1, Some(7));
    assert_eq!(out.events.len(), 1);
}

#[test]
fn small_events_and_events_without_a_side_are_never_big() {
    let got = bigs_of(&[
        print(S, "5000.25", 19, Buy),
        print(2 * S, "5000.25", 300, Unknown),
        print(3 * S, "5000.25", 20, Sell),
    ]);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].size, Qty::from(20));
    let mut j = EventCloser::new(
        Contract {
            multiplier: 1.0,
            ..es()
        },
        Grouping::default(),
    );
    let mut out = Closed::default();
    j.push(&print(S, "10", 20, Buy), None, &mut out);
    j.finish(&mut out);
    assert!(out.big.is_empty() && out.events.len() == 1);
}

fn tiered(size: i64, tier: Option<BigTradeTier>) -> BigTrade {
    BigTrade {
        tier,
        ..bigs_of(&[print(S, "5000.25", size, Buy)]).remove(0)
    }
}

#[test]
fn each_mode_shows_its_own_trades() {
    use BigTradeTier::{High, Low, Medium};
    let events = [
        tiered(20, None),
        tiered(30, Some(Low)),
        tiered(60, Some(Medium)),
        tiered(400, Some(High)),
    ];
    let shown = |f: &BigFilter| -> Vec<i64> {
        events
            .iter()
            .filter(|t| f.admits(t))
            .map(|t| t.size.to_f64() as i64)
            .collect()
    };
    let auto = |tiers: &[BigTradeTier]| BigFilter::Auto(tiers.to_vec());
    assert_eq!(shown(&auto(&[High, Medium, Low])), [30, 60, 400]);
    assert_eq!(shown(&auto(&[High])), [400]);
    assert_eq!(shown(&auto(&[Medium, Low])), [30, 60]);
    assert_eq!(
        shown(&auto(&[Low])),
        [30],
        "an event with no tier never shows in Auto"
    );
    let manual = |min: i64, max: Option<i64>| BigFilter::Manual {
        min: Qty::from(min),
        max: max.map(Qty::from),
    };
    assert_eq!(shown(&manual(25, None)), [30, 60, 400]);
    assert_eq!(shown(&manual(20, Some(60))), [20, 30, 60]);
    assert_eq!(
        (
            manual_min_of(floor_of(Some("ES"))),
            manual_min_of(floor_of(Some("NQ"))),
            manual_min_of(floor_of(None))
        ),
        (Qty::from(30), Qty::from(12), Qty::from(2))
    );
}

#[test]
fn the_shared_outcome_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/orderflow/outcome.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let tick = price(&case["tick"].to_string());
        let reach = case["reachTicks"].as_u64().unwrap() as u32;
        let prints: Vec<Trade> = case["prints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                print(
                    p[0].as_i64().unwrap(),
                    &p[1].to_string(),
                    p[2].as_i64().unwrap(),
                    Aggressor::from_sign(p[3].as_i64().unwrap() as i8),
                )
            })
            .collect();
        let every = Contract {
            tick,
            floor: Qty::ZERO,
            min_notional: 0.0,
            ..es()
        };
        let mut j = EventCloser::new(every, Grouping::default());
        let mut out = Closed::default();
        let mut events: Vec<(AggressorOrder, Option<BigTradeOutcome>)> = Vec::new();
        let mut watching: Vec<(usize, OutcomeWatch)> = Vec::new();
        let watch = |out: &mut Closed,
                     events: &mut Vec<(AggressorOrder, Option<BigTradeOutcome>)>,
                     watching: &mut Vec<(usize, OutcomeWatch)>| {
            for (o, _) in out.big.drain(..) {
                watching.push((events.len(), OutcomeWatch::new(&o, tick, reach).unwrap()));
                events.push((o, None));
            }
        };
        for p in &prints {
            j.push(p, None, &mut out);
            watch(&mut out, &mut events, &mut watching);
            watching.retain(|(k, w)| match w.on_print(p) {
                Some(o) => {
                    events[*k].1 = Some(o);
                    false
                }
                None => true,
            });
        }
        j.finish(&mut out);
        watch(&mut out, &mut events, &mut watching);
        let got: Vec<serde_json::Value> = events
            .iter()
            .map(|(o, outcome)| {
                serde_json::json!([
                    o.t.0,
                    o.aggressor.sign(),
                    o.size.to_f64() as i64,
                    outcome.map(|x| x.kind),
                    outcome.map(|x| x.decided.0)
                ])
            })
            .collect();
        assert_eq!(&got, case["outcomes"].as_array().unwrap(), "{name}");
        assert!(
            events
                .iter()
                .filter_map(|(_, o)| *o)
                .all(|o| o.reach_ticks == reach),
            "{name}"
        );
    }
}

#[test]
fn neither_waits_for_the_read_to_pass_60_seconds_after_the_last_print() {
    let o = AggressorOrder::start(&print(S, "5000", 30, Buy));
    let w = OutcomeWatch::new(&o, price("0.25"), 2).unwrap();
    assert_eq!(w.at_end(Timestamp(61 * S)), None, "the read ends at 60 s");
    assert_eq!(
        w.at_end(Timestamp(61 * S + 1)),
        Some(BigTradeOutcome {
            kind: BigTradeOutcomeKind::Neither,
            decided: Timestamp(61 * S),
            reach_ticks: 2
        })
    );
    let unknown = AggressorOrder::start(&print(S, "5000", 30, Unknown));
    assert_eq!(OutcomeWatch::new(&unknown, price("0.25"), 2), None);
}

#[test]
fn the_reach_is_half_the_median_minute_range_of_its_half_hour_of_the_session_and_at_least_two() {
    let mut b = ModelBuilder::new(SessionCalendar::CmeEquityIndex, sizing());
    let mut range = |from: Timestamp, ticks: &[i64]| {
        for (m, t) in ticks.iter().enumerate() {
            let at = from.0 + m as i64 * 60 * S;
            let high = Decimal::from(5000) + Decimal::new(25, 2) * Decimal::from(*t);
            b.add_print(&print(at, "5000", 1, Buy));
            b.add_print(&Trade {
                price: Price(high),
                ..print(at + S, "5000", 1, Sell)
            });
        }
    };
    range(new_york(day(5), 3, 0), &[1]);
    range(new_york(day(5), 10, 0), &[4, 12, 8]);
    let m = b.build(day(6), ModelCoverage::default());
    assert_eq!(m.reach_ticks.len(), 46, "the Globex session's 23 hours");
    assert_eq!(m.reach_from(), Some(new_york(day(5), 18, 0)));
    assert_eq!(
        [
            m.reach_at(new_york(day(6), 10, 29)),
            m.reach_at(new_york(day(6), 3, 15)),
            m.reach_at(new_york(day(6), 13, 0))
        ],
        [4, 2, 4],
        "10:00 has 4, 8 and 12 ticks; 03:00 one tick, so the least; 13:00 none, so the day's 8"
    );
    let empty = ModelBuilder::new(SessionCalendar::CmeEquityIndex, sizing())
        .build(day(6), ModelCoverage::default());
    assert!(empty.reach_ticks.is_empty());
    assert_eq!(empty.reach_at(new_york(day(6), 10, 0)), MIN_REACH_TICKS);
}

#[test]
fn a_session_on_another_calendar_sizes_and_reaches_by_its_own_hours() {
    let calendar = SessionCalendar::Crypto24x7;
    let utc = |d: u32, h: u32, m: u32| {
        tessera_core::time::local_to_timestamp(chrono_tz::Tz::UTC, day(d), h, m)
    };
    let whole = session_minutes(calendar, day(5));
    assert_eq!(whole, 24 * 60);
    let mut b = ModelBuilder::new(calendar, sizing());
    one_a_minute(&mut b, utc(5, 0, 0), (0..whole).map(|k| k + 1));
    for (m, ticks) in [(0, 6), (1, 10), (2, 2), (60, 20), (61, 20), (62, 20)] {
        let at = utc(5, 0, 0).0 + m * 60 * S;
        b.add_print(&print(at, "5000", 1, Buy));
        b.add_print(&Trade {
            price: Price(Decimal::from(5000) + Decimal::new(25, 2) * Decimal::from(ticks)),
            ..print(at + S, "5000", 1, Sell)
        });
    }
    let m = b.build(day(6), ModelCoverage::default());
    assert_eq!(
        m.cuts,
        cut(1321, 1396, 1426),
        "sizes 1..=1440 over a 24-hour session: the 120th, 45th and 15th largest"
    );
    assert_eq!(m.reach_ticks.len(), 48, "a UTC day in half hours");
    assert_eq!(m.reach_from(), Some(utc(6, 0, 0)));
    assert_eq!(
        [
            m.reach_at(utc(6, 0, 20)),
            m.reach_at(utc(6, 1, 10)),
            m.reach_at(utc(6, 0, 40))
        ],
        [3, 10, 10],
        "half hours count from 00:00 UTC, the session's open: 00:00 has 2, 6 and 10 ticks, 01:00 three of 20, 00:30 none, so the session's 20"
    );
}
