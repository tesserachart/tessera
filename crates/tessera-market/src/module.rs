use std::sync::Arc;

use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde_json::Value;
use tessera_core::health::ProviderHealth;
use tessera_core::instrument::{AssetClass, ContractSpec};
use tessera_core::market::Quote;
use tessera_core::time::NANOS_PER_MINUTE;
use tessera_core::{InstrumentId, Price, Timestamp};
use tessera_host::{
    EventBus, KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicKey,
    TopicSizing, TsExports, parse_params,
};
use tessera_protocol::compact::CompactBar;
use tessera_protocol::methods::{MarketProviderInfo, ServerCapabilities};
use tessera_protocol::rpc::{RpcError, codes};
use tessera_protocol::tools::RiskTier;
use tessera_protocol::topics::{BarsParams, InstrumentsParams, names};
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::aggregate::bar_range;
use crate::candles::{Candles, CandlesAsk, candles};
use crate::history::{HistoryKept, Read};
use crate::hub::depth_history;
use crate::hub::{Asker, MarketHub, PumpKey, footprint_key};
use crate::io::{
    BarUpdate, BigTradesOutput, CandlesOutput, CompactFootprint, ContractSpecOutput, DeltaOutput,
    DepthHistoryOutput, DepthLevelStat, DepthOutput, DepthParams, DepthUpdate, FootprintOutput,
    FootprintParams, FootprintUpdate, GetBigTradesInput, GetCandlesInput, GetContractSpecInput,
    GetDeltaInput, GetDepthHistoryInput, GetDepthInput, GetFootprintInput, GetQuoteInput,
    GetSessionsInput, GetTradesInput, GetVolumeProfileInput, HistoryUpdate, ListInstrumentsInput,
    ListInstrumentsOutput, MinSize, PrintsLoaded, RestingSide, SearchInstrumentsInput,
    SearchInstrumentsOutput, SessionFilter, SessionsOutput, StackedImbalance, TradesOutput,
    TradesUpdate, VolumeProfileOutput,
};
use crate::io::{
    CloseReplayInput, CloseReplayOutput, ControlReplayInput, GetReplaysInput, ListReplayDaysInput,
    ListReplayDaysOutput, OpenReplayInput, ReplayState, ReplaysOutput,
};
use crate::orderflow::bars::base_row_ticks;
use crate::orderflow::delta::DeltaReset;
use crate::orderflow::imbalance;
use crate::orderflow::loaded::{DaysToLoad, loaded};
use crate::orderflow::profile::auto_row_ticks;
use crate::orderflow::tools as flow;
use crate::provider::{BarsRequest, MarketDataProvider, MarketError};
use crate::replay::tools as replay;
use crate::router::{MarketRouter, effective};

pub const DEFAULT_BARS: u32 = 500;
pub const AGENT_MAX_BARS: u32 = 5000;
pub const USER_MAX_BARS: u32 = crate::history::CHART_MAX_BARS as u32;
pub const DEFAULT_TRADES: u32 = 500;
pub const USER_MAX_TRADES: u32 = 10_000;
pub const QUOTE_SNAPSHOT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
pub const DEFAULT_FOOTPRINTS: u32 = 20;
pub const USER_MAX_FOOTPRINTS: u32 = 200;
pub const FOOTPRINT_AUTO_ROWS: u32 = 40;
pub const AGENT_MAX_FOOTPRINT_CELLS: u64 = 5_000;
pub const USER_MAX_FOOTPRINT_CELLS: u64 = 250_000;
pub const MAX_ROW_TICKS: u32 = 100_000;
pub const AGENT_MAX_TRADES: u32 = 1000;
pub const AGENT_MAX_FOOTPRINTS: u32 = 50;

pub(crate) fn refuse_index(id: &InstrumentId, spec: &ContractSpec) -> Result<(), ToolError> {
    if spec.asset_class == AssetClass::Index {
        return Err(ToolError::unsupported(format!(
            "{id} is an index: it does not trade"
        )));
    }
    Ok(())
}

pub(crate) fn asker(ctx: &ToolCtx) -> Asker {
    if ctx.origin.is_user() {
        Asker::User
    } else {
        Asker::Agent
    }
}

pub fn market_error(e: MarketError) -> ToolError {
    match e {
        MarketError::UnknownInstrument(s) => ToolError::not_found(format!(
            "unknown instrument {s}; try market.search_instruments"
        )),
        MarketError::Unsupported(s) => ToolError::unsupported(s),
        MarketError::Unavailable(s) => ToolError::unavailable(s),
        MarketError::InvalidRequest(s) => ToolError::invalid_input(s),
    }
}

pub struct MarketModule {
    router: Arc<MarketRouter>,
    hub: Arc<MarketHub>,
}

impl std::fmt::Debug for MarketModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MarketModule")
            .field("router", &self.router)
            .finish_non_exhaustive()
    }
}

impl MarketModule {
    pub fn new(router: Arc<MarketRouter>, bus: Arc<EventBus>) -> Self {
        let hub = MarketHub::new(Arc::clone(&router), bus);
        Self { router, hub }
    }

    pub fn hub(&self) -> &Arc<MarketHub> {
        &self.hub
    }
}

