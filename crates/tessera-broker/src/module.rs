use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tessera_core::accounts::Environment;
use tessera_core::health::ProviderHealth;
use tessera_core::ids::AccountId;
use tessera_core::orders::OrderPreview;
use tessera_core::{InstrumentId, SharedClock};
use tessera_host::{
    EventBus, KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicKey,
    TopicSizing, TsExports, parse_params,
};
use tessera_market::MarketDataProvider;
use tessera_protocol::rpc::{RpcError, codes};
use tessera_protocol::topics::{
    AccountParams, AccountUpdate, FillUpdate, NoParams, OrderUpdate, PositionUpdate,
    ProtectionNote, names,
};
use tessera_store::Store;
use tessera_tools::{Invoker, RegistryError, ToolRegistry};
use tokio::task::JoinHandle;

use crate::copy::io::{
    CopyActionOutput, CopyCreateInput, CopyDeleteOutput, CopyFlattenInput, CopyGroupIdInput,
    CopyGroupOutput, CopyListInput, CopyListOutput, CopyPreview, CopyResyncInput, CopyStatusInput,
    CopyUpdateInput,
};
use crate::copy::tools::{
    CopyCreate, CopyDelete, CopyDisable, CopyEnable, CopyFlatten, CopyList, CopyResync, CopyStatus,
    CopyUpdate,
};
use crate::copy::{
    CopyBook, CopyGroupsUpdate, CopyNote, CopySyncUpdate, GROUPS_TOPIC, NOTES_TOPIC, SYNC_TOPIC,
};
use crate::lockout::AccountLocks;
use crate::orders::io::{
    AccountFilterInput, AccountScopeInput, AccountsOutput, BreakevenStopInput, BreakevenStopOutput,
    CancelAllInput, CancelAllOutput, CancelOrderInput, ContractForInput, ContractForOutput,
    FillsOutput, FlattenOutput, GetAccountsInput, GetFillsInput, GetLimitsInput, GetOrdersInput,
    LimitsOutput, MergeOutput, ModifyOrderInput, OrderInput, OrderOutput, OrdersOutput,
    PositionsOutput, ReverseInput, ReverseOutput, RiskStatusInput, RiskStatusOutput, SubmitOutput,
};
use crate::orders::io::{
    AccountLockOutput, GetLockInput, LockAccountInput, LockAccountOutput, UnlockAccountInput,
    UnlockAccountOutput,
};
use crate::orders::tools::{
    BreakevenStop, CancelAll, CancelOrder, ContractFor, CreateDraft, Flatten, GetAccounts,
    GetFills, GetLimits, GetLock, GetOrders, GetPositions, GetRiskStatus, LockAccount,
    MergeBrackets, ModifyOrder, PreviewOrder, Reverse, SubmitOrder, UnlockAccount,
};
use crate::orders::{ActionPreview, LossWatch, OrdersService};
use crate::paper::{AccountSeed, PaperBroker, PaperConfig, default_seeds};
use crate::protect::ProtectionManager;
use crate::{BrokerError, BrokerEvent, BrokerProvider, BrokerRouter, GuardedBroker};

pub fn publish_account_event<T: Serialize>(
    bus: &EventBus,
    topic: &'static str,
    account: &str,
    data: &T,
) -> u64 {
    bus.publish(topic, TopicKey::Account(account.to_owned()), data)
}

pub struct BrokerModule {
    paper: Arc<PaperBroker>,
    brokers: Arc<BrokerRouter>,
    service: Arc<OrdersService>,
    protection: Arc<ProtectionManager>,
    market: Arc<dyn MarketDataProvider>,
    bus: Arc<EventBus>,
}

impl std::fmt::Debug for BrokerModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrokerModule")
            .field("paper", &self.paper)
            .finish_non_exhaustive()
    }
}

impl BrokerModule {
    pub async fn paper(
        market: Arc<dyn MarketDataProvider>,
        clock: SharedClock,
        store: Option<Store>,
        config: PaperConfig,
        bus: Arc<EventBus>,
    ) -> Result<Self, BrokerError> {
        Self::paper_seeded(market, clock, store, config, bus, &default_seeds()).await
    }

