import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import type { PaintFrame } from '@tessera/chart';
import { askRuntimeToExit, resolveRuntimeBinary, TEST_RUNTIME } from '../dev/runtime-bin.ts';

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    tf: { type: 'string', default: '1m' },
    fill: { type: 'string', default: '8' },
    timeout: { type: 'string', default: '300' },
    shots: { type: 'string' },
    save: { type: 'boolean' },
    json: { type: 'boolean' },
  },
});

const repo = resolve(import.meta.dirname, '../../..');
const uiDir = join(repo, 'apps/desktop/dist');
const baselinePath = join(repo, 'apps/desktop/bench/load-baseline.json');

// One live Rithmic connection (Apex, NQ, 26 Nov 2026, #606) answers a tick replay after about 1.2 s, then sends
// about 9,000 prints a second, shared by every replay running at once.
const LIVE_FEED = { requestMs: 1_200, printsPerSecond: 9_000 };
const LOGIN = { system: 'Tessera Test', gateway: 'Chicago Area', user: 'trader', password: 'demo' };
const TILE = { layoutId: 'default', tileId: 'chart-1' };
const INSTRUMENT = 'NQ';
const QUIET_MS = 3_000;
const POLL_MS = 100;

const STUDIES = [
  { key: 'bars', label: 'bars', kind: null },
  { key: 'footprint', label: 'footprint', kind: 'footprint' },
  { key: 'vp', label: 'VP day', kind: 'volume_profile' },
  { key: 'cvd', label: 'CVD', kind: 'delta' },
  { key: 'bigTrades', label: 'big trades', kind: 'big_trades' },
] as const;
type StudyKey = (typeof STUDIES)[number]['key'];
const MODES = ['cold', 'warm'] as const;
type Mode = (typeof MODES)[number];

interface Timing {
  drawn: number | null;
  settled: number | null;
  refines: number;
}
type Sheet = Record<Mode, Record<StudyKey, Timing>>;

interface Fill {
  days: number;
  saved: number;
  prints: number;
}

interface Run {
  sheet: Sheet;
  fills: Record<Mode, Fill>;
}

interface Baseline {
  commit: string;
  date: string;
  setup: Setup;
  sheet: Sheet;
}

interface Setup {
  instrument: string;
  tf: string;
  template: string;
  feed: typeof LIVE_FEED;
  fillDays: number;
  runs: number;
  timeoutS: number;
}

const setup: Setup = {
  instrument: INSTRUMENT,
  tf: args.tf,
  template: 'Order flow',
  feed: LIVE_FEED,
  fillDays: Number(args.fill),
  runs: Number(args.runs),
  timeoutS: Number(args.timeout),
};

if (!existsSync(join(uiDir, 'index.html'))) {
  console.error(`[bench] no built UI at ${uiDir}: run \`bun run build\` (bun run bench:load does it first).`);
  process.exit(2);
}
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME, release: true }).path;

class Sim {
  readonly origin: string;
  readonly ticket: string;
  private readonly token: string;
  private readonly child: ChildProcess;

  private constructor(child: ChildProcess, ready: { port: number; token: string; ticket: string }) {
    this.child = child;
    this.origin = `http://127.0.0.1:${String(ready.port)}`;
    this.token = ready.token;
    this.ticket = ready.ticket;
  }

  static async start(dataDir: string): Promise<Sim> {
    const child = spawn(bin, ['serve', '--port', '0', '--ui-dir', uiDir, '--data-dir', dataDir, '--launch-tickets'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        TESSERA_TEST_MARKET: 'rithmic',
        TESSERA_TEST_HISTORY_MS: String(LIVE_FEED.requestMs),
        TESSERA_TEST_PRINTS_PER_SECOND: String(LIVE_FEED.printsPerSecond),
      },
    });
    const ready = await new Promise<{ port: number; token: string; ticket: string }>((done, fail) => {
      child.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
      const seen: { port?: number; token?: string; ticket?: string } = {};
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          Object.assign(seen, JSON.parse(line) as object);
        } catch {
          return;
        }
        if (seen.port && seen.token && seen.ticket) done({ port: seen.port, token: seen.token, ticket: seen.ticket });
      });
    });
    return new Sim(child, ready);
  }

  async tool<T>(name: string, input: unknown): Promise<T> {
    const ws = new WebSocket(`${this.origin.replace(/^http/, 'ws')}/ws`);
    await new Promise((done, fail) => {
      ws.onopen = done;
      ws.onerror = fail;
    });
    const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (m.id !== undefined) waiting.get(m.id)?.(m);
    };
    let id = 0;
    const call = (method: string, params: unknown) =>
      new Promise<{ result?: unknown; error?: { message: string } }>((done) => {
        waiting.set(++id, done);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    try {
      await call('session.hello', {
        client: { name: 'bench-load', version: '0', platform: 'node' },
        protocolVersion: 1,
        token: this.token,
      });
      const answer = await call('tools.invoke', { name, input });
      if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
      const result = answer.result as { ok: boolean; output: T; error: { message: string } | null };
      if (!result.ok) throw new Error(`${name}: ${result.error?.message ?? 'refused'}`);
      return result.output;
    } finally {
      ws.close();
    }
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((done) => this.child.once('exit', done));
    askRuntimeToExit(this.child);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(kill);
  }
}

