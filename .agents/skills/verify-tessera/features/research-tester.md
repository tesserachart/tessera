# Research station

Research lists every run of every study, newest first under day headings, each with its idea (the study's name), verdict, trades, net and where it came from: the analyst chat that ran it (else the chat that registered the idea), `You`, or an MCP client. A study not run yet sits under `Not run yet`. The run's page leads with the idea, the verdict and why, the hypothesis, development against later at a glance and the equity curve, then `Overview` (quant stats, pass rules, months, fill cases), `Trades · <n>` and `Setup`. A run can be archived, restored and deleted. A trade opens at its moment on the trader's real chart, and the chart offers the way back to it.

## Sub-features

- `rs-list` `navigation "Runs"`: `searchbox "Search runs"` matches every word typed across idea, hypothesis, market, verdict, net and chat title; `Runs` and `Archived · <n>` switch shelves. A row reads `<idea> <verdict>` over `<symbol> <tf> · <n> trades · <source>` and the net. Right-clicking a run offers `Archive` or `Restore`.
- `rs-source` the page's meta line starts with the source: a chat's title is a button that opens that chat in the Analyst area; `Run by you`; `A deleted chat` once the chat list has answered without it.
- `rs-glance` `table "Development and later"`: Net, Trades, Win rate, Profit factor, Max drawdown and Expectancy of each split, from `research.get_run`'s `evaluation.cases[0]`; under it `img "Equity curve, … at the end"` with money and date axes and the later sessions shaded, and `img "Drawdown, deepest …"` (`analytics-graphs.md`).
- `rs-overview` `Overview`: the quant table (Expectancy, Sharpe, win rate interval, …), `Pass rules` per fill case with the placebo line, `By month`, `Fill cases` and the approximate-fills note, `Level inputs` when the study has them.
- `rs-trades` `Trades · <n>`: `table "Trades"` under `Development · <n>` and `Later · <n>`; Entry, Side, Exit, Bars, MAE, MFE and P&L sort (`aria-sort`). No chart is drawn in Research.
- `rs-link` each row's `button "Show trade <n> on the chart"` (or a double-click) shows the desk, puts the study's instrument on the active chart, its timeframe when the chart's is coarser, frames the trade a dozen bars each side (its own length for a longer one) and draws it over the bars it held, at least one: the buy and the sell at their prices, the stop and target bands, `Long 1` and `<exit> <P&L>` labels, and axis tags for all four prices. `group "Research trade"` on that chart holds `Trade <n> · <idea>`, which returns to the run with that trade selected, and `button "Hide the research trade"`.
- `rs-archive` `Archive` moves the run to the `Archived` shelf (`research.list_runs` gives its `archivedAt`), `Restore` brings it back. `Delete` asks `Delete this run? Its trial stays counted.` and removes only the run; the study stays, under `Not run yet` once it has no runs. A study not run yet has `Run` and `Delete`.
- `rs-setup` `Setup`: the hypothesis and notes, the setup in words (market, history, window, levels, rules, contracts, costs, stop, target, fill cases, pass rules, placebo runs, family), a script's code, and the trading-session buttons of `strategy-flow.md`.

## How to get to it (user POV)

- `button "Research"` in `navigation "Areas"`. Agents open it on a run or study with `ui.show_area {area: "research", item}`.

## Driving it

- **Script.** `node .agents/skills/verify-tessera/scripts/research-station.ts [out dir] [label] [ui dir]` starts its own sim runtime, has a chat on the Claude stand-in register and run an NQ 5m breakout through its own MCP connection (`Research: <name>`, `analyst-queue.md`), runs one study as the user, leaves one not run, then walks the page, a trade to the chart and back, the chat link, archive and delete. It saves stills and the runtime's answers (`list-runs-*.json`, `chart-state.json`, `report.json`). With `TESSERA_TEST_RUNTIME_BIN` and a ui dir from main and the label `main`, it takes main's stills of the same data.
- **End state.** `report.json`: `tradeOnChart.tradeInView` true with `chart.get_state` on the study's instrument and timeframe, `backSelected` the trade's number, `archived` 1, `runsAfterDelete` one less, `studyKept` true. `apps/desktop/test/research-tester.test.tsx` renders `apps/desktop/test/fixtures/sim-research-run.json`, recorded from the sim.

## Gotchas

- The sim's chart pages intraday history back 20 calendar days while the mock serves 20 sessions, so a run's earliest trades (before about 13 Sep) fall before what the chart can show; the chart says so in its own words. The script frames the run's last trade.
- Trade times show in the display zone; months and Sharpe sessions use the instrument's trading day.
