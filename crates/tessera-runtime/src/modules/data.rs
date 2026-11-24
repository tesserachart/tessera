use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::accounts::CredentialStore;
use tessera_host::{RuntimeModule, TsExports};
use tessera_protocol::tools::RiskTier;
use tessera_store::{DataDir, Store};
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use ts_rs::TS;

use crate::secrets::Secrets;

const WALK_CAP: usize = 200_000;

/// `runtime.data_info` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataInfoInput {}

/// What a file or directory of the data directory holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DataFileKind {
    /// The database (`tessera.db`, with its write-ahead log and shared memory).
    Database,
    /// Raw vendor responses and attachments (`blobs/`).
    Blobs,
    /// The recorded order books (`depth.db`).
    Depth,
    /// The saved trades (`ticks/ticks.db`): every print kept per contract and trade date.
    Ticks,
    /// The runtime's logs (`logs/`).
    Logs,
    /// The analyst's working and session files (`agents/`).
    Agents,
    /// Copies of the database (`backups/`, `runtime.backup`).
    Backups,
}

/// One file or directory of the data directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DataFile {
    /// What it holds.
    pub what: DataFileKind,
    /// Its full path.
    pub path: String,
    /// Its size on disk, in bytes (a directory's summed over its files).
    #[ts(type = "number")]
    pub bytes: u64,
}

/// How many of something the database holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DataCount {
    /// What, in plain words (`Workspaces`, `Journal fills`).
    pub what: String,
    /// How many.
    #[ts(type = "number")]
    pub count: u64,
}

/// `runtime.data_info` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DataInfoOutput {
    /// The data directory; none for a runtime that keeps its data in memory.
    pub data_dir: Option<String>,
    /// What the data directory holds, those that exist.
    pub files: Vec<DataFile>,
    /// Their sizes summed, in bytes.
    #[ts(type = "number")]
    pub total_bytes: u64,
    /// How many workspaces, journal fills, research studies, analyst sessions, custom indicators and recorded
    /// tool calls the database holds.
    pub counts: Vec<DataCount>,
    /// Where new logins and keys are kept: the OS keyring, or the development file (`TESSERA_SECRET_STORE=file`).
    pub secret_store: CredentialStore,
    /// The development secrets directory (the fallback store).
    pub secrets_dir: Option<String>,
    /// The OS keyring's service name for this runtime's secrets (`tessera` unless `TESSERA_KEYRING_SERVICE` names
    /// another), when the keyring is used.
    pub keyring_service: Option<String>,
    /// The build: `debug` or `release`.
    pub profile: String,
    /// The runtime's version.
    pub version: String,
}

/// `runtime.backup` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupInput {}

/// `runtime.backup` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackupOutput {
    /// The copy's full path (`<data dir>/backups/tessera-20261009-153000.db`).
    pub path: String,
    /// Its size, in bytes.
    #[ts(type = "number")]
    pub bytes: u64,
}

pub struct DataModule {
    data: Arc<DataFacts>,
}

impl std::fmt::Debug for DataModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DataModule").finish_non_exhaustive()
    }
}

struct DataFacts {
    store: Store,
    data_dir: Option<PathBuf>,
    secrets: Secrets,
}

impl DataModule {
    pub fn new(store: Store, data_dir: Option<PathBuf>, secrets: Secrets) -> Self {
        Self {
            data: Arc::new(DataFacts {
                store,
                data_dir,
                secrets,
            }),
        }
    }
}

impl RuntimeModule for DataModule {
    fn name(&self) -> &'static str {
        "data"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(DataInfo(Arc::clone(&self.data)))?;
        r.register(Backup(Arc::clone(&self.data)))?;
        Ok(())
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (data)")
        .tool::<DataInfoInput, DataInfoOutput>("runtime.data_info")
        .tool::<BackupInput, BackupOutput>("runtime.backup")
}

fn size_of(path: &Path) -> Option<u64> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_dir() {
        return Some(meta.len());
    }
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > WALK_CAP {
                return Some(total);
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    Some(total)
}

fn database_size(file: &Path) -> Option<u64> {
    let main = size_of(file)?;
    let side = |suffix: &str| {
        let mut p = file.as_os_str().to_owned();
        p.push(suffix);
        size_of(Path::new(&p)).unwrap_or(0)
    };
    Some(main + side("-wal") + side("-shm"))
}

fn data_files(dir: &Path) -> Vec<DataFile> {
    let dir = DataDir::new(dir);
    let entries = [
        (DataFileKind::Database, dir.database(), true),
        (DataFileKind::Blobs, dir.blobs(), false),
        (DataFileKind::Depth, dir.depth(), true),
        (DataFileKind::Ticks, dir.ticks(), true),
        (DataFileKind::Logs, dir.logs(), false),
        (DataFileKind::Agents, dir.agents(), false),
        (DataFileKind::Backups, dir.backups(), false),
    ];
    entries
        .into_iter()
        .filter_map(|(what, path, database)| {
            let bytes = if database {
                database_size(&path)
            } else {
                size_of(&path)
            }?;
            Some(DataFile {
                what,
                path: path.display().to_string(),
                bytes,
            })
        })
        .collect()
}

const COUNTS: [(&str, &str, &str); 6] = [
    ("Workspaces", "layouts", ""),
    ("Journal fills", "journal_fills", ""),
    (
        "Research studies",
        "documents",
        " WHERE collection = 'research.study'",
    ),
    ("Analyst sessions", "sessions", ""),
    ("Custom indicators", "custom_indicators", ""),
    ("Tool calls recorded", "tool_calls", ""),
];

