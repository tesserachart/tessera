use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use chrono::{Datelike, Duration, NaiveDate};
use chrono_tz::Tz;
use parking_lot::RwLock;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use tessera_core::hash::sha256_hex;
use tessera_core::ids::unique;
use tessera_core::ids::{AccountId, FillId};
use tessera_core::instrument::{ContractSpec, InstrumentId};
use tessera_core::orders::{Fill, Order, OrderRole, Side};
use tessera_core::time::DisplayZone;
use tessera_core::{Money, Price, Qty, Timestamp};
use tessera_host::{EventBus, TopicKey};
use tessera_store::Store;
use tessera_store::blobs::BlobStore;
use tessera_tools::ToolError;

use crate::activity::{
    self, ActorKind, EventSource, FillRef, Leg, MoveDirection, OrderEvent, TradeAnalysis,
    TradeInput,
};
use crate::filter::{FilterCtx, keeps, sort};
use crate::import::{self, Platform, RawFill};
use crate::model::*;
use crate::repo::{AccountRow, Excursion, JournalFill, Repo, SetupBody, TagRow, TradeMeta};
use crate::specs::{ContractName, display_symbol, fallback_spec};
use crate::stats::{self, bucket, cents, day_label};
use crate::trades::{Execution, ExecutionKind, TradeBuilder};

pub const JOURNAL_CHANGES: &str = "journal.changes";

#[async_trait]
pub trait MarketSource: Send + Sync + 'static {
    async fn spec(&self, instrument: &InstrumentId) -> Option<ContractSpec>;
    async fn bars(
        &self,
        instrument: &InstrumentId,
        from: Timestamp,
        to: Timestamp,
    ) -> Option<Vec<(Timestamp, f64, f64)>>;
}

#[derive(Clone, Debug)]
struct Core {
    id: String,
    account: String,
    instrument: InstrumentId,
    side: Side,
    closed: bool,
    qty: Decimal,
    max_qty: Decimal,
    entry: Decimal,
    exit: Option<Decimal>,
    opened_at: Timestamp,
    closed_at: Option<Timestamp>,
    trade_date: NaiveDate,
    gross: Decimal,
    fees: Decimal,
    executions: Vec<Execution>,
    fill_ids: Vec<FillId>,
    origin: FillOrigin,
    source: String,
    reported: Option<Decimal>,
    exit_role: Option<OrderRole>,
    plan_stop: Option<Decimal>,
    plan_target: Option<Decimal>,
}

#[derive(Default)]
struct State {
    fills: BTreeMap<(String, String), Vec<JournalFill>>,
    specs: HashMap<String, ContractSpec>,
    accounts: HashMap<String, AccountRow>,
    metas: HashMap<String, TradeMeta>,
    tags: Vec<TagRow>,
    trade_tags: HashMap<String, Vec<String>>,
    setups: Vec<(String, Timestamp, SetupBody)>,
    rule_checks: HashMap<String, HashMap<String, bool>>,
    attachments: HashMap<String, u32>,
    settings: JournalSettings,
    cores: BTreeMap<(String, String), Vec<Core>>,
    rows: Option<Arc<Vec<JournalTrade>>>,
    days: BTreeSet<NaiveDate>,
    seq: i64,
    snapshots: HashMap<String, Order>,
    events: BTreeMap<(String, String), Vec<OrderEvent>>,
    analyses: HashMap<String, Arc<TradeAnalysis>>,
    analysis_keys: BTreeMap<(String, String), Vec<String>>,
    coverage: HashMap<String, (Option<Timestamp>, Option<Timestamp>)>,
    ev_seq: i64,
    trash: BTreeMap<String, (Timestamp, Vec<JournalFill>)>,
}

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::internal(e.to_string())
}

fn f(d: Decimal) -> f64 {
    d.to_f64().unwrap_or(0.0)
}

fn short_hash(s: &str) -> String {
    sha256_hex(s.as_bytes())[..16].to_owned()
}

#[derive(Clone, Debug)]
pub struct NewFill {
    pub fill: Fill,
    pub role: Option<OrderRole>,
    pub stop: Option<Price>,
    pub target: Option<Price>,
    pub reported_pnl: Option<Decimal>,
}

impl NewFill {
    pub fn plain(fill: Fill) -> Self {
        Self {
            fill,
            role: None,
            stop: None,
            target: None,
            reported_pnl: None,
        }
    }

    fn kept(self, seq: i64, from: &FillSource) -> JournalFill {
        JournalFill {
            fill: self.fill,
            seq,
            origin: from.origin(),
            import_id: from.import_id(),
            role: self.role,
            stop: self.stop,
            target: self.target,
            reported_pnl: self.reported_pnl,
        }
    }
}

#[derive(Clone, Debug)]
pub enum FillSource {
    Broker,
    Import(Box<ImportInfo>),
    Manual,
}

impl FillSource {
    fn origin(&self) -> FillOrigin {
        match self {
            FillSource::Broker => FillOrigin::Broker,
            FillSource::Import(_) => FillOrigin::Import,
            FillSource::Manual => FillOrigin::Manual,
        }
    }

