use std::collections::{BTreeMap, HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::hash::sha256_hex;
use tessera_core::orders::{Order, OrderRole, OrderStatus, OrderType, Side, StopRules};
use tessera_core::{Origin, Price, Timestamp};
use ts_rs::TS;

const SEC: i64 = 1_000_000_000;

const REPLACE_WINDOW: i64 = 10 * SEC;

/// What changed on an order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrderEventKind {
    /// First seen: placed (a bracket's leg is held until its entry fills).
    Placed,
    /// Its stop price changed.
    StopMoved,
    /// Its limit price changed.
    LimitMoved,
    /// Its quantity changed.
    QtyChanged,
    /// A bracket leg began working: its entry filled.
    Activated,
    /// A stop triggered.
    Triggered,
    /// Part of it filled.
    PartFilled,
    /// It filled completely.
    Filled,
    Cancelled,
    /// Refused by the broker.
    Rejected,
    /// Its time in force ran out.
    Expired,
}

impl OrderEventKind {
    fn rank(self) -> i64 {
        match self {
            OrderEventKind::Placed => 0,
            OrderEventKind::QtyChanged => 1,
            OrderEventKind::StopMoved => 2,
            OrderEventKind::LimitMoved => 3,
            OrderEventKind::Activated => 4,
            OrderEventKind::Triggered => 5,
            OrderEventKind::PartFilled => 6,
            OrderEventKind::Filled => 7,
            OrderEventKind::Cancelled => 8,
            OrderEventKind::Rejected => 9,
            OrderEventKind::Expired => 10,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            OrderEventKind::Placed => "placed",
            OrderEventKind::StopMoved => "stop_moved",
            OrderEventKind::LimitMoved => "limit_moved",
            OrderEventKind::QtyChanged => "qty_changed",
            OrderEventKind::Activated => "activated",
            OrderEventKind::Triggered => "triggered",
            OrderEventKind::PartFilled => "part_filled",
            OrderEventKind::Filled => "filled",
            OrderEventKind::Cancelled => "cancelled",
            OrderEventKind::Rejected => "rejected",
            OrderEventKind::Expired => "expired",
        }
    }
}

/// How the journal knows of an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    /// Seen as it happened, on the connection's stream of order updates.
    Live,
    /// Found changed when the journal read the connection's orders again (after a restart, or a
    /// stream that fell behind): what happened in between is not known.
    Resync,
    /// Reconstructed from an order as the paper broker stored it (its last state).
    Stored,
    /// Reconstructed from Tessera's own order call, as the audit kept it.
    Audit,
}

impl EventSource {
    pub fn as_str(self) -> &'static str {
        match self {
            EventSource::Live => "live",
            EventSource::Resync => "resync",
            EventSource::Stored => "stored",
            EventSource::Audit => "audit",
        }
    }
}

/// One change of one order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrderEvent {
    /// Stable id (the order, the change and its time).
    pub id: String,
    /// The order.
    pub order_id: String,
    /// The entry a bracket leg belongs to.
    pub parent_id: Option<String>,
    /// Account.
    pub account_id: String,
    /// Exact instrument (`NQZ6.CME`).
    pub instrument: String,
    /// Side of the order.
    pub side: Side,
    /// What the order is for, as the connection says.
    pub role: OrderRole,
    /// Its type.
    pub order_type: OrderType,
    /// Exit only.
    pub reduce_only: bool,
    /// What changed.
    pub kind: OrderEventKind,
    /// When: the broker's time of the change, else when the journal received it.
    #[ts(type = "number")]
    pub ts: Timestamp,
    /// When the journal received it (events seen live).
    #[ts(type = "number | null")]
    pub seen_at: Option<Timestamp>,
    /// Before the change: the price moved from, the quantity before, the quantity filled before.
    pub from: Option<f64>,
    /// After it.
    pub to: Option<f64>,
    /// The order's quantity after it.
    pub qty: f64,
    /// Filled so far.
    pub filled_qty: f64,
    /// Average fill price so far.
    pub avg_fill_price: Option<f64>,
    /// Stop price after it.
    pub stop_price: Option<f64>,
    /// Limit price after it.
    pub limit_price: Option<f64>,
    /// Status after it.
    pub status: OrderStatus,
    /// The broker's reason (a cancel's, a refusal's).
    pub reason: Option<String>,
    /// The stop's own breakeven or trailing rule, which the broker applies by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stop_rules: Option<StopRules>,
    /// How the journal knows of it.
    pub source: EventSource,
    /// Its time is a bound: the change happened at or before it.
    pub approx: bool,
    /// The Tessera call it was reconstructed from.
    pub call_id: Option<String>,
    /// Order among events at one instant.
    #[ts(type = "number")]
    pub seq: i64,
}

fn px(p: Option<Price>) -> Option<f64> {
    p.map(Price::to_f64)
}

fn open_status(s: OrderStatus) -> bool {
    matches!(
        s,
        OrderStatus::PendingSubmit
            | OrderStatus::Working
            | OrderStatus::PartiallyFilled
            | OrderStatus::PendingCancel
    )
}

fn event_id(
    order: &str,
    kind: OrderEventKind,
    ts: Timestamp,
    from: Option<f64>,
    to: Option<f64>,
) -> String {
    format!(
        "ev{}",
        &sha256_hex(format!("{order}|{}|{}|{from:?}|{to:?}", kind.as_str(), ts.0).as_bytes())[..20]
    )
}

#[allow(clippy::too_many_arguments)]
fn event_of(
    o: &Order,
    kind: OrderEventKind,
    ts: Timestamp,
    from: Option<f64>,
    to: Option<f64>,
    seen_at: Option<Timestamp>,
    source: EventSource,
    approx: bool,
) -> OrderEvent {
    OrderEvent {
        id: event_id(o.id.as_str(), kind, ts, from, to),
        order_id: o.id.to_string(),
        parent_id: o.parent_id.as_ref().map(ToString::to_string),
        account_id: o.request.account_id.to_string(),
        instrument: o.request.instrument.to_string(),
        side: o.request.side,
        role: o.role,
        order_type: o.request.order_type,
        reduce_only: o.request.reduce_only,
        kind,
        ts,
        seen_at,
        from,
        to,
        qty: o.request.qty.to_f64(),
        filled_qty: o.filled_qty.to_f64(),
        avg_fill_price: px(o.avg_fill_price),
        stop_price: px(o.request.stop_price),
        limit_price: px(o.request.limit_price),
        status: o.status,
        reason: o.reason.clone(),
        stop_rules: o.stop_rules,
        source,
        approx,
        call_id: None,
        seq: 0,
    }
}

fn working_price(o: &Order) -> Option<f64> {
    match o.request.order_type {
        OrderType::Stop | OrderType::StopLimit => px(o.request.stop_price),
        OrderType::Limit => px(o.request.limit_price),
        OrderType::Market => None,
    }
}

pub fn diff(
    prev: Option<&Order>,
    next: &Order,
    received: Timestamp,
    source: EventSource,
) -> Vec<OrderEvent> {
    let live = source == EventSource::Live;
    let seen = live.then_some(received);
    let at = if next.updated_at.0 > 0 {
        next.updated_at
    } else {
        received
    };
    let mut out = Vec::new();
    let placed;
    let prev = match prev {
        Some(p) => p,
        None => {
            let ts = if next.created_at.0 > 0 {
                next.created_at
            } else {
                at
            };
            let mut p = next.clone();
            p.status = if next.status == OrderStatus::Held {
                OrderStatus::Held
            } else if open_status(next.status) {
                next.status
            } else {
                OrderStatus::Working
            };
            p.filled_qty = tessera_core::Qty::ZERO;
            p.avg_fill_price = None;
            p.triggered_at = None;
            p.reason = None;
            let mut e = event_of(
                &p,
                OrderEventKind::Placed,
                ts,
                None,
                working_price(next),
                seen,
                source,
                !live,
            );
            e.status = p.status;
            out.push(e);
            placed = p;
            &placed
        }
    };
    let ev = |kind, ts, from, to, approx| event_of(next, kind, ts, from, to, seen, source, approx);
    let moved_approx = !live;
    let (s0, s1) = (px(prev.request.stop_price), px(next.request.stop_price));
    if s0 != s1 && next.request.order_type != OrderType::Market {
        out.push(ev(OrderEventKind::StopMoved, at, s0, s1, moved_approx));
    }
    let (l0, l1) = (px(prev.request.limit_price), px(next.request.limit_price));
    if l0 != l1 && next.request.order_type != OrderType::Market {
        out.push(ev(OrderEventKind::LimitMoved, at, l0, l1, moved_approx));
    }
    let (q0, q1) = (prev.request.qty.to_f64(), next.request.qty.to_f64());
    if q0 != q1 {
        out.push(ev(
            OrderEventKind::QtyChanged,
            at,
            Some(q0),
            Some(q1),
            moved_approx,
        ));
    }
    if prev.status == OrderStatus::Held
        && next.status != OrderStatus::Held
        && (open_status(next.status) || next.status == OrderStatus::Filled)
    {
        out.push(ev(OrderEventKind::Activated, at, None, None, moved_approx));
    }
    if prev.triggered_at.is_none()
        && let Some(t) = next.triggered_at
    {
        out.push(ev(
            OrderEventKind::Triggered,
            t,
            None,
            px(next.request.stop_price),
            false,
        ));
    }
    let (f0, f1) = (prev.filled_qty.to_f64(), next.filled_qty.to_f64());
    let filled_now = next.status == OrderStatus::Filled && prev.status != OrderStatus::Filled;
    if f1 > f0 || filled_now {
        let kind = if next.status == OrderStatus::Filled {
            OrderEventKind::Filled
        } else {
            OrderEventKind::PartFilled
        };
        out.push(ev(kind, at, Some(f0), Some(f1), false));
    }
    if next.status != prev.status {
        let kind = match next.status {
            OrderStatus::Cancelled => Some(OrderEventKind::Cancelled),
            OrderStatus::Rejected => Some(OrderEventKind::Rejected),
            OrderStatus::Expired => Some(OrderEventKind::Expired),
            _ => None,
        };
        if let Some(k) = kind {
            out.push(ev(k, at, None, None, false));
        }
    }
    out.sort_by_key(|e| (e.ts, e.kind.rank()));
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct OrderCall {
    pub call_id: String,
    pub tool: String,
    pub origin: Origin,
    pub input: Value,
    pub started_at: Timestamp,
    pub finished_at: Option<Timestamp>,
    pub approved: bool,
    pub summary: Option<String>,
}

pub const PROTECT_TOOL: &str = "orders.protect";

pub const COPY_TOOL: &str = "orders.copy";

pub const ORDER_TOOLS: [&str; 11] = [
    "orders.submit",
    "orders.create_draft",
    "orders.modify",
    "orders.cancel",
    "orders.cancel_all",
    "orders.flatten",
    "orders.merge_brackets",
    "orders.breakeven",
    "orders.reverse",
    PROTECT_TOOL,
    COPY_TOOL,
];

fn tool_of(c: &OrderCall) -> &str {
    if c.tool == COPY_TOOL {
        field(&c.input, "copyOf")
            .and_then(Value::as_str)
            .unwrap_or(COPY_TOOL)
    } else {
        &c.tool
    }
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn field<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.get(k).filter(|x| !x.is_null())
}

fn same(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() < 1e-9,
        _ => false,
    }
}

