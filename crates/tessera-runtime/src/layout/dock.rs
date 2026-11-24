use serde_json::{Map, Value, json};
use tessera_core::Origin;
use tessera_protocol::io::{ChartChangeOutput, OpenTileKind};
use tessera_protocol::surfaces::{
    ChartDrawingHistoryInput, ChartSetLinkInput, ChartSetViewportInput, ChartSetViewportOutput,
    DockOp, DockRequest, TileInfo, TilePlace, WorkspaceApplyPresetInput, WorkspaceDockOutput,
    WorkspaceMaximizeTileInput, WorkspaceMoveTileInput, WorkspaceSetTileSettingsInput,
    WorkspaceSetViewInput, WorkspaceTileInput, WorkspaceTilesOutput,
};
use tessera_tools::ToolError;

use super::{DOCK_VIEW_KEY, LINK_GROUPS, LayoutService, push_view_entry};

pub const MAX_CHARTS: usize = 24;

const VIEWPORT_ANSWER_WAIT: std::time::Duration = std::time::Duration::from_secs(8);

pub const MARKETS_IS_AN_AREA: &str = "Markets is an area now: ui.show_area {area: markets}";

pub fn dock_requests(dock: &Value) -> Vec<DockRequest> {
    dock.get(DOCK_VIEW_KEY)
        .and_then(|v| v.get("ops"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| serde_json::from_value(r.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn panels(dock: &Value) -> Option<&Map<String, Value>> {
    dock.get("panels").and_then(Value::as_object)
}

fn panel_kind(panel: &Value) -> (String, Value) {
    let component = panel
        .get("contentComponent")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = panel.get("params").cloned().unwrap_or(Value::Null);
    if component == "unknown-tile"
        && let Some(original) = params.get("originalComponent").and_then(Value::as_str)
    {
        let kept = params.get("originalParams").cloned().unwrap_or(Value::Null);
        return (original.to_owned(), kept);
    }
    let kind = OpenTileKind::from_component(component).map_or(component, |k| k.as_str());
    (kind.to_owned(), params)
}

fn listed_params(kind: &str, params: Value) -> Value {
    match params {
        Value::Object(mut m) if kind == OpenTileKind::Chart.as_str() => {
            m.remove("ticket");
            Value::Object(m)
        }
        other => other,
    }
}

type Views = (Option<String>, Vec<String>, Option<String>);

fn group_views(data: &Value) -> Views {
    let id = data.get("id").and_then(Value::as_str).map(str::to_owned);
    let views = data
        .get("views")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let active = data
        .get("activeView")
        .and_then(Value::as_str)
        .map(str::to_owned);
    (id, views, active)
}

fn grid_groups(node: &Value, out: &mut Vec<Views>) {
    match node.get("type").and_then(Value::as_str) {
        Some("leaf") => out.push(group_views(node.get("data").unwrap_or(&Value::Null))),
        Some("branch") => {
            for child in node
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                grid_groups(child, out);
            }
        }
        _ => {}
    }
}

pub fn dock_tiles(
    dock: &Value,
    charts: impl Iterator<Item = (String, String)>,
) -> (Vec<TileInfo>, Vec<TilePlace>) {
    let Some(panels) = panels(dock) else {
        let tiles = charts
            .map(|(id, title)| TileInfo {
                tile_id: id.clone(),
                kind: OpenTileKind::Chart.as_str().to_owned(),
                title,
                place: TilePlace::Centre,
                visible: true,
                group: None,
                params: json!({"tileId": id}),
            })
            .collect();
        return (tiles, Vec::new());
    };
    let mut groups: Vec<(TilePlace, bool, Views)> = Vec::new();
    let mut grid = Vec::new();
    if let Some(root) = dock.get("grid").and_then(|g| g.get("root")) {
        grid_groups(root, &mut grid);
    }
    groups.extend(grid.into_iter().map(|g| (TilePlace::Centre, true, g)));
    let mut collapsed = Vec::new();
    for (key, place) in [
        ("left", TilePlace::Left),
        ("right", TilePlace::Right),
        ("bottom", TilePlace::Bottom),
    ] {
        let Some(edge) = dock.get("edgeGroups").and_then(|e| e.get(key)) else {
            continue;
        };
        let shut = edge.get("collapsed").and_then(Value::as_bool) == Some(true);
        let shown = edge.get("visible").and_then(Value::as_bool) != Some(false);
        if shut {
            collapsed.push(place);
        }
        if let Some(group) = edge.get("group") {
            groups.push((place, shown && !shut, group_views(group)));
        }
    }
    for f in dock
        .get("floatingGroups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        groups.push((
            TilePlace::Floating,
            true,
            group_views(f.get("data").unwrap_or(&Value::Null)),
        ));
    }
    let mut tiles = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut tile = |id: &str, place: TilePlace, visible: bool, group: Option<&String>| {
        let Some(panel) = panels.get(id) else { return };
        if !seen.insert(id.to_owned()) {
            return;
        }
        let (kind, params) = panel_kind(panel);
        let params = listed_params(&kind, params);
        tiles.push(TileInfo {
            tile_id: id.to_owned(),
            title: panel
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(&kind)
                .to_owned(),
            kind,
            place,
            visible,
            group: group.cloned(),
            params,
        });
    };
    for (place, open, (group, views, active)) in &groups {
        for id in views {
            let shown = *open && active.as_deref() == Some(id.as_str());
            tile(id, *place, shown, group.as_ref());
        }
    }
    for id in panels.keys() {
        tile(id, TilePlace::Centre, false, None);
    }
    for p in dock
        .get(DOCK_VIEW_KEY)
        .and_then(|v| v.get("popouts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(id), Some(kind)) = (
            p.get("panelId").and_then(Value::as_str),
            p.get("kind").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        tiles.push(TileInfo {
            tile_id: id.to_owned(),
            kind: kind.to_owned(),
            title: id.to_owned(),
            place: TilePlace::Popout,
            visible: true,
            group: None,
            params: listed_params(kind, p.get("params").cloned().unwrap_or(Value::Null)),
        });
    }
    (tiles, collapsed)
}

fn kind_of(dock: &Value, id: &str) -> Option<String> {
    panels(dock)?.get(id).map(|p| panel_kind(p).0)
}

fn holds_kind(dock: &Value, kind: OpenTileKind) -> bool {
    panels(dock).is_some_and(|p| p.values().any(|v| panel_kind(v).0 == kind.as_str()))
}

fn link_of(v: &Value) -> Result<Value, ToolError> {
    match v {
        Value::Null => Ok(Value::Null),
        Value::String(s) if LINK_GROUPS.contains(&s.trim()) => Ok(json!(s.trim())),
        other => Err(ToolError::invalid_input(format!(
            "link must be 1, 2, 3, 4 or null, not {other}"
        ))),
    }
}

fn check_settings(kind: &str, settings: &Value) -> Result<Map<String, Value>, ToolError> {
    let Some(obj) = settings.as_object().filter(|o| !o.is_empty()) else {
        return Err(ToolError::invalid_input(
            "settings must be an object with the fields to change",
        ));
    };
    let fields: &[&str] = match kind {
        "dom" => &[
            "rowTicks",
            "volumeColumn",
            "autoCentre",
            "orders",
            "traded",
            "pullStack",
            "pnl",
            "refills",
            "queue",
            "link",
            "instrument",
        ],
        "tape" => &[
            "minSize",
            "highlight",
            "side",
            "aggregate",
            "millis",
            "link",
            "instrument",
        ],
        "markets" | "watchlist" => return Err(ToolError::invalid_input(MARKETS_IS_AN_AREA)),
        "positions" => &["account"],
        "chart" => {
            return Err(ToolError::invalid_input(
                "a chart's settings are its own tools: chart.set_symbol, chart.set_timeframe, chart.set_chart_type, chart.set_hours, chart.set_drawing_sources, chart.set_link, chart.add_layer and chart.update_layer",
            ));
        }
        other => {
            return Err(ToolError::invalid_input(format!(
                "a {other} tile has no settings of its own"
            )));
        }
    };
    let positive = |k: &str, v: &Value| match v.as_f64() {
        Some(n) if n > 0.0 && n.is_finite() => Ok(v.clone()),
        _ => Err(ToolError::invalid_input(format!(
            "{k} must be a size above 0, not {v}"
        ))),
    };
    let one_of = |k: &str, v: &Value, options: &[&str]| match v.as_str() {
        Some(s) if options.contains(&s) => Ok(v.clone()),
        _ => Err(ToolError::invalid_input(format!(
            "{k} must be one of {}, not {v}",
            options.join(", ")
        ))),
    };
    let boolean = |k: &str, v: &Value| {
        v.as_bool()
            .map(Value::Bool)
            .ok_or_else(|| ToolError::invalid_input(format!("{k} must be true or false, not {v}")))
    };
    let mut out = Map::new();
    for (k, v) in obj {
        if !fields.contains(&k.as_str()) {
            return Err(ToolError::invalid_input(format!(
                "a {kind} tile has no setting {k} (it has {})",
                fields.join(", ")
            )));
        }
        let checked = match k.as_str() {
            "rowTicks" => match v.as_u64() {
                Some(n @ (1 | 2 | 4 | 5 | 10)) => json!(n),
                _ => {
                    return Err(ToolError::invalid_input(format!(
                        "rowTicks must be 1, 2, 4, 5 or 10, not {v}"
                    )));
                }
            },
            "volumeColumn" | "traded" => one_of(k, v, &["session", "recent", "off"])?,
            "pullStack" => match v.as_u64() {
                Some(n @ (0 | 5 | 10 | 30)) => json!(n),
                _ => {
                    return Err(ToolError::invalid_input(format!(
                        "pullStack must be 0 (off), 5, 10 or 30 seconds, not {v}"
                    )));
                }
            },
            "side" => one_of(k, v, &["all", "buy", "sell"])?,
            "autoCentre" | "aggregate" | "millis" | "orders" | "pnl" | "refills" | "queue" => {
                boolean(k, v)?
            }
            "minSize" => positive(k, v)?,
            "highlight" if v.as_str() == Some("auto") => v.clone(),
            "highlight" => positive(k, v)?,
            "link" => link_of(v)?,
            "account" => match v.as_str().map(str::trim) {
                Some(a) if !a.is_empty() => json!(a),
                _ => {
                    return Err(ToolError::invalid_input(format!(
                        "account must be an account id (portfolio.get_accounts) or all, not {v}"
                    )));
                }
            },
            "instrument" => match v {
                Value::Null => Value::Null,
                Value::String(s) if !s.trim().is_empty() => json!(s.trim()),
                _ => {
                    return Err(ToolError::invalid_input(format!(
                        "instrument must be an id, a symbol or null, not {v}"
                    )));
                }
            },
            _ => unreachable!("fields are listed"),
        };
        out.insert(k.clone(), checked);
    }
    Ok(out)
}

impl LayoutService {
    async fn ask_desk(
        &self,
        layout_id: Option<&str>,
        reason: &str,
        origin: &Origin,
        check: impl FnOnce(&tessera_protocol::layout::Layout) -> Result<(), ToolError>,
        mut request: DockRequest,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let (layout, request) = self
            .mutate(layout_id, reason, origin, None, |l| {
                check(l)?;
                request.id = format!("op-{}", l.revision + 1);
                let entry = serde_json::to_value(&request)
                    .map_err(|e| ToolError::internal(e.to_string()))?;
                l.dock = push_view_entry(&l.dock, "ops", entry);
                Ok(request)
            })
            .await?;
        Ok(WorkspaceDockOutput {
            layout_id: layout.id,
            revision: layout.revision,
            request,
        })
    }

    fn tile_target(
        l: &tessera_protocol::layout::Layout,
        input: &WorkspaceTileInput,
    ) -> Result<(Option<String>, Option<OpenTileKind>), ToolError> {
        let tile = input
            .tile_id
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty());
        match (tile, input.kind) {
            (Some(_), Some(_)) | (None, None) => Err(ToolError::invalid_input(
                "name the tile by tileId or by kind, one of them",
            )),
            (Some(id), None) => {
                let known = l.charts.contains_key(id)
                    || kind_of(&l.dock, id).is_some()
                    || panels(&l.dock).is_none();
                if !known {
                    return Err(ToolError::not_found(format!(
                        "no tile {id} in {} (workspace.list_tiles lists them)",
                        l.id
                    )));
                }
                let kind = kind_of(&l.dock, id)
                    .and_then(|k| OpenTileKind::from_component(&k))
                    .or_else(|| l.charts.contains_key(id).then_some(OpenTileKind::Chart));
                if kind == Some(OpenTileKind::Markets) {
                    return Err(ToolError::invalid_input(MARKETS_IS_AN_AREA));
                }
                Ok((Some(id.to_owned()), kind))
            }
            (None, Some(OpenTileKind::Markets)) => {
                Err(ToolError::invalid_input(MARKETS_IS_AN_AREA))
            }
            (None, Some(kind)) => Ok((None, Some(kind))),
        }
    }

    fn close_target(
        l: &tessera_protocol::layout::Layout,
        input: &WorkspaceTileInput,
    ) -> Result<(Option<String>, Option<OpenTileKind>), ToolError> {
        let (id, kind) = Self::tile_target(l, input)?;
        if id.is_none()
            && let Some(k) = kind
            && k != OpenTileKind::Chart
            && panels(&l.dock).is_some()
            && !holds_kind(&l.dock, k)
        {
            return Err(ToolError::not_found(format!(
                "no {} is open in {}",
                k.words(),
                l.id
            )));
        }
        Ok((id, kind))
    }

    fn focus_target(
        l: &tessera_protocol::layout::Layout,
        input: &WorkspaceTileInput,
    ) -> Result<(Option<String>, Option<OpenTileKind>), ToolError> {
        let (id, kind) = Self::tile_target(l, input)?;
        if id.is_none()
            && let Some(k) = kind
            && !k.singleton()
            && k != OpenTileKind::Chart
            && panels(&l.dock).is_some()
            && !holds_kind(&l.dock, k)
        {
            return Err(ToolError::not_found(format!(
                "no {} is open in {}: workspace.open_tile opens one",
                k.words(),
                l.id
            )));
        }
        Ok((id, kind))
    }

    pub async fn close_tile(
        &self,
        input: WorkspaceTileInput,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let (tile_id, kind) = Self::close_target(&self.get(input.layout_id.as_deref())?, &input)?;
        self.ask_desk(
            input.layout_id.as_deref(),
            "workspace.close_tile",
            origin,
            |l| Self::close_target(l, &input).map(|_| ()),
            DockRequest {
                id: String::new(),
                op: DockOp::Close,
                tile_id,
                kind,
                preset: None,
                settings: None,
                place: None,
            },
        )
        .await
    }

    pub async fn focus_tile(
        &self,
        input: WorkspaceTileInput,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let (tile_id, kind) = Self::focus_target(&self.get(input.layout_id.as_deref())?, &input)?;
        self.ask_desk(
            input.layout_id.as_deref(),
            "workspace.focus_tile",
            origin,
            |l| Self::focus_target(l, &input).map(|_| ()),
            DockRequest {
                id: String::new(),
                op: DockOp::Focus,
                tile_id,
                kind,
                preset: None,
                settings: None,
                place: None,
            },
        )
        .await
    }

    pub async fn apply_preset(
        &self,
        input: WorkspaceApplyPresetInput,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.ask_desk(
            input.layout_id.as_deref(),
            "workspace.apply_preset",
            origin,
            |_| Ok(()),
            DockRequest {
                id: String::new(),
                op: DockOp::Preset,
                tile_id: None,
                kind: None,
                preset: Some(input.preset),
                settings: None,
                place: None,
            },
        )
        .await
    }

    pub async fn set_tile_settings(
        &self,
        input: WorkspaceSetTileSettingsInput,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let layout = self.get(input.layout_id.as_deref())?;
        let id = input.tile_id.trim().to_owned();
        let Some(kind) = kind_of(&layout.dock, &id).or_else(|| {
            layout
                .charts
                .contains_key(&id)
                .then(|| OpenTileKind::Chart.as_str().to_owned())
        }) else {
            return Err(ToolError::not_found(format!(
                "no tile {id} in {} (workspace.list_tiles lists them)",
                layout.id
            )));
        };
        let mut settings = check_settings(&kind, &input.settings)?;
        if let Some(Value::String(s)) = settings.get("instrument") {
            let resolved = self.resolve(s).await?;
            settings.insert("instrument".into(), json!(resolved.as_str()));
        }
        let expected = kind.clone();
        self.ask_desk(
            input.layout_id.as_deref(),
            "workspace.set_tile_settings",
            origin,
            |l| match kind_of(&l.dock, &id) {
                Some(k) if k == expected => Ok(()),
                _ => Err(ToolError::conflict(format!(
                    "tile {id} changed meanwhile; list the tiles again"
                ))),
            },
            DockRequest {
                id: String::new(),
                op: DockOp::Settings,
                tile_id: Some(id.clone()),
                kind: OpenTileKind::from_component(&kind),
                preset: None,
                settings: Some(Value::Object(settings)),
                place: None,
            },
        )
        .await
    }

    pub async fn move_tile(
        &self,
        input: WorkspaceMoveTileInput,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let target = WorkspaceTileInput {
            tile_id: input.tile_id.clone(),
            kind: input.kind,
            layout_id: input.layout_id.clone(),
        };
        if input.to == TilePlace::Popout {
            return Err(ToolError::invalid_input(
                "a tile goes to its own window only from the user's own tab menu (Pop out)",
            ));
        }
        let (tile_id, kind) = Self::focus_target(&self.get(input.layout_id.as_deref())?, &target)?;
        self.ask_desk(
            input.layout_id.as_deref(),
            "workspace.move_tile",
            origin,
            |l| Self::focus_target(l, &target).map(|_| ()),
            DockRequest {
                id: String::new(),
                op: DockOp::Move,
                tile_id,
                kind,
                preset: None,
                settings: None,
                place: Some(input.to),
            },
        )
        .await
    }

    pub async fn set_view(
        &self,
        input: WorkspaceSetViewInput,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let mut view = Map::new();
        for (k, v) in [
            ("left", input.left),
            ("right", input.right),
            ("bottom", input.bottom),
            ("shareInterval", input.share_interval),
            ("focus", input.focus),
        ] {
            if let Some(v) = v {
                view.insert(k.into(), Value::Bool(v));
            }
        }
        if view.is_empty() {
            return Err(ToolError::invalid_input(
                "give left, right, bottom, shareInterval or focus",
            ));
        }
        self.ask_desk(
            input.layout_id.as_deref(),
            "workspace.set_view",
            origin,
            |_| Ok(()),
            DockRequest {
                id: String::new(),
                op: DockOp::View,
                tile_id: None,
                kind: None,
                preset: None,
                settings: Some(Value::Object(view)),
                place: None,
            },
        )
        .await
    }

    pub async fn maximize_tile(
        &self,
        input: WorkspaceMaximizeTileInput,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let target = WorkspaceTileInput {
            tile_id: input.tile_id.clone(),
            kind: input.kind,
            layout_id: input.layout_id.clone(),
        };
        let docked = |l: &tessera_protocol::layout::Layout| -> Result<_, ToolError> {
            let (id, kind) = Self::focus_target(l, &target)?;
            if let Some(id) = &id {
                let (tiles, _) = dock_tiles(
                    &l.dock,
                    l.charts
                        .values()
                        .map(|c| (c.tile_id.clone(), c.title.clone())),
                );
                if let Some(t) = tiles.iter().find(|t| &t.tile_id == id)
                    && t.place == TilePlace::Popout
                {
                    return Err(ToolError::invalid_input(format!(
                        "{id} is in its own window: only a tile on the desk maximizes"
                    )));
                }
            }
            Ok((id, kind))
        };
        let (tile_id, kind) = docked(&self.get(input.layout_id.as_deref())?)?;
        self.ask_desk(
            input.layout_id.as_deref(),
            "workspace.maximize_tile",
            origin,
            |l| docked(l).map(|_| ()),
            DockRequest {
                id: String::new(),
                op: DockOp::Maximize,
                tile_id,
                kind,
                preset: None,
                settings: Some(json!({"restore": input.restore.unwrap_or(false)})),
                place: None,
            },
        )
        .await
    }

    pub async fn set_viewport(
        &self,
        input: ChartSetViewportInput,
        origin: &Origin,
    ) -> Result<ChartSetViewportOutput, ToolError> {
        let mut view = Map::new();
        let time_ways = [
            input.from.is_some() || input.to.is_some(),
            input.last_bars.is_some(),
            input.fit_all == Some(true),
        ]
        .into_iter()
        .filter(|w| *w)
        .count();
        if time_ways > 1 {
            return Err(ToolError::invalid_input(
                "place the time axis one way: from/to, lastBars or fitAll",
            ));
        }
        match (input.from, input.to) {
            (Some(from), to) => {
                let to = to.unwrap_or_else(|| self.clock.now());
                if to <= from {
                    return Err(ToolError::invalid_input("to must be after from"));
                }
                view.insert("from".into(), json!(from.0));
                view.insert("to".into(), json!(to.0));
            }
            (None, Some(_)) => {
                return Err(ToolError::invalid_input("to needs from (or use lastBars)"));
            }
            (None, None) => {}
        }
        if let Some(n) = input.last_bars {
            if !(1..=5_000).contains(&n) {
                return Err(ToolError::invalid_input("lastBars must be 1–5000"));
            }
            view.insert("lastBars".into(), json!(n));
        }
        if input.fit_all == Some(true) {
            view.insert("fitAll".into(), Value::Bool(true));
        }
        match (input.price_min, input.price_max, input.auto_scale) {
            (Some(_), _, Some(true)) | (_, Some(_), Some(true)) => {
                return Err(ToolError::invalid_input(
                    "a fixed price range (priceMin, priceMax) or autoScale, not both",
                ));
            }
            (Some(lo), Some(hi), _) => {
                if !(lo.is_finite() && hi.is_finite() && lo < hi) {
                    return Err(ToolError::invalid_input("priceMin must be below priceMax"));
                }
                view.insert("priceMin".into(), json!(lo));
                view.insert("priceMax".into(), json!(hi));
            }
            (Some(_), None, _) | (None, Some(_), _) => {
                return Err(ToolError::invalid_input(
                    "give priceMin and priceMax together",
                ));
            }
            (None, None, Some(true)) => {
                view.insert("autoScale".into(), Value::Bool(true));
            }
            (None, None, _) => {}
        }
        if view.is_empty() {
            return Err(ToolError::invalid_input(
                "give from/to, lastBars, fitAll, priceMin with priceMax, or autoScale",
            ));
        }
        let tile = input.tile_id.as_deref();
        let target = Self::tile_of(&self.get(input.layout_id.as_deref())?, tile)?;
        let asked = self
            .ask_desk(
                input.layout_id.as_deref(),
                "chart.set_viewport",
                origin,
                |l| Self::tile_of(l, Some(&target)).map(|_| ()),
                DockRequest {
                    id: String::new(),
                    op: DockOp::Viewport,
                    tile_id: Some(target.clone()),
                    kind: Some(OpenTileKind::Chart),
                    preset: None,
                    settings: Some(Value::Object(view)),
                    place: None,
                },
            )
            .await?;
        let shown = self
            .viewport_answer(
                &asked.layout_id,
                &target,
                &asked.request.id,
                VIEWPORT_ANSWER_WAIT,
            )
            .await;
        Ok(ChartSetViewportOutput {
            layout_id: asked.layout_id,
            revision: asked.revision,
            request: asked.request,
            shown,
        })
    }

    pub async fn drawing_history(
        &self,
        input: ChartDrawingHistoryInput,
        redo: bool,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let tile = input.tile_id.as_deref();
        let target = Self::tile_of(&self.get(input.layout_id.as_deref())?, tile)?;
        let reason = if redo {
            "chart.redo_drawing"
        } else {
            "chart.undo_drawing"
        };
        self.ask_desk(
            input.layout_id.as_deref(),
            reason,
            origin,
            |l| Self::tile_of(l, Some(&target)).map(|_| ()),
            DockRequest {
                id: String::new(),
                op: DockOp::Drawings,
                tile_id: Some(target.clone()),
                kind: Some(OpenTileKind::Chart),
                preset: None,
                settings: Some(json!({"action": if redo { "redo" } else { "undo" }})),
                place: None,
            },
        )
        .await
    }

    pub async fn ask_trade_panel(
        &self,
        layout_id: Option<&str>,
        tile: &str,
        patch: Value,
        origin: &Origin,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        self.ask_desk(
            layout_id,
            "trade.set_panel",
            origin,
            |l| Self::tile_of(l, Some(tile)).map(|_| ()),
            DockRequest {
                id: String::new(),
                op: DockOp::Trade,
                tile_id: Some(tile.to_owned()),
                kind: Some(OpenTileKind::Chart),
                preset: None,
                settings: Some(patch),
                place: None,
            },
        )
        .await
    }

    pub fn list_tiles(&self, layout_id: Option<&str>) -> Result<WorkspaceTilesOutput, ToolError> {
        let layout = self.get(layout_id)?;
        let (tiles, collapsed) = dock_tiles(
            &layout.dock,
            layout
                .charts
                .values()
                .map(|c| (c.tile_id.clone(), c.title.clone())),
        );
        Ok(WorkspaceTilesOutput {
            layout_id: layout.id,
            revision: layout.revision,
            tiles,
            collapsed,
        })
    }

    pub async fn set_link(
        &self,
        input: ChartSetLinkInput,
        origin: &Origin,
    ) -> Result<ChartChangeOutput, ToolError> {
        let link = match link_of(&input.link.clone().map_or(Value::Null, Value::String))? {
            Value::String(s) => Some(s),
            _ => None,
        };
        let tile = input.tile_id.as_deref();
        let mut target = String::new();
        let all = input.all == Some(true);
        let (layout, ()) = self
            .mutate(
                input.layout_id.as_deref(),
                "chart.set_link",
                origin,
                tile,
                |l| {
                    target = Self::tile_of(l, tile)?;
                    if all {
                        let instrument = l.charts[&target].instrument.clone();
                        for c in l.charts.values_mut() {
                            c.link_group = link.clone();
                            if link.is_some() && c.instrument != instrument {
                                c.instrument = instrument.clone();
                                c.annotations.clear();
                                c.viewport = None;
                            }
                        }
                        return Ok(());
                    }
                    let lead = link.as_ref().and_then(|g| {
                        l.charts
                            .values()
                            .find(|c| c.tile_id != target && c.link_group.as_ref() == Some(g))
                            .map(|c| c.instrument.clone())
                    });
                    let c = l.charts.get_mut(&target).expect("tile exists");
                    c.link_group = link;
                    if let Some(i) = lead
                        && i != c.instrument
                    {
                        c.instrument = i;
                        c.annotations.clear();
                        c.viewport = None;
                    }
                    Ok(())
                },
            )
            .await?;
        Self::chart_output(&layout, &target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> Value {
        json!({
            "grid": {"root": {"type": "branch", "data": [
                {"type": "leaf", "data": {"views": ["chart-1"], "activeView": "chart-1", "id": "g1"}},
                {"type": "leaf", "data": {"views": ["chart-2", "dom"], "activeView": "dom", "id": "g2"}},
            ]}},
            "panels": {
                "chart-1": {"id": "chart-1", "contentComponent": "chart", "title": "Chart 1", "params": {"layoutId": "default", "tileId": "chart-1", "ticket": {"open": true, "side": "right"}}},
                "chart-2": {"id": "chart-2", "contentComponent": "chart", "title": "Chart 2", "params": {}},
                "dom": {"id": "dom", "contentComponent": "dom", "title": "DOM", "params": {"link": "1", "rowTicks": 2}},
                "markets": {"id": "markets", "contentComponent": "watchlist", "title": "Markets", "params": {"link": "1"}},
                "trade": {"id": "trade", "contentComponent": "trade", "title": "Trade"},
                "analyst": {"id": "analyst", "contentComponent": "analyst", "title": "Analyst"},
                "journal-1": {"id": "journal-1", "contentComponent": "unknown-tile", "title": "Journal", "params": {"originalComponent": "journal", "originalParams": {"x": 1}}},
            },
            "edgeGroups": {
                "left": {"collapsed": true, "visible": true, "group": {"views": ["markets"], "activeView": "markets"}},
                "right": {"visible": true, "group": {"views": ["trade", "analyst"], "activeView": "trade"}},
            },
            "floatingGroups": [{"data": {"views": ["journal-1"], "activeView": "journal-1"}}],
            "tessera": {"v": 2, "popouts": [{"panelId": "chart-3", "kind": "chart", "params": {"ticket": {"open": false}}}]},
        })
    }

    #[test]
    fn the_saved_dock_lists_its_tiles_where_they_are() {
        let (tiles, collapsed) = dock_tiles(&tree(), std::iter::empty());
        let brief: Vec<(&str, &str, TilePlace, bool)> = tiles
            .iter()
            .map(|t| (t.tile_id.as_str(), t.kind.as_str(), t.place, t.visible))
            .collect();
        assert_eq!(
            brief,
            [
                ("chart-1", "chart", TilePlace::Centre, true),
                ("chart-2", "chart", TilePlace::Centre, false),
                ("dom", "dom", TilePlace::Centre, true),
                ("markets", "markets", TilePlace::Left, false),
                ("trade", "trade", TilePlace::Right, true),
                ("analyst", "analyst", TilePlace::Right, false),
                ("journal-1", "journal", TilePlace::Floating, true),
                ("chart-3", "chart", TilePlace::Popout, true),
            ]
        );
        assert_eq!(collapsed, [TilePlace::Left]);
        assert_eq!(tiles[2].params["rowTicks"], 2);
        assert_eq!(
            tiles[6].params,
            json!({"x": 1}),
            "a placeholder's own params"
        );
        assert_eq!(
            tiles[0].params,
            json!({"layoutId": "default", "tileId": "chart-1"})
        );
        assert_eq!(tiles[7].params, json!({}));
        let mut shut = tree();
        shut["edgeGroups"]["right"]["collapsed"] = json!(true);
        let (tiles, collapsed) = dock_tiles(&shut, std::iter::empty());
        assert_eq!(collapsed, [TilePlace::Left, TilePlace::Right]);
        assert!(
            tiles
                .iter()
                .filter(|t| t.place == TilePlace::Right)
                .all(|t| !t.visible)
        );
        let (tiles, _) = dock_tiles(
            &json!({"tessera": {"v": 2}}),
            [("chart-1".to_owned(), "Chart 1".to_owned())].into_iter(),
        );
        assert_eq!(tiles.len(), 1);
        assert_eq!(tiles[0].kind, "chart");
    }

    #[test]
    fn tile_settings_are_checked_for_their_kind() {
        let dom = check_settings(
            "dom",
            &json!({"rowTicks": 4, "volumeColumn": "recent", "autoCentre": false, "link": "2"}),
        )
        .unwrap();
        assert_eq!(dom["rowTicks"], 4);
        assert_eq!(dom["link"], "2");
        let tape = check_settings(
            "tape",
            &json!({"minSize": 10, "highlight": "auto", "side": "buy", "aggregate": false, "millis": true, "link": null}),
        )
        .unwrap();
        assert_eq!(tape["link"], Value::Null);
        assert!(check_settings("tape", &json!({"highlight": 25})).is_ok());
        let err = check_settings("markets", &json!({"link": "1"})).unwrap_err();
        assert_eq!(err.message, MARKETS_IS_AN_AREA);
        for (kind, bad) in [
            ("dom", json!({"rowTicks": 3})),
            ("dom", json!({"volumeColumn": "all"})),
            ("dom", json!({"minSize": 5})),
            ("tape", json!({"minSize": 0})),
            ("tape", json!({"side": "both"})),
            ("tape", json!({"millis": "yes"})),
            ("markets", json!({"link": "5"})),
            ("markets", json!({})),
            ("dom", json!(4)),
            ("chart", json!({"link": "1"})),
            ("analyst", json!({"link": "1"})),
            ("trade", json!({"qty": 2})),
        ] {
            assert!(check_settings(kind, &bad).is_err(), "{kind} {bad}");
        }
    }
}