    fn import_id(&self) -> Option<String> {
        match self {
            FillSource::Import(info) => Some(info.id.clone()),
            FillSource::Broker | FillSource::Manual => None,
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            FillSource::Broker => "fills",
            FillSource::Import(_) => "import",
            FillSource::Manual => "manual",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Added {
    pub fills: usize,
    pub trades: Vec<String>,
}

pub struct JournalService {
    repo: Repo,
    blobs: Option<BlobStore>,
    bus: Option<Arc<EventBus>>,
    market: Option<Arc<dyn MarketSource>>,
    state: RwLock<State>,
    revision: AtomicU64,
    zone: DisplayZone,
}

impl std::fmt::Debug for JournalService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JournalService")
            .field("revision", &self.revision.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl JournalService {
    pub fn open(
        store: Store,
        blobs: Option<BlobStore>,
        bus: Option<Arc<EventBus>>,
        market: Option<Arc<dyn MarketSource>>,
    ) -> tessera_store::Result<Self> {
        let repo = Repo::new(store);
        let mut st = State {
            settings: repo.settings()?,
            metas: repo.metas()?,
            tags: repo.tags()?,
            trade_tags: repo.trade_tags()?,
            setups: repo.setups()?,
            rule_checks: repo.rule_checks()?,
            attachments: repo.attachment_counts()?,
            ..State::default()
        };
        for a in repo.accounts()? {
            st.accounts.insert(a.id.clone(), a);
        }
        for s in repo.instruments()? {
            st.specs.insert(s.instrument.to_string(), s);
        }
        for jf in repo.fills()? {
            st.seq = st.seq.max(jf.seq + 1);
            st.fills
                .entry((
                    jf.fill.account_id.to_string(),
                    jf.fill.instrument.to_string(),
                ))
                .or_default()
                .push(jf);
        }
        for (trade, at, jf) in repo.trashed_fills()? {
            st.seq = st.seq.max(jf.seq + 1);
            let e = st.trash.entry(trade).or_insert((at, Vec::new()));
            e.0 = e.0.max(at);
            e.1.push(jf);
        }
        st.days = repo
            .days()?
            .into_iter()
            .filter_map(|(d, _)| NaiveDate::from_str(&d).ok())
            .collect();
        for o in repo.order_snapshots()? {
            st.snapshots.insert(o.id.to_string(), o);
        }
        for e in repo.order_events()? {
            st.ev_seq = st.ev_seq.max(e.seq + 1);
            st.events
                .entry((e.account_id.clone(), e.instrument.clone()))
                .or_default()
                .push(e);
        }
        for (a, live, back) in repo.activity_accounts()? {
            st.coverage.insert(a, (live, back));
        }
        if repo.flag("activity_backfill")?.is_none() {
            backfill(&repo, &mut st)?;
            repo.put_flag("activity_backfill", "1")?;
        }
        let keys: Vec<_> = st.fills.keys().cloned().collect();
        for k in keys {
            if let Some(v) = st.fills.get_mut(&k) {
                keep_splits(&repo, split_reversals(v));
            }
            rebuild(&mut st, &k);
        }
        if repo.checklist()?.is_empty() {
            repo.put_checklist(&[ChecklistItem {
                id: "pre-market".into(),
                text: "Pre-market check".into(),
                active: true,
            }])?;
        }
        Ok(Self {
            repo,
            blobs,
            bus,
            market,
            state: RwLock::new(st),
            revision: AtomicU64::new(0),
            zone: DisplayZone::default(),
        })
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    fn publish(&self, reason: &str, trade_ids: Vec<String>) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(bus) = &self.bus {
            bus.publish(
                JOURNAL_CHANGES,
                TopicKey::None,
                &JournalChange {
                    revision,
                    reason: reason.into(),
                    trade_ids,
                },
            );
        }
    }

    fn tz(&self) -> Tz {
        self.zone.get()
    }

    pub fn set_display_zone(&self, zone: Tz) {
        if self.zone.get() != zone {
            self.zone.set(zone);
            self.edited(Vec::new());
        }
    }

    pub fn today(&self, now: Timestamp) -> NaiveDate {
        now.in_tz(self.tz()).date_naive()
    }

    pub fn trades(&self) -> Arc<Vec<JournalTrade>> {
        if let Some(rows) = self.state.read().rows.clone() {
            return rows;
        }
        let mut st = self.state.write();
        if let Some(rows) = st.rows.clone() {
            return rows;
        }
        let mut rows: Vec<JournalTrade> = st
            .cores
            .values()
            .flatten()
            .map(|c| derive(c, &st))
            .collect();
        rows.sort_by(|a, b| b.opened_at.cmp(&a.opened_at).then(a.id.cmp(&b.id)));
        let rows = Arc::new(rows);
        st.rows = Some(Arc::clone(&rows));
        rows
    }

    fn filtered(&self, filter: &TradeFilter) -> (Arc<Vec<JournalTrade>>, Vec<usize>) {
        let rows = self.trades();
        let st = self.state.read();
        let tz = self.tz();
        let notes = |id: &str| st.metas.get(id).map(|m| m.notes.as_str());
        let ctx = FilterCtx {
            tz,
            sessions: &st.settings.sessions,
            notes: &notes,
        };
        let idx = rows
            .iter()
            .enumerate()
            .filter(|(_, t)| keeps(filter, t, &ctx))
            .map(|(i, _)| i)
            .collect();
        (rows, idx)
    }

    pub async fn ingest(
        &self,
        fills: Vec<Fill>,
        order_of: &(dyn Fn(&tessera_core::ids::OrderId) -> Option<Order> + Send + Sync),
    ) -> Result<usize, ToolError> {
        if fills.is_empty() {
            return Ok(0);
        }
        let known = self.known_fills();
        let fresh: Vec<Fill> = fills
            .into_iter()
            .filter(|f| !known.contains(f.id.as_str()))
            .collect();
        if fresh.is_empty() {
            return Ok(0);
        }
        for f in &fresh {
            self.ensure_spec(&f.instrument).await;
        }
        let mut news = Vec::with_capacity(fresh.len());
        {
            let st = self.state.read();
            for fill in fresh {
                let order = fill.order_id.as_ref().and_then(|id| {
                    order_of(id).or_else(|| self.repo.broker_order(id.as_str()).ok().flatten())
                });
                let (role, stop, target) = match &order {
                    Some(o) => {
                        let tick = st
                            .specs
                            .get(o.request.instrument.as_str())
                            .map(|s| s.tick_size.0);
                        let at = o.avg_fill_price.unwrap_or(fill.price);
                        let b = o
                            .request
                            .bracket
                            .map(|b| tick.map_or(b, |t| b.priced_from(o.request.side, at, t)));
                        (
                            Some(o.role),
                            b.and_then(|b| b.stop_loss),
                            b.and_then(|b| b.take_profit),
                        )
                    }
                    None => (None, None, None),
                };
                news.push(NewFill {
                    role,
                    stop,
                    target,
                    ..NewFill::plain(fill)
                });
            }
        }
        Ok(self.add_fills(news, FillSource::Broker)?.fills)
    }

    pub fn add_fills(&self, fills: Vec<NewFill>, from: FillSource) -> Result<Added, ToolError> {
        let kept: Vec<JournalFill> = {
            let mut st = self.state.write();
            let base = st.seq;
            st.seq += fills.len() as i64;
            fills
                .into_iter()
                .zip(base..)
                .map(|(f, seq)| f.kept(seq, &from))
                .collect()
        };
        let added = self.repo.insert_fills(&kept).map_err(internal)?;
        let fills = added.len();
        if let FillSource::Import(info) = &from {
            let info = ImportInfo {
                fills: fills as u32,
                ..(**info).clone()
            };
            self.repo.put_import(&info).map_err(internal)?;
        } else if fills == 0 {
            return Ok(Added::default());
        }
        let trades = self.absorb(added);
        self.publish(from.reason(), trades.clone());
        Ok(Added { fills, trades })
    }

    fn known_fills(&self) -> BTreeSet<String> {
        let st = self.state.read();
        st.fills
            .values()
            .flatten()
            .chain(st.trash.values().flat_map(|(_, v)| v))
            .map(|f| f.fill.id.to_string())
            .collect()
    }

    pub fn name_account(&self, id: &str, name: &str) {
        let mut st = self.state.write();
        if st.accounts.get(id).is_some_and(|a| a.name == name) {
            return;
        }
        let row = AccountRow {
            id: id.into(),
            name: name.into(),
            origin: FillOrigin::Broker,
            platform: None,
        };
        if self.repo.put_account(&row).is_ok() {
            st.accounts.insert(id.into(), row);
            st.rows = None;
        }
    }

    pub fn record_orders(
        &self,
        orders: Vec<Order>,
        received: Timestamp,
        source: EventSource,
    ) -> Result<Vec<String>, ToolError> {
        let mut st = self.state.write();
        let mut fresh: Vec<OrderEvent> = Vec::new();
        let mut snaps: Vec<Order> = Vec::new();
        for o in orders {
            let id = o.id.to_string();
            let prev = st.snapshots.get(&id);
            if prev.is_some_and(|p| o.updated_at < p.updated_at) {
                continue;
            }
            let mut evs = activity::diff(prev, &o, received, source);
            if !evs.is_empty() {
                for e in &mut evs {
                    e.seq = st.ev_seq;
                    st.ev_seq += 1;
                }
                fresh.extend(evs);
                snaps.push(o.clone());
            }
            st.snapshots.insert(id, o);
        }
        if fresh.is_empty() {
            return Ok(Vec::new());
        }
        self.repo
            .put_order_events(&fresh, &snaps)
            .map_err(internal)?;
        let mut keys: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
        for e in fresh {
            let key = (e.account_id.clone(), e.instrument.clone());
            keys.entry(key.clone())
                .or_default()
                .insert(e.order_id.clone());
            st.events.entry(key).or_default().push(e);
        }
        let mut ids = Vec::new();
        for (k, orders) in &keys {
            let mut since = None::<Timestamp>;
            if let Some(v) = st.events.get_mut(k) {
                v.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.seq.cmp(&b.seq)));
                since = v
                    .iter()
                    .find(|e| orders.contains(&e.order_id))
                    .map(|e| e.ts);
            }
            ids.extend(refresh_activity_since(&mut st, k, since));
        }
        st.rows = None;
        Ok(ids)
    }

    pub fn mark_live(&self, account: &str, at: Timestamp) {
        let mut st = self.state.write();
        if st.coverage.get(account).is_some_and(|c| c.0.is_some()) {
            return;
        }
        if self
            .repo
            .put_activity_account(account, Some(at), None)
            .is_ok()
        {
            st.coverage.entry(account.to_owned()).or_default().0 = Some(at);
            let keys: Vec<_> = st
                .cores
                .keys()
                .filter(|k| k.0 == account)
                .cloned()
                .collect();
            for k in keys {
                refresh_activity(&mut st, &k);
            }
            st.rows = None;
        }
    }

    pub fn announce_activity(&self, trade_ids: Vec<String>) {
        self.publish("activity", trade_ids);
    }

    async fn ensure_spec(&self, instrument: &InstrumentId) {
        if self.state.read().specs.contains_key(instrument.as_str()) {
            return;
        }
        let spec = match &self.market {
            Some(m) => m.spec(instrument).await,
            None => None,
        };
        let spec = spec.unwrap_or_else(|| {
            let sym = instrument.as_str().split('.').next().unwrap_or_default();
            let root = ContractName::parse(sym, 2026).map_or_else(|| sym.to_owned(), |c| c.root);
            fallback_spec(instrument, &root).0
        });
        if self.repo.put_instrument(&spec).is_ok() {
            self.state
                .write()
                .specs
                .insert(instrument.to_string(), spec);
        }
    }

    fn absorb(&self, added: Vec<JournalFill>) -> Vec<String> {
        let mut st = self.state.write();
        let mut keys = BTreeSet::new();
        for jf in added {
            let key = (
                jf.fill.account_id.to_string(),
                jf.fill.instrument.to_string(),
            );
            let v = st.fills.entry(key.clone()).or_default();
            v.push(jf);
            v.sort_by(|a, b| {
                a.fill
                    .ts
                    .cmp(&b.fill.ts)
                    .then(a.seq.cmp(&b.seq))
                    .then_with(|| a.fill.id.as_str().cmp(b.fill.id.as_str()))
            });
            keys.insert(key);
        }
        for k in &keys {
            if let Some(v) = st.fills.get_mut(k) {
                keep_splits(&self.repo, split_reversals(v));
            }
        }
        let mut ids = Vec::new();
        for k in keys {
            rebuild(&mut st, &k);
            ids.extend(st.cores.get(&k).into_iter().flatten().map(|c| c.id.clone()));
        }
        ids
    }

    pub fn list(&self, input: &ListTradesInput) -> ListTradesOutput {
        let filter = input.filter.clone().unwrap_or_default();
        let (rows, idx) = self.filtered(&filter);
        let mut kept: Vec<&JournalTrade> = idx.iter().map(|i| &rows[*i]).collect();
        sort(
            &mut kept,
            input.sort.unwrap_or_default(),
            input.ascending.unwrap_or(false),
        );
        let summary = bucket("filter", "These trades", kept.iter().copied());
        let offset = input.offset.unwrap_or(0) as usize;
        let limit = input.limit.unwrap_or(200).clamp(1, 2000) as usize;
        ListTradesOutput {
            total: kept.len() as u32,
            trades: kept.into_iter().skip(offset).take(limit).cloned().collect(),
            summary,
        }
    }

    pub async fn trade(&self, input: &GetTradeInput) -> Result<TradeDetail, ToolError> {
        self.measure_excursion(&input.id, true).await;
        let (rows, idx) = self.filtered(&input.filter.clone().unwrap_or_default());
        let Some(pos) = rows.iter().position(|t| t.id == input.id) else {
            return Err(ToolError::not_found(format!("no trade {}", input.id)));
        };
        let trade = rows[pos].clone();
        let at = idx.iter().position(|i| *i == pos);
        let next_id = at
            .and_then(|a| a.checked_sub(1))
            .map(|a| rows[idx[a]].id.clone());
        let prev_id = at.and_then(|a| idx.get(a + 1)).map(|i| rows[*i].id.clone());
        let st = self.state.read();
        let core = st
            .cores
            .values()
            .flatten()
            .find(|c| c.id == input.id)
            .cloned()
            .ok_or_else(|| ToolError::not_found(format!("no trade {}", input.id)))?;
        let key = (core.account.clone(), core.instrument.to_string());
        let roles: HashMap<String, Option<OrderRole>> = st
            .fills
            .get(&key)
            .into_iter()
            .flatten()
            .map(|jf| (jf.fill.id.to_string(), jf.role))
            .collect();
        let executions = core
            .executions
            .iter()
            .map(|e| ExecutionRow {
                fill_id: e.fill_id.to_string(),
                kind: e.kind,
                side: e.side,
                qty: f(e.qty.0),
                price: f(e.price.0),
                ts: e.ts,
                fee: cents(f(e.fee)),
                realized: e.realized.map(|r| cents(f(r))),
                role: roles
                    .get(e.fill_id.as_str())
                    .copied()
                    .flatten()
                    .filter(|r| *r != OrderRole::Entry)
                    .map(|r| {
                        match r {
                            OrderRole::StopLoss => "stop_loss",
                            OrderRole::TakeProfit => "take_profit",
                            OrderRole::Exit => "exit",
                            OrderRole::Entry => "entry",
                        }
                        .to_owned()
                    }),
            })
            .collect();
        let meta = st.metas.get(&input.id).cloned().unwrap_or_default();
        let rules = trade
            .setup_id
            .as_ref()
            .and_then(|s| st.setups.iter().find(|(id, _, _)| id == s))
            .map(|(_, _, body)| {
                let ticks = st.rule_checks.get(&input.id);
                body.rules
                    .iter()
                    .map(|r| RuleCheck {
                        rule_id: r.id.clone(),
                        text: r.text.clone(),
                        category: r.category.clone(),
                        checked: ticks.and_then(|t| t.get(&r.id)).copied().unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let spec = spec_of(&st, &core.instrument);
        let analysis = st.analyses.get(&input.id).cloned();
        let events: Vec<OrderEvent> = match &analysis {
            Some(a) => st
                .events
                .get(&key)
                .into_iter()
                .flatten()
                .filter(|e| a.legs.contains_key(&e.order_id))
                .cloned()
                .collect(),
            None => Vec::new(),
        };
        let live_since = st.coverage.get(&core.account).and_then(|c| c.0);
        drop(st);
        let activity = match analysis {
            Some(a) => Some(self.activity_view(&input.id, &a, &events, core.side, live_since)?),
            None => None,
        };
        let attachments = self
            .repo
            .attachments("trade", &input.id)
            .map_err(internal)?;
        let drawings = self.repo.drawings(&input.id).map_err(internal)?;
        let excursion_note = (trade.status == TradeStatus::Closed && trade.mae.is_none()).then(|| {
            "No 1-minute bars for its time from the connections now open, so MAE and MFE are not measured.".to_owned()
        });
        Ok(TradeDetail {
            trade,
            executions,
            notes: meta.notes,
            attachments,
            rules,
            prev_id,
            next_id,
            point_value: f(spec.multiplier),
            tick_size: f(spec.tick_size.0),
            excursion_note,
            activity,
            drawings,
        })
    }

    fn activity_view(
        &self,
        trade_id: &str,
        a: &TradeAnalysis,
        events: &[OrderEvent],
        side: Side,
        live_since: Option<Timestamp>,
    ) -> Result<TradeActivity, ToolError> {
        let shown: Vec<&OrderEvent> = events
            .iter()
            .filter(|e| a.legs.contains_key(&e.order_id) && e.ts >= a.from && e.ts <= a.to)
            .collect();
        let calls = self
            .repo
            .order_calls(Some((
                Timestamp(a.from.0 - 120 * 1_000_000_000),
                Timestamp(a.to.0 + 60 * 1_000_000_000),
            )))
            .map_err(internal)?;
        let actors = activity::attribute(&shown, events, &calls);
        let rows = shown
            .into_iter()
            .zip(actors)
            .map(|(e, actor)| {
                let leg = a.legs.get(&e.order_id).copied();
                activity_row(e, Some(trade_id), leg, actor, side, a.tick)
            })
            .collect();
        Ok(TradeActivity {
            summary: a.summary.clone(),
            stop_path: a.stop_path.clone(),
            target_path: a.target_path.clone(),
            moves: a.moves.clone(),
            rows,
            end: a.end,
            live_since,
        })
    }

    pub fn activity(&self, input: &GetActivityInput) -> Result<ActivityOutput, ToolError> {
        let st = self.state.read();
        let limit = input.limit.unwrap_or(500).clamp(1, 5000) as usize;
        let trade = input
            .trade_id
            .as_ref()
            .map(|id| {
                st.analyses
                    .get(id)
                    .cloned()
                    .ok_or_else(|| ToolError::not_found(format!("no activity for trade {id}")))
            })
            .transpose()?;
        let mut owner: HashMap<&str, Vec<(&str, Leg, Timestamp, Timestamp)>> = HashMap::new();
        for (tid, an) in &st.analyses {
            for (oid, leg) in &an.legs {
                owner
                    .entry(oid.as_str())
                    .or_default()
                    .push((tid.as_str(), *leg, an.from, an.to));
            }
        }
        let want_inst = input.instrument.as_deref().map(str::to_ascii_uppercase);
        let mut picked: Vec<(&OrderEvent, &[OrderEvent])> = Vec::new();
        for ((account, instrument), evs) in &st.events {
            if input.account_id.as_deref().is_some_and(|a| a != account) {
                continue;
            }
            if let Some(w) = &want_inst {
                let sym = instrument
                    .split('.')
                    .next()
                    .unwrap_or(instrument)
                    .to_ascii_uppercase();
                let inst = InstrumentId::new(instrument).ok();
                let display = inst.as_ref().map(|i| {
                    display_symbol(i, st.specs.get(instrument.as_str())).to_ascii_uppercase()
                });
                if *w != instrument.to_ascii_uppercase()
                    && *w != sym
                    && display.as_deref() != Some(w.as_str())
                {
                    continue;
                }
            }
            let dates = |e: &OrderEvent| -> NaiveDate {
                let inst = InstrumentId::new(&e.instrument)
                    .unwrap_or_else(|_| InstrumentId::from_parts("X", None));
                spec_of(&st, &inst).sessions.trade_date(e.ts)
            };
            for e in evs {
                if let Some(a) = &trade
                    && !(a.legs.contains_key(&e.order_id) && e.ts >= a.from && e.ts <= a.to)
                {
                    continue;
                }
                if input.from.is_some() || input.to.is_some() {
                    let d = dates(e);
                    if input.from.is_some_and(|f| d < f) || input.to.is_some_and(|t| d > t) {
                        continue;
                    }
                }
                picked.push((e, evs.as_slice()));
            }
        }
        picked.sort_by(|a, b| a.0.ts.cmp(&b.0.ts).then(a.0.seq.cmp(&b.0.seq)));
        let total = picked.len() as u32;
        let picked: Vec<_> = picked.split_off(picked.len().saturating_sub(limit));
        let (from, to) = match (picked.first(), picked.last()) {
            (Some(a), Some(b)) => (a.0.ts, b.0.ts),
            _ => (Timestamp(0), Timestamp(0)),
        };
        let accounts = coverage_list(&st);
        let sides: HashMap<&str, (Side, f64)> = st
            .cores
            .values()
            .flatten()
            .map(|c| {
                let spec = spec_of(&st, &c.instrument);
                (c.id.as_str(), (c.side, f(spec.tick_size.0)))
            })
            .collect();
        let calls = if picked.is_empty() {
            Vec::new()
        } else {
            self.repo
                .order_calls(Some((
                    Timestamp(from.0 - 600 * 1_000_000_000),
                    Timestamp(to.0 + 60 * 1_000_000_000),
                )))
                .map_err(internal)?
        };
        let mut actors: HashMap<&str, activity::Actor> = HashMap::new();
        type Group<'e> = (Vec<&'e OrderEvent>, &'e [OrderEvent]);
        let mut groups: BTreeMap<(&str, &str), Group<'_>> = BTreeMap::new();
        for (e, context) in &picked {
            groups
                .entry((e.account_id.as_str(), e.instrument.as_str()))
                .or_insert_with(|| (Vec::new(), context))
                .0
                .push(e);
        }
        for (shown, context) in groups.values() {
            for (e, a) in shown
                .iter()
                .zip(activity::attribute(shown, context, &calls))
            {
                actors.insert(e.id.as_str(), a);
            }
        }
        let mut rows = Vec::with_capacity(picked.len());
        for (e, _) in &picked {
            let actor = actors.remove(e.id.as_str()).unwrap_or(activity::Actor {
                kind: ActorKind::Outside,
                via: None,
                call_id: None,
                session_id: None,
                summary: None,
            });
            let mine = owner.get(e.order_id.as_str()).and_then(|v| {
                v.iter()
                    .find(|(_, _, f, t)| e.ts >= *f && e.ts <= *t)
                    .or_else(|| v.first())
            });
            let (tid, leg) = mine.map_or((None, None), |(t, l, _, _)| (Some(*t), Some(*l)));
            let (side, tick) = tid
                .and_then(|t| sides.get(t).copied())
                .unwrap_or((e.side, 0.0));
            rows.push(activity_row(e, tid, leg, actor, side, tick));
        }
        Ok(ActivityOutput {
            rows,
            total,
            accounts,
        })
    }

    pub async fn measure_excursion(&self, id: &str, retry: bool) {
        let Some(market) = self.market.clone() else {
            return;
        };
        let target = {
            let st = self.state.read();
            let Some(core) = st.cores.values().flatten().find(|c| c.id == id) else {
                return;
            };
            let (Some(closed_at), true) = (core.closed_at, core.closed) else {
                return;
            };
            let meta = st.metas.get(id);
            if meta
                .and_then(|m| m.excursion.as_ref())
                .is_some_and(|e| e.closed_at == closed_at.0)
                || (!retry && meta.is_some_and(|m| m.excursion_missing))
            {
                return;
            }
            let spec = spec_of(&st, &core.instrument);
            (core.clone(), f(spec.multiplier), closed_at)
        };
        let (core, mult, closed_at) = target;
        let minute = 60 * 1_000_000_000;
        let from = Timestamp(core.opened_at.0 - core.opened_at.0.rem_euclid(minute));
        let bars = market.bars(&core.instrument, from, closed_at).await;
        let mut st = self.state.write();
        let meta = st.metas.entry(id.to_owned()).or_default();
        match bars.filter(|b| !b.is_empty()) {
            Some(bars) => {
                let entry = f(core.entry);
                let qty = f(core.qty);
                let long = core.side == Side::Buy;
                let (mut adverse, mut favourable) = (0.0f64, 0.0f64);
                let (mut mae_price, mut mfe_price) = (entry, entry);
                for (_, high, low) in &bars {
                    let (fav, adv, fav_px, adv_px) = if long {
                        (high - entry, entry - low, *high, *low)
                    } else {
                        (entry - low, high - entry, *low, *high)
                    };
                    if fav > favourable {
                        favourable = fav;
                        mfe_price = fav_px;
                    }
                    if adv > adverse {
                        adverse = adv;
                        mae_price = adv_px;
                    }
                }
                meta.excursion = Some(Excursion {
                    mae: cents(-adverse * mult * qty),
                    mfe: cents(favourable * mult * qty),
                    mae_price,
                    mfe_price,
                    bars: bars.len() as u32,
                    closed_at: closed_at.0,
                });
                meta.excursion_missing = false;
            }
            None => meta.excursion_missing = true,
        }
        let meta = meta.clone();
        st.rows = None;
        drop(st);
        if let Err(e) = self.repo.put_meta(id, &meta) {
            tracing::warn!(trade = %id, error = %e, "journal: the trade's MAE/MFE was not kept");
        }
    }

    pub fn unmeasured(&self, limit: usize) -> Vec<String> {
        let rows = self.trades();
        let st = self.state.read();
        rows.iter()
            .filter(|t| t.status == TradeStatus::Closed && t.mae.is_none())
            .filter(|t| !st.metas.get(&t.id).is_some_and(|m| m.excursion_missing))
            .take(limit)
            .map(|t| t.id.clone())
            .collect()
    }

    pub fn stats(&self, input: &GetStatsInput) -> JournalStats {
        let (rows, idx) = self.filtered(&input.filter.clone().unwrap_or_default());
        let kept: Vec<&JournalTrade> = idx.iter().map(|i| &rows[*i]).collect();
        let st = self.state.read();
        let tz = self.tz();
        let mut out = stats::compute(
            &kept,
            tz,
            &st.settings.sessions,
            st.settings.breakeven_threshold,
            input.compact.unwrap_or(false),
        );
        let accounts: BTreeSet<&str> = kept.iter().map(|t| t.account_id.as_str()).collect();
        out.behaviour.recorded_since = accounts
            .iter()
            .filter_map(|a| st.coverage.get(*a).and_then(|c| c.0))
            .min();
        out
    }

    pub fn compliance(&self, input: &GetComplianceInput) -> ComplianceOutput {
        let (rows, idx) = self.filtered(&input.filter.clone().unwrap_or_default());
        let st = self.state.read();
        let mut out = ComplianceOutput::default();
        let (mut followed, mut checked) = (0u32, 0u32);
        let mut cats: BTreeMap<&str, (u32, u32)> = BTreeMap::new();
        let mut missed: BTreeMap<&str, MissedRule> = BTreeMap::new();
        for t in idx.iter().map(|i| &rows[*i]) {
            if t.status != TradeStatus::Closed {
                continue;
            }
            let Some((setup_id, _, body)) = t
                .setup_id
                .as_ref()
                .and_then(|s| st.setups.iter().find(|(id, _, _)| id == s))
            else {
                continue;
            };
            if body.rules.is_empty() {
                continue;
            }
            out.trades_with_setups += 1;
            let ticks = st.rule_checks.get(&t.id);
            for r in &body.rules {
                let ok = ticks.and_then(|c| c.get(&r.id)).copied().unwrap_or(false);
                let c = cats.entry(r.category.as_str()).or_default();
                c.1 += 1;
                checked += 1;
                if ok {
                    c.0 += 1;
                    followed += 1;
                } else {
                    missed
                        .entry(r.id.as_str())
                        .or_insert_with(|| MissedRule {
                            rule_id: r.id.clone(),
                            rule_name: r.text.clone(),
                            category: r.category.clone(),
                            setup_id: setup_id.clone(),
                            setup_name: body.name.clone(),
                            count: 0,
                        })
                        .count += 1;
                }
            }
        }
        fn share((f, n): (u32, u32)) -> Option<f64> {
            (n > 0).then(|| (f64::from(f) / f64::from(n) * 1e4).round() / 1e4)
        }
        out.overall = share((followed, checked));
        let cat = |k: &str| cats.get(k).copied().and_then(share);
        out.by_category = ComplianceByCategory {
            entry: cat("entry"),
            exit: cat("exit"),
            risk: cat("risk"),
            management: cat("management"),
        };
        let mut missed: Vec<MissedRule> = missed.into_values().collect();
        missed.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.setup_name.cmp(&b.setup_name))
                .then_with(|| a.rule_name.cmp(&b.rule_name))
        });
        missed.truncate(10);
        out.missed = missed;
        out
    }

    pub fn recent_days(&self, input: &RecentDaysInput) -> Result<RecentDaysOutput, ToolError> {
        let limit = input.limit.clamp(1, 100);
        let entries = self.repo.recent_days(limit).map_err(internal)?;
        let rows = self.trades();
        let mut by_day: HashMap<NaiveDate, Vec<&JournalTrade>> = HashMap::new();
        for t in rows.iter() {
            if input
                .accounts
                .as_ref()
                .is_some_and(|a| !a.contains(&t.account_id))
            {
                continue;
            }
            by_day.entry(t.trade_date).or_default().push(t);
        }
        let days = entries
            .into_iter()
            .filter_map(|(d, content)| {
                let date = NaiveDate::from_str(&d).ok()?;
                let v = by_day.get(&date).map(Vec::as_slice).unwrap_or_default();
                let b = bucket(d, day_label(date), v.iter().copied());
                Some(RecentDay {
                    date,
                    content,
                    net_pnl: (b.n > 0).then_some(b.net),
                    trades: v.len() as u32,
                })
            })
            .collect();
        Ok(RecentDaysOutput { days })
    }

    pub fn calendar(&self, input: &GetCalendarInput, today: NaiveDate) -> CalendarOutput {
        let from = input
            .from
            .unwrap_or_else(|| today.with_day(1).unwrap_or(today));
        let to = input.to.unwrap_or_else(|| month_end(from));
        let mut filter = input.filter.clone().unwrap_or_default();
        filter.from = Some(from);
        filter.to = Some(to);
        let (rows, idx) = self.filtered(&filter);
        let mut by_day: BTreeMap<NaiveDate, Vec<&JournalTrade>> = BTreeMap::new();
        for i in &idx {
            by_day
                .entry(rows[*i].trade_date)
                .or_default()
                .push(&rows[*i]);
        }
        let days_with_entry = self.state.read().days.clone();
        let mut dates: BTreeSet<NaiveDate> = by_day.keys().copied().collect();
        dates.extend(days_with_entry.range(from..=to).copied());
        let days = dates
            .iter()
            .map(|d| {
                let v = by_day.get(d).cloned().unwrap_or_default();
                CalendarDay {
                    date: *d,
                    unreviewed: v
                        .iter()
                        .filter(|t| t.status == TradeStatus::Closed && !t.reviewed)
                        .count() as u32,
                    stats: bucket(d.to_string(), day_label(*d), v),
                    journaled: days_with_entry.contains(d),
                }
            })
            .collect();
        let all = self.trades();
        let traded: BTreeSet<NaiveDate> = all
            .iter()
            .filter(|t| t.trade_date <= today)
            .map(|t| t.trade_date)
            .collect();
        let journal_streak = traded
            .iter()
            .rev()
            .take_while(|d| days_with_entry.contains(d))
            .count() as u32;
        CalendarOutput {
            from,
            to,
            days,
            total: bucket("range", "Range", idx.iter().map(|i| &rows[*i])),
            journal_streak,
        }
    }

    pub fn day(&self, date: NaiveDate) -> Result<DayEntry, ToolError> {
        let key = date.to_string();
        let entry = self.repo.day(&key).map_err(internal)?;
        let checks = self.repo.checks(&key).map_err(internal)?;
        let checklist = self
            .repo
            .checklist()
            .map_err(internal)?
            .into_iter()
            .filter(|i| i.active || checks.contains_key(&i.id))
            .map(|i| ChecklistState {
                checked: checks.get(&i.id).copied().unwrap_or(false),
                id: i.id,
                text: i.text,
            })
            .collect();
        let rows = self.trades();
        let mut trades: Vec<JournalTrade> = rows
            .iter()
            .filter(|t| t.trade_date == date)
            .cloned()
            .collect();
        trades.sort_by_key(|t| t.opened_at);
        let mut dates: BTreeSet<NaiveDate> = rows.iter().map(|t| t.trade_date).collect();
        dates.extend(self.state.read().days.iter().copied());
        let prev = dates.range(..date).next_back().copied();
        let next = dates.range(date + Duration::days(1)..).next().copied();
        Ok(DayEntry {
            date,
            stats: bucket(key.clone(), day_label(date), trades.iter()),
            trades,
            content: entry.as_ref().map(|e| e.0.clone()).unwrap_or_default(),
            started_at: entry.as_ref().and_then(|e| e.1),
            updated_at: entry.as_ref().map(|e| e.2),
            checklist,
            attachments: self.repo.attachments("day", &key).map_err(internal)?,
            prev,
            next,
        })
    }

    pub fn catalog(&self) -> Result<JournalCatalog, ToolError> {
        let rows = self.trades();
        let st = self.state.read();
        let mut accounts: BTreeMap<String, JournalAccount> = BTreeMap::new();
        for a in st.accounts.values() {
            accounts.insert(
                a.id.clone(),
                JournalAccount {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    origin: a.origin,
                    platform: a
                        .platform
                        .as_deref()
                        .and_then(|p| serde_json::from_value(serde_json::json!(p)).ok()),
                    trades: 0,
                },
            );
        }
        let mut symbols = BTreeSet::new();
        let mut uses: HashMap<&str, (u32, f64)> = HashMap::new();
        for t in rows.iter() {
            symbols.insert(t.symbol.clone());
            accounts
                .entry(t.account_id.clone())
                .or_insert_with(|| JournalAccount {
                    id: t.account_id.clone(),
                    name: t.account_name.clone(),
                    origin: t.origin,
                    platform: None,
                    trades: 0,
                })
                .trades += 1;
            for g in &t.tags {
                let u = uses.entry(g.id.as_str()).or_default();
                u.0 += 1;
                if t.status == TradeStatus::Closed {
                    u.1 += t.net_pnl;
                }
            }
        }
        let tags = st
            .tags
            .iter()
            .map(|t| Tag {
                id: t.id.clone(),
                name: t.name.clone(),
                color: t.color.clone(),
                group: t.group.clone(),
                uses: uses.get(t.id.as_str()).map_or(0, |u| u.0),
                net: cents(uses.get(t.id.as_str()).map_or(0.0, |u| u.1)),
            })
            .collect();
        let setups = st
            .setups
            .iter()
            .map(|(id, at, body)| {
                let mine: Vec<&JournalTrade> = rows
                    .iter()
                    .filter(|t| t.setup_id.as_deref() == Some(id))
                    .collect();
                let closed = mine
                    .iter()
                    .filter(|t| t.status == TradeStatus::Closed)
                    .count() as u32;
                let adherence = body
                    .rules
                    .iter()
                    .map(|r| RuleAdherence {
                        rule_id: r.id.clone(),
                        followed: mine
                            .iter()
                            .filter(|t| {
                                st.rule_checks
                                    .get(&t.id)
                                    .and_then(|c| c.get(&r.id))
                                    .copied()
                                    .unwrap_or(false)
                            })
                            .count() as u32,
                        trades: closed,
                    })
                    .collect();
                Setup {
                    id: id.clone(),
                    name: body.name.clone(),
                    description: body.description.clone(),
                    color: body.color.clone(),
                    entry_criteria: body.entry_criteria.clone(),
                    exit_rules: body.exit_rules.clone(),
                    rules: body.rules.clone(),
                    active: body.active,
                    study_id: body.study_id.clone(),
                    created_at: *at,
                    stats: bucket(id.clone(), body.name.clone(), mine.iter().copied()),
                    adherence,
                }
            })
            .collect();
        let settings = st.settings.clone();
        let trash = st.trash.len() as u32;
        drop(st);
        let mut accounts: Vec<JournalAccount> = accounts.into_values().collect();
        accounts.sort_by(|a, b| b.trades.cmp(&a.trades).then(a.name.cmp(&b.name)));
        Ok(JournalCatalog {
            accounts,
            symbols: symbols.into_iter().collect(),
            tags,
            setups,
            filters: self.repo.filters().map_err(internal)?,
            checklist: self.repo.checklist().map_err(internal)?,
            settings,
            imports: self.repo.imports().map_err(internal)?,
            platforms: [
                Platform::Rithmic,
                Platform::Tradovate,
                Platform::Projectx,
                Platform::Topstepx,
                Platform::Ninjatrader,
                Platform::Apex,
            ]
            .iter()
            .map(|p| PlatformInfo {
                id: *p,
                name: p.name().into(),
                hint: p.export_hint().into(),
            })
            .collect(),
            trades: rows.len() as u32,
            trash,
            activity: coverage_list(&self.state.read()),
            revision: self.revision(),
        })
    }

    pub fn search(&self, input: &SearchInput) -> Result<SearchOutput, ToolError> {
        let q = input.query.trim().to_lowercase();
        if q.chars().count() < 2 {
            return Err(ToolError::invalid_input("search for two letters or more"));
        }
        let limit = input.limit.unwrap_or(20).clamp(1, 100) as usize;
        let mut hits = Vec::new();
        let rows = self.trades();
        {
            let st = self.state.read();
            for t in rows.iter() {
                if let Some(snippet) = st.metas.get(&t.id).and_then(|m| snippet(&m.notes, &q)) {
                    hits.push(SearchHit {
                        kind: "trade".into(),
                        id: t.id.clone(),
                        title: format!(
                            "{} {} · {}",
                            t.symbol,
                            if t.side == Side::Buy { "long" } else { "short" },
                            day_label(t.trade_date)
                        ),
                        snippet,
                        date: t.trade_date,
                    });
                }
            }
        }
        for (d, content) in self.repo.days().map_err(internal)? {
            if let (Some(s), Ok(date)) = (snippet(&content, &q), NaiveDate::from_str(&d)) {
                hits.push(SearchHit {
                    kind: "day".into(),
                    id: d.clone(),
                    title: day_label(date),
                    snippet: s,
                    date,
                });
            }
        }
        hits.sort_by_key(|h| std::cmp::Reverse(h.date));
        hits.truncate(limit);
        Ok(SearchOutput { hits })
    }

    pub fn export(&self, input: &ExportInput) -> ExportOutput {
        let (rows, idx) = self.filtered(&input.filter.clone().unwrap_or_default());
        let st = self.state.read();
        let mut csv = String::from(
            "Account,Symbol,Instrument,Direction,Status,Quantity,Entry Time,Entry Price,Exit Time,Exit Price,Gross P&L,Fees,Net P&L,R Multiple,Minutes Held,Setup,Tags,Rating,Reviewed,Mood,Notes\n",
        );
        let q = |s: &str| {
            if s.contains([',', '"', '\n']) {
                format!("\"{}\"", s.replace('"', "\"\""))
            } else {
                s.to_owned()
            }
        };
        let num = |v: Option<f64>| v.map(|v| v.to_string()).unwrap_or_default();
        for i in &idx {
            let t = &rows[*i];
            let notes = st
                .metas
                .get(&t.id)
                .map(|m| m.notes.clone())
                .unwrap_or_default();
            let line = [
                q(&t.account_name),
                q(&t.symbol),
                q(&t.instrument),
                (if t.side == Side::Buy { "Long" } else { "Short" }).into(),
                (if t.status == TradeStatus::Closed {
                    "Closed"
                } else {
                    "Open"
                })
                .into(),
                t.qty.to_string(),
                t.opened_at.to_rfc3339(),
                t.entry_price.to_string(),
                t.closed_at.map(Timestamp::to_rfc3339).unwrap_or_default(),
                num(t.exit_price),
                t.gross_pnl.to_string(),
                t.fees.to_string(),
                t.net_pnl.to_string(),
                num(t.r_multiple),
                num(t.hold_secs.map(|s| (s as f64 / 60.0 * 10.0).round() / 10.0)),
                q(t.setup_name.as_deref().unwrap_or_default()),
                q(&t.tags
                    .iter()
                    .map(|g| g.name.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")),
                t.rating.map(|r| r.to_string()).unwrap_or_default(),
                (if t.reviewed { "yes" } else { "no" }).into(),
                t.emotion.map(|e| e.word().to_owned()).unwrap_or_default(),
                q(&notes),
            ]
            .join(",");
            csv.push_str(&line);
            csv.push('\n');
        }
        ExportOutput {
            filename: format!(
                "tessera-journal-{}.csv",
                Timestamp::now().to_datetime().format("%Y-%m-%d")
            ),
            csv,
            trades: idx.len() as u32,
        }
    }

    fn edited(&self, ids: Vec<String>) {
        self.state.write().rows = None;
        self.publish("edit", ids);
    }

    fn core_exists(&self, id: &str) -> bool {
        self.state
            .read()
            .cores
            .values()
            .flatten()
            .any(|c| c.id == id)
    }

    pub fn update(&self, input: &UpdateTradeInput) -> Result<JournalTrade, ToolError> {
        if !self.core_exists(&input.id) {
            return Err(ToolError::not_found(format!("no trade {}", input.id)));
        }
        {
            let st = self.state.read();
            if let Some(Some(s)) = &input.setup_id
                && !st.setups.iter().any(|(id, _, _)| id == s)
            {
                return Err(ToolError::invalid_input(format!("no setup {s}")));
            }
            if let Some(tags) = &input.tag_ids
                && let Some(bad) = tags.iter().find(|g| !st.tags.iter().any(|t| &t.id == *g))
            {
                return Err(ToolError::invalid_input(format!("no tag {bad}")));
            }
        }
        if let Some(Some(r)) = input.rating
            && !(1..=5).contains(&r)
        {
            return Err(ToolError::invalid_input("a rating is 1 to 5"));
        }
        let mut st = self.state.write();
        let meta = st.metas.entry(input.id.clone()).or_default();
        if let Some(v) = &input.notes {
            meta.notes = v.clone().unwrap_or_default();
        }
        if let Some(v) = &input.setup_id {
            meta.setup_id = v.clone();
        }
        if let Some(v) = input.rating {
            meta.rating = v;
        }
        if let Some(v) = input.reviewed {
            meta.reviewed = v;
        }
        if let Some(v) = input.emotion {
            meta.emotion = v;
        }
        if let Some(v) = input.exit_reason {
            meta.exit_reason = v;
        }
        if let Some(v) = input.stop_price {
            meta.stop_price = v;
        }
        if let Some(v) = input.target_price {
            meta.target_price = v;
        }
        let meta = meta.clone();
        self.repo.put_meta(&input.id, &meta).map_err(internal)?;
        if let Some(tags) = &input.tag_ids {
            self.repo
                .set_trade_tags(&input.id, tags)
                .map_err(internal)?;
            st.trade_tags.insert(input.id.clone(), tags.clone());
        }
        if let Some(rules) = &input.rules {
            for r in rules {
                self.repo
                    .put_rule_check(&input.id, &r.rule_id, r.checked)
                    .map_err(internal)?;
                st.rule_checks
                    .entry(input.id.clone())
                    .or_default()
                    .insert(r.rule_id.clone(), r.checked);
            }
        }
        drop(st);
        self.edited(vec![input.id.clone()]);
        self.trades()
            .iter()
            .find(|t| t.id == input.id)
            .cloned()
            .ok_or_else(|| ToolError::not_found(format!("no trade {}", input.id)))
    }

    pub fn bulk(&self, input: &BulkUpdateInput) -> Result<Changed, ToolError> {
        let mut changed = 0;
        for id in &input.ids {
            if !self.core_exists(id) {
                continue;
            }
            let mut tags = None;
            if input.add_tags.is_some() || input.remove_tags.is_some() {
                let mut have = self
                    .state
                    .read()
                    .trade_tags
                    .get(id)
                    .cloned()
                    .unwrap_or_default();
                for g in input.add_tags.iter().flatten() {
                    if !have.contains(g) {
                        have.push(g.clone());
                    }
                }
                have.retain(|g| !input.remove_tags.iter().flatten().any(|r| r == g));
                tags = Some(have);
            }
            self.update(&UpdateTradeInput {
                id: id.clone(),
                reviewed: input.reviewed,
                rating: input.rating.map(|r| (r > 0).then_some(r)),
                setup_id: input
                    .setup_id
                    .as_ref()
                    .map(|s| (!s.is_empty()).then(|| s.clone())),
                tag_ids: tags,
                ..UpdateTradeInput::default()
            })?;
            changed += 1;
        }
        Ok(Changed { changed })
    }

    pub fn save_tag(&self, input: &SaveTagInput) -> Result<Tag, ToolError> {
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > 50 {
            return Err(ToolError::invalid_input("a tag name is 1 to 50 characters"));
        }
        let mut st = self.state.write();
        let old = input
            .id
            .as_ref()
            .and_then(|id| st.tags.iter().find(|t| &t.id == id).cloned());
        if input.id.is_some() && old.is_none() {
            return Err(ToolError::not_found("no such tag"));
        }
        let group = input
            .group
            .clone()
            .or_else(|| old.as_ref().map(|o| o.group.clone()))
            .unwrap_or_default();
        if st.tags.iter().any(|t| {
            t.name.eq_ignore_ascii_case(name)
                && t.group.eq_ignore_ascii_case(&group)
                && Some(&t.id) != input.id.as_ref()
        }) {
            return Err(ToolError::conflict(format!("a tag {name} exists")));
        }
        let row = TagRow {
            id: input.id.clone().unwrap_or_else(|| unique("tag-")),
            name: name.into(),
            group: group.trim().into(),
            color: input
                .color
                .clone()
                .or_else(|| old.map(|o| o.color))
                .unwrap_or_else(|| TAG_COLORS[st.tags.len() % TAG_COLORS.len()].into()),
        };
        self.repo.put_tag(&row).map_err(internal)?;
        st.tags.retain(|t| t.id != row.id);
        st.tags.push(row.clone());
        st.tags
            .sort_by(|a, b| a.group.cmp(&b.group).then(a.name.cmp(&b.name)));
        drop(st);
        self.edited(Vec::new());
        Ok(Tag {
            id: row.id,
            name: row.name,
            color: row.color,
            group: row.group,
            uses: 0,
            net: 0.0,
        })
    }

    pub fn delete_tag(&self, id: &str) -> Result<Changed, ToolError> {
        let n = self.repo.delete_tag(id).map_err(internal)?;
        if n == 0 {
            return Err(ToolError::not_found(format!("no tag {id}")));
        }
        let mut st = self.state.write();
        st.tags.retain(|t| t.id != id);
        let mut changed = 0;
        for v in st.trade_tags.values_mut() {
            let before = v.len();
            v.retain(|g| g != id);
            changed += u32::from(v.len() != before);
        }
        drop(st);
        self.edited(Vec::new());
        Ok(Changed { changed })
    }

    pub fn save_setup(&self, input: &SaveSetupInput) -> Result<Setup, ToolError> {
        let mut st = self.state.write();
        let (id, mut body) = match &input.id {
            Some(id) => match st.setups.iter().find(|(s, _, _)| s == id) {
                Some((_, _, b)) => (id.clone(), b.clone()),
                None => return Err(ToolError::not_found(format!("no setup {id}"))),
            },
            None => (unique("setup-"), SetupBody::default()),
        };
        if let Some(v) = &input.name {
            body.name = v.trim().into();
        }
        if body.name.is_empty() {
            return Err(ToolError::invalid_input("a setup needs a name"));
        }
        if let Some(v) = &input.description {
            body.description = v.clone();
        }
        if let Some(v) = &input.color {
            body.color = v.clone();
        } else if input.id.is_none() {
            body.color = TAG_COLORS[st.setups.len() % TAG_COLORS.len()].into();
        }
        if let Some(v) = &input.entry_criteria {
            body.entry_criteria = v.clone();
        }
        if let Some(v) = &input.exit_rules {
            body.exit_rules = v.clone();
        }
        if let Some(v) = input.active {
            body.active = v;
        }
        if let Some(v) = &input.study_id {
            body.study_id = v.clone();
        }
        if let Some(rules) = &input.rules {
            body.rules = rules
                .iter()
                .filter(|r| !r.text.trim().is_empty())
                .map(|r| SetupRule {
                    id: r.id.clone().unwrap_or_else(|| unique("rule-")),
                    text: r.text.trim().into(),
                    category: match r.category.as_deref() {
                        Some(c @ ("entry" | "exit" | "risk" | "management")) => c.into(),
                        _ => "entry".into(),
                    },
                })
                .collect();
        }
        self.repo.put_setup(&id, &body).map_err(internal)?;
        let at = match st.setups.iter_mut().find(|(s, _, _)| *s == id) {
            Some(s) => {
                s.2 = body.clone();
                s.1
            }
            None => {
                let now = Timestamp::now();
                st.setups.push((id.clone(), now, body.clone()));
                now
            }
        };
        drop(st);
        self.edited(Vec::new());
        let stats = bucket(
            id.clone(),
            body.name.clone(),
            self.trades()
                .iter()
                .filter(|t| t.setup_id.as_deref() == Some(&id)),
        );
        Ok(Setup {
            id,
            name: body.name,
            description: body.description,
            color: body.color,
            entry_criteria: body.entry_criteria,
            exit_rules: body.exit_rules,
            rules: body.rules,
            active: body.active,
            study_id: body.study_id,
            created_at: at,
            stats,
            adherence: Vec::new(),
        })
    }

    pub fn delete_setup(&self, id: &str) -> Result<Changed, ToolError> {
        if self.repo.delete_setup(id).map_err(internal)? == 0 {
            return Err(ToolError::not_found(format!("no setup {id}")));
        }
        let mut st = self.state.write();
        st.setups.retain(|(s, _, _)| s != id);
        let mut touched = Vec::new();
        for (tid, m) in st.metas.iter_mut() {
            if m.setup_id.as_deref() == Some(id) {
                m.setup_id = None;
                touched.push((tid.clone(), m.clone()));
            }
        }
        drop(st);
        for (tid, m) in &touched {
            self.repo.put_meta(tid, m).map_err(internal)?;
        }
        self.edited(Vec::new());
        Ok(Changed {
            changed: touched.len() as u32,
        })
    }

    pub fn save_day(&self, input: &SaveDayInput) -> Result<DayEntry, ToolError> {
        let key = input.date.to_string();
        let old = self.repo.day(&key).map_err(internal)?;
        if input.content.is_some() || input.start == Some(true) || old.is_none() {
            let content = input
                .content
                .clone()
                .or_else(|| old.as_ref().map(|o| o.0.clone()))
                .unwrap_or_default();
            let started = (input.start == Some(true)).then(Timestamp::now);
            self.repo
                .put_day(&key, &content, started)
                .map_err(internal)?;
            let mut st = self.state.write();
            let has = !content.trim().is_empty()
                || started.is_some()
                || old.as_ref().is_some_and(|o| o.1.is_some());
            if has {
                st.days.insert(input.date);
            } else {
                st.days.remove(&input.date);
            }
        }
        for c in input.checks.iter().flatten() {
            self.repo
                .put_check(&key, &c.rule_id, c.checked)
                .map_err(internal)?;
        }
        self.publish("edit", Vec::new());
        self.day(input.date)
    }

    pub fn save_checklist(&self, input: &SaveChecklistInput) -> Result<ChecklistOutput, ToolError> {
        let items: Vec<ChecklistItem> = input
            .items
            .iter()
            .filter(|i| !i.text.trim().is_empty())
            .map(|i| ChecklistItem {
                id: i.id.clone().unwrap_or_else(|| unique("check-")),
                text: i.text.trim().into(),
                active: i.active.unwrap_or(true),
            })
            .collect();
        self.repo.put_checklist(&items).map_err(internal)?;
        self.publish("edit", Vec::new());
        Ok(ChecklistOutput { items })
    }

    pub fn save_filter(&self, input: &SaveFilterInput) -> Result<SavedFilter, ToolError> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(ToolError::invalid_input("a filter needs a name"));
        }
        let id = input.id.clone().unwrap_or_else(|| unique("filter-"));
        let is_default = match input.is_default {
            Some(v) => v,
            None => self
                .repo
                .filters()
                .map_err(internal)?
                .iter()
                .any(|f| f.id == id && f.is_default),
        };
        let f = SavedFilter {
            id,
            name: name.into(),
            filter: input.filter.clone(),
            is_default,
        };
        self.repo.put_filter(&f).map_err(internal)?;
        self.publish("edit", Vec::new());
        Ok(f)
    }

    pub fn delete_filter(&self, id: &str) -> Result<Changed, ToolError> {
        let n = self.repo.delete_filter(id).map_err(internal)?;
        self.publish("edit", Vec::new());
        Ok(Changed { changed: n as u32 })
    }

    pub fn set_settings(&self, input: &SetSettingsInput) -> Result<JournalSettings, ToolError> {
        let mut s = self.state.read().settings.clone();
        if let Some(v) = input.breakeven_threshold {
            if !(0.0..=1_000_000.0).contains(&v) {
                return Err(ToolError::invalid_input("the breakeven band is 0 or more"));
            }
            s.breakeven_threshold = v;
        }
        if let Some(sessions) = &input.sessions {
            for x in sessions {
                let ok = |v: &str| {
                    v.split_once(':').is_some_and(|(h, m)| {
                        h.parse::<u32>().is_ok_and(|h| h < 24)
                            && m.parse::<u32>().is_ok_and(|m| m < 60)
                    })
                };
                if x.name.trim().is_empty() || !ok(&x.start) || !ok(&x.end) {
                    return Err(ToolError::invalid_input(
                        "a session has a name and HH:MM start and end",
                    ));
                }
                if Tz::from_str(&x.timezone).is_err() {
                    return Err(ToolError::invalid_input(format!(
                        "session {}: {} is not an IANA time zone (Europe/London, America/New_York, Asia/Tokyo)",
                        x.name, x.timezone
                    )));
                }
            }
            s.sessions = sessions.clone();
        }
        self.repo.put_settings(&s).map_err(internal)?;
        let mut st = self.state.write();
        st.settings = s.clone();
        let keys: Vec<_> = st.cores.keys().cloned().collect();
        for k in keys {
            rebuild(&mut st, &k);
        }
        drop(st);
        self.edited(Vec::new());
        Ok(s)
    }

    fn import_account(
        &self,
        want: Option<&ImportAccount>,
        platform: Platform,
    ) -> Result<(String, Option<AccountRow>), ToolError> {
        let st = self.state.read();
        if let Some(id) = want.and_then(|a| a.id.as_ref()) {
            return match st.accounts.get(id) {
                Some(a) if a.origin != FillOrigin::Broker => Ok((id.clone(), None)),
                Some(_) => Err(ToolError::invalid_input(
                    "a connection's account gets its trades from the connection; import into an account of its own",
                )),
                None => Err(ToolError::not_found(format!("no account {id}"))),
            };
        }
        let name = want
            .and_then(|a| a.name.clone())
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("{} import", platform.name()));
        let id = format!("import-{}", short_hash(&name.to_lowercase()));
        if st.accounts.contains_key(&id) {
            return Ok((id, None));
        }
        Ok((
            id.clone(),
            Some(AccountRow {
                id,
                name,
                origin: FillOrigin::Import,
                platform: Some(platform.id().into()),
            }),
        ))
    }

    pub fn import(&self, input: &ImportInput, commit: bool) -> Result<ImportResult, ToolError> {
        let tz = match &input.timezone {
            Some(z) => Tz::from_str(z)
                .map_err(|_| ToolError::invalid_input(format!("unknown time zone {z}")))?,
            None => self.tz(),
        };
        let (platform, parsed) = import::parse(&input.csv, input.platform, tz)
            .map_err(|e| ToolError::invalid_input(e.to_string()))?;
        let (account_id, new_account) = self.import_account(input.account.as_ref(), platform)?;
        let source = format!("csv:{}", platform.id());
        let mut seen: HashMap<String, u32> = HashMap::new();
        let news: Vec<NewFill> = parsed
            .fills
            .iter()
            .map(|r| {
                let content = r.external_id.clone().unwrap_or_else(|| {
                    format!(
                        "{}|{:?}|{}|{}|{}",
                        r.raw_symbol, r.side, r.qty, r.price, r.ts.0
                    )
                });
                let n = seen.entry(content.clone()).or_default();
                *n += 1;
                let id = format!(
                    "imp-{}",
                    &sha256_hex(
                        format!("{account_id}|{}|{content}|{}", platform.id(), *n).as_bytes()
                    )[..24]
                );
                raw_to_fill(r, id, &account_id, &source)
            })
            .collect();
        let known = self.known_fills();
        let fresh: Vec<NewFill> = news
            .iter()
            .filter(|f| !known.contains(f.fill.id.as_str()))
            .cloned()
            .collect();
        let duplicates = (news.len() - fresh.len()) as u32;
        let info = ImportInfo {
            id: unique("imp-"),
            platform,
            format: parsed.format.clone(),
            filename: input.filename.clone(),
            account_id: account_id.clone(),
            created_at: Timestamp::now(),
            fills: 0,
            duplicates,
        };
        let import_id = info.id.clone();
        let from = FillSource::Import(Box::new(info));
        let numbered: Vec<JournalFill> = fresh
            .iter()
            .cloned()
            .zip(0..)
            .map(|(f, seq)| f.kept(seq, &from))
            .collect();
        let mut by_key: BTreeMap<String, Vec<&JournalFill>> = BTreeMap::new();
        for f in &numbered {
            by_key
                .entry(f.fill.instrument.to_string())
                .or_default()
                .push(f);
        }
        let mut preview = Vec::new();
        let mut unknown = BTreeSet::new();
        let mut trades = 0u32;
        for (inst, mut fs) in by_key {
            fs.sort_by(|a, b| a.fill.ts.cmp(&b.fill.ts).then(a.seq.cmp(&b.seq)));
            let id =
                InstrumentId::new(&inst).unwrap_or_else(|_| InstrumentId::from_parts("X", None));
            let sym = inst.split('.').next().unwrap_or_default();
            let root = ContractName::parse(sym, 2026).map_or_else(|| sym.to_owned(), |c| c.root);
            let (spec, known_spec) = self
                .state
                .read()
                .specs
                .get(&inst)
                .cloned()
                .map_or_else(|| fallback_spec(&id, &root), |s| (s, true));
            if !known_spec {
                unknown.insert(root.clone());
            }
            let owned: Vec<JournalFill> = fs.into_iter().cloned().collect();
            for c in build(&owned, &spec, &self.state.read().settings) {
                trades += 1;
                if preview.len() < 50 {
                    preview.push(PreviewTrade {
                        symbol: display_symbol(&c.instrument, Some(&spec)),
                        instrument: c.instrument.to_string(),
                        side: c.side,
                        qty: f(c.qty),
                        entry_price: f(c.entry),
                        exit_price: c.exit.map(f),
                        opened_at: c.opened_at,
                        closed_at: c.closed_at,
                        net_pnl: cents(f(c.gross - c.fees)),
                        reported_pnl: c.reported.map(|r| cents(f(r))),
                        price_decimals: spec.price_decimals,
                    });
                }
            }
        }
        preview.sort_by_key(|p| p.opened_at);
        let mut warnings = parsed.warnings.clone();
        if !unknown.is_empty() {
            warnings.push(format!(
                "{} {} no known point value: P&L is counted at $1 a point.",
                unknown.iter().cloned().collect::<Vec<_>>().join(", "),
                if unknown.len() == 1 { "has" } else { "have" }
            ));
        }
        let mut result = ImportResult {
            platform,
            format: parsed.format.clone(),
            rows: parsed.rows as u32,
            fills: news.len() as u32,
            new_fills: fresh.len() as u32,
            duplicates,
            trades,
            skipped: parsed.skipped as u32,
            errors: parsed.errors.clone(),
            warnings,
            preview,
            import_id: None,
            account_id: Some(account_id.clone()),
            unknown_symbols: unknown.into_iter().collect(),
        };
        if !commit {
            return Ok(result);
        }
        if fresh.is_empty() {
            return Ok(result);
        }
        if let Some(a) = &new_account {
            self.repo.put_account(a).map_err(internal)?;
            self.state.write().accounts.insert(a.id.clone(), a.clone());
        }
        for f in &fresh {
            let inst = f.fill.instrument.to_string();
            if !self.state.read().specs.contains_key(&inst) {
                let sym = inst.split('.').next().unwrap_or_default();
                let root =
                    ContractName::parse(sym, 2026).map_or_else(|| sym.to_owned(), |c| c.root);
                let spec = fallback_spec(&f.fill.instrument, &root).0;
                self.repo.put_instrument(&spec).map_err(internal)?;
                self.state.write().specs.insert(inst, spec);
            }
        }
        self.add_fills(fresh, from)?;
        result.import_id = Some(import_id);
        Ok(result)
    }

    pub fn delete_import(&self, id: &str) -> Result<Changed, ToolError> {
        let n = self.repo.delete_import(id).map_err(internal)?;
        let mut st = self.state.write();
        let mut keys = Vec::new();
        for (k, v) in st.fills.iter_mut() {
            let before = v.len();
            v.retain(|f| f.import_id.as_deref() != Some(id));
            if v.len() != before {
                keys.push(k.clone());
            }
        }
        for k in &keys {
            rebuild(&mut st, k);
        }
        for (_, v) in st.trash.values_mut() {
            v.retain(|f| f.import_id.as_deref() != Some(id));
        }
        st.trash.retain(|_, (_, v)| !v.is_empty());
        drop(st);
        self.publish("import", Vec::new());
        Ok(Changed { changed: n as u32 })
    }

    pub async fn log_trade(&self, input: &LogTradeInput) -> Result<JournalTrade, ToolError> {
        let entry_t = Timestamp::parse(&input.entry_time)
            .map_err(|_| ToolError::invalid_input("the entry time is not a time"))?;
        let exit_t = match &input.exit_time {
            Some(t) => Some(
                Timestamp::parse(t)
                    .map_err(|_| ToolError::invalid_input("the exit time is not a time"))?,
            ),
            None => None,
        };
        if input.qty <= 0.0 || input.entry_price <= 0.0 {
            return Err(ToolError::invalid_input(
                "quantity and price must be positive",
            ));
        }
        if input.exit_price.is_some() != exit_t.is_some() {
            return Err(ToolError::invalid_input(
                "an exit needs both its price and its time",
            ));
        }
        if let Some(x) = exit_t
            && x < entry_t
        {
            return Err(ToolError::invalid_input("the exit is before the entry"));
        }
        let year = entry_t.to_datetime().year();
        let contract = ContractName::parse(&input.symbol, year)
            .ok_or_else(|| ToolError::invalid_input(format!("cannot read {:?}", input.symbol)))?;
        let mut instrument = contract.instrument();
        if let Some(m) = &self.market
            && let Some(spec) = m.spec(&instrument).await
        {
            instrument = spec.instrument;
        }
        self.ensure_spec(&instrument).await;
        let account_id = {
            let st = self.state.read();
            match st.accounts.get(&input.account) {
                Some(a) => a.id.clone(),
                None => st
                    .accounts
                    .values()
                    .find(|a| a.name.eq_ignore_ascii_case(input.account.trim()))
                    .map(|a| a.id.clone())
                    .unwrap_or_default(),
            }
        };
        let account_id = if account_id.is_empty() {
            let name = input.account.trim();
            if name.is_empty() {
                return Err(ToolError::invalid_input("name the account"));
            }
            let row = AccountRow {
                id: format!("manual-{}", short_hash(&name.to_lowercase())),
                name: name.into(),
                origin: FillOrigin::Manual,
                platform: None,
            };
            self.repo.put_account(&row).map_err(internal)?;
            self.state
                .write()
                .accounts
                .insert(row.id.clone(), row.clone());
            row.id
        } else {
            account_id
        };
        let dec = |v: f64| Decimal::from_f64_retain(v).map(|d| d.round_dp(8).normalize());
        let qty = dec(input.qty).ok_or_else(|| ToolError::invalid_input("bad quantity"))?;
        let mk = |side: Side, price: f64, ts: Timestamp, fee: f64| -> Option<NewFill> {
            Some(NewFill {
                fill: Fill {
                    id: FillId::new(unique("man-")),
                    broker_fill_id: None,
                    order_id: None,
                    account_id: AccountId::new(&account_id),
                    instrument: instrument.clone(),
                    side,
                    qty: Qty(qty),
                    price: Price(dec(price)?),
                    ts,
                    fee: Money::usd(dec(fee)?),
                    realized_pnl: None,
                    source: "manual".into(),
                },
                role: None,
                stop: input.stop_price.and_then(dec).map(Price),
                target: input.target_price.and_then(dec).map(Price),
                reported_pnl: None,
            })
        };
        let opposite = if input.side == Side::Buy {
            Side::Sell
        } else {
            Side::Buy
        };
        let mut fills = vec![
            mk(input.side, input.entry_price, entry_t, 0.0)
                .ok_or_else(|| ToolError::invalid_input("bad entry price"))?,
        ];
        if let (Some(px), Some(t)) = (input.exit_price, exit_t) {
            fills.push(
                mk(opposite, px, t, input.fees.unwrap_or(0.0))
                    .ok_or_else(|| ToolError::invalid_input("bad exit price"))?,
            );
        }
        let first = fills[0].fill.id.to_string();
        self.add_fills(fills, FillSource::Manual)?;
        let id = self
            .state
            .read()
            .cores
            .values()
            .flatten()
            .find(|c| c.fill_ids.iter().any(|f| f.as_str() == first))
            .map(|c| c.id.clone())
            .unwrap_or_else(|| trade_id(&account_id, instrument.as_str(), &first));
        if input.setup_id.is_some() || input.notes.is_some() {
            self.update(&UpdateTradeInput {
                id: id.clone(),
                setup_id: input.setup_id.clone().map(Some),
                notes: input.notes.clone().map(Some),
                ..UpdateTradeInput::default()
            })?;
        }
        self.trades()
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| {
                ToolError::conflict(
                    "the trade joined another one open on that account and contract",
                )
            })
    }

    fn trash_trade(&self, st: &mut State, id: &str, at: Timestamp) -> Result<(), ToolError> {
        let Some((key, core)) = st.cores.iter().find_map(|(k, v)| {
            v.iter()
                .find(|c| c.id == id)
                .map(|c| (k.clone(), c.clone()))
        }) else {
            return Err(ToolError::not_found(format!("no trade {id}")));
        };
        if core.origin == FillOrigin::Broker {
            return Err(ToolError::invalid_input(
                "this trade is the connection's own record of its fills and cannot be deleted",
            ));
        }
        let ids: BTreeSet<String> = core.fill_ids.iter().map(|f| f.to_string()).collect();
        let list: Vec<String> = ids.iter().cloned().collect();
        self.repo.trash_fills(&list, id, at).map_err(internal)?;
        let mut moved = Vec::new();
        if let Some(v) = st.fills.get_mut(&key) {
            let (out, keep): (Vec<_>, Vec<_>) = std::mem::take(v)
                .into_iter()
                .partition(|f| ids.contains(f.fill.id.as_str()));
            *v = keep;
            moved = out;
        }
        let e = st.trash.entry(id.to_owned()).or_insert((at, Vec::new()));
        e.0 = at;
        e.1.extend(moved);
        rebuild(st, &key);
        Ok(())
    }

    pub fn delete_trade(&self, id: &str) -> Result<Changed, ToolError> {
        let mut st = self.state.write();
        self.trash_trade(&mut st, id, Timestamp::now())?;
        drop(st);
        self.publish("trash", vec![id.into()]);
        Ok(Changed { changed: 1 })
    }

    pub fn bulk_delete(&self, input: &BulkDeleteInput) -> Result<BulkDeleteOutput, ToolError> {
        let at = Timestamp::now();
        let mut out = BulkDeleteOutput::default();
        let mut ids = Vec::new();
        let mut st = self.state.write();
        for id in &input.ids {
            let origin = st
                .cores
                .values()
                .flatten()
                .find(|c| &c.id == id)
                .map(|c| c.origin);
            match origin {
                None => {}
                Some(FillOrigin::Broker) => out.skipped += 1,
                Some(_) => {
                    self.trash_trade(&mut st, id, at)?;
                    ids.push(id.clone());
                    out.changed += 1;
                }
            }
        }
        drop(st);
        if !ids.is_empty() {
            self.publish("trash", ids);
        }
        Ok(out)
    }

    pub fn list_trash(&self) -> TrashOutput {
        let st = self.state.read();
        let mut trades: Vec<TrashedTrade> = st
            .trash
            .iter()
            .filter_map(|(id, (at, fills))| {
                let mut fills = fills.clone();
                fills.sort_by(|a, b| {
                    a.fill
                        .ts
                        .cmp(&b.fill.ts)
                        .then(a.seq.cmp(&b.seq))
                        .then_with(|| a.fill.id.as_str().cmp(b.fill.id.as_str()))
                });
                let spec = spec_of(&st, &fills.first()?.fill.instrument);
                let cores = build(&fills, &spec, &st.settings);
                let core = cores
                    .iter()
                    .find(|c| &c.id == id)
                    .or_else(|| cores.first())?;
                let mut trade = derive(core, &st);
                trade.id.clone_from(id);
                Some(TrashedTrade {
                    trade,
                    trashed_at: *at,
                })
            })
            .collect();
        trades.sort_by(|a, b| {
            b.trashed_at
                .cmp(&a.trashed_at)
                .then_with(|| b.trade.opened_at.cmp(&a.trade.opened_at))
        });
        TrashOutput { trades }
    }

    pub fn restore_trade(&self, id: &str) -> Result<Changed, ToolError> {
        let Some((_, fills)) = self.state.write().trash.remove(id) else {
            return Err(ToolError::not_found(format!("no trade {id} in the Trash")));
        };
        if let Err(e) = self.repo.restore_fills(id) {
            self.state
                .write()
                .trash
                .insert(id.to_owned(), (Timestamp::now(), fills));
            return Err(internal(e));
        }
        self.absorb(fills);
        self.publish("trash", vec![id.into()]);
        Ok(Changed { changed: 1 })
    }

    pub fn purge_trash(&self, input: &PurgeTrashInput) -> Result<Changed, ToolError> {
        let mut st = self.state.write();
        let ids: Vec<String> = match &input.ids {
            Some(ids) => ids
                .iter()
                .filter(|i| st.trash.contains_key(*i))
                .cloned()
                .collect(),
            None => st.trash.keys().cloned().collect(),
        };
        if ids.is_empty() {
            return Ok(Changed { changed: 0 });
        }
        self.repo.purge_trades(&ids).map_err(internal)?;
        for id in &ids {
            st.trash.remove(id);
            st.metas.remove(id);
            st.trade_tags.remove(id);
            st.rule_checks.remove(id);
            st.attachments.remove(id);
        }
        drop(st);
        self.publish("trash", Vec::new());
        Ok(Changed {
            changed: ids.len() as u32,
        })
    }

    pub fn save_drawings(&self, input: &SaveTradeDrawingsInput) -> Result<Changed, ToolError> {
        if !self.core_exists(&input.trade_id) {
            return Err(ToolError::not_found(format!("no trade {}", input.trade_id)));
        }
        let size = serde_json::to_string(&input.drawings)
            .map_err(internal)?
            .len();
        if size > 1024 * 1024 {
            return Err(ToolError::invalid_input(
                "a trade's drawings are 1 MB at most",
            ));
        }
        self.repo
            .put_drawings(&input.trade_id, &input.drawings)
            .map_err(internal)?;
        self.publish("drawings", vec![input.trade_id.clone()]);
        Ok(Changed { changed: 1 })
    }

    pub fn add_attachment(&self, input: &AddAttachmentInput) -> Result<AttachmentInfo, ToolError> {
        let blobs = self
            .blobs
            .as_ref()
            .ok_or_else(|| ToolError::unavailable("files need a data directory"))?;
        let mt = input.media_type.to_ascii_lowercase();
        if !(mt.starts_with("image/") || mt == "application/pdf") {
            return Err(ToolError::invalid_input("images and PDFs only"));
        }
        let bytes = crate::b64::decode(&input.data_base64)
            .ok_or_else(|| ToolError::invalid_input("the data is not base64"))?;
        if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 {
            return Err(ToolError::invalid_input("a file is 10 MB at most"));
        }
        let (kind, owner) = match (&input.trade_id, &input.date) {
            (Some(t), None) => {
                if !self.core_exists(t) {
                    return Err(ToolError::not_found(format!("no trade {t}")));
                }
                ("trade", t.clone())
            }
            (None, Some(d)) => {
                let d = NaiveDate::from_str(d)
                    .map_err(|_| ToolError::invalid_input("the date is YYYY-MM-DD"))?;
                ("day", d.to_string())
            }
            _ => return Err(ToolError::invalid_input("give a trade or a date")),
        };
        let blob = blobs.put(&bytes, &mt, Some("journal")).map_err(internal)?;
        let info = AttachmentInfo {
            id: unique("file-"),
            filename: input.filename.chars().take(200).collect(),
            media_type: mt,
            size: bytes.len() as u64,
            caption: input.caption.clone(),
            created_at: Timestamp::now(),
        };
        self.repo
            .put_attachment(kind, &owner, &blob.sha256, &info)
            .map_err(internal)?;
        if kind == "trade" {
            *self
                .state
                .write()
                .attachments
                .entry(owner.clone())
                .or_default() += 1;
        }
        self.edited(if kind == "trade" {
            vec![owner]
        } else {
            Vec::new()
        });
        Ok(info)
    }

    pub fn attachment(&self, id: &str) -> Result<AttachmentData, ToolError> {
        let blobs = self
            .blobs
            .as_ref()
            .ok_or_else(|| ToolError::unavailable("files need a data directory"))?;
        let (info, sha) = self
            .repo
            .attachment(id)
            .map_err(internal)?
            .ok_or_else(|| ToolError::not_found(format!("no file {id}")))?;
        let bytes = blobs.get(&sha).map_err(internal)?;
        Ok(AttachmentData {
            info,
            data_base64: crate::b64::encode(&bytes),
        })
    }

    pub fn delete_attachment(&self, id: &str) -> Result<Changed, ToolError> {
        let owner = self
            .repo
            .attachment(id)
            .map_err(internal)?
            .ok_or_else(|| ToolError::not_found(format!("no file {id}")))?;
        self.repo.delete_attachment(id).map_err(internal)?;
        let counts = self.repo.attachment_counts().map_err(internal)?;
        self.state.write().attachments = counts;
        let _ = owner;
        self.edited(Vec::new());
        Ok(Changed { changed: 1 })
    }
}

const TAG_COLORS: [&str; 8] = [
    "#7f9fbf", "#a597cf", "#9bab78", "#b98f7a", "#6fa8a0", "#c4a46b", "#b07f9a", "#8c96a8",
];

fn month_end(d: NaiveDate) -> NaiveDate {
    let (y, m) = if d.month() == 12 {
        (d.year() + 1, 1)
    } else {
        (d.year(), d.month() + 1)
    };
    NaiveDate::from_ymd_opt(y, m, 1).map_or(d, |n| n - Duration::days(1))
}

fn snippet(text: &str, q: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let at = lower.find(q)?;
    let chars: Vec<char> = text.chars().collect();
    let at_c = lower[..at].chars().count();
    let start = at_c.saturating_sub(60);
    let end = (at_c + q.chars().count() + 80).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    s = s.replace('\n', " ");
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s.push('…');
    }
    Some(s)
}

