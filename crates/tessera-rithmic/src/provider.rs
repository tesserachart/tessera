use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::Datelike;
use futures::StreamExt;
use parking_lot::Mutex;
use rithmic_rs::rti::messages::RithmicMessage;
use rithmic_rs::{
    RithmicError, RithmicHistoryPlantHandle, TickBarReplayRequest, TimeBarReplayRequest,
};
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::health::{ConnectionPhase, ProviderHealth};
use tessera_core::instrument::{
    AssetClass, ContractSpec, ExchangeContract, FuturesContractCode, Instrument, InstrumentId,
};
use tessera_core::market::{AggressorSource, Bar, Quote, Trade};
use tessera_core::money::Qty;
use tessera_core::products::Product;
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_SEC, Timestamp};
use tessera_core::timeframe::Timeframe;
use tessera_market::provider::HistoryUse;
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketStream, OrderBookEvent,
    TradesRequest,
};
use tokio_stream::wrappers::ReceiverStream;
use tracing::info;

use crate::credentials::RithmicLogin;
use crate::feeds::{FeedKey, MAX_DEPTH_LEVELS, Want};
use crate::history::{self, BarPlan, PageVerdict, Pager, TickPager, Window};
use crate::map::{self, BarUnit};
use crate::session::{OpenError, RithmicOptions, Session, refusal_words};
use crate::symbols::{self, Wanted};
use crate::templates::Template;

const FRONT_MONTH_TTL: Duration = Duration::from_secs(15 * 60);

const MAX_INTRADAY_LOOKBACK_DAYS: i64 = 400;

const MAX_DAILY_LOOKBACK_DAYS: i64 = 4_000;

const MAX_WIDENINGS: u32 = 4;

type FormingBars = Arc<Mutex<HashMap<(FeedKey, Timeframe), (u64, Bar)>>>;

pub struct RithmicMarket {
    session: Arc<Session>,
    specs: Mutex<HashMap<InstrumentId, (Instrument, ContractSpec)>>,
    fronts: Mutex<HashMap<&'static str, (InstrumentId, Instant)>>,
    forming: FormingBars,
    streams: std::sync::atomic::AtomicU64,
    ticks_after: Arc<Mutex<Option<tokio::time::Instant>>>,
}

impl std::fmt::Debug for RithmicMarket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RithmicMarket")
            .field("session", &self.session)
            .finish_non_exhaustive()
    }
}

impl RithmicMarket {
    pub async fn connect(
        login: RithmicLogin,
        opts: RithmicOptions,
    ) -> Result<Arc<Self>, OpenError> {
        let market = Self::new(login, opts)?;
        market.session.start().await?;
        Ok(market)
    }

    pub fn new(login: RithmicLogin, opts: RithmicOptions) -> Result<Arc<Self>, OpenError> {
        Ok(Arc::new(Self {
            session: Session::new(login, opts)?,
            specs: Mutex::new(HashMap::new()),
            fronts: Mutex::new(HashMap::new()),
            forming: FormingBars::default(),
            streams: std::sync::atomic::AtomicU64::new(0),
            ticks_after: Arc::default(),
        }))
    }

    pub async fn reconnect(&self) -> Result<(), OpenError> {
        self.session.reconnect().await
    }

    pub async fn shutdown(&self) {
        self.session.shutdown().await;
    }

    pub fn phase(&self) -> ConnectionPhase {
        self.session.phase()
    }

    pub fn system_name(&self) -> &str {
        &self.session.login.system_name
    }

    pub(crate) fn session(&self) -> &Arc<Session> {
        &self.session
    }

    pub fn template_counts(&self) -> std::collections::BTreeMap<i32, u64> {
        self.session.gate.counts()
    }

    fn key(&self, instrument: &InstrumentId) -> Result<FeedKey, MarketError> {
        symbols::parse_instrument_id(instrument)
            .ok_or_else(|| MarketError::UnknownInstrument(instrument.to_string()))
    }

    fn year() -> i32 {
        chrono::Utc::now().year()
    }

    async fn front_month(&self, prod: &'static Product) -> Result<InstrumentId, MarketError> {
        let h = self.session.ticker()?;
        if let Some((id, at)) = self.fronts.lock().get(prod.root)
            && at.elapsed() < FRONT_MONTH_TTL
        {
            return Ok(id.clone());
        }
        let r = self
            .session
            .request(
                Template::FrontMonthContract,
                h.get_front_month_contract(prod.root, prod.exchange, false),
            )
            .await?;
        if let Some(e) = &r.error {
            return Err(MarketError::UnknownInstrument(format!(
                "{}: {}",
                prod.root,
                self.session.redact(e)
            )));
        }
        let RithmicMessage::ResponseFrontMonthContract(f) = r.message else {
            return Err(MarketError::Unavailable(
                "unexpected reply to a front-month request".into(),
            ));
        };
        let symbol = f
            .trading_symbol
            .ok_or_else(|| MarketError::UnknownInstrument(prod.root.to_owned()))?;
        let exchange = f
            .trading_exchange
            .unwrap_or_else(|| prod.exchange.to_owned());
        let id = symbols::instrument_id(&symbol, &exchange);
        self.fronts
            .lock()
            .insert(prod.root, (id.clone(), Instant::now()));
        Ok(id)
    }

    fn is_front(&self, id: &InstrumentId) -> bool {
        self.fronts.lock().values().any(|(f, _)| f == id)
    }

    async fn load_spec(
        &self,
        id: &InstrumentId,
    ) -> Result<(Instrument, ContractSpec), MarketError> {
        if let Some(s) = self.specs.lock().get(id) {
            let mut s = s.clone();
            s.0.is_front = self.is_front(id);
            return Ok(s);
        }
        let (symbol, exchange) = self.key(id)?;
        let h = self.session.ticker()?;
        let r = self
            .session
            .request(
                Template::ReferenceData,
                h.get_reference_data(&symbol, &exchange),
            )
            .await?;
        if r.error.is_some() {
            return Err(MarketError::UnknownInstrument(id.to_string()));
        }
        let RithmicMessage::ResponseReferenceData(data) = &r.message else {
            return Err(MarketError::UnknownInstrument(id.to_string()));
        };
        // Rithmic answers an unlisted contract with an empty reference-data reply (`no data`).
        if data.symbol.is_none() && data.product_code.is_none() && data.exchange.is_none() {
            return Err(MarketError::UnknownInstrument(id.to_string()));
        }
        let out = symbols::spec_from_reference(
            &symbol,
            &exchange,
            Some(data),
            self.is_front(id),
            Self::year(),
        );
        if let Some(tick) = symbols::reference_tick(data) {
            self.session
                .feeds
                .set_grid(&(symbol.clone(), exchange.clone()), map::Grid::of(tick));
        }
        self.specs.lock().insert(id.clone(), out.clone());
        Ok(out)
    }
}

async fn replay(
    session: &Arc<Session>,
    key: &FeedKey,
    plan: BarPlan,
    window: Window,
) -> Result<Vec<Bar>, MarketError> {
    let s = Arc::clone(session);
    let key = key.clone();
    session
        .with_history(move |h| async move { replay_pages(&s, &h, &key, plan, window).await })
        .await
}

fn first_own_bar_secs(own_from: Option<Timestamp>, bar_secs: i64) -> i64 {
    own_from.map_or(0, |t| {
        (t.0.div_euclid(NANOS_PER_SEC) + bar_secs - 1).div_euclid(bar_secs) * bar_secs
    })
}

fn lookback_days(plan: BarPlan) -> i64 {
    match plan.unit {
        BarUnit::Days => MAX_DAILY_LOOKBACK_DAYS,
        BarUnit::Seconds(_) => MAX_INTRADAY_LOOKBACK_DAYS,
    }
}

#[derive(Clone, Copy, Debug)]
struct Reach {
    end: i64,
    earliest: i64,
    bar_secs: i64,
    first_span: i64,
    limit: usize,
    now: Timestamp,
}

async fn reach_back<F, Fut>(
    r: Reach,
    mut fetch: F,
    finish: impl Fn(Vec<Bar>) -> Vec<Bar>,
) -> Result<Vec<Bar>, MarketError>
where
    F: FnMut(Window) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<Bar>, MarketError>>,
{
    let align = |t: i64| t.max(0).div_euclid(r.bar_secs) * r.bar_secs;
    let mut span = r.first_span;
    let mut start = align(r.end - span).max(r.earliest);
    let mut slice = Window { start, end: r.end };
    let mut raw: Vec<Bar> = Vec::new();
    let mut rounds = 0u32;
    loop {
        let reach = Window { start, end: r.end };
        if let Err(why) = history::check_long_pull(history::max_rows(reach, r.bar_secs), r.now) {
            if rounds == 0 {
                return Err(MarketError::Unsupported(why));
            }
            info!(
                found = raw.len(),
                "rithmic history: a wider reach would be a long pull in cash hours; returning what was found"
            );
            return Ok(finish(raw));
        }
        let got = match fetch(slice).await {
            Ok(got) => got,
            Err(MarketError::Unsupported(why)) if rounds > 0 => {
                info!(found = raw.len(), %why, "rithmic history: older bars were refused; returning what was found");
                return Ok(finish(raw));
            }
            Err(e) => return Err(e),
        };
        let found = !got.is_empty();
        let had = !raw.is_empty();
        raw.extend(got);
        rounds += 1;
        let bars = finish(raw.clone());
        let ran_out = rounds > 1 && had && !found;
        if bars.len() >= r.limit || start <= r.earliest || rounds > MAX_WIDENINGS || ran_out {
            return Ok(bars);
        }
        span = span.saturating_mul(3);
        let wider = align(r.end - span).max(r.earliest);
        slice = Window {
            start: wider,
            end: start,
        };
        start = wider;
    }
}

