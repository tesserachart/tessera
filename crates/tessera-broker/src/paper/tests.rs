use std::str::FromStr;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use rust_decimal::prelude::Signed;
use tessera_core::catalog::Catalog;
use tessera_core::ids::AccountId;
use tessera_core::market::{Aggressor, AggressorSource, Quote, Trade};
use tessera_core::money::Money;
use tessera_core::orders::{
    Bracket, BreakevenRule, CheckSeverity, Order, OrderRequest, OrderRole, OrderStatus, OrderType,
    Side, TimeInForce, TrailRule,
};
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{InstrumentId, Price, Qty, Timestamp};

use super::account::{AccountSeed, PaperAccount, test_seeds};
use super::engine::{Book, Commission, Feed, PaperConfig, usd};
use crate::OrderChanges;

fn t0() -> Timestamp {
    Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap()
}

fn at(secs: i64) -> Timestamp {
    t0().add_nanos(secs * NANOS_PER_SEC)
}

fn nq() -> InstrumentId {
    InstrumentId::new("NQZ6.CME").unwrap()
}

fn p(s: &str) -> Price {
    Price(Decimal::from_str(s).unwrap())
}

fn q(n: i64) -> Qty {
    Qty::from(n)
}

fn main() -> AccountId {
    AccountId::new("paper-main")
}

fn eval() -> AccountId {
    AccountId::new("eval-50k")
}

fn money(s: &str) -> Money {
    Money::usd(Decimal::from_str(s).unwrap())
}

fn book_with(config: PaperConfig) -> Book {
    let mut b = Book::new(config);
    for seed in test_seeds() {
        b.add_account(PaperAccount::open(&seed, "paper", t0()));
    }
    let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
    b.set_market(cat.spec(&nq()).unwrap().clone(), true);
    b
}

fn funded(mut b: Book) -> Book {
    for seed in test_seeds() {
        let rich = AccountSeed {
            balance: Decimal::from(10_000_000),
            ..seed
        };
        b.add_account(PaperAccount::open(&rich, "paper", t0()));
    }
    b
}

fn book() -> Book {
    let mut b = book_with(PaperConfig {
        commission: Commission::NONE,
        ..PaperConfig::default()
    });
    b.on_quote(
        &quote("20641.00", 10, "20641.25", 12, "20641.25", t0()),
        t0(),
    );
    b
}

fn quote(bid: &str, bid_size: i64, ask: &str, ask_size: i64, last: &str, ts: Timestamp) -> Quote {
    Quote {
        instrument: nq(),
        ts,
        bid: Some(p(bid)),
        bid_size: Some(q(bid_size)),
        ask: Some(p(ask)),
        ask_size: Some(q(ask_size)),
        last: Some(p(last)),
        last_size: Some(q(1)),
        session: None,
        source: None,
    }
}

fn trade(price: &str, size: i64) -> Trade {
    Trade {
        instrument: nq(),
        ts: t0(),
        price: p(price),
        size: q(size),
        aggressor: Aggressor::Unknown,
        aggressor_source: AggressorSource::Exchange,
        order_key: None,
        source: None,
    }
}

fn req(account: AccountId, side: Side, qty: i64, order_type: OrderType) -> OrderRequest {
    OrderRequest {
        account_id: account,
        instrument: nq(),
        side,
        qty: q(qty),
        order_type,
        limit_price: None,
        stop_price: None,
        tif: TimeInForce::Day,
        bracket: None,
        client_order_id: None,
        reduce_only: false,
    }
}

fn limit(account: AccountId, side: Side, qty: i64, price: &str) -> OrderRequest {
    OrderRequest {
        limit_price: Some(p(price)),
        ..req(account, side, qty, OrderType::Limit)
    }
}

fn stop(account: AccountId, side: Side, qty: i64, price: &str) -> OrderRequest {
    OrderRequest {
        stop_price: Some(p(price)),
        ..req(account, side, qty, OrderType::Stop)
    }
}

fn bracket(stop_loss: &str, take_profit: Option<&str>) -> Option<Bracket> {
    Some(Bracket {
        stop_loss: Some(p(stop_loss)),
        take_profit: take_profit.map(p),
        ..Bracket::default()
    })
}

fn submit(b: &mut Book, r: OrderRequest) -> Order {
    b.submit(r, None, t0()).unwrap().0
}

fn children(b: &Book, entry: &Order) -> (Order, Option<Order>) {
    let kids: Vec<Order> = b
        .orders(None)
        .into_iter()
        .filter(|o| o.parent_id.as_ref() == Some(&entry.id))
        .collect();
    let stop = kids
        .iter()
        .find(|o| o.role == OrderRole::StopLoss)
        .cloned()
        .unwrap();
    let target = kids.into_iter().find(|o| o.role == OrderRole::TakeProfit);
    (stop, target)
}

fn position(b: &Book, account: &AccountId) -> Option<tessera_core::orders::Position> {
    b.positions(Some(account)).into_iter().next()
}

#[test]
fn market_orders_fill_whole_at_the_touch() {
    let mut b = funded(book());
    let buy = submit(&mut b, req(main(), Side::Buy, 3, OrderType::Market));
    assert_eq!(buy.status, OrderStatus::Filled);
    assert_eq!(
        buy.filled_qty,
        q(3),
        "no partial fills, whatever the size at the ask"
    );
    assert_eq!(
        buy.avg_fill_price,
        Some(p("20641.25")),
        "a buy takes the ask"
    );
    let sell = submit(&mut b, req(main(), Side::Sell, 1, OrderType::Market));
    assert_eq!(
        sell.avg_fill_price,
        Some(p("20641.00")),
        "a sell takes the bid"
    );
    let pos = position(&b, &main()).unwrap();
    assert_eq!(pos.qty, q(2));
    assert_eq!(pos.avg_price, p("20641.25"));
    let fills = b.fills(Some(&main()), t0());
    assert_eq!(fills.len(), 2);
    assert_eq!(
        fills[1].realized_pnl,
        Some(money("-5")),
        "one tick against, one contract"
    );
}

#[test]
fn a_marketable_limit_fills_at_the_touch_and_a_resting_one_waits() {
    let mut b = book();
    let o = submit(&mut b, limit(main(), Side::Buy, 1, "20643.00"));
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(
        o.avg_fill_price,
        Some(p("20641.25")),
        "the ask, not the worse limit"
    );
    let o = submit(&mut b, limit(main(), Side::Buy, 1, "20640.00"));
    assert_eq!(o.status, OrderStatus::Working);
    assert_eq!(
        o.queue_ahead, None,
        "deeper than the bid: the queue is unknown"
    );
}

#[test]
fn a_resting_limit_works_off_the_queue_ahead_then_fills_partially() {
    let mut b = funded(book());
    let o = submit(&mut b, limit(main(), Side::Buy, 4, "20641.00"));
    assert_eq!(o.status, OrderStatus::Working);
    assert_eq!(o.queue_ahead, Some(q(10)));
    b.on_trade(&trade("20641.00", 7), t0());
    let o = b.order(&o.id).unwrap().clone();
    assert_eq!(
        (o.status, o.queue_ahead),
        (OrderStatus::Working, Some(q(3)))
    );
    b.on_trade(&trade("20641.00", 5), t0());
    let o = b.order(&o.id).unwrap().clone();
    assert_eq!(o.status, OrderStatus::PartiallyFilled);
    assert_eq!(o.filled_qty, q(2));
    assert_eq!(o.avg_fill_price, Some(p("20641.00")));
    b.on_trade(&trade("20640.75", 1), t0());
    let o = b.order(&o.id).unwrap().clone();
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.filled_qty, q(4));
    assert_eq!(o.avg_fill_price, Some(p("20641.00")));
}

#[test]
fn an_unknown_queue_fills_only_on_a_trade_through() {
    let mut b = book();
    let o = submit(&mut b, limit(main(), Side::Buy, 1, "20640.00"));
    b.on_trade(&trade("20640.00", 50), t0());
    assert_eq!(b.order(&o.id).unwrap().status, OrderStatus::Working);
    b.on_quote(&quote("20640.00", 6, "20640.25", 4, "20640.25", t0()), t0());
    assert_eq!(b.order(&o.id).unwrap().queue_ahead, Some(q(6)));
    b.on_trade(&trade("20639.75", 1), t0());
    assert_eq!(b.order(&o.id).unwrap().status, OrderStatus::Filled);
}