fn raw_to_fill(r: &RawFill, id: String, account: &str, source: &str) -> NewFill {
    NewFill {
        fill: Fill {
            id: FillId::new(id),
            broker_fill_id: r.external_id.clone(),
            order_id: None,
            account_id: AccountId::new(account),
            instrument: r.contract.instrument(),
            side: r.side,
            qty: Qty(r.qty),
            price: Price(r.price),
            ts: r.ts,
            fee: Money::usd(r.fee.unwrap_or_default()),
            realized_pnl: r.reported_pnl.map(Money::usd),
            source: source.into(),
        },
        role: None,
        stop: None,
        target: None,
        reported_pnl: r.reported_pnl,
    }
}

fn trade_id(account: &str, instrument: &str, first_fill: &str) -> String {
    format!(
        "t{}",
        short_hash(&format!("{account}|{instrument}|{first_fill}"))
    )
}

fn spec_of(st: &State, instrument: &InstrumentId) -> ContractSpec {
    st.specs
        .get(instrument.as_str())
        .cloned()
        .unwrap_or_else(|| {
            let sym = instrument.as_str().split('.').next().unwrap_or_default();
            let root = ContractName::parse(sym, 2026).map_or_else(|| sym.to_owned(), |c| c.root);
            fallback_spec(instrument, &root).0
        })
}

