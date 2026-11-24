use std::str::FromStr;

use rust_decimal::Decimal;
use tessera_core::accounts::Environment;
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::orders::{
    Bracket, Order, OrderRequest, OrderRole, OrderStatus, OrderType, Side, TimeInForce,
};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};

use super::*;

fn p(s: &str) -> Price {
    Price(Decimal::from_str(s).unwrap())
}

fn d(n: i64) -> Decimal {
    Decimal::from(n)
}

fn base(id: &str, side: Side, qty: i64, order_type: OrderType, at: i64) -> Order {
    Order {
        id: OrderId::new(id),
        broker_order_id: Some(id.to_owned()),
        draft_id: None,
        request: OrderRequest {
            account_id: AccountId::new("paper-main"),
            instrument: InstrumentId::new("MNQZ6.CME").unwrap(),
            side,
            qty: Qty::from(qty),
            order_type,
            limit_price: None,
            stop_price: None,
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only: false,
        },
        role: OrderRole::Entry,
        parent_id: None,
        status: OrderStatus::Working,
        filled_qty: Qty::ZERO,
        avg_fill_price: None,
        queue_ahead: None,
        stop_rules: None,
        triggered_at: None,
        environment: Environment::Paper,
        reason: None,
        created_at: Timestamp(at),
        updated_at: Timestamp(at),
    }
}

fn entry(id: &str, side: Side, qty: i64, filled: i64, at: i64) -> Order {
    let mut o = base(id, side, qty, OrderType::Market, at);
    o.filled_qty = Qty::from(filled);
    o.status = if filled == qty {
        OrderStatus::Filled
    } else {
        OrderStatus::Working
    };
    o
}

fn resting(id: &str, side: Side, qty: i64, price: &str, at: i64) -> Order {
    let mut o = base(id, side, qty, OrderType::Limit, at);
    o.request.limit_price = Some(p(price));
    o
}

fn leg(parent: &Order, role: OrderRole, qty: i64, price: &str) -> Order {
    let suffix = if role == OrderRole::StopLoss {
        "sl"
    } else {
        "tp"
    };
    let (order_type, stop, limit) = if role == OrderRole::StopLoss {
        (OrderType::Stop, Some(p(price)), None)
    } else {
        (OrderType::Limit, None, Some(p(price)))
    };
    let mut o = base(
        &format!("{}-{suffix}", parent.id),
        parent.request.side.opposite(),
        qty,
        order_type,
        parent.created_at.0,
    );
    o.request.stop_price = stop;
    o.request.limit_price = limit;
    o.request.reduce_only = true;
    o.role = role;
    o.parent_id = Some(parent.id.clone());
    o.status = if parent.filled_qty.is_zero() {
        OrderStatus::Held
    } else {
        OrderStatus::Working
    };
    o
}

fn pair(parent: &Order, qty: i64, stop: &str, target: &str) -> [Order; 2] {
    [
        leg(parent, OrderRole::StopLoss, qty, stop),
        leg(parent, OrderRole::TakeProfit, qty, target),
    ]
}

fn state<'a>(mode: ProtectionMode, position: i64, orders: &'a [Order]) -> State<'a> {
    State {
        mode,
        position: d(position),
        reading: Reading::Current,
        orders,
        changing: &[],
        intents: &[],
    }
}

fn id(s: &str) -> OrderId {
    OrderId::new(s)
}

fn resize(order: &str, role: OrderRole, from: i64, to: i64, why: Why) -> Step {
    Step::Resize {
        order: id(order),
        role,
        from: Qty::from(from),
        to: Qty::from(to),
        qty: Qty::from(to),
        why,
    }
}

fn cancel(order: &str, role: OrderRole, why: Why) -> Step {
    Step::Cancel {
        order: id(order),
        role,
        why,
    }
}

const SL: OrderRole = OrderRole::StopLoss;
const TP: OrderRole = OrderRole::TakeProfit;
const GROW: ProtectionMode = ProtectionMode::Grow;
const EACH: ProtectionMode = ProtectionMode::PerEntry;

