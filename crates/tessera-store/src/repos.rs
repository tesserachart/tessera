use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::Timestamp;
use tessera_core::ids::NoteId;
use tessera_core::orders::{Fill, Order, Position};
use tessera_protocol::agent::{AgentEventEnvelope, AgentSessionSummary};
use tessera_protocol::layout::Layout;
use tessera_protocol::tools::{Approval, DraftInfo, ToolCallRecord};

use crate::Store;
use crate::error::{Result, StoreError};

fn to_json<T: Serialize>(v: &T) -> Result<String> {
    Ok(serde_json::to_string(v)?)
}

fn from_json<T: DeserializeOwned>(s: &str) -> Result<T> {
    Ok(serde_json::from_str(s)?)
}

fn enum_str<T: Serialize>(v: &T) -> Result<String> {
    Ok(match serde_json::to_value(v)? {
        Value::String(s) => s,
        other => other.to_string(),
    })
}

fn collect<T>(rows: impl Iterator<Item = rusqlite::Result<String>>) -> Result<Vec<T>>
where
    T: DeserializeOwned,
{
    rows.map(|r| from_json(&r?)).collect()
}

#[derive(Debug, Clone, Copy)]
pub struct ToolCallRepo<'a> {
    store: &'a Store,
}

impl<'a> ToolCallRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn upsert(&self, rec: &ToolCallRecord) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT OR REPLACE INTO tool_calls (call_id, tool, risk, origin_kind, origin, session_id,
                input_hash, input, status, started_at, finished_at, duration_ms, error, approval_id,
                approved_by, deduped, idempotency_key, summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                rec.call_id.as_str(),
                rec.tool,
                enum_str(&rec.risk)?,
                rec.origin.kind_str(),
                to_json(&rec.origin)?,
                rec.session_id.as_ref().map(|s| s.as_str()),
                rec.input_hash,
                to_json(&rec.input)?,
                enum_str(&rec.status)?,
                rec.started_at.0,
                rec.finished_at.map(|t| t.0),
                rec.duration_ms,
                rec.error.as_ref().map(to_json).transpose()?,
                rec.approval_id.as_ref().map(|s| s.as_str()),
                rec.approved_by.as_ref().map(|s| s.as_str()),
                rec.deduped,
                rec.idempotency_key,
                rec.summary,
            ],
        )?;
        Ok(())
    }

    fn row_to_record(r: &Row<'_>) -> rusqlite::Result<RawCall> {
        Ok(RawCall {
            call_id: r.get(0)?,
            tool: r.get(1)?,
            risk: r.get(2)?,
            origin: r.get(3)?,
            session_id: r.get(4)?,
            input_hash: r.get(5)?,
            input: r.get(6)?,
            status: r.get(7)?,
            started_at: r.get(8)?,
            finished_at: r.get(9)?,
            duration_ms: r.get(10)?,
            error: r.get(11)?,
            approval_id: r.get(12)?,
            approved_by: r.get(13)?,
            deduped: r.get(14)?,
            idempotency_key: r.get(15)?,
            summary: r.get(16)?,
        })
    }

    const COLUMNS: &'static str = "call_id, tool, risk, origin, session_id, input_hash, input, \
        status, started_at, finished_at, duration_ms, error, approval_id, approved_by, deduped, \
        idempotency_key, summary";

    pub fn get(&self, call_id: &str) -> Result<Option<ToolCallRecord>> {
        let conn = self.store.conn()?;
        let raw = conn
            .query_row(
                &format!(
                    "SELECT {} FROM tool_calls WHERE call_id = ?1",
                    Self::COLUMNS
                ),
                params![call_id],
                Self::row_to_record,
            )
            .optional()?;
        raw.map(RawCall::into_record).transpose()
    }

    pub fn recent(&self, limit: u32, session_id: Option<&str>) -> Result<Vec<ToolCallRecord>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM tool_calls WHERE (?1 IS NULL OR session_id = ?1)
             ORDER BY started_at DESC, call_id DESC LIMIT ?2",
            Self::COLUMNS
        ))?;
        let rows = stmt.query_map(params![session_id, limit], Self::row_to_record)?;
        rows.map(|r| r?.into_record()).collect()
    }

    pub fn recent_of(&self, tools: &[&str], limit: u32) -> Result<Vec<ToolCallRecord>> {
        if tools.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.store.conn()?;
        let marks = vec!["?"; tools.len()].join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM tool_calls WHERE tool IN ({marks})
             ORDER BY started_at DESC, call_id DESC LIMIT {limit}",
            Self::COLUMNS
        ))?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(tools.iter()),
            Self::row_to_record,
        )?;
        rows.map(|r| r?.into_record()).collect()
    }

    pub fn count(&self) -> Result<i64> {
        Ok(self
            .store
            .conn()?
            .query_row("SELECT count(*) FROM tool_calls", [], |r| r.get(0))?)
    }
}

struct RawCall {
    call_id: String,
    tool: String,
    risk: String,
    origin: String,
    session_id: Option<String>,
    input_hash: String,
    input: String,
    status: String,
    started_at: i64,
    finished_at: Option<i64>,
    duration_ms: Option<f64>,
    error: Option<String>,
    approval_id: Option<String>,
    approved_by: Option<String>,
    deduped: bool,
    idempotency_key: Option<String>,
    summary: Option<String>,
}

