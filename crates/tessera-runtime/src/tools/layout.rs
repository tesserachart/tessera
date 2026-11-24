use std::sync::Arc;

use async_trait::async_trait;
use tessera_protocol::io::{
    LayoutDeleteInput, LayoutDeleteOutput, LayoutGetInput, LayoutListInput, LayoutListOutput,
    LayoutSaveInput, LayoutSaveOutput, OpenTileKind, TileRequest, TileRequestParams,
    WorkspaceDocumentInput, WorkspaceOpenTileInput, WorkspaceOpenTileOutput,
};
use tessera_protocol::layout::Layout;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::layout::LayoutService;
use crate::settings::SettingsService;
use crate::tools::surfaces::{MARKETS_AREA_REQUEST, show_markets_area};

struct LayoutGet(Arc<LayoutService>);

#[async_trait]
impl Tool for LayoutGet {
    type Input = LayoutGetInput;
    type Output = Layout;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("layout.get", "Get layout", RiskTier::Read)
            .description("The workspace layout: dock tree (UI-owned JSON), chart tiles with symbol, timeframe, layers, annotations and last viewport.")
            .activity("Read layout")
            .result_view("layout")
    }

    async fn call(&self, _ctx: &ToolCtx, input: LayoutGetInput) -> Result<Layout, ToolError> {
        self.0.get(input.layout_id.as_deref())
    }

    fn summarize(&self, l: &Layout) -> Option<String> {
        Some(format!(
            "{} · rev {} · {} charts",
            l.name,
            l.revision,
            l.charts.len()
        ))
    }
}

struct LayoutSave(Arc<LayoutService>);

#[async_trait]
impl Tool for LayoutSave {
    type Input = LayoutSaveInput;
    type Output = LayoutSaveOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("layout.save", "Save layout", RiskTier::Modify)
            .description("Writes the UI-owned parts of a layout (name, dock tree, active chart, chart tiles). Pass expectedRevision to fail on concurrent changes. Like every change to a workspace, it stays unsaved (`unsaved` in layout.get) until workspace.save; a name and the trade setup are kept at once. Its trade setup (`trade`: the account the workspace's tickets trade, quantity, entry, OCO) is the user's alone: agents are refused.")
            .activity("Saved layout")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: LayoutSaveInput,
    ) -> Result<LayoutSaveOutput, ToolError> {
        self.0.save(input, &ctx.origin).await
    }

    async fn preview(
        &self,
        ctx: &ToolCtx,
        input: &LayoutSaveInput,
    ) -> Result<serde_json::Value, ToolError> {
        LayoutService::check_trade_writer(input, &ctx.origin)?;
        Ok(serde_json::to_value(input)?)
    }

    fn summarize(&self, o: &LayoutSaveOutput) -> Option<String> {
        Some(format!("{} → rev {}", o.layout_id, o.revision))
    }
}

struct WorkspaceSave(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceSave {
    type Input = WorkspaceDocumentInput;
    type Output = LayoutSaveOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.save", "Save workspace", RiskTier::Modify)
            .description("Saves a workspace like a document: its unsaved changes (charts, tiles and their arrangement, whoever made them) become what it opens with. Until then a change stays unsaved, and leaving the workspace asks the user whether to save it.")
            .activity("Saved the workspace")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceDocumentInput,
    ) -> Result<LayoutSaveOutput, ToolError> {
        self.0
            .save_changes(input.layout_id.as_deref(), &ctx.origin)
            .await
    }

    fn summarize(&self, o: &LayoutSaveOutput) -> Option<String> {
        Some(format!("{} saved", o.layout_id))
    }
}

struct WorkspaceRevert(Arc<LayoutService>);

#[async_trait]
impl Tool for WorkspaceRevert {
    type Input = WorkspaceDocumentInput;
    type Output = LayoutSaveOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.revert", "Revert workspace", RiskTier::Modify)
            .description("Drops a workspace's unsaved changes: it goes back to what the user last saved. The user is asked first.")
            .activity("Reverted the workspace")
            .idempotent(true)
            .always_ask()
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceDocumentInput,
    ) -> Result<LayoutSaveOutput, ToolError> {
        self.0.revert(input.layout_id.as_deref(), &ctx.origin).await
    }

    fn summarize(&self, o: &LayoutSaveOutput) -> Option<String> {
        Some(format!("{} back to saved", o.layout_id))
    }
}

struct LayoutList(Arc<LayoutService>);

#[async_trait]
impl Tool for LayoutList {
    type Input = LayoutListInput;
    type Output = LayoutListOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("layout.list", "List layouts", RiskTier::Read)
            .description("Every saved layout (workspace): id, name, revision, its charts' symbols and timeframes, and whether it has unsaved changes (`recovered`: kept from a Tessera that closed before they were saved), with the active (default) layout's id.")
            .activity("Listed layouts")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: LayoutListInput,
    ) -> Result<LayoutListOutput, ToolError> {
        Ok(self.0.list())
    }

    fn summarize(&self, o: &LayoutListOutput) -> Option<String> {
        Some(format!("{} layouts", o.layouts.len()))
    }
}

struct LayoutDelete(Arc<LayoutService>);

