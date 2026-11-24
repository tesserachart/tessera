use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use serde_json::Value;
use tessera_broker::orders::OrdersService;
use tessera_broker::{BrokerEvent, BrokerProvider};
use tessera_core::instrument::{ContractSpec, InstrumentId};
use tessera_core::{SharedClock, Timeframe, Timestamp};
use tessera_host::{
    EventBus, KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicSizing,
    TsExports,
};
use tessera_market::{BarsRequest, MarketDataProvider, MarketRouter};
use tessera_protocol::rpc::RpcError;
use tessera_protocol::tools::RiskTier;
use tessera_protocol::topics::NoParams;
use tessera_store::Store;
use tessera_store::blobs::BlobStore;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use tokio::task::JoinHandle;

use crate::activity::EventSource;
use crate::model::*;
use crate::service::{JOURNAL_CHANGES, JournalService, MarketSource};

struct RouterSource(Arc<MarketRouter>);

#[async_trait]
impl MarketSource for RouterSource {
    async fn spec(&self, instrument: &InstrumentId) -> Option<ContractSpec> {
        let fut = self.0.spec(instrument);
        match tokio::time::timeout(Duration::from_secs(5), fut).await {
            Ok(Ok((_, spec))) => Some(spec),
            _ => None,
        }
    }

    async fn bars(
        &self,
        instrument: &InstrumentId,
        from: Timestamp,
        to: Timestamp,
    ) -> Option<Vec<(Timestamp, f64, f64)>> {
        let req = BarsRequest {
            instrument: instrument.clone(),
            tf: Timeframe::M1,
            from: Some(from),
            to: Some(to),
            limit: Some(5000),
            rth_only: false,
        };
        let series = tokio::time::timeout(Duration::from_secs(10), self.0.get_bars(req))
            .await
            .ok()?
            .ok()?;
        use rust_decimal::prelude::ToPrimitive;
        Some(
            series
                .bars
                .iter()
                .filter(|b| b.t <= to)
                .map(|b| {
                    (
                        b.t,
                        b.h.0.to_f64().unwrap_or(0.0),
                        b.l.0.to_f64().unwrap_or(0.0),
                    )
                })
                .collect(),
        )
    }
}

pub struct JournalModule {
    service: Arc<JournalService>,
    orders: Option<Arc<OrdersService>>,
    clock: Option<SharedClock>,
}

impl std::fmt::Debug for JournalModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JournalModule")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl JournalModule {
    pub fn open(
        store: Store,
        data_dir: Option<&Path>,
        bus: Arc<EventBus>,
        market: Option<Arc<MarketRouter>>,
        orders: Option<Arc<OrdersService>>,
        clock: Option<SharedClock>,
    ) -> tessera_store::Result<Self> {
        let blob_dir = match data_dir {
            Some(d) => tessera_store::DataDir::new(d).blobs(),
            None => std::env::temp_dir().join(format!("tessera-journal-{}", std::process::id())),
        };
        let blobs = BlobStore::open(&blob_dir, store.clone())
            .inspect_err(|e| {
                tracing::warn!(dir = %blob_dir.display(), error = %e, "journal: attachments are off; their folder could not be opened");
            })
            .ok();
        let market = market.map(|m| Arc::new(RouterSource(m)) as Arc<dyn MarketSource>);
        let service = JournalService::open(store, blobs, Some(bus), market)?;
        Ok(Self {
            service: Arc::new(service),
            orders,
            clock,
        })
    }

    pub fn with_service(service: Arc<JournalService>, orders: Option<Arc<OrdersService>>) -> Self {
        Self {
            service,
            orders,
            clock: None,
        }
    }

    pub fn service(&self) -> &Arc<JournalService> {
        &self.service
    }
}

