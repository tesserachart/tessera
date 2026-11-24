use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::{CallId, SessionId};
use tessera_core::{Origin, SharedClock, Timestamp};
use tessera_host::{EventBus, TopicKey};
use tessera_mcp::{McpHook, McpPrincipals};
use tessera_protocol::agent::{
    AgentEvent, AgentEventEnvelope, AgentInstallOutput, AgentProviderInfo, AgentProvidersOutput,
    AgentSendOutput, AgentSessionStatus, AgentSessionSummary, AgentSessionsEvent,
    AgentSignInOutput, AgentSignInPage, AgentStartSessionInput, AgentState, Attachment,
    AttachmentKind, Delivered, Delivery, QueuedMessage, TurnEnd,
};
use tessera_protocol::cards::Card;
use tessera_protocol::tools::{ApprovalKind, RiskTier, SessionMode, ToolOutcome, ToolResult};
use tessera_protocol::topics::names;
use tessera_store::Store;
use tessera_tools::{Invoker, ToolError};
use tokio::sync::mpsc;

use crate::attachments::{AttachmentStore, Resolved, prompt_text};
use crate::models::takes_effort;
use crate::provider::{
    AgentProvider, OpenThread, ProviderEvent, ProviderState, ProviderThread, SteerOutcome,
    TurnAttachment, TurnContent, TurnInput,
};
use crate::report::{TurnReport, TurnSink, TurnUsage};
use crate::session::{ContextPolicy, Preset, SessionConfig};
use crate::transcript::Transcript;
use crate::{BuildProvider, ProviderSettings};

pub const CODEX: &str = "codex";

pub const INSTRUCTIONS: &str = "You are the analyst in Tessera, a trading workspace. Your only tools are \
Tessera's (the `tessera` MCP server), and they reach everything the user can do in the app: read the chart \
(chart_get_state), the market, levels and the portfolio before you answer, and when asked to change something, do \
it with the tools, never explain how. Your session's mode is the user's alone (agent_list_sessions shows it). In \
supervised and auto_modify every order, modify, cancel or flatten you make is a draft the user approves in Tessera; \
say so, and never retry one that is waiting. In full_access they run at once, with no approval, on any account whose \
order entry the user turned on, live accounts included, held to the trader's risk limits: say plainly each order you \
placed, changed or closed. In read_only you change nothing. Each result says which happened (pending_approval or \
ok). Market data comes from the connection the user \
chose; execution is the account's: an order's contract is named by the executing account's own connection: give the \
chart's contract (any connection's id) or a root (NQ is the front month) and the order trades that connection's \
contract of the same exchange, root and month; for a family sibling (MNQ on an NQ chart) ask orders_contract_for \
with the root, which says the contract that account trades or why it has none. Never write a contract id yourself. \
orders_cancel_all with keepProtection is the Trade panel's Cancel (the position's stop and target stay). \
A position's stop and target follow the user's position bracket (trade.positionBracket): with per_entry (the default) \
every entry keeps its own pair; with grow one \
stop and one target cover the whole position, an add goes without its own (weighed at the position's stop) and \
Tessera grows them when it fills, shrinks them on an exit and cancels them when flat (journal_get_activity names \
Tessera). orders_merge_brackets merges a position's several pairs into \
one bracket (the Trade panel's Merge into one), like any order. orders_breakeven moves a position's stop \
to its average entry plus offsetTicks (the Trade panel's Breakeven; every pair's stop with per_entry), only once \
price has passed it; a position without a stop gets one there, reduce-only for the whole position. \
orders_reverse turns a position around \
at market, long 2 to short 2 (the Trade panel's Reverse): it cancels what works on the contract, closes the position, \
then enters the other side for the size closed with the bracket you give, priced for the new side as for \
orders_submit (the panel's own; left out, none); the new side is weighed like any entry and a refusal sends nothing, \
while a refusal after the close leaves the position flat and says so. The Trade copier (copy_list) mirrors a \
leader account's orders on its followers, each holding the leader's position at its own size (a multiplier or a fixed \
size, the micro contract for a follower that trades micros) and under its own limits; a paused follower gets nothing: an \
order you place on a leader whose group is on is copied too, its approval says `and N accounts by copy` and covers those \
accounts, and its result's copies say what each follower did (one refused is skipped, the others go). You may read the \
groups and whether each follower holds its size (copy_status: in_sync, settling, out_of_sync, unknown, with why), \
flatten a group's accounts (copy_flatten, an exit like orders_flatten) and turn one off (copy_disable); creating, \
changing, pausing, turning on, resyncing (copy_resync) and deleting one are the user's alone. Order hotkeys (settings trade.orderHotkeys, \
off by default) send the Trade panel's orders from the focused chart or DOM with a key: you may read them, turn them \
off, or change their keys while they are off; only the user turns them on. The Trade panel (trade_get_panel) sets what the user's own clicks send: trade_set_panel (account, size, sizing by \
risk, the bracket with breakeven and trailing) always asks the user first: say what you prepared. Present research \
as measured statistics, hypotheses or interpretation, and never as guaranteed outcomes. Charts: symbol, interval, \
type (none hides the price on that chart alone), link (all: true links every chart), indicators (add/update/remove_layer; style.labels puts a line's value \
on the price scale and its name at its end), indicator presets and the default a new one starts from \
(chart_*_indicator_preset, chart_set_indicator_default), templates (and the built-in Order flow), drawings \
(add/update/remove_drawing, undo/redo_drawing), your marks (annotate) and the view \
(chart_set_viewport: a time span, the last bars, a price range, autoScale; its shown says what the chart shows, \
and short why less than asked); pass the workspace on screen \
(ui.workspace) as layoutId when it is set. Name a line or shape with its own label, never a separate note beside it: \
a session high is a horizontal_line with label {text: \"Asia high\", showPrice: true}; label also sets colour, \
size, bold, italic, align (left, center, right) and position (above, on, below), and a Fibonacci drawing's \
showLevels and showPrice. Drawing templates are a kind's saved look (chart_list_drawing_templates, \
save_drawing_template, apply_drawing_template; set_default_drawing_template is what new drawings take). The desk: workspace_open_tile, close_tile, focus_tile, move_tile, \
maximize_tile (any panel fills the desk), set_view (the edges, focus mode, share interval), apply_preset, set_tile_settings (DOM, time & sales, Positions) and list_tiles; workspace_create \
and workspace_duplicate, layout_save {name} renames, layout_delete deletes, ui_show_workspace shows one. Areas: \
ui_show_area (desk, markets, agents: the Analyst page, indicators: the Indicators page, research, journal, copy: the Trade copier page's copy groups, settings: the Settings area with every \
preference; open it when the user asks to see or change their settings themselves; profile: their Tessera account, \
in a build with accounts) with item (an instrument, a \
Settings page or row, a session, an indicator, a study), markets ({list, watchlist, connection, query, moving, \
instrument}) or journal ({section, tradeId, date, reportTab, groupBy, filter…}); the ui.view setting says what each \
area shows now. Markets: market_list_instruments (every instrument each connection serves, labelled by connection) \
and the user's watchlists (watchlists_list, create, rename, delete, \
add, remove, move). Every preference is a setting (settings_get lists each with its description, \
value and schema; settings_set changes one). The whole app's look is appearance.theme, one theme for the app and its \
charts: {\"preset\":\"solarized-light\"} makes everything Solarized Light in one call (built-ins tessera, \
tessera-light, solarized-dark, solarized-light, night-owl, nord, gruvbox-dark, gruvbox-light; {\"mode\":\"light\"} moves to a \
built-in's light version; appearance.scheme {\"appearance\":\"system\"} follows the computer's light or dark mode and keeps \
a theme for each), {\"surfaces\":{\"ground\":\"#101418\"}} changes one app colour (groups surfaces, ink, \
lines, accents, semantics, card, categorical, then the chart's), appearance_get_theme reads it all, and \
appearance_save_theme {\"name\":\"Night Desk\"} saves it as a named theme that later changes save into \
(rename_theme, delete_theme; {\"saved\":\"Night Desk\"} shows one). Chart colours and text sizes are its chart part, \
appearance.chartTheme: send only what \
changes, e.g. {\"palette\":{\"background\":\"#101418\"}} (palette.up, .down, .mist… recolour everything derived \
from them) or {\"candles\":{\"upWick\":\"#ffffff\"}}; groups palette, canvas, axis, crosshair, lastPrice, \
candles, volume, levels, orders, profile, footprint, delta, bigTrades, drawings, fonts; \
{\"preset\":\"classic\"} (a chart look over the theme: tessera, classic, terminal, graphite) or {\"reset\":true}; \
appearance_get_chart_theme reads every chart colour as drawn. Also: appearance.upDownColors, appearance.density, chart.levels (each level's colour, \
line, label, visibility), chart.drawingTools, ui.preferences (toolbar intervals, default chart type, recent \
symbols). The journal (journal_*), research studies (research_*) and custom \
indicators (indicators_*) are yours to read and change. Custom indicators are JavaScript (export const indicator = \
{…}; export function compute(bars, inputs), with the ta, session and draw globals): preview before you save. \
Levels, zones and names that should move with new sessions are a custom indicator's lines, labels and boxes \
(draw.line with label, session.list(bars, hours, zone) with hours read in UTC unless an IANA zone follows; \
the guide's session-levels example), each named on its line, never fixed notes. Vendor \
levels come from the user's providers (intel_list_sources: each one's plan, requests today and history; backfill \
only when asked); to add one, draft its spec from what the user gives (its docs, a description, a sample answer), \
dry-run it with intel_test_source, show what it read under the vendor's own names, then leave it with \
intel_draft_source for them to try with their key and save in Settings › Connections: a key never goes through you. \
Alerts (alerts_create, list, update, pause, delete, history) are watched by Tessera on the live feed with the app \
closed too; a firing plays a sound, shows a toast and a desktop notification and, \
if the user chose it, posts to their Discord (a phone push). Turn the user's words into steps on the right identity: \
a vendor or computed level by its key (intel_get_levels, concepts_get_levels), a session high or low by the custom \
indicator line that draws it (chart_get_state lists the chart's indicators, indicators_compute shows a custom \
indicator's line labels; when none draws it say so and offer to write one), a drawn line by its id. \
\"Tell me when NQ sweeps the London high and reclaims it\" is a sequence on the chart's interval: \
[{op: crosses_above, target: the London-high line, on: trade}, {op: below, target: the same line, on: bar_close}] \
with withinBars (3 unless they say); a low is crosses_below, then above. Read the alert's title back to the user. \
Asking you to look when an alert fires is the user's switch on an alert you set, except in a trading session \
Tessera started for the user (its first message says so), where every alert you set wakes you when it fires. \
Earlier conversations are agent_list_sessions, \
agent_get_transcript and agent_search_sessions, and agent_set_model or agent_rename_session change a session. Only \
your own guard rails, your standing instructions, a session's mode and the mode sessions start in \
(agent.customInstructions, agent.defaultMode), which of the user's CLIs you run on and how (agent.providers), approvals, credentials (the Discord webhook too) and connections, where market data comes from (market.dataSource, \
and per exchange market.dataByExchange), the account each exchange trades on (trade.accountByExchange), risk \
limits, the position bracket, trade templates, turning order hotkeys on, setting up copy groups, starting or \
messaging analyst sessions and opening windows are the user's alone. Be brief.";

const STANDING: &str = "The user's standing instructions (follow them unless they conflict with Tessera's rules above):";

pub fn brief(custom: &str) -> String {
    let custom = custom.trim();
    if custom.is_empty() {
        INSTRUCTIONS.to_owned()
    } else {
        format!("{INSTRUCTIONS}\n\n{STANDING}\n{custom}")
    }
}

struct Live {
    summary: AgentSessionSummary,
    transcript: Transcript,
    stored_seq: u64,
    store_refusing: bool,
    thread: Option<Arc<dyn ProviderThread>>,
    last_status: Option<AgentState>,
    dispatched: Option<Dispatched>,
}

struct Dispatched {
    at: Instant,
    model: Option<String>,
    effort: Option<String>,
    last_error: Option<String>,
}

struct Message {
    text: String,
    records: Vec<Attachment>,
    turn: Vec<TurnAttachment>,
}

struct Next {
    turn: String,
    message: QueuedMessage,
}

pub const NEW_TITLE: &str = "New session";

const DELTA_WINDOW: Duration = Duration::from_millis(40);

const NOT_READY_RECHECK_EVERY: Duration = Duration::from_secs(60);

const ARGS_MAX: usize = 8_000;
const RESULT_MAX: usize = 4_000;

