use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_core::orders::{OrderPreview, Side};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{ActionTarget, Tool, ToolCtx, ToolError, ToolMeta};

use super::io::{
    AccountFilterInput, AccountLimits, AccountLockOutput, AccountScopeInput, AccountsOutput,
    BreakevenStopInput, BreakevenStopOutput, CancelAllInput, CancelAllOutput, CancelOrderInput,
    ContractForInput, ContractForOutput, FillsOutput, FlattenOutput, GetAccountsInput,
    GetFillsInput, GetLimitsInput, GetLockInput, GetOrdersInput, LimitsOutput, LockAccountInput,
    LockAccountOutput, MergeOutput, ModifyOrderInput, OrderInput, OrderOutput, OrdersOutput,
    PositionsOutput, ReverseInput, ReverseOutput, RiskStatusInput, RiskStatusOutput, SubmitOutput,
    UnlockAccountInput, UnlockAccountOutput,
};
use super::{OrdersService, legs_words, position_words};
use crate::paper::engine::{price_label, qty_label};

const AGENT_NOTE: &str = "From an agent or MCP client it creates a draft and an approval request \
(status pending_approval, with draftId and approvalId) that only the user can approve in Tessera, \
unless the user put the session in Full access: then it executes at once, as the user's own call \
would, under the trader's limits.";

const COPY_ORDERS_NOTE: &str = "On an account leading a copy group that is on (copy.list), it is \
copied to the group's followers that are not paused, each at its own size, under its own limits \
(one refused is skipped, the others go; `copies` in the result says each); an approval of it says \
`and N accounts by copy` and covers those accounts.";

const BRACKET_NOTE: &str = "A position's bracket follows the trader's setting \
(trade.positionBracket). With `per_entry` (the default) every entry keeps its own stop and target; a \
partial exit shrinks the newest entry's first. With `grow` a position has one stop and one target for all \
of it: an entry on the side of a position that has them is an add, sent without its own legs \
(the pre-trade checks and the trader's limits weigh it at the position's stop), and Tessera grows \
the stop and the target to the position's size when it fills, shrinks them on a partial exit and \
cancels them when flat (audited as orders.protect; journal.get_activity names Tessera; no limit \
refuses these).";

const CONTRACT_NOTE: &str = "The contract is named by the account's own connection: give any \
connection's id for it, or a symbol or root (NQ is the front month), and the order trades that \
connection's contract of the same exchange, root and month (orders.contract_for shows which). A \
connection that lists no such contract is refused before anything is sent, in words naming the \
account.";

fn order_target(svc: &OrdersService, input: &OrderInput) -> ActionTarget {
    ActionTarget {
        account: input.account_id.clone(),
        instrument: svc.instrument_hint(&input.account_id, &input.instrument),
        environment: svc.gate_environment(&input.account_id),
        exit: input.reduce_only.unwrap_or(false),
    }
}

const RESOLVE_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

async fn resolved_target(svc: &OrdersService, input: &OrderInput) -> ActionTarget {
    let _ = tokio::time::timeout(
        RESOLVE_WAIT,
        svc.resolve_for(&input.account_id, &input.instrument),
    )
    .await;
    order_target(svc, input)
}

fn scope_target(svc: &OrdersService, input: &AccountScopeInput) -> ActionTarget {
    ActionTarget {
        account: input.account_id.clone(),
        instrument: input
            .instrument
            .as_deref()
            .and_then(|i| svc.instrument_hint(&input.account_id, i)),
        environment: svc.gate_environment(&input.account_id),
        exit: true,
    }
}

fn submit_summary(out: &SubmitOutput) -> String {
    let o = &out.order;
    let mut s = format!(
        "{} {} {} {}",
        o.request.side.label().to_lowercase(),
        qty_label(o.request.qty),
        o.request.instrument.symbol(),
        o.request.order_type.abbrev()
    );
    let status = match o.status {
        tessera_core::orders::OrderStatus::Filled => format!(
            "filled at {}",
            o.avg_fill_price
                .map(|p| p.0.normalize().to_string())
                .unwrap_or_default()
        ),
        tessera_core::orders::OrderStatus::PartiallyFilled => {
            format!(
                "{} of {} filled",
                qty_label(o.filled_qty),
                qty_label(o.request.qty)
            )
        }
        other => format!("{other:?}").to_lowercase(),
    };
    s.push_str(&format!(" · {status}"));
    if !out.bracket.is_empty() {
        s.push_str(" · bracket");
    }
    if let Some(c) = &out.copies {
        s.push_str(&format!(" · {}", c.summary()));
    }
    s
}

pub struct ContractFor(pub Arc<OrdersService>);