impl RuntimeModule for MarketModule {
    fn name(&self) -> &'static str {
        "market"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(GetQuote(Arc::clone(&self.router)))?;
        r.register(GetCandles(Arc::clone(&self.router)))?;
        r.register(SearchInstruments(Arc::clone(&self.router)))?;
        r.register(ListInstruments(Arc::clone(&self.router)))?;
        r.register(GetContractSpec(Arc::clone(&self.router)))?;
        r.register(GetSessions(Arc::clone(&self.router)))?;
        r.register(GetTrades(Arc::clone(&self.hub)))?;
        r.register(GetDepth(Arc::clone(&self.hub)))?;
        r.register(GetFootprint(Arc::clone(&self.hub)))?;
        r.register(GetDepthHistory(Arc::clone(&self.hub)))?;
        r.register(flow::GetVolumeProfile::new(Arc::clone(&self.hub)))?;
        r.register(flow::GetBigTrades(Arc::clone(&self.hub)))?;
        r.register(flow::GetDelta(Arc::clone(&self.hub)))?;
        r.register(flow::GetPrintBars(Arc::clone(&self.hub)))?;
        r.register(replay::ListReplayDays(Arc::clone(&self.router)))?;
        r.register(replay::OpenReplay(Arc::clone(&self.router)))?;
        r.register(replay::ControlReplay(Arc::clone(&self.router)))?;
        r.register(replay::GetReplays(Arc::clone(&self.router)))?;
        r.register(replay::CloseReplay(Arc::clone(&self.router)))?;
        Ok(())
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        let hub = &self.hub;
        vec![
            Arc::new(QuotesTopic(Arc::clone(hub))),
            Arc::new(TradesTopic(Arc::clone(hub))),
            Arc::new(BarsTopic(Arc::clone(hub))),
            Arc::new(HistoryTopic(Arc::clone(hub))),
            Arc::new(DepthTopic(Arc::clone(hub))),
            Arc::new(FootprintTopic(Arc::clone(hub))),
        ]
    }

    fn health(&self) -> Vec<ProviderHealth> {
        self.router
            .providers()
            .iter()
            .map(|p| self.hub.health(p.as_ref()))
            .collect()
    }

    fn describe(&self, caps: &mut ServerCapabilities) {
        caps.market
            .extend(self.router.providers().iter().map(|p| MarketProviderInfo {
                provider_id: p.id().to_owned(),
                display_name: p.display_name().to_owned(),
                capabilities: effective(p.capabilities()),
            }));
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-market")
        .tool::<GetQuoteInput, Quote>("market.get_quote")
        .tool::<GetCandlesInput, CandlesOutput>("market.get_candles")
        .tool::<SearchInstrumentsInput, SearchInstrumentsOutput>("market.search_instruments")
        .tool::<ListInstrumentsInput, ListInstrumentsOutput>("market.list_instruments")
        .tool::<GetContractSpecInput, ContractSpecOutput>("market.get_contract_spec")
        .tool::<GetSessionsInput, SessionsOutput>("market.get_sessions")
        .tool::<GetTradesInput, TradesOutput>("market.get_trades")
        .tool::<GetDepthInput, DepthOutput>("market.get_depth")
        .tool::<GetFootprintInput, FootprintOutput>("market.get_footprint")
        .tool::<GetDepthHistoryInput, DepthHistoryOutput>("market.get_depth_history")
        .tool::<GetVolumeProfileInput, VolumeProfileOutput>("market.get_volume_profile")
        .tool::<GetBigTradesInput, BigTradesOutput>("market.get_big_trades")
        .tool::<GetDeltaInput, DeltaOutput>("market.get_delta")
        .tool::<crate::io::GetPrintBarsInput, crate::io::PrintBarsOutput>("market.get_print_bars")
        .tool::<ListReplayDaysInput, ListReplayDaysOutput>("market.list_replay_days")
        .tool::<OpenReplayInput, ReplayState>("market.open_replay")
        .tool::<ControlReplayInput, ReplayState>("market.control_replay")
        .tool::<GetReplaysInput, ReplaysOutput>("market.get_replays")
        .tool::<CloseReplayInput, CloseReplayOutput>("market.close_replay")
        .topic::<InstrumentsParams, Quote>(names::MARKET_QUOTES)
        .topic::<InstrumentsParams, TradesUpdate>(names::MARKET_TRADES)
        .topic::<BarsParams, BarUpdate>(names::MARKET_BARS)
        .topic::<BarsParams, HistoryUpdate>(names::MARKET_HISTORY)
        .topic::<DepthParams, DepthUpdate>(names::MARKET_DEPTH)
        .topic::<FootprintParams, FootprintUpdate>(names::MARKET_FOOTPRINT)
        .ty::<SessionFilter>()
        .ty::<DeltaReset>()
}

async fn resolve(m: &MarketRouter, s: &str) -> Result<InstrumentId, ToolError> {
    m.resolve(s).await.map_err(market_error)
}

struct GetQuote(Arc<MarketRouter>);

#[async_trait]
impl Tool for GetQuote {
    type Input = GetQuoteInput;
    type Output = Quote;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_quote", "Get quote", RiskTier::Read)
            .description("Latest bid, ask, last and session stats (open, high, low, prior close, volume) for an instrument, with the connection it came from (source.provider). Accepts ids or symbols such as NQ (front contract), NQZ6 or NQZ6.CME-RITHMIC.")
            .activity("Loaded quote")
            .result_view("quote")
    }

    async fn call(&self, _ctx: &ToolCtx, input: GetQuoteInput) -> Result<Quote, ToolError> {
        let id = resolve(&self.0, &input.instrument).await?;
        self.0.quote(&id).await.map_err(market_error)
    }

    fn summarize(&self, q: &Quote) -> Option<String> {
        let f =
            |p: Option<tessera_core::Price>| p.map_or_else(|| "—".to_owned(), |p| p.to_string());
        Some(format!(
            "bid {} · ask {} · last {}",
            f(q.bid),
            f(q.ask),
            f(q.last)
        ))
    }
}

struct GetCandles(Arc<MarketRouter>);

#[async_trait]
impl Tool for GetCandles {
    type Input = GetCandlesInput;
    type Output = CandlesOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_candles", "Get candles", RiskTier::Read)
            .description("Historical OHLCV bars as compact [t, o, h, l, c, v, bv?] rows (t = bar open, UTC nanoseconds; bv = aggressive buy volume when the feed knows it, so delta = 2·bv − v), oldest first. Timeframe: any count of s, m, h or D (15s 1m 7m 90m 2h 1D 2D); from/to accept RFC 3339 times (older pages: to = just before the first bar you have); default 500 bars, max 5000. provider names the connection that served them. Bars already kept on this machine are served from there and only the rest is asked of the connection; cachedOnly answers from the kept bars alone, at once.")
            .activity("Loaded candles")
            .result_view("bars")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: GetCandlesInput,
    ) -> Result<CandlesOutput, ToolError> {
        let id = resolve(&self.0, &input.instrument).await?;
        let limit = input.limit.unwrap_or(DEFAULT_BARS);
        let max = if ctx.origin.is_user() {
            USER_MAX_BARS
        } else {
            AGENT_MAX_BARS
        };
        if limit == 0 || limit > max {
            return Err(ToolError::invalid_input(format!("limit must be 1..={max}")));
        }
        let read = if input.cached_only == Some(true) {
            Read::Kept
        } else {
            Read::Through
        };
        let ask = CandlesAsk {
            instrument: id.clone(),
            tf: input.tf,
            from: input.from,
            to: input.to,
            limit: limit as usize,
            session: input.session.unwrap_or_default(),
            front_months: input.front_months == Some(true),
        };
        let Candles {
            series,
            contracts,
            provider,
            spec,
        } = candles(&self.0, ask, read, ctx.now)
            .await
            .map_err(market_error)?;
        Ok(CandlesOutput {
            instrument: id,
            tf: input.tf,
            price_decimals: spec.price_decimals,
            tz: spec.sessions.exchange_tz().name().to_owned(),
            columns: ["t", "o", "h", "l", "c", "v", "bv"]
                .map(str::to_owned)
                .to_vec(),
            bars: series.bars.iter().map(CompactBar::from).collect(),
            last_bar_open: series.last_bar_open,
            provider: provider.id().to_owned(),
            contracts,
        })
    }

    fn summarize(&self, out: &CandlesOutput) -> Option<String> {
        Some(format!(
            "{} bars · {} {}",
            out.bars.len(),
            out.instrument,
            out.tf
        ))
    }
}

