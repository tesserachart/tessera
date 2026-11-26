use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, OnceLock};

use serde_json::{Value, json};
use tessera_broker::BrokerModule;
use tessera_cloud::{NewShare, SetupBody, ShareBody, SharedSetup};
use tessera_core::{Origin, SharedClock};
use tessera_indicators::IndicatorsService;
use tessera_protocol::agent::AgentEventEnvelope;
use tessera_protocol::indicators::{CustomIndicators, normalize_custom_params};
use tessera_protocol::io::{ChartAddLayerInput, ChartChangeOutput, LayoutSaveInput};
use tessera_protocol::layers::LayerKind;
use tessera_protocol::layout::ChartState;
use tessera_protocol::templates::{self, TemplateLayer};
use tessera_protocol::tools::ToolErrorCode;
use tessera_store::Store;
use tessera_tools::ToolError;

use super::contract::{
    SetupCode, SetupDisplay, SetupKind, ShareAddInput, ShareAddOutput, ShareConversationInput,
    ShareOpenInput, ShareSetupInput, SharedConversation, SharedItem,
};
use super::conversation::{self, spoken_title};
use super::import::{chart_layers, retargeted, share_id, share_url, with_custom_ids};
use super::setup::{
    self, Built, CustomKey, CustomSource, Customs, LAYOUT_NAME_MAX, PortableLayer, PortableSetup,
    custom_index, custom_key, own_layer,
};
use super::words::ShareWords;
use super::{MAX_TITLE, ShareLink, ShareService, clip};
use crate::layout::{LayoutService, ORDER_FLOW_TEMPLATE_ID, order_flow_template};
use crate::modules::feedback::Scrubber;
use crate::templates::{TemplateService, unique_name};

const EVENTS_PAGE: u32 = 1_000;

pub const NOT_A_SHARE: &str = "That link isn’t a Tessera share.";
pub const LINK_GONE: &str = "That link doesn’t work any more.";
const NO_LINKS: &str = "This Tessera can’t open shared links.";
const CONVERSATION_GONE: &str = "That conversation is gone.";
const CHART_GONE: &str = "That chart is gone.";
const INDICATOR_GONE: &str = "That indicator is gone.";
const TEMPLATE_GONE: &str = "That template is gone.";
const WORKSPACE_GONE: &str = "That workspace is gone.";
const NOT_SHAREABLE: &str = "That can’t be shared.";
const TOO_LARGE: &str = "That is too large to share.";
const CANT_DRAW: &str = "This chart can’t draw that indicator.";
const NOT_ADDED: &str = "That couldn’t be added. Try again.";
const CODE_WONT_RUN: &str = "That indicator’s code doesn’t run here.";
const NO_INSTRUMENT: &str = "That workspace’s charts can’t open here.";
const IMPORT_NOTE: &str = "Added from a shared link";

pub(crate) fn not_a_share(why: impl std::fmt::Display) -> ToolError {
    tracing::info!(%why, "a shared link was refused");
    ToolError::invalid_input(NOT_A_SHARE)
}

fn chart_words(e: ToolError) -> ToolError {
    tracing::info!(error = %e.message, "a shared setup could not go on the chart");
    match e.code {
        ToolErrorCode::Unsupported => ToolError::unsupported(CANT_DRAW),
        ToolErrorCode::NotFound => ToolError::not_found(CHART_GONE),
        _ => ToolError::unavailable(NOT_ADDED),
    }
}

pub struct ShareDesk {
    shares: Arc<ShareService>,
    store: Store,
    layouts: Arc<LayoutService>,
    templates: Arc<TemplateService>,
    indicators: Arc<IndicatorsService>,
    broker: Arc<BrokerModule>,
    clock: SharedClock,
    titles: OnceLock<HashMap<String, String>>,
}

impl std::fmt::Debug for ShareDesk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShareDesk").finish_non_exhaustive()
    }
}

pub struct DeskParts {
    pub store: Store,
    pub layouts: Arc<LayoutService>,
    pub templates: Arc<TemplateService>,
    pub indicators: Arc<IndicatorsService>,
    pub broker: Arc<BrokerModule>,
    pub clock: SharedClock,
}

