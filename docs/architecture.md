# Architecture

```
┌──────────── Tessera.app (Tauri 2 shell) ──────────────────────┐
│  React UI (Vite)  ── WebSocket JSON-RPC + session token ──┐   │
└───────────────────────────────────────────────────────────┼───┘
                                                            ▼
┌──────────── tessera-runtime (Rust sidecar) ─────────────────────────┐
│ tool registry · permission gate · approvals · event bus · storage   │
│ market data · brokers · level providers · indicators · research     │
│ journal · alerts · agents (Codex / Claude Code) · MCP server        │
└─────────────────────────────────────────────────────────────────────┘
      ▲ MCP (session and client tokens)       ▲ R|Protocol, HTTPS
  the analyst's CLIs, the user's own agents   Rithmic, level providers
  (mcp-stdio shim)
```

## Principles

- **The runtime owns all state and logic.** The UI is a view plus input. Closing it loses nothing.
- **Every action is a tool.** The UI calls tools as `user`, the analyst as `agent`, MCP clients as `external`. One permission gate (read, modify, financial) and one audit log cover them all. An agent's order waits for the user's approval unless the user turned on Full access for that session.
- **User-only:** secrets, approvals, risk limits, the analyst's own mode and brief.
- **Providers behind interfaces:** market data, brokers, level sources and agents are traits. Rithmic, the paper broker, the user's level sources, Codex and Claude Code are implementations.
- **Only the user's own data:** market data comes from the user's connections (a Rithmic login today), levels from sources they add. With none connected there is nothing to chart. Paper trading fills at the prices of the user's market data.
- **High-frequency data never goes through React.** It streams into the chart engine and small stores.
- **One stream per market in a window:** every chart, DOM, time and sales and ticket shares a market's bars, flow and quote (`docs/dev.md` §12).

## Repository

- `crates/`
  - `tessera-runtime`: the process. It wires every module and serves the UI and the WebSocket. Its session runner (`session_runner/`) lets the analyst trade on its own while the CME market is open, one session from each open to the next break, on one account and under its limits, and posts a report of each.
  - `tessera-core`: domain types every crate shares (instruments, contract specs, bars, money, time, orders, accounts, levels), the session calendars and the futures product table.
  - `tessera-host`: the module contract: the event bus, topics and runtime modules the domain crates plug in as.
  - `tessera-tools`, `tessera-protocol`: the tool registry, the gate, approvals and audit, and every input and output type. `bun run gen` writes their TypeScript bindings to `packages/protocol/src/gen` and a zod schema for each to `packages/protocol/src/schemas.gen.ts`.
  - `tessera-market`: market data, the market router, bar history, order flow and replay.
  - `tessera-broker`: orders through `GuardedBroker`, the user's risk limits, the paper broker, position brackets and the trade copier.
  - `tessera-rithmic`: the R|Protocol client for data and orders.
  - `tessera-intel`: levels from built-in and spec-defined HTTP providers, and their history.
  - `tessera-concepts`: levels Tessera computes from a market's own data (prior day, volume profile, initial balance) and ATR.
  - `tessera-script`, `tessera-indicators`: one engine for user code, JavaScript in an embedded QuickJS with no host access: custom indicators, study strategies and level-file adapters (`docs/indicators.md`). `tessera-indicators` also keeps every indicator's values.
  - `tessera-research`, `tessera-journal`: studies and backtests; the trade journal.
  - `tessera-alerts`: alerts the runtime keeps and evaluates with the window closed. A firing is audited (`alerts.fire`), published on the `alerts` topic and posted to the user's Discord webhook, which lives in the secret store.
  - `tessera-agent`, `tessera-mcp`: the analyst's CLIs and the MCP server. The user's own agents reach it through `tessera-runtime mcp-stdio` with a token of their own (`docs/dev.md` §13).
  - `tessera-store`: SQLite, a blob store, and the bar, tick and depth databases.
  - `tessera-cloud`: Tessera Cloud's client.
  - `tessera-testkit`: test support only. The runtime binary never links it. It holds the fake connections (the mock market, mock levels, a read-only prop firm login, a fake Rithmic gateway and fake level vendors) and the `tessera-test-runtime` binary the e2e suite serves.