#[test]
fn stops_trigger_on_a_trade_and_fill_at_the_touch() {
    let mut b = book();
    let o = submit(&mut b, stop(main(), Side::Buy, 2, "20645.00"));
    assert_eq!(o.status, OrderStatus::Working);
    b.on_trade(&trade("20644.75", 1), t0());
    assert_eq!(b.order(&o.id).unwrap().triggered_at, None);
    b.on_quote(&quote("20645.00", 3, "20645.50", 3, "20645.00", t0()), t0());
    b.on_trade(&trade("20645.00", 1), t0());
    let o = b.order(&o.id).unwrap().clone();
    assert_eq!(o.status, OrderStatus::Filled);
    assert!(o.triggered_at.is_some());
    assert_eq!(o.avg_fill_price, Some(p("20645.50")));
    let s = submit(&mut b, stop(main(), Side::Sell, 1, "20630.00"));
    b.on_trade(&trade("20629.00", 1), t0());
    assert_eq!(
        b.order(&s.id).unwrap().avg_fill_price,
        Some(p("20629.00")),
        "the bid (20,645.00) is stale: the trade's price"
    );
    let r = submit(&mut b, stop(main(), Side::Buy, 1, "20600.00"));
    assert_eq!(r.status, OrderStatus::Rejected);
    assert!(r.reason.unwrap().contains("at or below the market"));
}

#[test]
fn a_stop_limit_triggers_then_works_as_a_limit() {
    let mut b = book();
    let o = submit(
        &mut b,
        OrderRequest {
            stop_price: Some(p("20645.00")),
            limit_price: Some(p("20645.25")),
            ..req(main(), Side::Buy, 1, OrderType::StopLimit)
        },
    );
    b.on_quote(&quote("20645.75", 3, "20646.00", 3, "20645.00", t0()), t0());
    b.on_trade(&trade("20645.00", 1), t0());
    let o2 = b.order(&o.id).unwrap().clone();
    assert!(o2.triggered_at.is_some());
    assert_eq!(o2.status, OrderStatus::Working);
    b.on_trade(&trade("20645.00", 1), t0());
    assert_eq!(
        b.order(&o.id).unwrap().status,
        OrderStatus::Filled,
        "traded through"
    );
}

#[test]
fn market_orders_need_an_open_session_and_a_live_price() {
    let mut b = book();
    let closed = Timestamp::parse("2026-10-02T17:30:00-04:00").unwrap();
    let (o, _) = b
        .submit(req(main(), Side::Buy, 1, OrderType::Market), None, closed)
        .unwrap();
    assert_eq!(o.status, OrderStatus::Rejected);
    assert_eq!(
        o.reason.as_deref(),
        Some("NQZ6 is closed. Opens Sun 18:00. Nothing sent.")
    );
    let (o, _) = b
        .submit(limit(main(), Side::Buy, 1, "20600.00"), None, closed)
        .unwrap();
    assert_eq!(o.status, OrderStatus::Working);
    let mut b = book();
    let (o, _) = b
        .submit(req(main(), Side::Buy, 1, OrderType::Market), None, at(600))
        .unwrap();
    assert_eq!(o.status, OrderStatus::Rejected);
    assert!(
        o.reason
            .unwrap()
            .starts_with("No live price for NQZ6 since")
    );
}

#[test]
fn a_market_order_ten_seconds_into_an_outage_is_refused_even_to_close() {
    let mut b = book();
    submit(&mut b, req(main(), Side::Buy, 1, OrderType::Market));
    for side in [Side::Buy, Side::Sell] {
        let (o, _) = b
            .submit(req(main(), side, 1, OrderType::Market), None, at(10))
            .unwrap();
        assert_eq!(o.status, OrderStatus::Rejected, "{side:?}");
        assert_eq!(
            o.reason.as_deref(),
            Some("No live price for NQZ6 since 14:42. Nothing sent.")
        );
    }
    assert_eq!(position(&b, &main()).unwrap().qty, q(1));
}

#[test]
fn a_market_order_fills_once_the_feed_is_back() {
    let mut b = book();
    b.on_quote(
        &quote("20650.00", 4, "20650.25", 4, "20650.00", at(60)),
        at(60),
    );
    let (o, _) = b
        .submit(req(main(), Side::Buy, 1, OrderType::Market), None, at(62))
        .unwrap();
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.avg_fill_price, Some(p("20650.25")));
}

#[test]
fn a_quiet_book_fills_on_its_quotes_however_old_the_last_trade() {
    let mut b = book();
    for (secs, bid_size) in [(60, 11), (120, 9), (180, 14), (240, 12)] {
        b.on_quote(
            &quote("20641.00", bid_size, "20641.25", 12, "20641.25", at(secs)),
            at(secs),
        );
    }
    let (o, _) = b
        .submit(req(main(), Side::Sell, 1, OrderType::Market), None, at(242))
        .unwrap();
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.avg_fill_price, Some(p("20641.00")));
}

#[test]
fn a_book_that_has_not_changed_fills_while_its_feed_is_heard() {
    let mut b = book();
    b.on_feed(&nq(), Feed::Live { heard_at: at(239) });
    let (o, _) = b
        .submit(req(main(), Side::Sell, 1, OrderType::Market), None, at(240))
        .unwrap();
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.avg_fill_price, Some(p("20641.00")));
}

#[test]
fn a_print_keeps_a_quiet_book_live() {
    let mut b = book();
    b.on_trade(
        &Trade {
            ts: at(60),
            ..trade("20641.25", 1)
        },
        at(60),
    );
    let (o, _) = b
        .submit(req(main(), Side::Buy, 1, OrderType::Market), None, at(61))
        .unwrap();
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.avg_fill_price, Some(p("20641.25")));
}

#[test]
fn a_quote_stamped_ahead_of_the_clock_lives_no_longer_than_one_heard_now() {
    let mut b = book();
    b.on_quote(
        &quote("20641.00", 10, "20641.25", 12, "20641.25", at(30)),
        t0(),
    );
    let (o, _) = b
        .submit(req(main(), Side::Buy, 1, OrderType::Market), None, at(10))
        .unwrap();
    assert_eq!(o.status, OrderStatus::Rejected);
}

#[test]
fn a_dropped_feed_refuses_at_once_and_fills_again_once_heard() {
    let mut b = book();
    b.on_feed(&nq(), Feed::Down);
    let (o, _) = b
        .submit(req(main(), Side::Buy, 1, OrderType::Market), None, t0())
        .unwrap();
    assert_eq!(
        o.reason.as_deref(),
        Some("No live price for NQZ6 since 14:42. Nothing sent.")
    );
    b.on_feed(&nq(), Feed::Live { heard_at: at(30) });
    let (o, _) = b
        .submit(req(main(), Side::Buy, 1, OrderType::Market), None, at(31))
        .unwrap();
    assert_eq!(o.status, OrderStatus::Filled);
}

#[test]
fn a_resting_order_fills_on_live_prints_never_on_a_stale_quote() {
    let mut b = book();
    let (o, _) = b
        .submit(limit(main(), Side::Buy, 1, "20643.00"), None, at(10))
        .unwrap();
    assert_eq!(
        o.status,
        OrderStatus::Working,
        "the 20,641.25 ask is ten seconds old"
    );
    b.on_trade(&trade("20642.75", 1), at(11));
    let o = b.order(&o.id).unwrap().clone();
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.avg_fill_price, Some(p("20643.00")));
}

#[test]
fn ioc_cancels_what_does_not_fill_at_once_and_client_ids_dedupe() {
    let mut b = book();
    let o = submit(
        &mut b,
        OrderRequest {
            tif: TimeInForce::Ioc,
            ..limit(main(), Side::Buy, 1, "20600.00")
        },
    );
    assert_eq!(o.status, OrderStatus::Cancelled);
    assert_eq!(
        o.reason.as_deref(),
        Some("IOC: nothing filled at once. Cancelled.")
    );
    let r = OrderRequest {
        client_order_id: Some("click-1".into()),
        ..req(main(), Side::Buy, 1, OrderType::Market)
    };
    let a = submit(&mut b, r.clone());
    let again = submit(&mut b, r);
    assert_eq!(a.id, again.id, "the same client order id is the same order");
    assert_eq!(position(&b, &main()).unwrap().qty, q(1));
}

#[test]
fn reduce_only_never_opens_or_flips() {
    let mut b = book();
    let r = submit(
        &mut b,
        OrderRequest {
            reduce_only: true,
            ..req(main(), Side::Sell, 1, OrderType::Market)
        },
    );
    assert_eq!(r.status, OrderStatus::Rejected);
    assert!(r.reason.unwrap().contains("it would add risk"));
    submit(&mut b, req(main(), Side::Buy, 1, OrderType::Market));
    let o = submit(
        &mut b,
        OrderRequest {
            reduce_only: true,
            ..req(main(), Side::Sell, 3, OrderType::Market)
        },
    );
    assert_eq!(o.filled_qty, q(1));
    assert!(position(&b, &main()).is_none());
}