type ProviderEvents = mpsc::UnboundedReceiver<(SessionId, ProviderEvent)>;

struct Slot {
    id: &'static str,
    build: BuildProvider,
    provider: Arc<dyn AgentProvider>,
    settings: ProviderSettings,
    checked_at: Option<Timestamp>,
    generation: u64,
    checking: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone)]
struct SlotView {
    provider: Arc<dyn AgentProvider>,
    enabled: bool,
    checked_at: Option<Timestamp>,
    generation: u64,
    checking: Arc<tokio::sync::Mutex<()>>,
}

pub struct AgentService {
    store: Store,
    bus: Arc<EventBus>,
    clock: SharedClock,
    principals: Arc<McpPrincipals>,
    providers: Mutex<Vec<Slot>>,
    wanted: Mutex<HashMap<String, ProviderSettings>>,
    reconciling: tokio::sync::Mutex<()>,
    invoker: OnceLock<Arc<Invoker>>,
    mcp_url: OnceLock<String>,
    live: Mutex<HashMap<String, Live>>,
    events: crate::provider::EventSink,
    pump: Mutex<Option<ProviderEvents>>,
    opening: tokio::sync::Mutex<()>,
    brief: Mutex<Arc<str>>,
    default_mode: Mutex<SessionMode>,
    attachments: Option<AttachmentStore>,
    turn_sink: OnceLock<TurnSink>,
}

