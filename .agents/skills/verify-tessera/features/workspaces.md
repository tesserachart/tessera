# Workspaces

A workspace is a named desk: its panels, their docks, tabs and sizes, the maximised panel and its pop-out windows with their bounds and screen. It saves like a document: every change (the user's, a pop-out's or the agent's) stays unsaved until the user saves it, and leaving asks first. The user makes one from a preset or saves the desk as a new one, switches between them from the Tessera menu, and resets any of them to the default (Trade | Analyst on the right, Positions | Accounts at the bottom). A workspace shown for the first time waits under one calm cover until its panels have loaded, then appears whole; a switch back to a recently shown workspace is instant because it stayed mounted.

## Sub-features

- `ws-preset` makes a workspace from a preset (Trade, Scalp, Analyse, Review) and shows it.
- `ws-switch` shows another workspace from `Switch workspace`.
- `ws-kept` keeps the last 3 shown workspaces mounted, so a switch back rebuilds nothing.
- `ws-default` keeps the default workspace: its `Delete…` is disabled.
- `ws-instrument` opens a new workspace on the instrument the desk shows (or the one chosen in Settings › Chart › New charts), and on an empty desk when there is neither.
- `ws-save-as` saves the desk as it stands under a new name (`Save as…`).
- `ws-reset` lays a workspace back to the default panels (`Reset to default`; a preset workspace reads `Reset to <preset>`).
- `ws-calm` a workspace shown for the first time shows `status "Loading the workspace"`, drawn as the desk Skullet last measured, until its DOMs, tapes and panels have loaded, then all of it at once. Its charts hold nothing back: each shows its frame at once and draws its bars when they are in.
- `ws-save` a change marks the workspace edited (the Tessera button carries a small tile, reads `Tessera menu: <workspace> — Edited`, and the menu head reads `<workspace> — Edited`); `Save` (⌘S / Ctrl+S) keeps it, `Revert to saved` (listed only while edited) drops it. Sizes, collapsed edges, focus, maximise, scroll and the chart ticket are not changes; a clean workspace keeps them as they move. A new name and the trade setup are kept at once.
- `ws-leave` switching workspace, `New workspace`, `New from preset`, an agent's `ui.show_workspace` or story preset, and quitting the desktop app ask `Save changes to “<workspace>”?` with `Don’t save`, `Cancel` and `Save` when the workspace is edited; `Don’t save` brings the saved version back. `Save as…` saves the changes under the new name and brings the original back to its saved version. Closing or reloading a browser tab loses nothing: the runtime keeps the unsaved changes and the desk comes back edited.
- `ws-recovered` when the runtime stopped before the user saved or dropped a change (a crash, a kill), the next launch says `Tessera closed before you saved “<workspace>”` / `Your unsaved changes are back.` with `Revert to saved` and `Keep changes`; `layout.list` marks the workspace `recovered`.
- `ws-windows` a workspace closes its pop-out windows when another one is shown and opens them again (at their bounds) when it comes back; a window whose screen is gone docks in the main window instead.

## How to get to it (user POV)

- The Tessera menu at the top of the rail, `button "Tessera menu: <workspace>"`. On every workspace it lists `Switch workspace`, `New workspace`, `New from preset`, `Save`, `Save as…`, `Revert to saved` (while edited), `Rename…`, `Reset to default` (`Reset to <preset>` on a preset workspace), `Delete…`, `Panels`, `Arrange charts: …` and `Send feedback…` (the desktop app adds `Check for updates`); a workspace that is not the default adds `Set as default`.

## Driving it with the e2e MCP

Preconditions:

- The baseline in `README.md`: doctor prints `workspace: Day · NQ/ES`.

- **Note the desk.** Run `observe` and note the node ids of `region "NQ Z6 5m"` and `region "ES Z6 1m"`.
- **Open the menu.** Tap `button "Tessera menu: Day · NQ/ES"`. `menu "Tessera menu: Day · NQ/ES"` lists the entries above, with `menuitem "Delete… the default"` `[disabled]`.
- **New from preset.** Tap `menuitem "New from preset"`, then `menuitem "Scalp 1m order flow, Trade, DOM and time & sales"`. The button reads `Tessera menu: Scalp`, and `main "Workspace"` holds `region "NQ Z6 1m"`, `region "NQ Z6 · DOM"` and `region "NQ Z6 · T&S"`.
- **Switch back.** Tap `button "Tessera menu: Scalp"`, `menuitem "Switch workspace"`, then `menuitemradio "Day · NQ/ES NQ Z6 5m · ES Z6 1m default"`. The button reads `Tessera menu: Day · NQ/ES`, and `region "NQ Z6 5m"` and `region "ES Z6 1m"` are back under the node ids noted at the start.
- **New workspace follows the desk.** With `region "NQ Z6 5m"` active, tap `button "Tessera menu: Day · NQ/ES"` and `menuitem "New workspace"`. `button "Tessera menu: Workspace 2"` and `main "Workspace"` show `region "NQ Z6 5m"`; `layout.list` has the new `ws-…` with `chart-1` on `NQZ6.CME`.
- **No instrument yet.** On a desk with no charts and `ui.preferences.recentSymbols` empty (clear `default`'s charts and the recents with `runtime.ts`), the same menu item opens `heading "No chart open"`; `layout.list` has the new `ws-…` with no charts.
- **Save like a document.** On `Day · NQ/ES`, click `region "NQ Z6 5m"`, press Ctrl+K, type `Timeframe 15m` and Enter. The button reads `Tessera menu: Day · NQ/ES — Edited` and `layout.get '{"layoutId":"default"}'` has `"unsaved": true`. Open the menu, tap `menuitem "New workspace"`: `dialog "Save changes to “Day · NQ/ES”?"` shows. Tap `button "Don’t save"`; back on `Day · NQ/ES`, `region "NQ Z6 5m"` shows and `layout.get` has chart-1 on `5m` with no `unsaved`. Change it again and press Ctrl+S: the mark goes and `layout.get` keeps `15m`.
- **Recovered after a crash.** The session's runtime cannot be killed and restarted on the same data, so `ws-recovered` is proved by the Rust test `crates/tessera-runtime/tests/workspace_save.rs` and by a hand-started `tessera-test-runtime serve --data-dir <dir>` killed with SIGKILL and started again on the same `<dir>`.
- **Stored.** Run `runtime.ts <port> layout.list`. `layouts` holds `Day · NQ/ES` (id `default`) and `Scalp` (id `ws-…`), and `activeId` is `default`.

## Gotchas

- Quitting asks only in the desktop app (its close button, Alt+F4, ⌘Q): `bun run e2e:tauri` drives it. In a browser the tab is not the app, so nothing asks.

- A node id is e2e's handle on one DOM element. The same ids after the round trip prove the desk stayed mounted. New ids for the same regions mean it was rebuilt.
- While another workspace shows, the hidden desk is missing from `observe` (it is inert), so its ids reappear only after the switch back.
- The proof covers the chart tiles. `region "Ticket: NQ Z6"` in the Trade sidebar comes back under new ids after the round trip.
- Only the last 3 shown workspaces stay mounted (`KEPT_WORKSPACES`). A fourth one unmounts the oldest, and the switch back to it rebuilds it.
- On the frozen market a switch costs next to nothing either way. Measure switch cost on the busy market (`docs/dev.md` §9).