#[test]
fn a_bracket_waits_for_its_entry_then_works_as_one_oco_pair() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20598.00", Some("20700.00")),
            ..limit(main(), Side::Buy, 2, "20615.00")
        },
    );
    let (s, t) = children(&b, &entry);
    let t = t.unwrap();
    for c in [&s, &t] {
        assert_eq!(c.status, OrderStatus::Held, "dormant until the entry fills");
        assert!(c.request.reduce_only);
        assert_eq!(c.request.side, Side::Sell);
        assert_eq!(c.request.qty, q(2));
    }
    assert_eq!(s.request.order_type, OrderType::Stop);
    assert_eq!(t.request.order_type, OrderType::Limit);
    b.on_quote(&quote("20615.00", 1, "20615.25", 5, "20615.25", t0()), t0());
    b.on_trade(&trade("20615.00", 2), t0());
    let e = b.order(&entry.id).unwrap().clone();
    assert_eq!(
        (e.status, e.filled_qty),
        (OrderStatus::PartiallyFilled, q(1))
    );
    let (s, t) = children(&b, &entry);
    assert_eq!((s.status, s.request.qty), (OrderStatus::Working, q(1)));
    assert_eq!(t.unwrap().request.qty, q(1));
    b.on_trade(&trade("20700.25", 1), t0());
    let (s, t) = children(&b, &entry);
    let t = t.unwrap();
    assert_eq!(t.status, OrderStatus::Filled);
    assert_eq!(t.avg_fill_price, Some(p("20700.00")));
    assert_eq!(s.status, OrderStatus::Cancelled);
    assert_eq!(s.reason.as_deref(), Some("The target filled."));
    assert_eq!(b.order(&entry.id).unwrap().status, OrderStatus::Cancelled);
    assert!(position(&b, &main()).is_none());
    let realized: Decimal = b
        .fills(Some(&main()), t0())
        .iter()
        .filter_map(|f| f.realized_pnl)
        .map(|m| m.amount)
        .sum();
    assert_eq!(realized, Decimal::from(1_700), "85 points × $20");
}

#[test]
fn moving_an_unfilled_entry_carries_its_bracket_at_the_same_distance() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20605.00", Some("20635.00")),
            ..limit(main(), Side::Buy, 1, "20615.00")
        },
    );
    let (moved, _) = b
        .modify(
            &entry.id,
            &OrderChanges {
                limit_price: Some(p("20617.00")),
                ..OrderChanges::default()
            },
            t0(),
        )
        .unwrap();
    let carried = moved.request.bracket.unwrap();
    assert_eq!(
        (carried.stop_loss, carried.take_profit),
        (Some(p("20607.00")), Some(p("20637.00")))
    );
    let (s, t) = children(&b, &entry);
    let t = t.unwrap();
    assert_eq!(
        (s.status, s.request.stop_price),
        (OrderStatus::Held, Some(p("20607.00"))),
        "40 ticks under the entry, as placed"
    );
    assert_eq!(
        (t.status, t.request.limit_price),
        (OrderStatus::Held, Some(p("20637.00"))),
        "80 ticks over it"
    );

    b.on_quote(&quote("20617.00", 1, "20617.25", 5, "20617.25", t0()), t0());
    b.on_trade(&trade("20616.75", 1), t0());
    assert_eq!(b.order(&entry.id).unwrap().status, OrderStatus::Filled);
    let (s, t) = children(&b, &entry);
    assert_eq!(
        (s.status, s.request.stop_price),
        (OrderStatus::Working, Some(p("20607.00")))
    );
    assert_eq!(t.unwrap().request.limit_price, Some(p("20637.00")));
}

#[test]
fn an_entry_moved_past_its_old_target_or_stop_keeps_its_bracket_at_the_same_distance() {
    let cases = [
        (
            Side::Buy,
            "20615.00",
            "20605.00",
            "20635.00",
            "20640.00",
            "20630.00",
            "20660.00",
        ),
        (
            Side::Buy,
            "20615.00",
            "20605.00",
            "20635.00",
            "20600.00",
            "20590.00",
            "20620.00",
        ),
        (
            Side::Sell,
            "20670.00",
            "20680.00",
            "20650.00",
            "20645.00",
            "20655.00",
            "20625.00",
        ),
        (
            Side::Sell,
            "20670.00",
            "20680.00",
            "20650.00",
            "20690.00",
            "20700.00",
            "20670.00",
        ),
    ];
    for (side, at, stop, target, to, moved_stop, moved_target) in cases {
        let mut b = book();
        let entry = submit(
            &mut b,
            OrderRequest {
                bracket: bracket(stop, Some(target)),
                ..limit(main(), side, 1, at)
            },
        );
        let (moved, _) = b
            .modify(
                &entry.id,
                &OrderChanges {
                    limit_price: Some(p(to)),
                    ..OrderChanges::default()
                },
                t0(),
            )
            .unwrap_or_else(|e| panic!("{side:?} {at} → {to}: {e}"));
        assert_eq!(moved.request.limit_price, Some(p(to)));
        let carried = moved.request.bracket.unwrap();
        assert_eq!(
            (carried.stop_loss, carried.take_profit),
            (Some(p(moved_stop)), Some(p(moved_target))),
            "{side:?} {at} → {to}"
        );
        let (s, t) = children(&b, &entry);
        assert_eq!(s.request.stop_price, Some(p(moved_stop)));
        assert_eq!(t.unwrap().request.limit_price, Some(p(moved_target)));
    }
}

#[test]
fn the_stop_side_closes_the_trade_and_cancelling_an_unfilled_entry_takes_its_bracket() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20598.00", Some("20700.00")),
            ..req(main(), Side::Buy, 1, OrderType::Market)
        },
    );
    assert_eq!(entry.status, OrderStatus::Filled);
    let (s, _) = children(&b, &entry);
    assert_eq!(s.status, OrderStatus::Working);
    b.on_quote(&quote("20597.50", 3, "20597.75", 3, "20598.00", t0()), t0());
    b.on_trade(&trade("20598.00", 1), t0());
    let (s, t) = children(&b, &entry);
    assert_eq!(s.status, OrderStatus::Filled);
    assert_eq!(
        s.avg_fill_price,
        Some(p("20597.50")),
        "the bid after the trigger"
    );
    assert_eq!(t.unwrap().status, OrderStatus::Cancelled);
    assert!(position(&b, &main()).is_none());

    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20500.00", None),
            ..limit(main(), Side::Buy, 1, "20550.00")
        },
    );
    b.cancel(&entry.id, t0()).unwrap();
    let (s, t) = children(&b, &entry);
    assert!(t.is_none());
    assert_eq!(s.status, OrderStatus::Cancelled);
    assert_eq!(s.reason.as_deref(), Some("The entry did not fill."));
}

#[test]
fn closing_the_position_by_hand_cancels_its_working_exits() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20598.00", Some("20700.00")),
            ..req(main(), Side::Buy, 1, OrderType::Market)
        },
    );
    submit(
        &mut b,
        OrderRequest {
            reduce_only: true,
            ..req(main(), Side::Sell, 1, OrderType::Market)
        },
    );
    let (s, t) = children(&b, &entry);
    assert_eq!(s.status, OrderStatus::Cancelled);
    assert_eq!(
        t.unwrap().reason.as_deref(),
        Some("The position is closed.")
    );
}

#[test]
fn a_working_leg_resized_takes_its_pair_along_and_keeps_its_size_as_the_entry_fills() {
    let mut b = funded(book());
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20598.00", Some("20700.00")),
            ..limit(main(), Side::Buy, 4, "20615.00")
        },
    );
    b.on_quote(&quote("20615.00", 1, "20615.25", 5, "20615.25", t0()), t0());
    b.on_trade(&trade("20615.00", 2), t0());
    let (s, t) = children(&b, &entry);
    assert_eq!((s.request.qty, t.unwrap().request.qty), (q(1), q(1)));
    let (s, _) = children(&b, &entry);
    b.modify(
        &s.id,
        &OrderChanges {
            qty: Some(q(6)),
            ..OrderChanges::default()
        },
        t0(),
    )
    .unwrap();
    let (s, t) = children(&b, &entry);
    assert_eq!((s.request.qty, t.unwrap().request.qty), (q(6), q(6)));
    b.on_trade(&trade("20615.00", 2), t0());
    let e = b.order(&entry.id).unwrap().clone();
    assert_eq!(e.filled_qty, q(3));
    let (s, t) = children(&b, &entry);
    assert_eq!((s.request.qty, t.unwrap().request.qty), (q(8), q(8)));
}

#[test]
fn a_target_filled_in_part_shrinks_its_stop_and_completing_it_ends_the_pair() {
    let mut b = funded(book());
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20598.00", Some("20650.00")),
            ..req(main(), Side::Buy, 2, OrderType::Market)
        },
    );
    submit(&mut b, req(main(), Side::Buy, 8, OrderType::Market));
    let (s, _) = children(&b, &entry);
    b.modify(
        &s.id,
        &OrderChanges {
            qty: Some(q(10)),
            ..OrderChanges::default()
        },
        t0(),
    )
    .unwrap();
    b.on_quote(&quote("20649.75", 3, "20650.00", 0, "20650.00", t0()), t0());
    let (_, t) = children(&b, &entry);
    let t = t.unwrap();
    assert_eq!(t.queue_ahead, Some(q(0)));
    b.on_trade(&trade("20650.00", 4), t0());
    let (s, t) = children(&b, &entry);
    let t = t.unwrap();
    assert_eq!(
        (t.status, t.filled_qty),
        (OrderStatus::PartiallyFilled, q(4))
    );
    assert_eq!(s.request.qty, q(6), "the stop takes the target's remainder");
    b.on_trade(&trade("20650.25", 1), t0());
    assert!(position(&b, &main()).is_none());
    let (s, t) = children(&b, &entry);
    assert_eq!(t.unwrap().status, OrderStatus::Filled);
    assert_eq!(s.status, OrderStatus::Cancelled);
}