impl RuntimeModule for JournalModule {
    fn name(&self) -> &'static str {
        "journal"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        let s = || Arc::clone(&self.service);
        let clock = self.clock.clone();
        r.register(ListTrades(s()))?;
        r.register(GetTrade(s()))?;
        r.register(GetActivity(s()))?;
        r.register(GetStats(s()))?;
        r.register(GetCalendar(s(), clock))?;
        r.register(GetDay(s()))?;
        r.register(GetCatalog(s()))?;
        r.register(GetCompliance(s()))?;
        r.register(RecentDays(s()))?;
        r.register(ListTrash(s()))?;
        r.register(Search(s()))?;
        r.register(ExportTrades(s()))?;
        r.register(PreviewImport(s()))?;
        r.register(GetAttachment(s()))?;
        r.register(UpdateTrade(s()))?;
        r.register(BulkUpdate(s()))?;
        r.register(SaveTag(s()))?;
        r.register(DeleteTag(s()))?;
        r.register(SaveSetup(s()))?;
        r.register(DeleteSetup(s()))?;
        r.register(SaveDay(s()))?;
        r.register(SaveChecklist(s()))?;
        r.register(ImportCsv(s()))?;
        r.register(DeleteImport(s()))?;
        r.register(LogTrade(s()))?;
        r.register(DeleteTrade(s()))?;
        r.register(BulkDelete(s()))?;
        r.register(RestoreTrade(s()))?;
        r.register(PurgeTrash(s()))?;
        r.register(SaveTradeDrawings(s()))?;
        r.register(AddAttachment(s()))?;
        r.register(DeleteAttachment(s()))?;
        r.register(SaveFilter(s()))?;
        r.register(DeleteFilter(s()))?;
        r.register(SetSettings(s()))?;
        Ok(())
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(ChangesTopic(Arc::clone(&self.service)))]
    }

    fn start(&self, _host: &ModuleHost) -> Vec<JoinHandle<()>> {
        let Some(orders) = self.orders.clone() else {
            return Vec::new();
        };
        vec![tokio::spawn(follow(
            Arc::clone(&self.service),
            orders,
            self.clock.clone(),
        ))]
    }
}

async fn follow(
    service: Arc<JournalService>,
    orders: Arc<OrdersService>,
    clock: Option<SharedClock>,
) {
    let provider: Arc<dyn BrokerProvider> = Arc::clone(orders.broker().provider());
    let mut events = provider.events();
    let mut backfilled: HashSet<String> = HashSet::new();
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    let mut flush = tokio::time::interval(Duration::from_secs(1));
    let mut touched: BTreeSet<String> = BTreeSet::new();
    let mut dirty = false;
    let now = move || clock.as_ref().map_or_else(Timestamp::now, |c| c.now());
    let order_of = {
        let p = Arc::clone(&provider);
        move |id: &tessera_core::ids::OrderId| p.order_of(id)
    };
    loop {
        tokio::select! {
            e = events.next() => match e {
                Some(BrokerEvent::Fill(fill)) => {
                    match service.ingest(vec![fill], &order_of).await {
                        Ok(n) if n > 0 => {
                            for id in service.unmeasured(4) {
                                service.measure_excursion(&id, false).await;
                            }
                        }
                        Ok(_) => {}
                        Err(e) => tracing::warn!(error = %e.message, "journal: a fill was not kept"),
                    }
                }
                Some(BrokerEvent::Order(order)) => {
                    match service.record_orders(vec![order], now(), EventSource::Live) {
                        Ok(ids) if !ids.is_empty() => {
                            dirty = true;
                            touched.extend(ids);
                        }
                        Ok(_) => {}
                        Err(e) => tracing::warn!(error = %e.message, "journal: an order change was not kept"),
                    }
                }
                Some(_) => {}
                None => break,
            },
            _ = flush.tick() => {
                if dirty {
                    service.announce_activity(std::mem::take(&mut touched).into_iter().collect());
                    dirty = false;
                }
            }
            _ = tick.tick() => {
                sync(&service, provider.as_ref(), &order_of, &mut backfilled, now()).await;
                for id in service.unmeasured(20) {
                    service.measure_excursion(&id, false).await;
                }
            }
        }
    }
}

