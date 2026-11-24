-- Records a module keeps as JSON, by collection and id (research studies and their runs, …):
-- one table, so a new kind of record needs no migration of its own.
CREATE TABLE documents (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    -- the record this one belongs to (a run's study), for listing by it
    parent     TEXT,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX documents_parent ON documents (collection, parent, created_at DESC);
CREATE INDEX documents_updated ON documents (collection, updated_at DESC);
