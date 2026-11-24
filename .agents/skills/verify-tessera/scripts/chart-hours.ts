#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/chart-hours', label = 'pr', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SETTLE_MS = 3_000;
const REPORTED_MS = 2_500;
const CHART = { layoutId: 'default', tileId: 'chart-1' };

const data = mkdtempSync(join(tmpdir(), 'tessera-chart-hours-'));
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
    client: { name: 'chart-hours', version: '0', platform: 'node' },
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

type Profile = { volume: number; label: string; source: { kind?: string } | string };
type ChartOut = { chart?: { hours?: string; viewport?: { bars: number | null; profiles?: Profile[] } } };

async function compositeVolume(session: 'all' | 'rth'): Promise<number | null> {
  const r = await tool('market.get_volume_profile', {
    instrument: 'NQ',
    mode: 'composite',
    sessions: 5,
    ...(session === 'rth' ? { session } : {}),
  });
  save(`market-composite-${session}`, r);
  const p = (r.output as { profiles?: { volume: number }[] } | undefined)?.profiles?.at(-1);
  return p?.volume ?? null;
}

async function drawn(): Promise<{ hours: string; volume: number | null; bars: number | null }> {
  const r = await tool('chart.get_state', CHART);
  const c = (r.output as ChartOut | undefined)?.chart;
  const composite = c?.viewport?.profiles?.find((p) => p.label.includes('5 sessions'));
  return { hours: c?.hours ?? 'eth', volume: composite?.volume ?? null, bars: c?.viewport?.bars ?? null };
}

async function settle(page: Page): Promise<void> {
  await page
    .getByRole('status', { name: 'Loading bars' })
    .first()
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=2'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();

try {
  const report: Record<string, string | number | null> = {};
  await tool('chart.set_timeframe', { ...CHART, tf: '5m' });
  await tool('chart.add_layer', {
    ...CHART,
    kind: 'volume_profile',
    params: { inputs: { period: 'composite', length: 5 } },
  });
  const all = await compositeVolume('all');
  const rth = await compositeVolume('rth');
  report['market.get_volume_profile composite 5, all hours'] = all;
  report['market.get_volume_profile composite 5, rth'] = rth;
  const rthBars = (await tool('market.get_candles', { instrument: 'NQ', tf: '5m', limit: 1500, session: 'rth' }))
    .output as { bars?: [number][] } | undefined;
  const newYorkTime = (t: number) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(
      t / 1e6,
    );
  const times = new Set((rthBars?.bars ?? []).map((b) => newYorkTime(b[0])));
  report['market.get_candles 5m rth, earliest and latest bar of the day'] =
    `${[...times].sort()[0] ?? '?'}–${[...times].sort().at(-1) ?? '?'}`;

  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 30_000 });
  await settle(page);
  await page.waitForTimeout(REPORTED_MS);
  const before = await drawn();
  report['before: chart hours'] = before.hours;
  report['before: drawn composite volume'] = before.volume;
  await page.screenshot({ path: join(dir, `${label}-1-eth.png`) });

  const pill = page.getByRole('button', { name: /^Chart hours: / });
  if ((await pill.count()) === 0) {
    report['hours pill'] = 'none in this build';
  } else {
    report['pill before'] = (await pill.first().textContent()) ?? '';
    await pill.first().click();
    await page.getByRole('menuitemradio', { name: /^Regular hours/ }).waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(dir, `${label}-2-menu.png`) });
    await page.getByRole('menuitemradio', { name: /^Regular hours/ }).click();
    await settle(page);
    await page.waitForTimeout(REPORTED_MS);
    const after = await drawn();
    report['pill after'] = (await pill.first().textContent()) ?? '';
    report['after: chart hours'] = after.hours;
    report['after: drawn composite volume'] = after.volume;
    report['after: drawn composite volume equals market.get_volume_profile rth'] = String(after.volume === rth);
    await page.screenshot({ path: join(dir, `${label}-3-rth.png`) });

    const agent = await tool('chart.set_hours', { ...CHART, hours: 'eth' });
    save('agent-set-hours-eth', agent);
    await settle(page);
    await page.waitForTimeout(REPORTED_MS);
    const back = await drawn();
    report['agent chart.set_hours eth: pill'] = (await pill.first().textContent()) ?? '';
    report['agent chart.set_hours eth: drawn composite volume'] = back.volume;
    report['agent chart.set_hours eth: equals all hours'] = String(back.volume === all);
    await page.screenshot({ path: join(dir, `${label}-4-agent-eth.png`) });
  }
  save('chart-state', await tool('chart.get_state', CHART));
  save('report', report);
  for (const [k, v] of Object.entries(report)) console.log(`${label} ${k}: ${String(v)}`);
} finally {
  await context.close();
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
  console.log(`stills and answers in ${dir}`);
}