async fn sync(
    service: &JournalService,
    provider: &dyn BrokerProvider,
    order_of: &(
         dyn Fn(&tessera_core::ids::OrderId) -> Option<tessera_core::orders::Order> + Send + Sync
     ),
    backfilled: &mut HashSet<String>,
    now: Timestamp,
) {
    let Ok(accounts) = provider.accounts().await else {
        return;
    };
    let recent = Timestamp(Timestamp::now().0 - 2 * 86_400 * 1_000_000_000);
    for a in accounts {
        let id = a.id.to_string();
        service.name_account(&id, &a.display_name);
        let since = if backfilled.contains(&id) {
            recent
        } else {
            Timestamp(0)
        };
        match provider.fills(&a.id, since).await {
            Ok(fills) => {
                backfilled.insert(id.clone());
                if let Err(e) = service.ingest(fills, order_of).await {
                    tracing::warn!(error = %e.message, "journal: fills not kept");
                }
            }
            Err(e) => tracing::debug!(account = %a.id, error = %e, "journal: no fills yet"),
        }
        match provider.orders(&a.id).await {
            Ok(orders) => {
                match service.record_orders(orders, now, EventSource::Resync) {
                    Ok(ids) if !ids.is_empty() => service.announce_activity(ids),
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e.message, "journal: orders not kept"),
                }
                service.mark_live(&id, now);
            }
            Err(e) => tracing::debug!(account = %a.id, error = %e, "journal: no orders yet"),
        }
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-journal")
        .tool::<ListTradesInput, ListTradesOutput>("journal.list_trades")
        .tool::<GetTradeInput, TradeDetail>("journal.get_trade")
        .tool::<GetActivityInput, ActivityOutput>("journal.get_activity")
        .tool::<GetStatsInput, JournalStats>("journal.get_stats")
        .tool::<GetCalendarInput, CalendarOutput>("journal.get_calendar")
        .tool::<GetDayInput, DayEntry>("journal.get_day")
        .tool::<Empty, JournalCatalog>("journal.get_catalog")
        .tool::<GetComplianceInput, ComplianceOutput>("journal.get_compliance")
        .tool::<RecentDaysInput, RecentDaysOutput>("journal.recent_days")
        .tool::<Empty, TrashOutput>("journal.list_trash")
        .tool::<SearchInput, SearchOutput>("journal.search")
        .tool::<ExportInput, ExportOutput>("journal.export_trades")
        .tool::<ImportInput, ImportResult>("journal.preview_import")
        .tool::<IdInput, AttachmentData>("journal.get_attachment")
        .tool::<UpdateTradeInput, JournalTrade>("journal.update_trade")
        .tool::<BulkUpdateInput, Changed>("journal.bulk_update")
        .tool::<SaveTagInput, Tag>("journal.save_tag")
        .tool::<IdInput, Changed>("journal.delete_tag")
        .tool::<SaveSetupInput, Setup>("journal.save_setup")
        .tool::<IdInput, Changed>("journal.delete_setup")
        .tool::<SaveDayInput, DayEntry>("journal.save_day")
        .tool::<SaveChecklistInput, ChecklistOutput>("journal.save_checklist")
        .tool::<ImportInput, ImportResult>("journal.import_csv")
        .tool::<IdInput, Changed>("journal.delete_import")
        .tool::<LogTradeInput, JournalTrade>("journal.log_trade")
        .tool::<IdInput, Changed>("journal.delete_trade")
        .tool::<BulkDeleteInput, BulkDeleteOutput>("journal.bulk_delete")
        .tool::<IdInput, Changed>("journal.restore_trade")
        .tool::<PurgeTrashInput, Changed>("journal.purge_trash")
        .tool::<SaveTradeDrawingsInput, Changed>("journal.save_trade_drawings")
        .tool::<AddAttachmentInput, AttachmentInfo>("journal.add_attachment")
        .tool::<IdInput, Changed>("journal.delete_attachment")
        .tool::<SaveFilterInput, SavedFilter>("journal.save_filter")
        .tool::<IdInput, Changed>("journal.delete_filter")
        .tool::<SetSettingsInput, JournalSettings>("journal.set_settings")
        .topic::<NoParams, JournalChange>(JOURNAL_CHANGES)
}

struct ChangesTopic(Arc<JournalService>);

#[async_trait]
impl TopicHandler for ChangesTopic {
    fn name(&self) -> &'static str {
        JOURNAL_CHANGES
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::SNAPSHOT
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        Ok(Subscribed::new(KeyFilter::All).snapshot(&JournalChange {
            revision: self.0.revision(),
            reason: "snapshot".into(),
            trade_ids: Vec::new(),
        }))
    }
}

