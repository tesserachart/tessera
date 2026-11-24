use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::clock::Clock;
use tessera_core::initial_balance::InitialBalance;
use tessera_core::levels::Level;
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_host::{
    EventBus, KeyFilter, ModuleHost, Pumps, RuntimeModule, Subscribed, TopicHandler, TopicKey,
    TopicSizing, TsExports, parse_params,
};
use tessera_market::{
    BarsRequest, MarketDataProvider, MarketError, MarketRouter, Read, market_error, refusal,
};
use tessera_protocol::rpc::{RpcError, codes};
use tessera_protocol::tools::RiskTier;
use tessera_protocol::topics::{InstrumentParams, LevelsUpdate};
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use ts_rs::TS;

use crate::initial_balance::initial_balance_levels;
use crate::prior_day::prior_day_levels;
use crate::volume_profile::VolumeProfileLevels;

pub const CONCEPTS_LEVELS: &str = "concepts.levels";
pub const PROVIDER_ID: &str = "tessera-concepts";
pub const REFRESH: Duration = Duration::from_secs(60);
pub const PROFILE_REFRESH: Duration = Duration::from_secs(5);
const SNAPSHOT_WAIT: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetConceptLevelsInput {
    /// Instrument id or symbol (`QQQ`, `NQ`).
    pub instrument: String,
}

pub type InitialBalanceMinutes = Arc<dyn Fn() -> u32 + Send + Sync>;

pub struct ConceptLevels {
    market: Arc<MarketRouter>,
    profiles: VolumeProfileLevels,
    clock: Arc<dyn Clock>,
    initial_balance_minutes: InitialBalanceMinutes,
}

impl std::fmt::Debug for ConceptLevels {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConceptLevels").finish_non_exhaustive()
    }
}

type Part = Option<(Timestamp, Vec<Level>)>;

#[derive(Clone, Debug, Default, PartialEq)]
struct Parts {
    prior_day: Part,
    profile: Part,
    periods: Part,
    initial_balance: Part,
}

impl Parts {
    fn all(&self) -> [&Part; 4] {
        [
            &self.prior_day,
            &self.profile,
            &self.periods,
            &self.initial_balance,
        ]
    }

    fn same_levels(&self, other: &Parts) -> bool {
        let levels = |p: &Parts| {
            p.all()
                .into_iter()
                .flatten()
                .flat_map(|(_, l)| l.iter().map(|l| (l.key.clone(), l.price, l.label.clone())))
                .collect::<Vec<_>>()
        };
        let prior_day_at = |p: &Parts| p.prior_day.as_ref().map(|(at, _)| *at);
        levels(self) == levels(other) && prior_day_at(self) == prior_day_at(other)
    }
}