fn build(fills: &[JournalFill], spec: &ContractSpec, _settings: &JournalSettings) -> Vec<Core> {
    let Some(first) = fills.first() else {
        return Vec::new();
    };
    let mut spec = spec.clone();
    spec.instrument = first.fill.instrument.clone();
    let by_id: HashMap<&str, &JournalFill> =
        fills.iter().map(|f| (f.fill.id.as_str(), f)).collect();
    let mut b = TradeBuilder::new();
    let mut out = Vec::new();
    let core_of = |account: &str,
                   instrument: &InstrumentId,
                   side: Side,
                   execs: &[Execution],
                   fill_ids: &[FillId]|
     -> Core {
        let first_fill = fill_ids.first().map(|f| f.to_string()).unwrap_or_default();
        let jf = |id: &FillId| by_id.get(id.as_str()).copied();
        let origin = fill_ids
            .first()
            .and_then(jf)
            .map_or(FillOrigin::Broker, |f| f.origin);
        let source = fill_ids
            .first()
            .and_then(jf)
            .map(|f| f.fill.source.clone())
            .unwrap_or_default();
        let entries: Vec<&JournalFill> = execs
            .iter()
            .filter(|e| matches!(e.kind, ExecutionKind::Entry | ExecutionKind::ScaleIn))
            .filter_map(|e| jf(&e.fill_id))
            .collect();
        let exits: Vec<&JournalFill> = execs
            .iter()
            .filter(|e| matches!(e.kind, ExecutionKind::Exit | ExecutionKind::ScaleOut))
            .filter_map(|e| jf(&e.fill_id))
            .collect();
        let reported = (!exits.is_empty() && exits.iter().all(|f| f.reported_pnl.is_some()))
            .then(|| exits.iter().filter_map(|f| f.reported_pnl).sum());
        Core {
            id: trade_id(account, instrument.as_str(), &first_fill),
            account: account.into(),
            instrument: instrument.clone(),
            side,
            closed: false,
            qty: Decimal::ZERO,
            max_qty: Decimal::ZERO,
            entry: Decimal::ZERO,
            exit: None,
            opened_at: Timestamp(0),
            closed_at: None,
            trade_date: NaiveDate::default(),
            gross: Decimal::ZERO,
            fees: Decimal::ZERO,
            executions: execs.to_vec(),
            fill_ids: fill_ids.to_vec(),
            origin,
            source,
            reported,
            exit_role: execs
                .iter()
                .rev()
                .find(|e| matches!(e.kind, ExecutionKind::Exit | ExecutionKind::ScaleOut))
                .and_then(|e| jf(&e.fill_id))
                .and_then(|f| f.role),
            plan_stop: entries.iter().find_map(|f| f.stop).map(|p| p.0),
            plan_target: entries.iter().find_map(|f| f.target).map(|p| p.0),
        }
    };
    for jf in fills {
        let mut fill = jf.fill.clone();
        fill.fee.currency = spec.currency;
        fill.instrument = spec.instrument.clone();
        match b.apply(&fill, &spec) {
            Ok(trips) => {
                for t in trips {
                    let mut c = core_of(
                        t.account_id.as_str(),
                        &t.instrument,
                        t.side,
                        &t.executions,
                        &t.fills,
                    );
                    c.closed = true;
                    c.qty = t.qty.0;
                    c.max_qty = t.max_qty.0;
                    c.entry = t.entry_avg.0;
                    c.exit = Some(t.exit_avg.0);
                    c.opened_at = t.opened_at;
                    c.closed_at = Some(t.closed_at);
                    c.trade_date = t.trade_date;
                    c.gross = t.gross_pnl.amount;
                    c.fees = t.fees.amount;
                    out.push(c);
                }
            }
            Err(e) => tracing::warn!(error = %e, fill = %jf.fill.id, "journal: fill left out"),
        }
    }
    for o in b.open_trips() {
        let mut c = core_of(
            o.account_id.as_str(),
            &o.instrument,
            o.side,
            &o.executions,
            &o.fills,
        );
        c.qty = o.entered_qty.0;
        c.max_qty = o.max_qty.0;
        c.entry = o.entry_avg.0;
        c.exit = o.exit_avg.map(|p| p.0);
        c.opened_at = o.opened_at;
        c.trade_date = spec.sessions.trade_date(o.opened_at);
        c.gross = o.realized;
        c.fees = o.fees;
        out.push(c);
    }
    out
}