macro_rules! tool {
    ($ty:ident, $name:literal, $title:literal, $risk:expr, $in:ty, $out:ty, $desc:literal,
     |$svc:ident, $input:ident| $body:expr) => {
        struct $ty(Arc<JournalService>);

        #[async_trait]
        impl Tool for $ty {
            type Input = $in;
            type Output = $out;

            fn meta(&self) -> ToolMeta {
                ToolMeta::new($name, $title, $risk)
                    .description($desc)
                    .category("journal")
            }

            async fn call(&self, _ctx: &ToolCtx, $input: $in) -> Result<$out, ToolError> {
                let $svc = &self.0;
                $body
            }
        }
    };
}

tool!(
    ListTrades,
    "journal.list_trades",
    "Journal trades",
    RiskTier::Read,
    ListTradesInput,
    ListTradesOutput,
    "The trader's journal of trades: round trips built from every account's fills (Tessera Paper, Rithmic, imported exports, trades logged by hand), FIFO from flat to flat, with net P&L from the contract spec, R from the planned stop, MAE/MFE from bars, setup, tags, rating, mood, review state. Filter by account, symbol, side, dates (trade dates: the CME session date for futures), outcome (net within ± the breakeven band is breakeven), setup, tag, weekday, entry hour, session, P&L, R, rating, review, mood, words in notes. `summary` measures every trade the filter keeps. Ask for small pages (limit 50) and use journal.get_stats for aggregates.",
    |s, input| Ok(s.list(&input))
);

tool!(
    GetTrade,
    "journal.get_trade",
    "Journal trade",
    RiskTier::Read,
    GetTradeInput,
    TradeDetail,
    "One journal trade with its executions (entry, adds, partial exits, exit; each fill's price, size, fees, realized P&L and the order role that filled it), the trader's notes (Markdown), files, its setup's rules and whether each was followed, and the previous and next trade under a filter. MAE/MFE are measured from 1-minute bars the first time (missing when no connection has bars for its time). `activity` (null when none of its orders is known) is its recorded order activity: `stopPath` and `targetPath` (step lines: the tightest working stop and nearest target from the entry on, null while none worked), each stop move (`moves`: tightened = toward the market, widened = away), every change of its orders with who made it (`rows`: actor trader, analyst after the trader's approval, client, broker by itself (bracket, trailing or breakeven rule, liquidation), market (fills), outside (no Tessera call matches: another platform)), and `summary`: initial stop, initial risk in money and ticks, R on that risk, moves, tightened, widened, trail steps (tightenings after the first), seconds to the first move, when the stop reached the entry, seconds without a working stop, the worst stop (farthest from the entry against the position), how it ended, and `coverage` (complete: every change seen live; partial: some reconstructed from stored orders and the audit, or found on a resync). Measured facts, not judgements.",
    |s, input| s.trade(&input).await
);

tool!(
    GetActivity,
    "journal.get_activity",
    "Journal order activity",
    RiskTier::Read,
    GetActivityInput,
    ActivityOutput,
    "The trader's order activity as the journal recorded it: every order placed, each stop or limit moved, quantity changed, bracket leg activated, stop triggered, fill, cancel, reject or expiry, oldest first, each with the price before and after, the order's role and side, the trade it belonged to and what it was to it (entry, stop, target, exit), and who made it (trader, analyst after approval, client, broker by itself, market, or outside Tessera). Filter by trade, account, symbol or instrument, and trade dates; `limit` keeps the newest (default 500). `accounts` says since when each account is recorded as it changes (complete from then) and when its earlier orders were reconstructed.",
    |s, input| s.activity(&input)
);

tool!(
    GetStats,
    "journal.get_stats",
    "Journal statistics",
    RiskTier::Read,
    GetStatsInput,
    JournalStats,
    "Measured statistics of the closed trades a filter keeps (TheTraderLog's analytics): net P&L, win rate with its Wilson 95% interval (breakevens left out), profit factor, average win and loss, payoff, expectancy, largest win and loss, per-trade Sharpe and Sortino, R (average, winners, losers), the equity curve and its drawdowns (depth, % of peak, recovery factor, Calmar (net annualized over the calendar span by 365, over the deepest drawdown, both in money), ulcer index, time in drawdown), streaks, Kelly fraction from these trades, time held; breakdowns by day, week, month, weekday, entry hour, session, symbol, side, setup, tag, account, time held, size, R range, planned R:R, trades per day, mood and how trades ended, and net per symbol and month (`bySymbolMonth`); what follows a winner or a loser; and `behaviour`, from the recorded order activity: trades whose stop was widened vs never, how the stop was managed (never moved, tightened once, twice or more, widened), trades whose stop reached the entry and what happened after, time open without a stop, how trades ended (stop, target, by hand, liquidation), time to the first stop move, mean initial risk, and `recordedSince` (activity is complete from then). Every bucket carries its n and the mean R on initial risk (`avgRInitial`): small samples are noise. These are measurements of past trades, not predictions. `compact` leaves out the curve and the per-day list.",
    |s, input| Ok(s.stats(&input))
);

