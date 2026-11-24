# Chart levels

A chart draws a level only when the user turns it on, and opens without studies too (`chart-studies.md`). The default workspace's charts start with no studies and no levels. The user turns a level on or off from the Indicators panel's chart menu, and the workspace's layout in the runtime keeps the choice.

## Sub-features

- `levels-start-clean` gives the default workspace's charts no levels: no Prior high, Prior low or mock gamma lines.
- `levels-by-hand` turns a Tessera level (Prior high, Prior low, Prior close) or a mock gamma level (`Mock · Gamma`) on from the menu, and draws it.
- `levels-stored` keeps those choices in the workspace's layout, after a reload too.
- `levels-initial-balance` the menu's `Initial balance` group draws IB high, low, mid and the ±50% and ±100% extensions from the instrument's RTH open over the window in Settings › Levels › Initial balance (30 or 60 min); `concepts.get_levels` returns the same `tessera.ib.*` prices.
- `vwap-from-prints` draws the session VWAP the runtime measures from the session's prints (`indicators.compute` with `indicator` `vwap` gives the same values); a session whose prints are not all held or saved falls back to bar typical price.
- `vwap-period` the VWAP's `Period` (Session, the default, Week or Month) in its settings form makes the line and its bands start over each session, each Monday-to-Sunday week of trade dates or each calendar month; a period whose first session the chart's bars do not reach draws nothing.

## How to get to it (user POV)

- The chart tile's `button "Indicators"` (`ƒx`) in its `toolbar "Chart"` focuses the Indicators panel for that chart. Its `button "On NQ Z6 5m"` (the active chart) opens the chart menu: the chart's indicators, then `group "Levels"` (`Prior high`, `Prior low`, `Prior close`) and `group "Mock · Gamma"` (`Zero Gamma`, `Major Positive Volume`, `Major Negative Volume`, `Major Positive OI`, `Major Negative OI`), each a `menuitemcheckbox`.

## Driving it with the e2e MCP

Preconditions:

- The baseline in `README.md`.

- **Start clean.** Run `runtime.ts <port> layout.get '{"layoutId":"default"}'`. `charts["chart-1"]` and `charts["chart-2"]` each have an empty `layers` list. In `region "NQ Z6 5m"`, tap `button "Indicators"`, then the Indicators panel's `button "On NQ Z6 5m"`. No level in the menu is `[checked]`. The Analyst column reads `Sees NQ Z6 5m`.
- **Prior high by hand.** Tap `menuitemcheckbox "Prior high"`. It becomes `[checked]`. Press `Escape`. The NQ chart draws `Prior high +170.75` at 20,812.00, and the Analyst reads `Sees NQ Z6 5m · Prior day`. In `layout.get`, `charts["chart-1"].layers` ends with `levels-pd`, params `{"group":"pd","fields":["pdh"]}`.
- **Mock gamma by hand.** Open the menu again and tap `menuitemcheckbox "Zero Gamma"`. In `layout.get`, `charts["chart-1"].layers` adds `levels-mock-gamma`, params `{"vendor":"Mock","package":"Gamma","fields":["zero_gamma"]}`.
- **VWAP from prints.** Add VWAP with `runtime.ts <port> chart.add_layer '{"kind":"vwap"}'`, then hover the last bar of `region "NQ Z6 5m"`: the legend reads `VWAP` and a value. Run `runtime.ts <port> indicators.compute '{"indicator":"vwap","instrument":"NQ","tf":"5m","limit":30}'`: its last `vwap` value is the legend's, and its `description` says a session whose prints are not all held or saved is weighted by bar typical price. The page's WebSocket carries an `indicators.series` subscription with `indicator` `vwap`.
- **VWAP period.** `node .agents/skills/verify-tessera/scripts/vwap-periods.ts [out dir] [ui dir] [name]` starts its own sim runtime, puts VWAP with bands 1 and 2 on a 30m NQ chart and switches `inputs.period` session, week, month with `chart.update_layer`, taking a still of each: session breaks the line at every trade date, week only at Mon 28 Sep, month only at 1 Oct (September draws nothing: the sim's bars start on 4 Sep). It then opens `VWAP month: settings` and taps `Week` in the `Period` row: `layout.get` stores `period: "week"`. `indicators.compute` with `inputs.period` week has its `computedFrom` at or before the week's Sunday-evening open.
- **Stored.** `navigate` to `/`. The page reconnects to the runtime by itself. In `toolbar "Layers"` of the NQ tile, `button "Prior high"` (text `PDH`) is `[pressed]`, the line is drawn again, and `layout.get` is unchanged.

- **Initial balance.** `toolbar "Layers"` lists `Initial balance` (`IBH` … `IB−100`). Open the Indicators panel's `button "On NQ Z6 5m"` menu and check `IB high`, `IB low`, `IB mid`, `IB +50%` and `IB −50%` in `group "Initial balance"`. On the frozen clock (Fri 2 Oct 14:42) the 30-minute window is complete, so the labels read `IB high`, `IB mid`, `IB low`, `IB −50%` with no `(forming …)`, at 20,947.25, 20,870.00, 20,792.75 and 20,715.50 (+50% at 21,024.50, above the view). The lines are mist, dashed for high and low and dotted for the rest; the prior day's are t2 dotted. `runtime.ts <port> concepts.get_levels '{"instrument":"NQ"}'` lists `tessera.ib.*` at the same prices, and `market.get_candles` 1m from 09:30 to 10:00 has the same high and low. `layout.get` adds `levels-ib` with `{"group":"ib","fields":[…]}`. The Analyst reads `Sees NQ Z6 5m · Initial balance`. Tap `button "1m"` and zoom out (`-` six times): the same lines. Then `Level settings…` › `region "Initial balance"`, `radiogroup "Initial balance window"`, tap `60 min`: `settings.get` has `chart.initialBalanceMinutes` 60, `concepts.get_levels` gives low 20,744.75 and mid 20,846, and within 5 s the chart's IB mid, low and −50% move there.

## Gotchas

- The level buttons in a tile's `toolbar "Layers"` (`PDH`, `ZG`, …) lie under the chart's overlay canvas, so a `tap` on them times out. Turn levels on and off from the menu, and read the buttons' `[pressed]` state with `locate` or `observe`.
- The menu lists first the group that has a layer on the chart. After Prior high is on, `Levels` comes before `Mock · Gamma`.
- The `Prior high` label is in both tiles' strips. Take the first match in `locate`, or look inside `region "NQ Z6 5m"`.
