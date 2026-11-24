use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::block::{compress, decompress};
use crate::error::Result;
use crate::local::{LocalDb, Setup};

const WHAT: &str = "a depth minute";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS depth_minutes (
    provider   TEXT    NOT NULL,
    instrument TEXT    NOT NULL,
    minute     INTEGER NOT NULL,
    data       BLOB    NOT NULL,
    PRIMARY KEY (provider, instrument, minute)
) WITHOUT ROWID;
";

const SETUP: Setup = Setup {
    before_wal: "",
    schema: |conn: &mut Connection| Ok(conn.execute_batch(SCHEMA)?),
};

#[derive(Debug)]
pub struct DepthStore {
    db: LocalDb,
}

impl DepthStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            db: LocalDb::open(path.as_ref(), &SETUP)?,
        })
    }

    pub fn open_in_dir(dir: impl AsRef<Path>) -> Result<Self> {
        Self::open(crate::DataDir::new(dir.as_ref()).depth())
    }

    pub fn open_in_memory() -> Result<Self> {
        Ok(Self {
            db: LocalDb::open_in_memory(&SETUP)?,
        })
    }

    pub fn put(&self, provider: &str, instrument: &str, minute: i64, data: &[u8]) -> Result<()> {
        let conn = self.db.lock();
        let held: Option<Vec<u8>> = conn
            .query_row(
                "SELECT data FROM depth_minutes WHERE provider = ?1 AND instrument = ?2 AND minute = ?3",
                params![provider, instrument, minute],
                |r| r.get(0),
            )
            .optional()?;
        let mut whole = match held {
            Some(z) => decompress(&z, WHAT)?,
            None => Vec::new(),
        };
        whole.extend_from_slice(data);
        let packed = compress(&whole, WHAT)?;
        conn.execute(
            "INSERT INTO depth_minutes (provider, instrument, minute, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (provider, instrument, minute) DO UPDATE SET data = excluded.data",
            params![provider, instrument, minute, packed],
        )?;
        Ok(())
    }

    pub fn get(
        &self,
        provider: &str,
        instrument: &str,
        from: i64,
        to: i64,
    ) -> Result<Vec<(i64, Vec<u8>)>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT minute, data FROM depth_minutes
             WHERE provider = ?1 AND instrument = ?2 AND minute >= ?3 AND minute < ?4
             ORDER BY minute",
        )?;
        let rows = stmt.query_map(params![provider, instrument, from, to], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (m, z) = row?;
            out.push((m, decompress(&z, WHAT)?));
        }
        Ok(out)
    }

    pub fn first(&self, provider: &str, instrument: &str) -> Result<Option<i64>> {
        Ok(self.db.lock().query_row(
            "SELECT MIN(minute) FROM depth_minutes WHERE provider = ?1 AND instrument = ?2",
            params![provider, instrument],
            |r| r.get(0),
        )?)
    }

    pub fn prune(&self, provider: &str, instrument: &str, before: i64) -> Result<usize> {
        Ok(self.db.lock().execute(
            "DELETE FROM depth_minutes WHERE provider = ?1 AND instrument = ?2 AND minute < ?3",
            params![provider, instrument, before],
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minutes_append_read_in_order_and_prune() {
        let d = DepthStore::open_in_memory().unwrap();
        d.put("rithmic", "ESZ6.CME", 120, b"two").unwrap();
        d.put("rithmic", "ESZ6.CME", 60, b"one").unwrap();
        d.put("rithmic", "ESZ6.CME", 60, b"+more").unwrap();
        d.put("feed", "ESZ6.CME", 60, b"other").unwrap();
        let got = d.get("rithmic", "ESZ6.CME", 0, 1_000).unwrap();
        assert_eq!(got, [(60, b"one+more".to_vec()), (120, b"two".to_vec())]);
        assert_eq!(d.get("rithmic", "ESZ6.CME", 61, 120).unwrap(), []);
        assert_eq!(d.first("rithmic", "ESZ6.CME").unwrap(), Some(60));
        assert_eq!(d.prune("rithmic", "ESZ6.CME", 120).unwrap(), 1);
        assert_eq!(d.first("rithmic", "ESZ6.CME").unwrap(), Some(120));
        assert_eq!(d.first("feed", "ESZ6.CME").unwrap(), Some(60));
        assert_eq!(d.first("x", "y").unwrap(), None);
    }

    #[test]
    fn a_file_archive_keeps_minutes_between_opens() {
        let dir = tempfile::tempdir().unwrap();
        DepthStore::open_in_dir(dir.path())
            .unwrap()
            .put("p", "i", 0, &[7; 4096])
            .unwrap();
        let d = DepthStore::open_in_dir(dir.path()).unwrap();
        assert_eq!(d.get("p", "i", 0, 1).unwrap(), [(0, vec![7; 4096])]);
    }
}