/// Who changed an order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    /// The trader, through Tessera.
    Trader,
    /// The analyst (an agent session), released by the trader's approval or by the Full access the
    /// trader gave the session.
    Analyst,
    /// An external MCP client, released by the trader's approval.
    Client,
    /// Tessera itself: the position's stop and target kept to the position as the trader's setting
    /// says (decision 0015): grown by an add, shrunk by an exit, cancelled when flat or reversed,
    /// an add's own legs folded into the bracket, or attached when the bracket was gone.
    Tessera,
    /// The broker by itself: a bracket leg activated, the other side of a bracket cancelled, a
    /// stop moved by its own breakeven or trailing rule, an order expired or refused, a liquidation.
    Broker,
    /// The market: a fill.
    Market,
    /// No Tessera call matches it: another platform, or the broker's side of a connection that
    /// does not say.
    Outside,
}

/// Who changed an order, and through what.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    /// Who.
    pub kind: ActorKind,
    /// The Tessera call (`orders.modify`), or the broker's own doing (`trailing`, `breakeven`,
    /// `bracket`, `liquidation`).
    pub via: Option<String>,
    /// The audited call.
    pub call_id: Option<String>,
    /// The analyst's session.
    pub session_id: Option<String>,
    /// What Tessera's own change came to (`NQZ6: Grew the stop and the target to 31`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary: Option<String>,
}

impl Actor {
    fn of(kind: ActorKind, via: Option<&str>) -> Self {
        Self {
            kind,
            via: via.map(str::to_owned),
            call_id: None,
            session_id: None,
            summary: None,
        }
    }

    fn by_call(c: &OrderCall) -> Self {
        let (kind, session_id) = match &c.origin {
            _ if c.tool == PROTECT_TOOL => (ActorKind::Tessera, None),
            Origin::User => (ActorKind::Trader, None),
            Origin::Agent { session_id, .. } => (ActorKind::Analyst, Some(session_id.to_string())),
            Origin::External { .. } => (ActorKind::Client, None),
        };
        Self {
            kind,
            via: Some(c.tool.clone()),
            call_id: Some(c.call_id.clone()),
            session_id,
            summary: (c.tool == PROTECT_TOOL)
                .then(|| c.summary.clone())
                .flatten(),
        }
    }
}

fn lists(input: &Value, key: &str, id: &str) -> bool {
    field(input, key)
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(id)))
}

fn protected_by(
    calls: &[OrderCall],
    account: &str,
    t: Timestamp,
    key: &str,
    id: &str,
) -> Option<Actor> {
    let c = nearest(calls, t, |c| {
        c.tool == PROTECT_TOOL && account_is(&c.input, account) && lists(&c.input, key, id)
    })?;
    if field(&c.input, "merge").and_then(Value::as_bool) == Some(true)
        && let Some(m) = nearest(calls, t, |m| {
            m.tool == "orders.merge_brackets" && account_is(&m.input, account)
        })
    {
        return Some(Actor::by_call(m));
    }
    Some(Actor::by_call(c))
}

fn instrument_matches(input: &Value, instrument: &str) -> bool {
    let Some(want) = field(input, "instrument").and_then(Value::as_str) else {
        return true;
    };
    let want = want.split('.').next().unwrap_or(want).to_ascii_uppercase();
    let have = instrument
        .split('.')
        .next()
        .unwrap_or(instrument)
        .to_ascii_uppercase();
    !want.is_empty() && have.starts_with(&want)
}

fn in_window(c: &OrderCall, t: Timestamp) -> bool {
    let end = c.finished_at.unwrap_or(c.started_at);
    t.0 >= c.started_at.0 - 2 * SEC && t.0 <= end.0 + 10 * SEC
}

fn account_is(input: &Value, account: &str) -> bool {
    field(input, "accountId").and_then(Value::as_str) == Some(account)
}

fn submit_matches(c: &OrderCall, e: &OrderEvent) -> bool {
    let i = &c.input;
    let tool = tool_of(c);
    if tool == "orders.reverse" {
        return e.order_type == OrderType::Market
            && account_is(i, &e.account_id)
            && instrument_matches(i, &e.instrument);
    }
    (tool == "orders.submit" || tool == "orders.create_draft")
        && account_is(i, &e.account_id)
        && field(i, "side").and_then(Value::as_str) == Some(side_str(e.side))
        && field(i, "orderType").and_then(Value::as_str) == Some(type_str(e.order_type))
        && instrument_matches(i, &e.instrument)
}

fn side_str(s: Side) -> &'static str {
    match s {
        Side::Buy => "buy",
        Side::Sell => "sell",
    }
}

fn type_str(t: OrderType) -> &'static str {
    match t {
        OrderType::Market => "market",
        OrderType::Limit => "limit",
        OrderType::Stop => "stop",
        OrderType::StopLimit => "stop_limit",
    }
}

fn nearest(
    calls: &[OrderCall],
    t: Timestamp,
    ok: impl Fn(&OrderCall) -> bool,
) -> Option<&OrderCall> {
    calls
        .iter()
        .filter(|c| in_window(c, t) && ok(c))
        .min_by_key(|c| (c.started_at.0 - t.0).abs())
}

