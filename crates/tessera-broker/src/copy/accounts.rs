use std::collections::HashSet;

use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_core::ids::{AccountId, OrderId};
use tessera_core::orders::{Bracket, Order, OrderRole, OrderStatus, OrderType, Side};
use tessera_core::{InstrumentId, Qty};
use tessera_protocol::tools::ToolErrorCode;
use tessera_tools::{ActionTarget, ToolCtx, ToolError};

use super::io::{CopyActionOutput, CopyFlattenInput, CopyResyncInput};
use super::mirror::{
    ACT_WAIT, Copying, Member, bare, flatten_words, outcome_of, preview_key, request_words,
    status_tail,
};
use super::model::{CopyFollower, CopyGroup, CopyOutcome};
use super::sync::{CopyHolding, Held, SyncState};
use crate::orders::io::{AccountScopeInput, CancelOrderInput, OrderInput};
use crate::orders::{OrdersService, broker_error, order_sentence};

pub const RESYNC_TOOL: &str = "copy.resync";
const ON_ITS_WAY: &str = "an order is on its way there; resync once it fills";
pub const FLATTEN_TOOL: &str = "copy.flatten";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResyncStep {
    Flatten,
    Open { side: Side, qty: Decimal },
    Reduce { side: Side, qty: Decimal },
}

fn against(side: Side) -> Side {
    match side {
        Side::Buy => Side::Sell,
        Side::Sell => Side::Buy,
    }
}

