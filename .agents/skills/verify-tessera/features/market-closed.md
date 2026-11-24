# Market closed

With the market closed (a weekend, a holiday, the daily halt, or before the Sunday reopen) every panel shows the last session and says once, quietly, when the market opens again. Nothing reads as an error: the studies draw the last session from the prints read back or stored, the T&S lists its last prints, and the DOM keeps its last book, dimmed, taking no order.

## Sub-features

- `closed-note` the chart's toolbar ends with `status` `Closed · opens 18:00 ET` (the day comes first when it is not today: `Closed · opens Sun 18:00 ET`; a holiday names itself: `Thanksgiving Day · opens 18:00 ET`; the halt reads `Daily halt · opens 18:00 ET`). The words come from the instrument's calendar (`market.get_sessions`) at the runtime's clock, in the exchange's time, and go the moment the session opens.
- `closed-status` with nothing wrong, the status line at the foot of the desk names the active chart's instrument and reads the same note (`NQ Z6  Daily halt · opens 18:00 ET`). A connection that is really in trouble still comes first.
- `closed-quiet` a closed market's silence is not a lost connection: no stream is dropped and opened again, nothing is replayed into the break, and the status line never says `No data for … seconds. Reconnecting.` Silence counts only while the market is open, from its reopen: at 18:00:15 a feed that has not printed yet is fifteen seconds quiet, not an hour.
- `closed-dom` the DOM's strip reads the same note in place of a loading skeleton or `Book … s behind`; the ladder dims, and a press on it is refused with `Market closed`. A dropped connection still says so first.
- `closed-tape` the T&S lists the last session's prints, newest first. On a fresh install the runtime answers its first read `filling` while it replays that session (`market.get_trades` with no `from`), and the T&S asks again until the prints are in. Only while it has no print to show does its pill read the closed note.
- `closed-studies` the footprint, volume profile and CVD draw the last session; big trades marks no gap while an answer is still sizing its Auto model, its events and gaps waiting for the settled answer.

## How to get to it (user POV)

- Open Tessera on a weekend, before 18:00 New York on Sunday, or during the daily halt. A fresh install logs in first.

## Driving it

The e2e session's frozen clock is a Friday afternoon, so it never shows this. `../scripts/market-closed.ts [evidence dir] [ui dir] [pr|main]` starts its own sim runtime as a fresh install on Sunday 4 Oct 2026 12:00 New York (`TESSERA_TEST_NOW`) behind the fake Rithmic login (`TESSERA_TEST_MARKET=rithmic`: no trade history, its tick replay paced like Rithmic), logs in through the first-run dialog, turns the history offer down, opens the Scalp preset and waits 90 s. It saves `<scene>-desk.png` and `<scene>-report.json` (the legend rows, the chart's and DOM's notes, the newest T&S times and any read the runtime refused), and in the `pr` scene fails unless the chart and DOM read `Closed · opens 18:00 ET`, the T&S lists prints, no legend row says `stopped` or `no tick history`, and no read failed. To shoot main the same way, pass main's `tessera-test-runtime` as `TESSERA_TEST_RUNTIME_BIN`, main's `dist` as the ui dir and `main`.

The daily halt: `../scripts/daily-break.ts [evidence dir] [ui dir] [pr|main]` starts a sim runtime frozen at Thursday 5 Nov 2026 17:05 New York behind the fake Rithmic login, opens the Scalp preset and watches the status line for 120 s, four times the 30 s silence limit. It saves `<scene>-desk.png` and `<scene>-report.json` (every status line it saw, the legend rows, the chart's note, any read the runtime refused) and in the `pr` scene fails unless the status line reads `Daily halt · opens 18:00 ET`, it never said reconnecting, no data or filling, CVD's legend shows no error, and no read failed.

- **Proof in tests.** `cargo test -p tessera-market --test stored_studies the_newest_prints a_fresh_install`, `cargo test -p tessera-market --test hub the_daily_break`, `cargo test -p tessera-core open_for`, `bunx vitest run apps/desktop/test/market-sessions.test.ts apps/desktop/test/tape.test.ts apps/desktop/test/dom-ladder.test.ts apps/desktop/test/flow-hub.test.ts apps/desktop/test/annunciator.test.tsx`.

## Gotchas

- The sim's mock always holds a book and a quote, so its closed DOM shows Friday's last book; a connection that sends no book on a weekend shows the same note over an empty ladder.
- Big trades on Auto shows no bubble until its model's five sessions are pulled (`order-flow.md`, Gotchas); on a fresh install that takes minutes, and its legend reads `Auto low` meanwhile.
