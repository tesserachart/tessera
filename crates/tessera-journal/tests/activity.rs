use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::NaiveDate;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use tessera_core::ids::{AccountId, CallId, FillId, OrderId};
use tessera_core::instrument::{ContractSpec, InstrumentId};
use tessera_core::orders::{
    Bracket, Fill, Order, OrderRequest, OrderRole, OrderStatus, OrderType, Side, StopRules,
    TimeInForce, TrailRule,
};
use tessera_core::{Environment, Money, Origin, Price, Qty, Timestamp};
use tessera_journal::activity::{
    ActorKind, Coverage, EndedBy, EventSource, Leg, MoveDirection, OrderEventKind,
};
use tessera_journal::model::*;
use tessera_journal::{JournalService, MarketSource};
use tessera_protocol::tools::{RiskTier, ToolCallRecord, ToolCallStatus};
use tessera_store::{BrokerBatch, Store};

const ACCOUNT: &str = "paper-main";
const SEC: i64 = 1_000_000_000;

struct Specs;

#[async_trait]
impl MarketSource for Specs {
    async fn spec(&self, instrument: &InstrumentId) -> Option<ContractSpec> {
        let cat = tessera_core::catalog::Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2)?);
        cat.spec(instrument).cloned()
    }

    async fn bars(
        &self,
        _: &InstrumentId,
        _: Timestamp,
        _: Timestamp,
    ) -> Option<Vec<(Timestamp, f64, f64)>> {
        None
    }
}

fn t0() -> Timestamp {
    Timestamp::parse("2026-10-02T10:00:00-04:00").unwrap()
}

fn at(s: i64) -> Timestamp {
    Timestamp(t0().0 + s * SEC)
}

fn p(v: &str) -> Price {
    Price(Decimal::from_str(v).unwrap())
}

fn order(
    id: &str,
    side: Side,
    ty: OrderType,
    role: OrderRole,
    qty: i64,
    price: Option<&str>,
) -> Order {
    Order {
        id: OrderId::new(id),
        broker_order_id: None,
        draft_id: None,
        request: OrderRequest {
            account_id: AccountId::new(ACCOUNT),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            side,
            qty: Qty::from(qty),
            order_type: ty,
            limit_price: (ty == OrderType::Limit).then(|| p(price.unwrap())),
            stop_price: (ty == OrderType::Stop).then(|| p(price.unwrap())),
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only: role != OrderRole::Entry,
        },
        role,
        parent_id: None,
        status: OrderStatus::Working,
        filled_qty: Qty::ZERO,
        avg_fill_price: None,
        queue_ahead: None,
        stop_rules: None,
        triggered_at: None,
        environment: Environment::Paper,
        reason: None,
        created_at: at(0),
        updated_at: at(0),
    }
}

fn leg(id: &str, parent: &str, ty: OrderType, qty: i64, price: &str) -> Order {
    let role = if ty == OrderType::Stop {
        OrderRole::StopLoss
    } else {
        OrderRole::TakeProfit
    };
    let mut o = order(id, Side::Sell, ty, role, qty, Some(price));
    o.parent_id = Some(OrderId::new(parent));
    o.status = OrderStatus::Held;
    o
}

fn then(o: &Order, s: i64, f: impl FnOnce(&mut Order)) -> Order {
    let mut n = o.clone();
    n.updated_at = at(s);
    f(&mut n);
    n
}

fn filled(o: &Order, s: i64, price: &str) -> Order {
    then(o, s, |n| {
        n.status = OrderStatus::Filled;
        n.filled_qty = n.request.qty;
        n.avg_fill_price = Some(p(price));
    })
}

fn fill(id: &str, order: &str, side: Side, qty: i64, price: &str, s: i64) -> Fill {
    Fill {
        id: FillId::new(id),
        broker_fill_id: None,
        order_id: Some(OrderId::new(order)),
        account_id: AccountId::new(ACCOUNT),
        instrument: InstrumentId::new("NQZ6.CME").unwrap(),
        side,
        qty: Qty::from(qty),
        price: p(price),
        ts: at(s),
        fee: Money::usd(Decimal::from_str("2.10").unwrap()),
        realized_pnl: None,
        source: "paper".into(),
    }
}

