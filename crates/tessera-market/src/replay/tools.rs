use std::sync::Arc;

use async_trait::async_trait;
use tessera_core::InstrumentId;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{Tool, ToolCtx, ToolError, ToolMeta};

use super::{MAX_SPEED, Replays};
use crate::io::{
    CloseReplayInput, CloseReplayOutput, ControlReplayInput, GetReplaysInput, ListReplayDaysInput,
    ListReplayDaysOutput, OpenReplayInput, ReplayState, ReplaysOutput, SavedContractDays,
};
use crate::module::market_error;
use crate::router::MarketRouter;
use crate::saved::Contract;

fn replays(router: &MarketRouter) -> Result<Arc<Replays>, ToolError> {
    router
        .replays()
        .ok_or_else(|| ToolError::unavailable("this runtime keeps no saved trades"))
}

fn replay_id(input: &str) -> Result<InstrumentId, ToolError> {
    InstrumentId::new(input).map_err(|e| ToolError::invalid_input(e.to_string()))
}

fn speed(asked: Option<u32>) -> Result<Option<u32>, ToolError> {
    match asked {
        Some(s) if !(1..=MAX_SPEED).contains(&s) => Err(ToolError::invalid_input(format!(
            "speed must be 1..={MAX_SPEED}"
        ))),
        s => Ok(s),
    }
}

fn names(contract: &SavedContractDays, asked: &str) -> bool {
    let asked = asked.trim().to_ascii_uppercase();
    contract.instrument.as_str() == asked || contract.instrument.symbol() == asked
}

async fn saved_days(r: &Arc<Replays>) -> Result<Vec<SavedContractDays>, ToolError> {
    let r = Arc::clone(r);
    tokio::task::spawn_blocking(move || r.saved_days())
        .await
        .map_err(|e| ToolError::internal(e.to_string()))?
        .map_err(|e| ToolError::unavailable(format!("saved trades unreadable: {e}")))
}

fn summary(s: &ReplayState) -> String {
    let clock = if s.playing { "playing" } else { "paused" };
    format!(
        "{} · {} of {} · {clock} at {}×",
        s.instrument, s.contract, s.trade_date, s.speed
    )
}

pub struct ListReplayDays(pub Arc<MarketRouter>);

#[async_trait]
impl Tool for ListReplayDays {
    type Input = ListReplayDaysInput;
    type Output = ListReplayDaysOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.list_replay_days", "List replay days", RiskTier::Read)
            .description("The trade dates whose prints are saved on this machine, per contract and the connection that served them, each with its first and last saved print time and how many prints. Any of them plays back with market.open_replay.")
            .activity("Listed saved days")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ListReplayDaysInput,
    ) -> Result<ListReplayDaysOutput, ToolError> {
        let mut contracts = saved_days(&replays(&self.0)?).await?;
        contracts.retain(|c| !c.days.is_empty());
        if let Some(asked) = &input.instrument {
            contracts.retain(|c| names(c, asked));
        }
        Ok(ListReplayDaysOutput { contracts })
    }

    fn summarize(&self, out: &ListReplayDaysOutput) -> Option<String> {
        let days: usize = out.contracts.iter().map(|c| c.days.len()).sum();
        Some(format!(
            "{days} saved days of {} contracts",
            out.contracts.len()
        ))
    }
}

pub struct OpenReplay(pub Arc<MarketRouter>);

#[async_trait]
impl Tool for OpenReplay {
    type Input = OpenReplayInput;
    type Output = ReplayState;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.open_replay", "Open replay", RiskTier::Modify)
            .description("Play a saved day back from disk, with no request to any connection: returns a replay instrument (NQZ6-R1.CME) whose prints arrive as its clock passes them, so charts, footprints, time and sales and big trades read it like a live market. Before the day's first saved print they read what this machine stores, as on the live chart: its bars and the prints of earlier saved days; nothing past the clock. `earlier` says how far the stored bars reach. It takes no orders. Control it with market.control_replay; close it with market.close_replay.")
            .activity("Opened replay")
    }

    async fn call(&self, _ctx: &ToolCtx, input: OpenReplayInput) -> Result<ReplayState, ToolError> {
        let speed = speed(input.speed)?.unwrap_or(1);
        let r = replays(&self.0)?;
        let saved = saved_days(&r).await?;
        let contract = saved
            .iter()
            .filter(|c| names(c, &input.instrument))
            .filter(|c| input.source.as_deref().is_none_or(|s| s == c.source))
            .filter_map(|c| {
                let day = c.days.iter().find(|d| d.trade_date == input.trade_date)?;
                Some((Contract::new(&c.source, &c.instrument), day.prints))
            })
            .max_by_key(|(_, prints)| *prints)
            .map(|(c, _)| c)
            .ok_or_else(|| {
                ToolError::not_found(format!(
                    "no saved trades of {} on {}; market.list_replay_days lists the saved days",
                    input.instrument, input.trade_date
                ))
            })?;
        r.open(
            &self.0,
            contract,
            input.trade_date,
            input.at,
            speed,
            input.playing.unwrap_or(true),
        )
        .await
        .map_err(market_error)
    }

    fn summarize(&self, out: &ReplayState) -> Option<String> {
        Some(summary(out))
    }
}

pub struct ControlReplay(pub Arc<MarketRouter>);

#[async_trait]
impl Tool for ControlReplay {
    type Input = ControlReplayInput;
    type Output = ReplayState;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.control_replay", "Control replay", RiskTier::Modify)
            .description("Play or pause a replay, change its speed (seconds of the day per second, 1 to 600), or jump its clock to a time of the saved day. A jump continues under a new replay instrument id, which the output names.")
            .activity("Controlled replay")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ControlReplayInput,
    ) -> Result<ReplayState, ToolError> {
        let speed = speed(input.speed)?;
        let r = replays(&self.0)?;
        let mut id = replay_id(&input.instrument)?;
        if let Some(at) = input.at {
            id = r.jump(&id, at).map_err(market_error)?.instrument;
        }
        r.control(&id, input.playing, speed).map_err(market_error)
    }

    fn summarize(&self, out: &ReplayState) -> Option<String> {
        Some(summary(out))
    }
}

pub struct GetReplays(pub Arc<MarketRouter>);

#[async_trait]
impl Tool for GetReplays {
    type Input = GetReplaysInput;
    type Output = ReplaysOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_replays", "Get replays", RiskTier::Read)
            .description("The open replays: each one's instrument, saved contract and day, its clock (cursor), whether it plays and at what speed.")
            .activity("Loaded replays")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: GetReplaysInput,
    ) -> Result<ReplaysOutput, ToolError> {
        let r = replays(&self.0)?;
        let replays = match &input.instrument {
            Some(i) => vec![r.state(&replay_id(i)?).map_err(market_error)?],
            None => r.states(),
        };
        Ok(ReplaysOutput { replays })
    }

    fn summarize(&self, out: &ReplaysOutput) -> Option<String> {
        Some(format!("{} open replays", out.replays.len()))
    }
}

pub struct CloseReplay(pub Arc<MarketRouter>);

#[async_trait]
impl Tool for CloseReplay {
    type Input = CloseReplayInput;
    type Output = CloseReplayOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.close_replay", "Close replay", RiskTier::Modify)
            .description("Close a replay: its instrument stops serving and its saved day may be pruned again.")
            .activity("Closed replay")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: CloseReplayInput,
    ) -> Result<CloseReplayOutput, ToolError> {
        let r = replays(&self.0)?;
        Ok(CloseReplayOutput {
            closed: r.close(&replay_id(&input.instrument)?),
        })
    }
}
