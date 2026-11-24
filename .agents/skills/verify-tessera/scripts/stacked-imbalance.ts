#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/stacked-imbalance', uiDir, tag = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-stacked-imbalance-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TESSERA_NO_RITHMIC: '1', TESSERA_TEST_MARKET: 'busy' },
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
    client: { name: 'stacked-imbalance', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

const save = async (name: string, input: unknown) =>
  writeFileSync(join(dir, `${tag}-${name}.json`), JSON.stringify(await tool(name, input), null, 2));

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
  const inChart = chart.getByRole('button', { name: 'Maximise', exact: true });
  const maximise = (await inChart.count()) > 0 ? inChart : page.getByRole('button', { name: 'Maximise', exact: true }).first();
  await maximise.click();
  await page.waitForTimeout(1_000);

  const box = (await chart.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Alt+i');
  const picker = page.getByRole('dialog', { name: 'Add indicator' });
  await picker.waitFor();
  await page.keyboard.type('imbalance');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, `${tag}-picker.png`) });
  if (tag === 'main') {
    console.log(JSON.stringify({ stills: dir }));
    process.exit(0);
  }
  await page.keyboard.press('Enter');
  await picker.waitFor({ state: 'detached' });

  const row = page.locator('.ind-lg-row', { hasText: 'Stacks' });
  await row.waitFor({ timeout: 30_000 });
  const settings = page.getByRole('button', { name: /^Stacks .*: settings$/ });
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: join(dir, `${tag}-zones.png`) });
  await save('layout.get', { layoutId: 'default' });

  await row.hover();
  await settings.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, `${tag}-settings.png`) });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await row.hover();
  await page.getByRole('button', { name: /^Alert on Stacks/ }).click();
  const form = page.getByRole('form', { name: 'New alert' });
  await form.waitFor();
  await form.getByRole('button', { name: 'Every time' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${tag}-alert-form.png`) });
  await form.getByRole('button', { name: 'Create' }).click();
  await form.waitFor({ state: 'detached' });

  let fires: unknown[] = [];
  for (let waited = 0; fires.length === 0; waited++) {
    if (waited > 150) throw new Error('no stacked imbalance alert fired in five minutes');
    await page.waitForTimeout(2_000);
    fires = ((await tool('alerts.history', {})) as { output?: { fires?: unknown[] } }).output?.fires ?? [];
  }
  await page.screenshot({ path: join(dir, `${tag}-fired.png`) });
  await save('alerts.list', {});
  await save('alerts.history', {});
  console.log(JSON.stringify({ fires: fires.length, first: fires[0], stills: dir }));
} catch (e) {
  await page.screenshot({ path: join(dir, `${tag}-failed.png`) });
  throw e;
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