#[async_trait]
impl Tool for ContractFor {
    type Input = ContractForInput;
    type Output = ContractForOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "orders.contract_for",
            "Contract for an account",
            RiskTier::Read,
        )
        .description(
            "The contract an order for an account trades, named by the account's own connection: \
             give what is meant (a chart's contract from any connection, a symbol or root, and \
             for a family sibling its root, MNQ for an NQ contract; or exchange, root and expiry \
             YYYY-MM) and get that connection's own instrument and spec, or `refused` in words \
             naming the account and the contract. Orders name their contract this way \
             themselves; use it to check before drafting.",
        )
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ContractForInput,
    ) -> Result<ContractForOutput, ToolError> {
        self.0.contract_for(&input).await
    }

    fn summarize(&self, out: &ContractForOutput) -> Option<String> {
        Some(match (&out.instrument, &out.refused) {
            (Some(i), _) => format!("{} for {}", i.id, out.account),
            (None, Some(why)) => why.clone(),
            (None, None) => out.account.clone(),
        })
    }
}

pub struct PreviewOrder(pub Arc<OrdersService>);

#[async_trait]
impl Tool for PreviewOrder {
    type Input = OrderInput;
    type Output = OrderPreview;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.preview", "Preview order", RiskTier::Read)
            .description(
                "Previews an order without sending it: the restatement, estimated price, value and \
                 fees, the risk to its bracket stop, the position after a fill and the pre-trade \
                 checks (a `block` check means it would be refused), the trader's own limits among \
                 them while one is on (risk.get_limits). An add to a position whose bracket grows \
                 (trade.positionBracket) is weighed at the position's stop, as its submit will be.",
            )
            .idempotent(false)
    }

    async fn call(&self, _ctx: &ToolCtx, input: OrderInput) -> Result<OrderPreview, ToolError> {
        self.0.preview(&input).await
    }
}

pub struct SubmitOrder(pub Arc<OrdersService>);

#[async_trait]
impl Tool for SubmitOrder {
    type Input = OrderInput;
    type Output = SubmitOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.submit", "Submit order", RiskTier::Financial).description(format!(
            "Sends an order (market, limit, stop or stop-limit, optionally with a bracket: a stop \
             and a target that work once the entry fills, as one OCO pair; the stop may move \
             by breakeven or trailing, only ever tighter: Paper moves it itself, and on Rithmic \
             Tessera moves it while it runs) to an account that takes orders: \
             paper, or an evaluation, funded or live account whose order entry the user turned on \
             (connections.list: accountOrderEntry). Refused with `rejected` when a pre-trade check blocks \
             it (market closed, no price, or one of the trader's own limits while the user has it \
             on: risk.get_limits; details carry the checks), and a market order that would open or \
             add while its instrument's market data has no live prices (details.code \
             `no_live_prices`; a close, orders.flatten and orders.reverse still go). {CONTRACT_NOTE} {BRACKET_NOTE} \
             {AGENT_NOTE} {COPY_ORDERS_NOTE}"
        ))
    }

    async fn call(&self, ctx: &ToolCtx, input: OrderInput) -> Result<SubmitOutput, ToolError> {
        self.0
            .submit_copying(
                ctx,
                "orders.submit",
                &input,
                ctx.idempotency_key.as_deref(),
                ctx.draft_id.clone(),
            )
            .await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &OrderInput) -> Result<Value, ToolError> {
        let mut v = serde_json::to_value(self.0.preview(input).await?)?;
        self.0
            .preview_copies("orders.submit", input, &input.account_id, &mut v)
            .await;
        Ok(v)
    }

    async fn ready(&self, _ctx: &ToolCtx, input: &OrderInput) -> Result<(), ToolError> {
        self.0.ready(input).await
    }

    async fn target(&self, input: &OrderInput) -> Option<ActionTarget> {
        Some(resolved_target(&self.0, input).await)
    }

    fn summarize(&self, out: &SubmitOutput) -> Option<String> {
        Some(submit_summary(out))
    }
}

