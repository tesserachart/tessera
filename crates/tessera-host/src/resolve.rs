use async_trait::async_trait;
use tessera_core::InstrumentId;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown instrument {0}")]
pub struct UnknownInstrument(pub String);

#[async_trait]
pub trait InstrumentResolver: Send + Sync + 'static {
    async fn resolve_instrument(&self, input: &str) -> Result<InstrumentId, UnknownInstrument>;
}
