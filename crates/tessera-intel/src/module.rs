use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_core::conversion::ConversionRecord;
use tessera_core::health::ProviderHealth;
use tessera_host::{
    EventBus, InstrumentResolver, KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler,
    TopicSizing, TsExports, parse_params,
};
use tessera_protocol::methods::{IntelProviderInfo, ServerCapabilities};
use tessera_protocol::rpc::{RpcError, codes};
use tessera_protocol::tools::RiskTier;
use tessera_protocol::topics::{InstrumentParams, LevelsUpdate, names};
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::IntelError;
use crate::history::LevelHistory;
use crate::history::io as hio;
use crate::history::tools as htools;
use crate::hub::IntelHub;
use crate::io::{
    DeclaredLevel, DeclaredPackage, DiscardSourceDraftInput, DiscardSourceDraftOutput,
    DraftSourceInput, GetConversionInput, GetLevelsInput, HistoryReach, HistoryTicker,
    IntelProviderEntry, LevelSourceInfo, ListIntelProvidersInput, ListIntelProvidersOutput,
    ListLevelSourcesInput, ListLevelSourcesOutput, ListSourceDraftsInput, ListSourceDraftsOutput,
    PoolCalls, SourceDraft, TestSourceInput, TestSourceOutput, TestedRequest,
};
use crate::router::IntelRouter;
use crate::service::IntelService;
use crate::source::SourceDrafts;
use crate::source::http::HttpClient;
use crate::source::spec::LevelSourceSpec;

pub fn intel_error(e: IntelError) -> ToolError {
    match e {
        IntelError::NotCovered(s) => ToolError::not_found(format!(
            "no intelligence for {s}; intel.list_providers shows what is connected"
        )),
        IntelError::NoSnapshot(t) => {
            ToolError::not_found(format!("no levels snapshot at or before {t}"))
        }
        IntelError::Unsupported(s) => ToolError::unsupported(s),
        IntelError::Unavailable(s) => ToolError::unavailable(s),
    }
}

pub struct IntelModule {
    service: Arc<IntelService>,
    hub: Arc<IntelHub>,
    http: Option<Arc<dyn HttpClient>>,
    history: Option<Arc<LevelHistory>>,
    drafts: Option<Arc<SourceDrafts>>,
}

impl std::fmt::Debug for IntelModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntelModule")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl IntelModule {
    pub fn new(
        router: Arc<IntelRouter>,
        resolver: Arc<dyn InstrumentResolver>,
        bus: Arc<EventBus>,
    ) -> Self {
        let service = Arc::new(IntelService::new(router, resolver));
        let hub = IntelHub::new(Arc::clone(&service), bus);
        Self {
            service,
            hub,
            http: None,
            history: None,
            drafts: None,
        }
    }

    #[must_use]
    pub fn with_drafts(mut self, drafts: Arc<SourceDrafts>) -> Self {
        self.drafts = Some(drafts);
        self
    }

    #[must_use]
    pub fn with_history(mut self, history: Arc<LevelHistory>) -> Self {
        self.history = Some(history);
        self
    }

    pub fn history(&self) -> Option<&Arc<LevelHistory>> {
        self.history.as_ref()
    }

    #[must_use]
    pub fn with_http(mut self, http: Arc<dyn HttpClient>) -> Self {
        self.http = Some(http);
        self
    }

    pub fn service(&self) -> &Arc<IntelService> {
        &self.service
    }

    pub fn hub(&self) -> &Arc<IntelHub> {
        &self.hub
    }
}

