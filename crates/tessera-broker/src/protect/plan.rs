use std::collections::BTreeSet;

use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::ids::OrderId;
use tessera_core::orders::{Bracket, Order, OrderRole, OrderStatus, OrderType, Side};
use tessera_core::{Price, Qty, Timestamp};
use ts_rs::TS;

/// How a position's stops and targets are kept (setting `trade.positionBracket`).
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ProtectionMode {
    /// One stop and one target cover the whole position: adds grow them, exits shrink them.
    Grow,
    /// Every entry keeps its own stop and target.
    #[default]
    PerEntry,
}

impl ProtectionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ProtectionMode::Grow => "grow",
            ProtectionMode::PerEntry => "per_entry",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "grow" => ProtectionMode::Grow,
            _ => ProtectionMode::PerEntry,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub entry: OrderId,
    pub bracket: Bracket,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Memory {
    pub side: Option<Side>,
    pub protection: Option<OrderId>,
    pub legacy: BTreeSet<OrderId>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Reading {
    #[default]
    Current,
    FillsAhead,
    ExitsAhead(Decimal),
}

#[derive(Clone, Copy, Debug)]
pub struct State<'a> {
    pub mode: ProtectionMode,
    pub position: Decimal,
    pub reading: Reading,
    pub orders: &'a [Order],
    pub changing: &'a [OrderId],
    pub intents: &'a [Intent],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Why {
    Flat,
    Reversed,
    Grew,
    Shrank,
    Oco,
    Joined,
    Merged,
    Unprotected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Cancel {
        order: OrderId,
        role: OrderRole,
        why: Why,
    },
    Resize {
        order: OrderId,
        role: OrderRole,
        from: Qty,
        to: Qty,
        qty: Qty,
        why: Why,
    },
    Move {
        order: OrderId,
        role: OrderRole,
        from: Price,
        to: Price,
    },
    Attach {
        entry: OrderId,
        bracket: Bracket,
        qty: Qty,
    },
}

impl Step {
    pub fn order(&self) -> &OrderId {
        match self {
            Step::Cancel { order, .. } | Step::Resize { order, .. } | Step::Move { order, .. } => {
                order
            }
            Step::Attach { entry, .. } => entry,
        }
    }

    pub fn shown_by(&self, o: &Order) -> bool {
        match self {
            Step::Cancel { .. } => !o.status.is_open() || o.status == OrderStatus::PendingCancel,
            Step::Resize { qty, .. } => o.request.qty == *qty,
            Step::Move { role, to, .. } => {
                let at = if *role == OrderRole::StopLoss {
                    o.request.stop_price
                } else {
                    o.request.limit_price
                };
                at == Some(*to)
            }
            Step::Attach { .. } => true,
        }
    }

    fn rank(&self) -> (u8, u8) {
        let role = |r: &OrderRole| u8::from(*r != OrderRole::StopLoss);
        match self {
            Step::Cancel { role: r, .. } => (0, role(r)),
            Step::Resize {
                from, to, role: r, ..
            } if to < from => (1, role(r)),
            Step::Move { role: r, .. } => (2, role(r)),
            Step::Resize { role: r, .. } => (3, role(r)),
            Step::Attach { .. } => (4, 0),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub memory: Memory,
    pub done: Vec<OrderId>,
    pub waiting: bool,
}

#[derive(Clone, Copy, Debug)]
struct Leg<'a> {
    order: &'a Order,
    role: OrderRole,
    left: Decimal,
    busy: bool,
}

impl Leg<'_> {
    fn id(&self) -> &OrderId {
        &self.order.id
    }

    fn role(&self) -> OrderRole {
        self.role
    }

    fn price(&self) -> Option<Price> {
        match self.role {
            OrderRole::StopLoss => self.order.request.stop_price,
            _ => self.order.request.limit_price,
        }
    }
}

#[derive(Clone, Debug)]
struct Pair<'a> {
    key: OrderId,
    at: Timestamp,
    stop: Option<Leg<'a>>,
    target: Option<Leg<'a>>,
}

