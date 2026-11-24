#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/footprint-modes', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-footprint-modes-'));
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

type Answer = { ok: unknown } | { refused: string };

async function tool(tool: string, input: unknown): Promise<Answer> {
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
    client: { name: 'footprint-modes', version: '0', platform: 'node' },
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

interface FootprintAnswer {
  bars: { t: number; cells: [number, number, number, number?][] }[];
}

const SCENES: { label: string; inputs: Record<string, unknown> }[] = [
  { label: 'bid-ask', inputs: { mode: 'bid_ask', dimBelow: 0, maxLevel: 'off' } },
  { label: 'trades', inputs: { mode: 'trades', dimBelow: 0, maxLevel: 'off' } },
  { label: 'histogram', inputs: { mode: 'histogram', dimBelow: 0, maxLevel: 'off' } },
  { label: 'dim-40', inputs: { mode: 'bid_ask', dimBelow: 40, maxLevel: 'off' } },
  { label: 'max-volume', inputs: { mode: 'bid_ask', dimBelow: 0, maxLevel: 'volume' } },
  { label: 'trades-max-trades', inputs: { mode: 'trades', dimBelow: 0, maxLevel: 'trades' } },
];
const ALL_ON = { mode: 'histogram', dimBelow: 30, maxLevel: 'volume' };
const INTERVALS = [
  { tf: '1m', lastBars: 10 },
  { tf: '5m', lastBars: 10 },
  { tf: '1h', lastBars: 10 },
  { tf: '1D', lastBars: 8 },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { build: name };
const failures: string[] = [];
const tile = { layoutId: 'default', tileId: 'chart-1' };
const step = (label: string, answer: Answer) => {
  report[label] = answer;
  if ('refused' in answer) failures.push(`${label} refused: ${answer.refused}`);
  return answer;
};

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  step('chart.set_symbol', await tool('chart.set_symbol', { ...tile, instrument: 'ES' }));
  step('chart.set_timeframe', await tool('chart.set_timeframe', { ...tile, tf: '1m' }));
  const added = step('chart.add_layer', await tool('chart.add_layer', { ...tile, kind: 'footprint' }));
  const layers = 'ok' in added ? (added.ok as { chart: { layers: { id: string; kind: string }[] } }).chart.layers : [];
  const layerId = layers.find((l) => l.kind === 'footprint')?.id ?? 'footprint-1';
  const chart = page.getByRole('region', { name: /^ES \S+ 1m$/ }).first();
  await chart.waitFor({ timeout: 30_000 });
  await chart.getByRole('button', { name: 'Maximise' }).click();
  await page.waitForTimeout(20_000);
  step('chart.set_viewport 1m', await tool('chart.set_viewport', { ...tile, lastBars: 12 }));
  for (const scene of SCENES) {
    step(
      `chart.update_layer ${scene.label}`,
      await tool('chart.update_layer', { ...tile, layerId, params: { inputs: scene.inputs } }),
    );
    await page.waitForTimeout(3_000);
    await chart.screenshot({ path: join(dir, `${name}-${scene.label}.png`) });
  }

  await page.locator('[data-layer]').first().hover();
  await page.getByRole('button', { name: /^Footprint.*: settings$/ }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, `${name}-settings.png`) });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const read = step(
    'market.get_footprint ES 1m',
    await tool('market.get_footprint', { instrument: 'ES', tf: '1m', rowTicks: 1, limit: 5 }),
  );
  if ('ok' in read) {
    const bars = (read.ok as FootprintAnswer).bars;
    const counted = bars.every((b) => b.cells.every((c) => c[1] + c[2] === 0 || (c[3] ?? 0) >= 1));
    report['every traded row counts a print'] = counted;
    if (!counted || bars.length === 0) failures.push('a footprint row with volume has no trade count');
  }

  step('chart.update_layer all on', await tool('chart.update_layer', { ...tile, layerId, params: { inputs: ALL_ON } }));
  for (const { tf, lastBars } of INTERVALS) {
    step(`chart.set_timeframe ${tf}`, await tool('chart.set_timeframe', { ...tile, tf }));
    const region = page.getByRole('region', { name: new RegExp(`^ES \\S+ ${tf}$`) }).first();
    await region.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(12_000);
    step(`chart.set_viewport ${tf}`, await tool('chart.set_viewport', { ...tile, lastBars }));
    await page.waitForTimeout(4_000);
    await region.screenshot({ path: join(dir, `${name}-all-on-${tf}.png`) });
    const legend = await page.locator('[data-layer]').allInnerTexts();
    report[`legend ${tf}`] = legend;
    const worded = legend.filter((t) => /stopped|would hold|rows|cannot|no tick history/i.test(t));
    if (worded.length > 0) failures.push(`${tf}: the legend has words: ${JSON.stringify(worded)}`);
  }
  report['failures'] = failures;
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stills and ${name}-report.json in ${dir}`);
  console.log(
    failures.length === 0
      ? `ok: ES 1m shot in ${SCENES.length} scenes and all on at ${INTERVALS.map((i) => i.tf).join(', ')}`
      : failures.join('\n'),
  );
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
process.exitCode = failures.length === 0 ? 0 : 1;
