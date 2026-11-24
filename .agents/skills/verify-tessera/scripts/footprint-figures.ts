#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/footprint-figures', uiDir, name = 'pr', ...counts] = process.argv.slice(2);
const barsAcross = counts.length > 0 ? counts.map(Number) : [8, 11, 13, 16, 24];
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-footprint-figures-'));
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
    client: { name: 'footprint-figures', version: '0', platform: 'node' },
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
const step = (label: string, answer: { ok: unknown } | { refused: string }) => {
  report[label] = answer;
  if ('refused' in answer) failures.push(`${label} refused: ${answer.refused}`);
};

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  step('chart.set_symbol', await tool('chart.set_symbol', { ...tile, instrument: 'ES' }));
  step('chart.set_timeframe', await tool('chart.set_timeframe', { ...tile, tf: '1m' }));
  step('chart.add_layer', await tool('chart.add_layer', { ...tile, kind: 'footprint' }));
  const chart = page.getByRole('region', { name: /^ES \S+ 1m$/ }).first();
  await chart.waitFor({ timeout: 30_000 });
  await chart.getByRole('button', { name: 'Maximise' }).click();
  await page.waitForTimeout(20_000);
  for (const lastBars of barsAcross) {
    step(`chart.set_viewport ${String(lastBars)}`, await tool('chart.set_viewport', { ...tile, lastBars }));
    await page.waitForTimeout(4_000);
    await chart.screenshot({ path: join(dir, `${name}-${String(lastBars)}-bars.png`) });
  }
  report['failures'] = failures;
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stills and ${name}-report.json in ${dir}`);
  console.log(failures.length === 0 ? `ok: ES 1m shot at ${barsAcross.join(', ')} bars` : failures.join('\n'));
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
process.exitCode = failures.length === 0 ? 0 : 1;
