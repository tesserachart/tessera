use rusqlite::{OptionalExtension, Row, params};
use tessera_core::Timestamp;

use crate::Store;
use crate::error::Result;

#[derive(Clone, PartialEq, Eq)]
pub struct McpClientRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub token_hash: String,
    pub policy: String,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
}

impl std::fmt::Debug for McpClientRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClientRecord")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("policy", &self.policy)
            .field("created_at", &self.created_at)
            .field("last_used_at", &self.last_used_at)
            .field("revoked_at", &self.revoked_at)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct McpClientRepo<'a> {
    store: &'a Store,
}

const SELECT: &str = "SELECT client_id, name, kind, token_hash, policy, created_at, last_used_at, revoked_at \
                      FROM mcp_clients";

fn record(r: &Row<'_>) -> rusqlite::Result<McpClientRecord> {
    Ok(McpClientRecord {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        token_hash: r.get(3)?,
        policy: r.get(4)?,
        created_at: Timestamp(r.get(5)?),
        last_used_at: r.get::<_, Option<i64>>(6)?.map(Timestamp),
        revoked_at: r.get::<_, Option<i64>>(7)?.map(Timestamp),
    })
}

impl<'a> McpClientRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn active(&self) -> Result<Vec<McpClientRecord>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(&format!(
            "{SELECT} WHERE revoked_at IS NULL ORDER BY created_at, client_id"
        ))?;
        Ok(stmt
            .query_map([], record)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn ids(&self) -> Result<Vec<String>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT client_id FROM mcp_clients")?;
        Ok(stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get(&self, id: &str) -> Result<Option<McpClientRecord>> {
        Ok(self
            .store
            .conn()?
            .query_row(
                &format!("{SELECT} WHERE client_id = ?1"),
                params![id],
                record,
            )
            .optional()?)
    }

    pub fn insert(&self, c: &McpClientRecord) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO mcp_clients (client_id, name, kind, token_hash, policy, created_at, last_used_at, revoked_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                c.id,
                c.name,
                c.kind,
                c.token_hash,
                c.policy,
                c.created_at.0,
                c.last_used_at.map(|t| t.0),
                c.revoked_at.map(|t| t.0),
            ],
        )?;
        Ok(())
    }

    pub fn set_policy(&self, id: &str, policy: &str) -> Result<bool> {
        Ok(self.store.conn()?.execute(
            "UPDATE mcp_clients SET policy = ?2 WHERE client_id = ?1 AND revoked_at IS NULL",
            params![id, policy],
        )? > 0)
    }

    pub fn revoke(&self, id: &str, now: Timestamp) -> Result<bool> {
        Ok(self.store.conn()?.execute(
            "UPDATE mcp_clients SET revoked_at = ?2 WHERE client_id = ?1 AND revoked_at IS NULL",
            params![id, now.0],
        )? > 0)
    }

    pub fn touch(&self, id: &str, at: Timestamp) -> Result<()> {
        self.store.conn()?.execute(
            "UPDATE mcp_clients SET last_used_at = ?2 WHERE client_id = ?1",
            params![id, at.0],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(id: &str, hash: &str, at: i64) -> McpClientRecord {
        McpClientRecord {
            id: id.into(),
            name: "Claude Desktop".into(),
            kind: "claude-desktop".into(),
            token_hash: hash.into(),
            policy: "supervised".into(),
            created_at: Timestamp(at),
            last_used_at: None,
            revoked_at: None,
        }
    }

    #[test]
    fn clients_are_kept_revoked_and_never_reuse_an_id_or_a_token() {
        let store = Store::open_in_memory().unwrap();
        let repo = store.mcp_clients();
        repo.insert(&client("claude-desktop", "h1", 2)).unwrap();
        repo.insert(&client("cursor", "h2", 1)).unwrap();
        assert!(
            repo.insert(&client("claude-desktop", "h3", 3)).is_err(),
            "same id"
        );
        assert!(
            repo.insert(&client("codex", "h1", 3)).is_err(),
            "same token"
        );
        let ids: Vec<String> = repo.active().unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["cursor", "claude-desktop"], "oldest first");

        assert!(repo.set_policy("cursor", "read_only").unwrap());
        repo.touch("cursor", Timestamp(9)).unwrap();
        let c = repo.get("cursor").unwrap().unwrap();
        assert_eq!(
            (c.policy.as_str(), c.last_used_at),
            ("read_only", Some(Timestamp(9)))
        );
        assert!(!format!("{c:?}").contains("h2"), "no hash in debug output");

        assert!(repo.revoke("cursor", Timestamp(10)).unwrap());
        assert!(!repo.revoke("cursor", Timestamp(11)).unwrap(), "once");
        assert!(!repo.set_policy("cursor", "supervised").unwrap());
        let ids: Vec<String> = repo.active().unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["claude-desktop"]);
        let mut all = repo.ids().unwrap();
        all.sort();
        assert_eq!(
            all,
            ["claude-desktop", "cursor"],
            "a revoked id stays taken"
        );
        assert_eq!(
            repo.get("cursor").unwrap().unwrap().revoked_at,
            Some(Timestamp(10))
        );
    }
}