async fn forming_bar(
    session: &Arc<Session>,
    key: &FeedKey,
    tf: Timeframe,
    now: Timestamp,
) -> Result<Option<Bar>, MarketError> {
    seed_bar(symbols::calendar_of(&key.0), tf, now, |step, window| {
        replay(session, key, BarPlan::for_timeframe(step), window)
    })
    .await
}

fn with_forming(
    mut bars: Vec<Bar>,
    forming: Bar,
    req: &BarsRequest,
    cal: SessionCalendar,
) -> Vec<Bar> {
    let outside = req.from.is_some_and(|f| forming.t < f) || req.to.is_some_and(|t| forming.t > t);
    if outside || (req.rth_only && !req.tf.is_session() && !cal.is_rth(forming.t)) {
        return bars;
    }
    bars.retain(|b| b.t < forming.t);
    bars.push(forming);
    if let Some(n) = req.limit
        && bars.len() > n
    {
        bars.drain(..bars.len() - n);
    }
    bars
}

fn seed_from(cal: SessionCalendar, tf: Timeframe, now: Timestamp) -> Timestamp {
    cal.bucket_span(now, tf).0
}

async fn seed_bar<F, Fut>(
    cal: SessionCalendar,
    tf: Timeframe,
    now: Timestamp,
    mut fetch: F,
) -> Result<Option<Bar>, MarketError>
where
    F: FnMut(Timeframe, Window) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<Bar>, MarketError>>,
{
    let bucket = cal.bucket_start(now, tf);
    let from = seed_from(cal, tf, now);
    let minute = cal.bucket_start(now, Timeframe::M1).max(from);
    let secs = |t: Timestamp| t.0.div_euclid(NANOS_PER_SEC);
    let mut bars = Vec::new();
    let built_from_minutes = tf.base().is_some();
    if built_from_minutes && tf != Timeframe::M1 && minute > from {
        let window = Window {
            start: secs(from),
            end: secs(minute),
        };
        let m1 = fetch(Timeframe::M1, window).await?;
        bars.extend(m1.into_iter().filter(|b| b.t >= from && b.t < minute));
    }
    let seconds_from = if built_from_minutes { minute } else { from };
    if tf != Timeframe::S1 && now > seconds_from {
        let window = Window {
            start: secs(seconds_from),
            end: secs(now),
        };
        let s1 = fetch(Timeframe::S1, window).await?;
        bars.extend(s1.into_iter().filter(|b| b.t >= seconds_from && b.t < now));
    }
    bars.sort_by_key(|b| b.t);
    bars.dedup_by_key(|b| b.t);
    let mut it = bars.into_iter();
    let Some(mut bar) = it.next() else {
        return Ok(None);
    };
    bar.t = bucket;
    for b in it {
        bar.merge(&b);
    }
    Ok(Some(bar))
}

async fn replay_pages(
    session: &Session,
    h: &RithmicHistoryPlantHandle,
    key: &FeedKey,
    plan: BarPlan,
    window: Window,
) -> Result<Vec<Bar>, MarketError> {
    let calendar = symbols::calendar_of(&key.0);
    let grid = session.feeds.grid(key).unwrap_or_default();
    let mut out = Vec::new();
    let mut pager = Pager::new(window, plan.bar_secs());
    while let Some(w) = pager.next_window() {
        let (start, end) = match plan.unit {
            BarUnit::Days => (yyyymmdd(w.start), yyyymmdd(w.end)),
            BarUnit::Seconds(_) => (clamp_i32(w.start), clamp_i32(w.end)),
        };
        let req = TimeBarReplayRequest::new()
            .symbol(key.0.clone())
            .exchange(key.1.clone())
            .bar_type(plan.bar_type)
            .bar_type_period(plan.period)
            .start_time_sec(start)
            .end_time_sec(end);
        session.history_use.lock().requests += 1;
        let rows = session
            .request(Template::TimeBarReplay, async {
                Ok(h.load_time_bar_replay(req).await)
            })
            .await?
            .map_err(|e| replay_failure(session, "bar replay", &e))?;
        count_history(session, &rows);
        if let Some(e) = rows.last().and_then(|r| r.error.as_ref()) {
            return Err(replay_failure(session, "bar replay", e));
        }
        let bars: Vec<Bar> = rows
            .iter()
            .filter_map(|r| match &r.message {
                RithmicMessage::ResponseTimeBarReplay(b) => {
                    map::time_bar(b, plan.unit, calendar, grid)
                }
                _ => None,
            })
            .collect();
        if pager.judge(w, rows.len()) == PageVerdict::Split {
            continue;
        }
        out.extend(bars);
    }
    Ok(out)
}

fn replay_failure(session: &Session, replay: &str, e: &RithmicError) -> MarketError {
    match e {
        RithmicError::RequestRejected(r) => MarketError::Unsupported(session.redact(format!(
            "Rithmic refused the {replay}: {}",
            refusal_words(r.code.as_deref(), r.message.as_deref())
        ))),
        other => MarketError::Unavailable(session.redact(other)),
    }
}

async fn replay_ticks(
    session: &Arc<Session>,
    paced: &Arc<Mutex<Option<tokio::time::Instant>>>,
    key: &FeedKey,
    instrument: &InstrumentId,
    window: Window,
) -> Result<(usize, Vec<Trade>), MarketError> {
    let (s, paced) = (Arc::clone(session), Arc::clone(paced));
    let (key, instrument) = (key.clone(), instrument.clone());
    session
        .with_history(move |h| async move {
            let after = *paced.lock();
            if let Some(at) = after {
                tokio::time::sleep_until(at).await;
            }
            let req = TickBarReplayRequest::new()
                .symbol(key.0.clone())
                .exchange(key.1.clone())
                .bar_length(1)
                .start_time_sec(clamp_i32(window.start))
                .end_time_sec(clamp_i32(window.end))
                .user_max_count(clamp_i32(history::MAX_ROWS_PER_PAGE as i64));
            s.history_use.lock().requests += 1;
            let rows = s
                .request(Template::TickBarReplay, async {
                    Ok(h.load_tick_bar_replay(req).await)
                })
                .await;
            *paced.lock() = Some(tokio::time::Instant::now() + history::TICK_PAUSE);
            let rows = rows?.map_err(|e| replay_failure(&s, "tick replay", &e))?;
            count_history(&s, &rows);
            if let Some(e) = rows.last().and_then(|r| r.error.as_ref()) {
                return Err(replay_failure(&s, "tick replay", e));
            }
            let grid = s.feeds.grid(&key).unwrap_or_default();
            let ticks: Vec<_> = rows
                .iter()
                .filter_map(|r| match &r.message {
                    RithmicMessage::ResponseTickBarReplay(t) if !t.data_bar_ssboe.is_empty() => {
                        Some(t)
                    }
                    _ => None,
                })
                .collect();
            let (lo, hi) = (
                Timestamp::from_secs(window.start),
                Timestamp::from_secs(window.end),
            );
            let trades = ticks
                .iter()
                .filter_map(|t| map::replayed_trade(&instrument, t, grid))
                .filter(|t| t.ts >= lo && t.ts < hi)
                .collect();
            Ok((ticks.len(), trades))
        })
        .await
}

const FRAME_LENGTH_PREFIX_BYTES: u64 = 4;

fn count_history(session: &Session, rows: &[rithmic_rs::RithmicResponse]) {
    use prost::Message;
    let bytes: u64 = rows
        .iter()
        .map(|r| {
            let body = match &r.message {
                RithmicMessage::ResponseTimeBarReplay(b) => b.encoded_len(),
                RithmicMessage::ResponseTickBarReplay(t) => t.encoded_len(),
                _ => 0,
            };
            body as u64 + FRAME_LENGTH_PREFIX_BYTES
        })
        .sum();
    session.history_use.lock().bytes += bytes;
}

fn clamp_i32(v: i64) -> i32 {
    i32::try_from(v.clamp(0, i64::from(i32::MAX))).unwrap_or(i32::MAX)
}

/// Rithmic's `YYYYMMDD` dates are CME trade dates in Chicago.
fn yyyymmdd(secs: i64) -> i32 {
    let date = SessionCalendar::CmeGlobex.trade_date(Timestamp::from_secs(secs));
    date.year() * 10_000 + date.month() as i32 * 100 + date.day() as i32
}

#[async_trait]
impl MarketDataProvider for RithmicMarket {
    fn id(&self) -> &str {
        &self.session.opts.provider_id
    }

    fn history_use(&self) -> HistoryUse {
        *self.session.history_use.lock()
    }