fn protecting(e: &str) -> Memory {
    Memory {
        side: Some(Side::Buy),
        protection: Some(id(e)),
        legacy: BTreeSet::new(),
    }
}

#[test]
fn the_first_pair_is_the_protection_and_an_add_grows_it_at_its_prices() {
    let e1 = entry("e1", Side::Buy, 13, 13, 1);
    let mut orders = vec![e1.clone()];
    orders.extend(pair(&e1, 13, "20544.75", "20806.00"));
    let first = plan(&state(GROW, 13, &orders), &Memory::default());
    assert!(first.steps.is_empty());
    assert_eq!(first.memory, protecting("e1"));
    orders.push(entry("e2", Side::Buy, 13, 13, 2));
    let next = plan(&state(GROW, 26, &orders), &first.memory);
    assert_eq!(
        next.steps,
        [
            resize("e1-sl", SL, 13, 26, Why::Grew),
            resize("e1-tp", TP, 13, 26, Why::Grew)
        ]
    );
    assert_eq!(next.memory, protecting("e1"));
    assert_eq!(
        plan(&state(GROW, 26, &orders), &next.memory).steps,
        next.steps
    );
}

#[test]
fn a_partial_exit_by_hand_shrinks_the_protection_stop_first() {
    let e1 = entry("e1", Side::Buy, 31, 31, 1);
    let mut orders = vec![e1.clone()];
    orders.extend(pair(&e1, 31, "20544.75", "20806.00"));
    let out = plan(&state(GROW, 21, &orders), &protecting("e1"));
    assert_eq!(
        out.steps,
        [
            resize("e1-sl", SL, 31, 21, Why::Shrank),
            resize("e1-tp", TP, 31, 21, Why::Shrank)
        ]
    );
}

#[test]
fn a_target_filled_in_part_shrinks_the_stop_to_the_remainder() {
    let e1 = entry("e1", Side::Buy, 31, 31, 1);
    let [sl, mut tp] = pair(&e1, 31, "20544.75", "20806.00");
    tp.filled_qty = Qty::from(5);
    tp.status = OrderStatus::PartiallyFilled;
    let orders = vec![e1, sl, tp];
    let out = plan(&state(GROW, 26, &orders), &protecting("e1"));
    assert_eq!(out.steps, [resize("e1-sl", SL, 31, 26, Why::Oco)]);
    let e1 = entry("e1", Side::Buy, 31, 31, 1);
    let [mut sl, tp] = pair(&e1, 31, "20544.75", "20806.00");
    sl.filled_qty = Qty::from(4);
    sl.status = OrderStatus::PartiallyFilled;
    let orders = vec![e1, sl, tp];
    let out = plan(&state(GROW, 27, &orders), &protecting("e1"));
    assert_eq!(out.steps, [resize("e1-tp", TP, 31, 27, Why::Oco)]);
}

fn target_filled_in_part(by: i64) -> Vec<Order> {
    let e1 = entry("e1", Side::Buy, 2, 2, 1);
    let [sl, mut tp] = pair(&e1, 2, "20544.75", "20806.00");
    tp.filled_qty = Qty::from(by);
    tp.status = OrderStatus::PartiallyFilled;
    vec![e1, sl, tp]
}

#[test]
fn before_the_position_counts_a_fill_only_the_pairs_own_legs_size_them() {
    let orders = target_filled_in_part(1);
    for (mode, position) in [(GROW, 2), (EACH, 2), (GROW, 0), (EACH, 0), (GROW, 3)] {
        let s = State {
            reading: Reading::FillsAhead,
            ..state(mode, position, &orders)
        };
        let out = plan(&s, &protecting("e1"));
        let want = if position == 0 {
            vec![]
        } else {
            vec![resize("e1-sl", SL, 2, 1, Why::Oco)]
        };
        assert_eq!(out.steps, want, "{mode:?} reading {position}");
        assert_eq!(out.memory, protecting("e1"), "{mode:?} reading {position}");
    }
}

