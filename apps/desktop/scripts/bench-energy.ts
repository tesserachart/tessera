import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { RuntimeRpc, type RuntimeInfo } from '../../../e2e/agent/support/runtime.ts';
import { askRuntimeToExit, resolveRuntimeBinary, TEST_RUNTIME } from '../dev/runtime-bin.ts';

const SCENES = ['idle', 'live', 'behind', 'hidden', 'popout'] as const;
type Scene = (typeof SCENES)[number];
const SCENE_TITLES: Record<Scene, string> = {
  idle: 'idle desk, market still',
  live: 'live footprint, DOM and tape',
  behind: 'live, window behind another',
  hidden: 'live, window hidden',
  popout: 'live, chart popped out',
};
const KINDS = ['runtime', 'renderer', 'gpu', 'browser', 'other'] as const;
type Kind = (typeof KINDS)[number];
const CLOCK_TICK_MS = 10;
const WINDOW = { width: 1600, height: 1000 };

const { values: args } = parseArgs({
  options: {
    ui: { type: 'string', multiple: true },
    runtime: { type: 'string', multiple: true },
    runs: { type: 'string', default: '3' },
    seconds: { type: 'string', default: '30' },
    settle: { type: 'string', default: '15' },
    scenes: { type: 'string', default: SCENES.join(',') },
    json: { type: 'string' },
    shots: { type: 'string' },
    profile: { type: 'string' },
    trace: { type: 'string' },
  },
});
const repo = resolve(import.meta.dirname, '../../..');
const seconds = Number(args.seconds);
const settleMs = Number(args.settle) * 1000;
const scenes = args.scenes.split(',').map((s) => {
  if (!(SCENES as readonly string[]).includes(s)) throw new Error(`unknown scene ${s}; scenes: ${SCENES.join(', ')}`);
  return s as Scene;
});
if (args.shots) mkdirSync(args.shots, { recursive: true });
if (args.profile) mkdirSync(args.profile, { recursive: true });
if (args.trace) mkdirSync(args.trace, { recursive: true });

interface Side {
  name: string;
  ui: string;
  runtime: string;
}

interface Usage {
  cpuMsPerMin: Record<Kind, number>;
  wakeupsPerMin: Record<Kind, number>;
}

interface Measured extends Usage {
  side: string;
  run: number;
  scene: Scene;
  errors: number;
  quotesMoved: number;
}

const runtimes = args.runtime?.length
  ? args.runtime.map((path) => resolve(path))
  : [resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path];
const sides = (args.ui?.length ? args.ui : [buildUi()]).map((dir, i) => {
  const ui = resolve(dir);
  if (!existsSync(join(ui, 'index.html'))) throw new Error(`no built UI at ${ui}`);
  return { name: args.ui && args.ui.length > 1 ? basename(ui) : 'ui', ui, runtime: runtimes[i] ?? runtimes[0]! };
});
const results: Measured[] = [];

for (let run = 0; run < Number(args.runs); run++) {
  for (const side of run % 2 === 0 ? sides : [...sides].reverse()) {
    const measured = await measureRun(side, run);
    for (const m of measured) {
      results.push({ ...m, side: side.name, run });
      console.info(`[energy] ${side.name} run ${String(run + 1)} ${m.scene}: ${line(m)}`);
    }
    if (args.json) writeFileSync(args.json, JSON.stringify(results, null, 2));
  }
}
report(results);
if (results.some((r) => r.errors > 0 || (r.scene !== 'idle' && r.quotesMoved === 0))) process.exitCode = 1;

