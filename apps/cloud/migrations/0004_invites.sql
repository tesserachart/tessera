CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  used_by TEXT REFERENCES users (id) ON DELETE CASCADE,
  used_at TEXT,
  revoked_at TEXT,
  CHECK ((used_by IS NULL) = (used_at IS NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX invites_open ON invites (email) WHERE used_at IS NULL AND revoked_at IS NULL;
