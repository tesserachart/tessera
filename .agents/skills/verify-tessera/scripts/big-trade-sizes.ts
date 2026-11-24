#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/big-trade-sizes', uiDir, tag = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const newYork = (hour: number, minute: number) => Date.UTC(2026, 9, 2, hour + 4, minute) * 1e6;

const VIEWS = [
  { name: '20m', from: newYork(14, 20) },
  { name: '80m', from: newYork(13, 20) },
  { name: 'zoomed-out', from: newYork(4, 0) },
] as const;
const TO = newYork(14, 40);

const LEVELS = [
  { name: 'auto-low', inputs: { size: 'auto', tier: 'low' } },
  { name: 'auto-medium', inputs: { size: 'auto', tier: 'medium' } },
  { name: 'auto-high', inputs: { size: 'auto', tier: 'high' } },
  { name: 'fixed-100', inputs: { size: 'fixed', minSize: 100 } },
] as const;

const data = mkdtempSync(join(tmpdir(), 'tessera-big-trade-sizes-'));
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
    client: { name: 'big-trade-sizes', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 2400, height: 1100 }, deviceScaleFactor: 2 });
const page = await context.newPage();

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const tile = { layoutId: 'default', tileId: 'chart-1' };
  await tool('chart.set_timeframe', { ...tile, tf: '1m' });
  const chart = page.getByRole('region', { name: 'NQ Z6 1m' });
  await chart.waitFor();
  await chart.getByRole('status', { name: 'Loading bars' }).waitFor({ state: 'detached', timeout: 60_000 });
  await tool('chart.add_layer', { ...tile, kind: 'big_trades' });
  const sized = async () => {
    const read = (await tool('market.get_big_trades', { instrument: 'NQZ6.CME', from: VIEWS[1].from, to: TO })) as {
      output?: { filling?: boolean; rule?: { cuts?: unknown } };
    };
    return read.output?.filling === false && read.output.rule?.cuts != null;
  };
  for (let waited = 0; !(await sized()); waited++) {
    if (waited > 90) throw new Error('Auto never sized');
    await page.waitForTimeout(2_000);
  }
  const settled = async (from: number) => {
    for (let waited = 0; waited < 120; waited++) {
      const read = (await tool('market.get_big_trades', { instrument: 'NQZ6.CME', from, to: TO })) as {
        output?: { filling?: boolean };
      };
      if (read.output?.filling === false) return page.waitForTimeout(4_000);
      await page.waitForTimeout(1_000);
    }
    throw new Error('the big trades never settled');
  };
  for (const view of VIEWS) {
    await tool('chart.set_viewport', { ...tile, from: view.from, to: TO });
    await settled(view.from);
    await page.waitForTimeout(15_000);
  }
  for (const level of LEVELS) {
    await tool('chart.update_layer', {
      ...tile,
      layerId: 'big_trades-1',
      params: { inputs: { ...level.inputs, showSize: true } },
    });
    for (const view of VIEWS) {
      await tool('chart.set_viewport', { ...tile, from: view.from, to: TO });
      await settled(view.from);
      await chart.screenshot({ path: join(dir, `${tag}-${level.name}-${view.name}.png`) });
    }
    const big = await tool('market.get_big_trades', {
      instrument: 'NQZ6.CME',
      from: VIEWS[1].from,
      to: TO,
      ...(level.inputs.size === 'fixed' ? { minSize: level.inputs.minSize } : {}),
    });
    writeFileSync(join(dir, `${tag}-${level.name}.json`), JSON.stringify(big, null, 2));
  }
  console.log(`stills in ${dir}`);
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