function buildUi(): string {
  const res = spawnSync('bun', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
  if (res.status !== 0) throw new Error('bun run build failed');
  return join(repo, 'apps/desktop/dist');
}

async function measureRun(side: Side, run: number): Promise<Omit<Measured, 'side' | 'run'>[]> {
  const out: Omit<Measured, 'side' | 'run'>[] = [];
  if (scenes.includes('idle')) {
    await withDesk(side, 'still', async (desk) => {
      out.push({ scene: 'idle', ...(await desk.measure('idle', run)) });
    });
  }
  const live = scenes.filter((s) => s !== 'idle');
  if (live.length === 0) return out;
  await withDesk(side, 'busy', async (desk) => {
    await desk.drive((page) => applyScalp(page));
    for (const scene of live) {
      if (scene === 'popout') await desk.drive((page) => popOutChart(page));
      const undo = await desk.arrange(scene);
      out.push({ scene, ...(await desk.measure(scene, run)) });
      await undo();
    }
  });
  return out;
}

interface Desk {
  drive(fn: (page: Page) => Promise<void>): Promise<void>;
  arrange(scene: Scene): Promise<() => Promise<void>>;
  measure(scene: Scene, run: number): Promise<Usage & { errors: number; quotesMoved: number }>;
}

async function withDesk(side: Side, market: 'still' | 'busy', body: (desk: Desk) => Promise<void>): Promise<void> {
  const runtime = await startRuntime(side, market);
  const chrome = await startChrome();
  try {
    const app = await openApp(chrome.endpoint, runtime.info);
    const rpc = await RuntimeRpc.open(runtime.info);
    try {
      await body({
        drive: async (fn) => {
          const browser = await chromium.connectOverCDP(chrome.endpoint);
          try {
            await fn(await pageOf(browser, app.targetId));
          } finally {
            await browser.close();
          }
        },
        arrange: (scene) => arrange(chrome.endpoint, app.targetId, scene),
        measure: async (scene, run) => {
          await sleep(settleMs);
          const instruments = await quotedInstruments(rpc);
          const before = await quotes(rpc, instruments);
          const errorsBefore = await pageErrors(chrome.endpoint, app.targetId);
          const usage = await sample([runtime.pid], chrome.pid, seconds);
          const errors = (await pageErrors(chrome.endpoint, app.targetId)) - errorsBefore;
          const after = await quotes(rpc, instruments);
          const evidence = sides.length > 1 ? `${side.name}-${scene}` : scene;
          if (args.shots && run === 0) await shoot(chrome.endpoint, join(args.shots, `${evidence}.png`));
          if (args.profile && run === 0) await profile(chrome.endpoint, join(args.profile, `${evidence}.cpuprofile`));
          if (args.trace && run === 0) await trace(chrome.endpoint, join(args.trace, `${evidence}.json`));
          return { ...usage, errors, quotesMoved: after.filter((ts, i) => ts !== before[i]).length };
        },
      });
    } finally {
      rpc.close();
    }
  } finally {
    await chrome.stop();
    await runtime.stop();
  }
}

async function startRuntime({ ui, runtime: runtimeBin }: Side, market: 'still' | 'busy') {
  const dataDir = mkdtempSync(join(tmpdir(), 'tessera-bench-energy-'));
  const env = { ...process.env, TESSERA_TEST_MARKET: market === 'busy' ? 'busy' : '' };
  const child = spawn(runtimeBin, ['serve', '--port', '0', '--ui-dir', ui, '--data-dir', dataDir, '--launch-tickets'], {
    cwd: repo,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const info = await new Promise<RuntimeInfo>((resolveInfo, reject) => {
    let ready: RuntimeInfo | null = null;
    child.once('exit', (code) => reject(new Error(`the sim runtime exited (${String(code)})`)));
    createInterface({ input: child.stdout }).on('line', (text) => {
      let msg: { event?: string; port?: number; token?: string; ticket?: string };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return;
      }
      if (msg.event === 'ready' && typeof msg.port === 'number' && typeof msg.token === 'string') {
        ready = { origin: `http://127.0.0.1:${String(msg.port)}`, token: msg.token, ticket: null };
      } else if (msg.event === 'launch' && typeof msg.ticket === 'string' && ready) {
        resolveInfo({ ...ready, ticket: msg.ticket });
      }
    });
  });
  return {
    info,
    pid: child.pid!,
    stop: async () => {
      await exited(child);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const gone = new Promise<void>((r) => child.once('exit', () => r()));
  askRuntimeToExit(child);
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  await gone;
  clearTimeout(kill);
}

async function startChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'tessera-bench-energy-chrome-'));
  const flags = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--window-size=${String(WINDOW.width)},${String(WINDOW.height)}`,
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const child = spawn(chromium.executablePath(), flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    child.once('exit', (code) => reject(new Error(`Chromium exited (${String(code)})`)));
    createInterface({ input: child.stderr }).on('line', (text) => {
      const m = /DevTools listening on ws:\/\/([^/]+)\//.exec(text);
      if (m) resolveEndpoint(`http://${m[1]!}`);
    });
  });
  return {
    endpoint,
    pid: child.pid!,
    stop: async () => {
      const tree = descendants(child.pid!);
      if (child.exitCode === null && child.signalCode === null) {
        const gone = new Promise<void>((r) => child.once('exit', () => r()));
        child.kill('SIGKILL');
        await gone;
      }
      for (const pid of tree) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (error) {
        console.warn(`[energy] left Chromium's profile at ${profile}:`, error instanceof Error ? error.message : error);
      }
    },
  };
}