#[test]
fn legs_attach_to_a_filled_entry_on_their_side_of_the_market() {
    let mut b = funded(book());
    let add = submit(&mut b, req(main(), Side::Buy, 3, OrderType::Market));
    let wrong = Bracket {
        stop_loss: Some(p("20650.00")),
        ..Bracket::default()
    };
    assert!(b.attach_bracket(&add.id, wrong, q(3), t0()).is_err());
    let rest = submit(&mut b, limit(main(), Side::Buy, 1, "20600.00"));
    assert!(
        b.attach_bracket(&rest.id, bracket("20590.00", None).unwrap(), q(1), t0())
            .is_err()
    );
    let (legs, _) = b
        .attach_bracket(
            &add.id,
            bracket("20620.00", Some("20700.00")).unwrap(),
            q(5),
            t0(),
        )
        .unwrap();
    assert_eq!(legs.len(), 2);
    for l in &legs {
        assert_eq!(l.status, OrderStatus::Working);
        assert_eq!(l.request.qty, q(5));
        assert!(l.request.reduce_only);
        assert_eq!(l.parent_id.as_ref(), Some(&add.id));
    }
    assert!(
        b.attach_bracket(&add.id, bracket("20620.00", None).unwrap(), q(5), t0())
            .is_err()
    );
}

#[test]
fn positions_average_realize_flip_and_charge_commissions() {
    let mut b = book_with(PaperConfig {
        commission: Commission {
            standard: Decimal::from_str("2.14").unwrap(),
            ..Commission::NONE
        },
        ..PaperConfig::default()
    });
    b.on_quote(&quote("20600.00", 5, "20600.25", 5, "20600.25", t0()), t0());
    submit(&mut b, req(main(), Side::Buy, 1, OrderType::Market));
    b.on_quote(&quote("20610.00", 5, "20610.25", 5, "20610.25", t0()), t0());
    submit(&mut b, req(main(), Side::Buy, 1, OrderType::Market));
    let pos = position(&b, &main()).unwrap();
    assert_eq!(pos.qty, q(2));
    assert_eq!(pos.avg_price, p("20605.25"));
    assert_eq!(
        pos.unrealized_pnl,
        Some(money("200")),
        "marked at the last, 20,610.25"
    );
    submit(&mut b, req(main(), Side::Sell, 3, OrderType::Market));
    let pos = position(&b, &main()).unwrap();
    assert_eq!(pos.qty, q(-1));
    assert_eq!(pos.avg_price, p("20610.00"));
    let fills = b.fills(Some(&main()), t0());
    assert_eq!(fills[2].realized_pnl, Some(money("190")));
    assert_eq!(fills[2].fee, money("6.42"));
    let s = b.summary(&main(), t0()).unwrap();
    assert_eq!(s.realized_today, money("190"));
    assert_eq!(s.fees_today, money("10.70"), "5 contracts × $2.14");
    assert_eq!(s.balance, money("100179.30"), "100,000 + 190 − 10.70");
    assert_eq!(s.open_pnl, money("-5"));
    assert_eq!(s.net_liq, money("100174.30"));
    assert_eq!(s.day_pnl, money("174.30"));
    assert_eq!(s.unrealized_today, money("-5"));
}

fn mnq() -> InstrumentId {
    InstrumentId::new("MNQZ6.CME").unwrap()
}

#[test]
fn a_paper_fill_pays_a_retail_commission_by_its_contract_class() {
    let mut b = book_with(PaperConfig::default());
    let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
    b.set_market(cat.spec(&mnq()).unwrap().clone(), true);
    let touch = quote("20641.00", 10, "20641.25", 12, "20641.25", t0());
    b.on_quote(&touch, t0());
    b.on_quote(
        &Quote {
            instrument: mnq(),
            ..touch
        },
        t0(),
    );
    submit(&mut b, req(main(), Side::Buy, 1, OrderType::Market));
    submit(
        &mut b,
        OrderRequest {
            instrument: mnq(),
            ..req(main(), Side::Buy, 3, OrderType::Market)
        },
    );
    let fees: Vec<Money> = b.fills(Some(&main()), t0()).iter().map(|f| f.fee).collect();
    assert_eq!(
        fees,
        [money("2.87"), money("2.82")],
        "NQ 1 × $2.87 a side, MNQ 3 × $0.94 a side"
    );
    let s = b.summary(&main(), t0()).unwrap();
    assert_eq!(s.fees_today, money("5.69"));
    assert_eq!(s.balance, money("99994.31"));
}

#[test]
fn today_starts_at_zero_and_moves_by_exactly_what_the_fills_made() {
    let mut b = book_with(PaperConfig::default());
    b.on_quote(
        &quote("20641.00", 10, "20641.25", 12, "20641.25", t0()),
        t0(),
    );
    assert_eq!(b.summary(&main(), t0()).unwrap().day_pnl, money("0"));
    submit(&mut b, req(main(), Side::Buy, 2, OrderType::Market));
    b.on_quote(
        &quote("20651.00", 10, "20651.25", 12, "20651.25", at(60)),
        at(60),
    );
    let s = b.summary(&main(), at(60)).unwrap();
    assert_eq!(s.open_pnl, money("400"), "10 points × $20 × 2");
    assert_eq!(s.day_pnl, money("394.26"), "less the entry's 2 × $2.87");
    b.submit(req(main(), Side::Sell, 2, OrderType::Market), None, at(60))
        .unwrap();
    let s = b.summary(&main(), at(60)).unwrap();
    assert_eq!(s.realized_today, money("390"), "sold at the bid, 20,651.00");
    assert_eq!(s.fees_today, money("11.48"));
    assert_eq!(s.day_pnl, money("378.52"));
    let made: Decimal = b
        .fills(Some(&main()), t0())
        .iter()
        .map(|f| f.realized_pnl.map_or(Decimal::ZERO, |r| r.amount) - f.fee.amount)
        .sum();
    assert_eq!(s.day_pnl.amount, made);
}

fn eval_down_310() -> Book {
    let mut b = funded(book());
    b.on_quote(&quote("20600.00", 5, "20600.25", 5, "20600.25", t0()), t0());
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20590.00", None),
            ..req(eval(), Side::Buy, 1, OrderType::Market)
        },
    );
    assert_eq!(entry.status, OrderStatus::Filled, "{entry:?}");
    b.on_quote(&quote("20584.75", 5, "20585.00", 5, "20585.00", t0()), t0());
    submit(
        &mut b,
        OrderRequest {
            reduce_only: true,
            ..req(eval(), Side::Sell, 1, OrderType::Market)
        },
    );
    assert_eq!(b.summary(&eval(), t0()).unwrap().day_pnl, money("-310"));
    b.on_quote(
        &quote("20641.00", 10, "20641.25", 12, "20641.25", t0()),
        t0(),
    );
    b
}

fn plan_a(qty: i64) -> OrderRequest {
    OrderRequest {
        bracket: bracket("20598.00", Some("20700.00")),
        ..limit(eval(), Side::Buy, qty, "20615.00")
    }
}

#[test]
fn the_simulator_refuses_nothing_for_risk_with_the_margin_for_it() {
    let mut b = eval_down_310();
    let preview = b.preview(&plan_a(20), t0()).unwrap();
    assert!(preview.checks.is_empty(), "{:?}", preview.checks);
    assert_eq!(
        preview.risk_to_stop,
        Some(money("6800")),
        "17 points × 20 × $20"
    );
    let o = submit(&mut b, plan_a(20));
    assert_eq!(o.status, OrderStatus::Working, "{o:?}");
    let big = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20500.00", None),
            ..req(eval(), Side::Buy, 5, OrderType::Market)
        },
    );
    assert_eq!(big.status, OrderStatus::Filled, "{big:?}");
    b.on_quote(
        &quote("20541.00", 10, "20541.25", 12, "20541.25", at(1)),
        at(1),
    );
    assert_eq!(position(&b, &eval()).unwrap().qty, q(5));
    assert!(b.summary(&eval(), at(1)).unwrap().day_pnl.amount < Decimal::from(-10_000));
    let more = submit(&mut b, req(eval(), Side::Buy, 1, OrderType::Market));
    assert_eq!(more.status, OrderStatus::Filled, "{more:?}");
}

#[test]
fn an_entry_without_a_stop_is_the_traders_call() {
    let mut b = eval_down_310();
    let o = submit(&mut b, limit(eval(), Side::Buy, 1, "20600.00"));
    assert_eq!(o.status, OrderStatus::Working, "{o:?}");
    let o = submit(&mut b, req(eval(), Side::Buy, 1, OrderType::Market));
    assert_eq!(o.status, OrderStatus::Filled, "{o:?}");
}

