# Analyst sessions and New chat

The Analyst panel's session menu lists recent sessions and starts a new chat. New chat says why it cannot start when no model can, in the app's shared tooltip, and offers the one action that fixes it.

## Sub-features

- `new-chat`: with a provider ready, the menu's New chat and `⇧⌘J` both open a new conversation and put the keyboard in the composer.
- `reason`: with no provider ready, New chat is disabled and its tooltip says the missing piece on hover or keyboard focus: `Claude Code is off.`, `Claude Code is not signed in.`, `Claude Code is not installed.`, `Checking Claude Code…`, or the runtime's own words for a failed provider.
- `turn-on`: when the named provider is off, the menu's `Turn on Claude Code` (or `Turn on Codex`) turns it on where the trader is; once it checks ready, New chat enables.
- `settings`: when the provider is on but needs a sign-in, install or another fix, `Model settings…` opens Model & permissions on the same rows. `⇧⌘J` while blocked opens the same sheet instead of doing nothing.

## How to get to it (user POV)

The Desk's Analyst panel header, the `Sessions` button, then `New chat`; or `⇧⌘J` anywhere. The Analyst area shows the same menu in its header.

## Driving it on the sim

The sim's providers start off. Use the stand-in CLIs from `../scripts/` (never the real `claude` or `codex`):

1. Turn on Claude Code with `settings.set '{"key":"agent.providers","value":{"claude-code":{"enabled":true,"binaryPath":"<checkout>/.agents/skills/verify-tessera/scripts/stand-in-claude.mjs"}}}'` and `agent.list_providers '{"recheck":true}'`.
2. Start one session with `agent.start_session '{"preset":"Trader","provider":"claude-code"}'` so the session menu shows.
3. Turn it off again with `settings.set '{"key":"agent.providers","value":{"claude-code":{"enabled":false}}}'`.
4. Open the session menu: `New chat` is disabled, hovering or focusing it shows `Claude Code is off.` in the shared tooltip, and `Turn on Claude Code` is the row below it.
5. Choose `Turn on Claude Code`: New chat's tooltip changes to `Checking Claude Code…`, then the row disappears and `New chat` enables once the provider is ready.
6. With the provider ready, choose `New chat`: the panel shows the opening and the composer, and the session menu says `Sessions`.

Press `⇧⌘J` with the provider off: Model & permissions opens with both CLIs off and their `Turn on` buttons.

## Gotchas

- With no sessions at all the menu is absent; the analyst's empty state shows `Turn on the analyst` (no model on) or the chart's opening (a model ready) instead. Create a session before checking this menu.
- `agent.start_session` is user-only; the runtime refuses it from an agent or MCP client.
- The stand-ins answer with `Stand-in answer for the demo, not a model`; a screenshot cannot pass for a real analyst.
