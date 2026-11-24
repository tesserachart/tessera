#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/drawing-sources', uiDir, label = 'pr', binArg] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-drawing-sources-'));
const bin = binArg ?? resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
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
    client: { name: 'drawing-sources', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return (answer.result as { output: unknown }).output;
}

interface StoredChart {
  instrument: string;
  timeframe: string;
  drawings?: { points: { price: number | null }[] }[];
  drawingsFrom?: string[];
}

async function stored(step: string) {
  await new Promise((r) => setTimeout(r, 1_500));
  const got = (await tool('layout.get', { layoutId: 'default' })) as { charts: Record<string, StoredChart> };
  writeFileSync(join(dir, `${label}-${step}-layout.get.json`), JSON.stringify(got, null, 2));
  return Object.fromEntries(
    Object.entries(got.charts).map(([id, c]) => [
      id,
      `${c.instrument} ${c.timeframe}: own [${(c.drawings ?? []).map((d) => d.points[0]?.price ?? null).join(', ')}] from [${(c.drawingsFrom ?? []).join(', ')}]`,
    ]),
  );
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${label}-${name}.png`) });

async function drawLine(page: Page, chart: Locator, at: number) {
  await page.getByRole('toolbar', { name: 'Drawing tools' }).first().getByRole('button', { name: 'Horizontal line' }).click();
  const box = await chart.boundingBox();
  if (!box) throw new Error('the chart is not on screen');
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * at);
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
}

async function moreOf(page: Page, chart: Locator): Promise<Locator> {
  const box = await chart.boundingBox();
  if (!box) throw new Error('the chart is not on screen');
  const buttons = page.getByRole('button', { name: /: more$/ });
  for (let i = 0; i < (await buttons.count()); i++) {
    const b = await buttons.nth(i).boundingBox();
    if (b && b.x >= box.x && b.x <= box.x + box.width && Math.abs(b.y - box.y) < 140) return buttons.nth(i);
  }
  throw new Error('no ⋯ button over that chart');
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { label };
try {
  await tool('chart.set_symbol', { layoutId: 'default', tileId: 'chart-2', instrument: 'NQ' });
  await tool('chart.set_timeframe', { layoutId: 'default', tileId: 'chart-2', tf: '1m' });
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await page.getByRole('button', { name: 'Split chart' }).first().click();
  await page.waitForTimeout(2_500);
  const added = Object.keys((await tool('layout.get', { layoutId: 'default' }) as { charts: object }).charts).find(
    (id) => id !== 'chart-1' && id !== 'chart-2',
  );
  if (!added) throw new Error('Split chart added no chart');
  await tool('chart.set_timeframe', { layoutId: 'default', tileId: added, tf: '1m' });
  const fiveMin = page.getByRole('region', { name: 'NQ Z6 5m' });
  const oneMin = page.getByRole('region', { name: 'NQ Z6 1m' });
  await oneMin.nth(1).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3_000);

  await drawLine(page, fiveMin, 0.78);
  report.drawnOn5m = await stored('drawn-on-5m');
  await shot(page, '1-drawn-on-5m-1m-charts-clean');

  await (await moreOf(page, oneMin.nth(0))).click();
  await page.waitForTimeout(500);
  await shot(page, '2-chart-menu');
  const settings = page.getByRole('menuitem', { name: /^Settings…/ });
  if ((await settings.count()) === 0) {
    report.settings = 'none in the chart menu';
    writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 0;
  } else {
  await settings.click();
  const picker = page.getByRole('dialog', { name: /Chart settings/ }).or(page.locator('.tile-settings'));
  await picker.first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await shot(page, '3-picker');
  report.picker = await picker.first().innerText();
  await page.getByRole('switch', { name: 'NQ Z6 5m' }).click();
  await page.waitForTimeout(600);
  await shot(page, '4-picked-5m');
  await page.keyboard.press('Escape');
  report.picked = await stored('picked');
  await shot(page, '5-one-1m-shows-the-5m-line');

  await drawLine(page, oneMin.nth(0), 0.3);
  report.drawnOn1m = await stored('drawn-on-1m');
  await shot(page, '6-1m-line-stays-on-1m');
  writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  }
} catch (err) {
  for (const [i, p] of context.pages().entries()) await shot(p, `failed-${String(i)}`).catch(() => undefined);
  throw err;
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