impl RuntimeModule for IntelModule {
    fn name(&self) -> &'static str {
        "intel"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(GetLevels(Arc::clone(&self.service)))?;
        r.register(GetConversion(Arc::clone(&self.service)))?;
        r.register(ListProviders(Arc::clone(&self.service)))?;
        r.register(ListSources(Arc::clone(&self.service)))?;
        r.register(TestSource(self.http.clone()))?;
        if let Some(d) = &self.drafts {
            r.register(DraftSource(Arc::clone(d)))?;
            r.register(ListSourceDrafts(Arc::clone(d)))?;
            r.register(DiscardSourceDraft(Arc::clone(d)))?;
        }
        if let Some(h) = &self.history {
            r.register(htools::GetLevelHistory {
                history: Arc::clone(h),
                intel: Arc::clone(&self.service),
            })?;
            r.register(htools::ListLevelHistory(Arc::clone(h)))?;
            r.register(htools::PreviewFile(Arc::clone(h)))?;
            r.register(htools::ImportLevelHistory(Arc::clone(h)))?;
            r.register(htools::UndoLevelImport(Arc::clone(h)))?;
            r.register(htools::BackfillLevelHistory(Arc::clone(h)))?;
        }
        Ok(())
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(LevelsTopic {
            service: Arc::clone(&self.service),
            hub: Arc::clone(&self.hub),
        })]
    }

    fn health(&self) -> Vec<ProviderHealth> {
        self.service
            .router()
            .providers()
            .iter()
            .map(|p| p.health())
            .collect()
    }

    fn describe(&self, caps: &mut ServerCapabilities) {
        caps.intel.extend(
            self.service
                .router()
                .providers()
                .iter()
                .map(|p| IntelProviderInfo {
                    provider_id: p.id().to_owned(),
                    display_name: p.display_name().to_owned(),
                    capabilities: p.capabilities(),
                }),
        );
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-intel")
        .tool::<GetLevelsInput, LevelsUpdate>("intel.get_levels")
        .tool::<GetConversionInput, ConversionRecord>("intel.get_conversion")
        .tool::<ListIntelProvidersInput, ListIntelProvidersOutput>("intel.list_providers")
        .tool::<ListLevelSourcesInput, ListLevelSourcesOutput>("intel.list_sources")
        .tool::<TestSourceInput, TestSourceOutput>("intel.test_source")
        .tool::<DraftSourceInput, SourceDraft>("intel.draft_source")
        .tool::<ListSourceDraftsInput, ListSourceDraftsOutput>("intel.list_source_drafts")
        .tool::<DiscardSourceDraftInput, DiscardSourceDraftOutput>("intel.discard_source_draft")
        .tool::<hio::GetLevelHistoryInput, hio::GetLevelHistoryOutput>("intel.get_level_history")
        .tool::<hio::ListLevelHistoryInput, hio::ListLevelHistoryOutput>("intel.list_level_history")
        .tool::<hio::PreviewFileInput, hio::PreviewFileOutput>("intel.preview_file")
        .tool::<hio::ImportLevelHistoryInput, hio::ImportLevelHistoryOutput>(
            "intel.import_level_history",
        )
        .tool::<hio::UndoLevelImportInput, hio::UndoLevelImportOutput>("intel.undo_level_import")
        .tool::<hio::BackfillLevelHistoryInput, hio::BackfillLevelHistoryOutput>(
            "intel.backfill_level_history",
        )
        .topic::<InstrumentParams, LevelsUpdate>(names::INTEL_LEVELS)
        .ty::<IntelProviderEntry>()
        .ty::<LevelSourceInfo>()
        .ty::<DeclaredPackage>()
        .ty::<DeclaredLevel>()
        .ty::<PoolCalls>()
        .ty::<HistoryReach>()
        .ty::<HistoryTicker>()
        .ty::<TestedRequest>()
        .ty::<LevelSourceSpec>()
}

struct GetLevels(Arc<IntelService>);

#[async_trait]
impl Tool for GetLevels {
    type Input = GetLevelsInput;
    type Output = LevelsUpdate;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.get_levels", "Get levels", RiskTier::Read)
            .description("Market-intelligence levels for an instrument from one connected provider (every source the user added from a spec, e.g. a vendor's zero_gamma or call_wall). Each level keeps the vendor's own field name, package, endpoint, price basis and snapshot time; a level the vendor marks not applicable has no price and says why. Levels converted from another price space (NQ from NDX) carry the conversion applied and their native price, and intel.get_conversion returns the full record. intel.list_sources lists what each source declares. asOf asks for the snapshot in effect at that instant and fails closed when there is none. provider picks a provider; by default the first one covering the instrument answers. unsupported means no connected provider offers levels.")
            .activity("Loaded levels")
            .result_view("levels")
    }

    async fn call(&self, _ctx: &ToolCtx, input: GetLevelsInput) -> Result<LevelsUpdate, ToolError> {
        let id = self
            .0
            .resolve(&input.instrument)
            .await
            .map_err(intel_error)?;
        self.0
            .levels(&id, input.as_of, input.provider.as_deref())
            .await
            .map_err(intel_error)
    }

    fn summarize(&self, out: &LevelsUpdate) -> Option<String> {
        Some(format!(
            "{} levels for {} from {}",
            out.levels.len(),
            out.instrument,
            out.provider
        ))
    }
}

struct GetConversion(Arc<IntelService>);

#[async_trait]
impl Tool for GetConversion {
    type Input = GetConversionInput;
    type Output = ConversionRecord;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.get_conversion", "Get price conversion", RiskTier::Read)
            .description("The conversion record that maps a vendor's price space onto an instrument (e.g. from NDX to NQ): target = source × ratio + additive, with the method (spot_ratio, or the vendor's model: additive, affine), the vendor's contract code when it names one, the observed prices of a spot ratio, source and observation time. Converted levels reference it by id in source.conversion. Conversions apply to prices only, never to magnitudes.")
            .activity("Loaded conversion")
            .result_view("conversion")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: GetConversionInput,
    ) -> Result<ConversionRecord, ToolError> {
        let to = self.0.resolve(&input.to).await.map_err(intel_error)?;
        self.0
            .conversion(input.from.trim(), &to, input.provider.as_deref())
            .await
            .map_err(intel_error)
    }

    fn summarize(&self, out: &ConversionRecord) -> Option<String> {
        let add = if out.additive.is_zero() {
            String::new()
        } else {
            format!(" + {}", out.additive.round_dp(4))
        };
        Some(format!(
            "{} to {}, × {}{add}",
            out.from,
            out.to,
            out.ratio.round_dp(5)
        ))
    }
}

