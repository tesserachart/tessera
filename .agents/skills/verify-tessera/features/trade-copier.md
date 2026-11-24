# Trade copier

A copy group mirrors one leader account's orders on its followers, each at its own size. The runtime keeps each follower's sync: what it holds against what it should hold at its size. The Trade copier is the one place to set groups up and watch them. On the sim runtime the leader is `Paper` (`paper-main`) and the followers are `Paper 2` (`paper-2`) and `Paper 3` (`paper-3`), all paper.

## Sub-features

- `copy-group` creates a group with a leader and two followers, sets a follower's contract to Micro, and turns the group on.
- `copy-entry` copies the leader's `Buy market` with its bracket to each follower at its size: NQ on a Same follower, MNQ on a Micro one, each with a stop and a target at the leader's prices.
- `copy-pause` skips a paused follower. Its row reads `Paused: …` with the runtime's reason and a red rule.
- `copy-resync` brings an out-of-sync follower to its size with a market order and a bracket at the leader's prices.
- `copy-flatten` flattens the leader and every follower with `Flatten all`, and cancels their brackets.
- `copy-breakeven` copies the leader's Breakeven to each follower. It needs the busy market (Gotchas).
- `copy-off` a new group starts off and says so: its switch reads `Copying off`, the sidebar row ends `· Off`, a line under the header reads `Off: trades on <leader> are not copied.` with `button "Start copying"`, and the followers' Copying switches are dimmed. Start copying (or the switch) turns it on, and the line goes.

## How to get to it (user POV)

- `button "Trade copier"` in `navigation "Areas"`, ⌥9 or ⌘K `Go to Trade copier` opens the Trade copier page (`region "Trade copier"` with `heading "Trade copier"`): the group list (`navigation "Copy groups"`) and the selected group. It is a panel too: dragging that rail item onto the desk docks it there, and ⌘K `Show Trade copier` or the Panels library opens it on the desk.
- With no groups the panel shows one line and `button "New group"`. `region "New group"` holds `checkbox "Paper 2"`, `checkbox "Paper 3"`, the `Group name` field and `button "Create"`.
- A group is `region "<name>"`: `switch "Copy <name>"`, `button "Resync"` (only while a follower is out of sync), `button "Flatten all"`, `table "<name> followers"` and `region "Recent copies"`.
- A follower row (`row "Paper 2 …"`) holds `radiogroup "Paper 2 contract"` (Same, Micro), `switch "Copy to Paper 2"` (off pauses it), and the buttons `Resync` and `Flatten` when they apply.

## Driving it with the e2e MCP

Preconditions:

- The baseline in `README.md`: doctor prints `accounts: Paper (paper), Paper 2 (paper), Paper 3 (paper)`, and every account is flat.

- **Group.** Tap `button "Trade copier"`, `button "New group"`, the two follower checkboxes, fill `Group name` with `Evals`, and tap `button "Create"`. In `table "Evals followers"`, tap `radio "Micro"` in `radiogroup "Paper 3 contract"` and `switch "Copy to Paper 2"` (off). Tap `switch "Copy Evals"`. Run `runtime.ts <port> copy.list`: one group, leader `paper-main`, `paper-3` has `micro` true, `paper-2` has `paused` true, `enabled` true.
- **Entry.** Open the Desk and tap `button "Buy market"` in `group "NQ Z6 orders"`. Run `runtime.ts <port> portfolio.get_positions '{"accountId":"paper-3"}'`: 1 MNQ Z6. `portfolio.get_positions '{"accountId":"paper-2"}'`: none. `portfolio.get_orders '{"accountId":"paper-3"}'`: a working `stop_loss` and `take_profit` at the leader's prices.
- **Pause.** Back on the Trade copier, the `Paper 2` row reads `Paused: …should hold Long 1 NQZ6` with a red rule, and `Paper 3` reads `In sync`. Run `runtime.ts <port> copy.status`: `paper-2` has `state` `out_of_sync`.
- **Resync.** Tap `switch "Copy to Paper 2"` (on), then `button "Resync"` in its row. `portfolio.get_positions '{"accountId":"paper-2"}'`: 1 NQ Z6, with a working stop and target at the leader's prices. The row reads `In sync`, and `region "Recent copies"` lists `Buy 1 NQZ6` and the resync.
- **Flatten all.** Tap `button "Flatten all"`. `portfolio.get_positions` is empty on all three accounts, and every stop and target is `cancelled`.

`e2e/agent/trade-copier.e2e.ts` runs these steps without a model (`bunx e2e run e2e/agent/trade-copier.e2e.ts`).

## Gotchas

- Breakeven moves a stop only once the market has passed the entry, and nothing moves on the frozen clock. To see it copied, start the sim on the busy market (`TESSERA_TEST_MARKET=busy node e2e/agent/support/serve.ts --port <port>`), buy on `Paper`, wait until the leader's position is a few ticks in profit, and tap `Breakeven`. `portfolio.get_orders` on each follower shows its stop at its own average entry.
- Out of sync waits 3 s before it shows. Until then the row reads `Copying…` while the copies are on their way.
- The group's switch applies at once, with no confirmation. A follower paused while it holds a position keeps it, and the row shows how far it is from its size.
- What one run sets up stays for the session. Delete the group (more menu, `Delete Evals`) and flatten the accounts before the next feature.