impl RawCall {
    fn into_record(self) -> Result<ToolCallRecord> {
        Ok(ToolCallRecord {
            call_id: self.call_id.into(),
            tool: self.tool,
            risk: serde_json::from_value(Value::String(self.risk))?,
            origin: from_json(&self.origin)?,
            session_id: self.session_id.map(Into::into),
            input_hash: self.input_hash,
            input: from_json(&self.input)?,
            status: serde_json::from_value(Value::String(self.status))?,
            started_at: Timestamp(self.started_at),
            finished_at: self.finished_at.map(Timestamp),
            duration_ms: self.duration_ms,
            error: self.error.as_deref().map(from_json).transpose()?,
            approval_id: self.approval_id.map(Into::into),
            deduped: self.deduped,
            idempotency_key: self.idempotency_key,
            summary: self.summary,
            approved_by: self.approved_by.map(Into::into),
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ApprovalRepo<'a> {
    store: &'a Store,
}

impl<'a> ApprovalRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn upsert(&self, a: &Approval, now: Timestamp) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO approvals (approval_id, kind, status, tool, session_id, draft_id,
                created_at, stale_at, updated_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (approval_id) DO UPDATE SET status = excluded.status,
                updated_at = excluded.updated_at, body = excluded.body",
            params![
                a.id.as_str(),
                enum_str(&a.kind)?,
                enum_str(&a.status)?,
                a.tool,
                a.session_id.as_ref().map(|s| s.as_str()),
                a.draft_id.as_ref().map(|s| s.as_str()),
                a.created_at.0,
                a.stale_at.0,
                now.0,
                to_json(a)?,
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<Approval>> {
        let conn = self.store.conn()?;
        let body: Option<String> = conn
            .query_row(
                "SELECT body FROM approvals WHERE approval_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        body.as_deref().map(from_json).transpose()
    }

    pub fn pending(&self) -> Result<Vec<Approval>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT body FROM approvals WHERE status = 'pending' ORDER BY created_at, approval_id",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        collect(rows)
    }

    pub fn recent(&self, limit: u32) -> Result<Vec<Approval>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT body FROM approvals ORDER BY created_at DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit], |r| r.get::<_, String>(0))?;
        collect(rows)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct DraftRepo<'a> {
    store: &'a Store,
}

impl<'a> DraftRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn upsert(&self, d: &DraftInfo, now: Timestamp) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO drafts (draft_id, approval_id, account, instrument, tool, live,
                created_at, updated_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (draft_id) DO UPDATE SET approval_id = excluded.approval_id,
                account = excluded.account, instrument = excluded.instrument,
                live = excluded.live, updated_at = excluded.updated_at, body = excluded.body",
            params![
                d.draft_id.as_str(),
                d.approval_id.as_str(),
                d.account,
                d.instrument.as_ref().map(|i| i.as_str()),
                d.tool,
                d.live,
                d.created_at.0,
                now.0,
                to_json(d)?,
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<DraftInfo>> {
        let body: Option<String> = self
            .store
            .conn()?
            .query_row(
                "SELECT body FROM drafts WHERE draft_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        body.as_deref().map(from_json).transpose()
    }

    pub fn live(&self, account: Option<&str>) -> Result<Vec<DraftInfo>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT body FROM drafts WHERE live = 1 AND (?1 IS NULL OR account = ?1)
             ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![account], |r| r.get::<_, String>(0))?;
        collect(rows)
    }
}

#[derive(Debug, Clone, Default)]
pub struct BrokerBatch {
    pub accounts: Vec<(String, Value)>,
    pub orders: Vec<Order>,
    pub fills: Vec<Fill>,
    pub positions: Vec<Position>,
}

impl BrokerBatch {
    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
            && self.orders.is_empty()
            && self.fills.is_empty()
            && self.positions.is_empty()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BrokerRepo<'a> {
    store: &'a Store,
    connection: &'a str,
}

impl<'a> BrokerRepo<'a> {
    pub(crate) fn new(store: &'a Store, connection: &'a str) -> Self {
        Self { store, connection }
    }