    pub async fn paper_seeded(
        market: Arc<dyn MarketDataProvider>,
        clock: SharedClock,
        store: Option<Store>,
        config: PaperConfig,
        bus: Arc<EventBus>,
        seeds: &[AccountSeed],
    ) -> Result<Self, BrokerError> {
        let paper = PaperBroker::open(
            Arc::clone(&market),
            Arc::clone(&clock),
            store.clone(),
            config,
            seeds,
        )
        .await?;
        let brokers = BrokerRouter::new();
        brokers.add(Arc::clone(&paper) as Arc<dyn BrokerProvider>)?;
        let provider: Arc<dyn BrokerProvider> = Arc::clone(&brokers) as _;
        let guarded = Arc::new(GuardedBroker::new(provider));
        let protection = ProtectionManager::new(Arc::clone(&guarded), Arc::clone(&clock));
        if let Some(s) = &store {
            protection.keep_rules_in(s.clone()).await;
        }
        let copies = CopyBook::load(store.clone()).await;
        let locks = AccountLocks::load(store.clone()).await;
        let service = Arc::new(
            OrdersService::new(guarded, Arc::clone(&market), clock)
                .with_copy_book(copies)
                .with_account_locks(locks),
        );
        service.set_protection(Arc::clone(&protection));
        Ok(Self {
            paper,
            brokers,
            service,
            protection,
            market,
            bus,
        })
    }

    pub fn paper_broker(&self) -> &Arc<PaperBroker> {
        &self.paper
    }

    pub fn brokers(&self) -> &Arc<BrokerRouter> {
        &self.brokers
    }

    pub fn service(&self) -> &Arc<OrdersService> {
        &self.service
    }

    pub fn set_limits(&self, setting: tessera_core::limits::LimitsSetting) {
        self.service.set_limits(setting);
        self.publish_accounts();
    }

    pub fn set_account_types(&self, types: BTreeMap<AccountId, Environment>) {
        self.brokers.set_account_types(types);
        self.publish_accounts();
    }

    fn publish_accounts(&self) {
        let (service, bus) = (Arc::clone(&self.service), Arc::clone(&self.bus));
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let Ok(all) = service.accounts().await else {
                    return;
                };
                for u in all {
                    let a = u.account.id.to_string();
                    publish_account_event(&bus, names::ACCOUNTS, &a, &u);
                }
            });
        }
    }

    pub fn protection(&self) -> &Arc<ProtectionManager> {
        &self.protection
    }
}

