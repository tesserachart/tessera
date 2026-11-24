-- Tessera local database, schema 1.
-- Times are integer UTC nanoseconds. JSON columns hold the protocol types verbatim.

-- Audit log of every tool call (all origins).
CREATE TABLE tool_calls (
    call_id         TEXT PRIMARY KEY,
    tool            TEXT NOT NULL,
    risk            TEXT NOT NULL,
    origin_kind     TEXT NOT NULL,
    origin          TEXT NOT NULL,
    session_id      TEXT,
    input_hash      TEXT NOT NULL,
    input           TEXT NOT NULL,
    status          TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    duration_ms     REAL,
    error           TEXT,
    approval_id     TEXT,
    approved_by     TEXT,
    deduped         INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    summary         TEXT
);
CREATE INDEX tool_calls_started ON tool_calls (started_at DESC);
CREATE INDEX tool_calls_session ON tool_calls (session_id, started_at);
CREATE INDEX tool_calls_approval ON tool_calls (approval_id);

-- Approval requests (full Approval JSON in body).
CREATE TABLE approvals (
    approval_id TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL,
    tool        TEXT NOT NULL,
    session_id  TEXT,
    draft_id    TEXT,
    created_at  INTEGER NOT NULL,
    stale_at    INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    body        TEXT NOT NULL
);
CREATE INDEX approvals_status ON approvals (status, created_at);

-- Drafts of pending financial actions (DraftInfo JSON in body).
CREATE TABLE drafts (
    draft_id    TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL,
    account     TEXT NOT NULL,
    instrument  TEXT,
    tool        TEXT NOT NULL,
    live        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    body        TEXT NOT NULL
);
CREATE INDEX drafts_live ON drafts (account, instrument) WHERE live = 1;

-- Agent sessions (AgentSessionSummary JSON in body).
CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    preset     TEXT NOT NULL,
    provider   TEXT NOT NULL,
    model      TEXT,
    mode       TEXT NOT NULL,
    status     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);

-- Append-only agent transcripts (AgentEventEnvelope JSON in body). seq is gapless per session.
CREATE TABLE agent_events (
    session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    ts         INTEGER NOT NULL,
    turn_id    TEXT,
    type       TEXT NOT NULL,
    body       TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

-- Settings: key -> JSON value.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Workspace layouts (Layout JSON in body).
CREATE TABLE layouts (
    layout_id  TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    revision   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);

-- Notes.
CREATE TABLE notes (
    note_id    TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    tags       TEXT NOT NULL DEFAULT '[]',
    instrument TEXT,
    session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Manifest of the content-addressed blob store (blobs/ab/cd/<sha256>.zst).
CREATE TABLE blobs (
    sha256      TEXT PRIMARY KEY,
    size        INTEGER NOT NULL,
    stored_size INTEGER NOT NULL,
    media_type  TEXT NOT NULL,
    source      TEXT,
    created_at  INTEGER NOT NULL
);

-- Full-text search over notes, transcripts and (later) research runs and journal entries.
CREATE VIRTUAL TABLE search_fts USING fts5 (
    kind UNINDEXED,
    ref_id UNINDEXED,
    title,
    body,
    tokenize = 'porter unicode61'
);

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO search_fts (kind, ref_id, title, body)
    VALUES ('note', new.note_id, new.title, new.body);
END;

CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
    DELETE FROM search_fts WHERE kind = 'note' AND ref_id = old.note_id;
    INSERT INTO search_fts (kind, ref_id, title, body)
    VALUES ('note', new.note_id, new.title, new.body);
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
    DELETE FROM search_fts WHERE kind = 'note' AND ref_id = old.note_id;
END;

CREATE TRIGGER agent_events_fts_insert AFTER INSERT ON agent_events
WHEN new.type IN ('user_message', 'assistant_message') BEGIN
    INSERT INTO search_fts (kind, ref_id, title, body)
    VALUES ('agent_event', new.session_id || ':' || new.seq, '',
            coalesce(json_extract(new.body, '$.event.text'), ''));
END;

CREATE TRIGGER agent_events_fts_delete AFTER DELETE ON agent_events BEGIN
    DELETE FROM search_fts WHERE kind = 'agent_event' AND ref_id = old.session_id || ':' || old.seq;
END;
