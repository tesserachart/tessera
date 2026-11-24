use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tessera_protocol::io::{ChartChangeOutput, OpenTileKind};
use tessera_protocol::surfaces::{
    ChartDrawingHistoryInput, ChartSetLinkInput, ChartSetViewportInput, ChartSetViewportOutput,
    DockOp, DockRequest, JournalView, MarketsView, UiArea, UiShowAreaInput, UiShowAreaOutput,
    UiShowWorkspaceInput, UiShowWorkspaceOutput, WorkspaceApplyPresetInput, WorkspaceDockOutput,
    WorkspaceListTilesInput, WorkspaceMaximizeTileInput, WorkspaceMoveTileInput,
    WorkspaceSetTileSettingsInput, WorkspaceSetViewInput, WorkspaceTileInput, WorkspaceTilesOutput,
};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::layout::LayoutService;
use crate::settings::SettingsService;

pub(crate) use crate::layout::MARKETS_IS_AN_AREA;

pub(crate) const MARKETS_AREA_REQUEST: &str = "area-markets";

pub(crate) async fn show_markets_area(
    settings: Option<&Arc<SettingsService>>,
    layouts: &LayoutService,
    layout_id: Option<&str>,
    ctx: &ToolCtx,
) -> Result<(String, u64), ToolError> {
    let Some(settings) = settings else {
        return Err(ToolError::invalid_input(MARKETS_IS_AN_AREA));
    };
    let layout = layouts.get(layout_id)?;
    settings
        .set("ui.area", json!(UiArea::Markets.as_str()), &ctx.origin)
        .await?;
    Ok((layout.id, layout.revision))
}

