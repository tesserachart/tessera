# First week of history

A fresh install's first-run dialog logs in to Rithmic, then offers to download the last week of history for the desk's markets. It says the data stays on this computer, lists each market with its days and measured size, and totals the size and time. Download starts one pull per picked market and the dialog leaves. The status bar counts the days while the pulls run, and the app stays usable. A restart resumes the pulls by themselves. Settings › Data's `The last week` row offers the same list later.

## Sub-features

- `fw-offer` after the login, `dialog "Your market data stays on this computer"` holds a two-sentence lede naming the connection (`Tessera charts the prices of your own feed, Tessera Test · …`), the label `Download the last week`, `group "Download the last week"` with one checkbox row per market (`NQ Z6` … `5 days · about 3.1 MB`), a total (`About 6.2 MB and 2 minutes. It runs in the background while you chart.`), `button "Not now"` and `button "Download"`. The desk's markets are checked; watchlist roots are listed unchecked.
- `fw-unknown` a size or time not measured yet reads `size not known yet` or `time not known yet`, with the reason in a tooltip. The estimates re-read every 2 s until known; on the sim the recording's first prints make them known within seconds.
- `fw-estimate` `market.estimate_pull {"instrument":"NQ"}` answers the pull's `request`, `days`, `saved`, `outOfReach`, `size` (bytes and prints scaled from the same root's saved prints by the 1-minute volume still to fetch) and `seconds` (at the connection's measured pace); each is null until measurable.
- `fw-status` while a pull runs, the footer shows `button "Downloading history: n of m days"` reading `History n/m days`, its tooltip one line per pull. It opens Settings › Data and leaves when no pull runs. Failed days read `History: n days failed` until clicked.
- `fw-later` Settings › Data › `region "Pull a date range"` starts with the `The last week` row: the same list, total and Download.
- `fw-resume` a runtime restarted mid-download resumes the same pulls once the login is back, asking nothing it saved before.
- `fw-filled` afterwards every day of the week has prints and 1-minute bars saved (`market.data_coverage` scope `session`: `printsSaved == days`, `barsMissing: []`), and a pulled day replays from disk.

## How to get to it (user POV)

- A first run with no market-data connection: the login, then the offer.
- Settings › Data › `The last week`.

## Driving it

The e2e session's sim always has its mock market, so the offer never shows there. `../scripts/first-week.ts [evidence dir] [ui dir] [pr|main]` starts its own sim runtime with `TESSERA_TEST_MARKET=rithmic` (no market connection at start; the fake Rithmic login `Tessera Test` / `demo` serves the mock, keeping no trade history and pacing its tick replay like Rithmic). It logs in through the dialog, shoots the offer (with an unknown estimate's tooltip when it catches one, then measured), presses Download, switches the NQ chart to 1m while the status bar counts, opens Settings › Data, stops the runtime once two days are saved, starts it again on the same data directory, logs in again over the runtime's API, and waits for the pulls to end. It then checks the estimate, the coverage and a replay of a pulled day, and saves the runtime's answers and the estimate against what was saved beside the stills. `main` with main's `dist` relays the page as a fresh install (as `connections.md` does) and shoots main's login and Data page. It needs no e2e session.

## Gotchas

- The sim's in-memory keychain forgets the login on a restart, so the script logs in again; a desktop app reads it back from the system keychain.
- `crates/tessera-runtime/tests/first_week.rs` proves the download, the restart and the filled week without a browser.
