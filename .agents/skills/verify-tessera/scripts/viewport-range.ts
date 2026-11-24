#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/viewport-range', label = 'pr', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SETTLE_MS = 3_000;
const REPORTED_MS = 2_500;
const NQ = { layoutId: 'default', tileId: 'chart-1' };
const ES = { layoutId: 'default', tileId: 'chart-2' };

const data = mkdtempSync(join(tmpdir(), 'tessera-viewport-range-'));
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

type Answer = { output?: unknown; error?: unknown };

async function tool(name: string, input: unknown): Promise<Answer> {
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
    client: { name: 'viewport-range', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) return { error: answer.error };
  return answer.result as Answer;
}

function save(name: string, value: unknown): void {
  writeFileSync(join(dir, `${label}-${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

type Shown = { from: number; to: number; bars: number | null; short?: string; follows?: boolean };
type ChartOut = { chart?: { chartType?: string; viewport?: Shown | null } };

const day = (ns: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ns / 1e6);

function words(v: Shown | null | undefined): string {
  if (!v) return 'no answer';
  const span = `${String(v.bars)} bars, ${day(v.from)} – ${day(v.to)}`;
  return v.short ? `${span} · ${v.short}` : span;
}

async function viewOf(chart: typeof NQ): Promise<Shown | null> {
  const r = await tool('chart.get_state', chart);
  return (r.output as ChartOut | undefined)?.chart?.viewport ?? null;
}

async function ask(name: string, chart: typeof NQ, input: object): Promise<string> {
  const r = await tool('chart.set_viewport', { ...chart, ...input });
  save(`ask-${name}`, r);
  const shown = (r.output as { shown?: Shown } | undefined)?.shown;
  await new Promise((done) => setTimeout(done, REPORTED_MS));
  const read = await viewOf(chart);
  return `answer: ${words(shown)} | chart.get_state: ${words(read)}`;
}

async function settle(page: Page): Promise<void> {
  await page
    .getByRole('status', { name: 'Loading bars' })
    .first()
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

async function keepChanges(page: Page): Promise<void> {
  const cancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel' });
  if ((await cancel.count()) > 0) await cancel.first().click();
}

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=2'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, string> = {};
const shot = (name: string) => page.screenshot({ path: join(dir, `${label}-${name}.png`) });

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await tool('chart.set_timeframe', { ...NQ, tf: '1h' });
  await page.getByRole('region', { name: 'NQ Z6 1h' }).waitFor({ timeout: 30_000 }).catch(() => shot('stuck'));
  await settle(page);

  report['1 NQ 1h lastBars 700'] = await ask('nq-1h-700', NQ, { lastBars: 700 });
  await shot('1-nq-1h-700');

  await tool('workspace.open_tile', { kind: 'chart', instrument: 'MNQ', placement: 'tab', beside: 'chart-1' });
  await settle(page);
  await shot('2a-other-tab');
  await tool('workspace.focus_tile', { tileId: 'chart-1' });
  await settle(page);
  await page.waitForTimeout(REPORTED_MS);
  report['2 NQ 1h after a tab switch'] = `chart.get_state: ${words(await viewOf(NQ))}`;
  await shot('2b-tab-reshown');

  const made = await tool('workspace.create', { name: 'Other' });
  const otherId = (made.output as { layoutId?: string; id?: string } | undefined)?.layoutId;
  if (otherId) {
    await tool('ui.show_workspace', { layoutId: otherId });
    await settle(page);
    await tool('ui.show_workspace', { layoutId: 'default' });
    await settle(page);
    await keepChanges(page);
    await page.waitForTimeout(REPORTED_MS);
    report['3 NQ 1h after a workspace switch'] = `chart.get_state: ${words(await viewOf(NQ))}`;
    await shot('3-workspace-reshown');
  }

  save('set-volume-bars', await tool('chart.set_timeframe', { ...NQ, tf: '1h', printBars: { kind: 'volume', size: 1000 } }));
  await page.getByRole('region', { name: /^NQ Z6 1000V/ }).waitFor({ timeout: 30_000 }).catch(() => shot('stuck'));
  await settle(page);
  report['4 NQ 1000V lastBars 900'] = await ask('nq-1000v-900', NQ, { lastBars: 900 });
  await shot('4-nq-1000v-900');

  await tool('chart.set_timeframe', { ...NQ, tf: '5m' });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 30_000 }).catch(() => shot('stuck'));
  await settle(page);
  const held = (await tool('market.get_candles', { instrument: 'NQ', tf: '5m', limit: 50_000 })).output as
    | { bars?: unknown[] }
    | undefined;
  report['5 NQ 5m fitAll'] = `${await ask('nq-5m-fit-all', NQ, { fitAll: true })} | market.get_candles holds ${String(
    held?.bars?.length,
  )}`;
  await shot('5-nq-5m-fit-all');

  await tool('chart.set_timeframe', { ...ES, tf: '1D' });
  await page.getByRole('region', { name: 'ES Z6 1D' }).waitFor({ timeout: 30_000 }).catch(() => shot('stuck'));
  await settle(page);
  report['6 ES 1D from Sep 22'] = await ask('es-1d-from-sep-22', ES, { from: '2026-09-22T00:00:00-04:00' });
  await shot('6-es-1d-from-sep-22');
  report['7 ES 1D from Oct 22 (after the sim’s clock)'] = await ask('es-1d-from-oct-22', ES, {
    from: '2026-10-22T00:00:00-04:00',
    to: '2026-10-30T00:00:00-04:00',
  });
  await shot('7-es-1d-from-oct-22');

  await tool('chart.set_viewport', { ...NQ, lastBars: 150 });
  await keepChanges(page);
  const typeButton = page.getByRole('button', { name: /^Chart type: / }).filter({ visible: true }).first();
  await typeButton.click();
  const none = page.getByRole('menuitemradio', { name: 'No price' });
  if ((await none.count()) > 0) {
    await page.waitForTimeout(400);
    await shot('8a-chart-type-menu');
    await none.click();
  } else {
    report['8 hide price'] = 'no No price item in this build';
    await page.keyboard.press('Escape');
  }
  await settle(page);
  const nq = (await tool('chart.get_state', NQ)).output as ChartOut | undefined;
  const es = (await tool('chart.get_state', ES)).output as ChartOut | undefined;
  report['8 hide price'] ??= `NQ chartType ${String(nq?.chart?.chartType)}, ES chartType ${String(es?.chart?.chartType)}`;
  await shot('8b-nq-price-hidden');

  save('layout', await tool('layout.get', { layoutId: 'default' }));
} finally {
  save('report', report);
  for (const [k, v] of Object.entries(report)) console.log(`${label} ${k}: ${v}`);
  await context.close();
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
  console.log(`stills and answers in ${dir}`);
}
