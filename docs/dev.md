# Developing Tessera

What to install, the commands, where things live, and what to do when something goes wrong. The overview is
`docs/architecture.md`.

## 1. Prerequisites

| Tool                   | Version                             | Notes                                                                                                                                                                                          |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust                   | stable (MSRV 1.95)                  | `rust-toolchain.toml` pins the channel and adds `rustfmt` and `clippy`.                                                                                                                        |
| Node                   | ≥ 24                                | Vite, Vitest, Playwright, ESLint, Prettier, tsc, e2e and the Tauri CLI run on Node.                                                                                                            |
| Bun                    | ≥ 1.4.2 (`packageManager`)          | Package manager and script runner. Always write `bun run <script>`: `bun build` and `bun test` are Bun's own tools.                                                                            |
| cargo-nextest          | 0.9.150 (`.github/actions/nextest`) | Runs the Rust tests: `cargo install --locked cargo-nextest`, or the release archive from nexte.st.                                                                                             |
| Tauri system libraries | Ubuntu 24.04                        | Desktop shell only: `libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev build-essential pkg-config libssl-dev patchelf` |
| sccache                | optional                            | Used when installed and `RUSTC_WRAPPER` is unset (§5).                                                                                                                                         |

No database server, Docker or API keys: SQLite is bundled. Recording agent tests needs the e2e model login (§9).

## 2. First run

```sh
bun install
bun run dev         # Vite on http://localhost:5173 (or the next free port) + tessera-runtime
```

Open the launch link it prints once the runtime is ready (`http://localhost:5173/#ticket=…`; when the output is not a
terminal, the link is in the file it names). Each link works once (§6). The runtime connects your Rithmic login from
`~/.config/tessera/credentials.env` (§4); without one the app asks for a login.

The first run compiles the runtime (minutes cold, seconds after) while the page waits. The runtime is not
hot-reloaded: press `r` + Enter in the Vite terminal to restart it.

## 3. Commands

| Command                                            | What it does                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`                                      | Vite dev server plus a runtime started by its plugin (§4).                                                             |
| `bun run build`                                    | Type-check and build the UI into `apps/desktop/dist`.                                                                  |
| `bun run serve`                                    | `bun run build`, then `tessera-runtime serve --ui-dir apps/desktop/dist`; prints the launch link.                      |
| `bun run tauri:dev`, `bun run tauri:build`         | The desktop shell in dev; the release bundles (deb + AppImage, NSIS on Windows, `.app` + `.dmg` on a Mac).             |
| `bun run check`                                    | **Everything a pull request must pass** (§8). `--list`, `--only a,b`, `--skip a,b`, `--job rust,ts,e2e`, `--parallel`. |
| `bun run comments`                                 | The comment check alone (§8).                                                                                          |
| `bun run smoke`                                    | The release smoke test (`docs/release-smoke-test.md`); `--release` builds in release.                                  |
| `bun run test`                                     | Bindings and schemas checks, vitest and the Rust tests.                                                                |
| `bun run test:ts`, `test:rust`, `test:shell`       | vitest; `cargo nextest run --workspace`; `cargo test` of the Tauri shell (`apps/desktop/src-tauri`).                   |
| `bun run test:perf`, `test:perf:report`            | The timing tests (`*.perf.ts`), one file at a time, against loose or strict limits.                                    |
| `bun run bench:chart`                              | The chart frame bench (§8).                                                                                            |
| `bun run bench:load`                               | The chart load bench (§8): seconds from opening the app to each order-flow study drawn.                                |
| `bun run lint`, `lint:rust`, `typecheck`           | ESLint with zero warnings; `cargo fmt --check` and clippy for both cargo workspaces; `tsc --noEmit` everywhere.        |
| `bun run knip`                                     | Unused files, exports, types and dependencies (§8).                                                                    |
| `bun run format`, `format:check`                   | Prettier.                                                                                                              |
| `bun run gen`, `gen:check`, `gen:schemas:check`    | Regenerate the TypeScript bindings and their zod schemas, or fail when they are stale.                                 |
| `bun run e2e:install`, `e2e:agent`, `e2e:agent:ci` | Playwright's Chromium; the e2e agent suite recording, or replay-only (§9).                                             |
| `bun run e2e:tauri`                                | The Tauri window tests, Linux (§9).                                                                                    |
| `bun run site:dev`, `site:build`                   | The website (`apps/site`, Astro).                                                                                      |
| `bun run voices`                                   | Make the voice packs (§16).                                                                                            |

```sh
tessera-runtime serve [--port 0] [--data-dir DIR] [--ui-dir DIR] [--detached] [--launch-tickets] \
                      [--review-origin URL]... [--rithmic-credentials FILE] [--no-rithmic]