    pub fn apply(&self, batch: &BrokerBatch, now: Timestamp) -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        {
            let mut acct = tx.prepare_cached(
                "INSERT INTO broker_accounts (connection, account_id, updated_at, body)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (connection, account_id) DO UPDATE SET
                    updated_at = excluded.updated_at, body = excluded.body",
            )?;
            for (id, body) in &batch.accounts {
                acct.execute(params![self.connection, id, now.0, to_json(body)?])?;
            }
            let mut order = tx.prepare_cached(
                "INSERT OR REPLACE INTO orders (order_id, connection, account_id, instrument,
                    status, open, draft_id, created_at, updated_at, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for o in &batch.orders {
                order.execute(params![
                    o.id.as_str(),
                    self.connection,
                    o.request.account_id.as_str(),
                    o.request.instrument.as_str(),
                    enum_str(&o.status)?,
                    o.status.is_open(),
                    o.draft_id.as_ref().map(|d| d.as_str()),
                    o.created_at.0,
                    o.updated_at.0,
                    to_json(o)?,
                ])?;
            }
            let mut fill = tx.prepare_cached(
                "INSERT OR REPLACE INTO fills (fill_id, connection, account_id, order_id,
                    instrument, ts, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for f in &batch.fills {
                fill.execute(params![
                    f.id.as_str(),
                    self.connection,
                    f.account_id.as_str(),
                    f.order_id.as_ref().map(|o| o.as_str()),
                    f.instrument.as_str(),
                    f.ts.0,
                    to_json(f)?,
                ])?;
            }
            let mut put = tx.prepare_cached(
                "INSERT OR REPLACE INTO positions (connection, account_id, instrument, updated_at,
                    body)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            let mut delete = tx.prepare_cached(
                "DELETE FROM positions WHERE connection = ?1 AND account_id = ?2 AND instrument = ?3",
            )?;
            for p in &batch.positions {
                if p.qty.is_zero() {
                    delete.execute(params![
                        self.connection,
                        p.account_id.as_str(),
                        p.instrument.as_str()
                    ])?;
                } else {
                    put.execute(params![
                        self.connection,
                        p.account_id.as_str(),
                        p.instrument.as_str(),
                        now.0,
                        to_json(p)?,
                    ])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn accounts(&self) -> Result<Vec<Value>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT body FROM broker_accounts WHERE connection = ?1 ORDER BY account_id",
        )?;
        let rows = stmt.query_map(params![self.connection], |r| r.get::<_, String>(0))?;
        collect(rows)
    }

    pub fn orders(&self, since: Timestamp) -> Result<Vec<Order>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT body FROM orders WHERE connection = ?1 AND (open = 1 OR updated_at >= ?2)
             ORDER BY created_at, order_id",
        )?;
        let rows = stmt.query_map(params![self.connection, since.0], |r| r.get::<_, String>(0))?;
        collect(rows)
    }

    pub fn fills(&self, account: Option<&str>, since: Timestamp) -> Result<Vec<Fill>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT body FROM fills WHERE connection = ?1 AND (?2 IS NULL OR account_id = ?2)
                AND ts >= ?3
             ORDER BY ts, fill_id",
        )?;
        let rows = stmt.query_map(params![self.connection, account, since.0], |r| {
            r.get::<_, String>(0)
        })?;
        collect(rows)
    }

    pub fn positions(&self) -> Result<Vec<Position>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT body FROM positions WHERE connection = ?1 ORDER BY account_id, instrument",
        )?;
        let rows = stmt.query_map(params![self.connection], |r| r.get::<_, String>(0))?;
        collect(rows)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SessionRepo<'a> {
    store: &'a Store,
}

impl<'a> SessionRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn upsert(&self, s: &AgentSessionSummary) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO sessions (session_id, title, preset, provider, model, mode, status,
                created_at, updated_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (session_id) DO UPDATE SET title = excluded.title,
                preset = excluded.preset, provider = excluded.provider, model = excluded.model,
                mode = excluded.mode, status = excluded.status,
                updated_at = excluded.updated_at, body = excluded.body",
            params![
                s.id.as_str(),
                s.title,
                s.preset,
                s.provider,
                s.model,
                enum_str(&s.mode)?,
                enum_str(&s.status)?,
                s.created_at.0,
                s.updated_at.0,
                to_json(s)?,
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<AgentSessionSummary>> {
        let body: Option<String> = self
            .store
            .conn()?
            .query_row(
                "SELECT body FROM sessions WHERE session_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        body.as_deref().map(from_json).transpose()
    }

    pub fn list(&self) -> Result<Vec<AgentSessionSummary>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT body FROM sessions ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        collect(rows)
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        Ok(self
            .store
            .conn()?
            .execute("DELETE FROM sessions WHERE session_id = ?1", params![id])?
            > 0)
    }
}

fn last_seq(tx: &rusqlite::Transaction<'_>, session_id: &str) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT coalesce(max(seq), 0) FROM agent_events WHERE session_id = ?1",
        params![session_id],
        |r| r.get(0),
    )?)
}

fn insert_event(tx: &rusqlite::Transaction<'_>, e: &AgentEventEnvelope) -> Result<()> {
    tx.execute(
        "INSERT INTO agent_events (session_id, seq, ts, turn_id, type, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            e.session_id.as_str(),
            e.seq as i64,
            e.ts.0,
            e.turn_id,
            e.event.type_name(),
            to_json(e)?,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub struct AgentEventRepo<'a> {
    store: &'a Store,
}

impl<'a> AgentEventRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn next_seq(&self, session_id: &str) -> Result<u64> {
        let max: i64 = self.store.conn()?.query_row(
            "SELECT coalesce(max(seq), 0) FROM agent_events WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        Ok(max as u64 + 1)
    }

    pub fn append(&self, e: &AgentEventEnvelope) -> Result<()> {
        let mut conn = self.store.conn()?;
        // SQLite: a deferred read-then-write transaction fails at once if another connection wrote.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let max = last_seq(&tx, e.session_id.as_str())?;
        let expected = max + 1;
        if e.seq as i64 != expected {
            return Err(StoreError::Conflict {
                expected,
                actual: e.seq as i64,
            });
        }
        insert_event(&tx, e)?;
        tx.commit()?;
        Ok(())
    }

    pub fn append_missing(&self, session_id: &str, events: &[AgentEventEnvelope]) -> Result<u64> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut last = last_seq(&tx, session_id)?;
        let stored = last;
        for e in events.iter().filter(|e| e.seq as i64 > stored) {
            if e.seq as i64 != last + 1 || e.session_id.as_str() != session_id {
                return Err(StoreError::Conflict {
                    expected: last + 1,
                    actual: e.seq as i64,
                });
            }
            insert_event(&tx, e)?;
            last = e.seq as i64;
        }
        tx.commit()?;
        Ok(last as u64)
    }

    pub fn list(
        &self,
        session_id: &str,
        after_seq: u64,
        limit: u32,
    ) -> Result<Vec<AgentEventEnvelope>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT body FROM agent_events WHERE session_id = ?1 AND seq > ?2
             ORDER BY seq LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, after_seq as i64, limit], |r| {
            r.get::<_, String>(0)
        })?;
        collect(rows)
    }
}

