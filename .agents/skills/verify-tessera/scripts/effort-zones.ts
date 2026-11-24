#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/effort-zones', uiDir, tag = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const BUY = '#26a69a';
const SELL = '#ef5350';
const MINUTE = 60e9;
const MARGIN = 12 * MINUTE;
const NEAR = 30 * MINUTE;
const INPUTS = { maxBarSeconds: 0 };

interface Box {
  time1: number;
  time2: number | null;
  price1: number;
  price2: number;
  color: string | null;
}

const data = mkdtempSync(join(tmpdir(), 'tessera-effort-zones-'));
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
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
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
    client: { name: 'effort-zones', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

const end = (box: Box) => box.time2 ?? box.time1;

function newestPair(boxes: Box[]): { from: number; to: number; buy: Box; sell: Box } | null {
  let best: { from: number; to: number; buy: Box; sell: Box } | null = null;
  for (const buy of boxes.filter((b) => b.color === BUY)) {
    for (const sell of boxes.filter((b) => b.color === SELL)) {
      const from = Math.min(buy.time1, sell.time1);
      const to = Math.max(end(buy), end(sell));
      if (to - from <= NEAR && (!best || to > best.to)) best = { from, to, buy, sell };
    }
  }
  return best;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const tile = { layoutId: 'default', tileId: 'chart-1' };
  await tool('chart.set_timeframe', { ...tile, tf: '1m' });
  const chart = page.getByRole('region', { name: 'NQ Z6 1m' });
  await chart.waitFor();
  await chart.getByRole('status', { name: 'Loading bars' }).waitFor({ state: 'detached', timeout: 60_000 });
  await tool('chart.add_layer', { ...tile, kind: 'effort', params: { inputs: INPUTS } });

  let series: { objects?: { boxes?: Box[] }; bars?: number } = {};
  let pair: ReturnType<typeof newestPair> = null;
  for (let waited = 0; !pair; waited++) {
    if (waited > 60) throw new Error('effort drew no buy zone beside a sell zone');
    await page.waitForTimeout(2_000);
    const answer = (await tool('indicators.compute', {
      indicator: 'effort',
      inputs: INPUTS,
      instrument: 'NQZ6.CME',
      tf: '1m',
      limit: 20_000,
    })) as { output?: typeof series };
    series = answer.output ?? {};
    pair = newestPair(series.objects?.boxes ?? []);
  }
  const boxes = series.objects?.boxes ?? [];
  const counts = {
    bars: series.bars,
    buy: boxes.filter((b) => b.color === BUY).length,
    sell: boxes.filter((b) => b.color === SELL).length,
    shown: { buy: pair.buy, sell: pair.sell },
  };
  writeFileSync(join(dir, `${tag}-indicators.compute.json`), JSON.stringify(series, null, 2));
  writeFileSync(join(dir, `${tag}-counts.json`), JSON.stringify(counts, null, 2));

  const inChart = chart.getByRole('button', { name: 'Maximise', exact: true });
  const maximise = (await inChart.count()) > 0 ? inChart : page.getByRole('button', { name: 'Maximise', exact: true }).first();
  await maximise.click();
  await page.waitForTimeout(1_000);
  await tool('chart.set_viewport', { ...tile, from: pair.from - MARGIN, to: pair.to + MARGIN });
  await page.waitForTimeout(4_000);
  writeFileSync(join(dir, `${tag}-chart.get_state.json`), JSON.stringify(await tool('chart.get_state', tile), null, 2));
  await page.screenshot({ path: join(dir, `${tag}-desk.png`) });
  await chart.screenshot({ path: join(dir, `${tag}-chart.png`) });
  console.log(JSON.stringify({ ...counts, stills: dir }));
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
