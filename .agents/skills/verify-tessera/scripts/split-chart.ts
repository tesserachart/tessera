#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/split-chart', uiDir, label = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-split-chart-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
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
    client: { name: 'split-chart', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

interface StoredLayout {
  charts: Record<string, { instrument: string; timeframe: string }>;
  activeChartId: string | null;
}

async function layout(step: string): Promise<StoredLayout> {
  await new Promise((r) => setTimeout(r, 1_500));
  const got = (await tool('layout.get', { layoutId: 'default' })) as { output: StoredLayout };
  writeFileSync(join(dir, `${label}-${step}-layout.get.json`), JSON.stringify(got, null, 2));
  return got.output;
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${label}-${name}.png`) });
const chartsOf = (l: StoredLayout) =>
  Object.entries(l.charts).map(([id, c]) => `${id} ${c.instrument} ${c.timeframe}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { label };
try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3_000);
  const split = page.getByRole('button', { name: 'Split chart' });
  report.splitButtons = await split.count();
  report.start = chartsOf(await layout('start'));
  await shot(page, 'desk');
  if (report.splitButtons === 0) {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('multi chart');
    await page.waitForTimeout(800);
    await shot(page, 'palette');
    await page.keyboard.press('Escape');
  } else {
    await split.first().hover();
    await page.waitForTimeout(1_200);
    await shot(page, 'tooltip');
    await split.first().click();
    await page.waitForTimeout(2_500);
    const once = await layout('split');
    report.afterClick = chartsOf(once);
    report.activeAfterClick = once.activeChartId;
    await shot(page, 'split');

    await page.keyboard.press('Control+k');
    await page.keyboard.type('multi chart');
    await page.waitForTimeout(800);
    await shot(page, 'palette');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2_500);
    const twice = await layout('palette');
    report.afterPalette = chartsOf(twice);
    report.activeAfterPalette = twice.activeChartId;
    await shot(page, 'split-twice');
  }
  writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
