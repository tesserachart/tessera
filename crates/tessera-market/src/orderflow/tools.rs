use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::NaiveDate;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use tessera_core::instrument::ContractSpec;
use tessera_core::market::{Aggressor, AggressorSource, Bar, FootprintBar, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_DAY, NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Price, Qty, Timeframe, Timestamp};
use tessera_host::ByteLru;
use tessera_protocol::compact::CompactTrade;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{Tool, ToolCtx, ToolError, ToolMeta};

use super::bars::CLOSE_GRACE;
use super::big_trades::{
    AggressorOrder, BigFilter, BigTradeModel, CONTINUATION_NS, Closed, Contract, EventCloser,
    FOLLOW_NS, Grouping, MIN_MODEL_MINUTES, MIN_NOTIONAL, MIN_REACH_TICKS, MODEL_SESSIONS,
    ModelBuilder, ModelCoverage, OrderAggregator, OutcomeWatch, TIERS, floor_of, manual_min_of,
    per_session, to_wire,
};
use super::delta::{CumulativeDelta, DeltaReset};
use super::loaded::{DaysToLoad, loaded};
use super::periods::{PeriodSpan, Piece, range_pieces, recent_periods};
use super::print_bars::{FlowBar, PRINT_BAR_SIZE_MAX, PrintBarBuilder, PrintBars};
use super::profile::{DEFAULT_VALUE_AREA, ProfileBuilder, VolumeProfile, auto_row_ticks};
use super::tpo::{MAX_TPO_MINUTES, TpoClock, TpoProfile, tpo_clock, tpo_profile};
use crate::aggregate::{FootprintBuilder, bar_range, regroup};
use crate::hub::{CHUNK, Gaps, MarketHub, Pulls, PumpKey, Read};
use crate::io::{
    BigTrade, BigTradeMode, BigTradeOutcome, BigTradeRule, BigTradeThreshold, BigTradeTier,
    BigTradeTierCounts, BigTradesOutput, CompactDeltaBar, CompactProfileRow, DeltaBasis,
    DeltaOutput, GetBigTradesInput, GetDeltaInput, GetVolumeProfileInput, PrintsLoaded,
    ProfileMode, ProfileOutput, ProfilePeriod, SessionFilter, VolumeProfileOutput,
};
use crate::io::{CompactTpoBracket, TpoOutput};
use crate::module::{MAX_ROW_TICKS, asker, market_error, refuse_index};
use crate::provider::{BarsRequest, MarketDataProvider};

pub const MAX_BAR_PRINTS: u64 = 5_000_000;

pub const RECORDED_FROM: &str = "For a connection that keeps no trade history (Rithmic), the prints are what the hub records and saves: it records every market on the user's watchlists for as long as Tessera is open (setting market.recordWatchlists, on by default) and any other instrument while a chart on the desk shows it (a call keeps it recording for a minute), saves every print with its aggressor side per contract and trade date (the newest 60 sessions by default, setting market.savedTradeSessions), and, in the background, reads the session before that recording back to the session's open, from the saved days first and then from the connection's tick replay. An earlier span is answered from the saved days; while the instrument records, the session time missing there is pulled from the tick replay, newest half hour first, one request at a time, and saved, back to the open of the oldest of the call's daysToLoad sessions (default 2: this session and the one before; older bars are read from the saved days only); loaded says how many of those sessions the answer holds. Every answer covers every print saved or recorded in its span, and gaps lists the spans of session time in it with none (closed hours and weekends are never gaps): nothing there is known, so read a gap as missing history, never as a quiet market; a bar or session that touches a gap is left out or names it. filling (true) means the hub is asking the connection's tick replay for some of those gaps: ask again shortly and they shrink. filling false with gaps left: nothing more is coming for now (the connection refused, or keeps nothing that old); a span the connection refused, and anything older, is not asked for again before the next session, even after a restart, and loaded.refused says so.";

pub const DEFAULT_PROFILE_ROWS: u32 = 60;
pub const MAX_PROFILE_ROWS: u32 = 500;
pub const MAX_FIXED_ROWS: u32 = 4000;
pub const SETTLE_NS: i64 = 2 * NANOS_PER_SEC;
const MAX_OPEN_PIECES: usize = 64;
const PROFILE_CACHE_BYTES: usize = 48 << 20;

pub const DEFAULT_BIG_TRADES_SPAN: i64 = 60 * NANOS_PER_MINUTE;
pub const MAX_BIG_TRADES_SPAN: i64 = NANOS_PER_DAY;
pub const DEFAULT_BIG_TRADES: u32 = 50;
pub const MAX_BIG_TRADES: u32 = 5000;

pub const DEFAULT_DELTA_BARS: u32 = 100;
pub const MAX_DELTA_BARS: u32 = 1000;

struct Subject {
    id: InstrumentId,
    provider: Arc<dyn MarketDataProvider>,
    spec: ContractSpec,
}

impl Subject {
    async fn resolve(hub: &MarketHub, instrument: &str) -> Result<Self, ToolError> {
        let router = hub.router();
        let id = router.resolve(instrument).await.map_err(market_error)?;
        let provider = router.route_async(&id).await.map_err(market_error)?;
        let (_, spec) = provider.spec(&id).await.map_err(market_error)?;
        Ok(Self { id, provider, spec })
    }

    fn needs_prints(&self) -> Result<(), ToolError> {
        refuse_index(&self.id, &self.spec)?;
        let caps = self.provider.capabilities();
        if caps.trades || caps.footprint {
            return Ok(());
        }
        Err(ToolError::unsupported(format!(
            "{} offers no prints for {}",
            self.provider.id(),
            self.id
        )))
    }
}

async fn each_print(
    hub: &MarketHub,
    id: &InstrumentId,
    from: Timestamp,
    to: Timestamp,
    f: impl FnMut(&Trade),
) -> Result<Read, ToolError> {
    hub.each_print(id, from, to, f).await.map_err(market_error)
}

async fn each_held_print(
    hub: &MarketHub,
    id: &InstrumentId,
    from: Timestamp,
    to: Timestamp,
    f: impl FnMut(&Trade),
) -> Result<Read, ToolError> {
    hub.each_held_print(id, from, to, f)
        .await
        .map_err(market_error)
}

fn stretch(from: Timestamp, to: Timestamp) -> tessera_store::ticks::Span {
    tessera_store::ticks::Span::new(from.0, to.0)
}

#[derive(Debug, Default)]
pub(crate) struct BuiltBars {
    pub bars: Vec<FootprintBar>,
    pub truncated: bool,
    pub aggressor_source: Option<AggressorSource>,
    pub gaps: Gaps,
    pub filling: bool,
    pub first_open: Option<Timestamp>,
    pub unread: usize,
}

pub(crate) struct BarsAsk<'a> {
    pub provider: &'a str,
    pub id: &'a InstrumentId,
    pub tf: Timeframe,
    pub calendar: SessionCalendar,
    pub tick: Price,
    pub row_ticks: Option<u32>,
    pub base_ticks: u32,
    pub now: Timestamp,
    pub budget: u64,
    pub pulls: Pulls,
}

