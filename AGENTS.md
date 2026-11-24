# Tessera — agent guide

Agent-first trading research and execution platform. Product, users and principles: `PRODUCT.md`. Architecture: `docs/architecture.md`.

## Product
- Build general systems from first principles. Solve the general case — an indicator sizes itself to what it actually draws, not "if daily" — and add a special case only when real use proves the general rule cannot cover it.
- Tessera just works. Features handle hard cases themselves and pick sensible defaults — a profile picks a row size that fits; a daily footprint still draws.
- Quietly fall back first to the closest thing that works. Never show internal limits, raw errors, explanatory essays, disabled tags or setup steps.
- Only when something truly cannot work at all, say so in a few plain words, the way macOS does.
- An error a trader sees says what happened and what to do, in plain words. Provider codes, tool names and raw runtime text stay in the logs; the desktop turns them into words in one place, `apps/desktop/src/shell/deskWords.ts`, and `desk-words.test.ts` keeps raw codes off the screen.

## Rules
- Never put credentials, tokens, account numbers, tailnet URLs or hostnames in tracked files. Secrets live outside the repo (e.g. `~/.config/tessera/`), referenced by path or env var.
- Do not enable paid APIs or subscriptions without a maintainer's approval.
- Domain logic stays out of React components; provider-specific logic stays behind provider interfaces.
- In Rust, a shared job has one home; look there before writing it: SQLite opening and block storage in `tessera-store`, `Backoff`, ids, slugs and CSV in `tessera-core`, HTTP clients in `tessera-http`, the only crate that builds one (a test fails on any other).
- Market-intelligence values keep their vendor identity and original semantics; normalized concepts never silently replace them.
- Present research as measured statistics vs hypotheses vs model interpretation; never as guaranteed outcomes.
- No users yet, so no migrations.
- Nothing owner-specific is hardcoded: no single firm, timezone, instrument or account. When the analyst trades is the user's choice (Settings › Analyst › Trading sessions and their own instructions), never in code.
- UI follows the brand rules and reuses the existing kit. A UI change ships with main-vs-PR screenshots. A disabled control says why in a tooltip.
- PR proof (screenshots, GIFs, videos) goes in the PR body or its comments, never committed: no `pr-*/` folders, no evidence media outside the app's asset folders (`bun run evidence`).
- Don't change big-trades detection or Auto sizing unless asked.
- Never drop Linux, Windows or Mac from CI.
- Never open a GitHub issue for your own follow-up work; a maintainer decides what is tracked there.

## Process
- Work the pstack way. `.claude/settings.json` installs pstack from `cursor/plugins` and updates it at every Claude Code start.
- Before a task that needs rigor, read pstack's `poteto-mode` skill in full and follow it. The skill list hides it, so read the newest `~/.claude/plugins/cache/cursor-plugins/pstack/*/skills/poteto-mode/SKILL.md`. A person starts it with `/pstack:poteto-mode`. If the ask is loose, rewrite it with pstack's `sharpen` skill first.
- A change is done when `.agents/skills/verify-tessera/` has proved it on the sim runtime: the mock market, the Paper account, and no login. Keep its feature map current with pstack's `maintain-verification-skill`.
- Each task ends as one PR against main, opened by the agent.

## Builds
- Each checkout builds into its own `target/`. Never point two checkouts at one `CARGO_TARGET_DIR`: cargo would hand one the other's stale build (`docs/dev.md` §8).
- UI-only work never builds Rust. The sim (`e2e/agent/support/serve.ts`), `bun run serve`, `bun run tauri:dev` and the smoke test run main's prebuilt runtime from `~/.cache/tessera/bin` (or `TESSERA_PREBUILT_DIR`) when nothing the Rust code reads changed since that build's commit; otherwise cargo builds it. Run the Vite dev server against it with `TESSERA_RUNTIME=bin TESSERA_RUNTIME_BIN=~/.cache/tessera/bin/tessera-runtime bun run dev`.
- Keep incremental builds on: sccache never shares a build between two target directories, and a one-line edit to the runtime rebuilt in about 30 s incremental against about 100 s without.

## Comments
- No comments. Names, types and tests carry the meaning. Before review, run pstack's `/no-comments` over the diff.
- A comment survives only when it states something we cannot change: a broker, Rithmic or exchange quirk, an OS, webview or browser bug, a vendor limit, or a license. Our own design choices, invariants, units and module overviews are not exceptions.
- When code seems to need a comment, fix the code: rename it, extract a named function or constant, add a type, or delete the dead path. A rule such as "do not remove" or "keep in sync" becomes a test, a type or a check.
- Never write a comment that explains a change or a deletion. That belongs in the commit message.
- `bun run check` fails on any comment that is not listed in `scripts/kept-comments.json` (`bun run comments` runs that step alone). Add an entry only for a comment that meets the rule above. Reviewers read that file's diff. Tool directives (`eslint-disable`, `@ts-expect-error`, `prettier-ignore`) and `// SAFETY:` notes on `unsafe` blocks, which clippy requires, are exempt. So are Rust doc comments that schemars or clap turn into tool schemas or `--help`: they are text an agent or a user reads, so write them for that reader. A type's or variant's doc says more than its name (`/// Cancelled.` on `Cancelled` fails); every field keeps one, since each tool schema property carries a description. A `TS` derive alone exempts nothing: the generated bindings are read by us.

## Testing
- Bun is the package manager and script runner: `bun install`, `bun run <script>`. Always write `run`: `bun test` and `bun build` are Bun's own test runner and bundler, not this repository's scripts. `bun run check` is everything a pull request must pass (`docs/dev.md` §8).
- New end-to-end tests use e2e (`e2e/agent/`, `docs/dev.md` §9); read `.agents/skills/e2e/SKILL.md` before writing or running one. Commit the recordings a run writes under `.e2e/cache/` after reviewing them.
- What only the desktop app does with its windows (pop-outs, focus, which window is in front, size) is tested on the real Tauri app in `e2e/tauri/` (`bun run e2e:tauri`, Linux; `docs/dev.md` §9). A caught bug that is not fixed yet stays as `it.fails('bug: …')`.
- e2e runs on your own ChatGPT login in `~/.config/e2e/` (never copy it) and with `E2E_TELEMETRY_DISABLED=1`; no API keys.
- Broker tests use the fake Rithmic gateway. Never log into a real broker or place a real order.