#[test]
fn a_position_that_may_still_count_an_exit_grows_the_legs_only_past_it() {
    let orders = target_filled_in_part(1);
    let late = State {
        reading: Reading::ExitsAhead(d(1)),
        ..state(GROW, 2, &orders)
    };
    assert_eq!(
        plan(&late, &protecting("e1")).steps,
        [resize("e1-sl", SL, 2, 1, Why::Oco)]
    );
    let added = State {
        reading: Reading::ExitsAhead(d(1)),
        ..state(GROW, 3, &orders)
    };
    assert_eq!(
        plan(&added, &protecting("e1")).steps,
        [
            resize("e1-sl", SL, 2, 1, Why::Oco),
            resize("e1-sl", SL, 1, 2, Why::Grew),
            Step::Resize {
                order: id("e1-tp"),
                role: TP,
                from: Qty::from(1),
                to: Qty::from(2),
                qty: Qty::from(3),
                why: Why::Grew,
            },
        ],
        "an add of 1 the position counts along with the exit"
    );
    assert_eq!(
        plan(&state(GROW, 2, &orders), &protecting("e1")).steps,
        [
            resize("e1-sl", SL, 2, 1, Why::Oco),
            resize("e1-sl", SL, 1, 2, Why::Grew),
            Step::Resize {
                order: id("e1-tp"),
                role: TP,
                from: Qty::from(1),
                to: Qty::from(2),
                qty: Qty::from(3),
                why: Why::Grew,
            },
        ],
        "a current position of 2 is an add, and grows them"
    );
}

#[test]
fn a_leg_whose_change_is_on_its_way_holds_its_pair() {
    let e1 = entry("e1", Side::Buy, 3, 3, 1);
    let [mut sl, tp] = pair(&e1, 2, "20544.75", "20806.00");
    sl.request.qty = Qty::from(3);
    let orders = vec![e1, sl, tp];
    let changing = [id("e1-tp")];
    let s = State {
        changing: &changing,
        ..state(GROW, 3, &orders)
    };
    let out = plan(&s, &protecting("e1"));
    assert!(out.steps.is_empty(), "{:?}", out.steps);
    assert!(out.waiting);
    assert_eq!(
        plan(&state(GROW, 3, &orders), &protecting("e1")).steps,
        [
            resize("e1-sl", SL, 3, 2, Why::Oco),
            resize("e1-sl", SL, 2, 3, Why::Grew),
            resize("e1-tp", TP, 2, 3, Why::Grew),
        ],
        "read alone, the half-grown pair looks uneven"
    );
}

#[test]
fn flat_cancels_the_protection_and_leaves_working_entries_their_legs() {
    let e1 = entry("e1", Side::Buy, 13, 13, 1);
    let e2 = resting("e2", Side::Buy, 2, "20500.00", 2);
    let mut orders = vec![e1.clone(), e2.clone()];
    orders.extend(pair(&e1, 13, "20544.75", "20806.00"));
    orders.extend(pair(&e2, 2, "20480.00", "20600.00"));
    let out = plan(&state(GROW, 0, &orders), &protecting("e1"));
    assert_eq!(
        out.steps,
        [
            cancel("e1-sl", SL, Why::Flat),
            cancel("e1-tp", TP, Why::Flat)
        ]
    );
    assert_eq!(out.memory, Memory::default());
}

#[test]
fn a_reversal_cancels_the_old_side_and_sizes_the_reversing_entrys_legs() {
    let e1 = entry("e1", Side::Buy, 3, 3, 1);
    let e2 = entry("e2", Side::Sell, 5, 5, 2);
    let mut orders = vec![e1.clone(), e2.clone()];
    orders.extend(pair(&e1, 3, "20544.75", "20806.00"));
    orders.extend(pair(&e2, 5, "20600.00", "20500.00"));
    let out = plan(&state(GROW, -2, &orders), &protecting("e1"));
    assert_eq!(
        out.steps,
        [
            cancel("e1-sl", SL, Why::Reversed),
            cancel("e1-tp", TP, Why::Reversed),
            resize("e2-sl", SL, 5, 2, Why::Shrank),
            resize("e2-tp", TP, 5, 2, Why::Shrank),
        ]
    );
    assert_eq!(out.memory.side, Some(Side::Sell));
    assert_eq!(out.memory.protection, Some(id("e2")));
    let out = plan(&state(EACH, -2, &orders), &Memory::default());
    assert_eq!(out.steps.len(), 4);
    assert_eq!(out.steps[2], resize("e2-sl", SL, 5, 2, Why::Shrank));
}