#[derive(Default)]
struct Book(Mutex<HashMap<String, Order>>);

impl Book {
    fn send(&self, j: &JournalService, o: &Order) -> Vec<String> {
        self.0.lock().insert(o.id.to_string(), o.clone());
        j.record_orders(vec![o.clone()], o.updated_at, EventSource::Live)
            .unwrap()
    }

    async fn fill(&self, j: &JournalService, f: Fill) {
        let book = self.0.lock().clone();
        j.ingest(vec![f], &move |id: &OrderId| book.get(id.as_str()).cloned())
            .await
            .unwrap();
    }
}

fn events_kept(store: &Store) -> i64 {
    store
        .conn()
        .unwrap()
        .query_row("SELECT count(*) FROM journal_order_events", [], |r| {
            r.get(0)
        })
        .unwrap()
}

fn call(store: &Store, id: &str, tool: &str, origin: Origin, s: i64, input: serde_json::Value) {
    let approved = !origin.is_user();
    store
        .tool_calls()
        .upsert(&ToolCallRecord {
            call_id: CallId::from(id.to_owned()),
            tool: tool.into(),
            risk: RiskTier::Financial,
            origin,
            session_id: None,
            input_hash: id.into(),
            input,
            status: ToolCallStatus::Ok,
            started_at: at(s),
            finished_at: Some(at(s)),
            duration_ms: Some(1.0),
            error: None,
            approval_id: None,
            deduped: false,
            idempotency_key: None,
            summary: None,
            approved_by: approved.then(|| "appr-1".to_owned().into()),
        })
        .unwrap();
}

async fn bracket_long(j: &JournalService, book: &Book) {
    let entry = order(
        "e1",
        Side::Buy,
        OrderType::Market,
        OrderRole::Entry,
        1,
        None,
    );
    let stop = leg("s1", "e1", OrderType::Stop, 1, "20590");
    let target = leg("t1", "e1", OrderType::Limit, 1, "20640");
    book.send(j, &entry);
    book.send(j, &stop);
    book.send(j, &target);
    book.send(j, &filled(&entry, 0, "20600"));
    book.fill(j, fill("f1", "e1", Side::Buy, 1, "20600", 0))
        .await;
    let stop = then(&stop, 0, |o| o.status = OrderStatus::Working);
    let target = then(&target, 0, |o| o.status = OrderStatus::Working);
    book.send(j, &stop);
    book.send(j, &target);
    let s = then(&stop, 30, |o| o.request.stop_price = Some(p("20595")));
    book.send(j, &s);
    let s = then(&s, 60, |o| o.request.stop_price = Some(p("20585")));
    book.send(j, &s);
    let s = then(&s, 120, |o| {
        o.request.stop_price = Some(p("20600"));
        o.stop_rules = Some(StopRules {
            trail: Some(TrailRule {
                distance_ticks: 40,
                trigger_ticks: 0,
                step_ticks: 1,
            }),
            ..StopRules::default()
        });
    });
    book.send(j, &s);
    let s = then(&s, 180, |o| o.request.stop_price = Some(p("20610")));
    book.send(j, &s);
    let s = then(&s, 240, |o| o.triggered_at = Some(at(240)));
    book.send(j, &s);
    book.send(j, &filled(&s, 240, "20610"));
    book.fill(j, fill("f2", "s1", Side::Sell, 1, "20610", 240))
        .await;
    book.send(
        j,
        &then(&target, 240, |o| {
            o.status = OrderStatus::Cancelled;
            o.reason = Some("The other side of the bracket filled.".into());
        }),
    );
}

fn service(store: &Store) -> JournalService {
    JournalService::open(store.clone(), None, None, Some(Arc::new(Specs))).unwrap()
}