async function pageOf(browser: Browser, targetId: string): Promise<Page> {
  for (const page of browser.contexts()[0]?.pages() ?? []) {
    const cdp = await page.context().newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.detach();
    if (targetInfo.targetId === targetId) return page;
  }
  return fail('the app page is gone');
}

async function openApp(endpoint: string, info: RuntimeInfo): Promise<{ targetId: string }> {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = browser.contexts()[0]!.pages()[0]!;
    await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
    await page.locator('main[aria-label="Workspace"]').waitFor({ timeout: 180_000 });
    await page.locator('.chart-host').first().waitFor({ timeout: 180_000 });
    await page.evaluate(() => {
      const w = window as unknown as { benchErrors: number };
      w.benchErrors = 0;
      addEventListener('error', () => w.benchErrors++);
      addEventListener('unhandledrejection', () => w.benchErrors++);
    });
    const cdp = await page.context().newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    return { targetId: targetInfo.targetId };
  } finally {
    await browser.close();
  }
}

async function applyScalp(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Tessera menu:/ }).click();
  await page.getByRole('menuitem', { name: 'New from preset' }).click();
  await page.getByRole('menuitem', { name: /Scalp/ }).click();
  await page.getByRole('region', { name: /DOM/ }).waitFor({ timeout: 60_000 });
  await page.locator('.chart-host:visible').first().waitFor({ timeout: 60_000 });
}

async function popOutChart(page: Page): Promise<void> {
  const tab = page.locator('.dock-tab:visible', { hasText: /·\s*1m/ }).first();
  await tab.click();
  const group = page.locator('.dv-groupview', { has: tab });
  const opened = page.context().waitForEvent('page', { timeout: 30_000 });
  await group.getByRole('button', { name: 'Pop out', exact: true }).click();
  const pop = await opened;
  await pop.locator('.chart-host').first().waitFor({ timeout: 60_000 });
}

