# Desk panels

Every panel on the desk is one instance with one standard header. Its tab row ends with a `+` that opens the Panels
library into that zone, and its right side holds the same controls in the same order: the panel's scope (when it has
one), Split chart (in the centre), Pop out, Maximise, More and Close. Close always closes, to the library, and the library (the `+`, the empty desk's
Add panel, the app menu's Panels and the palette's `Show <Title>` lines) brings a panel back where it last stood. An
open panel is focused where it is, never copied. A fresh or reset workspace has Trade | Analyst as tabs on the right
and Positions | Accounts at the bottom; nothing else is fixed.

## Sub-features

- `panel-header` every panel's header ends with `button "Pop out"`, `button "Maximise"`, `button "<Title>: more"` and
  `button "Close <Title>"`, in that order; a pane in the centre starts them with `button "Split chart"`. Kind tools live in the body: the chart's interval, type, ƒx and Trade in
  `toolbar "Chart"` under its tab; the analyst's session menu in `toolbar "Session"`.
- `panel-header-own` one component, `dock/header/PanelHeader.tsx`, draws every header on the desk, in floats, on
  collapsed edges and in pop-out windows: the tabs, `N more`, `+`, the scope, the buttons and a pop-out's window
  controls. dockview's own tabs are hidden; its header is only the host and drop area. A tab drag is the tab itself,
  so nothing is added to `document.body`, and once any drag ends (dropped, cancelled with Esc, let go in another
  window, focus lost) no dockview drop overlay stays on screen. Every header element is in the app's faces
  (`Instrument Sans`, the tab titles `Instrument Serif`).
- `panel-header-fit` a header narrower than its tabs and buttons keeps its active tab whole: the other tabs go
  into `N more` first (a tab is either whole or in the count, never half shown), then the buttons fold into More in
  this order: Close, the scope's words, Pop out (or Dock back), Maximise, Split chart (More › `Split chart`), `+`
  (More › `Add a panel here`), the active tab's own close. Only when all of that is gone does the active title shorten,
  with an ellipsis. Nothing in a header ever overlaps another part of it. The same rule holds on the desk, in a float,
  under the desktop app's window controls and in a pop-out window (`e2e/agent/panel-header.e2e.ts`,
  `../scripts/panel-headers.ts`).
- `panel-tab-drag` a tab dragged onto another header's tabs lands where it is let go, shown by an aqua insertion
  line; onto a header's empty part it goes last; onto a pane it splits or joins it as before. Pressing an edge's
  shown tab folds that edge away.
- `panel-split` every centre pane's `button "Split chart"` (⌘\\ or Ctrl+\\, the tab's right-click, More once folded,
  and ⌘K `Split chart`, found by `multi chart` or `side by side`) opens a new chart beside that pane on its symbol and
  interval, to the right of a wide pane and below a tall one, and makes it the active chart. Past six panes it opens as
  a tab of that pane; at 24 charts it adds nothing and says `24 charts is the most a workspace holds`. A pop-out window
  has no Split chart. `../scripts/split-chart.ts [evidence dir] [ui dir] [pr|main]` starts its own sim, clicks the NQ
  chart's `Split chart`, then runs ⌘K `multi chart`, saving `layout.get` and a still after each step.
- `panel-scope` DOM and Time & Sales show what they follow (`Active chart`, `Link N` or `Pinned`) and change it from
  that chip; Positions shows its account filter (`All accounts` or an account) there; charts show their link group
  once two or more groups are in use.