#[test]
fn an_add_filling_after_a_stop_out_gets_the_legs_it_was_placed_with() {
    let e1 = entry("e1", Side::Buy, 13, 13, 1);
    let [mut sl, mut tp] = pair(&e1, 13, "20544.75", "20806.00");
    sl.status = OrderStatus::Filled;
    sl.filled_qty = Qty::from(13);
    tp.status = OrderStatus::Cancelled;
    let e2 = entry("e2", Side::Buy, 5, 5, 3);
    let orders = vec![e1, sl, tp, e2];
    let legs = Bracket {
        stop_loss: Some(p("20530.00")),
        take_profit: Some(p("20700.00")),
        ..Bracket::default()
    };
    let intents = [Intent {
        entry: id("e2"),
        bracket: legs,
    }];
    let s = State {
        intents: &intents,
        ..state(GROW, 5, &orders)
    };
    let out = plan(&s, &protecting("e1"));
    assert_eq!(
        out.steps,
        [Step::Attach {
            entry: id("e2"),
            bracket: legs,
            qty: Qty::from(5)
        }]
    );
    assert_eq!(out.done, [id("e2")]);
    assert_eq!(out.memory.protection, None);
    assert!(
        plan(&state(GROW, 5, &orders), &Memory::default())
            .steps
            .is_empty()
    );
}

#[test]
fn an_adds_intent_stays_while_it_works_and_goes_when_it_ends() {
    let e2 = resting("e2", Side::Buy, 5, "20500.00", 2);
    let legs = Bracket {
        stop_loss: Some(p("20480.00")),
        ..Bracket::default()
    };
    let intents = [Intent {
        entry: id("e2"),
        bracket: legs,
    }];
    let orders = vec![e2.clone()];
    let s = State {
        intents: &intents,
        ..state(GROW, 0, &orders)
    };
    assert!(plan(&s, &Memory::default()).done.is_empty());
    let mut gone = e2;
    gone.status = OrderStatus::Cancelled;
    let orders = vec![gone];
    let s = State {
        intents: &intents,
        ..state(GROW, 0, &orders)
    };
    assert_eq!(plan(&s, &Memory::default()).done, [id("e2")]);
}

#[test]
fn an_entry_placed_with_legs_that_fills_into_a_protected_position_joins_it() {
    let e1 = entry("e1", Side::Buy, 13, 13, 2);
    let e0 = entry("e0", Side::Buy, 13, 13, 3);
    let mut orders = vec![e1.clone(), e0.clone()];
    orders.extend(pair(&e1, 13, "20544.75", "20806.00"));
    let m = plan(&state(GROW, 13, &orders), &Memory::default()).memory;
    assert_eq!(m.protection, Some(id("e1")));
    orders.extend(pair(&e0, 13, "20531.00", "20806.75"));
    let out = plan(&state(GROW, 26, &orders), &m);
    assert_eq!(
        out.steps,
        [
            cancel("e0-sl", SL, Why::Joined),
            cancel("e0-tp", TP, Why::Joined),
            resize("e1-sl", SL, 13, 26, Why::Grew),
            resize("e1-tp", TP, 13, 26, Why::Grew),
        ]
    );
}

