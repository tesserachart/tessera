use std::collections::HashMap;

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tessera_core::Origin;
use tessera_core::Price;
use tessera_core::Timestamp;
use tessera_core::instrument::ContractSpec;
use tessera_core::orders::{Fill, Order, OrderRole};
use tessera_store::{Result, Store};

use crate::activity::{ORDER_TOOLS, OrderCall, OrderEvent};

use crate::model::{
    AttachmentInfo, ChecklistItem, Emotion, ExitReason, FillOrigin, ImportInfo, JournalSettings,
    SavedFilter, SetupRule,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalFill {
    pub fill: Fill,
    pub seq: i64,
    pub origin: FillOrigin,
    pub import_id: Option<String>,
    pub role: Option<OrderRole>,
    pub stop: Option<Price>,
    pub target: Option<Price>,
    pub reported_pnl: Option<Decimal>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Excursion {
    pub mae: f64,
    pub mfe: f64,
    pub mae_price: f64,
    pub mfe_price: f64,
    pub bars: u32,
    pub closed_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TradeMeta {
    pub notes: String,
    pub setup_id: Option<String>,
    pub rating: Option<u8>,
    pub reviewed: bool,
    pub emotion: Option<Emotion>,
    pub exit_reason: Option<ExitReason>,
    pub stop_price: Option<f64>,
    pub target_price: Option<f64>,
    pub excursion: Option<Excursion>,
    pub excursion_missing: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SetupBody {
    pub name: String,
    pub description: String,
    pub color: String,
    pub entry_criteria: String,
    pub exit_rules: String,
    pub rules: Vec<SetupRule>,
    pub active: bool,
    pub study_id: Option<String>,
}

impl Default for SetupBody {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            color: "#7f9fbf".into(),
            entry_criteria: String::new(),
            exit_rules: String::new(),
            rules: Vec::new(),
            active: true,
            study_id: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagRow {
    pub id: String,
    pub name: String,
    pub group: String,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountRow {
    pub id: String,
    pub name: String,
    pub origin: FillOrigin,
    pub platform: Option<String>,
}

fn origin_str(o: FillOrigin) -> &'static str {
    match o {
        FillOrigin::Broker => "broker",
        FillOrigin::Import => "import",
        FillOrigin::Manual => "manual",
    }
}

fn origin_of(s: &str) -> FillOrigin {
    match s {
        "import" => FillOrigin::Import,
        "manual" => FillOrigin::Manual,
        _ => FillOrigin::Broker,
    }
}

pub type CoverageRow = (String, Option<Timestamp>, Option<Timestamp>);

#[derive(Clone, Debug)]
pub struct Repo {
    store: Store,
}

impl Repo {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn fills(&self) -> Result<Vec<JournalFill>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT body FROM journal_fills WHERE trashed_at IS NULL ORDER BY ts, seq, fill_id",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(serde_json::from_str(&r?)?);
        }
        Ok(out)
    }

    pub fn trashed_fills(&self) -> Result<Vec<(String, Timestamp, JournalFill)>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT trashed_trade, trashed_at, body FROM journal_fills
             WHERE trashed_at IS NOT NULL ORDER BY ts, seq, fill_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (trade, at, body) = r?;
            out.push((
                trade.unwrap_or_default(),
                Timestamp(at),
                serde_json::from_str(&body)?,
            ));
        }
        Ok(out)
    }

    pub fn trash_fills(&self, ids: &[String], trade_id: &str, at: Timestamp) -> Result<usize> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        let mut n = 0;
        for id in ids {
            n += tx.execute(
                "UPDATE journal_fills SET trashed_at = ?2, trashed_trade = ?3
                 WHERE fill_id = ?1 AND trashed_at IS NULL",
                params![id, at.0, trade_id],
            )?;
        }
        tx.commit()?;
        Ok(n)
    }

    pub fn restore_fills(&self, trade_id: &str) -> Result<usize> {
        Ok(self.store.conn()?.execute(
            "UPDATE journal_fills SET trashed_at = NULL, trashed_trade = NULL
             WHERE trashed_trade = ?1 AND trashed_at IS NOT NULL",
            params![trade_id],
        )?)
    }

    pub fn purge_trades(&self, trade_ids: &[String]) -> Result<usize> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        let mut n = 0;
        for id in trade_ids {
            n += tx.execute(
                "DELETE FROM journal_fills WHERE trashed_trade = ?1 AND trashed_at IS NOT NULL",
                params![id],
            )?;
            for sql in [
                "DELETE FROM journal_trade_meta WHERE trade_id = ?1",
                "DELETE FROM journal_trade_tags WHERE trade_id = ?1",
                "DELETE FROM journal_rule_checks WHERE trade_id = ?1",
                "DELETE FROM journal_trade_drawings WHERE trade_id = ?1",
                "DELETE FROM journal_attachments WHERE owner_kind = 'trade' AND owner_id = ?1",
            ] {
                tx.execute(sql, params![id])?;
            }
        }
        tx.commit()?;
        Ok(n)
    }

    pub fn insert_fills(&self, fills: &[JournalFill]) -> Result<Vec<JournalFill>> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        let mut added = Vec::new();
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO journal_fills
                 (fill_id, account_id, instrument, ts, seq, origin, import_id, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for f in fills {
                let n = stmt.execute(params![
                    f.fill.id.as_str(),
                    f.fill.account_id.as_str(),
                    f.fill.instrument.as_str(),
                    f.fill.ts.0,
                    f.seq,
                    origin_str(f.origin),
                    f.import_id,
                    serde_json::to_string(f)?,
                ])?;
                if n > 0 {
                    added.push(f.clone());
                }
            }
        }
        tx.commit()?;
        Ok(added)
    }

    pub fn split_fill(&self, closing: &JournalFill, opening: &JournalFill) -> Result<()> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE journal_fills SET body = ?2 WHERE fill_id = ?1",
            params![closing.fill.id.as_str(), serde_json::to_string(closing)?],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO journal_fills
             (fill_id, account_id, instrument, ts, seq, origin, import_id, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                opening.fill.id.as_str(),
                opening.fill.account_id.as_str(),
                opening.fill.instrument.as_str(),
                opening.fill.ts.0,
                opening.seq,
                origin_str(opening.origin),
                opening.import_id,
                serde_json::to_string(opening)?,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn instruments(&self) -> Result<Vec<ContractSpec>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT body FROM journal_instruments")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(spec) = serde_json::from_str(&r?) {
                out.push(spec);
            }
        }
        Ok(out)
    }

    pub fn put_instrument(&self, spec: &ContractSpec) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_instruments (instrument, body) VALUES (?1, ?2)
             ON CONFLICT (instrument) DO UPDATE SET body = excluded.body",
            params![spec.instrument.as_str(), serde_json::to_string(spec)?],
        )?;
        Ok(())
    }

    pub fn accounts(&self) -> Result<Vec<AccountRow>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT account_id, name, origin, platform FROM journal_accounts")?;
        let rows = stmt.query_map([], |r| {
            Ok(AccountRow {
                id: r.get(0)?,
                name: r.get(1)?,
                origin: origin_of(&r.get::<_, String>(2)?),
                platform: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn put_account(&self, a: &AccountRow) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_accounts (account_id, name, origin, platform, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (account_id) DO UPDATE SET name = excluded.name,
                 updated_at = excluded.updated_at",
            params![
                a.id,
                a.name,
                origin_str(a.origin),
                a.platform,
                Timestamp::now().0
            ],
        )?;
        Ok(())
    }

    pub fn metas(&self) -> Result<HashMap<String, TradeMeta>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT trade_id, body FROM journal_trade_meta")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = HashMap::new();
        for r in rows {
            let (id, body) = r?;
            out.insert(id, serde_json::from_str(&body).unwrap_or_default());
        }
        Ok(out)
    }

    pub fn put_meta(&self, trade_id: &str, meta: &TradeMeta) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_trade_meta (trade_id, updated_at, body) VALUES (?1, ?2, ?3)
             ON CONFLICT (trade_id) DO UPDATE SET body = excluded.body,
                 updated_at = excluded.updated_at",
            params![trade_id, Timestamp::now().0, serde_json::to_string(meta)?],
        )?;
        Ok(())
    }

    pub fn tags(&self) -> Result<Vec<TagRow>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT tag_id, name, grp, color FROM journal_tags ORDER BY grp, name")?;
        let rows = stmt.query_map([], |r| {
            Ok(TagRow {
                id: r.get(0)?,
                name: r.get(1)?,
                group: r.get(2)?,
                color: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn put_tag(&self, t: &TagRow) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_tags (tag_id, name, grp, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (tag_id) DO UPDATE SET name = excluded.name, grp = excluded.grp,
                 color = excluded.color",
            params![t.id, t.name, t.group, t.color, Timestamp::now().0],
        )?;
        Ok(())
    }

    pub fn delete_tag(&self, id: &str) -> Result<usize> {
        Ok(self
            .store
            .conn()?
            .execute("DELETE FROM journal_tags WHERE tag_id = ?1", params![id])?)
    }

    pub fn trade_tags(&self) -> Result<HashMap<String, Vec<String>>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT trade_id, tag_id FROM journal_trade_tags")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        for r in rows {
            let (t, g) = r?;
            out.entry(t).or_default().push(g);
        }
        Ok(out)
    }

    pub fn set_trade_tags(&self, trade_id: &str, tags: &[String]) -> Result<()> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM journal_trade_tags WHERE trade_id = ?1",
            params![trade_id],
        )?;
        for g in tags {
            tx.execute(
                "INSERT OR IGNORE INTO journal_trade_tags (trade_id, tag_id) VALUES (?1, ?2)",
                params![trade_id, g],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn setups(&self) -> Result<Vec<(String, Timestamp, SetupBody)>> {
        let conn = self.store.conn()?;
        let mut stmt = conn
            .prepare("SELECT setup_id, created_at, body FROM journal_setups ORDER BY created_at")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (id, at, body) = r?;
            out.push((
                id,
                Timestamp(at),
                serde_json::from_str(&body).unwrap_or_default(),
            ));
        }
        Ok(out)
    }

    pub fn put_setup(&self, id: &str, body: &SetupBody) -> Result<()> {
        let now = Timestamp::now().0;
        self.store.conn()?.execute(
            "INSERT INTO journal_setups (setup_id, created_at, updated_at, body) VALUES (?1, ?2, ?2, ?3)
             ON CONFLICT (setup_id) DO UPDATE SET body = excluded.body,
                 updated_at = excluded.updated_at",
            params![id, now, serde_json::to_string(body)?],
        )?;
        Ok(())
    }

    pub fn delete_setup(&self, id: &str) -> Result<usize> {
        Ok(self.store.conn()?.execute(
            "DELETE FROM journal_setups WHERE setup_id = ?1",
            params![id],
        )?)
    }

    pub fn rule_checks(&self) -> Result<HashMap<String, HashMap<String, bool>>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT trade_id, rule_id, checked FROM journal_rule_checks")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })?;
        let mut out: HashMap<String, HashMap<String, bool>> = HashMap::new();
        for r in rows {
            let (t, rule, c) = r?;
            out.entry(t).or_default().insert(rule, c);
        }
        Ok(out)
    }

    pub fn put_rule_check(&self, trade_id: &str, rule_id: &str, checked: bool) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_rule_checks (trade_id, rule_id, checked) VALUES (?1, ?2, ?3)
             ON CONFLICT (trade_id, rule_id) DO UPDATE SET checked = excluded.checked",
            params![trade_id, rule_id, checked],
        )?;
        Ok(())
    }

    pub fn day(&self, day: &str) -> Result<Option<(String, Option<Timestamp>, Timestamp)>> {
        Ok(self
            .store
            .conn()?
            .query_row(
                "SELECT content, started_at, updated_at FROM journal_days WHERE day = ?1",
                params![day],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<i64>>(1)?.map(Timestamp),
                        Timestamp(r.get::<_, i64>(2)?),
                    ))
                },
            )
            .optional()?)
    }

    pub fn put_day(&self, day: &str, content: &str, started_at: Option<Timestamp>) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_days (day, content, started_at, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (day) DO UPDATE SET content = excluded.content,
                 started_at = coalesce(journal_days.started_at, excluded.started_at),
                 updated_at = excluded.updated_at",
            params![day, content, started_at.map(|t| t.0), Timestamp::now().0],
        )?;
        Ok(())
    }

    pub fn recent_days(&self, limit: u32) -> Result<Vec<(String, String)>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT day, content FROM journal_days
             WHERE trim(content, ' ' || char(9) || char(10) || char(13)) != ''
             ORDER BY day DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn days(&self) -> Result<Vec<(String, String)>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT day, content FROM journal_days
             WHERE content != '' OR started_at IS NOT NULL ORDER BY day",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn checklist(&self) -> Result<Vec<ChecklistItem>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT item_id, text, active FROM journal_checklist ORDER BY ord")?;
        let rows = stmt.query_map([], |r| {
            Ok(ChecklistItem {
                id: r.get(0)?,
                text: r.get(1)?,
                active: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn put_checklist(&self, items: &[ChecklistItem]) -> Result<()> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let keep: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        {
            let mut stmt = tx.prepare("SELECT item_id FROM journal_checklist")?;
            let old: Vec<String> = stmt
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for id in old.iter().filter(|id| !keep.contains(&id.as_str())) {
                tx.execute(
                    "DELETE FROM journal_checklist WHERE item_id = ?1",
                    params![id],
                )?;
            }
        }
        for (i, it) in items.iter().enumerate() {
            tx.execute(
                "INSERT INTO journal_checklist (item_id, text, ord, active) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (item_id) DO UPDATE SET text = excluded.text, ord = excluded.ord,
                     active = excluded.active",
                params![it.id, it.text, i as i64, it.active],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn checks(&self, day: &str) -> Result<HashMap<String, bool>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT item_id, checked FROM journal_checks WHERE day = ?1")?;
        let rows = stmt.query_map(params![day], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn put_check(&self, day: &str, item: &str, checked: bool) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_checks (day, item_id, checked) VALUES (?1, ?2, ?3)
             ON CONFLICT (day, item_id) DO UPDATE SET checked = excluded.checked",
            params![day, item, checked],
        )?;
        Ok(())
    }

    pub fn put_attachment(
        &self,
        owner_kind: &str,
        owner_id: &str,
        sha: &str,
        a: &AttachmentInfo,
    ) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_attachments
             (attachment_id, owner_kind, owner_id, sha256, filename, media_type, size, caption, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                a.id,
                owner_kind,
                owner_id,
                sha,
                a.filename,
                a.media_type,
                a.size as i64,
                a.caption,
                a.created_at.0
            ],
        )?;
        Ok(())
    }

    fn attachment_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(AttachmentInfo, String)> {
        Ok((
            AttachmentInfo {
                id: r.get(0)?,
                filename: r.get(1)?,
                media_type: r.get(2)?,
                size: r.get::<_, i64>(3)? as u64,
                caption: r.get(4)?,
                created_at: Timestamp(r.get(5)?),
            },
            r.get(6)?,
        ))
    }

    pub fn attachments(&self, owner_kind: &str, owner_id: &str) -> Result<Vec<AttachmentInfo>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT attachment_id, filename, media_type, size, caption, created_at, sha256
             FROM journal_attachments WHERE owner_kind = ?1 AND owner_id = ?2 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![owner_kind, owner_id], Self::attachment_row)?;
        Ok(rows
            .map(|r| r.map(|(a, _)| a))
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn attachment(&self, id: &str) -> Result<Option<(AttachmentInfo, String)>> {
        Ok(self
            .store
            .conn()?
            .query_row(
                "SELECT attachment_id, filename, media_type, size, caption, created_at, sha256
                 FROM journal_attachments WHERE attachment_id = ?1",
                params![id],
                Self::attachment_row,
            )
            .optional()?)
    }

    pub fn delete_attachment(&self, id: &str) -> Result<usize> {
        Ok(self.store.conn()?.execute(
            "DELETE FROM journal_attachments WHERE attachment_id = ?1",
            params![id],
        )?)
    }

    pub fn attachment_counts(&self) -> Result<HashMap<String, u32>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT owner_id, count(*) FROM journal_attachments WHERE owner_kind = 'trade'
             GROUP BY owner_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn imports(&self) -> Result<Vec<ImportInfo>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT body FROM journal_imports ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(serde_json::from_str(&r?)?);
        }
        Ok(out)
    }

    pub fn put_import(&self, i: &ImportInfo) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_imports (import_id, created_at, body) VALUES (?1, ?2, ?3)",
            params![i.id, i.created_at.0, serde_json::to_string(i)?],
        )?;
        Ok(())
    }

    pub fn delete_import(&self, id: &str) -> Result<usize> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        let n = tx.execute(
            "DELETE FROM journal_fills WHERE import_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM journal_imports WHERE import_id = ?1",
            params![id],
        )?;
        tx.commit()?;
        Ok(n)
    }

    pub fn filters(&self) -> Result<Vec<SavedFilter>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT body, is_default FROM journal_filters ORDER BY created_at")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
        let mut out = Vec::new();
        for r in rows {
            let (body, default) = r?;
            if let Ok(mut f) = serde_json::from_str::<SavedFilter>(&body) {
                f.is_default = default;
                out.push(f);
            }
        }
        Ok(out)
    }

    pub fn put_filter(&self, f: &SavedFilter) -> Result<()> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        if f.is_default {
            tx.execute(
                "UPDATE journal_filters SET is_default = 0 WHERE filter_id != ?1",
                params![f.id],
            )?;
        }
        tx.execute(
            "INSERT INTO journal_filters (filter_id, created_at, body, is_default)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (filter_id) DO UPDATE SET body = excluded.body,
                 is_default = excluded.is_default",
            params![
                f.id,
                Timestamp::now().0,
                serde_json::to_string(f)?,
                f.is_default
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_filter(&self, id: &str) -> Result<usize> {
        Ok(self.store.conn()?.execute(
            "DELETE FROM journal_filters WHERE filter_id = ?1",
            params![id],
        )?)
    }

    pub fn drawings(&self, trade_id: &str) -> Result<Vec<serde_json::Value>> {
        let body: Option<String> = self
            .store
            .conn()?
            .query_row(
                "SELECT body FROM journal_trade_drawings WHERE trade_id = ?1",
                params![trade_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(body
            .and_then(|b| serde_json::from_str(&b).ok())
            .unwrap_or_default())
    }

    pub fn put_drawings(&self, trade_id: &str, drawings: &[serde_json::Value]) -> Result<()> {
        let conn = self.store.conn()?;
        if drawings.is_empty() {
            conn.execute(
                "DELETE FROM journal_trade_drawings WHERE trade_id = ?1",
                params![trade_id],
            )?;
        } else {
            conn.execute(
                "INSERT INTO journal_trade_drawings (trade_id, updated_at, body) VALUES (?1, ?2, ?3)
                 ON CONFLICT (trade_id) DO UPDATE SET body = excluded.body,
                     updated_at = excluded.updated_at",
                params![trade_id, Timestamp::now().0, serde_json::to_string(drawings)?],
            )?;
        }
        Ok(())
    }

    pub fn settings(&self) -> Result<JournalSettings> {
        let v: Option<String> = self
            .store
            .conn()?
            .query_row(
                "SELECT value FROM journal_settings WHERE key = 'settings'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    pub fn put_settings(&self, s: &JournalSettings) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_settings (key, value) VALUES ('settings', ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![serde_json::to_string(s)?],
        )?;
        Ok(())
    }

    pub fn broker_order(&self, order_id: &str) -> Result<Option<tessera_core::orders::Order>> {
        let body: Option<String> = self
            .store
            .conn()?
            .query_row(
                "SELECT body FROM orders WHERE order_id = ?1",
                params![order_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(body.and_then(|b| serde_json::from_str(&b).ok()))
    }

    pub fn order_events(&self) -> Result<Vec<OrderEvent>> {
        let conn = self.store.conn()?;
        let mut stmt =
            conn.prepare("SELECT body FROM journal_order_events ORDER BY ts, seq, event_id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(e) = serde_json::from_str(&r?) {
                out.push(e);
            }
        }
        Ok(out)
    }

    pub fn order_snapshots(&self) -> Result<Vec<Order>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT body FROM journal_orders")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(o) = serde_json::from_str(&r?) {
                out.push(o);
            }
        }
        Ok(out)
    }

    pub fn put_order_events(&self, events: &[OrderEvent], orders: &[Order]) -> Result<usize> {
        let mut conn = self.store.conn()?;
        let tx = conn.transaction()?;
        let mut n = 0;
        {
            let mut ev = tx.prepare_cached(
                "INSERT OR IGNORE INTO journal_order_events
                 (event_id, order_id, account_id, instrument, ts, seq, kind, source, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for e in events {
                n += ev.execute(params![
                    e.id,
                    e.order_id,
                    e.account_id,
                    e.instrument,
                    e.ts.0,
                    e.seq,
                    e.kind.as_str(),
                    e.source.as_str(),
                    serde_json::to_string(e)?,
                ])?;
            }
            let mut snap = tx.prepare_cached(
                "INSERT INTO journal_orders (order_id, account_id, instrument, updated_at, body)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (order_id) DO UPDATE SET updated_at = excluded.updated_at,
                     body = excluded.body",
            )?;
            for o in orders {
                snap.execute(params![
                    o.id.as_str(),
                    o.request.account_id.as_str(),
                    o.request.instrument.as_str(),
                    o.updated_at.0,
                    serde_json::to_string(o)?,
                ])?;
            }
        }
        tx.commit()?;
        Ok(n)
    }

    pub fn activity_accounts(&self) -> Result<Vec<CoverageRow>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT account_id, live_since, backfilled_at FROM journal_activity_accounts",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?.map(Timestamp),
                r.get::<_, Option<i64>>(2)?.map(Timestamp),
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn put_activity_account(
        &self,
        account: &str,
        live_since: Option<Timestamp>,
        backfilled_at: Option<Timestamp>,
    ) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_activity_accounts (account_id, live_since, backfilled_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (account_id) DO UPDATE SET
                 live_since = coalesce(journal_activity_accounts.live_since, excluded.live_since),
                 backfilled_at = coalesce(excluded.backfilled_at, journal_activity_accounts.backfilled_at)",
            params![account, live_since.map(|t| t.0), backfilled_at.map(|t| t.0)],
        )?;
        Ok(())
    }

    pub fn stored_orders(&self) -> Result<Vec<Order>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT body FROM orders ORDER BY created_at, order_id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(o) = serde_json::from_str(&r?) {
                out.push(o);
            }
        }
        Ok(out)
    }

    pub fn order_calls(&self, range: Option<(Timestamp, Timestamp)>) -> Result<Vec<OrderCall>> {
        let conn = self.store.conn()?;
        let tools = ORDER_TOOLS
            .iter()
            .map(|t| format!("'{t}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT call_id, tool, origin, input, started_at, finished_at, approved_by, summary
             FROM tool_calls
             WHERE status = 'ok' AND tool IN ({tools})
               AND (?1 IS NULL OR started_at >= ?1) AND (?2 IS NULL OR started_at <= ?2)
             ORDER BY started_at, call_id"
        ))?;
        let (from, to) = (range.map(|r| r.0.0), range.map(|r| r.1.0));
        let rows = stmt.query_map(params![from, to], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (call_id, tool, origin, input, started, finished, approved, summary) = r?;
            let Ok(origin) = serde_json::from_str::<Origin>(&origin) else {
                continue;
            };
            out.push(OrderCall {
                call_id,
                tool,
                origin,
                input: serde_json::from_str(&input).unwrap_or_default(),
                started_at: Timestamp(started),
                finished_at: finished.map(Timestamp),
                approved: approved.is_some(),
                summary,
            });
        }
        Ok(out)
    }

    pub fn flag(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .store
            .conn()?
            .query_row(
                "SELECT value FROM journal_settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn put_flag(&self, key: &str, value: &str) -> Result<()> {
        self.store.conn()?.execute(
            "INSERT INTO journal_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}