pub struct CreateDraft(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CreateDraft {
    type Input = OrderInput;
    type Output = SubmitOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.create_draft", "Draft order", RiskTier::Financial)
            .description(
                "Drafts an order for the user's approval, whoever calls it: the draft appears on \
                 the chart, the ladder and the approval card, and is sent only when the user \
                 approves it (then the result is that of orders.submit). It goes stale after the \
                 approval's age or tick limit. The contract is named by the account's own \
                 connection, as for orders.submit; a contract it does not list fails here, before \
                 any draft. On an account \
                 leading a copy group that is on, the approved order is copied to the accounts \
                 its approval names (`and N accounts by copy`).",
            )
            .draft_only()
    }

    async fn call(&self, ctx: &ToolCtx, input: OrderInput) -> Result<SubmitOutput, ToolError> {
        self.0
            .submit_copying(
                ctx,
                "orders.create_draft",
                &input,
                None,
                ctx.draft_id.clone(),
            )
            .await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &OrderInput) -> Result<Value, ToolError> {
        let mut v = serde_json::to_value(self.0.preview(input).await?)?;
        self.0
            .preview_copies("orders.create_draft", input, &input.account_id, &mut v)
            .await;
        Ok(v)
    }

    async fn ready(&self, _ctx: &ToolCtx, input: &OrderInput) -> Result<(), ToolError> {
        self.0.ready(input).await
    }

    async fn target(&self, input: &OrderInput) -> Option<ActionTarget> {
        Some(resolved_target(&self.0, input).await)
    }

    fn summarize(&self, out: &SubmitOutput) -> Option<String> {
        Some(submit_summary(out))
    }
}

pub struct ModifyOrder(pub Arc<OrdersService>);

fn modify_is_exit(svc: &OrdersService, input: &ModifyOrderInput) -> bool {
    let Some(o) = svc.order(&input.order_id) else {
        return false;
    };
    if o.request.reduce_only {
        let stop_ok = match (o.request.stop_price, input.stop_price) {
            (Some(old), Some(new)) => match o.request.side {
                Side::Sell => new >= old,
                Side::Buy => new <= old,
            },
            _ => true,
        };
        stop_ok && input.qty.is_none_or(|q| q <= o.request.qty)
    } else {
        input.limit_price.is_none()
            && input.stop_price.is_none()
            && input.qty.is_some_and(|q| q < o.request.qty)
    }
}

#[async_trait]
impl Tool for ModifyOrder {
    type Input = ModifyOrderInput;
    type Output = OrderOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.modify", "Modify order", RiskTier::Financial).description(format!(
            "Moves or resizes a working order (its limit or stop price, or an entry's quantity; a \
             bracket follows its entry). Tightening a protective stop or moving a target is an \
             exit; moving a stop away, or making an entry larger, is weighed against the \
             trader's limits while one is on (risk.get_limits). {AGENT_NOTE} {COPY_ORDERS_NOTE}"
        ))
    }

    async fn call(&self, ctx: &ToolCtx, input: ModifyOrderInput) -> Result<OrderOutput, ToolError> {
        self.0.modify_copying(ctx, &input).await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &ModifyOrderInput) -> Result<Value, ToolError> {
        let o = self
            .0
            .order(&input.order_id)
            .ok_or_else(|| ToolError::not_found(format!("order {} not found", input.order_id)))?;
        let mut changes = Vec::new();
        if let Some(p) = input.stop_price {
            changes.push(format!("stop to {}", p.0.normalize()));
        }
        if let Some(p) = input.limit_price {
            changes.push(format!("limit to {}", p.0.normalize()));
        }
        if let Some(q) = input.qty {
            changes.push(format!("quantity to {}", qty_label(q)));
        }
        let sentence = format!("Move {}: {}", self.0.sentence(&o).await, changes.join(", "));
        let p = self
            .0
            .action_preview(sentence, &input.account_id, vec![o], Vec::new())
            .await;
        let mut v = serde_json::to_value(p)?;
        self.0
            .preview_copies("orders.modify", input, &input.account_id, &mut v)
            .await;
        Ok(v)
    }

    async fn target(&self, input: &ModifyOrderInput) -> Option<ActionTarget> {
        Some(ActionTarget {
            account: input.account_id.clone(),
            instrument: self.0.order(&input.order_id).map(|o| o.request.instrument),
            environment: self.0.gate_environment(&input.account_id),
            exit: modify_is_exit(&self.0, input),
        })
    }
}

pub struct CancelOrder(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CancelOrder {
    type Input = CancelOrderInput;
    type Output = OrderOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.cancel", "Cancel order", RiskTier::Financial).description(format!(
            "Cancels one working order (an entry that has not filled takes its bracket with it). \
             An exit: the user's own cancel is never covered. {AGENT_NOTE} {COPY_ORDERS_NOTE}"
        ))
    }

    async fn call(&self, ctx: &ToolCtx, input: CancelOrderInput) -> Result<OrderOutput, ToolError> {
        self.0.cancel_copying(ctx, &input).await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &CancelOrderInput) -> Result<Value, ToolError> {
        let o = self
            .0
            .order(&input.order_id)
            .ok_or_else(|| ToolError::not_found(format!("order {} not found", input.order_id)))?;
        let sentence = format!("Cancel {}", self.0.sentence(&o).await);
        let p = self
            .0
            .action_preview(sentence, &input.account_id, vec![o], Vec::new())
            .await;
        let mut v = serde_json::to_value(p)?;
        self.0
            .preview_copies("orders.cancel", input, &input.account_id, &mut v)
            .await;
        Ok(v)
    }

    async fn target(&self, input: &CancelOrderInput) -> Option<ActionTarget> {
        Some(ActionTarget {
            account: input.account_id.clone(),
            instrument: self.0.order(&input.order_id).map(|o| o.request.instrument),
            environment: self.0.gate_environment(&input.account_id),
            exit: true,
        })
    }

    fn summarize(&self, out: &OrderOutput) -> Option<String> {
        Some(format!(
            "cancelled {} {} {}",
            out.order.request.side.label().to_lowercase(),
            qty_label(out.order.request.qty),
            out.order.request.instrument.symbol()
        ))
    }
}

