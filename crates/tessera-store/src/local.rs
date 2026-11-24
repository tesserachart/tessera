use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rusqlite::Connection;

use crate::error::{Result, io_err};

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct Setup {
    pub(crate) before_wal: &'static str,
    pub(crate) schema: fn(&mut Connection) -> Result<()>,
}

#[derive(Debug)]
pub(crate) struct LocalDb {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
}

impl LocalDb {
    pub(crate) fn open(path: &Path, setup: &Setup) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io_err(parent))?;
        }
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.execute_batch(setup.before_wal)?;
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.execute_batch("PRAGMA synchronous = NORMAL;")?;
        (setup.schema)(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: Some(path.to_owned()),
        })
    }

    pub(crate) fn open_in_memory(setup: &Setup) -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        (setup.schema)(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: None,
        })
    }

    pub(crate) fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(conn: &mut Connection) -> Result<()> {
        Ok(conn.execute_batch("CREATE TABLE IF NOT EXISTS t (x INTEGER);")?)
    }

    const SETUP: Setup = Setup {
        before_wal: "PRAGMA auto_vacuum = INCREMENTAL;",
        schema,
    };

    #[test]
    fn a_file_opens_in_wal_with_its_pragmas_and_a_poisoned_lock_still_answers() {
        let dir = tempfile::tempdir().unwrap();
        let db = std::sync::Arc::new(LocalDb::open(&dir.path().join("a/b.db"), &SETUP).unwrap());
        let mode: String = db
            .lock()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let vacuum: i64 = db
            .lock()
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vacuum, 2);
        let poisoner = db.clone();
        std::thread::spawn(move || {
            let _held = poisoner.lock();
            panic!("poison the lock");
        })
        .join()
        .unwrap_err();
        db.lock().execute("INSERT INTO t VALUES (1)", []).unwrap();
        assert_eq!(db.path(), Some(dir.path().join("a/b.db").as_path()));
    }
}