struct SearchInstruments(Arc<MarketRouter>);

#[async_trait]
impl Tool for SearchInstruments {
    type Input = SearchInstrumentsInput;
    type Output = SearchInstrumentsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.search_instruments", "Search instruments", RiskTier::Read)
            .description("Finds instruments by symbol, futures root, name or exchange across every market-data connection. Futures are dated contracts; the front contract ranks first.")
            .activity("Searched instruments")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: SearchInstrumentsInput,
    ) -> Result<SearchInstrumentsOutput, ToolError> {
        let limit = input.limit.unwrap_or(20).clamp(1, 100) as usize;
        let results = self
            .0
            .search(&input.query, input.asset_class, limit)
            .await
            .map_err(market_error)?;
        Ok(SearchInstrumentsOutput { results })
    }

    fn summarize(&self, out: &SearchInstrumentsOutput) -> Option<String> {
        Some(format!("{} instruments", out.results.len()))
    }
}

struct ListInstruments(Arc<MarketRouter>);

#[async_trait]
impl Tool for ListInstruments {
    type Input = ListInstrumentsInput;
    type Output = ListInstrumentsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.list_instruments", "List instruments", RiskTier::Read)
            .description("Every instrument each market-data connection serves, connection by connection (the Markets area's All list): the one feeding the desk first (feedsDesk), each instrument kept with the connection that listed it, so its quotes and spec come from there (unlike market.search_instruments, which ranks across connections and shows another connection's only as twins). A futures connection lists each product's front month. `connection` lists one; `assetClass` filters; `limit` caps each connection (default 500). An empty list means the connection lists nothing; `error` says why one could not answer.")
            .activity("Listed instruments")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ListInstrumentsInput,
    ) -> Result<ListInstrumentsOutput, ToolError> {
        let limit = input.limit.unwrap_or(500).clamp(1, 2000) as usize;
        let connection = input
            .connection
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty());
        if let Some(c) = connection
            && self.0.get(c).is_none()
        {
            let ids: Vec<String> = self.0.ordered().iter().map(|p| p.id().to_owned()).collect();
            return Err(ToolError::not_found(format!(
                "no market-data connection {c} (connected: {})",
                ids.join(", ")
            )));
        }
        let connections = self
            .0
            .list_by_connection(connection, input.asset_class, limit)
            .await;
        Ok(ListInstrumentsOutput { connections })
    }

    fn summarize(&self, out: &ListInstrumentsOutput) -> Option<String> {
        let n: usize = out.connections.iter().map(|c| c.instruments.len()).sum();
        let m = out.connections.len();
        Some(format!(
            "{n} instruments · {m} connection{}",
            if m == 1 { "" } else { "s" }
        ))
    }
}

struct GetContractSpec(Arc<MarketRouter>);

#[async_trait]
impl Tool for GetContractSpec {
    type Input = GetContractSpecInput;
    type Output = ContractSpecOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_contract_spec", "Get contract spec", RiskTier::Read)
            .description("Tick size, tick value, point multiplier, sessions, expiry and roll date of an instrument.")
            .activity("Loaded contract spec")
            .result_view("spec")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: GetContractSpecInput,
    ) -> Result<ContractSpecOutput, ToolError> {
        let id = resolve(&self.0, &input.instrument).await?;
        let (instrument, spec) = self.0.spec(&id).await.map_err(market_error)?;
        Ok(ContractSpecOutput { instrument, spec })
    }

    fn summarize(&self, out: &ContractSpecOutput) -> Option<String> {
        Some(format!(
            "{} · tick {} = {}",
            out.instrument.symbol, out.spec.tick_size, out.spec.tick_value
        ))
    }
}

pub const MAX_SESSION_DAYS: i64 = 366;

struct GetSessions(Arc<MarketRouter>);

#[async_trait]
impl Tool for GetSessions {
    type Input = GetSessionsInput;
    type Output = SessionsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_sessions", "Get sessions", RiskTier::Read)
            .description("An instrument's trading sessions on its exchange calendar, from the exchange's own hours with DST and holidays: each trade date's open and close, the windows it trades in, its regular session (rth: the cash or day session, e.g. 09:30–16:00 ET for CME equity index, 09:00–14:30 ET for NYMEX energy; empty for a market without one) and whether it closes early; hours describes the calendar, and holidays lists the weekdays with no session of their own (halt: when a market that trades part of the holiday stops; those hours belong to the next trade date). Times are UTC nanoseconds. from and to are trade dates, at most 366 days apart; default the trade dates either side of the current one.")
            .activity("Loaded sessions")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: GetSessionsInput,
    ) -> Result<SessionsOutput, ToolError> {
        let id = resolve(&self.0, &input.instrument).await?;
        let (_, spec) = self.0.spec(&id).await.map_err(market_error)?;
        let calendar = spec.sessions;
        let today = calendar.trade_date(ctx.now);
        let from = input
            .from
            .unwrap_or_else(|| calendar.prev_trade_date(today));
        let to = input.to.unwrap_or_else(|| calendar.next_trade_date(today));
        if to < from {
            return Err(ToolError::invalid_input("to is before from"));
        }
        if (to - from).num_days() > MAX_SESSION_DAYS {
            return Err(ToolError::invalid_input(format!(
                "ask for at most {MAX_SESSION_DAYS} days of sessions at a time"
            )));
        }
        Ok(SessionsOutput {
            instrument: id,
            hours: calendar.hours(),
            sessions: calendar.sessions_between(from, to),
            holidays: calendar.holidays_between(from, to),
        })
    }

    fn summarize(&self, out: &SessionsOutput) -> Option<String> {
        let rth = out.hours.rth.as_ref().map_or_else(
            || "no RTH".to_owned(),
            |w| format!("RTH {}–{}", w.start, w.end),
        );
        Some(format!(
            "{} · {} · {} sessions · {rth}",
            out.instrument.symbol(),
            out.hours.market,
            out.sessions.len()
        ))
    }
}