struct ListProviders(Arc<IntelService>);

#[async_trait]
impl Tool for ListProviders {
    type Input = ListIntelProvidersInput;
    type Output = ListIntelProvidersOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "intel.list_providers",
            "List intelligence providers",
            RiskTier::Read,
        )
        .description("Market-intelligence providers connected by the user (sources they added from a spec, with their own key), with what their entitlement covers (vendor, packages, levels, conversions, history) and current health. An empty list means none is connected.")
        .activity("Listed intelligence providers")
        .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: ListIntelProvidersInput,
    ) -> Result<ListIntelProvidersOutput, ToolError> {
        Ok(ListIntelProvidersOutput {
            providers: self.0.providers(),
        })
    }

    fn summarize(&self, out: &ListIntelProvidersOutput) -> Option<String> {
        Some(format!("{} providers", out.providers.len()))
    }
}

struct ListSources(Arc<IntelService>);

#[async_trait]
impl Tool for ListSources {
    type Input = ListLevelSourcesInput;
    type Output = ListLevelSourcesOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.list_sources", "List level sources", RiskTier::Read)
            .description("Every connected source of levels (each one the user added from a spec) with the vendor packages and levels each declares (key, the vendor's field verbatim, its label, endpoint, what it means, its concept annotation and default style), the instruments it covers, its schedule in plain words, the requests it made today per quota pool against Tessera's caps, its history API when its spec declares one (days back, quota pool, tickers and the instrument each is filed under: intel.backfill_level_history reads it), its spec (never a secret) and its health. A source an earlier Tessera saved without a spec shows down with editable false, and the analyst adds it again from the vendor's docs (connections.add_level_source with the same id keeps its saved key). Level settings (chart.levels) are kept by these keys.")
            .activity("Listed level sources")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: ListLevelSourcesInput,
    ) -> Result<ListLevelSourcesOutput, ToolError> {
        Ok(ListLevelSourcesOutput {
            sources: self.0.sources(),
        })
    }

    fn summarize(&self, out: &ListLevelSourcesOutput) -> Option<String> {
        Some(format!("{} level sources", out.sources.len()))
    }
}

struct TestSource(Option<Arc<dyn HttpClient>>);

#[async_trait]
impl Tool for TestSource {
    type Input = TestSourceInput;
    type Output = TestSourceOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.test_source", "Try a level source spec", RiskTier::Read)
            .description("A dry run of a levels-source spec (the format connections.add_level_source takes: baseUrl, auth, instruments with the vendor ticker and an optional conversion, requests with the path and how each response field becomes a level, schedule, limits). Give sample responses by request id in samples (the conversion request is `convert`) and it reads them without a network call; a request without a sample is asked live once, only when the spec needs no secret. Returns the problems with the spec in plain words and, per request, the levels it gives in the vendor's price space (a not-applicable value has no price and a reason). Nothing is kept or connected: once it reads what the user expects, intel.draft_source puts it in Settings › Connections for the user to try with their key and save.")
            .activity("Tried a level source")
            .timeout_ms(30_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: TestSourceInput,
    ) -> Result<TestSourceOutput, ToolError> {
        let client = self.0.clone().filter(|_| input.spec.auth.is_none());
        Ok(crate::source::test_spec(
            &input.spec,
            None,
            client,
            Arc::new(tessera_core::clock::SystemClock),
            &input.samples,
            input.instrument.as_deref(),
        )
        .await)
    }

    fn summarize(&self, out: &TestSourceOutput) -> Option<String> {
        let n: usize = out.requests.iter().map(|r| r.levels.len()).sum();
        Some(if out.ok {
            format!("{n} levels read")
        } else {
            format!("{} problems", out.problems.len().max(1))
        })
    }
}

struct DraftSource(Arc<SourceDrafts>);

