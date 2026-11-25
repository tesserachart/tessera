use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::{Timeframe, Timestamp};
use ts_rs::TS;

use crate::io::OpenTileKind;

/// The areas of the window's rail (decision 0011 §1): the desk with its charts, and the pages over it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UiArea {
    /// The desk: charts, Trade, the analyst, Positions and Accounts.
    Desk,
    /// Markets: every instrument the connections serve, the watchlists, and an instrument's detail.
    Markets,
    /// Agents: the analyst's sessions at full size.
    Agents,
    /// Indicators: the indicator library and custom indicators.
    Indicators,
    /// Research: studies and backtests.
    Research,
    /// Journal: the trade log and its analytics.
    Journal,
    /// The Trade copier: its copy groups, each leader's followers and whether each holds its size.
    Copy,
    /// Settings: every preference, at the rail's foot.
    Settings,
    /// Profile: the person's Tessera account (who is signed in, their alpha access, sign out), under Settings; only
    /// in a build with accounts.
    Profile,
}

impl UiArea {
    pub const ALL: [Self; 9] = [
        Self::Desk,
        Self::Markets,
        Self::Agents,
        Self::Indicators,
        Self::Research,
        Self::Journal,
        Self::Copy,
        Self::Settings,
        Self::Profile,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desk => "desk",
            Self::Markets => "markets",
            Self::Agents => "agents",
            Self::Indicators => "indicators",
            Self::Research => "research",
            Self::Journal => "journal",
            Self::Copy => "copy",
            Self::Settings => "settings",
            Self::Profile => "profile",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct UiShowAreaInput {
    /// `desk`, `markets`, `agents`, `indicators`, `research`, `journal`, `copy`, `settings` or `profile`.
    pub area: UiArea,
    /// What the area opens on. `settings`: a page (`connections`, `trading`, `chart`, `alerts`, `analyst`, `data`,
    /// `app`) or one setting's row id (`trading.commission`), brought into view; `connections.<connection id>` opens
    /// one connection (an id from connections.list), `connections.add.rithmic` and `connections.add.spec` an add
    /// form, `connections.exchanges` the section by exchange.
    /// `markets`: an instrument id or symbol, selected (its detail shown). `agents`: a session id
    /// (agent.list_sessions). `indicators`: an indicator id (a built-in kind such as `ema`, or a custom indicator's id
    /// from indicators.list). `research`: a run id (research.list_runs), or a study id (research.list_studies) for
    /// its newest run. Not for the desk, the profile, copy or the journal (`journal` says where the journal opens).
    #[serde(default)]
    pub item: Option<String>,
    /// `journal`: where the Journal opens and what it shows (only the fields given change).
    #[serde(default)]
    pub journal: Option<JournalView>,
    /// `markets`: which list the Markets area shows and how (only the fields given change; `item` wins for the
    /// instrument).
    #[serde(default)]
    pub markets: Option<MarketsView>,
}

/// A list of the Markets area.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MarketsList {
    /// Every instrument the connections serve.
    All,
    /// A watchlist of the user's (`watchlist` names which; markets.watchlists).
    Watchlist,
    Futures,
    /// Indices and ETFs.
    Index,
    Stocks,
    Crypto,
    /// What fits none of the others.
    Other,
    /// The symbols the user charted last.
    Recent,
    /// The instruments the user holds a position in.
    Positions,
}

/// What the Markets area shows (`ui.show_area` `markets`, and the `ui.view` setting's `markets`, which the window
/// keeps up to date as the user moves around it). In `ui.show_area`, only the fields given change; `""` clears a
/// text field.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct MarketsView {
    /// The list shown.
    #[serde(default)]
    pub list: Option<MarketsList>,
    /// The watchlist shown when `list` is `watchlist` (an id from watchlists.list); giving it shows that list.
    #[serde(default)]
    pub watchlist: Option<String>,
    /// Only this connection's instruments (a connection id, as market.list_instruments lists them); `""`: every
    /// connection.
    #[serde(default)]
    pub connection: Option<String>,
    /// The search text (`""` clears it).
    #[serde(default)]
    pub query: Option<String>,
    /// Only what is moving, the biggest absolute % change first.
    #[serde(default)]
    pub moving: Option<bool>,
    /// The instrument selected, its detail shown (an id or symbol; `""`: none).
    #[serde(default)]
    pub instrument: Option<String>,
}