pub struct CancelAll(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CancelAll {
    type Input = CancelAllInput;
    type Output = CancelAllOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "orders.cancel_all",
            "Cancel all orders",
            RiskTier::Financial,
        )
        .description(format!(
            "Cancels every working order of an account, or of one instrument (an entry takes \
             its held bracket with it). keepProtection: true is the Trade panel's Cancel: each \
             open position's own stop and target stay working, everything else goes. An exit: \
             the user's own cancel is never covered. {AGENT_NOTE} {COPY_ORDERS_NOTE}"
        ))
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CancelAllInput,
    ) -> Result<CancelAllOutput, ToolError> {
        self.0.cancel_all_copying(ctx, &input).await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &CancelAllInput) -> Result<Value, ToolError> {
        let (mut orders, positions) = self.0.scope_preview(&input.scope()).await?;
        let keep = input.keep_protection == Some(true);
        let kept = if keep {
            let before = orders.len();
            orders.retain(|o| !super::protects(o, &positions));
            before - orders.len()
        } else {
            0
        };
        let name = self.0.account_name(&input.account_id).await;
        let what = match &input.instrument {
            Some(i) => format!("{} ", i.to_ascii_uppercase()),
            None => String::new(),
        };
        let sentence = format!(
            "Cancel {} {what}order{} on {name}{}",
            orders.len(),
            if orders.len() == 1 { "" } else { "s" },
            match kept {
                0 => String::new(),
                1 => ", keeping the position's stop or target".to_owned(),
                n => format!(", keeping the position's {n} stops and targets"),
            }
        );
        let p = self
            .0
            .action_preview(sentence, &input.account_id, orders, Vec::new())
            .await;
        let mut v = serde_json::to_value(p)?;
        self.0
            .preview_copies("orders.cancel_all", input, &input.account_id, &mut v)
            .await;
        Ok(v)
    }

    async fn target(&self, input: &CancelAllInput) -> Option<ActionTarget> {
        if let Some(i) = &input.instrument {
            let _ =
                tokio::time::timeout(RESOLVE_WAIT, self.0.resolve_for(&input.account_id, i)).await;
        }
        Some(scope_target(&self.0, &input.scope()))
    }

    fn summarize(&self, out: &CancelAllOutput) -> Option<String> {
        Some(format!("cancelled {}", out.cancelled.len()))
    }
}

pub struct Flatten(pub Arc<OrdersService>);

#[async_trait]
impl Tool for Flatten {
    type Input = AccountScopeInput;
    type Output = FlattenOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.flatten", "Flatten", RiskTier::Financial).description(format!(
            "Flattens an account, or one instrument: cancels its working orders, then closes every \
             position at market with a reduce-only order. An exit: the user's own flatten is never \
             covered. Refused with `rejected` (details: what was cancelled and closed) when a \
             position could not be closed, e.g. the market is closed; such a position keeps its \
             stops and targets. {AGENT_NOTE} {COPY_ORDERS_NOTE}"
        ))
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AccountScopeInput,
    ) -> Result<FlattenOutput, ToolError> {
        self.0.flatten_copying(ctx, &input).await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &AccountScopeInput) -> Result<Value, ToolError> {
        let (orders, positions) = self.0.scope_preview(input).await?;
        let name = self.0.account_name(&input.account_id).await;
        let what = input
            .instrument
            .as_deref()
            .map_or_else(|| "everything".to_owned(), str::to_ascii_uppercase);
        let mut parts = Vec::new();
        if !orders.is_empty() {
            parts.push(format!(
                "cancel {} order{}",
                orders.len(),
                if orders.len() == 1 { "" } else { "s" }
            ));
        }
        for p in &positions {
            let Some(close) = p.side().map(Side::opposite) else {
                continue;
            };
            parts.push(format!(
                "{} {} {} at market",
                close.label().to_ascii_lowercase(),
                qty_label(p.qty.abs()),
                p.instrument.symbol()
            ));
        }
        if parts.is_empty() {
            parts.push("nothing open".into());
        }
        let sentence = format!("Flatten {what} on {name}: {}", parts.join(", "));
        let p = self
            .0
            .action_preview(sentence, &input.account_id, orders, positions)
            .await;
        let mut v = serde_json::to_value(p)?;
        self.0
            .preview_copies("orders.flatten", input, &input.account_id, &mut v)
            .await;
        Ok(v)
    }

    async fn target(&self, input: &AccountScopeInput) -> Option<ActionTarget> {
        if let Some(i) = &input.instrument {
            let _ =
                tokio::time::timeout(RESOLVE_WAIT, self.0.resolve_for(&input.account_id, i)).await;
        }
        Some(scope_target(&self.0, input))
    }

    fn summarize(&self, out: &FlattenOutput) -> Option<String> {
        Some(format!(
            "flat · cancelled {} · closed {}",
            out.cancelled.len(),
            out.closing.len()
        ))
    }
}

