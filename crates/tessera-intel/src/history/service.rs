use std::collections::BTreeSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tessera_core::ids::slug;
use tessera_core::{SharedClock, Timestamp};
use tessera_store::Store;
use tessera_store::level_history::{LevelName, SeriesCoverage};

use super::file::{self, Roots};
use super::import::{self, Plan, ny_date};
use super::io::{
    AdapterInfo, GetLevelHistoryOutput, ImportAdapter, ImportLevelHistoryInput,
    ImportLevelHistoryOutput, LevelHistorySeries, LevelImportInfo, LevelObservation,
    ListLevelHistoryOutput, PreviewFileOutput, RecordingInfo, SeriesCoverageInfo,
};
use super::mapping::{ImportMapping, MappingAdapter};
use super::script::ScriptAdapter;
use super::{FileData, HistoryAdapter};
use crate::router::IntelRouter;

pub const SAVED: &str = "intel.level_adapter";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SavedAdapter {
    Mapping { mapping: Box<ImportMapping> },
    Script { vendor: String, code: String },
}

pub struct LevelHistory {
    store: Store,
    clock: SharedClock,
    roots: Roots,
    router: Arc<IntelRouter>,
}

impl std::fmt::Debug for LevelHistory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LevelHistory")
            .field("roots", &self.roots)
            .finish_non_exhaustive()
    }
}

fn rewrite_note(python: &str) -> String {
    format!(
        "/*\n{}\n*/\nexport function records() {{\n  throw new Error('This adapter was written in Python, which Tessera no longer runs: rewrite it in JavaScript as records(text, file). The Python is kept above.');\n}}\n",
        python.replace("*/", "* /")
    )
}

pub fn root_of(instrument: &str) -> Option<String> {
    let (symbol, venue) = instrument.split_once('.')?;
    if venue.is_empty() {
        return None;
    }
    let digits = symbol
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .count();
    if digits == 0 || digits > 2 || symbol.len() < digits + 2 {
        return None;
    }
    let body = &symbol[..symbol.len() - digits];
    let month = body.chars().last()?;
    "FGHJKMNQUVXZ"
        .contains(month)
        .then(|| body[..body.len() - 1].to_owned())
        .filter(|r| !r.is_empty())
}

pub fn instruments_of(instrument: &str) -> Vec<String> {
    let mut out = vec![instrument.to_owned()];
    out.extend(root_of(instrument));
    out
}

impl LevelHistory {
    pub fn new(store: Store, clock: SharedClock, roots: Roots, router: Arc<IntelRouter>) -> Self {
        let history = Self {
            store,
            clock,
            roots,
            router,
        };
        if let Err(e) = history.port_unrunnable_adapters() {
            tracing::warn!(error = %e, "adapters saved for an earlier engine were left as they were");
        }
        history
    }