pub(crate) async fn footprint_bars(
    hub: &MarketHub,
    ask: &BarsAsk<'_>,
    opens: &[Timestamp],
) -> Result<BuiltBars, ToolError> {
    let cache = hub.closed_bars();
    let row = |ticks: u32| Price(ask.tick.0 * Decimal::from(ticks));
    let shape = |base: u32, bar: Arc<FootprintBar>| match ask.row_ticks {
        Some(r) if r != base => regroup(&bar, row(r)),
        _ => Arc::unwrap_or_clone(bar),
    };
    let range = |t: Timestamp| bar_range(ask.calendar, ask.tf, t);
    let kept: Vec<_> = opens
        .iter()
        .map(|t| cache.get(ask.provider, ask.id, ask.tf, *t, ask.row_ticks))
        .collect();
    let mut bars_out: Vec<FootprintBar> = Vec::new();
    let mut out = BuiltBars::default();
    let mut read = 0u64;
    let mut hi = opens.len();
    while hi > 0 {
        if let Some((base, bar)) = &kept[hi - 1] {
            out.aggressor_source = out.aggressor_source.or(Some(bar.aggressor_source));
            bars_out.push(shape(*base, Arc::clone(bar)));
            hi -= 1;
            continue;
        }
        if read >= ask.budget {
            out.truncated = true;
            out.unread = hi;
            break;
        }
        let end = range(opens[hi - 1]).1;
        let mut lo = hi - 1;
        while lo > 0 && kept[lo - 1].is_none() && end.0 - range(opens[lo - 1]).0.0 <= CHUNK {
            lo -= 1;
        }
        let wanted = &opens[lo..hi];
        let start = range(wanted[0]).0;
        let mut b = FootprintBuilder::new(ask.tf, ask.calendar, row(ask.base_ticks));
        let mut bars = Vec::new();
        let r = hub
            .read_prints(ask.id, start, end, ask.pulls, |t| bars.extend(b.push(t)))
            .await
            .map_err(market_error)?;
        bars.extend(b.current());
        bars.retain(|b| wanted.contains(&b.t));
        read += r.prints;
        out.aggressor_source = out.aggressor_source.or(r.aggressor_source);
        bars.retain(|b| {
            let (from, to) = range(b.t);
            !r.gaps.touches(stretch(from, to))
        });
        out.filling |= r.filling;
        out.gaps = std::mem::take(&mut out.gaps).merged(r.gaps);
        for bar in bars.into_iter().rev() {
            let bar = Arc::new(bar);
            if range(bar.t).1.0.saturating_add(CLOSE_GRACE) <= ask.now.0 {
                cache.put(
                    ask.provider,
                    ask.id,
                    ask.tf,
                    ask.base_ticks,
                    Arc::clone(&bar),
                );
            }
            bars_out.push(shape(ask.base_ticks, bar));
        }
        hi = lo;
    }
    bars_out.reverse();
    out.bars = bars_out;
    out.first_open = opens.get(out.unread).copied();
    Ok(out)
}

fn invalid(msg: impl Into<String>) -> ToolError {
    ToolError::invalid_input(msg)
}

pub const PARTIAL_MODEL_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

pub(crate) fn contract_of(
    instrument: &tessera_core::instrument::Instrument,
    spec: &ContractSpec,
) -> Contract {
    let root = instrument.root.as_deref().or(spec.root.as_deref());
    Contract {
        tick: spec.tick_size,
        lot: spec.qty_step.to_f64().max(1e-12),
        floor: floor_of(root),
        multiplier: spec.multiplier.to_f64().unwrap_or(1.0),
        min_notional: MIN_NOTIONAL,
    }
}

pub async fn big_trade_model(
    hub: &MarketHub,
    id: &InstrumentId,
    at: Timestamp,
    grouping: Grouping,
) -> Result<Arc<BigTradeModel>, ToolError> {
    let router = hub.router();
    let provider = router.route_async(id).await.map_err(market_error)?;
    let (instrument, spec) = provider.spec(id).await.map_err(market_error)?;
    let contract = contract_of(&instrument, &spec);
    let calendar = spec.sessions;
    let date = calendar.trade_date(at);
    if let Some(kept) = hub.big_trade_model(provider.id(), id, date, grouping) {
        return Ok(kept);
    }
    let spans = recent_sessions(calendar, at, MODEL_SESSIONS as usize + 1, false);
    let whole: Vec<Span> = spans
        .iter()
        .copied()
        .filter(|s| s.whole && s.to < at)
        .collect();
    let whole = &whole[whole.len().saturating_sub(MODEL_SESSIONS as usize)..];
    let mut builder = ModelBuilder::new(calendar, contract);
    let mut gaps = Gaps::default();
    for span in whole {
        let mut agg = OrderAggregator::new(contract.tick, grouping);
        let read = each_held_print(hub, id, span.from, span.to, |t| {
            builder.add_print(t);
            if let Some(o) = agg.push(t) {
                builder.add(&o);
            }
        })
        .await?;
        if let Some(o) = agg.finish() {
            builder.add(&o);
        }
        gaps = gaps.merged(read.gaps);
    }
    let pulling = match (gaps.is_empty(), whole.first(), whole.last()) {
        (false, Some(first), Some(last)) => hub.pull_missing(id, first.from, last.to).await,
        _ => false,
    };
    let partial = !gaps.is_empty() || whole.is_empty();
    let model = Arc::new(builder.build(date, ModelCoverage { partial, pulling }));
    hub.keep_big_trade_model(
        provider.id(),
        id,
        date,
        grouping,
        Arc::clone(&model),
        partial.then_some(PARTIAL_MODEL_TTL),
    );
    Ok(model)
}

pub async fn big_trade_threshold(
    hub: &MarketHub,
    id: &InstrumentId,
    now: Timestamp,
) -> Result<BigTradeThreshold, ToolError> {
    let router = hub.router();
    let provider = router.route_async(id).await.map_err(market_error)?;
    let (_, spec) = provider.spec(id).await.map_err(market_error)?;
    let model = big_trade_model(hub, id, now, Grouping::default()).await?;
    let last = hub
        .history(id, None, None, Some(1))
        .await
        .ok()
        .and_then(|h| h.trades.last().map(|t| t.price.to_f64()))
        .unwrap_or(0.0);
    let lot = spec.qty_step.to_f64().max(1e-12);
    let size = model.size_at(BigTradeTier::Low, last, lot);
    Ok(BigTradeThreshold {
        size: qty_of_f64(size),
        floor: model.floor,
        orders: model.orders(),
        sessions: model.sessions,
    })
}

fn qty_of_f64(v: f64) -> Qty {
    Qty(Decimal::from_f64_retain(v)
        .unwrap_or_default()
        .round_dp(4)
        .normalize())
}

#[derive(Debug, Default)]
pub struct Rows {
    pub rows: Vec<Row>,
    pub aggressor_source: Option<AggressorSource>,
    pub gaps: Gaps,
    pub filling: bool,
    pub truncated: bool,
}

pub const MAX_ROW_SCAN: usize = 2_000_000;
const ROW_PAGE: usize = 20_000;

pub type Row = (CompactTrade, u32, f64);

pub fn print_row(t: &Trade) -> Row {
    (CompactTrade::from(t), 1, t.price.to_f64())
}

fn order_row(o: &AggressorOrder) -> Row {
    (
        CompactTrade(
            o.t.0,
            o.average_price().to_f64(),
            o.size.to_f64(),
            o.aggressor.sign(),
            o.order_key,
        ),
        o.prints,
        o.last.to_f64(),
    )
}