const OPENING: &str = "~open";

fn split_reversals(fills: &mut Vec<JournalFill>) -> Vec<(JournalFill, JournalFill)> {
    let mut held = Decimal::ZERO;
    let mut splits = Vec::new();
    let mut out = Vec::with_capacity(fills.len());
    for jf in std::mem::take(fills) {
        let signed = jf.fill.qty.0.abs() * Decimal::from(jf.fill.side.sign());
        let after = held + signed;
        let reverses = !held.is_zero()
            && !after.is_zero()
            && after.is_sign_negative() != held.is_sign_negative();
        held = after;
        if !reverses {
            out.push(jf);
            continue;
        }
        let total = jf.fill.qty.0.abs();
        let closes = total - after.abs();
        let closing_fee = jf.fill.fee.amount * closes / total;
        let mut closing = jf.clone();
        closing.fill.qty = Qty(closes);
        closing.fill.fee.amount = closing_fee;
        let mut opening = jf;
        opening.fill.id = FillId::new(format!("{}{OPENING}", closing.fill.id));
        opening.fill.qty = Qty(after.abs());
        opening.fill.fee.amount -= closing_fee;
        opening.fill.realized_pnl = None;
        opening.reported_pnl = None;
        out.push(closing.clone());
        out.push(opening.clone());
        splits.push((closing, opening));
    }
    *fills = out;
    splits
}

