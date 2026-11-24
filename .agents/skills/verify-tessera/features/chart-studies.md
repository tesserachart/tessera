# Chart studies

A new chart opens with candles only. A study is on only when the trader turns it on, applies a template that contains it, or opens a story that includes it. The Standard template (Volume and VWAP) and the Order flow template are explicit choices, and the Scalp story includes order flow when picked.

## Sub-features

- `studies-start-clean` a new workspace or chart with no default template has no layers and an empty study legend; its layout stores `layers: []`, and the Analyst reads the symbol and interval alone (`Sees NQ Z6 5m`).
- `studies-standard-by-hand` the Template chip's `Standard` puts Volume and VWAP on the chart, and the layout stores them.
- `studies-order-flow-by-choice` the Template chip's `Order flow` and the Scalp story put footprint, volume profile, big trades and CVD on the chart only when the trader picks them.
- `studies-removable` a study hides or removes from its legend row and from the chart's Layers menu, stays gone after a reload, and draws once its data is in; the volume profile is off until it is added or a template or story with it is chosen.

## How to get to it (user POV)

- Templates live in the chart's [Template chip](chart-templates.md): `button "Template: <name>"` in the tile's `toolbar "Chart"`, after `Candles` and `ƒx`. Its menu lists `Standard`, saved templates, then `Order flow`. The chart's right-click `menu "Chart menu"` › `Layers` › `Template…` opens the same menu.
- The app menu's `New from preset` opens the Scalp story.

## Driving it with the e2e MCP

Preconditions:

- The baseline in `README.md`.

- **Start clean.** Run `runtime.ts <port> layout.get '{"layoutId":"default"}'`. `charts["chart-1"].layers` and `charts["chart-2"].layers` are `[]`. In `region "NQ Z6 5m"` the legend lists no study rows, and the Analyst column reads `Sees NQ Z6 5m`. Run `runtime.ts <port> workspace.create '{"instrument":"NQ","show":false}'` and `layout.get` on its `layoutId`: its `chart-1` has `layers: []`.
- **Standard by hand.** In `region "NQ Z6 5m"`, tap its `button "Template: None"` › `Standard`. The legend lists Volume and VWAP, the Analyst reads `Sees NQ Z6 5m · Volume · VWAP`, and `layout.get` has `volume-1` (kind `volume`) then `vwap-1` (kind `vwap`).
- **Order flow by choice.** In `button "Tessera menu: <workspace>"`, open `New from preset` › `Scalp`. `layout.list` finds the new workspace; `layout.get` on it has `chart-1` with `footprint`, `volume_profile`, `big_trades` and `delta`. On the default workspace, the Template chip's `Order flow` puts the same four on its chart.
- **Removable.** Click a study row's name in the legend, or right-click the row, then `Remove`. `layout.get` loses that layer, and a reload leaves it gone. Removing every study leaves the candles and an empty legend.

## Gotchas

- Settings › Chart still lists `Standard`, but it is not the default: a new chart starts only from a template the trader pinned as default.
- A chart created while the templates have not answered also starts clean; the default template is not applied afterwards.
