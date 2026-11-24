#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/follow-closed-chart', uiDir, label = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-follow-closed-chart-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_NO_RITHMIC: '1', TESSERA_TEST_MARKET: 'busy' } },
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
    client: { name: 'follow-closed-chart', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

interface StoredLayout {
  charts: Record<string, { instrument: string }>;
  activeChartId: string | null;
}

async function layout(step: string): Promise<StoredLayout> {
  await new Promise((r) => setTimeout(r, 1_500));
  const got = (await tool('layout.get', { layoutId: 'default' })) as { output: StoredLayout };
  writeFileSync(join(dir, `${label}-${step}-layout.get.json`), JSON.stringify(got, null, 2));
  return got.output;
}

async function panels(page: Page) {
  const tape = page.locator('.tape-tile');
  const dom = page.locator('.dom-tile');
  return {
    tape: await tape.getAttribute('aria-label'),
    tapeRows: await tape.locator('.t-tape-rows > *').count(),
    dom: await dom.getAttribute('aria-label'),
    domRows: await dom.locator('.t-ladder .r').count(),
    noChartNotes: await page.getByRole('region', { name: 'No chart open' }).count(),
  };
}

async function show(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.keyboard.type(`Show ${title}`);
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_500);
}

async function focusChart(page: Page, region: string): Promise<void> {
  await page.getByRole('tabpanel', { name: region }).click({ force: true });
  await page.waitForTimeout(1_000);
}

async function closeChart(page: Page, region: string): Promise<void> {
  await focusChart(page, region);
  await page.getByRole('button', { name: `Close ${region}` }).first().click();
  await page.waitForTimeout(3_000);
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${label}-${name}.png`) });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { label };
try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 60_000 });
  await show(page, 'Time & Sales');
  await show(page, 'DOM');
  await focusChart(page, 'ES Z6 1m');
  await page.waitForTimeout(2_000);
  report.start = { panels: await panels(page), layout: await layout('start') };
  await shot(page, '1-following-es');

  await page.getByRole('region', { name: 'ES Z6 1m' }).getByRole('button', { name: 'Split chart' }).click();
  await page.waitForTimeout(3_000);
  report.split = { panels: await panels(page), layout: await layout('split') };
  const halves = page.getByRole('region', { name: 'ES Z6 1m' });
  await halves.last().getByRole('button', { name: 'Close ES Z6 1m' }).first().click();
  await page.waitForTimeout(3_000);
  report.closedSplit = { panels: await panels(page), layout: await layout('closed-split') };
  await shot(page, '1b-split-closed');

  await closeChart(page, 'ES Z6 1m');
  report.closedFollowed = { panels: await panels(page), layout: await layout('closed-followed') };
  await shot(page, '2-closed-followed');

  await closeChart(page, 'NQ Z6 5m');
  report.closedEvery = { panels: await panels(page), layout: await layout('closed-every') };
  await shot(page, '3-closed-every');

  await page.reload();
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4_000);
  report.reloadedEmpty = { panels: await panels(page) };
  await shot(page, '4-reloaded-no-chart');

  writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