impl<'a> Pair<'a> {
    fn legs(&self) -> impl Iterator<Item = &Leg<'a>> {
        self.stop.iter().chain(self.target.iter())
    }

    fn legs_mut(&mut self) -> impl Iterator<Item = &mut Leg<'a>> {
        self.stop.iter_mut().chain(self.target.iter_mut())
    }

    fn busy(&self) -> bool {
        self.legs().any(|l| l.busy)
    }

    fn cover(&self) -> Decimal {
        self.legs().map(|l| l.left).min().unwrap_or(Decimal::ZERO)
    }
}

fn classify<'a>(state: &State<'a>) -> (Vec<Pair<'a>>, Vec<Leg<'a>>, bool) {
    let closing = Side::holding(state.position).map(Side::opposite);
    let mut pairs: Vec<Pair<'a>> = Vec::new();
    let mut other: Vec<Leg<'a>> = Vec::new();
    let mut waiting = false;
    for o in state.orders {
        if !matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit) || !o.status.is_open() {
            continue;
        }
        if o.status == OrderStatus::PendingCancel {
            waiting = true;
            continue;
        }
        let entry = o
            .parent_id
            .as_ref()
            .and_then(|p| state.orders.iter().find(|e| &e.id == p));
        let filled = match entry {
            Some(e) => !e.filled_qty.is_zero(),
            None => o.status != OrderStatus::Held,
        };
        if !filled {
            continue;
        }
        let busy = matches!(o.status, OrderStatus::Held | OrderStatus::PendingSubmit)
            || state.changing.contains(&o.id);
        waiting |= busy;
        let leg = Leg {
            order: o,
            role: o.role,
            left: o.remaining().0.max(Decimal::ZERO),
            busy,
        };
        if Some(o.request.side) != closing {
            other.push(leg);
            continue;
        }
        let key = o.parent_id.clone().unwrap_or_else(|| o.id.clone());
        let at = entry.map_or(o.created_at, |e| e.updated_at);
        let i = match pairs.iter().position(|p| p.key == key) {
            Some(i) => i,
            None => {
                pairs.push(Pair {
                    key,
                    at,
                    stop: None,
                    target: None,
                });
                pairs.len() - 1
            }
        };
        let slot = if o.role == OrderRole::StopLoss {
            &mut pairs[i].stop
        } else {
            &mut pairs[i].target
        };
        if slot.is_none() {
            *slot = Some(leg);
        } else {
            pairs.push(Pair {
                key: o.id.clone(),
                at,
                stop: (o.role == OrderRole::StopLoss).then_some(leg),
                target: (o.role == OrderRole::TakeProfit).then_some(leg),
            });
        }
    }
    pairs.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.key.cmp(&b.key)));
    (pairs, other, waiting)
}

fn loose_exit_role(o: &Order) -> Option<OrderRole> {
    if !o.request.reduce_only
        || o.parent_id.is_some()
        || matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit)
    {
        return None;
    }
    match o.request.order_type {
        OrderType::Stop | OrderType::StopLimit => Some(OrderRole::StopLoss),
        OrderType::Limit => Some(OrderRole::TakeProfit),
        OrderType::Market => None,
    }
}

fn loose_exits<'a>(state: &State<'a>) -> Vec<Leg<'a>> {
    state
        .orders
        .iter()
        .filter(|o| o.status.is_open() && o.status != OrderStatus::PendingCancel)
        .filter_map(|o| {
            Some(Leg {
                order: o,
                role: loose_exit_role(o)?,
                left: o.remaining().0.max(Decimal::ZERO),
                busy: matches!(o.status, OrderStatus::Held | OrderStatus::PendingSubmit)
                    || state.changing.contains(&o.id),
            })
        })
        .collect()
}