fn dock_summary(o: &WorkspaceDockOutput) -> String {
    let r = &o.request;
    if r.id == MARKETS_AREA_REQUEST {
        return "the Markets area".to_owned();
    }
    let what = r
        .tile_id
        .clone()
        .or_else(|| r.kind.map(|k| k.words().to_owned()))
        .unwrap_or_default();
    let verb = match r.op {
        DockOp::Close => format!("close {what}"),
        DockOp::Focus => format!("show {what}"),
        DockOp::Preset => format!(
            "preset {}",
            r.preset.map(|p| p.as_str()).unwrap_or_default()
        ),
        DockOp::Settings => format!("settings of {what}"),
        DockOp::Move => format!(
            "move {what} to {}",
            r.place
                .and_then(|p| serde_json::to_value(p).ok())
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        ),
        DockOp::View => format!("view {}", r.settings.clone().unwrap_or_default()),
        DockOp::Maximize => {
            let restore = r
                .settings
                .as_ref()
                .and_then(|s| s.get("restore"))
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            format!("{} {what}", if restore { "restore" } else { "maximize" })
        }
        DockOp::Viewport => format!("view of {what}"),
        DockOp::Drawings => format!(
            "{} a drawing edit on {what}",
            r.settings
                .as_ref()
                .and_then(|s| s.get("action"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("undo")
        ),
        DockOp::Trade => format!("Trade panel of {what}"),
    };
    format!("{verb} · {}", o.layout_id)
}

struct WorkspaceCloseTile(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceCloseTile {
    type Input = WorkspaceTileInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.close_tile", "Close a tile", RiskTier::Modify)
            .description("Closes a tile of the desk (its tab's ×, its header's Close, ⌘W), named by `tileId` (workspace.list_tiles; a chart's is its chart-N tile id) or by `kind` (chart: the active chart; dom, tape: the first open; trade, analyst, positions, accounts, alerts, journal, indicators, copy: the one there is). Every tile closes, an edge's last and the last chart too (the desk then shows its empty state); a closed tile comes back where it was with workspace.open_tile or focus_tile, while a closed chart goes with its indicators and drawings. The desk closes it at once when it shows the layout, else when it next does. Markets is an area now, not a tile (ui.show_area).")
            .activity("Closed a tile")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceTileInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.0.close_tile(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

struct WorkspaceFocusTile {
    layouts: Arc<LayoutService>,
    settings: Option<Arc<SettingsService>>,
}

#[async_trait]
impl Tool for WorkspaceFocusTile {
    type Input = WorkspaceTileInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.focus_tile", "Show a tile", RiskTier::Modify)
            .description("Brings a tile of the desk to the front, named by `tileId` (workspace.list_tiles) or by `kind` (as workspace.close_tile): it becomes the visible tab of its group and its edge opens; a chart becomes the active chart, the one chart tools act on without a tileId. An edge's tile that was closed comes back to its edge. The user's keyboard focus stays where it is. `kind: markets` shows the Markets area (an area now: prefer ui.show_area).")
            .activity("Showed a tile")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceTileInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        if input.kind == Some(OpenTileKind::Markets)
            && input.tile_id.as_deref().is_none_or(|t| t.trim().is_empty())
        {
            let (layout_id, revision) = show_markets_area(
                self.settings.as_ref(),
                &self.layouts,
                input.layout_id.as_deref(),
                ctx,
            )
            .await?;
            return Ok(WorkspaceDockOutput {
                layout_id,
                revision,
                request: DockRequest {
                    id: MARKETS_AREA_REQUEST.to_owned(),
                    op: DockOp::Focus,
                    tile_id: None,
                    kind: Some(OpenTileKind::Markets),
                    preset: None,
                    settings: None,
                    place: None,
                },
            });
        }
        self.layouts.focus_tile(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

struct WorkspaceApplyPreset(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceApplyPreset {
    type Input = WorkspaceApplyPresetInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.apply_preset", "Arrange the workspace", RiskTier::Modify)
            .description("Arranges the desk as the layout menu does. `1`, `2h` (two side by side), `2v` (two stacked), `3` (one beside two), `4` (2 × 2), `6` (3 × 2): the workspace's charts in that arrangement; charts it lacks copy the active chart (symbol, interval, indicators, link), charts past its count close (the active chart always stays); the edges and other tiles stay. `trade`, `scalp` (1m order flow, DOM, time & sales), `analyse` (1h and 5m linked), `review`: a story, made as a NEW workspace on the active chart's symbol and shown (the workspace shown is never overwritten; layout.list lists it after). `reset`: the workspace's layout rebuilt as its story (or the default) has it, its charts unchanged.")
            .activity("Arranged the workspace")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceApplyPresetInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.0.apply_preset(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

struct WorkspaceSetTileSettings(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceSetTileSettings {
    type Input = WorkspaceSetTileSettingsInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.set_tile_settings", "Change a tile's settings", RiskTier::Modify)
            .description("Changes a tile's own settings (what its settings popover or tab row sets), only the fields given. Positions: account (an account id from portfolio.get_accounts, or all: whose positions, orders and fills it lists). DOM: rowTicks (1, 2, 4, 5 or 10 ticks a row), volumeColumn (session, recent or off), traded (volume traded at the bid and the ask: session, recent or off), pullStack (size added or pulled per level over 5, 10 or 30 s; 0 off), orders (resting orders per level), refills (levels that refilled as they traded), queue (size ahead of the user's resting limit orders), pnl (P&L in ticks), autoCentre (bool), link (1–4 or null), instrument (pin, or null to follow). Time & sales: minSize (rows smaller are left out), highlight (auto: Tessera's big-trade size, or a size), side (all, buy, sell), aggregate (one row per aggressor order, else per print), millis (times to the millisecond), link, instrument. Chart settings have their own chart.* tools. Read the tile's current settings with workspace.list_tiles. None of these trade: the DOM sends orders only on the user's own clicks.")
            .activity("Changed a tile's settings")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceSetTileSettingsInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.0.set_tile_settings(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

struct WorkspaceMoveTile(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceMoveTile {
    type Input = WorkspaceMoveTileInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.move_tile", "Move a tile", RiskTier::Modify)
            .description("Moves a tile of the desk, named by `tileId` (workspace.list_tiles) or by `kind` (as workspace.close_tile), as the tab menu's Move to and Float do: `to` left, right or bottom (a tab of that edge, opened), centre (beside the active chart) or floating (over the desk, 640 × 480). The user can undo it from the toast. A tile goes to its own window only from the user's own Pop out (a window opens only on the user's own click).")
            .activity("Moved a tile")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceMoveTileInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.0.move_tile(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

struct WorkspaceSetView(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceSetView {
    type Input = WorkspaceSetViewInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.set_view", "Open or collapse the edges", RiskTier::Modify)
            .description("Changes how the desk is laid out; only the fields given change. `left`, `right`, `bottom`: open (true) or collapse to its strip (false) the left edge (empty by default: it holds what the user moved there), the right edge (Trade and the analyst as tabs in a fresh workspace) or the bottom edge (Positions and Accounts in a fresh workspace), as ⌘B, ⌥⌘B and ⌥⌘P do. `shareInterval`: the charts share their interval (a change on one applies to all; turning it on gives them the active chart's), as the tab menu's Share interval. `focus`: focus mode (⌥⌘F), every edge collapsed for now and put back as it was when it ends. workspace.list_tiles says which edges are collapsed.")
            .activity("Changed the desk's view")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceSetViewInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.0.set_view(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

struct WorkspaceListTiles(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceListTiles {
    type Input = WorkspaceListTilesInput;
    type Output = WorkspaceTilesOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.list_tiles", "List the tiles", RiskTier::Read)
            .description("The tiles of a workspace as its desk last saved them: each one's id, kind (chart, trade, analyst, positions, accounts, dom, tape, journal; an older desk's markets), title, place (centre, left, right: either part of the right edge, bottom, floating, popout: its own window), whether it is the tab its group shows with its edge open, and its own settings (a DOM's row size, a tape's filters, a link). Also which edges are collapsed. A workspace the desk has not saved yet lists its charts alone.")
            .activity("Listed the tiles")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: WorkspaceListTilesInput,
    ) -> Result<WorkspaceTilesOutput, ToolError> {
        self.0.list_tiles(input.layout_id.as_deref())
    }

    fn summarize(&self, o: &WorkspaceTilesOutput) -> Option<String> {
        Some(format!("{} tiles · {}", o.tiles.len(), o.layout_id))
    }
}

struct ChartSetLink(Arc<LayoutService>);

#[async_trait]
impl Tool for ChartSetLink {
    type Input = ChartSetLinkInput;
    type Output = ChartChangeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.set_link", "Link a chart", RiskTier::Modify)
            .description("Puts a chart in colour link group 1–4, or none (link null or omitted). The charts of a group show one symbol: a symbol change on one moves them all, and joining a group takes the group's symbol (the chart's marks go with its old symbol); leaving one keeps the chart as it is. `all: true` is the layout menu's Link all charts: every chart of the workspace joins `link` on this chart's symbol, or (link null) leaves its group. DOM and time & sales follow a group through their own link (workspace.set_tile_settings).")
            .activity("Linked a chart")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: ChartSetLinkInput,
    ) -> Result<ChartChangeOutput, ToolError> {
        self.0.set_link(input, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartChangeOutput) -> Option<String> {
        Some(match &o.chart.link_group {
            Some(g) => format!("{} on link {g} · {}", o.chart.tile_id, o.chart.instrument),
            None => format!("{} unlinked", o.chart.tile_id),
        })
    }
}

struct UiShowArea {
    settings: Arc<SettingsService>,
    accounts: bool,
}

#[async_trait]
impl Tool for UiShowArea {
    type Input = UiShowAreaInput;
    type Output = UiShowAreaOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("ui.show_area", "Show an area", RiskTier::Modify)
            .description("Switches the area the window shows, as its left rail does, and where in it: desk (charts, Trade, the analyst, Positions, Accounts), markets (every instrument the connections serve, the watchlists, an instrument's detail), agents (the analyst's sessions at full size), indicators, research, journal, copy (the Trade copier: its copy groups, each leader's followers and whether each holds its size), settings (every preference, at the rail's foot; open it when the user asks to change one by hand) or profile (the user's Tessera account, under Settings: who is signed in, their alpha access, sign out; only in a build with accounts). `item` opens Settings on a page (connections, trading: Trading and risk, chart, alerts: Alerts and sounds, analyst, data, appearance: the theme and the saved themes, app) or a setting's row (trading.commission); on a connection, connections.<connection id> (an id from connections.list), or a drafted levels source, connections.draft:<its id>; on an add form, connections.add.rithmic or connections.add.spec; on the section by exchange (each exchange's market data and the account its orders go from), connections.exchanges. Markets on an instrument (an id or symbol, selected with its detail), Agents on a session, Indicators on an indicator (a built-in kind or a custom id), Research on a study. `journal` opens the Journal where it says: {section, tradeId (its page; omitted: the trade page closes), date (a day), setupId, reportTab, groupBy, account, range, filter (as journal.list_trades takes it), sort, ascending}; e.g. {section: reports, reportTab: breakdowns, groupBy: setup} or {tradeId: \"T-12\"}. `markets` says what Markets shows, only the fields given changing: {list (all: every contract the connections serve, watchlist, recent, positions), watchlist (an id from watchlists.list; giving it shows that list), connection (a connection's instruments only; \"\": every connection), query (search text; \"\" clears), moving (only what is moving, biggest absolute % change first), instrument (selected; \"\": none)}; e.g. {area: markets, markets: {list: all, moving: true}} or {area: markets, item: \"NQ\"}. The desk stays live under the other areas. What each area shows now (the user's own moves too) is the ui.view setting; the area shown is ui.area.")
            .activity("Showed an area")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: UiShowAreaInput,
    ) -> Result<UiShowAreaOutput, ToolError> {
        if input.area == UiArea::Profile && !self.accounts {
            return Err(ToolError::unavailable(
                "this build of Tessera has no accounts, so no profile",
            ));
        }
        if let Some(view) = area_view(&self.settings, &input)? {
            self.settings.set("ui.view", view, &ctx.origin).await?;
        }
        let out = self
            .settings
            .set("ui.area", json!(input.area.as_str()), &ctx.origin)
            .await?;
        let previous = UiArea::ALL
            .into_iter()
            .find(|a| out.previous.as_str() == Some(a.as_str()));
        Ok(UiShowAreaOutput {
            area: input.area,
            previous,
        })
    }

    fn summarize(&self, o: &UiShowAreaOutput) -> Option<String> {
        Some(o.area.as_str().to_owned())
    }
}

struct UiShowWorkspace {
    settings: Arc<SettingsService>,
    layouts: Arc<LayoutService>,
}

#[async_trait]
impl Tool for UiShowWorkspace {
    type Input = UiShowWorkspaceInput;
    type Output = UiShowWorkspaceOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("ui.show_workspace", "Show a workspace", RiskTier::Modify)
            .description("Shows a saved workspace (a layout id from layout.list) on the desk, as the frame's workspace menu does; the area switches to the desk. The workspace shown is the ui.workspace setting (empty: the default, workspace.activeLayoutId); chart and workspace tools act on the default unless given its layoutId.")
            .activity("Showed a workspace")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: UiShowWorkspaceInput,
    ) -> Result<UiShowWorkspaceOutput, ToolError> {
        let id = input.layout_id.trim();
        let saved = self.layouts.list().layouts.iter().any(|l| l.id == id);
        if !saved {
            return Err(ToolError::not_found(format!(
                "no workspace {id} (layout.list lists them)"
            )));
        }
        let out = self
            .settings
            .set("ui.workspace", json!(id), &ctx.origin)
            .await?;
        self.settings
            .set("ui.area", json!(UiArea::Desk.as_str()), &ctx.origin)
            .await?;
        Ok(UiShowWorkspaceOutput {
            layout_id: id.to_owned(),
            previous: out
                .previous
                .as_str()
                .filter(|p| !p.is_empty())
                .map(str::to_owned),
        })
    }

    fn summarize(&self, o: &UiShowWorkspaceOutput) -> Option<String> {
        Some(o.layout_id.clone())
    }
}

fn area_view(
    settings: &SettingsService,
    input: &UiShowAreaInput,
) -> Result<Option<serde_json::Value>, ToolError> {
    let item = input
        .item
        .as_deref()
        .map(str::trim)
        .filter(|i| !i.is_empty());
    let mut view = match settings.value("ui.view") {
        Some(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    if input.markets.is_some() && input.area != UiArea::Markets {
        return Err(ToolError::invalid_input("`markets` goes with area markets"));
    }
    if input.area == UiArea::Markets {
        if input.journal.is_some() {
            return Err(ToolError::invalid_input("`journal` goes with area journal"));
        }
        if item.is_none() && input.markets.is_none() {
            return Ok(None);
        }
        let current = view.get("markets").cloned().unwrap_or_else(|| json!({}));
        let change = input.markets.clone().unwrap_or_default();
        view.insert(
            "markets".into(),
            markets_view(settings, current, &change, item)?,
        );
        return Ok(Some(serde_json::Value::Object(view)));
    }
    match (input.area, item, &input.journal) {
        (_, None, None) => Ok(None),
        (UiArea::Journal, Some(_), _) => Err(ToolError::invalid_input(
            "the journal opens where `journal` says (section, tradeId, date…), not on an item",
        )),
        (UiArea::Journal, None, Some(change)) => {
            let current = view.get("journal").cloned().unwrap_or_else(|| json!({}));
            view.insert("journal".into(), journal_view(current, change)?);
            Ok(Some(serde_json::Value::Object(view)))
        }
        (_, _, Some(_)) => Err(ToolError::invalid_input("`journal` goes with area journal")),
        (UiArea::Desk, Some(_), None) => Err(ToolError::invalid_input(
            "the desk has no item: workspace.focus_tile shows a tile",
        )),
        (UiArea::Profile, Some(_), None) => {
            Err(ToolError::invalid_input("the profile has no item"))
        }
        (UiArea::Copy, Some(_), None) => Err(ToolError::invalid_input(
            "the Trade copier has no item: it shows every copy group (copy.list)",
        )),
        (area, Some(item), None) => {
            if area == UiArea::Settings && !is_settings_place(item) {
                return Err(ToolError::invalid_input(format!(
                    "Settings has no {item}: a page ({}) or a row id (trading.commission)",
                    SETTINGS_PLACES.join(", ")
                )));
            }
            view.insert(area.as_str().into(), json!(item));
            Ok(Some(serde_json::Value::Object(view)))
        }
    }
}

fn markets_view(
    settings: &SettingsService,
    current: serde_json::Value,
    change: &MarketsView,
    item: Option<&str>,
) -> Result<serde_json::Value, ToolError> {
    let mut view = match current {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    let text = |v: &Option<String>| {
        v.as_deref().map(|s| match s.trim() {
            "" => serde_json::Value::Null,
            t => json!(t),
        })
    };
    if let Some(id) = change.watchlist.as_deref().map(str::trim)
        && !id.is_empty()
    {
        let lists = crate::watchlists::read(
            &settings
                .value(tessera_protocol::watchlists::KEY)
                .unwrap_or_default(),
        );
        if !lists.iter().any(|l| l.id == id) {
            return Err(crate::watchlists::unknown(id, &lists));
        }
        if change.list.is_none() {
            view.insert("list".into(), json!("watchlist"));
        }
    }
    if let Some(list) = change.list {
        view.insert(
            "list".into(),
            serde_json::to_value(list).map_err(|e| ToolError::internal(e.to_string()))?,
        );
    }
    for (key, value) in [
        ("watchlist", text(&change.watchlist)),
        ("connection", text(&change.connection)),
        ("query", text(&change.query)),
        ("instrument", text(&change.instrument)),
        ("moving", change.moving.map(serde_json::Value::Bool)),
    ] {
        if let Some(v) = value {
            view.insert(key.into(), v);
        }
    }
    if let Some(item) = item {
        view.insert("instrument".into(), json!(item));
    }
    Ok(serde_json::Value::Object(view))
}

const SETTINGS_PLACES: [&str; 8] = [
    "connections",
    "trading",
    "chart",
    "alerts",
    "analyst",
    "data",
    "appearance",
    "app",
];

fn is_settings_place(item: &str) -> bool {
    let page = item.split_once('.').map_or(item, |(page, _)| page);
    SETTINGS_PLACES.contains(&page)
}

fn journal_view(
    current: serde_json::Value,
    change: &JournalView,
) -> Result<serde_json::Value, ToolError> {
    let mut view = match current {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    let given = serde_json::to_value(change).map_err(|e| ToolError::internal(e.to_string()))?;
    if let Some(d) = change.date.as_deref()
        && !(d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-')
    {
        return Err(ToolError::invalid_input(format!(
            "date is a day, YYYY-MM-DD, not {d}"
        )));
    }
    if let Some(f) = &change.filter
        && !f.is_object()
    {
        return Err(ToolError::invalid_input(
            "filter is an object, as journal.list_trades takes it",
        ));
    }
    if let serde_json::Value::Object(m) = given {
        for (k, v) in m {
            if !v.is_null() {
                view.insert(k, v);
            }
        }
    }
    if change.trade_id.is_none() {
        view.insert("tradeId".into(), serde_json::Value::Null);
    } else if change.section.is_none() {
        view.insert("section".into(), json!("trades"));
    }
    Ok(serde_json::Value::Object(view))
}

struct WorkspaceMaximizeTile(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceMaximizeTile {
    type Input = WorkspaceMaximizeTileInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.maximize_tile", "Maximize a tile", RiskTier::Modify)
            .description("Maximizes a tile of the desk over the whole desk, as ⇧⌘⏎ and the panel header's Maximise do (an edge's tile goes back to its edge when restored; Esc restores too), named by `tileId` (workspace.list_tiles) or `kind` (chart: the active chart; a kind there is one of: that one); `restore: true` puts it back where it was. A tile in its own window does not maximize. The desk does it at once when it shows the layout.")
            .activity("Maximized a tile")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceMaximizeTileInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.0.maximize_tile(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

struct ChartSetViewport(Arc<LayoutService>);

#[async_trait]
impl Tool for ChartSetViewport {
    type Input = ChartSetViewportInput;
    type Output = ChartSetViewportOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.set_viewport", "Move a chart's view", RiskTier::Modify)
            .description("Moves what a chart shows, as the user's pan, zoom and scale do. The time axis one way: `from` and `to` (bar times, RFC 3339 or ns; `to` defaults to now) shows that span, from the bar that spans `from`; `lastBars` the last N bars, following new ones; `fitAll` every bar the chart holds. The price axis: `priceMin` with `priceMax` fixes it, `autoScale: true` makes it follow the bars again. The chart menu's Reset scale is {lastBars: 150, autoScale: true}. The chart reads older history until it holds what was asked, and keeps that view through tab switches until the user moves it. `shown` is what it then shows (first and last bar, bars) with `short`, why it shows less than was asked (the history it holds or can read stops short); absent when the chart did not answer in a few seconds (not on screen, or still reading), and chart.get_state reads it later.")
            .activity("Moved a chart's view")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: ChartSetViewportInput,
    ) -> Result<ChartSetViewportOutput, ToolError> {
        self.0.set_viewport(input, &ctx.origin).await
    }

    fn summarize(&self, o: &ChartSetViewportOutput) -> Option<String> {
        let tile = o.request.tile_id.clone().unwrap_or_default();
        Some(match &o.shown {
            Some(v) => match (&v.short, v.bars) {
                (Some(short), _) => format!("view of {tile}: {short}"),
                (None, Some(bars)) => format!("view of {tile}: {bars} bars"),
                (None, None) => format!("view of {tile}"),
            },
            None => format!("view of {tile}"),
        })
    }
}

struct ChartUndoDrawing(Arc<LayoutService>);

#[async_trait]
impl Tool for ChartUndoDrawing {
    type Input = ChartDrawingHistoryInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.undo_drawing", "Undo a drawing edit", RiskTier::Modify)
            .description("Undoes the chart's last drawing edit (a drawing placed, moved, restyled or removed by the user in the desk), as ⌘Z on the chart does; chart.redo_drawing does it again. The desk keeps that history for the user's own edits since the chart was shown; nothing happens when it is empty. To change a drawing directly use chart.update_drawing or chart.remove_drawing. Defaults to the active chart.")
            .activity("Undid a drawing edit")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: ChartDrawingHistoryInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.0.drawing_history(input, false, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

struct ChartRedoDrawing(Arc<LayoutService>);

#[async_trait]
impl Tool for ChartRedoDrawing {
    type Input = ChartDrawingHistoryInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("chart.redo_drawing", "Redo a drawing edit", RiskTier::Modify)
            .description("Redoes the drawing edit chart.undo_drawing (or the user's ⌘Z) last undid on the chart, as ⇧⌘Z does. Defaults to the active chart.")
            .activity("Redid a drawing edit")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: ChartDrawingHistoryInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.0.drawing_history(input, true, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(dock_summary(o))
    }
}

pub(crate) fn register(
    r: &mut ToolRegistry,
    l: &Arc<LayoutService>,
    s: Option<&Arc<SettingsService>>,
) -> Result<(), RegistryError> {
    r.register(WorkspaceCloseTile(Arc::clone(l)))?;
    r.register(WorkspaceFocusTile {
        layouts: Arc::clone(l),
        settings: s.cloned(),
    })?;
    r.register(WorkspaceApplyPreset(Arc::clone(l)))?;
    r.register(WorkspaceSetTileSettings(Arc::clone(l)))?;
    r.register(WorkspaceMoveTile(Arc::clone(l)))?;
    r.register(WorkspaceSetView(Arc::clone(l)))?;
    r.register(WorkspaceListTiles(Arc::clone(l)))?;
    r.register(WorkspaceMaximizeTile(Arc::clone(l)))?;
    r.register(ChartSetLink(Arc::clone(l)))?;
    r.register(ChartSetViewport(Arc::clone(l)))?;
    r.register(ChartUndoDrawing(Arc::clone(l)))?;
    r.register(ChartRedoDrawing(Arc::clone(l)))?;
    Ok(())
}

pub(crate) fn register_ui(
    r: &mut ToolRegistry,
    s: &Arc<SettingsService>,
    l: &Arc<LayoutService>,
    accounts: bool,
) -> Result<(), RegistryError> {
    r.register(UiShowArea {
        settings: Arc::clone(s),
        accounts,
    })?;
    r.register(UiShowWorkspace {
        settings: Arc::clone(s),
        layouts: Arc::clone(l),
    })?;
    Ok(())
}