struct GetCalendar(Arc<JournalService>, Option<SharedClock>);

#[async_trait]
impl Tool for GetCalendar {
    type Input = GetCalendarInput;
    type Output = CalendarOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("journal.get_calendar", "Journal calendar", RiskTier::Read)
            .description("The P&L calendar: each trade date in a range (default this month) with its closed trades measured (net, n, wins, losses, win rate), whether the day has a journal entry and how many trades are not yet reviewed; the range's total; and how many trading days in a row were journaled.")
            .category("journal")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: GetCalendarInput,
    ) -> Result<CalendarOutput, ToolError> {
        let now = self.1.as_ref().map_or(ctx.now, |c| c.now());
        Ok(self.0.calendar(&input, self.0.today(now)))
    }
}

tool!(
    GetDay,
    "journal.get_day",
    "Journal day",
    RiskTier::Read,
    GetDayInput,
    DayEntry,
    "One day of the journal: the trader's entry for it (Markdown), the daily checklist as ticked, the day's trades (by trade date) and their statistics, files, and the previous and next day with trades or an entry.",
    |s, input| s.day(input.date)
);

tool!(
    GetCatalog,
    "journal.get_catalog",
    "Journal catalog",
    RiskTier::Read,
    Empty,
    JournalCatalog,
    "What the journal holds and its screens pick from: accounts with their trade counts, symbols, tags (with groups such as Mistake, how many trades carry each and their closed net), setups (playbooks: description, entry criteria, exit rules, rules, measured stats and how often each rule was followed), saved filters (and which is the default), the daily checklist, settings (breakeven band, sessions with their time zones), imports done, the platforms it imports from, and how many trades are in the Trash.",
    |s, _input| s.catalog()
);

tool!(
    Search,
    "journal.search",
    "Search the journal",
    RiskTier::Read,
    SearchInput,
    SearchOutput,
    "Finds words in trade notes and day entries, newest first, with the words around each match.",
    |s, input| s.search(&input)
);

tool!(
    ExportTrades,
    "journal.export_trades",
    "Export journal trades",
    RiskTier::Read,
    ExportInput,
    ExportOutput,
    "The trades a filter keeps as CSV (account, symbol, contract, direction, quantity, entry and exit times and prices, gross, fees, net, R, minutes held, setup, tags, rating, reviewed, mood, notes).",
    |s, input| Ok(s.export(&input))
);

tool!(
    PreviewImport,
    "journal.preview_import",
    "Preview an import",
    RiskTier::Read,
    ImportInput,
    ImportResult,
    "Reads a broker or platform export without keeping anything: the platform (detected from its columns: ProjectX, TopstepX, NinjaTrader executions, Tradovate orders or position history, R | Trader completed orders; Apex through whichever its file is), the fills it holds, how many the journal already has, the trades they make with P&L from the contract spec beside the platform's own, rows that could not be read and why.",
    |s, input| s.import(&input, false)
);

tool!(
    GetAttachment,
    "journal.get_attachment",
    "Journal file",
    RiskTier::Read,
    IdInput,
    AttachmentData,
    "A screenshot or file attached to a trade or a day, base64.",
    |s, input| s.attachment(&input.id)
);

tool!(
    UpdateTrade,
    "journal.update_trade",
    "Edit a journal trade",
    RiskTier::Modify,
    UpdateTradeInput,
    JournalTrade,
    "Changes what the trader adds to a trade: notes (Markdown), setup, rating 1–5, reviewed, mood, exit reason, the planned stop and target (R and planned R:R follow), tags (replaced), and which of its setup's rules were followed. Absent fields stay; null clears. Fills, prices and P&L are the connection's record and do not change.",
    |s, input| s.update(&input)
);