#[derive(Debug)]
pub struct Kept<T> {
    key: &'static str,
    kind: std::marker::PhantomData<fn() -> T>,
}

impl<T> Kept<T> {
    pub const fn new(key: &'static str) -> Self {
        Self {
            key,
            kind: std::marker::PhantomData,
        }
    }

    pub const fn key(&self) -> &'static str {
        self.key
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SettingsRepo<'a> {
    store: &'a Store,
}

impl<'a> SettingsRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn get(&self, key: &str) -> Result<Option<Value>> {
        let v: Option<String> = self
            .store
            .conn()?
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        v.as_deref().map(from_json).transpose()
    }

    pub fn set(&self, key: &str, value: &Value, now: Timestamp) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, to_json(value)?, now.0],
        )?;
        Ok(())
    }

    pub fn load<T: DeserializeOwned>(&self, kept: &Kept<T>) -> Result<Option<T>> {
        self.get(kept.key)?
            .map(|v| Ok(serde_json::from_value(v)?))
            .transpose()
    }

    pub fn keep<T: Serialize>(&self, kept: &Kept<T>, value: &T, now: Timestamp) -> Result<()> {
        self.set(kept.key, &serde_json::to_value(value)?, now)
    }

    pub fn update<T, R, E>(
        &self,
        kept: &Kept<T>,
        now: Timestamp,
        f: impl FnOnce(&mut T) -> std::result::Result<R, E>,
    ) -> std::result::Result<R, E>
    where
        T: Serialize + DeserializeOwned + Default,
        E: From<StoreError>,
    {
        let mut conn = self.store.conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::from)?;
        let stored: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![kept.key],
                |r| r.get(0),
            )
            .optional()
            .map_err(StoreError::from)?;
        let mut value: T = match stored {
            Some(s) => from_json(&s)?,
            None => T::default(),
        };
        let out = f(&mut value)?;
        tx.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![kept.key, to_json(&value)?, now.0],
        )
        .map_err(StoreError::from)?;
        tx.commit().map_err(StoreError::from)?;
        Ok(out)
    }

    pub fn all(&self) -> Result<BTreeMap<String, Value>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.map(|r| {
            let (k, v) = r?;
            Ok((k, from_json(&v)?))
        })
        .collect()
    }

    pub fn delete(&self, key: &str) -> Result<bool> {
        Ok(self
            .store
            .conn()?
            .execute("DELETE FROM settings WHERE key = ?1", params![key])?
            > 0)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LayoutRepo<'a> {
    store: &'a Store,
}

impl<'a> LayoutRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn get(&self, id: &str) -> Result<Option<Layout>> {
        let body: Option<String> = self
            .store
            .conn()?
            .query_row(
                "SELECT body FROM layouts WHERE layout_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        body.as_deref().map(from_json).transpose()
    }

    pub fn saved(&self, id: &str) -> Result<Option<Layout>> {
        let body: Option<Option<String>> = self
            .store
            .conn()?
            .query_row(
                "SELECT saved FROM layouts WHERE layout_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        body.flatten().as_deref().map(from_json).transpose()
    }

    pub fn put(&self, layout: &Layout, saved: Option<&Layout>) -> Result<()> {
        let saved = saved.map(to_json).transpose()?;
        self.store.conn()?.execute(
            "INSERT INTO layouts (layout_id, name, revision, updated_at, body, saved)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (layout_id) DO UPDATE SET name = excluded.name,
                revision = excluded.revision, updated_at = excluded.updated_at, body = excluded.body,
                saved = excluded.saved",
            params![
                layout.id,
                layout.name,
                layout.revision as i64,
                layout.updated_at.0,
                to_json(layout)?,
                saved,
            ],
        )?;
        Ok(())
    }

    pub fn put_if_revision(&self, layout: &Layout, expected: u64) -> Result<()> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = tx
            .query_row(
                "SELECT revision FROM layouts WHERE layout_id = ?1",
                params![layout.id],
                |r| r.get(0),
            )
            .optional()?;
        let actual = current.unwrap_or(0);
        if actual != expected as i64 {
            return Err(StoreError::Conflict {
                expected: expected as i64,
                actual,
            });
        }
        tx.execute(
            "INSERT INTO layouts (layout_id, name, revision, updated_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (layout_id) DO UPDATE SET name = excluded.name,
                revision = excluded.revision, updated_at = excluded.updated_at, body = excluded.body",
            params![
                layout.id,
                layout.name,
                layout.revision as i64,
                layout.updated_at.0,
                to_json(layout)?,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        Ok(self
            .store
            .conn()?
            .execute("DELETE FROM layouts WHERE layout_id = ?1", params![id])?
            > 0)
    }

    pub fn list(&self) -> Result<Vec<(String, String, u64)>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT layout_id, name, revision FROM layouts ORDER BY layout_id")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)? as u64,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: NoteId,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub instrument: Option<String>,
    pub session_id: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, Copy)]
pub struct NoteRepo<'a> {
    store: &'a Store,
}

