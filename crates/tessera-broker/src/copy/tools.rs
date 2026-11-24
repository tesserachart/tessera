use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{ActionTarget, Tool, ToolCtx, ToolError, ToolMeta};

use super::io::{
    CopyActionOutput, CopyCreateInput, CopyDeleteOutput, CopyFlattenInput, CopyGroupIdInput,
    CopyGroupOutput, CopyListInput, CopyListOutput, CopyResyncInput, CopyStatusInput,
    CopyUpdateInput,
};
use super::sync::{CopySyncUpdate, SyncState};
use crate::orders::OrdersService;

const COPY_NOTE: &str = "A copy group mirrors one leader account's orders on its followers, each at \
its own size: a follower holds the leader's position times its multiplier, rounded to the nearest \
whole contract with halves up, or its fixed size whenever the leader holds any. Each of the \
leader's orders moves a follower by what it means at that size: an entry or an add opens what the \
size grows by, never past the follower's size (nothing when it rounds to the same or the follower \
holds its size already, said), a partial exit closes what it shrinks by, the leader's last exit there closes everything the follower holds there, and a reverse closes \
it and opens its size on the other side; so rounding never drifts. A follower with micro trades \
the micro of each full-size contract the leader trades (NQ to MNQ, ES to MES, YM to MYM, RTY to \
M2K, CL to MCL, GC to MGC) at the same prices; a paused follower gets nothing until it is resumed \
and keeps what it holds. Modifies, cancels, cancel all, flatten, reverse and breakeven are copied \
too. Each follower's order goes through its own risk limits and its own send permit: one refused \
is skipped and the others go on; exits are never refused by limits. A follower's stop and target \
keep the leader's distances from its own fill. Copies never trigger copying. If the leader's \
position cannot be read, its order goes alone and nothing is copied (each follower `unknown`). \
copy.status says whether each follower holds its size; copy.resync puts it there.";

fn sizing_schema_note() -> &'static str {
    "followers: [{accountId, multiplier (0.01 to 10, default 1) or fixedQty (1 to 100 whole \
     contracts), micro (default false), paused (default false)}]."
}

pub struct CopyList(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyList {
    type Input = CopyListInput;
    type Output = CopyListOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.list", "Copy groups", RiskTier::Read)
            .description(format!(
                "The Trade copier's copy groups: each with its leader, its followers \
                 and their sizing, whether each trades micros or is paused, whether the group is \
                 on, and per follower why it cannot take orders now (order entry off, read-only; \
                 its copies are skipped until it can). Give accountId for the groups an account \
                 leads or follows. An order on a leader account while its group is on is copied: \
                 an approval of yours there says `and N accounts by copy`. {COPY_NOTE}"
            ))
            .activity("Read the copy groups")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: CopyListInput,
    ) -> Result<CopyListOutput, ToolError> {
        self.0.copy_list(&input).await
    }

    fn summarize(&self, out: &CopyListOutput) -> Option<String> {
        let on = out.groups.iter().filter(|g| g.enabled).count();
        Some(format!("{} copy groups, {on} on", out.groups.len()))
    }
}

pub struct CopyCreate(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyCreate {
    type Input = CopyCreateInput;
    type Output = CopyGroupOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.create", "Create a copy group", RiskTier::Modify)
            .description(format!(
                "Creates a copy group: a leader and its followers ({}), off unless enabled. A \
                 follower is an account other than the leader whose order entry is on and that \
                 is not read-only. The user's alone: it multiplies what every order on the \
                 leader risks. {COPY_NOTE}",
                sizing_schema_note()
            ))
            .user_only()
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CopyCreateInput,
    ) -> Result<CopyGroupOutput, ToolError> {
        self.0.copy_create(ctx, &input).await
    }

    fn summarize(&self, out: &CopyGroupOutput) -> Option<String> {
        Some(format!("Created {}", out.group.name))
    }
}