#[async_trait]
impl Tool for LayoutDelete {
    type Input = LayoutDeleteInput;
    type Output = LayoutDeleteOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("layout.delete", "Delete layout", RiskTier::Modify)
            .description("Deletes a saved layout (workspace) and its charts. The active (default) layout cannot be deleted.")
            .activity("Deleted layout")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: LayoutDeleteInput,
    ) -> Result<LayoutDeleteOutput, ToolError> {
        self.0.delete(&input.layout_id).await
    }

    fn summarize(&self, o: &LayoutDeleteOutput) -> Option<String> {
        Some(format!("{} deleted", o.layout_id))
    }
}

struct WorkspaceOpenTile {
    layouts: Arc<LayoutService>,
    settings: Option<Arc<SettingsService>>,
}

#[async_trait]
impl Tool for WorkspaceOpenTile {
    type Input = WorkspaceOpenTileInput;
    type Output = WorkspaceOpenTileOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.open_tile", "Open a tile", RiskTier::Modify)
            .description("Opens a tile on the desk. `dom` (the DOM ladder: the book, session volume, the position and working orders at their prices) or `tape` (time & sales: the prints newest first) go in the column to the right of the chart they follow: pin one with `instrument`, or have it follow colour link group `link` (`1`–`4`); with neither it follows the active chart; one of that kind with the same pin and link already open is shown instead of a second. `chart` adds a chart on `instrument` (else the symbol of the chart it opens beside), with that chart's interval, set up from the default chart template, unlinked when its symbol differs: `placement` `split` (default) gives it a pane of its own beside the pane of chart `beside` (else the active chart's), splitting that pane's longer side, `tab` makes it a tab in that pane, the one it shows; adding never rearranges the other panes nor splits their tabs apart. The centre splits into at most six panes (past that a split opens as a tab) and a workspace holds at most 24 charts; `workspace.list_tiles` gives each tile's pane (`group`). `settings` sets what a DOM or a tape shows (the DOM's volume traded at the bid and ask, pulling and stacking, order counts, refills, queue position, P&L in ticks, row size; time & sales' filters and highlight: see the field), applied to the one already open too. `trade` (the trading panel), `analyst`, `positions`, `accounts`, `alerts`, `journal`, `indicators` (every study and the user's own scripts, added to the active chart from there), `copy` (the trade copier): the one there is is shown where it is docked (its edge opened), else it comes back where it was last closed, else at its place in a fresh workspace. `markets` shows the Markets area (an area now: prefer ui.show_area). The desk opens it at once when it shows the layout, else when it next does. It never trades: the DOM and Trade send orders only on the user's own clicks.")
            .activity("Opened a tile")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceOpenTileInput,
    ) -> Result<WorkspaceOpenTileOutput, ToolError> {
        if input.kind == OpenTileKind::Markets {
            let given = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.trim().is_empty());
            if given(&input.instrument)
                || given(&input.link)
                || given(&input.beside)
                || input.settings.is_some()
                || input.placement.is_some()
            {
                return Err(ToolError::invalid_input(format!(
                    "{}; `markets` there says what it shows",
                    crate::tools::surfaces::MARKETS_IS_AN_AREA
                )));
            }
            let (layout_id, revision) = show_markets_area(
                self.settings.as_ref(),
                &self.layouts,
                input.layout_id.as_deref(),
                ctx,
            )
            .await?;
            return Ok(WorkspaceOpenTileOutput {
                layout_id,
                revision,
                request: TileRequest {
                    id: MARKETS_AREA_REQUEST.to_owned(),
                    kind: OpenTileKind::Markets,
                    params: TileRequestParams {
                        instrument: None,
                        link: None,
                        settings: None,
                        placement: None,
                        beside: None,
                    },
                },
            });
        }
        self.layouts.open_tile(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WorkspaceOpenTileOutput) -> Option<String> {
        if o.request.id == MARKETS_AREA_REQUEST {
            return Some("the Markets area".to_owned());
        }
        let what = match o.request.params.placement {
            Some(p) if o.request.kind == tessera_protocol::io::OpenTileKind::Chart => {
                format!("chart ({})", p.words())
            }
            _ => o.request.kind.words().to_owned(),
        };
        let on = match (&o.request.params.instrument, &o.request.params.link) {
            (Some(i), _) => format!(" on {i}"),
            (None, Some(l)) => format!(" following link {l}"),
            (None, None) if o.request.kind.singleton() => String::new(),
            (None, None) => " following the active chart".to_owned(),
        };
        Some(format!("{what}{on} · {}", o.layout_id))
    }
}

pub(crate) fn register(
    r: &mut ToolRegistry,
    s: &Arc<LayoutService>,
    settings: Option<&Arc<SettingsService>>,
) -> Result<(), RegistryError> {
    r.register(LayoutGet(Arc::clone(s)))?;
    r.register(LayoutSave(Arc::clone(s)))?;
    r.register(WorkspaceSave(Arc::clone(s)))?;
    r.register(WorkspaceRevert(Arc::clone(s)))?;
    r.register(LayoutList(Arc::clone(s)))?;
    r.register(LayoutDelete(Arc::clone(s)))?;
    r.register(WorkspaceOpenTile {
        layouts: Arc::clone(s),
        settings: settings.cloned(),
    })?;
    Ok(())
}
