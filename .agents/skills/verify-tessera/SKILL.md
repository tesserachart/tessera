---
name: verify-tessera
description: Prove a Tessera change works by driving the real app on the sim runtime (the mock market, mock gamma levels and three paper accounts, with no login) through an e2e MCP session, and by reading what the runtime stored. Use it before you call a user-facing Tessera change done, to reproduce a UI bug, or to record a video for a pull request.
---

# Verify Tessera on the sim runtime

The sim runtime is `tessera-test-runtime` (`crates/tessera-testkit`): the real runtime serving the built UI on the mock market and mock gamma levels, with a clock frozen at Friday 2 Oct 2026 14:42 New York, three paper accounts (Paper at $100,000, Paper 2 and Paper 3 at $50,000), an in-memory keychain and a fresh temporary data directory. Its Rithmic is a fake gateway and its levels vendor a fake API; it reads no credentials file and has no Tessera account. Never verify on `bun run dev`, `bun run serve` or the desktop app: they run the real runtime on the developer's own logins.

## Launch

1. `bun run build`. The session serves `apps/desktop/dist` as built, so rebuild after every UI change.
2. `open_session` on the `e2e` MCP server (`.mcp.json`). Its app command, `e2e/agent/support/serve.ts`, starts the sim runtime on a port of its own: `TESSERA_TEST_RUNTIME_BIN` if set, else main's prebuilt `tessera-test-runtime` in `~/.cache/tessera/bin` when nothing the Rust code reads changed since that build, else a cargo build (minutes when cold). The reply's `App: http://127.0.0.1:<port>/` line names the port.
3. `call {tool: "open_runtime"}`. The app is ready when `observe` shows `navigation "Areas"` and `main "Workspace"`; before that it shows the `Open the runtime’s URL` alert.

If the session has no `e2e` MCP tools, the server failed to start. Run `bun install` and start a new agent session in the checkout.

## Doctor

`node .agents/skills/verify-tessera/scripts/runtime.ts <port> doctor` must print:

```
ok: sim runtime on 127.0.0.1:<port>
data: Mock market, Mock gamma levels
accounts: Paper (paper), Paper 2 (paper), Paper 3 (paper)
workspace: <the shown workspace>
```

`runtime.ts` talks to the runtime through the connection file only `serve.ts` writes, and refuses before any call a data source other than the mock market or an account that is not paper. Run the doctor before the first drive and after anything surprising. On a refusal, close the session and stop.

## Drive

- Read [`features/README.md`](features/README.md), then the feature's file for its entry points, recipe and end state.
- Act with `observe` and the verbs (`tap`, `type`, `press`, …) on node ids from the newest observation. Aim by the accessible names the feature's file gives.
- Read every end state from the runtime as well as the screen: `runtime.ts <port> <tool> '<json input>'`, such as `layout.get '{"layoutId":"default"}'` or `portfolio.get_orders`. Tool names are in `packages/protocol/src/gen/ToolMap.ts`.
- Orders go to the paper accounts only. Logins and keys typed on the sim reach only its fakes (`features/connections.md`). Never type a real credential, and never turn on a real model in the Analyst; the stand-in CLIs in `scripts/` are not models (`features/analyst-queue.md`).
- What a session cannot do (follow a pop-out window, right-click the chart's canvas, cut the page's socket, pause the runtime, hear the page) the feature's file does with a script in `scripts/`, run with `node`. One that takes `<port>` drives a browser of its own on the session's runtime with the same refusals as `runtime.ts`; one without starts its own sim runtime and needs no session. Each saves its evidence under `.e2e/artifacts/verify/<name>/` unless given a directory.

## Other sim knobs

A session's runtime gets only the variables `e2e.config.ts` lists in `passEnv`, from the environment the MCP server started with. For any other knob of `docs/dev.md` §9 (a busy market, replayed trades, another clock, stored days, a late market), start the sim by hand: `<knobs> node e2e/agent/support/serve.ts --port <free port>` with `TMPDIR` set to a directory of your own. Open `<origin>/#ticket=<ticket>` from `$TMPDIR/tessera-e2e-agent-<port>.json` with Playwright, and run `runtime.ts` with the same `TMPDIR`.

## Evidence

- Record the drive: `call {tool: "start_recording", args: {name: "<feature>"}}` once the start state is on screen, `stop_recording` once the end state is. The video lands in `.e2e/videos/<session>/`.
- `screenshot` returns 768 by 480. For a full 1600 by 1000 still, such as a pull request's screenshot, record a short clip of the state and take its last frame: `ffmpeg -sseof -0.3 -i <video> -frames:v 1 <png>`.
- Save the runtime's view of each end state before `close_session`, because the data directory goes with the runtime: `mkdir -p .e2e/artifacts/verify/<feature> && node .agents/skills/verify-tessera/scripts/runtime.ts <port> <tool> > .e2e/artifacts/verify/<feature>/<tool>.json`.
- A proof shows the user's action and the resulting state on screen and in the runtime. A toast or a status line alone is not proof.
- Git ignores `.e2e/videos/` and `.e2e/artifacts/`, so the evidence stays on this machine, and a later `bun run e2e:agent` empties `.e2e/artifacts/`. The pull request's Verification section names the run and its outcome. For a proof anyone can rerun, also write a deterministic test in `e2e/agent/` (`.agents/skills/e2e/SKILL.md`).

## Cleanup

`close_session`. It stops the runtime it started, and `serve.ts` removes the temporary data directory and the connection file. Then check that `curl -sf http://127.0.0.1:<port>/healthz` fails, that `${TMPDIR:-/tmp}/tessera-e2e-agent-<port>.json` is gone, and that the video and artifacts are still there.

## Gotchas

- Nothing ticks on the frozen clock. A change that shows only on a moving market (live quotes, DOM, order flow, switch cost) needs the busy market (`TESSERA_TEST_MARKET=busy`, above).
- Never stop a runtime by process name: other checkouts run their own. The session's is the pid listening on its port (`ss -ltnp | grep ":<port> "`).
- The UI's vocabulary in `e2e.config.ts` (`context`) predates the current shell. Trust `observe`.

## Scripts for no one feature

- `scripts/parity.ts [--resume] <before ui dir> <after ui dir> [out dir] [screen|@screens-file,…]` serves two builds on two sim runtimes and compares every screen in `scripts/parity-screens/` pixel by pixel and by computed style (`docs/dev.md` §18).
- `scripts/loading-sweep.ts [evidence dir] [ui dir] [surfaces] [record file]` films each surface's cold load with every runtime answer held back 250 to 2,000 ms (`TESSERA_SWEEP_WARM=1` films a return visit). With a record file it saves what the sim answered, which is how `apps/desktop/test/fixtures/sim-reads.json` is refreshed after a contract change.
- `scripts/playbook-strip.ts [evidence dir] [ui dir] [pr|main] [runtime bin]` seeds a setup with #600's values and one with six-figure values, then in Tessera and Tessera Light sweeps the window from 1600 to 800 px and lists every figure or label in Journal › Playbooks' stat strip that leaves its cell (`<label>-report.json`: each list must be empty), and shoots the strip at 1600 and 1100 px.