pub struct CopyUpdate(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyUpdate {
    type Input = CopyUpdateInput;
    type Output = CopyGroupOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.update", "Change a copy group", RiskTier::Modify)
            .description(format!(
                "Changes a copy group's name, leader or followers (replaced whole: {}; pausing or \
                 resuming a follower is a change of its paused). A group that is on stays on and \
                 copies the new way at once. A follower that stops copying (paused, removed, or \
                 the leader changed) has its working copies of the leader's entries cancelled, \
                 each said (`said`); what it holds and its stops and targets stay. The user's \
                 alone.",
                sizing_schema_note()
            ))
            .user_only()
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CopyUpdateInput,
    ) -> Result<CopyGroupOutput, ToolError> {
        self.0.copy_update(ctx, &input).await
    }

    fn summarize(&self, out: &CopyGroupOutput) -> Option<String> {
        Some(format!("Changed {}", out.group.name))
    }
}

pub struct CopyEnable(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyEnable {
    type Input = CopyGroupIdInput;
    type Output = CopyGroupOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.enable", "Turn a copy group on", RiskTier::Modify)
            .description(
                "Turns a copy group on at once: from the leader's next order, it is copied. One \
                 group is on per leader (the leader's other goes off, said); an account follows \
                 one leader at a time; copies never go round (a follower cannot lead a group that \
                 copies back to its leader). A follower or the leader already in a position is \
                 said (`said`), never evened out (copy.status shows such a follower out of sync; \
                 copy.resync, the user's, evens it). The user's alone.",
            )
            .user_only()
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CopyGroupIdInput,
    ) -> Result<CopyGroupOutput, ToolError> {
        self.0.copy_enable(ctx, &input.group_id).await
    }

    fn summarize(&self, out: &CopyGroupOutput) -> Option<String> {
        Some(format!("{} on", out.group.name))
    }
}

pub struct CopyDisable(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyDisable {
    type Input = CopyGroupIdInput;
    type Output = CopyGroupOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.disable", "Turn a copy group off", RiskTier::Modify).description(
            "Turns a copy group off at once: the leader's orders from now on are its own. \
                 Each follower's working copies of the leader's entries are cancelled, each said \
                 (`said`); its positions and their stops and targets stay as they are \
                 (copy.flatten flattens them). It only lowers risk, so the analyst may.",
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CopyGroupIdInput,
    ) -> Result<CopyGroupOutput, ToolError> {
        self.0.copy_disable(ctx, &input.group_id).await
    }

    fn summarize(&self, out: &CopyGroupOutput) -> Option<String> {
        Some(format!("{} off", out.group.name))
    }
}

pub struct CopyDelete(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyDelete {
    type Input = CopyGroupIdInput;
    type Output = CopyDeleteOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.delete", "Delete a copy group", RiskTier::Modify)
            .description(
                "Deletes a copy group (it stops copying at once). Each follower's working copies \
                 of the leader's entries are cancelled, each said (`said`); its positions and \
                 their stops and targets stay. The user's alone; copy.disable turns one off.",
            )
            .user_only()
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CopyGroupIdInput,
    ) -> Result<CopyDeleteOutput, ToolError> {
        self.0.copy_delete(ctx, &input.group_id).await
    }

    fn summarize(&self, out: &CopyDeleteOutput) -> Option<String> {
        Some(format!("Deleted {}", out.name))
    }
}

pub struct CopyStatus(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyStatus {
    type Input = CopyStatusInput;
    type Output = CopySyncUpdate;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.status", "Copy sync", RiskTier::Read)
            .description(
                "Whether each copy group's followers hold what they should at their size, on or \
                 off and paused or not (the same as the copy.sync topic): the leader's positions, \
                 and per follower every contract the leader or it holds (the follower's own \
                 contract for each of the leader's, its micro when it trades micros) with the \
                 leader's quantity, the follower's target and what it holds, all signed; its \
                 state (in_sync; settling while it differs for under 3 s, copies on their way; \
                 out_of_sync after that; unknown when its or the leader's positions cannot be \
                 read, never taken as in sync); why in words; since when it differs; and the last \
                 action of the leader's copied to it this run and how that went. Give groupId for \
                 one group.",
            )
            .activity("Read the copy sync")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: CopyStatusInput,
    ) -> Result<CopySyncUpdate, ToolError> {
        self.0.copy_status(&input).await
    }

    fn summarize(&self, out: &CopySyncUpdate) -> Option<String> {
        let followers = out.groups.iter().map(|g| g.followers.len()).sum::<usize>();
        let off = out
            .groups
            .iter()
            .flat_map(|g| &g.followers)
            .filter(|f| f.state != SyncState::InSync)
            .count();
        Some(format!("{followers} followers, {off} not in sync"))
    }
}