async function arrange(endpoint: string, app: string, scene: Scene): Promise<() => Promise<void>> {
  const noop = () => Promise.resolve();
  if (scene === 'hidden') {
    const tab = await devtools<{ id: string }>(endpoint, '/json/new?about:blank', 'PUT');
    return async () => {
      await devtools(endpoint, `/json/activate/${app}`);
      await devtools(endpoint, `/json/close/${tab.id}`);
    };
  }
  if (scene === 'behind') {
    const { targetId } = await browserCdp<{ targetId: string }>(endpoint, 'Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    });
    return async () => {
      await devtools(endpoint, `/json/close/${targetId}`);
    };
  }
  await devtools(endpoint, `/json/activate/${app}`);
  return noop;
}

async function devtools<T>(endpoint: string, path: string, method = 'GET'): Promise<T> {
  const res = await fetch(`${endpoint}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function cdpCall<T>(url: string, method: string, params: object): Promise<T> {
  const ws = new WebSocket(url);
  await new Promise((r, reject) => {
    ws.onopen = r;
    ws.onerror = reject;
  });
  try {
    return await new Promise<T>((r, reject) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { id?: number; result?: T; error?: { message: string } };
        if (msg.id !== 1) return;
        if (msg.error) reject(new Error(msg.error.message));
        else r(msg.result as T);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

async function browserCdp<T>(endpoint: string, method: string, params: object): Promise<T> {
  const { webSocketDebuggerUrl } = await devtools<{ webSocketDebuggerUrl: string }>(endpoint, '/json/version');
  return cdpCall<T>(webSocketDebuggerUrl, method, params);
}

async function pageEval<T>(endpoint: string, targetId: string, expression: string): Promise<T> {
  const targets = await devtools<{ id: string; webSocketDebuggerUrl: string }[]>(endpoint, '/json/list');
  const target = targets.find((t) => t.id === targetId) ?? fail('the app page is gone');
  const { result } = await cdpCall<{ result: { value: T } }>(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return result.value;
}

async function pageErrors(endpoint: string, targetId: string): Promise<number> {
  return pageEval<number>(endpoint, targetId, 'window.benchErrors ?? 0');
}

async function shoot(endpoint: string, path: string): Promise<void> {
  const targets = await devtools<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }[]>(
    endpoint,
    '/json/list',
  );
  for (const [i, t] of targets.filter((t) => t.type === 'page' && t.url.startsWith('http')).entries()) {
    const { data } = await cdpCall<{ data: string }>(t.webSocketDebuggerUrl, 'Page.captureScreenshot', {});
    writeFileSync(i === 0 ? path : path.replace(/\.png$/, `-${String(i)}.png`), Buffer.from(data, 'base64'));
  }
}

async function profile(endpoint: string, path: string): Promise<void> {
  const targets = await devtools<{ type: string; url: string; webSocketDebuggerUrl: string }[]>(endpoint, '/json/list');
  const pages = targets.filter((t) => t.type === 'page' && t.url.startsWith('http'));
  const sockets = await Promise.all(pages.map((t) => cdpSocket(t.webSocketDebuggerUrl)));
  try {
    for (const send of sockets) {
      await send('Profiler.enable', {});
      await send('Profiler.setSamplingInterval', { interval: 200 });
      await send('Profiler.start', {});
    }
    await sleep(10_000);
    for (const [i, send] of sockets.entries()) {
      const { profile } = await send<{ profile: unknown }>('Profiler.stop', {});
      writeFileSync(
        i === 0 ? path : path.replace(/\.cpuprofile$/, `-${String(i)}.cpuprofile`),
        JSON.stringify(profile),
      );
    }
  } finally {
    for (const send of sockets) send.close();
  }
}

async function trace(endpoint: string, path: string): Promise<void> {
  const { webSocketDebuggerUrl } = await devtools<{ webSocketDebuggerUrl: string }>(endpoint, '/json/version');
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r, reject) => {
    ws.onopen = r;
    ws.onerror = reject;
  });
  const events: unknown[] = [];
  const done = new Promise<void>((r) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { method?: string; params?: { value?: unknown[] } };
      if (msg.method === 'Tracing.dataCollected') events.push(...(msg.params?.value ?? []));
      if (msg.method === 'Tracing.tracingComplete') r();
    };
  });
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Tracing.start',
      params: {
        categories:
          'devtools.timeline,toplevel,cc,viz,blink,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack',
        transferMode: 'ReportEvents',
      },
    }),
  );
  await sleep(5000);
  ws.send(JSON.stringify({ id: 2, method: 'Tracing.end' }));
  await done;
  ws.close();
  writeFileSync(path, JSON.stringify(events));
}

async function cdpSocket(url: string) {
  const ws = new WebSocket(url);
  await new Promise((r, reject) => {
    ws.onopen = r;
    ws.onerror = reject;
  });
  let id = 0;
  const waiting = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
  };
  const send = <T>(method: string, params: object) =>
    new Promise<T>((r, reject) => {
      waiting.set(++id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : r(msg.result as T)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return Object.assign(send, { close: () => ws.close() });
}

async function quotedInstruments(rpc: RuntimeRpc): Promise<string[]> {
  const { layouts } = await rpc.tool<{ layouts: { id: string }[] }>('layout.list', {});
  const charts = await Promise.all(
    layouts.map((l) => rpc.tool<{ charts: Record<string, { instrument: string }> }>('layout.get', { layoutId: l.id })),
  );
  return [...new Set(charts.flatMap((l) => Object.values(l.charts).map((c) => c.instrument)))];
}

async function quotes(rpc: RuntimeRpc, instruments: string[]): Promise<string[]> {
  return Promise.all(
    instruments.map(async (instrument) => {
      const q = await rpc.tool<{ ts: unknown }>('market.get_quote', { instrument });
      return JSON.stringify(q.ts);
    }),
  );
}

interface Snapshot {
  cpu: Map<number, number>;
  switches: Map<string, number>;
  kinds: Map<number, Kind>;
}

async function sample(runtimePids: number[], chromePid: number, forSeconds: number): Promise<Usage> {
  const start = snapshot(runtimePids, chromePid);
  await sleep(forSeconds * 1000);
  const end = snapshot(runtimePids, chromePid);
  const perMin = 60 / forSeconds;
  const cpuMsPerMin = zeroes();
  const wakeupsPerMin = zeroes();
  for (const [pid, kind] of end.kinds) {
    cpuMsPerMin[kind] += ((end.cpu.get(pid)! - (start.cpu.get(pid) ?? 0)) * CLOCK_TICK_MS * perMin) | 0;
  }
  for (const [task, count] of end.switches) {
    const kind = end.kinds.get(Number(task.split(':')[0]))!;
    wakeupsPerMin[kind] += ((count - (start.switches.get(task) ?? 0)) * perMin) | 0;
  }
  return { cpuMsPerMin, wakeupsPerMin };
}

function zeroes(): Record<Kind, number> {
  return { runtime: 0, renderer: 0, gpu: 0, browser: 0, other: 0 };
}

function snapshot(runtimePids: number[], chromePid: number): Snapshot {
  const kinds = new Map<number, Kind>();
  for (const pid of runtimePids) kinds.set(pid, 'runtime');
  for (const pid of descendants(chromePid)) kinds.set(pid, chromeKind(pid));
  const cpu = new Map<number, number>();
  const switches = new Map<string, number>();
  for (const pid of kinds.keys()) {
    const stat = procStat(pid);
    if (!stat) {
      kinds.delete(pid);
      continue;
    }
    cpu.set(pid, Number(stat[11]) + Number(stat[12]));
    for (const tid of safeList(`/proc/${String(pid)}/task`)) {
      const status = safeRead(`/proc/${String(pid)}/task/${tid}/status`);
      const m = status && /voluntary_ctxt_switches:\s+(\d+)/.exec(status);
      if (m) switches.set(`${String(pid)}:${tid}`, Number(m[1]));
    }
  }
  return { cpu, switches, kinds };
}

function procStat(pid: number): string[] | null {
  const text = safeRead(`/proc/${String(pid)}/stat`);
  return text ? text.slice(text.lastIndexOf(')') + 2).split(' ') : null;
}

function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const entry of safeList('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = procStat(Number(entry));
    if (!stat) continue;
    const parent = Number(stat[1]);
    children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
  }
  const out = [root];
  for (const pid of out) out.push(...(children.get(pid) ?? []));
  return out;
}

function chromeKind(pid: number): Kind {
  const type = /--type=([\w-]+)/.exec(safeRead(`/proc/${String(pid)}/cmdline`)?.replaceAll('\0', ' ') ?? '')?.[1];
  if (type === undefined) return 'browser';
  if (type === 'renderer') return 'renderer';
  if (type === 'gpu-process') return 'gpu';
  return 'other';
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeList(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(message: string): never {
  throw new Error(message);
}

function total(r: Record<Kind, number>): number {
  return KINDS.reduce((s, k) => s + r[k], 0);
}

function line(m: Usage & { errors: number; quotesMoved: number }): string {
  const parts = KINDS.map((k) => `${k} ${String(m.cpuMsPerMin[k])}`).join(', ');
  return `cpu ${String(total(m.cpuMsPerMin))} ms/min (${parts}); wake-ups ${String(total(m.wakeupsPerMin))}/min; errors ${String(m.errors)}; quotes moved ${String(m.quotesMoved)}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function report(rows: Measured[]): void {
  console.info(`\nMedian of ${args.runs} runs of ${String(seconds)} s per scene, after ${args.settle} s to settle.`);
  printTable(rows, 'CPU, ms per minute', (r) => r.cpuMsPerMin);
  printTable(rows, 'Wake-ups per minute', (r) => r.wakeupsPerMin);
}

function printTable(rows: Measured[], title: string, of: (r: Measured) => Record<Kind, number>): void {
  const sideNames = [...new Set(rows.map((r) => r.side))];
  const head = ['scene', 'side', 'total', ...KINDS, 'range'];
  const table: string[][] = [head];
  for (const scene of scenes) {
    for (const side of sideNames) {
      const these = rows.filter((r) => r.scene === scene && r.side === side);
      if (these.length === 0) continue;
      const totals = these.map((r) => total(of(r)));
      table.push([
        SCENE_TITLES[scene],
        side,
        String(median(totals)),
        ...KINDS.map((k) => String(median(these.map((r) => of(r)[k])))),
        `${String(Math.min(...totals))}–${String(Math.max(...totals))}`,
      ]);
    }
  }
  const widths = head.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
  console.info(`\n${title}\n`);
  for (const row of table) {
    console.info(row.map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  '));
  }
}