#[test]
fn moving_a_stop_away_is_the_traders_call_and_through_the_market_is_refused() {
    let mut b = eval_down_310();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20630.00", None),
            ..req(eval(), Side::Buy, 1, OrderType::Market)
        },
    );
    let (s, _) = children(&b, &entry);
    let away = OrderChanges {
        stop_price: Some(p("20600.00")),
        ..OrderChanges::default()
    };
    let (moved, _) = b.modify(&s.id, &away, t0()).unwrap();
    assert_eq!(moved.request.stop_price, Some(p("20600.00")));
    let closer = OrderChanges {
        stop_price: Some(p("20635.00")),
        ..OrderChanges::default()
    };
    let (moved, _) = b.modify(&s.id, &closer, t0()).unwrap();
    assert_eq!(moved.request.stop_price, Some(p("20635.00")));
    let through = OrderChanges {
        stop_price: Some(p("20645.00")),
        ..OrderChanges::default()
    };
    assert!(
        b.modify(&s.id, &through, t0()).is_err(),
        "through the market"
    );
}

#[test]
fn day_orders_expire_at_the_session_change() {
    let mut b = book();
    let day = submit(&mut b, limit(main(), Side::Buy, 1, "20500.00"));
    let gtc = submit(
        &mut b,
        OrderRequest {
            tif: TimeInForce::Gtc,
            ..limit(main(), Side::Buy, 1, "20500.00")
        },
    );
    let evening = Timestamp::parse("2026-10-02T18:00:00-04:00").unwrap();
    let ch = b.roll(evening);
    assert!(ch.accounts.contains(&main()));
    assert_eq!(b.order(&day.id).unwrap().status, OrderStatus::Expired);
    assert_eq!(b.order(&gtc.id).unwrap().status, OrderStatus::Working);
}

#[test]
fn money_reads_like_the_trader_writes_it() {
    assert_eq!(usd(Decimal::from(690)), "$690");
    assert_eq!(usd(Decimal::from(124_820)), "$124,820");
    assert_eq!(usd(Decimal::from_str("12.5").unwrap()), "$12.50");
    assert_eq!(usd(Decimal::from_str("-105").unwrap()), "−$105");
}

#[test]
fn adv_a_limit_moved_through_the_market_never_fills_at_a_price_nobody_printed() {
    let mut b = book();
    let o = submit(&mut b, limit(main(), Side::Buy, 1, "20630.00"));
    assert_eq!(o.status, OrderStatus::Working);
    let up = OrderChanges {
        limit_price: Some(p("20650.00")),
        ..OrderChanges::default()
    };
    let (m, _) = b.modify(&o.id, &up, t0()).unwrap();
    eprintln!("after modify: {:?} {:?}", m.status, m.avg_fill_price);
    b.on_trade(&trade("20641.25", 1), t0());
    let o = b.order(&o.id).unwrap().clone();
    eprintln!("after trade: {:?} {:?}", o.status, o.avg_fill_price);
    assert_eq!(o.avg_fill_price, Some(p("20641.25")), "the ask, not 20,650");
}

#[test]
fn adv_an_eval_position_without_a_stop_does_not_block_the_next_entry() {
    let mut b = eval_down_310();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20630.00", None),
            ..req(eval(), Side::Buy, 2, OrderType::Market)
        },
    );
    assert_eq!(entry.status, OrderStatus::Filled);
    let (s, _) = children(&b, &entry);
    b.cancel(&s.id, t0()).unwrap();
    let preview = b.preview(&plan_a(1), t0()).unwrap();
    assert!(preview.checks.is_empty(), "{:?}", preview.checks);
}

#[test]
fn adv_closing_by_hand_after_a_partial_entry_never_leaves_its_rest_unprotected() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: bracket("20598.00", Some("20700.00")),
            ..limit(main(), Side::Buy, 2, "20615.00")
        },
    );
    b.on_quote(&quote("20615.00", 1, "20615.25", 5, "20615.25", t0()), t0());
    b.on_trade(&trade("20615.00", 2), t0());
    assert_eq!(b.order(&entry.id).unwrap().filled_qty, q(1));
    submit(
        &mut b,
        OrderRequest {
            reduce_only: true,
            ..req(main(), Side::Sell, 1, OrderType::Market)
        },
    );
    assert!(position(&b, &main()).is_none());
    let e = b.order(&entry.id).unwrap().clone();
    eprintln!("entry after the hand close: {:?}", e.status);
    b.on_trade(&trade("20614.75", 1), t0());
    let pos = position(&b, &main());
    let (s, t) = children(&b, &entry);
    eprintln!(
        "pos {pos:?}\nstop {:?} {:?}\ntarget {:?}",
        s.status,
        s.request.qty,
        t.map(|t| t.status)
    );
    if let Some(pos) = pos {
        let covered = b.orders(Some(&main())).iter().any(|o| {
            o.request.reduce_only
                && o.request.order_type == OrderType::Stop
                && o.status == OrderStatus::Working
        });
        assert!(covered, "long {} with no working stop", pos.qty);
    }
}

#[test]
fn adv_a_market_entrys_bracket_is_checked_against_the_market() {
    let b = book();
    let preview = b
        .preview(
            &OrderRequest {
                bracket: bracket("20700.00", Some("20600.00")),
                ..req(main(), Side::Buy, 1, OrderType::Market)
            },
            t0(),
        )
        .unwrap();
    let messages: Vec<&str> = preview
        .checks
        .iter()
        .filter(|c| c.severity == CheckSeverity::Block && c.code == "bracket_side")
        .map(|c| c.message.as_str())
        .collect();
    assert_eq!(
        messages,
        [
            "Stop 20,700.00 is at or above the market (20,641.25): it would stop out at once.",
            "Target 20,600.00 is at or below the market (20,641.25): it would fill at once.",
        ]
    );
}

fn from_fill(stop_ticks: u32, target_ticks: u32) -> Option<Bracket> {
    serde_json::from_value(serde_json::json!({
        "stopLoss": null,
        "takeProfit": null,
        "stopTicks": stop_ticks,
        "targetTicks": target_ticks,
    }))
    .unwrap()
}

fn ticks_from_fill(b: &Book, entry: &Order) -> (Decimal, Decimal) {
    let entry = b.order(&entry.id).unwrap().clone();
    let fill = entry.avg_fill_price.expect("the entry filled").0;
    let (stop, target) = children(b, &entry);
    let target = target.expect("a target");
    assert_eq!(
        (stop.status, target.status),
        (OrderStatus::Working, OrderStatus::Working)
    );
    let toward_profit = Decimal::from(entry.request.side.sign());
    let tick = Decimal::from_str("0.25").unwrap();
    (
        (fill - stop.request.stop_price.unwrap().0) * toward_profit / tick,
        (target.request.limit_price.unwrap().0 - fill) * toward_profit / tick,
    )
}

fn market_moves_to(b: &mut Book, bid: &str, ask: &str) {
    b.on_quote(&quote(bid, 10, ask, 10, ask, t0()), t0());
}

#[test]
fn a_market_entrys_legs_sit_their_ticks_from_its_fill_however_far_the_market_moved() {
    let cases = [
        (
            "buy at 20,623.75",
            Side::Buy,
            ("20623.50", "20623.75"),
            40,
            80,
        ),
        (
            "buy at 20,684.75",
            Side::Buy,
            ("20684.50", "20684.75"),
            40,
            80,
        ),
        (
            "sell at 20,624.00",
            Side::Sell,
            ("20624.00", "20624.25"),
            40,
            80,
        ),
        (
            "sell at 20,700.00",
            Side::Sell,
            ("20700.00", "20700.25"),
            40,
            80,
        ),
        (
            "wide buy at 20,623.75",
            Side::Buy,
            ("20623.50", "20623.75"),
            160,
            320,
        ),
        (
            "wide sell at 20,684.50",
            Side::Sell,
            ("20684.50", "20684.75"),
            160,
            320,
        ),
    ];
    for (case, side, (bid, ask), stop, target) in cases {
        let mut b = book();
        market_moves_to(&mut b, bid, ask);
        let entry = submit(
            &mut b,
            OrderRequest {
                bracket: from_fill(stop, target),
                ..req(main(), side, 2, OrderType::Market)
            },
        );
        assert_eq!(entry.status, OrderStatus::Filled, "{case}");
        let fill = if side == Side::Buy { ask } else { bid };
        assert_eq!(entry.avg_fill_price, Some(p(fill)), "{case}");
        assert_eq!(
            ticks_from_fill(&b, &entry),
            (Decimal::from(stop), Decimal::from(target)),
            "{case}"
        );
    }
}

#[test]
fn an_entry_whose_fill_passed_the_stop_distance_still_goes_with_its_legs() {
    let mut b = book();
    market_moves_to(&mut b, "20628.50", "20628.75");
    let r = OrderRequest {
        bracket: from_fill(40, 80),
        ..req(main(), Side::Buy, 2, OrderType::Market)
    };
    let preview = b.preview(&r, t0()).unwrap();
    assert!(preview.passes(), "{:?}", preview.checks);
    assert_eq!(preview.risk_to_stop, Some(money("400")));
    let entry = submit(&mut b, r);
    assert_eq!(entry.status, OrderStatus::Filled);
    assert_eq!(
        ticks_from_fill(&b, &entry),
        (Decimal::from(40), Decimal::from(80))
    );
}