fn resize(leg: &mut Leg<'_>, to: Decimal, why: Why, steps: &mut Vec<Step>) {
    if to == leg.left || leg.busy {
        return;
    }
    if to <= Decimal::ZERO {
        steps.push(Step::Cancel {
            order: leg.id().clone(),
            role: leg.role(),
            why,
        });
    } else {
        steps.push(Step::Resize {
            order: leg.id().clone(),
            role: leg.role(),
            from: Qty(leg.left),
            to: Qty(to),
            qty: Qty(leg.order.filled_qty.0 + to),
            why,
        });
    }
    leg.left = to.max(Decimal::ZERO);
}

fn cancel(leg: &mut Leg<'_>, why: Why, steps: &mut Vec<Step>) {
    if leg.busy {
        return;
    }
    steps.push(Step::Cancel {
        order: leg.id().clone(),
        role: leg.role(),
        why,
    });
    leg.left = Decimal::ZERO;
}

fn size_pair(pair: &mut Pair<'_>, cover: Decimal, why: Why, steps: &mut Vec<Step>) {
    for leg in pair.legs_mut() {
        resize(leg, cover, why, steps);
    }
}

fn even_pairs(pairs: &mut [Pair<'_>], steps: &mut Vec<Step>) {
    for p in pairs.iter_mut() {
        if p.busy() || p.stop.is_none() || p.target.is_none() {
            continue;
        }
        let cover = p.cover();
        for leg in p.legs_mut() {
            if leg.left > cover {
                resize(leg, cover, Why::Oco, steps);
            }
        }
    }
}

fn shrink_newest(pairs: &mut [&mut Pair<'_>], cap: Decimal, steps: &mut Vec<Step>) {
    let mut total: Decimal = pairs.iter().map(|p| p.cover()).sum();
    let mut order: Vec<usize> = (0..pairs.len()).collect();
    order.sort_by(|&a, &b| {
        pairs[b]
            .at
            .cmp(&pairs[a].at)
            .then_with(|| pairs[b].key.cmp(&pairs[a].key))
    });
    for i in order {
        if total <= cap {
            break;
        }
        let p = &mut pairs[i];
        if p.busy() {
            continue;
        }
        let cover = p.cover();
        let cut = cover.min(total - cap);
        size_pair(p, cover - cut, Why::Shrank, steps);
        total -= cut;
    }
}

fn lead(pairs: &[Pair<'_>], side: Side, whole: bool) -> Option<usize> {
    let long = side == Side::Buy;
    let score = |p: &Pair<'_>| {
        let stop = p.stop.and_then(|l| l.price()).map(|x| x.0);
        let target = p.target.and_then(|l| l.price()).map(|x| x.0);
        let tight = stop.map(|s| if long { s } else { -s });
        let near = target.map(|t| if long { -t } else { t });
        (
            whole && stop.is_some() && target.is_some(),
            stop.is_some(),
            tight,
            near,
        )
    };
    (0..pairs.len()).reduce(|best, i| {
        if score(&pairs[i]) > score(&pairs[best]) {
            i
        } else {
            best
        }
    })
}

fn settle_intents(state: &State<'_>, protected: bool, attached: bool, done: &mut Vec<OrderId>) {
    for i in state.intents {
        let Some(e) = state.orders.iter().find(|o| o.id == i.entry) else {
            continue;
        };
        if !e.status.is_terminal() {
            continue;
        }
        if e.filled_qty.is_zero() || protected || attached {
            done.push(i.entry.clone());
        }
    }
}

fn finish(mut plan: Plan) -> Plan {
    plan.steps.sort_by_key(Step::rank);
    plan
}

pub fn plan(state: &State<'_>, memory: &Memory) -> Plan {
    let (mut pairs, mut other, waiting) = classify(state);
    if state.reading == Reading::FillsAhead {
        let mut out = Plan {
            waiting,
            memory: memory.clone(),
            ..Plan::default()
        };
        even_pairs(&mut pairs, &mut out.steps);
        return finish(out);
    }
    let mut out = Plan {
        waiting,
        ..Plan::default()
    };
    let n = state.position.abs();
    let mut loose = loose_exits(state);
    let Some(side) = Side::holding(state.position) else {
        out.waiting |= loose.iter().any(|l| l.busy);
        for leg in pairs
            .iter_mut()
            .flat_map(Pair::legs_mut)
            .chain(other.iter_mut())
            .chain(loose.iter_mut())
        {
            cancel(leg, Why::Flat, &mut out.steps);
        }
        settle_intents(state, true, false, &mut out.done);
        return finish(out);
    };
    let (mut old_side, mut closing): (Vec<Leg<'_>>, Vec<Leg<'_>>) = loose
        .into_iter()
        .partition(|l| l.order.request.side == side);
    out.waiting |= old_side.iter().any(|l| l.busy);
    out.memory = if memory.side == Some(side) {
        memory.clone()
    } else {
        Memory {
            side: Some(side),
            ..Memory::default()
        }
    };
    for leg in other.iter_mut().chain(old_side.iter_mut()) {
        cancel(leg, Why::Reversed, &mut out.steps);
    }
    even_pairs(&mut pairs, &mut out.steps);
    match state.mode {
        ProtectionMode::PerEntry => {
            let mut all: Vec<&mut Pair<'_>> = pairs.iter_mut().collect();
            shrink_newest(&mut all, n, &mut out.steps);
            out.memory = Memory {
                side: Some(side),
                ..Memory::default()
            };
            settle_intents(state, true, false, &mut out.done);
        }
        ProtectionMode::Grow => grow(state, side, n, &mut pairs, &mut out),
    }
    for leg in closing.iter_mut().filter(|l| l.left > n) {
        out.waiting |= leg.busy;
        resize(leg, n, Why::Shrank, &mut out.steps);
    }
    finish(out)
}

fn grow<'a>(state: &State<'a>, side: Side, n: Decimal, pairs: &mut [Pair<'a>], out: &mut Plan) {
    let m = &mut out.memory;
    m.legacy.retain(|k| pairs.iter().any(|p| &p.key == k));
    if m.protection
        .as_ref()
        .is_some_and(|k| !pairs.iter().any(|p| &p.key == k))
    {
        m.protection = None;
    }
    if m.protection.is_none() {
        let legacy = m.legacy.clone();
        let free: Vec<usize> = (0..pairs.len())
            .filter(|&i| !legacy.contains(&pairs[i].key))
            .collect();
        if legacy.is_empty() && free.len() == 1 {
            m.protection = Some(pairs[free[0]].key.clone());
        } else if !pairs.is_empty() {
            let i = lead(pairs, side, false).expect("not empty");
            m.protection = Some(pairs[i].key.clone());
            m.legacy = pairs
                .iter()
                .filter(|p| p.key != pairs[i].key)
                .map(|p| p.key.clone())
                .collect();
        }
    }
    let protection = m.protection.clone();
    let legacy = m.legacy.clone();
    for p in pairs.iter_mut() {
        if Some(&p.key) == protection.as_ref() || legacy.contains(&p.key) {
            continue;
        }
        if p.busy() {
            out.waiting = true;
            continue;
        }
        for leg in p.legs_mut() {
            cancel(leg, Why::Joined, &mut out.steps);
        }
    }
    let mut attached = false;
    let none_left = pairs.is_empty();
    let mut kept: Vec<&mut Pair<'a>> = pairs
        .iter_mut()
        .filter(|p| legacy.contains(&p.key) || Some(&p.key) == protection.as_ref())
        .collect();
    let total: Decimal = kept.iter().map(|p| p.cover()).sum();
    if total > n {
        shrink_newest(&mut kept, n, &mut out.steps);
    }
    let protection_pair = kept
        .into_iter()
        .find(|p| Some(&p.key) == protection.as_ref());
    let ceiling = match state.reading {
        Reading::ExitsAhead(exits) => (n - exits).max(Decimal::ZERO),
        Reading::Current | Reading::FillsAhead => n,
    };
    match protection_pair {
        Some(p) => {
            if total < ceiling && !p.busy() {
                let want = p.cover() + (ceiling - total);
                size_pair(p, want, Why::Grew, &mut out.steps);
            }
        }
        None if none_left && !ceiling.is_zero() => {
            let want = ceiling;
            let newest = state
                .intents
                .iter()
                .filter_map(|i| {
                    let e = state.orders.iter().find(|o| o.id == i.entry)?;
                    (!e.filled_qty.is_zero() && e.request.side == side).then_some((e.updated_at, i))
                })
                .max_by_key(|(at, _)| *at);
            if let Some((_, i)) = newest
                && i.bracket.has_legs()
            {
                out.steps.push(Step::Attach {
                    entry: i.entry.clone(),
                    bracket: i.bracket,
                    qty: Qty(want),
                });
                attached = true;
                for i in state.intents {
                    if state
                        .orders
                        .iter()
                        .any(|o| o.id == i.entry && !o.filled_qty.is_zero())
                    {
                        out.done.push(i.entry.clone());
                    }
                }
            }
        }
        None => {}
    }
    let protected = protection.is_some();
    settle_intents(state, protected, attached, &mut out.done);
    out.done.sort();
    out.done.dedup();
}

pub fn merge(state: &State<'_>) -> Plan {
    let (mut pairs, _, waiting) = classify(state);
    let mut out = Plan {
        waiting,
        ..Plan::default()
    };
    let n = state.position.abs();
    let Some(side) = Side::holding(state.position) else {
        return out;
    };
    if pairs.len() < 2 || waiting {
        return out;
    }
    let long = side == Side::Buy;
    let keep = lead(&pairs, side, true).expect("two pairs");
    let best = |role: OrderRole| -> Option<Price> {
        let prices = pairs
            .iter()
            .filter_map(|p| {
                if role == OrderRole::StopLoss {
                    p.stop
                } else {
                    p.target
                }
            })
            .filter_map(|l| l.price());
        let high = (role == OrderRole::StopLoss) == long;
        if high { prices.max() } else { prices.min() }
    };
    let (stop_at, target_at) = (best(OrderRole::StopLoss), best(OrderRole::TakeProfit));
    for (i, p) in pairs.iter_mut().enumerate() {
        if i != keep {
            for leg in p.legs_mut() {
                cancel(leg, Why::Merged, &mut out.steps);
            }
        }
    }
    let k = &mut pairs[keep];
    for (leg, at) in [(k.stop.as_ref(), stop_at), (k.target.as_ref(), target_at)] {
        if let (Some(leg), Some(at)) = (leg, at)
            && let Some(from) = leg.price()
            && from != at
        {
            out.steps.push(Step::Move {
                order: leg.id().clone(),
                role: leg.role(),
                from,
                to: at,
            });
        }
    }
    size_pair(k, n, Why::Merged, &mut out.steps);
    out.memory = Memory {
        side: Some(side),
        protection: Some(k.key.clone()),
        legacy: BTreeSet::new(),
    };
    finish(out)
}

pub fn protected(orders: &[Order], position: Decimal) -> bool {
    if position.is_zero() {
        return false;
    }
    let state = State {
        mode: ProtectionMode::Grow,
        position,
        reading: Reading::Current,
        orders,
        changing: &[],
        intents: &[],
    };
    !classify(&state).0.is_empty()
}

pub fn protection_prices(orders: &[Order], position: Decimal) -> Bracket {
    let state = State {
        mode: ProtectionMode::Grow,
        position,
        reading: Reading::Current,
        orders,
        changing: &[],
        intents: &[],
    };
    let (pairs, _, _) = classify(&state);
    if position.is_zero() || pairs.is_empty() {
        return Bracket::default();
    }
    let long = position > Decimal::ZERO;
    let stops = pairs.iter().filter_map(|p| p.stop.and_then(|l| l.price()));
    let targets = pairs
        .iter()
        .filter_map(|p| p.target.and_then(|l| l.price()));
    Bracket {
        stop_loss: if long { stops.max() } else { stops.min() },
        take_profit: if long { targets.min() } else { targets.max() },
        ..Bracket::default()
    }
}

#[cfg(test)]
mod tests;