pub fn attribute(rows: &[&OrderEvent], context: &[OrderEvent], calls: &[OrderCall]) -> Vec<Actor> {
    let by_id: HashMap<&str, &OrderCall> = calls.iter().map(|c| (c.call_id.as_str(), c)).collect();
    let placed: HashMap<&str, &OrderEvent> = context
        .iter()
        .filter(|e| e.kind == OrderEventKind::Placed)
        .map(|e| (e.order_id.as_str(), e))
        .collect();
    let placed_by = |e: &OrderEvent| -> Actor {
        let t = e.seen_at.unwrap_or(e.ts);
        if let Some(c) = e.call_id.as_deref().and_then(|id| by_id.get(id)) {
            return Actor::by_call(c);
        }
        if e.reason
            .as_deref()
            .is_some_and(|r| r.starts_with("Liquidated"))
        {
            return Actor::of(ActorKind::Broker, Some("liquidation"));
        }
        if let Some(c) = nearest(calls, t, |c| submit_matches(c, e)) {
            return Actor::by_call(c);
        }
        if e.role == OrderRole::Exit
            && let Some(c) = nearest(calls, t, |c| {
                tool_of(c) == "orders.flatten"
                    && account_is(&c.input, &e.account_id)
                    && instrument_matches(&c.input, &e.instrument)
            })
        {
            return Actor::by_call(c);
        }
        if let Some(a) = protected_by(calls, &e.account_id, t, "orders", &e.order_id) {
            return a;
        }
        Actor::of(ActorKind::Outside, None)
    };
    let placed_actor = |order: &str| -> Option<Actor> { placed.get(order).map(|e| placed_by(e)) };
    rows.iter()
        .map(|e| {
            let t = e.seen_at.unwrap_or(e.ts);
            if let Some(c) = e.call_id.as_deref().and_then(|id| by_id.get(id)) {
                return Actor::by_call(c);
            }
            match e.kind {
                OrderEventKind::Placed => {
                    if let Some(parent) = e.parent_id.as_deref() {
                        if let Some(a) = protected_by(calls, &e.account_id, t, "entries", parent) {
                            return a;
                        }
                        if let Some(a) = placed_actor(parent) {
                            return a;
                        }
                        if let Some(c) = nearest(calls, t, |c| {
                            matches!(tool_of(c), "orders.submit" | "orders.create_draft")
                                && account_is(&c.input, &e.account_id)
                                && field(&c.input, "bracket").is_some_and(|b| {
                                    let leg = if e.role == OrderRole::TakeProfit {
                                        "takeProfit"
                                    } else {
                                        "stopLoss"
                                    };
                                    same(field(b, leg).and_then(num), e.to)
                                })
                        }) {
                            return Actor::by_call(c);
                        }
                        return Actor::of(ActorKind::Outside, None);
                    }
                    placed_by(e)
                }
                OrderEventKind::StopMoved
                | OrderEventKind::LimitMoved
                | OrderEventKind::QtyChanged => {
                    if let Some(a) = protected_by(calls, &e.account_id, t, "orders", &e.order_id) {
                        return a;
                    }
                    let key = match e.kind {
                        OrderEventKind::StopMoved => "stopPrice",
                        OrderEventKind::LimitMoved => "limitPrice",
                        _ => "qty",
                    };
                    let hit = nearest(calls, t, |c| {
                        if tool_of(c) == "orders.breakeven" {
                            return e.kind != OrderEventKind::QtyChanged
                                && account_is(&c.input, &e.account_id)
                                && instrument_matches(&c.input, &e.instrument);
                        }
                        if tool_of(c) != "orders.modify" {
                            return false;
                        }
                        let target = field(&c.input, "orderId").and_then(Value::as_str);
                        let mine = target == Some(e.order_id.as_str());
                        let parent = e.parent_id.is_some() && target == e.parent_id.as_deref();
                        let value = field(&c.input, key).and_then(num);
                        (mine && (value.is_none() || same(value, e.to)))
                            || (parent && e.kind == OrderEventKind::QtyChanged)
                    });
                    if let Some(c) = hit {
                        return Actor::by_call(c);
                    }
                    if e.kind == OrderEventKind::StopMoved
                        && let Some(r) = e.stop_rules
                    {
                        let via = if r.trail.is_some() {
                            "trailing"
                        } else {
                            "breakeven"
                        };
                        if r.trail.is_some() || r.breakeven.is_some() {
                            return Actor::of(ActorKind::Broker, Some(via));
                        }
                    }
                    if e.kind == OrderEventKind::QtyChanged && e.parent_id.is_some() {
                        return Actor::of(ActorKind::Broker, Some("bracket"));
                    }
                    Actor::of(ActorKind::Outside, None)
                }
                OrderEventKind::Cancelled => {
                    if let Some(a) = protected_by(calls, &e.account_id, t, "orders", &e.order_id) {
                        return a;
                    }
                    let hit = nearest(calls, t, |c| match tool_of(c) {
                        "orders.cancel" => {
                            let target = field(&c.input, "orderId").and_then(Value::as_str);
                            target == Some(e.order_id.as_str())
                                || (e.parent_id.is_some() && target == e.parent_id.as_deref())
                        }
                        "orders.cancel_all" | "orders.flatten" | "orders.reverse" => {
                            account_is(&c.input, &e.account_id)
                                && instrument_matches(&c.input, &e.instrument)
                        }
                        _ => false,
                    });
                    if let Some(c) = hit {
                        return Actor::by_call(c);
                    }
                    let broker_reason = e
                        .reason
                        .as_deref()
                        .is_some_and(|r| !r.trim().is_empty() && r != "Cancelled.");
                    let sibling_filled = e.parent_id.as_deref().is_some_and(|p| {
                        context.iter().any(|x| {
                            x.parent_id.as_deref() == Some(p)
                                && x.order_id != e.order_id
                                && matches!(
                                    x.kind,
                                    OrderEventKind::Filled | OrderEventKind::PartFilled
                                )
                                && x.ts.0 <= e.ts.0
                                && e.ts.0 - x.ts.0 <= 5 * SEC
                        })
                    });
                    if broker_reason || sibling_filled {
                        Actor::of(ActorKind::Broker, Some("bracket"))
                    } else {
                        Actor::of(ActorKind::Outside, None)
                    }
                }
                OrderEventKind::Activated => Actor::of(ActorKind::Broker, Some("bracket")),
                OrderEventKind::Triggered | OrderEventKind::PartFilled | OrderEventKind::Filled => {
                    Actor::of(ActorKind::Market, None)
                }
                OrderEventKind::Rejected | OrderEventKind::Expired => {
                    Actor::of(ActorKind::Broker, None)
                }
            }
        })
        .collect()
}

pub fn reconstruct(
    stored: &[Order],
    calls: &[OrderCall],
    first_fill: &HashMap<String, Timestamp>,
    known: &HashSet<String>,
    tick_of: impl Fn(&str) -> Option<f64>,
) -> Vec<OrderEvent> {
    let by_id: HashMap<&str, &Order> = stored.iter().map(|o| (o.id.as_str(), o)).collect();
    let submits: Vec<&OrderCall> = calls
        .iter()
        .filter(|c| c.tool == "orders.submit" || c.tool == "orders.create_draft")
        .collect();
    let submit_of = |o: &Order| -> Option<&OrderCall> {
        let probe = event_of(
            o,
            OrderEventKind::Placed,
            o.created_at,
            None,
            None,
            None,
            EventSource::Stored,
            true,
        );
        submits
            .iter()
            .copied()
            .filter(|c| {
                c.started_at.0 <= o.created_at.0 + 2 * SEC
                    && o.created_at.0 - c.started_at.0 <= 30 * SEC
                    && submit_matches(c, &probe)
            })
            .min_by_key(|c| (o.created_at.0 - c.started_at.0).abs())
    };
    let mut out = Vec::new();
    for o in stored {
        if known.contains(o.id.as_str()) {
            continue;
        }
        let is_stop = matches!(o.request.order_type, OrderType::Stop | OrderType::StopLimit);
        let price_key = if is_stop { "stopPrice" } else { "limitPrice" };
        let (initial, call) = match o.parent_id.as_ref().and_then(|p| by_id.get(p.as_str())) {
            Some(parent) => match submit_of(parent) {
                Some(c) => {
                    let target = o.role == OrderRole::TakeProfit;
                    let (leg, leg_ticks) = if target {
                        ("takeProfit", "targetTicks")
                    } else {
                        ("stopLoss", "stopTicks")
                    };
                    let bracket = field(&c.input, "bracket");
                    let p = bracket
                        .and_then(|b| field(b, leg))
                        .and_then(num)
                        .or_else(|| {
                            let ticks = bracket.and_then(|b| field(b, leg_ticks)).and_then(num)?;
                            let fill = parent.avg_fill_price?.to_f64();
                            let away = ticks * tick_of(o.request.instrument.as_str())?;
                            let up = (parent.request.side == Side::Buy) == target;
                            Some(if up { fill + away } else { fill - away })
                        });
                    (p, p.map(|_| c))
                }
                None => (None, None),
            },
            None => match submit_of(o) {
                Some(c) => {
                    let p = field(&c.input, price_key).and_then(num);
                    (p, Some(c))
                }
                None => (None, None),
            },
        };
        let mut modifies: Vec<&OrderCall> = calls
            .iter()
            .filter(|c| {
                c.tool == "orders.modify"
                    && field(&c.input, "orderId").and_then(Value::as_str) == Some(o.id.as_str())
                    && field(&c.input, price_key).is_some()
                    && c.started_at.0 >= o.created_at.0
                    && c.started_at.0 <= o.updated_at.0.max(o.created_at.0) + 2 * SEC
            })
            .collect();
        modifies.sort_by_key(|c| c.started_at);
        let final_price = working_price(o);
        let start_price = initial.or(if modifies.is_empty() {
            final_price
        } else {
            None
        });
        let leg = o.parent_id.is_some();
        let activated = if leg {
            o.parent_id
                .as_ref()
                .and_then(|p| first_fill.get(p.as_str()).copied())
                .filter(|t| t.0 <= o.updated_at.0)
        } else {
            None
        };
        let mut state = o.clone();
        state.status = if leg {
            OrderStatus::Held
        } else {
            OrderStatus::Working
        };
        state.filled_qty = tessera_core::Qty::ZERO;
        state.avg_fill_price = None;
        state.reason = None;
        let set_price = |s: &mut Order, p: Option<f64>| {
            let p = p.and_then(Price::from_f64);
            if is_stop {
                s.request.stop_price = p;
            } else {
                s.request.limit_price = p;
            }
        };
        set_price(&mut state, start_price);
        let source = if call.is_some() {
            EventSource::Audit
        } else {
            EventSource::Stored
        };
        let mut evs = Vec::new();
        let mut placed = event_of(
            &state,
            OrderEventKind::Placed,
            o.created_at,
            None,
            start_price,
            None,
            source,
            call.is_none(),
        );
        placed.call_id = call.map(|c| c.call_id.clone());
        evs.push(placed);
        enum Step<'a> {
            Activate,
            Modify(&'a OrderCall),
        }
        let mut steps: Vec<(Timestamp, Step<'_>)> = modifies
            .iter()
            .map(|c| (c.started_at, Step::Modify(c)))
            .collect();
        if let Some(t) = activated {
            steps.push((t, Step::Activate));
        }
        steps.sort_by_key(|(t, s)| (*t, matches!(s, Step::Modify(_))));
        let mut last = start_price;
        for (t, step) in steps {
            match step {
                Step::Activate => {
                    if state.status == OrderStatus::Held {
                        state.status = OrderStatus::Working;
                        evs.push(event_of(
                            &state,
                            OrderEventKind::Activated,
                            t,
                            None,
                            None,
                            None,
                            EventSource::Stored,
                            false,
                        ));
                    }
                }
                Step::Modify(c) => {
                    let to = field(&c.input, price_key).and_then(num);
                    if to.is_none() || same(to, last) {
                        continue;
                    }
                    set_price(&mut state, to);
                    let kind = if is_stop {
                        OrderEventKind::StopMoved
                    } else {
                        OrderEventKind::LimitMoved
                    };
                    let mut e =
                        event_of(&state, kind, t, last, to, None, EventSource::Audit, false);
                    e.call_id = Some(c.call_id.clone());
                    evs.push(e);
                    last = to;
                }
            }
        }
        let end = o.updated_at;
        if final_price.is_some() && !same(final_price, last) && last.is_some() {
            set_price(&mut state, final_price);
            let kind = if is_stop {
                OrderEventKind::StopMoved
            } else {
                OrderEventKind::LimitMoved
            };
            evs.push(event_of(
                &state,
                kind,
                end,
                last,
                final_price,
                None,
                EventSource::Stored,
                true,
            ));
        }
        let filled = o.filled_qty.to_f64();
        if filled > 0.0 || o.status == OrderStatus::Filled {
            let kind = if o.status == OrderStatus::Filled {
                OrderEventKind::Filled
            } else {
                OrderEventKind::PartFilled
            };
            state.filled_qty = o.filled_qty;
            state.avg_fill_price = o.avg_fill_price;
            state.status = if kind == OrderEventKind::Filled {
                OrderStatus::Filled
            } else {
                OrderStatus::PartiallyFilled
            };
            evs.push(event_of(
                &state,
                kind,
                end,
                Some(0.0),
                Some(filled),
                None,
                EventSource::Stored,
                false,
            ));
        }
        let terminal = match o.status {
            OrderStatus::Cancelled => Some(OrderEventKind::Cancelled),
            OrderStatus::Rejected => Some(OrderEventKind::Rejected),
            OrderStatus::Expired => Some(OrderEventKind::Expired),
            _ => None,
        };
        if let Some(k) = terminal {
            state.status = o.status;
            state.reason = o.reason.clone();
            evs.push(event_of(
                &state,
                k,
                end,
                None,
                None,
                None,
                EventSource::Stored,
                false,
            ));
        }
        out.extend(evs);
    }
    out.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.kind.rank().cmp(&b.kind.rank())));
    out
}