#[test]
fn a_stop_entrys_legs_follow_its_slipped_fill_unless_the_trader_moved_them() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: from_fill(40, 80),
            ..stop(main(), Side::Buy, 1, "20650.00")
        },
    );
    let (held_stop, held_target) = children(&b, &entry);
    let held_target = held_target.unwrap();
    assert_eq!(held_stop.request.stop_price, Some(p("20640.00")));
    assert_eq!(held_target.request.limit_price, Some(p("20670.00")));
    b.modify(
        &held_stop.id,
        &OrderChanges {
            stop_price: Some(p("20630.00")),
            ..OrderChanges::default()
        },
        t0(),
    )
    .unwrap();
    market_moves_to(&mut b, "20655.00", "20655.25");
    b.on_trade(&trade("20655.25", 1), t0());
    let entry = b.order(&entry.id).unwrap().clone();
    assert_eq!(entry.avg_fill_price, Some(p("20655.25")));
    let (s, t) = children(&b, &entry);
    assert_eq!(
        s.request.stop_price,
        Some(p("20630.00")),
        "the trader's stop"
    );
    assert_eq!(
        t.unwrap().request.limit_price,
        Some(p("20675.25")),
        "80 ticks from the fill"
    );
}

#[test]
fn legs_in_ticks_attach_from_a_filled_entrys_fill() {
    let mut b = book();
    let add = submit(&mut b, req(main(), Side::Sell, 1, OrderType::Market));
    let (legs, _) = b
        .attach_bracket(&add.id, from_fill(40, 80).unwrap(), q(1), t0())
        .unwrap();
    let at = |role| {
        legs.iter()
            .find(|l| l.role == role)
            .map(|l| l.request.stop_price.or(l.request.limit_price))
    };
    assert_eq!(at(OrderRole::StopLoss), Some(Some(p("20651.00"))));
    assert_eq!(at(OrderRole::TakeProfit), Some(Some(p("20621.00"))));
}

#[test]
fn adv_pnl_reconciles_to_fills_under_a_random_walk() {
    let mut b = book_with(PaperConfig {
        commission: Commission {
            standard: Decimal::from_str("1.25").unwrap(),
            ..Commission::NONE
        },
        ..PaperConfig::default()
    });
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    let mut mid = Decimal::from_str("20641.00").unwrap();
    let tick = Decimal::from_str("0.25").unwrap();
    for step in 0..2000 {
        let now = t0();
        let delta = Decimal::from(rnd(9) as i64 - 4) * tick;
        mid += delta;
        let bid = mid;
        let ask = mid + tick;
        let last = if rnd(2) == 0 { bid } else { ask };
        b.on_quote(
            &Quote {
                instrument: nq(),
                ts: now,
                bid: Some(Price(bid)),
                bid_size: Some(q(rnd(8) as i64 + 1)),
                ask: Some(Price(ask)),
                ask_size: Some(q(rnd(8) as i64 + 1)),
                last: Some(Price(last)),
                last_size: Some(q(1)),
                session: None,
                source: None,
            },
            now,
        );
        let tp = Price(mid + Decimal::from(rnd(3) as i64 - 1) * tick);
        b.on_trade(
            &Trade {
                price: tp,
                size: q(rnd(5) as i64 + 1),
                ..trade("20641.00", 1)
            },
            now,
        );
        let acct = if rnd(3) == 0 { eval() } else { main() };
        let side = if rnd(2) == 0 { Side::Buy } else { Side::Sell };
        let qty = rnd(3) as i64 + 1;
        let off = |k: u64| Decimal::from(k as i64) * tick;
        let stop_px = match side {
            Side::Buy => mid - off(rnd(20) + 4),
            Side::Sell => mid + tick + off(rnd(20) + 4),
        };
        let tp_px = match side {
            Side::Buy => mid + tick + off(rnd(20) + 4),
            Side::Sell => mid - off(rnd(20) + 4),
        };
        let r = match rnd(7) {
            0 => OrderRequest {
                bracket: Some(Bracket {
                    stop_loss: Some(Price(stop_px)),
                    take_profit: Some(Price(tp_px)),
                    ..Bracket::default()
                }),
                ..req(acct.clone(), side, qty, OrderType::Market)
            },
            1 | 2 => {
                let lp = match side {
                    Side::Buy => mid - off(rnd(6)),
                    Side::Sell => mid + tick + off(rnd(6)),
                };
                let entry = Price(lp);
                let stop = match side {
                    Side::Buy => Price(lp - off(rnd(12) + 2)),
                    Side::Sell => Price(lp + off(rnd(12) + 2)),
                };
                let tgt = match side {
                    Side::Buy => Price(lp + off(rnd(12) + 2)),
                    Side::Sell => Price(lp - off(rnd(12) + 2)),
                };
                OrderRequest {
                    limit_price: Some(entry),
                    bracket: Some(Bracket {
                        stop_loss: Some(stop),
                        take_profit: if rnd(2) == 0 { Some(tgt) } else { None },
                        ..Bracket::default()
                    }),
                    ..req(acct.clone(), side, qty, OrderType::Limit)
                }
            }
            3 => OrderRequest {
                reduce_only: true,
                ..req(acct.clone(), side, qty, OrderType::Market)
            },
            4 => req(main(), side, qty, OrderType::Market),
            5 => {
                let open: Vec<Order> = b
                    .orders(Some(&acct))
                    .into_iter()
                    .filter(|o| o.status.is_open())
                    .collect();
                if !open.is_empty() {
                    let o = &open[rnd(open.len() as u64) as usize];
                    if rnd(2) == 0 {
                        let _ = b.cancel(&o.id, now);
                    } else if o.request.limit_price.is_some() {
                        let np = Price(
                            o.request.limit_price.unwrap().0
                                + Decimal::from(rnd(9) as i64 - 4) * tick,
                        );
                        let _ = b.modify(
                            &o.id,
                            &OrderChanges {
                                limit_price: Some(np),
                                ..OrderChanges::default()
                            },
                            now,
                        );
                    }
                }
                continue;
            }
            _ => continue,
        };
        let _ = b.submit(r, None, now);

        for a in [main(), eval()] {
            let fills = b.fills(Some(&a), Timestamp(0));
            let acct = b.account(&a).unwrap().clone();
            let realized: Decimal = fills
                .iter()
                .filter_map(|f| f.realized_pnl)
                .map(|m| m.amount)
                .sum();
            let fees: Decimal = fills.iter().map(|f| f.fee.amount).sum();
            assert_eq!(
                acct.balance.amount,
                acct.starting_balance.amount + realized - fees,
                "step {step}: balance reconciles to fills on {a}"
            );
            let mult = Decimal::from(20);
            let (mut pos, mut avg) = (Decimal::ZERO, Decimal::ZERO);
            let (mut trip_cash, mut trip_realized) = (Decimal::ZERO, Decimal::ZERO);
            for f in &fills {
                let qd = f.qty.0 * Decimal::from(f.side.sign());
                if pos.is_zero() || pos.signum() == qd.signum() {
                    avg = (avg * pos.abs() + f.price.0 * f.qty.0) / (pos.abs() + f.qty.0);
                    pos += qd;
                    trip_cash -= qd * f.price.0 * mult;
                } else {
                    let closing = f.qty.0.min(pos.abs());
                    let r = (f.price.0 - avg) * closing * pos.signum() * mult;
                    let got = f.realized_pnl.expect("a closing fill realizes").amount;
                    assert_eq!(got, got.round_dp(2), "step {step}: realized in cents");
                    assert!(
                        (got - r).abs() < Decimal::ONE,
                        "step {step}: fill realized {got} vs {r}"
                    );
                    trip_realized += got;
                    trip_cash += closing * pos.signum() * f.price.0 * mult;
                    let after = pos + qd;
                    if after.is_zero() || after.signum() != pos.signum() {
                        assert_eq!(
                            trip_realized, trip_cash,
                            "step {step}: the round trip is exact"
                        );
                        trip_realized = Decimal::ZERO;
                        trip_cash = -after * f.price.0 * mult;
                        avg = f.price.0;
                    }
                    pos = after;
                }
            }
            let p = b.positions(Some(&a)).into_iter().next();
            assert_eq!(
                p.as_ref().map_or(Decimal::ZERO, |p| p.qty.0),
                pos,
                "step {step}: position = fills"
            );
            if let Some(p) = &p {
                assert!(
                    (p.avg_price.0 - avg).abs() < Decimal::new(1, 2),
                    "step {step}: avg"
                );
            }
            let s = b.summary(&a, t0()).unwrap();
            let open: Decimal = p
                .as_ref()
                .and_then(|p| p.unrealized_pnl)
                .map_or(Decimal::ZERO, |m| m.amount);
            assert_eq!(
                s.net_liq.amount,
                acct.balance.amount + open,
                "step {step}: net liq"
            );
            if p.is_none() {
                assert!(
                    b.orders(Some(&a))
                        .iter()
                        .all(|o| !(o.request.reduce_only && o.status.is_working())),
                    "step {step}: a working exit on a flat {a}"
                );
            }
            for o in b.orders(Some(&a)) {
                if let Some(pid) = &o.parent_id
                    && o.status.is_working()
                {
                    let e = b.order(pid).unwrap();
                    assert!(!e.filled_qty.is_zero(), "step {step}: an orphan leg");
                }
            }
        }
    }
}

