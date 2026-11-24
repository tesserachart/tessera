-- People, not trading: who someone is, what they may use, and when their app checked in. Never broker
-- credentials, trades or market data.

-- One row per person. `subject` is the identity provider's user id, kept apart from ours so the
-- provider can change without renumbering anyone.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  created_at TEXT NOT NULL,
  seen_at TEXT NOT NULL
);

-- A request for beta access, decided by an admin.
CREATE TABLE applications (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  prop_firm TEXT,
  platform TEXT,
  trading TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES users (id)
);

-- What someone may use, by key (`beta` today; plans later). `source` says what granted it.
CREATE TABLE entitlements (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  source TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- One row per app launch.
CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  channel TEXT NOT NULL
);
CREATE INDEX checkins_by_user ON checkins (user_id, at DESC);