struct GetTrades(Arc<MarketHub>);

#[async_trait]
impl Tool for GetTrades {
    type Input = GetTradesInput;
    type Output = TradesOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_trades", "Get trades", RiskTier::Read)
            .description(format!("Time & sales: individual prints as compact [t, price, size, side, order?] rows (t = UTC nanoseconds; side 1 = buyer lifted the offer, -1 = seller hit the bid, 0 = unknown; order = key of the aggressor order when the feed names it), oldest first. from (inclusive) / to (exclusive) accept RFC 3339 times; default the latest 500 rows, at most 1000 for an agent (big trades, footprints and profiles summarise more). aggregate: true joins the prints of one aggressor order into one row (its first print's time, size-weighted average price, total size; prints says how many it joined). minSize keeps rows of at least that size; minSize \"auto\" uses the size Tessera's big-trade rule calls big now (market.get_big_trades' Auto: the Low cut of the call's trade date, the size about the 120th largest event a session reached in the five sessions before, at least ES 20, NQ 8 and a $500k notional) and threshold says what it was and what it read. Prints of one aggressor order join, and so do other orders on the same side within 5 ms that do not retreat (a sweep or burst split across messages). aggressorSource says where the side came from (exchange flag, replay-mapped, inferred). truncated: older rows were left out (the limit was reached with from given, or a filtered read stopped at its budget); narrow the span, or page back with to. {}", flow::RECORDED_FROM))
            .activity("Loaded trades")
            .result_view("table")
    }

    async fn call(&self, ctx: &ToolCtx, input: GetTradesInput) -> Result<TradesOutput, ToolError> {
        let id = resolve(self.0.router(), &input.instrument).await?;
        let limit = input.limit.unwrap_or(DEFAULT_TRADES);
        if limit == 0 || limit > USER_MAX_TRADES {
            return Err(ToolError::invalid_input(format!(
                "limit must be 1..={USER_MAX_TRADES}"
            )));
        }
        if !ctx.origin.is_user() && limit > AGENT_MAX_TRADES {
            return Err(ToolError::invalid_input(format!(
                "agents read at most {AGENT_MAX_TRADES} prints a call; market.get_big_trades, market.get_footprint and market.get_volume_profile summarise more"
            )));
        }
        if let (Some(f), Some(t)) = (input.from, input.to)
            && f >= t
        {
            return Err(ToolError::invalid_input("from must be before to"));
        }
        let provider = self
            .0
            .router()
            .route_async(&id)
            .await
            .map_err(market_error)?;
        let (_, spec) = provider.spec(&id).await.map_err(market_error)?;
        refuse_index(&id, &spec)?;
        let _recording = self.0.linger_as(PumpKey::Trades(id.clone()), asker(ctx));
        let threshold = match input.min_size {
            Some(MinSize::Auto(_)) => Some(flow::big_trade_threshold(&self.0, &id, ctx.now).await?),
            _ => None,
        };
        let min = match &input.min_size {
            Some(MinSize::Size(q)) => Some(*q),
            Some(MinSize::Auto(_)) => threshold.as_ref().map(|t| t.size),
            None => None,
        };
        let aggregate = input.aggregate.unwrap_or(false);
        let end = input.to.unwrap_or(ctx.now);
        let read = if min.is_none() && !aggregate {
            let h = self
                .0
                .history(&id, input.from, input.to, Some(limit as usize))
                .await
                .map_err(market_error)?;
            let truncated = input.from.is_some() && h.trades.len() >= limit as usize;
            flow::Rows {
                aggressor_source: h.trades.last().map(|t| t.aggressor_source),
                rows: h.trades.iter().map(flow::print_row).collect(),
                gaps: h.gaps,
                filling: h.filling,
                truncated,
            }
        } else {
            flow::trade_rows(
                &self.0,
                &id,
                spec.tick_size,
                input.from,
                input.to,
                ctx.now,
                limit as usize,
                min,
                aggregate,
            )
            .await?
        };
        let mut columns = ["t", "price", "size", "side", "order"]
            .map(str::to_owned)
            .to_vec();
        if aggregate {
            columns.push("prints".into());
        }
        let mut trades = Vec::with_capacity(read.rows.len());
        let mut prints = Vec::new();
        let mut last = Vec::new();
        for (row, n, at) in read.rows {
            trades.push(row);
            if aggregate {
                prints.push(n);
                last.push(at);
            }
        }
        let gaps = read
            .gaps
            .within(tessera_store::ticks::Span::new(i64::MIN, end.0));
        Ok(TradesOutput {
            instrument: id,
            price_decimals: spec.price_decimals,
            columns,
            aggressor_source: read.aggressor_source,
            filling: read.filling && (!gaps.is_empty() || input.from.is_none()),
            gaps: gaps.wire(),
            truncated: read.truncated,
            trades,
            aggregated: aggregate,
            prints,
            last,
            threshold,
            provider: provider.id().to_owned(),
        })
    }

    fn summarize(&self, out: &TradesOutput) -> Option<String> {
        Some(format!("{} prints · {}", out.trades.len(), out.instrument))
    }
}

pub const DEFAULT_DEPTH: u32 = 20;
const FIRST_BOOK_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

struct GetDepth(Arc<MarketHub>);

