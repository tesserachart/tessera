-- Tessera local database, schema 6: the journal's record of trading activity. Every order's
-- lifecycle as compact events (placed, each change of its stop or limit price, its quantity or its
-- status, cancelled, filled), kept apart from the fills so a trade's stops and targets can be read
-- back over time. Only changes are stored: `journal_orders` holds the last snapshot of each order,
-- and an update is compared with it. Bodies hold the journal's own JSON types.

CREATE TABLE journal_order_events (
    event_id   TEXT PRIMARY KEY,
    order_id   TEXT NOT NULL,
    account_id TEXT NOT NULL,
    instrument TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    source     TEXT NOT NULL,
    body       TEXT NOT NULL
);
CREATE INDEX journal_order_events_key ON journal_order_events (account_id, instrument, ts, seq);
CREATE INDEX journal_order_events_order ON journal_order_events (order_id, ts, seq);

-- the last state of each order seen (the next update is compared with it)
CREATE TABLE journal_orders (
    order_id   TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    instrument TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);

-- per account: since when its orders are recorded as they change (`live_since`), and when its
-- earlier orders were reconstructed from what was stored
CREATE TABLE journal_activity_accounts (
    account_id    TEXT PRIMARY KEY,
    live_since    INTEGER,
    backfilled_at INTEGER
);
