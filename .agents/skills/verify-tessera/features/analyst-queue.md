# Analyst queue and steer

While the analyst works, the composer keeps Send beside Stop. A message either steers the running turn or waits in the session's queue (T3 Code's model). The queue sends itself in order as turns end, can be edited or emptied, and waits after Stop until the user resumes it.

## Sub-features

- `send-mid-run`: while a turn runs, `button "Stop"` shows alone; once the composer has text, `button "Steer message"` (or `"Queue message"`) sits beside it.
- `steer`: Enter steers by default. The message shows as the user's words inside the running turn, and the analyst's answer follows it in the same turn.
- `steer-fallback`: a provider that cannot take a message mid-run queues it, and the composer's notice says so (`… so it's queued for when this run ends.`).
- `queue`: Cmd/Ctrl+Enter, or a Cmd/Ctrl-click on Send, queues. `region "N queued messages"` lists them over the composer, oldest first. `button "Edit queued message"` loads one into the composer (`button "Update queued message"`, Escape or `button "Cancel editing queued message"` gives the draft back) and `button "Remove queued message"` takes it out.
- `drain`: when a turn completes, the first queued message starts the next turn, and so on until the queue is empty.
- `stop-holds`: Stop keeps the queue but holds it. The list reads `Queued, paused` and, with an empty composer, `button "Resume queue"` replaces Send.
- `setting`: Settings › Analyst › Conversations › `While the analyst works` (`Steer`, `Queue`) is the default, the `agent.followUp` setting.

## How to get to it (user POV)

- The desk's Analyst panel (⌘J, or Ctrl+K `Show Analyst`; Maximise fills the desk with it and its sessions), or the Analyst page (`button "Analyst"` in `navigation "Areas"`, ⌥3): the same conversation, composer and queue at full size.

## Driving it on the sim

The sim never runs a real model. Run the analyst on the stand-in CLIs in `../scripts/`. They stream a fixed demo answer about 10 s long and talk the same wire protocol as the real CLIs.

- `stand-in-claude.mjs` is Claude Code 2.1.309's stream-json as observed, including a `priority: "now"` steer (an `aborted_streaming` result, then the answer to the steer).
- `stand-in-codex.mjs` is a Codex app-server without `turn/steer`: it answers that method with JSON-RPC `-32601`, as Codex builds without steering do. Use it for `steer-fallback`.

Turn them on as the user before the first message: `runtime.ts <port> settings.set '{"key":"agent.providers","value":{"claude-code":{"enabled":true,"binaryPath":"<checkout>/.agents/skills/verify-tessera/scripts/stand-in-claude.mjs"},"codex":{"enabled":true,"binaryPath":"<checkout>/.agents/skills/verify-tessera/scripts/stand-in-codex.mjs"}}}'`, then `agent.list_providers '{"recheck":true}'`. Never point a provider at the real `claude` or `codex` binary on the sim.

- **Steer.** Pick a Claude model in the composer, ask anything, and while `button "Stop"` shows type a second message and press Enter. The second message appears in the running turn and the answer that follows starts `Taking that on board mid-run`. `agent.get_transcript` shows its `user_message` with the running turn's `turnId`.
- **Queue, edit, remove.** While a turn runs, queue two messages with Ctrl+Enter, edit the second, remove the first. `agent.list_sessions` shows the session's `queue` with the edited text only.
- **Drain.** Wait for the turn to end: the queued message starts the next turn and the list empties.
- **Stop.** Ask again, queue one message, tap Stop. `agent.list_sessions` shows `queueHeld: true`. Tap `Resume queue`: the message starts a turn.
- **Fallback.** Start a new session on the Codex model, ask, and press Enter on a second message while it runs. The notice says Codex can't take messages mid-run and the message is in the queue, then drains when the turn ends.

## Gotchas

- The stand-ins print `Stand-in answer for the demo, not a model` in every answer, so a screenshot cannot pass for a real analyst.
- The runtime starts each CLI with a cleared environment and an allowlisted `PATH`, so the stand-ins need `node` on that `PATH`.