#[tokio::test]
async fn order_changes_are_kept_once_measured_and_survive_a_restart() {
    let store = Store::open_in_memory().unwrap();
    let j = service(&store);
    j.mark_live(ACCOUNT, at(-3600));
    let book = Book::default();
    bracket_long(&j, &book).await;
    let trade = j.trades()[0].clone();
    let a = trade.activity.clone().expect("recorded");
    assert_eq!(a.coverage, Coverage::Complete);
    assert_eq!(a.initial_stop, Some(20590.0));
    assert_eq!(a.initial_target, Some(20640.0));
    assert_eq!(a.initial_risk_ticks, Some(40.0));
    assert_eq!(a.initial_risk, Some(200.0), "10 points × $20 × 1");
    assert_eq!(trade.net_pnl, 195.8);
    assert_eq!(a.r_initial, Some(0.98));
    assert_eq!(trade.r_multiple, Some(0.98), "R on the initial risk");
    assert_eq!(trade.plan_from.as_deref(), Some("activity"));
    assert_eq!(trade.stop_price, Some(20590.0));
    assert_eq!(
        (a.stop_moves, a.tightened, a.widened, a.trail_steps),
        (4, 3, 1, 2)
    );
    assert_eq!(a.first_move_secs, Some(30.0));
    assert_eq!(a.breakeven_secs, Some(120.0));
    assert_eq!(a.unprotected_secs, 0.0);
    assert_eq!(a.worst_stop, Some(20585.0));
    assert_eq!(a.worst_stop_ticks, Some(60.0));
    assert_eq!(a.ended_by, Some(EndedBy::Stop));

    let kept = events_kept(&store);
    let last = book.0.lock().get("s1").cloned().unwrap();
    assert!(book.send(&j, &last).is_empty());
    assert_eq!(events_kept(&store), kept);

    call(
        &store,
        "c-drag",
        "orders.modify",
        Origin::User,
        30,
        serde_json::json!({"accountId": ACCOUNT, "orderId": "s1", "stopPrice": 20595}),
    );
    call(
        &store,
        "c-agent",
        "orders.modify",
        Origin::Agent {
            session_id: "sess-7".into(),
            provider: "codex".into(),
        },
        60,
        serde_json::json!({"accountId": ACCOUNT, "orderId": "s1", "stopPrice": "20585"}),
    );
    let d = j
        .trade(&GetTradeInput {
            id: trade.id.clone(),
            filter: None,
        })
        .await
        .unwrap();
    let act = d.activity.expect("activity");
    let moves: Vec<_> = act
        .rows
        .iter()
        .filter(|r| r.event.kind == OrderEventKind::StopMoved)
        .map(|r| (r.actor.kind, r.direction, r.ticks))
        .collect();
    assert_eq!(
        moves,
        vec![
            (
                ActorKind::Trader,
                Some(MoveDirection::Tightened),
                Some(20.0)
            ),
            (ActorKind::Analyst, Some(MoveDirection::Widened), Some(40.0)),
            (
                ActorKind::Broker,
                Some(MoveDirection::Tightened),
                Some(60.0)
            ),
            (
                ActorKind::Broker,
                Some(MoveDirection::Tightened),
                Some(40.0)
            ),
        ]
    );
    let analyst = act
        .rows
        .iter()
        .find(|r| r.actor.kind == ActorKind::Analyst)
        .unwrap();
    assert_eq!(analyst.actor.session_id.as_deref(), Some("sess-7"));
    let cancel = act
        .rows
        .iter()
        .find(|r| r.event.kind == OrderEventKind::Cancelled)
        .unwrap();
    assert_eq!(
        (cancel.leg, cancel.actor.kind),
        (Some(Leg::Target), ActorKind::Broker)
    );
    assert!(
        act.rows
            .iter()
            .any(|r| r.event.kind == OrderEventKind::Filled
                && r.actor.kind == ActorKind::Market
                && r.leg == Some(Leg::Stop))
    );
    let path: Vec<_> = act.stop_path.iter().map(|s| s.price).collect();
    assert_eq!(
        path,
        vec![
            Some(20590.0),
            Some(20595.0),
            Some(20585.0),
            Some(20600.0),
            Some(20610.0),
            None
        ]
    );
    assert_eq!(act.target_path[0].price, Some(20640.0));

    drop(j);
    let j = service(&store);
    let again = j.trades()[0].clone();
    assert_eq!(again.activity, trade.activity);
    assert_eq!(again.r_multiple, Some(0.98));
    let book2 = Book::default();
    assert!(book2.send(&j, &last).is_empty());
    assert_eq!(events_kept(&store), kept);

    let day = j
        .activity(&GetActivityInput {
            from: NaiveDate::from_ymd_opt(2026, 10, 2),
            to: NaiveDate::from_ymd_opt(2026, 10, 2),
            ..GetActivityInput::default()
        })
        .unwrap();
    assert_eq!(day.total as i64, kept);
    assert!(
        day.rows
            .iter()
            .all(|r| r.trade_id.as_deref() == Some(trade.id.as_str()))
    );
    let none = j
        .activity(&GetActivityInput {
            account_id: Some("someone-else".into()),
            ..GetActivityInput::default()
        })
        .unwrap();
    assert!(none.rows.is_empty());
    assert_eq!(day.accounts[0].live_since, Some(at(-3600)));
    let by_symbol = j
        .activity(&GetActivityInput {
            instrument: Some("NQ".into()),
            limit: Some(3),
            ..GetActivityInput::default()
        })
        .unwrap();
    assert_eq!(by_symbol.rows.len(), 3, "the newest three");
    assert_eq!(by_symbol.rows[2].event.kind, OrderEventKind::Cancelled);
}

