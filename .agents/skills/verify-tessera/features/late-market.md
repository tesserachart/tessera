# Late market

The desktop app opens its desk before a saved Rithmic login is read from the keychain and logged in. Everything the desk asked in that window must arrive once the connection serves, with no reload: the runtime refuses a market subscription it cannot serve yet with the `unavailable` code (-32015) and the page asks again; tool reads and market reads that failed are asked again when the `health` topic shows a market-data connection serving; the hub replays the session, builds footprints and big trades, and sends the current quote once the connection is in.

## Sub-features

- `late-none` the desk opened with no market-data connection at all: the ORB legend reads `unavailable: no market-data connection is configured`, the charts `did not load`, the ticket `Buy bid —`.
- `late-login` the connection is added but still logging in: the legend reads `connecting to the mock market`.
- `late-served` once it serves, without a reload: the charts draw, every indicator row has values, `Buy bid` and `Sell ask` show prices and `Buy market` is enabled, and a market order fills into the read-out's Position, Open P/L and Today.

## How to get to it (user POV)

- Start the app with a saved login; the Connect screen's `Not now` shows the desk while it logs in.

## Driving it

An e2e session cannot pass these variables, so start the runtime by hand and drive it with Playwright from a script outside the repository. The default layout gets its charts only when a market resolves its instruments, so make the desk first:

1. Start `tessera-test-runtime serve --port <port> --ui-dir apps/desktop/dist --data-dir <dir> --launch-tickets` with `TESSERA_NO_RITHMIC=1`, open `<origin>/#ticket=<ticket>` from the `launch` line, add a custom indicator to the active chart (`indicators.create_custom`, `chart.add_layer` without `tileId`), and stop the runtime.
2. Start it again on the same `<dir>` with `TESSERA_TEST_MARKET_AFTER_MS=20000 TESSERA_TEST_MARKET_LOGIN_MS=35000`, open the new ticket, tap `Not now`.
3. Read the legend (`[data-layer]`), the ticket's `Buy bid`/`Sell ask` buttons and the read-out (`.t-readout-row`) at about 12 s (`late-none`), 28 s (`late-login`) and 50 s (`late-served`), then tap `Buy market`.

- **Proof in tests.** `cargo test -p tessera-market --test hub quotes_` and `--test analytics logs_in`, `cargo test -p tessera-indicators --test custom unavailable`, `bunx vitest run packages/protocol/test/runtimeClient.test.ts apps/desktop/test/market-served.test.ts`.

## Gotchas

- The mock market logging in skips its ticks, and the frozen market never ticks: the bid and ask come from the quote the hub sends once the connection serves.
- The `health` topic is sent on every change of connections and every 5 s, so the desk's reads are asked again within about 5 s of the login.
