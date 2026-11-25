use std::sync::Arc;

use tessera_host::{RuntimeModule, TsExports};
use tessera_tools::{RegistryError, ToolRegistry};

use crate::budget::ResearchBudget;
use crate::study::Studies;

#[derive(Debug, Default)]
pub struct ResearchModule {
    studies: Option<Arc<Studies>>,
}

impl ResearchModule {
    pub fn new() -> Self {
        Self { studies: None }
    }

    pub fn with_studies(studies: Arc<Studies>) -> Self {
        Self {
            studies: Some(studies),
        }
    }
}

impl RuntimeModule for ResearchModule {
    fn name(&self) -> &'static str {
        "research"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        match &self.studies {
            Some(s) => crate::tools::register(r, s),
            None => Ok(()),
        }
    }
}

pub fn ts_exports() -> TsExports {
    crate::tools::ts_exports(TsExports::new("tessera-research")).ty::<ResearchBudget>()
}
