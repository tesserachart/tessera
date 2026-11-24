-- Tessera local database, schema 7: the history of market-intelligence levels (decision 0013).
-- One store for every vendor: a series is one vendor's level on one instrument, its names kept
-- verbatim (the vendor, its package, its level) and the vendor a column, never a code path. An
-- observation is the level's value at the vendor's own time (`as_of`) and when Tessera could first
-- have known it (`known_at`): its arrival for a live snapshot, the vendor's time for an import.
-- Real observations only (live snapshots as providers deliver them, files the user imports, a
-- vendor's history API): nothing synthetic is ever stored here.

CREATE TABLE level_series (
    series_id  INTEGER PRIMARY KEY,
    vendor     TEXT NOT NULL,              -- as the vendor writes its name (Acme)
    vendor_key TEXT NOT NULL,              -- its key (acme): the first part of `vendor.level`
    package    TEXT NOT NULL DEFAULT '',   -- the vendor's package or product, verbatim (State)
    level      TEXT NOT NULL,              -- the vendor's level name, verbatim (major_long_gamma)
    instrument TEXT NOT NULL,              -- what the value's price applies to (NQZ6.CME, NDX, NQ)
    label      TEXT,                       -- the vendor's own name for it (Major Long Gamma)
    endpoint   TEXT,                       -- the vendor request it comes from (state/gamma_zero)
    basis      TEXT,                       -- the price space the vendor computed it in (NDX)
    meta       TEXT,                       -- JSON: what else the vendor declares (concept, meaning)
    created_at INTEGER NOT NULL,
    UNIQUE (vendor_key, package, level, instrument)
);
CREATE INDEX level_series_level ON level_series (vendor_key, level);

CREATE TABLE level_observations (
    series_id    INTEGER NOT NULL REFERENCES level_series (series_id) ON DELETE CASCADE,
    as_of        INTEGER NOT NULL,         -- the vendor's time of the value, ns
    known_at     INTEGER NOT NULL,         -- when Tessera could first have known it, ns
    value        REAL,                     -- the price; NULL when the vendor marks it not applicable
    native_value REAL,                     -- the vendor's value before a price conversion
    reason       TEXT,                     -- why there is no value
    conversion   TEXT,                     -- JSON: the conversion applied (NDX → NQZ6), if any
    origin       TEXT NOT NULL,            -- live | import | backfill
    batch        TEXT NOT NULL,            -- the provider that delivered it, or the import
    PRIMARY KEY (series_id, as_of)
) WITHOUT ROWID;
CREATE INDEX level_observations_known ON level_observations (series_id, known_at);
CREATE INDEX level_observations_batch ON level_observations (batch);

-- per provider: since when its snapshots are recorded as they arrive
CREATE TABLE level_recordings (
    provider  TEXT PRIMARY KEY,
    vendor    TEXT NOT NULL,
    first_at  INTEGER NOT NULL,
    last_at   INTEGER NOT NULL,
    snapshots INTEGER NOT NULL
);

-- every file imported, with what it gave
CREATE TABLE level_imports (
    import_id   TEXT PRIMARY KEY,
    vendor      TEXT NOT NULL,
    file_name   TEXT,
    adapter     TEXT NOT NULL,
    records     INTEGER NOT NULL,
    imported    INTEGER NOT NULL,
    skipped     INTEGER NOT NULL,
    first_as_of INTEGER,
    last_as_of  INTEGER,
    at          INTEGER NOT NULL,
    by          TEXT NOT NULL
);
