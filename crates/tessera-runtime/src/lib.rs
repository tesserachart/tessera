pub mod alerts;
pub mod auth;
pub mod build_source;
pub mod cli;
pub mod connections;
pub mod connectors;
pub mod depth_archive;
pub mod drawing_templates;
pub mod from_install_dir;
pub mod from_nightly;
pub mod r#gen;
pub mod handover;
pub mod layout;
pub mod level_sources;
pub mod lock;
pub mod logging;
pub mod mcp_stdio;
pub mod modules;
pub mod observer;
pub mod presets;
pub mod private;
pub mod recording;
pub mod secrets;
pub mod server;
pub mod session_runner;
pub mod settings;
pub mod state;
pub mod telemetry;
pub mod templates;
pub mod tools;
pub mod watchlists;
pub mod ws;

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::Context;
use serde_json::{Value, json};
use tessera_agent::AgentModule;
use tessera_broker::BrokerModule;
use tessera_broker::paper::{AccountSeed, Commission, PaperConfig, default_seeds};
use tessera_concepts::ConceptsModule;
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{SharedClock, SystemClock};
use tessera_host::{
    EventBus, InstrumentResolver, ModuleContext, ModuleHost, RuntimeModule, TopicHandler, TopicKey,
};
use tessera_intel::IntelModule;
use tessera_market::{MarketDataProvider, MarketModule, MarketRouter};
use tessera_protocol::tools::{ApprovalResolution, ApprovalStatus};
use tessera_protocol::topics::names;
use tessera_research::ResearchModule;
use tessera_store::{DataDir, Store};
use tessera_tools::approvals::StalenessPolicy;
use tessera_tools::{Extensions, Invoker, InvokerConfig, LoopLimits, ToolRegistry};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::auth::{OriginPolicy, SessionToken, Tickets};
use crate::connections::{ConnectionsModule, ConnectionsService, IntelRouter};
use crate::connectors::{Connectors, LiveRithmic, RithmicFactory};
use crate::layout::LayoutService;
use crate::lock::DataDirLock;
use crate::modules::core::{CoreModule, StateCell};
use crate::modules::settings::SettingsModule;
use crate::modules::workspace::WorkspaceModule;
use crate::observer::RuntimeObserver;
use crate::secrets::Secrets;
use crate::settings::{
    ACCOUNT_TYPES, DISPLAY_TIME_ZONE, PAPER_COMMISSION_MICRO, PAPER_COMMISSION_STANDARD,
    SettingsService,
};
use crate::state::{AppState, SharedState};

pub use tessera_host::{ModuleFactory, ToolsModule};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub struct RuntimeConfig {
    pub port: u16,
    pub data_dir: Option<PathBuf>,
    pub data_dir_lock: Option<Arc<DataDirLock>>,
    pub ui_dir: Option<PathBuf>,
    pub review_origins: Vec<String>,
    pub agents: bool,
    pub clock: SharedClock,
    pub paper_accounts: Vec<AccountSeed>,
    pub secrets: Option<Secrets>,
    pub rithmic: Option<Arc<dyn RithmicFactory>>,
    pub rithmic_credentials: Option<PathBuf>,
    pub level_http: Option<Arc<dyn tessera_intel::source::http::HttpClient>>,
    pub alert_webhooks: Option<Arc<dyn tessera_alerts::WebhookSender>>,
    pub mcp_exe: Option<PathBuf>,
    pub claude_desktop_config: Option<PathBuf>,
    pub cloud_url: Option<String>,
    pub launch_tickets: Option<auth::LaunchSink>,
    pub agent_providers: Option<Vec<tessera_agent::BuildProvider>>,
    pub issue_filer: Option<Arc<dyn session_runner::issues::IssueFiler>>,
    pub telemetry: telemetry::Project,
}

impl std::fmt::Debug for RuntimeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeConfig")
            .field("port", &self.port)
            .field("data_dir", &self.data_dir)
            .field("ui_dir", &self.ui_dir)
            .field("rithmic_credentials", &self.rithmic_credentials.is_some())
            .field("mcp_exe", &self.mcp_exe)
            .field("claude_desktop_config", &self.claude_desktop_config)
            .field("cloud_url", &self.cloud_url)
            .field("launch_tickets", &self.launch_tickets.is_some())
            .finish_non_exhaustive()
    }
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            port: 0,
            data_dir: None,
            data_dir_lock: None,
            ui_dir: None,
            review_origins: Vec::new(),
            agents: false,
            clock: Arc::new(SystemClock),
            paper_accounts: default_seeds(),
            secrets: None,
            rithmic: None,
            rithmic_credentials: None,
            level_http: None,
            alert_webhooks: None,
            mcp_exe: None,
            claude_desktop_config: None,
            cloud_url: None,
            launch_tickets: None,
            agent_providers: None,
            issue_filer: None,
            telemetry: telemetry::Project::default(),
        }
    }
}

pub struct Runtime {
    state: SharedState,
    listener: TcpListener,
    shutdown_tx: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
    connectors: Arc<Connectors>,
    data_dir_lock: Option<Arc<DataDirLock>>,
    discovery_dir: Option<PathBuf>,
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runtime")
            .field("port", &self.state.port)
            .finish_non_exhaustive()
    }
}

pub fn windows_install_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("Tessera"))
        .filter(|_| cfg!(windows))
}