    fn display_name(&self) -> &str {
        &self.session.opts.display_name
    }

    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            history_timeframes: Timeframe::PRESETS.to_vec(),
            live_timeframes: Timeframe::PRESETS.to_vec(),
            quotes: true,
            trades: true,
            depth_levels: Some(MAX_DEPTH_LEVELS),
            footprint: false,
            asset_classes: vec![AssetClass::Future],
            max_intraday_history_days: Some(MAX_INTRADAY_LOOKBACK_DAYS as u32),
            max_daily_history_days: Some(MAX_DAILY_LOOKBACK_DAYS as u32),
            realtime: true,
            aggressor_source: Some(AggressorSource::Exchange),
        }
    }

    fn health(&self) -> ProviderHealth {
        self.session.health()
    }

    fn prices_flowing(&self) -> bool {
        self.session.phase() == ConnectionPhase::Live
    }

    fn history_blocked(&self) -> Option<String> {
        match self.session.phase() {
            ConnectionPhase::Live | ConnectionPhase::Reconnecting { .. } => None,
            ConnectionPhase::Connecting => Some("connecting to Rithmic".into()),
            ConnectionPhase::Stopped => Some("Rithmic is not connected".into()),
            ConnectionPhase::Waiting => Some("Rithmic logged out; logging in again".into()),
            ConnectionPhase::LoggedOut => Some("Rithmic ended the session".into()),
            ConnectionPhase::TakenOver => Some("the connection was taken by another login".into()),
            ConnectionPhase::Refused { .. } => Some("Rithmic refused the login".into()),
            ConnectionPhase::Unreachable { .. } => Some("Rithmic can't be reached".into()),
        }
    }

    async fn search(
        &self,
        query: &str,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        if asset_class.is_some_and(|c| c != AssetClass::Future) || limit == 0 {
            return Ok(Vec::new());
        }
        let q = query.trim().to_ascii_uppercase();
        let mut ids: Vec<InstrumentId> = Vec::new();
        if let Some(Wanted::Contract { symbol, exchange }) = symbols::read_input(&q, Self::year()) {
            ids.push(symbols::instrument_id(&symbol, &exchange));
        }
        let lower = query.trim().to_ascii_lowercase();
        let products = symbols::listed().filter(|p| {
            q.is_empty() || p.root.starts_with(&q) || p.name.to_ascii_lowercase().contains(&lower)
        });
        let mut last_err = None;
        let fronts =
            futures::future::join_all(products.take(limit).map(|p| self.front_month(p))).await;
        for f in fronts {
            match f {
                Ok(id) if !ids.contains(&id) => ids.push(id),
                Ok(_) => {}
                Err(e) => last_err = Some(e),
            }
        }
        ids.truncate(limit);
        let specs = futures::future::join_all(ids.iter().map(|id| self.load_spec(id))).await;
        let mut out = Vec::new();
        for s in specs {
            match s {
                Ok((i, _)) => out.push(i),
                Err(e) => last_err = Some(e),
            }
        }
        match (out.is_empty(), last_err) {
            (true, Some(MarketError::Unavailable(m))) => Err(MarketError::Unavailable(m)),
            _ => Ok(out),
        }
    }

    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        match symbols::read_input(input, Self::year()) {
            Some(Wanted::Root(p)) => self.front_month(p).await,
            Some(Wanted::Contract { symbol, exchange }) => {
                let id = symbols::instrument_id(&symbol, &exchange);
                self.load_spec(&id).await.map(|_| id)
            }
            None => Err(MarketError::UnknownInstrument(input.to_owned())),
        }
    }

    async fn spec(
        &self,
        instrument: &InstrumentId,
    ) -> Result<(Instrument, ContractSpec), MarketError> {
        self.load_spec(instrument).await
    }

    async fn contract_for(
        &self,
        want: &ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        let Some(month) = want.expiry else {
            return Ok(None);
        };
        let code = FuturesContractCode {
            root: want.root.clone(),
            month: month.month,
            year: month.year,
        };
        let id = symbols::instrument_id(&code.code(), &want.exchange);
        match self.load_spec(&id).await {
            Ok((i, _)) => Ok(Some(i)),
            Err(MarketError::UnknownInstrument(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        let key = self.key(&req.instrument)?;
        let own_from = self
            .load_spec(&req.instrument)
            .await
            .ok()
            .and_then(|(_, spec)| spec.earliest_bar(Self::year()));
        if let (Some(f), Some(t)) = (req.from, req.to)
            && f > t
        {
            return Err(MarketError::InvalidRequest("from is after to".into()));
        }
        let plan = BarPlan::for_timeframe(req.tf);
        let now = Timestamp::now();
        let cal = symbols::calendar_of(&key.0);
        let to = req.to.unwrap_or(now).min(now);
        let bar_secs = plan.bar_secs();
        let tf_secs = req.tf.nanos() / NANOS_PER_SEC;
        let end =
            (to.0.div_euclid(NANOS_PER_SEC) + tf_secs).div_euclid(bar_secs) * bar_secs + bar_secs;
        let limit = req
            .limit
            .unwrap_or(tessera_market::module::DEFAULT_BARS as usize);
        let days = lookback_days(plan);
        let reach = (end - days * 86_400).max(0).div_euclid(bar_secs) * bar_secs;
        let earliest = reach.max(first_own_bar_secs(own_from, bar_secs));
        let finish = |mut raw: Vec<Bar>| {
            raw.retain(|b| own_from.is_none_or(|t| b.t >= t));
            history::finish(raw, req.tf, cal, req.from, req.to, req.limit, req.rth_only)
        };
        let bars = match req.from {
            Some(f) => {
                let from = f.0.div_euclid(NANOS_PER_SEC).div_euclid(bar_secs) * bar_secs;
                if from < reach {
                    return Err(MarketError::InvalidRequest(format!(
                        "Rithmic {} history reaches back {days} days, to {}; ask from then on",
                        req.tf,
                        Timestamp::from_secs(reach)
                    )));
                }
                let from = from.max(earliest);
                if from >= end {
                    Vec::new()
                } else {
                    let window = Window { start: from, end };
                    history::check_long_pull(history::max_rows(window, bar_secs), now)
                        .map_err(MarketError::Unsupported)?;
                    finish(replay(&self.session, &key, plan, window).await?)
                }
            }
            None => {
                let bars = limit as i64 * tf_secs;
                let reach = Reach {
                    end,
                    earliest,
                    bar_secs,
                    first_span: bars * 3 / 2 + bars.min(3 * 86_400),
                    limit,
                    now,
                };
                let session = &self.session;
                let key = &key;
                reach_back(reach, |w| replay(session, key, plan, w), finish).await?
            }
        };
        // Rithmic replays closed bars only.
        let bucket = cal.bucket_start(now, req.tf);
        let bars = if req.to.is_none_or(|t| t >= now || t >= bucket) {
            let live = self
                .forming
                .lock()
                .get(&(key.clone(), req.tf))
                .map(|(_, b)| *b)
                .filter(|b| b.t == bucket);
            let forming = match live {
                Some(b) => Some(b),
                None => forming_bar(&self.session, &key, req.tf, now)
                    .await
                    .ok()
                    .flatten(),
            };
            match forming {
                Some(f) => with_forming(bars, f, &req, cal),
                None => bars,
            }
        } else {
            bars
        };
        let last_bar_open = bars
            .last()
            .is_some_and(|b| cal.bucket_span(b.t, req.tf).1 > now);
        Ok(BarSeries {
            instrument: req.instrument,
            tf: req.tf,
            bars,
            last_bar_open,
        })
    }

    async fn replay_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let (Some(from), Some(to)) = (req.from, req.to) else {
            return Err(MarketError::InvalidRequest(
                "a tick replay needs from and to".into(),
            ));
        };
        let key = self.key(&req.instrument)?;
        if self.session.feeds.grid(&key).is_none() {
            let _ = self.load_spec(&req.instrument).await;
        }
        let window = Window {
            start: from.0.div_euclid(NANOS_PER_SEC),
            end: to.0.div_euclid(NANOS_PER_SEC) + 1,
        };
        let mut pager = TickPager::new(window);
        let mut pages = Vec::new();
        while let Some(w) = pager.next_window() {
            let (rows, trades) =
                replay_ticks(&self.session, &self.ticks_after, &key, &req.instrument, w).await?;
            match pager.judge(w, rows) {
                PageVerdict::Split => {}
                PageVerdict::Keep => pages.push(trades),
                PageVerdict::KeepCapped => {
                    return Err(MarketError::Unsupported(format!(
                        "Rithmic holds more than {} prints of {} within the second at {}",
                        history::MAX_ROWS_PER_PAGE,
                        req.instrument,
                        Timestamp::from_secs(w.start)
                    )));
                }
            }
        }
        let mut out: Vec<Trade> = pages
            .into_iter()
            .rev()
            .flatten()
            .filter(|t| t.ts >= from && t.ts < to)
            .collect();
        out.sort_by_key(|t| t.ts);
        Ok(out)
    }

    async fn quote(&self, instrument: &InstrumentId) -> Result<Quote, MarketError> {
        let key = self.key(instrument)?;
        if let Some(q) = self.session.feeds.quote(&key) {
            return Ok(q);
        }
        let stream = self.subscribe_quotes(std::slice::from_ref(instrument))?;
        first_quote(stream, self.session.opts.request_timeout, QUOTE_SETTLE)
            .await
            .ok_or_else(|| {
                MarketError::Unavailable(format!("no quote for {instrument} from Rithmic yet"))
            })
    }

    fn subscribe_quotes(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Quote>, MarketError> {
        let mut streams = Vec::new();
        for id in instruments {
            let key = self.key(id)?;
            let guard = self.session.feeds.acquire(
                &self.session,
                &key,
                id,
                symbols::calendar_of(&key.0),
                Want::Top,
            );
            streams.push(self.session.feeds.quotes(&key, guard));
        }
        Ok(futures::stream::select_all(streams).boxed())
    }

    fn subscribe_trades(
        &self,
        instruments: &[InstrumentId],
    ) -> Result<MarketStream<Trade>, MarketError> {
        let mut streams = Vec::new();
        for id in instruments {
            let key = self.key(id)?;
            let guard = self.session.feeds.acquire(
                &self.session,
                &key,
                id,
                symbols::calendar_of(&key.0),
                Want::Top,
            );
            streams.push(self.session.feeds.trades(&key, guard));
        }
        Ok(futures::stream::select_all(streams).boxed())
    }

    fn subscribe_bars(
        &self,
        instrument: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        let key = self.key(instrument)?;
        let prints = self.subscribe_trades(std::slice::from_ref(instrument))?;
        let (tx, rx) = tokio::sync::mpsc::channel::<LiveBar>(1024);
        let session = Arc::clone(&self.session);
        let id = instrument.clone();
        let forming = Arc::clone(&self.forming);
        let n = self
            .streams
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.session.runtime().spawn(async move {
            let slot = (key.clone(), tf);
            let _forget = Forget(Arc::clone(&forming), slot.clone(), n);
            let offer = |bar: Bar| {
                forming.lock().insert(slot.clone(), (n, bar));
            };
            let cut = Timestamp::from_secs(Timestamp::now().secs());
            let seed = || forming_bar(&session, &key, tf, cut);
            let open = Opening {
                tf,
                calendar: symbols::calendar_of(&key.0),
                cut,
            };
            live_bars(open, prints, seed, offer, &tx, &id).await;
        });
        Ok(ReceiverStream::new(rx).boxed())
    }

    fn subscribe_order_book(
        &self,
        instrument: &InstrumentId,
    ) -> Result<MarketStream<OrderBookEvent>, MarketError> {
        let key = self.key(instrument)?;
        let guard = self.session.feeds.acquire(
            &self.session,
            &key,
            instrument,
            symbols::calendar_of(&key.0),
            Want::Depth,
        );
        Ok(self.session.feeds.order_events(&self.session, &key, guard))
    }
}

/// Rithmic answers a quote subscription with separate BBO, last-trade and session messages.
const QUOTE_SETTLE: Duration = Duration::from_secs(1);

fn session_known(q: &Quote) -> bool {
    q.session
        .as_ref()
        .is_some_and(|s| s.volume.is_some() && s.open.is_some())
}

async fn first_quote(
    mut stream: MarketStream<Quote>,
    first: Duration,
    settle: Duration,
) -> Option<Quote> {
    let mut q = tokio::time::timeout(first, stream.next())
        .await
        .ok()
        .flatten()?;
    let until = tokio::time::Instant::now() + settle;
    while !session_known(&q) {
        match tokio::time::timeout_at(until, stream.next()).await {
            Ok(Some(next)) => q = next,
            Ok(None) | Err(_) => break,
        }
    }
    Some(q)
}

struct Forget(FormingBars, (FeedKey, Timeframe), u64);

impl Drop for Forget {
    fn drop(&mut self) {
        let mut forming = self.0.lock();
        if forming.get(&self.1).is_some_and(|(n, _)| *n == self.2) {
            forming.remove(&self.1);
        }
    }
}

const SEED_RETRY: Duration = Duration::from_secs(1);
const SEED_RETRY_MAX: Duration = Duration::from_secs(30);
const MAX_HELD_PRINTS: usize = 200_000;
const BAR_CLOSE_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug)]
struct Opening {
    tf: Timeframe,
    calendar: SessionCalendar,
    cut: Timestamp,
}

