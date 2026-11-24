use tessera_core::InstrumentId;
use tessera_market::hub::depth_history::DepthArchive;
use tessera_store::depth::DepthStore;

#[derive(Debug)]
pub struct StoreDepthArchive(pub DepthStore);

impl DepthArchive for StoreDepthArchive {
    fn put(
        &self,
        provider: &str,
        instrument: &InstrumentId,
        minute: i64,
        columns: &[u8],
    ) -> Result<(), String> {
        self.0
            .put(provider, instrument.as_str(), minute, columns)
            .map_err(|e| e.to_string())
    }

    fn get(
        &self,
        provider: &str,
        instrument: &InstrumentId,
        from: i64,
        to: i64,
    ) -> Result<Vec<(i64, Vec<u8>)>, String> {
        self.0
            .get(provider, instrument.as_str(), from, to)
            .map_err(|e| e.to_string())
    }

    fn first(&self, provider: &str, instrument: &InstrumentId) -> Result<Option<i64>, String> {
        self.0
            .first(provider, instrument.as_str())
            .map_err(|e| e.to_string())
    }

    fn prune(&self, provider: &str, instrument: &InstrumentId, before: i64) -> Result<(), String> {
        self.0
            .prune(provider, instrument.as_str(), before)
            .map(drop)
            .map_err(|e| e.to_string())
    }
}