pub fn default_data_dir() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("tessera"));
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    xdg.or_else(|| {
        if cfg!(target_os = "macos") {
            home().map(|h| h.join("Library/Application Support/Tessera"))
        } else if cfg!(windows) {
            windows_install_dir().map(|d| d.join(from_install_dir::DATA_DIR))
        } else {
            home().map(|h| h.join(".local/share/tessera"))
        }
    })
}

impl Runtime {
    pub async fn build(config: RuntimeConfig, extra: Vec<ModuleFactory>) -> anyhow::Result<Self> {
        let clock = Arc::clone(&config.clock);

        let data_dir_lock = match (&config.data_dir, &config.data_dir_lock) {
            (Some(dir), Some(lock)) => {
                anyhow::ensure!(
                    lock.dir() == dir.as_path(),
                    "the data directory lock is for {}, not {}",
                    lock.dir().display(),
                    dir.display()
                );
                Some(Arc::clone(lock))
            }
            (Some(dir), None) => Some(Arc::new(DataDirLock::acquire(dir)?)),
            (None, _) => None,
        };

        let (store, bar_store, tick_store) = match &config.data_dir {
            Some(dir) => {
                for sub in DataDir::new(dir).private_dirs() {
                    private::private_dir(&sub)
                        .with_context(|| format!("creating {}", sub.display()))?;
                }
                let dir = dir.clone();
                tokio::task::spawn_blocking(move || {
                    let store = Store::open_in_dir(&dir)?;
                    let bars = tessera_store::bars::BarStore::open_in_dir(&dir)
                        .inspect_err(|e| tracing::warn!(error = %e, "the bar store is unavailable"))
                        .ok();
                    let ticks = tessera_store::ticks::TickStore::open_in_dir(&dir)
                        .inspect_err(
                            |e| tracing::warn!(error = %e, "the tick store is unavailable"),
                        )
                        .ok();
                    private::protect_data_dir(&dir)
                        .with_context(|| format!("protecting {}", dir.display()))?;
                    anyhow::Ok((store, bars, ticks))
                })
                .await??
            }
            None => (Store::open_in_memory()?, None, None),
        };
        cancel_orphaned_approvals(&store, clock.now())?;
        cancel_orphaned_drafts(&store, clock.now())?;

        let market = MarketRouter::new();
        if let Some(bars) = bar_store {
            market.set_bar_cache(tessera_market::BarCache::new(
                Arc::new(bars),
                Arc::clone(&clock),
            ));
        }
        let level_recorder = tessera_intel::history::recorder::LevelRecorder::new(
            store.clone(),
            Arc::new(SystemClock),
        );
        let intel = IntelRouter::recording(level_recorder);
        let bus = Arc::new(EventBus::new());
        let settings = SettingsService::load(store.clone(), Arc::clone(&clock))?;
        let telemetry =
            telemetry::Telemetry::new(config.telemetry.clone(), config.data_dir.as_deref());
        telemetry.set_consent(telemetry::Consent::of(
            settings.value(telemetry::CONSENT).as_ref(),
        ));
        telemetry.start().await;
        {
            let t = telemetry.clone();
            settings.on_change(move |key, value| {
                if key == telemetry::CONSENT {
                    t.set_consent(telemetry::Consent::of(Some(value)));
                }
            });
        }
        apply_data_source(&market, &settings);
        {
            let m = Arc::downgrade(&market);
            let s = Arc::downgrade(&settings);
            settings.on_change(move |key, _| {
                if (key == "market.dataSource" || key == "market.dataByExchange")
                    && let (Some(m), Some(s)) = (m.upgrade(), s.upgrade())
                {
                    apply_data_source(&m, &s);
                }
            });
        }
        if let Err(e) = crate::templates::migrate_new_chart_layers(&settings).await {
            tracing::warn!(error = %e.message, "could not move newChartLayers into chart.templates");
        }
        let layouts = LayoutService::load(
            store.clone(),
            Arc::clone(&bus),
            Arc::clone(&market),
            Arc::clone(&clock),
            settings.string("workspace.activeLayoutId"),
            crate::layout::LegacyVwapLevels::from_setting(settings.stored("chart.levels").as_ref()),
        )
        .await
        .map_err(|e| anyhow::anyhow!("loading layouts: {e}"))?;
        {
            let l = Arc::downgrade(&layouts);
            settings.on_change(move |key, value| {
                if key == "workspace.activeLayoutId"
                    && let (Some(l), Some(id)) = (l.upgrade(), value.as_str())
                {
                    l.set_active(id);
                }
            });
        }

        let broker = Arc::new(
            BrokerModule::paper_seeded(
                Arc::clone(&market) as Arc<dyn MarketDataProvider>,
                Arc::clone(&clock),
                Some(store.clone()),
                PaperConfig {
                    commission: commission(&settings),
                    ..PaperConfig::default()
                },
                Arc::clone(&bus),
                &config.paper_accounts,
            )
            .await
            .map_err(|e| anyhow::anyhow!("opening the paper broker: {e}"))?,
        );

        broker.service().set_limits(risk_limits(&settings));
        broker
            .brokers()
            .set_account_types(settings::account_types(&settings));

        let connections = Arc::new(
            ConnectionsService::new(Arc::clone(&market), Arc::clone(&intel))
                .with_brokers(Arc::clone(broker.brokers())),
        );
        let secrets = config.secrets.clone().unwrap_or_else(Secrets::in_memory);
        let source_drafts = Arc::new(tessera_intel::source::SourceDrafts::new(
            store.clone(),
            Arc::clone(&clock),
        ));
        let level_http: Arc<dyn tessera_intel::source::http::HttpClient> = match &config.level_http
        {
            Some(h) => Arc::clone(h),
            None => Arc::new(
                tessera_intel::source::http::ReqwestClient::new(&format!("Tessera/{VERSION}"))
                    .map_err(|e| anyhow::anyhow!("the HTTP client of level sources: {e}"))?,
            ),
        };
        let level_raw = config.data_dir.as_ref().and_then(|dir| {
            match tessera_store::blobs::BlobStore::open(DataDir::new(dir).blobs(), store.clone()) {
                Ok(b) => {
                    Some(Arc::new(level_sources::BlobSink(b))
                        as Arc<dyn tessera_intel::source::RawSink>)
                }
                Err(e) => {
                    tracing::warn!(error = %e, "raw levels responses will not be kept");
                    None
                }
            }
        });
        let level_sources = level_sources::LevelSources::new(level_sources::LevelSourcesDeps {
            connections: Arc::clone(&connections),
            store: store.clone(),
            secrets: secrets.clone(),
            http: Arc::clone(&level_http),
            raw: level_raw,
            specs: Some(Arc::new(level_sources::MarketSpecs(Arc::clone(&market)))
                as Arc<dyn tessera_intel::source::SpecLookup>),
            vendor_clock: Arc::new(SystemClock),
            clock: Arc::clone(&clock),
            drafts: Some(Arc::clone(&source_drafts)),
        });
        if let Err(e) = level_sources::migrate_chart_levels(&settings).await {
            tracing::warn!(error = %e.message, "could not move chart.levels onto level keys");
        }
        if let Err(e) = crate::watchlists::migrate_preferences_watchlist(&settings).await {
            tracing::warn!(error = %e.message, "could not move the watchlist into markets.watchlists");
        }
        let alert_webhooks: Arc<dyn tessera_alerts::WebhookSender> = match &config.alert_webhooks {
            Some(w) => Arc::clone(w),
            None => Arc::new(
                tessera_alerts::discord::ReqwestSender::new(&format!("Tessera/{VERSION}"))
                    .map_err(|e| anyhow::anyhow!("the HTTP client of alerts: {e}"))?,
            ),
        };
        let vault = Arc::new(alerts::SecretVault::new(secrets.clone(), store.clone()));
        vault.note_kept().await;
        let alerts_service = tessera_alerts::AlertsService::load(
            store.clone(),
            Arc::clone(&bus),
            Arc::clone(&clock),
            Arc::clone(&market),
            vault,
            alert_webhooks,
        )
        .map_err(|e| anyhow::anyhow!("loading alerts: {}", e.message))?;
        alerts_service.set_default_delivery(alerts::default_delivery(&settings));
        {
            let a = Arc::downgrade(&alerts_service);
            let s = Arc::downgrade(&settings);
            settings.on_change(move |key, _| {
                if key == alerts::DEFAULT_DELIVERY_KEY
                    && let (Some(a), Some(s)) = (a.upgrade(), s.upgrade())
                {
                    a.set_default_delivery(alerts::default_delivery(&s));
                }
            });
        }
        let account = crate::modules::account::AccountService::new(
            config.cloud_url.clone(),
            secrets.clone(),
            Arc::clone(&bus),
            Arc::clone(&clock),
        )?;
        telemetry.identify_with({
            let account = Arc::downgrade(&account);
            move || account.upgrade().and_then(|a| a.user_id())
        });
        let data_module = Arc::new(crate::modules::data::DataModule::new(
            store.clone(),
            config.data_dir.clone(),
            secrets.clone(),
        ));
        let connectors = Connectors::new(
            Arc::clone(&connections),
            store.clone(),
            secrets,
            config
                .rithmic
                .clone()
                .unwrap_or_else(|| Arc::new(LiveRithmic) as Arc<dyn RithmicFactory>),
            Arc::clone(&clock),
            Some(Arc::clone(broker.service().broker())),
        );

        let mut services = Extensions::new();
        services.insert(Arc::clone(broker.service()));
        services.insert(Arc::clone(&market));
        services.insert(Arc::clone(&intel));
        services.insert(Arc::clone(&connections));
        services.insert(Arc::clone(&layouts));
        services.insert(Arc::clone(&settings));
        services.insert(Arc::new(store.clone()));
        let cards = tessera_host::Cards::new(Arc::clone(&bus));
        services.insert(Arc::clone(&cards));

        let state_cell: StateCell = Arc::new(OnceLock::new());
        let resolver: Arc<dyn InstrumentResolver> = Arc::clone(&market) as _;
        let market_module = Arc::new(MarketModule::new(Arc::clone(&market), Arc::clone(&bus)));
        if let Some(dir) = &config.data_dir {
            match tessera_store::depth::DepthStore::open_in_dir(dir) {
                Ok(d) => market_module
                    .hub()
                    .set_depth_archive(Arc::new(depth_archive::StoreDepthArchive(d))),
                Err(e) => tracing::warn!(error = %e, "the depth archive is unavailable"),
            }
        }
        let mut pulls = None;
        let mut saved_prints = None;
        if let Some(ticks) = tick_store {
            let saved = tessera_market::saved::SavedTrades::new(Arc::new(ticks));
            saved_prints = Some(Arc::clone(&saved));
            services.insert(Arc::clone(&saved));
            apply_saved_sessions(&saved, &settings);
            {
                let w = Arc::downgrade(&saved);
                let s = Arc::downgrade(&settings);
                settings.on_change(move |key, _| {
                    if key == tessera_market::saved::KEEP_SETTING
                        && let (Some(w), Some(s)) = (w.upgrade(), s.upgrade())
                    {
                        apply_saved_sessions(&w, &s);
                    }
                });
            }
            market.set_replays(tessera_market::replay::Replays::new(Arc::clone(&saved)));
            market_module.hub().set_saved_trades(Arc::clone(&saved));
            match tessera_market::pull::Pulls::open(saved, Arc::clone(&market), Arc::clone(&clock))
                .await
            {
                Ok(p) => {
                    apply_auto_download(&p, &settings);
                    let w = Arc::downgrade(&p);
                    let s = Arc::downgrade(&settings);
                    settings.on_change(move |key, _| {
                        if key == tessera_market::pull::AUTO_SETTING
                            && let (Some(w), Some(s)) = (w.upgrade(), s.upgrade())
                        {
                            apply_auto_download(&w, &s);
                        }
                    });
                    pulls = Some(p);
                }
                Err(e) => tracing::warn!(error = %e, "saved trade pulls are unavailable"),
            }
        }
        let ctx = ModuleContext {
            bus: Arc::clone(&bus),
            clock: Arc::clone(&clock),
            services: services.clone(),
        };
        let indicators = tessera_indicators::IndicatorsService::load(
            store.clone(),
            Arc::clone(&market),
            Some(Arc::clone(market_module.hub())),
            Arc::clone(&bus),
            Arc::clone(&clock),
        )
        .map_err(|e| anyhow::anyhow!("loading custom indicators: {e}"))?;
        let level_history = Arc::new(tessera_intel::history::LevelHistory::new(
            store.clone(),
            Arc::clone(&clock),
            tessera_intel::history::file::Roots::new(config.data_dir.clone()),
            Arc::clone(&intel),
        ));
        let intel_module = Arc::new(
            IntelModule::new(Arc::clone(&intel), resolver, Arc::clone(&bus))
                .with_http(Arc::clone(&level_http))
                .with_history(level_history)
                .with_drafts(Arc::clone(&source_drafts)),
        );
        let principals = Arc::new(tessera_mcp::McpPrincipals::new());
        let mcp_clients = {
            let exe = config
                .mcp_exe
                .clone()
                .or_else(|| std::env::current_exe().ok())
                .unwrap_or_else(|| PathBuf::from("tessera-runtime"));
            let launch = tessera_mcp::setup::Launch::new(
                &exe,
                config.data_dir.as_deref(),
                default_data_dir().as_deref(),
            );
            crate::modules::mcp::McpClients::load(
                store.clone(),
                Arc::clone(&clock),
                launch,
                config.claude_desktop_config.clone(),
            )
            .context("loading the connected MCP clients")?
        };
        let agent_service = config.agents.then(|| {
            let dir = config.data_dir.as_ref().map_or_else(
                || std::env::temp_dir().join("tessera-agents"),
                |d| DataDir::new(d).agents(),
            );
            let svc = tessera_agent::AgentService::with_builders(
                store.clone(),
                Arc::clone(&bus),
                Arc::clone(&clock),
                Arc::clone(&principals),
                config
                    .agent_providers
                    .clone()
                    .unwrap_or_else(|| tessera_agent::provider_builders(&dir, VERSION)),
            );
            Arc::new(
                match tessera_agent::AttachmentStore::open(DataDir::new(dir).attachments()) {
                    Ok(a) => svc.with_attachments(a),
                    Err(e) => {
                        tracing::warn!(error = %e, "messages will take no attachments");
                        svc
                    }
                },
            )
        });
        if let Some(svc) = &agent_service {
            let t = telemetry.clone();
            svc.set_turn_sink(Arc::new(move |report| t.turn(&report)));
            apply_agent_preferences(svc, &settings);
            svc.want(agent_providers(&settings));
            let a = Arc::downgrade(svc);
            let s = Arc::downgrade(&settings);
            settings.on_change(move |key, _| {
                let (Some(a), Some(s)) = (a.upgrade(), s.upgrade()) else {
                    return;
                };
                if matches!(key, "agent.customInstructions" | "agent.defaultMode") {
                    apply_agent_preferences(&a, &s);
                } else if key == crate::settings::AGENT_PROVIDERS {
                    a.set_provider_settings(agent_providers(&s));
                }
            });
        }
        layouts.set_custom_indicators(Arc::clone(&indicators) as _);
        let session_runner = agent_service.as_ref().map(|svc| {
            session_runner::SessionRunner::new(
                Arc::clone(svc),
                Arc::clone(&settings),
                store.clone(),
                Arc::clone(&clock),
                config
                    .issue_filer
                    .clone()
                    .unwrap_or_else(|| Arc::new(session_runner::issues::GhCli)),
            )
        });
        if let Some(runner) = &session_runner {
            runner.set_telemetry(telemetry.clone());
        }
        alerts_service.set_analyst(agent_service.as_ref().map(|svc| {
            Arc::new(alerts::Analyst {
                agents: Arc::clone(svc),
                sessions: session_runner.clone(),
            }) as Arc<dyn tessera_alerts::AlertAnalyst>
        }));
        let journal = Arc::new(
            tessera_journal::JournalModule::open(
                store.clone(),
                config.data_dir.as_deref(),
                Arc::clone(&bus),
                Some(Arc::clone(&market)),
                Some(Arc::clone(broker.service())),
                Some(Arc::clone(&clock)),
            )
            .map_err(|e| anyhow::anyhow!("opening the journal: {e}"))?,
        );
        let zoned = Zoned {
            alerts: Arc::clone(&alerts_service),
            journal: Arc::clone(journal.service()),
            orders: Arc::clone(broker.service()),
        };
        zoned.apply(&settings);
        {
            let s = Arc::downgrade(&settings);
            let a = Arc::downgrade(&zoned.alerts);
            let j = Arc::downgrade(&zoned.journal);
            let o = Arc::downgrade(&zoned.orders);
            settings.on_change(move |key, _| {
                if key == DISPLAY_TIME_ZONE
                    && let (Some(s), Some(alerts), Some(journal), Some(orders)) =
                        (s.upgrade(), a.upgrade(), j.upgrade(), o.upgrade())
                {
                    Zoned {
                        alerts,
                        journal,
                        orders,
                    }
                    .apply(&s);
                }
            });
        }
        let mut modules: Vec<Arc<dyn RuntimeModule>> = vec![
            Arc::new(CoreModule::new(Arc::clone(&state_cell))),
            Arc::new(
                WorkspaceModule::new(Arc::clone(&layouts))
                    .with_templates(crate::templates::TemplateService::new(
                        Arc::clone(&settings),
                        Arc::clone(&layouts),
                    ))
                    .with_drawing_templates(crate::drawing_templates::DrawingTemplateService::new(
                        Arc::clone(&settings),
                        Arc::clone(&layouts),
                    ))
                    .with_presets(crate::presets::PresetService::new(
                        Arc::clone(&settings),
                        Arc::clone(&layouts),
                        Some(Arc::clone(&indicators) as _),
                    ))
                    .with_settings(Arc::clone(&settings))
                    .with_accounts(config.cloud_url.is_some()),
            ),
            Arc::new(SettingsModule::new(Arc::clone(&settings))),
            data_module,
            Arc::new(crate::modules::telemetry::TelemetryModule::new(
                telemetry.clone(),
            )),
            Arc::new(crate::modules::mcp::McpModule::new(Arc::clone(
                &mcp_clients,
            ))),
            Arc::new(crate::modules::account::AccountModule::new(Arc::clone(
                &account,
            ))),
            Arc::new(
                ConnectionsModule::new(Arc::clone(&connections))
                    .with_connectors(Arc::clone(&connectors))
                    .with_level_sources(Arc::clone(&level_sources)),
            ),
            Arc::clone(&market_module) as Arc<dyn RuntimeModule>,
            Arc::new(
                tessera_market::saved_tools::SavedTradesModule::new(pulls)
                    .with_cards(Arc::clone(&cards)),
            ),
            Arc::new(crate::modules::cards::CardsModule(Arc::clone(&cards))),
            Arc::clone(&intel_module) as Arc<dyn RuntimeModule>,
            Arc::new(ConceptsModule::new(
                Arc::clone(&market),
                Arc::clone(&bus),
                Arc::clone(market_module.hub()),
                Arc::clone(&clock),
                {
                    let store = store.clone();
                    Arc::new(move || {
                        let key = tessera_core::initial_balance::MINUTES_SETTING;
                        tessera_core::initial_balance::minutes_setting(
                            store.settings().get(key).ok().flatten().as_ref(),
                        )
                    })
                },
            )),
            Arc::new(tessera_indicators::IndicatorsModule::new(Arc::clone(
                &indicators,
            ))),
            Arc::new(tessera_alerts::AlertsModule::new(
                Arc::clone(&alerts_service),
                Arc::clone(market_module.hub()),
                Arc::new(alerts::RuntimeSources::new(
                    Arc::clone(&state_cell),
                    Arc::clone(&layouts),
                    Arc::clone(&indicators),
                )),
            )),
            Arc::clone(&broker) as Arc<dyn RuntimeModule>,
            Arc::new(ResearchModule::with_studies(Arc::new({
                let studies = tessera_research::Studies::new(
                    store.clone(),
                    Arc::clone(&market),
                    Arc::clone(&clock),
                );
                match &saved_prints {
                    Some(saved) => studies.with_prints(Arc::clone(saved)),
                    None => studies,
                }
            }))),
            Arc::clone(&journal) as Arc<dyn RuntimeModule>,
            match &agent_service {
                Some(svc) => Arc::new(AgentModule::with_service(store.clone(), Arc::clone(svc))),
                None => Arc::new(AgentModule::new(store.clone())),
            },
        ];
        modules.push(Arc::new(session_runner::tools::SessionRunnerModule(
            session_runner.clone(),
        )));
        modules.push(Arc::new(crate::modules::feedback::FeedbackModule(
            crate::modules::feedback::FeedbackService::new(
                config.data_dir.as_ref().map(|d| d.join("feedback")),
                Arc::new(crate::modules::feedback::CloudSink(Arc::clone(&account))),
                agent_service
                    .as_ref()
                    .map(|a| Arc::clone(a) as Arc<dyn crate::modules::feedback::WriteUpAgent>),
                Some(crate::modules::feedback::Trading {
                    broker: Arc::clone(&broker),
                }),
                store.clone(),
                Arc::clone(&clock),
            ),
        )));
        modules.push(Arc::new(crate::modules::share::ShareModule(
            crate::modules::share::ShareService::new(Arc::new(crate::modules::share::CloudShares(
                Arc::clone(&account),
            ))),
        )));

        for factory in extra {
            modules.push(factory(&ctx).map_err(|e| anyhow::anyhow!("building a module: {e}"))?);
        }

        let mut registry = ToolRegistry::new();
        for m in &modules {
            m.register_tools(&mut registry)
                .with_context(|| format!("registering the tools of module {}", m.name()))?;
        }

        let observer = RuntimeObserver::spawn(Arc::clone(&bus), store.clone(), Arc::clone(&clock));
        observer.set_telemetry(telemetry.clone());
        broker
            .protection()
            .set_audit(Arc::clone(&observer) as Arc<dyn tessera_tools::ToolObserver>);
        broker
            .service()
            .set_copy_audit(Arc::clone(&observer) as Arc<dyn tessera_tools::ToolObserver>);
        alerts_service.set_audit(Arc::clone(&observer) as Arc<dyn tessera_tools::ToolObserver>);
        broker.protection().set_mode(bracket_mode(&settings));
        {
            let p = Arc::downgrade(broker.protection());
            let s = Arc::downgrade(&settings);
            settings.on_change(move |key, _| {
                if key == BRACKET_MODE_KEY
                    && let (Some(p), Some(s)) = (p.upgrade(), s.upgrade())
                {
                    p.set_mode(bracket_mode(&s));
                }
            });
        }
        let limits = loop_limits(&settings);
        let invoker = Arc::new(
            Invoker::new(
                Arc::new(registry),
                Arc::clone(&observer) as Arc<dyn tessera_tools::ToolObserver>,
                Arc::clone(&clock),
                InvokerConfig {
                    staleness: staleness(&settings),
                    limits,
                },
            )
            .with_extensions(services),
        );
        {
            let inv = Arc::downgrade(&invoker);
            let s = Arc::downgrade(&settings);
            let paper = Arc::downgrade(broker.paper_broker());
            let held = Arc::downgrade(&broker);
            settings.on_change(move |key, _| {
                let (Some(inv), Some(s)) = (inv.upgrade(), s.upgrade()) else {
                    return;
                };
                if key == "risk.limits"
                    && let Some(b) = held.upgrade()
                {
                    b.set_limits(risk_limits(&s));
                    return;
                }
                if key == ACCOUNT_TYPES
                    && let Some(b) = held.upgrade()
                {
                    b.set_account_types(settings::account_types(&s));
                    return;
                }
                if key.starts_with("agent.") {
                    inv.set_limits(loop_limits(&s));
                } else if key.starts_with("approvals.") {
                    inv.set_staleness(staleness(&s));
                } else if [PAPER_COMMISSION_STANDARD, PAPER_COMMISSION_MICRO].contains(&key)
                    && let Some(paper) = paper.upgrade()
                {
                    paper.set_commission(commission(&s));
                }
            });
        }

        mcp_clients.attach_invoker(&invoker);
        let host = ModuleHost {
            ctx,
            invoker: Arc::clone(&invoker),
        };
        let mut topics: HashMap<&'static str, Arc<dyn TopicHandler>> = HashMap::new();
        for m in &modules {
            for t in m.topics(&host) {
                let name = t.name();
                bus.register(name, t.sizing())
                    .with_context(|| format!("topic {name} of module {}", m.name()))?;
                topics.insert(name, t);
            }
        }
        telemetry.watch_accounts(&bus, Arc::clone(broker.service()));
        telemetry.watch_sign_in(&bus);

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], config.port)))
            .await
            .with_context(|| format!("binding 127.0.0.1:{}", config.port))?;
        let port = listener.local_addr()?.port();
        account.set_port(port);
        if let Some(svc) = &agent_service {
            svc.set_mcp_url(format!("http://127.0.0.1:{port}/mcp"));
        }
        let mcp = Arc::new(tessera_mcp::McpService::new(
            Arc::clone(&invoker),
            agent_service
                .as_ref()
                .map(|svc| Arc::clone(svc) as Arc<dyn tessera_mcp::McpHook>),
            VERSION,
        ));
        if let Some(dir) = &config.data_dir {
            private::protect_data_dir(dir)
                .with_context(|| format!("protecting {}", dir.display()))?;
            auth::remove_launch_link(dir);
        }
        let token = SessionToken::generate()?;
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let state = Arc::new(AppState {
            version: VERSION,
            port,
            token,
            tickets: Tickets::new(config.launch_tickets.clone())?,
            origins: OriginPolicy::new(config.review_origins.clone()),
            bus: Arc::clone(&bus),
            invoker: Arc::clone(&invoker),
            store,
            observer: Arc::clone(&observer),
            telemetry: telemetry.clone(),
            broker: Arc::clone(&broker),
            modules: modules.clone(),
            topics,
            connections: Arc::clone(&connections),
            market: market_module,
            intel: intel_module,
            layouts,
            settings,
            clock: Arc::clone(&clock),
            ui_dir: config.ui_dir.clone(),
            shutdown: shutdown_rx,
            next_conn: AtomicU64::new(0),
            mcp,
            principals,
            mcp_clients,
            account,
        });
        let _ = state_cell.set(Arc::downgrade(&state));

        let mut tasks = Vec::new();
        for m in &modules {
            tasks.extend(m.start(&host));
        }
        {
            let inv = Arc::clone(&invoker);
            tasks.push(tokio::spawn(async move {
                let mut iv = tokio::time::interval(Duration::from_secs(1));
                loop {
                    iv.tick().await;
                    inv.expire_stale();
                }
            }));
        }
        {
            let st = Arc::downgrade(&state);
            tasks.push(tokio::spawn(async move {
                let mut iv = tokio::time::interval(Duration::from_secs(5));
                loop {
                    iv.tick().await;
                    let Some(st) = st.upgrade() else { return };
                    st.bus.publish(names::HEALTH, TopicKey::None, &st.health());
                }
            }));
        }
        {
            let st = Arc::downgrade(&state);
            let mut market_changes = market.changes();
            let mut intel_changes = intel.changes();
            let mut broker_changes = broker.brokers().changes();
            let mut configured_changes = connections.changes();
            tasks.push(tokio::spawn(async move {
                loop {
                    let alive = tokio::select! {
                        r = market_changes.changed() => r.is_ok(),
                        r = intel_changes.changed() => r.is_ok(),
                        r = broker_changes.changed() => r.is_ok(),
                        r = configured_changes.changed() => r.is_ok(),
                    };
                    let Some(st) = st.upgrade().filter(|_| alive) else {
                        return;
                    };
                    st.bus
                        .publish(names::CAPABILITIES, TopicKey::None, &st.capabilities());
                    st.bus.publish(names::HEALTH, TopicKey::None, &st.health());
                }
            }));
        }

        tasks.push(recording::spawn(
            Arc::clone(state.market.hub()),
            Arc::clone(&market),
            &state.settings,
        ));

        let waiting_for_roots = state.layouts.place_pending_charts().await;
        tasks.push(spawn_chart_follower(
            Arc::downgrade(&state.layouts),
            waiting_for_roots,
            connectors.logins(),
            market.changes(),
        ));

        let saved = connectors.list_saved().await;
        let mut restoring = connectors.log_in_saved(saved);
        if tokio::time::timeout(RESTORE_BEFORE_SERVING, &mut restoring)
            .await
            .is_err()
        {
            tasks.push(restoring);
        }
        tasks.push(level_sources.restore());
        if let Some(file) = config.rithmic_credentials.clone() {
            tasks.push(connectors.add_dev_file(file));
        }

        Ok(Self {
            state,
            listener,
            shutdown_tx,
            tasks,
            connectors,
            data_dir_lock,
            discovery_dir: config.data_dir.clone(),
        })
    }

    pub fn port(&self) -> u16 {
        self.state.port
    }

    pub fn token(&self) -> &SessionToken {
        &self.state.token
    }

    pub fn state(&self) -> &SharedState {
        &self.state
    }

    pub fn ready_line(&self) -> String {
        json!({
            "event": "ready",
            "port": self.state.port,
            "token": self.state.token.expose(),
            "version": VERSION,
        })
        .to_string()
    }

    pub async fn run(
        self,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> anyhow::Result<()> {
        let Runtime {
            state,
            listener,
            shutdown_tx,
            tasks,
            connectors,
            data_dir_lock,
            discovery_dir,
        } = self;
        let pid = std::process::id();
        if let Some(dir) = &discovery_dir {
            let discovery = tessera_mcp::Discovery {
                port: state.port,
                pid,
                version: VERSION.to_owned(),
            };
            if let Err(e) = discovery.write(dir) {
                tracing::warn!(error = %e, "could not write the discovery file: MCP clients will not find this runtime");
            }
        }
        let app = server::router(Arc::clone(&state));
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let signal = async move {
            shutdown.await;
            tracing::info!("shutting down");
            let _ = shutdown_tx.send(true);
            let _ = stop_tx.send(());
        };
        let server = axum::serve(listener, app.into_make_service()).with_graceful_shutdown(signal);
        let grace = async move {
            let _ = stop_rx.await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        };
        let served = tokio::select! {
            r = server => r.context("http server"),
            () = grace => {
                tracing::warn!("forced shutdown after {}s grace period", SHUTDOWN_GRACE.as_secs());
                Ok(())
            }
        };
        if let Some(dir) = &discovery_dir {
            tessera_mcp::Discovery::remove_own(dir, pid);
            auth::remove_launch_link(dir);
        }
        served?;
        let interrupted = state.invoker.shutdown();
        if !interrupted.is_empty() {
            tracing::warn!(
                calls = interrupted.len(),
                "financial calls interrupted by shutdown; recorded as outcome unknown"
            );
        }
        state.observer.flush().await;
        state.telemetry.flush().await;
        state.broker.paper_broker().flush().await;
        connectors.shutdown().await;
        for t in tasks {
            t.abort();
        }
        drop(data_dir_lock);
        Ok(())
    }

    pub fn spawn(self) -> RuntimeHandle {
        let port = self.port();
        let token = self.token().expose().to_owned();
        let state = Arc::clone(&self.state);
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let join = tokio::spawn(self.run(async move {
            let _ = rx.await;
        }));
        RuntimeHandle {
            port,
            token,
            state,
            stop: Some(tx),
            join,
        }
    }
}