#[tokio::test]
#[ignore = "deferred: marks are written with fills only, so a restart shows the last fill's mark until the first quote"]
async fn adv_restart_keeps_marks() {
    use std::sync::Arc;
    use tessera_core::SharedClock;
    use tessera_core::clock::ManualClock;
    use tessera_market::{MarketDataProvider, MockConfig, MockMarket};
    let manual = Arc::new(ManualClock::new(t0()));
    let clock: SharedClock = manual.clone();
    let mk = || {
        let mut cfg = MockConfig::new(Arc::clone(&clock));
        cfg.intraday_sessions = 1;
        cfg.daily_sessions = 5;
        Arc::new(MockMarket::new(cfg)) as Arc<dyn MarketDataProvider>
    };
    let store = tessera_store::Store::open_in_memory().unwrap();
    let broker = super::PaperBroker::open(
        mk(),
        Arc::clone(&clock),
        Some(store.clone()),
        PaperConfig::default(),
        &test_seeds(),
    )
    .await
    .unwrap();
    broker.load(&nq()).await.unwrap();
    {
        let mut book = broker.book.lock();
        let ch = book.on_quote(
            &quote("20641.00", 10, "20641.25", 12, "20641.25", t0()),
            t0(),
        );
        broker.dispatch(&book, ch, t0());
        let (_, ch) = book
            .submit(req(main(), Side::Buy, 2, OrderType::Market), None, t0())
            .unwrap();
        broker.dispatch(&book, ch, t0());
        let ch = book.on_quote(
            &quote("20661.00", 10, "20661.25", 12, "20661.25", at(5)),
            at(5),
        );
        broker.dispatch(&book, ch, at(5));
    }
    broker.flush().await;
    let before = broker.book.lock().summary(&main(), at(5)).unwrap();
    drop(broker);
    let again = super::PaperBroker::open(
        mk(),
        Arc::clone(&clock),
        Some(store),
        PaperConfig::default(),
        &test_seeds(),
    )
    .await
    .unwrap();
    let after = again.book.lock().summary(&main(), at(5)).unwrap();
    eprintln!("before {:?} after {:?}", before.net_liq, after.net_liq);
    assert_eq!(after.net_liq, before.net_liq);
    assert_eq!(after.open_pnl, before.open_pnl);
}

#[test]
fn adv_round_trip_realized_is_exact() {
    let mut b = funded(book());
    submit(&mut b, req(main(), Side::Buy, 1, OrderType::Market));
    b.on_quote(
        &quote("20640.75", 10, "20641.00", 12, "20641.25", t0()),
        t0(),
    );
    submit(&mut b, req(main(), Side::Buy, 1, OrderType::Market));
    b.on_quote(
        &quote("20640.75", 10, "20641.00", 12, "20641.00", t0()),
        t0(),
    );
    submit(&mut b, req(main(), Side::Buy, 1, OrderType::Market));
    let pos = position(&b, &main()).unwrap();
    eprintln!("avg {}", pos.avg_price.0);
    b.on_quote(
        &quote("20650.00", 10, "20650.25", 12, "20650.00", t0()),
        t0(),
    );
    submit(&mut b, req(main(), Side::Sell, 1, OrderType::Market));
    submit(&mut b, req(main(), Side::Sell, 2, OrderType::Market));
    let fills = b.fills(Some(&main()), t0());
    let realized: Decimal = fills
        .iter()
        .filter_map(|f| f.realized_pnl)
        .map(|m| m.amount)
        .sum();
    let cash: Decimal = fills
        .iter()
        .map(|f| -Decimal::from(f.side.sign()) * f.qty.0 * f.price.0 * Decimal::from(20))
        .sum();
    eprintln!(
        "realized {realized} cash {cash} per fill {:?}",
        fills
            .iter()
            .map(|f| f.realized_pnl.map(|m| m.amount))
            .collect::<Vec<_>>()
    );
    assert_eq!(realized, cash);
    let s = b.summary(&main(), t0()).unwrap();
    eprintln!("balance {}", s.balance.amount);
}

fn rules_bracket(
    stop_loss: &str,
    take_profit: Option<&str>,
    breakeven: Option<(u32, u32)>,
    trail: Option<u32>,
) -> Option<Bracket> {
    Some(Bracket {
        stop_loss: Some(p(stop_loss)),
        take_profit: take_profit.map(p),
        breakeven: breakeven.map(|(trigger_ticks, offset_ticks)| BreakevenRule {
            trigger_ticks,
            offset_ticks,
        }),
        trail: trail.map(|distance_ticks| TrailRule {
            distance_ticks,
            trigger_ticks: 0,
            step_ticks: 1,
        }),
        ..Bracket::default()
    })
}

fn print(b: &mut Book, price: &str) {
    let px = p(price);
    let bid = Price(px.0 - Decimal::from_str("0.25").unwrap());
    b.on_quote(
        &Quote {
            bid: Some(bid),
            ask: Some(px),
            last: Some(px),
            ..quote("1", 10, "1", 12, "1", t0())
        },
        t0(),
    );
    b.on_trade(&trade(price, 1), t0());
}

fn stop_price(b: &Book, entry: &Order) -> Price {
    children(b, entry).0.request.stop_price.unwrap()
}

#[test]
fn breakeven_fires_once_and_moves_the_stop_to_the_entry_plus_its_offset() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: rules_bracket("20631.25", Some("20681.25"), Some((8, 1)), None),
            ..req(main(), Side::Buy, 1, OrderType::Market)
        },
    );
    assert_eq!(entry.avg_fill_price, Some(p("20641.25")));
    let (s, _) = children(&b, &entry);
    let rules = s.stop_rules.expect("the stop carries the bracket's rules");
    assert_eq!(
        rules.entry_price,
        Some(p("20641.25")),
        "measured from the fill"
    );
    assert!(!rules.breakeven_done);
    print(&mut b, "20643.00");
    assert_eq!(stop_price(&b, &entry), p("20631.25"));
    print(&mut b, "20643.25");
    let (s, _) = children(&b, &entry);
    assert_eq!(s.request.stop_price, Some(p("20641.50")));
    assert!(s.stop_rules.unwrap().breakeven_done);
    assert_eq!(s.status, OrderStatus::Working);
    print(&mut b, "20642.00");
    assert_eq!(stop_price(&b, &entry), p("20641.50"));
    let (s, _) = children(&b, &entry);
    b.modify(
        &s.id,
        &OrderChanges {
            stop_price: Some(p("20635.00")),
            ..OrderChanges::default()
        },
        t0(),
    )
    .unwrap();
    print(&mut b, "20650.00");
    assert_eq!(
        stop_price(&b, &entry),
        p("20635.00"),
        "breakeven fires once"
    );
}

#[test]
fn breakeven_waits_for_the_entry_to_fill_and_a_short_moves_down() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: rules_bracket("20650.00", None, Some((4, 0)), None),
            ..limit(main(), Side::Sell, 1, "20645.00")
        },
    );
    print(&mut b, "20641.25");
    let (s, _) = children(&b, &entry);
    assert_eq!(s.status, OrderStatus::Held);
    assert_eq!(s.stop_rules.unwrap().entry_price, None);
    assert_eq!(s.request.stop_price, Some(p("20650.00")));
    print(&mut b, "20645.25");
    assert_eq!(b.order(&entry.id).unwrap().status, OrderStatus::Filled);
    print(&mut b, "20644.25");
    assert_eq!(stop_price(&b, &entry), p("20650.00"), "3 ticks: not yet");
    print(&mut b, "20644.00");
    assert_eq!(stop_price(&b, &entry), p("20645.00"));
}

#[test]
fn trailing_only_ever_tightens() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: rules_bracket("20631.25", None, None, Some(20)),
            ..req(main(), Side::Buy, 1, OrderType::Market)
        },
    );
    print(&mut b, "20641.25");
    assert_eq!(stop_price(&b, &entry), p("20636.25"), "20 ticks behind");
    print(&mut b, "20650.00");
    assert_eq!(stop_price(&b, &entry), p("20645.00"));
    print(&mut b, "20646.00");
    assert_eq!(
        stop_price(&b, &entry),
        p("20645.00"),
        "a pullback never loosens it"
    );
    print(&mut b, "20652.50");
    assert_eq!(stop_price(&b, &entry), p("20647.50"));

    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: rules_bracket("20651.00", None, None, Some(8)),
            ..req(main(), Side::Sell, 1, OrderType::Market)
        },
    );
    assert_eq!(entry.avg_fill_price, Some(p("20641.00")));
    print(&mut b, "20641.00");
    assert_eq!(stop_price(&b, &entry), p("20643.00"));
    print(&mut b, "20630.00");
    assert_eq!(stop_price(&b, &entry), p("20632.00"));
    print(&mut b, "20635.00");
    assert_eq!(stop_price(&b, &entry), p("20632.00"));
}

