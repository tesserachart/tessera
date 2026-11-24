#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/orderflow-loading', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: orderflow-loading.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const ui = uiDir || join(repo, 'apps/desktop/dist');
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const data = mkdtempSync(join(tmpdir(), 'tessera-orderflow-loading-'));

const LOGIN = { system: 'Tessera Test', gateway: 'Chicago Area', user: 'trader', password: 'demo' };
const HISTORY_MS = process.env.HISTORY_MS ?? '400';
const TILE = { layoutId: 'default', tileId: 'chart-1' };
const WATCH_MS = 60_000;
const SAMPLE_MS = 200;
const FORMING_ASKS = 8;

const failures: string[] = [];
const expectThat = (ok: boolean, line: string) => {
  console.info(`${ok ? 'ok' : 'FAIL'}: ${line}`);
  if (!ok) failures.push(line);
};

const runtime = spawn(bin, ['serve', '--port', '0', '--ui-dir', ui, '--data-dir', data, '--launch-tickets'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, TESSERA_TEST_MARKET: 'rithmic', TESSERA_TEST_HISTORY_MS: HISTORY_MS },
});
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

async function tool<T>(name: string, input: unknown): Promise<T> {
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
    client: { name: 'orderflow-loading', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  const result = answer.result as { ok: boolean; output: T; error: { message: string } | null };
  if (!result.ok) throw new Error(`${name}: ${result.error?.message ?? 'refused'}`);
  return result.output;
}

interface Pulled {
  source: string;
  total: { requests: number; bytes: number };
}

const pulled = async () =>
  ((await tool<{ pulled?: Pulled[] }>('market.saved_trades', {})).pulled ?? []).reduce(
    (n, p) => n + p.total.requests,
    0,
  );

const legendOf = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ind-lg-row.is-flow')].map((r) => ({
      text: (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
      placeholder: r.querySelector('.ind-lg-skel') !== null,
    })),
  );

const chartOf = (page: Page) => page.getByRole('region', { name: /^NQ \S+ 1m$/ }).first();

interface Sample {
  ms: number;
  legend: { text: string; placeholder: boolean }[];
}

async function watch(page: Page, began: number, name: string) {
  const samples: Sample[] = [];
  let shotLoading = false;
  while (Date.now() - began < WATCH_MS) {
    const legend = await legendOf(page);
    samples.push({ ms: Date.now() - began, legend });
    const text = legend.map((l) => l.text).join(' | ');
    if (!shotLoading && /Loading ·/.test(text)) {
      shotLoading = true;
      await page.screenshot({ path: join(dir, `${scene}-${name}-loading.png`) });
    }
    const settled = samples.length > 5 && !/Loading ·/.test(text) && legend.every((l) => !l.placeholder);
    if (settled) break;
    await page.waitForTimeout(SAMPLE_MS);
  }
  await page.screenshot({ path: join(dir, `${scene}-${name}-settled.png`) });
  writeFileSync(join(dir, `${scene}-${name}-legend.json`), JSON.stringify(samples, null, 2));
  return samples;
}

const browser = await chromium.launch();
const report: Record<string, unknown> = { build: scene, historyMs: Number(HISTORY_MS) };
try {
  await tool('settings.set', { key: 'market.recordWatchlists', value: false });
  await tool('connections.add_rithmic', LOGIN);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll('.t-splash').length === 0, null, { timeout: 60_000 });
  await tool('chart.set_symbol', { ...TILE, instrument: 'NQ' });
  await tool('chart.set_timeframe', { ...TILE, tf: '1m' });
  await chartOf(page).waitFor({ timeout: 60_000 });
  const began = Date.now();
  await tool('chart.add_layer', { ...TILE, kind: 'footprint' });
  let firstBarsMs: number | null = null;
  const polling = (async () => {
    while (firstBarsMs === null && Date.now() - began < WATCH_MS) {
      const fp = await tool<{ bars: unknown[] }>('market.get_footprint', {
        instrument: 'NQ',
        tf: '1m',
        rowTicks: 1,
        limit: 200,
      });
      if (fp.bars.length > 0) firstBarsMs = Date.now() - began;
      else await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
  })();
  const cold = await watch(page, began, 'cold');
  await polling;
  report.firstBarsMs = firstBarsMs;
  report.coldSettledMs = cold.at(-1)?.ms;
  const loadingWords = cold.flatMap((s) => s.legend.map((l) => l.text)).filter((t) => /Loading ·/.test(t));
  report.loadingWords = [...new Set(loadingWords)];
  expectThat(firstBarsMs !== null && firstBarsMs < 5_000, `the first footprint bars within seconds: ${String(firstBarsMs)} ms`);
  const silent = cold.filter((s) => s.legend.length > 0 && s.legend.every((l) => !l.placeholder && !/Loading ·/.test(l.text)));
  const settledAt = cold.findIndex((s) => s === silent[0]);
  expectThat(
    scene === 'main' || cold.slice(0, settledAt < 0 ? cold.length : settledAt).filter((s) => s.legend.length > 0).every((s) => s.legend.some((l) => l.placeholder || /Loading ·/.test(l.text))),
    'the legend shows the study loading the whole time until it settles',
  );
  expectThat(scene === 'main' || loadingWords.length > 0, `the legend says how far it is: ${loadingWords[0] ?? 'nothing'}`);

  let asked = scene === 'pr' ? await pulled() : null;
  for (let still = 0; scene === 'pr' && still < 5; ) {
    await page.waitForTimeout(1_000);
    const now = await pulled();
    still = now === asked ? still + 1 : 0;
    asked = now;
  }
  report.historyRequestsCold = asked;
  const again = Date.now();
  await page.reload();
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll('.t-splash').length === 0, null, { timeout: 60_000 });
  await chartOf(page).waitFor({ timeout: 60_000 });
  const warm = await watch(page, again, 'second-open');
  report.secondOpenSettledMs = warm.at(-1)?.ms;
  if (scene === 'pr') {
    const after = await pulled();
    report.historyRequestsSecondOpen = after - (asked ?? 0);
    expectThat(
      after - (asked ?? 0) <= FORMING_ASKS,
      `a second open asks only the bars still forming (one ask per chart's instrument and base, at most ${String(FORMING_ASKS)}): ${String(after - (asked ?? 0))}`,
    );
    report.savedTrades = await tool('market.saved_trades', {});
  }
  await page.close();
} catch (e) {
  failures.push(String(e));
} finally {
  report.failures = failures;
  writeFileSync(join(dir, `${scene}-report.json`), JSON.stringify(report, null, 2));
  await browser.close();
  const exited = new Promise((done) => runtime.once('exit', done));
  runtime.kill('SIGTERM');
  await exited;
  rmSync(data, { recursive: true, force: true });
}
console.info(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