impl RuntimeModule for BrokerModule {
    fn name(&self) -> &'static str {
        "broker"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        let s = &self.service;
        r.register(ContractFor(Arc::clone(s)))?;
        r.register(PreviewOrder(Arc::clone(s)))?;
        r.register(SubmitOrder(Arc::clone(s)))?;
        r.register(CreateDraft(Arc::clone(s)))?;
        r.register(ModifyOrder(Arc::clone(s)))?;
        r.register(CancelOrder(Arc::clone(s)))?;
        r.register(CancelAll(Arc::clone(s)))?;
        r.register(Flatten(Arc::clone(s)))?;
        r.register(MergeBrackets(Arc::clone(s)))?;
        r.register(BreakevenStop(Arc::clone(s)))?;
        r.register(Reverse(Arc::clone(s)))?;
        r.register(GetAccounts(Arc::clone(s)))?;
        r.register(GetPositions(Arc::clone(s)))?;
        r.register(GetOrders(Arc::clone(s)))?;
        r.register(GetFills(Arc::clone(s)))?;
        r.register(GetRiskStatus(Arc::clone(s)))?;
        r.register(GetLimits(Arc::clone(s)))?;
        r.register(GetLock(Arc::clone(s)))?;
        r.register(LockAccount(Arc::clone(s)))?;
        r.register(UnlockAccount(Arc::clone(s)))?;
        r.register(CopyList(Arc::clone(s)))?;
        r.register(CopyCreate(Arc::clone(s)))?;
        r.register(CopyUpdate(Arc::clone(s)))?;
        r.register(CopyEnable(Arc::clone(s)))?;
        r.register(CopyDisable(Arc::clone(s)))?;
        r.register(CopyDelete(Arc::clone(s)))?;
        r.register(CopyStatus(Arc::clone(s)))?;
        r.register(CopyResync(Arc::clone(s)))?;
        r.register(CopyFlatten(Arc::clone(s)))?;
        Ok(())
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        [
            names::ORDERS,
            names::POSITIONS,
            names::ACCOUNTS,
            names::FILLS,
            names::PROTECTION,
        ]
        .into_iter()
        .map(|name| {
            Arc::new(AccountTopic {
                name,
                service: Arc::clone(&self.service),
            }) as Arc<dyn TopicHandler>
        })
        .chain([
            Arc::new(CopyGroupsTopic(Arc::clone(&self.service))) as Arc<dyn TopicHandler>,
            Arc::new(CopyNotesTopic) as Arc<dyn TopicHandler>,
            Arc::new(CopySyncTopic(Arc::clone(&self.service))) as Arc<dyn TopicHandler>,
        ])
        .collect()
    }

    fn health(&self) -> Vec<ProviderHealth> {
        self.brokers.healths()
    }

    fn start(&self, host: &ModuleHost) -> Vec<JoinHandle<()>> {
        let mut tasks = self.paper.start();
        tasks.push(tokio::spawn(pump_events(
            Arc::clone(&self.service),
            Arc::clone(&self.bus),
        )));
        tasks.push(tokio::spawn(watch_ticks(
            Arc::downgrade(&host.invoker),
            Arc::clone(&self.market),
        )));
        tasks.extend(self.protection.start());
        tasks.push(tokio::spawn(watch_rule_prices(
            Arc::downgrade(&self.protection),
            Arc::clone(&self.market),
        )));
        tasks.push(tokio::spawn(watch_loss_limits(
            Arc::clone(&self.service),
            Arc::clone(&self.bus),
        )));
        tasks.push(tokio::spawn(pump_notes(
            self.protection.notes(),
            Arc::clone(&self.bus),
        )));
        tasks.extend(self.service.start_copying());
        tasks.push(tokio::spawn(pump_copies(
            Arc::clone(&self.service),
            Arc::clone(&self.bus),
        )));
        tasks
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-broker")
        .tool::<ContractForInput, ContractForOutput>("orders.contract_for")
        .tool::<OrderInput, OrderPreview>("orders.preview")
        .tool::<OrderInput, SubmitOutput>("orders.submit")
        .tool::<OrderInput, SubmitOutput>("orders.create_draft")
        .tool::<ModifyOrderInput, OrderOutput>("orders.modify")
        .tool::<CancelOrderInput, OrderOutput>("orders.cancel")
        .tool::<CancelAllInput, CancelAllOutput>("orders.cancel_all")
        .tool::<AccountScopeInput, FlattenOutput>("orders.flatten")
        .tool::<AccountScopeInput, MergeOutput>("orders.merge_brackets")
        .tool::<BreakevenStopInput, BreakevenStopOutput>("orders.breakeven")
        .tool::<ReverseInput, ReverseOutput>("orders.reverse")
        .tool::<GetAccountsInput, AccountsOutput>("portfolio.get_accounts")
        .tool::<AccountFilterInput, PositionsOutput>("portfolio.get_positions")
        .tool::<GetOrdersInput, OrdersOutput>("portfolio.get_orders")
        .tool::<GetFillsInput, FillsOutput>("portfolio.get_fills")
        .tool::<RiskStatusInput, RiskStatusOutput>("portfolio.get_risk_status")
        .tool::<GetLimitsInput, LimitsOutput>("risk.get_limits")
        .tool::<GetLockInput, AccountLockOutput>("risk.get_lock")
        .tool::<LockAccountInput, LockAccountOutput>("risk.lock_account")
        .tool::<UnlockAccountInput, UnlockAccountOutput>("risk.unlock_account")
        .ty::<ActionPreview>()
        .ty::<tessera_core::limits::LimitsSetting>()
        .topic::<AccountParams, OrderUpdate>(names::ORDERS)
        .topic::<AccountParams, PositionUpdate>(names::POSITIONS)
        .topic::<AccountParams, AccountUpdate>(names::ACCOUNTS)
        .topic::<AccountParams, FillUpdate>(names::FILLS)
        .topic::<AccountParams, ProtectionNote>(names::PROTECTION)
        .tool::<CopyListInput, CopyListOutput>("copy.list")
        .tool::<CopyCreateInput, CopyGroupOutput>("copy.create")
        .tool::<CopyUpdateInput, CopyGroupOutput>("copy.update")
        .tool::<CopyGroupIdInput, CopyGroupOutput>("copy.enable")
        .tool::<CopyGroupIdInput, CopyGroupOutput>("copy.disable")
        .tool::<CopyGroupIdInput, CopyDeleteOutput>("copy.delete")
        .tool::<CopyStatusInput, CopySyncUpdate>("copy.status")
        .tool::<CopyResyncInput, CopyActionOutput>("copy.resync")
        .tool::<CopyFlattenInput, CopyActionOutput>("copy.flatten")
        .ty::<CopyPreview>()
        .topic::<NoParams, CopyGroupsUpdate>(GROUPS_TOPIC)
        .topic::<NoParams, CopyNote>(NOTES_TOPIC)
        .topic::<NoParams, CopySyncUpdate>(SYNC_TOPIC)
}

