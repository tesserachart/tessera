# Journal and Research graphs

Every graph in the Journal and in Research comes from one kit, `apps/desktop/src/graphs/` on visx: the equity graph (a money axis, a date or trade axis, the high-water line, a drawdown pane under it and an optional shaded span), bars, the signed area, lines with a legend, the donut, the gauge and the sparkline. Each draws in the theme's colours, Light included, and reads out what is under the pointer in one tip box.

## Sub-features

- `ag-equity` Journal › Analytics › Risk and each Playbooks setup: `img "Equity curve over <n> trades, ending at …"` with dated ticks under `img "Drawdown"`; the tip reads `Trade <n>`, its day and time, the trade's net, the equity and the distance from the peak; a click opens that trade (`complementary "The trade"`).
- `ag-research` a Research run: `img "Equity curve, … at the end"` with dated ticks, money ticks, `Development` and `Later` over the later sessions shaded in both panes, and `img "Drawdown, deepest …"`; the tip reads the bar's date and time, the net and the distance from the high.
- `ag-bars` Risk's R-multiple and size bars (`img "Bars by bucket"`): buckets of fewer than 20 trades (`SMALL_N`) are drawn faint and their tip ends `Few trades: read as noise`. Overview's `P&L by trade` bars and its `Cumulative P&L` area open the trade under the pointer.
- `ag-lines` Symbols › Symbol trend: a legend button isolates its line (`aria-pressed`), the others dim, a second click brings them back.
- `ag-rings` Overview's win/loss donut and Symbols' share donut show the hovered segment in the centre; the Dashboard's gauges and the sparklines (also on the workspace's Journal tile).

## How to get to it (user POV)

- `button "Journal"` in `navigation "Areas"`, then Dashboard, Analytics (Overview, Time, Risk, Symbols, Behaviour) or Playbooks.
- `button "Research"`, then a run.

## Driving it

- **Script.** `node .agents/skills/verify-tessera/scripts/analytics-graphs.ts [out dir] [label] [ui dir]` starts its own sim runtime, logs 72 closed NQ and ES trades from July to October with stops under two setups, runs an NQ EMA 9/21 study, and shoots the Dashboard, every Analytics tab, Playbooks and the run in Tessera, then in Tessera Light. Between them it hovers and clicks the Risk equity curve, hovers a Risk bucket, isolates a Symbols line and hovers the Research curve.
- **End state.** `<label>-report.json`: `journalEquityTip` starts `Trade`, `pickedTrade` 1, `bucketTip` ends `Few trades: read as noise`, `fadedBars` above 0, `isolated` 1, `researchTip` set, `laterShaded` 1 and `researchAxisLabels` with money and date ticks. With main's `dist` and the label `main` it shoots main's same screens for a main-against-PR comparison.

## Gotchas

- Headless Chromium starts in light mode; the script emulates dark first, then sets `appearance.theme` to `tessera-light`.
- The sim's frozen clock sits on 2 Oct 2026, so trades logged before it all count under `All`.
