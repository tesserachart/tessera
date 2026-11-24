use std::str::FromStr;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use tessera_core::accounts::Environment;
use tessera_core::catalog::Catalog;
use tessera_core::ids::AccountId;
use tessera_core::market::Quote;
use tessera_core::orders::{
    CheckSeverity, Order, OrderRequest, OrderStatus, OrderType, Position, Side, TimeInForce,
};
use tessera_core::{InstrumentId, Money, Price, Qty, Timestamp};

use super::account::{AccountSeed, PaperAccount};
use super::engine::{Book, Commission, PaperConfig};
use crate::OrderChanges;

fn t0() -> Timestamp {
    Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap()
}

fn id(s: &str) -> InstrumentId {
    InstrumentId::new(s).unwrap()
}

fn p(s: &str) -> Price {
    Price(Decimal::from_str(s).unwrap())
}

fn usd(n: i64) -> Decimal {
    Decimal::from(n)
}

fn paper() -> AccountId {
    AccountId::new("paper-main")
}

const PRODUCTS: [(&str, &str, &str); 4] = [
    ("NQZ6.CME", "20641.00", "20641.25"),
    ("MNQZ6.CME", "20641.00", "20641.25"),
    ("ESZ6.CME", "5583.00", "5583.25"),
    ("MESZ6.CME", "5583.00", "5583.25"),
];

fn quote(instrument: &str, bid: &str, ask: &str) -> Quote {
    Quote {
        instrument: id(instrument),
        ts: t0(),
        bid: Some(p(bid)),
        bid_size: Some(Qty::from(10)),
        ask: Some(p(ask)),
        ask_size: Some(Qty::from(10)),
        last: Some(p(bid)),
        last_size: Some(Qty::from(1)),
        session: None,
        source: None,
    }
}

fn book(balance: i64) -> Book {
    let mut b = Book::new(PaperConfig {
        commission: Commission::NONE,
        ..PaperConfig::default()
    });
    let seed = AccountSeed {
        id: "paper-main",
        name: "Paper",
        environment: Environment::Paper,
        balance: Decimal::from(balance),
        formerly: None,
    };
    b.add_account(PaperAccount::open(&seed, "paper", t0()));
    let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
    for (instrument, bid, ask) in PRODUCTS {
        b.set_market(cat.spec(&id(instrument)).unwrap().clone(), true);
        b.on_quote(&quote(instrument, bid, ask), t0());
    }
    b
}

fn order(instrument: &str, side: Side, qty: i64, order_type: OrderType) -> OrderRequest {
    OrderRequest {
        account_id: paper(),
        instrument: id(instrument),
        side,
        qty: Qty::from(qty),
        order_type,
        limit_price: None,
        stop_price: None,
        tif: TimeInForce::Day,
        bracket: None,
        client_order_id: None,
        reduce_only: false,
    }
}

fn market(instrument: &str, side: Side, qty: i64) -> OrderRequest {
    order(instrument, side, qty, OrderType::Market)
}

fn limit(instrument: &str, side: Side, qty: i64, price: &str) -> OrderRequest {
    OrderRequest {
        limit_price: Some(p(price)),
        ..order(instrument, side, qty, OrderType::Limit)
    }
}

fn send(b: &mut Book, req: OrderRequest) -> Order {
    b.submit(req, None, t0()).unwrap().0
}

fn refusal(o: &Order) -> &str {
    assert_eq!(o.status, OrderStatus::Rejected, "{o:?}");
    o.reason.as_deref().unwrap_or_default()
}

fn buying_power(b: &Book) -> Decimal {
    b.summary(&paper(), t0()).unwrap().buying_power.amount
}

