#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/vp-first', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME, release: true }).path;

const LIVE_FEED = { TESSERA_TEST_HISTORY_MS: '1200', TESSERA_TEST_PRINTS_PER_SECOND: '9000' };
const LOGIN = { system: 'Tessera Test', gateway: 'Chicago Area', user: 'trader', password: 'demo' };
const TILE = { layoutId: 'default', tileId: 'chart-1' };
const SETTLE_LIMIT_MS = 300_000;

interface Profile {
  id: string;
  label: string;
  from: number;
  volume: number;
  delta: number;
  poc: number | null;
  partial: boolean;
}

interface Layer {
  id: string;
  kind: string;
  inputs?: Record<string, unknown>;
}

const data = mkdtempSync(join(tmpdir(), 'tessera-vp-first-'));
const runtime: ChildProcess = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TESSERA_TEST_MARKET: 'rithmic', ...LIVE_FEED } },
);
const ready = await new Promise<{ port: number; token: string; ticket: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; token?: string; ticket?: string } = {};
  createInterface({ input: runtime.stdout! }).on('line', (line) => {
    try {
      Object.assign(seen, JSON.parse(line) as object);
    } catch {
      return;
    }
    if (seen.port && seen.token && seen.ticket) done({ port: seen.port, token: seen.token, ticket: seen.ticket });
  });
});
const origin = `http://127.0.0.1:${String(ready.port)}`;

async function tool<T>(name: string, input: unknown): Promise<T> {
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
  try {
    await call('session.hello', {
      client: { name: 'vp-first', version: '0', platform: 'node' },
      protocolVersion: 1,
      token: ready.token,
    });
    const answer = await call('tools.invoke', { name, input });
    if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
    const result = answer.result as { ok: boolean; output: T; error: { message: string } | null };
    if (!result.ok) throw new Error(`${name}: ${result.error?.message ?? 'refused'}`);
    return result.output;
  } finally {
    ws.close();
  }
}

const report: Record<string, unknown> = { build: name };
const failures: string[] = [];
const browser = await chromium.launch();
try {
  await tool('connections.add_rithmic', LOGIN);
  await tool('chart.set_symbol', { ...TILE, instrument: 'NQ' });
  await tool('chart.set_timeframe', { ...TILE, tf: '1m' });
  await tool('chart.apply_template', { ...TILE, template: 'Order flow' });
  await tool('workspace.save', { layoutId: TILE.layoutId });
  const layout = await tool<{ charts: Record<string, { layers: Layer[] }> }>('layout.get', { layoutId: TILE.layoutId });
  const vpLayer = layout.charts[TILE.tileId]?.layers.find((l) => l.kind === 'volume_profile');
  report.vpLayer = vpLayer;
  const estimate = await tool<{ request: { to: string } }>('market.estimate_pull', { instrument: 'NQ' });
  const to = new Date(`${estimate.request.to}T12:00:00Z`);
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 11);
  report.fill = await tool('market.pull_trades', {
    instrument: 'NQ',
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    scope: 'session',
  });

  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const opened = Date.now();
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  const profiles = async (): Promise<Profile[]> => {
    const s = await tool<{ chart: { viewport?: { profiles?: Profile[] } | null } }>('chart.get_state', TILE);
    return (s.chart.viewport?.profiles ?? []).filter((p) => p.id === vpLayer?.id);
  };
  const vpLegend = async () =>
    (await page.locator('[data-layer]').allInnerTexts()).filter((t) => /^VP\b/.test(t.trim())).join(' | ');
  const newest = (ps: Profile[]) => ps.reduce<Profile | null>((a, p) => (a === null || p.from > a.from ? p : a), null);

  let first: Profile | null = null;
  while (Date.now() - opened < SETTLE_LIMIT_MS && first === null) {
    first = newest(await profiles());
    if (first === null) await page.waitForTimeout(250);
  }
  report.firstDrawnS = (Date.now() - opened) / 1000;
  report.first = first;
  report.firstLegend = await vpLegend();
  await page.screenshot({ path: join(dir, `${name}-first.png`) });
  if (first === null) failures.push('no VP profile was drawn');
  else if (!first.partial) failures.push('the first profile drawn was already whole: nothing to show partial');
  else if (!/Loading/.test(String(report.firstLegend)))
    failures.push(`a partial profile's legend does not say it is loading: ${String(report.firstLegend)}`);

  let settled: Profile | null = null;
  const seen: { atS: number; volume: number; partial: boolean }[] = [];
  while (Date.now() - opened < SETTLE_LIMIT_MS) {
    const p = newest(await profiles());
    if (p && seen.at(-1)?.volume !== p.volume)
      seen.push({ atS: (Date.now() - opened) / 1000, volume: p.volume, partial: p.partial });
    if (p && !p.partial) {
      settled = p;
      break;
    }
    await page.waitForTimeout(1_000);
  }
  report.refines = seen;
  report.settledS = settled ? (Date.now() - opened) / 1000 : null;
  report.settled = settled;
  report.settledLegend = await vpLegend();
  await page.screenshot({ path: join(dir, `${name}-settled.png`) });
  if (settled === null) failures.push(`the profile did not settle within ${String(SETTLE_LIMIT_MS / 1000)} s`);
  else {
    if (first && first.volume >= settled.volume)
      failures.push(`the partial profile (${String(first.volume)}) was not less than the whole (${String(settled.volume)})`);
    const period = (vpLayer?.inputs?.period as string | undefined) ?? 'session';
    const whole = await tool<{ profiles: { from: number; volume: number; delta: number }[] }>(
      'market.get_volume_profile',
      { instrument: 'NQ', mode: period, rowTicks: 1, maxRows: 500 },
    );
    const asked = whole.profiles.at(-1);
    report.wholePull = asked && { from: asked.from, volume: asked.volume, delta: asked.delta };
    const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    if (!asked || !same(asked.volume, settled.volume) || !same(asked.delta, settled.delta))
      failures.push(
        `the drawn profile (volume ${String(settled.volume)}, delta ${String(settled.delta)}) is not the full pull's ` +
          `(volume ${String(asked?.volume)}, delta ${String(asked?.delta)})`,
      );
  }
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
report.failures = failures;
writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
