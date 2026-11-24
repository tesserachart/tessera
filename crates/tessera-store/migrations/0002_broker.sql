-- Tessera local database, schema 2: broker state (the paper broker's accounts, orders, fills and
-- positions). Bodies hold the core types verbatim (Order, Fill, Position) or the connection's own
-- account state. Rows are scoped by connection id (`paper`).

CREATE TABLE broker_accounts (
    connection TEXT NOT NULL,
    account_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL,
    PRIMARY KEY (connection, account_id)
);

CREATE TABLE orders (
    order_id   TEXT PRIMARY KEY,
    connection TEXT NOT NULL,
    account_id TEXT NOT NULL,
    instrument TEXT NOT NULL,
    status     TEXT NOT NULL,
    open       INTEGER NOT NULL,
    draft_id   TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL
);
CREATE INDEX orders_open ON orders (connection, open);
CREATE INDEX orders_account ON orders (connection, account_id, updated_at);

CREATE TABLE fills (
    fill_id    TEXT PRIMARY KEY,
    connection TEXT NOT NULL,
    account_id TEXT NOT NULL,
    order_id   TEXT,
    instrument TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    body       TEXT NOT NULL
);
CREATE INDEX fills_account_ts ON fills (connection, account_id, ts);

CREATE TABLE positions (
    connection TEXT NOT NULL,
    account_id TEXT NOT NULL,
    instrument TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    body       TEXT NOT NULL,
    PRIMARY KEY (connection, account_id, instrument)
);
