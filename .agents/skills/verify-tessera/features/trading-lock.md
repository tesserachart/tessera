# Trading lock

The trader locks one account to new entries for a span, to stop revenge trading. It is the daily loss limit's lock (`risk.loss_locks` in the store, `lockedUntil` on the account's limits), set by hand: every order that opens or adds is refused in the runtime, from the ticket, an agent or the copier, while exits, stops and targets work and positions stay. Working entry orders are cancelled when it is set. It survives a restart, is never shortened, and lifts early only when Settings › Trading and risk › Allow unlocking early is on and the trader types `UNLOCK`. An agent reads it (`risk.get_lock`), may set it when asked (`risk.lock_account`), and never lifts it (`risk.unlock_account` is the user's alone).

## Sub-features

- `lock-menu` the account chip's menu has `Lock trading` with the spans: 5, 15 and 30 min, 1, 2 and 4 hours; Until market close (17:00 New York), Until tomorrow's open (09:30 New York), Rest of the trading day (18:00 New York); the New York, London and Tokyo sessions (the rest of one that runs, else until it opens). Each says when it would end, in the user's time zone; one that cannot be set now (market close during the Globex break) is dimmed with its reason.
- `lock-chip` a locked account's chip reads `Locked until HH:MM` in place of its net liq, and its tooltip is the runtime's words.
- `lock-ticket` the ticket's line reads `Trading locked until HH:MM · exits, stops and targets work`, and Buy and Sell are off; an order sent anyway is refused with `code` `account_locked` and the same words.
- `lock-restart` the lock holds after the runtime restarts on the same data directory.
- `lock-unlock` with Allow unlocking early on, the menu has `Unlock early…`, a dialog that unlocks only on `UNLOCK`.
- `lock-copier` a locked follower is skipped with the lock's words in the copy report; a locked leader's group copies no entries, and its exits are still copied.
- `lock-accounts` the Accounts panel's row reads `Locked until HH:MM`, and its detail header has the same lock menu.

## How to get to it (user POV)

- The Trade ticket's account chip, `button "Account: Paper, $100,000"`, opens `menu "Accounts"`; its `menuitem "Lock trading"` opens `menu "Lock trading"`.
- While locked the chip is `button "Account: Paper, Locked until 14:57"`.
- In the Accounts panel, select a row: the detail header's `button "Lock trading"` (or `Locked until HH:MM`) opens the same spans.

## Driving it

`scripts/trading-lock.ts [evidence dir] [ui dir] [pr|main]` starts its own sim runtime (New York clock and zone), opens the chip's menu, locks `Paper` for 15 min, reads the ticket line, Buy market and an `orders.submit` from the runtime, restarts the runtime on the same data directory and checks the chip again. It saves `pr-ticket.png`, `pr-menu.png`, `pr-locked-ticket.png`, `pr-after-restart-ticket.png` and the runtime's `risk.get_lock`, the refused `orders.submit` and `portfolio.get_orders`. With main's `dist` and `main` it shoots main's ticket and chip menu. It needs no e2e session.

With an e2e session:

- Tap the chip, then `menuitem "Lock trading"` and `menuitem "15 min"`. The chip reads `Locked until 14:57`. Run `runtime.ts <port> risk.get_lock '{"accountId":"paper-main"}'`: `lock.kind` `manual`, `lock.until` 14:57:30 New York.
- Tap `button "Buy market"`: it is off, and the ticket's line says why. Run `runtime.ts <port> orders.submit '{"accountId":"paper-main","instrument":"NQZ6.CME","side":"buy","qty":1,"orderType":"market"}'`: refused, `code` `account_locked`.

## Tests

- `crates/tessera-broker/tests/protection.rs` `a_locked_account_refuses_entries_from_anyone_and_keeps_its_exits_and_stops`: Paper; entries refused with the words, the preview's block, a stop moved and an exit sent, an agent in Full access refused and denied the unlock, an agent's shorter lock changes nothing, the unlock's setting and typed word, the lock lifting at its time.
- `crates/tessera-broker/src/lockout.rs`: a lock kept by the previous release reads back unchanged; a manual lock survives a restart of the store.
- `crates/tessera-rithmic/tests/copy.rs` `a_locked_follower_is_skipped_and_a_locked_leader_copies_only_its_exits`: the fake Rithmic gateway; nothing reaches it for a locked account.
- `crates/tessera-core/src/limits.rs`: each span's end in the exchange's clock across clock changes and weekends.
- `apps/desktop/test/lock.test.ts`, `apps/desktop/test/limits.test.ts`: the chip's and the ticket's words, the menu's groups.

## Gotchas

- The sim's clock is frozen at Friday 14:42:30 New York: a lock never ends on its own there. `Until market close` ends at 17:00 the same day; `Rest of the trading day` at Sunday 18:00.
- The span's clock times are the exchange's (CME: New York); the app shows them in `display.timeZone`. The script runs both in New York so the stills read 14:57.
