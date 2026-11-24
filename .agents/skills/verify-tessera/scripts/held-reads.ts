#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/held-reads', sceneName = '1m', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const newYork = (day: number, hour: number, minute: number) => Date.UTC(2026, 9, day, hour + 4, minute) * 1e6;
const DAY_NS = 86_400e9;

interface Scene {
  tf: '1m' | '1h';
  from: number;
  to: number;
  answered: Readonly<Record<string, number>>;
}

const SCENES: Record<string, Scene> = {
  '1m': {
    tf: '1m',
    from: newYork(1, 9, 0),
    to: newYork(2, 14, 45),
    answered: { 'market.get_big_trades': 1, 'indicators.reach': 0, 'market.get_volume_profile': 1 },
  },
  '1h': {
    tf: '1h',
    from: newYork(14, 0, 0) - 30 * DAY_NS,
    to: newYork(2, 16, 0),
    answered: { 'market.get_big_trades': 4, 'indicators.reach': 0, 'market.get_volume_profile': 1 },
  },
};
const scene = SCENES[sceneName];
if (!scene) throw new Error(`no scene ${sceneName}: use 1m or 1h`);

const data = mkdtempSync(join(tmpdir(), 'tessera-held-reads-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  [
    'serve',
    '--port',
    '0',
    '--ui-dir',
    uiDir ?? join(repo, 'apps/desktop/dist'),
    '--data-dir',
    data,
    '--launch-tickets',
  ],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_TEST_TRADES: 'replay', TESSERA_NO_RITHMIC: '1' } },
);
const ready = await new Promise<{ port: number; token: string; ticket: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; token?: string; ticket?: string } = {};
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    try {
      Object.assign(seen, JSON.parse(line) as object);
    } catch {
      return;
    }
    if (seen.port && seen.token && seen.ticket) done({ port: seen.port, token: seen.token, ticket: seen.ticket });
  });
});
const origin = `http://127.0.0.1:${String(ready.port)}`;

async function tool(name: string, input: unknown): Promise<unknown> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`);
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
  await call('session.hello', {
    client: { name: 'held-reads', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

const CANDLES_LATE_MS = 4_000;
const gate = {
  holding: false,
  lateCandles: false,
  answered: {} as Readonly<Record<string, number>>,
  seen: new Map<string, number>(),
};
const held: string[] = [];
let toPage: ((m: string) => void) | null = null;
const release = () => {
  for (const m of held.splice(0)) toPage?.(m);
};

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
const context = await browser.newContext({ viewport: { width: 2400, height: 1100 } });
const page: Page = await context.newPage();
await page.routeWebSocket(/\/ws/, (ws) => {
  const server = ws.connectToServer();
  const tools = new Map<number, string>();
  toPage = (m) => ws.send(m);
  ws.onMessage((m) => {
    try {
      const sent = JSON.parse(String(m)) as { id?: number; method?: string; params?: { name?: string } };
      if (sent.method === 'tools.invoke' && sent.id !== undefined && sent.params?.name)
        tools.set(sent.id, sent.params.name);
    } catch {
      server.send(m);
      return;
    }
    server.send(m);
  });
  server.onMessage((m) => {
    let name: string | undefined;
    try {
      const answer = JSON.parse(String(m)) as { id?: number };
      name = answer.id === undefined ? undefined : tools.get(answer.id);
    } catch {
      name = undefined;
    }
    if (name === 'market.get_candles' && gate.lateCandles) {
      setTimeout(() => ws.send(m), CANDLES_LATE_MS);
      return;
    }
    const allowed = name === undefined ? undefined : gate.answered[name];
    if (name !== undefined && allowed !== undefined) {
      const n = (gate.seen.get(name) ?? 0) + 1;
      gate.seen.set(name, n);
      if (gate.holding && n > allowed) {
        held.push(String(m));
        return;
      }
    }
    ws.send(m);
  });
});

const still = (chart: Locator, name: string) => chart.screenshot({ path: join(dir, `${sceneName}-${name}.png`) });

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const tile = { layoutId: 'default', tileId: 'chart-1' };
  gate.lateCandles = true;
  await tool('chart.set_timeframe', { ...tile, tf: scene.tf });
  const chart = page.getByRole('region', { name: `NQ Z6 ${scene.tf}` });
  await chart.waitFor();
  await page.waitForTimeout(1_500);
  await still(chart, 'bars-loading');
  gate.lateCandles = false;
  await chart.getByRole('status', { name: 'Loading bars' }).waitFor({ state: 'detached', timeout: 60_000 });
  await tool('chart.set_viewport', { ...tile, from: scene.from, to: scene.to });
  await page.waitForTimeout(4_000);
  gate.answered = scene.answered;
  gate.holding = true;
  for (const kind of ['big_trades', 'delta', 'volume_profile']) await tool('chart.add_layer', { ...tile, kind });
  await page.waitForTimeout(3_000);
  await tool('chart.set_viewport', { ...tile, from: scene.from, to: scene.to });
  await page.waitForTimeout(10_000);
  await still(chart, 'held');
  console.log(`held ${String(held.length)} answers: ${JSON.stringify(Object.fromEntries(gate.seen))}`);
  gate.holding = false;
  release();
  await page.waitForTimeout(15_000);
  await still(chart, 'answered');
  console.log(`stills in ${dir}`);
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
