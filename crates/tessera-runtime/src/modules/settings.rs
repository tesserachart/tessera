use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_host::{
    KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicKey, TopicSizing,
    TsExports,
};
use tessera_protocol::chart_theme::{ChartThemeGetInput, ChartThemeOutput};
use tessera_protocol::io::{
    SettingsEvent, SettingsGetInput, SettingsGetOutput, SettingsSetInput, SettingsSetOutput,
};
use tessera_protocol::rpc::RpcError;
use tessera_protocol::theme::{
    ThemeDeleteInput, ThemeGetInput, ThemeOutput, ThemeRenameInput, ThemeSaveInput,
    ThemeSavedOutput,
};
use tessera_protocol::topics::{NoParams, names};
use tessera_protocol::watchlists::{
    WatchlistOutput, WatchlistsAddInput, WatchlistsCreateInput, WatchlistsDeleteInput,
    WatchlistsListInput, WatchlistsMoveInput, WatchlistsOutput, WatchlistsRemoveInput,
    WatchlistsRenameInput,
};
use tessera_tools::{RegistryError, ToolRegistry};

use crate::settings::SettingsService;
use crate::watchlists::WatchlistService;

pub struct SettingsModule {
    settings: Arc<SettingsService>,
    watchlists: Arc<WatchlistService>,
}

impl std::fmt::Debug for SettingsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsModule").finish_non_exhaustive()
    }
}

impl SettingsModule {
    pub fn new(settings: Arc<SettingsService>) -> Self {
        let watchlists = WatchlistService::new(Arc::clone(&settings));
        Self {
            settings,
            watchlists,
        }
    }
}

impl RuntimeModule for SettingsModule {
    fn name(&self) -> &'static str {
        "settings"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        crate::tools::settings::register(r, &self.settings)?;
        crate::tools::watchlists::register(r, &self.watchlists)
    }

    fn topics(&self, host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        let bus = Arc::clone(&host.ctx.bus);
        self.settings.on_change(move |key, value| {
            bus.publish(
                names::SETTINGS,
                TopicKey::None,
                &SettingsEvent::Changed {
                    key: key.to_owned(),
                    value: value.clone(),
                },
            );
        });
        vec![Arc::new(SettingsTopic(Arc::clone(&self.settings)))]
    }
}

struct SettingsTopic(Arc<SettingsService>);

#[async_trait]
impl TopicHandler for SettingsTopic {
    fn name(&self) -> &'static str {
        names::SETTINGS
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::SNAPSHOT
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        let values = self
            .0
            .get(None)
            .map(|out| {
                out.settings
                    .into_iter()
                    .map(|(k, i)| (k, i.value))
                    .collect()
            })
            .unwrap_or_default();
        Ok(Subscribed::new(KeyFilter::All).snapshot(&SettingsEvent::Snapshot { values }))
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (settings)")
        .tool::<SettingsGetInput, SettingsGetOutput>("settings.get")
        .tool::<SettingsSetInput, SettingsSetOutput>("settings.set")
        .tool::<ChartThemeGetInput, ChartThemeOutput>("appearance.get_chart_theme")
        .tool::<ThemeGetInput, ThemeOutput>("appearance.get_theme")
        .tool::<ThemeSaveInput, ThemeSavedOutput>("appearance.save_theme")
        .tool::<ThemeRenameInput, ThemeSavedOutput>("appearance.rename_theme")
        .tool::<ThemeDeleteInput, ThemeSavedOutput>("appearance.delete_theme")
        .tool::<WatchlistsListInput, WatchlistsOutput>("watchlists.list")
        .tool::<WatchlistsCreateInput, WatchlistOutput>("watchlists.create")
        .tool::<WatchlistsRenameInput, WatchlistOutput>("watchlists.rename")
        .tool::<WatchlistsDeleteInput, WatchlistsOutput>("watchlists.delete")
        .tool::<WatchlistsAddInput, WatchlistOutput>("watchlists.add")
        .tool::<WatchlistsRemoveInput, WatchlistOutput>("watchlists.remove")
        .tool::<WatchlistsMoveInput, WatchlistsOutput>("watchlists.move")
        .topic::<NoParams, SettingsEvent>(names::SETTINGS)
}