fn counts(store: &Store) -> Result<Vec<DataCount>, ToolError> {
    let conn = store
        .conn()
        .map_err(|e| ToolError::internal(format!("the database: {e}")))?;
    let mut out = Vec::new();
    for (what, table, filter) in COUNTS {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| ToolError::internal(format!("the database: {e}")))?;
        if exists == 0 {
            continue;
        }
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}{filter}"), [], |r| {
                r.get(0)
            })
            .map_err(|e| ToolError::internal(format!("counting {table}: {e}")))?;
        out.push(DataCount {
            what: what.to_owned(),
            count: u64::try_from(count).unwrap_or(0),
        });
    }
    Ok(out)
}

impl DataFacts {
    fn info(&self) -> Result<DataInfoOutput, ToolError> {
        let files = self.data_dir.as_deref().map(data_files).unwrap_or_default();
        Ok(DataInfoOutput {
            data_dir: self.data_dir.as_ref().map(|d| d.display().to_string()),
            total_bytes: files.iter().map(|f| f.bytes).sum(),
            files,
            counts: counts(&self.store)?,
            secret_store: self.secrets.primary(),
            secrets_dir: self.secrets.secrets_dir().map(|d| d.display().to_string()),
            keyring_service: self.secrets.keyring_service(),
            profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
            .to_owned(),
            version: crate::VERSION.to_owned(),
        })
    }

    fn backup(&self) -> Result<BackupOutput, ToolError> {
        let Some(dir) = &self.data_dir else {
            return Err(ToolError::unavailable("this runtime keeps no data on disk"));
        };
        let backups = DataDir::new(dir).backups();
        crate::private::private_dir(&backups).map_err(|e| {
            ToolError::internal(format!("cannot create {}: {}", backups.display(), e.kind()))
        })?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let path = (0..100)
            .map(|n| {
                backups.join(if n == 0 {
                    format!("tessera-{stamp}.db")
                } else {
                    format!("tessera-{stamp}-{n}.db")
                })
            })
            .find(|p| !p.exists())
            .ok_or_else(|| ToolError::conflict("too many backups this second; try again"))?;
        let target = path.to_str().ok_or_else(|| {
            ToolError::internal(format!(
                "the data directory's path is not UTF-8: {}",
                path.display()
            ))
        })?;
        let conn = self
            .store
            .conn()
            .map_err(|e| ToolError::internal(format!("the database: {e}")))?;
        conn.execute("VACUUM INTO ?1", [target])
            .map_err(|e| ToolError::internal(format!("the backup did not finish: {e}")))?;
        let _ = crate::private::protect_data_dir(&backups);
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        tracing::info!(path = %path.display(), bytes, "database backed up");
        Ok(BackupOutput {
            path: path.display().to_string(),
            bytes,
        })
    }
}

async fn blocking<T: Send + 'static>(
    data: &Arc<DataFacts>,
    f: fn(&DataFacts) -> Result<T, ToolError>,
) -> Result<T, ToolError> {
    let data = Arc::clone(data);
    tokio::task::spawn_blocking(move || f(&data))
        .await
        .map_err(|e| ToolError::internal(e.to_string()))?
}

struct DataInfo(Arc<DataFacts>);

#[async_trait]
impl Tool for DataInfo {
    type Input = DataInfoInput;
    type Output = DataInfoOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("runtime.data_info", "Read data facts", RiskTier::Read)
            .description("Where Tessera keeps the user's data and how much: the data directory, its database, raw vendor responses, recorded order books, saved trades, logs, the analyst's files and backups with their sizes; how many workspaces, journal fills, research studies, analyst sessions, custom indicators and recorded tool calls the database holds; where logins and keys are kept (the OS keyring, or the development secrets file); the build (debug or release) and version. Never a secret.")
            .activity("Read data facts")
            .timeout_ms(60_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: DataInfoInput,
    ) -> Result<DataInfoOutput, ToolError> {
        blocking(&self.0, DataFacts::info).await
    }

    fn summarize(&self, out: &DataInfoOutput) -> Option<String> {
        Some(format!("{} bytes on disk", out.total_bytes))
    }
}

struct Backup(Arc<DataFacts>);

#[async_trait]
impl Tool for Backup {
    type Input = BackupInput;
    type Output = BackupOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("runtime.backup", "Back up the database", RiskTier::Modify)
            .description("Writes a consistent copy of Tessera's database (workspaces, settings, the journal, research, analyst sessions, custom indicators, records of tool calls; never a login or key, which live in the OS keyring) to a new file in the data directory's backups folder, named by the time, and says where. The running runtime carries on while it copies.")
            .user_only()
            .timeout_ms(600_000)
    }

    async fn call(&self, _ctx: &ToolCtx, _input: BackupInput) -> Result<BackupOutput, ToolError> {
        blocking(&self.0, DataFacts::backup).await
    }

    fn summarize(&self, out: &BackupOutput) -> Option<String> {
        Some(out.path.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_is_summed_over_its_files_and_a_missing_one_is_left_out() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("blobs/ab")).unwrap();
        std::fs::write(dir.path().join("blobs/ab/x"), [0u8; 100]).unwrap();
        std::fs::write(dir.path().join("blobs/y"), [0u8; 20]).unwrap();
        std::fs::write(dir.path().join("tessera.db"), [0u8; 4096]).unwrap();
        std::fs::write(dir.path().join("tessera.db-wal"), [0u8; 10]).unwrap();
        let files = data_files(dir.path());
        let got: Vec<(DataFileKind, u64)> = files.iter().map(|f| (f.what, f.bytes)).collect();
        assert_eq!(
            got,
            [(DataFileKind::Database, 4106), (DataFileKind::Blobs, 120)]
        );
        assert!(files[0].path.ends_with("tessera.db"));
    }
}