pub struct MergeBrackets(pub Arc<OrdersService>);

#[async_trait]
impl Tool for MergeBrackets {
    type Input = AccountScopeInput;
    type Output = MergeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "orders.merge_brackets",
            "Merge into one bracket",
            RiskTier::Financial,
        )
        .description(format!(
            "Merges a position's stop and target pairs (one per entry, as they were before the \
             trader's setting was to grow the position's bracket) into one bracket: the tightest \
             stop and the nearest target, for the whole position. The others are cancelled first, \
             then the one kept is moved and grown. Give the account and the instrument. An exit: \
             it never adds risk; never copied (each account keeps its own bracket). {AGENT_NOTE}"
        ))
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AccountScopeInput,
    ) -> Result<MergeOutput, ToolError> {
        self.0.merge_brackets(&input).await
    }

    async fn target(&self, input: &AccountScopeInput) -> Option<ActionTarget> {
        Some(scope_target(&self.0, input))
    }

    fn summarize(&self, out: &MergeOutput) -> Option<String> {
        Some(out.summary.clone())
    }
}

pub struct BreakevenStop(pub Arc<OrdersService>);

#[async_trait]
impl Tool for BreakevenStop {
    type Input = BreakevenStopInput;
    type Output = BreakevenStopOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.breakeven", "Breakeven", RiskTier::Financial).description(format!(
            "Moves a position's stop to breakeven now (the Trade panel's Breakeven, the chart's \
             and the DOM's): its average entry plus offsetTicks toward profit (left out: the \
             offset of the breakeven rule its stops carry, else 0), rounded to the tick toward \
             profit. With one bracket per position that is its one stop; with each entry its own \
             bracket, every pair's stop goes to the position's average entry. Only stops behind \
             that price move; one already at or past it stays. A position with no stop gets one \
             there: a reduce-only stop for the whole position (`placed`). Refused with \
             `rejected`, nothing moved or sent, when there is no position, every stop is already \
             there, or the market has not passed that price yet (a stop there would trigger at \
             once). Give the account and the instrument. An exit: it only tightens, and the \
             trader's limits never refuse it. {AGENT_NOTE} {COPY_ORDERS_NOTE}"
        ))
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: BreakevenStopInput,
    ) -> Result<BreakevenStopOutput, ToolError> {
        self.0.breakeven_copying(ctx, &input).await
    }

    async fn preview(
        &self,
        _ctx: &ToolCtx,
        input: &BreakevenStopInput,
    ) -> Result<Value, ToolError> {
        let (done, out) = self.0.breakeven(input, false).await?;
        let name = self.0.account_name(&input.account_id).await;
        let symbol = done.position.instrument.symbol();
        let at = out
            .summary
            .split_once(", ")
            .map_or(out.summary.as_str(), |(_, at)| at);
        let sentence = match (done.plan.new_stop, done.plan.moves.len()) {
            (Some(_), _) => format!(
                "Place a stop for the {} {symbol} on {name} at breakeven: {at}",
                position_words(done.position.qty.0)
            ),
            (None, 1) => format!("Move the {symbol} stop on {name} to breakeven: {at}"),
            (None, n) => format!("Move the {n} {symbol} stops on {name} to breakeven: {at}"),
        };
        let p = self
            .0
            .action_preview(sentence, &input.account_id, done.stops, vec![done.position])
            .await;
        let mut v = serde_json::to_value(p)?;
        self.0
            .preview_copies("orders.breakeven", input, &input.account_id, &mut v)
            .await;
        Ok(v)
    }

    async fn target(&self, input: &BreakevenStopInput) -> Option<ActionTarget> {
        let _ = tokio::time::timeout(
            RESOLVE_WAIT,
            self.0.resolve_for(&input.account_id, &input.instrument),
        )
        .await;
        Some(ActionTarget {
            account: input.account_id.clone(),
            instrument: self.0.instrument_hint(&input.account_id, &input.instrument),
            environment: self.0.gate_environment(&input.account_id),
            exit: true,
        })
    }

    fn summarize(&self, out: &BreakevenStopOutput) -> Option<String> {
        Some(out.summary.clone())
    }
}