tool!(
    BulkUpdate,
    "journal.bulk_update",
    "Edit journal trades",
    RiskTier::Modify,
    BulkUpdateInput,
    Changed,
    "Marks many trades reviewed or not, rates them (0 clears), sets their setup (empty clears), adds or removes tags.",
    |s, input| s.bulk(&input)
);

tool!(
    SaveTag,
    "journal.save_tag",
    "Save a journal tag",
    RiskTier::Modify,
    SaveTagInput,
    Tag,
    "Creates a tag, or renames, recolours or regroups one (`id`). Names are unique within a group; a group such as Mistake gathers tags of one kind.",
    |s, input| s.save_tag(&input)
);

tool!(
    DeleteTag,
    "journal.delete_tag",
    "Delete a journal tag",
    RiskTier::Modify,
    IdInput,
    Changed,
    "Deletes a tag and takes it off every trade.",
    |s, input| s.delete_tag(&input.id)
);

tool!(
    SaveSetup,
    "journal.save_setup",
    "Save a setup",
    RiskTier::Modify,
    SaveSetupInput,
    Setup,
    "Creates a setup (a playbook: name, description, entry criteria, exit rules, a checklist of rules by category entry/exit/risk/management) or changes one (`id`; absent fields stay; rules given replace the rules, a rule kept by id keeps its ticks).",
    |s, input| s.save_setup(&input)
);

tool!(
    DeleteSetup,
    "journal.delete_setup",
    "Delete a setup",
    RiskTier::Modify,
    IdInput,
    Changed,
    "Deletes a setup; its trades keep everything else.",
    |s, input| s.delete_setup(&input.id)
);

tool!(
    SaveDay,
    "journal.save_day",
    "Write a journal day",
    RiskTier::Modify,
    SaveDayInput,
    DayEntry,
    "Writes a day's journal entry (Markdown, replaces it), starts the day's journal, or ticks checklist items (`checks`: ruleId is the checklist item's id).",
    |s, input| s.save_day(&input)
);

tool!(
    SaveChecklist,
    "journal.save_checklist",
    "Save the daily checklist",
    RiskTier::Modify,
    SaveChecklistInput,
    ChecklistOutput,
    "Replaces the daily checklist with these items, in order (items kept by id keep their ticks).",
    |s, input| s.save_checklist(&input)
);

tool!(
    ImportCsv,
    "journal.import_csv",
    "Import trades",
    RiskTier::Modify,
    ImportInput,
    ImportResult,
    "Imports a broker or platform export (see journal.preview_import) into an account of its own (an imported account by id, or a new one by name). Fills already in the journal are skipped, so importing a file twice adds nothing.",
    |s, input| s.import(&input, true)
);

tool!(
    DeleteImport,
    "journal.delete_import",
    "Undo an import",
    RiskTier::Modify,
    IdInput,
    Changed,
    "Removes an import's fills and the trades they made.",
    |s, input| s.delete_import(&input.id)
);

tool!(
    LogTrade,
    "journal.log_trade",
    "Log a trade",
    RiskTier::Modify,
    LogTradeInput,
    JournalTrade,
    "Logs a trade by hand into an account of its own (a journal account by id or name; a new one is made): contract, side, quantity, entry price and time, and its exit when closed, fees, planned stop and target, setup, notes. Nothing is sent to any broker.",
    |s, input| s.log_trade(&input).await
);

tool!(
    DeleteTrade,
    "journal.delete_trade",
    "Delete a logged trade",
    RiskTier::Modify,
    IdInput,
    Changed,
    "Moves a trade logged by hand or imported to the Trash: it leaves the lists, statistics and calendar until journal.restore_trade brings it back, and journal.purge_trash deletes it for good. A connection's trades are its record and cannot be deleted.",
    |s, input| s.delete_trade(&input.id)
);

tool!(
    BulkDelete,
    "journal.bulk_delete",
    "Delete journal trades",
    RiskTier::Modify,
    BulkDeleteInput,
    BulkDeleteOutput,
    "Moves many trades logged by hand or imported to the Trash (see journal.delete_trade). A connection's trades are its record: they stay and are counted in `skipped`.",
    |s, input| s.bulk_delete(&input)
);

