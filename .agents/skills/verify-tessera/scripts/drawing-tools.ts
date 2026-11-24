#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/drawing-tools', uiDir, label = 'pr', binArg] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-drawing-tools-'));
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
    client: { name: 'drawing-tools', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  const result = answer.result as { ok: boolean; output: unknown; error: { message: string } | null };
  if (!result.ok) throw new Error(`${name}: ${result.error?.message ?? 'refused'}`);
  return result.output;
}

interface StoredDrawing {
  id: string;
  kind: string;
  instrument: string;
  namespace: string;
  points: { t: string | null; price: number | null }[];
  style: { color: string; extend: string };
  levels?: number[];
}

async function drawings(step: string): Promise<StoredDrawing[]> {
  await new Promise((r) => setTimeout(r, 1_500));
  const got = (await tool('layout.get', { layoutId: 'default' })) as {
    charts: Record<string, { drawings?: StoredDrawing[] }>;
  };
  writeFileSync(join(dir, `${label}-${step}-layout.get.json`), JSON.stringify(got, null, 2));
  return Object.values(got.charts).flatMap((c) => c.drawings ?? []);
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${label}-${name}.png`) });
const rail = (page: Page) => page.getByRole('toolbar', { name: 'Drawing tools' });

async function plot(page: Page) {
  const box = await page.getByRole('region', { name: 'NQ Z6 5m' }).boundingBox();
  if (!box) throw new Error('NQ Z6 5m is not on screen');
  return box;
}

async function openGroup(page: Page, button: string, group: string) {
  await rail(page).getByRole('button', { name: button, exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: group });
  await menu.waitFor();
  return menu;
}

async function pick(page: Page, button: string, group: string, kind: string) {
  const menu = await openGroup(page, button, group);
  await menu.getByRole('menuitem', { name: kind }).click();
}

async function clicks(page: Page, at: readonly (readonly [number, number])[]) {
  const box = await plot(page);
  for (const [fx, fy] of at) {
    const x = box.x + box.width * fx;
    const y = box.y + box.height * fy;
    await page.mouse.move(x, y, { steps: 6 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(800);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { label };
try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3_000);

  for (const [button, group, name] of [
    ['Trend line', 'Lines', 'lines'],
    ['Horizontal line', 'Horizontal and vertical', 'levels'],
    ['Fib retracement', 'Fibonacci', 'fib'],
  ] as const) {
    const single = (await rail(page).getByRole('button', { name: button, exact: true }).getAttribute('aria-haspopup')) === null;
    if (single) {
      report[`${name}Menu`] = [button];
      continue;
    }
    const menu = await openGroup(page, button, group);
    report[`${name}Menu`] = await menu.getByRole('menuitem').allInnerTexts();
    await shot(page, `0-menu-${name}`);
    await page.keyboard.press('Escape');
  }
  if (label === 'main') {
    writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  await pick(page, 'Horizontal line', 'Horizontal and vertical', 'Cross line');
  await clicks(page, [[0.62, 0.3]]);
  await shot(page, '1-cross-line');

  await pick(page, 'Trend line', 'Lines', 'Trend angle');
  await clicks(page, [
    [0.3, 0.75],
    [0.48, 0.45],
  ]);
  await shot(page, '2-trend-angle');

  await pick(page, 'Fib retracement', 'Fibonacci', 'Fib extension');
  await clicks(page, [
    [0.5, 0.8],
    [0.6, 0.5],
    [0.66, 0.65],
  ]);
  await shot(page, '3-fib-extension');
  const bar = page.getByRole('toolbar', { name: 'Fib extension style' });
  await bar.getByRole('button', { name: /^Levels:/ }).click();
  const levels = page.getByRole('dialog', { name: 'Fib extension levels' });
  await levels.waitFor();
  report.extensionLevelChoices = await levels.getByRole('checkbox').evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') ?? e.textContent),
  );
  await shot(page, '4-extension-levels');
  await levels.getByRole('checkbox', { name: '1.272' }).click();
  await bar.getByRole('button', { name: /^Levels:/ }).click();
  report.afterLevel = (await drawings('extension-level')).find((d) => d.kind === 'fib_extension')?.levels;

  await bar.getByRole('button', { name: 'Fib extension templates' }).click();
  await page.getByRole('menuitem', { name: 'Save as template…' }).click();
  await page.getByRole('textbox', { name: 'Template name' }).fill('Targets');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_000);
  report.templates = await tool('chart.list_drawing_templates', { kind: 'fib_extension' });
  await page.keyboard.press('Escape');

  await pick(page, 'Fib extension', 'Fibonacci', 'Fib fan');
  await clicks(page, [
    [0.72, 0.85],
    [0.82, 0.4],
  ]);
  await shot(page, '5-fib-fan');
  const fanBar = page.getByRole('toolbar', { name: 'Fib fan style' });
  await fanBar.getByRole('button', { name: /^Extension:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Stops at its anchors' }).click();
  await page.waitForTimeout(500);
  await shot(page, '6-fib-fan-stopped');
  await page.keyboard.press('Escape');

  const drawn = await drawings('user-drawn');
  report.userDrawn = drawn.map((d) => ({ kind: d.kind, anchors: d.points.length, extend: d.style.extend, levels: d.levels }));

  const es = ((await tool('chart.get_state', { layoutId: 'default', tileId: 'chart-2' })) as { chart: { instrument: string } }).chart;
  const candles = (await tool('market.get_candles', { instrument: es.instrument, tf: '1m', limit: 60 })) as {
    columns: string[];
    bars: number[][];
  };
  const col = (name: string) => candles.columns.indexOf(name);
  const bars = candles.bars.map((b) => ({ t: b[col('t')]!, h: b[col('h')]!, l: b[col('l')]! }));
  const ns = (v: number) => (v > 1e15 ? v : v > 1e12 ? v * 1e6 : v * 1e9);
  const t = (i: number) => ns(bars[Math.max(0, bars.length - 1 - i)]!.t);
  const hi = Math.max(...bars.map((b) => b.h));
  const lo = Math.min(...bars.map((b) => b.l));
  const at = (share: number) => Math.round((lo + (hi - lo) * share) * 4) / 4;
  const add = (input: object) => tool('chart.add_drawing', { layoutId: 'default', tileId: 'chart-2', ...input });
  await add({ kind: 'cross_line', points: [{ t: t(8), price: at(0.5) }], style: { color: 'brass' } });
  await add({ kind: 'trend_angle', points: [{ t: t(50), price: at(0.1) }, { t: t(30), price: at(0.6) }] });
  const ext = (await add({
    kind: 'fib_extension',
    points: [
      { t: t(45), price: at(0.15) },
      { t: t(30), price: at(0.55) },
      { t: t(20), price: at(0.35) },
    ],
  })) as { drawing: StoredDrawing };
  await tool('chart.apply_drawing_template', {
    layoutId: 'default',
    tileId: 'chart-2',
    drawingId: ext.drawing.id,
    template: 'Targets',
  });
  await add({ kind: 'fib_fan', points: [{ t: t(58), price: at(0.05) }, { t: t(40), price: at(0.7) }] });
  const all = await drawings('agent-drawn');
  report.toolDrawn = all
    .filter((d) => d.instrument === es.instrument)
    .map((d) => ({ kind: d.kind, color: d.style.color, levels: d.levels }));
  const state = (await tool('chart.get_state', { layoutId: 'default', tileId: 'chart-2' })) as {
    chart: { drawings?: StoredDrawing[] };
  };
  report.esChartLists = (state.chart.drawings ?? []).map((d) => d.kind);
  await page.waitForTimeout(1_500);
  await shot(page, '7-agent-drawn-on-es');

  writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  for (const [i, p] of context.pages().entries()) await shot(p, `failed-${String(i)}`).catch(() => undefined);
  throw err;
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