#[async_trait]
impl Tool for GetDepth {
    type Input = GetDepthInput;
    type Output = DepthOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_depth", "Get order book", RiskTier::Read)
            .description("The resting order book now: bids and asks as [price, size, orders?] levels, best first (orders when the feed counts them). Default 20 levels a side, at most what the connection offers. Asking records the book for a minute (as long as a chart shows it), for market.get_depth_history.")
            .activity("Loaded order book")
            .result_view("table")
    }

    async fn call(&self, ctx: &ToolCtx, input: GetDepthInput) -> Result<DepthOutput, ToolError> {
        let router = self.0.router();
        let id = resolve(router, &input.instrument).await?;
        let provider = router.route_async(&id).await.map_err(market_error)?;
        let caps = provider.capabilities();
        let Some(max) = caps.depth_levels else {
            return Err(ToolError::unsupported(format!(
                "{} offers no depth for {id}",
                provider.id()
            )));
        };
        let levels = input.levels.unwrap_or(DEFAULT_DEPTH).clamp(1, max.max(1)) as usize;
        let (_, spec) = provider.spec(&id).await.map_err(market_error)?;
        let _recording = self
            .0
            .linger_as(PumpKey::Book(id.clone()), asker(ctx))
            .map_err(market_error)?;
        let book = self.0.book_now(&id, FIRST_BOOK_WAIT).await.ok_or_else(|| {
            ToolError::unavailable(format!("no book for {id} yet (market closed?)"))
        })?;
        let side = |l: &[tessera_core::market::DepthLevel]| {
            l.iter()
                .take(levels)
                .map(tessera_protocol::compact::CompactLevel::from)
                .collect()
        };
        Ok(DepthOutput {
            instrument: id,
            ts: book.ts,
            price_decimals: spec.price_decimals,
            bids: side(&book.bids),
            asks: side(&book.asks),
            provider: provider.id().to_owned(),
        })
    }

    fn summarize(&self, out: &DepthOutput) -> Option<String> {
        let best = |l: &[tessera_protocol::compact::CompactLevel]| {
            l.first()
                .map_or_else(|| "—".to_owned(), |l| format!("{} × {}", l.0, l.1))
        };
        Some(format!("bid {} · ask {}", best(&out.bids), best(&out.asks)))
    }
}

fn check_row_ticks(n: u32) -> Result<u32, ToolError> {
    if n == 0 || n > MAX_ROW_TICKS {
        return Err(ToolError::invalid_input(format!(
            "rowTicks must be 1..={MAX_ROW_TICKS}"
        )));
    }
    Ok(n)
}

fn rows_of(low: i64, high: i64, n: u32) -> u64 {
    let n = i64::from(n.max(1));
    (high.div_euclid(n) - low.div_euclid(n) + 1).max(1) as u64
}

struct GetFootprint(Arc<MarketHub>);