#[test]
fn a_managed_stop_still_works_as_one_oco_pair() {
    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: rules_bracket("20631.25", Some("20700.00"), Some((8, 1)), Some(20)),
            ..req(main(), Side::Buy, 1, OrderType::Market)
        },
    );
    print(&mut b, "20660.00");
    assert_eq!(
        stop_price(&b, &entry),
        p("20655.00"),
        "the tighter rule wins"
    );
    print(&mut b, "20654.75");
    let (s, t) = children(&b, &entry);
    assert_eq!(s.status, OrderStatus::Filled);
    assert_eq!(s.avg_fill_price, Some(p("20654.50")), "at the touch");
    let t = t.unwrap();
    assert_eq!(t.status, OrderStatus::Cancelled);
    assert_eq!(t.reason.as_deref(), Some("The stop filled."));
    assert!(position(&b, &main()).is_none());

    let mut b = book();
    let entry = submit(
        &mut b,
        OrderRequest {
            bracket: rules_bracket("20631.25", Some("20650.00"), Some((8, 1)), None),
            ..req(main(), Side::Buy, 1, OrderType::Market)
        },
    );
    print(&mut b, "20645.00");
    assert_eq!(stop_price(&b, &entry), p("20641.50"));
    print(&mut b, "20650.25");
    let (s, t) = children(&b, &entry);
    assert_eq!(t.unwrap().status, OrderStatus::Filled);
    assert_eq!(s.status, OrderStatus::Cancelled);
    assert_eq!(s.reason.as_deref(), Some("The target filled."));
    assert!(position(&b, &main()).is_none());
}

#[tokio::test]
async fn breakeven_and_trailing_survive_a_restart() {
    use std::sync::Arc;
    use tessera_core::SharedClock;
    use tessera_core::clock::ManualClock;
    use tessera_market::{MarketDataProvider, MockConfig, MockMarket};
    let manual = Arc::new(ManualClock::new(t0()));
    let clock: SharedClock = manual.clone();
    let mk = || {
        let mut cfg = MockConfig::new(Arc::clone(&clock));
        cfg.intraday_sessions = 1;
        cfg.daily_sessions = 5;
        Arc::new(MockMarket::new(cfg)) as Arc<dyn MarketDataProvider>
    };
    let store = tessera_store::Store::open_in_memory().unwrap();
    let seeds = test_seeds();
    let open = |store: tessera_store::Store| {
        super::PaperBroker::open(
            mk(),
            Arc::clone(&clock),
            Some(store),
            PaperConfig::default(),
            &seeds,
        )
    };
    let broker = open(store.clone()).await.unwrap();
    broker.load(&nq()).await.unwrap();
    let entry = {
        let mut book = broker.book.lock();
        let ch = book.on_quote(
            &quote("20641.00", 10, "20641.25", 12, "20641.25", t0()),
            t0(),
        );
        broker.dispatch(&book, ch, t0());
        let (entry, ch) = book
            .submit(
                OrderRequest {
                    bracket: rules_bracket("20631.25", None, Some((8, 1)), Some(40)),
                    ..req(main(), Side::Buy, 1, OrderType::Market)
                },
                None,
                t0(),
            )
            .unwrap();
        broker.dispatch(&book, ch, t0());
        let ch = book.on_trade(&trade("20643.25", 1), t0());
        broker.dispatch(&book, ch, t0());
        entry
    };
    broker.flush().await;
    let before = children(&broker.book.lock(), &entry).0;
    assert_eq!(before.request.stop_price, Some(p("20641.50")));
    drop(broker);

    let again = open(store).await.unwrap();
    let mut book = again.book.lock();
    let (s, _) = children(&book, &entry);
    assert_eq!(s.request.stop_price, Some(p("20641.50")));
    let rules = s.stop_rules.unwrap();
    assert!(rules.breakeven_done, "breakeven does not fire again");
    assert_eq!(rules.trail.map(|t| t.distance_ticks), Some(40));
    assert_eq!(rules.entry_price, Some(p("20641.25")));
    book.on_quote(
        &quote("20660.75", 10, "20661.00", 12, "20661.00", t0()),
        t0(),
    );
    book.on_trade(&trade("20661.00", 1), t0());
    assert_eq!(stop_price(&book, &entry), p("20651.00"));
}

#[tokio::test]
async fn an_account_seeded_under_an_earlier_name_takes_its_seeds_name() {
    use std::sync::Arc;
    use tessera_core::SharedClock;
    use tessera_core::clock::ManualClock;
    use tessera_market::{MarketDataProvider, MockConfig, MockMarket};
    let clock: SharedClock = Arc::new(ManualClock::new(t0()));
    let mk = || {
        let mut cfg = MockConfig::new(Arc::clone(&clock));
        cfg.intraday_sessions = 1;
        Arc::new(MockMarket::new(cfg)) as Arc<dyn MarketDataProvider>
    };
    let store = tessera_store::Store::open_in_memory().unwrap();
    let mut earlier = test_seeds();
    earlier[1].id = "apex-50k-eval";
    earlier[1].name = "Apex 50K eval";
    earlier[1].formerly = None;
    earlier[0].name = "paper-main";
    earlier[0].formerly = None;
    let open = |seeds: Vec<super::AccountSeed>| {
        let (market, clock, store) = (mk(), Arc::clone(&clock), store.clone());
        async move {
            super::PaperBroker::open(market, clock, Some(store), PaperConfig::default(), &seeds)
                .await
                .unwrap()
        }
    };
    let old = AccountId::new("apex-50k-eval");
    drop(open(earlier).await);
    let mut seeds = test_seeds();
    seeds[1].formerly = Some(("apex-50k-eval", "Apex 50K eval"));
    for _ in 0..2 {
        let b = open(seeds.clone()).await;
        let book = b.book.lock();
        assert_eq!(book.account(&old).map(PaperAccount::name), Some("Eval 50K"));
        assert!(book.account(&eval()).is_none(), "no second eval is seeded");
        assert_eq!(book.account(&main()).map(PaperAccount::name), Some("Paper"));
    }
}

#[tokio::test]
async fn a_stored_account_no_seed_names_stays_off_the_simulator() {
    use std::sync::Arc;
    use tessera_core::SharedClock;
    use tessera_core::clock::ManualClock;
    use tessera_market::{MarketDataProvider, MockConfig, MockMarket};
    let clock: SharedClock = Arc::new(ManualClock::new(t0()));
    let mk = || {
        let mut cfg = MockConfig::new(Arc::clone(&clock));
        cfg.intraday_sessions = 1;
        Arc::new(MockMarket::new(cfg)) as Arc<dyn MarketDataProvider>
    };
    let store = tessera_store::Store::open_in_memory().unwrap();
    let open = |seeds: Vec<super::AccountSeed>| {
        let (market, clock, store) = (mk(), Arc::clone(&clock), store.clone());
        async move {
            super::PaperBroker::open(market, clock, Some(store), PaperConfig::default(), &seeds)
                .await
                .unwrap()
        }
    };
    let both = open(test_seeds()).await;
    both.load(&nq()).await.unwrap();
    {
        let mut book = both.book.lock();
        let ch = book.on_quote(
            &quote("20641.00", 10, "20641.25", 12, "20641.25", t0()),
            t0(),
        );
        both.dispatch(&book, ch, t0());
        for account in [main(), eval()] {
            let (_, ch) = book
                .submit(
                    req(account.clone(), Side::Buy, 1, OrderType::Market),
                    None,
                    t0(),
                )
                .unwrap();
            both.dispatch(&book, ch, t0());
            let (_, ch) = book
                .submit(limit(account, Side::Buy, 1, "20600.00"), None, t0())
                .unwrap();
            both.dispatch(&book, ch, t0());
        }
    }
    both.flush().await;
    drop(both);

    let one = open(super::default_seeds()).await;
    {
        let book = one.book.lock();
        assert_eq!(
            book.accounts().map(|a| a.id().clone()).collect::<Vec<_>>(),
            vec![main()]
        );
        assert!(book.orders(Some(&eval())).is_empty());
        assert!(book.positions(Some(&eval())).is_empty());
        assert!(book.fills(Some(&eval()), Timestamp(0)).is_empty());
        assert!(
            book.orders(None)
                .iter()
                .all(|o| o.request.account_id == main())
        );
        assert_eq!(book.positions(Some(&main())).len(), 1);
        assert_eq!(book.fills(Some(&main()), Timestamp(0)).len(), 1);
    }
    drop(one);

    let again = open(test_seeds()).await;
    let book = again.book.lock();
    assert!(book.account(&eval()).is_some());
    assert_eq!(book.positions(Some(&eval())).len(), 1);
    assert_eq!(book.fills(Some(&eval()), Timestamp(0)).len(), 1);
}
