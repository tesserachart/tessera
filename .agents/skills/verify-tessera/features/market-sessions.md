# Market sessions

Each instrument trades on its exchange calendar: CME futures by product family (equity index, Treasuries, currencies, energy, gold, silver, copper, platinum), each with the Globex week (Sunday to Friday, 18:00 to 17:00 New York), its own regular session (RTH), early closes and holidays. The Markets area's detail names the session the market is in now and its hours, and `market.get_sessions` gives the agent the same sessions.

## Sub-features

- `sessions-now` the Markets detail's `Session` row reads the phase from the runtime's calendar: `Regular · closes in …` inside RTH, `Overnight` or `After hours` around it, `Daily halt` between two sessions, `Holiday hours` or `Closed · <holiday>` on a holiday.
- `sessions-hours` the detail's `Hours` and `Regular hours` rows come from the instrument's calendar: NQ reads `Sun–Fri 18:00–17:00 ET` and `09:30–16:00 ET`.
- `sessions-tool` `market.get_sessions` returns the calendar's hours, each trade date's open, close, windows and RTH, and the weekday holidays in the range.

## How to get to it (user POV)

- The rail's `button "Markets"`, then a row of `listbox "All markets"` (`option "NQ Z6"`). Its `region "NQ Z6 details"` lists `Session`, `Hours` and `Regular hours`.

## Driving it with the e2e MCP

Preconditions:

- The baseline in `README.md`. The frozen clock is Friday 2 Oct 2026 14:42 New York, inside every CME family's day except energy's and metals' RTH.

- **Hours.** Tap `button "Markets"`, then `option "NQ Z6"`. `region "NQ Z6 details"` reads `Session` `Regular · closes in` a countdown to 16:00, `Hours` `Sun–Fri 18:00–17:00 ET` and `Regular hours` `09:30–16:00 ET`. The row's `Session` column reads `Regular`.
- **Tool.** `runtime.ts <port> market.get_sessions '{"instrument":"NQ"}'` returns `hours.calendar` `cme_equity_index`, `hours.rth` `{"start":"09:30","end":"16:00"}`, and three sessions: Thu 1 Oct, Fri 2 Oct and Mon 5 Oct, each opening at 18:00 New York the evening before (22:00 UTC) and closing at 17:00. `'{"instrument":"NQ","from":"2026-11-25","to":"2026-11-30"}'` lists `Thanksgiving Day` in `holidays` with `halt` at 13:00 New York, and the Fri 27 Nov session `earlyClose` with RTH ending 13:00.

## Gotchas

- The mock market carries CME equity index futures only (NQ, ES, MNQ, MES). The other families' hours (CL 09:00–14:30, GC 08:20–13:30, ZN and 6E 08:20–15:00, and their holiday and early-close hours) are proven by `tessera-core`'s session tests and `tessera-rithmic`'s symbol tests, not on the sim.