pub struct Reverse(pub Arc<OrdersService>);

#[async_trait]
impl Tool for Reverse {
    type Input = ReverseInput;
    type Output = ReverseOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("orders.reverse", "Reverse", RiskTier::Financial).description(format!(
            "Reverses a position at market: long 2 becomes short 2 (the Trade panel's Reverse, the \
             chart's and the DOM's). Two orders, never one for twice the size: everything working \
             on the contract is cancelled first (the old side's stop and target, entries, the rest \
             of a part-filled exit), the position is closed with a reduce-only market order, and \
             once it is flat the new side goes at market for the size closed, with `bracket` (the \
             new side's stop and target as prices, as orders.submit takes them: a short's stop \
             above the market; the Trade panel sends its own; left out, none), which the \
             position's bracket then follows. The close is an exit; the new side is an entry like \
             any: the pre-trade checks and the trader's limits weigh it from flat before anything \
             is sent, and a block refuses the whole reverse (`rejected`, nothing sent, the \
             position stays). Refused, nothing sent, without a position. Should the new side be \
             refused after the close, the position is left flat and the error says so (details: \
             flat, closing). Give the account and the instrument. {AGENT_NOTE} \
             {COPY_ORDERS_NOTE} A follower's own position on the contract is flattened, whatever \
             it is, then it opens the leader's new side at its own size."
        ))
    }

    async fn call(&self, ctx: &ToolCtx, input: ReverseInput) -> Result<ReverseOutput, ToolError> {
        self.0.reverse_copying(ctx, &input).await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &ReverseInput) -> Result<Value, ToolError> {
        let plan = self.0.reverse_plan(input).await?;
        let name = self.0.account_name(&input.account_id).await;
        let symbol = plan.position.instrument.symbol().to_owned();
        let side = plan.entry.side.label().to_lowercase();
        let qty = qty_label(plan.entry.qty);
        let mut parts = Vec::new();
        if !plan.orders.is_empty() {
            parts.push(format!(
                "cancel {} order{}",
                plan.orders.len(),
                if plan.orders.len() == 1 { "" } else { "s" }
            ));
        }
        parts.push(format!("{side} {qty} at market to close"));
        let legs = plan
            .entry
            .bracket
            .map(|b| legs_words(&b, |p| price_label(&plan.spec, p)));
        parts.push(match legs.filter(|l| !l.is_empty()) {
            Some(l) => format!("then {side} {qty} at market with {l}"),
            None => format!("then {side} {qty} at market, no stop"),
        });
        let sentence = format!(
            "Reverse the {} {symbol} on {name}: {}",
            position_words(plan.position.qty.0),
            parts.join(", ")
        );
        let p = self
            .0
            .action_preview(
                sentence,
                &input.account_id,
                plan.orders,
                vec![plan.position],
            )
            .await;
        let mut v = serde_json::to_value(p)?;
        self.0
            .preview_copies("orders.reverse", input, &input.account_id, &mut v)
            .await;
        Ok(v)
    }

    async fn target(&self, input: &ReverseInput) -> Option<ActionTarget> {
        let _ = tokio::time::timeout(
            RESOLVE_WAIT,
            self.0.resolve_for(&input.account_id, &input.instrument),
        )
        .await;
        Some(ActionTarget {
            account: input.account_id.clone(),
            instrument: self.0.instrument_hint(&input.account_id, &input.instrument),
            environment: self.0.gate_environment(&input.account_id),
            exit: false,
        })
    }

    fn summarize(&self, out: &ReverseOutput) -> Option<String> {
        Some(out.summary.clone())
    }
}

pub struct GetAccounts(pub Arc<OrdersService>);

#[async_trait]
impl Tool for GetAccounts {
    type Input = GetAccountsInput;
    type Output = AccountsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("portfolio.get_accounts", "Accounts", RiskTier::Read).description(
            "Every trading account: name, environment (paper, eval…), balance, net liquidation \
             value, today's P&L, open P&L, the rules a prop firm's platform reports for it (`risk`: \
             daily loss left, trailing room, lock; informational unless the user holds the account \
             to them) and, while one of the trader's own limits is on, where it stands against \
             them (`limits`: daily loss left, trades today, the lock).",
        )
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: GetAccountsInput,
    ) -> Result<AccountsOutput, ToolError> {
        Ok(AccountsOutput {
            accounts: self.0.accounts().await?,
        })
    }
}

