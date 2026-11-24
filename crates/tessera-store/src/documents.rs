use std::marker::PhantomData;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tessera_core::Timestamp;

use crate::Store;
use crate::error::{Result, StoreError};

#[derive(Clone, Debug, PartialEq)]
pub struct Document {
    pub id: String,
    pub parent: Option<String>,
    pub body: Value,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, Copy)]
pub struct DocumentRepo<'a> {
    store: &'a Store,
    collection: &'a str,
}

impl<'a> DocumentRepo<'a> {
    pub(crate) fn new(store: &'a Store, collection: &'a str) -> Self {
        Self { store, collection }
    }

    pub fn put(&self, id: &str, parent: Option<&str>, body: &Value, now: Timestamp) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO documents (collection, id, parent, body, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (collection, id) DO UPDATE SET
               parent = excluded.parent, body = excluded.body, updated_at = excluded.updated_at",
            params![
                self.collection,
                id,
                parent,
                serde_json::to_string(body)?,
                now.0
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<Document>> {
        let row = self
            .store
            .conn()?
            .query_row(
                "SELECT id, parent, body, created_at, updated_at FROM documents
                 WHERE collection = ?1 AND id = ?2",
                params![self.collection, id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?;
        row.map(doc).transpose()
    }

    pub fn list(&self, parent: Option<&str>, limit: usize) -> Result<Vec<Document>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, parent, body, created_at, updated_at FROM documents
             WHERE collection = ?1 AND (?2 IS NULL OR parent = ?2)
             ORDER BY updated_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![self.collection, parent, limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        rows.map(|r| doc(r?)).collect()
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM documents WHERE collection = ?1 AND parent = ?2",
            params![self.collection, id],
        )?;
        let removed = tx.execute(
            "DELETE FROM documents WHERE collection = ?1 AND id = ?2",
            params![self.collection, id],
        )? > 0;
        tx.commit()?;
        Ok(removed)
    }

    pub fn delete_children(&self, parent: &str) -> Result<usize> {
        Ok(self.store.conn()?.execute(
            "DELETE FROM documents WHERE collection = ?1 AND parent = ?2",
            params![self.collection, parent],
        )?)
    }
}

fn body_of(conn: &Connection, collection: &str, id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT body FROM documents WHERE collection = ?1 AND id = ?2",
            params![collection, id],
            |r| r.get(0),
        )
        .optional()?)
}

#[derive(Debug)]
pub struct Docs<'a, T> {
    repo: DocumentRepo<'a>,
    kind: PhantomData<fn() -> T>,
}

impl<T> Clone for Docs<'_, T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Docs<'_, T> {}

impl<'a, T: Serialize + DeserializeOwned> Docs<'a, T> {
    pub(crate) fn new(store: &'a Store, collection: &'a str) -> Self {
        Self {
            repo: DocumentRepo::new(store, collection),
            kind: PhantomData,
        }
    }

    pub fn get(&self, id: &str) -> Result<Option<T>> {
        self.repo
            .get(id)?
            .map(|d| Ok(serde_json::from_value(d.body)?))
            .transpose()
    }

    pub fn put(&self, id: &str, parent: Option<&str>, value: &T, now: Timestamp) -> Result<()> {
        self.repo
            .put(id, parent, &serde_json::to_value(value)?, now)
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        self.repo.delete(id)
    }

    pub fn change<R, E: From<StoreError>>(
        &self,
        id: &str,
        now: Timestamp,
        f: impl FnOnce(&mut T) -> std::result::Result<R, E>,
    ) -> std::result::Result<Option<R>, E> {
        let mut conn = self.repo.store.conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::from)?;
        let Some(body) = body_of(&tx, self.repo.collection, id)? else {
            return Ok(None);
        };
        let before: Value = serde_json::from_str(&body).map_err(StoreError::from)?;
        let mut value: T = serde_json::from_value(before.clone()).map_err(StoreError::from)?;
        let out = f(&mut value)?;
        let after = serde_json::to_value(&value).map_err(StoreError::from)?;
        if after == before {
            return Ok(Some(out));
        }
        let body = serde_json::to_string(&after).map_err(StoreError::from)?;
        tx.execute(
            "UPDATE documents SET body = ?3, updated_at = ?4 WHERE collection = ?1 AND id = ?2",
            params![self.repo.collection, id, body, now.0],
        )
        .map_err(StoreError::from)?;
        tx.commit().map_err(StoreError::from)?;
        Ok(Some(out))
    }
}