- `panel-follow` a DOM or Time & Sales on `Active chart` whose chart closes (its X, a split pane's Close, pop out)
  moves to the chart focused before it that is still docked, or the first one docked; `layout.get` reads that chart as
  `activeChartId`. With no chart left it keeps its last symbol and its prints and book keep coming (the DOM is
  read-only: `Open a <symbol> chart to size orders here`). One that never had a symbol on a desk with no chart reads
  `region "No chart open"` with `button "Open a chart"` (the palette's symbols), never an empty black panel.
  `../scripts/follow-closed-chart.ts [evidence dir] [ui dir] [pr|main]` starts its own busy sim, opens both panels on
  the ES chart, splits it and closes the new half, closes ES, closes NQ, then reloads, saving `layout.get`, each panel's name and rows, and a
  still after each step.
- `panel-library` the `+` (`button "Add a panel here"`) lists every panel kind with where it is (`Right side`,
  `Bottom`, `Centre`, `Floating`, `Window`, or nothing while closed). A closed panel goes into that zone; an open one
  is focused where it is; a chart, DOM or Time & Sales adds one there.
- `panel-close` a tab's X, the header's Close, or More › Close closes any panel, an edge's last tab and the last chart
  included. `layout.get` keeps its last place in the dock's `tessera.closed`.
- `panel-restore` `Show <Title>` (palette), the app menu's `Panels` or the empty desk's `Add panel` brings a closed
  panel back at its last place, at its tab.
- `panel-empty` with no panel in the centre the desk reads `No chart open` with `button "Open a chart"` (the palette's
  symbols) and `button "Add panel"`, centred under a panel header like its neighbours' that holds
  `button "Add a panel here"`. Once the last chart closes, `layout.get` reads `"charts":{}` and
  `"activeChartId":null`, and a reload keeps the empty desk.
- `panel-maximise` Maximise fills the desk with any panel; an edge's panel moves to the centre and goes back to its
  edge on Restore or Esc. A maximised Analyst lists its sessions on the left.
- `panel-rail` every rail item but Desk opens its own page (the rail, its ⌥ digit, ⌘K `Go to <area>`); the chart's ƒx
  focuses the Indicators panel for that chart. Analyst, Indicators, Journal and Trade copier are panels too: drag the
  rail item onto the desk, or `Show Analyst` (⌘J) / `Show Indicators` / `Show Trade copier` (palette) or the Panels
  library.
- `panel-popout` Pop out opens any panel in its own window (`?window=pop-<workspace>-<panel>`). Its header has
  `button "Dock back"`, More (with `Full screen` in the desktop app) and Close. Dock back puts it back at its last
  place; dragging its tab onto the desk docks it there; closing the window sends the panel to the library.
  In the desktop app the window opens over the main window at its size. With the only chart popped out, New chart
  (Ctrl+T) on the main window opens `Search symbols for a new chart tab` on the desk, and a pick adds the chart there
  (`../scripts/new-chart-popped.ts`). Enter typed while the matches are still loading opens the first match once they
  arrive; typing on drops it.
- `panel-collapse` an edge collapses from More › `Collapse the <edge>` (or ⌘B, ⌥⌘B, ⌥⌘P), or by dragging its hairline
  shut; its strip names its panels, and a click opens it at its last size.

## How to get to it (user POV)

- Any tab row: `button "Add a panel here"` after the tabs; the header's buttons on the right.
- Any centre pane: `button "Split chart"`, the first of the header's buttons; ⌘K `Split chart`.
- The app menu: `button "Tessera menu: <workspace>"`, then `menuitem "Panels"`.
- Ctrl+K: `Show Positions` and the other `Show <Title>` lines, each with where the panel is.
- The rail: drag `button "Analyst"`, `button "Indicators"`, `button "Journal"` or `button "Trade copier"` onto the desk.

## Driving it

The e2e MCP session or a Playwright script on the sim (`<origin>/#ticket=<ticket>` from serve's ready line).

- **Header.** Every `.dv-groupview` header shows Pop out, Maximise, More and Close in that order, the chart's body
  starts with `toolbar "Chart"` (`1m 5m 15m 1h 1D`, `Candles`, `ƒx`, Trade).
- **Close and restore.** Tap `button "Close Trade"` and `button "Close Analyst"`: the right edge is gone. `layout.get`
  lists both in `tessera.closed` with `referenceGroupId` `edge-right`. Ctrl+K `Show Analyst` (its line has no place
  word while closed): the right edge is back with the Analyst tab at its old index.
- **Split.** On the NQ chart's header tap `button "Split chart"`: a third chart, `NQ Z6 5m`, opens to the right of NQ
  and is the active chart; `layout.get` lists `chart-3` on `NQZ6.CME` `5m`, and the dock's grid holds three chart panes.
- **Library.** On the bottom row tap `button "Add a panel here"`, then `Journal`: Journal is a tab of the bottom. Tap it
  again and pick `Trade`: Trade stays on the right and is focused; there is one Trade.
- **Last chart.** Close every chart: the centre reads `No chart open`; `layout.get` has no charts and a null
  `activeChartId`; a reload still reads `No chart open`. `Open a chart` opens the palette and a symbol picked there
  opens a chart.
- **Empty desk.** `../scripts/empty-desk.ts [evidence dir] [ui dir] [pr|main]` starts its own sim, closes every chart,
  reloads, closes every other panel, then adds Journal from the empty desk's header. After each step it saves a still
  and reports the header (its top and height match Trade's, it holds `Add a panel here`, it is in the title-bar band)
  and how far the invite sits from the centre of the body below it (`dx` and `dy` both 0).
- **Maximise.** On the right edge tap the Analyst tab, then `button "Maximise"`: the Analyst fills the desk with its
  sessions on the left. Press Esc: it is back on the right, at its tab.
- **Narrow headers.** Close ES, Trade and Analyst, then tap the NQ chart's `button "Trade"`: the right side opens with
  `Trade` whole. Add Analyst, Indicators, Journal and Alerts there and click through them at window widths down to
  760 px: each active title stays whole beside `N more`, which never counts it. Pop the NQ chart out, tap `Trade` in
  its window and narrow the window to 320 px: `Trade` stays whole, with More holding Close.
- **Clean headers.** `../scripts/panel-headers.ts [evidence dir] [ui dir] [pr|main]` starts its own sim runtime, opens
  Indicators beside Trade, drags its tab over the ES header and cancels with Esc, drops it before Trade and then on
  the NQ chart's tabs, adds Journal, Alerts and Analyst, narrows the window to 1100 and 760 px and opens Trade's
  pop-out at 900, 420 and 300 px. After each step it saves a still and lists any header part that leaves its header,
  is covered, overlaps another, is cut without an ellipsis or is not in the app's faces, and any drag preview or drop
  overlay left on the page (`<label>-report.json`, every list empty).
- **Pop out.** Tap Positions' `button "Pop out"` (wait on Playwright's `context.waitForEvent('page')`). The window shows
  `Positions` with `All accounts`, `Dock back`, More and Close; `layout.get` has it in `tessera.popouts` with its
  `bounds`, `monitor` and `returnTo`. Tap `Dock back`: the window closes and Positions is the bottom's first tab again.
  Pop out the Analyst and close its window: `tessera.closed` lists it at `edge-right`.

## Gotchas

- A popped window loads like the main page; give it up to a minute on a loaded box before reading it.
- Clicking an edge's already active tab collapses that edge; click a tab once.
- Drop on a tab's middle, not its edge: 4 px from a tab's side is the sash between panes.
- A workspace closes its windows when another workspace is shown and opens them again when it comes back.
- `layout.get` reads the runtime: a dock change is saved 800 ms after it settles.