#[async_trait]
impl Tool for GetFootprint {
    type Input = GetFootprintInput;
    type Output = FootprintOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_footprint", "Get footprint", RiskTier::Read)
            .description(format!("Footprint bars: per bar, the volume at each price split into sellers hitting the bid and buyers lifting the offer, as rows [price, bidVolume, askVolume, trades] (lowest first; price is the row's floor; trades counts the prints there), plus the bar's volume, delta (ask − bid) and point of control, and stackedImbalances: three or more adjacent rows where buyers lifted at least imbalanceRatio (default 3×) the volume sellers hit one row below, or sellers hit that multiple of what buyers lifted one row above, the imbalanced side holding at least imbalanceMinVolume (default 5) and leading the other side by at least imbalanceMinDifference (default 0); a side against a row the bar traded nothing at (N against 0) counts only with imbalanceIncludeZero (default false), and the bar's own high and low are never compared past it: the rule the chart's footprint draws. Every bar is built from all of its prints, and a bar that touches a gap is left out; truncated says the call read its budget of prints and left older bars out. firstOpen is the open of the oldest bar the answer accounts for, with a footprint or not: ask with to just before it for older bars; null means the connection has no older bar. Timeframe: any count of s, m, h or D (15s 1m 7m 90m 2h 1D 2D); from/to are bar open times; default the latest 20 bars, at most 50 for an agent. rowTicks groups rows (default: the round height that fits the widest bar in 40 rows); an agent's answer holds at most 5000 rows in all, so ask for fewer bars or larger rows, or use market.get_volume_profile, for more. {}", flow::RECORDED_FROM))
            .activity("Built footprint")
            .result_view("table")
            .timeout_ms(90_000)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: GetFootprintInput,
    ) -> Result<FootprintOutput, ToolError> {
        let router = self.0.router();
        let id = resolve(router, &input.instrument).await?;
        let limit = input.limit.unwrap_or(DEFAULT_FOOTPRINTS);
        if limit == 0 || limit > USER_MAX_FOOTPRINTS {
            return Err(ToolError::invalid_input(format!(
                "limit must be 1..={USER_MAX_FOOTPRINTS}"
            )));
        }
        let agent = !ctx.origin.is_user();
        if agent && limit > AGENT_MAX_FOOTPRINTS {
            return Err(ToolError::invalid_input(format!(
                "agents read at most {AGENT_MAX_FOOTPRINTS} footprint bars a call; use a longer timeframe or market.get_volume_profile"
            )));
        }
        let ratio = input.imbalance_ratio.unwrap_or(imbalance::DEFAULT_RATIO);
        if !(1.5..=20.0).contains(&ratio) {
            return Err(ToolError::invalid_input("imbalanceRatio must be 1.5..=20"));
        }
        let min_volume = input
            .imbalance_min_volume
            .unwrap_or(imbalance::DEFAULT_MIN_VOLUME);
        if !(min_volume.is_finite() && min_volume >= 0.0) {
            return Err(ToolError::invalid_input(
                "imbalanceMinVolume must be zero or more",
            ));
        }
        let min_difference = input
            .imbalance_min_difference
            .unwrap_or(imbalance::DEFAULT_MIN_DIFFERENCE);
        if !(min_difference.is_finite() && min_difference >= 0.0) {
            return Err(ToolError::invalid_input(
                "imbalanceMinDifference must be zero or more",
            ));
        }
        let rule = imbalance::Rule {
            ratio,
            min_volume,
            min_difference,
            include_zero: input.imbalance_include_zero.unwrap_or(false),
        };
        let asked_rows = input.row_ticks.map(check_row_ticks).transpose()?;
        let days = DaysToLoad::of(input.days_to_load)?;
        let provider = router.route_async(&id).await.map_err(market_error)?;
        let caps = effective(provider.capabilities());
        if !caps.footprint {
            return Err(ToolError::unsupported(format!(
                "{} offers no prints for {id}",
                provider.id()
            )));
        }
        let (_, spec) = provider.spec(&id).await.map_err(market_error)?;
        refuse_index(&id, &spec)?;
        let tick = spec.tick_size.0;
        let series = router
            .bars_from(
                &provider,
                BarsRequest {
                    instrument: id.clone(),
                    tf: input.tf,
                    from: input.from,
                    to: input.to,
                    limit: Some(limit as usize),
                    rth_only: false,
                },
                Read::Recent,
            )
            .await
            .map_err(market_error)?;
        let ticks = |p: Price| {
            if tick.is_zero() {
                0
            } else {
                (p.0 / tick).round().to_i64().unwrap_or(0)
            }
        };
        let ranges: Vec<(i64, i64)> = series
            .bars
            .iter()
            .map(|b| (ticks(b.l), ticks(b.h)))
            .collect();
        let widest = ranges.iter().map(|(l, h)| h - l + 1).max().unwrap_or(1);
        let row_ticks = asked_rows
            .unwrap_or_else(|| auto_row_ticks(widest, FOOTPRINT_AUTO_ROWS).min(MAX_ROW_TICKS));
        let row_ticks = if agent {
            check_footprint_cells(&ranges, row_ticks, AGENT_MAX_FOOTPRINT_CELLS, &id)?;
            row_ticks
        } else {
            fitting_row_ticks(&ranges, row_ticks, USER_MAX_FOOTPRINT_CELLS)
        };
        let row = Price(tick * Decimal::from(row_ticks));
        let opens: Vec<_> = series.bars.iter().map(|b| b.t).collect();
        let _recording = self.0.linger_as(PumpKey::Trades(id.clone()), asker(ctx));
        let ask = flow::BarsAsk {
            provider: provider.id(),
            id: &id,
            tf: input.tf,
            calendar: spec.sessions,
            tick: spec.tick_size,
            row_ticks: Some(row_ticks),
            base_ticks: base_row_ticks(row_ticks, widest),
            now: ctx.now,
            budget: flow::MAX_BAR_PRINTS,
            pulls: days.pulls(spec.sessions, ctx.now),
        };
        let built = flow::footprint_bars(&self.0, &ask, &opens).await?;
        let window = opens.first().zip(opens.last()).map(|(first, last)| {
            let floor = days.floor(spec.sessions, ctx.now);
            let from = bar_range(spec.sessions, input.tf, *first).0.max(floor);
            let to = bar_range(spec.sessions, input.tf, *last).1.min(ctx.now);
            tessera_store::ticks::Span::new(from.0, to.0)
        });
        let loaded = window.map_or_else(PrintsLoaded::default, |w| {
            loaded(
                spec.sessions,
                &built.gaps,
                w,
                self.0.refused(&id) && !built.filling,
            )
        });
        let bars = built.bars;
        let stacked_imbalances = bars
            .iter()
            .flat_map(|b| {
                let found = imbalance::imbalances(b, &rule);
                imbalance::stacks(b, &found, imbalance::STACK_ROWS)
                    .into_iter()
                    .map(|s| StackedImbalance {
                        t: b.t,
                        side: s.side,
                        low: s.low,
                        high: s.high,
                        rows: s.rows,
                    })
            })
            .collect();
        Ok(FootprintOutput {
            imbalance_ratio: ratio,
            imbalance_min_volume: min_volume,
            imbalance_min_difference: min_difference,
            imbalance_include_zero: rule.include_zero,
            stacked_imbalances,
            instrument: id,
            tf: input.tf,
            price_decimals: spec.price_decimals,
            row,
            last_bar_open: series.last_bar_open
                && bars
                    .last()
                    .zip(series.bars.last())
                    .is_some_and(|(b, s)| b.t == s.t),
            bars: bars.iter().map(CompactFootprint::from).collect(),
            truncated: built.truncated,
            gaps: built.gaps.wire(),
            filling: built.filling,
            loaded,
            first_open: built.first_open,
            provider: provider.id().to_owned(),
        })
    }

    fn summarize(&self, out: &FootprintOutput) -> Option<String> {
        let known = if out.gaps.is_empty() {
            String::new()
        } else {
            format!(" · {} gaps in the tick history", out.gaps.len())
        };
        Some(format!(
            "{} footprint bars · {} {}{known}",
            out.bars.len(),
            out.instrument,
            out.tf
        ))
    }
}

const ROW_MULTIPLES: [u32; 21] = [
    1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1_000, 2_000, 2_500, 5_000, 10_000, 20_000,
    25_000, 50_000, 100_000,
];

fn footprint_cells(ranges: &[(i64, i64)], row_ticks: u32) -> u64 {
    ranges.iter().map(|&(l, h)| rows_of(l, h, row_ticks)).sum()
}

fn fitting_row_ticks(ranges: &[(i64, i64)], finest: u32, cap: u64) -> u32 {
    ROW_MULTIPLES
        .iter()
        .map(|k| finest.saturating_mul(*k).min(MAX_ROW_TICKS))
        .find(|&n| n == MAX_ROW_TICKS || footprint_cells(ranges, n) <= cap)
        .unwrap_or(MAX_ROW_TICKS)
}

fn check_footprint_cells(
    ranges: &[(i64, i64)],
    row_ticks: u32,
    cap: u64,
    id: &InstrumentId,
) -> Result<(), ToolError> {
    let cells = footprint_cells(ranges, row_ticks);
    if cells <= cap {
        return Ok(());
    }
    let span: i64 = ranges.iter().map(|(l, h)| h - l + 1).sum();
    let fits = auto_row_ticks(
        span,
        cap.saturating_sub(2 * ranges.len() as u64).max(1) as u32,
    );
    Err(ToolError::invalid_input(format!(
        "{} bars of {id} at rows of {row_ticks} ticks would hold up to {cells} rows; an answer holds at most {cap}: set rowTicks to {fits} or more, ask for fewer bars, or use market.get_volume_profile",
        ranges.len()
    )))
}

pub const DEFAULT_DEPTH_SPAN_NS: i64 = 30 * NANOS_PER_MINUTE;
pub const DEFAULT_DEPTH_LEVELS: u32 = 10;
pub const MAX_DEPTH_LEVELS: u32 = 50;

struct GetDepthHistory(Arc<MarketHub>);

