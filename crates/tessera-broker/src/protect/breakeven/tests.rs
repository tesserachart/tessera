use std::str::FromStr;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use tessera_core::accounts::Environment;
use tessera_core::catalog::Catalog;
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::money::Money;
use tessera_core::orders::{
    BreakevenRule, Order, OrderRequest, OrderRole, OrderStatus, OrderType, Position, Side,
    StopRules, TimeInForce,
};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};

use super::*;

fn p(s: &str) -> Price {
    Price(Decimal::from_str(s).unwrap())
}

fn mnq() -> InstrumentId {
    InstrumentId::new("MNQZ6.CME").unwrap()
}

fn spec() -> ContractSpec {
    Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap())
        .spec(&mnq())
        .unwrap()
        .clone()
}

fn position(qty: i64, avg: &str) -> Position {
    Position {
        account_id: AccountId::new("paper-main"),
        instrument: mnq(),
        qty: Qty::from(qty),
        avg_price: p(avg),
        realized_pnl: Money::usd(Decimal::ZERO),
        unrealized_pnl: None,
        mark: None,
        opened_at: Timestamp(0),
    }
}

fn stop(id: &str, side: Side, qty: i64, at: &str) -> Order {
    Order {
        id: OrderId::new(id),
        broker_order_id: Some(id.to_owned()),
        draft_id: None,
        request: OrderRequest {
            account_id: AccountId::new("paper-main"),
            instrument: mnq(),
            side: side.opposite(),
            qty: Qty::from(qty),
            order_type: OrderType::Stop,
            limit_price: None,
            stop_price: Some(p(at)),
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only: true,
        },
        role: OrderRole::StopLoss,
        parent_id: Some(OrderId::new(format!("{id}-entry"))),
        status: OrderStatus::Working,
        filled_qty: Qty::ZERO,
        avg_fill_price: None,
        queue_ahead: None,
        stop_rules: None,
        triggered_at: None,
        environment: Environment::Paper,
        reason: None,
        created_at: Timestamp(0),
        updated_at: Timestamp(0),
    }
}

fn touch(bid: &str, ask: &str, last: &str) -> Touch {
    Touch {
        bid: Some(p(bid)),
        ask: Some(p(ask)),
        last: Some(p(last)),
    }
}

fn ask(offset: Option<u32>, t: Touch) -> BreakevenAsk {
    BreakevenAsk {
        spec: spec(),
        offset_ticks: offset,
        touch: t,
    }
}

fn moved(plan: &BreakevenPlan) -> Vec<(&str, Price)> {
    plan.moves
        .iter()
        .map(|m| (m.order.as_str(), m.to))
        .collect()
}

#[test]
fn a_longs_stop_goes_to_the_entry_plus_the_offset() {
    let pos = position(2, "20600.00");
    let orders = [stop("s1", Side::Buy, 2, "20590.00")];
    let plan = plan(
        Some(&pos),
        &orders,
        &ask(Some(4), touch("20610.00", "20610.25", "20610.00")),
    )
    .unwrap();
    assert_eq!(plan.price, p("20601.00"));
    assert_eq!(moved(&plan), [("s1", p("20601.00"))]);
    assert_eq!(plan.kept, 0);
    assert_eq!(
        plan.summary(),
        "Moved the stop to breakeven, 20,601.00 (the entry + 4 ticks)"
    );
}

#[test]
fn a_shorts_stop_goes_to_the_entry_minus_the_offset() {
    let pos = position(-3, "20600.00");
    let orders = [stop("s1", Side::Sell, 3, "20612.50")];
    let plan = plan(
        Some(&pos),
        &orders,
        &ask(Some(1), touch("20590.00", "20590.25", "20590.25")),
    )
    .unwrap();
    assert_eq!(plan.price, p("20599.75"));
    assert_eq!(moved(&plan), [("s1", p("20599.75"))]);
    assert_eq!(
        plan.summary(),
        "Moved the stop to breakeven, 20,599.75 (the entry + 1 tick)"
    );
}

