-- Custom indicators (decision 0011 §3): the user's and the analyst's Python indicators, every saved
-- version kept. `latest` is the version charts draw unless a layer pins another.
CREATE TABLE custom_indicators (
    indicator_id TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    latest       INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    created_by   TEXT NOT NULL
);

CREATE TABLE custom_indicator_versions (
    indicator_id TEXT NOT NULL REFERENCES custom_indicators (indicator_id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    code         TEXT NOT NULL,
    manifest     TEXT NOT NULL,
    note         TEXT,
    created_at   INTEGER NOT NULL,
    created_by   TEXT NOT NULL,
    PRIMARY KEY (indicator_id, version)
);
