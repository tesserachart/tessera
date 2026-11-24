#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/stored-history', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SATURDAY = '2026-10-03T12:00:00-04:00';
const newYork = (day: number, hour: number, minute = 0) =>
  Date.UTC(2026, day > 20 ? 8 : 9, day, hour + 4, minute) * 1e6;
const at = (day: number, hour: number) =>
  `2026-${day > 20 ? '09' : '10'}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00-04:00`;
const STORED = [
  [at(28, 18), at(29, 17)],
  [at(29, 18), at(30, 17)],
  [at(30, 18), at(1, 10)],
  [at(1, 11), at(1, 17)],
  [at(1, 18), at(2, 17)],
]
  .map(([from, to]) => `${from}/${to}`)
  .join(',');
const WEEK = { from: newYork(27, 18), to: newYork(2, 17) };
const THURSDAY = { from: newYork(30, 18), to: newYork(1, 17) };
const MONDAY = { from: newYork(27, 18), to: newYork(28, 17) };
const HOLD_MS = 6_000;
const SETTLE_MS = 12_000;

const data = mkdtempSync(join(tmpdir(), 'tessera-stored-history-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      TESSERA_TEST_TRADES: 'replay',
      TESSERA_TEST_REPLAY: 'refuse',
      TESSERA_TEST_NOW: SATURDAY,
      TESSERA_TEST_STORED: STORED,
      TESSERA_NO_RITHMIC: '1',
    },
  },
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
    client: { name: 'stored-history', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

const gate = { holding: false };
const held: string[] = [];
let toPage: ((m: string) => void) | null = null;
const release = () => {
  gate.holding = false;
  for (const m of held.splice(0)) toPage?.(m);
};

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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
    if (gate.holding && name === 'market.get_footprint') {
      held.push(String(m));
      return;
    }
    ws.send(m);
  });
});

const still = (chart: Locator, name: string) => chart.screenshot({ path: join(dir, `${name}.png`) });
const save = (name: string, value: unknown) =>
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);

const tile = { layoutId: 'default', tileId: 'chart-1' };

async function chartAt(tf: '1h' | '15m', view: { from: number; to: number }): Promise<Locator> {
  await tool('chart.set_timeframe', { ...tile, tf });
  const chart = page.getByRole('region', { name: `NQ Z6 ${tf}` });
  await chart.waitFor();
  const loading = chart.getByRole('status', { name: 'Loading bars' });
  await loading.waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined);
  await loading.waitFor({ state: 'detached', timeout: 60_000 });
  await tool('chart.set_viewport', { ...tile, ...view });
  await page.waitForTimeout(SETTLE_MS);
  await tool('chart.set_viewport', { ...tile, ...view });
  await page.waitForTimeout(2_000);
  return chart;
}

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('toolbar', { name: 'Chart' }).first().getByRole('button', { name: 'Maximise' }).click();
  let chart = await chartAt('1h', WEEK);
  await still(chart, 'candles');

  gate.holding = true;
  await tool('chart.add_layer', { ...tile, kind: 'footprint' });
  await page.waitForTimeout(HOLD_MS);
  await still(chart, 'footprint-reading');
  console.log(`held ${String(held.length)} footprint answers`);
  release();
  await page.waitForTimeout(SETTLE_MS);
  await still(chart, 'footprint');

  chart = await chartAt('15m', THURSDAY);
  await still(chart, 'footprint-hole');

  await tool('chart.update_layer', { ...tile, layerId: 'footprint-1', visible: false });
  await tool('chart.add_layer', { ...tile, kind: 'delta' });
  chart = await chartAt('1h', WEEK);
  await still(chart, 'cvd');
  chart = await chartAt('15m', THURSDAY);
  await still(chart, 'cvd-hole');

  await tool('chart.update_layer', { ...tile, layerId: 'footprint-1', visible: true });
  chart = await chartAt('15m', MONDAY);
  await still(chart, 'no-history');

  const instrument = 'NQZ6.CME';
  save(
    'footprint-thursday',
    await tool('market.get_footprint', { instrument, tf: '15m', from: THURSDAY.from, to: THURSDAY.to, limit: 100 }),
  );
  save('saved-trades', await tool('market.saved_trades', {}));
  console.log(`stills in ${dir}`);
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