async fn market_order(
    j: &JournalService,
    book: &Book,
    id: &str,
    side: Side,
    qty: i64,
    s: i64,
    price: &str,
) {
    let role = if side == Side::Buy {
        OrderRole::Entry
    } else {
        OrderRole::Exit
    };
    let o = then(
        &order(id, side, OrderType::Market, role, qty, None),
        s,
        |_| {},
    );
    book.send(j, &o);
    book.send(j, &filled(&o, s, price));
    book.fill(j, fill(&format!("f-{id}"), id, side, qty, price, s))
        .await;
}

#[tokio::test]
async fn r_is_the_net_over_all_the_trade_put_at_its_stops_and_none_without_one() {
    let store = Store::open_in_memory().unwrap();
    let j = service(&store);
    j.mark_live(ACCOUNT, at(-3600));
    let book = Book::default();

    let stop = leg("s1", "e1", OrderType::Stop, 1, "20590");
    book.send(&j, &stop);
    market_order(&j, &book, "e1", Side::Buy, 1, 0, "20600").await;
    let stop = then(&stop, 0, |o| o.status = OrderStatus::Working);
    book.send(&j, &stop);
    market_order(&j, &book, "e2", Side::Buy, 9, 30, "20605").await;
    let stop = then(&stop, 30, |o| o.request.qty = Qty::from(10));
    book.send(&j, &stop);
    market_order(&j, &book, "x1", Side::Sell, 10, 60, "20620").await;
    book.send(
        &j,
        &then(&stop, 60, |o| {
            o.status = OrderStatus::Cancelled;
            o.reason = Some("The position is closed.".into());
        }),
    );

    market_order(&j, &book, "e3", Side::Buy, 1, 120, "20610").await;
    market_order(&j, &book, "x2", Side::Sell, 1, 150, "20620").await;

    let s4 = then(&leg("s4", "e4", OrderType::Stop, 1, "20590"), 200, |_| {});
    book.send(&j, &s4);
    market_order(&j, &book, "e4", Side::Buy, 1, 200, "20600").await;
    let s4 = then(&s4, 200, |o| o.status = OrderStatus::Working);
    book.send(&j, &s4);
    book.send(
        &j,
        &then(&s4, 210, |o| {
            o.status = OrderStatus::Cancelled;
            o.reason = Some("Cancelled by the trader.".into());
        }),
    );
    market_order(&j, &book, "e5", Side::Buy, 1, 230, "20605").await;
    market_order(&j, &book, "x3", Side::Sell, 2, 260, "20615").await;

    let bracketed = then(
        &order(
            "e6",
            Side::Buy,
            OrderType::Market,
            OrderRole::Entry,
            2,
            None,
        ),
        300,
        |o| {
            o.request.bracket = Some(Bracket {
                stop_loss: Some(p("20590")),
                ..Bracket::default()
            })
        },
    );
    book.send(&j, &bracketed);
    book.send(&j, &filled(&bracketed, 300, "20600"));
    book.fill(&j, fill("f-e6", "e6", Side::Buy, 2, "20600", 300))
        .await;
    market_order(&j, &book, "x4", Side::Sell, 2, 320, "20610").await;

    let trades = j.trades();
    let opened = |s: i64| trades.iter().find(|t| t.opened_at == at(s)).unwrap();
    let built = opened(0);
    assert_eq!(built.net_pnl, 3093.7, "400 + 2,700 less 3 fills × $2.10");
    assert_eq!(
        built.risk,
        Some(2900.0),
        "1 × 10 points + 9 × 15 points, × $20"
    );
    assert_eq!(built.r_multiple, Some(1.07));
    let bare = opened(120);
    assert_eq!((bare.risk, bare.r_multiple), (None, None), "no stop, no R");
    let uncovered = opened(200);
    assert_eq!(uncovered.stop_price, Some(20590.0));
    assert_eq!(
        (uncovered.risk, uncovered.r_multiple),
        (None, None),
        "the add at 230 s had no stop, so the trade's risk is unknown"
    );
    let unseen = opened(300);
    assert_eq!(
        (unseen.risk, unseen.r_multiple),
        (Some(400.0), Some(0.99)),
        "no stop leg recorded: the entry's own bracket stop, 2 × 10 points × $20"
    );
}