impl std::fmt::Debug for AgentService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentService").finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn unavailable(e: impl std::fmt::Display) -> ToolError {
    ToolError::unavailable(e.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OneAnswer {
    pub provider: &'static str,
    pub provider_name: &'static str,
    pub text: String,
}

async fn last_message(
    rx: &mut mpsc::UnboundedReceiver<(SessionId, ProviderEvent)>,
    name: &str,
) -> Result<String, ToolError> {
    let mut last: Option<String> = None;
    let mut failure: Option<String> = None;
    while let Some((_, event)) = rx.recv().await {
        match event {
            ProviderEvent::Message { text, .. } if !text.trim().is_empty() => last = Some(text),
            ProviderEvent::Error { message } => failure = Some(message),
            ProviderEvent::TurnEnded { end, error, .. } => {
                return match (end, last) {
                    (TurnEnd::Completed, Some(text)) => Ok(text),
                    (_, _) => Err(ToolError::unavailable(
                        error
                            .or(failure)
                            .unwrap_or_else(|| format!("{name} gave no answer")),
                    )),
                };
            }
            ProviderEvent::Exited { message } => return Err(ToolError::unavailable(message)),
            _ => {}
        }
    }
    Err(ToolError::unavailable(format!(
        "{name} stopped before answering"
    )))
}

fn off_words(name: &str) -> String {
    format!("{name} is off: the user turns it on in Settings › Analyst")
}

impl AgentService {
    pub fn new(
        store: Store,
        bus: Arc<EventBus>,
        clock: SharedClock,
        principals: Arc<McpPrincipals>,
        providers: Vec<Arc<dyn AgentProvider>>,
    ) -> Self {
        let builds = providers
            .into_iter()
            .map(|p| Arc::new(move |_: &ProviderSettings| Arc::clone(&p)) as BuildProvider)
            .collect();
        Self::with_builders(store, bus, clock, principals, builds)
    }

    pub fn with_builders(
        store: Store,
        bus: Arc<EventBus>,
        clock: SharedClock,
        principals: Arc<McpPrincipals>,
        builds: Vec<BuildProvider>,
    ) -> Self {
        let providers = builds
            .into_iter()
            .map(|build| {
                let settings = ProviderSettings::default();
                let provider = build(&settings);
                Slot {
                    id: provider.id(),
                    build,
                    provider,
                    settings,
                    checked_at: None,
                    generation: 0,
                    checking: Arc::new(tokio::sync::Mutex::new(())),
                }
            })
            .collect();
        match store.sessions().list() {
            Ok(sessions) => {
                for mut s in sessions {
                    let was = (s.status, s.queue_held);
                    if matches!(
                        s.status,
                        AgentSessionStatus::Running | AgentSessionStatus::NeedsYou
                    ) {
                        s.status = AgentSessionStatus::Idle;
                    }
                    s.queue_held |= !s.queue.is_empty();
                    if (s.status, s.queue_held) != was
                        && let Err(e) = store.sessions().upsert(&s)
                    {
                        tracing::warn!(error = %e, session = %s.id, "agent session not reset after a restart");
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "agent sessions not read at startup; none were reset")
            }
        }
        let (events, rx) = mpsc::unbounded_channel();
        Self {
            store,
            bus,
            clock,
            principals,
            providers: Mutex::new(providers),
            wanted: Mutex::new(HashMap::new()),
            reconciling: tokio::sync::Mutex::new(()),
            invoker: OnceLock::new(),
            mcp_url: OnceLock::new(),
            live: Mutex::new(HashMap::new()),
            events,
            pump: Mutex::new(Some(rx)),
            opening: tokio::sync::Mutex::new(()),
            brief: Mutex::new(Arc::from(INSTRUCTIONS)),
            default_mode: Mutex::new(SessionMode::AutoModify),
            attachments: None,
            turn_sink: OnceLock::new(),
        }
    }

    pub fn with_attachments(mut self, store: AttachmentStore) -> Self {
        self.attachments = Some(store);
        self
    }

    pub fn attachments(&self) -> Result<&AttachmentStore, ToolError> {
        self.attachments
            .as_ref()
            .ok_or_else(|| ToolError::unavailable("attachments need a data directory"))
    }

    pub fn set_custom_instructions(&self, text: String) {
        *lock(&self.brief) = Arc::from(brief(&text));
    }

    pub fn set_default_mode(&self, mode: SessionMode) {
        *lock(&self.default_mode) = mode;
    }

    pub fn default_mode(&self) -> SessionMode {
        *lock(&self.default_mode)
    }

    pub fn attach_invoker(self: &Arc<Self>, invoker: Arc<Invoker>) {
        let mut changed = invoker.approvals_changed();
        if self.invoker.set(invoker).is_err() {
            return;
        }
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            while changed.changed().await.is_ok() {
                let Some(s) = me.upgrade() else { return };
                s.follow_approvals();
            }
        });
    }

    fn follow_approvals(&self) {
        let mut live = lock(&self.live);
        for l in live.values_mut() {
            self.settle_status(l);
        }
    }

    fn waits_for_approval(&self, sid: &SessionId) -> bool {
        self.invoker.get().is_some_and(|inv| {
            inv.approvals()
                .pending()
                .iter()
                .any(|a| a.session_id.as_ref() == Some(sid))
        })
    }

    fn settle_status(&self, l: &mut Live) {
        let status = if self.waits_for_approval(&l.summary.id) {
            AgentSessionStatus::NeedsYou
        } else if l.transcript.current_turn().is_some() {
            AgentSessionStatus::Running
        } else {
            AgentSessionStatus::Idle
        };
        self.set_session_status(l, status);
    }

    pub fn set_mcp_url(&self, url: String) {
        let _ = self.mcp_url.set(url);
    }

    pub fn set_turn_sink(&self, sink: TurnSink) {
        let _ = self.turn_sink.set(sink);
    }

    pub fn providers(&self) -> Vec<Arc<dyn AgentProvider>> {
        lock(&self.providers)
            .iter()
            .map(|s| Arc::clone(&s.provider))
            .collect()
    }

    fn ids(&self) -> Vec<&'static str> {
        lock(&self.providers).iter().map(|s| s.id).collect()
    }

    fn view(&self, id: &str) -> Option<SlotView> {
        lock(&self.providers)
            .iter()
            .find(|s| s.id == id)
            .map(|s| SlotView {
                provider: Arc::clone(&s.provider),
                enabled: s.settings.enabled,
                checked_at: s.checked_at,
                generation: s.generation,
                checking: Arc::clone(&s.checking),
            })
    }

    fn provider(&self, id: &str) -> Result<Arc<dyn AgentProvider>, ToolError> {
        self.view(id)
            .map(|v| v.provider)
            .ok_or_else(|| ToolError::invalid_input(format!("no agent provider {id}")))
    }

    fn enabled(&self, id: &str) -> Result<Arc<dyn AgentProvider>, ToolError> {
        let v = self
            .view(id)
            .ok_or_else(|| ToolError::invalid_input(format!("no agent provider {id}")))?;
        if v.enabled {
            Ok(v.provider)
        } else {
            Err(unavailable(off_words(v.provider.name())))
        }
    }

    pub fn health(&self) -> Vec<ProviderHealth> {
        let on: Vec<Arc<dyn AgentProvider>> = lock(&self.providers)
            .iter()
            .filter(|s| s.settings.enabled)
            .map(|s| Arc::clone(&s.provider))
            .collect();
        on.into_iter()
            .map(|p| {
                let s = p.state();
                ProviderHealth {
                    provider_id: p.id().into(),
                    kind: ProviderKind::Agent,
                    display_name: p.name().into(),
                    status: s.status,
                    latency_ms: None,
                    last_message_at: None,
                    message: s.message,
                    connection: None,
                    accounts: None,
                    checked_at: self.clock.now(),
                }
            })
            .collect()
    }

    pub fn want(&self, wanted: HashMap<String, ProviderSettings>) {
        *lock(&self.wanted) = wanted
            .into_iter()
            .map(|(k, v)| (k, v.normalized()))
            .collect();
    }

    pub fn set_provider_settings(self: &Arc<Self>, wanted: HashMap<String, ProviderSettings>) {
        self.want(wanted);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let me = Arc::clone(self);
            rt.spawn(async move { me.reconcile().await });
        }
    }

    pub async fn configure(self: &Arc<Self>, wanted: HashMap<String, ProviderSettings>) {
        self.want(wanted);
        self.reconcile().await;
    }

    async fn reconcile(self: &Arc<Self>) {
        let to_check = {
            let _one = self.reconciling.lock().await;
            let wanted = lock(&self.wanted).clone();
            let mut to_check = Vec::new();
            for id in self.ids() {
                let next = wanted.get(id).cloned().unwrap_or_default();
                let Some((current, provider)) = lock(&self.providers)
                    .iter()
                    .find(|s| s.id == id)
                    .map(|s| (s.settings.clone(), Arc::clone(&s.provider)))
                else {
                    continue;
                };
                if next == current {
                    continue;
                }
                let relaunch = !current.same_launch(&next);
                if current.enabled && (!next.enabled || relaunch) {
                    self.stop(id, &provider).await;
                }
                if let Some(s) = lock(&self.providers).iter_mut().find(|s| s.id == id) {
                    if relaunch {
                        s.provider = (s.build)(&next);
                    }
                    s.settings = next.clone();
                    s.checked_at = None;
                    s.generation += 1;
                }
                if next.enabled {
                    to_check.push(id);
                }
            }
            to_check
        };
        futures::future::join_all(to_check.into_iter().map(|id| self.check(id, false))).await;
    }

    async fn check(&self, id: &str, force: bool) -> Option<ProviderState> {
        let v = self.view(id).filter(|v| v.enabled)?;
        let _one = v.checking.lock().await;
        let now = self.view(id).filter(|n| n.enabled)?;
        if now.generation != v.generation {
            return Some(now.provider.state());
        }
        if !force && now.checked_at.is_some() {
            return Some(now.provider.state());
        }
        let state = now.provider.connect().await;
        let at = self.now();
        if let Some(s) = lock(&self.providers)
            .iter_mut()
            .find(|s| s.id == id && s.generation == v.generation && s.settings.enabled)
        {
            s.checked_at = Some(at);
        }
        Some(state)
    }

    async fn stop(self: &Arc<Self>, id: &str, provider: &Arc<dyn AgentProvider>) {
        let threads: Vec<(SessionId, Arc<dyn ProviderThread>, bool)> = lock(&self.live)
            .values_mut()
            .filter(|l| l.summary.provider == id)
            .filter_map(|l| {
                let running = l.transcript.current_turn().is_some();
                l.thread.take().map(|t| (l.summary.id.clone(), t, running))
            })
            .collect();
        for (sid, thread, running) in threads {
            if running {
                let _ = thread.interrupt().await;
                self.finish(sid.as_str(), TurnEnd::Interrupted, None, None);
            }
            thread.close().await;
            self.principals.revoke_session(&sid);
        }
        provider.shutdown().await;
    }

    pub async fn watch(self: Arc<Self>) {
        self.reconcile().await;
        let me = Arc::downgrade(&self);
        drop(self);
        let mut every = tokio::time::interval(NOT_READY_RECHECK_EVERY);
        every.tick().await;
        loop {
            every.tick().await;
            let Some(me) = me.upgrade() else { return };
            for id in me.ids() {
                if me
                    .view(id)
                    .is_some_and(|v| v.enabled && !v.provider.state().ready())
                {
                    me.check(id, true).await;
                }
            }
        }
    }

    pub async fn providers_info(&self, recheck: bool) -> AgentProvidersOutput {
        let ids = self.ids();
        futures::future::join_all(ids.iter().map(|id| self.check(id, recheck))).await;
        let mut providers = Vec::new();
        for id in ids {
            let Some(v) = self.view(id) else { continue };
            let p = v.provider;
            if !v.enabled {
                providers.push(AgentProviderInfo {
                    id: p.id().into(),
                    name: p.name().into(),
                    enabled: false,
                    status: HealthStatus::Disabled,
                    message: None,
                    models: Vec::new(),
                    default_model: None,
                    version: None,
                    config_home: None,
                    checked_at: None,
                    reads_pdfs: p.reads_pdfs(),
                });
                continue;
            }
            let state = p.state();
            let models = p.models().await;
            providers.push(AgentProviderInfo {
                id: p.id().into(),
                name: p.name().into(),
                enabled: true,
                status: state.status,
                message: state.message.clone(),
                default_model: models.first().map(|m| m.id.clone()),
                models,
                version: p.version(),
                config_home: p.config_home(),
                checked_at: v.checked_at,
                reads_pdfs: p.reads_pdfs(),
            });
        }
        AgentProvidersOutput { providers }
    }

    pub async fn install(self: &Arc<Self>, id: &str) -> Result<AgentInstallOutput, ToolError> {
        let p = self.enabled(id)?;
        p.install().await.map_err(unavailable)?;
        self.check(id, true).await;
        Ok(AgentInstallOutput {
            provider: id.into(),
        })
    }

    pub async fn sign_in(
        self: &Arc<Self>,
        id: &str,
        code: Option<&str>,
    ) -> Result<AgentSignInOutput, ToolError> {
        let p = self.enabled(id)?;
        if let Some(code) = code {
            p.sign_in_code(code).await.map_err(unavailable)?;
            return Ok(AgentSignInOutput {
                provider: id.into(),
                page: None,
            });
        }
        let started = p.sign_in().await.map_err(unavailable)?;
        if let Some(ended) = started.ended {
            let me = Arc::downgrade(self);
            let id = id.to_owned();
            tokio::spawn(async move {
                let _ = ended.await;
                if let Some(me) = me.upgrade() {
                    me.check(&id, true).await;
                }
            });
        }
        Ok(AgentSignInOutput {
            provider: id.into(),
            page: Some(AgentSignInPage {
                url: started.url,
                opened: started.opened,
                takes_code: started.takes_code,
            }),
        })
    }

    async fn ready(&self, id: &str) -> Result<Arc<dyn AgentProvider>, ToolError> {
        let p = self.enabled(id)?;
        let mut state = p.state();
        if !state.ready() {
            state = self
                .check(id, true)
                .await
                .ok_or_else(|| unavailable(off_words(p.name())))?;
        }
        match state.status {
            HealthStatus::Ok => Ok(p),
            HealthStatus::Disconnected => Err(unavailable(format!(
                "{} is not signed in: the user signs it in in Settings › Analyst",
                p.name()
            ))),
            _ => {
                Err(unavailable(state.message.unwrap_or_else(|| {
                    format!("{} is not available", p.name())
                })))
            }
        }
    }

    async fn resolve(
        &self,
        p: &Arc<dyn AgentProvider>,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<(Option<String>, Option<String>), ToolError> {
        let models = p.models().await;
        let model = match model {
            Some(m) if models.is_empty() || models.iter().any(|x| x.id == m) => Some(m),
            Some(m) => {
                return Err(ToolError::invalid_input(format!(
                    "{} has no model {m}",
                    p.name()
                )));
            }
            None => models.first().map(|m| m.id.clone()),
        };
        let info = model
            .as_ref()
            .and_then(|id| models.iter().find(|m| &m.id == id));
        let effort = match (effort, info) {
            (Some(_), Some(m)) if m.efforts.is_empty() => None,
            (Some(e), Some(m)) if !takes_effort(m, &e) => {
                return Err(ToolError::invalid_input(format!(
                    "{} takes no effort {e}",
                    m.label
                )));
            }
            (e, _) => e,
        };
        Ok((model, effort))
    }

    fn now(&self) -> tessera_core::Timestamp {
        self.clock.now()
    }

    fn ensure_pump(self: &Arc<Self>) {
        if let Some(rx) = lock(&self.pump).take() {
            tokio::spawn(pump(Arc::downgrade(self), rx));
        }
    }

    fn emit(&self, l: &mut Live, event: AgentEvent) {
        let env = l.transcript.push(event, self.now()).clone();
        self.publish(&env);
        self.persist(l);
    }

    fn publish(&self, env: &AgentEventEnvelope) {
        self.bus.publish(
            names::AGENT_SESSION,
            TopicKey::Id(env.session_id.to_string()),
            env,
        );
    }

    fn persist(&self, l: &mut Live) {
        let pending = l.transcript.since(l.stored_seq);
        if pending.is_empty() {
            return;
        }
        match self
            .store
            .agent_events()
            .append_missing(l.summary.id.as_str(), pending)
        {
            Ok(last) => {
                l.stored_seq = last;
                l.store_refusing = false;
            }
            Err(e) => {
                if !l.store_refusing {
                    tracing::warn!(error = %e, session = %l.summary.id, "agent event not stored yet; retried with the next one");
                }
                l.store_refusing = true;
            }
        }
    }

    fn upsert(&self, summary: &AgentSessionSummary) {
        if let Err(e) = self.store.sessions().upsert(summary) {
            tracing::warn!(error = %e, "agent session not stored");
        }
        self.bus.publish(
            names::AGENT_SESSIONS,
            TopicKey::None,
            &AgentSessionsEvent::Upsert {
                session: Box::new(summary.clone()),
            },
        );
    }

    fn set_session_status(&self, l: &mut Live, status: AgentSessionStatus) {
        if l.summary.status != status {
            l.summary.status = status;
            l.summary.updated_at = self.now();
            self.upsert(&l.summary);
        }
    }

    fn origin(summary: &AgentSessionSummary) -> Origin {
        Origin::Agent {
            session_id: summary.id.clone(),
            provider: summary.provider.clone(),
        }
    }

    fn apply_policy(&self, summary: &AgentSessionSummary, preset: &Preset) {
        let cfg = SessionConfig {
            title: String::new(),
            preset: preset.clone(),
            provider: summary.provider.clone(),
            model: summary.model.clone(),
            mode: summary.mode,
            context: ContextPolicy::default(),
            allow: None,
            deny: Vec::new(),
        };
        if let Some(inv) = self.invoker.get() {
            inv.set_policy(&Self::origin(summary), cfg.policy());
        }
    }

    async fn open_thread(
        self: &Arc<Self>,
        summary: &AgentSessionSummary,
        preset: &Preset,
    ) -> Result<Arc<dyn ProviderThread>, ToolError> {
        let provider = self.ready(&summary.provider).await?;
        self.ensure_pump();
        let url = self
            .mcp_url
            .get()
            .cloned()
            .ok_or_else(|| ToolError::unavailable("the runtime is not listening yet"))?;
        let origin = Self::origin(summary);
        self.apply_policy(summary, preset);
        self.principals.revoke_session(&summary.id);
        let token = self.principals.issue(origin);
        let instructions = Arc::clone(&*lock(&self.brief));
        provider
            .open(OpenThread {
                session: summary.id.clone(),
                mcp_url: url,
                token,
                instructions,
                model: summary.model.clone(),
                effort: summary.effort.clone(),
                resume: summary.thread.clone(),
                events: self.events.clone(),
            })
            .await
            .map_err(|e| {
                self.principals.revoke_session(&summary.id);
                unavailable(e)
            })
    }

    pub fn first_ready(&self) -> Option<&'static str> {
        for id in self.ids() {
            let Some(v) = self.view(id) else { continue };
            if v.enabled && v.provider.state().ready() {
                return Some(id);
            }
        }
        None
    }

    pub async fn answer_once(
        &self,
        provider: &str,
        instructions: &str,
        text: String,
        within: Duration,
    ) -> Result<OneAnswer, ToolError> {
        let p = self.ready(provider).await?;
        let (model, effort) = self.resolve(&p, None, None).await?;
        let url = self
            .mcp_url
            .get()
            .cloned()
            .ok_or_else(|| ToolError::unavailable("the runtime is not listening yet"))?;
        let session = SessionId::generate();
        let origin = Origin::Agent {
            session_id: session.clone(),
            provider: p.id().into(),
        };
        if let Some(inv) = self.invoker.get() {
            inv.set_policy(
                &origin,
                tessera_tools::SessionPolicy {
                    mode: SessionMode::default(),
                    allow: Some(Vec::new()),
                    deny: Vec::new(),
                },
            );
        }
        let token = self.principals.issue(origin);
        let (events, mut rx) = mpsc::unbounded_channel();
        let opened = p
            .open(OpenThread {
                session: session.clone(),
                mcp_url: url,
                token,
                instructions: Arc::from(instructions),
                model: model.clone(),
                effort: effort.clone(),
                resume: None,
                events,
            })
            .await;
        let answered = match opened {
            Err(e) => Err(unavailable(e)),
            Ok(thread) => {
                let turn = async {
                    thread
                        .send(TurnInput {
                            text,
                            attachments: Vec::new(),
                            model,
                            effort,
                        })
                        .await
                        .map_err(unavailable)?;
                    last_message(&mut rx, p.name()).await
                };
                let r = tokio::time::timeout(within, turn).await;
                thread.close().await;
                r.unwrap_or_else(|_| {
                    Err(ToolError::unavailable(format!(
                        "{} did not answer in time",
                        p.name()
                    )))
                })
            }
        };
        self.principals.revoke_session(&session);
        answered.map(|text| OneAnswer {
            provider: p.id(),
            provider_name: p.name(),
            text,
        })
    }

    pub async fn start_session(
        self: &Arc<Self>,
        input: AgentStartSessionInput,
    ) -> Result<AgentSessionSummary, ToolError> {
        let provider = self.ready(&input.provider).await?;
        let (model, effort) = self
            .resolve(&provider, input.model.clone(), input.effort.clone())
            .await?;
        let preset = preset_of(&input.preset);
        let mode = input.mode.unwrap_or_else(|| self.default_mode());
        let now = self.now();
        let summary = AgentSessionSummary {
            id: SessionId::generate(),
            title: input
                .title
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| NEW_TITLE.into()),
            preset: preset.label().to_owned(),
            provider: provider.id().into(),
            model,
            effort,
            thread: None,
            mode,
            status: AgentSessionStatus::Idle,
            origin: Origin::User,
            source_label: None,
            created_at: now,
            updated_at: now,
            queue: Vec::new(),
            queue_held: false,
        };
        let thread = self.open_thread(&summary, &preset).await?;
        self.upsert(&summary);
        lock(&self.live).insert(
            summary.id.to_string(),
            Live {
                transcript: Transcript::new(summary.id.clone()),
                summary: summary.clone(),
                stored_seq: 0,
                store_refusing: false,
                thread: Some(thread),
                last_status: None,
                dispatched: None,
            },
        );
        Ok(summary)
    }

    fn summary(&self, sid: &SessionId) -> Result<AgentSessionSummary, ToolError> {
        if let Some(l) = lock(&self.live).get(sid.as_str()) {
            return Ok(l.summary.clone());
        }
        self.store
            .sessions()
            .get(sid.as_str())
            .map_err(|e| ToolError::internal(e.to_string()))?
            .ok_or_else(|| ToolError::not_found(format!("no session {sid}")))
    }

    async fn thread(
        self: &Arc<Self>,
        sid: &SessionId,
    ) -> Result<Arc<dyn ProviderThread>, ToolError> {
        let _one = self.opening.lock().await;
        if let Some(t) = lock(&self.live)
            .get(sid.as_str())
            .and_then(|l| l.thread.clone())
        {
            return Ok(t);
        }
        let live = lock(&self.live)
            .get(sid.as_str())
            .map(|l| l.summary.clone());
        let summary = match live {
            Some(s) => s,
            None => self.stored(sid)?,
        };
        let thread = self
            .open_thread(&summary, &preset_of(&summary.preset))
            .await?;
        let mut live = lock(&self.live);
        if let Some(l) = live.get_mut(sid.as_str()) {
            l.thread = Some(Arc::clone(&thread));
            return Ok(thread);
        }
        let mut l = self.restore(summary)?;
        l.thread = Some(Arc::clone(&thread));
        live.insert(sid.to_string(), l);
        Ok(thread)
    }

    fn stored(&self, sid: &SessionId) -> Result<AgentSessionSummary, ToolError> {
        Ok(AgentSessionSummary {
            mode: self.default_mode(),
            status: AgentSessionStatus::Idle,
            ..self.summary(sid)?
        })
    }

    fn restore(&self, summary: AgentSessionSummary) -> Result<Live, ToolError> {
        let sid = summary.id.clone();
        let events = self
            .store
            .agent_events()
            .list(sid.as_str(), 0, u32::MAX)
            .map_err(|e| ToolError::internal(e.to_string()))?;
        let transcript =
            Transcript::restore(sid.clone(), events).unwrap_or_else(|| Transcript::new(sid));
        Ok(Live {
            stored_seq: transcript.events().len() as u64,
            transcript,
            summary,
            store_refusing: false,
            thread: None,
            last_status: None,
            dispatched: None,
        })
    }

    pub fn post_card(&self, sid: &SessionId, card: Card) -> Result<(), ToolError> {
        let summary = self.stored(sid)?;
        let mut live = lock(&self.live);
        if !live.contains_key(sid.as_str()) {
            let l = self.restore(summary)?;
            live.insert(sid.to_string(), l);
        }
        if let Some(l) = live.get_mut(sid.as_str()) {
            self.emit(l, AgentEvent::Card { card });
        }
        Ok(())
    }

    pub fn answering(&self, sid: &SessionId) -> bool {
        lock(&self.live)
            .get(sid.as_str())
            .is_some_and(|l| l.transcript.current_turn().is_some())
    }

    pub async fn send(
        self: &Arc<Self>,
        sid: &SessionId,
        text: &str,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<AgentSendOutput, ToolError> {
        self.send_with(sid, text, &[], model, effort, None).await
    }

    async fn resolve_attachments(
        &self,
        sid: &SessionId,
        list: &[Attachment],
    ) -> Result<Vec<Resolved>, ToolError> {
        let uploaded = list
            .iter()
            .any(|a| matches!(a.kind, AttachmentKind::Image | AttachmentKind::File));
        if !uploaded {
            return Ok(Vec::new());
        }
        let store = self.attachments()?.clone();
        let (sid2, list2) = (sid.clone(), list.to_vec());
        let resolved = tokio::task::spawn_blocking(move || store.resolve(&sid2, &list2))
            .await
            .map_err(|e| ToolError::internal(e.to_string()))??;
        let summary = self.summary(sid)?;
        let provider = self.provider(&summary.provider)?;
        if !provider.reads_pdfs()
            && let Some(pdf) = resolved.iter().find(|r| r.turn.content == TurnContent::Pdf)
        {
            return Err(ToolError::invalid_input(format!(
                "{} does not read PDFs: remove {}, or ask in a Claude Code session",
                provider.name(),
                pdf.turn.name
            )));
        }
        Ok(resolved)
    }

    async fn message(
        &self,
        sid: &SessionId,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<Message, ToolError> {
        let resolved = self.resolve_attachments(sid, attachments).await?;
        if text.trim().is_empty() && resolved.is_empty() {
            return Err(ToolError::invalid_input(
                "a message needs words or an attachment",
            ));
        }
        let mut records: Vec<Attachment> = attachments
            .iter()
            .filter(|a| !matches!(a.kind, AttachmentKind::Image | AttachmentKind::File))
            .cloned()
            .collect();
        records.extend(resolved.iter().map(|r| r.attachment.clone()));
        Ok(Message {
            text: text.to_owned(),
            records,
            turn: resolved.into_iter().map(|r| r.turn).collect(),
        })
    }

    async fn turn_input(&self, sid: &SessionId, m: &Message) -> Result<TurnInput, ToolError> {
        let summary = self.summary(sid)?;
        Ok(TurnInput {
            text: prompt_text(&m.text, &m.turn),
            attachments: m
                .turn
                .iter()
                .filter(|a| a.content != TurnContent::Text)
                .cloned()
                .collect(),
            effort: self.turn_effort(&summary).await,
            model: summary.model,
        })
    }

    pub async fn send_with(
        self: &Arc<Self>,
        sid: &SessionId,
        text: &str,
        attachments: &[Attachment],
        model: Option<String>,
        effort: Option<String>,
        delivery: Option<Delivery>,
    ) -> Result<AgentSendOutput, ToolError> {
        let message = self.message(sid, text, attachments).await?;
        if model.is_some() || effort.is_some() {
            self.set_model(sid, model, effort).await?;
        }
        let thread = self.thread(sid).await?;
        let input = self.turn_input(sid, &message).await?;
        let turn = {
            let mut live = lock(&self.live);
            let l = live
                .get_mut(sid.as_str())
                .ok_or_else(|| ToolError::not_found(format!("no live session {sid}")))?;
            self.open_turn(l, &message.text, &message.records)
        };
        let Some(turn) = turn else {
            return match delivery.unwrap_or(Delivery::Queue) {
                Delivery::Steer => self.steer(sid, &thread, message, input).await,
                Delivery::Queue => self.enqueue(sid, message, None),
            };
        };
        self.claim(sid, &message.records);
        self.send_turn(sid, &thread, input).await?;
        Ok(sent(sid, Delivered::Turn, Some(turn)))
    }

    fn open_turn(&self, l: &mut Live, text: &str, records: &[Attachment]) -> Option<String> {
        let first = !l
            .transcript
            .events()
            .iter()
            .any(|e| matches!(e.event, AgentEvent::UserMessage { .. }));
        let title = title_from(if text.trim().is_empty() {
            records.first().map_or(NEW_TITLE, |a| a.label.as_str())
        } else {
            text
        });
        let turn = l
            .transcript
            .begin_turn(text, records.to_vec(), self.now())
            .ok()?;
        let n = l.transcript.events().len();
        for env in &l.transcript.events()[n - 2..] {
            self.publish(env);
        }
        self.persist(l);
        if first && l.summary.title == NEW_TITLE {
            l.summary.title = title;
        }
        l.last_status = None;
        self.emit(l, status(AgentState::Thinking));
        l.last_status = Some(AgentState::Thinking);
        self.settle_status(l);
        l.summary.updated_at = self.now();
        self.upsert(&l.summary);
        Some(turn)
    }

    fn claim(&self, sid: &SessionId, records: &[Attachment]) {
        let ids: Vec<String> = records.iter().filter_map(|a| a.id.clone()).collect();
        if !ids.is_empty()
            && let Ok(store) = self.attachments()
        {
            store.claim(sid, &ids);
        }
    }

    fn begin_tool_turn(&self, sid: &SessionId) {
        if let (Some(inv), Ok(summary)) = (self.invoker.get(), self.summary(sid)) {
            inv.begin_turn(&Self::origin(&summary));
        }
    }

    async fn send_turn(
        self: &Arc<Self>,
        sid: &SessionId,
        thread: &Arc<dyn ProviderThread>,
        input: TurnInput,
    ) -> Result<(), ToolError> {
        self.begin_tool_turn(sid);
        if let Some(l) = lock(&self.live)
            .get_mut(sid.as_str())
            .filter(|l| l.transcript.current_turn().is_some())
        {
            l.dispatched = Some(Dispatched {
                at: Instant::now(),
                model: input.model.clone(),
                effort: input.effort.clone(),
                last_error: None,
            });
        }
        thread.send(input).await.map_err(|e| {
            self.finish(sid.as_str(), TurnEnd::Failed, Some(e.to_string()), None);
            unavailable(e)
        })
    }

    async fn steer(
        self: &Arc<Self>,
        sid: &SessionId,
        thread: &Arc<dyn ProviderThread>,
        message: Message,
        input: TurnInput,
    ) -> Result<AgentSendOutput, ToolError> {
        let name = self.provider(&self.summary(sid)?.provider)?.name();
        let notice = match thread.steer(input).await {
            Ok(SteerOutcome::Took) => return self.steered(sid, message),
            Ok(SteerOutcome::NoTurn) => None,
            Ok(SteerOutcome::Unsupported) => Some(format!(
                "{name} can't take messages mid-run, so it's queued for when this run ends."
            )),
            Err(e) => Some(format!(
                "{name} didn't take the message mid-run ({e}), so it's queued for when this run ends."
            )),
        };
        self.enqueue(sid, message, notice)
    }

    fn steered(&self, sid: &SessionId, message: Message) -> Result<AgentSendOutput, ToolError> {
        let (turn, began) = {
            let mut live = lock(&self.live);
            let l = live
                .get_mut(sid.as_str())
                .ok_or_else(|| ToolError::not_found(format!("no live session {sid}")))?;
            match l
                .transcript
                .steer(&message.text, message.records.clone(), self.now())
            {
                Ok(turn) => {
                    if let Some(env) = l.transcript.events().last() {
                        self.publish(env);
                    }
                    self.persist(l);
                    (Some(turn), false)
                }
                Err(_) => (self.open_turn(l, &message.text, &message.records), true),
            }
        };
        self.claim(sid, &message.records);
        if began {
            self.begin_tool_turn(sid);
        }
        Ok(sent(sid, Delivered::Steered, turn))
    }

    fn enqueue(
        self: &Arc<Self>,
        sid: &SessionId,
        message: Message,
        notice: Option<String>,
    ) -> Result<AgentSendOutput, ToolError> {
        let id = tessera_core::ids::unique("q");
        let next = {
            let mut live = lock(&self.live);
            let l = live
                .get_mut(sid.as_str())
                .ok_or_else(|| ToolError::not_found(format!("no live session {sid}")))?;
            l.summary.queue.push(QueuedMessage {
                id: id.clone(),
                text: message.text,
                attachments: message.records.clone(),
                queued_at: self.now(),
            });
            self.upsert(&l.summary);
            self.next_queued(l)
        };
        self.claim(sid, &message.records);
        let out = match &next {
            Some(n) if n.message.id == id => sent(sid, Delivered::Turn, Some(n.turn.clone())),
            _ => AgentSendOutput {
                session_id: sid.clone(),
                delivered: Delivered::Queued,
                turn_id: None,
                queued_id: Some(id),
                notice,
            },
        };
        if let Some(next) = next {
            self.dispatch(sid, next);
        }
        Ok(out)
    }

    fn next_queued(&self, l: &mut Live) -> Option<Next> {
        if l.summary.queue_held
            || l.summary.queue.is_empty()
            || l.transcript.current_turn().is_some()
        {
            return None;
        }
        let message = l.summary.queue.remove(0);
        let turn = self.open_turn(l, &message.text, &message.attachments)?;
        Some(Next { turn, message })
    }

    fn drain(self: &Arc<Self>, sid: &SessionId) -> Option<AgentSessionSummary> {
        let (summary, next) = {
            let mut live = lock(&self.live);
            let l = live.get_mut(sid.as_str())?;
            let next = self.next_queued(l)?;
            (l.summary.clone(), next)
        };
        self.dispatch(sid, next);
        Some(summary)
    }

    fn dispatch(self: &Arc<Self>, sid: &SessionId, next: Next) {
        let (me, sid) = (Arc::clone(self), sid.clone());
        tokio::spawn(async move {
            let q = &next.message;
            let ready = async {
                let message = me.message(&sid, &q.text, &q.attachments).await?;
                let thread = me.thread(&sid).await?;
                let input = me.turn_input(&sid, &message).await?;
                Ok::<_, ToolError>((thread, input))
            }
            .await;
            match ready {
                Ok((thread, input)) => {
                    let _ = me.send_turn(&sid, &thread, input).await;
                }
                Err(e) => me.finish(sid.as_str(), TurnEnd::Failed, Some(e.message), None),
            }
        });
    }

    fn change_queue<R>(
        &self,
        sid: &SessionId,
        change: impl FnOnce(&mut AgentSessionSummary) -> Result<R, ToolError>,
    ) -> Result<(AgentSessionSummary, R), ToolError> {
        let mut stored = self.summary(sid)?;
        let mut live = lock(&self.live);
        let summary = match live.get_mut(sid.as_str()) {
            Some(l) => &mut l.summary,
            None => &mut stored,
        };
        let out = change(&mut *summary)?;
        self.upsert(summary);
        Ok((summary.clone(), out))
    }

    pub fn edit_queued(
        &self,
        sid: &SessionId,
        queued_id: &str,
        text: &str,
    ) -> Result<AgentSessionSummary, ToolError> {
        let (summary, ()) = self.change_queue(sid, |s| {
            let q = s
                .queue
                .iter_mut()
                .find(|q| q.id == queued_id)
                .ok_or_else(|| gone(queued_id))?;
            if text.trim().is_empty() && q.attachments.is_empty() {
                return Err(ToolError::invalid_input(
                    "a message needs words or an attachment",
                ));
            }
            q.text = text.to_owned();
            Ok(())
        })?;
        Ok(summary)
    }

    pub fn remove_queued(
        &self,
        sid: &SessionId,
        queued_id: &str,
    ) -> Result<AgentSessionSummary, ToolError> {
        let (summary, removed) = self.change_queue(sid, |s| {
            let at = s
                .queue
                .iter()
                .position(|q| q.id == queued_id)
                .ok_or_else(|| gone(queued_id))?;
            let removed = s.queue.remove(at);
            s.queue_held &= !s.queue.is_empty();
            Ok(removed)
        })?;
        let uploads: Vec<String> = removed
            .attachments
            .iter()
            .filter_map(|a| a.id.clone())
            .collect();
        if !uploads.is_empty()
            && let Ok(store) = self.attachments()
        {
            store.release(sid, &uploads);
        }
        Ok(summary)
    }

    pub async fn resume_queue(
        self: &Arc<Self>,
        sid: &SessionId,
    ) -> Result<AgentSessionSummary, ToolError> {
        if !self.summary(sid)?.queue.is_empty() {
            self.thread(sid).await?;
        }
        let (summary, ()) = self.change_queue(sid, |s| {
            s.queue_held = false;
            Ok(())
        })?;
        Ok(self.drain(sid).unwrap_or(summary))
    }

    async fn turn_effort(&self, summary: &AgentSessionSummary) -> Option<String> {
        if summary.effort.is_some() {
            return summary.effort.clone();
        }
        let provider = self.provider(&summary.provider).ok()?;
        let model = summary.model.as_ref()?;
        provider
            .models()
            .await
            .into_iter()
            .find(|m| &m.id == model)
            .and_then(|m| m.default_effort)
    }

    pub async fn interrupt(self: &Arc<Self>, sid: &SessionId) -> Result<bool, ToolError> {
        let thread = lock(&self.live)
            .get(sid.as_str())
            .filter(|l| l.transcript.current_turn().is_some())
            .and_then(|l| l.thread.clone());
        let Some(thread) = thread else {
            return Ok(false);
        };
        thread.interrupt().await.map_err(unavailable)
    }

    pub async fn set_model(
        self: &Arc<Self>,
        sid: &SessionId,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<AgentSessionSummary, ToolError> {
        let current = self.summary(sid)?;
        let provider = self.enabled(&current.provider)?;
        let changed_model = model.is_some() && model != current.model;
        let model = model.or(current.model.clone());
        let effort = effort.or(if changed_model {
            None
        } else {
            current.effort.clone()
        });
        let (model, effort) = self.resolve(&provider, model, effort).await?;
        let mut live = lock(&self.live);
        let summary = match live.get_mut(sid.as_str()) {
            Some(l) => {
                l.summary.model = model;
                l.summary.effort = effort;
                l.summary.clone()
            }
            None => AgentSessionSummary {
                model,
                effort,
                ..current
            },
        };
        self.upsert(&summary);
        Ok(summary)
    }

    pub fn set_mode(
        &self,
        sid: &SessionId,
        mode: SessionMode,
    ) -> Result<AgentSessionSummary, ToolError> {
        let current = self.summary(sid)?;
        let summary = {
            let mut live = lock(&self.live);
            match live.get_mut(sid.as_str()) {
                Some(l) => {
                    l.summary.mode = mode;
                    l.summary.clone()
                }
                None => AgentSessionSummary { mode, ..current },
            }
        };
        self.upsert(&summary);
        self.apply_policy(&summary, &preset_of(&summary.preset));
        Ok(summary)
    }

    pub fn rename(&self, sid: &SessionId, title: &str) -> Result<AgentSessionSummary, ToolError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(ToolError::invalid_input("a session needs a title"));
        }
        let title: String = title.chars().take(120).collect();
        let current = self.summary(sid)?;
        let mut live = lock(&self.live);
        let summary = match live.get_mut(sid.as_str()) {
            Some(l) => {
                l.summary.title = title;
                l.summary.clone()
            }
            None => AgentSessionSummary { title, ..current },
        };
        self.upsert(&summary);
        Ok(summary)
    }

    pub async fn delete(self: &Arc<Self>, sid: &SessionId) -> Result<bool, ToolError> {
        if let (Some(inv), Ok(summary)) = (self.invoker.get(), self.summary(sid)) {
            inv.close(&Self::origin(&summary));
        }
        let live = lock(&self.live).remove(sid.as_str());
        if let Some(thread) = live.and_then(|l| l.thread) {
            let _ = thread.interrupt().await;
            thread.close().await;
        }
        self.principals.revoke_session(sid);
        if let Ok(store) = self.attachments() {
            store.remove_session(sid);
        }
        let deleted = self
            .store
            .sessions()
            .delete(sid.as_str())
            .map_err(|e| ToolError::internal(e.to_string()))?;
        if deleted {
            self.bus.publish(
                names::AGENT_SESSIONS,
                TopicKey::None,
                &AgentSessionsEvent::Removed {
                    session_id: sid.clone(),
                },
            );
        }
        Ok(deleted)
    }

    fn finish(
        self: &Arc<Self>,
        sid: &str,
        end: TurnEnd,
        error: Option<String>,
        usage: Option<TurnUsage>,
    ) {
        let (next, report) = {
            let mut live = lock(&self.live);
            let Some(l) = live.get_mut(sid) else { return };
            if let Some(message) = error.clone() {
                self.emit(
                    l,
                    AgentEvent::Error {
                        code: "provider".into(),
                        message,
                        retryable: true,
                    },
                );
            }
            if l.transcript.current_turn().is_none() {
                return;
            }
            if let Ok(env) = l.transcript.end_turn(end, self.now()) {
                let env = env.clone();
                self.publish(&env);
                self.persist(l);
            }
            let report = l.dispatched.take().map(|d| TurnReport {
                session: l.summary.id.clone(),
                provider: l.summary.provider.clone(),
                model: d.model,
                effort: d.effort,
                latency: d.at.elapsed(),
                end,
                error: error.or(d.last_error.filter(|_| end == TurnEnd::Failed)),
                usage,
            });
            l.last_status = None;
            self.emit(l, status(AgentState::Idle));
            l.summary.queue_held |= end != TurnEnd::Completed && !l.summary.queue.is_empty();
            self.settle_status(l);
            (self.next_queued(l), report)
        };
        if let (Some(report), Some(sink)) = (report, self.turn_sink.get()) {
            sink(report);
        }
        if let Some(next) = next {
            self.dispatch(&SessionId::new(sid), next);
        }
    }

    fn on_event(self: &Arc<Self>, sid: &SessionId, ev: ProviderEvent) {
        let refused = matches!(ev, ProviderEvent::Message { .. })
            .then(|| self.step_refused(sid))
            .flatten();
        self.apply(sid, ev);
        if let Some(trip) = refused {
            self.stop_looping(sid, trip);
        }
    }

    fn apply(self: &Arc<Self>, sid: &SessionId, ev: ProviderEvent) {
        match ev {
            ProviderEvent::TurnEnded { end, error, usage } => {
                self.finish(sid.as_str(), end, error, usage);
            }
            ProviderEvent::Exited { message } => {
                let running = {
                    let mut live = lock(&self.live);
                    live.get_mut(sid.as_str()).is_some_and(|l| {
                        l.thread = None;
                        l.transcript.current_turn().is_some()
                    })
                };
                if running {
                    self.finish(sid.as_str(), TurnEnd::Failed, Some(message), None);
                }
            }
            ev => {
                let mut live = lock(&self.live);
                let Some(l) = live.get_mut(sid.as_str()) else {
                    return;
                };
                match ev {
                    ProviderEvent::Thread(id) => {
                        if l.summary.thread.as_deref() != Some(id.as_str()) {
                            l.summary.thread = Some(id);
                            self.upsert(&l.summary);
                        }
                    }
                    ProviderEvent::ThreadLost => {
                        if l.summary.thread.take().is_some() {
                            self.upsert(&l.summary);
                        }
                    }
                    ProviderEvent::Model(m) => {
                        if l.summary.model.is_none() {
                            l.summary.model = Some(m);
                            self.upsert(&l.summary);
                        }
                    }
                    ProviderEvent::Status(s) => {
                        if l.transcript.current_turn().is_some() && l.last_status != Some(s) {
                            l.last_status = Some(s);
                            self.emit(l, status(s));
                        }
                    }
                    ProviderEvent::Delta { message_id, text } => {
                        self.emit(l, AgentEvent::AssistantDelta { message_id, text });
                    }
                    ProviderEvent::Message { message_id, text } => self.emit(
                        l,
                        AgentEvent::AssistantMessage {
                            message_id,
                            text,
                            blocks: Vec::new(),
                        },
                    ),
                    ProviderEvent::Reasoning { text, duration_ms } => {
                        self.emit(l, AgentEvent::ReasoningSummary { text, duration_ms });
                    }
                    ProviderEvent::Error { message } => {
                        if let Some(d) = l.dispatched.as_mut() {
                            d.last_error = Some(message.clone());
                        }
                        self.emit(
                            l,
                            AgentEvent::Error {
                                code: "provider".into(),
                                message,
                                retryable: true,
                            },
                        );
                    }
                    ProviderEvent::TurnEnded { .. } | ProviderEvent::Exited { .. } => {}
                }
            }
        }
    }
}