- `apps/desktop`: the React app and `src-tauri`, the shell that runs the runtime as a sidecar. Sounds and voice packs live in `src/sound/` (`docs/dev.md` §16).
- `apps/cloud`: Tessera Cloud (below). `apps/site`: the marketing site, a static Astro build.
- `packages/chart`: Tessera's own chart engine (layered canvases). `packages/ui`: components and tokens. `packages/bridge`: Tauri vs browser. `packages/protocol`: `RuntimeClient` and the generated types.

## Connections and exchanges

Settings › Connections holds the user's connections and says where each exchange's data comes from and where its orders go. `market.dataSource` is the default data connection; `market.dataByExchange` gives an exchange its own. `MarketRouter` binds every instrument to the data connection of its exchange. `trade.accountByExchange` is the account a chart's Trade panel uses for that exchange unless the chart picked its own.

Rithmic allows one session per login. When another session of the same login logs in, Rithmic sends a ForcedLogout. Tessera logs in again once. A second ForcedLogout within ten minutes means the other session took the seat back: the connection stays logged out (`Phase::TakenOver` in `tessera-rithmic/src/session.rs`) until the user reconnects.

An account's kind (evaluation, funded, live, broker simulation) comes from its connection (`tessera-rithmic/src/firms.rs`). The user's own choice (`accounts.types`) wins. It changes labels, safety cues and which rules apply, never order entry.

## Orders and risk

Every order goes through `GuardedBroker`, one call per send (`submit`, `modify`, `cancel`, `attach`), which checks the account's route at that moment. A bracket's stop carries its breakeven and trailing rules (`StopRules::next_stop` in `tessera-core`). The paper broker moves the stop itself; for Rithmic the bracket manager (`tessera-broker/src/protect/`) moves it by a modify, audited as `orders.protect`.

A paper account takes only what a real futures account could (`paper/room.rs`): an order that opens contracts needs their CME initial margin out of buying power, and no order opens more than a retail account may hold. Exits and reductions always go.

When an account reaches its daily loss limit, Tessera locks it (`lockout.rs`): it cancels working orders, closes positions, and refuses new entries until the next session opens at 18:00 New York.

The trade copier (`tessera-broker/src/copy/`) mirrors one leader account's orders on its followers. A follower's size is a target position (`follower_qty` in `model.rs`), so rounding never drifts. A follower may trade the micro of each full-size contract. Every copy takes the plain order path, with its own order-entry check, limits and bracket. `sync.rs` measures each follower against its leader and publishes `copy.sync` when that changes. `copy.resync` and `copy.flatten` are the user's alone. Groups live in the settings under `copy.groups`.

## Time

Every time Tessera shows a person is in one zone, `display.timeZone` (Settings › App › Time zone), which defaults to the computer's own. What an exchange defines in its own time keeps it: a contract's trading day, session windows, the loss limit's reset.

Every instrument trades on a session calendar (`tessera-core/src/session.rs`): trade dates, session windows, RTH, early closes and holidays. CME futures take theirs from their product family (`SessionCalendar::of_cme_root`). A CME product outside the table keeps the Globex week with no RTH. Bars, footprints, profiles and the agent (`market.get_sessions`) all read the same calendar.

## Bar history

Bars live in the runtime, never in the UI. `bars.db` (`tessera-store/src/bars.rs`) keeps each connection's 1-minute and daily bars as served, plus the spans known whole, so a hole is a missing span, never a guess. Every history read goes through `BarCache` (`tessera-market/src/history.rs`): kept bars come from disk, only holes and the tail are asked of the connection, and other timeframes are built from the minutes. `market.get_candles` with `cachedOnly` answers from disk alone, so a chart opens before the connection answers. While a chart is open, a background task fills older minutes and open charts prepend them without moving the view.

A chart can also draw tick, range, volume, delta and renko bars, built in the runtime from prints (`market.get_print_bars`).

The initial balance is a level, not an indicator (`tessera-core/src/initial_balance.rs`): the high and low of the first 30 or 60 minutes after RTH opens (`chart.initialBalanceMinutes`), published as group `ib`.

## Order flow