/// What an order was to a trade.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Leg {
    /// It opened or added to the position.
    Entry,
    /// A stop that covered it.
    Stop,
    /// A target (an opposite-side limit) that covered it.
    Target,
    /// Another order that took part of it off or closed it.
    Exit,
}

/// How a trade ended, from the order whose fill closed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EndedBy {
    /// A stop that covered it filled.
    Stop,
    /// A target that covered it filled.
    Target,
    /// Another order closed it: a market or limit close, a flatten.
    Manual,
    /// The broker's liquidation.
    Liquidation,
}

/// Which way a stop moved, against the position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MoveDirection {
    /// Toward the market: less at risk (a long's stop up, a short's down).
    Tightened,
    /// Away from it: more at risk.
    Widened,
}

/// How complete a trade's activity is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    /// Every change was seen as it happened.
    Complete,
    /// Some of it was reconstructed (stored orders, the audit) or found on a resync, or the trade
    /// began before its account was recorded.
    Partial,
}

/// One step of a stop or target path: from `t`, this price (none: no working order).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathStep {
    /// From.
    #[ts(type = "number")]
    pub t: Timestamp,
    /// Price (the tightest working one); null while none works.
    pub price: Option<f64>,
}

/// One stop move while the position was open.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StopMove {
    /// When.
    #[ts(type = "number")]
    pub t: Timestamp,
    /// The order moved (the new one, for a cancel and replace).
    pub order_id: String,
    /// From.
    pub from: f64,
    /// To.
    pub to: f64,
    /// Ticks moved.
    pub ticks: f64,
    /// Tightened or widened.
    pub direction: MoveDirection,
    /// A stop cancelled and another placed within 10 s, read as one move.
    pub replaced: bool,
}

/// What the recorded activity measures of one trade. Every figure is a measurement of what the
/// orders did; none is a judgement.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    /// Complete, or partly reconstructed.
    pub coverage: Coverage,
    /// Orders linked to it (entries, stops, targets, exits).
    pub orders: u32,
    /// The first stop that covered it: the tightest working stop at the first moment, from the
    /// entry, that one worked.
    pub initial_stop: Option<f64>,
    /// When it first worked.
    #[ts(type = "number | null")]
    pub initial_stop_at: Option<Timestamp>,
    /// The first target that covered it.
    pub initial_target: Option<f64>,
    /// Money the trade put at risk as it was built: for every entry fill, its quantity × the
    /// distance from its price to the stop protecting it (its own bracket's stop, else the
    /// position's tightest working stop then or the first one after) × point value. None when an
    /// entry was never covered by a stop or nothing was at risk.
    pub initial_risk: Option<f64>,
    /// That distance in ticks.
    pub initial_risk_ticks: Option<f64>,
    /// Net P&L over the initial risk (closed trades).
    pub r_initial: Option<f64>,
    /// Stop moves while the position was open (each price change of a covering stop, and each
    /// stop cancelled and replaced within 10 s).
    pub stop_moves: u32,
    /// Moves toward the market.
    pub tightened: u32,
    /// Moves away from it.
    pub widened: u32,
    /// Tightening moves after the first one.
    pub trail_steps: u32,
    /// Seconds from the entry to the first stop move.
    pub first_move_secs: Option<f64>,
    /// When the stop first stood at the average entry or past it (in the position's favour).
    #[ts(type = "number | null")]
    pub breakeven_at: Option<Timestamp>,
    /// Seconds from the entry to then.
    pub breakeven_secs: Option<f64>,
    /// Seconds the position was open with no working stop.
    pub unprotected_secs: f64,
    /// No stop worked at any time while it was open.
    pub never_protected: bool,
    /// The stop farthest from the entry against the position, at any time.
    pub worst_stop: Option<f64>,
    /// Its distance from the average entry then, in ticks (negative: past the entry).
    pub worst_stop_ticks: Option<f64>,
    /// The order whose fill closed it.
    pub ended_by: Option<EndedBy>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FillRef {
    pub ts: Timestamp,
    pub qty: f64,
    pub price: f64,
    pub entry: bool,
    pub order_id: Option<String>,
    pub role: Option<OrderRole>,
}

#[derive(Clone, Debug)]
pub struct TradeInput<'a> {
    pub side: Side,
    pub opened_at: Timestamp,
    pub end: Timestamp,
    pub closed: bool,
    pub net: f64,
    pub fills: &'a [FillRef],
    pub tick: f64,
    pub mult: f64,
    pub live_since: Option<Timestamp>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TradeAnalysis {
    pub summary: ActivitySummary,
    pub stop_path: Vec<PathStep>,
    pub target_path: Vec<PathStep>,
    pub moves: Vec<StopMove>,
    pub legs: BTreeMap<String, Leg>,
    pub from: Timestamp,
    pub to: Timestamp,
    pub end: Timestamp,
    pub tick: f64,
}

#[derive(Clone, Copy, Debug)]
struct State {
    working: bool,
    stop: Option<f64>,
    limit: Option<f64>,
}

struct Track<'a> {
    first: &'a OrderEvent,
    events: Vec<&'a OrderEvent>,
    activates: Option<Timestamp>,
}

impl Track<'_> {
    fn at(&self, t: Timestamp) -> Option<State> {
        self.events
            .iter()
            .take_while(|e| e.ts <= t)
            .last()
            .map(|e| State {
                working: open_status(e.status)
                    || (e.status == OrderStatus::Held && self.activates.is_some_and(|a| a <= t)),
                stop: e.stop_price,
                limit: e.limit_price,
            })
    }

    fn is_stop(&self) -> bool {
        matches!(
            self.first.order_type,
            OrderType::Stop | OrderType::StopLimit
        ) || (self.first.role == OrderRole::StopLoss && self.first.order_type != OrderType::Limit)
    }

    fn is_target(&self) -> bool {
        !self.is_stop()
            && (self.first.order_type == OrderType::Limit
                || self.first.role == OrderRole::TakeProfit)
    }

    fn price(&self, s: State) -> Option<f64> {
        if self.is_stop() { s.stop } else { s.limit }
    }

    fn instants(&self) -> impl Iterator<Item = Timestamp> + '_ {
        self.events.iter().map(|e| e.ts).chain(self.activates)
    }

    fn works_within(&self, from: Timestamp, to: Timestamp) -> bool {
        self.at(from).is_some_and(|s| s.working)
            || self
                .instants()
                .any(|i| i > from && i <= to && self.at(i).is_some_and(|s| s.working))
    }

    fn works_from(&self, from: Timestamp) -> Option<Timestamp> {
        if self.at(from).is_some_and(|s| s.working) {
            return Some(from);
        }
        let mut at: Vec<Timestamp> = self.instants().filter(|i| *i > from).collect();
        at.sort();
        at.into_iter()
            .find(|i| self.at(*i).is_some_and(|s| s.working))
    }
}

fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn secs(a: Timestamp, b: Timestamp) -> f64 {
    ((b.0 - a.0) as f64 / SEC as f64 * 10.0).round() / 10.0
}

fn position_at(fills: &[FillRef], t: Timestamp) -> (f64, f64) {
    let (mut held, mut qty_in, mut value_in) = (0.0, 0.0, 0.0);
    for f in fills.iter().take_while(|f| f.ts <= t) {
        if f.entry {
            held += f.qty;
            qty_in += f.qty;
            value_in += f.qty * f.price;
        } else {
            held -= f.qty;
        }
    }
    (
        held.max(0.0),
        if qty_in > 0.0 { value_in / qty_in } else { 0.0 },
    )
}

