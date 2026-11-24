use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tessera_protocol::chart_theme::{self, ChartThemeGetInput, ChartThemeOutput};
use tessera_protocol::io::{
    SettingsGetInput, SettingsGetOutput, SettingsSetInput, SettingsSetOutput,
};
use tessera_protocol::theme::{
    self, ThemeDeleteInput, ThemeGetInput, ThemeOutput, ThemeRenameInput, ThemeSaveInput,
    ThemeSavedOutput,
};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::settings::SettingsService;

struct SettingsGet(Arc<SettingsService>);

#[async_trait]
impl Tool for SettingsGet {
    type Input = SettingsGetInput;
    type Output = SettingsGetOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("settings.get", "Get settings", RiskTier::Read)
            .description("Current values, defaults, descriptions and schemas of Tessera settings (all, or the given keys).")
            .activity("Read settings")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: SettingsGetInput,
    ) -> Result<SettingsGetOutput, ToolError> {
        self.0.get(input.keys.as_deref())
    }

    fn summarize(&self, o: &SettingsGetOutput) -> Option<String> {
        Some(format!("{} settings", o.settings.len()))
    }
}

struct SettingsSet(Arc<SettingsService>);

#[async_trait]
impl Tool for SettingsSet {
    type Input = SettingsSetInput;
    type Output = SettingsSetOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("settings.set", "Change a setting", RiskTier::Modify)
            .description("Sets one setting after validating it against its schema (settings_get lists every key with its description, value and schema). appearance.theme (the whole app's theme, charts included) and appearance.chartTheme (its chart part) merge: send only what changes, e.g. {\"preset\": \"solarized-light\"} for the whole app in Solarized Light; trade.orderHotkeys merges too, and only the user turns order hotkeys on (an agent may turn them off, and change their keys while they are off). Safety settings (userOnly: the agent loop guards, approval staleness, where market data comes from, trade templates, the trader's risk limits) can only be changed by the user; agents and MCP clients are refused.")
            .activity("Changed setting")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: SettingsSetInput,
    ) -> Result<SettingsSetOutput, ToolError> {
        self.0.set(&input.key, input.value, &ctx.origin).await
    }

    async fn preview(
        &self,
        ctx: &ToolCtx,
        input: &SettingsSetInput,
    ) -> Result<serde_json::Value, ToolError> {
        self.0.check_writer(&input.key, &ctx.origin)?;
        let value = self.0.check_change(&input.key, &input.value)?;
        self.0
            .check_order_hotkeys_origin(&input.key, &value, &ctx.origin)?;
        Ok(serde_json::to_value(input)?)
    }

    fn summarize(&self, o: &SettingsSetOutput) -> Option<String> {
        Some(format!("{} = {}", o.key, o.value))
    }
}

struct GetChartTheme(Arc<SettingsService>);

#[async_trait]
impl Tool for GetChartTheme {
    type Input = ChartThemeGetInput;
    type Output = ChartThemeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("appearance.get_chart_theme", "Get the chart theme", RiskTier::Read)
            .description("Every colour the charts draw with now (palette, canvas, axis, crosshair, last price, candles, volume, levels, orders, profile, footprint, delta, big trades, drawings) as `group.key` → #rrggbb[aa], the text sizes, the chart look it starts from (tessera: the app theme's own chart), the keys the user overrode, and the looks. Change any of it with settings_set key appearance.chartTheme: send only the keys that change, e.g. {\"canvas\": {\"gridVertical\": \"#ffffff10\"}}. The whole app's theme is appearance_get_theme.")
            .activity("Read the chart theme")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: ChartThemeGetInput,
    ) -> Result<ChartThemeOutput, ToolError> {
        Ok(chart_theme::output(
            &self.0.theme().0,
            &self.0.string(chart_theme::UP_DOWN_KEY),
        ))
    }

    fn summarize(&self, o: &ChartThemeOutput) -> Option<String> {
        Some(format!(
            "{} theme, {} overrides",
            o.preset,
            o.overridden.len()
        ))
    }
}

fn theme_output(s: &SettingsService) -> ThemeOutput {
    theme::output(
        &s.stored(theme::KEY).unwrap_or_else(|| json!({})),
        &s.stored(theme::SAVED_KEY).unwrap_or_else(|| json!({})),
        &s.string(chart_theme::UP_DOWN_KEY),
    )
}

fn refused(e: String) -> ToolError {
    ToolError::invalid_input(e)
}

struct GetTheme(Arc<SettingsService>);

#[async_trait]
impl Tool for GetTheme {
    type Input = ThemeGetInput;
    type Output = ThemeOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("appearance.get_theme", "Get the theme", RiskTier::Read)
            .description("The theme the whole app draws with now, app and charts alike: the built-in it starts from, the saved theme it shows (if any), dark or light, every colour as `group.key` → #rrggbb[aa] (the app's surfaces, ink, lines, accents, semantics, card and categorical groups, then the chart's), the chart look and text sizes, the keys set over the built-in, the built-in themes and the saved ones, and the theme's own value (what Export writes). Change it with settings_set key appearance.theme, sending only what changes: {\"preset\": \"solarized-light\"} makes the whole app Solarized Light; {\"surfaces\": {\"ground\": \"#101418\"}} changes one colour. Save it with appearance_save_theme.")
            .activity("Read the theme")
    }

    async fn call(&self, _ctx: &ToolCtx, _input: ThemeGetInput) -> Result<ThemeOutput, ToolError> {
        Ok(theme_output(&self.0))
    }

    fn summarize(&self, o: &ThemeOutput) -> Option<String> {
        let name = o
            .saved
            .as_ref()
            .map_or(o.preset.as_str(), |t| t.name.as_str());
        Some(format!(
            "{name}, {}, {} own colours",
            o.mode.as_str(),
            o.overridden.len()
        ))
    }
}