async fn send_bar(
    tx: &tokio::sync::mpsc::Sender<LiveBar>,
    id: &InstrumentId,
    tf: Timeframe,
    bar: Bar,
    closed: bool,
) -> bool {
    let live = LiveBar {
        instrument: id.clone(),
        tf,
        bar,
        closed,
    };
    tx.send(live).await.is_ok()
}

async fn live_bars<P, F, Fut>(
    open: Opening,
    mut prints: P,
    mut seed: F,
    mut offer: impl FnMut(Bar),
    tx: &tokio::sync::mpsc::Sender<LiveBar>,
    id: &InstrumentId,
) where
    P: futures::Stream<Item = Trade> + Unpin,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<Bar>, MarketError>>,
{
    let Opening { tf, calendar, cut } = open;
    let first = calendar.bucket_start(cut, tf);
    let mut builder = LiveBarBuilder::new(tf, calendar);
    let mut held: Option<Vec<Trade>> = Some(Vec::new());
    let mut asking = Some(Box::pin(seed()));
    let mut waiting: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut closing: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let started = tokio::time::Instant::now();
    let close_of = |bar: Bar| {
        let (_, end) = calendar.bucket_span(bar.t, tf);
        let now = cut.add_nanos(i64::try_from(started.elapsed().as_nanos()).unwrap_or(i64::MAX));
        let left = u64::try_from(end.0.saturating_sub(now.0)).unwrap_or(0);
        Box::pin(tokio::time::sleep(
            std::time::Duration::from_nanos(left) + BAR_CLOSE_GRACE,
        ))
    };
    let mut pause = SEED_RETRY;
    loop {
        tokio::select! {
            () = async { closing.as_mut().expect("a close is due").await }, if closing.is_some() => {
                closing = None;
                if let Some(bar) = builder.close()
                    && !send_bar(tx, id, tf, bar, true).await
                {
                    return;
                }
            }
            r = async { asking.as_mut().expect("a seed is asked for").await }, if asking.is_some() => {
                asking = None;
                match r {
                    Ok(s) => {
                        let mut b = LiveBarBuilder::new(tf, calendar);
                        if let Some(s) = s {
                            b.seed(s);
                        }
                        for t in held.take().unwrap_or_default() {
                            b.push(&t);
                        }
                        let Some(bar) = b.current() else {
                            continue;
                        };
                        let closed = builder.current().is_some_and(|c| c.t > bar.t);
                        if !closed {
                            builder = b;
                            offer(bar);
                            closing = Some(close_of(bar));
                        }
                        if !send_bar(tx, id, tf, bar, closed).await {
                            return;
                        }
                    }
                    Err(e) => {
                        tracing::debug!(
                            instrument = %id,
                            error = %e,
                            retry_in = ?pause,
                            "the forming bar's history is not in yet; its prints wait",
                        );
                        waiting = Some(Box::pin(tokio::time::sleep(pause)));
                        pause = (pause * 2).min(SEED_RETRY_MAX);
                    }
                }
            }
            () = async { waiting.as_mut().expect("a retry is waiting").await }, if waiting.is_some() => {
                waiting = None;
                asking = Some(Box::pin(seed()));
            }
            t = prints.next() => {
                let Some(t) = t else { return };
                if t.ts < cut {
                    continue;
                }
                if let Some(h) = held.as_mut()
                    && calendar.bucket_start(t.ts, tf) <= first
                {
                    if h.len() >= MAX_HELD_PRINTS {
                        tracing::warn!(
                            instrument = %id,
                            "the forming bar's history never came; the live bar stream starts over",
                        );
                        return;
                    }
                    h.push(t);
                    continue;
                }
                let out = builder.push(&t);
                if let Some(bar) = builder.current() {
                    offer(bar);
                    closing = Some(close_of(bar));
                }
                for (bar, closed) in out {
                    if !send_bar(tx, id, tf, bar, closed).await {
                        return;
                    }
                }
            }
        }
    }
}

#[derive(Debug)]
pub struct LiveBarBuilder {
    tf: Timeframe,
    calendar: SessionCalendar,
    current: Option<Bar>,
    closed: Option<Timestamp>,
    flow_known: bool,
}

impl LiveBarBuilder {
    pub fn new(tf: Timeframe, calendar: SessionCalendar) -> Self {
        Self {
            tf,
            calendar,
            current: None,
            closed: None,
            flow_known: true,
        }
    }

    pub fn close(&mut self) -> Option<Bar> {
        let bar = self.current.take()?;
        self.closed = Some(bar.t);
        Some(bar)
    }

    pub fn seed(&mut self, bar: Bar) {
        self.flow_known = bar.bv.is_some();
        self.current = Some(bar);
    }

    pub fn current(&self) -> Option<Bar> {
        self.current
    }