tessera-runtime mcp-stdio [--data-dir DIR]        # MCP over stdio for the user's own agent (§13)
tessera-runtime ticks export --instrument NQ --from YYYY-MM-DD --to YYYY-MM-DD --out DIR [--rth] [--source ID]
tessera-runtime build-info                         # {"version":…,"checkouts":[…]}
```

## 4. Run modes

| Mode    | Start               | UI served by                    | How the UI finds the runtime                                  |
| ------- | ------------------- | ------------------------------- | ------------------------------------------------------------- |
| Dev     | `bun run dev`       | Vite                            | `GET /runtime.json` from Vite, then the launch link (§6).     |
| Served  | `bun run serve`     | the runtime (`--ui-dir`)        | Its own origin, `http://127.0.0.1:PORT/#ticket=…`.            |
| Desktop | `bun run tauri:dev` | Vite in dev, bundled in release | `invoke('runtime_connection')` from the sidecar's ready line. |

`TESSERA_RUNTIME` picks what `bun run dev` starts: `auto` or `cargo` (`cargo run`), `bin` (`TESSERA_RUNTIME_BIN`),
`external` (`TESSERA_RUNTIME_URL`) or `none`.

**Market data.** Tessera has no data of its own: market data and instruments come from the user's Rithmic login,
levels from sources the user adds. Paper trading fills at that market's prices.

**Your Rithmic login in development.** The launchers pass `~/.config/tessera/credentials.env` (`$XDG_CONFIG_HOME`
honoured) to the runtime as `TESSERA_RITHMIC_CREDENTIALS` when it exists; set the variable to another file, or empty
for none. The file stays outside the repository, mode 600 (`crates/tessera-rithmic/src/credentials.rs`):

```sh
RITHMIC_USERNAME='<your login>'
RITHMIC_PASSWORD='<its password>'
RITHMIC_SYSTEM='<the system as Rithmic spells it>'
RITHMIC_GATEWAY='<the gateway, wss://…>'
```

All four keys are required and the gateway must be `wss://`. A bad file is left unused and the log says why. Logins
added in Settings › Connections are kept in the OS keyring instead. On a prop login keep live runs short and history
pulls small: tick replay goes one page of at most 10,000 prints at a time (`crates/tessera-rithmic/src/history.rs`).

**The first run.** With no market-data connection the window asks for a Rithmic login (`shell/Onboarding.tsx`), then
opens the desk on the login's first front month. To see it:
`TESSERA_DATA_DIR=$(mktemp -d) TESSERA_RITHMIC_CREDENTIALS= bun run dev`.

**Rithmic's directory** (the list of systems and gateways) is asked of the gateways in `TESSERA_RITHMIC_DIRECTORY`
(`wss://`, comma-separated), else the value built in (§14). When it is unset the launchers read
`~/.config/tessera/rithmic-directory`. The addresses are never committed.

**Levels.** None are built in. Add a source in Settings › Connections › Add connection: `Any API, with the analyst…`
or `Write a spec…`.

## 5. Ports and directories

| What             | Default                                                                                                                         | Change with                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Vite dev server  | `localhost:5173`, or the next free port                                                                                         | `TESSERA_UI_PORT` (exactly)          |
| Runtime          | `127.0.0.1`, a free port                                                                                                        | `--port N`                           |
| Agent e2e        | `127.0.0.1:47231`                                                                                                               | `TESSERA_E2E_AGENT_PORT` (`0`: free) |
| App data         | `$XDG_DATA_HOME/tessera`, else `~/Library/Application Support/Tessera`, `%LOCALAPPDATA%\Tessera\Data`, `~/.local/share/tessera` | `--data-dir`, `TESSERA_DATA_DIR`     |
| Development data | `~/.local/share/tessera-dev/<checkout>-<hash>`, one per checkout                                                                | `TESSERA_DATA_DIR`                   |
| Saved logins     | OS keyring; dev fallback `~/.config/tessera/secrets/`                                                                           | `TESSERA_SECRET_STORE=file`          |

A data directory holds `tessera.db` (settings, layouts, audit, sessions), `depth.db`, `bars.db`, `ticks/`, `blobs/`,
`agents/`, `backups/`, `feedback/`, `logs/runtime.log`, `tessera.lock` and, while serving, `discovery.json`. Delete a
checkout's development directory to reset it. One runtime per data directory: a second exits with status 3.

**Builds.** Dev and test profiles keep line tables only. With `RUSTC_WRAPPER` unset the scripts use sccache when it
is installed; `RUSTC_WRAPPER=` turns it off. For plain `cargo`, set `rustc-wrapper = "sccache"` in
`~/.cargo/config.toml`.

