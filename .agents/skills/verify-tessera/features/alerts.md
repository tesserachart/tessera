# Alerts

An alert watches a price, a plot or a level on a chart, or the tape itself: a big trade (one aggressor order with its same-side sweep within 5 ms) or one print of at least a size, at the ask, at the bid or either side. A firing shows a toast, plays its sound or voice line and is kept in the alert's history.

## Sub-features

- `al-flow-form` the alert form's `When` lists Price, the chart's plots, and six order-flow subjects: `Big trade at the ask`, `Big trade at the bid`, `Big trade, either side`, `One print at the ask`, `One print at the bid`, `One print, either side`. Picking one sets `Condition` to `At least` and replaces the target with `Size` in contracts (default 50).
- `al-flow-fire` a big-trade alert fires when an order at least that size ends on its side. The toast reads `NQ Z6 <size> at the ask · <average price>`, the price rounded to the tick's places, and `alerts.history` keeps its `size` and `side`. The voice says `Big buyer.` or `Big seller.`; in tones mode they are a rising or a falling three-note tone.
- `al-stack` the bell on a `Stacked imbalance` legend row opens `form "New alert"` with `When` `Price back in a stack, either side (3:1)` (also `a buy stack`, `a sell stack`), `Condition` `At least`, `textbox "Stack"` at the study's `Minimum stack` followed by `rows`, and `Interval` at the chart's. It fires on the first trade inside a zone still open on that interval, once per zone; `alerts.history` keeps its `side` (`ask` buy, `bid` sell) and no `size`, and the alert puts no tag on the price axis. Proven on the busy market by `scripts/stacked-imbalance.ts`.
- `alert-form-actions` the form of a saved alert has `Delete` and `Pause` (or `Resume`) beside `Cancel` and `Save`; a new alert's form has neither.
- `alert-tag-menu` a right-click on an alert's tag on the price axis opens `Edit…`, `Pause` or `Resume`, `All alerts` (the Alerts panel) and `Delete`.

## How to get to it (user POV)

- Command palette (`Ctrl+K`), `New alert on this chart…`: `form "New alert"` opens over the active chart. A right-click on the chart's price (`Alert at <price>…`) opens the same form.
- An alert's tag is `button "Alert: <its title>"` inside `getByLabel('Alerts on the chart')`; a click reopens its form.

## Driving it

- **Form.** On the default workspace open the form from the palette and tap `combobox "When"`: the listbox shows `Price` and the six order-flow subjects (the default charts have no plots). Pick `Big trade at the ask`: `combobox "Condition"` reads `At least` and `textbox "Size"` reads `50`, followed by `contracts`.
- **Firing.** The frozen market prints no trades, so use the busy market (`docs/dev.md` §9): an e2e config whose app env sets `TESSERA_TEST_MARKET=busy`. Its NQ tape prints orders of a few contracts, and orders of 20 or more within seconds. Set `Size` to 20, `Fires` to `Every time`, and `Create`: within seconds a toast reads like `NQ Z6 25 at the ask · 20,627.90 · NQ Z6 prints a big trade of at least 20 at the ask` (seen 2026-10-24; the busy tape is random, so size and price differ per run). `runtime.ts <port> alerts.history '{}'` lists the firing with `size`, `side` `ask` and the same price.
- **End state.** `runtime.ts <port> alerts.list '{}'` holds the alert, active, its step `{"subject":{"kind":"big_trade","side":"ask"},"op":"at_least","target":{"kind":"value","value":20}}`.
- **Pause and delete by mouse.** The e2e engine's right-click does not reach the chart, so drive this with Playwright (`page.mouse.click(x, y, { button: 'right' })`), after the ticket shows live prices. Make a price alert from the chart's right-click, then click its tag: the form reads `Change the alert` with `button "Delete"` and `button "Pause"`. Tap `Pause`: `alerts.list` reads `paused` and the button reads `Resume`. Tap `Resume`, then `Cancel`. Right-click the tag: the menu holds `Edit…`, `Pause`, `All alerts` and `Delete`. `All alerts` shows the Alerts panel; `Delete` removes the tag and `alerts.list` is empty.

## Gotchas

- The e2e session cannot hear the page. The voice lines and tones are proven by `apps/desktop/test/alerts.test.tsx` and `voice.test.ts`, and their audio context by `sounds.md`.
- One e2e config is open at a time: close the busy session before opening the frozen one.
