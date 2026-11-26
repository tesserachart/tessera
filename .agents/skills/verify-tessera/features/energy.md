# Energy

What the desk costs a laptop's battery: the CPU time and wake-ups per minute of the runtime and of the page (its renderer, GPU and browser processes) on fixed sim scenes. A change that claims to save energy proves it with `bun run bench:energy`, and proves with the parity screens that nothing on screen changed.

## Sub-features

- `energy-idle`: the default desk on the still market (nothing ticks) draws nothing and wakes almost never. No animation keeps running once what it animated has left the page, so the page renders no frame unless something on it changed.
- `energy-live`: the Scalp preset (an order-flow chart, a DOM, a T&S and the Trade ticket) on the busy market. Live prices, the ladder and order entry are never slowed down while the window shows.
- `energy-behind`: the same desk, its window still showing but behind another window. It costs what the live desk costs: a window that can still be seen is drawn at full speed.
- `energy-hidden`: the same desk in a hidden window (minimised, on another space, or covered). It draws nothing and reads only what keeps it current, and shows the market as it is the moment it is shown again.
- `energy-popout`: the order-flow chart popped out into its own window beside the desk.

## Measure

`bun run bench:energy` builds the UI, starts the sim runtime (`TESSERA_TEST_MARKET=busy` for the live scenes) and a Chromium of its own, and prints, per scene, the median CPU milliseconds per minute and wake-ups (voluntary context switches) per minute of the runtime, renderer, GPU, browser and other processes, with the range over the runs. It exits non-zero if the page threw or the market did not move during a live scene.

- `--ui <dir>` measures a built UI; give it twice (`--ui main-dist --ui pr-dist`) to alternate two builds run by run, each run starting with the other one, so neither drift nor going second favours either.
- `--runtime <path>` measures with a given `tessera-test-runtime`; give one per `--ui` to compare two runtimes. Use a release build for numbers you report: `cargo build --release -p tessera-testkit --bin tessera-test-runtime`.
- `--runs`, `--seconds`, `--settle` (15 s, for the runtime's start-up work to finish) and `--scenes idle,live,behind,hidden,popout`.
- `--shots <dir>` saves each scene's screenshot, `--profile <dir>` a 10 s CPU profile of each page and `--trace <dir>` a 5 s Chromium trace, taken after the measured window so they never count.

The hidden scene opens a background tab in the window, and the behind scene a second window over it, after Playwright has let go of the page: Playwright's focus emulation keeps a page visible.

## Prove nothing on screen changed

- `node .agents/skills/verify-tessera/scripts/parity.ts <main ui dir> <pr ui dir>` compares every parity screen pixel by pixel (`../SKILL.md`).
- `bun run bench:energy --shots <dir>` on both builds: the live scene's chart, DOM and T&S show the same market at the end of each window.

## Gotchas

- Headless Chromium rasterises in software, so the GPU column is CPU time in the GPU process; read it as a direction, not as watts.
- Run nothing else while it measures: a build or a test suite on the same cores moves every number. Run `uptime` first.
- The busy market ticks every 20 ms, faster than any debounce of a few hundred milliseconds: a cost that waits for a quiet market shows less here than on a calmer one.
