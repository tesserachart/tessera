use std::str::FromStr;
use std::time::Duration;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use tessera_core::accounts::Environment;
use tessera_core::catalog::Catalog;
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::orders::{
    BreakevenRule, Order, OrderRequest, OrderRole, OrderStatus, OrderType, Side, StopRules,
    TimeInForce, TrailRule,
};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};
use tokio::time::Instant;

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

fn stop(at: &str, rules: Option<StopRules>, status: OrderStatus) -> Order {
    Order {
        id: OrderId::new("sl-1"),
        broker_order_id: Some("B1-S".into()),
        draft_id: None,
        request: OrderRequest {
            account_id: AccountId::new("rithmic-apex-x"),
            instrument: mnq(),
            side: Side::Sell,
            qty: Qty::from(2),
            order_type: OrderType::Stop,
            limit_price: None,
            stop_price: Some(p(at)),
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only: true,
        },
        role: OrderRole::StopLoss,
        parent_id: Some(OrderId::new("e-1")),
        status,
        filled_qty: Qty::ZERO,
        avg_fill_price: None,
        queue_ahead: None,
        stop_rules: rules,
        triggered_at: None,
        environment: Environment::Eval,
        reason: None,
        created_at: Timestamp(0),
        updated_at: Timestamp(0),
    }
}

fn rules(entry: Option<&str>) -> Option<StopRules> {
    Some(StopRules {
        breakeven: Some(BreakevenRule {
            trigger_ticks: 8,
            offset_ticks: 1,
        }),
        trail: Some(TrailRule {
            distance_ticks: 12,
            trigger_ticks: 20,
            step_ticks: 1,
        }),
        entry_price: entry.map(p),
        ..StopRules::default()
    })
}

#[test]
fn a_working_stop_with_rules_from_a_fill_is_watched_and_nothing_else() {
    let mut book = RuleBook::default();
    book.track(&stop("19990", rules(None), OrderStatus::Working));
    assert!(book.instruments().is_empty(), "no fill yet");
    book.track(&stop("19990", rules(Some("20000")), OrderStatus::Held));
    assert!(book.instruments().is_empty(), "a held leg waits");
    book.track(&stop("19990", None, OrderStatus::Working));
    assert!(book.instruments().is_empty(), "no rules");
    book.track(&stop("19990", rules(Some("20000")), OrderStatus::Working));
    assert_eq!(book.instruments(), [mnq()]);
    book.track(&stop("19990", rules(Some("20000")), OrderStatus::Cancelled));
    assert!(book.instruments().is_empty(), "gone with its order");
}

#[test]
fn one_move_at_a_time_and_the_best_price_seen_meanwhile_counts() {
    let spec = spec();
    let mut book = RuleBook::default();
    let order = stop("19990", rules(Some("20000")), OrderStatus::Working);
    book.track(&order);
    let t0 = Instant::now();
    assert!(book.on_trade(&mnq(), &spec, p("20001"), t0).is_empty());
    let first = book.on_trade(&mnq(), &spec, p("20002"), t0);
    assert_eq!(
        first,
        [RuleMove {
            order: order.id.clone(),
            account: order.request.account_id.clone(),
            instrument: mnq(),
            from: p("19990"),
            to: p("20000.25"),
            breakeven: true,
        }]
    );
    assert!(
        book.on_trade(&mnq(), &spec, p("20009"), t0).is_empty(),
        "nothing more while the move is on its way"
    );
    book.moved(&first[0], t0);
    assert!(
        book.on_trade(&mnq(), &spec, p("20005"), t0 + Duration::from_millis(100))
            .is_empty(),
        "at most one move per stop every 250 ms"
    );
    let next = book.on_trade(&mnq(), &spec, p("20007"), t0 + RULE_GAP);
    assert_eq!(next.len(), 1);
    assert_eq!(
        (next[0].to, next[0].breakeven),
        (p("20006"), false),
        "trails from 20,009, seen while the breakeven move was on its way"
    );
}

#[test]
fn a_refused_breakeven_is_tried_again_after_the_back_off() {
    let spec = spec();
    let mut book = RuleBook::default();
    book.track(&stop("19990", rules(Some("20000")), OrderStatus::Working));
    let t0 = Instant::now();
    let m = book.on_trade(&mnq(), &spec, p("20002"), t0);
    assert!(m[0].breakeven);
    book.refused(&m[0], t0);
    assert!(
        book.on_trade(&mnq(), &spec, p("20002"), t0 + RULE_GAP)
            .is_empty()
    );
    let again = book.on_trade(&mnq(), &spec, p("20002"), t0 + RULE_BACK_OFF);
    assert_eq!((again[0].to, again[0].breakeven), (p("20000.25"), true));
}

#[test]
fn a_stop_its_broker_moves_is_left_to_it() {
    let spec = spec();
    let mut book = RuleBook::default();
    book.track(&stop("19990", rules(Some("20000")), OrderStatus::Working));
    let m = book.on_trade(&mnq(), &spec, p("20002"), Instant::now());
    book.moved_by_broker(&m[0].order);
    assert!(book.instruments().is_empty());
    assert!(
        book.on_trade(&mnq(), &spec, p("20010"), Instant::now())
            .is_empty()
    );
}

#[test]
fn a_stop_reported_again_after_a_restart_takes_back_its_kept_rules() {
    let spec = spec();
    let mut book = RuleBook::default();
    book.track(&stop("19990", rules(Some("20000")), OrderStatus::Working));
    let m = book.on_trade(&mnq(), &spec, p("20002"), Instant::now());
    book.moved(&m[0], Instant::now());
    let kept = book.take_kept().expect("written once its rules are known");
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].broker_order_id, "B1-S");
    assert!(kept[0].rules.breakeven_done);
    assert_eq!(kept[0].rules.best_price, None);
    assert!(book.take_kept().is_none(), "nothing new to write");

    let mut after = RuleBook::default();
    after.restore(kept);
    after.track(&stop("20000.25", None, OrderStatus::Working));
    assert_eq!(after.instruments(), [mnq()]);
    assert!(
        after
            .on_trade(&mnq(), &spec, p("20004"), Instant::now())
            .is_empty(),
        "breakeven does not fire again"
    );
    let m = after.on_trade(&mnq(), &spec, p("20008"), Instant::now());
    assert_eq!((m[0].to, m[0].breakeven), (p("20005"), false));
    after.track(&stop("20005", None, OrderStatus::Filled));
    assert!(after.instruments().is_empty());
    assert_eq!(
        after.take_kept().map(|k| k.len()),
        Some(0),
        "gone with its order"
    );
}

#[test]
fn stop_rules_that_could_not_be_written_are_written_next_time() {
    let spec = spec();
    let mut book = RuleBook::default();
    book.track(&stop("19990", rules(Some("20000")), OrderStatus::Working));
    let m = book.on_trade(&mnq(), &spec, p("20002"), Instant::now());
    book.moved(&m[0], Instant::now());
    let first = book.take_kept().expect("written once its rules are known");
    book.unsaved();
    assert_eq!(book.take_kept(), Some(first));
}