#[async_trait]
impl Tool for GetDepthHistory {
    type Input = GetDepthHistoryInput;
    type Output = DepthHistoryOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_depth_history", "Get depth history", RiskTier::Read)
            .description("The recorded resting book, one column a second: each price's time-weighted mean resting size over the second (a level that flickered for milliseconds weighs milliseconds) and how many times its size fell. Answers per price over [from, to): meanSize (over the recorded time, absent counting as zero), maxSize (largest one-second mean), decreases (fills and cancels alike: a count, not a reading of intent) and presence, the top N bids and asks by mean. The recorder only moves forward: recordedFrom says from when anything is known, recordedMs how much of the span a book covered; nothing before is ever filled in. Only instruments whose book has been watched are recorded (the last five sessions are kept); asking starts recording.")
            .activity("Loaded depth history")
            .result_view("table")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: GetDepthHistoryInput,
    ) -> Result<DepthHistoryOutput, ToolError> {
        let router = self.0.router();
        let id = resolve(router, &input.instrument).await?;
        let top = input.top.unwrap_or(DEFAULT_DEPTH_LEVELS);
        if top == 0 || top > MAX_DEPTH_LEVELS {
            return Err(ToolError::invalid_input(format!(
                "top must be 1..={MAX_DEPTH_LEVELS}"
            )));
        }
        let provider = router.route_async(&id).await.map_err(market_error)?;
        let caps = provider.capabilities();
        if caps.depth_levels.is_none() {
            return Err(ToolError::unsupported(format!(
                "{} offers no depth for {id}",
                provider.id()
            )));
        }
        let (_, spec) = provider.spec(&id).await.map_err(market_error)?;
        let to = input.to.unwrap_or(ctx.now);
        let from = input
            .from
            .unwrap_or(Timestamp(to.0 - DEFAULT_DEPTH_SPAN_NS));
        if from >= to {
            return Err(ToolError::invalid_input("from must be before to"));
        }
        let _recording = self
            .0
            .linger_as(PumpKey::Book(id.clone()), asker(ctx))
            .map_err(market_error)?;
        let span = self.0.depth_history(&id, from.0, to.0).await;
        let tick = span.tick.unwrap_or(spec.tick_size.0);
        let tick_f = tick.to_f64().unwrap_or(f64::NAN);
        let (lo, hi) = depth_history::tick_range(tick_f, input.price_from, input.price_to);
        let in_range = |t: i64| t >= lo && t <= hi;
        let (stats, known) = depth_history::level_stats(&span.columns, span.end, from.0, to.0);
        let price = |t: i64| {
            let mut d = Decimal::from(t) * tick;
            d.rescale(tick.scale());
            d.to_f64().unwrap_or(f64::NAN)
        };
        let mut out = DepthHistoryOutput {
            instrument: id.clone(),
            price_decimals: spec.price_decimals,
            tick: tick_f,
            from,
            to,
            recorded_from: span.recorded_from.map(Timestamp),
            recording: span.recording,
            recorded_ms: (known / 1_000_000).max(0) as u64,
            bids: Vec::new(),
            asks: Vec::new(),
            provider: provider.id().to_owned(),
        };
        let round = |v: f64| (v * 100.0).round() / 100.0;
        for s in stats.iter().filter(|s| in_range(s.tick)) {
            let side = if s.bid { &mut out.bids } else { &mut out.asks };
            if side.len() >= top as usize {
                continue;
            }
            side.push(DepthLevelStat {
                price: price(s.tick),
                side: if s.bid {
                    RestingSide::Bid
                } else {
                    RestingSide::Ask
                },
                mean_size: round(s.mean),
                max_size: round(s.max),
                decreases: s.decreases,
                presence: if known > 0 {
                    round(s.present as f64 / known as f64)
                } else {
                    0.0
                },
            });
        }
        Ok(out)
    }

    fn summarize(&self, out: &DepthHistoryOutput) -> Option<String> {
        Some(format!(
            "{} bids, {} asks · {}",
            out.bids.len(),
            out.asks.len(),
            out.instrument
        ))
    }
}

const DEPTH_SIZING: TopicSizing = TopicSizing {
    capacity: 2048,
    replay: 0,
};

const FOOTPRINT_SIZING: TopicSizing = TopicSizing {
    capacity: 256,
    replay: 0,
};

pub fn refusal(e: MarketError, code: i32) -> RpcError {
    let code = match &e {
        MarketError::Unavailable(_) => codes::UNAVAILABLE,
        _ => code,
    };
    RpcError::new(code, e.to_string())
}

fn unsupported(e: MarketError) -> RpcError {
    refusal(e, codes::UNSUPPORTED)
}

async fn resolve_param(hub: &MarketHub, input: &str) -> Result<InstrumentId, RpcError> {
    hub.router()
        .resolve(input)
        .await
        .map_err(|e| refusal(e, codes::INVALID_PARAMS))
}

async fn resolve_all(hub: &MarketHub, inputs: &[String]) -> Result<Vec<InstrumentId>, RpcError> {
    if inputs.is_empty() {
        return Err(RpcError::new(
            codes::INVALID_PARAMS,
            "instruments must not be empty",
        ));
    }
    let mut out = Vec::with_capacity(inputs.len());
    for s in inputs {
        out.push(resolve_param(hub, s).await?);
    }
    Ok(out)
}

struct QuotesTopic(Arc<MarketHub>);

#[async_trait]
impl TopicHandler for QuotesTopic {
    fn name(&self) -> &'static str {
        names::MARKET_QUOTES
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::MARKET
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: InstrumentsParams = parse_params(params)?;
        let ids = resolve_all(&self.0, &p.instruments).await?;
        let mut sub = Subscribed::new(KeyFilter::Instruments(ids.iter().cloned().collect()));
        for id in &ids {
            sub = sub.keep(
                self.0
                    .acquire(PumpKey::Quotes(id.clone()))
                    .map_err(unsupported)?,
            );
        }
        let router = self.0.router();
        let quotes = futures::future::join_all(
            ids.iter()
                .map(|id| tokio::time::timeout(QUOTE_SNAPSHOT_WAIT, router.quote(id))),
        )
        .await;
        for q in quotes.into_iter().flatten().flatten() {
            sub = sub.snapshot(&q);
        }
        Ok(sub)
    }
}

struct TradesTopic(Arc<MarketHub>);