impl ConceptLevels {
    async fn prior_day(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(tessera_core::Timestamp, Vec<tessera_core::levels::Level>), MarketError> {
        let provider = self.market.route_async(instrument).await?;
        let series = provider
            .get_bars(BarsRequest::latest(instrument.clone(), Timeframe::D1, 3))
            .await?;
        prior_day_levels(instrument, &series.bars, series.last_bar_open).ok_or_else(|| {
            MarketError::Unavailable(format!("no completed session of {instrument} yet"))
        })
    }

    async fn profile(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(tessera_core::Timestamp, Vec<tessera_core::levels::Level>), MarketError> {
        self.profiles.levels(instrument).await
    }

    async fn periods(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(tessera_core::Timestamp, Vec<tessera_core::levels::Level>), MarketError> {
        self.profiles.period_levels(instrument).await
    }

    async fn initial_balance(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(Timestamp, Vec<Level>), MarketError> {
        let minutes = (self.initial_balance_minutes)();
        let now = self.clock.now();
        let (_, spec) = self.market.spec(instrument).await?;
        let calendar = spec.sessions;
        let opened = |s: &tessera_core::session::TradingSession| {
            s.rth.filter(|r| r.start < now).map(|r| (s.clone(), r))
        };
        let (session, rth) = calendar
            .last_sessions(now, 2)
            .iter()
            .rev()
            .find_map(opened)
            .ok_or_else(|| {
                MarketError::Unavailable(format!("no regular session of {instrument} has opened"))
            })?;
        let provider = self.market.route_async(instrument).await?;
        let request = BarsRequest {
            from: Some(rth.start),
            to: Some(Timestamp(
                rth.start.0 + i64::from(minutes) * NANOS_PER_MINUTE,
            )),
            ..BarsRequest::latest(instrument.clone(), Timeframe::M1, minutes as usize + 1)
        };
        let bars = self
            .market
            .bars_from(&provider, request, Read::Through)
            .await?;
        let ib = InitialBalance::measure(&session, minutes, &bars.bars, NANOS_PER_MINUTE, now)
            .ok_or_else(|| {
                MarketError::Unavailable(format!("no bars of {instrument} since its regular open"))
            })?;
        Ok((
            ib.through,
            initial_balance_levels(instrument, &ib, calendar.trade_date(now)),
        ))
    }

    async fn update_of(
        &self,
        instrument: &InstrumentId,
        parts: &Parts,
    ) -> Result<LevelsUpdate, MarketError> {
        let mut levels = Vec::new();
        let mut as_of = None;
        for (at, ls) in parts.all().into_iter().flatten() {
            levels.extend(ls.iter().cloned());
            as_of = as_of.max(Some(*at));
        }
        let as_of = as_of.ok_or_else(|| {
            MarketError::Unavailable(format!("no completed session of {instrument} yet"))
        })?;
        Ok(LevelsUpdate {
            instrument: instrument.clone(),
            levels,
            as_of,
            provider: PROVIDER_ID.to_owned(),
        })
    }

    pub async fn levels(&self, instrument: &InstrumentId) -> Result<LevelsUpdate, MarketError> {
        let (prior_day, profile, periods, initial_balance) = tokio::join!(
            self.prior_day(instrument),
            self.profile(instrument),
            self.periods(instrument),
            self.initial_balance(instrument)
        );
        let parts = Parts {
            prior_day: prior_day.ok(),
            profile: profile.ok().filter(|(_, l)| !l.is_empty()),
            periods: periods.ok().filter(|(_, l)| !l.is_empty()),
            initial_balance: initial_balance.ok(),
        };
        self.update_of(instrument, &parts).await
    }
}

pub struct ConceptsModule {
    levels: Arc<ConceptLevels>,
    bus: Arc<EventBus>,
    pumps: Arc<Pumps<InstrumentId>>,
}

impl std::fmt::Debug for ConceptsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConceptsModule")
            .field("pumps", &self.pumps.len())
            .finish_non_exhaustive()
    }
}

impl ConceptsModule {
    pub fn new(
        market: Arc<MarketRouter>,
        bus: Arc<EventBus>,
        hub: Arc<tessera_market::hub::MarketHub>,
        clock: Arc<dyn Clock>,
        initial_balance_minutes: InitialBalanceMinutes,
    ) -> Self {
        Self {
            levels: Arc::new(ConceptLevels {
                market,
                profiles: VolumeProfileLevels::new(hub, Arc::clone(&clock)),
                clock,
                initial_balance_minutes,
            }),
            bus,
            pumps: Arc::new(Pumps::new()),
        }
    }
}

impl RuntimeModule for ConceptsModule {
    fn name(&self) -> &'static str {
        "concepts"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(GetConceptLevels(Arc::clone(&self.levels)))
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(LevelsTopic {
            levels: Arc::clone(&self.levels),
            bus: Arc::clone(&self.bus),
            pumps: Arc::clone(&self.pumps),
        })]
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-concepts")
        .tool::<GetConceptLevelsInput, LevelsUpdate>("concepts.get_levels")
        .topic::<InstrumentParams, LevelsUpdate>(CONCEPTS_LEVELS)
}

struct GetConceptLevels(Arc<ConceptLevels>);

#[async_trait]
impl Tool for GetConceptLevels {
    type Input = GetConceptLevelsInput;
    type Output = LevelsUpdate;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("concepts.get_levels", "Get computed levels", RiskTier::Read)
            .description("Levels Tessera computes from the instrument's own market data (not vendor intelligence): prior-day high (pdh), low (pdl) and close (pdc) of the last completed session; and the volume profile's point of control and value area (one-tick rows, 70% of the volume) of the current session (poc, vah, val; developing, a few seconds behind the tape), the prior session (ppoc, pvah, pval), the last five sessions together (cpoc, cvah, cval), the current and prior trading week (wpoc, wvah, wval; pwpoc, pwvah, pwval: the sessions whose trade dates fall in one Monday-to-Sunday week) and the current and prior month (mpoc, mvah, mval; pmpoc, pmvah, pmval), measured from every print, all in group vp. A chart draws one set as lines with a levels layer {group: \"vp\", fields: [\"wpoc\", \"wvah\", \"wval\"]}; market.get_volume_profile mode week or month gives the whole profile. A label ending (recorded part) was measured from the prints Tessera recorded, not the whole span (the connection keeps no trade history). The initial balance (group ib, keys tessera.ib.*): the high, low and mid of the first 30 or 60 minutes after the instrument's regular-session open (setting chart.initialBalanceMinutes) and 50% and 100% of its range above the high and below the low, the same lines the charts draw; a label ending (forming, 12 of 30 min) means the window is still running, and one ending with a date is an earlier session's, before today's regular open. Markets without a regular session have none. Source Tessera · Concepts.")
            .activity("Computed levels")
            .result_view("levels")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: GetConceptLevelsInput,
    ) -> Result<LevelsUpdate, ToolError> {
        let id = self
            .0
            .market
            .resolve(&input.instrument)
            .await
            .map_err(market_error)?;
        self.0.levels(&id).await.map_err(market_error)
    }

    fn summarize(&self, out: &LevelsUpdate) -> Option<String> {
        Some(format!(
            "{} levels for {}",
            out.levels.len(),
            out.instrument
        ))
    }
}

