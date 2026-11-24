mod cache;
mod frame;
pub mod io;
mod series;
mod service;
mod studies;
mod tools;

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tessera_host::{
    KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicSizing, TsExports,
    parse_params,
};
use tessera_protocol::rpc::RpcError;
use tessera_protocol::topics::NoParams;
use tessera_tools::{RegistryError, ToolRegistry};

pub use frame::{BarKind, Grid, builtin_series};
pub use series::SERIES_TOPIC;
pub use service::{CATALOG_TOPIC, IndicatorsService, MAX_BARS, script_error, spec_of};
pub use studies::{COMPUTED_BUILTINS, FORMING_THROTTLE};

use crate::io::*;

pub struct IndicatorsModule {
    svc: Arc<IndicatorsService>,
}

impl std::fmt::Debug for IndicatorsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndicatorsModule")
            .field("svc", &self.svc)
            .finish_non_exhaustive()
    }
}

impl IndicatorsModule {
    pub fn new(svc: Arc<IndicatorsService>) -> Self {
        Self { svc }
    }

    pub fn service(&self) -> &Arc<IndicatorsService> {
        &self.svc
    }
}

impl RuntimeModule for IndicatorsModule {
    fn name(&self) -> &'static str {
        "indicators"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(tools::ListIndicators(Arc::clone(&self.svc)))?;
        r.register(tools::GetIndicator(Arc::clone(&self.svc)))?;
        r.register(tools::CreateCustom(Arc::clone(&self.svc)))?;
        r.register(tools::UpdateCustom(Arc::clone(&self.svc)))?;
        r.register(tools::DeleteCustom(Arc::clone(&self.svc)))?;
        r.register(tools::Compute(Arc::clone(&self.svc)))?;
        r.register(tools::Preview(Arc::clone(&self.svc)))?;
        r.register(tools::Reach(Arc::clone(&self.svc)))
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        self.topic_handlers()
    }
}

impl IndicatorsModule {
    pub fn topic_handlers(&self) -> Vec<Arc<dyn TopicHandler>> {
        vec![
            Arc::new(series::SeriesTopic::new(Arc::clone(&self.svc))),
            Arc::new(CatalogTopic(Arc::clone(&self.svc))),
        ]
    }
}

struct CatalogTopic(Arc<IndicatorsService>);

#[async_trait]
impl TopicHandler for CatalogTopic {
    fn name(&self) -> &'static str {
        CATALOG_TOPIC
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::SNAPSHOT
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let _: NoParams = parse_params(params)?;
        Ok(Subscribed::new(KeyFilter::All).snapshot(&CatalogUpdate {
            custom: self.0.custom(),
        }))
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-indicators")
        .ty::<BuiltinIndicator>()
        .ty::<CustomIndicator>()
        .ty::<SandboxStatus>()
        .ty::<IndicatorVersionInfo>()
        .ty::<SeriesPlot>()
        .ty::<SeriesError>()
        .ty::<Replaces>()
        .ty::<SeriesColumn>()
        .ty::<tessera_protocol::indicators::IndicatorLabels>()
        .ty::<tessera_protocol::indicators::IndicatorObjects>()
        .tool::<ListIndicatorsInput, IndicatorsListOutput>("indicators.list")
        .tool::<GetIndicatorInput, IndicatorDetail>("indicators.get")
        .tool::<CreateCustomInput, IndicatorDetail>("indicators.create_custom")
        .tool::<UpdateCustomInput, IndicatorDetail>("indicators.update_custom")
        .tool::<DeleteCustomInput, DeleteCustomOutput>("indicators.delete_custom")
        .tool::<ComputeInput, IndicatorSeries>("indicators.compute")
        .tool::<PreviewInput, IndicatorSeries>("indicators.preview")
        .tool::<ReachInput, ReachOutput>("indicators.reach")
        .topic::<SeriesParams, SeriesUpdate>(SERIES_TOPIC)
        .topic::<NoParams, CatalogUpdate>(CATALOG_TOPIC)
}
