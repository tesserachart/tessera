use std::sync::Arc;

use tessera_core::{InstrumentId, Timestamp};
use tessera_host::InstrumentResolver;
use tessera_protocol::topics::LevelsUpdate;

use crate::io::{IntelProviderEntry, LevelSourceInfo};
use crate::router::IntelRouter;
use crate::{ConversionRecord, IntelError, IntelligenceProvider, LevelSnapshot};

pub fn levels_update(provider: &dyn IntelligenceProvider, snap: LevelSnapshot) -> LevelsUpdate {
    LevelsUpdate {
        instrument: snap.instrument,
        levels: snap.levels,
        as_of: snap.as_of,
        provider: provider.id().to_owned(),
    }
}

pub struct IntelService {
    router: Arc<IntelRouter>,
    resolver: Arc<dyn InstrumentResolver>,
}

impl std::fmt::Debug for IntelService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntelService")
            .field("router", &self.router)
            .finish_non_exhaustive()
    }
}

impl IntelService {
    pub fn new(router: Arc<IntelRouter>, resolver: Arc<dyn InstrumentResolver>) -> Self {
        Self { router, resolver }
    }

    pub fn router(&self) -> &Arc<IntelRouter> {
        &self.router
    }

    pub async fn resolve(&self, input: &str) -> Result<InstrumentId, IntelError> {
        self.resolver
            .resolve_instrument(input)
            .await
            .map_err(|e| IntelError::NotCovered(format!("{} (unknown instrument)", e.0)))
    }

    fn candidates(
        &self,
        provider: Option<&str>,
        what: &str,
        offers: impl Fn(&dyn IntelligenceProvider) -> bool,
    ) -> Result<Vec<Arc<dyn IntelligenceProvider>>, IntelError> {
        let all = self.router.providers();
        let picked: Vec<_> = match provider {
            Some(id) => {
                let p = all.into_iter().find(|p| p.id() == id).ok_or_else(|| {
                    IntelError::NotCovered(format!(
                        "no intelligence provider {id} is connected; intel.list_providers shows what is"
                    ))
                })?;
                vec![p]
            }
            None => all,
        };
        let offering: Vec<_> = picked.into_iter().filter(|p| offers(p.as_ref())).collect();
        if offering.is_empty() {
            return Err(IntelError::Unsupported(format!(
                "no connected intelligence provider offers {what}; intel.list_providers shows what is connected"
            )));
        }
        Ok(offering)
    }

    pub async fn levels(
        &self,
        instrument: &InstrumentId,
        as_of: Option<Timestamp>,
        provider: Option<&str>,
    ) -> Result<LevelsUpdate, IntelError> {
        let mut last = None;
        for p in self.candidates(provider, "levels", |p| p.capabilities().levels)? {
            match p.levels(instrument, as_of).await {
                Ok(snap) => return Ok(levels_update(p.as_ref(), snap)),
                Err(e @ IntelError::NoSnapshot(_)) => return Err(e),
                Err(IntelError::NotCovered(_)) => {}
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| IntelError::NotCovered(instrument.to_string())))
    }

    pub async fn levels_all(&self, instrument: &InstrumentId) -> Vec<LevelsUpdate> {
        let mut out = Vec::new();
        for p in self.router.providers() {
            if !p.capabilities().levels {
                continue;
            }
            if let Ok(snap) = p.levels(instrument, None).await {
                out.push(levels_update(p.as_ref(), snap));
            }
        }
        out
    }

    pub async fn conversion(
        &self,
        from: &str,
        to: &InstrumentId,
        provider: Option<&str>,
    ) -> Result<ConversionRecord, IntelError> {
        let mut last = None;
        for p in self.candidates(provider, "conversions", |p| p.capabilities().conversions)? {
            match p.conversion(from, to).await {
                Ok(rec) => return Ok(rec),
                Err(IntelError::NotCovered(_)) => {}
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| IntelError::NotCovered(format!("{from} → {to}"))))
    }

    pub fn sources(&self) -> Vec<LevelSourceInfo> {
        self.router
            .providers()
            .iter()
            .filter_map(|p| p.level_source())
            .collect()
    }

    pub fn providers(&self) -> Vec<IntelProviderEntry> {
        self.router
            .providers()
            .iter()
            .map(|p| IntelProviderEntry {
                provider_id: p.id().to_owned(),
                display_name: p.display_name().to_owned(),
                capabilities: p.capabilities(),
                health: p.health(),
            })
            .collect()
    }
}
