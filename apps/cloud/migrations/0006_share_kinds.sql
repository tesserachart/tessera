CREATE TABLE shares_by_kind (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('chart', 'conversation', 'indicator', 'template', 'layout')),
  title TEXT NOT NULL,
  body_type TEXT NOT NULL CHECK (body_type IN ('image/png', 'image/jpeg', 'application/json')),
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);
INSERT INTO shares_by_kind (id, user_id, kind, title, body_type, width, height, created_at)
  SELECT id, user_id, kind, title, image_type, width, height, created_at FROM shares;
DROP TABLE shares;
ALTER TABLE shares_by_kind RENAME TO shares;
CREATE INDEX shares_by_user ON shares (user_id, created_at DESC);
