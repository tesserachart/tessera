# Desk status when a feed drops

When the runtime or a feed is gone, every surface uses one wording source: what is wrong, what is still open, and what still works. No developer strings, no spliced sentences, no invented elapsed times.

## Sub-features

- `status-exposure` keeps an open position in its own slot, not inside the outage sentence.
- `status-words` names the outage in trader words (no `os error`, `tools.invoke`, or `ForcedLogout`).
- `dom-loading` covers the ladder with a skeleton, `status "Loading the book"`, until the first book arrives, and counts no seconds. The skeleton is measured from rows the ladder's own row builder makes, with the live ladder's columns; the time & sales does the same from its own rows (`status "Loading prints"`).
- `flow-retry` retries a stalled footprint or profile read and says it is trying again, then stops in trader words.
- `palette-after-drop` charts a desk symbol after search fails (Ctrl+K, ES, Enter), runs a highlighted command (Connections opens Settings › Connections), and leaves unknown text uncharted with “Search could not reach the feed.”

## How to get to it (user POV)

- The status line at the top of the desk, `status "Status"`.
- Scalp: Tessera menu › New from preset › `Scalp 1m order flow, Trade, DOM and time & sales`. Then `region "NQ Z6 · DOM"` and the footprint / CVD legend on `region "NQ Z6 1m"`.
- The command palette: Ctrl+K (⌘K), `dialog "Command palette"`.

## Driving it

The e2e session cannot cut the page's link, so `../scripts/feed-drop.ts <port>` drives its own browser on the session's runtime, the same refusals as `runtime-gone.ts`. It opens Scalp, takes a paper long, drops the socket, and saves shots of the status line, DOM, footprint, palette (Connections, unknown text, ES), and the desk after the link returns.

- **Position out of the sentence.** After the drop, `status "Status"` has source `Runtime`, fact `dropped.`, and exposure `Long 1 NQ Z6 open.` The concatenated line is not `Runtime Long 1 NQ Z6 open. dropped.`
- **DOM while loading.** Before the first book the ladder shows `status "Loading the book"` and no header; after a drop the strip is the dropped line. Neither ever shows a second count.
- **DOM after the link returns.** The book and the tape drop their dropped line on the first update that arrives, so once the link is back the ladder shows its book again, not `dropped`.
- **Retry now.** Offered only while the desk waits between attempts: the annunciator shows it with the countdown, the splash's button and its R key work. While an attempt runs the annunciator offers no action, and the splash's button is off with the tooltip `Already trying to reach the runtime`.
- **Footprint.** While it asks again the footprint keeps what it drew and paints nothing over the bars (`order-flow.md`, `of-loading`); once it gives up, its note is `stopped:` in trader words. It does not contain `tools.invoke` or `20000ms`.
- **Palette.** While the runtime is down: Ctrl+K `Connections` Enter opens Settings › Connections and never labels a chart, DOM, T&S or ticket with that word. Unknown text shows `Search could not reach the feed` and changes no instrument. `ES` Enter charts ES; DOM, T&S and ticket do not keep NQ prices or prints under the ES name. After the link returns, the desk still shows ES so the switch can be undone.

## Gotchas

- Paper only. The script refuses any runtime that is not the mock market with only paper accounts.
- A toast or the status line alone is not the proof: the script keeps the DOM, footprint and palette shots from the same drop.
