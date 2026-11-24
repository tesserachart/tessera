-- Tessera local database, schema 9: the MCP clients the user connected (their own Claude Desktop, Claude Code,
-- Codex, Cursor…). Only each token's SHA-256 is kept (`token_hash`); the token itself is shown once and never stored.
-- A revoked client keeps its row (`revoked_at`, UTC nanoseconds) so its id, which its calls and drafts were recorded
-- under, is never given to another client.

CREATE TABLE mcp_clients (
    client_id    TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    policy       TEXT NOT NULL DEFAULT 'supervised',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
);
