use tessera_core::SharedClock;
use tessera_store::Store;

use crate::io::{DraftSourceInput, SourceDraft};

pub const COLLECTION: &str = "intel.level_source_draft";

const MAX_DRAFTS: usize = 20;

#[derive(Clone)]
pub struct SourceDrafts {
    store: Store,
    clock: SharedClock,
}

impl std::fmt::Debug for SourceDrafts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceDrafts").finish_non_exhaustive()
    }
}

impl SourceDrafts {
    pub fn new(store: Store, clock: SharedClock) -> Self {
        Self { store, clock }
    }

    pub fn put(&self, input: DraftSourceInput) -> Result<SourceDraft, String> {
        let id = input.spec.id.trim().to_owned();
        if id.is_empty() {
            return Err("the spec has no id".into());
        }
        if self.list()?.len() >= MAX_DRAFTS && self.get(&id)?.is_none() {
            return Err(format!(
                "{MAX_DRAFTS} drafts are waiting: the user saves or discards one first"
            ));
        }
        let draft = SourceDraft {
            problems: input.spec.problems(),
            id: id.clone(),
            spec: input.spec,
            samples: input.samples,
            note: input
                .note
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty()),
            drafted_at: self.clock.now(),
        };
        let body = serde_json::to_value(&draft).map_err(|e| e.to_string())?;
        self.store
            .documents(COLLECTION)
            .put(&id, None, &body, draft.drafted_at)
            .map_err(|e| e.to_string())?;
        Ok(draft)
    }

    fn get(&self, id: &str) -> Result<Option<SourceDraft>, String> {
        Ok(self
            .store
            .documents(COLLECTION)
            .get(id)
            .map_err(|e| e.to_string())?
            .and_then(|d| serde_json::from_value::<SourceDraft>(d.body).ok()))
    }

    pub fn list(&self) -> Result<Vec<SourceDraft>, String> {
        let mut out: Vec<SourceDraft> = self
            .store
            .documents(COLLECTION)
            .list(None, 200)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|d| serde_json::from_value::<SourceDraft>(d.body).ok())
            .collect();
        out.sort_by_key(|a| std::cmp::Reverse(a.drafted_at));
        Ok(out)
    }

    pub fn discard(&self, id: &str) -> Result<bool, String> {
        self.store
            .documents(COLLECTION)
            .delete(id)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::LevelSourceSpec;
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use tessera_core::clock::SystemClock;

    fn spec(id: &str) -> LevelSourceSpec {
        serde_json::from_value(serde_json::json!({
            "version": 1, "id": id, "name": "Acme", "vendor": "Acme",
            "baseUrl": "https://api.acme.test",
            "instruments": [{"root": "NQ", "ticker": "NDX"}],
            "requests": [{"id": "levels", "package": "Levels", "path": "/{ticker}",
                "fields": [{"field": "call_wall"}]}],
            "schedule": {"everySeconds": 300}
        }))
        .unwrap()
    }

    #[test]
    fn a_draft_is_kept_listed_replaced_and_discarded() {
        let store = Store::open_in_memory().unwrap();
        let d = SourceDrafts::new(store, Arc::new(SystemClock));
        let first = d
            .put(DraftSourceInput {
                spec: spec("acme"),
                samples: BTreeMap::from([("levels".into(), serde_json::json!({"call_wall": 1}))]),
                note: Some("  check the ticker  ".into()),
            })
            .unwrap();
        assert!(first.problems.is_empty(), "{:?}", first.problems);
        assert_eq!(first.note.as_deref(), Some("check the ticker"));
        assert_eq!(serde_json::to_value(&first).unwrap()["spec"]["id"], "acme");
        d.put(DraftSourceInput {
            spec: spec("acme"),
            samples: BTreeMap::new(),
            note: None,
        })
        .unwrap();
        assert_eq!(d.list().unwrap().len(), 1);
        assert!(d.discard("acme").unwrap());
        assert!(!d.discard("acme").unwrap());
        assert!(d.list().unwrap().is_empty());
    }
}