fn doc(
    (id, parent, body, created, updated): (String, Option<String>, String, i64, i64),
) -> Result<Document> {
    Ok(Document {
        id,
        parent,
        body: serde_json::from_str(&body)?,
        created_at: Timestamp(created),
        updated_at: Timestamp(updated),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Serialize, Deserialize, Default)]
    struct Count {
        n: u32,
        note: String,
    }

    #[test]
    fn concurrent_changes_lose_no_update() {
        let store = Store::open_in_memory().unwrap();
        let docs = store.docs::<Count>("counts");
        docs.put("c", None, &Count::default(), Timestamp(0))
            .unwrap();
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..25 {
                        docs.change("c", Timestamp(1), |c| {
                            c.n += 1;
                            Ok::<_, StoreError>(())
                        })
                        .unwrap()
                        .unwrap();
                    }
                });
            }
        });
        assert_eq!(docs.get("c").unwrap().unwrap().n, 200);
    }

    #[test]
    fn a_change_applies_to_the_current_row_and_keeps_what_others_wrote() {
        let store = Store::open_in_memory().unwrap();
        let docs = store.docs::<Count>("counts");
        docs.put("c", None, &Count::default(), Timestamp(0))
            .unwrap();
        let stale = docs.get("c").unwrap().unwrap();
        docs.change("c", Timestamp(1), |c| {
            c.note = "paused".into();
            Ok::<_, StoreError>(())
        })
        .unwrap();
        docs.change("c", Timestamp(2), |c| {
            c.n = stale.n + 1;
            Ok::<_, StoreError>(())
        })
        .unwrap();
        let now = docs.get("c").unwrap().unwrap();
        assert_eq!((now.n, now.note.as_str()), (1, "paused"));
    }

    #[test]
    fn a_change_never_brings_back_a_deleted_row() {
        let store = Store::open_in_memory().unwrap();
        let docs = store.docs::<Count>("counts");
        docs.put("c", None, &Count::default(), Timestamp(0))
            .unwrap();
        assert!(docs.delete("c").unwrap());
        let changed = docs
            .change("c", Timestamp(1), |c| {
                c.n += 1;
                Ok::<_, StoreError>(())
            })
            .unwrap();
        assert!(changed.is_none());
        assert!(docs.get("c").unwrap().is_none());
    }

    #[test]
    fn a_change_that_changes_nothing_keeps_the_row_where_it_was() {
        let store = Store::open_in_memory().unwrap();
        let docs = store.docs::<Count>("counts");
        docs.put("c", None, &Count::default(), Timestamp(0))
            .unwrap();
        docs.change("c", Timestamp(9), |_| Ok::<_, StoreError>(()))
            .unwrap();
        let row = store.documents("counts").get("c").unwrap().unwrap();
        assert_eq!(row.updated_at, Timestamp(0));
    }

    #[test]
    fn a_refused_change_writes_nothing() {
        let store = Store::open_in_memory().unwrap();
        let docs = store.docs::<Count>("counts");
        docs.put("c", None, &Count::default(), Timestamp(0))
            .unwrap();
        let refused = docs.change("c", Timestamp(1), |c| {
            c.n = 9;
            Err::<(), _>(StoreError::Invalid("no".into()))
        });
        assert!(refused.is_err());
        assert_eq!(docs.get("c").unwrap().unwrap().n, 0);
    }

    #[test]
    fn records_round_trip_by_collection_and_parent() {
        let store = Store::open_in_memory().unwrap();
        let studies = store.documents("research.study");
        let runs = store.documents("research.run");
        studies
            .put("s1", None, &json!({"name": "ORB"}), Timestamp(1))
            .unwrap();
        studies
            .put("s1", None, &json!({"name": "ORB 2"}), Timestamp(5))
            .unwrap();
        let s = studies.get("s1").unwrap().unwrap();
        assert_eq!(s.body["name"], "ORB 2");
        assert_eq!((s.created_at, s.updated_at), (Timestamp(1), Timestamp(5)));
        runs.put("r1", Some("s1"), &json!({"n": 1}), Timestamp(2))
            .unwrap();
        runs.put("r2", Some("s1"), &json!({"n": 2}), Timestamp(3))
            .unwrap();
        runs.put("r3", Some("s2"), &json!({"n": 3}), Timestamp(4))
            .unwrap();
        let of_s1: Vec<_> = runs
            .list(Some("s1"), 10)
            .unwrap()
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(of_s1, ["r2", "r1"]);
        assert_eq!(runs.list(None, 10).unwrap().len(), 3);
        assert!(studies.get("r1").unwrap().is_none());
        assert_eq!(runs.delete_children("s1").unwrap(), 2);
        assert!(studies.delete("s1").unwrap());
        assert!(studies.get("s1").unwrap().is_none());
    }
}
