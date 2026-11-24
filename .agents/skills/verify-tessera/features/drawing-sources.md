# Drawings from other charts

A drawing stays on the chart it was made on. A chart shows only its own drawings until its Settings… pick other charts of the workspace to show drawings from, by chart and not by timeframe: a 1m NQ chart can pull from the 5m NQ chart without pulling from another 1m NQ chart. A new chart picks nothing.

## Sub-features

- `sources-none` a chart that picks nothing, a new chart included, shows only its own drawings, however many other charts of its instrument have some.
- `sources-pick` the chart's ⋯ › `Settings…` popover has `Drawings from` with one switch per other chart on its instrument (`switch "NQ Z6 5m"`); on, the chart also shows that chart's drawings on its instrument.
- `sources-apart` two charts with the same symbol and interval carry where they sit under their label (`Right`, `Bottom left`, `Top left, tab 2`, `Pop-out window`, `Main window`), and the switch's name says it (`switch "NQ Z6 1m, Right"`).
- `sources-home` a drawing made on a chart is stored on that chart only (`layout.get` › `charts[…].drawings`); a pulled drawing moved, restyled or deleted on the chart showing it changes on the chart it was made on, and ⌘Z there undoes it.
- `sources-remove-all` `Remove all drawings` on a chart removes its own and leaves those it pulls.
- `sources-closed` closing a chart drops it from every pick list, so a new chart given its tile id pulls nothing in.
- `sources-agent` `chart.set_drawing_sources {tileId, from}` sets the list; `chart.get_state` shows it as `chart.drawingsFrom` and the pulled drawings under `pulled`, each with the `tileId` it lives on.

## How to get to it (user POV)

- Put two more NQ charts on the desk: `button "Split chart"` on the NQ 5m chart, then set the new chart and `ES Z6 1m` to NQ 1m.
- Draw with `toolbar "Drawing tools"` › `button "Horizontal line"` and a tap on the chart.
- Open a chart's picker: its header's `button "NQ Z6 1m: more"` › `menuitem "Settings…"`.

## Driving it

Preconditions: the baseline in `README.md`.

- `node .agents/skills/verify-tessera/scripts/drawing-sources.ts [out dir] [ui dir] [label] [runtime bin]` starts its own sim runtime. It sets up NQ 5m and two NQ 1m charts and draws a line on the 5m. It opens the first 1m chart's menu and Settings…, picks `NQ Z6 5m`, then draws on that 1m. It saves a screenshot and `layout.get` at each step under `.e2e/artifacts/verify/drawing-sources/`.
- End state: the 5m line shows on the 5m chart and the 1m chart that picked it, not on the other 1m; the 1m's own line shows only on that 1m; `layout.get` has each line once, on the chart it was drawn on, and `drawingsFrom: ["chart-1"]` on the picking chart only.

## Gotchas

- Picks are per workspace: tile ids name charts of the same workspace only.
- A picked chart switched to another symbol shows nothing on this chart until it is back on this chart's instrument.