pub fn analyse<'a>(
    t: &TradeInput<'_>,
    events: impl IntoIterator<Item = &'a OrderEvent>,
) -> Option<TradeAnalysis> {
    let long = t.side == Side::Buy;
    let opposite = if long { Side::Sell } else { Side::Buy };
    let (opened, end) = (t.opened_at, t.end.max(t.opened_at));
    let entry_ids: HashSet<&str> = t
        .fills
        .iter()
        .filter(|f| f.entry)
        .filter_map(|f| f.order_id.as_deref())
        .collect();
    let exit_ids: HashSet<&str> = t
        .fills
        .iter()
        .filter(|f| !f.entry)
        .filter_map(|f| f.order_id.as_deref())
        .collect();
    let mut entry_fill: HashMap<&str, Timestamp> = HashMap::new();
    for f in t.fills.iter().filter(|f| f.entry) {
        if let Some(id) = f.order_id.as_deref() {
            entry_fill.entry(id).or_insert(f.ts);
        }
    }
    let mut tracks: BTreeMap<&str, Track<'a>> = BTreeMap::new();
    for e in events {
        tracks
            .entry(e.order_id.as_str())
            .or_insert_with(|| Track {
                first: e,
                events: Vec::new(),
                activates: e
                    .parent_id
                    .as_deref()
                    .and_then(|p| entry_fill.get(p).copied()),
            })
            .events
            .push(e);
    }
    let mut legs: BTreeMap<String, Leg> = BTreeMap::new();
    for (id, tr) in &tracks {
        let f = tr.first;
        let leg = if entry_ids.contains(id) {
            Some(Leg::Entry)
        } else {
            let bracket = f
                .parent_id
                .as_deref()
                .is_some_and(|p| entry_ids.contains(p));
            let covering = f.side == opposite
                && (tr.is_stop() || tr.is_target())
                && tr.works_within(opened, end);
            if bracket || covering {
                Some(if tr.is_stop() { Leg::Stop } else { Leg::Target })
            } else if exit_ids.contains(id) {
                Some(Leg::Exit)
            } else {
                None
            }
        };
        if let Some(l) = leg {
            legs.insert((*id).to_owned(), l);
        }
    }
    let recorded_live = t.live_since.is_some_and(|s| s <= opened);
    if legs.is_empty() && !recorded_live {
        return None;
    }
    let of = |leg: Leg| -> Vec<&Track<'_>> {
        legs.iter()
            .filter(|(_, l)| **l == leg)
            .filter_map(|(id, _)| tracks.get(id.as_str()))
            .collect()
    };
    let stops = of(Leg::Stop);
    let targets = of(Leg::Target);
    let tight = |a: f64, b: f64| if long { a > b } else { a < b };
    let near = |a: f64, b: f64| if long { a < b } else { a > b };
    let path = |orders: &[&Track<'_>], better: &dyn Fn(f64, f64) -> bool| -> Vec<PathStep> {
        let mut instants: Vec<Timestamp> = vec![opened];
        for o in orders {
            instants.extend(o.instants().filter(|ts| *ts > opened && *ts <= end));
        }
        instants.sort();
        instants.dedup();
        let mut out: Vec<PathStep> = Vec::new();
        for at in instants {
            let mut best: Option<f64> = None;
            for o in orders {
                if let Some(s) = o.at(at).filter(|s| s.working)
                    && let Some(p) = o.price(s)
                    && best.is_none_or(|b| better(p, b))
                {
                    best = Some(p);
                }
            }
            if out.last().is_none_or(|l| l.price != best) {
                out.push(PathStep { t: at, price: best });
            }
        }
        out
    };
    let stop_path = path(&stops, &tight);
    let target_path = path(&targets, &near);
    let tick = if t.tick > 0.0 { t.tick } else { 0.01 };
    let direction = |from: f64, to: f64| {
        if tight(to, from) {
            MoveDirection::Tightened
        } else {
            MoveDirection::Widened
        }
    };
    let mut moves: Vec<StopMove> = Vec::new();
    for o in &stops {
        for e in &o.events {
            if e.kind == OrderEventKind::StopMoved
                && e.ts >= opened
                && e.ts <= end
                && let (Some(from), Some(to)) = (e.from, e.to)
                && (from - to).abs() > 1e-9
            {
                moves.push(StopMove {
                    t: e.ts,
                    order_id: e.order_id.clone(),
                    from,
                    to,
                    ticks: r2((to - from).abs() / tick),
                    direction: direction(from, to),
                    replaced: false,
                });
            }
        }
    }
    let mut used: HashSet<&str> = HashSet::new();
    for o in &stops {
        for e in &o.events {
            if e.kind != OrderEventKind::Cancelled || e.ts < opened || e.ts > end {
                continue;
            }
            if e.reason
                .as_deref()
                .is_some_and(|r| !r.trim().is_empty() && r != "Cancelled.")
            {
                continue;
            }
            let before = Timestamp(e.ts.0 - 1);
            let Some(old) = o.at(before).filter(|s| s.working).and_then(|s| o.price(s)) else {
                continue;
            };
            let replacement = stops
                .iter()
                .filter(|n| {
                    n.first.order_id != o.first.order_id
                        && !used.contains(n.first.order_id.as_str())
                })
                .filter_map(|n| {
                    let from = Timestamp(e.ts.0 - REPLACE_WINDOW);
                    if n.at(from).is_some_and(|s| s.working) {
                        return None;
                    }
                    let w = n.works_from(from)?;
                    (w.0 <= e.ts.0 + REPLACE_WINDOW).then_some((n, w))
                })
                .min_by_key(|(_, w)| (w.0 - e.ts.0).abs());
            if let Some((n, w)) = replacement
                && let Some(new) = n.at(w).and_then(|s| n.price(s))
                && (new - old).abs() > 1e-9
            {
                used.insert(n.first.order_id.as_str());
                moves.push(StopMove {
                    t: Timestamp(w.0.max(e.ts.0)),
                    order_id: n.first.order_id.clone(),
                    from: old,
                    to: new,
                    ticks: r2((new - old).abs() / tick),
                    direction: direction(old, new),
                    replaced: true,
                });
            }
        }
    }
    moves.sort_by_key(|m| m.t);
    let tightened = moves
        .iter()
        .filter(|m| m.direction == MoveDirection::Tightened)
        .count() as u32;
    let widened = moves.len() as u32 - tightened;
    let first = stop_path.iter().find(|s| s.price.is_some());
    let (initial_stop, initial_stop_at) = (first.and_then(|s| s.price), first.map(|s| s.t));
    let mut initial_risk_ticks = None;
    if let (Some(stop), Some(at)) = (initial_stop, initial_stop_at) {
        let (_, avg) = position_at(t.fills, at);
        let dist = if long { avg - stop } else { stop - avg };
        initial_risk_ticks = Some(r2(dist / tick));
    }
    let own_stop = |entry: &str| -> Option<f64> {
        stops
            .iter()
            .filter(|tr| tr.first.parent_id.as_deref() == Some(entry))
            .filter_map(|tr| {
                let w = tr.works_from(opened)?;
                tr.at(w).and_then(|s| tr.price(s))
            })
            .reduce(|a, b| if tight(a, b) { b } else { a })
    };
    let covering_at = |at: Timestamp| -> Option<f64> {
        stop_path
            .iter()
            .take_while(|s| s.t <= at)
            .last()
            .and_then(|s| s.price)
            .or_else(|| stop_path.iter().filter(|s| s.t > at).find_map(|s| s.price))
    };
    let mut at_risk = Some(0.0);
    for f in t.fills.iter().filter(|f| f.entry) {
        let stop = f
            .order_id
            .as_deref()
            .and_then(own_stop)
            .or_else(|| covering_at(f.ts));
        at_risk = match (at_risk, stop) {
            (Some(sum), Some(stop)) => {
                let dist = if long { f.price - stop } else { stop - f.price };
                Some(sum + dist.max(0.0) * t.mult * f.qty)
            }
            _ => None,
        };
    }
    let initial_risk = at_risk.filter(|r| *r > 1e-9).map(r2);
    let r_initial = initial_risk
        .filter(|r| *r > 0.0 && t.closed)
        .map(|r| r2(t.net / r));
    let eps = tick * 0.01;
    let breakeven_at = stop_path
        .iter()
        .find(|s| {
            s.price.is_some_and(|p| {
                let (_, avg) = position_at(t.fills, s.t);
                if long { p >= avg - eps } else { p <= avg + eps }
            })
        })
        .map(|s| s.t);
    let mut unprotected = 0i64;
    let mut worst: Option<(f64, f64)> = None;
    for (i, s) in stop_path.iter().enumerate() {
        let next = stop_path.get(i + 1).map_or(end, |n| n.t);
        match s.price {
            None => unprotected += (next.0 - s.t.0).max(0),
            Some(p) => {
                let (_, avg) = position_at(t.fills, s.t);
                let dist = if long { avg - p } else { p - avg };
                if worst.is_none_or(|(d, _)| dist > d) {
                    worst = Some((dist, p));
                }
            }
        }
    }
    let ended_by = if t.closed {
        t.fills.iter().rev().find(|f| !f.entry).and_then(|f| {
            let leg = f.order_id.as_deref().and_then(|id| legs.get(id).copied());
            match (leg, f.role) {
                (Some(Leg::Stop), _) | (None, Some(OrderRole::StopLoss)) => Some(EndedBy::Stop),
                (Some(Leg::Target), _) | (None, Some(OrderRole::TakeProfit)) => {
                    Some(EndedBy::Target)
                }
                _ => {
                    let liquidated = f
                        .order_id
                        .as_deref()
                        .and_then(|id| tracks.get(id))
                        .is_some_and(|tr| {
                            tr.events.iter().any(|e| {
                                e.reason
                                    .as_deref()
                                    .is_some_and(|r| r.starts_with("Liquidated"))
                            })
                        });
                    if liquidated {
                        Some(EndedBy::Liquidation)
                    } else if f.order_id.is_some() {
                        Some(EndedBy::Manual)
                    } else {
                        None
                    }
                }
            }
        })
    } else {
        None
    };
    let from = legs
        .iter()
        .filter(|(_, l)| **l == Leg::Entry)
        .filter_map(|(id, _)| tracks.get(id.as_str()))
        .map(|tr| tr.first.ts)
        .min()
        .map_or(opened, |p| p.min(opened));
    let to = Timestamp(end.0 + 5 * SEC);
    let approx = legs
        .keys()
        .filter_map(|id| tracks.get(id.as_str()))
        .any(|tr| {
            tr.events
                .iter()
                .any(|e| e.ts <= to && e.source != EventSource::Live)
        });
    let coverage = if recorded_live && !approx {
        Coverage::Complete
    } else {
        Coverage::Partial
    };
    let summary = ActivitySummary {
        coverage,
        orders: legs.len() as u32,
        initial_stop,
        initial_stop_at,
        initial_target: target_path.iter().find_map(|s| s.price),
        initial_risk,
        initial_risk_ticks,
        r_initial,
        stop_moves: moves.len() as u32,
        tightened,
        widened,
        trail_steps: tightened.saturating_sub(1),
        first_move_secs: moves.first().map(|m| secs(opened, m.t)),
        breakeven_at,
        breakeven_secs: breakeven_at.map(|b| secs(opened, b)),
        unprotected_secs: (unprotected as f64 / SEC as f64 * 10.0).round() / 10.0,
        never_protected: initial_stop.is_none(),
        worst_stop: worst.map(|(_, p)| p),
        worst_stop_ticks: worst.map(|(d, _)| r2(d / tick)),
        ended_by,
    };
    Some(TradeAnalysis {
        summary,
        stop_path,
        target_path,
        moves,
        legs,
        from,
        to,
        end,
        tick,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::ids::{AccountId, OrderId};
    use tessera_core::orders::{Bracket, OrderRequest, TimeInForce, TrailRule};
    use tessera_core::{Environment, InstrumentId, Qty};

    fn t(s: i64) -> Timestamp {
        Timestamp(1_790_000_000 * SEC + s * SEC)
    }

    fn order(id: &str, side: Side, ty: OrderType, role: OrderRole, price: f64) -> Order {
        let p = Price::from_f64(price);
        Order {
            id: OrderId::new(id),
            broker_order_id: None,
            draft_id: None,
            request: OrderRequest {
                account_id: AccountId::new("paper-main"),
                instrument: InstrumentId::new("NQZ6.CME").unwrap(),
                side,
                qty: Qty::from(1),
                order_type: ty,
                limit_price: if ty == OrderType::Limit { p } else { None },
                stop_price: if ty == OrderType::Stop { p } else { None },
                tif: TimeInForce::Day,
                bracket: None::<Bracket>,
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
            created_at: t(0),
            updated_at: t(0),
        }
    }

    fn record(updates: &[Order]) -> Vec<OrderEvent> {
        let mut last: HashMap<String, Order> = HashMap::new();
        let mut out = Vec::new();
        for o in updates {
            let evs = diff(last.get(o.id.as_str()), o, o.updated_at, EventSource::Live);
            last.insert(o.id.to_string(), o.clone());
            out.extend(evs);
        }
        for (i, e) in out.iter_mut().enumerate() {
            e.seq = i as i64;
        }
        out.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.seq.cmp(&b.seq)));
        out
    }

    fn moved(o: &Order, at: i64, price: f64) -> Order {
        let mut n = o.clone();
        n.request.stop_price = Price::from_f64(price);
        n.updated_at = t(at);
        n
    }

    fn status(o: &Order, at: i64, s: OrderStatus) -> Order {
        let mut n = o.clone();
        n.status = s;
        n.updated_at = t(at);
        if s == OrderStatus::Filled {
            n.filled_qty = n.request.qty;
        }
        n
    }

    #[test]
    fn a_repeated_snapshot_stores_nothing() {
        let o = order(
            "s1",
            Side::Sell,
            OrderType::Stop,
            OrderRole::StopLoss,
            100.0,
        );
        let first = diff(None, &o, t(0), EventSource::Live);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].kind, OrderEventKind::Placed);
        assert_eq!(first[0].to, Some(100.0));
        let mut again = o.clone();
        again.queue_ahead = Some(Qty::from(4));
        assert!(diff(Some(&o), &again, t(1), EventSource::Live).is_empty());
        let m = moved(&o, 5, 101.0);
        let ev = diff(Some(&o), &m, t(5), EventSource::Live);
        assert_eq!(ev.len(), 1);
        assert_eq!(
            (ev[0].kind, ev[0].from, ev[0].to),
            (OrderEventKind::StopMoved, Some(100.0), Some(101.0))
        );
        assert_eq!(ev[0].ts, t(5));
        assert_eq!(ev[0].id, diff(Some(&o), &m, t(9), EventSource::Live)[0].id);
    }

    #[test]
    fn a_first_sight_of_a_finished_order_is_placed_then_ended() {
        let mut o = order("x", Side::Sell, OrderType::Market, OrderRole::Exit, 0.0);
        o.status = OrderStatus::Filled;
        o.filled_qty = Qty::from(1);
        o.avg_fill_price = Price::from_f64(101.0);
        o.updated_at = t(3);
        let ev = diff(None, &o, t(4), EventSource::Resync);
        let kinds: Vec<_> = ev.iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec![OrderEventKind::Placed, OrderEventKind::Filled]);
        assert!(ev[0].approx, "not seen as it was placed");
        assert_eq!(ev[0].ts, t(0));
        assert_eq!(ev[1].ts, t(3));
    }

    fn fills(
        long: bool,
        entry: (i64, f64, &str),
        exit: Option<(i64, f64, &str, Option<OrderRole>)>,
    ) -> Vec<FillRef> {
        let mut v = vec![FillRef {
            ts: t(entry.0),
            qty: 1.0,
            price: entry.1,
            entry: true,
            order_id: Some(entry.2.into()),
            role: Some(OrderRole::Entry),
        }];
        if let Some((at, p, id, role)) = exit {
            v.push(FillRef {
                ts: t(at),
                qty: 1.0,
                price: p,
                entry: false,
                order_id: Some(id.into()),
                role,
            });
        }
        let _ = long;
        v
    }

    fn input<'a>(side: Side, fills: &'a [FillRef], end: i64, net: f64) -> TradeInput<'a> {
        TradeInput {
            side,
            opened_at: fills[0].ts,
            end: t(end),
            closed: true,
            net,
            fills,
            tick: 0.25,
            mult: 20.0,
            live_since: Some(t(-100)),
        }
    }

    #[test]
    fn a_long_s_stop_moves_are_measured() {
        let entry = {
            let mut o = order("e1", Side::Buy, OrderType::Market, OrderRole::Entry, 0.0);
            o.status = OrderStatus::Filled;
            o.filled_qty = Qty::from(1);
            o.avg_fill_price = Price::from_f64(100.0);
            o
        };
        let mut stop = order("s1", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        stop.parent_id = Some(OrderId::new("e1"));
        stop.status = OrderStatus::Held;
        let working = status(&stop, 0, OrderStatus::Working);
        let a = moved(&working, 30, 99.0);
        let b = moved(&a, 60, 97.5);
        let c = moved(&b, 120, 100.0);
        let d = moved(&c, 180, 101.0);
        let hit = status(&d, 240, OrderStatus::Filled);
        let ev = record(&[entry, stop, working, a, b, c, d, hit]);
        let f = fills(
            true,
            (0, 100.0, "e1"),
            Some((240, 101.0, "s1", Some(OrderRole::StopLoss))),
        );
        let an = analyse(&input(Side::Buy, &f, 240, 16.0), &ev).unwrap();
        let s = &an.summary;
        assert_eq!(s.initial_stop, Some(98.0));
        assert_eq!(s.initial_risk_ticks, Some(8.0));
        assert_eq!(s.initial_risk, Some(40.0), "2 points × $20 × 1");
        assert_eq!(s.r_initial, Some(0.4));
        assert_eq!((s.stop_moves, s.tightened, s.widened), (4, 3, 1));
        assert_eq!(s.trail_steps, 2);
        assert_eq!(s.first_move_secs, Some(30.0));
        assert_eq!(s.breakeven_secs, Some(120.0));
        assert_eq!(s.unprotected_secs, 0.0);
        assert_eq!(s.worst_stop, Some(97.5));
        assert_eq!(s.worst_stop_ticks, Some(10.0));
        assert_eq!(s.ended_by, Some(EndedBy::Stop));
        assert_eq!(s.coverage, Coverage::Complete);
        let prices: Vec<_> = an.stop_path.iter().map(|p| p.price).collect();
        assert_eq!(
            prices,
            vec![
                Some(98.0),
                Some(99.0),
                Some(97.5),
                Some(100.0),
                Some(101.0),
                None
            ]
        );
        assert_eq!(an.legs.get("s1"), Some(&Leg::Stop));
        assert_eq!(an.legs.get("e1"), Some(&Leg::Entry));
    }

    #[test]
    fn a_short_s_stop_moves_the_other_way() {
        let mut stop = order("s2", Side::Buy, OrderType::Stop, OrderRole::Entry, 105.0);
        stop.request.reduce_only = true;
        let a = moved(&stop, 10, 104.0);
        let b = moved(&a, 20, 106.0);
        let ev = record(&[stop, a, b]);
        let f = fills(
            false,
            (0, 100.0, "e2"),
            Some((50, 98.0, "x2", Some(OrderRole::Exit))),
        );
        let an = analyse(&input(Side::Sell, &f, 50, 40.0), &ev).unwrap();
        let s = &an.summary;
        assert_eq!(s.initial_stop, Some(105.0));
        assert_eq!(s.initial_risk_ticks, Some(20.0));
        assert_eq!((s.tightened, s.widened), (1, 1));
        assert_eq!(an.moves[0].direction, MoveDirection::Tightened);
        assert_eq!(an.moves[1].direction, MoveDirection::Widened);
        assert_eq!(s.worst_stop, Some(106.0));
        assert_eq!(s.ended_by, Some(EndedBy::Manual));
        assert!(s.breakeven_at.is_none());
    }

    #[test]
    fn time_without_a_stop_is_measured() {
        let mut stop = order("s3", Side::Sell, OrderType::Stop, OrderRole::Entry, 95.0);
        stop.created_at = t(45);
        stop.updated_at = t(45);
        let gone = status(&stop, 100, OrderStatus::Cancelled);
        let ev = record(&[stop, gone]);
        let f = fills(true, (0, 100.0, "e3"), Some((160, 101.0, "x3", None)));
        let an = analyse(&input(Side::Buy, &f, 160, 15.0), &ev).unwrap();
        assert_eq!(an.summary.unprotected_secs, 45.0 + 60.0);
        assert_eq!(an.summary.initial_stop_at, Some(t(45)));
        assert!(!an.summary.never_protected);
    }

    #[test]
    fn a_cancelled_and_replaced_stop_is_one_move() {
        let s1 = order("r1", Side::Sell, OrderType::Stop, OrderRole::Entry, 95.0);
        let gone = status(&s1, 30, OrderStatus::Cancelled);
        let mut s2 = order("r2", Side::Sell, OrderType::Stop, OrderRole::Entry, 93.0);
        s2.created_at = t(33);
        s2.updated_at = t(33);
        let ev = record(&[s1, gone, s2]);
        let f = fills(true, (0, 100.0, "e4"), Some((90, 99.0, "x4", None)));
        let an = analyse(&input(Side::Buy, &f, 90, -20.0), &ev).unwrap();
        assert_eq!(an.summary.stop_moves, 1);
        assert_eq!(an.summary.widened, 1);
        assert!(an.moves[0].replaced);
        assert_eq!(an.summary.unprotected_secs, 3.0);
    }

    #[test]
    fn nothing_known_is_none_and_no_stop_on_a_recorded_account_is_measured() {
        let f = fills(true, (0, 100.0, "e5"), Some((60, 101.0, "x5", None)));
        let mut i = input(Side::Buy, &f, 60, 20.0);
        i.live_since = None;
        assert!(analyse(&i, &[]).is_none());
        i.live_since = Some(t(-1));
        let an = analyse(&i, &[]).unwrap();
        assert!(an.summary.never_protected);
        assert_eq!(an.summary.unprotected_secs, 60.0);
        assert_eq!(an.summary.initial_risk, None);
        assert_eq!(an.summary.coverage, Coverage::Complete);
    }

    fn call(id: &str, tool: &str, origin: Origin, at: i64, input: Value) -> OrderCall {
        OrderCall {
            call_id: id.into(),
            tool: tool.into(),
            origin,
            input,
            started_at: t(at),
            finished_at: Some(t(at)),
            approved: false,
            summary: None,
        }
    }

    #[test]
    fn who_moved_it_comes_from_the_audit() {
        let mut stop = order("s6", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        stop.parent_id = Some(OrderId::new("e6"));
        let entry = order("e6", Side::Buy, OrderType::Market, OrderRole::Entry, 0.0);
        let by_trader = moved(&stop, 30, 99.0);
        let by_analyst = moved(&by_trader, 60, 99.5);
        let mut by_rule = moved(&by_analyst, 90, 100.0);
        by_rule.stop_rules = Some(StopRules {
            trail: Some(TrailRule {
                distance_ticks: 8,
                trigger_ticks: 0,
                step_ticks: 1,
            }),
            ..StopRules::default()
        });
        let mut outside = moved(&by_rule, 120, 100.25);
        outside.stop_rules = None;
        let ev = record(&[entry, stop, by_trader, by_analyst, by_rule, outside]);
        let calls = vec![
            call(
                "c1",
                "orders.submit",
                Origin::User,
                0,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQ", "side": "buy", "orderType": "market", "qty": 1}),
            ),
            call(
                "c2",
                "orders.modify",
                Origin::User,
                30,
                serde_json::json!({"accountId": "paper-main", "orderId": "s6", "stopPrice": 99.0}),
            ),
            call(
                "c3",
                "orders.modify",
                Origin::Agent {
                    session_id: "sess-1".into(),
                    provider: "codex".into(),
                },
                60,
                serde_json::json!({"accountId": "paper-main", "orderId": "s6", "stopPrice": "99.5"}),
            ),
        ];
        let rows: Vec<&OrderEvent> = ev.iter().collect();
        let who: Vec<ActorKind> = attribute(&rows, &ev, &calls)
            .iter()
            .map(|a| a.kind)
            .collect();
        assert_eq!(
            who,
            vec![
                ActorKind::Trader,
                ActorKind::Trader,
                ActorKind::Trader,
                ActorKind::Analyst,
                ActorKind::Broker,
                ActorKind::Outside,
            ]
        );
    }

    #[test]
    fn the_close_tessera_sent_at_the_loss_limit_is_tesseras() {
        let close = order("x7", Side::Sell, OrderType::Market, OrderRole::Exit, 0.0);
        let ev = record(&[close]);
        let calls = vec![call(
            "p7",
            PROTECT_TOOL,
            Origin::User,
            0,
            serde_json::json!({"accountId": "paper-main", "mode": "loss_limit", "orders": ["x7"], "entries": []}),
        )];
        let rows: Vec<&OrderEvent> = ev.iter().collect();
        let who = attribute(&rows, &ev, &calls);
        assert_eq!(who[0].kind, ActorKind::Tessera);
        assert_eq!(who[0].call_id.as_deref(), Some("p7"));
        assert_eq!(attribute(&rows, &ev, &[])[0].kind, ActorKind::Outside);
    }

    #[test]
    fn a_followers_copy_is_whoever_placed_the_leaders_order() {
        let entry = order("e9", Side::Buy, OrderType::Market, OrderRole::Entry, 0.0);
        let mut stop = order("s9", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        stop.parent_id = Some(OrderId::new("e9"));
        let mut gone = stop.clone();
        gone.status = OrderStatus::Cancelled;
        gone.reason = Some("Cancelled.".into());
        gone.updated_at = t(60);
        let ev = record(&[entry, stop, gone]);
        let analyst = Origin::Agent {
            session_id: tessera_core::ids::SessionId::new("S1"),
            provider: "codex".into(),
        };
        let calls = vec![
            call(
                "k1",
                COPY_TOOL,
                analyst,
                0,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQZ6.CME", "side": "buy", "orderType": "market", "qty": 1, "copyOf": "orders.submit", "leaderAccountId": "lead", "groupId": "cg1"}),
            ),
            call(
                "k2",
                COPY_TOOL,
                Origin::User,
                60,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQZ6.CME", "copyOf": "orders.flatten", "leaderAccountId": "lead", "groupId": "cg1"}),
            ),
        ];
        let rows: Vec<&OrderEvent> = ev.iter().collect();
        let kinds: Vec<(ActorKind, Option<String>)> = attribute(&rows, &ev, &calls)
            .into_iter()
            .map(|a| (a.kind, a.via))
            .collect();
        let copy = Some(COPY_TOOL.to_owned());
        assert_eq!(
            kinds,
            vec![
                (ActorKind::Analyst, copy.clone()),
                (ActorKind::Analyst, copy.clone()),
                (ActorKind::Trader, copy),
            ]
        );
    }

    #[test]
    fn tesseras_own_changes_to_a_positions_bracket_are_tesseras() {
        let entry = order("e8", Side::Buy, OrderType::Market, OrderRole::Entry, 0.0);
        let mut stop = order("s8", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        stop.parent_id = Some(OrderId::new("e8"));
        let mut grown = stop.clone();
        grown.request.qty = Qty::from(31);
        grown.updated_at = t(30);
        let mut merged = moved(&grown, 60, 99.0);
        merged.request.qty = Qty::from(31);
        let mut gone = merged.clone();
        gone.status = OrderStatus::Cancelled;
        gone.reason = Some("Cancelled.".into());
        gone.updated_at = t(90);
        let ev = record(&[entry, stop, grown.clone(), merged, gone]);
        let protect = |id: &str, at: i64, merge: bool| {
            let mut c = call(
                id,
                PROTECT_TOOL,
                Origin::User,
                at,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQZ6.CME", "orders": ["s8"], "merge": merge}),
            );
            c.summary = Some("NQZ6: Grew the stop and the target to 31".into());
            c
        };
        let calls = vec![
            call(
                "c1",
                "orders.submit",
                Origin::User,
                0,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQ", "side": "buy", "orderType": "market", "qty": 1}),
            ),
            protect("p1", 30, false),
            call(
                "m1",
                "orders.merge_brackets",
                Origin::User,
                60,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQ"}),
            ),
            protect("p2", 60, true),
            protect("p3", 90, false),
        ];
        let rows: Vec<&OrderEvent> = ev.iter().collect();
        let who = attribute(&rows, &ev, &calls);
        let kinds: Vec<(ActorKind, Option<&str>)> =
            who.iter().map(|a| (a.kind, a.via.as_deref())).collect();
        assert_eq!(
            kinds,
            vec![
                (ActorKind::Trader, Some("orders.submit")),
                (ActorKind::Trader, Some("orders.submit")),
                (ActorKind::Tessera, Some(PROTECT_TOOL)),
                (ActorKind::Trader, Some("orders.merge_brackets")),
                (ActorKind::Tessera, Some(PROTECT_TOOL)),
            ]
        );
        assert_eq!(
            who[2].summary.as_deref(),
            Some("NQZ6: Grew the stop and the target to 31")
        );
    }

    #[test]
    fn a_stop_moved_by_breakeven_is_whoever_pressed_it() {
        let entry = order("e9", Side::Buy, OrderType::Market, OrderRole::Entry, 0.0);
        let mut stop = order("s9", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        stop.parent_id = Some(OrderId::new("e9"));
        stop.stop_rules = Some(StopRules {
            breakeven: Some(tessera_core::orders::BreakevenRule {
                trigger_ticks: 20,
                offset_ticks: 1,
            }),
            ..StopRules::default()
        });
        let pressed = moved(&stop, 30, 100.25);
        let ev = record(&[entry, stop, pressed]);
        let calls = vec![
            call(
                "c1",
                "orders.submit",
                Origin::User,
                0,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQ", "side": "buy", "orderType": "market", "qty": 1}),
            ),
            call(
                "b1",
                "orders.breakeven",
                Origin::User,
                30,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQZ6.CME", "offsetTicks": 1}),
            ),
        ];
        let rows: Vec<&OrderEvent> = ev.iter().collect();
        let who: Vec<(ActorKind, Option<String>)> = attribute(&rows, &ev, &calls)
            .into_iter()
            .map(|a| (a.kind, a.via))
            .collect();
        assert_eq!(
            who[2],
            (ActorKind::Trader, Some("orders.breakeven".to_owned()))
        );
    }

    #[test]
    fn a_stored_leg_set_in_ticks_starts_that_far_from_its_entrys_fill() {
        let mut entry = order("e8", Side::Sell, OrderType::Market, OrderRole::Entry, 0.0);
        entry.status = OrderStatus::Filled;
        entry.filled_qty = Qty::from(1);
        entry.avg_fill_price = Price::from_f64(100.0);
        let mut leg = order("s8", Side::Buy, OrderType::Stop, OrderRole::StopLoss, 101.0);
        leg.parent_id = Some(OrderId::new("e8"));
        leg.updated_at = t(300);
        let calls = vec![
            call(
                "c1",
                "orders.submit",
                Origin::User,
                0,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQZ6.CME", "side": "sell", "orderType": "market", "qty": 1, "bracket": {"stopLoss": null, "takeProfit": null, "stopTicks": 8}}),
            ),
            call(
                "c2",
                "orders.modify",
                Origin::User,
                100,
                serde_json::json!({"accountId": "paper-main", "orderId": "s8", "stopPrice": 101.0}),
            ),
        ];
        let first = HashMap::from([("e8".to_owned(), t(0))]);
        let ev = reconstruct(&[entry, leg], &calls, &first, &HashSet::new(), |_| {
            Some(0.25)
        });
        let leg_ev: Vec<_> = ev.iter().filter(|e| e.order_id == "s8").collect();
        assert_eq!(leg_ev[0].to, Some(102.0), "8 ticks above the short's fill");
        assert_eq!(leg_ev[0].source, EventSource::Audit);
    }

    #[test]
    fn stored_orders_are_rebuilt_from_the_audit() {
        let mut entry = order("e7", Side::Buy, OrderType::Market, OrderRole::Entry, 0.0);
        entry.status = OrderStatus::Filled;
        entry.filled_qty = Qty::from(1);
        let mut leg = order(
            "s7",
            Side::Sell,
            OrderType::Stop,
            OrderRole::StopLoss,
            101.0,
        );
        leg.parent_id = Some(OrderId::new("e7"));
        leg.status = OrderStatus::Filled;
        leg.filled_qty = Qty::from(1);
        leg.updated_at = t(300);
        let calls = vec![
            call(
                "c1",
                "orders.submit",
                Origin::User,
                0,
                serde_json::json!({"accountId": "paper-main", "instrument": "NQZ6.CME", "side": "buy", "orderType": "market", "qty": 1, "bracket": {"stopLoss": 98.0}}),
            ),
            call(
                "c2",
                "orders.modify",
                Origin::User,
                100,
                serde_json::json!({"accountId": "paper-main", "orderId": "s7", "stopPrice": 99.0}),
            ),
        ];
        let first = HashMap::from([("e7".to_owned(), t(0))]);
        let ev = reconstruct(&[entry, leg], &calls, &first, &HashSet::new(), |_| None);
        let leg_ev: Vec<_> = ev.iter().filter(|e| e.order_id == "s7").collect();
        let kinds: Vec<_> = leg_ev.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                OrderEventKind::Placed,
                OrderEventKind::Activated,
                OrderEventKind::StopMoved,
                OrderEventKind::StopMoved,
                OrderEventKind::Filled
            ]
        );
        assert_eq!(leg_ev[0].to, Some(98.0), "placed at the bracket's stop");
        assert_eq!(leg_ev[0].source, EventSource::Audit);
        assert_eq!((leg_ev[2].from, leg_ev[2].to), (Some(98.0), Some(99.0)));
        assert_eq!(leg_ev[2].call_id.as_deref(), Some("c2"));
        assert!(
            leg_ev[3].approx,
            "the last move no call explains is a bound"
        );
        assert_eq!((leg_ev[3].from, leg_ev[3].to), (Some(99.0), Some(101.0)));
        let none = reconstruct(&[], &calls, &first, &HashSet::new(), |_| None);
        assert!(none.is_empty());
    }

    fn filled_entry(id: &str, side: Side, qty: i64, price: f64) -> Order {
        let mut o = order(id, side, OrderType::Market, OrderRole::Entry, 0.0);
        o.request.qty = Qty::from(qty);
        o.status = OrderStatus::Filled;
        o.filled_qty = Qty::from(qty);
        o.avg_fill_price = Price::from_f64(price);
        o
    }

    fn entry_fill(at: i64, qty: f64, price: f64, id: &str) -> FillRef {
        FillRef {
            ts: t(at),
            qty,
            price,
            entry: true,
            order_id: Some(id.into()),
            role: Some(OrderRole::Entry),
        }
    }

    fn exit_fill(at: i64, qty: f64, price: f64, id: &str, role: OrderRole) -> FillRef {
        FillRef {
            ts: t(at),
            qty,
            price,
            entry: false,
            order_id: Some(id.into()),
            role: Some(role),
        }
    }

    #[test]
    fn a_trade_built_in_pieces_risks_every_piece_to_its_stop() {
        let first = filled_entry("e1", Side::Buy, 1, 100.0);
        let add = filled_entry("e2", Side::Buy, 9, 101.0);
        let mut stop = order("s1", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        stop.parent_id = Some(OrderId::new("e1"));
        let mut grown = status(&stop, 30, OrderStatus::Working);
        grown.request.qty = Qty::from(10);
        let hit = status(&grown, 100, OrderStatus::Filled);
        let ev = record(&[first, stop, add, grown, hit]);
        let f = vec![
            entry_fill(0, 1.0, 100.0, "e1"),
            entry_fill(30, 9.0, 101.0, "e2"),
            exit_fill(100, 10.0, 98.0, "s1", OrderRole::StopLoss),
        ];
        let net = (98.0 - 100.0) * 20.0 + (98.0 - 101.0) * 20.0 * 9.0;
        let an = analyse(&input(Side::Buy, &f, 100, net), &ev).unwrap();
        let s = &an.summary;
        assert_eq!(
            s.initial_risk,
            Some(580.0),
            "1 × 2 points + 9 × 3 points, × $20"
        );
        assert_eq!(
            s.r_initial,
            Some(-1.0),
            "stopped out of the whole position is −1R"
        );
    }

    #[test]
    fn an_entry_filled_in_parts_risks_all_of_it() {
        let entry = filled_entry("e1", Side::Buy, 10, 100.0);
        let mut stop = order("s1", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        stop.parent_id = Some(OrderId::new("e1"));
        stop.request.qty = Qty::from(10);
        let working = status(&stop, 0, OrderStatus::Working);
        let out = status(&working, 60, OrderStatus::Cancelled);
        let ev = record(&[entry, stop, working, out]);
        let f = vec![
            entry_fill(0, 1.0, 100.0, "e1"),
            entry_fill(5, 9.0, 100.0, "e1"),
            exit_fill(60, 10.0, 104.0, "x", OrderRole::Exit),
        ];
        let an = analyse(&input(Side::Buy, &f, 60, 800.0), &ev).unwrap();
        assert_eq!(an.summary.initial_risk, Some(400.0), "10 × 2 points × $20");
        assert_eq!(an.summary.r_initial, Some(2.0));
    }

    #[test]
    fn each_entrys_own_bracket_stop_measures_its_own_risk() {
        let first = filled_entry("e1", Side::Buy, 1, 100.0);
        let second = filled_entry("e2", Side::Buy, 1, 102.0);
        let mut s1 = order("s1", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        s1.parent_id = Some(OrderId::new("e1"));
        let mut s2 = order(
            "s2",
            Side::Sell,
            OrderType::Stop,
            OrderRole::StopLoss,
            101.0,
        );
        s2.parent_id = Some(OrderId::new("e2"));
        s2.updated_at = t(20);
        s2.created_at = t(20);
        let x1 = status(&s1, 90, OrderStatus::Cancelled);
        let x2 = status(&s2, 90, OrderStatus::Cancelled);
        let ev = record(&[first, s1, second, s2, x1, x2]);
        let f = vec![
            entry_fill(0, 1.0, 100.0, "e1"),
            entry_fill(20, 1.0, 102.0, "e2"),
            exit_fill(90, 2.0, 104.0, "x", OrderRole::Exit),
        ];
        let an = analyse(&input(Side::Buy, &f, 90, 120.0), &ev).unwrap();
        assert_eq!(
            an.summary.initial_risk,
            Some(60.0),
            "2 points and 1 point, × $20"
        );
        assert_eq!(an.summary.r_initial, Some(2.0));
    }

    #[test]
    fn a_piece_no_stop_ever_covered_leaves_the_trade_without_an_r() {
        let first = filled_entry("e1", Side::Buy, 1, 100.0);
        let mut stop = order("s1", Side::Sell, OrderType::Stop, OrderRole::StopLoss, 98.0);
        stop.parent_id = Some(OrderId::new("e1"));
        let gone = status(&stop, 10, OrderStatus::Cancelled);
        let ev = record(&[first, stop, gone]);
        let f = vec![
            entry_fill(0, 1.0, 100.0, "e1"),
            entry_fill(30, 1.0, 101.0, "e2"),
            exit_fill(60, 2.0, 103.0, "x", OrderRole::Exit),
        ];
        let an = analyse(&input(Side::Buy, &f, 60, 100.0), &ev).unwrap();
        assert_eq!(an.summary.initial_stop, Some(98.0));
        assert_eq!(
            an.summary.initial_risk, None,
            "the add at 30 s had no stop at all"
        );
        assert_eq!(an.summary.r_initial, None);
    }
}