fn rows_of(prints: &[Trade], tick: Price, min: Option<Qty>, aggregate: bool) -> Vec<Row> {
    let keep = |size: Qty| min.is_none_or(|m| size >= m);
    if !aggregate {
        return prints
            .iter()
            .filter(|t| keep(t.size))
            .map(print_row)
            .collect();
    }
    let mut agg = OrderAggregator::new(tick, Grouping::default());
    let mut out = Vec::new();
    for t in prints {
        if let Some(o) = agg.push(t).filter(|o| keep(o.size)) {
            out.push(order_row(&o));
        }
    }
    if let Some(o) = agg.finish().filter(|o| keep(o.size)) {
        out.push(order_row(&o));
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub async fn trade_rows(
    hub: &MarketHub,
    id: &InstrumentId,
    tick: Price,
    from: Option<Timestamp>,
    to: Option<Timestamp>,
    now: Timestamp,
    limit: usize,
    min: Option<Qty>,
    aggregate: bool,
) -> Result<Rows, ToolError> {
    let mut out = Rows::default();
    if let Some(from) = from {
        let end = to.unwrap_or_else(|| now.add_nanos(tessera_core::time::NANOS_PER_SEC));
        let mut rows: VecDeque<Row> = VecDeque::new();
        let mut agg = OrderAggregator::new(tick, Grouping::default());
        let keep = |size: Qty| min.is_none_or(|m| size >= m);
        let push = |row: Row, rows: &mut VecDeque<_>, cut: &mut bool| {
            rows.push_back(row);
            if rows.len() > limit {
                rows.pop_front();
                *cut = true;
            }
        };
        let mut cut = false;
        let read = hub
            .each_print(id, from, end, |t| {
                if aggregate {
                    if let Some(o) = agg.push(t).filter(|o| keep(o.size)) {
                        push(order_row(&o), &mut rows, &mut cut);
                    }
                } else if keep(t.size) {
                    push(print_row(t), &mut rows, &mut cut);
                }
            })
            .await
            .map_err(market_error)?;
        if let Some(o) = agg.finish().filter(|o| keep(o.size)) {
            push(order_row(&o), &mut rows, &mut cut);
        }
        out.rows = rows.into();
        out.aggressor_source = read.aggressor_source;
        out.gaps = read.gaps;
        out.filling = read.filling;
        out.truncated = cut;
        return Ok(out);
    }
    let mut cursor = to;
    let mut scanned = 0usize;
    let mut pages: Vec<Vec<Row>> = Vec::new();
    let mut found = 0usize;
    loop {
        let h = hub
            .history(id, None, cursor, Some(ROW_PAGE))
            .await
            .map_err(market_error)?;
        if out.aggressor_source.is_none() {
            out.aggressor_source = h.trades.last().map(|t| t.aggressor_source);
        }
        out.gaps = std::mem::take(&mut out.gaps).merged(h.gaps);
        out.filling |= h.filling;
        scanned += h.trades.len();
        let full = h.trades.len() >= ROW_PAGE;
        let mut prints = h.trades;
        if full {
            let keep_from = prints
                .windows(2)
                .position(|w| w[1].ts.0 - w[0].ts.0 > CONTINUATION_NS)
                .map_or(0, |k| k + 1);
            if keep_from < prints.len() {
                prints.drain(..keep_from);
            }
        }
        let next = prints.first().map(|t| t.ts);
        let rows = rows_of(&prints, tick, min, aggregate);
        found += rows.len();
        pages.push(rows);
        if !full || found >= limit || next.is_none() {
            break;
        }
        if scanned >= MAX_ROW_SCAN {
            out.truncated = true;
            break;
        }
        cursor = next;
    }
    let mut rows: Vec<Row> = pages.into_iter().rev().flatten().collect();
    if rows.len() > limit {
        rows.drain(..rows.len() - limit);
    }
    out.rows = rows;
    Ok(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Span {
    from: Timestamp,
    to: Timestamp,
    date: Option<NaiveDate>,
    whole: bool,
    end: Option<Timestamp>,
}

fn recent_sessions(calendar: SessionCalendar, at: Timestamp, n: usize, rth: bool) -> Vec<Span> {
    let mut out = Vec::with_capacity(n);
    let mut date = calendar.trade_date(at);
    if !calendar.is_trade_date(date) {
        date = calendar.prev_trade_date(date);
    }
    for _ in 0..(n * 4 + 8) {
        if out.len() == n {
            break;
        }
        if let Some(s) = calendar.session(date) {
            let (start, end) = match (rth, s.rth) {
                (true, Some(w)) => (w.start, w.end),
                _ => (s.open, s.close),
            };
            if start <= at {
                out.push(Span {
                    from: start,
                    to: end.min(at),
                    date: Some(date),
                    whole: end <= at,
                    end: Some(end),
                });
            }
        }
        date = calendar.prev_trade_date(date);
    }
    out.reverse();
    out
}

type PieceKey = (String, InstrumentId, Timestamp, Timestamp);
type OpenKey = (String, InstrumentId, Timestamp);

struct OpenPiece {
    read_to: Timestamp,
    builder: Arc<ProfileBuilder>,
}

#[derive(Clone, Debug)]
struct Wanted {
    from: Timestamp,
    to: Timestamp,
    date: Option<NaiveDate>,
    end: Option<Timestamp>,
    pieces: Vec<Piece>,
}

impl From<PeriodSpan> for Wanted {
    fn from(p: PeriodSpan) -> Self {
        Self {
            from: p.from,
            to: p.to,
            date: Some(p.date),
            end: Some(p.end),
            pieces: p.pieces,
        }
    }
}

struct Measured {
    builder: Arc<ProfileBuilder>,
    gaps: Gaps,
    filling: bool,
}

pub struct GetVolumeProfile {
    hub: Arc<MarketHub>,
    cache: Mutex<ByteLru<PieceKey, Arc<ProfileBuilder>>>,
    open: Mutex<HashMap<OpenKey, OpenPiece>>,
}

impl GetVolumeProfile {
    pub fn new(hub: Arc<MarketHub>) -> Self {
        Self {
            hub,
            cache: Mutex::new(ByteLru::new(PROFILE_CACHE_BYTES)),
            open: Mutex::new(HashMap::new()),
        }
    }

    async fn read_into(
        &self,
        s: &Subject,
        b: &mut ProfileBuilder,
        from: Timestamp,
        to: Timestamp,
        pulls: Pulls,
        source: &mut Option<AggressorSource>,
    ) -> Result<Read, ToolError> {
        if to <= from {
            return Ok(Read::default());
        }
        let read = self
            .hub
            .read_prints(&s.id, from, to, pulls, |t| b.push_trade(t))
            .await
            .map_err(market_error)?;
        *source = read.aggressor_source.or(*source);
        Ok(read)
    }

    async fn piece(
        &self,
        s: &Subject,
        p: Piece,
        now: Timestamp,
        pulls: Pulls,
        source: &mut Option<AggressorSource>,
    ) -> Result<Measured, ToolError> {
        let provider = s.provider.id().to_owned();
        let settled = Timestamp(now.0 - SETTLE_NS);
        if p.to <= settled {
            let key = (provider, s.id.clone(), p.from, p.to);
            if let Some(b) = self.cache.lock().get(&key) {
                return Ok(Measured {
                    builder: Arc::clone(b),
                    gaps: Gaps::default(),
                    filling: false,
                });
            }
            let mut b = ProfileBuilder::new(s.spec.tick_size);
            let read = self
                .read_into(s, &mut b, p.from, p.to, pulls, source)
                .await?;
            let b = Arc::new(b);
            if read.gaps.is_empty() {
                let evicted = self.cache.lock().insert(key, Arc::clone(&b));
                drop(evicted);
            }
            return Ok(Measured {
                builder: b,
                gaps: read.gaps,
                filling: read.filling,
            });
        }
        let cut = settled.max(p.from).min(p.to);
        let key = (provider, s.id.clone(), p.from);
        let held = self
            .open
            .lock()
            .get(&key)
            .filter(|o| o.read_to <= cut)
            .map(|o| (o.read_to, Arc::clone(&o.builder)));
        let (read_to, mut b) = match held {
            Some((t, b)) => (t, Arc::unwrap_or_clone(b)),
            None => (p.from, ProfileBuilder::new(s.spec.tick_size)),
        };
        let head = self
            .read_into(s, &mut b, read_to, cut, pulls, source)
            .await?;
        if head.gaps.is_empty() && cut > read_to {
            let mut open = self.open.lock();
            if open.len() >= MAX_OPEN_PIECES {
                open.clear();
            }
            open.insert(
                key,
                OpenPiece {
                    read_to: cut,
                    builder: Arc::new(b.clone()),
                },
            );
        }
        let tail = self.read_into(s, &mut b, cut, p.to, pulls, source).await?;
        Ok(Measured {
            builder: Arc::new(b),
            gaps: head.gaps.merged(tail.gaps),
            filling: head.filling || tail.filling,
        })
    }

    async fn measure(
        &self,
        s: &Subject,
        w: &Wanted,
        now: Timestamp,
        pulls: Pulls,
        source: &mut Option<AggressorSource>,
    ) -> Result<Measured, ToolError> {
        let mut parts = Vec::with_capacity(w.pieces.len());
        for p in &w.pieces {
            parts.push(self.piece(s, *p, now, pulls, source).await?);
        }
        if parts.len() == 1 {
            return Ok(parts.pop().expect("one part"));
        }
        let mut all = ProfileBuilder::new(s.spec.tick_size);
        let mut gaps = Gaps::default();
        let mut filling = false;
        for m in parts {
            all.merge(&m.builder);
            gaps = gaps.merged(m.gaps);
            filling |= m.filling;
        }
        Ok(Measured {
            builder: Arc::new(all),
            gaps,
            filling,
        })
    }
}

fn period_of(mode: ProfileMode, asked: Option<ProfilePeriod>) -> Result<ProfilePeriod, ToolError> {
    match (mode, mode.period(), asked) {
        (ProfileMode::Range, _, Some(_)) => Err(invalid(
            "period is for the period modes and composite; range takes from and to",
        )),
        (ProfileMode::Session, _, Some(p)) => Ok(p),
        (_, Some(m), Some(p)) if m != p => Err(invalid(format!(
            "mode {} already names its period; drop period, or use mode composite to merge {} periods",
            mode.as_str(),
            p.as_str()
        ))),
        (_, Some(m), _) => Ok(m),
        (_, None, p) => Ok(p.unwrap_or_default()),
    }
}

fn tpo_output(t: TpoProfile) -> TpoOutput {
    let price = |tick: Price, i: i64| {
        let mut d = Decimal::from(i) * tick.0;
        d.rescale(tick.0.scale());
        Price(d)
    };
    let tick = t.tick;
    TpoOutput {
        minutes: t.minutes,
        brackets: t
            .brackets
            .iter()
            .map(|b| CompactTpoBracket(b.start, b.letter, price(tick, b.low), price(tick, b.high)))
            .collect(),
        poc: t.poc,
        vah: t.vah,
        val: t.val,
        ib_from: t.ib_from,
        ib_high: t.ib_high,
        ib_low: t.ib_low,
    }
}

fn profile_output(
    vp: &VolumeProfile,
    from: Timestamp,
    to: Timestamp,
    date: Option<NaiveDate>,
    session_end: Option<Timestamp>,
    gaps: &Gaps,
    tpo: Option<TpoOutput>,
) -> ProfileOutput {
    ProfileOutput {
        from,
        to,
        session_end,
        trade_date: date,
        row: vp.row,
        poc: vp.poc,
        vah: vp.value_area.map(|v| v.high),
        val: vp.value_area.map(|v| v.low),
        value_area_volume: vp.value_area.map_or(Qty::ZERO, |v| v.volume),
        volume: vp.volume,
        buy_volume: vp.buy,
        sell_volume: vp.sell,
        delta: vp.delta(),
        high: vp.high,
        low: vp.low,
        tpo,
        prints: vp.prints,
        first_print: vp.first,
        last_print: vp.last,
        gaps: gaps.wire(),
        rows: vp
            .rows
            .iter()
            .map(|r| CompactProfileRow(r.price, r.volume, r.buy, r.sell))
            .collect(),
    }
}

#[async_trait]
impl Tool for GetVolumeProfile {
    type Input = GetVolumeProfileInput;
    type Output = VolumeProfileOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_volume_profile", "Get volume profile", RiskTier::Read)
            .description(format!("Volume profile measured from the instrument's prints: the volume traded at each price over a span, with the point of control (poc: the row with the most volume), the value area (val–vah: the band around the poc holding valueAreaPercent of the volume, default 70%), total, buy and sell volume and delta. One call answers each of these. Per period, one profile each for the newest `count` (default 1, no upper limit) on the instrument's trading calendar: mode session (default; for CME futures a session opens the evening before its trade date), day (a calendar day in the exchange's time zone, midnight to midnight), week (the sessions whose trade dates fall in one Monday-to-Sunday week, so NQ's opens Sunday evening) or month (the sessions of one calendar month's trade dates): the weekly profile of NQ is {{instrument: \"NQ\", mode: \"week\"}}, last week and this one {{mode: \"week\", count: 2}}. composite: the newest `count` periods (default 5) merged into one, the period given by `period` (session, the default, day, week or month), reaching back as far as prints are held (older periods with none are left out): the last three weeks together are {{mode: \"composite\", period: \"week\", count: 3}}, a 13-week rolling composite {{mode: \"composite\", period: \"week\", count: 13}}. range: from–to, any span (a chart's visible range, a fixed range from one bar to another: {{mode: \"range\", from, to}}; without to, an anchored profile from `from` to now). session: \"rth\" keeps each session's regular hours only, in every mode. Whole sessions are measured once and kept, so a long range or a month answers from them and reads only its edges anew. Rows [price, volume, buyVolume, sellVolume] at each row's floor price, lowest first, at most maxRows (default 60; rowTicks fixes the row height, given as row, coarsened only past 4,000 rows): so poc is the floor of the busiest row (it spans poc to poc + row − one tick), while val/vah are the lowest and highest prices the value area covers and high/low the exact traded extremes. to sets the newest period (default now); a period still trading ends at the time read, its scheduled end in sessionEnd; tradeDate is the session's date, the day, or the first trade date of the week or month. provider names the connection. gaps on a profile: the session time within it with no prints known; the profile measures every other print, so with gaps it is not the whole span's. tpoMinutes (30 is the classic) also counts each profile in time, as a Market Profile: tpo.brackets [start, letter, low, high] (letter 0 is A, counted from each session's open and starting again at the next), the TPO poc, vah and val (by how many brackets traded at each row) and the initial balance (ibHigh, ibLow: the first hour from the regular open); the market_profile layer draws them. To draw one on a chart rather than read it, add a volume_profile layer (chart.add_layer, inputs.period session, day, week, month, composite, range or anchored); chart.get_state's viewport.profiles then lists each profile the chart drew with its POC. {RECORDED_FROM}"))
            .activity("Built volume profile")
            .result_view("table")
            .timeout_ms(90_000)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: GetVolumeProfileInput,
    ) -> Result<VolumeProfileOutput, ToolError> {
        let s = Subject::resolve(&self.hub, &input.instrument).await?;
        s.needs_prints()?;
        let mode = input.mode.unwrap_or_default();
        let pct = input
            .value_area_percent
            .unwrap_or(DEFAULT_VALUE_AREA * 100.0);
        if !(1.0..=99.0).contains(&pct) {
            return Err(invalid("valueAreaPercent must be 1..=99"));
        }
        let max_rows = input.max_rows.unwrap_or(DEFAULT_PROFILE_ROWS);
        if max_rows == 0 || max_rows > MAX_PROFILE_ROWS {
            return Err(invalid(format!("maxRows must be 1..={MAX_PROFILE_ROWS}")));
        }
        if input.row_ticks.is_some_and(|n| n == 0 || n > MAX_ROW_TICKS) {
            return Err(invalid(format!("rowTicks must be 1..={MAX_ROW_TICKS}")));
        }
        if input
            .tpo_minutes
            .is_some_and(|n| n == 0 || n > MAX_TPO_MINUTES)
        {
            return Err(invalid(format!("tpoMinutes must be 1..={MAX_TPO_MINUTES}")));
        }
        let to = input.to.unwrap_or(ctx.now).min(ctx.now);
        let rth = input.session == Some(SessionFilter::Rth);
        let count = match (input.count, input.sessions) {
            (Some(a), Some(b)) if a != b => {
                return Err(invalid(
                    "count and sessions are one setting (sessions is its older name); give one",
                ));
            }
            (a, b) => a.or(b),
        };
        let period = period_of(mode, input.period)?;
        let days = DaysToLoad::of(input.days_to_load)?;
        let pulls = days.pulls(s.spec.sessions, ctx.now);
        let wanted: Vec<Wanted> = match mode {
            ProfileMode::Range => {
                let from = input.from.ok_or_else(|| invalid("range mode needs from"))?;
                if from >= to {
                    return Err(invalid("from must be before to"));
                }
                vec![Wanted {
                    from,
                    to,
                    date: None,
                    end: None,
                    pieces: range_pieces(s.spec.sessions, from, to, rth),
                }]
            }
            _ => {
                let default = if mode == ProfileMode::Composite { 5 } else { 1 };
                let n = count.unwrap_or(default);
                if n == 0 {
                    return Err(invalid("count must be 1 or more"));
                }
                recent_periods(s.spec.sessions, period, to, n as usize, rth)
                    .into_iter()
                    .map(Wanted::from)
                    .collect()
            }
        };
        let _recording = self
            .hub
            .linger_as(PumpKey::Trades(s.id.clone()), asker(ctx));
        let mut source = None;
        let mut built = Vec::with_capacity(wanted.len());
        for w in wanted.iter().rev() {
            let m = self.measure(&s, w, ctx.now, pulls, &mut source).await?;
            let beyond_held = mode == ProfileMode::Composite
                && !built.is_empty()
                && m.builder.prints() == 0
                && !m.filling;
            if beyond_held {
                break;
            }
            built.push(m);
        }
        built.reverse();
        let wanted = &wanted[wanted.len() - built.len()..];
        let row_ticks = |b: &ProfileBuilder| match input.row_ticks {
            Some(n) => n.max(auto_row_ticks(b.span_ticks(), MAX_FIXED_ROWS)),
            None => auto_row_ticks(b.span_ticks(), max_rows),
        };
        let finish = |b: &ProfileBuilder| b.finish(row_ticks(b), pct / 100.0);
        let calendar = s.spec.sessions;
        let tpo = |b: &ProfileBuilder, clock: TpoClock| {
            input
                .tpo_minutes
                .map(|m| tpo_output(tpo_profile(b, &clock, m, row_ticks(b), pct / 100.0)))
        };
        let filling = built.iter().any(|m| m.filling);
        let loaded = match (wanted.first(), wanted.last()) {
            (Some(first), Some(last)) => {
                let floor = days.floor(calendar, ctx.now);
                let window = tessera_store::ticks::Span::new(first.from.max(floor).0, last.to.0);
                let gaps = built
                    .iter()
                    .fold(Gaps::default(), |g, m| g.merged(m.gaps.clone()));
                loaded(calendar, &gaps, window, self.hub.refused(&s.id) && !filling)
            }
            _ => PrintsLoaded::default(),
        };
        let profiles = match mode {
            ProfileMode::Composite => {
                let mut all = ProfileBuilder::new(s.spec.tick_size);
                let mut gaps = Gaps::default();
                for m in built {
                    all.merge(&m.builder);
                    gaps = gaps.merged(m.gaps);
                }
                let (from, to) = (
                    wanted.first().map_or(to, |w| w.from),
                    wanted.last().map_or(to, |w| w.to),
                );
                let clock = TpoClock {
                    balance_from: None,
                    ..tpo_clock(calendar, from, to, rth)
                };
                let tpo = tpo(&all, clock);
                vec![profile_output(
                    &finish(&all),
                    from,
                    to,
                    None,
                    None,
                    &gaps,
                    tpo,
                )]
            }
            _ => wanted
                .iter()
                .zip(&built)
                .map(|(w, m)| {
                    let tpo = tpo(&m.builder, tpo_clock(calendar, w.from, w.to, rth));
                    profile_output(
                        &finish(&m.builder),
                        w.from,
                        w.to,
                        w.date,
                        w.end,
                        &m.gaps,
                        tpo,
                    )
                })
                .collect(),
        };
        Ok(VolumeProfileOutput {
            instrument: s.id.clone(),
            price_decimals: s.spec.price_decimals,
            mode,
            value_area_percent: pct,
            columns: ["price", "volume", "buyVolume", "sellVolume"]
                .map(str::to_owned)
                .to_vec(),
            period: (mode != ProfileMode::Range).then_some(period),
            profiles,
            filling,
            loaded,
            aggressor_source: source,
            provider: s.provider.id().to_owned(),
        })
    }

    fn summarize(&self, out: &VolumeProfileOutput) -> Option<String> {
        let last = out.profiles.last()?;
        let f = |p: Option<Price>| p.map_or_else(|| "—".to_owned(), |p| p.to_string());
        Some(format!(
            "{} · POC {} · VA {}–{}",
            out.instrument,
            f(last.poc),
            f(last.val),
            f(last.vah)
        ))
    }
}

pub struct GetBigTrades(pub Arc<MarketHub>);

struct Newest {
    limit: usize,
    trades: VecDeque<BigTrade>,
    taken: u64,
    watching: Vec<(u64, OutcomeWatch)>,
}

impl Newest {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            trades: VecDeque::with_capacity(limit),
            taken: 0,
            watching: Vec::new(),
        }
    }

    fn first(&self) -> u64 {
        self.taken - self.trades.len() as u64
    }

    fn push(&mut self, t: BigTrade, watch: Option<OutcomeWatch>) {
        if self.trades.len() == self.limit {
            self.trades.pop_front();
        }
        self.trades.push_back(t);
        if let Some(w) = watch {
            self.watching.push((self.taken, w));
        }
        self.taken += 1;
        let first = self.first();
        self.watching.retain(|(n, _)| *n >= first);
    }

    fn settle(&mut self, decide: impl Fn(&OutcomeWatch) -> Option<BigTradeOutcome>) {
        let first = self.first();
        let trades = &mut self.trades;
        self.watching.retain(|(n, w)| match decide(w) {
            Some(outcome) => {
                trades[(n - first) as usize].outcome = Some(outcome);
                false
            }
            None => true,
        });
    }
}

fn filter_of(input: &GetBigTradesInput, contract: &Contract) -> Result<BigFilter, ToolError> {
    let manual = input.min_size.is_some() || input.max_size.is_some();
    if manual && input.tiers.is_some() {
        return Err(invalid(
            "Auto (tiers) or Manual (minSize, maxSize), not both",
        ));
    }
    if manual {
        let lots = |q: Option<Qty>, name: &str| match q {
            Some(q) if q < Qty::ZERO => Err(invalid(format!("{name} is 0 or more lots"))),
            q => Ok(q.filter(|q| !q.is_zero())),
        };
        let min = lots(input.min_size, "minSize")?.unwrap_or_else(|| manual_min_of(contract.floor));
        let max = lots(input.max_size, "maxSize")?;
        if let Some(m) = max.filter(|m| *m < min) {
            return Err(invalid(format!(
                "maxSize {m} is below the {min} lots minSize asks for"
            )));
        }
        return Ok(BigFilter::Manual { min, max });
    }
    let asked = input.tiers.as_deref();
    let tiers: Vec<BigTradeTier> = TIERS
        .into_iter()
        .filter(|t| asked.is_none_or(|a| a.contains(t)))
        .collect();
    if tiers.is_empty() {
        return Err(invalid("tiers names at least one of high, medium, low"));
    }
    Ok(BigFilter::Auto(tiers))
}

#[async_trait]
impl Tool for GetBigTrades {
    type Input = GetBigTradesInput;
    type Output = BigTradesOutput;

    fn meta(&self) -> ToolMeta {
        let (es, nq, other) = (floor_of(Some("ES")), floor_of(Some("NQ")), floor_of(None));
        ToolMeta::new("market.get_big_trades", "Get big trades", RiskTier::Read)
            .description(format!("Big trades by Tessera's rule, the set the desk draws as bubbles. Prints join into aggressor events: a print continues an event on the same side that it does not retreat from, at most 5 ms after the event's last print (a sweep, or an algo order sliced across messages: orders says how many joined, levels at how many prices it printed, durationNs its first print to its last). Two settings, both on by default: joinOrders also joins one aggressor order's fills whatever the gap or price, and reachLimit stops an event 2 ticks past its extreme; with both off, prints join by the 5 ms chain alone and a sweep walks any number of ticks. The cuts come from events grouped the same way. A print with no known side is never big. Two modes, never both. Auto, the default (tiers: any of high, medium, low, default all three): an event is big when it clears the contract's floor (ES {es}, NQ {nq}, any other {other} lot) and $500k notional and is at least the Low cut. The cuts are measured, not fitted, one set for each whole trade date: the events over the floors in the {MODEL_SESSIONS} trailing whole sessions, largest first; Low is the size of about the {low}th largest a session, Medium the {medium}th and High the {high}th (each at least one lot over the tier below). The counts scale by the minutes of those sessions that held any event, over the minutes of one such session on the instrument's calendar, so a model on less history asks for fewer. With under {MIN_MODEL_MINUTES} such minutes the model is still sizing: rule.cuts is null and Auto shows nothing. Manual (minSize, maxSize): events of at least minSize lots (0 or absent: the contract's default, ES {}, NQ {}, any other {}) and at most maxSize (0 or absent: no limit); the floors and notional do not apply. In both modes an event that clears the floors and notional carries its Auto tier once the model is sized; one under them has none. Default span the last 60 minutes (up to a day); returns the newest `limit` (default 50) oldest first, with counts by tier, buy/sell volume and the rule: rule.cuts gives the low, medium and high cut for the trade date of `to` (null: still sizing), rule.sizeNow the smallest size shown on that date. These are measured sizes, not predictions. Each event carries outcome, what the market did next: the first print after its last one that reaches outcome.reachTicks past its far price its way (pushed: past its highest for a buy, its lowest for a sell) or back past its average price against it (absorbed: the other side held) decides it at that print's time (outcome.decided); none within 60 s of its last print is neither, decided at 60 s. The reach is half the median one-minute high-to-low range of the model's sessions in the event's half hour of its session on the instrument's calendar (the whole session's when that half hour has none), at least 2 ticks; rule.reachTicks lists it by half hour from rule.reachFrom, the open of the trade date's session. outcome is null until the prints that decide it are in. It says what happened, not what will. The model reads its five trailing sessions from what is held or saved; where part of them is missing on a connection that keeps no trade history, it pulls that part in the background once the session read has ended, while the instrument records (a chart shows it, or a call keeps it recording for a minute). Until that pull is done the answer says filling (true): the cuts rest on less (rule.modelSessions, rule.modelMinutes and rule.modelOrders say how much), so ask again shortly and the tiers firm up. {RECORDED_FROM}", manual_min_of(es), manual_min_of(nq), manual_min_of(other), low = per_session(BigTradeTier::Low), medium = per_session(BigTradeTier::Medium), high = per_session(BigTradeTier::High)))
            .activity("Found big trades")
            .result_view("table")
            .timeout_ms(60_000)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: GetBigTradesInput,
    ) -> Result<BigTradesOutput, ToolError> {
        let s = Subject::resolve(&self.0, &input.instrument).await?;
        s.needs_prints()?;
        let to = input.to.unwrap_or(ctx.now).min(ctx.now);
        let from = input
            .from
            .unwrap_or(Timestamp(to.0 - DEFAULT_BIG_TRADES_SPAN));
        if from >= to {
            return Err(invalid("from must be before to"));
        }
        if to.0 - from.0 > MAX_BIG_TRADES_SPAN {
            return Err(invalid("big trades span at most a day"));
        }
        let limit = input.limit.unwrap_or(DEFAULT_BIG_TRADES);
        if limit == 0 || limit > MAX_BIG_TRADES {
            return Err(invalid(format!("limit must be 1..={MAX_BIG_TRADES}")));
        }
        let (instrument, _) = s.provider.spec(&s.id).await.map_err(market_error)?;
        let contract = contract_of(&instrument, &s.spec);
        let filter = filter_of(&input, &contract)?;
        let days = DaysToLoad::of(input.days_to_load)?;
        let grouping = Grouping {
            join_orders: input.join_orders.unwrap_or(true),
            reach_limit: input.reach_limit.unwrap_or(true),
        };
        let closing = match &filter {
            BigFilter::Manual { min, .. } => Contract {
                floor: *min,
                min_notional: 0.0,
                ..contract
            },
            BigFilter::Auto(_) => contract,
        };
        let _recording = self.0.linger_as(PumpKey::Trades(s.id.clone()), asker(ctx));
        let cal = s.spec.sessions;
        let mut models: Vec<Arc<BigTradeModel>> = Vec::new();
        for at in [from, Timestamp(to.0 - 1)] {
            if !models.iter().any(|m| m.date == cal.trade_date(at)) {
                models.push(big_trade_model(&self.0, &s.id, at, grouping).await?);
            }
        }
        let model_for = |t: Timestamp| {
            let d = cal.trade_date(t);
            models.iter().find(|m| m.date == d).map(Arc::as_ref)
        };
        let read_from = Timestamp(from.0 - NANOS_PER_SEC);
        let read_to = Timestamp((to.0 + CONTINUATION_NS + FOLLOW_NS).min(ctx.now.0 + 1));
        let mut closer = EventCloser::new(closing, grouping);
        let mut out = Closed::default();
        let mut newest = Newest::new(limit as usize);
        let mut counts = BigTradeTierCounts::default();
        let (mut count, mut events) = (0u32, 0u64);
        let (mut buy, mut sell) = (Qty::ZERO, Qty::ZERO);
        let in_span = |t: Timestamp| t >= from && t < to;
        let mut take = |out: &mut Closed, newest: &mut Newest| {
            events += out.events.drain(..).filter(|o| in_span(o.t)).count() as u64;
            for (o, _) in out.big.drain(..) {
                if !in_span(o.t) {
                    continue;
                }
                let model = model_for(o.t);
                let t = to_wire(&o, None, &contract, model);
                if !filter.admits(&t) {
                    continue;
                }
                count += 1;
                match t.tier {
                    Some(BigTradeTier::High) => counts.high += 1,
                    Some(BigTradeTier::Medium) => counts.medium += 1,
                    Some(BigTradeTier::Low) => counts.low += 1,
                    None => {}
                }
                match t.side {
                    Aggressor::Buy => buy = buy + t.size,
                    Aggressor::Sell => sell = sell + t.size,
                    Aggressor::Unknown => {}
                }
                let reach = model.map_or(MIN_REACH_TICKS, |m| m.reach_at(o.t));
                newest.push(t, OutcomeWatch::new(&o, contract.tick, reach));
            }
        };
        let pulls = days.pulls(cal, ctx.now);
        let read = self
            .0
            .read_prints(&s.id, read_from, read_to, pulls, |t| {
                closer.push(t, None, &mut out);
                take(&mut out, &mut newest);
                newest.settle(|w| w.on_print(t));
            })
            .await
            .map_err(market_error)?;
        closer.finish(&mut out);
        take(&mut out, &mut newest);
        newest.settle(|w| w.at_end(read_to));
        let at_to = Timestamp(to.0 - 1);
        let now_model = model_for(at_to);
        let last = newest.trades.back().map_or(0.0, |t| t.price.to_f64());
        let (mode, tiers, min_size, max_size, size_now) = match &filter {
            BigFilter::Auto(tiers) => {
                let size_now = match (now_model, tiers.last()) {
                    (Some(m), Some(lowest)) => qty_of_f64(m.size_at(*lowest, last, contract.lot)),
                    _ => contract.floor,
                };
                (
                    BigTradeMode::Auto,
                    Some(tiers.clone()),
                    None,
                    None,
                    size_now,
                )
            }
            BigFilter::Manual { min, max } => (BigTradeMode::Manual, None, Some(*min), *max, *min),
        };
        Ok(BigTradesOutput {
            instrument: s.id.clone(),
            price_decimals: s.spec.price_decimals,
            from,
            to,
            rule: BigTradeRule {
                mode,
                tiers,
                min_size,
                max_size,
                cuts: now_model.and_then(|m| m.cuts.clone()),
                floor: contract.floor,
                min_notional: contract.min_notional,
                multiplier: contract.multiplier,
                join_orders: grouping.join_orders,
                reach_limit: grouping.reach_limit,
                continuation_ms: CONTINUATION_NS as f64 / 1e6,
                size_now,
                model_orders: now_model.map_or(0, BigTradeModel::orders),
                model_sessions: now_model.map_or(0, |m| m.sessions),
                model_minutes: now_model.map_or(0, |m| m.minutes),
                reach_ticks: now_model.map_or_else(Vec::new, |m| m.reach_ticks.clone()),
                reach_from: now_model.and_then(BigTradeModel::reach_from),
            },
            trades: newest.trades.into(),
            count,
            tiers: counts,
            buy_volume: buy,
            sell_volume: sell,
            orders: events,
            gaps: read.gaps.within(stretch(from, to)).wire(),
            loaded: loaded(
                cal,
                &read.gaps,
                stretch(from.max(days.floor(cal, ctx.now)), to),
                self.0.refused(&s.id) && !read.filling,
            ),
            filling: read.filling || models.iter().any(|m| m.pulling),
            aggressor_source: read.aggressor_source,
            provider: s.provider.id().to_owned(),
        })
    }

    fn summarize(&self, out: &BigTradesOutput) -> Option<String> {
        let c = &out.tiers;
        Some(format!(
            "{} big trades · {} · buy {} · sell {} · {} high, {} medium, {} low",
            out.count, out.instrument, out.buy_volume, out.sell_volume, c.high, c.medium, c.low
        ))
    }
}

pub const DEFAULT_PRINT_BAR_SESSIONS: u32 = 2;
pub const MAX_PRINT_BAR_SESSIONS: u32 = 5;
pub const MAX_PRINT_BARS: usize = 20_000;

pub struct PrintBarsRead {
    pub bars: Vec<FlowBar>,
    pub cut: bool,
    pub forming: bool,
    pub gaps: Gaps,
    pub filling: bool,
}

pub async fn print_bars(
    hub: &MarketHub,
    id: &InstrumentId,
    bars: PrintBars,
    sessions: u32,
    now: Timestamp,
) -> Result<PrintBarsRead, ToolError> {
    let router = hub.router();
    let provider = router.route_async(id).await.map_err(market_error)?;
    let (_, spec) = provider.spec(id).await.map_err(market_error)?;
    let calendar = spec.sessions;
    let from = calendar
        .last_sessions(now, sessions as usize)
        .first()
        .map_or(now, |first| first.open);
    let mut builder = PrintBarBuilder::new(bars, spec.tick_size, calendar);
    let read = each_print(hub, id, from, now, |t| builder.push(t)).await?;
    let (mut closed, forming) = builder.finish_with_flow();
    let open = forming.is_some();
    closed.extend(forming);
    let cut = closed.len() > MAX_PRINT_BARS;
    if cut {
        closed.drain(..closed.len() - MAX_PRINT_BARS);
    }
    Ok(PrintBarsRead {
        bars: closed,
        cut,
        forming: open,
        gaps: read.gaps,
        filling: read.filling,
    })
}

pub struct GetPrintBars(pub Arc<MarketHub>);

#[async_trait]
impl Tool for GetPrintBars {
    type Input = crate::io::GetPrintBarsInput;
    type Output = crate::io::PrintBarsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_print_bars", "Get tick, range, volume, delta or renko bars", RiskTier::Read)
            .description(format!("Bars built from the instrument's prints rather than the clock, starting again at each session's open (renko bricks run on across it): tick (a bar every size prints), range (each bar's high and low within size ticks; the print that would take it further starts the next), volume (a bar every size contracts, closing on the print that reaches it), delta (a bar closing on the print that takes its net delta, aggressive buys less sells, to size either way) or renko (bricks size ticks tall: one closes size ticks past the last close the way the bricks run, or 2 × size back against them; a print that jumps further leaves a brick for each box, with no volume of its own; a finished brick is its body alone, open to close, with no wicks; the forming one runs from the last close to the latest print). Rows [t, o, h, l, c, v, bv] (t = the bar's first print, UTC nanoseconds, and for a renko brick at least a millisecond after the brick before; bv = aggressive buy volume), oldest first, the newest {MAX_PRINT_BARS} at most; lastBarOpen when the last is still forming. sessions: the current session and those before it (default {DEFAULT_PRINT_BAR_SESSIONS}, at most {MAX_PRINT_BAR_SESSIONS}). {RECORDED_FROM}"))
            .activity("Built print bars")
            .timeout_ms(60_000)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: crate::io::GetPrintBarsInput,
    ) -> Result<crate::io::PrintBarsOutput, ToolError> {
        let s = Subject::resolve(&self.0, &input.instrument).await?;
        s.needs_prints()?;
        let size = input.bars.size();
        if size == 0 || size > PRINT_BAR_SIZE_MAX {
            return Err(invalid(format!("size must be 1..={PRINT_BAR_SIZE_MAX}")));
        }
        let n = input.sessions.unwrap_or(DEFAULT_PRINT_BAR_SESSIONS);
        if n == 0 || n > MAX_PRINT_BAR_SESSIONS {
            return Err(invalid(format!(
                "sessions must be 1..={MAX_PRINT_BAR_SESSIONS}"
            )));
        }
        let read = print_bars(&self.0, &s.id, input.bars, n, ctx.now).await?;
        Ok(crate::io::PrintBarsOutput {
            instrument: s.id,
            bars: input.bars,
            price_decimals: s.spec.price_decimals,
            columns: ["t", "o", "h", "l", "c", "v", "bv"]
                .map(str::to_owned)
                .to_vec(),
            candles: read
                .bars
                .iter()
                .map(|(b, _)| tessera_protocol::compact::CompactBar::from(b))
                .collect(),
            last_bar_open: read.forming,
            gaps: read.gaps.wire(),
            filling: read.filling,
        })
    }

    fn summarize(&self, out: &crate::io::PrintBarsOutput) -> Option<String> {
        Some(format!(
            "{} · {} bars of {}",
            out.instrument,
            out.candles.len(),
            out.bars.words()
        ))
    }
}