fn keep_splits(repo: &Repo, splits: Vec<(JournalFill, JournalFill)>) {
    for (closing, opening) in splits {
        if let Err(e) = repo.split_fill(&closing, &opening) {
            tracing::warn!(fill = %closing.fill.id, error = %e, "a reversing fill could not be split");
        }
    }
}

fn rebuild(st: &mut State, key: &(String, String)) {
    let fills = st.fills.get(key).cloned().unwrap_or_default();
    if fills.is_empty() {
        st.cores.remove(key);
        st.fills.remove(key);
    } else {
        let inst = fills[0].fill.instrument.clone();
        let spec = spec_of(st, &inst);
        let cores = build(&fills, &spec, &st.settings);
        st.cores.insert(key.clone(), cores);
    }
    refresh_activity(st, key);
    st.rows = None;
}

fn refresh_activity(st: &mut State, key: &(String, String)) {
    refresh_activity_since(st, key, None);
}

struct OrderSpan<'a> {
    first: Timestamp,
    last: Timestamp,
    open: bool,
    events: Vec<&'a OrderEvent>,
}

fn refresh_activity_since(
    st: &mut State,
    key: &(String, String),
    since: Option<Timestamp>,
) -> Vec<String> {
    let keep = |c: &Core| {
        since.is_some_and(|s| c.closed_at.is_some_and(|t| t.0 + 5 * 1_000_000_000 < s.0))
    };
    let kept: std::collections::HashSet<String> = st
        .cores
        .get(key)
        .into_iter()
        .flatten()
        .filter(|c| keep(c))
        .map(|c| c.id.clone())
        .collect();
    if let Some(old) = st.analysis_keys.remove(key) {
        for id in old.iter().filter(|id| !kept.contains(*id)) {
            st.analyses.remove(id);
        }
        let still: Vec<String> = old.into_iter().filter(|id| kept.contains(id)).collect();
        if !still.is_empty() {
            st.analysis_keys.insert(key.clone(), still);
        }
    }
    let Some(cores) = st.cores.get(key) else {
        return Vec::new();
    };
    let events: &[OrderEvent] = st.events.get(key).map_or(&[], Vec::as_slice);
    let mut spans: BTreeMap<&str, OrderSpan<'_>> = BTreeMap::new();
    for e in events {
        let s = spans.entry(e.order_id.as_str()).or_insert(OrderSpan {
            first: e.ts,
            last: e.ts,
            open: true,
            events: Vec::new(),
        });
        s.last = e.ts;
        s.open = !e.status.is_terminal();
        s.events.push(e);
    }
    let orders: HashMap<&str, (Option<&str>, Option<OrderRole>)> = st
        .fills
        .get(key)
        .into_iter()
        .flatten()
        .map(|jf| {
            (
                jf.fill.id.as_str(),
                (jf.fill.order_id.as_ref().map(|o| o.as_str()), jf.role),
            )
        })
        .collect();
    let spec = match cores.first() {
        Some(c) => spec_of(st, &c.instrument),
        None => return Vec::new(),
    };
    let live_since = st.coverage.get(&key.0).and_then(|c| c.0);
    let horizon = st
        .fills
        .get(key)
        .into_iter()
        .flatten()
        .map(|f| f.fill.ts)
        .chain(events.iter().map(|e| e.ts))
        .max()
        .unwrap_or(Timestamp(0));
    let mut out = Vec::new();
    for c in cores.iter().filter(|c| !keep(c)) {
        let fills: Vec<FillRef> = c
            .executions
            .iter()
            .map(|e| {
                let (order, role) = orders
                    .get(e.fill_id.as_str())
                    .copied()
                    .unwrap_or((None, None));
                FillRef {
                    ts: e.ts,
                    qty: f(e.qty.0),
                    price: f(e.price.0),
                    entry: matches!(e.kind, ExecutionKind::Entry | ExecutionKind::ScaleIn),
                    order_id: order.map(str::to_owned),
                    role,
                }
            })
            .collect();
        let input = TradeInput {
            side: c.side,
            opened_at: c.opened_at,
            end: c.closed_at.unwrap_or(horizon),
            closed: c.closed,
            net: cents(f(c.gross - c.fees)),
            fills: &fills,
            tick: f(spec.tick_size.0),
            mult: f(spec.multiplier),
            live_since,
        };
        let (from, to) = (
            Timestamp(c.opened_at.0 - 1_000_000_000),
            Timestamp(input.end.0 + 5 * 1_000_000_000),
        );
        let mine = spans
            .values()
            .filter(|s| s.first <= to && (s.last >= from || s.open))
            .flat_map(|s| s.events.iter().copied());
        if let Some(a) = activity::analyse(&input, mine) {
            out.push((c.id.clone(), Arc::new(a)));
        }
    }
    let ids: Vec<String> = out.iter().map(|(id, _)| id.clone()).collect();
    st.analysis_keys
        .entry(key.clone())
        .or_default()
        .extend(ids.iter().cloned());
    st.analyses.extend(out);
    ids
}