interface PullSummary {
  id: string;
  progress: { days: number; saved: number; alreadySaved: number; prints: number };
}

interface ChartModel {
  charts: Record<string, { layers: { id: string; kind: string }[] }>;
}

function tradeDatesBefore(last: string, count: number, skip: number): { from: string; to: string } {
  const dates: string[] = [];
  const d = new Date(`${last}T12:00:00Z`);
  while (dates.length < skip + count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  const range = dates.slice(skip);
  return { from: range.at(-1)!, to: range[0]! };
}

async function openChart(sim: Sim, mode: Mode): Promise<{ layerKinds: Map<string, string>; fill: string | null }> {
  await sim.tool('connections.add_rithmic', LOGIN);
  await sim.tool('chart.set_symbol', { ...TILE, instrument: INSTRUMENT });
  await sim.tool('chart.set_timeframe', { ...TILE, tf: setup.tf });
  await sim.tool('chart.apply_template', { ...TILE, template: setup.template });
  await sim.tool('workspace.save', { layoutId: TILE.layoutId });
  const layout = await sim.tool<ChartModel>('layout.get', { layoutId: TILE.layoutId });
  const layerKinds = new Map((layout.charts[TILE.tileId]?.layers ?? []).map((l) => [`model:${l.id}`, l.kind] as const));
  let fill: string | null = null;
  if (setup.fillDays > 0) {
    const estimate = await sim.tool<{ request: { to: string } }>('market.estimate_pull', { instrument: INSTRUMENT });
    const skip = mode === 'cold' ? 1 : 1 + setup.fillDays;
    const range = tradeDatesBefore(estimate.request.to, setup.fillDays, skip);
    const pull = await sim.tool<PullSummary>('market.pull_trades', {
      instrument: INSTRUMENT,
      ...range,
      scope: 'session',
    });
    fill = pull.id;
  }
  return { layerKinds, fill };
}

async function fillState(sim: Sim, id: string | null): Promise<Fill> {
  const p = id ? (await sim.tool<{ pulls: PullSummary[] }>('market.list_pulls', { id })).pulls[0] : undefined;
  return p
    ? { days: p.progress.days, saved: p.progress.saved + p.progress.alreadySaved, prints: p.progress.prints }
    : { days: 0, saved: 0, prints: 0 };
}

class Watch {
  private chart: number | null = null;
  private readonly furniture = new Map<string, number>();
  private readonly last = new Map<StudyKey, { print: string; data: number }>();
  private readonly loading = new Map<StudyKey, boolean>();
  readonly timings = Object.fromEntries(
    STUDIES.map((s) => [s.key, { drawn: null, settled: null, refines: 0 }]),
  ) as Record<StudyKey, Timing>;
  lastChange = 0;
  private readonly layerKinds: Map<string, string>;

  constructor(layerKinds: Map<string, string>) {
    this.layerKinds = layerKinds;
  }

  take(frame: PaintFrame): void {
    if (this.chart === null && frame.layers.some((l) => this.studyOf(l.id) !== null)) this.chart = frame.chart;
    if (frame.chart !== this.chart) return;
    if (frame.bars.count > 0) {
      this.saw(
        'bars',
        frame.at,
        `${String(frame.bars.count)}|${String(frame.bars.first)}|${String(frame.bars.last)}`,
        0,
      );
      this.loading.set('bars', false);
    }
    const byStudy = new Map<StudyKey, { ops: number; print: string; data: number; loading: boolean }>();
    for (const l of frame.layers) {
      const key = this.studyOf(l.id);
      if (!key) continue;
      if (frame.bars.count === 0) this.furniture.set(l.id, Math.max(this.furniture.get(l.id) ?? 0, l.ops));
      const drew = l.ops > (this.furniture.get(l.id) ?? 0);
      const s = byStudy.get(key) ?? { ops: 0, print: '', data: 0, loading: false };
      byStudy.set(key, {
        ops: s.ops + (drew ? l.ops : 0),
        print: `${s.print}${l.id}:${drew ? String(l.print) : '-'};`,
        data: s.data + l.data,
        loading: s.loading || l.reading || (l.notice?.startsWith('Loading') ?? false),
      });
    }
    for (const [key, s] of byStudy) {
      this.loading.set(key, s.loading);
      if (s.ops > 0) this.saw(key, frame.at, s.print, s.data);
    }
  }

  settled(): boolean {
    return STUDIES.every((s) => this.timings[s.key].drawn !== null && this.loading.get(s.key) === false);
  }

  finish(): Record<StudyKey, Timing> {
    for (const s of STUDIES) {
      const t = this.timings[s.key];
      if (this.loading.get(s.key) !== false) t.settled = null;
    }
    return this.timings;
  }

  private saw(key: StudyKey, at: number, print: string, data: number): void {
    const before = this.last.get(key);
    if (before?.print === print) return;
    const t = this.timings[key];
    if (before && key !== 'bars' && before.data === data) return;
    this.last.set(key, { print, data });
    if (t.drawn === null) t.drawn = at;
    else t.refines++;
    t.settled = at;
    this.lastChange = at;
  }

  private studyOf(layerId: string): StudyKey | null {
    const model = layerId.split(':').slice(0, 2).join(':');
    const kind = this.layerKinds.get(model);
    return STUDIES.find((s) => s.kind !== null && s.kind === kind)?.key ?? null;
  }
}

async function measure(
  browser: Browser,
  sim: Sim,
  mode: Mode,
  run: number,
): Promise<{ timings: Record<StudyKey, Timing>; fill: Fill }> {
  const { layerKinds, fill } = await openChart(sim, mode);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => {
    const frames: unknown[] = [];
    Object.assign(window, { __benchFrames: frames });
    globalThis.__TESSERA_PAINT_HOOK__ = (f) => frames.push(f);
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[bench] page error:', e.message));
  const watch = new Watch(layerKinds);
  const drain = async (p: Page) => {
    const frames = await p.evaluate(() =>
      (window as unknown as { __benchFrames: PaintFrame[] }).__benchFrames.splice(0),
    );
    for (const f of frames) watch.take(f);
    return p.evaluate(() => performance.now());
  };
  await page.goto(`${sim.origin}/#ticket=${sim.ticket}`);
  const limit = setup.timeoutS * 1000;
  for (;;) {
    const now = await drain(page);
    if (watch.settled() && now - watch.lastChange >= QUIET_MS) break;
    if (now >= limit) break;
    await page.waitForTimeout(POLL_MS);
  }
  if (args.shots) {
    mkdirSync(args.shots, { recursive: true });
    await page.screenshot({ path: join(args.shots, `run${String(run + 1)}-${mode}.png`) });
  }
  const filled = await fillState(sim, fill);
  await context.close();
  return { timings: watch.finish(), fill: filled };
}

async function oneRun(browser: Browser, run: number): Promise<Run> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tessera-bench-load-'));
  const sheet = {} as Sheet;
  const fills = {} as Record<Mode, Fill>;
  try {
    for (const mode of MODES) {
      const sim = await Sim.start(dataDir);
      try {
        const { timings, fill } = await measure(browser, sim, mode, run);
        sheet[mode] = timings;
        fills[mode] = fill;
      } finally {
        await sim.stop();
      }
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return { sheet, fills };
}

function median(xs: readonly (number | null)[]): number | null {
  if (xs.some((x) => x === null)) return null;
  const s = (xs as number[]).toSorted((a, b) => a - b);
  return s.length === 0 ? null : Math.round(s[s.length >> 1]!);
}

function medianSheet(runs: readonly Run[]): Sheet {
  const out = {} as Sheet;
  for (const mode of MODES) {
    out[mode] = {} as Record<StudyKey, Timing>;
    for (const s of STUDIES) {
      const ts = runs.map((r) => r.sheet[mode][s.key]);
      out[mode][s.key] = {
        drawn: median(ts.map((t) => t.drawn)),
        settled: median(ts.map((t) => t.settled)),
        refines: median(ts.map((t) => t.refines)) ?? 0,
      };
    }
  }
  return out;
}

function seconds(ms: number | null): string {
  return ms === null ? `>${String(setup.timeoutS)}` : (ms / 1000).toFixed(1);
}

function delta(now: number | null, before: number | null): string {
  if (now === null || before === null) return now === before ? '' : now === null ? 'worse' : 'better';
  const d = (now - before) / 1000;
  return Math.abs(d) < 0.05 ? '=' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
}

function report(sheet: Sheet, runs: readonly Run[], baseline: Baseline | null): void {
  const feed = `${(LIVE_FEED.requestMs / 1000).toFixed(1)} s a request, ${LIVE_FEED.printsPerSecond.toLocaleString('en-US')} prints/s`;
  console.info(
    `chart load: ${INSTRUMENT} ${setup.tf} with ${setup.template} on the default desk, sim on the fake Rithmic login ` +
      `at the live pace (${feed}), ${String(setup.fillDays)} days of history filling, median of ${String(runs.length)}`,
  );
  console.info(
    'seconds from opening the app to each study drawn (its first picture, partial or not) and settled (its last refine, done loading);',
  );
  console.info('cold: an empty data directory; warm: the same directory opened again right after the cold measure');
  const pad = (s: string, n: number) => s.padStart(n);
  const head = (base: boolean) => MODES.map((m) => m.padEnd(base ? 34 : 24)).join('  ');
  const sub = (base: boolean) =>
    MODES.map(() =>
      base
        ? `${pad('drawn', 7)}${pad('Δ', 6)}${pad('settled', 9)}${pad('Δ', 6)}${pad('refines', 8)}`
        : `${pad('drawn', 7)}${pad('settled', 9)}${pad('refines', 8)}`,
    ).join('  ');
  const b = baseline?.sheet ?? null;
  console.info(`\n${''.padEnd(12)}${head(b !== null)}`);
  console.info(`${''.padEnd(12)}${sub(b !== null)}`);
  for (const s of STUDIES) {
    const cells = MODES.map((m) => {
      const t = sheet[m][s.key];
      const was = b?.[m][s.key];
      return was
        ? `${pad(seconds(t.drawn), 7)}${pad(delta(t.drawn, was.drawn), 6)}${pad(seconds(t.settled), 9)}${pad(delta(t.settled, was.settled), 6)}${pad(String(t.refines), 8)}`
        : `${pad(seconds(t.drawn), 7)}${pad(seconds(t.settled), 9)}${pad(String(t.refines), 8)}`;
    });
    console.info(`${s.label.padEnd(12)}${cells.join('  ')}`);
  }
  const fills = MODES.map((m) => {
    const f = runs[0]!.fills[m];
    return `${m} ${String(f.saved)} of ${String(f.days)} days saved (${f.prints.toLocaleString('en-US')} prints fetched)`;
  });
  console.info(`\nhistory fill when each measure ended (run 1): ${fills.join(', ')}`);
  if (baseline)
    console.info(
      `Δ: seconds against the baseline of ${baseline.commit} (${baseline.date}, apps/desktop/bench/load-baseline.json), + is slower`,
    );
}

function commit(): string {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline) : null;
const sameSetup = (a: Setup, b: Setup) => JSON.stringify({ ...a, runs: 0 }) === JSON.stringify({ ...b, runs: 0 });
const comparable = baseline && sameSetup(baseline.setup, setup) ? baseline : null;
const browser = await chromium.launch();
const runs: Run[] = [];
try {
  for (let i = 0; i < setup.runs; i++) {
    if (!args.json) console.info(`[bench] run ${String(i + 1)} of ${String(setup.runs)}`);
    runs.push(await oneRun(browser, i));
  }
} finally {
  await browser.close();
}
const sheet = medianSheet(runs);
if (args.json) console.info(JSON.stringify({ setup, sheet, runs }, null, 2));
else report(sheet, runs, args.save ? null : comparable);
if (baseline && !comparable && !args.save)
  console.info('the committed baseline was measured with other settings: no Δ');
if (args.save) {
  const saved: Baseline = { commit: commit(), date: new Date().toISOString().slice(0, 10), setup, sheet };
  writeFileSync(baselinePath, `${JSON.stringify(saved, null, 2)}\n`);
  console.info(`saved the baseline to ${baselinePath}`);
}