#[test]
fn legacy_pairs_keep_their_prices_and_the_tightest_takes_the_adds() {
    let a = entry("a", Side::Buy, 13, 13, 1);
    let b = entry("b", Side::Buy, 13, 13, 2);
    let c = entry("c", Side::Buy, 5, 5, 3);
    let mut orders = vec![a.clone(), b.clone(), c.clone()];
    orders.extend(pair(&a, 13, "20544.75", "20806.00"));
    orders.extend(pair(&b, 13, "20544.75", "20806.00"));
    orders.extend(pair(&c, 5, "20531.00", "20806.75"));
    let out = plan(&state(GROW, 31, &orders), &Memory::default());
    assert!(
        out.steps.is_empty(),
        "nobody's price or size moves by itself"
    );
    assert_eq!(
        out.memory.protection,
        Some(id("a")),
        "the tightest stop, oldest"
    );
    assert_eq!(out.memory.legacy, BTreeSet::from([id("b"), id("c")]));
    orders.push(entry("d", Side::Buy, 2, 2, 4));
    let add = plan(&state(GROW, 33, &orders), &out.memory);
    assert_eq!(
        add.steps,
        [
            resize("a-sl", SL, 13, 15, Why::Grew),
            resize("a-tp", TP, 13, 15, Why::Grew)
        ]
    );
    let mut orders = vec![a.clone(), b.clone(), c.clone()];
    orders.extend(pair(&a, 15, "20544.75", "20806.00"));
    orders.extend(pair(&b, 13, "20544.75", "20806.00"));
    orders.extend(pair(&c, 5, "20531.00", "20806.75"));
    let exit = plan(&state(GROW, 20, &orders), &out.memory);
    assert_eq!(
        exit.steps,
        [
            cancel("c-sl", SL, Why::Shrank),
            cancel("c-tp", TP, Why::Shrank),
            resize("b-sl", SL, 13, 5, Why::Shrank),
            resize("b-tp", TP, 13, 5, Why::Shrank),
        ]
    );
    assert_eq!(exit.memory.legacy, BTreeSet::from([id("b"), id("c")]));
}

#[test]
fn merging_keeps_one_pair_at_the_tightest_stop_and_nearest_target() {
    let a = entry("a", Side::Buy, 13, 13, 1);
    let b = entry("b", Side::Buy, 13, 13, 2);
    let c = entry("c", Side::Buy, 5, 5, 3);
    let mut orders = vec![a.clone(), b.clone(), c.clone()];
    orders.extend(pair(&a, 13, "20540.00", "20806.00"));
    orders.extend(pair(&b, 13, "20544.75", "20810.00"));
    orders.extend(pair(&c, 5, "20531.00", "20800.25"));
    let out = merge(&state(GROW, 31, &orders));
    assert_eq!(
        out.steps,
        [
            cancel("a-sl", SL, Why::Merged),
            cancel("c-sl", SL, Why::Merged),
            cancel("a-tp", TP, Why::Merged),
            cancel("c-tp", TP, Why::Merged),
            Step::Move {
                order: id("b-tp"),
                role: TP,
                from: p("20810.00"),
                to: p("20800.25")
            },
            resize("b-sl", SL, 13, 31, Why::Merged),
            resize("b-tp", TP, 13, 31, Why::Merged),
        ]
    );
    assert_eq!(out.memory.protection, Some(id("b")));
    assert!(out.memory.legacy.is_empty());
    let one = &orders[..1]
        .iter()
        .cloned()
        .chain(pair(&a, 13, "20540.00", "20806.00"))
        .collect::<Vec<_>>();
    assert!(merge(&state(GROW, 13, one)).steps.is_empty());
}

#[test]
fn a_leg_on_its_way_waits() {
    let e1 = entry("e1", Side::Buy, 13, 13, 1);
    let e2 = entry("e2", Side::Buy, 13, 13, 2);
    let mut orders = vec![e1.clone(), e2];
    for mut l in pair(&e1, 13, "20544.75", "20806.00") {
        l.status = OrderStatus::Held;
        l.broker_order_id = None;
        orders.push(l);
    }
    let out = plan(&state(GROW, 26, &orders), &protecting("e1"));
    assert!(out.steps.is_empty());
    assert!(out.waiting);
    assert!(protected(&orders, d(26)));
    assert!(!protected(&orders, d(0)));
    let held_only = [resting("e3", Side::Buy, 1, "20500.00", 3)];
    assert!(!protected(&held_only, d(26)));
}

