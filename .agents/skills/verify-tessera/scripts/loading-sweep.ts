#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/loading-sweep', uiDir, only, recordTo] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SLOW = { min: 250, max: 2_000 };
const WATCH_MS = 9_000;

interface Surface {
  id: string;
  open: (page: Page) => Promise<void>;
}

const rail = (label: string) => async (page: Page) => {
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('button', { name: label, exact: true }).click();
};

const SURFACES: readonly Surface[] = [
  { id: 'desk', open: async () => undefined },
  { id: 'markets', open: rail('Markets') },
  { id: 'analyst', open: rail('Analyst') },
  { id: 'indicators', open: rail('Indicators') },
  { id: 'research', open: rail('Research') },
  { id: 'journal', open: rail('Journal') },
  { id: 'copy', open: rail('Trade copier') },
  { id: 'settings', open: rail('Settings') },
  {
    id: 'profile',
    open: async (page) => {
      await page.locator('.ar-rail-foot button').last().click();
    },
  },
];

function delayFor(key: string, n: number): number {
  let h = 2166136261;
  for (const c of `${key}#${String(n)}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return SLOW.min + ((h >>> 0) % (SLOW.max - SLOW.min));
}

const data = mkdtempSync(join(tmpdir(), 'tessera-loading-sweep-'));
const bin = process.env.TESSERA_TEST_RUNTIME_BIN ?? resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir || join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
);
let ticket: string | null = null;
const ready = await new Promise<number>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  let port: number | undefined;
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    let m: { event?: string; port?: number; ticket?: string };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      return;
    }
    if (m.port) port = m.port;
    if (typeof m.ticket === 'string') ticket = m.ticket;
    if (port && ticket) done(port);
  });
});
const origin = `http://127.0.0.1:${String(ready)}`;

async function nextTicket(used: string | null): Promise<string> {
  for (let i = 0; i < 200 && (ticket === null || ticket === used); i++) await new Promise((r) => setTimeout(r, 50));
  if (ticket === null || ticket === used) throw new Error('the runtime printed no new launch ticket');
  return ticket;
}

const OBSERVE = () => {
  const w = window as unknown as { __sweep: unknown };
  const start = performance.now();
  const shifts: { t: number; value: number; sources: string[] }[] = [];
  const states: { t: number; text: string; busy: number }[] = [];
  w.__sweep = { shifts, states };
  const path = (n: Node | null): string => {
    const parts: string[] = [];
    for (let e = n instanceof Element ? n : null; e && parts.length < 4; e = e.parentElement)
      parts.unshift(e.tagName.toLowerCase() + (e.classList.length ? `.${[...e.classList].slice(0, 2).join('.')}` : ''));
    return parts.join('>');
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as unknown as {
      startTime: number;
      value: number;
      hadRecentInput: boolean;
      sources: { node: Node | null }[];
    }[])
      if (!e.hadRecentInput) shifts.push({ t: e.startTime - start, value: e.value, sources: e.sources.map((s) => path(s.node)) });
  }).observe({ type: 'layout-shift', buffered: true });
  const sample = () => {
    const root =
      document.querySelector('.ar-layer:not([hidden])') ?? document.querySelector('.ar-desk') ?? document.body;
    const text = (root as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 6000);
    const busy = root.querySelectorAll('[aria-busy="true"]').length;
    const last = states.at(-1);
    if (!last || last.text !== text || last.busy !== busy) states.push({ t: performance.now() - start, text, busy });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

interface Recorded {
  tools: Record<string, { input: unknown; output: unknown }[]>;
  topics: Record<string, unknown[]>;
}
const recorded: Recorded = { tools: {}, topics: {} };
const NOT_RECORDED = new Set(['market.get_candles', 'layout.save', 'settings.set', 'indicators.reach', 'indicators.series', 'market.history']);
const keep = (list: unknown[], item: unknown, max: number) => {
  const key = JSON.stringify(item);
  if (list.length < max && !list.some((x) => JSON.stringify(x) === key)) list.push(item);
};

function wordDiff(before: string[], after: string[]): string {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  const run = (sign: string, words: string[]) => words.length && out.push(`${sign}[${words.join(' ').slice(0, 160)}]`);
  while (i < n || j < m) {
    const gone: string[] = [];
    const came: string[] = [];
    while (i < n && (j >= m || (before[i] !== after[j] && lcs[i + 1]![j]! >= lcs[i]![j + 1]!))) gone.push(before[i++]!);
    while (j < m && (i >= n || (before[i] !== after[j] && lcs[i]![j + 1]! > lcs[i + 1]![j]!))) came.push(after[j++]!);
    run('-', gone);
    run('+', came);
    if (i < n && j < m && before[i] === after[j]) {
      i++;
      j++;
    }
  }
  return out.join(' ');
}

function parse<T>(m: string | Buffer): T | null {
  try {
    return JSON.parse(String(m)) as T;
  } catch {
    return null;
  }
}

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
const WARM = process.env.TESSERA_SWEEP_WARM === '1';
let used: string | null = null;

async function visited(surface: Surface): Promise<Awaited<ReturnType<BrowserContext['storageState']>>> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => sessionStorage.setItem('tessera.intro', 'seen'));
  used = await nextTicket(used);
  await page.goto(`${origin}/#ticket=${used}`);
  await page.getByRole('navigation', { name: 'Areas' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await surface.open(page);
  await page.waitForTimeout(4_000);
  await rail('Desk')(page);
  await page.waitForTimeout(1_000);
  const state = await context.storageState();
  await context.close();
  return state;
}
const report: Record<string, unknown> = {};
try {
  for (const surface of SURFACES.filter((s) => !only || only.split(',').includes(s.id))) {
    const videoDir = join(dir, `video-${surface.id}`);
    rmSync(videoDir, { recursive: true, force: true });
    const storageState = WARM ? await visited(surface) : undefined;
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      recordVideo: { dir: videoDir, size: { width: 1600, height: 1000 } },
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    await page.addInitScript(OBSERVE);
    await page.addInitScript(() => sessionStorage.setItem('tessera.intro', 'seen'));
    let slowing = surface.id === 'desk';
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      const names = new Map<number, string>();
      const inputs = new Map<number, unknown>();
      const counts = new Map<string, number>();
      const lanes = new Map<string, number>();
      const at = (lane: string, wait: number) => {
        const t = Math.max(Date.now() + wait, lanes.get(lane) ?? 0);
        lanes.set(lane, t);
        return t - Date.now();
      };
      ws.onMessage((m) => {
        const sent = parse<{ id?: number; method?: string; params?: { name?: string; topic?: string; input?: unknown } }>(m);
        if (sent?.id !== undefined && sent.method && sent.method !== 'session.hello') {
          const tool = sent.method === 'tools.invoke';
          names.set(sent.id, tool ? `tool:${sent.params?.name ?? '?'}` : `${sent.method}:${sent.params?.topic ?? ''}`);
          if (tool) inputs.set(sent.id, sent.params?.input ?? null);
        }
        server.send(m);
      });
      server.onMessage((m) => {
        let lane = 'other';
        let wait = 0;
        const msg = parse<{
          id?: number;
          method?: string;
          params?: { subscriptionId?: string; topic?: string; data?: unknown };
          result?: { subscriptionId?: string; ok?: boolean; output?: unknown };
        }>(m);
        const name = msg?.id === undefined ? undefined : names.get(msg.id);
        if (msg && name?.startsWith('tool:') && msg.result?.ok && !NOT_RECORDED.has(name.slice(5)))
          keep((recorded.tools[name.slice(5)] ??= []), { input: inputs.get(msg.id!), output: msg.result.output }, 2);
        if (msg?.method === 'event' && msg.params?.topic && !NOT_RECORDED.has(msg.params.topic))
          keep((recorded.topics[msg.params.topic] ??= []), msg.params.data, 2);
        if (msg && name && slowing) {
          const n = (counts.get(name) ?? 0) + 1;
          counts.set(name, n);
          wait = delayFor(name, n);
          lane = msg.result?.subscriptionId ? `sub:${msg.result.subscriptionId}` : `id:${String(msg.id)}`;
        } else if (msg?.method === 'event' && msg.params?.subscriptionId) lane = `sub:${msg.params.subscriptionId}`;
        const delay = at(lane, wait);
        if (delay <= 0) ws.send(m);
        else setTimeout(() => ws.send(m), delay);
      });
    });
    used = await nextTicket(used);
    const t0 = Date.now();
    await page.goto(`${origin}/#ticket=${used}`);
    await page.getByRole('navigation', { name: 'Areas' }).waitFor({ timeout: 60_000 });
    let openedAt = 0;
    if (surface.id !== 'desk') {
      await page.waitForTimeout(8_000);
      await page.evaluate(() => {
        const s = (window as unknown as { __sweep: { states: unknown[]; shifts: unknown[] } }).__sweep;
        s.states.length = 0;
        s.shifts.length = 0;
      });
      slowing = true;
      openedAt = Date.now() - t0;
      await surface.open(page);
    }
    await page.waitForTimeout(WATCH_MS);
    const seen = await page.evaluate(() => (window as unknown as { __sweep: unknown }).__sweep);
    await page.screenshot({ path: join(dir, `${surface.id}-settled.png`) });
    await context.close();
    const video = readdirSync(videoDir)
      .filter((f) => f.endsWith('.webm'))
      .sort((a, b) => statSync(join(videoDir, b)).size - statSync(join(videoDir, a)).size)[0];
    report[surface.id] = { openedAtMs: openedAt, video: video ? join(videoDir, video) : null, ...(seen as object) };
    const r = seen as { states: { t: number; text: string }[]; shifts: { t: number; value: number; sources: string[] }[] };
    const cls = r.shifts.reduce((a, s) => a + s.value, 0);
    let previous: string[] = [];
    const timeline = [
      ...r.shifts.map((s) => `${String(Math.round(s.t)).padStart(6)} shift ${s.value.toFixed(3)} ${s.sources.join(' | ')}`),
      ...r.states.map((s) => {
        const words = s.text.split(' ').filter(Boolean);
        const line = `${String(Math.round(s.t)).padStart(6)} ${wordDiff(previous, words)}`;
        previous = words;
        return line;
      }),
    ];
    writeFileSync(join(dir, `${surface.id}-timeline.txt`), `${timeline.join('\n')}\n`);
    console.log(`${surface.id}: ${String(r.states.length)} states, CLS ${cls.toFixed(3)}`);
    if (video) {
      const strip = join(dir, `${surface.id}-strip.png`);
      const from = Math.max(0, openedAt / 1000 - 0.2);
      spawnSync(
        'ffmpeg',
        ['-nostdin', '-y', '-loglevel', 'error', '-ss', String(from), '-i', join(videoDir, video), '-t', '6',
          '-vf', 'fps=2.5,scale=640:-1,tile=3x5', '-frames:v', '1', strip],
        { stdio: 'inherit' },
      );
    }
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 1));
  if (recordTo) {
    writeFileSync(resolve(recordTo), JSON.stringify(recorded));
    spawnSync('npx', ['prettier', '--write', resolve(recordTo)], { cwd: repo, stdio: 'inherit' });
  }
  console.log(`report in ${dir}`);
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
