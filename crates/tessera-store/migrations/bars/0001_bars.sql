-- The bar store (bars.db): the bars each connection served, kept as it served them, one
-- compressed block per session day (daily bars: one per year), and the spans of time known whole.
CREATE TABLE bar_blocks (
    source     TEXT    NOT NULL,   -- the connection that served the bars (rithmic-apex)
    instrument TEXT    NOT NULL,   -- that connection's instrument id
    series     TEXT    NOT NULL,   -- 1m or 1D
    block      INTEGER NOT NULL,   -- the session day (YYYYMMDD), or the year of daily bars
    first_t    INTEGER NOT NULL,   -- open time of the first bar (ns)
    last_t     INTEGER NOT NULL,   -- open time of the last bar (ns)
    bars       INTEGER NOT NULL,
    data       BLOB    NOT NULL,   -- columnar, zstd
    PRIMARY KEY (source, instrument, series, block)
) WITHOUT ROWID;

CREATE INDEX bar_blocks_by_time ON bar_blocks (source, instrument, series, last_t);

-- Half-open spans [start, end) (ns) whose bars are all in bar_blocks: the connection was asked
-- for them and answered. Disjoint and never touching (merged as they are written).
CREATE TABLE bar_coverage (
    source     TEXT    NOT NULL,
    instrument TEXT    NOT NULL,
    series     TEXT    NOT NULL,
    start      INTEGER NOT NULL,
    end        INTEGER NOT NULL,
    PRIMARY KEY (source, instrument, series, start)
) WITHOUT ROWID;
