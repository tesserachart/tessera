use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::watch;

use crate::IntelligenceProvider;
use crate::history::recorder::{LevelRecorder, Recorded};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IntelRouterError {
    #[error("an intelligence provider with id {0:?} is already connected")]
    Duplicate(String),
}

pub struct IntelRouter {
    providers: RwLock<Vec<Arc<dyn IntelligenceProvider>>>,
    changes: watch::Sender<u64>,
    recorder: Option<Arc<LevelRecorder>>,
}

impl std::fmt::Debug for IntelRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntelRouter")
            .field(
                "providers",
                &self
                    .providers
                    .read()
                    .iter()
                    .map(|p| p.id().to_owned())
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl IntelRouter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            providers: RwLock::new(Vec::new()),
            changes: watch::channel(0).0,
            recorder: None,
        })
    }

    pub fn recording(recorder: Arc<LevelRecorder>) -> Arc<Self> {
        Arc::new(Self {
            providers: RwLock::new(Vec::new()),
            changes: watch::channel(0).0,
            recorder: Some(recorder),
        })
    }

    pub fn recorder(&self) -> Option<&Arc<LevelRecorder>> {
        self.recorder.as_ref()
    }

    pub fn add(&self, provider: Arc<dyn IntelligenceProvider>) -> Result<(), IntelRouterError> {
        let provider: Arc<dyn IntelligenceProvider> = match &self.recorder {
            Some(r) => Arc::new(Recorded::new(provider, Arc::clone(r))),
            None => provider,
        };
        {
            let mut ps = self.providers.write();
            if ps.iter().any(|p| p.id() == provider.id()) {
                return Err(IntelRouterError::Duplicate(provider.id().to_owned()));
            }
            ps.push(provider);
        }
        self.changes.send_modify(|v| *v += 1);
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Option<Arc<dyn IntelligenceProvider>> {
        let removed = {
            let mut ps = self.providers.write();
            let i = ps.iter().position(|p| p.id() == id)?;
            ps.remove(i)
        };
        self.changes.send_modify(|v| *v += 1);
        Some(removed)
    }

    pub fn providers(&self) -> Vec<Arc<dyn IntelligenceProvider>> {
        self.providers.read().clone()
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn IntelligenceProvider>> {
        self.providers.read().iter().find(|p| p.id() == id).cloned()
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }
}