async fn pump_copies(service: Arc<OrdersService>, bus: Arc<EventBus>) {
    use tokio::sync::broadcast::error::RecvError;
    let mut groups = service.copy_book().changes();
    let mut notes = service.copy_book().notes();
    let mut sync = service.copy_sync_updates();
    loop {
        tokio::select! {
            u = sync.recv() => match u {
                Ok(u) => {
                    bus.publish(SYNC_TOPIC, TopicKey::None, &u);
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            },
            g = groups.recv() => match g {
                Ok(g) => {
                    bus.publish(GROUPS_TOPIC, TopicKey::None, &g);
                }
                Err(RecvError::Lagged(_)) => {
                    let g = CopyGroupsUpdate { groups: service.copy_book().groups() };
                    bus.publish(GROUPS_TOPIC, TopicKey::None, &g);
                }
                Err(RecvError::Closed) => return,
            },
            n = notes.recv() => match n {
                Ok(n) => {
                    bus.publish(NOTES_TOPIC, TopicKey::None, &n);
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            },
        }
    }
}

struct CopyGroupsTopic(Arc<OrdersService>);

#[async_trait]
impl TopicHandler for CopyGroupsTopic {
    fn name(&self) -> &'static str {
        GROUPS_TOPIC
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 64,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        let now = CopyGroupsUpdate {
            groups: self.0.copy_book().groups(),
        };
        Ok(Subscribed::new(KeyFilter::All).snapshot(&now))
    }
}

struct CopySyncTopic(Arc<OrdersService>);

#[async_trait]
impl TopicHandler for CopySyncTopic {
    fn name(&self) -> &'static str {
        SYNC_TOPIC
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 64,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        let now = self
            .0
            .copy_status(&CopyStatusInput::default())
            .await
            .map_err(|e| RpcError::new(codes::INTERNAL_ERROR, e.message))?;
        Ok(Subscribed::new(KeyFilter::All).snapshot(&now))
    }
}

struct CopyNotesTopic;

#[async_trait]
impl TopicHandler for CopyNotesTopic {
    fn name(&self) -> &'static str {
        NOTES_TOPIC
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 256,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        Ok(Subscribed::new(KeyFilter::All))
    }
}