Footprint, volume profile, CVD and big trades are built from prints. Rithmic keeps no trade history, so the hub (`tessera-market/src/hub/`) records it: every market on the user's watchlists while the app is open and connected (`market.recordWatchlists`), and any other market while a chart shows it. When a recording starts, it reads the session before from the connection's tick replay. Every print is saved per contract and trade date in `ticks/ticks.db` (`tessera-store/src/ticks.rs`), so reopening a saved session asks the connection nothing.

A read answers at once with every print it has, the `gaps` in its range, and `filling` while prints are still being fetched. A bar that touches a gap has no order flow. The desk asks again until the answer settles, then replaces what it drew in one change (`Refill` in `apps/desktop/src/market/flow/hub.ts`). A gap that stays is marked faintly along the time axis (`packages/chart/src/layers/missingPrints.ts`).

The big-trade model (`tessera-market/src/orderflow/big_trades.rs`) sizes each trade date from its five trailing sessions. Each event carries what happened in the next 60 s (`fixtures/orderflow/outcome.json`). The desk sizes each bubble against the size filter's minimum or the tier's cut (`bubbleRadius` in `packages/chart/src/layers/bigTrades.ts`).

`market.pull_trades` fetches a range of days. `market.estimate_pull` says first what that will take, or null when it cannot be measured yet.

## Replay

A chart can play a saved day back (`tessera-market/src/replay/`). `market.open_replay` gives it an instrument of its own (`NQZ6-R1.CME`) that takes no orders and asks no connection anything. Prints come from `ticks.db` as the replay clock passes them; before the clock it serves the stored bars and prints. Nothing after the clock is served until the clock reaches it.

## Chat cards

A tool can answer with a card (`tessera-protocol/src/cards.rs`): a typed body by kind, and actions that are each a tool call. The runtime keeps the newest 200 (`tessera-host/src/cards.rs`) and publishes each change on topic `cards`. The chat shows a card where the call was made and updates it in place. An action runs its tool as the user, through the same gate. The kinds are `data_coverage` (`market.data_coverage`: which days of a market are on disk) and `trading_session` (the session runner's report).

## Indicator values

Every per-bar series a chart draws (built-in studies, session VWAP, volume, delta, CVD, custom indicators) is computed in the runtime by one cache (`tessera-indicators/src/cache.rs`) and kept there. The desk draws what `indicators.series` sends. A frame is one market's bars at one bar type and session filter, with each study's output beside them. An edit (a live tick, a backfill, prints read later) replaces a span of rows, and each study resumes from the first row that differs, so a cached value always equals a full recompute. Updates carry only changed bars. A study that measures each session's opening window (the opening range and initial balance) reads that window's stored one-minute bars into the frame whenever the frame's own bars do not tile it, so every interval, tick bars included, draws the same levels; while a window trades they are read again each second. A frame stays in memory while followed and, idle, within 64 MiB. Agents and alerts read the same frames through `indicators.compute`.

## Tessera Cloud

`apps/cloud` is one Cloudflare Worker (Hono, D1), the only server Tessera has. It knows people, not trading: who someone is, their alpha application, their entitlements (`early_access` today) and a check-in per app launch. It never sees broker credentials, trades or market data, and exits, flatten and cancels never depend on it. The identity provider (WorkOS AuthKit) sits behind its `Identity` interface. Its pages: `/apply` (sign in and apply), `/admin` (approve, decline, invite) and `/invite/<token>`. It also files testers' feedback as GitHub issues labelled `feedback`. Development: `docs/dev.md` §15.

In the app, `crates/tessera-cloud` is Cloud's client and the runtime's `account` module holds the account: sign-in through the system browser (PKCE), the session in the OS keychain. A build without `TESSERA_CLOUD_URL` has no accounts.

## Secrets and data

Logins live in the OS keychain; the database holds only a reference. Debug builds may fall back to files in `~/.config/tessera/secrets/`, and `TESSERA_SECRET_STORE=file` uses only those. The data directory and its files are the user's alone, on Windows through its access list (`tessera_core::private`). Where each file lives: `docs/dev.md` §5.

## Tooling

Bun runs the scripts and cargo builds the Rust. `bun run check` is everything a pull request must pass. CI runs it in one `Check` job; on a pull request it skips the Rust steps when the Rust code reads no changed file (`docs/dev.md` §8).
