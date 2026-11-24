-- Tessera local database, schema 8: the journal's Trash, default filter and trade drawings.
-- A trade deleted from the journal goes to the Trash: its fills stay in `journal_fills` with when
-- (`trashed_at`, UTC nanoseconds like `ts`) and the trade they formed (`trashed_trade`), are left out
-- of every trade built, and come back when it is restored; emptying the Trash deletes them.

ALTER TABLE journal_fills ADD COLUMN trashed_at INTEGER;
ALTER TABLE journal_fills ADD COLUMN trashed_trade TEXT;
CREATE INDEX journal_fills_trash ON journal_fills (trashed_trade);

-- the saved filter the trades list opens with (one at most)
ALTER TABLE journal_filters ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- what the trader drew on a trade's chart, by the trade's stable id: the chart's own JSON array
CREATE TABLE journal_trade_drawings (
    trade_id   TEXT PRIMARY KEY,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);