#[test]
fn exits_placed_by_hand_are_left_alone_until_the_position_is_gone() {
    let e1 = entry("e1", Side::Buy, 10, 10, 1);
    let mut exit = base("x", Side::Sell, 4, OrderType::Limit, 2);
    exit.role = OrderRole::Exit;
    exit.request.reduce_only = true;
    exit.request.limit_price = Some(p("20700.00"));
    let mut orders = vec![e1.clone(), exit];
    orders.extend(pair(&e1, 10, "20544.75", "20806.00"));
    assert!(
        plan(&state(GROW, 10, &orders), &protecting("e1"))
            .steps
            .is_empty()
    );
    assert_eq!(
        plan(&state(GROW, 0, &orders), &protecting("e1")).steps,
        [
            cancel("e1-sl", SL, Why::Flat),
            cancel("e1-tp", TP, Why::Flat),
            cancel("x", TP, Why::Flat)
        ]
    );
}

#[test]
fn the_protection_prices_are_the_tightest_stop_and_nearest_target() {
    let a = entry("a", Side::Buy, 13, 13, 1);
    let c = entry("c", Side::Buy, 5, 5, 3);
    let mut orders = vec![a.clone(), c.clone()];
    orders.extend(pair(&a, 13, "20544.75", "20806.00"));
    orders.extend(pair(&c, 5, "20531.00", "20800.25"));
    let b = protection_prices(&orders, d(18));
    assert_eq!(b.stop_loss, Some(p("20544.75")));
    assert_eq!(b.take_profit, Some(p("20800.25")));
    assert_eq!(protection_prices(&orders, d(0)), Bracket::default());
}

#[test]
fn per_entry_pairs_stay_their_own_and_a_partial_exit_shrinks_the_newest_first() {
    let a = entry("a", Side::Buy, 13, 13, 1);
    let b = entry("b", Side::Buy, 13, 13, 2);
    let c = entry("c", Side::Buy, 5, 5, 3);
    let mut orders = vec![a.clone(), b.clone(), c.clone()];
    orders.extend(pair(&a, 13, "20544.75", "20806.00"));
    orders.extend(pair(&b, 13, "20544.75", "20806.00"));
    orders.extend(pair(&c, 5, "20531.00", "20806.75"));
    assert!(
        plan(&state(EACH, 31, &orders), &Memory::default())
            .steps
            .is_empty()
    );
    let out = plan(&state(EACH, 20, &orders), &Memory::default());
    assert_eq!(
        out.steps,
        [
            cancel("c-sl", SL, Why::Shrank),
            cancel("c-tp", TP, Why::Shrank),
            resize("b-sl", SL, 13, 7, Why::Shrank),
            resize("b-tp", TP, 13, 7, Why::Shrank),
        ]
    );
}

#[test]
fn per_entry_a_target_filled_in_part_shrinks_its_own_stop_only() {
    let a = entry("a", Side::Buy, 13, 13, 1);
    let b = entry("b", Side::Buy, 13, 13, 2);
    let mut orders = vec![a.clone(), b.clone()];
    orders.extend(pair(&a, 13, "20544.75", "20806.00"));
    let [sl, mut tp] = pair(&b, 13, "20540.00", "20700.00");
    tp.filled_qty = Qty::from(5);
    tp.status = OrderStatus::PartiallyFilled;
    orders.extend([sl, tp]);
    let out = plan(&state(EACH, 21, &orders), &Memory::default());
    assert_eq!(out.steps, [resize("b-sl", SL, 13, 8, Why::Oco)]);
}

#[test]
fn per_entry_flat_and_a_reversal_cancel_like_grow() {
    let a = entry("a", Side::Buy, 13, 13, 1);
    let mut orders = vec![a.clone()];
    orders.extend(pair(&a, 13, "20544.75", "20806.00"));
    assert_eq!(
        plan(&state(EACH, 0, &orders), &Memory::default()).steps,
        [cancel("a-sl", SL, Why::Flat), cancel("a-tp", TP, Why::Flat)]
    );
    assert_eq!(
        plan(&state(EACH, -3, &orders), &Memory::default()).steps,
        [
            cancel("a-sl", SL, Why::Reversed),
            cancel("a-tp", TP, Why::Reversed)
        ]
    );
}

