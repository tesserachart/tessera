use rusqlite::{Connection, OptionalExtension, params};
use tessera_core::Timestamp;
use tessera_core::hash::sha256_hex;

use crate::error::{Result, StoreError};

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
    pub earlier_checksums: &'static [&'static str],
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init",
        sql: include_str!("../migrations/0001_init.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 2,
        name: "broker",
        sql: include_str!("../migrations/0002_broker.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 3,
        name: "documents",
        sql: include_str!("../migrations/0003_documents.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 4,
        name: "journal",
        sql: include_str!("../migrations/0004_journal.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 5,
        name: "custom_indicators",
        sql: include_str!("../migrations/0005_custom_indicators.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 6,
        name: "journal_activity",
        sql: include_str!("../migrations/0006_journal_activity.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 7,
        name: "level_history",
        sql: include_str!("../migrations/0007_level_history.sql"),
        earlier_checksums: &["f8d4680bb023a44315ec0ce188de7da729eea7394676b8fc66579c64ee44473f"],
    },
    Migration {
        version: 8,
        name: "journal_trash",
        sql: include_str!("../migrations/0008_journal_trash.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 9,
        name: "mcp_clients",
        sql: include_str!("../migrations/0009_mcp_clients.sql"),
        earlier_checksums: &[],
    },
    Migration {
        version: 10,
        name: "layout_saved",
        sql: include_str!("../migrations/0010_layout_saved.sql"),
        earlier_checksums: &[],
    },
];

pub fn latest_version() -> i64 {
    MIGRATIONS.last().map_or(0, |m| m.version)
}

pub fn migrate(conn: &mut Connection) -> Result<usize> {
    migrate_with(conn, MIGRATIONS)
}

pub fn migrate_with(conn: &mut Connection, migrations: &[Migration]) -> Result<usize> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            checksum   TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );",
    )?;
    let mut applied = 0;
    for m in migrations {
        let checksum = sha256_hex(m.sql.as_bytes());
        let existing: Option<String> = conn
            .query_row(
                "SELECT checksum FROM _migrations WHERE version = ?1",
                params![m.version],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(c) if c == checksum => continue,
            Some(c) if m.earlier_checksums.contains(&c.as_str()) => {
                conn.execute(
                    "UPDATE _migrations SET checksum = ?1 WHERE version = ?2",
                    params![checksum, m.version],
                )?;
                continue;
            }
            Some(_) => {
                return Err(StoreError::Migration {
                    version: m.version,
                    message: format!(
                        "applied migration {} ({}) was modified; add a new migration instead",
                        m.version, m.name
                    ),
                });
            }
            None => {}
        }
        let tx = conn.transaction()?;
        tx.execute_batch(m.sql).map_err(|e| StoreError::Migration {
            version: m.version,
            message: e.to_string(),
        })?;
        tx.execute(
            "INSERT INTO _migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            params![m.version, m.name, checksum, Timestamp::now().0],
        )?;
        tx.commit()?;
        applied += 1;
        tracing::info!(version = m.version, name = m.name, "applied migration");
    }
    Ok(applied)
}

pub fn current_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT coalesce(max(version), 0) FROM _migrations",
        [],
        |r| r.get(0),
    )?)
}
