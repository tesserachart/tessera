# Research results as a strategy tester

A study's latest run reads as a strategy tester in the results pane, beside the study's form: the verdict in plain words, the base case's equity curve with its development and later sessions and its drawdown, development against later side by side with quant stats computed from the run's trades, a per-month breakdown, the pass rules, and a Trades tab with a price chart marking every entry and exit over a sortable trades list. Hypothesis, data and every fill case are folded under `Hypothesis · data · every fill case`.

## Sub-features

- `rt-verdict` the pane opens on the verdict word (`Qualified`, `Lead`, `Rejected`) and `research.get_run`'s `evaluation.reason`, then the exploratory note and the data words.
- `rt-equity` `Summary` › `Equity · base`: `img "Equity curve, … at the end"` with `Development` and `Later` tags and the later sessions shaded from the later split's first bar, `img "Drawdown, deepest …"` under it. Hovering reads the date, the P&L and how far it is from the high.
- `rt-sides` `Development vs later`: `group "Development"` and `group "Later"`, each with Net, Profit factor, Win rate, Max drawdown and Trades from `cases[0].development.metrics` and `.later.metrics`; under them Expectancy (mean trade and its 5-session block interval), Sharpe (session P&L, sessions without a trade flat, ×√252), win rate interval, average win and loss, best and worst trade, average MAE and MFE, longest losing run, bars held, long · short, trades per session, sessions and costs.
- `rt-months` `By month`: one row per month of the trades' exit days (the instrument's trading day), with trades, win rate, net and which split it holds.
- `rt-trades` `Trades · <n>`: `img "Price chart with <n> trades marked"` on the study's instrument and timeframe (RTH bars when the study is RTH only), every trade's entry and exit marked and the picked trade drawn with its stop and target; `table "Trades"` in entry order under `Development · <n>` and `Later · <n>`. Entry, Side, Exit, Bars, MAE, MFE and P&L sort (`aria-sort`), a second press reverses; a row picks its trade and the chart frames it.

## How to get to it (user POV)

- Research › a study with a run › results pane. `Trades · <n>` beside `Summary`.

## Driving it

- **Run.** `research.save_study` an NQ 5m breakout (lookback 20, hold 12, RTH only, window 09:30–12:00, stop 60 and target 120 ticks, development 60%, 50 placebo runs), then `research.run_study`. On the frozen mock market it reads Rejected over 20 sessions with 25 trades.
- **End state.** The screen's numbers match `research.get_run`'s `evaluation.cases[0]`; the price chart's bars are `market.get_candles` for the run's range. `apps/desktop/test/research-tester.test.tsx` renders the same run from `apps/desktop/test/fixtures/sim-research-run.json`, recorded from the sim.

## Gotchas

- A run longer than 5,000 bars of its timeframe charts a 2,000-bar window around the picked trade, read again when a trade outside it is picked.
- Trade times show in the display zone; months and Sharpe sessions use the instrument's trading day.
