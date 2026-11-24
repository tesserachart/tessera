#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/draw-report', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-draw-report-'));
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

async function tool(name: string, input: unknown): Promise<{ ok: unknown } | { refused: string }> {
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
    client: { name: 'draw-report', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) return { refused: answer.error.message };
  const result = answer.result as { ok?: boolean; output?: unknown; error?: { message: string } };
  if (result.ok === false) return { refused: result.error?.message ?? 'refused' };
  return { ok: result.output ?? result };
}

interface Drawn {
  label: string;
  from: number;
  to: number;
  poc: number | null;
  volume: number;
}
interface Viewport {
  from: number;
  to: number;
  priceMin: number | null;
  priceMax: number | null;
  profiles?: Drawn[];
}

const BARS = [
  { label: 'time-5m', tf: '5m' },
  { label: 'tick-500', tf: '5m', printBars: { kind: 'tick', size: 500 } },
  { label: 'volume-1000', tf: '5m', printBars: { kind: 'volume', size: 1000 } },
  { label: 'daily-1D', tf: '1D' },
] as const;
const HOURS = ['all', 'rth'] as const;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { build: name };
const failures: string[] = [];
const tile = { layoutId: 'default', tileId: 'chart-1' };

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const added = (await tool('chart.add_layer', { ...tile, kind: 'volume_profile' })) as {
    ok?: { chart: { layers: { id: string; kind: string }[] } };
  };
  const layerId = added.ok?.chart.layers.find((l) => l.kind === 'volume_profile')?.id;
  if (!layerId) throw new Error(`no volume profile layer: ${JSON.stringify(added)}`);
  for (const bars of BARS) {
    report[`${bars.label}.tf`] = await tool('chart.set_timeframe', {
      ...tile,
      tf: bars.tf,
      ...('printBars' in bars ? { printBars: bars.printBars } : {}),
    });
    for (const hours of HOURS) {
      const label = `${bars.label}-${hours}`;
      await tool('chart.update_layer', { ...tile, layerId, params: { inputs: { hours } } });
      await page.waitForTimeout(25_000);
      await page.getByRole('main', { name: 'Workspace' }).screenshot({ path: join(dir, `${name}-${label}.png`) });
      const state = (await tool('chart.get_state', tile)) as { ok?: { chart: { viewport: Viewport | null } } };
      const vp = state.ok?.chart.viewport ?? null;
      const profiles = vp?.profiles ?? [];
      report[label] = { viewport: vp && { ...vp, profiles: undefined }, profiles };
      for (const p of profiles) {
        const inView = vp !== null && p.to > vp.from && p.from <= vp.to;
        if (!inView) failures.push(`${label}: ${p.label} is listed but its span is outside the view`);
        if (!(p.volume > 0)) failures.push(`${label}: ${p.label} is listed with no volume`);
      }
    }
  }
  const kinds = JSON.stringify(await tool('chart.list_layer_kinds', tile)).length;
  const kind = JSON.stringify(await tool('chart.list_layer_kinds', { ...tile, kind: 'volume_profile' })).length;
  const full = JSON.stringify(await tool('chart.list_layer_kinds', { ...tile, full: true })).length;
  const pulls = JSON.stringify(await tool('market.list_pulls', {})).length;
  report['sizes'] = { 'list_layer_kinds {}': kinds, 'list_layer_kinds {kind}': kind, 'list_layer_kinds {full}': full, 'list_pulls {}': pulls };
  if (kinds > 12_000) failures.push(`chart.list_layer_kinds {} is ${String(kinds)} characters`);
  report['failures'] = failures;
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stills and ${name}-report.json in ${dir}`);
  console.log(failures.length === 0 ? 'ok: every listed profile is in view with volume' : failures.join('\n'));
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
process.exitCode = failures.length === 0 ? 0 : 1;