fn backfill(repo: &Repo, st: &mut State) -> tessera_store::Result<()> {
    let stored = repo.stored_orders()?;
    if stored.is_empty() {
        return Ok(());
    }
    let calls = repo.order_calls(None)?;
    let mut first_fill: HashMap<String, Timestamp> = HashMap::new();
    for jf in st.fills.values().flatten() {
        if let Some(o) = &jf.fill.order_id {
            let t = first_fill.entry(o.to_string()).or_insert(jf.fill.ts);
            *t = (*t).min(jf.fill.ts);
        }
    }
    let known: std::collections::HashSet<String> = st.snapshots.keys().cloned().collect();
    let mut evs = activity::reconstruct(&stored, &calls, &first_fill, &known, |i| {
        st.specs.get(i).map(|s| s.tick_size.to_f64())
    });
    for e in &mut evs {
        e.seq = st.ev_seq;
        st.ev_seq += 1;
    }
    let fresh: Vec<Order> = stored
        .into_iter()
        .filter(|o| !known.contains(o.id.as_str()))
        .collect();
    repo.put_order_events(&evs, &fresh)?;
    let now = Timestamp::now();
    let accounts: BTreeSet<String> = fresh
        .iter()
        .map(|o| o.request.account_id.to_string())
        .collect();
    for a in accounts {
        repo.put_activity_account(&a, None, Some(now))?;
        st.coverage.entry(a).or_default().1 = Some(now);
    }
    for o in fresh {
        st.snapshots.insert(o.id.to_string(), o);
    }
    for e in evs {
        st.events
            .entry((e.account_id.clone(), e.instrument.clone()))
            .or_default()
            .push(e);
    }
    for v in st.events.values_mut() {
        v.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.seq.cmp(&b.seq)));
    }
    Ok(())
}