pub struct RuntimeHandle {
    pub port: u16,
    pub token: String,
    pub state: SharedState,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    join: JoinHandle<anyhow::Result<()>>,
}

impl std::fmt::Debug for RuntimeHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeHandle")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl RuntimeHandle {
    pub async fn shutdown(mut self) -> anyhow::Result<()> {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        (&mut self.join).await?
    }
}

const RESTORE_BEFORE_SERVING: Duration = Duration::from_secs(3);

const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

fn spawn_chart_follower(
    layouts: std::sync::Weak<LayoutService>,
    mut waiting_for_roots: bool,
    mut logins: watch::Receiver<u64>,
    mut sources: watch::Receiver<u64>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Some(l) = layouts.upgrade() else {
                return;
            };
            if waiting_for_roots {
                waiting_for_roots = l.place_pending_charts().await;
            }
            l.follow_data_source().await;
            drop(l);
            let alive = tokio::select! {
                r = logins.changed() => r.is_ok(),
                r = sources.changed() => r.is_ok(),
            };
            if !alive {
                return;
            }
        }
    })
}

fn apply_auto_download(pulls: &tessera_market::pull::Pulls, settings: &SettingsService) {
    pulls.set_auto(
        settings
            .value(tessera_market::pull::AUTO_SETTING)
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    );
}

