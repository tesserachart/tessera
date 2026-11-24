-- Spans (ns, half-open) a connection refused to replay, and when (ns), so a restart does not ask
-- for them again before the next session.
CREATE TABLE tick_refusals (
    source     TEXT    NOT NULL,
    instrument TEXT    NOT NULL,
    start      INTEGER NOT NULL,
    end        INTEGER NOT NULL,
    refused_at INTEGER NOT NULL,
    PRIMARY KEY (source, instrument, start)
) WITHOUT ROWID;

-- What each connection's history service sent per UTC day: requests and the bytes of their
-- answers, so a login's data allowance can be watched.
CREATE TABLE history_use (
    source   TEXT    NOT NULL,
    day      TEXT    NOT NULL,   -- YYYY-MM-DD, UTC
    requests INTEGER NOT NULL,
    bytes    INTEGER NOT NULL,
    PRIMARY KEY (source, day)
) WITHOUT ROWID;