#[test]
fn the_17704_mnq_short_on_a_1_39m_account_is_refused_for_margin_and_over_the_order_cap() {
    let mut b = book(1_390_000);
    let preview = b
        .preview(&market("MNQZ6.CME", Side::Sell, 17_704), t0())
        .unwrap();
    let blocks: Vec<(&str, &str)> = preview
        .checks
        .iter()
        .filter(|c| c.severity == CheckSeverity::Block)
        .map(|c| (c.code.as_str(), c.message.as_str()))
        .collect();
    assert_eq!(
        blocks,
        [
            (
                "paper_margin",
                "17,704 MNQ need $80,606,312 of margin; the account has $1,390,000 of buying \
                 power. Nothing sent."
            ),
            (
                "paper_order_qty",
                "17,704 MNQ in one order: paper takes at most 500 MNQ an order. Nothing sent."
            ),
        ]
    );
    assert_eq!(
        preview.buying_power_after.map(|m| m.amount),
        Some(usd(1_390_000 - 17_704 * 4_553))
    );
    let o = send(&mut b, market("MNQZ6.CME", Side::Sell, 17_704));
    assert_eq!(refusal(&o), blocks[0].1);
    assert!(b.positions(Some(&paper())).is_empty());
    assert_eq!(buying_power(&b), usd(1_390_000));
}

#[test]
fn an_order_over_the_per_order_cap_is_refused_even_with_the_margin_for_it() {
    let mut b = book(100_000_000);
    let over = send(&mut b, market("MNQZ6.CME", Side::Buy, 501));
    assert_eq!(
        refusal(&over),
        "501 MNQ in one order: paper takes at most 500 MNQ an order. Nothing sent."
    );
    let nq = send(&mut b, market("NQZ6.CME", Side::Buy, 101));
    assert_eq!(
        refusal(&nq),
        "101 NQ in one order: paper takes at most 100 NQ an order. Nothing sent."
    );
    assert_eq!(
        send(&mut b, market("MNQZ6.CME", Side::Buy, 500)).status,
        OrderStatus::Filled
    );
    assert_eq!(
        send(&mut b, market("MNQZ6.CME", Side::Buy, 500)).status,
        OrderStatus::Filled
    );
    assert_eq!(
        send(&mut b, market("MNQZ6.CME", Side::Sell, 1_000)).status,
        OrderStatus::Filled,
        "an exit of any size goes"
    );
}

#[test]
fn each_product_takes_what_its_initial_margin_allows_and_refuses_one_more() {
    let cases = [
        ("NQZ6.CME", "NQ", 45_532),
        ("MNQZ6.CME", "MNQ", 4_553),
        ("ESZ6.CME", "ES", 25_777),
        ("MESZ6.CME", "MES", 2_577),
    ];
    for (instrument, root, margin) in cases {
        let mut b = book(100_000);
        let most = 100_000 / margin;
        let held = send(&mut b, market(instrument, Side::Buy, most));
        assert_eq!(held.status, OrderStatus::Filled, "{root}: {held:?}");
        let power = buying_power(&b);
        assert!(power < usd(margin), "{root}: {power}");
        let more = send(&mut b, market(instrument, Side::Buy, 1));
        assert_eq!(
            refusal(&more),
            format!(
                "1 {root} needs ${} of margin; the account has {} of buying power. Nothing sent.",
                super::engine::count_label(usd(margin)),
                super::engine::usd(power)
            ),
            "{root}"
        );
        let short = send(&mut b, market(instrument, Side::Sell, 2 * most + 1));
        assert!(
            refusal(&short).starts_with(&format!("{} {root} need ", 2 * most + 1)),
            "{root}: a reversal past what the margin allows is refused"
        );
        let out = send(&mut b, market(instrument, Side::Sell, most));
        assert_eq!(out.status, OrderStatus::Filled, "{root}: the exit goes");
        assert_eq!(buying_power(&b), b.net_liq(&paper()).unwrap().amount);
    }
}

#[test]
fn open_losses_shrink_buying_power_and_then_only_exits_and_reductions_go() {
    let mut b = book(100_000);
    assert_eq!(
        send(&mut b, market("NQZ6.CME", Side::Buy, 2)).status,
        OrderStatus::Filled
    );
    assert_eq!(buying_power(&b), usd(100_000 - 2 * 45_532 - 10));
    b.on_quote(&quote("NQZ6.CME", "20400.00", "20400.25"), t0());
    let net = b.net_liq(&paper()).unwrap().amount;
    assert_eq!(
        net,
        usd(100_000) + (p("20400.00").0 - p("20641.25").0) * usd(40)
    );
    assert_eq!(buying_power(&b), net - usd(2 * 45_532));
    assert!(buying_power(&b) < Decimal::ZERO);
    let add = send(&mut b, market("NQZ6.CME", Side::Buy, 1));
    assert_eq!(
        refusal(&add),
        "1 NQ needs $45,532 of margin; the account has $0 of buying power. Nothing sent."
    );
    let mnq = send(&mut b, market("MNQZ6.CME", Side::Sell, 1));
    assert!(refusal(&mnq).starts_with("1 MNQ needs $4,553 of margin"));
    let reduce = send(&mut b, market("NQZ6.CME", Side::Sell, 1));
    assert_eq!(reduce.status, OrderStatus::Filled);
    let stop = send(
        &mut b,
        OrderRequest {
            stop_price: Some(p("20300.00")),
            reduce_only: true,
            ..order("NQZ6.CME", Side::Sell, 1, OrderType::Stop)
        },
    );
    assert_eq!(stop.status, OrderStatus::Working, "a protective stop goes");
}