tool!(
    ListTrash,
    "journal.list_trash",
    "Journal Trash",
    RiskTier::Read,
    Empty,
    TrashOutput,
    "The trades in the journal's Trash, latest deleted first: each as it was (built again from its fills, with its id, notes, setup and tags) and when it was deleted.",
    |s, _input| Ok(s.list_trash())
);

tool!(
    RestoreTrade,
    "journal.restore_trade",
    "Restore a journal trade",
    RiskTier::Modify,
    IdInput,
    Changed,
    "Brings a trade back from the Trash with its fills and everything the trader added to it; it keeps its id.",
    |s, input| s.restore_trade(&input.id)
);

tool!(
    PurgeTrash,
    "journal.purge_trash",
    "Empty the Trash",
    RiskTier::Modify,
    PurgeTrashInput,
    Changed,
    "Deletes trades in the Trash for good (these `ids`, or every one when absent): their fills and their notes, setup, tags, rule ticks, drawings and file records. It cannot be undone.",
    |s, input| s.purge_trash(&input)
);

tool!(
    SaveTradeDrawings,
    "journal.save_trade_drawings",
    "Save a trade's drawings",
    RiskTier::Modify,
    SaveTradeDrawingsInput,
    Changed,
    "Keeps what was drawn on a trade's chart: the chart's own JSON array, as given (replaces it; empty removes it; 1 MB at most). journal.get_trade returns it as `drawings`.",
    |s, input| s.save_drawings(&input)
);

tool!(
    GetCompliance,
    "journal.get_compliance",
    "Setup rule compliance",
    RiskTier::Read,
    GetComplianceInput,
    ComplianceOutput,
    "How often setup rules were followed over the closed trades a filter keeps whose setup has rules (TheTraderLog's rule compliance): every rule of a trade's setup counts once per trade and a rule not ticked counts as not followed. `overall` and each category (entry, exit, risk, management; null when no rule of it applied) are fractions 0–1 of the rules checked; `missed` is the ten rules missed most, with their setup and on how many trades. Measured from the trader's own ticks, not judged.",
    |s, input| Ok(s.compliance(&input))
);

tool!(
    RecentDays,
    "journal.recent_days",
    "Recent journal days",
    RiskTier::Read,
    RecentDaysInput,
    RecentDaysOutput,
    "The latest days with a written journal entry (`limit`, 1 to 100), newest first: the entry (Markdown), that day's closed net (null without closed trades) and its trades, on `accounts` (every account when absent).",
    |s, input| s.recent_days(&input)
);

tool!(
    AddAttachment,
    "journal.add_attachment",
    "Attach a file",
    RiskTier::Modify,
    AddAttachmentInput,
    AttachmentInfo,
    "Attaches a screenshot (image) or PDF, base64, 10 MB at most, to a trade or a day.",
    |s, input| s.add_attachment(&input)
);

tool!(
    DeleteAttachment,
    "journal.delete_attachment",
    "Remove a file",
    RiskTier::Modify,
    IdInput,
    Changed,
    "Removes a file from its trade or day.",
    |s, input| s.delete_attachment(&input.id)
);

tool!(
    SaveFilter,
    "journal.save_filter",
    "Save a journal filter",
    RiskTier::Modify,
    SaveFilterInput,
    SavedFilter,
    "Saves a filter under a name (or replaces one by id) for the trades list and reports. `isDefault` makes it the one the trades list opens with (the others stop being it); absent keeps what it was.",
    |s, input| s.save_filter(&input)
);

tool!(
    DeleteFilter,
    "journal.delete_filter",
    "Delete a saved filter",
    RiskTier::Modify,
    IdInput,
    Changed,
    "Deletes a saved filter.",
    |s, input| s.delete_filter(&input.id)
);

tool!(
    SetSettings,
    "journal.set_settings",
    "Journal settings",
    RiskTier::Modify,
    SetSettingsInput,
    JournalSettings,
    "Sets the breakeven band (net within ± this is breakeven) and the sessions (name, HH:MM start and end in the session's own IANA time zone, e.g. London 08:00–14:30 Europe/London; a session past midnight wraps; a trade is in every session its entry falls in). Clock times, entry hours and today are read in the user's time zone (display.timeZone, Settings › App), not here.",
    |s, input| s.set_settings(&input)
);