struct LevelsTopic {
    levels: Arc<ConceptLevels>,
    bus: Arc<EventBus>,
    pumps: Arc<Pumps<InstrumentId>>,
}

#[async_trait]
impl TopicHandler for LevelsTopic {
    fn name(&self) -> &'static str {
        CONCEPTS_LEVELS
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::SNAPSHOT
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: InstrumentParams = parse_params(params)?;
        let id = self
            .levels
            .market
            .resolve(&p.instrument)
            .await
            .map_err(|e| refusal(e, codes::INVALID_PARAMS))?;
        let (prior_day, profile, periods, initial_balance) = tokio::join!(
            self.levels.prior_day(&id),
            tokio::time::timeout(SNAPSHOT_WAIT, self.levels.profile(&id)),
            tokio::time::timeout(SNAPSHOT_WAIT, self.levels.periods(&id)),
            tokio::time::timeout(SNAPSHOT_WAIT, self.levels.initial_balance(&id))
        );
        let parts = Parts {
            prior_day: prior_day.ok(),
            profile: profile
                .ok()
                .and_then(Result::ok)
                .filter(|(_, l)| !l.is_empty()),
            periods: periods
                .ok()
                .and_then(Result::ok)
                .filter(|(_, l)| !l.is_empty()),
            initial_balance: initial_balance.ok().and_then(Result::ok),
        };
        let snapshot = self.levels.update_of(&id, &parts).await.ok();
        let guard = self.pumps.acquire(id.clone(), || {
            Ok::<_, std::convert::Infallible>(tokio::spawn(refresh(
                Arc::clone(&self.levels),
                Arc::clone(&self.bus),
                id.clone(),
                parts.clone(),
            )))
        });
        let guard = match guard {
            Ok(g) => g,
            Err(never) => match never {},
        };
        let mut sub = Subscribed::new(KeyFilter::Instruments([id].into_iter().collect()));
        if let Some(s) = &snapshot {
            sub = sub.snapshot(s);
        }
        Ok(sub.keep(guard))
    }
}

async fn refresh(
    levels: Arc<ConceptLevels>,
    bus: Arc<EventBus>,
    instrument: InstrumentId,
    mut parts: Parts,
) {
    let start = tokio::time::Instant::now();
    let mut tick = tokio::time::interval_at(start + PROFILE_REFRESH, PROFILE_REFRESH);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut prior_day_at = start;
    let mut periods_at = (parts.periods.is_some()).then_some(start);
    let mut profile_now = parts.profile.is_none();
    loop {
        if !std::mem::take(&mut profile_now) {
            tick.tick().await;
        }
        let mut next = parts.clone();
        if prior_day_at.elapsed() >= REFRESH {
            prior_day_at = tokio::time::Instant::now();
            if let Ok(p) = levels.prior_day(&instrument).await {
                next.prior_day = Some(p);
            }
        }
        if let Ok(p) = levels.profile(&instrument).await {
            next.profile = Some(p).filter(|(_, l)| !l.is_empty());
        }
        if periods_at.is_none_or(|t| t.elapsed() >= REFRESH)
            && let Ok(p) = levels.periods(&instrument).await
        {
            periods_at = Some(tokio::time::Instant::now());
            next.periods = Some(p).filter(|(_, l)| !l.is_empty());
        }
        next.initial_balance = levels.initial_balance(&instrument).await.ok();
        if parts.same_levels(&next) {
            continue;
        }
        parts = next;
        if let Ok(update) = levels.update_of(&instrument, &parts).await {
            bus.publish(
                CONCEPTS_LEVELS,
                TopicKey::Instrument(instrument.clone()),
                &update,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::bar;

    fn read_at(t: &str, high: f64) -> (tessera_core::Timestamp, Vec<tessera_core::levels::Level>) {
        let nq = InstrumentId::new("NQ").unwrap();
        prior_day_levels(&nq, &[bar(t, 10.0, high, 9.0, 11.0, 100.0)], false).unwrap()
    }

    #[test]
    fn only_moved_levels_or_a_new_prior_day_are_a_change() {
        let parts = Parts {
            prior_day: Some(read_at("2026-10-01T00:00:00Z", 12.0)),
            profile: Some(read_at("2026-10-02T14:00:00Z", 12.0)),
            periods: None,
            initial_balance: None,
        };
        let reread = Parts {
            profile: Some(read_at("2026-10-02T14:00:05Z", 12.0)),
            ..parts.clone()
        };
        assert!(parts.same_levels(&reread));
        let moved = Parts {
            profile: Some(read_at("2026-10-02T14:00:05Z", 12.5)),
            ..parts.clone()
        };
        assert!(!parts.same_levels(&moved));
        let next_day = Parts {
            prior_day: Some(read_at("2026-10-02T00:00:00Z", 12.0)),
            ..parts.clone()
        };
        assert!(!parts.same_levels(&next_day));
    }
}