pub struct GetDelta(pub Arc<MarketHub>);

type SidesFromPrints = (
    HashMap<Timestamp, (Qty, Qty)>,
    Option<AggressorSource>,
    Gaps,
    bool,
);

async fn sides_from_prints(
    hub: &MarketHub,
    s: &Subject,
    tf: Timeframe,
    opens: &[Timestamp],
    now: Timestamp,
) -> Result<SidesFromPrints, ToolError> {
    let ask = BarsAsk {
        provider: s.provider.id(),
        id: &s.id,
        tf,
        calendar: s.spec.sessions,
        tick: s.spec.tick_size,
        row_ticks: None,
        base_ticks: 1_000_000_000,
        now,
        budget: MAX_BAR_PRINTS,
        pulls: Pulls::ALWAYS,
    };
    let built = footprint_bars(hub, &ask, opens).await?;
    let sides = built
        .bars
        .iter()
        .map(|b| {
            let (sell, buy) = b.cells.iter().fold((Qty::ZERO, Qty::ZERO), |(s, a), c| {
                (s + c.bid_volume, a + c.ask_volume)
            });
            (b.t, (buy, sell))
        })
        .collect();
    Ok((sides, built.aggressor_source, built.gaps, built.filling))
}

#[async_trait]
impl Tool for GetDelta {
    type Input = GetDeltaInput;
    type Output = DeltaOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("market.get_delta", "Get delta", RiskTier::Read)
            .description(format!("Delta per bar, measured: aggressive buy volume (buyers lifting the offer) minus aggressive sell volume (sellers hitting the bid), and cumulative delta, as rows [t, volume, buyVolume, sellVolume, delta, cumDelta] (t = bar open, UTC nanoseconds), oldest first. Cumulative delta restarts at each session (reset: \"none\" runs it across sessions) and counts the session's bars before the first one returned. Each bar's split comes from the bar's own buy volume when the feed gives it, else from all of its prints (basis says which). Bars with neither are left out and counted in missing; earlier bars of the session cumDelta could not count are in missingBefore (when non-zero, cumDelta leaves them out). Timeframe: any count of s, m, h or D (15s 1m 7m 90m 2h 1D 2D); default the latest 100 bars, max 1000. A bar that touches a gap has no known split and is in missing. {RECORDED_FROM}"))
            .activity("Loaded delta")
            .result_view("table")
            .timeout_ms(60_000)
    }

    async fn call(&self, ctx: &ToolCtx, input: GetDeltaInput) -> Result<DeltaOutput, ToolError> {
        let s = Subject::resolve(&self.0, &input.instrument).await?;
        s.needs_prints()?;
        let limit = input.limit.unwrap_or(DEFAULT_DELTA_BARS);
        if limit == 0 || limit > MAX_DELTA_BARS {
            return Err(invalid(format!("limit must be 1..={MAX_DELTA_BARS}")));
        }
        let reset = input.reset.unwrap_or_default();
        let router = self.0.router();
        let series = router
            .bars_from(
                &s.provider,
                BarsRequest {
                    instrument: s.id.clone(),
                    tf: input.tf,
                    from: input.from,
                    to: input.to,
                    limit: Some(limit as usize),
                    rth_only: false,
                },
                crate::history::Read::Recent,
            )
            .await
            .map_err(market_error)?;
        let calendar = s.spec.sessions;
        let mut seed: Vec<Bar> = Vec::new();
        if reset == DeltaReset::Session
            && !input.tf.is_session()
            && let Some(first) = series.bars.first()
            && let Some(session) = calendar.session(calendar.trade_date(first.t))
            && session.open < first.t
        {
            seed = router
                .bars_from(
                    &s.provider,
                    BarsRequest {
                        instrument: s.id.clone(),
                        tf: input.tf,
                        from: Some(session.open),
                        to: Some(Timestamp(first.t.0 - 1)),
                        limit: None,
                        rth_only: false,
                    },
                    crate::history::Read::Recent,
                )
                .await
                .map_err(market_error)?
                .bars;
        }
        let all: Vec<&Bar> = seed.iter().chain(&series.bars).collect();
        let unknown: Vec<Timestamp> = all.iter().filter(|b| b.bv.is_none()).map(|b| b.t).collect();
        let caps = s.provider.capabilities();
        let (mut from_prints, mut source, mut gaps, mut filling) =
            (HashMap::new(), None, Gaps::default(), false);
        if !unknown.is_empty() && (caps.trades || caps.footprint) {
            let _recording = self.0.linger_as(PumpKey::Trades(s.id.clone()), asker(ctx));
            (from_prints, source, gaps, filling) =
                sides_from_prints(&self.0, &s, input.tf, &unknown, ctx.now).await?;
        }
        let mut cum = CumulativeDelta::new(calendar, reset);
        let (mut rows, mut missing, mut by_bars, mut by_prints) = (Vec::new(), 0u32, 0, 0);
        let mut missing_before = 0u32;
        for (i, b) in all.iter().enumerate() {
            let shown = i >= seed.len();
            let d = match (cum.push_bar(b), from_prints.get(&b.t)) {
                (Some(d), _) => {
                    by_bars += usize::from(shown);
                    d
                }
                (None, Some(&(buy, sell))) => {
                    by_prints += usize::from(shown);
                    cum.push(b.t, b.v, buy, sell)
                }
                (None, None) => {
                    if shown {
                        missing += 1;
                    } else {
                        missing_before += 1;
                    }
                    continue;
                }
            };
            if shown {
                rows.push(CompactDeltaBar(
                    d.t,
                    d.volume,
                    d.buy,
                    d.sell,
                    d.delta,
                    d.cumulative,
                ));
            }
        }
        let basis = match (by_bars, by_prints) {
            (0, 0) => None,
            (_, 0) => Some(DeltaBasis::Bars),
            (0, _) => Some(DeltaBasis::Prints),
            _ => Some(DeltaBasis::Mixed),
        };
        Ok(DeltaOutput {
            instrument: s.id.clone(),
            tf: input.tf,
            reset,
            columns: [
                "t",
                "volume",
                "buyVolume",
                "sellVolume",
                "delta",
                "cumDelta",
            ]
            .map(str::to_owned)
            .to_vec(),
            bars: rows,
            missing,
            missing_before,
            basis,
            last_bar_open: series.last_bar_open,
            aggressor_source: source.or(caps.aggressor_source),
            gaps: gaps.wire(),
            filling,
            provider: s.provider.id().to_owned(),
        })
    }

    fn summarize(&self, out: &DeltaOutput) -> Option<String> {
        let Some(last) = out.bars.last() else {
            return (!out.gaps.is_empty())
                .then(|| format!("no delta bars · {} · no tick history here", out.instrument));
        };
        Some(format!(
            "{} {} · delta {} · cumulative {}",
            out.instrument, out.tf, last.4, last.5
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desk_reads_print_bars_within_the_sessions_the_runtime_builds() {
        let desk = include_str!("../../../../apps/desktop/src/market/intervals.ts");
        assert!(desk.contains(&format!(
            "export const FIRST_PRINT_BAR_SESSIONS = {DEFAULT_PRINT_BAR_SESSIONS};"
        )));
        assert!(desk.contains(&format!(
            "export const MAX_PRINT_BAR_SESSIONS = {MAX_PRINT_BAR_SESSIONS};"
        )));
    }

    #[test]
    fn recent_sessions_walk_back_over_weekends() {
        let at = Timestamp::parse("2026-10-05T10:00:00-04:00").unwrap();
        let s = recent_sessions(SessionCalendar::CmeEquityIndex, at, 2, false);
        assert_eq!(s.len(), 2);
        assert_eq!(s[1].date, NaiveDate::from_ymd_opt(2026, 10, 5));
        assert_eq!(s[1].to, at);
        assert!(!s[1].whole);
        assert_eq!(
            s[1].end,
            Some(Timestamp::parse("2026-10-05T17:00:00-04:00").unwrap())
        );
        assert_eq!(s[0].date, NaiveDate::from_ymd_opt(2026, 10, 2));
        assert!(s[0].whole);
        assert_eq!(s[0].end, Some(s[0].to));
        assert_eq!(
            s[0].from,
            Timestamp::parse("2026-10-01T18:00:00-04:00").unwrap()
        );
        let early = Timestamp::parse("2026-10-05T08:00:00-04:00").unwrap();
        let s = recent_sessions(SessionCalendar::UsEquities, early, 1, true);
        assert_eq!(s[0].date, NaiveDate::from_ymd_opt(2026, 10, 2));
        assert_eq!(
            (s[0].from, s[0].to),
            (
                Timestamp::parse("2026-10-02T09:30:00-04:00").unwrap(),
                Timestamp::parse("2026-10-02T16:00:00-04:00").unwrap()
            )
        );
    }

    fn nq_calendar() -> SessionCalendar {
        tessera_core::catalog::seed_futures_products()
            .into_iter()
            .find(|p| p.root == "NQ")
            .map(|p| {
                p.contract(2026, tessera_core::instrument::FuturesMonth::Z, true)
                    .1
                    .sessions
            })
            .unwrap()
    }

    #[test]
    fn profile_sessions_split_on_the_cme_calendar_across_dst_and_a_holiday() {
        let ts = |s: &str| Timestamp::parse(s).unwrap();
        let date = |m, d| NaiveDate::from_ymd_opt(2026, m, d);
        let cal = nq_calendar();
        let monday = ts("2026-11-02T11:00:00-05:00");
        let s = recent_sessions(cal, monday, 2, false);
        assert_eq!(s[1].date, date(11, 2));
        assert_eq!(s[1].from, ts("2026-11-01T23:00:00Z"));
        assert_eq!(s[0].date, date(10, 30));
        assert_eq!(
            (s[0].from, s[0].to),
            (ts("2026-10-29T22:00:00Z"), ts("2026-10-30T21:00:00Z"))
        );
        let rth = recent_sessions(cal, monday, 2, true);
        assert_eq!(
            (rth[1].from, rth[1].to),
            (ts("2026-11-02T14:30:00Z"), monday)
        );
        assert_eq!(
            (rth[0].from, rth[0].to),
            (ts("2026-10-30T13:30:00Z"), ts("2026-10-30T20:00:00Z"))
        );
        let friday = ts("2026-11-27T12:00:00-05:00");
        let s = recent_sessions(cal, friday, 2, false);
        assert_eq!(s[1].date, date(11, 27));
        assert_eq!(s[1].from, ts("2026-11-25T18:00:00-05:00"));
        assert_eq!(s[1].end, Some(ts("2026-11-27T13:15:00-05:00")));
        assert_eq!(
            s[0].date,
            date(11, 25),
            "Thanksgiving has no session of its own"
        );
        let rth = recent_sessions(cal, friday, 1, true);
        assert_eq!(rth[0].from, ts("2026-11-27T09:30:00-05:00"));
        assert_eq!(rth[0].end, Some(ts("2026-11-27T13:00:00-05:00")));
    }
}
