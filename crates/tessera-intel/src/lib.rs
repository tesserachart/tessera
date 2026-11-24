pub mod conversion;
pub mod history;
pub mod hub;
pub mod io;
#[cfg(any(test, feature = "test-support"))]
pub mod mock;
pub mod module;
pub mod router;
pub mod service;
pub mod source;

use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use tessera_core::capabilities::IntelCapabilities;
use tessera_core::health::ProviderHealth;
use tessera_core::levels::Level;
use tessera_core::{InstrumentId, Timestamp};

pub use conversion::{ConversionError, ConversionRecord};
pub use history::backfill::HistoryRequest;
pub use module::{IntelModule, ts_exports};
pub use router::IntelRouter;
pub use service::IntelService;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IntelError {
    #[error("no intelligence for {0}")]
    NotCovered(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
    #[error("no snapshot at or before {0}")]
    NoSnapshot(Timestamp),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelSnapshot {
    pub instrument: InstrumentId,
    pub as_of: Timestamp,
    pub levels: Vec<Level>,
    pub raw_blob: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct HistoryFile {
    pub name: String,
    pub endpoint: String,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for HistoryFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HistoryFile")
            .field("name", &self.name)
            .field("bytes", &self.bytes.len())
            .finish()
    }
}

#[async_trait]
pub trait IntelligenceProvider: Send + Sync + 'static {
    fn id(&self) -> &str;

    fn display_name(&self) -> &str;

    fn capabilities(&self) -> IntelCapabilities;

    fn health(&self) -> ProviderHealth;

    async fn levels(
        &self,
        instrument: &InstrumentId,
        as_of: Option<Timestamp>,
    ) -> Result<LevelSnapshot, IntelError>;

    async fn conversion(
        &self,
        from: &str,
        to: &InstrumentId,
    ) -> Result<ConversionRecord, IntelError>;

    fn subscribe_levels(
        &self,
        instrument: &InstrumentId,
    ) -> Result<BoxStream<'static, LevelSnapshot>, IntelError> {
        Err(IntelError::Unsupported(format!(
            "{} does not stream levels for {instrument}",
            self.id()
        )))
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_secs(30)
    }

    fn level_source(&self) -> Option<io::LevelSourceInfo> {
        None
    }

    async fn history_file(&self, request: &HistoryRequest) -> Result<HistoryFile, IntelError> {
        Err(IntelError::Unsupported(format!(
            "{} offers no history for {} {} on {}",
            self.id(),
            request.ticker,
            request.package,
            request.date
        )))
    }
}