/// A section of the Journal area.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JournalSection {
    /// The stat strip, equity, today's trades, the calendar and the setups.
    Overview,
    /// The trades list (and a trade's page over it).
    Trades,
    /// The daily journal: a day's entry, its checklist and trades.
    Days,
    /// The reports: overview, time, risk, breakdowns, behaviour.
    Reports,
    /// The setups and their rules.
    Playbooks,
    /// CSV imports and trades logged by hand.
    Import,
    /// Tags, the checklist, the breakeven band, the time zone and the sessions.
    Settings,
}

/// A tab of the Journal's analytics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JournalReportTab {
    /// The headline, equity, outcomes and the R histogram.
    Overview,
    /// Days, weekdays, entry hours, sessions, months, time held.
    Time,
    /// Drawdowns, planned R:R, position size.
    Risk,
    /// Each symbol's figures, its share of trades or P&L, its curve month by month.
    Symbols,
    /// Every grouping (`groupBy`).
    Breakdowns,
    /// Runs, after a win or a loss, trades per day, mood.
    Behaviour,
}

/// The range every Journal section reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
pub enum JournalRange {
    /// This week.
    #[serde(rename = "week")]
    Week,
    /// This month.
    #[serde(rename = "month")]
    Month,
    /// The last 30 days.
    #[serde(rename = "30d")]
    Days30,
    /// The last 90 days.
    #[serde(rename = "90d")]
    Days90,
    #[serde(rename = "ytd")]
    YearToDate,
    /// Everything.
    #[serde(rename = "all")]
    All,
}

