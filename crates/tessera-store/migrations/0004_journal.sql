-- Tessera local database, schema 3: the journal (decision 0011 §5, TheTraderLog brought in).
-- Trades are not stored: they are built from `journal_fills` (every connection's fills, imports,
-- trades logged by hand) whenever those change. What the trader adds to a trade is kept by the
-- trade's stable id in `journal_trade_meta`. Bodies hold the journal's own JSON types.

CREATE TABLE journal_fills (
    fill_id    TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    instrument TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    origin     TEXT NOT NULL,
    import_id  TEXT,
    body       TEXT NOT NULL
);
CREATE INDEX journal_fills_key ON journal_fills (account_id, instrument, ts, seq);
CREATE INDEX journal_fills_import ON journal_fills (import_id);

-- the contract spec each instrument's trades are priced with, kept so a trade reads the same
-- when its connection is gone
CREATE TABLE journal_instruments (
    instrument TEXT PRIMARY KEY,
    body       TEXT NOT NULL
);

CREATE TABLE journal_accounts (
    account_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    origin     TEXT NOT NULL,
    platform   TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE journal_trade_meta (
    trade_id   TEXT PRIMARY KEY,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);

CREATE TABLE journal_tags (
    tag_id     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    grp        TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX journal_tags_name ON journal_tags (grp, name COLLATE NOCASE);

CREATE TABLE journal_trade_tags (
    trade_id TEXT NOT NULL,
    tag_id   TEXT NOT NULL REFERENCES journal_tags (tag_id) ON DELETE CASCADE,
    PRIMARY KEY (trade_id, tag_id)
);
CREATE INDEX journal_trade_tags_tag ON journal_trade_tags (tag_id);

CREATE TABLE journal_setups (
    setup_id   TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);

CREATE TABLE journal_rule_checks (
    trade_id TEXT NOT NULL,
    rule_id  TEXT NOT NULL,
    checked  INTEGER NOT NULL,
    PRIMARY KEY (trade_id, rule_id)
);

CREATE TABLE journal_days (
    day        TEXT PRIMARY KEY,
    content    TEXT NOT NULL DEFAULT '',
    started_at INTEGER,
    updated_at INTEGER NOT NULL
);

CREATE TABLE journal_checklist (
    item_id TEXT PRIMARY KEY,
    text    TEXT NOT NULL,
    ord     INTEGER NOT NULL,
    active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE journal_checks (
    day     TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES journal_checklist (item_id) ON DELETE CASCADE,
    checked INTEGER NOT NULL,
    PRIMARY KEY (day, item_id)
);

-- screenshots and files: the bytes in the blob store (`blobs/`), by digest
CREATE TABLE journal_attachments (
    attachment_id TEXT PRIMARY KEY,
    owner_kind    TEXT NOT NULL,
    owner_id      TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    filename      TEXT NOT NULL,
    media_type    TEXT NOT NULL,
    size          INTEGER NOT NULL,
    caption       TEXT,
    created_at    INTEGER NOT NULL
);
CREATE INDEX journal_attachments_owner ON journal_attachments (owner_kind, owner_id);

CREATE TABLE journal_imports (
    import_id  TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);

CREATE TABLE journal_filters (
    filter_id  TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);

CREATE TABLE journal_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