#[test]
fn an_account_below_zero_opens_nothing_new_anywhere_and_its_exits_go() {
    let mut b = book(100_000);
    let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
    for (instrument, bid, ask) in [
        ("NQH7.CME", "20841.00", "20841.25"),
        ("QQQ", "480.00", "480.01"),
    ] {
        b.set_market(cat.spec(&id(instrument)).unwrap().clone(), true);
        b.on_quote(&quote(instrument, bid, ask), t0());
    }
    assert_eq!(
        send(&mut b, market("NQZ6.CME", Side::Buy, 2)).status,
        OrderStatus::Filled
    );
    b.on_quote(&quote("NQZ6.CME", "17000.00", "17000.25"), t0());
    assert!(b.net_liq(&paper()).unwrap().amount < Decimal::ZERO);
    let month = send(&mut b, market("NQH7.CME", Side::Buy, 1));
    assert!(refusal(&month).starts_with("1 NQ needs $45,532 of margin; the account has $0 "));
    let stock = send(&mut b, market("QQQ", Side::Buy, 1));
    assert_eq!(
        refusal(&stock),
        format!(
            "The account has no buying power ({}): no new positions. Exits work. Nothing sent.",
            super::engine::usd(buying_power(&b))
        )
    );
    assert_eq!(
        send(&mut b, market("QQQ", Side::Buy, 101)).reason,
        stock.reason,
        "shares have no order cap"
    );
    assert_eq!(
        send(&mut b, market("NQZ6.CME", Side::Sell, 2)).status,
        OrderStatus::Filled
    );
}

#[test]
fn working_orders_hold_margin_and_growing_one_past_it_is_refused() {
    let mut b = book(100_000);
    let resting = send(&mut b, limit("NQZ6.CME", Side::Buy, 1, "20600.00"));
    assert_eq!(resting.status, OrderStatus::Working);
    assert_eq!(buying_power(&b), usd(100_000 - 45_532));
    assert_eq!(
        send(&mut b, limit("NQZ6.CME", Side::Buy, 1, "20590.00")).status,
        OrderStatus::Working
    );
    let third = send(&mut b, limit("NQZ6.CME", Side::Buy, 1, "20580.00"));
    assert_eq!(
        refusal(&third),
        format!(
            "1 NQ needs $45,532 of margin; the account has {} of buying power. Nothing sent.",
            super::engine::usd(usd(100_000 - 2 * 45_532))
        )
    );
    let grow = OrderChanges {
        qty: Some(Qty::from(2)),
        limit_price: None,
        stop_price: None,
    };
    let refused = b.modify(&resting.id, &grow, t0()).unwrap_err();
    assert_eq!(
        refused.to_string(),
        "2 NQ need $45,532 of margin; the account has $8,936 of buying power. The order stays \
         as it was."
    );
    let moved = OrderChanges {
        qty: None,
        limit_price: Some(p("20610.00")),
        stop_price: None,
    };
    assert!(
        b.modify(&resting.id, &moved, t0()).is_ok(),
        "a price move goes"
    );
    let sell = send(&mut b, limit("NQZ6.CME", Side::Sell, 1, "20700.00"));
    assert_eq!(
        sell.status,
        OrderStatus::Working,
        "a sell against working buys adds no margin"
    );
}