    fn port_unrunnable_adapters(&self) -> Result<(), String> {
        let repo = self.store.documents(SAVED);
        for doc in repo.list(None, 200).map_err(|e| e.to_string())? {
            if doc.body["kind"] != "python" {
                continue;
            }
            let ported = SavedAdapter::Script {
                vendor: doc.body["vendor"].as_str().unwrap_or_default().to_owned(),
                code: rewrite_note(doc.body["code"].as_str().unwrap_or_default()),
            };
            let body = serde_json::to_value(&ported).map_err(|e| e.to_string())?;
            repo.put(&doc.id, None, &body, self.clock.now())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn router(&self) -> &Arc<IntelRouter> {
        &self.router
    }

    pub fn now(&self) -> Timestamp {
        self.clock.now()
    }

    pub fn coverage_info(&self, c: &SeriesCoverage) -> SeriesCoverageInfo {
        let hours = self
            .store
            .level_history()
            .known_hours(c.series.id, Timestamp(i64::MIN), Timestamp(i64::MAX))
            .unwrap_or_default();
        let days: BTreeSet<String> = hours.into_iter().map(ny_date).collect();
        let s = &c.series;
        SeriesCoverageInfo {
            name: s.full_name(),
            vendor: s.info.vendor.clone(),
            package: s.info.package.clone(),
            level: s.info.level.clone(),
            label: s.info.label.clone(),
            instrument: s.info.instrument.clone(),
            endpoint: s.info.endpoint.clone(),
            basis: s.info.basis.clone(),
            first: c.first,
            last: c.last,
            first_date: ny_date(c.first),
            last_date: ny_date(c.last),
            days: days.len() as u32,
            observations: c.observations,
            origins: c.origins.clone(),
        }
    }

    pub fn recordings(&self) -> Result<Vec<RecordingInfo>, String> {
        Ok(self
            .store
            .level_history()
            .recordings()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|r| RecordingInfo {
                provider: r.provider,
                vendor: r.vendor,
                since: r.first_at,
                last: r.last_at,
                snapshots: r.snapshots,
            })
            .collect())
    }

    pub fn none_words(&self) -> String {
        let rec = self.recordings().unwrap_or_default();
        let real: Vec<String> = self
            .router
            .providers()
            .iter()
            .map(|p| p.capabilities())
            .filter(|c| c.levels)
            .map(|c| c.vendor)
            .collect();
        let recording = if rec.is_empty() {
            if real.is_empty() {
                "Nothing has been recorded: no source of levels is connected.".to_owned()
            } else {
                format!(
                    "Nothing has been recorded yet: {} levels are recorded while a chart shows an instrument they cover.",
                    real.join(", ")
                )
            }
        } else {
            rec.iter()
                .map(|r| format!("{} recorded since {}", r.vendor, ny_date(r.since)))
                .collect::<Vec<_>>()
                .join("; ")
                + "."
        };
        format!(
            "{recording} Earlier history can be imported from a file (intel.preview_file, then intel.import_level_history), or backfilled from a vendor whose plan includes it (intel.backfill_level_history)."
        )
    }

    pub fn get(
        &self,
        instrument: &str,
        names: Option<&[String]>,
        from: Option<Timestamp>,
        to: Option<Timestamp>,
        limit: usize,
    ) -> Result<GetLevelHistoryOutput, String> {
        let h = self.store.level_history();
        let wanted = instruments_of(instrument);
        let series = match names {
            Some(names) if !names.is_empty() => {
                let mut out = Vec::new();
                for n in names {
                    let name = LevelName::parse(n)?;
                    let found = h.find(&name, &wanted).map_err(|e| e.to_string())?;
                    if found.is_empty() {
                        return Err(format!(
                            "no history of {n} on {}. {}",
                            wanted.join(" or "),
                            self.none_words()
                        ));
                    }
                    out.extend(found);
                }
                out
            }
            _ => h
                .all_series()
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|s| {
                    wanted
                        .iter()
                        .any(|w| w.eq_ignore_ascii_case(&s.info.instrument))
                })
                .collect(),
        };
        let ids: Vec<i64> = series.iter().map(|s| s.id).collect();
        let coverage = h.coverage(Some(&ids)).map_err(|e| e.to_string())?;
        let mut out = GetLevelHistoryOutput {
            instrument: instrument.to_owned(),
            series: Vec::new(),
            notes: Vec::new(),
        };
        for c in &coverage {
            let obs = h
                .observations(c.series.id, from, to, limit + 1)
                .map_err(|e| e.to_string())?;
            let truncated = obs.len() > limit;
            out.series.push(LevelHistorySeries {
                series: self.coverage_info(c),
                observations: obs
                    .into_iter()
                    .take(limit)
                    .map(|o| LevelObservation {
                        as_of: o.as_of,
                        known_at: o.known_at,
                        value: o.value,
                        native_value: o.native_value,
                        reason: o.reason,
                        origin: o.origin,
                    })
                    .collect(),
                truncated,
            });
        }
        if out.series.is_empty() {
            out.notes.push(format!(
                "No level history on {}. {}",
                wanted.join(" or "),
                self.none_words()
            ));
        }
        Ok(out)
    }

