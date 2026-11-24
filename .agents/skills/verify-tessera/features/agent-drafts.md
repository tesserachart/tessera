# Agent drafts

An order from an agent (the analyst or one of the user's MCP clients) is a draft the user approves in Tessera. The draft card shows in the desk's Analyst panel; nothing reaches the account until the user approves it.

## Sub-features

- `draft-card` shows a client's draft: the order, its price and distance from the last price, `Drafted by` and the client's name, then `Approve on paper`, `Edit` and `Reject`.
- `draft-edit` edits an order draft with the ticket's controls, starting from the stop and target Approve would send; a leg turned off there stays off on the edited draft: `Side` (`Buy`, `Sell`) and `Order type` (`Market`, `Limit`, `Stop`, `Stop limit`) buttons, a `Contracts` stepper, tick-stepped `Limit price` and `Stop price` fields, and `Stop` and `Target` rows. Drafts of other tools keep the generic form.
- `draft-bracket` fills the stop and target an entry draft lacks from the trader's bracket for that account and contract (the one the Trade ticket shows): the card shows `Stop` with its price and risk and `Target`, the by-line ends `stop and target from your bracket`, and Approve sends the entry with them. With the ticket's bracket off the card reads `Stop` `None` and `Target` `None`, and Approve sends the draft as it is. A draft's own legs stay, and a draft that closes the position gets none.
- `draft-reply` tells the client the draft is not sent, until when it waits, and that it then expires unsent.
- `draft-expired` keeps an expired draft in the conversation, reading `Expired` `Not sent`, until the user taps `Dismiss`.
- `composer-placeholder` offers typed orders (`Ask, or type an order`) only while a model is on; without one it reads `Ask the analyst`.

## How to get to it (user POV)

- The Desk's right sidebar, `region "Analyst"`, with `textbox "Ask the analyst"` at its foot. A waiting draft docks above it in `region "Waiting drafts"` as `group "Draft"`. At 1920×1080 and 1280×800, in every desk preset, `button "Approve on paper"` and `button "Reject"` stay in that pane without scrolling. While Trade is the right edge's shown tab, the Analyst tab and the rail's `button "Analyst"` count the waiting draft.
- The rail's `button "Analyst"` (⌥3) opens the Analyst page: the same conversation, sessions and composer at full size, with the same draft cards. Maximised, the panel shows the same.

## Driving it with the e2e MCP

Preconditions:

- The baseline in `README.md`, with no model turned on.

- **Draft.** Run `../scripts/mcp-draft.ts <port>`. It connects an MCP client named `MCP client`, sends it an `orders_submit` for a paper buy limit 150 points under the last price, and prints the client's reply. The reply starts `Drafted, not sent: it waits for the user's approval in Tessera until` and says `it expires and nothing is sent`. `region "Waiting drafts"` shows `group "Draft"` with `Buy 1 NQ Z6`, `Drafted by an MCP client` and `button "Approve on paper"`. Run `runtime.ts <port> portfolio.get_orders`: no new order.
- **Edit.** Draft with `mcp-draft.ts <port> sell 60`, then tap `button "Edit"` on the card. `region "Edit the draft"` shows `button "Sell"` pressed, `button "Limit"` pressed and `textbox "Limit price"` at the drafted price. With the ticket's `Bracket` on, the form starts from what Approve would send: `Stop` and `Target` are ticked at the card's prices (40t and 80t from the entry by default). Tap `button "Up a tick"` beside the limit price twice, then `button "Save"`. The card comes back with the new price. Approve it: `portfolio.get_orders` has the sell limit two ticks higher with `bracket` `stopLoss` and `takeProfit` at those rows' prices, and the chart shows its SL and TP tags. `Save` with nothing changed closes the form and makes no new draft.
- **Approve with the bracket.** Within the draft's minute, with the ticket on `Paper` and `Bracket` on at its default 40t · 80t, the card shows `Stop` 40 ticks under the limit with `−$200`, `Target` 80 ticks over it, and `Drafted by an MCP client · stop and target from your bracket`. Tap `button "Approve on paper"`. `portfolio.get_orders` has the buy limit working with `request.bracket` `stopLoss` and `takeProfit` at those prices and its stop and target held, and the chart shows the entry's `SL` and `TP` tags.
- **No bracket.** Turn `Bracket` off on the ticket before drafting. The card reads `Stop` `None` and `Target` `None`, and an approved entry has `request.bracket` `null`.
- **Reject.** Within the draft's minute, tap `button "Reject"` on the card. The card and the chart's `Buy limit 1 · … · draft` tag go, and `portfolio.get_orders` still has no new order.
- **Composer.** With no model on, `textbox "Ask the analyst"` reads `Ask the analyst`.

## Gotchas

- The runtime's clock is frozen, so it never expires a draft, but the page's clock runs on. A minute after a draft, the card reads `Expired` `Not sent` and offers `Dismiss` while the runtime still holds the draft. `Dismiss` then only hides the card, the chart keeps its draft tag, and the client cannot draft that contract again in this session. The real `draft-expired`, with the runtime's stale event, shows only on the busy market (`TESSERA_TEST_MARKET=busy`, `docs/dev.md` §9), which a session gets only from the MCP server's environment (`../SKILL.md`, Other sim knobs): verify it with `apps/desktop/test/agent-drafts.test.tsx`, or on a busy test runtime driven by hand. There `approvals.staleAfterTicks` (1000 trades by default) ends a draft within seconds; `settings.set` it to `0` to expire by `approvals.staleAfterSeconds` alone.
- Every run of `mcp-draft.ts` connects another client (`other`, `other-2`, …). Settings › Analyst lists them.
