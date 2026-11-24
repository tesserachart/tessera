pub mod backfill;
pub mod file;
pub mod import;
pub mod io;
pub mod mapping;
pub mod recorder;
pub mod script;
pub mod service;
pub mod snapshots;
pub mod tools;

use std::collections::BTreeMap;

use async_trait::async_trait;
use tessera_core::Timestamp;

pub use service::LevelHistory;

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub time: Timestamp,
    pub instrument: String,
    pub package: String,
    pub level: String,
    pub value: Option<f64>,
    pub reason: Option<String>,
    pub line: usize,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LevelDecl {
    pub label: Option<String>,
    pub endpoint: Option<String>,
    pub basis: Option<String>,
    pub description: Option<String>,
    pub concept: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub line: usize,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Adapted {
    pub vendor: String,
    pub rows: usize,
    pub records: Vec<Record>,
    pub problems: Vec<Problem>,
    pub declared: BTreeMap<(String, String), LevelDecl>,
    pub notes: Vec<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct FileData {
    pub name: String,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for FileData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileData")
            .field("name", &self.name)
            .field("bytes", &self.bytes.len())
            .finish()
    }
}

impl FileData {
    pub fn text(&self) -> Result<&str, String> {
        let bytes = self
            .bytes
            .strip_prefix(b"\xef\xbb\xbf")
            .unwrap_or(&self.bytes);
        std::str::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8 text", self.name))
    }
}

#[async_trait]
pub trait HistoryAdapter: Send + Sync {
    fn describe(&self) -> String;
    fn recognises(&self, _columns: &[String]) -> bool {
        false
    }
    async fn read(&self, file: &FileData, every_seconds: Option<u32>) -> Result<Adapted, String>;
}

pub fn thin(records: Vec<Record>, every_seconds: u32) -> Vec<Record> {
    if every_seconds == 0 {
        return records;
    }
    let every = i64::from(every_seconds) * 1_000_000_000;
    let mut last: BTreeMap<(String, String, String, i64), Record> = BTreeMap::new();
    for r in records {
        let bucket = r.time.0.div_euclid(every);
        let key = (
            r.instrument.clone(),
            r.package.clone(),
            r.level.clone(),
            bucket,
        );
        match last.get(&key) {
            Some(prev) if prev.time > r.time => {}
            _ => {
                last.insert(key, r);
            }
        }
    }
    let mut out: Vec<Record> = last.into_values().collect();
    out.sort_by_key(|r| r.time);
    out
}
