use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use futures::future::join_all;
use parking_lot::{Mutex, RwLock};
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::{Value, json};
use tessera_core::accounts::Environment;
use tessera_core::hash::{hash_json, hash_serializable};
use tessera_core::ids::{AccountId, CallId, DraftId, OrderId};
use tessera_core::instrument::ContractSpec;
use tessera_core::orders::{Bracket, Order, OrderRequest, OrderRole, OrderStatus, OrderType, Side};
use tessera_core::products::{Product, product};
use tessera_core::{InstrumentId, Price, Qty};
use tessera_market::exchange_contract;
use tessera_protocol::tools::{
    RiskTier, ToolCallRecord, ToolCallStatus, ToolErrorCode, ToolErrorInfo,
};
use tessera_tools::{ToolCtx, ToolError, ToolObserver};
use tokio::sync::OwnedMutexGuard;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::book::CopyBook;
use super::io::CopyPreview;
use super::model::{
    COPIED_IN_MICROS, CopyFollower, CopyGroup, CopyNote, CopyOutcome, CopyReport, CopyResult,
    follower_qty, split, why_nothing,
};
use super::sync::SyncBook;
use crate::orders::io::{
    AccountScopeInput, BreakevenStopInput, BreakevenStopOutput, CancelAllInput, CancelAllOutput,
    CancelOrderInput, FlattenOutput, ModifyOrderInput, OrderInput, OrderOutput, ReverseInput,
    ReverseOutput, SubmitOutput,
};
use crate::orders::{OrdersService, order_sentence, position_words};
use crate::paper::engine::{price_label, qty_label};
use crate::{BrokerEvent, OrderChanges};

pub const COPY_TOOL: &str = "orders.copy";

const COPY_WAIT: Duration = Duration::from_secs(15);
pub(super) const ACT_WAIT: Duration = Duration::from_secs(60);
const FILL_WAIT: Duration = Duration::from_secs(10);
const WATCH_FOR: Duration = Duration::from_secs(8 * 3600);
const LINKS_KEPT: usize = 4096;
const PREVIEWS_KEPT: usize = 512;
const LEADER_UNREAD: &str = "the leader's position could not be read; nothing copied";
const SENT_FRESH: Duration = Duration::from_secs(5);

pub fn copies_words(n: usize) -> String {
    if n == 1 {
        "and 1 account by copy".to_owned()
    } else {
        format!("and {n} accounts by copy")
    }
}

struct Linked {
    leader: AccountId,
    before: Decimal,
    copies: Vec<(AccountId, OrderId)>,
}

#[derive(Default)]
struct Links {
    by_leader: HashMap<OrderId, Linked>,
    order: VecDeque<OrderId>,
}

impl Links {
    fn add(&mut self, lead: &Order, before: Decimal, follower: &AccountId, order: &OrderId) {
        if !self.by_leader.contains_key(&lead.id) {
            self.order.push_back(lead.id.clone());
            while self.order.len() > LINKS_KEPT {
                if let Some(old) = self.order.pop_front() {
                    self.by_leader.remove(&old);
                }
            }
        }
        self.by_leader
            .entry(lead.id.clone())
            .or_insert_with(|| Linked {
                leader: lead.request.account_id.clone(),
                before,
                copies: Vec::new(),
            })
            .copies
            .push((follower.clone(), order.clone()));
    }

    fn leader_of(&self, follower: &AccountId, order: &OrderId) -> Option<OrderId> {
        self.by_leader
            .iter()
            .find(|(_, l)| l.copies.iter().any(|(a, o)| a == follower && o == order))
            .map(|(id, _)| id.clone())
    }