struct SaveTheme(Arc<SettingsService>);

#[async_trait]
impl Tool for SaveTheme {
    type Input = ThemeSaveInput;
    type Output = ThemeSavedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("appearance.save_theme", "Save a theme", RiskTier::Modify)
            .description("Saves a theme under a name and shows it, so later changes to appearance.theme save into it (\"save this as Night Desk\" is {\"name\": \"Night Desk\"}). It saves the theme shown now, or `from` (a saved theme's id or name, or a built-in's id, to duplicate it), or `theme` (a theme as Export writes it, to import one). A saved theme of the same name is replaced. Saved themes stay across updates; the built-ins cannot be changed.")
            .activity("Saved a theme")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: ThemeSaveInput,
    ) -> Result<ThemeSavedOutput, ToolError> {
        let s = &self.0;
        let active = s.stored(theme::KEY).unwrap_or_else(|| json!({}));
        let saved = s.stored(theme::SAVED_KEY).unwrap_or_else(|| json!({}));
        let value = match &input.theme {
            Some(t) => theme::read_import(t).map_err(refused)?.1,
            None => theme::source(&active, &saved, input.from.as_deref()).map_err(refused)?,
        };
        theme::check(&value, &s.string(chart_theme::UP_DOWN_KEY)).map_err(refused)?;
        let out = theme::save(&saved, &input.name, &value).map_err(refused)?;
        s.set(theme::SAVED_KEY, out.saved, &ctx.origin).await?;
        s.set(theme::KEY, json!({"saved": out.theme.id}), &ctx.origin)
            .await?;
        Ok(ThemeSavedOutput {
            id: out.theme.id,
            name: out.theme.name,
            replaced: out.replaced,
            theme: theme_output(s),
        })
    }

    fn summarize(&self, o: &ThemeSavedOutput) -> Option<String> {
        Some(if o.replaced {
            format!("replaced {}", o.name)
        } else {
            format!("saved {}", o.name)
        })
    }
}

struct RenameTheme(Arc<SettingsService>);

#[async_trait]
impl Tool for RenameTheme {
    type Input = ThemeRenameInput;
    type Output = ThemeSavedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "appearance.rename_theme",
            "Rename a theme",
            RiskTier::Modify,
        )
        .description("Renames a saved theme (by its id or name). Built-in themes keep their names.")
        .activity("Renamed a theme")
        .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: ThemeRenameInput,
    ) -> Result<ThemeSavedOutput, ToolError> {
        let s = &self.0;
        let saved = s.stored(theme::SAVED_KEY).unwrap_or_else(|| json!({}));
        let (list, t) = theme::rename(&saved, &input.id, &input.name).map_err(refused)?;
        s.set(theme::SAVED_KEY, list, &ctx.origin).await?;
        Ok(ThemeSavedOutput {
            id: t.id,
            name: t.name,
            replaced: false,
            theme: theme_output(s),
        })
    }

    fn summarize(&self, o: &ThemeSavedOutput) -> Option<String> {
        Some(format!("renamed {}", o.name))
    }
}

struct DeleteTheme(Arc<SettingsService>);

#[async_trait]
impl Tool for DeleteTheme {
    type Input = ThemeDeleteInput;
    type Output = ThemeSavedOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("appearance.delete_theme", "Delete a theme", RiskTier::Modify)
            .description("Deletes a saved theme (by its id or name). If it is shown, the app keeps its colours as unsaved ones, so nothing on screen changes. Built-in themes cannot be deleted.")
            .activity("Deleted a theme")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: ThemeDeleteInput,
    ) -> Result<ThemeSavedOutput, ToolError> {
        let s = &self.0;
        let saved = s.stored(theme::SAVED_KEY).unwrap_or_else(|| json!({}));
        let (list, t) = theme::remove(&saved, &input.id).map_err(refused)?;
        if s.theme().1.is_some_and(|shown| shown.id == t.id) {
            s.set(theme::KEY, json!({"saved": null}), &ctx.origin)
                .await?;
        }
        s.set(theme::SAVED_KEY, list, &ctx.origin).await?;
        Ok(ThemeSavedOutput {
            id: t.id,
            name: t.name,
            replaced: false,
            theme: theme_output(s),
        })
    }

    fn summarize(&self, o: &ThemeSavedOutput) -> Option<String> {
        Some(format!("deleted {}", o.name))
    }
}

pub(crate) fn register(
    r: &mut ToolRegistry,
    s: &Arc<SettingsService>,
) -> Result<(), RegistryError> {
    r.register(SettingsGet(Arc::clone(s)))?;
    r.register(SettingsSet(Arc::clone(s)))?;
    r.register(GetChartTheme(Arc::clone(s)))?;
    r.register(GetTheme(Arc::clone(s)))?;
    r.register(SaveTheme(Arc::clone(s)))?;
    r.register(RenameTheme(Arc::clone(s)))?;
    r.register(DeleteTheme(Arc::clone(s)))?;
    Ok(())
}