impl AgentService {
    fn step_refused(&self, sid: &SessionId) -> Option<tessera_tools::GuardTrip> {
        let inv = self.invoker.get()?;
        let live = lock(&self.live);
        let l = live.get(sid.as_str())?;
        l.transcript.current_turn()?;
        inv.note_step(&Self::origin(&l.summary)).err()
    }

    fn stop_looping(self: &Arc<Self>, sid: &SessionId, trip: tessera_tools::GuardTrip) {
        let thread = lock(&self.live)
            .get(sid.as_str())
            .and_then(|l| l.thread.clone());
        if let Some(thread) = thread {
            tokio::spawn(async move {
                let _ = thread.interrupt().await;
            });
        }
        self.finish(
            sid.as_str(),
            TurnEnd::LoopGuard,
            Some(format!("Stopped this turn: {trip}.")),
            None,
        );
    }
}

async fn pump(service: Weak<AgentService>, mut rx: ProviderEvents) {
    let mut held: Option<(SessionId, String, String, Instant)> = None;
    let flush = |held: &mut Option<(SessionId, String, String, Instant)>| {
        if let (Some((sid, message_id, text, _)), Some(s)) = (held.take(), service.upgrade()) {
            s.on_event(&sid, ProviderEvent::Delta { message_id, text });
        }
    };
    loop {
        let next = match &held {
            Some((.., since)) => {
                let left = DELTA_WINDOW.saturating_sub(since.elapsed());
                match tokio::time::timeout(left, rx.recv()).await {
                    Ok(next) => next,
                    Err(_) => {
                        flush(&mut held);
                        continue;
                    }
                }
            }
            None => rx.recv().await,
        };
        let Some((sid, ev)) = next else {
            flush(&mut held);
            return;
        };
        match ev {
            ProviderEvent::Delta { message_id, text } => match &mut held {
                Some((s, m, t, since))
                    if *s == sid && *m == message_id && since.elapsed() < DELTA_WINDOW =>
                {
                    t.push_str(&text);
                }
                _ => {
                    flush(&mut held);
                    held = Some((sid, message_id, text, Instant::now()));
                }
            },
            ev => {
                flush(&mut held);
                let Some(s) = service.upgrade() else { return };
                s.on_event(&sid, ev);
            }
        }
    }
}