    fn of(&self, leader: &OrderId, follower: &AccountId) -> Vec<OrderId> {
        self.by_leader
            .get(leader)
            .map(|l| {
                l.copies
                    .iter()
                    .filter(|(a, _)| a == follower)
                    .map(|(_, o)| o.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn before(&self, leader: &OrderId) -> Option<Decimal> {
        self.by_leader.get(leader).map(|l| l.before)
    }

    fn copies_by(&self, leader: &AccountId, follower: &AccountId) -> Vec<OrderId> {
        self.by_leader
            .values()
            .filter(|l| &l.leader == leader)
            .flat_map(|l| l.copies.iter())
            .filter(|(a, _)| a == follower)
            .map(|(_, o)| o.clone())
            .collect()
    }
}

#[derive(Clone, Debug)]
struct Anchor {
    account: AccountId,
    stop: Option<Decimal>,
    target: Option<Decimal>,
    leader: Option<(OrderId, Option<Price>, Option<Price>)>,
    tick: Option<Decimal>,
    at: Instant,
}

#[derive(Clone, Debug)]
struct FillWatch {
    group_id: String,
    leader: AccountId,
    leader_name: String,
    leader_order: OrderId,
    what: String,
    followers: Vec<(String, OrderId)>,
    spec: Option<ContractSpec>,
    filled_at: Option<Instant>,
    created: Instant,
}

pub(crate) struct CopyState {
    pub(crate) book: CopyBook,
    links: Mutex<Links>,
    anchors: Mutex<HashMap<OrderId, Anchor>>,
    watches: Mutex<Vec<FillWatch>>,
    previewed: Mutex<VecDeque<(String, Vec<AccountId>)>>,
    audit: RwLock<Option<Arc<dyn ToolObserver>>>,
    pub(crate) manage: tokio::sync::Mutex<()>,
    turns: Mutex<HashMap<AccountId, Arc<tokio::sync::Mutex<()>>>>,
    sent: Mutex<VecDeque<(OrderId, Instant)>>,
    pub(crate) sync: SyncBook,
}

impl CopyState {
    pub(crate) fn new(book: CopyBook) -> Self {
        Self {
            book,
            links: Mutex::new(Links::default()),
            anchors: Mutex::new(HashMap::new()),
            watches: Mutex::new(Vec::new()),
            previewed: Mutex::new(VecDeque::new()),
            audit: RwLock::new(None),
            manage: tokio::sync::Mutex::new(()),
            turns: Mutex::new(HashMap::new()),
            sent: Mutex::new(VecDeque::new()),
            sync: SyncBook::default(),
        }
    }
}

pub(super) fn preview_key<T: Serialize>(tool: &str, input: &T) -> String {
    hash_serializable(&(tool, input)).unwrap_or_else(|e| {
        tracing::warn!(tool, error = %e, "copy: a preview could not be keyed");
        String::new()
    })
}

fn strictness(e: Environment) -> u8 {
    match e {
        Environment::Paper => 0,
        Environment::Sim => 1,
        Environment::Eval => 2,
        Environment::Funded => 3,
        Environment::Live => 4,
    }
}

pub(super) fn bare(words: &str, e: &ToolError) -> String {
    let m = e.message.trim();
    m.strip_prefix(words)
        .and_then(|r| r.strip_prefix(": "))
        .unwrap_or(m)
        .to_owned()
}

pub(super) fn outcome_of(e: &ToolError) -> CopyOutcome {
    match e.code {
        ToolErrorCode::Unavailable
        | ToolErrorCode::Timeout
        | ToolErrorCode::OutcomeUnknown
        | ToolErrorCode::Internal => CopyOutcome::Unknown,
        _ => CopyOutcome::Skipped,
    }
}

fn on_tick(p: Decimal, tick: Option<Decimal>) -> Decimal {
    match tick.filter(|t| *t > Decimal::ZERO) {
        Some(t) => (p / t).round() * t,
        None => p,
    }
}

fn shifted(b: &Bracket, from: Price, to: Price, tick: Option<Decimal>) -> Bracket {
    let mv = |p: Option<Price>| p.map(|p| Price(on_tick(p.0 - from.0 + to.0, tick)));
    Bracket {
        stop_loss: mv(b.stop_loss),
        take_profit: mv(b.take_profit),
        ..*b
    }
}

pub(super) fn request_words(r: &OrderRequest, spec: Option<&ContractSpec>) -> String {
    let price = |p: Option<Price>| match (p, spec) {
        (Some(p), Some(s)) => price_label(s, p),
        (Some(p), None) => p.0.normalize().to_string(),
        (None, _) => String::new(),
    };
    let side = match r.side {
        Side::Buy => "Buy",
        Side::Sell => "Sell",
    };
    let what = match r.order_type {
        OrderType::Market => "market".to_owned(),
        OrderType::Limit => format!("limit {}", price(r.limit_price)),
        OrderType::Stop => format!("stop {}", price(r.stop_price)),
        OrderType::StopLimit => format!(
            "stop {} limit {}",
            price(r.stop_price),
            price(r.limit_price)
        ),
    };
    format!(
        "{side} {} {} {what}",
        qty_label(r.qty),
        r.instrument.symbol()
    )
}

pub(super) fn status_tail(o: &Order) -> &'static str {
    match o.status {
        OrderStatus::Filled => " · filled",
        OrderStatus::PartiallyFilled => " · part filled",
        OrderStatus::Rejected => " · rejected",
        OrderStatus::Cancelled => " · cancelled",
        _ => " · working",
    }
}

fn attach<T>(
    r: Result<T, ToolError>,
    report: CopyReport,
    put: impl FnOnce(&mut T, CopyReport),
) -> Result<T, ToolError> {
    match r {
        Ok(mut out) => {
            put(&mut out, report);
            Ok(out)
        }
        Err(mut e) => {
            let mut d = e.details.take().unwrap_or_else(|| json!({}));
            if let (Some(o), Ok(v)) = (d.as_object_mut(), serde_json::to_value(&report)) {
                o.insert("copies".into(), v);
            }
            e.details = Some(d);
            Err(e)
        }
    }
}

pub(super) struct Copying {
    pub(super) result: CopyResult,
    main: Option<OrderId>,
}

impl Copying {
    pub(super) fn new(account: &AccountId, name: String) -> Self {
        Self {
            result: CopyResult {
                account_id: account.clone(),
                account: name,
                outcome: CopyOutcome::Copied,
                text: String::new(),
                orders: Vec::new(),
            },
            main: None,
        }
    }

    pub(super) fn done(mut self, outcome: CopyOutcome, text: impl Into<String>) -> Self {
        self.result.outcome = outcome;
        self.result.text = text.into();
        self
    }
}

struct Lead<'a> {
    input: &'a OrderInput,
    req: &'a OrderRequest,
    before: Decimal,
    order: Option<&'a Order>,
    anchor: Option<Price>,
    flat_first: bool,
    what: Option<String>,
}

pub(super) trait Member: Sync {
    fn account(&self) -> &AccountId;
}

impl Member for CopyFollower {
    fn account(&self) -> &AccountId {
        &self.account_id
    }
}

impl Member for AccountId {
    fn account(&self) -> &AccountId {
        self
    }
}

pub(super) fn flatten_words(o: &FlattenOutput) -> String {
    if o.closing.is_empty() && o.cancelled.is_empty() {
        "flat already".to_owned()
    } else {
        format!(
            "flat · closed {} · cancelled {}",
            o.closing.len(),
            o.cancelled.len()
        )
    }
}

impl OrdersService {
    fn contract_words(&self, account: &AccountId, input: &str) -> String {
        self.instrument_hint(account.as_str(), input).map_or_else(
            || input.trim().to_ascii_uppercase(),
            |i| i.symbol().to_owned(),
        )
    }

    pub fn copy_book(&self) -> &CopyBook {
        &self.copying.book
    }

    pub fn set_copy_audit(&self, observer: Arc<dyn ToolObserver>) {
        *self.copying.audit.write() = Some(observer);
    }

    pub(super) async fn leader_turn(&self, leader: &AccountId) -> OwnedMutexGuard<()> {
        let turn = Arc::clone(self.copying.turns.lock().entry(leader.clone()).or_default());
        turn.lock_owned().await
    }

    async fn turn_if_leading(&self, leader: &AccountId) -> Option<OwnedMutexGuard<()>> {
        match self.copying.book.led_by(leader) {
            Some(_) => Some(self.leader_turn(leader).await),
            None => None,
        }
    }

    pub(super) fn note_sent(&self, order: &OrderId) {
        let mut sent = self.copying.sent.lock();
        while sent
            .front()
            .is_some_and(|(_, at)| at.elapsed() >= SENT_FRESH)
        {
            sent.pop_front();
        }
        sent.push_back((order.clone(), Instant::now()));
    }

    pub(super) fn sent_lately(&self) -> HashSet<OrderId> {
        self.copying
            .sent
            .lock()
            .iter()
            .filter(|(_, at)| at.elapsed() < SENT_FRESH)
            .map(|(o, _)| o.clone())
            .collect()
    }

    pub(super) fn remember_preview(&self, key: String, accounts: Vec<AccountId>) {
        let mut memo = self.copying.previewed.lock();
        memo.push_back((key, accounts));
        while memo.len() > PREVIEWS_KEPT {
            memo.pop_front();
        }
    }

    pub(super) fn previewed_accounts(&self, key: &str) -> Option<Vec<AccountId>> {
        self.copying
            .previewed
            .lock()
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    pub(super) fn copies_of_leader(
        &self,
        leader: &AccountId,
        follower: &AccountId,
    ) -> Vec<OrderId> {
        self.copying.links.lock().copies_by(leader, follower)
    }

    fn copy_scope<T: Serialize>(
        &self,
        ctx: &ToolCtx,
        tool: &str,
        input: &T,
        leader: &AccountId,
    ) -> Option<CopyGroup> {
        let mut group = self.copying.book.led_by(leader)?;
        group.followers = group.copying().cloned().collect();
        if ctx.approved_by.is_some() {
            let named = self.previewed_accounts(&preview_key(tool, input))?;
            group.followers.retain(|f| named.contains(&f.account_id));
        }
        (!group.followers.is_empty()).then_some(group)
    }

    pub fn gate_environment(&self, account: &str) -> Option<Environment> {
        let leader = AccountId::new(account);
        let Some(group) = self.copying.book.led_by(&leader) else {
            return self.environment(account);
        };
        self.strictest_environment(
            std::iter::once(&leader).chain(group.copying().map(|f| &f.account_id)),
        )
    }

    pub fn strictest_environment<'a>(
        &self,
        accounts: impl IntoIterator<Item = &'a AccountId>,
    ) -> Option<Environment> {
        let mut strictest: Option<Environment> = None;
        for a in accounts {
            let e = self.environment(a.as_str())?;
            if strictest.is_none_or(|s| strictness(e) > strictness(s)) {
                strictest = Some(e);
            }
        }
        strictest
    }

    pub(crate) async fn follower_contract(
        &self,
        f: &CopyFollower,
        leader_instrument: &str,
    ) -> Result<InstrumentId, ToolError> {
        let root = if f.micro {
            let (instrument, _) = match self.meant(leader_instrument).await {
                Ok(m) => m,
                Err(e) => {
                    let words = self.account_words(&f.account_id).await;
                    return Err(crate::orders::naming(&words, e));
                }
            };
            exchange_contract(&instrument)
                .filter(|c| {
                    COPIED_IN_MICROS
                        .iter()
                        .any(|r| r.eq_ignore_ascii_case(&c.root))
                })
                .and_then(|c| product(&c.root))
                .and_then(Product::micro)
                .map(|m| m.root)
        } else {
            None
        };
        Ok(self
            .name_contract(&f.account_id, leader_instrument, root)
            .await?
            .instrument
            .id)
    }

    pub async fn preview_copies<T: Serialize>(
        &self,
        tool: &str,
        input: &T,
        account: &str,
        preview: &mut Value,
    ) {
        let group = self.copying.book.led_by(&AccountId::new(account));
        let followers: Vec<AccountId> = group
            .as_ref()
            .map(|g| g.copying().map(|f| f.account_id.clone()).collect())
            .unwrap_or_default();
        self.remember_preview(preview_key(tool, input), followers.clone());
        let Some(group) = group.filter(|_| !followers.is_empty()) else {
            return;
        };
        let mut accounts = Vec::with_capacity(followers.len());
        for f in &followers {
            accounts.push(self.account_name(f.as_str()).await);
        }
        let words = copies_words(followers.len());
        if let Some(obj) = preview.as_object_mut() {
            if let Some(Value::String(s)) = obj.get_mut("restatement") {
                s.push(' ');
                s.push_str(&words);
            }
            let copies = CopyPreview {
                group_id: group.id,
                group_name: group.name,
                accounts,
                words,
            };
            if let Ok(v) = serde_json::to_value(copies) {
                obj.insert("copies".into(), v);
            }
        }
    }

    async fn held(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
    ) -> Result<Decimal, ToolError> {
        Ok(self
            .provider_ref()
            .positions(account)
            .await
            .map_err(crate::orders::broker_error)?
            .into_iter()
            .find(|p| &p.instrument == instrument)
            .map_or(Decimal::ZERO, |p| p.qty.0))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn audit_copy(
        &self,
        ctx: &ToolCtx,
        group: &CopyGroup,
        leader_name: &str,
        follower: &AccountId,
        copy_of: &str,
        input: Value,
        r: &Result<String, ToolError>,
    ) {
        let Some(observer) = self.copying.audit.read().clone() else {
            return;
        };
        let mut input = match input {
            Value::Object(m) => Value::Object(m),
            other => json!({ "input": other }),
        };
        if let Some(o) = input.as_object_mut() {
            o.insert("accountId".into(), json!(follower));
            o.insert("copyOf".into(), json!(copy_of));
            o.insert("leaderAccountId".into(), json!(group.leader_id));
            o.insert("groupId".into(), json!(group.id));
        }
        let now = self.clock_ref().now();
        let record = ToolCallRecord {
            call_id: CallId::generate(),
            tool: COPY_TOOL.to_owned(),
            risk: RiskTier::Financial,
            origin: ctx.origin.clone(),
            session_id: ctx.session_id.clone(),
            input_hash: hash_json(&input),
            input,
            status: if r.is_ok() {
                ToolCallStatus::Ok
            } else {
                ToolCallStatus::Error
            },
            started_at: now,
            finished_at: Some(now),
            duration_ms: Some(0.0),
            error: r.as_ref().err().map(|e| ToolErrorInfo {
                code: e.code,
                message: e.message.clone(),
                retryable: false,
                details: None,
            }),
            approval_id: ctx.approved_by.clone(),
            deduped: false,
            idempotency_key: None,
            summary: Some(match r {
                Ok(s) => format!("Copied from {leader_name}: {s}"),
                Err(e) => format!("Not copied from {leader_name}: {}", e.message),
            }),
            approved_by: ctx.approved_by.clone(),
        };
        observer.call_finished(&record);
    }

    fn say_report(&self, group: &CopyGroup, what: &str, report: &CopyReport) {
        let now = self.clock_ref().now();
        self.copying.sync.remember(group, what, report, now);
        if let Some((title, detail, tone)) = report.note(what) {
            self.say(group, title, detail, tone);
        }
    }

    pub(super) fn say_whole_report(&self, group: &CopyGroup, what: &str, report: &CopyReport) {
        let now = self.clock_ref().now();
        self.copying.sync.remember(group, what, report, now);
        let (title, detail, tone) = report.said(what);
        self.say(group, title, detail, tone);
    }

    fn say(&self, group: &CopyGroup, title: String, detail: String, tone: &str) {
        self.copying.book.say(CopyNote {
            group_id: group.id.clone(),
            leader_id: group.leader_id.clone(),
            title,
            detail,
            tone: tone.into(),
            ts: self.clock_ref().now(),
        });
    }

    async fn each_follower<'a, F, Fut>(&'a self, group: &'a CopyGroup, each: F) -> Vec<Copying>
    where
        F: Fn(&'a CopyFollower, String) -> Fut,
        Fut: Future<Output = Copying> + 'a,
    {
        self.each_of(&group.followers, COPY_WAIT, each).await
    }

    pub(super) async fn each_of<'a, T, F, Fut>(
        &'a self,
        members: &'a [T],
        wait: Duration,
        each: F,
    ) -> Vec<Copying>
    where
        T: Member,
        F: Fn(&'a T, String) -> Fut,
        Fut: Future<Output = Copying> + 'a,
    {
        let tasks = members.iter().map(|m| {
            let fut = async {
                let account = m.account();
                let name = self.account_name(account.as_str()).await;
                match tokio::time::timeout(wait, each(m, name.clone())).await {
                    Ok(c) => c,
                    Err(_) => Copying::new(account, name).done(
                        CopyOutcome::Unknown,
                        format!("no answer in {} s; check its orders", wait.as_secs()),
                    ),
                }
            };
            Box::pin(fut)
        });
        join_all(tasks).await
    }

    pub(super) fn report(&self, group: &CopyGroup, done: &[Copying]) -> CopyReport {
        CopyReport {
            group_id: group.id.clone(),
            group_name: group.name.clone(),
            leader_id: group.leader_id.clone(),
            results: done.iter().map(|c| c.result.clone()).collect(),
        }
    }

    pub async fn submit_copying(
        &self,
        ctx: &ToolCtx,
        tool: &str,
        input: &OrderInput,
        key: Option<&str>,
        draft: Option<DraftId>,
    ) -> Result<SubmitOutput, ToolError> {
        let leader = AccountId::new(&input.account_id);
        let _turn = self.turn_if_leading(&leader).await;
        let Some(group) = self.copy_scope(ctx, tool, input, &leader) else {
            return self.submit(input, key, draft).await;
        };
        let req = match self.request(input, key).await {
            Ok(r) => r,
            Err(e) => return Err(self.named_error(&input.account_id, e).await),
        };
        let before = self.held(&leader, &req.instrument).await;
        let r = self.submit(input, key, draft).await;
        let before = match before {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(account = %leader, error = %e.message, "copy: {LEADER_UNREAD}");
                let report = self.copied_nothing(&group, &req).await;
                return attach(r, report, |o, c| o.copies = Some(c));
            }
        };
        let (closing, opening) = split(before, req.side, req.qty.0, req.reduce_only);
        if r.is_err() && (!opening.is_zero() || closing.is_zero()) {
            return r;
        }
        let order = r.as_ref().ok().map(|o| o.order.clone());
        let anchor = self.leader_anchor(order.as_ref(), &req).await;
        let lead = Lead {
            input,
            req: &req,
            before,
            order: order.as_ref(),
            anchor,
            flat_first: false,
            what: None,
        };
        let report = self.copy_order(ctx, &group, &lead).await;
        attach(r, report, |o, c| o.copies = Some(c))
    }

    async fn copied_nothing(&self, group: &CopyGroup, req: &OrderRequest) -> CopyReport {
        let spec = self
            .market_ref()
            .spec(&req.instrument)
            .await
            .ok()
            .map(|(_, s)| s);
        let done = self
            .each_follower(group, |f, name| async move {
                Copying::new(&f.account_id, name).done(CopyOutcome::Unknown, LEADER_UNREAD)
            })
            .await;
        let report = self.report(group, &done);
        self.say_report(group, &request_words(req, spec.as_ref()), &report);
        report
    }

    async fn leader_anchor(&self, order: Option<&Order>, req: &OrderRequest) -> Option<Price> {
        if let Some(p) = order
            .filter(|o| !o.filled_qty.is_zero())
            .and_then(|o| o.avg_fill_price)
        {
            return Some(p);
        }
        match req.entry_price() {
            Some(p) => Some(p),
            None => self.touch(&req.instrument, req.side).await,
        }
    }

    async fn copy_order(&self, ctx: &ToolCtx, group: &CopyGroup, lead: &Lead<'_>) -> CopyReport {
        let leader_name = self.account_name(group.leader_id.as_str()).await;
        let spec = self
            .market_ref()
            .spec(&lead.req.instrument)
            .await
            .ok()
            .map(|(_, s)| s);
        let tick = spec.as_ref().map(|s| s.tick_size.0);
        let what = lead
            .what
            .clone()
            .unwrap_or_else(|| request_words(lead.req, spec.as_ref()));
        let done = self
            .each_follower(group, |f, name| {
                self.copy_order_to(ctx, group, &leader_name, f, name, lead, tick)
            })
            .await;
        let report = self.report(group, &done);
        self.say_report(group, &what, &report);
        if let Some(lo) = lead.order {
            let followers: Vec<(String, OrderId)> = done
                .iter()
                .filter_map(|c| c.main.clone().map(|m| (c.result.account.clone(), m)))
                .collect();
            if !followers.is_empty() {
                self.copying.watches.lock().push(FillWatch {
                    group_id: group.id.clone(),
                    leader: group.leader_id.clone(),
                    leader_name,
                    leader_order: lo.id.clone(),
                    what,
                    followers,
                    spec,
                    filled_at: None,
                    created: Instant::now(),
                });
                self.check_fills(Some(&lo.id));
            }
        }
        report
    }

    #[allow(clippy::too_many_arguments)]
    async fn copy_order_to(
        &self,
        ctx: &ToolCtx,
        group: &CopyGroup,
        leader_name: &str,
        f: &CopyFollower,
        name: String,
        lead: &Lead<'_>,
        tick: Option<Decimal>,
    ) -> Copying {
        let mut c = Copying::new(&f.account_id, name);
        let req = lead.req;
        let words = self.account_words(&f.account_id).await;
        let own = match self.follower_contract(f, req.instrument.as_str()).await {
            Ok(own) => own,
            Err(e) => {
                let why = bare(&words, &e);
                return c.done(outcome_of(&e), why);
            }
        };
        let mut texts: Vec<String> = Vec::new();
        if lead.flat_first {
            match self
                .flat_on(
                    ctx,
                    group,
                    leader_name,
                    &f.account_id,
                    &own,
                    "orders.flatten",
                )
                .await
            {
                Ok((text, closed)) => {
                    texts.push(text);
                    c.result.orders.extend(closed);
                }
                Err(e) => {
                    let why = bare(&words, &e);
                    let text = format!("{}; the entry was not sent", why.trim_end_matches('.'));
                    return c.done(outcome_of(&e), text);
                }
            }
        }
        let pos = match self.held(&f.account_id, &own).await {
            Ok(p) => p,
            Err(e) => {
                let why = bare(&words, &e);
                return c.done(outcome_of(&e), why);
            }
        };
        let q = follower_qty(lead.before, req.side, req.qty.0, req.reduce_only, pos, f);
        if q.is_zero() {
            texts.push(why_nothing(
                lead.before,
                req.side,
                req.qty.0,
                req.reduce_only,
                pos,
                f,
                own.symbol(),
            ));
            return c.done(CopyOutcome::Nothing, texts.join("; "));
        }
        let base = OrderInput {
            account_id: f.account_id.to_string(),
            instrument: own.to_string(),
            side: req.side,
            qty: Qty::ZERO,
            order_type: req.order_type,
            limit_price: req.limit_price,
            stop_price: req.stop_price,
            tif: Some(req.tif),
            bracket: None,
            reduce_only: None,
            client_order_id: None,
        };
        if !q.close.is_zero() {
            let close = OrderInput {
                qty: Qty(q.close),
                reduce_only: Some(true),
                ..base.clone()
            };
            let r = self.submit(&close, None, None).await;
            let summary = r
                .as_ref()
                .map(|o| {
                    format!(
                        "{} (closes){}",
                        request_words(&o.order.request, None),
                        status_tail(&o.order)
                    )
                })
                .map_err(Clone::clone);
            self.audit_copy(
                ctx,
                group,
                leader_name,
                &f.account_id,
                "orders.submit",
                json!(close),
                &summary,
            );
            match r {
                Ok(out) => {
                    if let Some(lo) = lead.order {
                        self.copying.links.lock().add(
                            lo,
                            lead.before,
                            &f.account_id,
                            &out.order.id,
                        );
                    }
                    self.note_sent(&out.order.id);
                    c.result.orders.push(out.order.id.clone());
                    c.main = Some(out.order.id);
                    texts.extend(summary.ok());
                }
                Err(e) => {
                    let why = bare(&words, &e);
                    return c.done(outcome_of(&e), why);
                }
            }
        }
        if !q.open.is_zero()
            && let Some(e) = self.leader_locked(&group.leader_id)
        {
            let why = bare(&words, &e);
            if texts.is_empty() {
                return c.done(outcome_of(&e), why);
            }
            let text = format!("{}; the entry was not sent: {why}", texts.join(" · "));
            return c.done(outcome_of(&e), text);
        }
        if !q.open.is_zero() {
            let legs = lead.input.bracket.filter(|b| !b.is_empty());
            let (bracket, offsets) = match (legs, lead.anchor) {
                (Some(b), Some(from)) => {
                    let to = match req.entry_price() {
                        Some(p) => Some(p),
                        None => self.touch(&own, req.side).await,
                    }
                    .unwrap_or(from);
                    let offsets = (
                        b.stop_loss.map(|s| s.0 - from.0),
                        b.take_profit.map(|t| t.0 - from.0),
                    );
                    (Some(shifted(&b, from, to, tick)), Some(offsets))
                }
                (b, _) => (b, None),
            };
            let open = OrderInput {
                qty: Qty(q.open),
                bracket,
                reduce_only: lead.input.reduce_only,
                ..base
            };
            let r = self.submit(&open, None, None).await;
            let summary = r
                .as_ref()
                .map(|o| {
                    let mut s = format!(
                        "{}{}",
                        request_words(&o.order.request, None),
                        status_tail(&o.order)
                    );
                    if !o.bracket.is_empty() || o.order.request.bracket.is_some() {
                        s.push_str(" · bracket");
                    }
                    s
                })
                .map_err(Clone::clone);
            self.audit_copy(
                ctx,
                group,
                leader_name,
                &f.account_id,
                "orders.submit",
                json!(open),
                &summary,
            );
            match r {
                Ok(out) => {
                    if let Some(lo) = lead.order {
                        self.copying.links.lock().add(
                            lo,
                            lead.before,
                            &f.account_id,
                            &out.order.id,
                        );
                    }
                    if let Some((stop, target)) = offsets {
                        let a = Anchor {
                            account: f.account_id.clone(),
                            stop,
                            target,
                            leader: lead
                                .order
                                .zip(legs)
                                .map(|(o, b)| (o.id.clone(), b.stop_loss, b.take_profit)),
                            tick,
                            at: Instant::now(),
                        };
                        if out.order.status == OrderStatus::Filled {
                            self.reanchor(&out.order.id, &a).await;
                        } else if out.order.status.is_open() {
                            self.copying.anchors.lock().insert(out.order.id.clone(), a);
                        }
                    }
                    self.note_sent(&out.order.id);
                    c.result.orders.push(out.order.id.clone());
                    c.main = Some(out.order.id);
                    texts.extend(summary.ok());
                }
                Err(e) => {
                    let why = bare(&words, &e);
                    if texts.is_empty() {
                        return c.done(outcome_of(&e), why);
                    }
                    let text = format!("{}; the entry was not sent: {why}", texts.join(" · "));
                    return c.done(outcome_of(&e), text);
                }
            }
        }
        let text = texts.join(" · ");
        c.done(CopyOutcome::Copied, text)
    }

    pub(super) async fn flat_on(
        &self,
        ctx: &ToolCtx,
        group: &CopyGroup,
        leader_name: &str,
        account: &AccountId,
        own: &InstrumentId,
        copy_of: &str,
    ) -> Result<(String, Vec<OrderId>), ToolError> {
        let mine = AccountScopeInput {
            account_id: account.to_string(),
            instrument: Some(own.to_string()),
        };
        let r = self.flatten(&mine).await;
        let summary = r.as_ref().map(flatten_words).map_err(Clone::clone);
        self.audit_copy(
            ctx,
            group,
            leader_name,
            account,
            copy_of,
            json!(mine),
            &summary,
        );
        let closed: Vec<OrderId> = r
            .as_ref()
            .map(|o| o.closing.iter().map(|o| o.id.clone()).collect())
            .unwrap_or_default();
        for id in &closed {
            self.note_sent(id);
        }
        let deadline = Instant::now() + crate::orders::REVERSE_SETTLE;
        loop {
            let flat = self.held(account, own).await.is_ok_and(|q| q.is_zero());
            let idle = self.provider_ref().orders(account).await.is_ok_and(|v| {
                !v.iter()
                    .any(|o| &o.request.instrument == own && o.status.is_open())
            });
            if flat && idle {
                return Ok((summary.unwrap_or_else(|_| "flat".to_owned()), closed));
            }
            if Instant::now() >= deadline {
                return Err(match r {
                    Err(e) => e,
                    Ok(_) => {
                        ToolError::unavailable(format!("{} does not read flat yet", own.symbol()))
                    }
                });
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn reanchor(&self, entry: &OrderId, a: &Anchor) {
        let provider = self.provider_ref();
        let Some(avg) = provider.order_of(entry).and_then(|o| o.avg_fill_price) else {
            return;
        };
        let Ok(orders) = provider.orders(&a.account).await else {
            return;
        };
        let filled = a.leader.as_ref().and_then(|(id, stop, target)| {
            let lead = provider.order_of(id)?;
            let at = lead.avg_fill_price.filter(|_| !lead.filled_qty.is_zero())?;
            Some((stop.map(|s| s.0 - at.0), target.map(|t| t.0 - at.0)))
        });
        let (stop, target) = filled.unwrap_or((a.stop, a.target));
        let legs = orders
            .into_iter()
            .filter(|l| l.parent_id.as_ref() == Some(entry) && l.status.is_open());
        for leg in legs {
            let (offset, now) = match leg.role {
                OrderRole::StopLoss => (stop, leg.request.stop_price),
                OrderRole::TakeProfit => (target, leg.request.limit_price),
                _ => continue,
            };
            let (Some(offset), Some(now)) = (offset, now) else {
                continue;
            };
            let want = Price(on_tick(avg.0 + offset, a.tick));
            if want == now {
                continue;
            }
            let changes = if leg.role == OrderRole::StopLoss {
                OrderChanges {
                    stop_price: Some(want),
                    ..OrderChanges::default()
                }
            } else {
                OrderChanges {
                    limit_price: Some(want),
                    ..OrderChanges::default()
                }
            };
            let b = self.broker();
            let r = b.modify(&a.account, &leg.id, changes).await;
            match &r {
                Ok(_) => tracing::info!(order = %leg.id, "copy: a leg moved to its entry's fill"),
                Err(e) => {
                    tracing::warn!(order = %leg.id, error = %e, "copy: a leg stays where it is")
                }
            }
            if let Some(p) = self.protection() {
                let role = if leg.role == OrderRole::StopLoss {
                    "stop"
                } else {
                    "target"
                };
                let at = crate::protect::manager::price_words(want);
                let text = match &r {
                    Ok(_) => format!(
                        "Copy: moved the {role} to {at}, the leader's distance from this fill"
                    ),
                    Err(e) => format!(
                        "Copy: could not move the {role} to {at}, the leader's distance from this \
                         fill: {}",
                        crate::protect::manager::error_words(e)
                    ),
                };
                p.tell(
                    &(a.account.clone(), leg.request.instrument.clone()),
                    json!({
                        "accountId": a.account,
                        "instrument": leg.request.instrument,
                        "mode": "copy",
                        "merge": false,
                        "orders": [leg.id.to_string()],
                        "entries": [entry.to_string()],
                        "steps": [{
                            "action": "move", "orderId": leg.id, "role": leg.role,
                            "from": now, "to": want,
                        }],
                    }),
                    &text,
                    r.as_ref().err(),
                );
            }
        }
    }

    pub(super) fn copies_a_working_order(&self, follower: &AccountId, order: &OrderId) -> bool {
        let leader = self.copying.links.lock().leader_of(follower, order);
        leader
            .and_then(|l| self.provider_ref().order_of(&l))
            .is_some_and(|o| o.status.is_open())
    }

    async fn copies_of(&self, f: &CopyFollower, order: &Order) -> Result<Vec<Order>, ToolError> {
        let follower = &f.account_id;
        let (direct, via_parent) = {
            let links = self.copying.links.lock();
            (
                links.of(&order.id, follower),
                order
                    .parent_id
                    .as_ref()
                    .map(|p| links.of(p, follower))
                    .unwrap_or_default(),
            )
        };
        let orders = self
            .provider_ref()
            .orders(follower)
            .await
            .map_err(crate::orders::broker_error)?;
        let open: Vec<Order> = orders.into_iter().filter(|o| o.status.is_open()).collect();
        if !direct.is_empty() {
            return Ok(open
                .into_iter()
                .filter(|o| direct.contains(&o.id))
                .collect());
        }
        let leg = matches!(order.role, OrderRole::StopLoss | OrderRole::TakeProfit);
        if leg && !via_parent.is_empty() {
            let found: Vec<Order> = open
                .iter()
                .filter(|o| {
                    o.role == order.role
                        && o.parent_id.as_ref().is_some_and(|p| via_parent.contains(p))
                })
                .cloned()
                .collect();
            if !found.is_empty() {
                return Ok(found);
            }
        }
        if !(leg || order.request.reduce_only) {
            return Ok(Vec::new());
        }
        let own = self
            .follower_contract(f, order.request.instrument.as_str())
            .await?;
        let like: Vec<Order> = open
            .into_iter()
            .filter(|o| {
                o.status != OrderStatus::Held
                    && o.request.instrument == own
                    && o.role == order.role
                    && o.request.side == order.request.side
                    && o.request.order_type == order.request.order_type
                    && o.request.reduce_only == order.request.reduce_only
            })
            .collect();
        Ok(if like.len() == 1 { like } else { Vec::new() })
    }

    pub async fn modify_copying(
        &self,
        ctx: &ToolCtx,
        input: &ModifyOrderInput,
    ) -> Result<OrderOutput, ToolError> {
        let leader = AccountId::new(&input.account_id);
        let _turn = self.turn_if_leading(&leader).await;
        let Some(before) = self.provider_ref().order_of(&input.order_id) else {
            return self.modify(input).await;
        };
        let Some(group) = self.copy_scope(ctx, "orders.modify", input, &leader) else {
            let out = self.modify(input).await?;
            self.carry_anchors(&before, &out.order);
            return Ok(out);
        };
        let moved_leader = self.modify(input).await?;
        self.carry_anchors(&before, &moved_leader.order);
        let leader_name = self.account_name(group.leader_id.as_str()).await;
        let spec = self
            .market_ref()
            .spec(&before.request.instrument)
            .await
            .ok()
            .map(|(_, s)| s);
        let what = format!("Move {}", order_sentence(&before, spec.as_ref()));
        let done = self
            .each_follower(&group, |f, name| {
                let (before, group, leader_name, spec) = (&before, &group, &leader_name, &spec);
                async move {
                    let c = Copying::new(&f.account_id, name);
                    let targets = match self.copies_of(f, before).await {
                        Ok(t) => t,
                        Err(e) => {
                            let words = self.account_words(&f.account_id).await;
                            return c.done(outcome_of(&e), bare(&words, &e));
                        }
                    };
                    if targets.is_empty() {
                        return c.done(CopyOutcome::Nothing, "no matching working order");
                    }
                    let mut c = c;
                    let mut texts = Vec::new();
                    let leader_before = self.copying.links.lock().before(&before.id);
                    for t in targets {
                        let change = match moved(before, input, &t, f, leader_before) {
                            FollowMove::Keep => continue,
                            FollowMove::Cancel => {
                                let cancel = CancelOrderInput {
                                    account_id: f.account_id.to_string(),
                                    order_id: t.id.clone(),
                                };
                                let r = self.cancel(&cancel).await;
                                let summary = r
                                    .as_ref()
                                    .map(|o| {
                                        format!(
                                            "cancelled {}: at {} the new quantity adds nothing",
                                            order_sentence(&o.order, spec.as_ref()),
                                            f.sizing_words()
                                        )
                                    })
                                    .map_err(Clone::clone);
                                self.audit_copy(
                                    ctx,
                                    group,
                                    leader_name,
                                    &f.account_id,
                                    "orders.modify",
                                    json!(cancel),
                                    &summary,
                                );
                                match r {
                                    Ok(o) => {
                                        c.result.orders.push(o.order.id);
                                        texts.extend(summary.ok());
                                    }
                                    Err(e) if e.code == ToolErrorCode::Conflict => {}
                                    Err(e) => {
                                        let words = self.account_words(&f.account_id).await;
                                        return c.done(outcome_of(&e), bare(&words, &e));
                                    }
                                }
                                continue;
                            }
                            FollowMove::Modify(change) => change,
                        };
                        let r = self.modify(&change).await;
                        let summary = r
                            .as_ref()
                            .map(|o| format!("moved {}", order_sentence(&o.order, spec.as_ref())))
                            .map_err(Clone::clone);
                        self.audit_copy(
                            ctx,
                            group,
                            leader_name,
                            &f.account_id,
                            "orders.modify",
                            json!(change),
                            &summary,
                        );
                        match r {
                            Ok(o) => {
                                c.result.orders.push(o.order.id);
                                texts.extend(summary.ok());
                            }
                            Err(e) => {
                                let words = self.account_words(&f.account_id).await;
                                return c.done(outcome_of(&e), bare(&words, &e));
                            }
                        }
                    }
                    if texts.is_empty() {
                        return c.done(CopyOutcome::Nothing, "nothing to change");
                    }
                    c.done(CopyOutcome::Copied, texts.join(" · "))
                }
            })
            .await;
        let report = self.report(&group, &done);
        self.say_report(&group, &what, &report);
        attach(Ok(moved_leader), report, |o, c| o.copies = Some(c))
    }

    fn carry_anchors(&self, before: &Order, after: &Order) {
        if before.role != OrderRole::Entry || !before.filled_qty.is_zero() {
            return;
        }
        let (Some(from), Some(to)) = (before.request.entry_price(), after.request.entry_price())
        else {
            return;
        };
        let by = to.0 - from.0;
        if by.is_zero() {
            return;
        }
        let carry = |p: Option<Price>| p.map(|p| Price(p.0 + by));
        for a in self.copying.anchors.lock().values_mut() {
            if let Some((lead, stop, target)) = a.leader.as_mut()
                && *lead == before.id
            {
                *stop = carry(*stop);
                *target = carry(*target);
            }
        }
    }

    pub async fn cancel_copying(
        &self,
        ctx: &ToolCtx,
        input: &CancelOrderInput,
    ) -> Result<OrderOutput, ToolError> {
        let leader = AccountId::new(&input.account_id);
        let _turn = self.turn_if_leading(&leader).await;
        let Some(group) = self.copy_scope(ctx, "orders.cancel", input, &leader) else {
            return self.cancel(input).await;
        };
        let Some(before) = self.provider_ref().order_of(&input.order_id) else {
            return self.cancel(input).await;
        };
        let r = self.cancel(input).await;
        let leader_name = self.account_name(group.leader_id.as_str()).await;
        let spec = self
            .market_ref()
            .spec(&before.request.instrument)
            .await
            .ok()
            .map(|(_, s)| s);
        let what = format!("Cancel {}", order_sentence(&before, spec.as_ref()));
        let done = self
            .each_follower(&group, |f, name| {
                let (before, group, leader_name, spec) = (&before, &group, &leader_name, &spec);
                async move {
                    let c = Copying::new(&f.account_id, name);
                    let targets = match self.copies_of(f, before).await {
                        Ok(t) => t,
                        Err(e) => {
                            let words = self.account_words(&f.account_id).await;
                            return c.done(outcome_of(&e), bare(&words, &e));
                        }
                    };
                    if targets.is_empty() {
                        return c.done(CopyOutcome::Nothing, "no matching working order");
                    }
                    let mut c = c;
                    let mut texts = Vec::new();
                    for t in targets {
                        let cancel = CancelOrderInput {
                            account_id: f.account_id.to_string(),
                            order_id: t.id.clone(),
                        };
                        let r = self.cancel(&cancel).await;
                        let summary = r
                            .as_ref()
                            .map(|o| {
                                format!("cancelled {}", order_sentence(&o.order, spec.as_ref()))
                            })
                            .map_err(Clone::clone);
                        self.audit_copy(
                            ctx,
                            group,
                            leader_name,
                            &f.account_id,
                            "orders.cancel",
                            json!(cancel),
                            &summary,
                        );
                        match r {
                            Ok(o) => {
                                c.result.orders.push(o.order.id);
                                texts.extend(summary.ok());
                            }
                            Err(e) if e.code == ToolErrorCode::Conflict => {}
                            Err(e) => {
                                let words = self.account_words(&f.account_id).await;
                                return c.done(outcome_of(&e), bare(&words, &e));
                            }
                        }
                    }
                    if texts.is_empty() {
                        return c.done(CopyOutcome::Copied, "nothing left working");
                    }
                    c.done(CopyOutcome::Copied, texts.join(" · "))
                }
            })
            .await;
        let report = self.report(&group, &done);
        self.say_report(&group, &what, &report);
        attach(r, report, |o, c| o.copies = Some(c))
    }

    pub async fn cancel_all_copying(
        &self,
        ctx: &ToolCtx,
        input: &CancelAllInput,
    ) -> Result<CancelAllOutput, ToolError> {
        let leader = AccountId::new(&input.account_id);
        let _turn = self.turn_if_leading(&leader).await;
        let Some(group) = self.copy_scope(ctx, "orders.cancel_all", input, &leader) else {
            return self.cancel_all(input).await;
        };
        let r = self.cancel_all(input).await;
        let leader_name = self.account_name(group.leader_id.as_str()).await;
        let what = match &input.instrument {
            Some(i) => format!("Cancel {} orders", self.contract_words(&leader, i)),
            None => "Cancel all orders".to_owned(),
        };
        let done = self
            .each_follower(&group, |f, name| {
                let (group, leader_name) = (&group, &leader_name);
                async move {
                    let c = Copying::new(&f.account_id, name);
                    let instrument = match &input.instrument {
                        Some(i) => match self.follower_contract(f, i).await {
                            Ok(own) => Some(own.to_string()),
                            Err(e) => {
                                let words = self.account_words(&f.account_id).await;
                                return c.done(outcome_of(&e), bare(&words, &e));
                            }
                        },
                        None => None,
                    };
                    let mine = CancelAllInput {
                        account_id: f.account_id.to_string(),
                        instrument,
                        ..input.clone()
                    };
                    let r = self.cancel_all(&mine).await;
                    let summary = r
                        .as_ref()
                        .map(|o| format!("cancelled {}", o.cancelled.len()))
                        .map_err(Clone::clone);
                    self.audit_copy(
                        ctx,
                        group,
                        leader_name,
                        &f.account_id,
                        "orders.cancel_all",
                        json!(mine),
                        &summary,
                    );
                    match (r, summary) {
                        (Ok(o), Ok(s)) => {
                            let mut c = c;
                            c.result.orders = o.cancelled.into_iter().map(|o| o.id).collect();
                            c.done(CopyOutcome::Copied, s)
                        }
                        (Err(e), _) | (_, Err(e)) => {
                            let words = self.account_words(&f.account_id).await;
                            c.done(outcome_of(&e), bare(&words, &e))
                        }
                    }
                }
            })
            .await;
        let report = self.report(&group, &done);
        self.say_report(&group, &what, &report);
        attach(r, report, |o, c| o.copies = Some(c))
    }

    pub async fn flatten_copying(
        &self,
        ctx: &ToolCtx,
        input: &AccountScopeInput,
    ) -> Result<FlattenOutput, ToolError> {
        let leader = AccountId::new(&input.account_id);
        let _turn = self.turn_if_leading(&leader).await;
        let Some(group) = self.copy_scope(ctx, "orders.flatten", input, &leader) else {
            return self.flatten(input).await;
        };
        let r = self.flatten(input).await;
        let report = self
            .copy_flatten(ctx, &group, input.instrument.as_deref())
            .await;
        attach(r, report, |o, c| o.copies = Some(c))
    }

    async fn copy_flatten(
        &self,
        ctx: &ToolCtx,
        group: &CopyGroup,
        instrument: Option<&str>,
    ) -> CopyReport {
        let leader_name = self.account_name(group.leader_id.as_str()).await;
        let what = match instrument {
            Some(i) => format!("Flatten {}", self.contract_words(&group.leader_id, i)),
            None => "Flatten everything".to_owned(),
        };
        let done = self
            .each_follower(group, |f, name| {
                let leader_name = &leader_name;
                async move {
                    let c = Copying::new(&f.account_id, name);
                    let instrument = match instrument {
                        Some(i) => match self.follower_contract(f, i).await {
                            Ok(own) => Some(own.to_string()),
                            Err(e) => {
                                let words = self.account_words(&f.account_id).await;
                                return c.done(outcome_of(&e), bare(&words, &e));
                            }
                        },
                        None => None,
                    };
                    let mine = AccountScopeInput {
                        account_id: f.account_id.to_string(),
                        instrument,
                    };
                    let r = self.flatten(&mine).await;
                    let summary = r.as_ref().map(flatten_words).map_err(Clone::clone);
                    self.audit_copy(
                        ctx,
                        group,
                        leader_name,
                        &f.account_id,
                        "orders.flatten",
                        json!(mine),
                        &summary,
                    );
                    match (r, summary) {
                        (Ok(o), Ok(s)) => {
                            let mut c = c;
                            c.result.orders = o.closing.into_iter().map(|o| o.id).collect();
                            c.done(CopyOutcome::Copied, s)
                        }
                        (Err(e), _) | (_, Err(e)) => {
                            let words = self.account_words(&f.account_id).await;
                            c.done(outcome_of(&e), bare(&words, &e))
                        }
                    }
                }
            })
            .await;
        let report = self.report(group, &done);
        self.say_report(group, &what, &report);
        report
    }

    pub async fn breakeven_copying(
        &self,
        ctx: &ToolCtx,
        input: &BreakevenStopInput,
    ) -> Result<BreakevenStopOutput, ToolError> {
        let leader = AccountId::new(&input.account_id);
        let _turn = self.turn_if_leading(&leader).await;
        let Some(group) = self.copy_scope(ctx, "orders.breakeven", input, &leader) else {
            return Ok(self.breakeven(input, true).await?.1);
        };
        let r = self.breakeven(input, true).await.map(|(_, out)| out);
        let leader_name = self.account_name(group.leader_id.as_str()).await;
        let what = format!(
            "Breakeven {}",
            self.contract_words(&leader, &input.instrument)
        );
        let done = self
            .each_follower(&group, |f, name| {
                let (group, leader_name) = (&group, &leader_name);
                async move {
                    let c = Copying::new(&f.account_id, name);
                    let words = self.account_words(&f.account_id).await;
                    let own = match self.follower_contract(f, &input.instrument).await {
                        Ok(own) => own,
                        Err(e) => return c.done(outcome_of(&e), bare(&words, &e)),
                    };
                    let mine = BreakevenStopInput {
                        account_id: f.account_id.to_string(),
                        instrument: own.to_string(),
                        ..input.clone()
                    };
                    let r = self.breakeven(&mine, true).await.map(|(_, out)| out);
                    match r {
                        Ok(out) => {
                            let summary = Ok(out.summary.clone());
                            self.audit_copy(
                                ctx,
                                group,
                                leader_name,
                                &f.account_id,
                                "orders.breakeven",
                                json!(mine),
                                &summary,
                            );
                            let mut c = c;
                            c.result.orders = out
                                .moved
                                .into_iter()
                                .chain(out.placed)
                                .map(|o| o.id)
                                .collect();
                            c.done(CopyOutcome::Copied, out.summary)
                        }
                        Err(e) if e.code == ToolErrorCode::Rejected => {
                            c.done(CopyOutcome::Nothing, bare(&words, &e))
                        }
                        Err(e) => {
                            self.audit_copy(
                                ctx,
                                group,
                                leader_name,
                                &f.account_id,
                                "orders.breakeven",
                                json!(mine),
                                &Err(e.clone()),
                            );
                            c.done(outcome_of(&e), bare(&words, &e))
                        }
                    }
                }
            })
            .await;
        let report = self.report(&group, &done);
        self.say_report(&group, &what, &report);
        attach(r, report, |o, c| o.copies = Some(c))
    }

    pub async fn reverse_copying(
        &self,
        ctx: &ToolCtx,
        input: &ReverseInput,
    ) -> Result<ReverseOutput, ToolError> {
        let leader = AccountId::new(&input.account_id);
        let _turn = self.turn_if_leading(&leader).await;
        let Some(group) = self.copy_scope(ctx, "orders.reverse", input, &leader) else {
            return self.reverse(input, ctx.draft_id.clone()).await;
        };
        let r = self.reverse(input, ctx.draft_id.clone()).await;
        let report = match &r {
            Ok(out) => {
                let req = out.entry.request.clone();
                let entry = OrderInput {
                    account_id: input.account_id.clone(),
                    instrument: req.instrument.to_string(),
                    side: req.side,
                    qty: req.qty,
                    order_type: OrderType::Market,
                    limit_price: None,
                    stop_price: None,
                    tif: None,
                    bracket: input.bracket.filter(|b| !b.is_empty()),
                    reduce_only: None,
                    client_order_id: None,
                };
                let anchor = self.leader_anchor(Some(&out.entry), &req).await;
                let now = Decimal::from(req.side.sign()) * req.qty.0;
                let lead = Lead {
                    input: &entry,
                    req: &req,
                    before: Decimal::ZERO,
                    order: Some(&out.entry),
                    anchor,
                    flat_first: true,
                    what: Some(format!(
                        "Reverse {} to {}",
                        req.instrument.symbol(),
                        position_words(now)
                    )),
                };
                self.copy_order(ctx, &group, &lead).await
            }
            Err(e)
                if e.details
                    .as_ref()
                    .is_some_and(|d| d.get("cancelled").is_some()) =>
            {
                let contract = self
                    .instrument_hint(&input.account_id, &input.instrument)
                    .map_or_else(|| input.instrument.clone(), |i| i.to_string());
                self.copy_flatten(ctx, &group, Some(&contract)).await
            }
            Err(_) => return r,
        };
        attach(r, report, |o, c| o.copies = Some(c))
    }

    pub fn start_copying(self: &Arc<Self>) -> Vec<JoinHandle<()>> {
        let mut events = self.provider_ref().events();
        let me = Arc::downgrade(self);
        let watch = tokio::spawn(async move {
            while let Some(e) = events.next().await {
                let BrokerEvent::Order(o) = e else { continue };
                let Some(m) = me.upgrade() else { return };
                m.saw(&o);
            }
        });
        let me = Arc::downgrade(self);
        let tick = tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(1));
            loop {
                iv.tick().await;
                let Some(m) = me.upgrade() else { return };
                m.check_fills(None);
                m.copying
                    .anchors
                    .lock()
                    .retain(|_, a| a.at.elapsed() < WATCH_FOR);
            }
        });
        vec![watch, tick, self.start_sync()]
    }

    fn saw(self: &Arc<Self>, o: &Order) {
        let anchor = {
            let mut anchors = self.copying.anchors.lock();
            match anchors.get(&o.id) {
                Some(_) if o.status == OrderStatus::Filled => anchors.remove(&o.id),
                Some(_) if o.status.is_terminal() => {
                    anchors.remove(&o.id);
                    None
                }
                _ => None,
            }
        };
        if let Some(a) = anchor {
            let me = Arc::clone(self);
            let id = o.id.clone();
            tokio::spawn(async move { me.reanchor(&id, &a).await });
        }
        self.check_fills(Some(&o.id));
    }

    fn check_fills(&self, touched: Option<&OrderId>) {
        let provider = self.provider_ref();
        let mut said = Vec::new();
        self.copying.watches.lock().retain_mut(|w| {
            if let Some(t) = touched
                && &w.leader_order != t
                && !w.followers.iter().any(|(_, o)| o == t)
            {
                return true;
            }
            let Some(lead) = provider.order_of(&w.leader_order) else {
                return w.created.elapsed() < WATCH_FOR;
            };
            if lead.status != OrderStatus::Filled {
                return !lead.status.is_terminal() && w.created.elapsed() < WATCH_FOR;
            }
            let filled_at = *w.filled_at.get_or_insert_with(Instant::now);
            let Some(at) = lead.avg_fill_price else {
                return false;
            };
            let copies: Vec<(String, Option<Order>)> = w
                .followers
                .iter()
                .map(|(n, id)| (n.clone(), provider.order_of(id)))
                .collect();
            let waiting = copies
                .iter()
                .any(|(_, o)| o.as_ref().is_some_and(|o| !o.status.is_terminal()));
            if waiting && filled_at.elapsed() < FILL_WAIT {
                return true;
            }
            let px = |p: Price| match &w.spec {
                Some(s) => price_label(s, p),
                None => p.0.normalize().to_string(),
            };
            let tick = w
                .spec
                .as_ref()
                .map(|s| s.tick_size.0)
                .filter(|t| !t.is_zero());
            let mut off = Vec::new();
            for (name, o) in copies {
                let Some(o) = o else { continue };
                match (o.status, o.avg_fill_price) {
                    (OrderStatus::Filled, Some(p)) if p != at => {
                        let away = match tick {
                            Some(t) => {
                                let n = ((p.0 - at.0) / t).round().abs();
                                format!(
                                    "{} tick{} {}",
                                    n.normalize(),
                                    if n == Decimal::ONE { "" } else { "s" },
                                    if p > at { "above" } else { "below" }
                                )
                            }
                            None => (if p > at { "above" } else { "below" }).to_owned(),
                        };
                        off.push(format!("{name} filled at {}, {away}", px(p)));
                    }
                    (OrderStatus::Filled, _) => {}
                    (s, _) if !s.is_terminal() => off.push(format!("{name} not filled yet")),
                    _ if !o.filled_qty.is_zero() => off.push(format!(
                        "{name} filled {} of {}",
                        qty_label(o.filled_qty),
                        qty_label(o.request.qty)
                    )),
                    _ => off.push(format!(
                        "{name} did not fill{}",
                        o.reason
                            .as_deref()
                            .map(|r| format!(": {}", r.trim_end_matches('.')))
                            .unwrap_or_default()
                    )),
                }
            }
            if !off.is_empty() {
                said.push(CopyNote {
                    group_id: w.group_id.clone(),
                    leader_id: w.leader.clone(),
                    title: format!("{}: {} filled at {}", w.what, w.leader_name, px(at)),
                    detail: format!("{}.", off.join(". ")),
                    tone: "info".into(),
                    ts: self.clock_ref().now(),
                });
            }
            false
        });
        for n in said {
            self.copying.book.say(n);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum FollowMove {
    Modify(ModifyOrderInput),
    Cancel,
    Keep,
}

fn moved(
    before: &Order,
    input: &ModifyOrderInput,
    t: &Order,
    f: &CopyFollower,
    leader_before: Option<Decimal>,
) -> FollowMove {
    let entry = before.role == OrderRole::Entry
        && before.parent_id.is_none()
        && !before.request.reduce_only;
    let (qty, limit_price, stop_price) = if entry {
        let qty = match (input.qty, leader_before) {
            (Some(q), Some(held)) => {
                let after = held + Decimal::from(before.request.side.sign()) * q.0;
                let size = (f.target(after) - f.target(held)).abs();
                if size.is_zero() {
                    return FollowMove::Cancel;
                }
                Some(Qty(size))
            }
            (Some(q), None) => Some(Qty(f.opens(q.0))).filter(|q| !q.is_zero()),
            (None, _) => None,
        }
        .filter(|q| *q != t.request.qty);
        (qty, input.limit_price, input.stop_price)
    } else {
        let by = |new: Option<Price>, old: Option<Price>, now: Option<Price>| match (new, old, now)
        {
            (Some(n), Some(o), Some(c)) => Some(Price(c.0 + n.0 - o.0)),
            (Some(n), _, None) => Some(n),
            _ => None,
        };
        let qty = input.qty.and_then(|q| {
            (!before.request.qty.is_zero()).then(|| {
                Qty(
                    super::model::round_contracts(t.request.qty.0 * q.0 / before.request.qty.0)
                        .max(Decimal::ONE),
                )
            })
        });
        (
            qty.filter(|q| *q != t.request.qty),
            by(
                input.limit_price,
                before.request.limit_price,
                t.request.limit_price,
            ),
            by(
                input.stop_price,
                before.request.stop_price,
                t.request.stop_price,
            ),
        )
    };
    let limit_price = limit_price.filter(|p| Some(*p) != t.request.limit_price);
    let stop_price = stop_price.filter(|p| Some(*p) != t.request.stop_price);
    if qty.is_none() && limit_price.is_none() && stop_price.is_none() {
        return FollowMove::Keep;
    }
    FollowMove::Modify(ModifyOrderInput {
        account_id: t.request.account_id.to_string(),
        order_id: t.id.clone(),
        qty,
        limit_price,
        stop_price,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Price {
        Price(s.parse().unwrap())
    }

    #[test]
    fn a_followers_bracket_keeps_the_leaders_distances_from_its_own_entry() {
        let b = Bracket {
            stop_loss: Some(p("20600.00")),
            take_profit: Some(p("20700.00")),
            ..Bracket::default()
        };
        let moved = shifted(
            &b,
            p("20641.25"),
            p("20642.00"),
            Some("0.25".parse().unwrap()),
        );
        assert_eq!(moved.stop_loss, Some(p("20600.75")));
        assert_eq!(moved.take_profit, Some(p("20700.75")));
    }

    #[test]
    fn copies_are_counted_in_words() {
        assert_eq!(copies_words(1), "and 1 account by copy");
        assert_eq!(copies_words(6), "and 6 accounts by copy");
    }
}
