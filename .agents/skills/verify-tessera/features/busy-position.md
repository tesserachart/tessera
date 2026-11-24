# A position on a busy tape

With a position and its stop and target open, the desk keeps up with a busy tape as it does flat. With a position open the runtime sends a position and an account update on every quote. The app reads them once a frame, as it reads quotes, and only what shows P/L re-renders: the chart's position tag, the ticket's read-out, and the Positions and Accounts rows. The chart tiles, their legends and drawing rails, the area rail and the rest of the ticket stay as they are. An order tag is measured again only when its text changes width, never for a P/L that keeps its digit count.

## Sub-features

- `busy-position-fps`: with the position open, the page's frame rate and idle time stay near what they are flat, and no "… behind" shows.
- `busy-position-actions`: Reverse and Flat show on the page within a few hundred milliseconds of the runtime taking them.
- `busy-position-money`: the ticket's Open P/L and Today keep exactly two decimals on every tick, so neither row changes width or moves its digits while the price moves.
- `busy-position-partial-target`: when a bracket's target fills in part, its stop shrinks to what the target left, so a stop hit closes the rest and never opens a reverse position.

## How to get to it (user POV)

- The Trade ticket: `Stop distance` and `Target distance` under `region "Bracket"`, then `button "Buy market"`, `button "Reverse"` and `button "Flat"`.
- `"Paper read-out"`: `Position` reads `+1 @ …`, then `−1 @ …` after Reverse, then `Flat`.
- The NQ chart's position tag (`group "Long 1 · … · …"`, test id `tag-entry`) with its P/L moving on every quote.

## Driving it

An e2e session runs the frozen market, where nothing ticks, so this feature runs on the busy market (`docs/dev.md` §9) from a script.

Preconditions:

- A built UI (`bun run build`).
- A sim runtime on the busy market, started by hand: `TESSERA_TEST_MARKET=busy node e2e/agent/support/serve.ts --port <port>`. Point `TESSERA_TEST_RUNTIME_BIN` at a built `tessera-test-runtime` to skip the cargo build. It writes `$TMPDIR/tessera-e2e-agent-<port>.json`.
- A quiet box: the script compares the page against itself flat, so it holds on a loaded box, but a box above load ~20 makes both runs noisy.

Recipe:

- `node .agents/skills/verify-tessera/scripts/busy-position.ts <port> [evidence dir]`. It refuses any runtime that is not the sim on paper accounts. It measures the page flat (frames a second, and idle time from a 10 s CPU profile), sets a 400-tick stop and an 800-tick target, buys 1 NQ on `Paper`, and holds it 36 s while it samples frames and the "behind" label. It then taps `Reverse` and `Flat`, timing each from the click to the runtime's position (`portfolio.get_positions`) and to the ticket's `Position`.
- End state: it prints `ok: evidence in <dir>` and exits 0. The page never said "behind", the open frame rate's median is at least three quarters of the flat one, and Reverse and Flat each showed on the page within 2 s of the runtime. `busy-position.json` holds the numbers; `1-open.png`, `2-reversed.png` and `3-flat.png` the screen. Stop the runtime with `kill` on the pid listening on its port.

### Money that holds still

- Same preconditions. `node .agents/skills/verify-tessera/scripts/money-steady.ts <port> [evidence dir] [contract]` buys 1 on `Paper` with a 400-tick stop and an 800-tick target, then reads the `"Paper read-out"` rows `Open P/L` and `Today` 80 times, 150 ms apart: each value's text, its right edge, and the x of its dollar units digit. Pass `MNQ Z6` as the contract for a P/L that moves in half dollars, the case that once dropped and regained cents.
- End state: it prints each row's summary and `ok: evidence in <dir>`, and flattens. Every sample ends in two decimals, the right edge never moves, and the units digit never moves between samples of one length. `money-steady.json` holds every sample; `readout-*.png` six frames of the read-out, `desk.png` the desk.

### Target filled in part

- Same preconditions. `node .agents/skills/verify-tessera/scripts/partial-target.ts <port> [evidence dir] [attempts]` picks `NQ Z6` in the ticket's contract combobox, sets 2 contracts, a 400-tick stop and an 8-tick target, and taps `Buy market` until an attempt's target fills in part (usually within five).
- End state: it prints that entry's order events from `journal.get_activity` and `ok: evidence in <dir>`, for example `take_profit part_filled qty 2 filled 1`, then `stop_loss qty_changed qty 1`, then `take_profit filled` and `stop_loss cancelled`. `target-in-part.txt` holds those events, `partial-target.json` every attempt, and `attempt-<n>-2-flat.png` the desk, whose `Fills today` shows the target's two fills of 1 and no stop fill.

## Gotchas

- The busy mock trends hard: a 40-tick bracket fills or stops within seconds, which is why the script uses 400 and 800 ticks.
- On Paper a target's part fill and the rest land within a millisecond, so no screenshot catches the stop at its smaller size; the order events are the proof. Paper fills a triggered stop whole, so a stop filled in part shows only in `crates/tessera-broker/tests/firm_exits.rs` and the fake Rithmic gateway's tests in `crates/tessera-rithmic/tests/orders.rs`.
- `apps/desktop/test/position-ticks.test.tsx` covers the parts a script cannot see: a P/L-only tick measures no tag, the desk's shell data does not change on a tick, and the position and account streams report once a frame.
