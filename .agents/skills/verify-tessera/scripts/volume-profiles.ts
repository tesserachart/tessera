#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/volume-profiles', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const newYork = (month: number, day: number, hour: number, minute = 0) =>
  Date.UTC(2026, month - 1, day, hour + 4, minute) * 1e6;
const VIEW = { from: newYork(9, 6, 18), to: newYork(10, 2, 16) };
const WIDE = { from: newYork(6, 1, 0), to: newYork(10, 2, 16) };
const TWO_DAYS = { from: newYork(10, 1, 6), to: newYork(10, 2, 16) };
const old = name === 'main';

const data = mkdtempSync(join(tmpdir(), 'tessera-volume-profiles-'));
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
    client: { name: 'volume-profiles', version: '0', platform: 'node' },
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
const tile = { layoutId: 'default', tileId: 'chart-1' };
const failures: string[] = [];
const iso = (ns: number) => new Date(ns / 1e6).toISOString();

type Study = { period: string; length?: number; compositePeriod?: string; from?: number; to?: number; hours?: string };
const asInputs = (s: Study): Record<string, unknown> =>
  old
    ? {
        range: s.period,
        ...(s.period === 'composite'
          ? { sessions: s.length, compositePeriod: s.compositePeriod }
          : { sessionsShown: s.length }),
        ...(s.hours ? { hours: s.hours } : {}),
      }
    : {
        period: s.period,
        ...(s.length ? { length: s.length } : {}),
        ...(s.compositePeriod ? { compositePeriod: s.compositePeriod } : {}),
        ...(s.from ? { from: iso(s.from) } : {}),
        ...(s.to ? { to: iso(s.to) } : {}),
        ...(s.hours ? { hours: s.hours } : {}),
      };

