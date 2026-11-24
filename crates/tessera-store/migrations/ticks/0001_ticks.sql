-- The tick store (ticks/ticks.db): every print a connection served, live or replayed, kept per
-- dated contract and trade date as one compressed columnar block per five minutes, with the spans
-- of time known whole. A print is kept only inside a span known whole.
CREATE TABLE tick_blocks (
    source     TEXT    NOT NULL,   -- the connection that served the prints (rithmic-apex)
    instrument TEXT    NOT NULL,   -- the dated contract (NQZ6.CME)
    block      INTEGER NOT NULL,   -- start of the five minutes the block holds (ns)
    trade_date TEXT    NOT NULL,   -- the session's trade date (YYYY-MM-DD)
    first_t    INTEGER NOT NULL,
    last_t     INTEGER NOT NULL,
    prints     INTEGER NOT NULL,
    data       BLOB    NOT NULL,   -- columnar, zstd
    PRIMARY KEY (source, instrument, block)
) WITHOUT ROWID;

CREATE INDEX tick_blocks_by_date ON tick_blocks (source, instrument, trade_date);

-- Half-open spans [start, end) (ns) whose prints are all in tick_blocks: recorded live, or asked
-- of the connection and answered. Each lies within one trade date; disjoint, merged as written.
CREATE TABLE tick_coverage (
    source     TEXT    NOT NULL,
    instrument TEXT    NOT NULL,
    start      INTEGER NOT NULL,
    end        INTEGER NOT NULL,
    trade_date TEXT    NOT NULL,
    PRIMARY KEY (source, instrument, start)
) WITHOUT ROWID;

CREATE INDEX tick_coverage_by_date ON tick_coverage (source, instrument, trade_date);

-- The contract as its connection described it (JSON), so a saved day replays with no connection.
CREATE TABLE tick_contracts (
    source     TEXT NOT NULL,
    instrument TEXT NOT NULL,
    contract   TEXT NOT NULL,
    PRIMARY KEY (source, instrument)
) WITHOUT ROWID;

-- Date-range pulls (JSON), kept so a pull resumes after a restart and protects its days.
CREATE TABLE tick_pulls (
    id      TEXT    NOT NULL PRIMARY KEY,
    body    TEXT    NOT NULL,
    updated INTEGER NOT NULL
) WITHOUT ROWID;