#[async_trait]
impl TopicHandler for TradesTopic {
    fn name(&self) -> &'static str {
        names::MARKET_TRADES
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::MARKET
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: InstrumentsParams = parse_params(params)?;
        let ids = resolve_all(&self.0, &p.instruments).await?;
        let mut sub = Subscribed::new(KeyFilter::Instruments(ids.iter().cloned().collect()));
        for id in &ids {
            sub = sub
                .keep(
                    self.0
                        .linger(PumpKey::Trades(id.clone()))
                        .map_err(unsupported)?,
                )
                .keep(
                    self.0
                        .acquire(PumpKey::Trades(id.clone()))
                        .map_err(unsupported)?,
                );
            match self.0.trades_snapshot(id).await {
                Ok(snap) => sub = sub.snapshot(&snap),
                Err(e) => tracing::debug!(%id, error = %e, "no trades snapshot"),
            }
        }
        Ok(sub)
    }
}

struct BarsTopic(Arc<MarketHub>);

#[async_trait]
impl TopicHandler for BarsTopic {
    fn name(&self) -> &'static str {
        names::MARKET_BARS
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::MARKET
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: BarsParams = parse_params(params)?;
        let id = resolve_param(&self.0, &p.instrument).await?;
        let (source, caps) = self
            .0
            .router()
            .capabilities_for(&id)
            .await
            .map_err(unsupported)?;
        if !caps.serves_live(p.tf) {
            return Err(RpcError::new(
                codes::UNSUPPORTED,
                format!("{} offers no live {} bars for {id}", source.provider, p.tf),
            ));
        }
        let guard = self
            .0
            .acquire(PumpKey::Bars(id.clone(), p.tf))
            .map_err(unsupported)?;
        Ok(Subscribed::new(KeyFilter::Bars(id, p.tf)).keep(guard))
    }
}

struct HistoryTopic(Arc<MarketHub>);

#[async_trait]
impl TopicHandler for HistoryTopic {
    fn name(&self) -> &'static str {
        names::MARKET_HISTORY
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: BarsParams = parse_params(params)?;
        let id = resolve_param(&self.0, &p.instrument).await?;
        let filter = KeyFilter::Instruments([id.clone()].into_iter().collect());
        let router = self.0.router();
        let Some(cache) = router.bar_cache() else {
            return Ok(
                Subscribed::new(filter).snapshot(&history_update(HistoryKept {
                    instrument: id,
                    from: None,
                    to: None,
                    filling: false,
                })),
            );
        };
        let bus = Arc::clone(self.0.bus());
        let publish: crate::history::Publish = Arc::new(move |kept: HistoryKept| {
            let key = TopicKey::Instrument(kept.instrument.clone());
            bus.publish(names::MARKET_HISTORY, key, &history_update(kept));
        });
        let guard = cache.fill(router, &id, p.tf, publish);
        let mut kept = cache.kept_now(router, &id).await;
        kept.filling |= guard.is_some();
        let mut sub = Subscribed::new(filter).snapshot(&history_update(kept));
        if let Some(g) = guard {
            sub = sub.keep(g);
        }
        Ok(sub)
    }
}

fn history_update(k: HistoryKept) -> HistoryUpdate {
    HistoryUpdate {
        instrument: k.instrument,
        from: k.from,
        to: k.to,
        filling: k.filling,
    }
}

struct DepthTopic(Arc<MarketHub>);

#[async_trait]
impl TopicHandler for DepthTopic {
    fn name(&self) -> &'static str {
        names::MARKET_DEPTH
    }

    fn sizing(&self) -> TopicSizing {
        DEPTH_SIZING
    }

    fn offered(&self) -> bool {
        self.0.router().capabilities().depth_levels.is_some()
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: DepthParams = parse_params(params)?;
        let id = resolve_param(&self.0, &p.instrument).await?;
        let max = depth_of(&self.0, &id).await?;
        let levels = p.levels.unwrap_or(max).clamp(1, max.max(1));
        let recording = self
            .0
            .linger(PumpKey::Book(id.clone()))
            .map_err(unsupported)?;
        let guard = self
            .0
            .acquire(PumpKey::Depth(id.clone(), levels))
            .map_err(unsupported)?;
        let hub = Arc::clone(&self.0);
        let book = id.clone();
        let mut sub = Subscribed::new(KeyFilter::Depth(id.clone(), levels))
            .resync(move || hub.depth_snapshot(&book, levels))
            .keep(recording)
            .keep(guard);
        if let Some(snap) = self.0.depth_snapshot(&id, levels) {
            sub = sub.snapshot(&snap);
        }
        Ok(sub)
    }
}

async fn depth_of(hub: &MarketHub, id: &InstrumentId) -> Result<u32, RpcError> {
    let (source, caps) = hub
        .router()
        .capabilities_for(id)
        .await
        .map_err(unsupported)?;
    caps.depth_levels.ok_or_else(|| {
        RpcError::new(
            codes::UNSUPPORTED,
            format!("{} offers no depth for {id}", source.provider),
        )
    })
}

struct FootprintTopic(Arc<MarketHub>);

#[async_trait]
impl TopicHandler for FootprintTopic {
    fn name(&self) -> &'static str {
        names::MARKET_FOOTPRINT
    }

    fn sizing(&self) -> TopicSizing {
        FOOTPRINT_SIZING
    }

    fn offered(&self) -> bool {
        self.0.router().capabilities().footprint
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: FootprintParams = parse_params(params)?;
        let id = resolve_param(&self.0, &p.instrument).await?;
        let (source, caps) = self
            .0
            .router()
            .capabilities_for(&id)
            .await
            .map_err(unsupported)?;
        if !caps.footprint {
            return Err(RpcError::new(
                codes::UNSUPPORTED,
                format!("{} offers no footprint for {id}", source.provider),
            ));
        }
        let rows = p.row_ticks.unwrap_or(1);
        if rows == 0 || rows > MAX_ROW_TICKS {
            return Err(RpcError::new(
                codes::INVALID_PARAMS,
                format!("rowTicks must be 1..={MAX_ROW_TICKS}"),
            ));
        }
        let guard = self
            .0
            .acquire(PumpKey::Footprint(id.clone(), p.tf, rows))
            .map_err(unsupported)?;
        let mut sub = Subscribed::new(KeyFilter::Id(footprint_key(&id, p.tf, rows))).keep(guard);
        if caps.order_flow()
            && let Ok(recording) = self.0.linger(PumpKey::Trades(id.clone()))
        {
            sub = sub.keep(recording);
        }
        if let Some(snap) = self.0.footprint_snapshot(&id, p.tf, rows) {
            sub = sub.snapshot(&snap);
        }
        Ok(sub)
    }
}
