pub mod bars;
pub mod blobs;
mod block;
mod codec;
mod data_dir;
pub mod depth;
pub mod documents;
pub mod error;
pub mod indicators;
pub mod level_history;
mod local;
pub mod mcp_clients;
pub mod migrate;
pub mod repos;
pub mod ticks;

use std::path::{Path, PathBuf};
use std::time::Duration;

use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;

pub use data_dir::DataDir;
pub use documents::{Docs, Document, DocumentRepo};
pub use error::{Result, StoreError};
pub use indicators::{CustomIndicatorRecord, CustomIndicatorRepo, CustomIndicatorVersion};
pub use level_history::LevelHistoryRepo;
pub use mcp_clients::{McpClientRecord, McpClientRepo};
pub use repos::{
    AgentEventRepo, ApprovalRepo, BrokerBatch, BrokerRepo, DraftRepo, Kept, LayoutRepo, Note,
    NoteRepo, SearchHit, SearchRepo, SessionRepo, SettingsRepo, ToolCallRepo,
};

use crate::error::io_err;

pub type Conn = PooledConnection<SqliteConnectionManager>;

#[derive(Clone, Debug)]
pub struct Store {
    pool: Pool<SqliteConnectionManager>,
    path: Option<PathBuf>,
    _scratch: Option<std::sync::Arc<tempfile::TempDir>>,
}

fn configure(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    )
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io_err(parent))?;
        }
        // SQLite's WAL mode is a persistent property of the database file.
        {
            let conn = rusqlite::Connection::open(&path)?;
            let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
            if !mode.eq_ignore_ascii_case("wal") {
                tracing::warn!(%mode, "SQLite did not switch to WAL");
            }
        }
        let manager = SqliteConnectionManager::file(&path).with_init(configure);
        let pool = Pool::builder()
            .max_size(8)
            .connection_timeout(Duration::from_secs(10))
            .build(manager)?;
        let store = Self {
            pool,
            path: Some(path),
            _scratch: None,
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_dir(dir: impl AsRef<Path>) -> Result<Self> {
        Self::open(DataDir::new(dir.as_ref()).database())
    }

    /// Shared-cache memory databases fail with `SQLITE_LOCKED`, which busy_timeout does not retry.
    pub fn open_in_memory() -> Result<Self> {
        let dir = tempfile::Builder::new()
            .prefix("tessera-store-")
            .tempdir()
            .map_err(io_err(std::env::temp_dir()))?;
        let mut store = Self::open(DataDir::new(dir.path()).database())?;
        store.path = None;
        store._scratch = Some(std::sync::Arc::new(dir));
        Ok(store)
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn conn(&self) -> Result<Conn> {
        Ok(self.pool.get()?)
    }

    pub fn migrate(&self) -> Result<usize> {
        let mut conn = self.conn()?;
        migrate::migrate(&mut conn)
    }

    pub fn schema_version(&self) -> Result<i64> {
        let conn = self.conn()?;
        migrate::current_version(&conn)
    }

    pub fn journal_mode(&self) -> Result<String> {
        Ok(self
            .conn()?
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))?)
    }

    pub fn tool_calls(&self) -> ToolCallRepo<'_> {
        ToolCallRepo::new(self)
    }

    pub fn approvals(&self) -> ApprovalRepo<'_> {
        ApprovalRepo::new(self)
    }

    pub fn drafts(&self) -> DraftRepo<'_> {
        DraftRepo::new(self)
    }

    pub fn sessions(&self) -> SessionRepo<'_> {
        SessionRepo::new(self)
    }

    pub fn agent_events(&self) -> AgentEventRepo<'_> {
        AgentEventRepo::new(self)
    }

    pub fn settings(&self) -> SettingsRepo<'_> {
        SettingsRepo::new(self)
    }

    pub fn layouts(&self) -> LayoutRepo<'_> {
        LayoutRepo::new(self)
    }

    pub fn notes(&self) -> NoteRepo<'_> {
        NoteRepo::new(self)
    }

    pub fn search(&self) -> SearchRepo<'_> {
        SearchRepo::new(self)
    }

    pub fn documents<'a>(&'a self, collection: &'a str) -> DocumentRepo<'a> {
        DocumentRepo::new(self, collection)
    }

    pub fn docs<'a, T: serde::Serialize + serde::de::DeserializeOwned>(
        &'a self,
        collection: &'a str,
    ) -> Docs<'a, T> {
        Docs::new(self, collection)
    }

    pub fn custom_indicators(&self) -> CustomIndicatorRepo<'_> {
        CustomIndicatorRepo::new(self)
    }

    pub fn level_history(&self) -> LevelHistoryRepo<'_> {
        LevelHistoryRepo::new(self)
    }

    pub fn mcp_clients(&self) -> McpClientRepo<'_> {
        McpClientRepo::new(self)
    }

    pub fn broker<'a>(&'a self, connection: &'a str) -> BrokerRepo<'a> {
        BrokerRepo::new(self, connection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_uses_wal_and_migrates_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_in_dir(dir.path()).unwrap();
        assert_eq!(store.journal_mode().unwrap().to_lowercase(), "wal");
        assert_eq!(store.schema_version().unwrap(), migrate::latest_version());
        assert_eq!(store.migrate().unwrap(), 0, "idempotent");
        drop(store);
        let again = Store::open_in_dir(dir.path()).unwrap();
        assert_eq!(again.schema_version().unwrap(), migrate::latest_version());
    }

    #[test]
    fn modified_migrations_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_in_dir(dir.path()).unwrap();
        store
            .conn()
            .unwrap()
            .execute(
                "UPDATE _migrations SET checksum = 'x' WHERE version = 1",
                [],
            )
            .unwrap();
        assert!(matches!(
            store.migrate(),
            Err(StoreError::Migration { version: 1, .. })
        ));
    }

    #[test]
    fn a_migration_takes_an_earlier_checksum_of_its_own_and_keeps_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_in_dir(dir.path()).unwrap();
        let m = migrate::MIGRATIONS
            .iter()
            .find(|m| !m.earlier_checksums.is_empty())
            .unwrap();
        let checksum = |store: &Store| -> String {
            store
                .conn()
                .unwrap()
                .query_row(
                    "SELECT checksum FROM _migrations WHERE version = ?1",
                    [m.version],
                    |r| r.get(0),
                )
                .unwrap()
        };
        let now = checksum(&store);
        store
            .conn()
            .unwrap()
            .execute(
                "UPDATE _migrations SET checksum = ?1 WHERE version = ?2",
                rusqlite::params![m.earlier_checksums[0], m.version],
            )
            .unwrap();
        store.migrate().unwrap();
        assert_eq!(checksum(&store), now);
    }

    #[test]
    fn memory_stores_are_isolated_and_shared_across_the_pool() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        a.settings()
            .set("k", &serde_json::json!(1), tessera_core::Timestamp(0))
            .unwrap();
        assert!(b.settings().get("k").unwrap().is_none());
        let c1 = a.conn().unwrap();
        let c2 = a.conn().unwrap();
        let n1: i64 = c1
            .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
            .unwrap();
        let n2: i64 = c2
            .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
            .unwrap();
        assert_eq!((n1, n2), (1, 1));
    }
}
