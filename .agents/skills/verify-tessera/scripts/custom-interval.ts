#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/custom-interval', label = 'pr', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SETTLE_MS = 2_500;
const TYPED = ['15s', '2D', '377T'] as const;

const data = mkdtempSync(join(tmpdir(), 'tessera-custom-interval-'));
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

async function tool(name: string, input: unknown): Promise<{ output?: unknown; error?: unknown }> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`);
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown };
    if (m.id !== undefined) waiting.get(m.id)?.(m);
  };
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: unknown }>((done) => {
      waiting.set(++id, done);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  await call('session.hello', {
    client: { name: 'custom-interval', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) return { error: answer.error };
  return answer.result as { output?: unknown; error?: unknown };
}

function save(name: string, value: unknown): void {
  writeFileSync(join(dir, `${label}-${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function brief(r: { output?: unknown; error?: unknown }): string {
  if (r.error) return `refused: ${JSON.stringify(r.error)}`;
  const o = r.output as { tf?: string; bars?: unknown[]; chart?: { timeframe?: string } } | undefined;
  if (o?.bars) return `${String(o.bars.length)} ${o.tf ?? ''} bars`;
  if (o?.chart) return `chart on ${o.chart.timeframe ?? '?'}`;
  return 'ok';
}

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=2'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page: Page = await context.newPage();

function nqChart(): Locator {
  return page.getByRole('region', { name: /^NQ Z6 / });
}

async function insideChart(candidates: Locator): Promise<Locator> {
  const box = await nqChart().boundingBox();
  for (const c of await candidates.all()) {
    const at = await c.boundingBox();
    if (box && at && at.x >= box.x && at.x < box.x + box.width && at.y >= box.y - 60) return c;
  }
  return candidates.first();
}

async function openMenu(): Promise<void> {
  await (await insideChart(page.getByRole('button', { name: 'All intervals' }))).click();
  await page.getByRole('menu').first().waitFor();
}

async function shownOn(interval: string): Promise<void> {
  await page.getByRole('region', { name: `NQ Z6 ${interval}` }).waitFor({ timeout: 20_000 });
  await page
    .getByRole('status', { name: 'Loading bars' })
    .first()
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

try {
  const report: Record<string, string> = {};
  for (const [name, input] of [
    ['candles-15s', { instrument: 'NQ', tf: '15s', limit: 200 }],
    ['candles-2D', { instrument: 'NQ', tf: '2D', limit: 30 }],
    ['candles-7m', { instrument: 'NQ', tf: '7m', limit: 100 }],
  ] as const) {
    const r = await tool('market.get_candles', input);
    save(name, r);
    report[`market.get_candles ${input.tf}`] = brief(r);
  }
  await tool('chart.set_timeframe', { layoutId: 'default', tileId: 'chart-1', tf: '1m' });
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await shownOn('1m');
  await openMenu();
  await page.screenshot({ path: join(dir, `${label}-menu.png`) });
  const field = page.getByRole('textbox', { name: 'Interval' });
  if (await field.count()) {
    for (const typed of TYPED) {
      if (!(await field.isVisible())) await openMenu();
      await field.fill(typed);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(dir, `${label}-typed-${typed}.png`) });
      await field.press('Enter');
      await shownOn(typed);
      await page.screenshot({ path: join(dir, `${label}-chart-${typed}.png`) });
      report[`typed ${typed}`] = `chart shows ${(await nqChart().getAttribute('aria-label')) ?? '?'}`;
    }
    await openMenu();
    await field.fill('soon');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(dir, `${label}-typed-wrong.png`) });
    report['typed soon'] =
      (await page.getByRole('group', { name: 'Any interval' }).getByRole('alert').textContent()) ?? '';
    await page.keyboard.press('Escape');
  } else {
    report['typed'] = 'the interval menu has no field to type in';
  }
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  await openMenu();
  if (await saveButton.count()) {
    for (const typed of ['15s', '377T']) {
      if (!(await field.isVisible())) await openMenu();
      await field.fill(typed);
      await saveButton.click();
      await shownOn(typed);
    }
    await (await insideChart(page.getByRole('button', { name: '5m', exact: true }))).click();
    await shownOn('5m');
    const before = await insideChart(page.getByRole('group', { name: 'Timeframe' }));
    report['saved 15s and 377T, back on 5m'] = `tab row: ${(await before.getByRole('button').allTextContents()).join(' ')}`;
    await page.waitForTimeout(1_500);
    save('preferences-before-reload', await tool('settings.get', { keys: ['ui.preferences'] }));
    await page.reload();
    await shownOn('5m');
    const tabs = await insideChart(page.getByRole('group', { name: 'Timeframe' }));
    const row = (await tabs.getByRole('button').allTextContents()).join(' ');
    await page.screenshot({ path: join(dir, `${label}-saved-tab-row.png`) });
    report['saved 15s and 377T, back on 5m after a reload'] = `tab row: ${row}`;
  } else {
    await page.keyboard.press('Escape');
    report['saved'] = 'the interval menu has no Save';
  }
  const agent = await tool('chart.set_timeframe', { layoutId: 'default', tileId: 'chart-1', tf: '90m' });
  report['agent chart.set_timeframe 90m'] = brief(agent);
  if (!agent.error) {
    await shownOn('90m');
    await page.screenshot({ path: join(dir, `${label}-agent-90m.png`) });
  }
  save('agent-90m', agent);
  save('chart-state', await tool('chart.get_state', { layoutId: 'default', tileId: 'chart-1' }));
  save('report', report);
  for (const [k, v] of Object.entries(report)) console.log(`${label} ${k}: ${v}`);
} finally {
  await context.close();
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
  console.log(`stills and answers in ${dir}`);
}