pub struct GetPositions(pub Arc<OrdersService>);

#[async_trait]
impl Tool for GetPositions {
    type Input = AccountFilterInput;
    type Output = PositionsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("portfolio.get_positions", "Positions", RiskTier::Read)
            .description("Open positions with average price, mark, open and realized P&L.")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AccountFilterInput,
    ) -> Result<PositionsOutput, ToolError> {
        let mut positions = Vec::new();
        for a in self.0.account_ids(input.account_id.as_deref()).await? {
            positions.extend(
                self.0
                    .broker()
                    .provider()
                    .positions(&a)
                    .await
                    .map_err(super::broker_error)?,
            );
        }
        Ok(PositionsOutput { positions })
    }
}

pub struct GetOrders(pub Arc<OrdersService>);

#[async_trait]
impl Tool for GetOrders {
    type Input = GetOrdersInput;
    type Output = OrdersOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("portfolio.get_orders", "Orders", RiskTier::Read).description(
            "Working and held orders, and today's finished ones (filled, cancelled, rejected with \
             their reasons, expired), oldest first.",
        )
    }

    async fn call(&self, _ctx: &ToolCtx, input: GetOrdersInput) -> Result<OrdersOutput, ToolError> {
        let open_only = input.open_only.unwrap_or(false);
        let mut orders = Vec::new();
        for a in self.0.account_ids(input.account_id.as_deref()).await? {
            orders.extend(
                self.0
                    .broker()
                    .provider()
                    .orders(&a)
                    .await
                    .map_err(super::broker_error)?
                    .into_iter()
                    .filter(|o| !open_only || o.status.is_open()),
            );
        }
        orders.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Ok(OrdersOutput { orders })
    }
}

pub struct GetFills(pub Arc<OrdersService>);

#[async_trait]
impl Tool for GetFills {
    type Input = GetFillsInput;
    type Output = FillsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("portfolio.get_fills", "Fills", RiskTier::Read).description(
            "Executions since a time (default: the start of the trading day), oldest first, with \
             fees and the realized P&L of closing fills.",
        )
    }

    async fn call(&self, _ctx: &ToolCtx, input: GetFillsInput) -> Result<FillsOutput, ToolError> {
        let since = input.since.unwrap_or_else(|| self.0.day_start());
        let mut fills = Vec::new();
        for a in self.0.account_ids(input.account_id.as_deref()).await? {
            fills.extend(
                self.0
                    .broker()
                    .provider()
                    .fills(&a, since)
                    .await
                    .map_err(super::broker_error)?,
            );
        }
        fills.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.id.cmp(&b.id)));
        Ok(FillsOutput { fills })
    }

    fn summarize(&self, out: &FillsOutput) -> Option<String> {
        Some(format!("{} fills", out.fills.len()))
    }
}

pub struct GetRiskStatus(pub Arc<OrdersService>);

#[async_trait]
impl Tool for GetRiskStatus {
    type Input = RiskStatusInput;
    type Output = RiskStatusOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("portfolio.get_risk_status", "Risk status", RiskTier::Read).description(
            "Where an account stands: `risk`, the rules its prop firm's platform reports (daily \
             loss limit and what is left today, the firm's drawdown threshold and the room above it, a lock, \
             its own contract limits; null without them; informational unless the user turned on Use my firm's limits), and \
             `limits`, the trader's own limits in force on it and what they leave (null while none \
             is on: nothing is refused for risk).",
        )
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: RiskStatusInput,
    ) -> Result<RiskStatusOutput, ToolError> {
        let ids = self.0.account_ids(Some(&input.account_id)).await?;
        let risk = self
            .0
            .broker()
            .provider()
            .risk(&ids[0])
            .await
            .map_err(super::broker_error)?;
        let limits = self
            .0
            .accounts()
            .await?
            .into_iter()
            .find(|u| u.account.id == ids[0])
            .and_then(|u| u.limits);
        Ok(RiskStatusOutput { risk, limits })
    }
}

pub struct GetLimits(pub Arc<OrdersService>);