/// What the Journal area shows (`ui.show_area` `journal`, and the `ui.view` setting's `journal`, which the window keeps
/// up to date as the user moves around it).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct JournalView {
    /// The section shown.
    #[serde(default)]
    pub section: Option<JournalSection>,
    /// A trade open on its page (journal.list_trades ids; shows over the trades list); null closes it.
    #[serde(default)]
    pub trade_id: Option<String>,
    /// The day the daily journal shows (`YYYY-MM-DD`; null: today).
    #[serde(default)]
    pub date: Option<String>,
    /// The setup open in Playbooks (journal.get_catalog setups).
    #[serde(default)]
    pub setup_id: Option<String>,
    /// The reports' tab.
    #[serde(default)]
    pub report_tab: Option<JournalReportTab>,
    /// What the Breakdowns tab groups by: symbol, setup, tag, account, side, result, emotion, hold, size, session,
    /// week or month.
    #[serde(default)]
    pub group_by: Option<String>,
    /// The account every section reads (an account id, or `all`).
    #[serde(default)]
    pub account: Option<String>,
    /// The range every section reads.
    #[serde(default)]
    pub range: Option<JournalRange>,
    /// The trades list's and the reports' finer filter, as journal.list_trades takes it (symbols, setups, tags,
    /// side, outcome, how it ended, reviewed, weekdays, hours, sessions, P&L and R ranges, moods, search); `{}`
    /// clears it.
    #[serde(default)]
    pub filter: Option<Value>,
    /// The trades list's sort (a journal.list_trades sort key: opened, closed, symbol, pnl, r, hold, rating…).
    #[serde(default)]
    pub sort: Option<String>,
    /// The sort ascending.
    #[serde(default)]
    pub ascending: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiShowAreaOutput {
    /// The area shown now.
    pub area: UiArea,
    /// The area shown before.
    pub previous: Option<UiArea>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiShowWorkspaceInput {
    /// The workspace (layout id, from `layout.list`) the desk shows.
    pub layout_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiShowWorkspaceOutput {
    /// The workspace shown now.
    pub layout_id: String,
    /// The workspace shown before (null: the default one).
    pub previous: Option<String>,
}

/// What `workspace.apply_preset` applies: a chart arrangement of the workspace shown, a story (a new workspace made
/// from it), or the workspace's own layout again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
pub enum WorkspacePreset {
    /// One chart.
    #[serde(rename = "1")]
    One,
    /// Two charts side by side.
    #[serde(rename = "2h")]
    TwoSideBySide,
    /// Two charts stacked.
    #[serde(rename = "2v")]
    TwoStacked,
    /// Three: one chart beside two stacked.
    #[serde(rename = "3")]
    Three,
    /// Four: 2 × 2.
    #[serde(rename = "4")]
    Four,
    /// Six: 3 × 2.
    #[serde(rename = "6")]
    Six,
    /// Story Trade: one chart, Trade beside it (a new workspace).
    #[serde(rename = "trade")]
    Trade,
    /// Story Scalp: 1m order flow, Trade, DOM and time & sales (a new workspace).
    #[serde(rename = "scalp")]
    Scalp,
    /// Story Analyse: 1h and 5m side by side, linked (a new workspace).
    #[serde(rename = "analyse")]
    Analyse,
    /// Story Review: the chart over the session's record (a new workspace).
    #[serde(rename = "review")]
    Review,
    /// The workspace's layout rebuilt as its story (or the default) has it; its charts stay as they are.
    #[serde(rename = "reset")]
    Reset,
}

impl WorkspacePreset {
    pub fn charts(self) -> Option<usize> {
        match self {
            Self::One => Some(1),
            Self::TwoSideBySide | Self::TwoStacked => Some(2),
            Self::Three => Some(3),
            Self::Four => Some(4),
            Self::Six => Some(6),
            _ => None,
        }
    }

    pub fn story(self) -> bool {
        matches!(
            self,
            Self::Trade | Self::Scalp | Self::Analyse | Self::Review
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::One => "1",
            Self::TwoSideBySide => "2h",
            Self::TwoStacked => "2v",
            Self::Three => "3",
            Self::Four => "4",
            Self::Six => "6",
            Self::Trade => "trade",
            Self::Scalp => "scalp",
            Self::Analyse => "analyse",
            Self::Review => "review",
            Self::Reset => "reset",
        }
    }
}

/// What a [`DockRequest`] asks the desk to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DockOp {
    /// Close a tile; it comes back where it was when opened again (a chart goes with its drawings).
    Close,
    /// Show a tile: the visible tab of its group, its edge opened; a chart becomes the active chart.
    Focus,
    /// Apply a [`WorkspacePreset`].
    Preset,
    /// Change a tile's own settings.
    Settings,
    /// Move a tile to an edge, the centre, or float it.
    Move,
    /// Open or collapse the edges, share the interval between the charts, focus mode.
    View,
    /// Maximize a tile over the desk, or restore it.
    Maximize,
    /// Move a chart's view: a time span, the last bars, every bar, a price range or the automatic scale.
    Viewport,
    /// Undo or redo a chart's last drawing edit (the desk keeps the history).
    Drawings,
    /// Change a chart's Trade panel setup (the account, size and bracket its Trade panel and DOM trade with); only
    /// ever asked once the user allowed it.
    Trade,
}

/// One change the desk is asked to make to a layout's dock, kept in the layout's dock value (`dock.tessera.ops`)
/// until a desk showing the layout has made it and saved its dock.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DockRequest {
    /// The request's id, unique in its layout (`op-<revision>`: the desk takes `open` and `ops` requests in
    /// revision order); `area-markets` when Markets, an area now, was shown instead and nothing waits in the dock.
    pub id: String,
    /// What to do.
    pub op: DockOp,
    /// `close`, `focus`, `settings`: the tile, by its panel id; null: the tile of `kind`.
    pub tile_id: Option<String>,
    /// `close`, `focus`: the kind whose tile is meant when no `tileId` is given (the one of an edge's kind, else
    /// the active chart or the first of the kind).
    pub kind: Option<OpenTileKind>,
    /// `preset`: what to apply.
    pub preset: Option<WorkspacePreset>,
    /// `settings`: the fields to change, merged into the tile's own (validated by the runtime for its kind).
    /// `view`: `left`, `right`, `bottom` (true: open, false: collapsed), `shareInterval` and `focus` (bool), each
    /// optional. `maximize`: `{restore: bool}`.
    /// `viewport`: `from`, `to` (ns), `lastBars`, `fitAll`, `priceMin`, `priceMax`, `autoScale`. `drawings`:
    /// `{action: undo|redo}`. `trade`: the Trade panel fields to change (`trade.set_panel`).
    pub settings: Option<Value>,
    /// `move`: where the tile goes (`left`, `right`, `bottom`, `centre`, `floating`).
    #[serde(default)]
    pub place: Option<TilePlace>,
}