const chartRegion = () => page.getByRole('region', { name: /^NQ Z6 / }).first();
const still = (scene: string) => chartRegion().screenshot({ path: join(dir, `${name}-${scene}.png`) });
const drawn = async (scene: string) => {
  const state = (await tool('chart.get_state', tile)) as { ok?: { chart: { viewport: { profiles?: unknown[] } | null } } };
  const profiles = (state.ok?.chart.viewport?.profiles ?? []) as { label: string }[];
  report[`${scene}.profiles`] = profiles;
  return profiles;
};
const bars = async (tf: string, printBars: unknown, view: { from: number; to: number }) => {
  report[`bars ${tf} ${JSON.stringify(printBars)}`] = await tool('chart.set_timeframe', {
    ...tile,
    tf,
    ...(printBars ? { printBars } : {}),
  });
  await page.waitForTimeout(3_000);
  await tool('chart.set_viewport', { ...tile, ...view });
  await page.waitForTimeout(1_500);
};
const drawingOf = (s: Study) => ({
  kind: s.period === 'range' ? 'profile_range' : 'profile_anchored',
  points: s.period === 'range' ? [{ t: s.from }, { t: s.to }] : [{ t: s.from }],
});
const study = async (scene: string, s: Study, want: (labels: string[]) => boolean) => {
  const asDrawing = old && (s.period === 'range' || s.period === 'anchored');
  const added = asDrawing
    ? await tool('chart.add_drawing', { ...tile, ...drawingOf(s) })
    : await tool('chart.add_layer', { ...tile, kind: 'volume_profile', params: { inputs: asInputs(s) } });
  report[`${scene}.added`] = added;
  let labels: string[] = [];
  for (let k = 0; k < 20; k++) {
    await page.waitForTimeout(1_500);
    labels = (await drawn(scene)).map((p) => p.label);
    if (want(labels)) break;
  }
  await page.waitForTimeout(1_000);
  await still(scene);
  await drawn(scene);
  if (!want(labels)) failures.push(`${scene}: drew ${JSON.stringify(labels)}`);
  if (asDrawing) {
    const drawingId = 'ok' in added ? (added.ok as { drawing: { id: string } }).drawing.id : undefined;
    if (drawingId) await tool('chart.remove_drawing', { ...tile, drawingId });
    return;
  }
  const layers = 'ok' in added ? (added.ok as { chart: { layers: { id: string; kind: string }[] } }).chart.layers : [];
  const id = layers.filter((l) => l.kind === 'volume_profile').at(-1)?.id;
  if (id) await tool('chart.remove_layer', { ...tile, layerId: id });
};
const any = (labels: string[]) => labels.length > 0;

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const range = { from: newYork(9, 8, 9, 30), to: newYork(10, 2, 14) };

  await bars('1h', null, VIEW);
  await study('weekly-1h', { period: 'week', length: 4 }, (l) => l.length >= 4);
  await study('range-1h', { period: 'range', ...range }, (l) => l.includes('Range'));
  await study('anchored-1h', { period: 'anchored', from: newYork(10, 1, 9, 30) }, (l) => l.includes('Anchored'));
  await study('composite-13-weeks-1h', { period: 'composite', compositePeriod: 'week', length: 13 }, any);

  await bars('1D', null, WIDE);
  await study('rth-sessions-1D', { period: 'session', hours: 'rth', length: 10 }, (l) => l.length >= 10);
  await study('weekly-1D', { period: 'week', length: 4 }, (l) => l.length >= 4);
  await study('range-1D', { period: 'range', ...range }, (l) => l.includes('Range'));
  await study('composite-13-weeks-1D', { period: 'composite', compositePeriod: 'week', length: 13 }, any);

  for (const [scene, printBars] of [
    ['volume-bars', { kind: 'volume', size: 1000 }],
    ['tick-bars', { kind: 'tick', size: 500 }],
  ] as const) {
    await bars('5m', printBars, TWO_DAYS);
    await study(`sessions-${scene}`, { period: 'session', length: 5 }, (l) => l.length >= 2);
    await study(`rth-sessions-${scene}`, { period: 'session', hours: 'rth', length: 5 }, (l) => l.length >= 2);
    await study(`weekly-${scene}`, { period: 'week', length: 2 }, any);
    await study(`anchored-${scene}`, { period: 'anchored', from: newYork(10, 2, 9, 30) }, (l) => l.includes('Anchored'));
    await study(`composite-${scene}`, { period: 'composite', compositePeriod: 'week', length: 13 }, any);
  }

  if (!old) {
    await bars('1h', null, VIEW);
    const box = (await chartRegion().boundingBox())!;
    const at = (x: number) => page.mouse.click(box.x + box.width * x, box.y + box.height * 0.55);
    await at(0.5);
    await page.keyboard.press('Alt+Shift+P');
    await at(0.3);
    await at(0.6);
    await page.waitForTimeout(6_000);
    const state = (await tool('chart.get_state', tile)) as {
      ok?: { chart: { layers: { id: string; kind: string; params: { inputs: Record<string, unknown> } }[] } };
    };
    const placed = state.ok?.chart.layers.find((l) => l.kind === 'volume_profile');
    report['clicked.layer'] = placed ?? null;
    await still('clicked-range-1h');
    const labels = (await drawn('clicked-range-1h')).map((p) => p.label);
    if (placed?.params.inputs.period !== 'range' || !labels.includes('Range'))
      failures.push(`clicked range: ${JSON.stringify(placed?.params.inputs)} drew ${JSON.stringify(labels)}`);

    const area = (await chartRegion().boundingBox())!;
    await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.5);
    const row = (await page.getByText('VP range', { exact: true }).first().boundingBox())!;
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
    await page.locator('[aria-label="VP range: settings"]').first().click();
    const from = page.getByRole('textbox', { name: 'From' });
    await from.waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(dir, `${name}-range-settings.png`) });
    await from.fill('2026-09-08 09:30');
    await from.press('Enter');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(6_000);
    const after = (await tool('chart.get_state', tile)) as {
      ok?: { chart: { layers: { kind: string; params: { inputs: Record<string, unknown> } }[] } };
    };
    const edited = after.ok?.chart.layers.find((l) => l.kind === 'volume_profile')?.params.inputs;
    report['edited.inputs'] = edited ?? null;
    await still('edited-range-1h');
    const drew = await drawn('edited-range-1h');
    const typed = await page.evaluate(() => new Date(2026, 8, 8, 9, 30).getTime());
    if (Date.parse(String(edited?.from)) !== typed || !drew.some((p) => p.label === 'Range'))
      failures.push(`edited range: ${JSON.stringify(edited)} drew ${JSON.stringify(drew)}`);
  }

  report['market.week'] = await tool('market.get_volume_profile', { instrument: 'NQ', mode: 'week', maxRows: 5 });
  report['market.composite13'] = await tool('market.get_volume_profile', {
    instrument: 'NQ',
    mode: 'composite',
    period: 'week',
    count: 13,
    maxRows: 5,
  });
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
