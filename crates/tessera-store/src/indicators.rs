use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};
use serde_json::Value;
use tessera_core::Timestamp;

use crate::Store;
use crate::error::{Result, StoreError};

#[derive(Clone, Debug, PartialEq)]
pub struct CustomIndicatorRecord {
    pub id: String,
    pub name: String,
    pub latest: u32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub created_by: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CustomIndicatorVersion {
    pub id: String,
    pub version: u32,
    pub code: String,
    pub manifest: Value,
    pub note: Option<String>,
    pub created_at: Timestamp,
    pub created_by: String,
}

#[derive(Debug, Clone, Copy)]
pub struct CustomIndicatorRepo<'a> {
    store: &'a Store,
}

fn record(r: &Row<'_>) -> rusqlite::Result<CustomIndicatorRecord> {
    Ok(CustomIndicatorRecord {
        id: r.get(0)?,
        name: r.get(1)?,
        latest: r.get(2)?,
        created_at: Timestamp(r.get(3)?),
        updated_at: Timestamp(r.get(4)?),
        created_by: r.get(5)?,
    })
}

fn version(r: &Row<'_>) -> rusqlite::Result<(CustomIndicatorVersion, String)> {
    Ok((
        CustomIndicatorVersion {
            id: r.get(0)?,
            version: r.get(1)?,
            code: r.get(2)?,
            manifest: Value::Null,
            note: r.get(4)?,
            created_at: Timestamp(r.get(5)?),
            created_by: r.get(6)?,
        },
        r.get::<_, String>(3)?,
    ))
}

fn parsed((mut v, manifest): (CustomIndicatorVersion, String)) -> Result<CustomIndicatorVersion> {
    v.manifest = serde_json::from_str(&manifest)?;
    Ok(v)
}

const RECORD: &str =
    "SELECT indicator_id, name, latest, created_at, updated_at, created_by FROM custom_indicators";
const VERSION: &str = "SELECT indicator_id, version, code, manifest, note, created_at, created_by FROM custom_indicator_versions";

impl<'a> CustomIndicatorRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn list(&self) -> Result<Vec<(CustomIndicatorRecord, CustomIndicatorVersion)>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(&format!("{RECORD} ORDER BY created_at, indicator_id"))?;
        let records = stmt
            .query_map([], record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(records.len());
        for rec in records {
            let v = conn
                .query_row(
                    &format!("{VERSION} WHERE indicator_id = ?1 AND version = ?2"),
                    params![rec.id, rec.latest],
                    version,
                )
                .optional()?;
            if let Some(v) = v {
                out.push((rec, parsed(v)?));
            }
        }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Option<CustomIndicatorRecord>> {
        Ok(self
            .store
            .conn()?
            .query_row(
                &format!("{RECORD} WHERE indicator_id = ?1"),
                params![id],
                record,
            )
            .optional()?)
    }

    pub fn version(
        &self,
        id: &str,
        version_no: Option<u32>,
    ) -> Result<Option<CustomIndicatorVersion>> {
        let conn = self.store.conn()?;
        let v = match version_no {
            Some(n) => conn
                .query_row(
                    &format!("{VERSION} WHERE indicator_id = ?1 AND version = ?2"),
                    params![id, n],
                    version,
                )
                .optional()?,
            None => conn
                .query_row(
                    &format!(
                        "{VERSION} WHERE indicator_id = ?1 AND version = (SELECT latest FROM custom_indicators WHERE indicator_id = ?1)"
                    ),
                    params![id],
                    version,
                )
                .optional()?,
        };
        v.map(parsed).transpose()
    }

    pub fn versions(&self, id: &str) -> Result<Vec<CustomIndicatorVersion>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(&format!(
            "{VERSION} WHERE indicator_id = ?1 ORDER BY version DESC"
        ))?;
        let rows = stmt
            .query_map(params![id], version)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(parsed).collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        id: &str,
        name: &str,
        code: &str,
        manifest: &Value,
        note: Option<&str>,
        by: &str,
        at: Timestamp,
    ) -> Result<()> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO custom_indicators (indicator_id, name, latest, created_at, updated_at, created_by)
             VALUES (?1, ?2, 1, ?3, ?3, ?4)",
            params![id, name, at.0, by],
        )?;
        tx.execute(
            "INSERT INTO custom_indicator_versions (indicator_id, version, code, manifest, note, created_at, created_by)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6)",
            params![id, code, serde_json::to_string(manifest)?, note, at.0, by],
        )?;
        tx.commit()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_version(
        &self,
        id: &str,
        expected: Option<u32>,
        name: &str,
        code: &str,
        manifest: &Value,
        note: Option<&str>,
        by: &str,
        at: Timestamp,
    ) -> Result<Option<u32>> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let latest: Option<u32> = tx
            .query_row(
                "SELECT latest FROM custom_indicators WHERE indicator_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(latest) = latest else {
            return Ok(None);
        };
        if let Some(e) = expected
            && e != latest
        {
            return Err(StoreError::Conflict {
                expected: i64::from(e),
                actual: i64::from(latest),
            });
        }
        let next = latest + 1;
        tx.execute(
            "INSERT INTO custom_indicator_versions (indicator_id, version, code, manifest, note, created_at, created_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, next, code, serde_json::to_string(manifest)?, note, at.0, by],
        )?;
        tx.execute(
            "UPDATE custom_indicators SET latest = ?2, name = ?3, updated_at = ?4 WHERE indicator_id = ?1",
            params![id, next, name, at.0],
        )?;
        tx.commit()?;
        Ok(Some(next))
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        let n = self.store.conn()?.execute(
            "DELETE FROM custom_indicators WHERE indicator_id = ?1",
            params![id],
        )?;
        Ok(n > 0)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn versions_are_kept_and_deleted_together() {
        let store = Store::open_in_memory().unwrap();
        let repo = store.custom_indicators();
        repo.create(
            "ci_1",
            "EMA cross",
            "v1",
            &json!({"title": "EMA cross"}),
            None,
            "user",
            Timestamp(1),
        )
        .unwrap();
        assert_eq!(
            repo.add_version(
                "ci_1",
                Some(1),
                "EMA cross 2",
                "v2",
                &json!({}),
                Some("faster"),
                "agent:s1",
                Timestamp(2)
            )
            .unwrap(),
            Some(2)
        );
        assert!(matches!(
            repo.add_version(
                "ci_1",
                Some(1),
                "x",
                "v3",
                &json!({}),
                None,
                "user",
                Timestamp(3)
            ),
            Err(StoreError::Conflict {
                expected: 1,
                actual: 2
            })
        ));
        assert_eq!(
            repo.add_version(
                "nope",
                None,
                "x",
                "v",
                &json!({}),
                None,
                "user",
                Timestamp(3)
            )
            .unwrap(),
            None
        );
        let list = repo.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].0.name, "EMA cross 2");
        assert_eq!(list[0].1.code, "v2");
        assert_eq!(
            repo.version("ci_1", Some(1)).unwrap().unwrap().manifest["title"],
            "EMA cross"
        );
        assert_eq!(
            repo.version("ci_1", None).unwrap().unwrap().note.as_deref(),
            Some("faster")
        );
        assert_eq!(repo.versions("ci_1").unwrap().len(), 2);
        assert!(repo.delete("ci_1").unwrap());
        assert!(
            repo.versions("ci_1").unwrap().is_empty(),
            "versions go with it"
        );
        assert!(!repo.delete("ci_1").unwrap());
    }
}