#[async_trait]
impl Tool for DraftSource {
    type Input = DraftSourceInput;
    type Output = SourceDraft;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.draft_source", "Draft a level source", RiskTier::Modify)
            .description("Puts a levels-source spec you drafted (from the user's description, the API's docs or a sample answer, tried first with intel.test_source) in Settings › Connections, for the user to review, try with their own key and save: adding a source is the user's alone, and a key never goes in a spec or through you. samples are the answers it was tried on (the user's dry run reads them too); note says in a sentence or two what you assumed or what they should check. A draft of the same id is replaced. Then show them where it is: ui_show_area settings with item connections.draft:<the draft's id>, its row with Review. Nothing is connected.")
            .activity("Drafted a level source")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: DraftSourceInput,
    ) -> Result<SourceDraft, ToolError> {
        self.0.put(input).map_err(ToolError::invalid_input)
    }

    fn summarize(&self, out: &SourceDraft) -> Option<String> {
        Some(if out.problems.is_empty() {
            format!("Drafted {}", out.spec.name)
        } else {
            format!(
                "Drafted {} ({} problems)",
                out.spec.name,
                out.problems.len()
            )
        })
    }
}

struct ListSourceDrafts(Arc<SourceDrafts>);

#[async_trait]
impl Tool for ListSourceDrafts {
    type Input = ListSourceDraftsInput;
    type Output = ListSourceDraftsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.list_source_drafts", "List drafted level sources", RiskTier::Read)
            .description("The level sources drafted with intel.draft_source that the user has not saved or discarded yet: each spec, the samples it was tried on, the note and the problems it still has.")
            .activity("Listed drafted level sources")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: ListSourceDraftsInput,
    ) -> Result<ListSourceDraftsOutput, ToolError> {
        Ok(ListSourceDraftsOutput {
            drafts: self.0.list().map_err(ToolError::internal)?,
        })
    }

    fn summarize(&self, out: &ListSourceDraftsOutput) -> Option<String> {
        Some(format!("{} drafts", out.drafts.len()))
    }
}

struct DiscardSourceDraft(Arc<SourceDrafts>);

#[async_trait]
impl Tool for DiscardSourceDraft {
    type Input = DiscardSourceDraftInput;
    type Output = DiscardSourceDraftOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.discard_source_draft", "Discard a drafted level source", RiskTier::Modify)
            .description("Discards a level source drafted with intel.draft_source (Discard on its row in Settings › Connections). A source already saved is removed with connections.remove, the user's alone.")
            .activity("Discarded a drafted level source")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: DiscardSourceDraftInput,
    ) -> Result<DiscardSourceDraftOutput, ToolError> {
        Ok(DiscardSourceDraftOutput {
            discarded: self.0.discard(&input.id).map_err(ToolError::internal)?,
        })
    }
}

struct LevelsTopic {
    service: Arc<IntelService>,
    hub: Arc<IntelHub>,
}

#[async_trait]
impl TopicHandler for LevelsTopic {
    fn name(&self) -> &'static str {
        names::INTEL_LEVELS
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::SNAPSHOT
    }

    fn offered(&self) -> bool {
        self.service
            .router()
            .providers()
            .iter()
            .any(|p| p.capabilities().levels)
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: InstrumentParams = parse_params(params)?;
        let id = self
            .service
            .resolve(&p.instrument)
            .await
            .map_err(|e| RpcError::new(codes::INVALID_PARAMS, e.to_string()))?;
        let snapshot = self.service.levels_all(&id).await;
        let guard = self.hub.acquire(&id, &snapshot);
        let mut sub = Subscribed::new(KeyFilter::Instruments([id].into_iter().collect()));
        for update in &snapshot {
            sub = sub.snapshot(update);
        }
        Ok(sub.keep(guard))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tessera_core::Timestamp;
    use tessera_core::origin::Origin;

    use super::*;
    use crate::source::fake::FakeHttp;

    #[tokio::test]
    async fn a_dry_run_asks_live_only_a_spec_that_sends_no_secret() {
        let http = FakeHttp::new();
        http.route("/v1/levels/QQQ", 200, &json!({"cw": 492.5}));
        let tool = TestSource(Some(Arc::clone(&http) as Arc<dyn HttpClient>));
        let ctx = ToolCtx::new(Origin::User, Timestamp::now());
        let spec = json!({
            "version": 1, "id": "acme", "name": "Acme levels", "vendor": "Acme",
            "baseUrl": "https://api.acme.test/v1",
            "instruments": [{"root": "QQQ", "ticker": "QQQ"}],
            "requests": [{"id": "main", "package": "Main", "path": "/levels/{ticker}",
                "fields": [{"field": "call_wall", "path": "cw"}]}],
            "schedule": {"everySeconds": 300}
        });
        let mut with_secret = spec.clone();
        with_secret["auth"] = json!({"in": "header", "name": "Authorization", "prefix": "Bearer "});
        let input = |spec| serde_json::from_value(json!({"spec": spec})).unwrap();

        tool.call(&ctx, input(with_secret)).await.unwrap();
        assert_eq!(http.calls().len(), 0);
        tool.call(&ctx, input(spec)).await.unwrap();
        assert_eq!(http.calls().len(), 1);
    }
}