impl ShareDesk {
    pub fn new(shares: Arc<ShareService>, parts: DeskParts) -> Arc<Self> {
        Arc::new(Self {
            shares,
            store: parts.store,
            layouts: parts.layouts,
            templates: parts.templates,
            indicators: parts.indicators,
            broker: parts.broker,
            clock: parts.clock,
            titles: OnceLock::new(),
        })
    }

    pub fn set_tool_titles(&self, titles: impl IntoIterator<Item = (String, String)>) {
        let _ = self.titles.set(titles.into_iter().collect());
    }

    fn tool_title(&self, tool: &str) -> String {
        self.titles
            .get()
            .and_then(|t| t.get(tool))
            .cloned()
            .unwrap_or_else(|| spoken_title(tool))
    }

    async fn private_words(&self) -> Vec<String> {
        let accounts = self
            .broker
            .service()
            .broker()
            .provider()
            .accounts()
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "the accounts could not be read for a share");
                Vec::new()
            });
        let mut words = Vec::new();
        for a in accounts {
            words.push(a.id.to_string());
            if let Some((_, native)) = a.id.as_str().split_once(':') {
                words.push(native.to_owned());
            }
            words.push(a.display_name);
            words.extend(a.external_ref_masked);
        }
        words
    }

    fn events(&self, session: &str) -> Result<Vec<AgentEventEnvelope>, ToolError> {
        let repo = self.store.agent_events();
        let mut out: Vec<AgentEventEnvelope> = Vec::new();
        loop {
            let after = out.last().map_or(0, |e| e.seq);
            let page = repo.list(session, after, EVENTS_PAGE).map_err(|e| {
                tracing::warn!(error = %e, "a conversation could not be read for a share");
                ToolError::unavailable(CONVERSATION_GONE)
            })?;
            let full = page.len() == EVENTS_PAGE as usize;
            out.extend(page);
            if !full {
                return Ok(out);
            }
        }
    }

    pub async fn preview(
        &self,
        input: &ShareConversationInput,
    ) -> Result<SharedConversation, ToolError> {
        let id = input.session_id.trim();
        let session = self.store.sessions().get(id).ok().flatten();
        let events = self.events(id)?;
        if session.is_none() && events.is_empty() {
            return Err(ToolError::not_found(CONVERSATION_GONE));
        }
        let words = ShareWords::new(self.private_words().await, input.show_pnl);
        let title =
            conversation::title_of(session.as_ref().map_or("", |s| s.title.as_str()), &words);
        Ok(conversation::fold(&events, title, &words, &|t| {
            self.tool_title(t)
        }))
    }

    pub async fn conversation(
        &self,
        input: &ShareConversationInput,
    ) -> Result<ShareLink, ToolError> {
        self.shares.ready()?;
        let shared = self.preview(input).await?;
        let body = serde_json::to_value(&shared).map_err(|e| ToolError::internal(e.to_string()))?;
        let link = self
            .shares
            .create(&NewShare {
                title: shared.title.clone(),
                body: ShareBody::Conversation { conversation: body },
            })
            .await?;
        tracing::info!(share = %link.id, "conversation shared");
        Ok(link)
    }

    async fn customs(&self, keys: impl IntoIterator<Item = CustomKey>) -> Customs {
        let mut out = HashMap::new();
        for key in keys {
            if out.contains_key(&key) {
                continue;
            }
            match self.indicators.get(&key.0, key.1).await {
                Ok(d) => {
                    if let (Some(c), Some(code)) = (d.custom, d.code) {
                        let source = CustomSource {
                            name: c.spec.title.clone(),
                            code,
                            spec: c.spec,
                        };
                        out.insert(key, source);
                    }
                }
                Err(e) => tracing::info!(error = %e.message, "a custom indicator is not shared"),
            }
        }
        out
    }

    async fn built(
        &self,
        input: &ShareSetupInput,
        scrubber: &Scrubber,
    ) -> Result<Built, ToolError> {
        match input {
            ShareSetupInput::Indicator {
                layout_id,
                tile_id,
                layer_id,
            } => {
                let layout = self
                    .layouts
                    .get(Some(layout_id))
                    .map_err(|_| ToolError::not_found(CHART_GONE))?;
                let chart = layout
                    .charts
                    .get(tile_id)
                    .ok_or_else(|| ToolError::not_found(CHART_GONE))?;
                let layer = chart
                    .layers
                    .iter()
                    .find(|l| &l.id == layer_id)
                    .ok_or_else(|| ToolError::not_found(INDICATOR_GONE))?;
                let kind = LayerKind::parse(&layer.kind)
                    .ok_or_else(|| ToolError::invalid_input(NOT_SHAREABLE))?;
                let customs = self.customs(custom_key(&layer.kind, &layer.params)).await;
                setup::indicator(kind, &layer.params, &customs, scrubber)
                    .ok_or_else(|| ToolError::invalid_input(NOT_SHAREABLE))
            }
            ShareSetupInput::CustomIndicator { id } => {
                let customs = self.customs([(id.clone(), None)]).await;
                if customs.is_empty() {
                    return Err(ToolError::not_found(INDICATOR_GONE));
                }
                setup::indicator(
                    LayerKind::Custom,
                    &json!({ "indicator": id }),
                    &customs,
                    scrubber,
                )
                .ok_or_else(|| ToolError::invalid_input(TOO_LARGE))
            }
            ShareSetupInput::Template { id } => {
                let all = self.templates.list();
                let template = templates::find(&all, id)
                    .cloned()
                    .or_else(|| (id == ORDER_FLOW_TEMPLATE_ID).then(order_flow_template))
                    .ok_or_else(|| ToolError::not_found(TEMPLATE_GONE))?;
                let keys: Vec<CustomKey> = template
                    .layers
                    .iter()
                    .filter_map(|l| custom_key(&l.kind, &l.params))
                    .collect();
                let customs = self.customs(keys).await;
                Ok(setup::template(&template, &customs, scrubber))
            }
            ShareSetupInput::Layout { layout_id } => {
                let layout = self
                    .layouts
                    .get(Some(layout_id))
                    .map_err(|_| ToolError::not_found(WORKSPACE_GONE))?;
                let keys: Vec<CustomKey> = layout
                    .charts
                    .values()
                    .flat_map(|c| &c.layers)
                    .filter(|l| own_layer(l))
                    .filter_map(|l| custom_key(&l.kind, &l.params))
                    .collect();
                let customs = self.customs(keys).await;
                Ok(setup::layout(&layout, &customs, scrubber))
            }
        }
    }

    pub async fn setup(&self, input: &ShareSetupInput) -> Result<ShareLink, ToolError> {
        self.shares.ready()?;
        let scrubber = Scrubber::new(self.private_words().await);
        let mut built = self.built(input, &scrubber).await?;
        let title = clip(&setup::display(&built).name, MAX_TITLE);
        let display =
            setup::fit(&mut built, &title).ok_or_else(|| ToolError::invalid_input(TOO_LARGE))?;
        let kind = built.setup.kind();
        let body = SetupBody {
            display: serde_json::to_value(&display)
                .map_err(|e| ToolError::internal(e.to_string()))?,
            setup: serde_json::to_value(&built.setup)
                .map_err(|e| ToolError::internal(e.to_string()))?,
        };
        let body = match kind {
            SetupKind::Indicator => ShareBody::Indicator(body),
            SetupKind::Template => ShareBody::Template(body),
            SetupKind::Layout => ShareBody::Layout(body),
        };
        let link = self.shares.create(&NewShare { title, body }).await?;
        tracing::info!(share = %link.id, kind = setup::kind_word(kind), "setup shared");
        Ok(link)
    }

    fn link(&self, pasted: &str) -> Result<(String, String), ToolError> {
        let base = self
            .shares
            .base()
            .ok_or_else(|| ToolError::unavailable(NO_LINKS))?;
        let id = share_id(pasted, &base).ok_or_else(|| ToolError::invalid_input(NOT_A_SHARE))?;
        Ok((share_url(&base, &id), id))
    }

    async fn fetch(&self, pasted: &str) -> Result<(String, SharedSetup, PortableSetup), ToolError> {
        let (url, id) = self.link(pasted)?;
        let mut shared = self.shares.fetch(&id).await?;
        let setup =
            setup::read(&shared.kind, std::mem::take(&mut shared.setup)).map_err(not_a_share)?;
        Ok((url, shared, setup))
    }

    pub async fn open(&self, input: &ShareOpenInput) -> Result<SharedItem, ToolError> {
        let (url, shared, setup) = self.fetch(&input.url).await?;
        let mut display: SetupDisplay =
            serde_json::from_value(shared.display).map_err(not_a_share)?;
        display.code = setup
            .custom()
            .iter()
            .map(|c| SetupCode {
                name: c.name.clone(),
                code: c.code.clone(),
            })
            .collect();
        Ok(SharedItem {
            id: shared.id,
            url,
            kind: setup.kind(),
            title: clip(&shared.title, MAX_TITLE),
            display,
        })
    }

    async fn local_customs(&self, setup: &PortableSetup) -> Result<Vec<Option<String>>, ToolError> {
        let wanted: BTreeSet<usize> = setup
            .layers()
            .into_iter()
            .filter_map(custom_index)
            .collect();
        let mut ids = vec![None; setup.custom().len()];
        for n in wanted {
            let Some(c) = setup.custom().get(n) else {
                return Err(not_a_share("a layer names code the link does not bring"));
            };
            ids[n] = Some(self.local_custom(&c.name, &c.code).await?);
        }
        Ok(ids)
    }

    async fn local_custom(&self, name: &str, code: &str) -> Result<String, ToolError> {
        for existing in self.indicators.custom() {
            if existing.spec.title != name {
                continue;
            }
            let same = self
                .indicators
                .get(&existing.id, None)
                .await
                .ok()
                .and_then(|d| d.code)
                .is_some_and(|c| c == code);
            if same {
                return Ok(existing.id);
            }
        }
        let made = self
            .indicators
            .create(
                code,
                Some(IMPORT_NOTE.to_owned()),
                &Origin::User,
                self.clock.now(),
            )
            .await
            .map_err(|e| {
                tracing::info!(error = %e.message, "a shared custom indicator did not load");
                ToolError::invalid_input(CODE_WONT_RUN)
            })?;
        made.custom
            .map(|c| c.id)
            .ok_or_else(|| ToolError::internal("a created custom indicator has no id"))
    }

    fn local_layer(
        &self,
        layer: &PortableLayer,
        ids: &[Option<String>],
    ) -> Result<(LayerKind, Value, bool), ToolError> {
        let params = with_custom_ids(layer, ids)
            .ok_or_else(|| not_a_share("a custom indicator is missing"))?;
        let params = if layer.kind == LayerKind::Custom {
            let id = params
                .get("indicator")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let spec = self.indicators.custom_spec(id, None).map_err(not_a_share)?;
            normalize_custom_params(Some(&spec), &params).map_err(not_a_share)?
        } else {
            layer.kind.validate_params(&params).map_err(not_a_share)?
        };
        Ok((layer.kind, params, layer.visible))
    }

    async fn instrument(&self, wanted: &str) -> Result<tessera_core::InstrumentId, ToolError> {
        if let Ok(i) = self.layouts.resolve_instrument(wanted).await {
            return Ok(i);
        }
        tracing::info!(
            instrument = wanted,
            "a shared chart opens on this desk's instrument"
        );
        self.layouts
            .active_chart_instrument()
            .or_else(|| self.layouts.last_chart_instrument())
            .ok_or_else(|| ToolError::unavailable(NO_INSTRUMENT))
    }

    async fn add_indicator(
        &self,
        input: &ShareAddInput,
        layer: &PortableLayer,
        ids: &[Option<String>],
    ) -> Result<ChartChangeOutput, ToolError> {
        let (kind, params, _) = self.local_layer(layer, ids)?;
        self.layouts
            .add_layer(
                ChartAddLayerInput {
                    tile_id: input.tile_id.clone(),
                    layout_id: input.layout_id.clone(),
                    kind,
                    params: Some(params),
                    id: None,
                },
                &Origin::User,
            )
            .await
            .map_err(chart_words)
    }

    async fn add_layout(
        &self,
        name: &str,
        active_chart_id: Option<String>,
        charts: Vec<setup::PortableChart>,
        dock: Option<Value>,
        ids: &[Option<String>],
    ) -> Result<ShareAddOutput, ToolError> {
        let listed = self.layouts.list().layouts;
        let names: Vec<String> = listed.iter().map(|l| l.name.clone()).collect();
        let taken: Vec<String> = listed.iter().map(|l| l.id.clone()).collect();
        let id = crate::tools::workspaces::new_id(self.clock.now().0 / 1_000_000, &taken);
        let mut states = BTreeMap::new();
        for c in charts {
            let layers = c
                .layers
                .iter()
                .map(|l| self.local_layer(l, ids))
                .collect::<Result<Vec<_>, _>>()?;
            let instrument = self.instrument(&c.instrument).await?;
            states.insert(
                c.tile_id.clone(),
                ChartState {
                    title: c.title.unwrap_or_else(|| c.tile_id.clone()),
                    tile_id: c.tile_id,
                    instrument,
                    timeframe: c.timeframe,
                    print_bars: None,
                    layers: chart_layers(layers),
                    annotations: Vec::new(),
                    viewport: None,
                    link_group: c.link_group,
                    chart_type: c.chart_type,
                    hours: c.hours,
                    drawings: Vec::new(),
                    drawings_from: Vec::new(),
                },
            );
        }
        self.layouts
            .save(
                LayoutSaveInput {
                    layout_id: Some(id.clone()),
                    expected_revision: None,
                    name: Some(unique_name(name, &names, LAYOUT_NAME_MAX)),
                    dock: dock.map(|d| retargeted(&d, &id)),
                    active_chart_id,
                    charts: Some(states),
                    trade: None,
                },
                &Origin::User,
            )
            .await
            .map_err(|e| {
                tracing::warn!(error = %e.message, "a shared workspace could not be saved");
                ToolError::unavailable(NOT_ADDED)
            })?;
        Ok(ShareAddOutput::Layout {
            layout: self.layouts.get(Some(&id))?,
        })
    }

    pub async fn add(&self, input: &ShareAddInput) -> Result<ShareAddOutput, ToolError> {
        let (_, _, setup) = self.fetch(&input.url).await?;
        let ids = self.local_customs(&setup).await?;
        match setup {
            PortableSetup::Indicator { layer, .. } => Ok(ShareAddOutput::Indicator {
                chart: self.add_indicator(input, &layer, &ids).await?,
            }),
            PortableSetup::Template {
                name,
                chart_type,
                layers,
                ..
            } => {
                let layers = layers
                    .iter()
                    .map(|l| {
                        self.local_layer(l, &ids)
                            .map(|(kind, params, visible)| TemplateLayer {
                                kind: kind.as_str().to_owned(),
                                params,
                                visible,
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let (templates, template) = self
                    .templates
                    .add(&name, chart_type, layers, &Origin::User)
                    .await?;
                let applied = match input.tile_id.as_deref() {
                    Some(tile) => Some(
                        self.layouts
                            .apply_template(
                                input.layout_id.as_deref(),
                                Some(tile),
                                &template,
                                &Origin::User,
                            )
                            .await
                            .map_err(chart_words)?,
                    ),
                    None => None,
                };
                Ok(ShareAddOutput::Template {
                    templates,
                    template_id: template.id,
                    applied,
                })
            }
            PortableSetup::Layout {
                name,
                active_chart_id,
                charts,
                dock,
                ..
            } => {
                self.add_layout(&name, active_chart_id, charts, dock, &ids)
                    .await
            }
        }
    }
}