fn list_future(b: &mut Book, instrument: &str, root: &str, tick: &str, multiplier: i64) {
    let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
    let mut spec = cat.spec(&id("NQZ6.CME")).unwrap().clone();
    spec.instrument = id(instrument);
    spec.root = Some(root.to_owned());
    spec.tick_size = p(tick);
    spec.multiplier = usd(multiplier);
    spec.tick_value = Money::usd(p(tick).0 * usd(multiplier));
    spec.price_decimals = p(tick).0.scale();
    spec.micro_of = None;
    b.set_market(spec, true);
}

#[test]
fn crude_gold_russell_and_notes_hold_their_cme_initial_margin_on_paper() {
    let cases = [
        ("CLZ6.NYMEX", "CL", "0.01", 1_000, "61.50", "61.51", 10_117),
        ("GCZ6.COMEX", "GC", "0.1", 100, "2650.0", "2650.1", 22_864),
        ("RTYZ6.CME", "RTY", "0.1", 50, "2210.0", "2210.1", 11_239),
        (
            "ZNZ6.CBOT",
            "ZN",
            "0.015625",
            1_000,
            "110.5",
            "110.515625",
            2_063,
        ),
    ];
    for (instrument, root, tick, multiplier, bid, ask, margin) in cases {
        let mut b = book(100_000);
        list_future(&mut b, instrument, root, tick, multiplier);
        b.on_quote(&quote(instrument, bid, ask), t0());
        let most = 100_000 / margin;
        let held = send(&mut b, market(instrument, Side::Buy, most));
        assert_eq!(held.status, OrderStatus::Filled, "{root}: {held:?}");
        let power = buying_power(&b);
        assert!(power < usd(margin), "{root}: {power}");
        let more = send(&mut b, market(instrument, Side::Buy, 1));
        assert_eq!(
            refusal(&more),
            format!(
                "1 {root} needs ${} of margin; the account has {} of buying power. Nothing sent.",
                super::engine::count_label(usd(margin)),
                super::engine::usd(power)
            ),
            "{root}"
        );
        let out = send(&mut b, market(instrument, Side::Sell, most));
        assert_eq!(out.status, OrderStatus::Filled, "{root}: the exit goes");
    }
}

#[test]
fn a_future_paper_has_no_margin_for_opens_nothing_and_its_exits_go() {
    let mut b = book(100_000_000);
    list_future(&mut b, "XYZZ6.CME", "XYZ", "0.25", 20);
    b.on_quote(&quote("XYZZ6.CME", "100.00", "100.25"), t0());
    let refused = "Paper has no margin for XYZ, so it does not open positions in it. Exits work. \
                   Nothing sent.";
    let preview = b.preview(&market("XYZZ6.CME", Side::Buy, 1), t0()).unwrap();
    let blocks: Vec<(&str, &str)> = preview
        .checks
        .iter()
        .filter(|c| c.severity == CheckSeverity::Block)
        .map(|c| (c.code.as_str(), c.message.as_str()))
        .collect();
    assert_eq!(blocks, [("paper_margin_unknown", refused)]);
    assert_eq!(
        refusal(&send(&mut b, market("XYZZ6.CME", Side::Buy, 1))),
        refused
    );
    assert_eq!(
        refusal(&send(&mut b, limit("XYZZ6.CME", Side::Sell, 1, "100.50"))),
        refused
    );
    assert!(b.positions(Some(&paper())).is_empty());

    b.restore_position(Position {
        account_id: paper(),
        instrument: id("XYZZ6.CME"),
        qty: Qty::from(2),
        avg_price: p("99.00"),
        realized_pnl: Money::usd(Decimal::ZERO),
        unrealized_pnl: None,
        mark: None,
        opened_at: t0(),
    });
    assert_eq!(
        refusal(&send(&mut b, market("XYZZ6.CME", Side::Buy, 1))),
        refused,
        "adding to a held position is refused"
    );
    assert_eq!(
        refusal(&send(&mut b, market("XYZZ6.CME", Side::Sell, 3))),
        refused,
        "a reversal opens contracts"
    );
    assert_eq!(
        send(&mut b, market("XYZZ6.CME", Side::Sell, 2)).status,
        OrderStatus::Filled,
        "the exit goes"
    );
    assert!(b.positions(Some(&paper())).is_empty());
    assert_eq!(
        refusal(&send(&mut b, market("XYZZ6.CME", Side::Sell, 1))),
        refused,
        "a fresh short is refused too"
    );
}