#[test]
fn an_average_off_the_tick_rounds_toward_profit() {
    let long = position(3, "20600.10");
    let orders = [stop("s1", Side::Buy, 3, "20590.00")];
    let t = touch("20610.00", "20610.25", "20610.00");
    assert_eq!(
        plan(Some(&long), &orders, &ask(None, t)).unwrap().price,
        p("20600.25")
    );
    let short = position(-3, "20600.10");
    let orders = [stop("s1", Side::Sell, 3, "20612.00")];
    let t = touch("20590.00", "20590.25", "20590.25");
    assert_eq!(
        plan(Some(&short), &orders, &ask(None, t)).unwrap().price,
        p("20600.00")
    );
}

#[test]
fn without_an_offset_asked_the_stops_own_rule_gives_it_else_none() {
    let pos = position(1, "20600.00");
    let t = touch("20610.00", "20610.25", "20610.00");
    let mut s = stop("s1", Side::Buy, 1, "20590.00");
    assert_eq!(
        plan(Some(&pos), std::slice::from_ref(&s), &ask(None, t))
            .unwrap()
            .price,
        p("20600.00"),
        "no rule: the entry itself"
    );
    s.stop_rules = Some(StopRules {
        breakeven: Some(BreakevenRule {
            trigger_ticks: 20,
            offset_ticks: 2,
        }),
        ..StopRules::default()
    });
    assert_eq!(
        plan(Some(&pos), std::slice::from_ref(&s), &ask(None, t))
            .unwrap()
            .price,
        p("20600.50"),
        "the rule the stop carries"
    );
    assert_eq!(
        plan(Some(&pos), std::slice::from_ref(&s), &ask(Some(0), t))
            .unwrap()
            .price,
        p("20600.00"),
        "the offset asked wins"
    );
}

#[test]
fn every_pairs_stop_goes_to_the_positions_average_entry() {
    let pos = position(18, "20597.25");
    let orders = [
        stop("s13", Side::Buy, 13, "20560.00"),
        stop("s5", Side::Buy, 5, "20600.00"),
        stop("other", Side::Sell, 1, "20700.00"),
        Order {
            status: OrderStatus::Held,
            ..stop("held", Side::Buy, 2, "20550.00")
        },
    ];
    let plan = plan(
        Some(&pos),
        &orders,
        &ask(Some(1), touch("20610.00", "20610.25", "20610.00")),
    )
    .unwrap();
    assert_eq!(moved(&plan), [("s13", p("20597.50"))]);
    assert_eq!(plan.kept, 1);
    let orders = [
        stop("s13", Side::Buy, 13, "20560.00"),
        stop("s5", Side::Buy, 5, "20580.00"),
    ];
    let plan = super::plan(
        Some(&pos),
        &orders,
        &ask(Some(1), touch("20610.00", "20610.25", "20610.00")),
    )
    .unwrap();
    assert_eq!(
        moved(&plan),
        [("s13", p("20597.50")), ("s5", p("20597.50"))]
    );
    assert_eq!(
        plan.summary(),
        "Moved 2 stops to breakeven, 20,597.50 (the entry + 1 tick): every entry's stop to the \
         position's average entry"
    );
}

#[test]
fn refused_while_price_has_not_passed_breakeven() {
    let pos = position(2, "20600.00");
    let orders = [stop("s1", Side::Buy, 2, "20598.00")];
    let e = plan(
        Some(&pos),
        &orders,
        &ask(Some(0), touch("20600.00", "20600.25", "20600.25")),
    )
    .unwrap_err();
    assert_eq!(
        e.words("MNQZ6"),
        "Price hasn't passed your entry (20,600.00) yet; the stop stays at 20,598.00."
    );
    let e = plan(
        Some(&pos),
        &orders,
        &ask(Some(4), touch("20600.75", "20601.00", "20601.00")),
    )
    .unwrap_err();
    assert_eq!(
        e.words("MNQZ6"),
        "Price hasn't passed breakeven (20,601.00, the entry + 4 ticks) yet; the stop stays at \
         20,598.00."
    );
    let pos = position(-2, "20600.00");
    let orders = [stop("s1", Side::Sell, 2, "20604.00")];
    let e = plan(
        Some(&pos),
        &orders,
        &ask(None, touch("20599.75", "20600.00", "20599.75")),
    )
    .unwrap_err();
    assert!(matches!(e, Refused::NotPassed { .. }), "{e:?}");
    let e = plan(Some(&pos), &orders, &ask(None, Touch::default())).unwrap_err();
    assert_eq!(
        e.words("MNQZ6"),
        "No price for MNQZ6 yet; the stop stays at 20,604.00."
    );
}