pub struct CopyResync(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyResync {
    type Input = CopyResyncInput;
    type Output = CopyActionOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.resync", "Resync copy followers", RiskTier::Financial)
            .description(
                "Puts a copy group's followers back at their size against the leader's positions \
                 now, from fresh reads taken while no order of the leader's is being copied: \
                 every follower that is out of sync (a paused one only on its own, with \
                 accountId; one whose positions cannot be read is listed, nothing sent), or the \
                 follower accountId names (the leader or an account outside the group is \
                 refused, and nothing is sent). A follower still settling (copies on their way) \
                 is left alone, even when named, and so is any contract the follower has an \
                 order on its way to (a market order not filled yet, or an order a copy or a \
                 resync sent seconds ago that copies no working order of the leader's). After an approval, only the followers its \
                 preview named are resynced. Per \
                 contract that differs it cancels the follower's working entries that copy no \
                 working order of the leader's, flattens the contract when it should be flat or \
                 is on the other side, then buys or sells at market what is missing, with a stop \
                 and a target at the leader's own working ones (the nearest the market), or \
                 closes what is over. Each order goes through the follower's own limits, order \
                 entry and send permit: one refused is skipped and the others go on; one whose \
                 positions cannot be read is unknown and gets nothing. Weighed as an order on the \
                 strictest account it can send to. The user's alone: it adds risk.",
            )
            .user_only()
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CopyResyncInput,
    ) -> Result<CopyActionOutput, ToolError> {
        self.0.copy_resync(ctx, &input).await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &CopyResyncInput) -> Result<Value, ToolError> {
        self.0.resync_preview(input).await
    }

    async fn target(&self, input: &CopyResyncInput) -> Option<ActionTarget> {
        self.0.resync_target(input)
    }

    fn summarize(&self, out: &CopyActionOutput) -> Option<String> {
        Some(format!(
            "Resync {}: {}",
            out.report.group_name,
            out.report.summary()
        ))
    }
}

pub struct CopyFlatten(pub Arc<OrdersService>);

#[async_trait]
impl Tool for CopyFlatten {
    type Input = CopyFlattenInput;
    type Output = CopyActionOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("copy.flatten", "Flatten a copy group", RiskTier::Financial).description(
            "Flattens a copy group's leader and every follower (paused ones too) at once, \
                 whole accounts, or the one account accountId names (the leader or a follower; \
                 any other is refused): each cancels its working orders and closes every \
                 position at market, as orders.flatten does, on its own permit. Nothing is \
                 mirrored: each account is flattened by itself, and after an approval only the \
                 accounts its preview named. The report has each account's \
                 result, the leader's first. An exit: the user's own is never covered; from an \
                 agent it asks the user first unless the session is in Full access.",
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: CopyFlattenInput,
    ) -> Result<CopyActionOutput, ToolError> {
        self.0.copy_flatten_group(ctx, &input).await
    }

    async fn preview(&self, _ctx: &ToolCtx, input: &CopyFlattenInput) -> Result<Value, ToolError> {
        self.0.group_flatten_preview(input).await
    }

    async fn target(&self, input: &CopyFlattenInput) -> Option<ActionTarget> {
        self.0.group_flatten_target(input)
    }

    fn summarize(&self, out: &CopyActionOutput) -> Option<String> {
        Some(format!(
            "Flatten {}: {}",
            out.report.group_name,
            out.report.summary()
        ))
    }
}