#[tokio::test]
async fn partial_exits_and_reversals_link_to_the_right_trade() {
    let store = Store::open_in_memory().unwrap();
    let j = service(&store);
    j.mark_live(ACCOUNT, at(-60));
    let book = Book::default();
    let entry = order(
        "e2",
        Side::Buy,
        OrderType::Market,
        OrderRole::Entry,
        2,
        None,
    );
    let stop = leg("s2", "e2", OrderType::Stop, 2, "20590");
    let target = leg("t2", "e2", OrderType::Limit, 2, "20620");
    for o in [&entry, &stop, &target] {
        book.send(&j, o);
    }
    book.send(&j, &filled(&entry, 0, "20600"));
    book.fill(&j, fill("g1", "e2", Side::Buy, 2, "20600", 0))
        .await;
    let stop = then(&stop, 0, |o| o.status = OrderStatus::Working);
    let target = then(&target, 0, |o| o.status = OrderStatus::Working);
    book.send(&j, &stop);
    book.send(&j, &target);
    let target = then(&target, 60, |o| {
        o.status = OrderStatus::PartiallyFilled;
        o.filled_qty = Qty::from(1);
    });
    book.send(&j, &target);
    book.fill(&j, fill("g2", "t2", Side::Sell, 1, "20620", 60))
        .await;
    let stop = then(&stop, 60, |o| o.request.qty = Qty::from(1));
    book.send(&j, &stop);
    let rev = order(
        "r1",
        Side::Sell,
        OrderType::Market,
        OrderRole::Entry,
        3,
        None,
    );
    let rev = then(&rev, 120, |o| o.created_at = at(120));
    book.send(&j, &rev);
    book.send(&j, &filled(&rev, 120, "20610"));
    book.fill(&j, fill("g3", "r1", Side::Sell, 3, "20610", 120))
        .await;
    for o in [&stop, &target] {
        book.send(
            &j,
            &then(o, 120, |n| {
                n.status = OrderStatus::Cancelled;
                n.reason = Some("The position is closed.".into());
            }),
        );
    }
    let mut cover = order(
        "b1",
        Side::Buy,
        OrderType::Stop,
        OrderRole::Entry,
        2,
        Some("20630"),
    );
    cover.request.reduce_only = true;
    cover.created_at = at(130);
    cover.updated_at = at(130);
    book.send(&j, &cover);
    let out = order("x1", Side::Buy, OrderType::Market, OrderRole::Exit, 2, None);
    let out = then(&out, 200, |o| o.created_at = at(200));
    book.send(&j, &out);
    book.send(&j, &filled(&out, 200, "20605"));
    book.fill(&j, fill("g4", "x1", Side::Buy, 2, "20605", 200))
        .await;
    book.send(
        &j,
        &then(&cover, 200, |o| {
            o.status = OrderStatus::Cancelled;
            o.reason = Some("The position is closed.".into());
        }),
    );

    let trades = j.trades();
    assert_eq!(trades.len(), 2);
    let long = trades.iter().find(|t| t.side == Side::Buy).unwrap();
    let short = trades.iter().find(|t| t.side == Side::Sell).unwrap();
    let la = long.activity.as_ref().unwrap();
    assert_eq!(la.initial_stop, Some(20590.0));
    assert_eq!(la.initial_risk, Some(400.0), "10 points × $20 × 2 held");
    assert_eq!(la.stop_moves, 0, "a quantity change is not a move");
    assert_eq!(
        la.ended_by,
        Some(EndedBy::Manual),
        "the reversing sell closed it"
    );
    let sa = short.activity.as_ref().unwrap();
    assert_eq!(sa.initial_stop, Some(20630.0));
    assert_eq!(sa.initial_stop_at, Some(at(130)));
    assert_eq!(sa.unprotected_secs, 10.0);
    assert_eq!(sa.initial_risk_ticks, Some(80.0));
    assert_eq!(
        sa.initial_target, None,
        "the long's target is not the short's"
    );
    assert_eq!(sa.ended_by, Some(EndedBy::Manual));
    let long_d = j
        .trade(&GetTradeInput {
            id: long.id.clone(),
            filter: None,
        })
        .await
        .unwrap()
        .activity
        .unwrap();
    let legs: HashMap<String, Leg> = long_d
        .rows
        .iter()
        .filter_map(|r| r.leg.map(|l| (r.event.order_id.clone(), l)))
        .collect();
    assert_eq!(legs.get("s2"), Some(&Leg::Stop));
    assert_eq!(legs.get("t2"), Some(&Leg::Target));
    assert_eq!(legs.get("r1"), Some(&Leg::Exit));
    assert!(!legs.contains_key("b1"));
    let short_d = j
        .trade(&GetTradeInput {
            id: short.id.clone(),
            filter: None,
        })
        .await
        .unwrap()
        .activity
        .unwrap();
    let legs: HashMap<String, Leg> = short_d
        .rows
        .iter()
        .filter_map(|r| r.leg.map(|l| (r.event.order_id.clone(), l)))
        .collect();
    assert_eq!(legs.get("r1"), Some(&Leg::Entry));
    assert_eq!(legs.get("b1"), Some(&Leg::Stop));
    assert_eq!(legs.get("x1"), Some(&Leg::Exit));
    assert!(!legs.contains_key("s2") && !legs.contains_key("t2"));
}

