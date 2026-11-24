# Replay a saved day

A chart can play back any day of trades saved on this machine, from disk, through the same trade path a live market takes: candles, footprint, time and sales and big trades build as the replay clock passes each print. The replay is its own instrument (`NQZ6-R1.CME`), shown everywhere as `NQ Z6 replay`, and takes no orders on any account.

## Sub-features

- `rp-pick` the chart menu's `Replay a saved day…` lists every saved day per contract, the charted contract first, newest first, with its print count.
- `rp-transport` the replay tile shows a bar above the chart: the contract and day, play or pause, the replay clock (in the time zone of Settings › App), speeds 1× 2× 5× 10× 60×, a `Jump to a time` field and `Back to <contract>`.
- `rp-history` a replay opens on every bar stored before its day, as the live chart showed them, and its studies run over them; bars from its first print on appear only as the clock reaches them. When the stored bars miss part of the trading day before, the replay bar says `No saved bars from <time> to <time>`, or `No saved bars before the replay` when there are none.
- `rp-clock` playing moves the clock at the chosen speed and the chart's bars follow it; paused, both hold.
- `rp-jump` a time typed in the field (`11:00`, Enter) continues the replay there under a new instrument (`-R2`): the chart shows the day up to that time and nothing after it.
- `rp-orders` the Trade ticket on a replay reads `NQZ6-R1 replays a saved day: it takes no orders` and its order buttons are off; `orders.submit` on the replay id is rejected on every account.
- `rp-live` `Back to NQ Z6` returns the chart to the live contract and closes the replay.

## How to get to it (user POV)

- the chart tile header's `button "Chart: more"`, `menuitem "Replay a saved day…"`, then a row of `list "Saved days"` in `dialog "Replay a saved day"`.

## Driving it

- **Saved days.** The sim's tick store starts empty, and the mock market keeps its own history, so a chart never saves a day on the frozen clock. Pull some first (`saved-trades.md`): Settings › Data › Pull a date range, `NQ`, 2026-09-28 to 2026-10-01, RTH, Pull (or `runtime.ts <port> market.pull_trades '{"instrument":"NQ","from":"2026-09-28","to":"2026-10-01","scope":"rth"}'`). `runtime.ts <port> market.list_replay_days '{}'` lists them.
- **Play.** Pick `Thu, 1 Oct 2026`. The tab reads `NQ Z6 replay 5m`, `toolbar "Replay"` shows `09:30:00` (the cash open) and `button "Pause"`. Tap `button "60 times"`; the clock runs a minute a second.
- **History.** Before picking the day, open `NQ Z6` at 15m and wait about 15 s so its bars are stored. Pick `Thu, 1 Oct 2026`: the replay opens at `09:30:00` with the days before it and the night session drawn, and `market.get_candles` on the replay id returns no bar at or after its `cursor`. A sim whose chart never loaded NQ Z6 shows `No saved bars before the replay`.
- **Jump.** `type` `11:00` into `textbox "Jump to a time"`, `press` Enter. The clock reads `11:01:00` a second later and the ticket's note names `NQZ6-R2`.
- **End state.** `runtime.ts <port> market.get_replays '{}'` lists only `NQZ6-R2.CME`, `playing: false` after `button "Pause"`, with a `cursor` that holds between two reads. After `button "Back to NQ Z6"` it lists none and the tab reads `NQ Z6 5m` again. `bars.db` holds no `replay` source and `ticks/ticks.db` no replay instrument.

## Gotchas

- The replay clock is wall time, not the runtime's frozen clock, so a replay moves on the frozen sim.
- A replay lives in the runtime's memory: after a runtime restart the tile shows `This replay has closed` with `Back to NQ Z6`.