/// `workspace.close_tile` and `workspace.focus_tile` input: a tile by its id, or by its kind.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceTileInput {
    /// The tile's id (`workspace.list_tiles`; a chart's is its `chart-N` tile id).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Or its kind: the one panel of a kind there is one of (`trade`, `analyst`, `positions`, `accounts`, `alerts`,
    /// `journal`, `indicators`, `copy`), else the active chart (`chart`) or the first of the kind (`dom`, `tape`).
    /// `markets` is an area now (ui.show_area {area: markets}): focus_tile with it shows the Markets area.
    #[serde(default)]
    pub kind: Option<OpenTileKind>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceApplyPresetInput {
    /// An arrangement of the workspace's charts (`1`, `2h`, `2v`, `3`, `4`, `6`), a story that makes a new workspace
    /// (`trade`, `scalp`, `analyse`, `review`), or `reset` (the workspace's layout rebuilt).
    pub preset: WorkspacePreset,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceSetTileSettingsInput {
    /// The tile's id (`workspace.list_tiles`).
    pub tile_id: String,
    /// The fields to change; the others keep their value. A DOM (`dom`): `rowTicks` 1|2|4|5|10, `volumeColumn`
    /// session|recent|off, `traded` session|recent|off, `pullStack` 0|5|10|30, `orders`, `refills`, `queue`, `pnl` and
    /// `autoCentre` bool, `link` 1–4|null, `instrument` id or symbol|null. Time & sales (`tape`):
    /// `minSize` ≥ 0 (0 every print), `highlight` auto|size > 0, `side` all|buy|sell, `speed` slow|medium|fast|live
    /// (paced rows, at most 2 s behind; live the default), `aggregate` bool (one row per aggressor order), `millis`
    /// bool, `link`, `instrument`. Positions (`positions`): `account`.
    pub settings: Value,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceMoveTileInput {
    /// The tile's id (`workspace.list_tiles`).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Or its kind (as `workspace.close_tile` takes it).
    #[serde(default)]
    pub kind: Option<OpenTileKind>,
    /// Where it goes: `left`, `right`, `bottom` (an edge, opened), `centre` (beside the active chart) or `floating`
    /// (over the desk, 640 × 480).
    pub to: TilePlace,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

/// `workspace.set_view` input: each field given changes, the others stay.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceSetViewInput {
    /// The left edge (empty by default: it holds what the user moved there) open (true) or collapsed to its strip
    /// (false).
    #[serde(default)]
    pub left: Option<bool>,
    /// The right edge (Trade and the analyst, as tabs, in a fresh workspace) open or collapsed.
    #[serde(default)]
    pub right: Option<bool>,
    /// The bottom edge (Positions and Accounts in a fresh workspace) open or collapsed.
    #[serde(default)]
    pub bottom: Option<bool>,
    /// The charts share their interval: a change on one applies to all (turning it on gives them the active chart's).
    #[serde(default)]
    pub share_interval: Option<bool>,
    /// Focus mode (⌥⌘F): every edge collapses for now; off puts each back as it was. Not saved.
    #[serde(default)]
    pub focus: Option<bool>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceMaximizeTileInput {
    /// The tile's id (`workspace.list_tiles`; a chart's `chart-N`).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Or its kind (`chart`: the active chart).
    #[serde(default)]
    pub kind: Option<OpenTileKind>,
    /// Restore the tile to its place among the others instead.
    #[serde(default)]
    pub restore: Option<bool>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

/// `chart.set_viewport` input: what the chart shows. One way of placing the time axis (`from`/`to`, `lastBars` or
/// `fitAll`), and the price axis (`priceMin` with `priceMax`, or `autoScale`), each optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetViewportInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The first bar time to show (with `to`).
    #[serde(default)]
    pub from: Option<Timestamp>,
    /// The last bar time to show (with `from`; default: now).
    #[serde(default)]
    pub to: Option<Timestamp>,
    /// Show the last this many bars, following new ones (1–5000).
    #[serde(default)]
    pub last_bars: Option<u32>,
    /// Show every bar the chart holds.
    #[serde(default)]
    pub fit_all: Option<bool>,
    /// The price axis from this price (with `priceMax`): the scale stops following the bars.
    #[serde(default)]
    pub price_min: Option<f64>,
    /// The price axis to this price (with `priceMin`).
    #[serde(default)]
    pub price_max: Option<f64>,
    /// The price axis follows the bars in view again (as a double-click on the price axis).
    #[serde(default)]
    pub auto_scale: Option<bool>,
}

/// `chart.set_viewport` output: the request the desk takes, and the view the chart then shows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartSetViewportOutput {
    /// Layout id.
    pub layout_id: String,
    /// New revision.
    #[ts(type = "number")]
    pub revision: u64,
    /// The request as the desk takes it.
    pub request: DockRequest,
    /// What the chart shows once it has placed the view: its first and last bar, how many bars, and `short`, why
    /// it shows less than was asked. Absent when the chart did not answer in time (it is not on screen, or is still
    /// reading older bars): chart.get_chart's viewport has it later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shown: Option<crate::layout::Viewport>,
}

/// `chart.undo_drawing` and `chart.redo_drawing` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartDrawingHistoryInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceCreateInput {
    /// Its name (default `Workspace N`).
    #[serde(default)]
    pub name: Option<String>,
    /// Its chart's instrument, id or symbol. Default: the instrument last charted, or the market.defaultInstrument
    /// setting when set; with neither, the workspace opens with no chart.
    #[serde(default)]
    pub instrument: Option<String>,
    /// Its chart's interval (default: the chart.defaultTimeframe setting).
    #[serde(default)]
    pub timeframe: Option<Timeframe>,
    /// Show it on the desk (default true).
    #[serde(default)]
    pub show: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceDuplicateInput {
    /// The workspace to copy (default: the one the desk shows, else the default one).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The copy's name (default `<name> copy`).
    #[serde(default)]
    pub name: Option<String>,
    /// Show the copy on the desk (default true).
    #[serde(default)]
    pub show: Option<bool>,
}

/// `workspace.create` and `workspace.duplicate` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreatedOutput {
    /// The new workspace's id.
    pub layout_id: String,
    /// Its name.
    pub name: String,
    /// Whether the desk shows it now.
    pub shown: bool,
}

/// The output of the tools that ask the desk for a change to the dock.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDockOutput {
    /// Layout id.
    pub layout_id: String,
    /// New revision.
    #[ts(type = "number")]
    pub revision: u64,
    /// The request as the desk takes it.
    pub request: DockRequest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceListTilesInput {
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
}

/// Where a tile is on the desk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TilePlace {
    /// The grid in the middle, with the charts.
    Centre,
    /// The left edge.
    Left,
    /// The right edge.
    Right,
    /// The bottom edge.
    Bottom,
    /// Floating over the desk.
    Floating,
    /// In its own window.
    Popout,
}

