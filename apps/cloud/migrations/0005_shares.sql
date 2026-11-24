CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('chart')),
  title TEXT NOT NULL,
  image_type TEXT NOT NULL CHECK (image_type IN ('image/png', 'image/jpeg')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX shares_by_user ON shares (user_id, created_at DESC);
