# Chart templates

Each chart's toolbar carries a `Template: <name>` chip after `Candles` and `ƒx`. It reads the template the chart shows (`None` when it matches none, `<name> · modified` once the chart leaves the template it followed) and opens the one menu that saves, applies and defaults templates for that chart.

## Sub-features

- `chip-reads-chart` each chip reads its own chart's template: `Template: None` on a clean chart, the template's name once applied, `Template: <name> · modified` after a study changes.
- `apply-one-chart` picking a template in one chart's chip changes that chart's layers alone; the other chart's layout and chip stay as they were.
- `save-from-chip` `Save changes to “<name>”` (only on a modified chart), `Save as new template…`, `Rename…` and `Make a copy…` (only while the chart matches) are the only ways to save a template; the chart then follows what it saved.
- `default-star` the star on a template row makes it (or stops it being) the default for new charts; `chart.list_templates` reports it as `defaultId`.
- `one-menu` right-click › `Layers` › `Template…` opens that chart's chip menu; Layers and the Indicators panel's chart menu have no Templates submenu. `Manage templates…` opens Settings › Chart › Templates (rename, default, delete).

## How to get to it (user POV)

- `button "Template: <name>"` in a chart tile's `toolbar "Chart"`. Its menu is labelled by the chip.
- The chart's right-click `menu "Chart menu"` › `Layers` › `Template…` (its hint names the chart's template).

## Driving it

`node .agents/skills/verify-tessera/scripts/template-chip.ts <port>` on a fresh sim session drives every sub-feature (a right-click on the canvas is not something a session can do) and saves screenshots, `chart.list_templates.json` and `layout.get.json` under `.e2e/artifacts/verify/template-chip/`. It ends with `template chip: all checks passed`.

By hand on the baseline:

- **Apply.** On `region "NQ Z6 5m"` tap `button "Template: None"` › `Standard`. The chip reads `Template: Standard`; `layout.get` has `volume` then `vwap` on `chart-1` and `layers: []` on `chart-2`, whose chip still reads `Template: None`.
- **Modified.** `runtime.ts <port> chart.remove_layer '{"layoutId":"default","tileId":"chart-1","layerId":"vwap-1"}'`. The chip reads `Template: Standard · modified` and its menu starts with `Save changes to “Standard”`.
- **Save as new.** `Save as new template…`, type `Lean`, Enter. The chip reads `Template: Lean`; `chart.list_templates` has `Lean` with `volume` alone.
- **Default.** Hover `Lean` in the chip's menu and tap `button "Default for new charts"`. `chart.list_templates` has `defaultId: "lean"`.

## Gotchas

- What a chart follows is kept for the window's life. After a reload a chart reads the template it matches, or `None` if its studies match none.
- Applying from the chip replaces the chart's indicators and, when the template has one, its chart type; levels and drawings stay.