    pub fn list(&self) -> Result<ListLevelHistoryOutput, String> {
        let h = self.store.level_history();
        let series = h
            .coverage(None)
            .map_err(|e| e.to_string())?
            .iter()
            .map(|c| self.coverage_info(c))
            .collect();
        let imports = h
            .imports()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|i| LevelImportInfo {
                id: i.id,
                vendor: i.vendor,
                file_name: i.file_name,
                adapter: i.adapter,
                records: i.records,
                imported: i.imported,
                skipped: i.skipped,
                from: i.first_as_of,
                to: i.last_as_of,
                at: i.at,
                by: i.by,
            })
            .collect();
        Ok(ListLevelHistoryOutput {
            series,
            recordings: self.recordings()?,
            imports,
            adapters: self.adapters()?,
        })
    }

    fn saved(&self) -> Result<Vec<(String, SavedAdapter)>, String> {
        Ok(self
            .store
            .documents(SAVED)
            .list(None, 200)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|d| serde_json::from_value(d.body).ok().map(|a| (d.id, a)))
            .collect())
    }

    pub fn adapters(&self) -> Result<Vec<AdapterInfo>, String> {
        let mut out = Vec::new();
        for (key, a) in self.saved()? {
            out.push(match a {
                SavedAdapter::Mapping { mapping } => AdapterInfo {
                    description: MappingAdapter {
                        mapping: (*mapping).clone(),
                    }
                    .describe(),
                    name: key,
                    vendor: mapping.vendor,
                    kind: "mapping".into(),
                },
                SavedAdapter::Script { vendor, .. } => AdapterInfo {
                    description: format!("{vendor} files, read by a saved JavaScript adapter"),
                    name: key,
                    vendor,
                    kind: "script".into(),
                },
            });
        }
        Ok(out)
    }

    pub fn preview(&self, path: &str) -> Result<PreviewFileOutput, String> {
        let real = self.roots.resolve(path)?;
        let mut p = file::preview(&real)?;
        p.adapters = self
            .saved()?
            .into_iter()
            .filter_map(|(key, a)| match a {
                SavedAdapter::Mapping { mapping } => {
                    let m = MappingAdapter { mapping: *mapping };
                    m.recognises(&p.header).then(|| AdapterInfo {
                        description: m.describe(),
                        name: key,
                        vendor: m.mapping.vendor.clone(),
                        kind: "mapping".into(),
                    })
                }
                SavedAdapter::Script { .. } => None,
            })
            .collect();
        Ok(p)
    }

    fn adapter(&self, a: &ImportAdapter) -> Result<(Arc<dyn HistoryAdapter>, String), String> {
        match a {
            ImportAdapter::Mapping { mapping } => {
                let p = mapping.problems();
                if !p.is_empty() {
                    return Err(p.join("; "));
                }
                let key = slug(&mapping.vendor);
                Ok((
                    Arc::new(MappingAdapter {
                        mapping: (**mapping).clone(),
                    }),
                    format!("mapping:{key}"),
                ))
            }
            ImportAdapter::Script { vendor, code } => {
                if vendor.trim().is_empty() || code.trim().is_empty() {
                    return Err("a JavaScript adapter needs its vendor and its code".into());
                }
                let key = slug(vendor);
                Ok((
                    Arc::new(ScriptAdapter {
                        vendor: vendor.trim().to_owned(),
                        code: code.clone(),
                    }),
                    format!("script:{key}"),
                ))
            }
            ImportAdapter::Saved { vendor } => {
                let key = slug(vendor);
                let saved = self
                    .saved()?
                    .into_iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, a)| a);
                match saved {
                    Some(SavedAdapter::Mapping { mapping }) => {
                        self.adapter(&ImportAdapter::Mapping { mapping })
                    }
                    Some(SavedAdapter::Script { vendor, code }) => {
                        self.adapter(&ImportAdapter::Script { vendor, code })
                    }
                    None => Err(format!(
                        "nothing is saved for {vendor}; preview the file and give a mapping (saved with save: true once it works)"
                    )),
                }
            }
        }
    }

    pub async fn import(
        &self,
        input: &ImportLevelHistoryInput,
        by: &str,
    ) -> Result<ImportLevelHistoryOutput, String> {
        let file: FileData = match (&input.path, &input.text) {
            (Some(p), None) => {
                let real = self.roots.resolve(p)?;
                tokio::task::spawn_blocking(move || file::read(&real))
                    .await
                    .map_err(|e| e.to_string())??
            }
            (None, Some(t)) => FileData {
                name: input.file_name.clone().unwrap_or_else(|| "pasted".into()),
                bytes: t.clone().into_bytes(),
            },
            _ => return Err("give the file's path, or its text".into()),
        };
        let (adapter, label) = self.adapter(&input.adapter)?;
        let adapted = adapter.read(&file, input.every_seconds).await?;
        let dry_run = input.dry_run.unwrap_or(true);
        let plan = Plan {
            adapter: label,
            file_name: Some(file.name.clone()),
            dry_run,
            origin: tessera_store::level_history::origin::IMPORT,
            instrument: None,
            by: by.to_owned(),
            now: self.clock.now(),
        };
        let store = self.store.clone();
        let mut out = tokio::task::spawn_blocking(move || import::store(&store, adapted, &plan))
            .await
            .map_err(|e| e.to_string())??;
        if !dry_run && input.save.unwrap_or(false) && out.imported + out.duplicates > 0 {
            let saved = match &input.adapter {
                ImportAdapter::Mapping { mapping } => Some((
                    slug(&mapping.vendor),
                    SavedAdapter::Mapping {
                        mapping: mapping.clone(),
                    },
                )),
                ImportAdapter::Script { vendor, code } => Some((
                    slug(vendor),
                    SavedAdapter::Script {
                        vendor: vendor.trim().to_owned(),
                        code: code.clone(),
                    },
                )),
                _ => None,
            };
            if let Some((key, a)) = saved {
                let body = serde_json::to_value(&a).map_err(|e| e.to_string())?;
                self.store
                    .documents(SAVED)
                    .put(&key, None, &body, self.clock.now())
                    .map_err(|e| e.to_string())?;
                out.saved = Some(key);
            }
        }
        Ok(out)
    }

    pub fn undo(&self, id: &str) -> Result<u64, String> {
        self.store
            .level_history()
            .delete_import(id)
            .map(|n| n as u64)
            .map_err(|e| e.to_string())
    }
}
