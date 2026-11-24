# Paper orders

The Trade ticket sends orders to the Paper account, which fills them at the prices of the market data on screen. On the sim runtime that is the frozen mock market. The ticket starts on Paper, and every account there is paper, so this is where an agent places orders.

## Sub-features

- `order-market` fills `Buy market` at the ask and `Sell market` at the bid.
- `order-bracket` adds a stop and a target to an entry while `Bracket` is on in the ticket. It is off by default; turned on, its distances start at 40 and 80 ticks, and the workspace keeps them, on or off, per account and contract. The chart menu's `Buy limit`, `Sell limit`, `Buy stop` and `Sell stop` rows always send a plain order and say `no bracket`. For an entry that fills where the market is (market, a limit through the market, a stop) the ticket sends them as ticks, and the runtime places them that far from the fill; a resting limit or stop limit, and a leg clicked or dragged to a price, keep their prices. When that position goes flat — a trailing or fixed stop fill, a target fill, Flat, or a close from outside — those legs are cancelled and the Positions `Working` group is gone. A rest the trader placed on its own stays.
- `order-flat` closes the position with `Flat` and cancels its bracket.
- `order-live-price` fills only at a live price. Paper counts a price as live while its market-data connection is up and has sent data in the last 5 s: a trade, a bid or ask, or a change in the book. A quiet book is live, and so is the frozen sim. Otherwise Paper refuses every market order, a close and `Flat` included, with `No live price for NQZ6 since 14:42. Nothing sent.`. A limit or a stop that would fill at once waits for a live price.
- `order-journal` adds the closed trade to the Journal's `Today`.
- `order-fees` charges each paper fill the commission in Settings › Trading and risk › Paper trading: by default $2.87 a side per standard contract (NQ, ES) and $0.94 per micro (MNQ, MES). The read-out's `Today`, the account's balance and the Journal's net all take it off. A trade's R in the Journal is its net over the risk every entry put at its stop.
- `order-runtime-gone` sends an order now or not at all: while the runtime is unreachable the ticket's orders are off and say why, and nothing clicked then goes out once it is back.
- `order-runtime-hung` is the same rule when the runtime is alive but stopped: a Buy market click is refused once it wakes, a second click does not go, and the ticket says unknown, then late.
- `order-drag` moves a stop, target or resting entry from its tag or its price line on the chart, plain or bracketed. Only a position's tag drags out a new stop or target. A stop or target taken through the market is refused on the chart and nothing is sent. A resting entry takes its bracket along at the same distances, however far it moves, past its old target or stop included.
- `order-popout` shows an order refused in a pop-out chart window in that window, with Retry, and not in the main window.
- `order-right-click` drops the order in hand on a right-click (a two-finger click on a Mac trackpad). A chart or DOM drag puts the order back and sends nothing, a held DOM press sends nothing, a placement on the chart or the DOM ends, and no menu opens. With nothing in hand, a right-click opens the menu.
- `order-stop-rules` moves a bracket's stop by its rules, set in the ticket's Bracket › More: `Breakeven` (ticks of profit, then the entry plus ticks, once) and `Trailing` (ticks behind the best price, from `+N t` of profit, in steps of `Trail step`), only ever tighter. Paper moves the stop itself on each print; on Rithmic the runtime's bracket manager moves it by a modify (`crates/tessera-rithmic/tests/orders.rs` proves that path on the fake gateway).
- `order-rate` caps each account at 6 orders a second that open or add (or change a working entry): the seventh is refused and new entries pause for 10 s, with `Too many orders: more than 6 in a second. New entries pause for 10 s, until 14:42:40. Exits, stops, targets and cancels still go` under the ticket's buttons and in the status line. Exits, stop and target moves, cancels and Flat still go during the pause. On the frozen sim the clock never moves, so the pause never ends there; `crates/tessera-broker/tests/orders.rs` (`more_than_six_entries_a_second…`) proves its end on a manual clock.
- `order-loss-lock` acts on the daily loss limit (Settings › Trading and risk): once the day's loss, closed and open, reaches it, Tessera cancels the account's working orders, closes its positions and refuses new entries until the next session opens at 18:00 New York, even if the limit is changed. The ticket's line under its buttons and the Accounts tile say `Daily loss limit reached · new entries from 18:00 · exits work` (`Sun 18:00` on a Friday), the voice says `Loss limit reached.`, and the chart shows Tessera's note. It flattens once per lock, sizing each close from a fresh read of the position, and leaves the account alone after that; it tries again in 10 s only when it could not reach the account. `crates/tessera-broker/tests/protection.rs` proves the breach, flatten, refusal and the next session's unlock on Paper with a moving tape, and `crates/tessera-rithmic/tests/orders.rs` (`the_loss_lockout_…`) proves on the fake gateway that a late position update never makes it sell a closed position; the frozen sim's loss never moves, so on the sim set a limit under the round trip's spread and commission (`$5`): one `Buy market` and `Flat` lock the account.
- `order-exit-never-opens` sizes every closing order (reduce-only: Flat, a position's stop or target, a breakeven stop, a copied exit) when it goes, from a fresh read of the position: one larger than the position goes out at its size, and one with nothing to close is refused with `No open position for this exit to close; nothing sent.` No single stop or target stays larger than the position after a partial exit. On Rithmic the position counts the order plant's fills before the P&L plant shows them, and a position's stop and target go out as one OCO group, so Rithmic cancels the other when one fills, with the app closed too. `crates/tessera-rithmic/tests/orders.rs` proves each on the fake gateway with the P&L update late or missing.
- `order-limits` refuses, in the runtime, an order a real futures account could not take: one that needs more CME initial margin than the account's buying power, or opens more than 100 NQ or ES (500 MNQ or MES) at once. Every future Tessera knows has its margin (`crates/tessera-core/src/products.rs`); one it has no margin for opens nothing: `Paper has no margin for XYZ, so it does not open positions in it. Exits work.` Exits always go. The ticket says why under its buttons. The $ Risk box shows its whole amount and sizes by the money over the stop.
- `order-elsewhere` keeps every account's working orders in view: with the ticket on one account, another account's orders on the chart's contract show on the chart and the DOM dimmed under that account's name (`Paper 2 · Buy limit 1 · …`, a DOM chip `Paper 2 · 1`), and a click on one puts the ticket on that account. The Accounts table's `Open` column counts each account's working orders (`3 working`) beside its position.

## How to get to it (user POV)

- The Desk's right sidebar, `region "Trade"`, holds `region "Ticket: NQ Z6"` for the active chart's market: `button "Account: Paper, $100,000"`, `"Paper read-out"`, and the buttons of `group "NQ Z6 orders"`. At 1920×1080 and 1280×800, in every desk preset, that working-orders list stays in the Trade pane without scrolling while a draft waits.
- The `Positions` tab at the bottom lists positions, orders and fills. A desk that opens flat keeps the bottom edge on its tab strip, and an order or a fill leaves it there, so the charts and the ticket never move at entry. The tab counts open positions (`Positions 1`). Tap it to open the edge.

## Driving it with the e2e MCP

Preconditions:

- The baseline in `README.md`: doctor prints `accounts: Paper (paper)`, and `"Paper read-out"` shows `Position` `Flat`.

- **Bracket on.** Open the ticket's `Bracket` section and turn its switch on. Its stop and target read 40 and 80 ticks.
- **Buy.** Tap `button "Buy market"`. The charts keep their size and the tab strip reads `Positions 1`. `"Paper read-out"` reads `Open P/L` `−$5` and `Today` `−$7.87` (the open loss and one side's $2.87). Tap that tab: `table "Positions, orders and fills"` shows `row "NQ Z6 Long 1 20,641.50 20,641.25 −$5.00 $0.00 Paper"`. Run `runtime.ts <port> portfolio.get_positions`: one position, `accountId` `paper-main`, `qty` 1, `avgPrice` 20641.5.
- **Bracket.** Run `runtime.ts <port> portfolio.get_orders`: the `entry` (buy market) is `filled` with `request.bracket` `{"stopLoss": null, "takeProfit": null, "stopTicks": 40, "targetTicks": 80}`, and the `stop_loss` (sell stop 20631.5) and `take_profit` (sell limit 20661.5) are `working`, 40 and 80 ticks from its `avgFillPrice`. Every order has `environment` `paper`.
- **Flat.** Tap `button "Flat"`. Run `runtime.ts <port> portfolio.get_positions`: `positions` is `[]`. Run `runtime.ts <port> portfolio.get_orders`: `stop_loss` and `take_profit` are `cancelled`, and an `exit` (sell market) is `filled`.
- **Journal.** Tap `button "Journal"` in `navigation "Areas"`. `region "today"` shows `−$10.74` (−$5.00 and two sides of $2.87), `1` trade, and W/L `0 / 1`, and no `vs avg day` line: the session's journal has no trading day before today.
- **Fees and R.** From flat, `Buy market` 1, type `9` in `textbox "Contracts"`, `Buy market` again (each entry gets its own bracket), then `Flat`. `Today` reads `−$107.40`: −$50.00 realized and 20 sides of $2.87. `portfolio.get_fills` shows fees 2.87, 25.83 and 28.7. In the Journal, the trade's page reads Net P&L `−$107.40`, Fees `−$57.40`, Risk `−$2,000.00` (10 contracts × 10 points × $20) and Realized R `−0.05R`. The frozen clock gives every fill the same time, so this cannot show R on a trade built in pieces over time; the journal's tests cover that.

## Breakeven and trailing

The frozen market never moves, so the stop only moves on the busy market (`docs/dev.md` §9), driven by a browser of its own on a sim started with `TESSERA_TEST_MARKET=busy` (`../SKILL.md`, Other sim knobs).

- **Set up.** Open `button "More"` in `region "Bracket"`, check `Breakeven` and `Trailing`. The steppers are `Breakeven trigger in ticks`, `Breakeven offset in ticks`, `Trailing distance in ticks`, `Ticks of profit before trailing starts` and `Trailing step in ticks`. With the fold closed, the More button reads `Breakeven 20 · Trail 20`.
- **Buy.** `Buy market` with a wide stop (160 ticks) so the busy tape does not stop it out. `portfolio.get_orders`: the `stop_loss` is `working` with `stopRules` `{breakeven, trail, entryPrice}`, `entryPrice` the entry's `avgFillPrice`.
- **Moves.** Once a print is the breakeven trigger past the entry, the stop is at the entry plus the offset and `stopRules.breakevenDone` is true. Once the best print is the trail's start past the entry, the stop follows the best print at the trail's distance, in whole steps. The chart's `SL` tag moves with it, and no move loosens it.
## Order rate

Playwright's clicks land about 180 ms apart, too slow to reach 6 a second, so fire them from the page: on `MNQ Z6` with `Bracket` off, click `Buy bid` and `Sell ask` in turn seven times, 40 ms apart (`element.click()` in `page.evaluate`). `portfolio.get_orders` holds six working limits and the status line reads `Not sent · Paper · Too many orders: …`. `Cancel` then cancels all six, and another `Buy bid` is still refused.

## Paper limits

The sim's Paper account holds $100,000, so it can carry 2 NQ, 3 ES, 21 MNQ or 38 MES (CME initial margin $45,532, $25,777, $4,553 and $2,577, `crates/tessera-core/src/margin.rs`).

- **Over margin.** Tap `button "10"` in `group "Contract presets"`, then `Buy market`. Under the order buttons `status` reads `10 NQ need $455,320 of margin; the account has $100,000 of buying power · Not sent`. `portfolio.get_positions` is `[]`.
- **Risk sizing.** Pick `MNQ Z6` in `combobox "Contract to trade"`, `check` the `switch "Risk"` (a tap on the word beside it toggles it too), type `1000` in `textbox "Money at risk"`, tap a neutral spot (Tab lands on the switch, whose tooltip covers `Sell market`), tap `Sell market`, then `tap_at` (150, 259) on the 768 by 480 screenshot: 20,674.00, 131 ticks above the bid. The entry tag reads `Sell market 15` ($1,000 over 131 × $0.50) and the click fills it: `portfolio.get_positions` shows `qty` −15, and `portfolio.get_accounts` `buyingPower` 31,705.
- **A risk too big for the account.** Type `1000000` in the same box: it reads `1,000,000` in full and the tag `Sell market 15267`. The same click is refused: the ticket's line reads `15,267 MNQ need $69,510,651 of margin; the account has $100,000 of buying power · Not sent`, and `portfolio.get_orders` stays `[]`.
- **Too little risk.** Type `50`: the same stop says `One contract to this stop risks $65.50, over the $50 at risk: click it closer` under the chart, and the click sends nothing.
- **Exits go.** Hold 2 NQ (`button "2"`, `Buy market`): `portfolio.get_accounts` shows `buyingPower` $8,926 from a fresh account ($100,000, less the $10 spread, less 2 × $45,532). A third is refused (`1 NQ needs $45,532 of margin; …`), `Flat` closes them, and the ticket's line clears.

## Runtime gone

The e2e session cannot cut the page's link to the runtime, so `../scripts/runtime-gone.ts <port>` drives a browser of its own on the session's runtime. From a flat Paper account it cuts the link, reads the ticket and clicks `Buy market`, restores the link, then lets the runtime swallow one `Buy market` and reads the notice. It ends with a `Buy market` that fills and a `Flat`, so the Journal gains one trade. It prints each step, saves screenshots to `.e2e/artifacts/verify/runtime-gone/`, and exits 1 on any failure.

- **Gone.** `Buy market` is off and the ticket's note reads `Orders are off until the runtime reconnects`.
- **Back.** No order reached the runtime from the click while it was gone.
- **No answer.** The notice reads `No answer from the runtime · Paper · Check Orders before sending it again`, with no `tools.invoke` or timeout in it. `Buy market` for that click stays off; a Sell or a limit at another price stays on. A repeat of the same order says `Not sent · Already sending this order` next to that warning; it does not close it. The held click releases after twice the ticket deadline, without a reload, and the next `Buy market` fills.

## Runtime hung

The e2e session cannot pause the runtime, so `../scripts/runtime-hung.ts <port>` drives a browser of its own on the session's runtime. From a flat Paper account it SIGSTOPs the runtime process (found by the session port, never by name), clicks `Buy market`, waits until the ticket says there was no answer, clicks again, SIGCONTs, then reads the notice and Paper orders. It prints each step, saves screenshots to `.e2e/artifacts/verify/runtime-hung/`, and exits 1 on any failure.

- **Hung.** After 20 s the notice reads `No answer from the runtime`, and `Buy market` stays off.
- **Awake.** No order reached the runtime from either click. The notice reads `Not sent` / `Too late`. Approve and Buy market work again without a reload.
- **Now.** A later `Buy market` fills, then `Flat`. Two Buy limits of the same size at different prices are two orders. A second click of the same order while the first is still open is not sent and says `Not sent`; the first click's note stays. Only a true resend of the same order is held as one click.

Dragging orders on the chart (`order-drag`), from a fresh Buy with `Bracket` on:

- **Through the market.** `drag` the `group "SL 20,631.50 · −$200 · 40t"` tag onto the `group "TP 20,661.50 …"` tag. The stop tag stays at 20,631.50, and `contentinfo "Status and notices"` shows `Not sent · Paper · Stop 20,661.50 is above the market (20,641.25): it would stop out at once`. In the runtime's data directory, `tessera.db` table `tool_calls` has no `orders.modify`.
- **While moving.** `press` `ArrowUp` on the stop tag (each press is a tick; `times` is at most 20). Past 20,641.25 the line under the chart says `Stop 20,641.50 is above the market (20,641.25): it would stop out at once`; `Enter` there refuses it the same way. From 20,631.50, 14 presses and `Enter` move it: `portfolio.get_orders` shows the `stop_loss` at 20635 and `tool_calls` one `orders.modify`.
- **A resting entry.** `Flat`, tap `button "Buy limit"`, then `tap_at` the chart under the ask. Its tags read `Buy limit 1 · 20,6…`, `SL … · −$200 · 40t` and `TP … · +$400 · 80t · 2.0R`. Press `ArrowUp` 8 times on the entry tag: all three tags move 2 points with the same money, ticks and R. `Enter`, then `portfolio.get_orders`: the `entry` limit and the `held` `stop_loss` and `take_profit` all moved by 2 points, and `tool_calls` has one `orders.modify`, for the entry.
- **A plain limit.** With `Bracket` off, right-click the chart under the market and pick `Buy limit 1 @ …` (it reads `no bracket`). `portfolio.get_orders` has the entry with `request.bracket` `null` and no `stop_loss` or `take_profit`. Drag its price line up 2 points: `portfolio.get_orders` has it at the new price and `tool_calls` one `orders.modify`, for that entry.
- **Past its target.** From that resting entry (`Buy limit 1 · 20,614.00` with `TP 20,634.00`), drag the entry tag up about 25 points with the mouse, to just under the ask (Playwright `mouse.down`, moves, `mouse.up`; the e2e `drag` needs a node to drop on). On release the three tags stay where the drag left them (`Buy limit 1 · 20,639.25`, `SL 20,629.25`, `TP 20,659.25`), the status line shows no refusal, and `portfolio.get_orders` has the entry at 20639.25 with `request.bracket` 20629.25 / 20659.25 and the held legs at those prices.

## Prices down

The e2e session cannot take the mock market down by itself, so `../scripts/paper-outage.ts <port> [evidence dir]` drives a browser of its own on the session's runtime, with the same refusals as `runtime-gone.ts`. It finds the runtime by the pid listening on the session's port, never by name. It prints each step, saves screenshots to `.e2e/artifacts/verify/paper-outage/`, and exits 1 on any failure.

- **Live.** It taps `Buy market`, and Paper holds `+1 @ 20,641.50`.
- **Down.** It sends `kill -USR1` (`docs/dev.md` §9) and waits until the ticket reads `No live prices`. Then it taps `Sell market`. The close passes the runtime's price gate (`stale-numbers.md`), and Paper refuses it. `contentinfo "Status and notices"` reads `Not sent · Paper · No live price for NQZ6 since 14:42`, no order reaches `portfolio.get_orders`, and the position stays `+1`. Then it taps `Flat`. The status line reads `Not flat: No live price for NQZ6 since 14:42. Nothing sent. 1 NQZ6 still open with its exits working`, the stop and target stay on the chart, and the position stays `+1`.
- **Back.** It sends `kill -USR2`. `Sell market` fills at the bid, 20,641.25, and the account is flat.

## Pop-out chart

A pop-out chart window has its own strip at its foot, `contentinfo "Notices"`. It shows what was done in that window, refusals and Retry included, and nothing from the main window. What no one window caused (a connection dropping, an alert firing, a copier note, an update) shows in the main window's `contentinfo "Status and notices"` only. The e2e session does not follow a window the app opens, so `../scripts/popout-refusal.ts <port> [evidence dir]` drives a browser of its own on the session's runtime, with the same refusals and the same SIGUSR1/SIGUSR2 as `paper-outage.ts`. Start it on a new session: it needs the baseline desk. It prints each step, saves screenshots of both windows to `.e2e/artifacts/verify/popout-refusal/`, and exits 1 on any failure.

- **Pop out.** On the main window, `Pop out the chart` from the command palette opens `NQ Z6 5m` in a window of its own. There, `button "Trade"` opens its `region "Ticket: NQ Z6"`; `Buy market` makes Paper `+1 @ 20,641.50`.
- **Down.** With the mock market down, the pop-out's `Sell market` and then `Flat` are refused by Paper. The pop-out's `contentinfo "Notices"` first reads `Not sent · Paper · No live price for NQZ6 since 14:42`, then `Not flat: No live price for NQZ6 since 14:42. Nothing sent. 1 NQZ6 still open with its exits working · Paper · Working entries are cancelled` with `2` notices and `button "Retry"`. The main window's `contentinfo "Status and notices"` has the market's outage and no refusal.
- **Retry.** With the market back, `Retry` in the pop-out flattens the position.

## Right-click drops the order in hand

The e2e grammar cannot hold the left button while it presses the right one, so `../scripts/right-click-drop.ts <port> [evidence dir]` drives a browser of its own on the session's runtime, with the same refusals as `runtime-gone.ts`. It counts what was sent from `tool_calls` in the runtime's `tessera.db` (the runtime's `--data-dir`). Start it on a new session: it needs the baseline desk, and it ends on the Scalp preset, flat with nothing working. It prints `ok` or `FAIL` for each check and saves screenshots to the evidence directory.

- **Nothing in hand.** A right-click on the NQ chart opens `menu "Chart menu"`.
- **Placing.** `Buy limit`, then hover the chart under the ask. The hint reads `Click the buy limit's price …` and a `Buy limit 1 · …` tag follows the pointer. A right-click opens no menu and removes the hint and the tag. A left click after it sends no `orders.submit`.
- **Dragging.** `Buy market`, then press the `SL 20,631.50` tag and move it up until it reads `SL 20,637.75 …`. A right press with the left button still held puts it back at `SL 20,631.50` and opens no menu. Letting go sends no `orders.modify`, and `portfolio.get_orders` keeps the `stop_loss` at 20631.5. A control drag let go without the right press sends one `orders.modify`.
- **DOM.** On Scalp, in `NQ Z6 depth of market`, a held press on the 20,639.00 bid and then a right press opens no `menu "Ladder menu"`, and letting go sends no `orders.submit`. A Buy limit resting at 20,639.00, dragged three rows down and right-pressed, stays at 20639 with no `orders.modify` (a control drag moves it). With `Risk` on, a click on the 20,640.50 bid asks for the stop, and a right-click on the 20,639.50 bid opens no menu and ends the placement.

## Other accounts' orders

- Put the ticket on `Paper 2` (the account picker in the ticket's header), right-click the NQ chart below the price and take `Buy limit` with the ticket's bracket on: `Working · Paper 2 · Buy limit 1 …`. Put the ticket back on `Paper`.
- The chart keeps the entry, its SL and its TP as dimmed tags reading `Paper 2 · …`, the Scalp preset's DOM shows `Paper 2 · 1` on the bid, and Positions › `Accounts` reads `3 working` on the `Paper 2` row. A click on the dimmed entry tag puts the ticket on `Paper 2`, and its own tags come back at full strength.

## Gotchas

- `Flat`, `Cancel`, `Breakeven` and `Reverse` are disabled while the account is flat. `Flat` is the filled exit only while a position is open.
- `Breakeven` on a position without a stop offers one at the entry, but the frozen market never passes the entry, so the runtime refuses it: `Price hasn't passed your entry (…) yet; no stop sent.`
- The frozen market never moves, so a stop or target never triggers, and a round trip of one NQ loses the spread, $5.
- On the frozen market the page's quote is the fill, so legs placed from the fill look the same as legs priced from the page. Telling them apart needs the busy market (`docs/dev.md` §9), which a session gets only from the MCP server's environment (`../SKILL.md`, Other sim knobs): there, with the page fresh or slowed by CDP CPU throttling, the legs sit exactly 40 and 80 ticks from `avgFillPrice`.
- The ticket trades the active chart's market. Check the ticket's name, `Ticket: NQ Z6`, before you buy.
- `drag` drops on another node, so it shows only where a drag ends. To see the chart while an order is moving, move its tag with the arrow keys.
- Headless Chromium on Linux fires `contextmenu` on the right press, as WebKit does on macOS and Linux. Windows WebView2 fires it on the release, after the drag is gone: `apps/desktop/test/chart-order-drag.test.tsx` and `apps/desktop/test/dom-controller.test.ts` cover that order.