#[tokio::test]
async fn the_behaviour_report_measures_stop_handling() {
    let store = Store::open_in_memory().unwrap();
    let j = service(&store);
    j.mark_live(ACCOUNT, at(-60));
    let book = Book::default();
    bracket_long(&j, &book).await;
    let e = order(
        "e9",
        Side::Buy,
        OrderType::Market,
        OrderRole::Entry,
        1,
        None,
    );
    let e = then(&e, 1000, |o| o.created_at = at(1000));
    book.send(&j, &e);
    book.send(&j, &filled(&e, 1000, "20600"));
    book.fill(&j, fill("h1", "e9", Side::Buy, 1, "20600", 1000))
        .await;
    let x = order(
        "x9",
        Side::Sell,
        OrderType::Market,
        OrderRole::Exit,
        1,
        None,
    );
    let x = then(&x, 1100, |o| o.created_at = at(1100));
    book.send(&j, &x);
    book.send(&j, &filled(&x, 1100, "20590"));
    book.fill(&j, fill("h2", "x9", Side::Sell, 1, "20590", 1100))
        .await;
    let s = j.stats(&GetStatsInput::default());
    let b = &s.behaviour;
    assert_eq!((b.n_activity, b.n_stop, b.n_partial), (2, 1, 0));
    let n = |v: &[Bucket], key: &str| v.iter().find(|x| x.key == key).unwrap().n;
    assert_eq!(n(&b.widened, "widened"), 1);
    assert_eq!(n(&b.widened, "never_widened"), 0);
    assert_eq!(n(&b.management, "widened"), 1);
    assert_eq!(n(&b.breakeven, "reached"), 1);
    assert_eq!(n(&b.breakeven, "reached_stop"), 1);
    assert_eq!(n(&b.unprotected, "always"), 1);
    assert_eq!(n(&b.unprotected, "never"), 1);
    assert_eq!(n(&b.ended_by, "stop"), 1);
    assert_eq!(n(&b.ended_by, "manual"), 1);
    assert_eq!(n(&b.first_move, "lt60"), 1);
    let widened = b.widened.iter().find(|x| x.key == "widened").unwrap();
    assert_eq!(widened.avg_r_initial, Some(0.98));
    assert_eq!(b.avg_initial_risk, Some(200.0));
    assert_eq!(b.unprotected_pct, Some(50.0));
    assert_eq!(b.recorded_since, Some(at(-60)));
    assert_eq!(s.overview.all.n_r_initial, 1);
    let by_moves = j.list(&ListTradesInput {
        sort: Some(TradeSortKey::StopMoves),
        ..ListTradesInput::default()
    });
    assert_eq!(
        by_moves.trades[0].activity.as_ref().unwrap().stop_moves,
        4,
        "most moves first"
    );
}

