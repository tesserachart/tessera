#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/delta-profiles', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const newYork = (month: number, day: number, hour: number, minute = 0) =>
  Date.UTC(2026, month - 1, day, hour + 4, minute) * 1e6;
const TWO_DAYS = { from: newYork(10, 1, 6), to: newYork(10, 2, 16) };
const TWO_WEEKS = { from: newYork(9, 20, 18), to: newYork(10, 2, 16) };

const data = mkdtempSync(join(tmpdir(), 'tessera-delta-profiles-'));
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
    client: { name: 'delta-profiles', version: '0', platform: 'node' },
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

interface Drawn {
  label: string;
  from: number;
  to: number;
  volume: number;
  delta?: number;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { build: name };
const tile = { layoutId: 'default', tileId: 'chart-1' };
const failures: string[] = [];
let tf = '5m';

const chartRegion = () => page.getByRole('region', { name: /^NQ Z6 / }).first();
const still = (scene: string) => chartRegion().screenshot({ path: join(dir, `${name}-${scene}.png`) });
const drawn = async (): Promise<Drawn[]> => {
  const state = (await tool('chart.get_state', tile)) as { ok?: { chart: { viewport: { profiles?: Drawn[] } | null } } };
  return state.ok?.chart.viewport?.profiles ?? [];
};
const bars = async (timeframe: string, view: { from: number; to: number }) => {
  tf = timeframe;
  await tool('chart.set_timeframe', { ...tile, tf });
  await page.waitForTimeout(3_000);
  await tool('chart.set_viewport', { ...tile, ...view });
  await page.waitForTimeout(1_500);
};

const deltaStudy = async (p: Drawn): Promise<number | null> => {
  const answer = (await tool('indicators.compute', {
    indicator: 'delta',
    inputs: { reset: 'session' },
    instrument: 'NQ',
    tf,
    from: p.from,
    to: p.to,
    limit: 20_000,
  })) as { ok?: { time: number[]; plots: { key: string; values: (number | null)[] }[] } };
  const time = answer.ok?.time ?? [];
  const values = answer.ok?.plots.find((x) => x.key === 'delta')?.values.filter((_, k) => time[k]! < p.to);
  if (!values || values.some((v) => v === null)) return null;
  return values.reduce<number>((t, v) => t + v!, 0);
};

const study = async (scene: string, inputs: Record<string, unknown>, want: number) => {
  const added = await tool('chart.add_layer', { ...tile, kind: 'volume_profile', params: { inputs } });
  report[`${scene}.inputs`] = inputs;
  let profiles: Drawn[] = [];
  for (let k = 0; k < 20 && profiles.length < want; k++) {
    await page.waitForTimeout(1_500);
    profiles = await drawn();
  }
  await page.waitForTimeout(1_000);
  await still(scene);
  profiles = await drawn();
  const checked = [];
  for (const p of profiles) {
    const study = await deltaStudy(p);
    checked.push({ label: p.label, from: p.from, to: p.to, volume: p.volume, delta: p.delta ?? null, deltaStudy: study });
    if (p.delta === undefined) continue;
    if (study === null || Math.abs(study - p.delta) > 1e-6)
      failures.push(`${scene} ${p.label}: profile delta ${String(p.delta)}, delta study ${String(study)}`);
  }
  report[`${scene}.profiles`] = checked;
  if (profiles.length < want) failures.push(`${scene}: drew ${String(profiles.length)} of ${String(want)}`);
  const layers = 'ok' in added ? (added.ok as { chart: { layers: { id: string; kind: string }[] } }).chart.layers : [];
  const id = layers.filter((l) => l.kind === 'volume_profile').at(-1)?.id;
  if (id) await tool('chart.remove_layer', { ...tile, layerId: id });
};

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Maximise' }).first().click();
  report['delta.added'] = await tool('chart.add_layer', { ...tile, kind: 'delta', params: { inputs: { mode: 'bar' } } });

  await bars('5m', TWO_DAYS);
  await study('session-delta-5m', { period: 'session', length: 2, show: 'delta' }, 2);
  await study('session-volume-delta-5m', { period: 'session', length: 2, show: 'volumeDelta' }, 2);
  await study('rth-session-delta-5m', { period: 'session', hours: 'rth', length: 2, show: 'delta' }, 2);
  await study('day-delta-5m', { period: 'day', length: 2, show: 'delta' }, 2);
  await study('composite-delta-5m', { period: 'composite', compositePeriod: 'session', length: 3, show: 'volumeDelta' }, 1);

  await bars('1h', TWO_WEEKS);
  await study('week-delta-1h', { period: 'week', length: 2, show: 'delta' }, 2);
  await study('week-volume-delta-1h', { period: 'week', length: 2, show: 'volumeDelta' }, 2);
  await study('composite-weeks-delta-1h', { period: 'composite', compositePeriod: 'week', length: 2, show: 'delta' }, 1);
} finally {
  report.failures = failures;
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stills and ${name}-report.json in ${dir}`);
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