#[test]
fn modes_read_and_write_their_setting_values() {
    assert_eq!(ProtectionMode::parse("per_entry"), ProtectionMode::PerEntry);
    assert_eq!(ProtectionMode::parse("grow"), ProtectionMode::Grow);
    assert_eq!(ProtectionMode::parse("nonsense"), ProtectionMode::PerEntry);
    assert_eq!(ProtectionMode::default(), ProtectionMode::PerEntry);
    assert_eq!(ProtectionMode::PerEntry.as_str(), "per_entry");
}

fn loose(id: &str, side: Side, order_type: OrderType, price: &str, role: OrderRole) -> Order {
    let mut o = base(id, side, 2, order_type, 5);
    if order_type == OrderType::Limit {
        o.request.limit_price = Some(p(price));
    } else {
        o.request.stop_price = Some(p(price));
    }
    o.request.reduce_only = true;
    o.role = role;
    o
}

#[test]
fn a_loose_reduce_only_stop_or_target_dies_with_the_position() {
    let breakeven = loose(
        "be",
        Side::Sell,
        OrderType::Stop,
        "20600.00",
        OrderRole::Entry,
    );
    let dragged = loose(
        "tp",
        Side::Sell,
        OrderType::Limit,
        "20700.00",
        OrderRole::Exit,
    );
    let entry_stop = base("es", Side::Sell, 1, OrderType::Stop, 6);
    let mut closing = base("close", Side::Sell, 2, OrderType::Market, 7);
    closing.request.reduce_only = true;
    closing.role = OrderRole::Exit;
    let orders = vec![breakeven, dragged, entry_stop, closing];
    for mode in [EACH, GROW] {
        assert_eq!(
            plan(&state(mode, 2, &orders), &Memory::default()).steps,
            [],
            "{mode:?}: they protect the long"
        );
        let flat = plan(&state(mode, 0, &orders), &Memory::default());
        assert_eq!(
            flat.steps,
            [cancel("be", SL, Why::Flat), cancel("tp", TP, Why::Flat)],
            "{mode:?}"
        );
        assert_eq!(
            plan(&state(mode, -2, &orders), &Memory::default()).steps,
            [
                cancel("be", SL, Why::Reversed),
                cancel("tp", TP, Why::Reversed)
            ],
            "{mode:?}"
        );
    }
}

#[test]
fn a_loose_exit_larger_than_what_a_partial_exit_left_shrinks_to_the_position() {
    let stop = loose(
        "be",
        Side::Sell,
        OrderType::Stop,
        "20600.00",
        OrderRole::Entry,
    );
    let target = loose(
        "tp",
        Side::Sell,
        OrderType::Limit,
        "20700.00",
        OrderRole::Entry,
    );
    let orders = vec![stop, target];
    for mode in [EACH, GROW] {
        assert_eq!(
            plan(&state(mode, 1, &orders), &Memory::default()).steps,
            [
                resize("be", SL, 2, 1, Why::Shrank),
                resize("tp", TP, 2, 1, Why::Shrank)
            ],
            "{mode:?}: a 2-lot exit on a 1-lot long would leave it short"
        );
    }
}

#[test]
fn a_loose_stop_still_on_its_way_when_flat_is_cancelled_once_it_arrives() {
    let mut on_its_way = loose(
        "be",
        Side::Sell,
        OrderType::Stop,
        "20600.00",
        OrderRole::Entry,
    );
    on_its_way.status = OrderStatus::PendingSubmit;
    let orders = vec![on_its_way.clone()];
    let out = plan(&state(EACH, 0, &orders), &Memory::default());
    assert!(out.steps.is_empty());
    assert!(out.waiting, "planned again shortly");
    on_its_way.status = OrderStatus::Working;
    let orders = vec![on_its_way];
    assert_eq!(
        plan(&state(EACH, 0, &orders), &Memory::default()).steps,
        [cancel("be", SL, Why::Flat)]
    );
}