**Prebuilt runtimes.** A machine may keep main's `tessera-runtime` and `tessera-test-runtime` in `~/.cache/tessera/bin`
(or `TESSERA_PREBUILT_DIR`; empty turns it off) with their commit in `main.sha`. `bun run serve`, `bun run tauri:dev`,
the smoke test, the e2e sim and `bun run e2e:tauri` run them when `scripts/rust-affected.ts` finds nothing the Rust
code reads changed since, never for `--release`. `scripts/seed-target.ts` seeds a new worktree's `target/` with a
golden build's dependencies.

**Review on another device.** The runtime binds `127.0.0.1` only. Put it behind `tailscale serve` and pass that origin
with `--review-origin`. That URL never goes in tracked files.

## 6. Auth and the runtime token

The session token acts as the user. It travels only by pipe (the ready line), the desktop shell's IPC, and to a page
in the answer to a one-time ticket; never in a URL, a command line, a child's environment, browser storage or a log.
An analyst session's or MCP client's token (`tsk_…`) acts as that agent, never as the user.

- **One token per start**, `tss_` and 64 hex digits, in the ready line `{"event":"ready","port":N,"token":"…"}`.
  Every credential shape is redacted from logs, panics and reports (`crates/tessera-core/src/token.rs`).
- **`/ws`** checks the Origin (Tauri's, `localhost`, `127.0.0.1`, `[::1]`, each `--review-origin`), then wants
  `Authorization: Bearer` or a first `session.hello` with the `token` or a `ticket`. Anything else is refused
  (`-32001`). No cookies, no `?token=`.
- **The launch link** `<origin>/#ticket=…` is taken once. With `--launch-tickets` the runtime prints the next ticket
  each time one is used; when the launcher's output is not a terminal it writes `launch-link` in the data directory.
- **A page keeps the token in memory only** (`packages/bridge/src/session.ts`). Pop-outs get it from a live page over a
  `BroadcastChannel`; a reload uses a ticket held in `sessionStorage` for a minute.
- **Dev mode.** The Vite plugin never holds the token; `/runtime.json` gives only the port. **Tauri** hands port and
  token to each window over IPC.
- **Agents.** `/mcp` never accepts the session token, nor `/ws` an agent's (`crates/tessera-runtime/tests/isolation.rs`).
- **Lifetime.** The runtime exits when its stdin closes (unless `--detached`) and on SIGINT/SIGTERM.

## 7. Verify a run mode

Open the URL `bun run dev` or `bun run serve` printed, or drive the served build with an `e2e mcp` session (§9). The
desktop shell on a headless box:

```sh
xvfb-run -a -s "-screen 0 1600x1000x24" dbus-run-session -- bash -c '
  setsid bun run tauri:dev > /tmp/tauri.log 2>&1 & pid=$!
  until grep -q "platform=Some(\"tauri\")" /tmp/tauri.log; do sleep 1; done; sleep 10
  ffmpeg -loglevel error -f x11grab -video_size 1600x1000 -i "$DISPLAY" -frames:v 1 -y /tmp/tauri.png
  kill -TERM -- -$pid'
```

## 8. `bun run check` and CI

`bun run check` runs, stopping at the first failure: prettier, comments, evidence, rust-lint, bindings, schemas,
typecheck, eslint, knip, vitest, perf, cargo-test, shell and smoke. `e2e-agent` and `tauri-windows` are opt-in
(`TESSERA_CHECK_AGENT=1`, `TESSERA_CHECK_TAURI=1`, or `--only`). `--list` shows each step and its half.

- **Comments** (`scripts/comments.ts`): any comment `scripts/kept-comments.json` does not list fails, as does an entry
  whose comment is gone. The rule is in `AGENTS.md`. `bun scripts/comments.ts list|strip [paths…]`.
- **Evidence** (`scripts/evidence.ts`): a file added under a root `pr-*/` folder or `docs/pr/`, or a screenshot, GIF or video added
  outside the app's asset folders (`apps/*/public`, `apps/*/src/assets`, the Tauri `icons` and `dmg`,
  `packages/ui/brand` and `icons`), fails. It compares the index with where `HEAD` left `origin/main`, or with
  `HEAD^1` (a pull request's base in CI). Proof goes in the pull request's body.
- **Unused code** (`knip.json`): knip fails on a file, export, type or dependency nothing uses, and on a stale line in
  its own config. An entry point knip cannot find by itself (a script run by path, an e2e or perf test, the design kit,
  an indicator example `include_str!` reads) is listed in `entry`. Delete what it reports; un-export what is only used
  in its own file.
- **Rust tests** run under cargo-nextest, which runs no doctests: a doc example is a ` ```text ` block.
- **Timing tests** count CPU time, run alone, and run nightly in `.github/workflows/perf.yml`, not in pull requests.
- **The chart frame bench** (`apps/desktop/scripts/bench-chart.ts`) times the desktop chart in Chromium:
  `--setup standard` or `--setup orderflow`, `--layers` for each layer. A pull request that claims a frame time cites
  it.
- **The chart load bench** (`apps/desktop/scripts/bench-load.ts`) times the production build on the release sim
  runtime, served by the fake Rithmic login at the pace of one live connection (`TESSERA_TEST_PRINTS_PER_SECOND`, §9):
  NQ with the `Order flow` template on the default desk, a history fill of the 8 trade dates before it running. For
  bars, footprint, VP, CVD and big trades it prints when each is first drawn and when it settled (its last refine, no
  longer loading), cold (an empty data directory) and warm (the same directory, the runtime started again), and the
  change against `apps/desktop/bench/load-baseline.json`. The chart engine reports each layer's painted frames to
  `globalThis.__TESSERA_PAINT_HOOK__` when a page sets it (`packages/chart/src/paintProbe.ts`), so a study counts as
  drawn when it paints, partial or not, and each later picture that new data changes is a refine. `--save` writes the
  baseline; a pull request that claims a loading time cites the bench before and after.
- **One target directory per checkout.** Checkouts that share a `CARGO_TARGET_DIR` get each other's builds. The
  launchers claim the directory for their checkout and check `build-info`; a runtime built from another checkout
  exits with status 4 (`TESSERA_EXPECT_CHECKOUT`).

**CI.** `.github/workflows/ci.yml` runs `Check` on `boat-large`. For a pull request,
`.github/actions/changed` decides whether the Rust code reads a changed file (`scripts/rust-affected.ts`), whether
the shell or runtime crates changed, and which e2e agent specs cover the change (`scripts/e2e-affected.ts`). The job
runs the `ts` steps, then the Rust steps that need to run.

**Which e2e specs a pull request runs.** `SPEC_SOURCES` in `scripts/e2e-affected.ts` lists, for each spec, the source
paths it covers. A pull request runs a spec when its diff touches the spec, one of its recordings, or one of its
sources; a change only to docs, design, the site, unit tests or `scripts/kept-comments.json` runs none. Any other path,
a shared helper in `e2e/agent/support/`, the config, a package, a crate, a file the Rust code reads, or a path no spec
claims, runs the whole suite; so does a push to main, where the action gives no answer. The `What changed` log names
each spec picked and the files that picked it, or the files that made it run everything, and its `e2e` output (`all`,
`none` or the spec paths) is what `bun run e2e:agent:ci -- <specs>` takes. A new spec needs an entry, and a source that
moves fails `scripts/e2e-affected.test.ts` until its entry follows. It ends by
publishing `Fresh base` (`scripts/stale-base.ts`), which fails a pull request more than 5 commits behind main; the
label `stack` passes it. On pushes to main and manual dispatch, never on a pull request, `Check (Windows)` runs clippy
`-D warnings` of the workspace and of the Tauri shell, then the workspace's tests under nextest, on `tessera-win`; a
newer push cancels the one still waiting or running. The window tests run in the builds (§14).

**Runners.** While the repository variable `HOSTED_RUNNERS` is unset, every job runs where it always has: `Check` on
`boat-large`, the timing tests on `boat`, `Check (Windows)` and the Windows builds on `tessera-win`, everything else on
`tessera-vm`. A pull request from a fork is the exception: its `Check` runs on GitHub's `ubuntu-latest`, and it never
publishes `Fresh base`, since its token cannot write statuses. With `HOSTED_RUNNERS` set to `true`, every job runs on
GitHub-hosted runners (`ubuntu-latest`, `windows-latest`; Mac jobs stay on `MAC_RUNNER`). `scripts/workflows.test.ts`
evaluates each job's `runs-on` today, with the switch on, and for a fork's pull request.

A fork's pull request runs the workflow files from its own branch, so the files alone cannot keep it off a runner the
repository can reach. On the day the repository goes public, in its settings:

1. Secrets and variables › Actions › Variables: add `HOSTED_RUNNERS` = `true`.
2. Actions › General › Fork pull request workflows from outside collaborators: require approval for all outside
   collaborators.
3. Actions › Runners: remove every self-hosted runner (`boat`, `tessera-vm`, `tessera-win`) from the repository, or
   keep them only in an organization runner group that does not allow public repositories.
4. Run Release by hand (a dry run unless told to publish) to see the builds pass on GitHub-hosted runners.

**When a runner drops a job.** A step that needs the checkout runs only once the checkout succeeded, so a job that
never got one fails once, plainly, and not on every step. When CI on main fails only because its runner dropped a job,
`.github/workflows/rerun.yml` (on a GitHub-hosted runner, so it spends no sandbox start) reruns the failed jobs, as
long as that commit is still main's head (`scripts/runner-dropped.ts`). A runner drops a job in three ways:

- boat refuses to start a sandbox once the day's included starts are spent. The rerun waits until the time boat names.
- The runner stops or loses its connection mid-job. The rerun starts at once.
- The job never got a checkout.

It reads each failed job's whole log from the API, cargo's colours and all, and its annotations. A job that failed on
its own, such as `Check (Windows)` ending with exit code 100 (nextest's code for a failed test), or a third attempt,
stays red. Only boat's sandboxes carry the `boat` and `boat-large`
labels: a machine's own runner with either label takes jobs meant for a sandbox, and stopping it kills the job it is
running.

**Install policy** (`bunfig.toml`): a dependency version resolves only once it is a day old, and no dependency runs an
install script.

## 9. Testing with e2e

New end-to-end tests use [e2e](https://e2e.tester.army/docs). A test mixes plain-language goals (`agent.act`) with
exact checks; verified agent steps are recorded in `.e2e/cache/` (committed) and replay without a model.

- **Where.** Config `e2e.config.ts`; tests `e2e/agent/*.e2e.ts`; support `e2e/agent/support/` (`serve.ts` starts the
  app, `fixtures.ts` has the `runtime` fixture, `launch.ts` opens the app); output `.e2e/` (ignored); skill
  `.agents/skills/e2e/`; MCP `.mcp.json`.
- **The app under test.** `serve.ts` runs `tessera-test-runtime serve` (`crates/tessera-testkit`: the mock market,
  mock levels and paper accounts, no credentials) with the production build, a fresh data directory and a clock frozen
  on a Friday afternoon: markets open, nothing ticks. Run `bun run build` first for `e2e mcp` and `e2e explore`.
- **The model.** `chatgpt('gpt-6-luna')` on your own ChatGPT login (`bunx e2e login openai --device`, kept in
  `~/.config/e2e/`; never copy it). `E2E_TELEMETRY_DISABLED=1` everywhere.

The sim's knobs:

| Variable                                          | Effect                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `TESSERA_TEST_MARKET=busy`                        | The mock live and busy (ticks every 20 ms), for profiling.                                  |
| `TESSERA_TEST_MARKET=rithmic`                     | No connection at start; the fake Rithmic login (`Tessera Test`, password `demo`) serves it. |
| `TESSERA_TEST_RITHMIC=dropped`                    | The fake Rithmic login logs in, then reads as dropped and reconnecting on its 2nd try.      |
| `TESSERA_TEST_HISTORY_MS=<ms>`                    | With `MARKET=rithmic`, each bar or tick replay of the fake login takes that long.           |
| `TESSERA_TEST_PRINTS_PER_SECOND=<n>`              | With `MARKET=rithmic`, tick replays then send `n` prints a second, shared by all at once.   |
| `TESSERA_TEST_TRADES=replay`                      | No trade history; prints replay on request, as on Rithmic.                                  |
| `TESSERA_TEST_NOW=<RFC 3339>`                     | Freeze the clock at that instant.                                                           |
| `TESSERA_TEST_STORED=<start>/<end>,…`             | Store the mock's prints of these spans before serving.                                      |
| `TESSERA_TEST_REPLAY=refuse`                      | Refuse every tick replay.                                                                   |
| `TESSERA_TEST_MARKET_AFTER_MS`, `…_LOGIN_MS`      | Add the mock market late, or keep it logging in, for that long.                             |
| `TESSERA_TEST_LEVELS=live`                        | Level sources reach the network instead of the fake vendor (key `demo`).                    |
| `TESSERA_TEST_FIRM`, `TESSERA_TEST_FIRM_ACCOUNTS` | A read-only prop firm login on the mock, and its accounts.                                  |
| `TESSERA_TEST_ACCOUNTS=1`                         | Accounts on, at a local `TESSERA_CLOUD_URL`.                                                |
| `TESSERA_TEST_CRASH=1`                            | Adds `sim.crash`, which panics a runtime task.                                              |

`kill -USR1 <pid>` takes the mock market down, `kill -USR2 <pid>` brings it back. Find the pid by the runtime's port
(`ss -ltnp | grep ":<port> "`), never by name.

**Write.** Read `.agents/skills/e2e/SKILL.md` first. Import `test` and `expect` from `e2e/agent/support/fixtures.ts`.
One goal per `agent.act`, each followed by an exact check, which records the step. Never use `agent.assert`,
`agent.waitFor` or `agent.extract`: they always call the model. Leave the runtime as you found it.

**Record and replay.** `bun run e2e:agent [files…]` records new or changed steps; review and commit `.e2e/cache` with
the test. To re-record an unchanged step, delete its file (`bunx e2e cache ls`). A new minor version of `e2e`
invalidates every recording. `bun run e2e:agent:ci` replays only: a missing recording fails with `TEST_SETUP_FAILED`,
a stale one with `REPLAY_STALE`.

**Explore.** `bunx e2e explore --session served '<charter>'`; a bug bash runs several (`bunx e2e guide bug-bash`,
`TESSERA_E2E_AGENT_PORT=0`). In `e2e mcp`, call the project tool `open_runtime` after `open_session`.

### The real app's windows (Tauri)

Pop-outs, focus, which window is in front and window size are tested on the real app (`e2e/tauri/*.tauri.ts`): each
test starts Xvfb with openbox, runs the shell under tauri-driver on the test runtime, and reads the windows with
`xprop` and `xwininfo`. Screenshots and logs land in `.e2e/tauri/`. On Linux install once
`webkit2gtk-driver xvfb openbox x11-utils xdotool wmctrl dbus ffmpeg` and
`cargo install tauri-driver --version 2.1.0 --locked`, then `bun run e2e:tauri [vitest flags]`. macOS has no
WebDriver, so the Mac build runs `e2e/tauri/mac/popout-check.ts` on the app it built. A caught bug that is not fixed
stays as `it.fails('bug: …')` (and in `KNOWN_BUGS` for the Mac check).

## 10. Environment variables

The sim's are in §9.

| Variable                                            | Meaning                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `TESSERA_RUNTIME`, `TESSERA_RUNTIME_URL`            | What `bun run dev` starts (§4).                                                 |
| `TESSERA_RUNTIME_BIN`, `TESSERA_TEST_RUNTIME_BIN`   | A prebuilt runtime or test runtime for the launchers, e2e and smoke.            |
| `TESSERA_PREBUILT_DIR`                              | Main's prebuilt runtimes (§5).                                                  |
| `TESSERA_DATA_DIR`, `TESSERA_REVIEW_ORIGIN`         | The runtime's data directory; extra allowed origins (§5).                       |
| `TESSERA_RITHMIC_CREDENTIALS`, `TESSERA_NO_RITHMIC` | A login file to connect at start (§4); `1`: sign in to no Rithmic login.        |
| `TESSERA_RITHMIC_DIRECTORY`                         | Where to ask Rithmic's systems and gateways (§4).                               |
| `TESSERA_CLOUD_URL`                                 | Tessera Cloud's address: accounts on (§15). Set but empty: off.                 |
| `TESSERA_POSTHOG_KEY`, `TESSERA_POSTHOG_HOST`       | The PostHog project and where it is reached (§17).                              |
| `TESSERA_SECRET_STORE`, `TESSERA_KEYRING_SERVICE`   | `file`: saved logins in `~/.config/tessera/secrets/`; the keyring service name. |
| `TESSERA_UI_PORT`, `TESSERA_WEBVIEW_DATA_DIR`       | Exact dev server port; the debug shell's webview data.                          |
| `TESSERA_E2E_AGENT_PORT`                            | The agent suite's port (default 47231; `0`: free, cache read-only).             |
| `TESSERA_CHECK_AGENT`, `TESSERA_CHECK_TAURI`        | `1`: run the opt-in check steps (§8).                                           |
| `TESSERA_MCP_TOKEN`                                 | The connected agent's own token, for `mcp-stdio` (§13).                         |
| `TESSERA_CODEX_BIN`, `TESSERA_CLAUDE_BIN`           | The analyst's CLIs when Settings › Analyst leaves the path empty (§13).         |
| `TESSERA_CODEX_HOME`, `TESSERA_CLAUDE_CONFIG_DIR`   | Their homes when Settings › Analyst leaves them empty.                          |
| `TESSERA_CLAUDE_INSTALLER`                          | What runs to install Claude Code instead of its own installer.                  |
| `TESSERA_GH_BIN`                                    | The GitHub CLI trading sessions file issues with (default `gh`).                |
| `TESSERA_CREDENTIALS_FILE`                          | The login file the `tessera-rithmic` live examples read.                        |

## 11. Troubleshooting

- **"Starting the runtime", "Runtime failed to start", "Data directory in use".** Cargo is still building, the build
  failed (see the `[tessera-runtime]` lines), or another runtime holds the data directory. The page retries.
- **"Session ended" or "Open the runtime’s URL".** Open the latest launch link (§6).
- **The runtime exits at once.** Its stdin closed: keep a pipe open or pass `--detached`.
- **Nothing ticks.** The exchange is closed, or no connection is up (Settings › Connections says why).
- **`gen:check` fails.** Run `bun run gen` and commit `packages/protocol/src/gen` and `schemas.gen.ts`.
- **Agent suite.** Missing Chromium: `bun run e2e:install`. `APP_ALREADY_RUNNING`: another run holds 47231.
  `REPLAY_STALE`: `bun run e2e:agent <file>`. `LOGIN_REQUIRED`: `bunx e2e login openai --device`.
- **"… is also used by the checkout …" or "… was built from the checkout …".** Two checkouts share a target directory
  (§8): give each its own.
- **The Tauri shell hangs headless.** Run it under `dbus-run-session` as well as Xvfb.
- **The layout looks wrong.** ⌘K › Reset this workspace to default.

## 12. Data and state on the TypeScript side

- **Contract.** Every answer and event is decoded with its generated zod schema (`packages/protocol/src/schemas.gen.ts`);
  a payload it does not describe is a `ContractError`.
- **Connection.** `createRuntimeClient` (`packages/protocol/src/runtimeClient.ts`) connects, reconnects and resubscribes.
  Failures are typed (`runtimeErrors.ts`); `ConnectionLost` is never retried.
- **Services** (`apps/desktop/src/app/services.ts`): the window's host and connection; `appClient()` and `appHost()`
  outside React.
- **Tool reads** (`app/tools.ts`) are TanStack queries: `useTool`, `useToolValue`, `runTool(…, { refresh })`.
- **Topics** (`app/topics.ts`): `topicFold` folds a topic into a shared store. Quote-speed streams reach React once a
  frame (`app/frame.ts`). Market data is shared and kept warm (`app/warm.ts`).
- **Loading.** `Loaded` (`@tessera/ui`) shows one loading state, then everything at once;
  `apps/desktop/test/loading-*.test.tsx` hold every area to it.
- **Stores** (`app/store.ts`): zustand, `makeStore(initial, { persist? })`.
- **Tests** render under `TestRuntime` (`apps/desktop/test/support/runtime.tsx`); `fakeRuntime()` is a runtime the
  test drives.

## 13. The user's own agent (MCP)

- **Connect.** Settings › Analyst › Use Tessera from your agent › Connect an agent makes a client with its own token
  and shows its setup once (Claude Desktop, Cursor, Claude Code, Codex), each running `<runtime> mcp-stdio` with
  `TESSERA_MCP_TOKEN`. The runtime keeps only the token's hash.
- **Permissions.** Supervised (changes ask, orders are drafts the user approves) or Read only. No client sees
  user-only tools or resolves an approval.
- **The shim** relays JSON-RPC from stdin to the running runtime's `/mcp`, found through `discovery.json`.

**The analyst** runs on the user's own Codex and Claude Code CLIs, each off until turned on in Settings › Analyst ›
Models. `agent.send` takes `delivery`: `steer` into the running turn, or `queue` as its own turn after it.

**Trading sessions** (Settings › Analyst › Trading sessions; `crates/tessera-runtime/src/session_runner/`). The analyst
trades each CME session on one account, in full access, under the user's standing instructions
(`~/.config/tessera/analyst-instructions.md`; template `docs/analyst-instructions.example.md`), which decide when and
what it trades. Before the break it closes out and writes its log; at the break the runtime cancels the account's
orders, closes its positions and reports in the journal, filing failures as GitHub issues through the user's `gh`. A
session never starts without the account's daily loss limit, max position and max risk per trade.

## 14. Releases and updates

- **Builds.** Release (`.github/workflows/release.yml`, a `v0.2.0-alpha.N` tag; by hand a dry run by default) and
  Build from main (`main-build.yml`, daily at 22:00 UTC once CI passed, only platforms whose published build differs)
  both call `build.yml`: Mac on `MAC_RUNNER` (default `macos-15`), Linux on `tessera-vm`, Windows on `tessera-win`, or
  GitHub-hosted runners with `HOSTED_RUNNERS` (§8).
  `build.yml` first refuses a commit whose latest CI run did not pass; to publish, that run must be a push or a manual
  dispatch, the runs that check Windows, not a pull request's. It runs no clippy or nextest of its own: each platform
  is built and gets the checks that need the real app (the app's windows on Linux, the smoke test of each runtime it
  ships, the .dmg window and the pop-outs on a Mac), and is staged; a release publishes only when all three pass.
- **Publishing** (`scripts/channel.ts`): the public R2 bucket at `UPDATES_URL`, each `<platform>/latest.json` last,
  plus a GitHub pre-release for a release. The site and Cloud offer only platforms with a feed
  (`packages/ui/src/downloads.ts`).
- **Build variables.** `TESSERA_RITHMIC_DIRECTORY`, `CLOUD_URL` and `POSTHOG_PROJECT_KEY` are repository variables.
- **Signing.** Updates are signed with `TAURI_SIGNING_PRIVATE_KEY` and checked against `tauri.conf.json`'s public key;
  losing the key strands installed apps. The Windows installer is not code-signed (`packages/ui/src/firstOpen.ts`).
- **In the app** (`apps/desktop/src/app/updates.ts`): a check a minute after opening, every thirty minutes and on
  focus. Only Restart and update downloads and installs, after warning about working orders and open positions.
  Tessera never restarts by itself.
- **macOS keychain.** At an update the old runtime hands each saved secret to the new build
  (`crates/tessera-runtime/src/handover.rs`), tested by `.github/workflows/keychain.yml`.
- **CSP.** Release builds enforce `app.security.csp` in `tauri.conf.json`; debug builds have none.

## 15. Tessera Cloud

`apps/cloud` is one Cloudflare Worker (Hono, D1): the API in `src/app.ts`, pages in `src/web.tsx`, queries in
`src/store.ts`, the schema in `migrations/`, identity behind `src/identity.ts` (WorkOS) and mail behind `src/mail.ts`.

- **Environments.** Production and staging, each with its own D1 and WorkOS environment (`wrangler.jsonc`).
- **Secrets** (`bunx wrangler secret put <name> [--env staging]`, never in the repository): `WORKOS_API_KEY`,
  `SESSION_SECRET`, and for feedback `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`.
- **Deploy.** `.github/workflows/cloud.yml` applies the migrations and deploys production on pushes to main that touch
  `apps/cloud/`, or either environment by hand.
- **Locally.** `bunx wrangler d1 migrations apply DB --local --env staging`, secrets in `apps/cloud/.dev.vars`, then
  `bun --cwd=apps/cloud run dev` on `http://127.0.0.1:8787`. Schema changes are a new numbered migration.
- **The website.** `/apply`, `/admin` (approvals, invites) and `/invite/<token>`. Approval grants `early_access`. Make
  the first admin with `bunx wrangler d1 execute DB --remote --command "UPDATE users SET role = 'admin' WHERE …"`.
- **Feedback.** `POST /v1/feedback` files the report as a GitHub issue in `FEEDBACK_REPO` through the GitHub App.

**The app's side.** `crates/tessera-cloud` is the client; the runtime's `account` module holds the account; the
Profile area shows it. Accounts are on only with a Cloud address (`TESSERA_CLOUD_URL`, else the build's). Sign-in uses
the system browser (PKCE, back to the runtime's `/auth/callback`); the session lives in the OS keyring. Orders, exits,
flatten and cancels never depend on Cloud. Feedback (the rail's Feedback, ⌘⇧/) sends a masked screenshot and redacted
context (`crates/tessera-runtime/src/modules/feedback.rs`), queued in `<data dir>/feedback/outbox/`.

## 16. Voice packs

The spoken alerts (Settings › Alerts and sounds › Voice) are packs in `apps/desktop/src/sound/voice/packs/<voice>/`: a
`manifest.json` and one MP3 a line of `VOICE_LINES` (`apps/desktop/src/sound/voice/lines.ts`). Without a pack the app
plays tones. Make them with `bun run voices --max-chars N` (`--dry-run` prices it; the ElevenLabs key file defaults to
`~/.config/tessera/elevenlabs.env`; needs ffmpeg with libmp3lame). **The packs were made on ElevenLabs' free plan:
make every pack again on a paid plan before Tessera is sold.**

## 17. Usage and crash reports (PostHog)

- **One way out.** Only the runtime talks to PostHog (`crates/tessera-runtime/src/telemetry/`); the window hands its
  events and replay to it (`apps/desktop/src/app/telemetry.ts`).
- **Consent** (Settings › App › Privacy). Crash reports are on in a fresh install, sent as the install. Usage waits
  for a Yes. A build without `TESSERA_POSTHOG_KEY` sends nothing.
- **Content.** Every string is redacted. Tracked tool calls (`telemetry/tracked.rs`) never carry an account, price,
  size or note. Replay masks digits, inputs and private regions (`app/replayMask.ts`) and records no chart.
- **The project.** `POSTHOG_PERSONAL_API_KEY=… node scripts/posthog.ts` sets it up, idempotently.

## 18. Styling with Tailwind

- **One theme.** `packages/ui/src/styles/tokens.css` is the Tailwind v4 theme, starting from `--*: initial`, so only
  Tessera's tokens exist (`bg-ink`, `text-t2`, `text-body`, `font-fig`, `h-row`). Spacing runs on 4 px.
- **A missing colour or size** becomes a token in `tokens.css` and `packages/ui/src/theme.ts` (a test keeps them
  equal). One-off geometry may be arbitrary (`w-[560px]`); a colour may not.
- **`cx()`** (`@tessera/ui`) merges classes. Recipes like `PRICE_TEXT` and `ICON_BUTTON` are class strings there.
- **Trap.** tailwind-merge drops a `leading-*` written before a `text-<step>`: write the step first.
- **Stylesheets** remain only for DOM Tessera does not render (dockview, CodeMirror), `@font-face` and keyframes.
- **Proving a restyle.** `.agents/skills/verify-tessera/scripts/parity.ts <before dist> <after dist>` compares every
  screen and computed style of two builds and prints `VERIFIED` only when nothing differs.
