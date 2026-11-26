use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tessera_core::ids::numbered;
use tessera_core::{Origin, Timeframe};
use tessera_protocol::io::LayoutSaveInput;
use tessera_protocol::layout::{ChartState, Layout, OverlayNamespace};
use tessera_protocol::surfaces::{
    UiArea, WorkspaceCreateInput, WorkspaceCreatedOutput, WorkspaceDuplicateInput,
};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::layout::{DOCK_VIEW_KEY, LayoutService};
use crate::settings::SettingsService;
use crate::templates::TemplateService;

const NAME_MAX: usize = 60;

fn clean_name(name: &str) -> Result<String, ToolError> {
    let n = name.trim();
    if n.is_empty() {
        return Err(ToolError::invalid_input("a workspace needs a name"));
    }
    Ok(n.chars().take(NAME_MAX).collect())
}

fn next_name(names: &[String]) -> String {
    (names.len() + 1..)
        .map(|n| format!("Workspace {n}"))
        .find(|n| !names.contains(n))
        .expect("unbounded")
}

fn copy_name(name: &str, names: &[String]) -> String {
    numbered(&format!("{name} copy"), " ")
        .find(|n| !names.contains(n))
        .expect("unbounded")
}

pub(crate) fn new_id(now_ms: i64, taken: &[String]) -> String {
    let mut n = u64::try_from(now_ms).unwrap_or_default();
    loop {
        let mut digits = Vec::new();
        let mut x = n;
        loop {
            let d = (x % 36) as u32;
            digits.push(char::from_digit(d, 36).expect("base 36"));
            x /= 36;
            if x == 0 {
                break;
            }
        }
        let id = format!("ws-{}", digits.iter().rev().collect::<String>());
        if !taken.contains(&id) {
            return id;
        }
        n += 1;
    }
}

pub fn retarget_dock(dock: &Value, from: &str, to: &str) -> Value {
    let Value::Object(root) = dock else {
        return dock.clone();
    };
    let mut root = root.clone();
    if let Some(Value::Object(panels)) = root.get_mut("panels") {
        for panel in panels.values_mut() {
            if let Some(params) = panel.get_mut("params").and_then(Value::as_object_mut)
                && params.get("layoutId").and_then(Value::as_str) == Some(from)
            {
                params.insert("layoutId".into(), json!(to));
            }
        }
    }
    if let Some(Value::Object(view)) = root.get_mut(DOCK_VIEW_KEY) {
        view.remove("open");
        view.remove("ops");
    }
    Value::Object(root)
}

async fn show(settings: &Arc<SettingsService>, id: &str, origin: &Origin) -> Result<(), ToolError> {
    settings.set("ui.workspace", json!(id), origin).await?;
    settings
        .set("ui.area", json!(UiArea::Desk.as_str()), origin)
        .await?;
    Ok(())
}

struct NewWorkspace {
    id: String,
    name: String,
    dock: Option<Value>,
    active_chart_id: Option<String>,
    charts: BTreeMap<String, ChartState>,
    show: bool,
}

impl NewWorkspace {
    async fn save(
        self,
        layouts: &LayoutService,
        settings: &Arc<SettingsService>,
        ctx: &ToolCtx,
    ) -> Result<WorkspaceCreatedOutput, ToolError> {
        layouts
            .save(
                LayoutSaveInput {
                    layout_id: Some(self.id.clone()),
                    expected_revision: None,
                    name: Some(self.name.clone()),
                    dock: self.dock,
                    active_chart_id: self.active_chart_id,
                    charts: Some(self.charts),
                    trade: None,
                },
                &ctx.origin,
            )
            .await?;
        if self.show {
            show(settings, &self.id, &ctx.origin).await?;
        }
        Ok(WorkspaceCreatedOutput {
            layout_id: self.id,
            name: self.name,
            shown: self.show,
        })
    }
}

fn summary(o: &WorkspaceCreatedOutput) -> Option<String> {
    Some(format!("{} · {}", o.name, o.layout_id))
}

fn names(layouts: &LayoutService) -> (Vec<String>, Vec<String>) {
    let list = layouts.list().layouts;
    (
        list.iter().map(|l| l.name.clone()).collect(),
        list.iter().map(|l| l.id.clone()).collect(),
    )
}

