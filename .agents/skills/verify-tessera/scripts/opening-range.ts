#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/opening-range', uiDir, tag = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const NS = 1e6;
const at = (iso: string) => Date.parse(iso) * NS;
const SESSION = { from: at('2026-10-02T12:00:00Z'), to: at('2026-10-02T18:50:00Z') };
const WEEKS = { from: at('2026-09-14T00:00:00Z'), to: at('2026-10-03T00:00:00Z') };
const LEVELS = ['orHigh', 'orLow', 'ibHigh', 'ibLow', 'up100', 'down100'] as const;
const INTERVALS: { name: string; tf: string; printBars?: { kind: string; size: number }; view: typeof SESSION }[] = [
  { name: '1m', tf: '1m', view: SESSION },
  { name: '5m', tf: '5m', view: SESSION },
  { name: '1h', tf: '1h', view: SESSION },
  { name: '1D', tf: '1D', view: WEEKS },
  { name: '500T', tf: '1m', printBars: { kind: 'tick', size: 500 }, view: SESSION },
];

const data = mkdtempSync(join(tmpdir(), 'tessera-opening-range-'));
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
  { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
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
    client: { name: 'opening-range', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result as { output?: unknown; error?: unknown };
}

const save = (name: string, value: unknown) =>
  writeFileSync(join(dir, `${tag}-${name}.json`), JSON.stringify(value, null, 2));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const tile = { layoutId: 'default', tileId: 'chart-1' };

async function settled(chart: Locator): Promise<void> {
  await chart.waitFor({ timeout: 30_000 });
  await chart
    .getByRole('status', { name: 'Loading bars' })
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(3_000);
}

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await tool('chart.set_timeframe', { ...tile, tf: '5m' });
  const first = page.getByRole('region', { name: 'NQ Z6 5m' });
  await settled(first);

  await page.locator('.chart-tools').first().getByRole('button', { name: 'Indicators', exact: true }).click();
  const library = page.getByRole('complementary', { name: 'Indicators' });
  await library.getByRole('searchbox').or(library.getByRole('textbox')).first().fill('open');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, `${tag}-library-search.png`) });
  const row = library.getByRole('button', { name: /^Opening range/ });
  if ((await row.count()) === 0) {
    console.log(JSON.stringify({ tag, library: 'no Opening range row', stills: dir }));
    process.exit(0);
  }
  await row.click();
  await page.getByRole('button', { name: 'Add to chart' }).click();
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: join(dir, `${tag}-library-added.png`) });
  await page.keyboard.press('Escape');

  const layout = (await tool('layout.get', { layoutId: 'default' })) as {
    output?: { charts?: Record<string, { layers?: { kind: string; params: unknown }[] }> };
  };
  const layers = layout.output?.charts?.['chart-1']?.layers ?? [];
  save('layout.get', layers);
  if (!layers.some((l) => l.kind === 'opening_range')) throw new Error('the study was not added to chart-1');

  const report: Record<string, unknown> = {};
  for (const iv of INTERVALS) {
    await tool('chart.set_timeframe', { ...tile, tf: iv.tf, ...(iv.printBars ? { printBars: iv.printBars } : {}) });
    const chart = page.getByRole('region', { name: `NQ Z6 ${iv.name}` });
    await settled(chart);
    await tool('chart.set_viewport', { ...tile, from: iv.view.from, to: iv.view.to });
    await page.waitForTimeout(2_500);
    const legend = await page.locator('.ind-legend').first().innerText();
    let last: Record<string, number> | null = null;
    if (!iv.printBars) {
      const series = (await tool('indicators.compute', {
        indicator: 'opening_range',
        instrument: 'NQZ6.CME',
        tf: iv.tf,
        limit: 5,
      })) as { output?: { plots?: { key: string; values: (number | null)[] }[] } };
      last = Object.fromEntries(
        LEVELS.map((k) => {
          const v = series.output?.plots?.find((p) => p.key === k)?.values.at(-1);
          return [k, v ?? Number.NaN];
        }),
      );
    }
    report[iv.name] = { legend: legend.replace(/\s+/g, ' ').trim(), last };
    await chart.screenshot({ path: join(dir, `${tag}-chart-${iv.name}.png`) });
  }
  save('levels', report);

  await page.getByRole('button', { name: 'OR 15: menu' }).first().click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await page.getByRole('dialog').first().waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, `${tag}-settings.png`) });
  console.log(JSON.stringify({ tag, report, stills: dir }, null, 2));
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
