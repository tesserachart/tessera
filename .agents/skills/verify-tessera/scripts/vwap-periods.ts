#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/vwap-periods', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const newYork = (month: number, day: number, hour: number, minute = 0) =>
  Date.UTC(2026, month - 1, day, hour + 4, minute) * 1e6;
const VIEW = { from: newYork(9, 21, 18), to: newYork(10, 2, 15) };

const data = mkdtempSync(join(tmpdir(), 'tessera-vwap-periods-'));
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

async function tool(tool: string, input: unknown): Promise<{ ok: unknown } | { refused: string }> {
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
    client: { name: 'vwap-periods', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name: tool, input });
  ws.close();
  if (answer.error) return { refused: answer.error.message };
  const result = answer.result as { ok?: boolean; output?: unknown; error?: { message: string } };
  if (result.ok === false) return { refused: result.error?.message ?? 'refused' };
  return { ok: result.output ?? result };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { build: name };
const tile = { layoutId: 'default', tileId: 'chart-1' };
const still = (at: Locator, scene: string) => at.screenshot({ path: join(dir, `${name}-${scene}.png`) });

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  report['tf'] = await tool('chart.set_timeframe', { ...tile, tf: '30m' });
  await page.waitForTimeout(2_000);
  await tool('chart.set_viewport', { ...tile, ...VIEW });
  const chart = page.getByRole('region', { name: 'NQ Z6 30m' });
  await chart.waitFor();
  const added = await tool('chart.add_layer', {
    ...tile,
    kind: 'vwap',
    params: { inputs: { band1: true, band2: true } },
  });
  report['add_layer'] = added;
  const layers = 'ok' in added ? (added.ok as { chart: { layers: { id: string; kind: string }[] } }).chart.layers : [];
  const layerId = layers.find((l) => l.kind === 'vwap')?.id ?? 'vwap-1';
  for (const period of ['session', 'week', 'month']) {
    report[`${period}.update_layer`] = await tool('chart.update_layer', {
      ...tile,
      layerId,
      params: { inputs: { period } },
    });
    await page.waitForTimeout(period === 'session' ? 15_000 : 6_000);
    await still(chart, period);
    report[`${period}.compute`] = await tool('indicators.compute', {
      indicator: 'vwap',
      instrument: 'NQ',
      tf: '30m',
      inputs: { period, band1: true },
      limit: 3,
    });
  }
  report['layout'] = await tool('layout.get', { layoutId: 'default' });
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  report['settings buttons'] = await page
    .locator('button[aria-label*="settings" i], button[aria-label*="VWAP"]')
    .evaluateAll((all) => all.map((b) => b.getAttribute('aria-label')));
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  await page
    .locator('button[aria-label$=": settings"][aria-label^="VWAP"]')
    .first()
    .evaluate((b: HTMLElement) => b.click());
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await still(dialog, 'settings');
  const week = dialog.getByRole('radio', { name: 'Week' }).or(dialog.getByRole('button', { name: 'Week' }));
  if ((await week.count()) > 0) {
    await week.first().click();
    await page.waitForTimeout(1_500);
    await still(dialog, 'settings-week');
    report['after-form.layout'] = await tool('layout.get', { layoutId: 'default' });
  } else {
    report['form'] = 'no period choice in the form';
  }
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stills and ${name}-report.json in ${dir}`);
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
