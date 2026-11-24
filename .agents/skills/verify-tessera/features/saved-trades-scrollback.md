# Saved trades: scroll back

On a connection that keeps no trade history (Rithmic), the hub saves every print it records and every span the tick replay answers, reads saved days before it asks the connection, and pulls older sessions when a footprint, delta or volume-profile layer is scrolled past what is saved. Every read answers every stored print in its range at once and names its `gaps`; the desk draws it, and asks again while the answer says `filling`, the settled answer landing in one change. The big-trade model pulls the part of its five trailing sessions that is not saved, once the session read has ended, so a fresh install scores big trades against whole sessions.

## Sub-features

- `st-reopen` a chart reopened on a session saved whole asks the connection nothing.
- `st-partial` a partly saved session asks only the spans it misses.
- `st-scroll` scrolling past the saved days pulls older sessions, newest half hour first, one request at a time, and saves them; a second read asks nothing.
- `st-refused` the pull stops where the connection refuses: the answer stops `filling`, its `gaps` stay, and the bars there stay plain candles over the time axis's faint gap strip, with no words in any legend (`order-flow.md`, `of-tick-gaps`). It is not asked again at once; a read a minute later asks for the span again, then after 2, 4 … up to 30 minutes, and fills it when the connection answers.
- `st-older-than-a-hole` a stored day older than a hole is read like any other: one unstored day or hour hides nothing beyond itself, with the market open or closed (`order-flow.md`, `of-stored-history`).
- `st-pinned` a day a chart shows outlives the prune of old sessions until the chart closes.
- `st-desk-wait` the footprint feed draws each answer at once and asks the same page again while it says `filling`; answers between are dropped and the settled one replaces it in one change.
- `st-model` on an empty data directory the big-trade model's five trailing sessions are pulled after the session read, never during it; meanwhile `market.get_big_trades` answers `filling` and the desk draws it and reads it again until it settles, so the first chart's big trades take their tiers in one change without a reload, and the live stream holds a big trade until it can score it.

## How to get to it (user POV)

- Open a footprint chart on a Rithmic instrument and scroll left past the session's open.
- `st-model`: open the Scalp preset (big trades on) on a fresh install.

## Driving it

- **The sim needs `TESSERA_TEST_TRADES=replay`** (`docs/dev.md` §9). Without it the mock market keeps its own trade history, so the hub records nothing and no read is ever answered from saved days. With it the mock keeps none and answers only tick replays, as Rithmic does. An e2e MCP session passes the runtime only the variables in `e2e.config.ts`'s `passEnv`, so start the runtime by hand: `TESSERA_TEST_TRADES=replay TESSERA_NO_RITHMIC=1 TESSERA_TEST_RUNTIME_BIN=<built tessera-test-runtime> node e2e/agent/support/serve.ts --port <port>` with `TMPDIR` set to a directory of your own (the info file `$TMPDIR/tessera-e2e-agent-<port>.json` lands there, and `runtime.ts` reads it from the same `TMPDIR`), then drive it with Playwright from a script outside the repository, opening `<origin>/#ticket=<ticket>` from that info file. Never add a login; agents never log in to Rithmic.
- **`st-model` on the sim.** Open the Scalp preset (`order-flow.md`) once, with no reload. Within 30 seconds `runtime.ts <port> market.saved_trades` lists `NQZ6.CME` from 2026-09-25 to 2026-10-02 (6 days: the five sessions before Oct 2, and Oct 2), and the 1m chart's bubbles appear on Auto, the legend reading `Auto low ≥ <cut>` and each bubble's tooltip carrying its `Tier` (`High`, `Medium` or `Low`). `market.get_big_trades '{"instrument":"NQZ6.CME"}'` answers `rule.modelSessions` 5 and a `rule.cuts` that is not null, with its `low`, `medium` and `high` sizes. While the pull runs nothing is drawn behind the bars and the legend says nothing about it (`order-flow.md`, `of-loading`).
- **Proof in tests.** `cargo test -p tessera-market --test saved_trades` covers `st-reopen`, `st-partial`, `st-scroll`, `st-refused` (with `a_span_the_connection_refused_is_asked_again_after_a_wait_and_fills`), `st-pinned` and `st-model` with a connection that replays trades and counts every request, and `cargo test -p tessera-market --lib hub::disk` the waits between asks; `cargo test -p tessera-market --test stored_studies` and `cargo test -p tessera-indicators --test flow cvd_counts_every_stored_session_with_the_market_closed` cover `st-older-than-a-hole` on a Saturday with replays refused. `bunx vitest run apps/desktop/test/flow-hub.test.ts -t "still filling"` covers `st-desk-wait`.
- **Without the variable** the sim still shows scroll-back paging older bars from the mock's history (`order-flow.md` for zooming the chart), because the mock answers every older page whole.

## Gotchas

- The model asks for its sessions only while the instrument records (a chart shows it, or an agent's read keeps it recording for a minute). A pull cut short by the chart closing resumes at the model's next read.
- The Scalp preset's volume profile reads 10 sessions (`market.get_volume_profile` with `sessions` 10). On the first open that read runs during the session read and pulls nothing; after a reload it pulls the 10 sessions itself. To see the model's own pull, read `market.saved_trades` before any reload.