async fn pump_notes(
    mut notes: tokio::sync::broadcast::Receiver<ProtectionNote>,
    bus: Arc<EventBus>,
) {
    loop {
        match notes.recv().await {
            Ok(n) => {
                let a = n.account_id.clone();
                publish_account_event(&bus, names::PROTECTION, &a, &n);
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

async fn watch_loss_limits(service: Arc<OrdersService>, bus: Arc<EventBus>) {
    let mut iv = tokio::time::interval(Duration::from_millis(500));
    iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        iv.tick().await;
        let mut changed = service.lift_ended_locks().await;
        let Ok(ids) = service.account_ids(None).await else {
            continue;
        };
        for a in ids {
            let LossWatch::Held { lock, fresh, flat } = service.watch_loss_limit(&a).await else {
                continue;
            };
            if fresh {
                changed.push(a.clone());
            }
            if let Some(flat) = flat {
                for n in service.loss_lock_held(&lock, &flat) {
                    publish_account_event(&bus, names::PROTECTION, a.as_str(), &n);
                }
            }
        }
        for a in changed {
            let Ok(summary) = service.broker().provider().summary(&a).await else {
                continue;
            };
            if let Some(update) = account_update(&service, summary).await {
                publish_account_event(&bus, names::ACCOUNTS, a.as_str(), &update);
            }
        }
    }
}

async fn pump_events(service: Arc<OrdersService>, bus: Arc<EventBus>) {
    let provider = Arc::clone(service.broker().provider());
    let mut events = provider.events();
    while let Some(e) = events.next().await {
        match e {
            BrokerEvent::Order(order) => {
                let a = order.request.account_id.to_string();
                publish_account_event(&bus, names::ORDERS, &a, &OrderUpdate { order });
            }
            BrokerEvent::Fill(fill) => {
                service.note_fill(&fill.account_id);
                let a = fill.account_id.to_string();
                publish_account_event(&bus, names::FILLS, &a, &FillUpdate { fill });
            }
            BrokerEvent::Position(position) => {
                let a = position.account_id.to_string();
                publish_account_event(&bus, names::POSITIONS, &a, &PositionUpdate { position });
            }
            BrokerEvent::Account(summary) => {
                if let Some(update) = account_update(&service, summary).await {
                    let a = update.account.id.to_string();
                    publish_account_event(&bus, names::ACCOUNTS, &a, &update);
                }
            }
            BrokerEvent::Disconnected { reason } => {
                tracing::warn!(%reason, "broker disconnected");
            }
        }
    }
}

async fn account_update(
    service: &OrdersService,
    summary: tessera_core::accounts::AccountSummary,
) -> Option<AccountUpdate> {
    let provider = service.broker().provider();
    let account = provider
        .accounts()
        .await
        .ok()?
        .into_iter()
        .find(|a| a.id == summary.account_id)?;
    let risk = provider.risk(&account.id).await.ok().flatten();
    let limits = service.standing(&account, &summary, risk.as_ref()).await;
    Some(AccountUpdate {
        account,
        summary,
        risk,
        limits,
    })
}

async fn watch_rule_prices(
    protection: Weak<ProtectionManager>,
    market: Arc<dyn MarketDataProvider>,
) {
    let mut feeds: HashMap<InstrumentId, JoinHandle<()>> = HashMap::new();
    let mut iv = tokio::time::interval(Duration::from_millis(250));
    loop {
        iv.tick().await;
        let Some(p) = protection.upgrade() else {
            return;
        };
        let watched = p.rule_instruments();
        drop(p);
        feeds.retain(|i, task| {
            let keep = watched.contains(i) && !task.is_finished();
            if !keep {
                task.abort();
            }
            keep
        });
        for i in watched {
            if feeds.contains_key(&i) {
                continue;
            }
            let found = match market.spec(&i).await {
                Ok((_, spec)) => Some((i.clone(), spec)),
                Err(_) => match market.resolve(i.as_str()).await {
                    Ok(c) => market.spec(&c).await.ok().map(|(_, spec)| (c, spec)),
                    Err(_) => None,
                },
            };
            let Some((contract, spec)) = found else {
                continue;
            };
            let Ok(mut trades) = market.subscribe_trades(std::slice::from_ref(&contract)) else {
                continue;
            };
            let protection = protection.clone();
            let key = i.clone();
            feeds.insert(
                i,
                tokio::spawn(async move {
                    while let Some(t) = trades.next().await {
                        let Some(p) = protection.upgrade() else {
                            return;
                        };
                        p.on_trade(&key, &spec, t.price);
                    }
                }),
            );
        }
    }
}

async fn watch_ticks(invoker: Weak<Invoker>, market: Arc<dyn MarketDataProvider>) {
    let mut feeds: HashMap<InstrumentId, JoinHandle<()>> = HashMap::new();
    let mut iv = tokio::time::interval(Duration::from_millis(250));
    loop {
        iv.tick().await;
        let Some(inv) = invoker.upgrade() else { return };
        let watched = inv.tick_watched_instruments();
        drop(inv);
        feeds.retain(|i, task| {
            let keep = watched.contains(i) && !task.is_finished();
            if !keep {
                task.abort();
            }
            keep
        });
        for i in watched {
            if feeds.contains_key(&i) {
                continue;
            }
            let contract = match market.spec(&i).await {
                Ok(_) => i.clone(),
                Err(_) => match market.resolve(i.as_str()).await {
                    Ok(c) => c,
                    Err(_) => continue,
                },
            };
            let Ok(mut trades) = market.subscribe_trades(std::slice::from_ref(&contract)) else {
                continue;
            };
            let inv = invoker.clone();
            let key = i.clone();
            feeds.insert(
                i,
                tokio::spawn(async move {
                    while trades.next().await.is_some() {
                        let Some(inv) = inv.upgrade() else { return };
                        inv.observe_ticks(&key, 1);
                    }
                }),
            );
        }
    }
}

struct AccountTopic {
    name: &'static str,
    service: Arc<OrdersService>,
}

#[async_trait]
impl TopicHandler for AccountTopic {
    fn name(&self) -> &'static str {
        self.name
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 2048,
            replay: 0,
        }
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: AccountParams = parse_params(params)?;
        let svc = &self.service;
        let ids: Vec<AccountId> = svc
            .account_ids(p.account_id.as_deref())
            .await
            .map_err(|e| RpcError::new(codes::INVALID_PARAMS, e.message))?;
        let provider = svc.broker().provider();
        let one = p.account_id.is_some();
        let internal = |e: BrokerError| RpcError::new(codes::INTERNAL_ERROR, e.to_string());
        let skip = |a: &AccountId, e: BrokerError| -> Result<(), RpcError> {
            if one {
                return Err(internal(e));
            }
            tracing::debug!(account = %a, error = %e, "account left out of the snapshot");
            Ok(())
        };
        let mut sub = Subscribed::new(KeyFilter::Account(p.account_id.clone()));
        match self.name {
            names::ACCOUNTS => {
                let all = svc
                    .accounts()
                    .await
                    .map_err(|e| RpcError::new(codes::INTERNAL_ERROR, e.message))?;
                for u in all.into_iter().filter(|u| ids.contains(&u.account.id)) {
                    sub = sub.snapshot(&u);
                }
            }
            names::ORDERS => {
                for a in &ids {
                    match provider.orders(a).await {
                        Ok(orders) => {
                            for order in orders.into_iter().filter(|o| o.status.is_open()) {
                                sub = sub.snapshot(&OrderUpdate { order });
                            }
                        }
                        Err(e) => skip(a, e)?,
                    }
                }
            }
            names::POSITIONS => {
                for a in &ids {
                    match provider.positions(a).await {
                        Ok(positions) => {
                            for position in positions {
                                sub = sub.snapshot(&PositionUpdate { position });
                            }
                        }
                        Err(e) => skip(a, e)?,
                    }
                }
            }
            names::FILLS => {
                let since = svc.day_start();
                for a in &ids {
                    match provider.fills(a, since).await {
                        Ok(fills) => {
                            for fill in fills {
                                sub = sub.snapshot(&FillUpdate { fill });
                            }
                        }
                        Err(e) => skip(a, e)?,
                    }
                }
            }
            _ => {}
        }
        Ok(sub)
    }
}
