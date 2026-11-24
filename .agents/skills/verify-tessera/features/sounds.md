# Sounds

Each trading event the runtime reports is said aloud by the chosen voice (Daniel by default) or played as its tone: a fill by its order type, a stop or target hit, a position closed or reversed, a rejected order, a cancel, a lock, a connection lost or back, an alert. All of them play through one Web Audio context. When that context stops sounding, the app closes it and plays on a new one. That covers a closed context, one that will not resume, and one whose clock stops while it says it is running. The app checks this when a sound plays and once a second. The desktop's main window keeps its page running while hidden (`backgroundThrottling: "disabled"`), so WKWebView never suspends the page that makes the sounds.

## Sub-features

- `sound-fill` says `Market filled.` when `Buy market` fills and `Position closed.` when `Flat` closes it, one line per burst (`apps/desktop/src/sound/voice/director.ts`).
- `sound-survives` plays the next trade's line after the page's audio context is suspended, closed, or suspended while it still reports `running` (what WebKit leaves after a sleep or an output device change). No more than one context stays open.
- `sound-lock` an account that locks says `Loss limit reached.` when its daily loss limit locked it, and `Account locked.` for any other lock: the trader's own (`Lock trading`), the firm's rules, the firm's platform. A lock that changes cause says the new one; one already there when the app opens says nothing (`lockCause` in `apps/desktop/src/accounts/limits.ts`, the same cause the ticket's line words).
- `sound-rejected` `Order rejected.` plays on every rejected order: one the broker rejects (from the order's status on `orders`) and one Tessera refuses before it reaches the broker, from any origin (an `orders.submit` or `orders.reverse` that finishes on `tool.calls` refused with nothing sent). A refusal that did reach the broker is said once, from the order.
- `sound-connection` a lost connection is said as soon as its feed goes silent, not only once a reconnect is attempted: with ticks flowing, a market-data feed that sends nothing for 30 s of open market (a closed laptop, a socket that dies without closing) reports `degraded` and says `Connection lost.`; when the feed returns, the bars are read back from the last stored bar. `Connection restored.` comes only once data is flowing again and that hole has been filled. A feed that has delivered nothing since it opened (a replay) is never called lost, nor is one whose market is closed (the daily halt, a weekend, a holiday): silence counts from the reopen.

## How to get to it (user POV)

- Trade on the Paper account from the Trade ticket (`paper-orders.md`). The sound settings live in Settings › Alerts & sounds: the voice, the volume, mute, each event's switch and a `Play` button per event.

## Driving it

The e2e session cannot hear the page, so `../scripts/sounds-survive.ts <port> [evidence dir] [rounds]` drives a Chromium of its own on the session's runtime, with autoplay allowed as in the desktop shell. It wraps the page's `AudioContext` to count the contexts made and open, the voice lines and tones started, and those that played to their `ended` event, which only fires once audio rendered past the line's end. From a flat Paper account it trades once (`Buy market`, then `Flat`), then for each round suspends, stalls and closes the live context in turn, trading after each. It prints each step and the counts, writes them to `sounds.json` in the evidence directory (`.e2e/artifacts/verify/sounds/` by default), and exits 1 on any failure.

`../scripts/voice-lines.ts [evidence dir] [ui dir]` starts its own sim runtime, tags each voice clip the page starts by its file, and checks what is heard: `Lock trading` › `15 min` on Paper's chip says `account_locked`; an `orders.submit` on the locked Paper says `order_rejected`; Paper 2 buying at market, then a $1 daily loss limit on it, says `loss_limit`. It writes `voice-lines.json` and `locked.png` (`.e2e/artifacts/verify/voice-lines/` by default) and exits 1 on any miss. With main's `dist` as the ui dir it shows main's lines for the same steps.

- **Each trade.** `Buy market` and `Flat` each play one voice line to its end within 6 s.
- **End.** One context open, and no more contexts made than mishaps plus one.

## Gotchas

- Chromium on Linux is not WKWebView on macOS. The script shows the app replaces a context that is closed, suspended or stalled in a real Web Audio engine. Whether WebKit's own sleep, device and hidden-window behaviour is covered is shown by `apps/desktop/test/sound-output.test.ts`, which fakes WebKit's behaviour, not here.
- The voice director holds a trade line for a second after it ends, so the script waits 2.5 s between orders. Faster orders play one line for the burst, as designed.