fn chosen_instrument(settings: &SettingsService) -> Option<String> {
    settings
        .stored("market.defaultInstrument")
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn recent_instruments(settings: &SettingsService) -> Vec<String> {
    settings
        .value("ui.preferences")
        .as_ref()
        .and_then(|v| v.get("recentSymbols"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

struct WorkspaceCreate {
    layouts: Arc<LayoutService>,
    settings: Arc<SettingsService>,
    templates: Option<Arc<TemplateService>>,
}

impl WorkspaceCreate {
    fn candidates(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(chosen) = chosen_instrument(&self.settings) {
            out.push(chosen);
        }
        if let Some(active) = self.layouts.active_chart_instrument() {
            out.push(active.as_str().to_owned());
        }
        out.extend(recent_instruments(&self.settings));
        if let Some(last) = self.layouts.last_chart_instrument() {
            let last = last.as_str().to_owned();
            if !out.contains(&last) {
                out.push(last);
            }
        }
        out
    }

    async fn default_instrument(&self) -> Option<tessera_core::InstrumentId> {
        for candidate in self.candidates() {
            if let Ok(id) = self.layouts.resolve_instrument(&candidate).await {
                return Some(id);
            }
        }
        None
    }

    fn chart(&self, instrument: tessera_core::InstrumentId, tf: Timeframe) -> ChartState {
        let mut chart = ChartState {
            tile_id: "chart-1".into(),
            title: "Chart 1".into(),
            instrument,
            timeframe: tf,
            print_bars: None,
            layers: Vec::new(),
            annotations: Vec::new(),
            viewport: None,
            link_group: None,
            chart_type: None,
            hours: None,
            drawings: Vec::new(),
            drawings_from: Vec::new(),
        };
        if let Some(templates) = &self.templates {
            let all = templates.list();
            if let Some(t) = all
                .default_id
                .as_deref()
                .and_then(|id| all.templates.iter().find(|t| t.id == id))
                && let Err(e) =
                    tessera_protocol::templates::apply(&mut chart, t, OverlayNamespace::User, None)
            {
                tracing::warn!(error = %e, "a new workspace's chart starts without its default template");
            }
        }
        chart
    }
}

#[async_trait]
impl Tool for WorkspaceCreate {
    type Input = WorkspaceCreateInput;
    type Output = WorkspaceCreatedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.create", "New workspace", RiskTier::Modify)
            .description("Makes a new workspace, as the workspace menu's New workspace does: one chart on `instrument` at `timeframe` (default: chart.defaultTimeframe) with the default chart template's indicators, named `name` (default `Workspace N`), and shows it on the desk unless `show: false` (the desk lays it out: Trade and the analyst as tabs on the right, Positions and Accounts at the bottom). `instrument` defaults to the one you last charted, or market.defaultInstrument when it is set; with neither, the workspace opens on an empty desk to pick a market. For a story's workspace (Trade, Scalp, Analyse, Review) use workspace.apply_preset; to copy one, workspace.duplicate.")
            .activity("Made a workspace")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceCreateInput,
    ) -> Result<WorkspaceCreatedOutput, ToolError> {
        let (names, ids) = names(&self.layouts);
        let name = match input.name.as_deref() {
            Some(n) => clean_name(n)?,
            None => next_name(&names),
        };
        let resolved = match input.instrument.as_deref().map(str::trim) {
            Some(i) if !i.is_empty() => Some(self.layouts.resolve_instrument(i).await?),
            _ => self.default_instrument().await,
        };
        let tf = match input.timeframe {
            Some(tf) => tf,
            None => serde_json::from_value(json!(self.settings.string("chart.defaultTimeframe")))
                .unwrap_or(Timeframe::M5),
        };
        let id = new_id(ctx.now.0 / 1_000_000, &ids);
        let mut charts = BTreeMap::new();
        if let Some(instrument) = resolved {
            charts.insert("chart-1".to_owned(), self.chart(instrument, tf));
        }
        let workspace = NewWorkspace {
            id,
            name,
            dock: None,
            active_chart_id: charts.contains_key("chart-1").then(|| "chart-1".into()),
            charts,
            show: input.show != Some(false),
        };
        workspace.save(&self.layouts, &self.settings, ctx).await
    }

    fn summarize(&self, o: &WorkspaceCreatedOutput) -> Option<String> {
        summary(o)
    }
}

struct WorkspaceDuplicate {
    layouts: Arc<LayoutService>,
    settings: Arc<SettingsService>,
}

#[async_trait]
impl Tool for WorkspaceDuplicate {
    type Input = WorkspaceDuplicateInput;
    type Output = WorkspaceCreatedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("workspace.duplicate", "Duplicate a workspace", RiskTier::Modify)
            .description("Copies a workspace (default: the one the desk shows), as the workspace menu's Duplicate does: its charts with their indicators, drawings and links, and its tiles where they are, under `name` (default `<name> copy`); its Trade panel setup is not copied (the copy's panels start fresh). Shows the copy on the desk unless `show: false`.")
            .activity("Duplicated a workspace")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WorkspaceDuplicateInput,
    ) -> Result<WorkspaceCreatedOutput, ToolError> {
        let shown_now = self.settings.string("ui.workspace");
        let from = match input.layout_id.as_deref().map(str::trim) {
            Some(id) if !id.is_empty() => id.to_owned(),
            _ if !shown_now.is_empty() => shown_now,
            _ => self.layouts.active_id(),
        };
        let original: Layout = self.layouts.get(Some(&from))?;
        let (names, ids) = names(&self.layouts);
        let name = match input.name.as_deref() {
            Some(n) => clean_name(n)?,
            None => copy_name(&original.name, &names),
        };
        let id = new_id(ctx.now.0 / 1_000_000, &ids);
        let dock = (!original.dock.is_null()).then(|| retarget_dock(&original.dock, &from, &id));
        let copy = NewWorkspace {
            id,
            name,
            dock,
            active_chart_id: original.active_chart_id,
            charts: original.charts,
            show: input.show != Some(false),
        };
        copy.save(&self.layouts, &self.settings, ctx).await
    }

    fn summarize(&self, o: &WorkspaceCreatedOutput) -> Option<String> {
        summary(o)
    }
}

pub(crate) fn register(
    r: &mut ToolRegistry,
    layouts: &Arc<LayoutService>,
    settings: &Arc<SettingsService>,
    templates: Option<&Arc<TemplateService>>,
) -> Result<(), RegistryError> {
    r.register(WorkspaceCreate {
        layouts: Arc::clone(layouts),
        settings: Arc::clone(settings),
        templates: templates.cloned(),
    })?;
    r.register(WorkspaceDuplicate {
        layouts: Arc::clone(layouts),
        settings: Arc::clone(settings),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_ids_and_docks_follow_the_menu() {
        let names = vec!["Workspace 2".to_owned(), "Day".to_owned()];
        assert_eq!(next_name(&names), "Workspace 3");
        assert_eq!(copy_name("Day", &names), "Day copy");
        assert_eq!(copy_name("Day", &["Day copy".to_owned()]), "Day copy 2");
        let id = new_id(1_700_000_000_000, &[]);
        assert_eq!(id, "ws-loyw3v28");
        assert_ne!(new_id(1_700_000_000_000, &[id]), "ws-loyw3v28");
        let dock = json!({
            "panels": {
                "chart-1": {"params": {"layoutId": "day", "tileId": "chart-1"}},
                "dom": {"params": {"rowTicks": 2}},
            },
            "tessera": {"v": 2, "open": [{"id": "open-3"}], "ops": [{"id": "op-4"}], "syncInterval": true},
        });
        let copy = retarget_dock(&dock, "day", "ws-1");
        assert_eq!(copy["panels"]["chart-1"]["params"]["layoutId"], "ws-1");
        assert_eq!(copy["panels"]["dom"]["params"]["rowTicks"], 2);
        assert!(copy["tessera"].get("open").is_none() && copy["tessera"].get("ops").is_none());
        assert_eq!(copy["tessera"]["syncInterval"], true);
    }
}