impl<'a> NoteRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(
        &self,
        title: &str,
        body: &str,
        tags: &[String],
        instrument: Option<&str>,
        session_id: Option<&str>,
        now: Timestamp,
    ) -> Result<Note> {
        let note = Note {
            id: NoteId::generate(),
            title: title.to_owned(),
            body: body.to_owned(),
            tags: tags.to_vec(),
            instrument: instrument.map(str::to_owned),
            session_id: session_id.map(str::to_owned),
            created_at: now,
            updated_at: now,
        };
        self.store.conn()?.execute(
            "INSERT INTO notes (note_id, title, body, tags, instrument, session_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                note.id.as_str(),
                note.title,
                note.body,
                to_json(&note.tags)?,
                note.instrument,
                note.session_id,
                now.0,
                now.0
            ],
        )?;
        Ok(note)
    }

    fn row(r: &Row<'_>) -> rusqlite::Result<(Note, String)> {
        Ok((
            Note {
                id: NoteId::new(r.get::<_, String>(0)?),
                title: r.get(1)?,
                body: r.get(2)?,
                tags: Vec::new(),
                instrument: r.get(4)?,
                session_id: r.get(5)?,
                created_at: Timestamp(r.get(6)?),
                updated_at: Timestamp(r.get(7)?),
            },
            r.get::<_, String>(3)?,
        ))
    }

    pub fn get(&self, id: &str) -> Result<Option<Note>> {
        let row = self
            .store
            .conn()?
            .query_row(
                "SELECT note_id, title, body, tags, instrument, session_id, created_at, updated_at
                 FROM notes WHERE note_id = ?1",
                params![id],
                Self::row,
            )
            .optional()?;
        row.map(|(mut n, tags)| {
            n.tags = from_json(&tags)?;
            Ok(n)
        })
        .transpose()
    }

    pub fn update(&self, id: &str, title: &str, body: &str, now: Timestamp) -> Result<()> {
        let n = self.store.conn()?.execute(
            "UPDATE notes SET title = ?2, body = ?3, updated_at = ?4 WHERE note_id = ?1",
            params![id, title, body, now.0],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(format!("note {id}")));
        }
        Ok(())
    }

    pub fn list(&self, limit: u32) -> Result<Vec<Note>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT note_id, title, body, tags, instrument, session_id, created_at, updated_at
             FROM notes ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], Self::row)?;
        rows.map(|r| {
            let (mut n, tags) = r?;
            n.tags = from_json(&tags)?;
            Ok(n)
        })
        .collect()
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        Ok(self
            .store
            .conn()?
            .execute("DELETE FROM notes WHERE note_id = ?1", params![id])?
            > 0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: String,
    pub ref_id: String,
    pub title: String,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct SearchRepo<'a> {
    store: &'a Store,
}