/// One tile of a workspace, as its saved dock holds it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TileInfo {
    /// Its id (the panel's).
    pub tile_id: String,
    /// Its kind (`chart`, `trade`, `analyst`, `positions`, `accounts`, `dom`, `tape`, `journal`, or a kind of
    /// another build: an older desk's `markets`).
    pub kind: String,
    /// Its tab's title.
    pub title: String,
    /// Where it is.
    pub place: TilePlace,
    /// Its tab is the one its group shows, and its edge is open.
    pub visible: bool,
    /// The pane (dockview group) it is a tab of: tiles with the same `group` are tabs of one pane. Absent in its
    /// own window, or before the desk saved a tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group: Option<String>,
    /// Its own settings (a DOM's row size, a tape's filters, a link), as saved.
    pub params: Value,
}

/// `workspace.list_tiles` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTilesOutput {
    /// Layout id.
    pub layout_id: String,
    /// Revision.
    #[ts(type = "number")]
    pub revision: u64,
    /// Its tiles, centre first, then the edges (left, right, bottom), floating and in their own windows.
    pub tiles: Vec<TileInfo>,
    /// Edges the user collapsed (their tiles are on the edge's strip).
    pub collapsed: Vec<TilePlace>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetLinkInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Colour link group `1`–`4` (the charts of a group show one symbol: joining takes the group's), or null to
    /// unlink.
    #[serde(default)]
    pub link: Option<String>,
    /// Every chart of the workspace instead (the layout menu's Link all charts): each joins `link`, taking this
    /// chart's symbol, or leaves its group (null).
    #[serde(default)]
    pub all: Option<bool>,
}