fn coverage_list(st: &State) -> Vec<ActivityAccount> {
    let mut v: Vec<ActivityAccount> = st
        .coverage
        .iter()
        .map(|(a, (live, back))| ActivityAccount {
            account_id: a.clone(),
            live_since: *live,
            backfilled_at: *back,
        })
        .collect();
    v.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    v
}

fn activity_row(
    e: &OrderEvent,
    trade_id: Option<&str>,
    leg: Option<Leg>,
    actor: activity::Actor,
    side: Side,
    tick: f64,
) -> ActivityRow {
    let (direction, ticks) = match (e.kind, e.from, e.to) {
        (activity::OrderEventKind::StopMoved, Some(a), Some(b)) if (a - b).abs() > 1e-9 => {
            let tighter = if side == Side::Buy { b > a } else { b < a };
            let dir = (leg == Some(Leg::Stop)).then_some(if tighter {
                MoveDirection::Tightened
            } else {
                MoveDirection::Widened
            });
            (
                dir,
                (tick > 0.0).then(|| ((b - a).abs() / tick * 100.0).round() / 100.0),
            )
        }
        (activity::OrderEventKind::LimitMoved, Some(a), Some(b)) => (
            None,
            (tick > 0.0).then(|| ((b - a).abs() / tick * 100.0).round() / 100.0),
        ),
        _ => (None, None),
    };
    ActivityRow {
        event: e.clone(),
        trade_id: trade_id.map(str::to_owned),
        leg,
        actor,
        direction,
        ticks,
    }
}

fn derive(c: &Core, st: &State) -> JournalTrade {
    let spec = spec_of(st, &c.instrument);
    let meta = st.metas.get(&c.id).cloned().unwrap_or_default();
    let mult = f(spec.multiplier);
    let tick = f(spec.tick_size.0);
    let sign = f64::from(c.side.sign() as i32);
    let entry = f(c.entry);
    let exit = c.exit.map(f);
    let qty = f(c.qty);
    let net = cents(f(c.gross - c.fees));
    let be = st.settings.breakeven_threshold;
    let points = if c.closed {
        exit.map(|x| (x - entry) * sign)
    } else {
        None
    };
    let act = st.analyses.get(&c.id).map(|a| &a.summary);
    let first_stop = act.and_then(|a| a.initial_stop);
    let first_target = act.and_then(|a| a.initial_target);
    let (stop, target, plan_from) = match (meta.stop_price, meta.target_price) {
        (None, None) if first_stop.is_some() => (
            first_stop,
            first_target.or(c.plan_target.map(f)),
            Some("activity".to_owned()),
        ),
        (None, None) if c.plan_stop.is_some() || c.plan_target.is_some() => (
            c.plan_stop.map(f),
            c.plan_target.map(f),
            Some("order".to_owned()),
        ),
        (s, t) => (
            s.or(first_stop).or(c.plan_stop.map(f)),
            t.or(first_target).or(c.plan_target.map(f)),
            (s.is_some() || t.is_some()).then(|| "you".to_owned()),
        ),
    };
    let (risk, r_multiple) = match act {
        Some(a) if meta.stop_price.is_none() && first_stop.is_some() => {
            (a.initial_risk, a.r_initial)
        }
        _ => {
            let risk = stop
                .map(|s| (entry - s).abs() * mult * qty)
                .filter(|r| *r > 0.0);
            let r = if c.closed {
                risk.map(|r| (net / r * 100.0).round() / 100.0)
            } else {
                None
            };
            (risk, r)
        }
    };
    let planned_rr = match (stop, target) {
        (Some(s), Some(t)) if (entry - s).abs() > 0.0 => {
            Some(((t - entry).abs() / (entry - s).abs() * 100.0).round() / 100.0)
        }
        _ => None,
    };
    let outcome = if !c.closed {
        Outcome::Open
    } else if net > be {
        Outcome::Win
    } else if net < -be {
        Outcome::Loss
    } else {
        Outcome::Breakeven
    };
    let result = result_of(c, &meta, stop, target, exit, entry, tick);
    let tags: Vec<TagRef> = st
        .trade_tags
        .get(&c.id)
        .into_iter()
        .flatten()
        .filter_map(|g| st.tags.iter().find(|t| &t.id == g))
        .map(|t| TagRef {
            id: t.id.clone(),
            name: t.name.clone(),
            color: t.color.clone(),
            group: t.group.clone(),
        })
        .collect();
    let setup = meta
        .setup_id
        .as_ref()
        .and_then(|s| st.setups.iter().find(|(id, _, _)| id == s));
    let excursion = meta
        .excursion
        .as_ref()
        .filter(|e| c.closed_at.is_some_and(|t| t.0 == e.closed_at));
    JournalTrade {
        id: c.id.clone(),
        account_id: c.account.clone(),
        account_name: st
            .accounts
            .get(&c.account)
            .map_or_else(|| c.account.clone(), |a| a.name.clone()),
        instrument: c.instrument.to_string(),
        symbol: display_symbol(&c.instrument, Some(&spec)),
        side: c.side,
        status: if c.closed {
            TradeStatus::Closed
        } else {
            TradeStatus::Open
        },
        qty,
        max_qty: f(c.max_qty),
        entry_price: entry,
        exit_price: exit,
        opened_at: c.opened_at,
        closed_at: c.closed_at,
        trade_date: c.trade_date,
        hold_secs: c.closed_at.map(|t| (t.0 - c.opened_at.0) / 1_000_000_000),
        gross_pnl: cents(f(c.gross)),
        fees: cents(f(c.fees)),
        net_pnl: net,
        points: points.map(|p| (p * 1e6).round() / 1e6),
        ticks: points
            .filter(|_| tick > 0.0)
            .map(|p| (p / tick * 100.0).round() / 100.0),
        price_decimals: spec.price_decimals,
        outcome,
        result,
        stop_price: stop,
        target_price: target,
        plan_from,
        risk: risk.map(cents),
        r_multiple,
        planned_rr,
        mae: excursion.map(|e| e.mae),
        mfe: excursion.map(|e| e.mfe),
        mae_price: excursion.map(|e| e.mae_price),
        mfe_price: excursion.map(|e| e.mfe_price),
        setup_id: setup.map(|(id, _, _)| id.clone()),
        setup_name: setup.map(|(_, _, b)| b.name.clone()),
        tags,
        rating: meta.rating,
        reviewed: meta.reviewed,
        emotion: meta.emotion,
        exit_reason: meta.exit_reason,
        has_notes: !meta.notes.trim().is_empty(),
        attachments: st.attachments.get(&c.id).copied().unwrap_or(0),
        origin: c.origin,
        source: c.source.clone(),
        reported_pnl: c.reported.map(|r| cents(f(r))),
        executions: c.executions.len() as u32,
        activity: act.cloned(),
    }
}

fn result_of(
    c: &Core,
    meta: &TradeMeta,
    stop: Option<f64>,
    target: Option<f64>,
    exit: Option<f64>,
    entry: f64,
    tick: f64,
) -> TradeResult {
    if !c.closed {
        return TradeResult::Open;
    }
    if let Some(r) = meta.exit_reason {
        return match r {
            ExitReason::Manual | ExitReason::TimeBased => TradeResult::Manual,
            ExitReason::StopLoss => TradeResult::Stop,
            ExitReason::TrailingStop => TradeResult::Trailed,
            ExitReason::TakeProfit => TradeResult::Target,
            ExitReason::Breakeven => TradeResult::Breakeven,
        };
    }
    let long = c.side == Side::Buy;
    let Some(exit) = exit else {
        return TradeResult::Manual;
    };
    match c.exit_role {
        Some(OrderRole::TakeProfit) => return TradeResult::Target,
        Some(OrderRole::StopLoss) => {
            let gain = (exit - entry) * if long { 1.0 } else { -1.0 };
            return if gain.abs() <= tick.max(1e-9) {
                TradeResult::Breakeven
            } else if gain > 0.0 {
                TradeResult::Trailed
            } else {
                TradeResult::Stop
            };
        }
        _ => {}
    }
    if let Some(t) = target
        && ((long && exit >= t) || (!long && exit <= t))
    {
        return TradeResult::Target;
    }
    if let Some(s) = stop
        && ((long && exit <= s) || (!long && exit >= s))
    {
        return TradeResult::Stop;
    }
    TradeResult::Manual
}