impl<'a> SearchRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn index(&self, kind: &str, ref_id: &str, title: &str, body: &str) -> Result<()> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM search_fts WHERE kind = ?1 AND ref_id = ?2",
            params![kind, ref_id],
        )?;
        tx.execute(
            "INSERT INTO search_fts (kind, ref_id, title, body) VALUES (?1, ?2, ?3, ?4)",
            params![kind, ref_id, title, body],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn search(&self, query: &str, kind: Option<&str>, limit: u32) -> Result<Vec<SearchHit>> {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let fts_query = terms.join(" ");
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT kind, ref_id, title, snippet(search_fts, 3, '[', ']', '…', 12), rank
             FROM search_fts WHERE search_fts MATCH ?1 AND (?2 IS NULL OR kind = ?2)
             ORDER BY rank LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![fts_query, kind, limit], |r| {
            Ok(SearchHit {
                kind: r.get(0)?,
                ref_id: r.get(1)?,
                title: r.get(2)?,
                snippet: r.get(3)?,
                rank: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_setting_updates_lose_no_update() {
        const LIST: Kept<Vec<u32>> = Kept::new("test.list");
        let store = Store::open_in_memory().unwrap();
        let settings = store.settings();
        std::thread::scope(|s| {
            for t in 0..8 {
                s.spawn(move || {
                    for i in 0..10 {
                        settings
                            .update(&LIST, Timestamp(1), |l| {
                                l.push(t * 100 + i);
                                Ok::<_, StoreError>(())
                            })
                            .unwrap();
                    }
                });
            }
        });
        assert_eq!(settings.load(&LIST).unwrap().unwrap().len(), 80);
    }

    #[test]
    fn an_unreadable_setting_is_refused_not_overwritten() {
        const LIST: Kept<Vec<u32>> = Kept::new("test.list");
        let store = Store::open_in_memory().unwrap();
        let settings = store.settings();
        settings
            .set(LIST.key(), &serde_json::json!("not a list"), Timestamp(0))
            .unwrap();
        let r = settings.update(&LIST, Timestamp(1), |l| {
            l.push(1);
            Ok::<_, StoreError>(())
        });
        assert!(r.is_err());
        assert_eq!(
            settings.get(LIST.key()).unwrap(),
            Some(serde_json::json!("not a list"))
        );
    }
    use serde_json::json;
    use tessera_core::ids::{ApprovalId, CallId, DraftId, SessionId};
    use tessera_core::orders::DraftStatus;
    use tessera_core::{InstrumentId, Origin};
    use tessera_protocol::agent::{AgentEvent, AgentSessionStatus};
    use tessera_protocol::tools::{
        ApprovalKind, ApprovalStatus, RiskTier, SessionMode, ToolCallStatus, ToolErrorCode,
        ToolErrorInfo,
    };

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    fn record(id: &str, t: i64, session: Option<&str>) -> ToolCallRecord {
        ToolCallRecord {
            call_id: CallId::new(id),
            tool: "market.get_quote".into(),
            risk: RiskTier::Read,
            origin: match session {
                Some(s) => Origin::Agent {
                    session_id: SessionId::new(s),
                    provider: "codex".into(),
                },
                None => Origin::User,
            },
            session_id: session.map(SessionId::new),
            input_hash: "abc".into(),
            input: json!({"instrument": "QQQ"}),
            status: ToolCallStatus::Error,
            started_at: Timestamp(t),
            finished_at: Some(Timestamp(t + 5)),
            duration_ms: Some(0.005),
            error: Some(ToolErrorInfo {
                code: ToolErrorCode::NotFound,
                message: "x".into(),
                details: None,
                retryable: false,
            }),
            approval_id: None,
            deduped: false,
            idempotency_key: Some("k".into()),
            summary: None,
            approved_by: None,
        }
    }

    #[test]
    fn tool_calls_round_trip() {
        let s = store();
        let repo = s.tool_calls();
        repo.upsert(&record("call_1", 10, None)).unwrap();
        repo.upsert(&record("call_2", 20, Some("S1"))).unwrap();
        let mut r3 = record("call_3", 30, Some("S1"));
        repo.upsert(&r3).unwrap();
        r3.status = ToolCallStatus::Ok;
        r3.error = None;
        repo.upsert(&r3).unwrap();
        assert_eq!(repo.count().unwrap(), 3);
        assert_eq!(repo.get("call_3").unwrap().unwrap(), r3);
        assert_eq!(
            repo.get("call_1").unwrap().unwrap(),
            record("call_1", 10, None)
        );
        let recent: Vec<_> = repo
            .recent(10, None)
            .unwrap()
            .into_iter()
            .map(|r| r.call_id.0)
            .collect();
        assert_eq!(recent, vec!["call_3", "call_2", "call_1"]);
        assert_eq!(repo.recent(10, Some("S1")).unwrap().len(), 2);
        assert!(repo.get("nope").unwrap().is_none());
    }

    #[test]
    fn the_newest_calls_of_some_tools_include_the_failed_ones() {
        let s = store();
        let repo = s.tool_calls();
        for (id, at, tool) in [
            ("call_1", 10, "orders.submit"),
            ("call_2", 20, "market.get_candles"),
            ("call_3", 30, "orders.protect"),
            ("call_4", 40, "orders.submit"),
        ] {
            let mut r = record(id, at, None);
            r.tool = tool.into();
            repo.upsert(&r).unwrap();
        }
        let ids = |limit| -> Vec<String> {
            repo.recent_of(&["orders.submit", "orders.protect"], limit)
                .unwrap()
                .into_iter()
                .map(|r| r.call_id.0)
                .collect()
        };
        assert_eq!(ids(10), ["call_4", "call_3", "call_1"]);
        assert_eq!(ids(2), ["call_4", "call_3"]);
        assert!(repo.recent_of(&[], 10).unwrap().is_empty());
        assert_eq!(
            repo.recent_of(&["orders.submit"], 1).unwrap()[0].status,
            ToolCallStatus::Error
        );
    }

    fn approval(id: &str, status: ApprovalStatus, t: i64) -> Approval {
        Approval {
            id: ApprovalId::new(id),
            kind: ApprovalKind::Financial,
            status,
            origin: Origin::User,
            session_id: None,
            call_id: CallId::new("call_1"),
            tool: "orders.submit".into(),
            risk: RiskTier::Financial,
            input: json!({}),
            preview: json!({}),
            preview_hash: "h".into(),
            draft_id: Some(DraftId::new("d_1")),
            environment: None,
            instrument: Some(InstrumentId::new("QQQ").unwrap()),
            created_at: Timestamp(t),
            stale_at: Timestamp(t + 60),
            max_ticks: None,
            ticks_seen: 0,
            resolution: None,
            replaced_by: None,
            replaces: None,
        }
    }

    #[test]
    fn approvals_and_drafts() {
        let s = store();
        let a = s.approvals();
        a.upsert(&approval("apr_1", ApprovalStatus::Pending, 1), Timestamp(1))
            .unwrap();
        a.upsert(&approval("apr_2", ApprovalStatus::Pending, 2), Timestamp(2))
            .unwrap();
        a.upsert(
            &approval("apr_1", ApprovalStatus::Rejected, 1),
            Timestamp(3),
        )
        .unwrap();
        let pending = a.pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id.as_str(), "apr_2");
        assert_eq!(
            a.get("apr_1").unwrap().unwrap().status,
            ApprovalStatus::Rejected
        );
        assert_eq!(a.recent(10).unwrap().len(), 2);

        let d = s.drafts();
        let mut info = DraftInfo {
            draft_id: DraftId::new("d_1"),
            approval_id: ApprovalId::new("apr_2"),
            tool: "orders.submit".into(),
            account: "paper-main".into(),
            environment: None,
            instrument: Some(InstrumentId::new("QQQ").unwrap()),
            preview: json!({"restatement": "BUY 25 QQQ LMT 487.25 DAY"}),
            live: true,
            status: DraftStatus::Live,
            origin: Origin::User,
            created_at: Timestamp(2),
            stale_at: Timestamp(62),
            error: None,
        };
        d.upsert(&info, Timestamp(2)).unwrap();
        assert_eq!(d.live(Some("paper-main")).unwrap().len(), 1);
        assert_eq!(d.live(Some("other")).unwrap().len(), 0);
        info.live = false;
        d.upsert(&info, Timestamp(3)).unwrap();
        assert!(d.live(None).unwrap().is_empty());
        assert!(!d.get("d_1").unwrap().unwrap().live);
    }

    #[test]
    fn broker_state_round_trips_in_one_transaction() {
        use tessera_core::accounts::Environment;
        use tessera_core::ids::{AccountId, FillId, OrderId};
        use tessera_core::money::Money;
        use tessera_core::orders::{
            OrderRequest, OrderRole, OrderStatus, OrderType, Side, TimeInForce,
        };
        use tessera_core::{Price, Qty};

        let s = store();
        let b = s.broker("paper");
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let order = |id: &str, status: OrderStatus, t: i64| Order {
            id: OrderId::new(id),
            broker_order_id: None,
            draft_id: None,
            request: OrderRequest {
                account_id: AccountId::new("paper-main"),
                instrument: nq.clone(),
                side: Side::Buy,
                qty: Qty::from(2),
                order_type: OrderType::Limit,
                limit_price: Some(Price::from(20_615)),
                stop_price: None,
                tif: TimeInForce::Day,
                bracket: None,
                client_order_id: None,
                reduce_only: false,
            },
            role: OrderRole::Entry,
            parent_id: None,
            status,
            filled_qty: Qty::ZERO,
            avg_fill_price: None,
            queue_ahead: None,
            stop_rules: None,
            triggered_at: None,
            environment: Environment::Paper,
            reason: None,
            created_at: Timestamp(t),
            updated_at: Timestamp(t),
        };
        let position = |qty: i64| Position {
            account_id: AccountId::new("paper-main"),
            instrument: nq.clone(),
            qty: Qty::from(qty),
            avg_price: Price::from(20_615),
            realized_pnl: Money::usd(0.into()),
            unrealized_pnl: None,
            mark: None,
            opened_at: Timestamp(5),
        };
        let fill = Fill {
            id: FillId::new("f1"),
            broker_fill_id: None,
            order_id: Some(OrderId::new("o2")),
            account_id: AccountId::new("paper-main"),
            instrument: nq.clone(),
            side: Side::Buy,
            qty: Qty::from(1),
            price: Price::from(20_615),
            ts: Timestamp(5),
            fee: Money::usd(0.into()),
            realized_pnl: None,
            source: "paper".into(),
        };
        b.apply(
            &BrokerBatch {
                accounts: vec![("paper-main".into(), json!({"balance": 124820}))],
                orders: vec![
                    order("o1", OrderStatus::Filled, 1),
                    order("o2", OrderStatus::Working, 2),
                ],
                fills: vec![fill.clone()],
                positions: vec![position(1)],
            },
            Timestamp(5),
        )
        .unwrap();
        assert_eq!(b.accounts().unwrap(), vec![json!({"balance": 124820})]);
        let ids = |v: Vec<Order>| v.into_iter().map(|o| o.id.0).collect::<Vec<_>>();
        assert_eq!(ids(b.orders(Timestamp(2)).unwrap()), ["o2"]);
        assert_eq!(ids(b.orders(Timestamp(0)).unwrap()), ["o1", "o2"]);
        assert_eq!(
            b.fills(Some("paper-main"), Timestamp(0)).unwrap(),
            vec![fill]
        );
        assert!(b.fills(Some("other"), Timestamp(0)).unwrap().is_empty());
        assert_eq!(b.positions().unwrap().len(), 1);
        b.apply(
            &BrokerBatch {
                positions: vec![position(0)],
                ..BrokerBatch::default()
            },
            Timestamp(6),
        )
        .unwrap();
        assert!(b.positions().unwrap().is_empty());
        assert!(s.broker("rithmic").orders(Timestamp(0)).unwrap().is_empty());
    }

    fn session(id: &str, t: i64) -> AgentSessionSummary {
        AgentSessionSummary {
            id: SessionId::new(id),
            title: "Gamma reversion".into(),
            preset: "Trader".into(),
            provider: "codex".into(),
            model: None,
            effort: None,
            thread: None,
            mode: SessionMode::Supervised,
            status: AgentSessionStatus::Idle,
            origin: Origin::Agent {
                session_id: SessionId::new(id),
                provider: "codex".into(),
            },
            source_label: None,
            created_at: Timestamp(t),
            updated_at: Timestamp(t),
            queue: Vec::new(),
            queue_held: false,
        }
    }

    fn event(session: &str, seq: u64, text: &str) -> AgentEventEnvelope {
        AgentEventEnvelope {
            session_id: SessionId::new(session),
            seq,
            ts: Timestamp(seq as i64),
            turn_id: Some("t1".into()),
            event: AgentEvent::UserMessage {
                text: text.into(),
                attachments: vec![],
            },
        }
    }

    #[test]
    fn transcripts_are_gapless_and_cascade() {
        let s = store();
        s.sessions().upsert(&session("S15", 1)).unwrap();
        s.sessions().upsert(&session("S14", 2)).unwrap();
        let ev = s.agent_events();
        assert_eq!(ev.next_seq("S15").unwrap(), 1);
        ev.append(&event("S15", 1, "test gamma reversion on QQQ"))
            .unwrap();
        ev.append(&event("S15", 2, "and NQ")).unwrap();
        assert!(matches!(
            ev.append(&event("S15", 4, "gap")),
            Err(StoreError::Conflict {
                expected: 3,
                actual: 4
            })
        ));
        assert!(matches!(
            ev.append(&event("S15", 2, "dup")),
            Err(StoreError::Conflict { .. })
        ));
        assert_eq!(ev.list("S15", 0, 100).unwrap().len(), 2);
        assert_eq!(ev.list("S15", 1, 100).unwrap()[0].seq, 2);
        let hits = s.search().search("gamma", Some("agent_event"), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].ref_id, "S15:1");
        assert_eq!(s.sessions().list().unwrap()[0].id.as_str(), "S14");
        assert!(s.sessions().delete("S15").unwrap());
        assert!(ev.list("S15", 0, 100).unwrap().is_empty(), "cascade");
        assert!(s.search().search("gamma", None, 10).unwrap().is_empty());
        assert!(ev.append(&event("nope", 1, "x")).is_err());
    }

    #[test]
    fn a_writer_that_missed_an_event_catches_up() {
        let s = store();
        s.sessions().upsert(&session("S15", 1)).unwrap();
        let ev = s.agent_events();
        let log: Vec<_> = (1..=5).map(|i| event("S15", i, "x")).collect();
        ev.append(&log[0]).unwrap();
        assert_eq!(ev.append_missing("S15", &log[1..]).unwrap(), 5);
        let seqs: Vec<u64> = ev
            .list("S15", 0, 100)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
        assert_eq!(ev.append_missing("S15", &log).unwrap(), 5);
        assert_eq!(ev.append_missing("S15", &[]).unwrap(), 5);
        let later = [event("S15", 6, "x"), event("S15", 8, "x")];
        assert!(matches!(
            ev.append_missing("S15", &later),
            Err(StoreError::Conflict {
                expected: 7,
                actual: 8
            })
        ));
        assert_eq!(ev.next_seq("S15").unwrap(), 6);
    }

    #[test]
    fn settings_round_trip() {
        let s = store();
        let r = s.settings();
        assert!(r.get("agent.maxStepsPerTurn").unwrap().is_none());
        r.set("agent.maxStepsPerTurn", &json!(30), Timestamp(1))
            .unwrap();
        r.set("appearance.upDownColors", &json!("green_red"), Timestamp(1))
            .unwrap();
        r.set("agent.maxStepsPerTurn", &json!(25), Timestamp(2))
            .unwrap();
        assert_eq!(r.get("agent.maxStepsPerTurn").unwrap(), Some(json!(25)));
        assert_eq!(r.all().unwrap().len(), 2);
        assert!(r.delete("appearance.upDownColors").unwrap());
        assert!(!r.delete("appearance.upDownColors").unwrap());
    }

    fn layout(rev: u64) -> Layout {
        Layout {
            id: "default".into(),
            name: "Day · QQQ/NQ".into(),
            revision: rev,
            updated_at: Timestamp(rev as i64),
            active_chart_id: None,
            dock: Value::Null,
            charts: BTreeMap::new(),
            trade: Value::Null,
            unsaved: false,
        }
    }

    #[test]
    fn layouts_with_optimistic_concurrency() {
        let s = store();
        let r = s.layouts();
        r.put_if_revision(&layout(1), 0).unwrap();
        assert!(matches!(
            r.put_if_revision(&layout(2), 0),
            Err(StoreError::Conflict {
                expected: 0,
                actual: 1
            })
        ));
        r.put_if_revision(&layout(2), 1).unwrap();
        assert_eq!(r.get("default").unwrap().unwrap().revision, 2);
        r.put(&layout(7), None).unwrap();
        assert_eq!(
            r.list().unwrap(),
            vec![("default".into(), "Day · QQQ/NQ".into(), 7)]
        );
        assert!(r.get("nope").unwrap().is_none());
    }

    #[test]
    fn a_layout_keeps_its_saved_copy_beside_the_one_shown() {
        let s = store();
        let r = s.layouts();
        r.put(&layout(3), Some(&layout(2))).unwrap();
        assert_eq!(r.get("default").unwrap().unwrap().revision, 3);
        assert_eq!(r.saved("default").unwrap().unwrap().revision, 2);
        r.put(&layout(4), None).unwrap();
        assert_eq!(r.get("default").unwrap().unwrap().revision, 4);
        assert!(r.saved("default").unwrap().is_none());
        assert!(r.saved("nope").unwrap().is_none());
    }

    #[test]
    fn notes_are_searchable() {
        let s = store();
        let n = s.notes();
        let a = n
            .create(
                "QQQ gamma flip",
                "Retest of the Gamma Flip at 485.40 held.",
                &["gamma".into()],
                Some("QQQ"),
                None,
                Timestamp(1),
            )
            .unwrap();
        n.create(
            "NQ overnight",
            "Levels check before the open.",
            &[],
            None,
            None,
            Timestamp(2),
        )
        .unwrap();
        assert_eq!(n.get(a.id.as_str()).unwrap().unwrap(), a);
        let hits = s.search().search("retest", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "note");
        assert!(hits[0].snippet.contains("[Retest]"));
        assert_eq!(s.search().search("level", None, 10).unwrap().len(), 1);
        n.update(
            a.id.as_str(),
            "QQQ flip",
            "Rejected at PDH instead.",
            Timestamp(3),
        )
        .unwrap();
        assert!(s.search().search("retest", None, 10).unwrap().is_empty());
        assert_eq!(s.search().search("PDH", None, 10).unwrap().len(), 1);
        assert_eq!(n.list(10).unwrap()[0].id, a.id);
        assert!(n.delete(a.id.as_str()).unwrap());
        assert!(s.search().search("PDH", None, 10).unwrap().is_empty());
        assert!(matches!(
            n.update("missing", "t", "b", Timestamp(4)),
            Err(StoreError::NotFound(_))
        ));
        assert!(s.search().search("\"unbalanced AND (", None, 10).is_ok());
        s.search()
            .index(
                "research_run",
                "rs_2a91",
                "Gamma reversion",
                "418 events, 61.7% reverted",
            )
            .unwrap();
        assert_eq!(
            s.search()
                .search("reverted", Some("research_run"), 5)
                .unwrap()
                .len(),
            1
        );
    }
}
