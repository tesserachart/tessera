# Saved trades

Settings › Data shows the trades saved on this machine (`ticks/ticks.db`): their size on disk, how many sessions of each contract are kept, and each saved contract with its days, prints and size. A date-range pull fetches every trading day of a range through the data connection and saves it; a saved range or contract exports to one CSV per trade date. On the sim runtime the mock market keeps its own history, so a pull asks it `get_trades`.

## Sub-features

- `saved-disk` shows the tick store's size (`row "On disk"`, and `Saved trades` in the files list) and its path.
- `saved-keep` edits the sessions kept per contract (setting `market.savedTradeSessions`, default 60).
- `pull-start` starts a pull: contract or root, first and last day, RTH or full session.
- `pull-progress` shows where a running pull stands (`Fetching Sep 24 · 46%`) and what its days became (fetched, already saved, without trades, older than the connection keeps, not all sent yet, failed).
- `saved-auto` the `Download missing data automatically` switch in `region "Saved trades"` turns `market.autoDownload` on and off.
- `pull-actions` cancels, resumes, exports and releases a pull.
- `pull-restart` a running pull resumes after a restart by itself, waits (`Waiting for <connection> to connect`) until its connection serves the contract, and asks nothing it saved before.
- `pull-agent` a pull started by an agent or MCP client (`market.pull_trades`) shows in an open Settings › Data with its progress, without a reload.
- `saved-prune` with fewer sessions kept, a release deletes the older days and gives their disk space back before it returns.
- `pull-auto` with `Download missing data automatically` on (setting `market.autoDownload`, the default), `market.data_coverage` (a Research run's `Saved data`, the analyst) starts downloading the missing days the connection keeps by itself; the coverage card shows no Download button, only `Downloading N days…`, then `Downloading · n of N days · <day>, n of m half hours · <time> left`, then `Saved · N days`. A day the connection has not sent all of yet (`Later`) or did not answer (`Failed`) is asked again on its own, less often each time; a day whose session ends joins its pull. Off, nothing downloads until the user presses Download.
- `pull-card` the coverage card counts each lane's saved days, names each run of missing days with its reason (`older than Mock market keeps`, `today's session is still open`, `<connection> has not sent all of it yet`), offers `Download N days` (only days a download can fetch, and only with the setting off) for missing prints, follows the download, and ends at `Saved · N days` with Prints at `N of N days saved`.
- `pull-blocked` while the connection cannot answer (Rithmic: `the connection was taken by another login` when R Trader takes the same login) a pull waits instead of failing days, and says why: `Downloading · … · waiting for <connection>: <reason>`.
- `saved-export` writes `<ROOT>-<YYYY-MM-DD>.csv` files (`ts_ns,price,size,side`) into the folder in `row "Export to"`; `tessera-runtime ticks export` writes the same files with the app open or closed.

## How to get to it (user POV)

- Settings in the rail, then `button "Data"`: `region "Saved trades"` and `region "Pull a date range"`.
- Research › a study's run › `Saved data`: the coverage card.
- The tools `market.saved_trades`, `market.pull_trades`, `market.list_pulls`, `market.cancel_pull`, `market.resume_pull`, `market.release_pull` and `market.export_trades`. `market.list_pulls` with `{}` lists the newest 10 pulls with only their open days; `id`, `instrument` (`NQ` takes `NQZ6`) and `state` filter, `limit` caps, `days: "all"` lists every day, and `omitted` counts what the limit left out. Settings › Saved trades asks for every pull and day.

## Driving it with the e2e MCP

Preconditions:

- The baseline in `README.md`.

- **Before.** `region "Saved trades"` shows `On disk` with a size and the path `<data dir>/ticks/ticks.db`, and `Sessions kept per contract` at 60.
- **Pull RTH.** In `region "Pull a date range"`, type `NQ` in `textbox "Contract or root"`, `2026-09-21` in `First day`, `2026-10-01` in `Last day`, tap `button "RTH"`, then `button "Pull"`. A row `NQ · Sep 21 to Oct 1, 2026 · RTH` appears with `Fetching Oct 1 · n%`, then `Done` and `9 of 9 days · 9 fetched · …prints`. The weekends are not among the 9 days.
- **Pull full session over saved days.** Pull `2026-09-28` to `2026-10-01` with `button "Full session"`. It ends `4 of 4 days · 4 fetched` with fewer prints than four whole sessions: their RTH hours were on disk and were not asked again.
- **Already saved.** Pull a range already saved (the same RTH range again, or `2026-09-14` to `2026-09-18` RTH after a full-session pull of it). It ends `5 of 5 days · 5 already saved` and asks nothing.
- **Export.** Tap the pull's `button "Export"`. Its help reads `9 files in <data dir>/exports`. Each file is `NQ-2026-09-24.csv` and starts `ts_ns,price,size,side`.
- **CLI.** With the app running, `target/debug/tessera-runtime ticks export --data-dir <data dir> --instrument NQ --from 2026-09-21 --to 2026-10-01 --rth --out <dir>` prints one JSON line and writes files identical to the app's (`diff -r`).
- **Cancel, resume, release.** `runtime.ts <port> market.pull_trades '{"instrument":"NQ","from":"2026-09-14","to":"2026-09-18","scope":"session"}'`, then at once `market.cancel_pull '{"id":"NQ-2026-09-14-2026-09-18-session"}'`: `state` is `cancelled`. `market.resume_pull` with that id ends `done`. `market.release_pull` removes it from `market.list_pulls`.
- **Agent pull.** With Settings › Data open, `runtime.ts <port> market.pull_trades '{"instrument":"NQ","from":"2026-09-14","to":"2026-10-01","scope":"session"}'`. Within five seconds the row `NQ · Sep 14 to Oct 1, 2026 · full session` appears with `Fetching … · n%`.
- **Restart.** The e2e session cannot restart its runtime on the same data directory: start the sim runtime by hand as `order-flow.md` does for the busy market, but without `TESSERA_TEST_MARKET`, on a data directory you keep, start the agent pull above, kill the runtime once `market.list_pulls` shows 4 days saved, and start it again on the same directory. The pull ends `done` with `failed` 0 by itself; the days saved before the kill have the same `tick_blocks` rows (read `ticks.db` read-only), and each day fetched after it has as many prints on disk as its status says it fetched.
- **Room back.** After the restart run (14 days), type `3` in `Sessions kept per contract`, press Enter, and tap the pull's `Release`. `On disk` and the files list's `Saved trades` read about 7 MB; read-only sqlite on `ticks.db` gives `PRAGMA freelist_count` 0 and a main file of `page_count × page_size` bytes.
- **Coverage card, automatic.** Research › `New study`: a name and a hypothesis, `From` `2026-09-22`, `To` `2026-09-25`, `Regular hours only` (tap its label), then `Run exploratory`. Under `Saved data` the card has no Download button and reads `Downloading 4 days…` or `Downloading · n of 4 days · …`, then within seconds `Saved · 4 days` with Prints `4 of 4 days saved`. `runtime.ts <port> cards.get '{"cardId":"card-NQZ6.CME-2026-09-22-2026-09-25-rth"}'` gives `body.download.state` `done` and `auto` true, as `market.list_pulls` does for its pull.
- **Coverage card, by hand.** Turn `Download missing data automatically` off in Settings › Data, then run a study over `2026-09-14` to `2026-09-17`. The card reads Prints `0 of 4 days saved · 4 missing` with `Download 4 days`; tap it. It reads `Downloading · …`, then `Saved · 4 days`. Turn the switch back on afterwards.
- **Out of reach.** `runtime.ts <port> market.data_coverage '{"instrument":"NQZ6","from":"2026-08-03","to":"2026-08-04"}'`: each day has `outOfReach` true and `note` `older than Mock market keeps`, the card offers only `Check again`, and `downloading` is false.
- **Refused value.** Type `1` in `Sessions kept per contract` and press Enter: the field shows the value kept before, with `Must be ≥ 2` beside it.
- **Stored.** `runtime.ts <port> market.saved_trades` lists `NQZ6.CME` from `mock` with the days and prints the contract row shows; `runtime.data_info` lists a file with `what` `ticks`.

## Gotchas

- The frozen clock is Fri 2 Oct 14:42: today's hours have not ended, so a range reaching Oct 2 plans up to Oct 1 (Oct 2 joins when the same range is pulled after its hours end).
- The mock keeps about 20 calendar days of prints; older days are `older than the connection keeps` and ask nothing.
- On the mock a pull of a few days takes seconds, so a cancel has to follow the start at once to catch it running.
- With `market.autoDownload` on, every `market.data_coverage` of a range with missing days adds an automatic pull to Settings › Data; turn it off before a drive that counts the pulls.
- A card's id is `card-<pull id>`, and the pull id names the contract the run used (`NQZ6.CME-…`), not the root.
- A card that missed the download's last change stays at `Downloading` while `market.list_pulls` says `done`. One drive rarely shows it: compare `cards.get` with `market.list_pulls` over many pulls.
- `tessera-runtime ticks export` needs the runtime binary of this checkout (`cargo build -p tessera-runtime`), not the sim runtime binary.