#[tokio::test]
async fn stored_orders_and_the_audit_are_reconstructed_once() {
    let store = Store::open_in_memory().unwrap();
    let entry = filled(
        &order(
            "e5",
            Side::Buy,
            OrderType::Market,
            OrderRole::Entry,
            1,
            None,
        ),
        0,
        "20600",
    );
    let mut stop = leg("s5", "e5", OrderType::Stop, 1, "20612");
    stop = filled(&stop, 300, "20612");
    stop.triggered_at = Some(at(300));
    let mut target = leg("t5", "e5", OrderType::Limit, 1, "20650");
    target.status = OrderStatus::Cancelled;
    target.reason = Some("The other side of the bracket filled.".into());
    target.updated_at = at(300);
    store
        .broker("paper")
        .apply(
            &BrokerBatch {
                orders: vec![entry, stop, target],
                ..BrokerBatch::default()
            },
            at(300),
        )
        .unwrap();
    call(
        &store,
        "c-submit",
        "orders.submit",
        Origin::User,
        0,
        serde_json::json!({"accountId": ACCOUNT, "instrument": "NQ", "side": "buy", "orderType": "market", "qty": 1, "bracket": {"stopLoss": 20590, "takeProfit": 20650}}),
    );
    call(
        &store,
        "c-be",
        "orders.modify",
        Origin::User,
        100,
        serde_json::json!({"accountId": ACCOUNT, "orderId": "s5", "stopPrice": 20600}),
    );
    let j = service(&store);
    let kept = events_kept(&store);
    assert!(kept > 0);
    let book = Book::default();
    book.fill(&j, fill("k1", "e5", Side::Buy, 1, "20600", 0))
        .await;
    book.fill(&j, fill("k2", "s5", Side::Sell, 1, "20612", 300))
        .await;
    let trade = j.trades()[0].clone();
    let a = trade.activity.clone().unwrap();
    assert_eq!(a.coverage, Coverage::Partial);
    assert_eq!(
        a.initial_stop,
        Some(20590.0),
        "the bracket the submit asked for"
    );
    assert_eq!(a.initial_target, Some(20650.0));
    assert_eq!((a.stop_moves, a.tightened), (2, 2));
    assert_eq!(a.breakeven_secs, Some(100.0));
    assert_eq!(a.ended_by, Some(EndedBy::Stop));
    let d = j
        .trade(&GetTradeInput {
            id: trade.id.clone(),
            filter: None,
        })
        .await
        .unwrap()
        .activity
        .unwrap();
    let moves: Vec<_> = d
        .rows
        .iter()
        .filter(|r| r.event.kind == OrderEventKind::StopMoved)
        .map(|r| (r.actor.kind, r.event.approx, r.event.source))
        .collect();
    assert_eq!(
        moves,
        vec![
            (ActorKind::Trader, false, EventSource::Audit),
            (ActorKind::Outside, true, EventSource::Stored),
        ]
    );
    let cat = j.catalog().unwrap();
    assert!(cat.activity[0].backfilled_at.is_some());
    assert!(cat.activity[0].live_since.is_none());
    drop(j);
    let _j = service(&store);
    assert_eq!(events_kept(&store), kept);
}