#[async_trait]
impl Tool for GetLimits {
    type Input = GetLimitsInput;
    type Output = LimitsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("risk.get_limits", "Risk limits", RiskTier::Read)
            .description(
                "The trader's own risk limits (Settings › Trading and risk) and where each account stands \
                 against them: the daily loss limit and what is left today, the max risk per \
                 trade (at the stop), max contracts an order and held, max trades a day with \
                 today's count, whether a prop firm's own rules count too, and the lock holding \
                 (a reached limit's or the trader's own, risk.get_lock). Each limit is off until the user sets it; with none on, nothing \
                 is refused for risk. Every order is checked against them before it is sent, on \
                 every connection. Only the user changes them (the user-only setting risk.limits): \
                 an agent or MCP client is refused, and may suggest a change for the user to make.",
            )
            .activity("Read the risk limits")
    }

    async fn call(&self, _ctx: &ToolCtx, input: GetLimitsInput) -> Result<LimitsOutput, ToolError> {
        let ids = self.0.account_ids(input.account_id.as_deref()).await?;
        let setting = self.0.limits();
        let accounts = self
            .0
            .accounts()
            .await?
            .into_iter()
            .filter(|u| ids.contains(&u.account.id))
            .map(|u| AccountLimits {
                own: setting.accounts.contains_key(u.account.id.as_str()),
                account_id: u.account.id,
                display_name: u.account.display_name,
                status: u.limits,
                firm: u.risk,
            })
            .collect();
        Ok(LimitsOutput { setting, accounts })
    }

    fn summarize(&self, o: &LimitsOutput) -> Option<String> {
        let on = o.accounts.iter().filter(|a| a.status.is_some()).count();
        Some(if on == 0 {
            "No limits on".into()
        } else {
            format!("Limits on {on} of {} accounts", o.accounts.len())
        })
    }
}

pub struct GetLock(pub Arc<OrdersService>);

#[async_trait]
impl Tool for GetLock {
    type Input = GetLockInput;
    type Output = AccountLockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("risk.get_lock", "Trading lock", RiskTier::Read)
            .description(
                "Whether an account is locked to new entries, and how it could be locked now. A \
                 lock refuses every order that opens or adds, from the app, an agent or the copier, \
                 on every connection; exits, stops and targets always work. `lock` is the lock \
                 holding now (a reached daily loss limit's, or one the trader set) with its end and \
                 its words to relay; `options` are the spans risk.lock_account takes, each with \
                 when it would end if set now, in the exchange's own clock (CME: New York; pass \
                 the chart's contract as instrument). `copy` says what a lock does to the account's \
                 copy group.",
            )
            .activity("Read the trading lock")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: GetLockInput,
    ) -> Result<AccountLockOutput, ToolError> {
        self.0.lock_info(&input).await
    }

    fn summarize(&self, o: &AccountLockOutput) -> Option<String> {
        Some(match &o.lock {
            Some(l) => l.words.clone(),
            None => format!("{} is not locked", o.display_name),
        })
    }
}

pub struct LockAccount(pub Arc<OrdersService>);

#[async_trait]
impl Tool for LockAccount {
    type Input = LockAccountInput;
    type Output = LockAccountOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("risk.lock_account", "Lock trading", RiskTier::Modify)
            .description(
                "Locks an account to new entries for a span (risk.get_lock lists them: 5 min to 4 \
                 hours, until market close, until tomorrow's open, the rest of the trading day, or \
                 a New York, London or Tokyo session), to stop revenge trading. Use it only when \
                 the trader asks. Every order that opens or adds is refused until then, with the \
                 lock's words; exits, stops and targets work, positions stay. Working entry orders \
                 are cancelled (with their copies). On a copy group's leader the group copies no \
                 entries; on a follower the leader's entries skip it. The lock survives a restart \
                 and is never shortened: a span ending sooner than the lock holding changes \
                 nothing. Only the trader can lift it early, in the app, when they allowed that; \
                 an agent never can.",
            )
            .activity("Locked trading")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: LockAccountInput,
    ) -> Result<LockAccountOutput, ToolError> {
        self.0.lock_account(ctx, &input).await
    }

    fn summarize(&self, o: &LockAccountOutput) -> Option<String> {
        Some(o.summary.clone())
    }
}

pub struct UnlockAccount(pub Arc<OrdersService>);

#[async_trait]
impl Tool for UnlockAccount {
    type Input = UnlockAccountInput;
    type Output = UnlockAccountOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "risk.unlock_account",
            "Lift a trading lock",
            RiskTier::Modify,
        )
        .description(
            "Lifts the trader's own lock before its time, when they allowed early unlock \
                 (Settings › Trading and risk) and typed UNLOCK. A reached daily loss limit's lock \
                 never lifts early.",
        )
        .user_only()
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: UnlockAccountInput,
    ) -> Result<UnlockAccountOutput, ToolError> {
        self.0.unlock_account(&ctx.origin, &input).await
    }

    fn summarize(&self, _o: &UnlockAccountOutput) -> Option<String> {
        Some("Lifted the trading lock".into())
    }
}