#[test]
fn a_position_without_a_stop_gets_one_at_breakeven_for_its_whole_size() {
    let t = touch("20610.00", "20610.25", "20610.00");
    let mut target = stop("t1", Side::Buy, 2, "20650.00");
    target.role = OrderRole::TakeProfit;
    target.request.order_type = OrderType::Limit;
    target.request.limit_price = target.request.stop_price.take();
    let long = plan(Some(&position(2, "20600.00")), &[target], &ask(Some(4), t)).unwrap();
    assert_eq!(long.new_stop, Some(Qty::from(2)));
    assert_eq!(long.side, Side::Buy);
    assert_eq!(long.price, p("20601.00"));
    assert!(long.moves.is_empty());
    assert_eq!(
        long.summary(),
        "Placed a stop at breakeven, 20,601.00 (the entry + 4 ticks)"
    );
    let short = plan(
        Some(&position(-3, "20620.00")),
        &[],
        &ask(None, touch("20610.00", "20610.25", "20610.00")),
    )
    .unwrap();
    assert_eq!(short.new_stop, Some(Qty::from(3)));
    assert_eq!(short.price, p("20620.00"));
    assert_eq!(
        short.summary(),
        "Placed a stop at breakeven, 20,620.00 (the entry)"
    );
}

#[test]
fn a_position_without_a_stop_gets_none_until_price_has_passed_breakeven() {
    let pos = position(2, "20600.00");
    let e = plan(
        Some(&pos),
        &[],
        &ask(Some(0), touch("20600.00", "20600.25", "20600.25")),
    )
    .unwrap_err();
    assert_eq!(
        e.words("MNQZ6"),
        "Price hasn't passed your entry (20,600.00) yet; no stop sent."
    );
    let e = plan(Some(&pos), &[], &ask(None, Touch::default())).unwrap_err();
    assert_eq!(e.words("MNQZ6"), "No price for MNQZ6 yet; no stop sent.");
}

#[test]
fn refused_without_a_position_or_a_stop_behind_it() {
    let t = touch("20610.00", "20610.25", "20610.00");
    assert_eq!(plan(None, &[], &ask(None, t)), Err(Refused::NoPosition));
    let pos = position(2, "20600.00");
    let e = plan(
        Some(&pos),
        &[stop("s1", Side::Buy, 2, "20601.00")],
        &ask(Some(1), t),
    )
    .unwrap_err();
    assert_eq!(
        e.words("MNQZ6"),
        "The stop is already at or past breakeven (20,600.25)."
    );
    let busy = Order {
        status: OrderStatus::PendingSubmit,
        ..stop("s1", Side::Buy, 2, "20590.00")
    };
    assert_eq!(
        plan(Some(&pos), &[busy], &ask(None, t)),
        Err(Refused::OnItsWay)
    );
}

#[test]
fn a_reduce_only_stop_limit_moves_its_limit_with_it() {
    let pos = position(1, "20600.00");
    let mut s = stop("s1", Side::Buy, 1, "20590.00");
    s.role = OrderRole::Exit;
    s.parent_id = None;
    s.request.order_type = OrderType::StopLimit;
    s.request.limit_price = Some(p("20589.00"));
    let plan = plan(
        Some(&pos),
        &[s],
        &ask(None, touch("20610.00", "20610.25", "20610.00")),
    )
    .unwrap();
    assert_eq!(plan.moves[0].to, p("20600.00"));
    assert_eq!(plan.moves[0].limit, Some(p("20599.00")));
}