fn apply_saved_sessions(
    saved: &Arc<tessera_market::saved::SavedTrades>,
    settings: &SettingsService,
) {
    let keep = settings
        .value(tessera_market::saved::KEEP_SETTING)
        .and_then(|v| v.as_u64())
        .map_or(tessera_market::saved::KEEP_SESSIONS, |n| n as usize);
    saved.set_keep(keep);
    let saved = Arc::clone(saved);
    let prune = move || {
        if let Err(e) = saved.prune_all() {
            tracing::warn!(error = %e, "old saved trades were not pruned");
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(rt) => drop(rt.spawn_blocking(prune)),
        Err(_) => prune(),
    }
}

fn apply_data_source(market: &MarketRouter, settings: &SettingsService) {
    market.set_data_choice(tessera_market::DataChoice::from_setting(
        &settings.string("market.dataSource"),
    ));
    let by_exchange = match settings.value("market.dataByExchange") {
        Some(Value::Object(m)) => m
            .into_iter()
            .filter_map(|(exchange, c)| Some((exchange, c.as_str()?.to_owned())))
            .collect(),
        _ => BTreeMap::new(),
    };
    market.set_exchange_choices(by_exchange);
}

fn apply_agent_preferences(svc: &tessera_agent::AgentService, settings: &SettingsService) {
    svc.set_custom_instructions(settings.string("agent.customInstructions"));
    let mode = settings
        .value("agent.defaultMode")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or(tessera_protocol::tools::SessionMode::AutoModify);
    svc.set_default_mode(mode);
}

fn agent_providers(
    settings: &SettingsService,
) -> std::collections::HashMap<String, tessera_agent::ProviderSettings> {
    crate::settings::agent_providers(
        &settings
            .value(crate::settings::AGENT_PROVIDERS)
            .unwrap_or_default(),
    )
}

fn staleness(settings: &SettingsService) -> StalenessPolicy {
    let ticks = settings.int("approvals.staleAfterTicks");
    StalenessPolicy {
        max_age_nanos: settings.int("approvals.staleAfterSeconds").max(5) * NANOS_PER_SEC,
        max_ticks: (ticks > 0).then(|| u32::try_from(ticks).unwrap_or(u32::MAX)),
    }
}

struct Zoned {
    alerts: Arc<tessera_alerts::AlertsService>,
    journal: Arc<tessera_journal::JournalService>,
    orders: Arc<tessera_broker::orders::OrdersService>,
}

impl Zoned {
    fn apply(&self, settings: &SettingsService) {
        let zone = settings::display_zone(settings);
        self.alerts.set_display_zone(zone);
        self.journal.set_display_zone(zone);
        self.orders.set_display_zone(zone);
    }
}

fn risk_limits(settings: &SettingsService) -> tessera_core::limits::LimitsSetting {
    settings
        .value("risk.limits")
        .map(|v| tessera_core::limits::LimitsSetting::from_value(&v))
        .unwrap_or_default()
}

const BRACKET_MODE_KEY: &str = "trade.positionBracket";

fn bracket_mode(settings: &SettingsService) -> tessera_broker::protect::ProtectionMode {
    tessera_broker::protect::ProtectionMode::parse(&settings.string(BRACKET_MODE_KEY))
}

fn commission(settings: &SettingsService) -> Commission {
    let rate =
        |key| tessera_core::money::decimal_from_f64(settings.number(key)).unwrap_or_default();
    Commission {
        standard: rate(PAPER_COMMISSION_STANDARD),
        micro: rate(PAPER_COMMISSION_MICRO),
    }
}

fn loop_limits(settings: &SettingsService) -> LoopLimits {
    LoopLimits {
        max_steps_per_turn: settings.int("agent.maxStepsPerTurn").clamp(1, 200) as u32,
        max_tool_calls_per_turn: settings.int("agent.maxToolCallsPerTurn").clamp(1, 500) as u32,
        dedup_window_nanos: settings.int("agent.dedupWindowMs").max(0) * 1_000_000,
    }
}

fn cancel_orphaned_drafts(store: &Store, now: tessera_core::Timestamp) -> anyhow::Result<()> {
    let repo = store.drafts();
    for mut d in repo.live(None)? {
        d.status = tessera_core::orders::DraftStatus::Cancelled;
        repo.upsert(&d, now)?;
        tracing::info!(draft = %d.draft_id, "cancelled draft left live by a previous run");
    }
    Ok(())
}

fn cancel_orphaned_approvals(store: &Store, now: tessera_core::Timestamp) -> anyhow::Result<()> {
    let repo = store.approvals();
    for mut a in repo.pending()? {
        a.status = ApprovalStatus::Cancelled;
        a.resolution = None::<ApprovalResolution>;
        repo.upsert(&a, now)?;
        tracing::info!(approval = %a.id, "cancelled approval left pending by a previous run");
    }
    Ok(())
}