pub(crate) fn resync_steps(holds: Decimal, target: Decimal) -> Vec<ResyncStep> {
    let mut steps = Vec::new();
    let other_side = !holds.is_zero()
        && !target.is_zero()
        && holds.is_sign_positive() != target.is_sign_positive();
    let holds = if target.is_zero() || other_side {
        if !holds.is_zero() {
            steps.push(ResyncStep::Flatten);
        }
        Decimal::ZERO
    } else {
        holds
    };
    let Some(side) = Side::holding(target) else {
        return steps;
    };
    let (want, have) = (target.abs(), holds.abs());
    if want > have {
        steps.push(ResyncStep::Open {
            side,
            qty: want - have,
        });
    } else if have > want {
        steps.push(ResyncStep::Reduce {
            side: against(side),
            qty: have - want,
        });
    }
    steps
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ContractPlan {
    Wait,
    Steps(Vec<ResyncStep>),
}

pub(crate) fn contract_plan(
    h: &CopyHolding,
    orders: &[Order],
    sent_lately: &HashSet<OrderId>,
    resting_copies: &HashSet<OrderId>,
) -> ContractPlan {
    let on_its_way = orders.iter().any(|o| {
        o.request.instrument == h.instrument
            && !o.status.is_terminal()
            && (o.request.order_type == OrderType::Market
                || (sent_lately.contains(&o.id) && !resting_copies.contains(&o.id)))
    });
    if on_its_way {
        ContractPlan::Wait
    } else {
        ContractPlan::Steps(resync_steps(h.qty.0, h.target_qty.0))
    }
}

pub(crate) fn leader_bracket(
    orders: &[Order],
    instrument: &InstrumentId,
    long: bool,
) -> Option<Bracket> {
    let exit = if long { Side::Sell } else { Side::Buy };
    let legs = |role: OrderRole| {
        orders.iter().filter(move |o| {
            &o.request.instrument == instrument
                && o.role == role
                && o.request.side == exit
                && o.status.is_open()
                && o.status != OrderStatus::Held
        })
    };
    let stops = legs(OrderRole::StopLoss).filter_map(|o| o.request.stop_price);
    let targets = legs(OrderRole::TakeProfit).filter_map(|o| o.request.limit_price);
    let (stop, target) = if long {
        (stops.max(), targets.min())
    } else {
        (stops.min(), targets.max())
    };
    (stop.is_some() || target.is_some()).then(|| Bracket {
        stop_loss: stop,
        take_profit: target,
        ..Bracket::default()
    })
}

fn listed(names: &[String]) -> String {
    match names {
        [] => "nobody".to_owned(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[derive(Clone, Copy, Debug)]
enum Sending {
    Opens(Option<Bracket>),
    Closes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ResyncPlan {
    Act,
    Paused,
    Settling,
    InSync,
    Unknown(String),
}

fn resync_plan_for(
    paused: bool,
    named: bool,
    standing: Option<(SyncState, Option<String>)>,
) -> Option<ResyncPlan> {
    let state = standing.as_ref().map(|(s, _)| *s);
    let plan = match standing {
        None | Some((SyncState::Unknown, None)) => {
            ResyncPlan::Unknown("its positions could not be read".to_owned())
        }
        Some((SyncState::Unknown, Some(why))) => ResyncPlan::Unknown(why),
        Some(_) if paused && !named => ResyncPlan::Paused,
        Some((SyncState::OutOfSync, _)) => ResyncPlan::Act,
        Some((SyncState::Settling, _)) => ResyncPlan::Settling,
        Some((SyncState::InSync, _)) => ResyncPlan::InSync,
    };
    let reported = named
        || match plan {
            ResyncPlan::Act | ResyncPlan::Unknown(_) => true,
            ResyncPlan::Paused => state == Some(SyncState::OutOfSync),
            ResyncPlan::Settling | ResyncPlan::InSync => false,
        };
    reported.then_some(plan)
}

struct Planned {
    follower: CopyFollower,
    plan: ResyncPlan,
}

impl Member for Planned {
    fn account(&self) -> &AccountId {
        &self.follower.account_id
    }
}

struct Resyncing<'a> {
    ctx: &'a ToolCtx,
    group: &'a CopyGroup,
    leader_name: &'a str,
    leader_orders: &'a [Order],
}

impl OrdersService {
    fn copy_group(&self, id: &str) -> Result<CopyGroup, ToolError> {
        let id = id.trim();
        self.copying
            .book
            .group(id)
            .ok_or_else(|| ToolError::not_found(format!("no copy group {id}")))
    }

    async fn resync_scope(
        &self,
        input: &CopyResyncInput,
    ) -> Result<(CopyGroup, Option<CopyFollower>), ToolError> {
        let group = self.copy_group(&input.group_id)?;
        let Some(a) = input.account_id.as_deref().map(str::trim) else {
            return Ok((group, None));
        };
        let id = AccountId::new(a);
        if id == group.leader_id {
            let leader = self.account_name(a).await;
            return Err(ToolError::rejected(format!(
                "{leader} leads {}; resync puts followers at their size.",
                group.name
            )));
        }
        let Some(f) = group.follower(&id).cloned() else {
            let name = self.account_name(a).await;
            return Err(ToolError::rejected(format!(
                "{name} is not in {}.",
                group.name
            )));
        };
        Ok((group, Some(f)))
    }

    pub fn resync_target(&self, input: &CopyResyncInput) -> Option<ActionTarget> {
        let g = self.copying.book.group(input.group_id.trim())?;
        let (account, concerned): (AccountId, Vec<AccountId>) =
            match input.account_id.as_deref().map(str::trim) {
                Some(a) => (AccountId::new(a), vec![AccountId::new(a)]),
                None => (
                    g.leader_id.clone(),
                    g.copying().map(|f| f.account_id.clone()).collect(),
                ),
            };
        let environment = if concerned.is_empty() {
            self.environment(g.leader_id.as_str())
        } else {
            self.strictest_environment(&concerned)
        };
        Some(ActionTarget {
            account: account.to_string(),
            instrument: None,
            environment,
            exit: false,
        })
    }

    async fn resync_plan(&self, group: &CopyGroup, one: Option<&CopyFollower>) -> Vec<Planned> {
        let sync = self.sync_of(std::slice::from_ref(group)).await;
        let standing = |f: &CopyFollower| {
            sync.groups
                .iter()
                .flat_map(|g| &g.followers)
                .find(|s| s.account_id == f.account_id)
                .map(|s| (s.state, s.why.clone()))
        };
        let planned = |f: &CopyFollower, named: bool| {
            resync_plan_for(f.paused, named, standing(f)).map(|plan| Planned {
                follower: f.clone(),
                plan,
            })
        };
        match one {
            Some(f) => planned(f, true).into_iter().collect(),
            None => group
                .followers
                .iter()
                .filter_map(|f| planned(f, false))
                .collect(),
        }
    }

    pub async fn resync_preview(&self, input: &CopyResyncInput) -> Result<Value, ToolError> {
        let (group, plans) = {
            let _manage = self.copying.manage.lock().await;
            let (group, one) = self.resync_scope(input).await?;
            let _turn = self.leader_turn(&group.leader_id).await;
            let plans = self.resync_plan(&group, one.as_ref()).await;
            (group, plans)
        };
        let acting: Vec<AccountId> = plans
            .iter()
            .filter(|p| p.plan == ResyncPlan::Act)
            .map(|p| p.follower.account_id.clone())
            .collect();
        self.remember_preview(preview_key(RESYNC_TOOL, input), acting.clone());
        let mut names = Vec::with_capacity(acting.len());
        for a in &acting {
            names.push(self.account_name(a.as_str()).await);
        }
        let restatement = match names.len() {
            0 => format!(
                "Resync {}: no follower is out of sync now; nothing to send",
                group.name
            ),
            1 => format!(
                "Resync {} in {}: put it at its size",
                listed(&names),
                group.name
            ),
            _ => format!(
                "Resync {}: put {} at their size",
                group.name,
                listed(&names)
            ),
        };
        Ok(json!({ "restatement": restatement }))
    }

    pub async fn copy_resync(
        &self,
        ctx: &ToolCtx,
        input: &CopyResyncInput,
    ) -> Result<CopyActionOutput, ToolError> {
        let manage = self.copying.manage.lock().await;
        let (group, one) = self.resync_scope(input).await?;
        let _turn = self.leader_turn(&group.leader_id).await;
        let mut plans = self.resync_plan(&group, one.as_ref()).await;
        if ctx.approved_by.is_some() {
            let named = self
                .previewed_accounts(&preview_key(RESYNC_TOOL, input))
                .unwrap_or_default();
            plans.retain(|p| p.plan != ResyncPlan::Act || named.contains(&p.follower.account_id));
        }
        drop(manage);
        let leader_name = self.account_name(group.leader_id.as_str()).await;
        let lead = self.open_positions(&group.leader_id).await;
        let leader_orders = self
            .provider_ref()
            .orders(&group.leader_id)
            .await
            .map_err(|e| broker_error(e).message);
        let done = self
            .each_of(&plans, ACT_WAIT, |p, name| {
                let (group, leader_name, lead, leader_orders) =
                    (&group, &leader_name, &lead, &leader_orders);
                async move {
                    let f = &p.follower;
                    let c = Copying::new(&f.account_id, name);
                    match &p.plan {
                        ResyncPlan::Act => {}
                        ResyncPlan::Paused => {
                            return c.done(CopyOutcome::Nothing, "paused: resync it on its own");
                        }
                        ResyncPlan::Settling => {
                            return c.done(
                                CopyOutcome::Nothing,
                                "copies are on their way; resync once it settles",
                            );
                        }
                        ResyncPlan::InSync => {
                            return c.done(CopyOutcome::Nothing, "in sync already");
                        }
                        ResyncPlan::Unknown(why) => {
                            return c.done(
                                CopyOutcome::Unknown,
                                format!("{}; nothing sent", why.trim_end_matches('.')),
                            );
                        }
                    }
                    let (lead, leader_orders) = match (lead, leader_orders) {
                        (Ok(l), Ok(o)) => (l, o),
                        (Err(why), _) => {
                            return c.done(
                                CopyOutcome::Unknown,
                                format!(
                                    "the leader's positions could not be read: {}; nothing sent",
                                    why.trim_end_matches('.')
                                ),
                            );
                        }
                        (_, Err(why)) => {
                            return c.done(
                                CopyOutcome::Unknown,
                                format!(
                                    "the leader's orders could not be read: {}; nothing sent",
                                    why.trim_end_matches('.')
                                ),
                            );
                        }
                    };
                    let r = Resyncing {
                        ctx,
                        group,
                        leader_name,
                        leader_orders,
                    };
                    self.resync_one(&r, f, c, lead).await
                }
            })
            .await;
        let report = self.report(&group, &done);
        if !report.results.is_empty() {
            self.say_whole_report(&group, &format!("Resync {}", group.name), &report);
        }
        Ok(CopyActionOutput { report })
    }

    async fn resync_one(
        &self,
        r: &Resyncing<'_>,
        f: &CopyFollower,
        mut c: Copying,
        lead: &Held,
    ) -> Copying {
        let holdings = match self.reading(f, lead).await {
            Ok(h) => h,
            Err(why) => return c.done(CopyOutcome::Unknown, format!("{why}; nothing sent")),
        };
        let orders = match self.provider_ref().orders(&f.account_id).await {
            Ok(o) => o,
            Err(e) => {
                return c.done(
                    CopyOutcome::Unknown,
                    format!(
                        "its orders could not be read: {}; nothing sent",
                        broker_error(e).message.trim_end_matches('.')
                    ),
                );
            }
        };
        let apart: Vec<&CopyHolding> = holdings.iter().filter(|h| h.apart()).collect();
        if apart.is_empty() {
            return c.done(CopyOutcome::Nothing, "in sync already");
        }
        let sent = self.sent_lately();
        let resting: HashSet<OrderId> = orders
            .iter()
            .filter(|o| o.status.is_open() && self.copies_a_working_order(&f.account_id, &o.id))
            .map(|o| o.id.clone())
            .collect();
        let mut texts = Vec::new();
        let mut waiting = Vec::new();
        for h in apart {
            let steps = match contract_plan(h, &orders, &sent, &resting) {
                ContractPlan::Wait => {
                    waiting.push(h.instrument.symbol().to_owned());
                    continue;
                }
                ContractPlan::Steps(steps) => steps,
            };
            if let Err(e) = self
                .resync_holding(r, h, &orders, steps, &mut c, &mut texts)
                .await
            {
                let words = self.account_words(&f.account_id).await;
                let why = bare(&words, &e);
                let text = if texts.is_empty() {
                    why
                } else {
                    format!("{}; then: {why}", texts.join(" · "))
                };
                return c.done(outcome_of(&e), text);
            }
        }
        if !waiting.is_empty() {
            if texts.is_empty() {
                return c.done(CopyOutcome::Nothing, ON_ITS_WAY);
            }
            texts.push(format!("{}: {ON_ITS_WAY}", waiting.join(", ")));
        }
        c.done(CopyOutcome::Copied, texts.join(" · "))
    }

    async fn resync_holding(
        &self,
        r: &Resyncing<'_>,
        h: &CopyHolding,
        orders: &[Order],
        steps: Vec<ResyncStep>,
        c: &mut Copying,
        texts: &mut Vec<String>,
    ) -> Result<(), ToolError> {
        let account = &c.result.account_id.clone();
        let stale = orders.iter().filter(|o| {
            o.request.instrument == h.instrument
                && o.status.is_open()
                && o.role == OrderRole::Entry
                && o.parent_id.is_none()
                && !o.request.reduce_only
                && !self.copies_a_working_order(account, &o.id)
        });
        for o in stale {
            let cancel = CancelOrderInput {
                account_id: account.to_string(),
                order_id: o.id.clone(),
            };
            let out = self.cancel(&cancel).await;
            let summary = out
                .as_ref()
                .map(|x| format!("cancelled {}", order_sentence(&x.order, None)))
                .map_err(Clone::clone);
            self.audit_copy(
                r.ctx,
                r.group,
                r.leader_name,
                account,
                RESYNC_TOOL,
                json!(cancel),
                &summary,
            );
            match out {
                Ok(x) => {
                    c.result.orders.push(x.order.id);
                    texts.extend(summary.ok());
                }
                Err(e) if e.code == ToolErrorCode::Conflict => {}
                Err(e) => return Err(e),
            }
        }
        for step in steps {
            match step {
                ResyncStep::Flatten => {
                    let (text, closed) = self
                        .flat_on(
                            r.ctx,
                            r.group,
                            r.leader_name,
                            account,
                            &h.instrument,
                            RESYNC_TOOL,
                        )
                        .await?;
                    c.result.orders.extend(closed);
                    texts.push(format!("{} {text}", h.instrument.symbol()));
                }
                ResyncStep::Open { side, qty } => {
                    if let Some(e) = self.leader_locked(&r.group.leader_id) {
                        return Err(e);
                    }
                    let bracket = h
                        .leader_instrument
                        .as_ref()
                        .and_then(|i| leader_bracket(r.leader_orders, i, side == Side::Buy));
                    let (id, text) = self
                        .resync_send(
                            r,
                            account,
                            &h.instrument,
                            side,
                            qty,
                            Sending::Opens(bracket),
                        )
                        .await?;
                    c.result.orders.push(id);
                    texts.push(text);
                }
                ResyncStep::Reduce { side, qty } => {
                    let (id, text) = self
                        .resync_send(r, account, &h.instrument, side, qty, Sending::Closes)
                        .await?;
                    c.result.orders.push(id);
                    texts.push(text);
                }
            }
        }
        Ok(())
    }

    async fn resync_send(
        &self,
        r: &Resyncing<'_>,
        account: &AccountId,
        instrument: &InstrumentId,
        side: Side,
        qty: Decimal,
        sending: Sending,
    ) -> Result<(OrderId, String), ToolError> {
        let (bracket, closes) = match sending {
            Sending::Opens(b) => (b, false),
            Sending::Closes => (None, true),
        };
        let input = OrderInput {
            account_id: account.to_string(),
            instrument: instrument.to_string(),
            side,
            qty: Qty(qty),
            order_type: OrderType::Market,
            limit_price: None,
            stop_price: None,
            tif: None,
            bracket,
            reduce_only: closes.then_some(true),
            client_order_id: None,
        };
        let out = self.submit(&input, None, None).await;
        let summary = out
            .as_ref()
            .map(|o| {
                let mut s = request_words(&o.order.request, None);
                if closes {
                    s.push_str(" (closes)");
                }
                s.push_str(status_tail(&o.order));
                if !o.bracket.is_empty() || o.order.request.bracket.is_some() {
                    s.push_str(" · bracket");
                }
                s
            })
            .map_err(Clone::clone);
        self.audit_copy(
            r.ctx,
            r.group,
            r.leader_name,
            account,
            RESYNC_TOOL,
            json!(input),
            &summary,
        );
        let out = out?;
        self.note_sent(&out.order.id);
        Ok((out.order.id, summary.unwrap_or_default()))
    }

    async fn flatten_scope(
        &self,
        input: &CopyFlattenInput,
    ) -> Result<(CopyGroup, Vec<AccountId>), ToolError> {
        let group = self.copy_group(&input.group_id)?;
        let accounts = match input.account_id.as_deref().map(str::trim) {
            None => std::iter::once(group.leader_id.clone())
                .chain(group.followers.iter().map(|f| f.account_id.clone()))
                .collect(),
            Some(a) => {
                let id = AccountId::new(a);
                if id != group.leader_id && group.follower(&id).is_none() {
                    let name = self.account_name(a).await;
                    return Err(ToolError::rejected(format!(
                        "{name} is not in {}.",
                        group.name
                    )));
                }
                vec![id]
            }
        };
        Ok((group, accounts))
    }

    pub fn group_flatten_target(&self, input: &CopyFlattenInput) -> Option<ActionTarget> {
        let g = self.copying.book.group(input.group_id.trim())?;
        let (account, concerned): (AccountId, Vec<AccountId>) =
            match input.account_id.as_deref().map(str::trim) {
                Some(a) => (AccountId::new(a), vec![AccountId::new(a)]),
                None => (
                    g.leader_id.clone(),
                    std::iter::once(g.leader_id.clone())
                        .chain(g.followers.iter().map(|f| f.account_id.clone()))
                        .collect(),
                ),
            };
        Some(ActionTarget {
            account: account.to_string(),
            instrument: None,
            environment: self.strictest_environment(&concerned),
            exit: true,
        })
    }

    pub async fn group_flatten_preview(
        &self,
        input: &CopyFlattenInput,
    ) -> Result<Value, ToolError> {
        let (group, accounts) = {
            let _manage = self.copying.manage.lock().await;
            self.flatten_scope(input).await?
        };
        self.remember_preview(preview_key(FLATTEN_TOOL, input), accounts.clone());
        let mut names = Vec::with_capacity(accounts.len());
        for a in &accounts {
            names.push(self.account_name(a.as_str()).await);
        }
        let whose = if names.len() == 1 { "its" } else { "their" };
        Ok(json!({
            "restatement": format!(
                "Flatten {} ({}): cancel {whose} working orders and close every position at market",
                listed(&names),
                group.name
            )
        }))
    }

    pub async fn copy_flatten_group(
        &self,
        ctx: &ToolCtx,
        input: &CopyFlattenInput,
    ) -> Result<CopyActionOutput, ToolError> {
        let manage = self.copying.manage.lock().await;
        let (group, mut accounts) = self.flatten_scope(input).await?;
        let _turn = self.leader_turn(&group.leader_id).await;
        if ctx.approved_by.is_some() {
            let named = self
                .previewed_accounts(&preview_key(FLATTEN_TOOL, input))
                .unwrap_or_default();
            accounts.retain(|a| named.contains(a));
        }
        drop(manage);
        let leader_name = self.account_name(group.leader_id.as_str()).await;
        let done = self
            .each_of(&accounts, ACT_WAIT, |a, name| {
                let (group, leader_name) = (&group, &leader_name);
                async move {
                    let mut c = Copying::new(a, name);
                    let mine = AccountScopeInput {
                        account_id: a.to_string(),
                        instrument: None,
                    };
                    let out = self.flatten(&mine).await;
                    let summary = out.as_ref().map(flatten_words).map_err(Clone::clone);
                    if a != &group.leader_id {
                        self.audit_copy(
                            ctx,
                            group,
                            leader_name,
                            a,
                            FLATTEN_TOOL,
                            json!(mine),
                            &summary,
                        );
                    }
                    match (out, summary) {
                        (Ok(o), Ok(s)) => {
                            c.result.orders = o.closing.into_iter().map(|o| o.id).collect();
                            c.done(CopyOutcome::Copied, s)
                        }
                        (Err(e), _) | (_, Err(e)) => {
                            let words = self.account_words(a).await;
                            c.done(outcome_of(&e), bare(&words, &e))
                        }
                    }
                }
            })
            .await;
        let report = self.report(&group, &done);
        if report.results.is_empty() {
            return Ok(CopyActionOutput { report });
        }
        let what = match (&input.account_id, done.first()) {
            (Some(_), Some(c)) => format!("Flatten {}", c.result.account),
            _ => format!("Flatten {}", group.name),
        };
        self.say_whole_report(&group, &what, &report);
        Ok(CopyActionOutput { report })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::Price;
    use tessera_core::ids::AccountId;
    use tessera_core::orders::{OrderRequest, TimeInForce};

    fn d(s: &str) -> Decimal {
        s.parse().unwrap()
    }

    #[test]
    fn resync_opens_closes_or_turns_a_contract_to_its_size() {
        use ResyncStep::{Flatten, Open, Reduce};
        let buy = |q: &str| Open {
            side: Side::Buy,
            qty: d(q),
        };
        let rows = [
            ("0", "2", vec![buy("2")]),
            ("1", "3", vec![buy("2")]),
            (
                "3",
                "2",
                vec![Reduce {
                    side: Side::Sell,
                    qty: d("1"),
                }],
            ),
            (
                "-3",
                "-1",
                vec![Reduce {
                    side: Side::Buy,
                    qty: d("2"),
                }],
            ),
            ("2", "0", vec![Flatten]),
            ("-1", "2", vec![Flatten, buy("2")]),
            (
                "1",
                "-1",
                vec![
                    Flatten,
                    Open {
                        side: Side::Sell,
                        qty: d("1"),
                    },
                ],
            ),
            ("2", "2", vec![]),
        ];
        for (holds, target, want) in rows {
            assert_eq!(
                resync_steps(d(holds), d(target)),
                want,
                "{holds} → {target}"
            );
        }
    }

    fn leg(role: OrderRole, side: Side, price: &str, status: OrderStatus) -> Order {
        let p = Some(Price(d(price)));
        let req = OrderRequest {
            account_id: AccountId::new("lead"),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            side,
            qty: Qty::from(1),
            order_type: if role == OrderRole::StopLoss {
                OrderType::Stop
            } else {
                OrderType::Limit
            },
            limit_price: if role == OrderRole::TakeProfit {
                p
            } else {
                None
            },
            stop_price: if role == OrderRole::StopLoss { p } else { None },
            tif: TimeInForce::Gtc,
            bracket: None,
            client_order_id: None,
            reduce_only: true,
        };
        Order {
            id: OrderId::generate(),
            broker_order_id: None,
            draft_id: None,
            request: req,
            role,
            parent_id: None,
            status,
            filled_qty: Qty::ZERO,
            avg_fill_price: None,
            queue_ahead: None,
            stop_rules: None,
            triggered_at: None,
            environment: tessera_core::accounts::Environment::Paper,
            reason: None,
            created_at: tessera_core::Timestamp(0),
            updated_at: tessera_core::Timestamp(0),
        }
    }

    #[test]
    fn a_resync_brackets_at_the_leaders_stop_and_target_nearest_the_market() {
        let w = OrderStatus::Working;
        let orders = [
            leg(OrderRole::StopLoss, Side::Sell, "20600.00", w),
            leg(OrderRole::StopLoss, Side::Sell, "20610.00", w),
            leg(OrderRole::TakeProfit, Side::Sell, "20700.00", w),
            leg(OrderRole::TakeProfit, Side::Sell, "20690.00", w),
            leg(
                OrderRole::StopLoss,
                Side::Sell,
                "20640.00",
                OrderStatus::Held,
            ),
            leg(
                OrderRole::StopLoss,
                Side::Sell,
                "20645.00",
                OrderStatus::Cancelled,
            ),
        ];
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let b = leader_bracket(&orders, &nq, true).unwrap();
        assert_eq!(b.stop_loss, Some(Price(d("20610.00"))));
        assert_eq!(b.take_profit, Some(Price(d("20690.00"))));
        assert_eq!(leader_bracket(&orders, &nq, false), None);
        let es = InstrumentId::new("ESZ6.CME").unwrap();
        assert_eq!(leader_bracket(&orders, &es, true), None);
        let short = [
            leg(OrderRole::StopLoss, Side::Buy, "20700.00", w),
            leg(OrderRole::StopLoss, Side::Buy, "20690.00", w),
        ];
        let b = leader_bracket(&short, &nq, false).unwrap();
        assert_eq!(b.stop_loss, Some(Price(d("20690.00"))));
        assert_eq!(b.take_profit, None);
    }

    #[test]
    fn a_resync_acts_only_on_a_follower_out_of_sync_and_never_while_it_settles() {
        use ResyncPlan::{Act, InSync, Paused, Settling, Unknown};
        use SyncState as S;
        let unread = || Some("positions could not be read: not connected".to_owned());
        let rows = [
            (false, false, Some((S::OutOfSync, None)), Some(Act)),
            (false, false, Some((S::Settling, None)), None),
            (false, false, Some((S::InSync, None)), None),
            (
                false,
                false,
                Some((S::Unknown, unread())),
                Some(Unknown(
                    "positions could not be read: not connected".to_owned(),
                )),
            ),
            (true, false, Some((S::OutOfSync, None)), Some(Paused)),
            (true, false, Some((S::Settling, None)), None),
            (true, false, Some((S::InSync, None)), None),
            (false, true, Some((S::OutOfSync, None)), Some(Act)),
            (true, true, Some((S::OutOfSync, None)), Some(Act)),
            (false, true, Some((S::Settling, None)), Some(Settling)),
            (true, true, Some((S::Settling, None)), Some(Settling)),
            (false, true, Some((S::InSync, None)), Some(InSync)),
            (
                false,
                true,
                None,
                Some(Unknown("its positions could not be read".to_owned())),
            ),
        ];
        for (paused, named, standing, want) in rows {
            assert_eq!(
                resync_plan_for(paused, named, standing.clone()),
                want,
                "paused {paused}, named {named}, {standing:?}"
            );
        }
    }

    #[test]
    fn a_resync_waits_while_an_order_is_on_its_way_to_the_contract() {
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let h = CopyHolding {
            leader_instrument: Some(nq.clone()),
            instrument: nq.clone(),
            leader_qty: Qty::from(2),
            target_qty: Qty::from(2),
            qty: Qty::ZERO,
        };
        let none = HashSet::new();
        let opens = ContractPlan::Steps(vec![ResyncStep::Open {
            side: Side::Buy,
            qty: d("2"),
        }]);
        let mut market = leg(
            OrderRole::Entry,
            Side::Buy,
            "20641.25",
            OrderStatus::Working,
        );
        market.request.order_type = OrderType::Market;
        market.request.reduce_only = false;
        assert_eq!(contract_plan(&h, &[], &none, &none), opens);
        assert_eq!(
            contract_plan(&h, std::slice::from_ref(&market), &none, &none),
            ContractPlan::Wait,
            "a market order not filled yet"
        );
        let mut filled = market.clone();
        filled.status = OrderStatus::Filled;
        assert_eq!(contract_plan(&h, &[filled], &none, &none), opens);
        let mut elsewhere = market.clone();
        elsewhere.request.instrument = InstrumentId::new("ESZ6.CME").unwrap();
        assert_eq!(contract_plan(&h, &[elsewhere], &none, &none), opens);
        let mut resting = leg(
            OrderRole::Entry,
            Side::Buy,
            "20630.00",
            OrderStatus::Working,
        );
        resting.request.reduce_only = false;
        let lately: HashSet<OrderId> = [resting.id.clone()].into();
        assert_eq!(
            contract_plan(&h, std::slice::from_ref(&resting), &lately, &none),
            ContractPlan::Wait,
            "a limit the copier just sent"
        );
        assert_eq!(
            contract_plan(&h, std::slice::from_ref(&resting), &lately, &lately),
            opens,
            "a resting copy of a working leader order"
        );
        assert_eq!(
            contract_plan(&h, std::slice::from_ref(&resting), &none, &none),
            opens,
            "an old limit is the resync's to cancel"
        );
    }

    #[test]
    fn names_are_listed_in_words() {
        let n = |v: &[&str]| listed(&v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        assert_eq!(n(&["Lead"]), "Lead");
        assert_eq!(n(&["Lead", "Eval 1"]), "Lead and Eval 1");
        assert_eq!(n(&["Lead", "Eval 1", "Eval 2"]), "Lead, Eval 1 and Eval 2");
    }
}
