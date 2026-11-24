#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/daily-orderflow', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const newYork = (month: number, day: number, hour: number, minute = 0) =>
  Date.UTC(2026, month - 1, day, hour + 4, minute) * 1e6;
const CLOSE_UP = { from: newYork(9, 21, 0), to: newYork(10, 2, 16) };

const data = mkdtempSync(join(tmpdir(), 'tessera-daily-orderflow-'));
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
    client: { name: 'daily-orderflow', version: '0', platform: 'node' },
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
const failures: string[] = [];
const tile = { layoutId: 'default', tileId: 'chart-1' };

const scene = async (chart: Locator, label: string, ms = 20_000) => {
  await page.waitForTimeout(ms);
  await chart.screenshot({ path: join(dir, `${name}-${label}.png`) });
  const legend = await page.locator('[data-layer]').allInnerTexts();
  const state = (await tool('chart.get_state', tile)) as {
    ok?: { chart: { viewport: { profiles?: unknown[] } | null } };
  };
  const profiles = state.ok?.chart.viewport?.profiles ?? [];
  report[label] = { legend, profiles };
  const worded = legend.filter((t) => /stopped|would hold|rows|cannot|no tick history/i.test(t));
  if (worded.length > 0) failures.push(`${label}: the legend has words: ${JSON.stringify(worded)}`);
  if (profiles.length === 0) failures.push(`${label}: the volume profile drew nothing`);
};

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  report['tf'] = await tool('chart.set_timeframe', { ...tile, tf: '1D' });
  const chart = page.getByRole('region', { name: 'NQ Z6 1D' });
  await chart.waitFor({ timeout: 30_000 });
  report['footprint.add_layer'] = await tool('chart.add_layer', { ...tile, kind: 'footprint' });
  report['volume_profile.add_layer'] = await tool('chart.add_layer', { ...tile, kind: 'volume_profile' });
  await scene(chart, 'daily', 90_000);
  await tool('chart.set_viewport', { ...tile, ...CLOSE_UP });
  await scene(chart, 'daily-close-up');
  const fp = await tool('market.get_footprint', { instrument: 'NQ', tf: '1D', rowTicks: 1, limit: 200 });
  report['market.get_footprint 1D x200 rowTicks 1'] =
    'ok' in fp
      ? (() => {
          const o = fp.ok as { row: number; bars: { cells: unknown[] }[] };
          return { row: o.row, bars: o.bars.length, cells: o.bars.reduce((n, b) => n + b.cells.length, 0) };
        })()
      : fp;
  if ('refused' in fp) failures.push(`market.get_footprint 1D refused: ${fp.refused}`);
  report['failures'] = failures;
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stills and ${name}-report.json in ${dir}`);
  console.log(failures.length === 0 ? 'ok: NQ 1D draws a footprint and a profile with no words' : failures.join('\n'));
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
process.exitCode = failures.length === 0 ? 0 : 1;