fn preset_of(name: &str) -> Preset {
    serde_json::from_value(json!({"kind": name.to_lowercase()})).unwrap_or(Preset::Trader)
}

pub fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(NEW_TITLE);
    if line.chars().count() <= 60 {
        return line.to_owned();
    }
    let cut: String = line.chars().take(60).collect();
    let at = cut.rfind(' ').filter(|i| *i > 30).unwrap_or(cut.len());
    format!("{}…", cut[..at].trim_end())
}

fn sent(sid: &SessionId, delivered: Delivered, turn_id: Option<String>) -> AgentSendOutput {
    AgentSendOutput {
        session_id: sid.clone(),
        delivered,
        turn_id,
        queued_id: None,
        notice: None,
    }
}

fn gone(queued_id: &str) -> ToolError {
    ToolError::not_found(format!(
        "no queued message {queued_id}: it was already sent or removed"
    ))
}

fn status(state: AgentState) -> AgentEvent {
    AgentEvent::Status {
        state,
        text: None,
        step: None,
        total_steps: None,
    }
}

fn cut(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn args_preview(args: &Value) -> Value {
    let text = args.to_string();
    if text.len() <= ARGS_MAX {
        args.clone()
    } else {
        Value::String(cut(text, ARGS_MAX))
    }
}

fn shown_card(result: &ToolResult) -> Option<Card> {
    if result.status != ToolOutcome::Ok {
        return None;
    }
    let card = result.output.as_ref()?.get("card")?;
    serde_json::from_value(card.clone()).ok()
}

fn result_preview(result: &ToolResult) -> Option<String> {
    match (result.status, &result.output) {
        (ToolOutcome::Ok, Some(v)) => Some(cut(v.to_string(), RESULT_MAX)),
        _ => None,
    }
}

impl McpHook for AgentService {
    fn calling(&self, origin: &Origin, call: &CallId, tool: &str, risk: RiskTier, args: &Value) {
        let Some(sid) = origin.session_id() else {
            return;
        };
        let mut live = lock(&self.live);
        let Some(l) = live.get_mut(sid.as_str()) else {
            return;
        };
        self.emit(
            l,
            AgentEvent::ToolCallStarted {
                call_id: call.clone(),
                tool: tool.to_owned(),
                risk,
                args: args_preview(args),
                title: None,
            },
        );
        l.last_status = Some(AgentState::RunningTool);
    }

    fn called(
        &self,
        origin: &Origin,
        call: &CallId,
        tool: &str,
        risk: RiskTier,
        result: &ToolResult,
    ) {
        let Some(sid) = origin.session_id() else {
            return;
        };
        let mut live = lock(&self.live);
        let Some(l) = live.get_mut(sid.as_str()) else {
            return;
        };
        self.emit(
            l,
            AgentEvent::ToolCallFinished {
                call_id: call.clone(),
                tool: tool.to_owned(),
                risk,
                outcome: result.status,
                result_summary: None,
                artifact_refs: Vec::new(),
                duration_ms: result.duration_ms,
                error: result.error.clone(),
                result: result_preview(result),
            },
        );
        if let Some(card) = shown_card(result) {
            self.emit(l, AgentEvent::Card { card });
        }
        if result.status == ToolOutcome::PendingApproval {
            if let Some(a) = &result.approval {
                self.emit(
                    l,
                    AgentEvent::ApprovalRequested {
                        approval_id: a.approval_id.clone(),
                        draft_id: a.draft_id.clone(),
                        tool: tool.to_owned(),
                        kind: if risk == RiskTier::Financial {
                            ApprovalKind::Financial
                        } else {
                            ApprovalKind::Modify
                        },
                    },
                );
            }
            self.settle_status(l);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::clock::SystemClock;
    use tessera_core::settle::settle;
    use tessera_protocol::tools::ToolErrorCode;

    fn summary(id: &str) -> AgentSessionSummary {
        AgentSessionSummary {
            id: SessionId::new(id),
            title: NEW_TITLE.into(),
            preset: "Trader".into(),
            provider: "claude-code".into(),
            model: None,
            effort: None,
            thread: None,
            mode: SessionMode::AutoModify,
            status: AgentSessionStatus::Idle,
            origin: Origin::User,
            source_label: None,
            created_at: tessera_core::Timestamp(0),
            updated_at: tessera_core::Timestamp(0),
            queue: Vec::new(),
            queue_held: false,
        }
    }

    #[test]
    fn a_call_that_answers_with_a_card_puts_it_in_the_chat() {
        let card = serde_json::json!({
            "id": "card-NQ",
            "body": {"kind": "data_coverage", "symbol": "NQ", "scope": "rth", "from": "2026-10-01", "to": "2026-10-02", "days": []},
            "actions": [{"label": "Check again", "tool": "market.data_coverage", "input": {"instrument": "NQ"}, "primary": false}],
            "updatedAt": 1
        });
        let result = |status, output| ToolResult {
            ok: true,
            status,
            call_id: CallId::generate(),
            duration_ms: 1.0,
            output: Some(output),
            error: None,
            approval: None,
            deduped: false,
        };
        let shown = shown_card(&result(
            ToolOutcome::Ok,
            serde_json::json!({"card": card, "days": 2}),
        ));
        assert_eq!(shown.map(|c| c.id), Some("card-NQ".to_owned()));
        assert!(shown_card(&result(ToolOutcome::Ok, serde_json::json!({"days": 2}))).is_none());
        assert!(
            shown_card(&result(
                ToolOutcome::PendingApproval,
                serde_json::json!({"card": card})
            ))
            .is_none()
        );
    }

    #[test]
    fn a_refused_write_is_caught_up_by_the_next_one() {
        let store = Store::open_in_memory().unwrap();
        let svc = AgentService::new(
            store.clone(),
            Arc::new(EventBus::new()),
            Arc::new(SystemClock),
            Arc::new(McpPrincipals::new()),
            Vec::new(),
        );
        let mut l = Live {
            summary: summary("S1"),
            transcript: Transcript::new(SessionId::new("S1")),
            stored_seq: 0,
            store_refusing: false,
            thread: None,
            last_status: None,
            dispatched: None,
        };
        svc.emit(&mut l, status(AgentState::Thinking));
        assert_eq!(l.stored_seq, 0);
        assert!(l.store_refusing);
        store.sessions().upsert(&l.summary).unwrap();
        svc.emit(&mut l, status(AgentState::Writing));
        svc.emit(&mut l, status(AgentState::Idle));
        assert_eq!(l.stored_seq, 3);
        assert!(!l.store_refusing);
        let seqs: Vec<u64> = store
            .agent_events()
            .list("S1", 0, 10)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn the_brief_carries_the_users_standing_instructions_after_tesseras() {
        assert_eq!(brief(""), INSTRUCTIONS);
        assert_eq!(brief("  \n\t "), INSTRUCTIONS, "blank is none");
        let b = brief("\n  Always quote prices in ticks.\n");
        assert_eq!(
            b,
            format!(
                "{INSTRUCTIONS}\n\nThe user's standing instructions (follow them unless they conflict with Tessera's rules above):\nAlways quote prices in ticks."
            )
        );
        assert!(b.starts_with(INSTRUCTIONS));
        assert!(INSTRUCTIONS.contains("settings: the Settings area"));
        assert!(INSTRUCTIONS.contains("desk, markets, agents"));
        assert!(!INSTRUCTIONS.contains("Markets, Positions"));
        assert!(INSTRUCTIONS.contains("trade.positionBracket"));
        assert!(INSTRUCTIONS.contains("intel_draft_source"));
        assert!(INSTRUCTIONS.contains("limits, the position bracket, trade templates"));
        assert!(INSTRUCTIONS.contains("and N accounts by copy"));
        assert!(INSTRUCTIONS.contains("setting up copy groups"));
        assert!(INSTRUCTIONS.contains("(agent.providers)"));
        assert!(INSTRUCTIONS.contains("own label, never a separate note"));
        assert!(INSTRUCTIONS.contains("label {text:"));
        assert!(INSTRUCTIONS.contains("draw.line with label"));
        assert!(INSTRUCTIONS.contains("Custom indicators are JavaScript"));
        assert!(INSTRUCTIONS.contains("style.labels"));
        for tool in [
            "chart_get_state",
            "chart_set_viewport",
            "chart_list_drawing_templates",
            "set_default_drawing_template",
            "trade_set_panel",
            "orders_contract_for",
            "orders_merge_brackets",
            "orders_breakeven",
            "orders_reverse",
            "copy_list",
            "copy_status",
            "copy_flatten",
            "copy_resync",
            "copy_disable",
            "workspace_set_view",
            "workspace_create",
            "ui_show_area",
            "market_list_instruments",
            "watchlists_list",
            "watchlists_add",
            "settings_set",
            "agent_get_transcript",
            "journal_",
            "research_",
            "indicators_",
            "chart_set_indicator_default",
            "chart_*_indicator_preset",
        ] {
            let short = tool.split_once('_').map_or(tool, |(_, verb)| verb);
            assert!(
                INSTRUCTIONS.contains(tool) || INSTRUCTIONS.contains(short),
                "the brief names {tool}"
            );
        }
    }

    #[derive(Default)]
    struct Script {
        sent: Vec<String>,
        steered: Vec<String>,
        sink: Option<(SessionId, crate::provider::EventSink)>,
    }

    #[derive(Default)]
    struct Stub {
        steers: bool,
        script: Arc<Mutex<Script>>,
    }

    impl Stub {
        fn steering() -> Self {
            Self {
                steers: true,
                ..Self::default()
            }
        }

        fn sent(&self) -> Vec<String> {
            lock(&self.script).sent.clone()
        }

        fn steered(&self) -> Vec<String> {
            lock(&self.script).steered.clone()
        }

        fn emit(&self, ev: ProviderEvent) {
            let script = lock(&self.script);
            let (sid, sink) = script.sink.as_ref().expect("a thread is open");
            sink.send((sid.clone(), ev)).unwrap();
        }

        fn end(&self, end: TurnEnd) {
            self.emit(ProviderEvent::TurnEnded {
                end,
                error: None,
                usage: None,
            });
        }
    }

    struct StubThread {
        steers: bool,
        script: Arc<Mutex<Script>>,
    }

    #[async_trait::async_trait]
    impl ProviderThread for StubThread {
        fn thread_id(&self) -> Option<String> {
            None
        }
        async fn send(&self, turn: TurnInput) -> Result<(), crate::AgentError> {
            lock(&self.script).sent.push(turn.text);
            Ok(())
        }
        async fn steer(&self, turn: TurnInput) -> Result<SteerOutcome, crate::AgentError> {
            if !self.steers {
                return Ok(SteerOutcome::Unsupported);
            }
            lock(&self.script).steered.push(turn.text);
            Ok(SteerOutcome::Took)
        }
        async fn interrupt(&self) -> Result<bool, crate::AgentError> {
            Ok(true)
        }
        async fn close(&self) {}
    }

    #[async_trait::async_trait]
    impl AgentProvider for Stub {
        fn id(&self) -> &'static str {
            CODEX
        }
        fn name(&self) -> &'static str {
            "Codex"
        }
        fn state(&self) -> ProviderState {
            ProviderState::new(HealthStatus::Ok, "signed in")
        }
        async fn connect(&self) -> ProviderState {
            self.state()
        }
        async fn models(&self) -> Vec<tessera_protocol::agent::AgentModel> {
            Vec::new()
        }
        async fn open(
            &self,
            req: OpenThread,
        ) -> Result<Arc<dyn ProviderThread>, crate::AgentError> {
            lock(&self.script).sink = Some((req.session, req.events));
            Ok(Arc::new(StubThread {
                steers: self.steers,
                script: Arc::clone(&self.script),
            }))
        }
    }

    struct Rig {
        svc: Arc<AgentService>,
        stub: Arc<Stub>,
        store: Store,
        sid: SessionId,
    }

    async fn rig(stub: Stub) -> Rig {
        let store = Store::open_in_memory().unwrap();
        let stub = Arc::new(stub);
        let svc = Arc::new(AgentService::new(
            store.clone(),
            Arc::new(EventBus::new()),
            Arc::new(SystemClock),
            Arc::new(McpPrincipals::new()),
            vec![Arc::clone(&stub) as Arc<dyn AgentProvider>],
        ));
        svc.set_mcp_url("http://127.0.0.1:9/mcp".into());
        svc.configure(HashMap::from([(
            CODEX.to_owned(),
            ProviderSettings {
                enabled: true,
                ..ProviderSettings::default()
            },
        )]))
        .await;
        let sid = svc
            .start_session(AgentStartSessionInput {
                preset: "Trader".into(),
                provider: CODEX.into(),
                model: None,
                effort: None,
                mode: None,
                title: None,
            })
            .await
            .unwrap()
            .id;
        Rig {
            svc,
            stub,
            store,
            sid,
        }
    }

    impl Rig {
        async fn send(&self, text: &str, delivery: Option<Delivery>) -> AgentSendOutput {
            self.svc
                .send_with(&self.sid, text, &[], None, None, delivery)
                .await
                .unwrap()
        }

        fn session(&self) -> AgentSessionSummary {
            self.store
                .sessions()
                .get(self.sid.as_str())
                .unwrap()
                .unwrap()
        }

        fn queue(&self) -> Vec<String> {
            self.session().queue.into_iter().map(|q| q.text).collect()
        }

        fn idle(&self) -> bool {
            self.session().status == AgentSessionStatus::Idle
        }

        fn asked(&self) -> Vec<(String, String)> {
            self.store
                .agent_events()
                .list(self.sid.as_str(), 0, 10_000)
                .unwrap()
                .into_iter()
                .filter_map(|e| match e.event {
                    AgentEvent::UserMessage { text, .. } => {
                        Some((text, e.turn_id.unwrap_or_default()))
                    }
                    _ => None,
                })
                .collect()
        }

        async fn asked_once(&self, text: &str) {
            settle(
                &format!("{text:?} is sent"),
                || self.stub.sent(),
                |sent| sent.iter().any(|t| t == text),
            )
            .await;
        }

        fn turns(&self) -> usize {
            self.store
                .agent_events()
                .list(self.sid.as_str(), 0, 10_000)
                .unwrap()
                .iter()
                .filter(|e| matches!(e.event, AgentEvent::TurnStarted { .. }))
                .count()
        }

        async fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
            settle(what, || (done(self), self.session()), |(done, _)| *done).await;
        }
    }

    #[tokio::test]
    async fn queued_messages_start_their_own_turns_in_order() {
        let r = rig(Stub::steering()).await;
        let first = r.send("How is NQ?", None).await;
        assert_eq!(first.delivered, Delivered::Turn);
        let t1 = first.turn_id.unwrap();
        let a = r.send("Then ES", Some(Delivery::Queue)).await;
        let b = r.send("Then CL", None).await;
        assert_eq!(
            (a.delivered, b.delivered),
            (Delivered::Queued, Delivered::Queued)
        );
        assert_eq!((a.turn_id, a.notice), (None, None));
        let ids: Vec<Option<String>> = r.session().queue.into_iter().map(|q| Some(q.id)).collect();
        assert_eq!(ids, [a.queued_id.clone(), b.queued_id.clone()]);
        assert_ne!(a.queued_id, b.queued_id);
        assert_eq!(r.queue(), ["Then ES", "Then CL"]);
        assert_eq!(
            r.stub.sent(),
            ["How is NQ?"],
            "nothing more goes while it runs"
        );

        r.stub.end(TurnEnd::Completed);
        r.until("Then ES starts", |r| r.stub.sent().len() == 2)
            .await;
        assert_eq!(r.stub.sent(), ["How is NQ?", "Then ES"]);
        assert_eq!(r.queue(), ["Then CL"]);
        let asked = r.asked();
        assert_eq!(asked.len(), 2);
        assert_eq!(asked[0], ("How is NQ?".to_owned(), t1.clone()));
        assert_eq!(asked[1].0, "Then ES");
        assert_ne!(asked[1].1, t1, "its own turn");
        assert_eq!(r.session().status, AgentSessionStatus::Running);

        r.stub.end(TurnEnd::Completed);
        r.until("Then CL starts", |r| r.stub.sent().len() == 3)
            .await;
        assert_eq!(r.stub.sent()[2], "Then CL");
        assert!(r.queue().is_empty());

        r.stub.end(TurnEnd::Completed);
        r.until("the session rests", Rig::idle).await;
        assert_eq!(r.turns(), 3);
        assert!(r.queue().is_empty());
        assert!(!r.session().queue_held);
        assert!(r.stub.steered().is_empty());
    }

    #[tokio::test]
    async fn a_queued_message_is_edited_or_removed_until_it_goes() {
        let r = rig(Stub::steering()).await;
        r.send("How is NQ?", None).await;
        let a = r.send("Then ES", None).await.queued_id.unwrap();
        let b = r.send("Then CL", None).await.queued_id.unwrap();
        let edited = r.svc.edit_queued(&r.sid, &a, "Then ES on the 5m").unwrap();
        assert_eq!(edited.queue[0].text, "Then ES on the 5m");
        assert_eq!(r.queue(), ["Then ES on the 5m", "Then CL"]);
        let err = r.svc.edit_queued(&r.sid, &a, "  ").unwrap_err();
        assert_eq!(err.code, ToolErrorCode::InvalidInput);
        assert_eq!(
            r.queue(),
            ["Then ES on the 5m", "Then CL"],
            "a refused edit changes nothing"
        );
        let left = r.svc.remove_queued(&r.sid, &b).unwrap();
        assert_eq!(left.queue.len(), 1);
        assert_eq!(r.queue(), ["Then ES on the 5m"]);
        assert_eq!(
            r.svc.remove_queued(&r.sid, &b).unwrap_err().code,
            ToolErrorCode::NotFound
        );

        r.stub.end(TurnEnd::Completed);
        r.until("the edited message goes", |r| r.stub.sent().len() == 2)
            .await;
        assert_eq!(r.stub.sent()[1], "Then ES on the 5m");
        for err in [
            r.svc.edit_queued(&r.sid, &a, "late").unwrap_err(),
            r.svc.remove_queued(&r.sid, &a).unwrap_err(),
        ] {
            assert_eq!(err.code, ToolErrorCode::NotFound);
            assert!(
                err.message.contains("already sent or removed"),
                "{}",
                err.message
            );
        }
    }

    #[tokio::test]
    async fn a_steer_lands_in_the_running_turn() {
        let r = rig(Stub::steering()).await;
        let t1 = r.send("How is NQ?", None).await.turn_id.unwrap();
        let out = r.send("Look at ES too", Some(Delivery::Steer)).await;
        assert_eq!(out.delivered, Delivered::Steered);
        assert_eq!(out.turn_id.as_deref(), Some(t1.as_str()));
        assert_eq!((out.queued_id, out.notice), (None, None));
        assert_eq!(r.stub.steered(), ["Look at ES too"]);
        assert_eq!(r.stub.sent(), ["How is NQ?"], "no second turn");
        assert_eq!(
            r.asked(),
            [
                ("How is NQ?".to_owned(), t1.clone()),
                ("Look at ES too".to_owned(), t1.clone())
            ]
        );
        assert!(r.queue().is_empty());
        r.stub.end(TurnEnd::Completed);
        r.until("the turn ends", Rig::idle).await;
        assert_eq!(r.turns(), 1);
        assert_eq!(r.stub.sent().len(), 1);
    }

    #[tokio::test]
    async fn a_provider_that_cannot_steer_queues_the_message_and_says_so() {
        let r = rig(Stub::default()).await;
        r.send("How is NQ?", None).await;
        let out = r.send("Look at ES too", Some(Delivery::Steer)).await;
        assert_eq!(out.delivered, Delivered::Queued);
        assert_eq!(
            out.notice.as_deref(),
            Some("Codex can't take messages mid-run, so it's queued for when this run ends.")
        );
        assert!(out.queued_id.is_some());
        assert_eq!(r.queue(), ["Look at ES too"]);
        assert!(r.stub.steered().is_empty());
        r.stub.end(TurnEnd::Completed);
        r.until("it goes once the turn ends", |r| r.stub.sent().len() == 2)
            .await;
        assert_eq!(r.stub.sent(), ["How is NQ?", "Look at ES too"]);
        assert!(r.queue().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn stop_and_a_failed_turn_hold_the_queue_until_resumed() {
        let r = rig(Stub::steering()).await;
        r.send("How is NQ?", None).await;
        r.send("Then ES", None).await;
        r.send("Then CL", None).await;
        assert!(r.svc.interrupt(&r.sid).await.unwrap());
        r.stub.end(TurnEnd::Interrupted);
        r.until("the turn stops", Rig::idle).await;
        assert!(r.session().queue_held);
        assert_eq!(r.queue(), ["Then ES", "Then CL"]);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(r.stub.sent(), ["How is NQ?"], "nothing starts by itself");

        let resumed = r.svc.resume_queue(&r.sid).await.unwrap();
        assert!(!resumed.queue_held);
        r.until("Then ES starts", |r| r.stub.sent().len() == 2)
            .await;
        assert_eq!(r.stub.sent()[1], "Then ES");
        assert_eq!(r.queue(), ["Then CL"]);
        assert!(!r.session().queue_held);

        r.stub.end(TurnEnd::Failed);
        r.until("the turn fails", Rig::idle).await;
        assert!(r.session().queue_held, "a failed turn holds the rest");
        assert_eq!(r.queue(), ["Then CL"]);

        let fresh = r.send("What now?", Some(Delivery::Steer)).await;
        assert_eq!(
            fresh.delivered,
            Delivered::Turn,
            "a held queue lets the user go on"
        );
        r.stub.end(TurnEnd::Completed);
        r.until("that turn ends", Rig::idle).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(r.stub.sent(), ["How is NQ?", "Then ES", "What now?"]);
        assert!(r.session().queue_held, "only the user resumes it");
        assert_eq!(r.queue(), ["Then CL"]);
    }

    #[tokio::test]
    async fn an_idle_session_starts_a_turn_however_it_is_sent() {
        let r = rig(Stub::steering()).await;
        for (i, delivery) in [None, Some(Delivery::Steer), Some(Delivery::Queue)]
            .into_iter()
            .enumerate()
        {
            let out = r.send("How is NQ?", delivery).await;
            assert_eq!(out.delivered, Delivered::Turn, "{delivery:?}");
            assert!(out.turn_id.is_some());
            assert_eq!(r.stub.sent().len(), i + 1);
            r.stub.end(TurnEnd::Completed);
            r.until("the turn ends", Rig::idle).await;
        }
        assert!(r.stub.steered().is_empty());
        assert!(r.queue().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn each_turn_the_provider_ran_is_reported_once_it_ends() {
        let r = rig(Stub::default()).await;
        let reports = Arc::new(Mutex::new(Vec::<TurnReport>::new()));
        let seen = Arc::clone(&reports);
        r.svc
            .set_turn_sink(Arc::new(move |report| lock(&seen).push(report)));
        let count = || lock(&reports).len();

        r.send("How is NQ?", None).await;
        r.stub.emit(ProviderEvent::Error {
            message: "Codex's usage limit is reached".into(),
        });
        let spent = TurnUsage {
            input_tokens: 1_200,
            output_tokens: 80,
            cached_input_tokens: 1_000,
            reasoning_tokens: 30,
        };
        r.stub.emit(ProviderEvent::TurnEnded {
            end: TurnEnd::Failed,
            error: None,
            usage: Some(spent),
        });
        r.until("the first turn is reported", |_| count() == 1)
            .await;

        r.svc
            .send_with(
                &r.sid,
                "And ES?",
                &[],
                Some("gpt-5.5".into()),
                Some("high".into()),
                None,
            )
            .await
            .unwrap();
        r.stub.end(TurnEnd::Completed);
        r.until("the second turn is reported", |_| count() == 2)
            .await;
        r.stub.end(TurnEnd::Completed);
        tokio::time::sleep(Duration::from_millis(100)).await;

        let got = lock(&reports).clone();
        assert_eq!(got.len(), 2, "an end with no turn running reports nothing");
        assert!(got.iter().all(|g| !g.latency.is_zero()));
        let report = |i: usize| TurnReport {
            session: r.sid.clone(),
            provider: CODEX.into(),
            model: None,
            effort: None,
            latency: got[i].latency,
            end: TurnEnd::Completed,
            error: None,
            usage: None,
        };
        assert_eq!(
            got[0],
            TurnReport {
                end: TurnEnd::Failed,
                error: Some("Codex's usage limit is reached".into()),
                usage: Some(spent),
                ..report(0)
            },
            "a failed turn carries the error its provider streamed"
        );
        assert_eq!(
            got[1],
            TurnReport {
                model: Some("gpt-5.5".into()),
                effort: Some("high".into()),
                ..report(1)
            }
        );
    }

    #[tokio::test]
    async fn a_provider_without_pdfs_refuses_one_naming_it() {
        use tessera_protocol::agent::AgentUploadAttachmentInput;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_in_memory().unwrap();
        let svc = AgentService::new(
            store.clone(),
            Arc::new(EventBus::new()),
            Arc::new(SystemClock),
            Arc::new(McpPrincipals::new()),
            vec![Arc::new(Stub::default()) as Arc<dyn AgentProvider>],
        )
        .with_attachments(AttachmentStore::open(dir.path()).unwrap());
        let mut s = summary("S1");
        s.provider = CODEX.into();
        store.sessions().upsert(&s).unwrap();
        let up = |name: &str, data: &[u8]| {
            svc.attachments()
                .unwrap()
                .upload(
                    &AgentUploadAttachmentInput {
                        name: name.into(),
                        mime_type: String::new(),
                        size_bytes: data.len() as u64,
                        data_base64: tessera_core::b64::encode(data),
                        upload_id: None,
                        offset: None,
                    },
                    tessera_core::Timestamp(0),
                )
                .unwrap()
                .attachment
                .unwrap()
        };
        let pdf = up("report.pdf", b"%PDF-1.7\n");
        let txt = up("notes.txt", b"levels\n");
        let err = svc
            .resolve_attachments(&s.id, &[txt.clone(), pdf])
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Codex does not read PDFs: remove report.pdf, or ask in a Claude Code session"
        );
        assert_eq!(
            svc.resolve_attachments(&s.id, &[txt]).await.unwrap().len(),
            1
        );
    }

    #[test]
    fn a_session_is_titled_by_its_first_message() {
        assert_eq!(title_from("\n  How is NQ doing?\nmore"), "How is NQ doing?");
        let long =
            "Test whether QQQ tends to revert after touching Max +Gamma on days when the open gaps";
        let t = title_from(long);
        assert!(t.ends_with('…') && t.chars().count() <= 61, "{t}");
        assert!(!t.contains("  "));
    }

    #[test]
    fn sessions_left_running_by_a_restart_are_idle() {
        let store = Store::open_in_memory().unwrap();
        let mut s = summary("S2");
        s.status = AgentSessionStatus::Running;
        store.sessions().upsert(&s).unwrap();
        let _svc = AgentService::new(
            store.clone(),
            Arc::new(EventBus::new()),
            Arc::new(SystemClock),
            Arc::new(McpPrincipals::new()),
            Vec::new(),
        );
        assert_eq!(
            store.sessions().get("S2").unwrap().unwrap().status,
            AgentSessionStatus::Idle
        );
    }

    #[test]
    fn a_queue_left_by_a_restart_waits_for_the_user() {
        let store = Store::open_in_memory().unwrap();
        let mut s = summary("S3");
        s.queue = vec![QueuedMessage {
            id: "q1".into(),
            text: "Then ES".into(),
            attachments: Vec::new(),
            queued_at: Timestamp(0),
        }];
        store.sessions().upsert(&s).unwrap();
        store.sessions().upsert(&summary("S4")).unwrap();
        let _svc = AgentService::new(
            store.clone(),
            Arc::new(EventBus::new()),
            Arc::new(SystemClock),
            Arc::new(McpPrincipals::new()),
            Vec::new(),
        );
        let back = store.sessions().get("S3").unwrap().unwrap();
        assert!(back.queue_held);
        assert_eq!(back.queue, s.queue);
        assert!(
            !store.sessions().get("S4").unwrap().unwrap().queue_held,
            "an empty queue holds nothing"
        );
    }

    #[test]
    fn tool_previews_are_cut_at_a_character() {
        assert_eq!(cut("héllo".into(), 2), "h…");
        assert_eq!(cut("ok".into(), 10), "ok");
        let big = json!({"code": "x".repeat(ARGS_MAX)});
        assert!(args_preview(&big).is_string());
        assert_eq!(args_preview(&json!({"a": 1})), json!({"a": 1}));
    }

    #[tokio::test]
    async fn one_answer_comes_from_a_hidden_thread_with_no_tools_and_no_session() {
        let r = rig(Stub::default()).await;
        let sessions = r.store.sessions().list().unwrap().len();
        assert_eq!(r.svc.first_ready(), Some(CODEX));
        let svc = Arc::clone(&r.svc);
        let asked = tokio::spawn(async move {
            svc.answer_once(
                CODEX,
                "Answer with JSON.",
                "write it up".into(),
                Duration::from_secs(5),
            )
            .await
        });
        r.asked_once("write it up").await;
        r.stub.emit(ProviderEvent::Message {
            message_id: "m1".into(),
            text: "thinking".into(),
        });
        r.stub.emit(ProviderEvent::Message {
            message_id: "m2".into(),
            text: "{\"title\": \"x\"}".into(),
        });
        r.stub.end(TurnEnd::Completed);
        let a = asked.await.unwrap().unwrap();
        assert_eq!(a.text, "{\"title\": \"x\"}");
        assert_eq!(a.provider_name, "Codex");
        assert_eq!(
            r.store.sessions().list().unwrap().len(),
            sessions,
            "no session kept"
        );

        let svc = Arc::clone(&r.svc);
        let failed = tokio::spawn(async move {
            svc.answer_once(CODEX, "", "again".into(), Duration::from_secs(5))
                .await
        });
        r.asked_once("again").await;
        r.stub.end(TurnEnd::Failed);
        assert!(failed.await.unwrap().is_err());
    }

    fn invoker(limits: tessera_tools::LoopLimits) -> Arc<tessera_tools::Invoker> {
        Arc::new(tessera_tools::Invoker::new(
            Arc::new(tessera_tools::ToolRegistry::new()),
            Arc::new(tessera_tools::NullObserver),
            Arc::new(SystemClock),
            tessera_tools::InvokerConfig {
                limits,
                ..tessera_tools::InvokerConfig::default()
            },
        ))
    }

    #[tokio::test]
    async fn a_deleted_session_takes_its_approvals_with_it() {
        let r = rig(Stub::steering()).await;
        let inv = invoker(tessera_tools::LoopLimits::default());
        r.svc.attach_invoker(Arc::clone(&inv));
        let asked = inv.approvals().create(
            tessera_tools::approvals::NewApproval {
                kind: tessera_protocol::tools::ApprovalKind::Financial,
                origin: AgentService::origin(&r.session()),
                call_id: tessera_core::ids::CallId::generate(),
                tool: "orders.submit".into(),
                risk: tessera_protocol::tools::RiskTier::Financial,
                input: serde_json::json!({"qty": 1}),
                preview: serde_json::json!({"restatement": "BUY 1 NQ MKT"}),
                draft_id: None,
                environment: None,
                instrument: None,
                replaces: None,
            },
            r.svc.now(),
        );
        assert!(r.svc.delete(&r.sid).await.unwrap());
        assert_eq!(
            inv.approvals().get(&asked.id).unwrap().status,
            tessera_protocol::tools::ApprovalStatus::Cancelled
        );
        assert!(inv.approvals().pending().is_empty());
    }

    #[tokio::test]
    async fn a_turn_past_its_step_limit_is_stopped_by_the_loop_guard() {
        let r = rig(Stub::steering()).await;
        r.svc.attach_invoker(invoker(tessera_tools::LoopLimits {
            max_steps_per_turn: 2,
            ..tessera_tools::LoopLimits::default()
        }));
        r.send("Watch NQ", None).await;
        r.asked_once("Watch NQ").await;
        for n in 0..3 {
            r.stub.emit(ProviderEvent::Message {
                message_id: format!("m{n}"),
                text: format!("step {n}"),
            });
        }
        r.until("the turn ends", Rig::idle).await;
        let ends: Vec<TurnEnd> = r
            .store
            .agent_events()
            .list(r.sid.as_str(), 0, 10_000)
            .unwrap()
            .into_iter()
            .filter_map(|e| match e.event {
                AgentEvent::TurnFinished { end, .. } => Some(end),
                _ => None,
            })
            .collect();
        assert_eq!(ends, [TurnEnd::LoopGuard]);

        r.send("Again", None).await;
        r.asked_once("Again").await;
        r.stub.emit(ProviderEvent::Message {
            message_id: "n0".into(),
            text: "a new turn counts from zero".into(),
        });
        r.stub.end(TurnEnd::Completed);
        r.until("the next turn ends", Rig::idle).await;
    }

    #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    struct Symbol {
        symbol: String,
    }

    struct SetSymbol;

    #[async_trait::async_trait]
    impl tessera_tools::Tool for SetSymbol {
        type Input = Symbol;
        type Output = serde_json::Value;
        fn meta(&self) -> tessera_tools::ToolMeta {
            tessera_tools::ToolMeta::new(
                "chart.set_symbol",
                "Set symbol",
                tessera_protocol::tools::RiskTier::Modify,
            )
        }
        async fn call(
            &self,
            _ctx: &tessera_tools::ToolCtx,
            input: Symbol,
        ) -> Result<serde_json::Value, ToolError> {
            Ok(serde_json::json!({ "set": input.symbol }))
        }
    }

    async fn supervised(r: &Rig) -> Arc<tessera_tools::Invoker> {
        let mut registry = tessera_tools::ToolRegistry::new();
        registry.register(SetSymbol).unwrap();
        let inv = Arc::new(tessera_tools::Invoker::new(
            Arc::new(registry),
            Arc::new(tessera_tools::NullObserver),
            Arc::new(SystemClock),
            tessera_tools::InvokerConfig::default(),
        ));
        r.svc.attach_invoker(Arc::clone(&inv));
        r.svc.set_mode(&r.sid, SessionMode::Supervised).unwrap();
        inv
    }

    async fn ask_approval(r: &Rig, inv: &tessera_tools::Invoker) -> tessera_core::ids::ApprovalId {
        let asked = inv
            .invoke(tessera_tools::InvokeRequest::new(
                "chart.set_symbol",
                serde_json::json!({"symbol": "ES"}),
                AgentService::origin(&r.session()),
            ))
            .await;
        assert_eq!(asked.status, ToolOutcome::PendingApproval, "{asked:?}");
        asked.approval.unwrap().approval_id
    }

    fn session_status(r: &Rig) -> AgentSessionStatus {
        r.session().status
    }

    #[tokio::test]
    async fn an_approval_resolved_mid_turn_hands_the_session_back_to_its_turn() {
        let r = rig(Stub::steering()).await;
        let inv = supervised(&r).await;
        r.send("Switch to ES", None).await;
        r.asked_once("Switch to ES").await;
        let id = ask_approval(&r, &inv).await;
        r.until("the session waits for the user", |r| {
            session_status(r) == AgentSessionStatus::NeedsYou
        })
        .await;
        let a = inv.approvals().get(&id).unwrap();
        inv.resolve(
            &tessera_protocol::methods::ApprovalsResolveParams {
                approval_id: id,
                decision: tessera_protocol::tools::ApprovalDecision::Reject,
                preview_hash: a.preview_hash,
                note: None,
                input: None,
                deadline: None,
                idempotency_key: None,
            },
            &Origin::User,
        )
        .await
        .unwrap();
        r.until("the turn runs on", |r| {
            session_status(r) == AgentSessionStatus::Running
        })
        .await;
        r.stub.end(TurnEnd::Completed);
        r.until("the turn ends", Rig::idle).await;
    }

    #[tokio::test]
    async fn a_turn_that_ends_with_an_approval_pending_still_needs_the_user() {
        let r = rig(Stub::steering()).await;
        let inv = supervised(&r).await;
        r.send("Switch to ES", None).await;
        r.asked_once("Switch to ES").await;
        ask_approval(&r, &inv).await;
        r.stub.end(TurnEnd::Completed);
        r.until("the turn ends", |r| !r.svc.answering(&r.sid)).await;
        assert_eq!(session_status(&r), AgentSessionStatus::NeedsYou);
        inv.close(&AgentService::origin(&r.session()));
        r.until("nothing is waiting any more", Rig::idle).await;
    }

    #[tokio::test]
    async fn full_access_does_not_survive_a_restart() {
        let r = rig(Stub::steering()).await;
        r.svc.set_mode(&r.sid, SessionMode::FullAccess).unwrap();
        let restarted = Arc::new(AgentService::new(
            r.store.clone(),
            Arc::new(EventBus::new()),
            Arc::new(SystemClock),
            Arc::new(McpPrincipals::new()),
            vec![Arc::clone(&r.stub) as Arc<dyn AgentProvider>],
        ));
        restarted.set_mcp_url("http://127.0.0.1:9/mcp".into());
        restarted
            .configure(HashMap::from([(
                CODEX.to_owned(),
                ProviderSettings {
                    enabled: true,
                    ..ProviderSettings::default()
                },
            )]))
            .await;
        restarted
            .post_card(
                &r.sid,
                serde_json::from_value(serde_json::json!({
                    "id": "card-NQ",
                    "body": {"kind": "data_coverage", "symbol": "NQ", "scope": "rth", "from": "2026-10-01", "to": "2026-10-02", "days": []},
                    "updatedAt": 1
                }))
                .unwrap(),
            )
            .unwrap();
        restarted
            .send_with(&r.sid, "Go on", &[], None, None, None)
            .await
            .unwrap();
        r.asked_once("Go on").await;
        assert_eq!(r.session().mode, restarted.default_mode());
        assert_ne!(r.session().mode, SessionMode::FullAccess);
    }
}