    pub fn push(&mut self, t: &Trade) -> Vec<(Bar, bool)> {
        let key = self.calendar.bucket_start(t.ts, self.tf);
        let mut out = Vec::with_capacity(2);
        if self.current.is_some_and(|c| key < c.t) || self.closed.is_some_and(|c| key <= c) {
            return out;
        }
        match &mut self.current {
            Some(cur) if cur.t == key => {
                cur.apply_trade(t.price, t.size, t.aggressor);
                if !self.flow_known {
                    cur.bv = None;
                }
            }
            slot => {
                let mut bar = Bar::flat(key, t.price, Qty::ZERO);
                bar.apply_trade(t.price, t.size, t.aggressor);
                if let Some(prev) = slot.replace(bar)
                    && prev.t < key
                {
                    out.push((prev, true));
                }
                self.flow_known = true;
            }
        }
        if let Some(cur) = self.current {
            out.push((cur, false));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;
    use tessera_core::market::Aggressor;
    use tessera_core::money::Price;

    fn print(at: &str, px: i64, size: i64, side: Aggressor) -> Trade {
        Trade {
            instrument: InstrumentId::new("ESZ6.CME-RITHMIC").unwrap(),
            ts: Timestamp::parse(at).unwrap(),
            price: Price::from(px),
            size: Qty::from(size),
            aggressor: side,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        }
    }

    #[test]
    fn live_bars_continue_the_seed_and_close_on_a_new_bucket() {
        let mut b = LiveBarBuilder::new(Timeframe::M5, SessionCalendar::CmeEquityIndex);
        let open = Timestamp::parse("2026-10-07T12:00:00-04:00").unwrap();
        let mut seed = Bar::flat(open, Price::from(100), Qty::from(10));
        seed.h = Price::from(103);
        b.seed(seed);
        let out = b.push(&print("2026-10-07T12:03:10-04:00", 101, 2, Aggressor::Buy));
        assert_eq!(out.len(), 1);
        let (bar, closed) = out[0];
        assert!(!closed);
        assert_eq!(
            (bar.t, bar.h, bar.c, bar.v),
            (open, Price::from(103), Price::from(101), Qty::from(12))
        );
        assert_eq!(bar.bv, None);
        let out = b.push(&print("2026-10-07T12:05:00-04:00", 99, 1, Aggressor::Sell));
        assert_eq!(out.len(), 2);
        assert!(out[0].1 && out[0].0.t == open);
        assert_eq!(out[0].0.bv, None);
        assert_eq!(out[1].0.t, open.add_nanos(5 * 60 * NANOS_PER_SEC));
        assert_eq!(out[1].0.v, Qty::from(1));
        assert_eq!(out[1].0.bv, Some(Qty::ZERO));
        let out = b.push(&print("2026-10-07T12:06:00-04:00", 100, 3, Aggressor::Buy));
        assert_eq!(out[0].0.bv, Some(Qty::from(3)));
        assert!(
            b.push(&print("2026-10-07T12:04:59-04:00", 98, 1, Aggressor::Sell))
                .is_empty()
        );
        assert_eq!(b.current().unwrap().l, Price::from(99));
    }

    struct Live {
        prints: tokio::sync::mpsc::UnboundedSender<Trade>,
        bars: tokio::sync::mpsc::Receiver<LiveBar>,
        offered: Arc<Mutex<Vec<Bar>>>,
        asked: Arc<std::sync::atomic::AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    fn live(tf: Timeframe, cut: &str, seeds: Vec<Result<Option<Bar>, MarketError>>) -> Live {
        let (prints, rx) = tokio::sync::mpsc::unbounded_channel();
        let (tx, bars) = tokio::sync::mpsc::channel(64);
        let offered = Arc::new(Mutex::new(Vec::new()));
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let open = Opening {
            tf,
            calendar: SessionCalendar::CmeEquityIndex,
            cut: Timestamp::parse(cut).unwrap(),
        };
        let (o, a) = (Arc::clone(&offered), Arc::clone(&asked));
        let task = tokio::spawn(async move {
            let seed = || {
                let i = a.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let r = seeds[i.min(seeds.len() - 1)].clone();
                std::future::ready(r)
            };
            let id = InstrumentId::new("ESZ6.CME-RITHMIC").unwrap();
            let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx);
            live_bars(open, stream, seed, |b| o.lock().push(b), &tx, &id).await;
        });
        Live {
            prints,
            bars,
            offered,
            asked,
            task,
        }
    }

    impl Live {
        async fn next(&mut self) -> Option<LiveBar> {
            tokio::time::timeout(Duration::from_millis(900), self.bars.recv())
                .await
                .ok()
                .flatten()
        }

        fn asked(&self) -> usize {
            self.asked.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    fn down() -> Result<Option<Bar>, MarketError> {
        Err(MarketError::Unavailable(
            "the Rithmic history plant failed moments ago; try again shortly".into(),
        ))
    }

    #[tokio::test(start_paused = true)]
    async fn a_live_bar_closes_at_its_end_without_waiting_for_the_next_print() {
        let mut s = live(Timeframe::M5, "2026-10-07T12:02:10-04:00", vec![Ok(None)]);
        s.prints
            .send(print("2026-10-07T12:02:11-04:00", 101, 2, Aggressor::Buy))
            .unwrap();
        let open = s.next().await.unwrap();
        assert!(!open.closed);
        tokio::time::sleep(Duration::from_secs(170)).await;
        let closed = tokio::time::timeout(Duration::from_secs(5), s.bars.recv())
            .await
            .expect("the bar closes at 12:05 with no print after it")
            .unwrap();
        assert!(closed.closed);
        assert_eq!(closed.bar.t, open.bar.t);
        assert_eq!(closed.bar.c, Price::from(101));
        s.prints
            .send(print("2026-10-07T12:04:59-04:00", 99, 1, Aggressor::Sell))
            .unwrap();
        s.prints
            .send(print("2026-10-07T12:06:00-04:00", 102, 1, Aggressor::Buy))
            .unwrap();
        let next = s.next().await.unwrap();
        assert!(!next.closed, "a late print reopens nothing");
        assert_eq!(
            next.bar.t,
            Timestamp::parse("2026-10-07T12:05:00-04:00").unwrap()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_bar_already_trading_waits_for_its_seed() {
        let open = Timestamp::parse("2026-10-07T12:00:00-04:00").unwrap();
        let mut seed = Bar::flat(open, Price::from(100), Qty::from(40));
        seed.h = Price::from(110);
        seed.l = Price::from(95);
        let mut s = live(
            Timeframe::M5,
            "2026-10-07T12:02:10-04:00",
            vec![down(), down(), Ok(Some(seed))],
        );
        s.prints
            .send(print("2026-10-07T12:02:11-04:00", 101, 2, Aggressor::Buy))
            .unwrap();
        s.prints
            .send(print("2026-10-07T12:02:12-04:00", 102, 1, Aggressor::Sell))
            .unwrap();
        assert!(s.next().await.is_none());
        assert!(s.offered.lock().is_empty());
        assert_eq!(s.asked(), 1);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(s.asked(), 2);
        assert!(s.bars.try_recv().is_err());
        let bar = tokio::time::timeout(Duration::from_secs(3), s.bars.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(s.asked(), 3);
        assert!(!bar.closed);
        assert_eq!(
            (
                bar.bar.t, bar.bar.o, bar.bar.h, bar.bar.l, bar.bar.c, bar.bar.v
            ),
            (
                open,
                Price::from(100),
                Price::from(110),
                Price::from(95),
                Price::from(102),
                Qty::from(43)
            )
        );
        assert_eq!(s.offered.lock().last(), Some(&bar.bar));
        s.prints
            .send(print("2026-10-07T12:03:00-04:00", 111, 1, Aggressor::Buy))
            .unwrap();
        let next = s.next().await.unwrap();
        assert_eq!((next.bar.h, next.bar.v), (Price::from(111), Qty::from(44)));
        drop(s.prints);
        s.task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn later_buckets_stream_from_prints_while_the_first_waits() {
        let open = Timestamp::parse("2026-10-07T12:00:00-04:00").unwrap();
        let next_open = open.add_nanos(5 * 60 * NANOS_PER_SEC);
        let seed = Bar::flat(open, Price::from(100), Qty::from(40));
        let mut s = live(
            Timeframe::M5,
            "2026-10-07T12:04:58-04:00",
            vec![down(), down(), down(), Ok(Some(seed))],
        );
        s.prints
            .send(print("2026-10-07T12:04:59-04:00", 99, 3, Aggressor::Sell))
            .unwrap();
        s.prints
            .send(print("2026-10-07T12:05:01-04:00", 98, 2, Aggressor::Sell))
            .unwrap();
        let bar = s.next().await.unwrap();
        assert_eq!(
            (bar.bar.t, bar.bar.o, bar.bar.v, bar.bar.bv, bar.closed),
            (
                next_open,
                Price::from(98),
                Qty::from(2),
                Some(Qty::ZERO),
                false
            )
        );
        assert_eq!(s.offered.lock().as_slice(), &[bar.bar]);
        let first = tokio::time::timeout(Duration::from_secs(10), s.bars.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(first.closed);
        assert_eq!(
            (first.bar.t, first.bar.c, first.bar.v),
            (open, Price::from(99), Qty::from(43))
        );
        assert_eq!(s.offered.lock().last().map(|b| b.t), Some(next_open));
        s.prints
            .send(print("2026-10-07T12:04:59-04:00", 90, 1, Aggressor::Sell))
            .unwrap();
        assert!(s.next().await.is_none());
        drop(s.prints);
        s.task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_gap_in_the_prints_ends_the_bar_stream() {
        let mut s = live(Timeframe::M1, "2026-10-07T12:00:10-04:00", vec![Ok(None)]);
        s.prints
            .send(print("2026-10-07T12:00:11-04:00", 100, 1, Aggressor::Buy))
            .unwrap();
        let bar = s.next().await.unwrap();
        assert_eq!(bar.bar.v, Qty::from(1));
        drop(s.prints);
        assert!(s.bars.recv().await.is_none());
        s.task.await.unwrap();
    }

    async fn seed_at(tf: Timeframe, now: &str) -> (Option<Bar>, Vec<(Timeframe, Window)>) {
        let now = Timestamp::parse(now).unwrap();
        let asked = std::cell::RefCell::new(Vec::new());
        let seed = seed_bar(SessionCalendar::CmeEquityIndex, tf, now, |step, w| {
            asked.borrow_mut().push((step, w));
            let every = if step == Timeframe::M1 { 1_800 } else { 10 };
            let bars = (w.start..w.end)
                .filter(|t| t % every == 0)
                .map(|t| {
                    let ts = Timestamp::from_secs(t);
                    let hour = i64::from(ts.in_tz(chrono_tz::America::New_York).hour());
                    Bar::flat(ts, Price::from(100 + hour), Qty::from(1))
                })
                .collect();
            std::future::ready(Ok(bars))
        })
        .await
        .unwrap();
        (seed, asked.into_inner())
    }

    fn secs_of(at: &str) -> i64 {
        Timestamp::parse(at).unwrap().secs()
    }

    #[tokio::test]
    async fn a_daily_seed_at_midday_starts_at_the_globex_open_the_evening_before() {
        let (seed, asked) = seed_at(Timeframe::D1, "2026-10-07T12:00:30-04:00").await;
        assert_eq!(
            asked,
            vec![
                (
                    Timeframe::M1,
                    Window {
                        start: secs_of("2026-10-06T18:00:00-04:00"),
                        end: secs_of("2026-10-07T12:00:00-04:00"),
                    }
                ),
                (
                    Timeframe::S1,
                    Window {
                        start: secs_of("2026-10-07T12:00:00-04:00"),
                        end: secs_of("2026-10-07T12:00:30-04:00"),
                    }
                ),
            ]
        );
        let bar = seed.unwrap();
        assert_eq!(
            bar.t,
            Timestamp::parse("2026-10-07T00:00:00-04:00").unwrap()
        );
        assert_eq!(bar.o, Price::from(118));
        assert_eq!(bar.h, Price::from(123));
        assert_eq!(bar.l, Price::from(100));
        assert_eq!(bar.c, Price::from(112));
        assert_eq!(bar.v, Qty::from(36 + 3));
    }

    #[tokio::test]
    async fn a_daily_seed_after_the_globex_open_covers_the_new_session_only() {
        let (seed, asked) = seed_at(Timeframe::D1, "2026-10-07T19:00:30-04:00").await;
        assert_eq!(
            asked[0],
            (
                Timeframe::M1,
                Window {
                    start: secs_of("2026-10-07T18:00:00-04:00"),
                    end: secs_of("2026-10-07T19:00:00-04:00"),
                }
            )
        );
        let bar = seed.unwrap();
        assert_eq!(
            bar.t,
            Timestamp::parse("2026-10-08T00:00:00-04:00").unwrap()
        );
        assert_eq!((bar.o, bar.c), (Price::from(118), Price::from(119)));
        assert_eq!(bar.v, Qty::from(2 + 3));
    }

    #[tokio::test]
    async fn a_daily_seed_over_the_weekend_asks_for_nothing() {
        let (seed, asked) = seed_at(Timeframe::D1, "2026-10-10T12:00:00-04:00").await;
        assert!(seed.is_none());
        assert!(asked.is_empty(), "{asked:?}");
    }

    #[tokio::test]
    async fn an_intraday_seed_starts_at_its_bucket() {
        let (seed, asked) = seed_at(Timeframe::H1, "2026-10-07T12:40:00-04:00").await;
        assert_eq!(
            asked,
            vec![(
                Timeframe::M1,
                Window {
                    start: secs_of("2026-10-07T12:00:00-04:00"),
                    end: secs_of("2026-10-07T12:40:00-04:00"),
                }
            )]
        );
        let bar = seed.unwrap();
        assert_eq!(
            bar.t,
            Timestamp::parse("2026-10-07T12:00:00-04:00").unwrap()
        );
        assert_eq!(bar.v, Qty::from(2));
    }

    async fn next<T>(s: &mut MarketStream<T>) -> Option<T> {
        tokio::time::timeout(Duration::from_millis(500), s.next())
            .await
            .ok()
            .flatten()
    }

    #[tokio::test(start_paused = true)]
    async fn streams_carry_the_synthetic_session() {
        use rithmic_rs::rti::ResponseDepthByOrderSnapshot;
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: "wss://gateway.invalid".into(),
        };
        let opts = RithmicOptions::for_system("Rithmic Test");
        let market = RithmicMarket::new(login, opts).unwrap();
        assert_eq!(market.id(), "rithmic-test");
        let id = symbols::instrument_id("ESZ6", "CME");
        let mut trades = market.subscribe_trades(std::slice::from_ref(&id)).unwrap();
        let mut quotes = market.subscribe_quotes(std::slice::from_ref(&id)).unwrap();
        let mut orders = market.subscribe_order_book(&id).unwrap();
        assert!(matches!(
            market.subscribe_depth(&id, 10),
            Err(MarketError::Unsupported(_))
        ));
        let router = tessera_market::MarketRouter::new();
        router
            .add(Arc::clone(&market) as Arc<dyn MarketDataProvider>)
            .unwrap();
        let mut depth = router.subscribe_depth(&id, 10).unwrap();

        let session = crate::synthetic::recording();
        let key: FeedKey = ("ESZ6".into(), "CME".into());
        let mut frames: Vec<ResponseDepthByOrderSnapshot> = Vec::new();
        let mut prints = 0;
        for m in session {
            match m {
                RithmicMessage::ResponseDepthByOrderSnapshot(f) => {
                    let last = f.depth_side.is_none();
                    frames.push(f);
                    if last {
                        market.session.feeds.apply_snapshot(&key, &frames);
                    }
                }
                other => {
                    if let RithmicMessage::LastTrade(t) = &other
                        && map::trade(&id, t, map::Grid::default()).is_some()
                    {
                        prints += 1;
                    }
                    market.session.feeds.dispatch(&market.session, other);
                }
            }
        }

        let mut got = 0;
        while let Some(t) = next(&mut trades).await {
            assert_eq!(t.instrument, id);
            assert_ne!(t.aggressor, tessera_core::market::Aggressor::Unknown);
            got += 1;
        }
        assert_eq!(got, prints);
        let q = next(&mut quotes).await.unwrap();
        assert!(q.bid.is_some() && q.ask.is_some());
        let folded = market.quote(&id).await.unwrap();
        assert!(folded.bid.unwrap() < folded.ask.unwrap());
        assert!(folded.session.unwrap().volume.unwrap() > Qty::from(100_000));

        assert!(matches!(
            next(&mut orders).await,
            Some(OrderBookEvent::Clear { .. })
        ));
        let mut built = tessera_market::orderbook::OrderBookBuilder::new(id.clone());
        let (mut adds, mut changes) = (0, 0);
        while let Some(e) = next(&mut orders).await {
            match &e {
                OrderBookEvent::Add { .. } => adds += 1,
                OrderBookEvent::Modify { .. } | OrderBookEvent::Remove { .. } => changes += 1,
                OrderBookEvent::Clear { .. } | OrderBookEvent::Synced { .. } => {}
            }
            built.apply(e);
        }
        assert!(built.is_synced());
        assert!(
            adds > 100 && changes > 100,
            "{adds} adds, {changes} changes"
        );
        let whole = built.snapshot(usize::MAX);
        assert!(whole.bids.len() > 10 && whole.asks.len() > 10);
        let mut book = None;
        while let Some(b) = next(&mut depth).await {
            book = Some(b);
        }
        let book = book.expect("a book snapshot");
        assert_eq!((book.bids.len(), book.asks.len()), (10, 10));
        assert!(book.bids[0].price < book.asks[0].price);
        assert!(book.bids[0].orders.is_some_and(|n| n > 0));
        assert_eq!(book.bids, whole.bids[..10]);
        assert_eq!(book.asks, whole.asks[..10]);
        market.session.feeds.reset_all();
        assert!(matches!(
            next(&mut orders).await,
            Some(OrderBookEvent::Clear { .. })
        ));
        let gone = next(&mut depth).await.expect("the dropped book");
        assert!(gone.bids.is_empty() && gone.asks.is_empty());
        assert!(next(&mut depth).await.is_none());
        let caps = market.capabilities();
        assert!(caps.trades && caps.depth_levels.is_some() && !caps.footprint);
        assert_eq!(caps.aggressor_source, Some(AggressorSource::Exchange));
        assert!(tessera_market::router::effective(caps).footprint);

        let bars = market
            .get_bars(BarsRequest::latest(id.clone(), Timeframe::M1, 10))
            .await;
        assert!(matches!(bars, Err(MarketError::Unavailable(_))));
        let foreign = InstrumentId::new("ESZ6.CME").unwrap();
        assert!(matches!(
            market.spec(&foreign).await,
            Err(MarketError::UnknownInstrument(_))
        ));
        assert_eq!(
            market.health().status,
            tessera_core::health::HealthStatus::Disconnected
        );
        assert!(market.capabilities().realtime);
    }

    fn bars_in(w: Window, step: i64, n: usize) -> Vec<Bar> {
        (0..)
            .map(|i| w.end - step * (i + 1))
            .take_while(|t| *t >= w.start)
            .take(n)
            .map(|t| Bar::flat(Timestamp::from_secs(t), Price::from(100), Qty::from(1)))
            .collect()
    }

    fn sorted(mut raw: Vec<Bar>) -> Vec<Bar> {
        raw.sort_by_key(|b| b.t);
        raw.dedup_by_key(|b| b.t);
        raw
    }

    async fn reach(
        r: Reach,
        answer: impl Fn(Window) -> Vec<Bar>,
    ) -> (Result<Vec<Bar>, MarketError>, Vec<Window>) {
        let asked = std::cell::RefCell::new(Vec::new());
        let out = reach_back(
            r,
            |w| {
                asked.borrow_mut().push(w);
                std::future::ready(Ok(answer(w)))
            },
            sorted,
        )
        .await;
        (out, asked.into_inner())
    }

    fn one_minute(now: &str) -> Reach {
        let now = Timestamp::parse(now).unwrap();
        let end = now.secs().div_euclid(60) * 60 + 60;
        let bars = 1_500 * 60;
        Reach {
            end,
            earliest: end - MAX_INTRADAY_LOOKBACK_DAYS * 86_400,
            bar_secs: 60,
            first_span: bars * 3 / 2 + bars.min(3 * 86_400),
            limit: 1_500,
            now,
        }
    }

    #[tokio::test]
    async fn a_daily_reach_stops_after_the_contract_that_had_its_name_a_decade_before() {
        let (_, z6) = crate::symbols::spec_from_reference("ESZ6", "CME", None, true, 2026);
        let own_from = z6.earliest_bar(2026);
        let now = Timestamp::parse("2026-11-05T12:00:00-05:00").unwrap();
        let day = 86_400;
        let end = now.secs().div_euclid(day) * day + 2 * day;
        let r = Reach {
            end,
            earliest: (end - MAX_DAILY_LOOKBACK_DAYS * day).max(first_own_bar_secs(own_from, day)),
            bar_secs: day,
            first_span: 5_000 * day,
            limit: 5_000,
            now,
        };
        let (_, asked) = reach(r, |w| bars_in(w, day, 5_000)).await;
        let first_own = Timestamp::parse("2017-01-01T00:00:00-05:00")
            .unwrap()
            .secs();
        assert!(!asked.is_empty());
        assert!(asked.iter().all(|w| w.start >= first_own), "{asked:?}");
        assert!(end - MAX_DAILY_LOOKBACK_DAYS * day < first_own);
        assert_eq!(first_own_bar_secs(None, day), 0);
    }

    #[tokio::test]
    async fn a_thin_contract_in_cash_hours_gets_what_exists_not_an_error() {
        let r = one_minute("2026-10-07T12:00:00-04:00");
        let (out, asked) = reach(r, |w| bars_in(w, 3_600, 40)).await;
        let bars = out.expect("the bars found, not a long-pull error");
        assert_eq!(asked.len(), 2);
        assert_eq!(bars.len(), 80);
        assert_eq!(asked[1].end, asked[0].start);
        assert_eq!(asked[0].end, r.end);
        assert!(
            history::max_rows(
                Window {
                    start: asked[1].start,
                    end: r.end
                },
                60
            ) <= history::LONG_PULL_ROWS
        );
    }

    #[tokio::test]
    async fn widening_never_asks_for_a_row_twice_and_stops_at_its_cap() {
        let r = one_minute("2026-10-07T20:00:00-04:00");
        let (out, asked) = reach(r, |w| bars_in(w, 86_400, 1)).await;
        assert!(out.unwrap().len() < 1_500);
        assert_eq!(asked.len() as u32, MAX_WIDENINGS + 1);
        for pair in asked.windows(2) {
            assert_eq!(pair[1].end, pair[0].start, "{asked:?}");
            assert!(pair[1].start < pair[1].end);
        }
    }

    #[tokio::test]
    async fn widening_stops_where_the_contracts_data_begins() {
        let r = one_minute("2026-10-07T20:00:00-04:00");
        let first = std::cell::Cell::new(true);
        let (out, asked) = reach(r, |w| {
            if first.replace(false) {
                bars_in(w, 60, 500)
            } else {
                Vec::new()
            }
        })
        .await;
        assert_eq!(out.unwrap().len(), 500);
        assert_eq!(asked.len(), 2);
    }

    #[tokio::test]
    async fn older_bars_refused_while_widening_leave_the_bars_found() {
        let r = one_minute("2026-10-07T20:00:00-04:00");
        let refusal = || {
            MarketError::Unsupported(
                "Rithmic refused the bar replay: permission denied (code 13)".into(),
            )
        };
        let asked = std::cell::Cell::new(0);
        let out = reach_back(
            r,
            |w| {
                asked.set(asked.get() + 1);
                std::future::ready(if asked.get() == 1 {
                    Ok(bars_in(w, 60, 500))
                } else {
                    Err(refusal())
                })
            },
            sorted,
        )
        .await;
        assert_eq!(out.expect("the bars found before the refusal").len(), 500);
        assert_eq!(asked.get(), 2);
        let first = reach_back(r, |_| std::future::ready(Err(refusal())), sorted).await;
        assert_eq!(first, Err(refusal()));
    }

    #[tokio::test]
    async fn an_expired_contract_is_reached_back_to_and_enough_bars_end_it() {
        let r = one_minute("2026-10-07T20:00:00-04:00");
        let data_end = r.end - 20 * 86_400;
        let (out, asked) = reach(r, |w| {
            let w = Window {
                start: w.start,
                end: w.end.min(data_end),
            };
            if w.is_empty() {
                Vec::new()
            } else {
                bars_in(w, 60, 2_000)
            }
        })
        .await;
        assert_eq!(out.unwrap().len(), 2_000);
        assert!(asked.len() >= 2 && asked.len() as u32 <= MAX_WIDENINGS + 1);
    }

    #[tokio::test]
    async fn a_first_window_too_long_for_cash_hours_is_refused() {
        let mut r = one_minute("2026-10-07T12:00:00-04:00");
        r.first_span = (history::LONG_PULL_ROWS + 1) * 60;
        let (out, asked) = reach(r, |_| Vec::new()).await;
        assert!(matches!(out, Err(MarketError::Unsupported(_))));
        assert!(asked.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_snapshot_gives_the_book_up_without_buffering() {
        use rithmic_rs::rti::DepthByOrder;
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: "wss://gateway.invalid".into(),
        };
        let market = RithmicMarket::new(login, RithmicOptions::for_system("Rithmic Test")).unwrap();
        let id = symbols::instrument_id("ESZ6", "CME");
        let key: FeedKey = ("ESZ6".into(), "CME".into());
        let mut orders = market.subscribe_order_book(&id).unwrap();
        market.session.feeds.give_up(
            &key,
            "Rithmic refused the depth snapshot: no permission".into(),
        );
        let update = || {
            let mut u = DepthByOrder::default();
            u.symbol = Some("ESZ6".into());
            u.exchange = Some("CME".into());
            u.sequence_number = Some(1);
            u.update_type.push(1);
            u.transaction_type.push(1);
            u.depth_price.push(7000.0);
            u.depth_size.push(1);
            u.exchange_order_id.push("x".into());
            u
        };
        for _ in 0..=crate::book::MAX_PENDING_UPDATES {
            market
                .session
                .feeds
                .dispatch(&market.session, RithmicMessage::DepthByOrder(update()));
        }
        assert!(market.template_counts().is_empty());
        assert!(next(&mut orders).await.is_none());
        let why = market
            .session
            .feeds
            .unavailable_books(Duration::from_secs(30));
        assert_eq!(why.len(), 1);
        assert!(why[0].1.contains("no permission"));
        market.session.feeds.reset_all();
        assert!(
            market
                .session
                .feeds
                .unavailable_books(Duration::from_secs(30))
                .is_empty()
        );
    }

    #[test]
    fn a_series_reaching_now_ends_with_the_forming_bar() {
        let cal = SessionCalendar::CmeEquityIndex;
        let at = |s: &str| Timestamp::parse(s).unwrap();
        let bar = |t: &str, v: i64| Bar::flat(at(t), Price::from(100), Qty::from(v));
        let closed = vec![
            bar("2026-10-07T11:50:00-04:00", 10),
            bar("2026-10-07T11:55:00-04:00", 10),
            bar("2026-10-07T12:00:00-04:00", 3),
        ];
        let forming = bar("2026-10-07T12:00:00-04:00", 7);
        let req = BarsRequest::latest(symbols::instrument_id("ESZ6", "CME"), Timeframe::M5, 3);
        let out = with_forming(closed.clone(), forming, &req, cal);
        assert_eq!(out.len(), 3);
        assert_eq!(out.last(), Some(&forming));
        assert_eq!(out[0].t, at("2026-10-07T11:50:00-04:00"));
        let two = BarsRequest {
            limit: Some(2),
            ..req.clone()
        };
        let out = with_forming(closed[..2].to_vec(), forming, &two, cal);
        assert_eq!(
            out.iter().map(|b| b.t).collect::<Vec<_>>(),
            [at("2026-10-07T11:55:00-04:00"), forming.t]
        );
        let before = BarsRequest {
            to: Some(at("2026-10-07T11:55:00-04:00")),
            ..req.clone()
        };
        assert_eq!(
            with_forming(closed[..2].to_vec(), forming, &before, cal).len(),
            2
        );
        let night = bar("2026-10-07T20:00:00-04:00", 1);
        let rth = BarsRequest {
            rth_only: true,
            ..req.clone()
        };
        assert_eq!(
            with_forming(closed[..2].to_vec(), night, &rth, cal).len(),
            2
        );
        assert_eq!(
            with_forming(closed[..2].to_vec(), night, &req, cal).len(),
            3
        );
    }

    #[test]
    fn an_ended_live_stream_forgets_only_its_own_forming_bar() {
        let forming = FormingBars::default();
        let slot: (FeedKey, Timeframe) = (("ESZ6".into(), "CME".into()), Timeframe::M1);
        let bar = Bar::flat(Timestamp(0), Price::from(1), Qty::from(1));
        forming.lock().insert(slot.clone(), (2, bar));
        drop(Forget(Arc::clone(&forming), slot.clone(), 1));
        assert!(
            forming.lock().contains_key(&slot),
            "a newer stream's bar stays"
        );
        drop(Forget(Arc::clone(&forming), slot.clone(), 2));
        assert!(forming.lock().is_empty());
    }

    fn last_trade(secs: i32, price: f64) -> RithmicMessage {
        let mut t = rithmic_rs::rti::LastTrade::default();
        t.symbol = Some("ESZ6".into());
        t.exchange = Some("CME".into());
        t.presence_bits = Some(1);
        t.trade_price = Some(price);
        t.trade_size = Some(1);
        t.aggressor = Some(1);
        t.source_ssboe = Some(secs);
        t.source_nsecs = Some(0);
        RithmicMessage::LastTrade(t)
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_connection_breaks_the_hubs_recording_at_the_gap() {
        use tessera_market::hub::{MarketHub, PumpKey};
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: "wss://gateway.invalid".into(),
        };
        let market = RithmicMarket::new(login, RithmicOptions::for_system("Rithmic Test")).unwrap();
        let id = symbols::instrument_id("ESZ6", "CME");
        let router = tessera_market::MarketRouter::new();
        router
            .add(Arc::clone(&market) as Arc<dyn MarketDataProvider>)
            .unwrap();
        let hub = MarketHub::new(router, Arc::new(tessera_host::EventBus::new()));
        hub.set_linger(Duration::ZERO);
        let _tape = hub.acquire(PumpKey::Trades(id.clone())).unwrap();
        let whole_from = async |secs: i32| {
            let at = Timestamp::from_secs(i64::from(secs));
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let since = Timestamp::from_secs(i64::from(secs - 60));
                    let h = hub.history(&id, Some(since), None, None).await.unwrap();
                    if h.trades.last().is_some_and(|t| t.ts == at) {
                        return h.gaps.spans().last().map(|g| Timestamp(g.end));
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("the print reached the tape")
        };
        let t0 = 1_791_388_000;
        for (i, px) in [7000.0, 7000.25].into_iter().enumerate() {
            market
                .session
                .feeds
                .dispatch(&market.session, last_trade(t0 + i as i32, px));
        }
        assert_eq!(
            whole_from(t0 + 1).await,
            Some(Timestamp::from_secs(i64::from(t0)))
        );

        market.session.feeds.reset_all();
        tokio::time::sleep(Duration::from_millis(200)).await;
        market
            .session
            .feeds
            .dispatch(&market.session, last_trade(t0 + 10, 7001.0));
        assert_eq!(
            whole_from(t0 + 10).await,
            Some(Timestamp::from_secs(i64::from(t0 + 10))),
            "whole only after the gap"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_reopened_bar_stream_never_sends_the_trading_bar_unseeded() {
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: "wss://gateway.invalid".into(),
        };
        let market = RithmicMarket::new(login, RithmicOptions::for_system("Rithmic Test")).unwrap();
        let id = symbols::instrument_id("ESZ6", "CME");
        let still_this_hour = || {
            let now = Timestamp::now().secs();
            let last_second = now - now.rem_euclid(3_600) + 3_599;
            Timestamp::from_secs((now + 1).min(last_second))
        };
        let secs = |at: Timestamp| i32::try_from(at.secs()).unwrap();
        let mut bars = market.subscribe_bars(&id, Timeframe::H1).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let soon = still_this_hour();
        market
            .session
            .feeds
            .dispatch(&market.session, last_trade(secs(soon), 7000.0));
        assert!(next(&mut bars).await.is_none(), "no bar without its seed");

        market.session.feeds.reset_all();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), bars.next())
                .await
                .unwrap()
                .is_none()
        );
        let mut bars = market.subscribe_bars(&id, Timeframe::H1).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let soon = still_this_hour();
        market
            .session
            .feeds
            .dispatch(&market.session, last_trade(secs(soon), 7001.0));
        assert!(next(&mut bars).await.is_none(), "no bar without its seed");
        let later = soon.add_nanos(3 * 3_600 * NANOS_PER_SEC);
        market
            .session
            .feeds
            .dispatch(&market.session, last_trade(secs(later), 7002.0));
        let bar = next(&mut bars).await.expect("the later hour's bar");
        assert_eq!(
            bar.bar.t,
            SessionCalendar::CmeEquityIndex.bucket_start(later, Timeframe::H1)
        );
        assert_eq!(bar.bar.o, Price::from_f64(7002.0).unwrap());
        assert!(!bar.closed);
    }

    fn quote_market() -> (Arc<RithmicMarket>, InstrumentId, FeedKey) {
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: "wss://gateway.invalid".into(),
        };
        let market = RithmicMarket::new(login, RithmicOptions::for_system("Rithmic Test")).unwrap();
        (
            market,
            symbols::instrument_id("ESZ6", "CME"),
            ("ESZ6".into(), "CME".into()),
        )
    }

    async fn lookup(
        market: &Arc<RithmicMarket>,
        id: &InstrumentId,
        key: &FeedKey,
    ) -> tokio::task::JoinHandle<Result<Quote, MarketError>> {
        let (m, at) = (Arc::clone(market), id.clone());
        let task = tokio::spawn(async move { m.quote(&at).await });
        while !market.session.feeds.keys().contains(key) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        task
    }

    fn bbo() -> RithmicMessage {
        let mut b = rithmic_rs::rti::BestBidOffer::default();
        b.symbol = Some("ESZ6".into());
        b.exchange = Some("CME".into());
        b.presence_bits = Some(1 | 2);
        b.bid_price = Some(7000.0);
        b.bid_size = Some(5);
        b.ask_price = Some(7000.25);
        b.ask_size = Some(7);
        RithmicMessage::BestBidOffer(b)
    }

    #[tokio::test(start_paused = true)]
    async fn a_first_quote_waits_for_the_session_behind_the_bbo() {
        let (market, id, key) = quote_market();
        let task = lookup(&market, &id, &key).await;
        let feeds = &market.session.feeds;
        feeds.dispatch(&market.session, bbo());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!task.is_finished(), "the BBO alone does not answer");
        let mut snap = rithmic_rs::rti::LastTrade::default();
        snap.symbol = Some("ESZ6".into());
        snap.exchange = Some("CME".into());
        snap.is_snapshot = Some(true);
        snap.presence_bits = Some(1 | 8);
        snap.trade_price = Some(7000.25);
        snap.trade_size = Some(2);
        snap.net_change = Some(-12.5);
        snap.volume = Some(619);
        feeds.dispatch(&market.session, RithmicMessage::LastTrade(snap));
        let mut stats = rithmic_rs::rti::TradeStatistics::default();
        stats.symbol = Some("ESZ6".into());
        stats.exchange = Some("CME".into());
        stats.presence_bits = Some(1 | 2 | 4);
        stats.open_price = Some(7010.0);
        stats.high_price = Some(7015.0);
        stats.low_price = Some(6990.0);
        feeds.dispatch(&market.session, RithmicMessage::TradeStatistics(stats));
        let q = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(q.bid, Some("7000".parse().unwrap()));
        assert_eq!(q.last, Some("7000.25".parse().unwrap()));
        let s = q.session.unwrap();
        assert_eq!(s.volume, Some(Qty::from(619)));
        assert_eq!(s.open, Some("7010".parse().unwrap()));
        assert_eq!(s.prev_close, Some("7012.75".parse().unwrap()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_quote_without_its_session_says_the_volume_is_unknown() {
        let (market, id, key) = quote_market();
        let task = lookup(&market, &id, &key).await;
        let at = tokio::time::Instant::now();
        market.session.feeds.dispatch(&market.session, bbo());
        let q = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            at.elapsed() >= Duration::from_millis(900),
            "waited for the session"
        );
        assert!(q.ask.is_some() && q.last.is_none());
        assert_eq!(q.session.unwrap().volume, None);
        let at = tokio::time::Instant::now();
        let again = market.quote(&id).await.unwrap();
        assert!(at.elapsed() < Duration::from_millis(100));
        assert_eq!(again.session.unwrap().volume, None);
    }

    #[tokio::test(start_paused = true)]
    async fn feed_prices_are_put_on_the_learned_tick() {
        let login = RithmicLogin {
            user: "nobody".into(),
            password: "unused".into(),
            system_name: "Rithmic Test".into(),
            gateway_url: "wss://gateway.invalid".into(),
        };
        let market = RithmicMarket::new(login, RithmicOptions::for_system("Rithmic Test")).unwrap();
        let id = symbols::instrument_id("ESZ6", "CME");
        let key: FeedKey = ("ESZ6".into(), "CME".into());
        market
            .session
            .feeds
            .set_grid(&key, map::Grid::of("0.25".parse().unwrap()));
        let mut trades = market.subscribe_trades(std::slice::from_ref(&id)).unwrap();
        market.session.feeds.dispatch(
            &market.session,
            last_trade(1_791_388_000, 7000.250000000001),
        );
        let t = next(&mut trades).await.unwrap();
        assert_eq!(t.price, "7000.25".parse().unwrap());
        assert_eq!(t.price.to_string(), "7000.25");
        let q = market.session.feeds.quote(&key).unwrap();
        assert_eq!(q.last, Some("7000.25".parse().unwrap()));
    }

    #[test]
    fn daily_windows_use_cme_trade_dates() {
        let evening = Timestamp::parse("2026-10-07T19:00:00-04:00").unwrap();
        assert_eq!(yyyymmdd(evening.secs()), 20_261_008);
        assert_eq!(clamp_i32(-5), 0);
        assert_eq!(clamp_i32(i64::MAX), i32::MAX);
    }
}
