#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/market-profile', uiDir, tag = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const NS = 1e6;
const at = (iso: string) => Date.parse(iso) * NS;
const TWO_SESSIONS = { from: at('2026-10-01T13:30:00Z'), to: at('2026-10-02T20:00:00Z') };
const TWO_WEEKS = { from: at('2026-09-20T22:00:00Z'), to: at('2026-10-02T20:00:00Z') };

const data = mkdtempSync(join(tmpdir(), 'tessera-market-profile-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  [
    'serve',
    '--port',
    '0',
    '--ui-dir',
    uiDir ?? join(repo, 'apps/desktop/dist'),
    '--data-dir',
    data,
    '--launch-tickets',
  ],
  { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
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

async function tool(name: string, input: unknown): Promise<{ output?: unknown; error?: unknown }> {
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
    client: { name: 'market-profile', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result as { output?: unknown; error?: unknown };
}

const save = (name: string, value: unknown) =>
  writeFileSync(join(dir, `${tag}-${name}.json`), JSON.stringify(value, null, 2));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const tile = { layoutId: 'default', tileId: 'chart-1' };
const failures: string[] = [];
const report: Record<string, unknown> = { tag };

interface Drawn {
  id: string;
  label: string;
  from: number;
  to: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
}

async function settled(chart: Locator): Promise<void> {
  await chart.waitFor({ timeout: 30_000 });
  await chart
    .getByRole('status', { name: 'Loading bars' })
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(3_000);
}

async function drawn(want: number): Promise<Drawn[]> {
  let out: Drawn[] = [];
  for (let k = 0; k < 30; k++) {
    const state = (await tool('chart.get_state', tile)) as {
      output?: { chart: { layers: { id: string; kind: string }[]; viewport: { profiles?: Drawn[] } | null } };
    };
    const ids = new Set(state.output?.chart.layers.filter((l) => l.kind === 'market_profile').map((l) => l.id));
    out = (state.output?.chart.viewport?.profiles ?? []).filter((p) => ids.has(p.id));
    if (out.length >= want) break;
    await page.waitForTimeout(1_000);
  }
  return out;
}

async function sameAsRuntime(scene: string, mode: string, minutes: number, want: number, hours?: 'rth') {
  const profiles = await drawn(want);
  const answer = (await tool('market.get_volume_profile', {
    instrument: 'NQ',
    mode,
    count: 12,
    tpoMinutes: minutes,
    rowTicks: 1,
    maxRows: 500,
    ...(hours ? { session: hours } : {}),
  })) as { output?: { profiles: { from: number; tpo?: { poc: number | null; vah: number | null; val: number | null; brackets: unknown[] } }[] } };
  const runtime = answer.output?.profiles ?? [];
  const rows = profiles.map((p) => {
    const r = runtime.find((x) => x.from === p.from);
    const same = r?.tpo && r.tpo.poc === p.poc && r.tpo.vah === p.vah && r.tpo.val === p.val;
    if (!same) failures.push(`${scene} ${p.label}: chart ${String(p.poc)}/${String(p.vah)}/${String(p.val)}, runtime ${JSON.stringify(r?.tpo && { poc: r.tpo.poc, vah: r.tpo.vah, val: r.tpo.val })}`);
    return { label: p.label, from: p.from, chart: { poc: p.poc, vah: p.vah, val: p.val }, runtime: r?.tpo ? { poc: r.tpo.poc, vah: r.tpo.vah, val: r.tpo.val, brackets: r.tpo.brackets.length } : null };
  });
  if (profiles.length < want) failures.push(`${scene}: drew ${String(profiles.length)} of ${String(want)}`);
  report[scene] = rows;
}

async function view(tf: string, span: { from: number; to: number }) {
  await tool('chart.set_timeframe', { ...tile, tf });
  await settled(page.getByRole('region', { name: `NQ Z6 ${tf}` }));
  await tool('chart.set_viewport', { ...tile, ...span });
  await page.waitForTimeout(2_500);
}

async function pick(label: string, option: string) {
  const dialog = page.getByRole('dialog').first();
  const radio = dialog.getByRole('radio', { name: option, exact: true });
  if ((await radio.count()) > 0) {
    await radio.first().click();
    return;
  }
  const segment = dialog.getByRole('button', { name: option, exact: true });
  if ((await segment.count()) > 0) {
    await segment.first().click();
    return;
  }
  await dialog.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const chartStill = (scene: string) =>
  page.getByRole('region', { name: /^NQ Z6 / }).first().screenshot({ path: join(dir, `${tag}-${scene}.png`) });

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Maximise' }).first().click();
  await view('5m', TWO_SESSIONS);

  await page.locator('.chart-tools').first().getByRole('button', { name: 'Indicators', exact: true }).click();
  const library = page.getByRole('complementary', { name: 'Indicators' });
  await library.getByRole('searchbox').or(library.getByRole('textbox')).first().fill('market profile');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(dir, `${tag}-library-search.png`) });
  const row = library.getByRole('button', { name: /^Market profile/ });
  if ((await row.count()) === 0) {
    report.library = 'no Market profile row';
    process.exitCode = 0;
  } else {
    await row.first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(dir, `${tag}-library-row.png`) });
    await page.getByRole('button', { name: 'Add to chart' }).click();
    await page.waitForTimeout(1_000);
    await page.keyboard.press('Escape');
    await page.getByRole('region', { name: /^NQ Z6 / }).first().getByRole('button', { name: 'Maximise' }).first().click();
    await page.waitForTimeout(800);

    const layout = (await tool('layout.get', { layoutId: 'default' })) as {
      output?: { charts?: Record<string, { layers?: { kind: string; params: { inputs?: Record<string, unknown> } }[] }> };
    };
    const added = layout.output?.charts?.['chart-1']?.layers?.find((l) => l.kind === 'market_profile');
    report.added = added?.params.inputs ?? null;
    if (!added) throw new Error('the study was not added to chart-1');
    const i = added.params.inputs ?? {};
    if (i.period !== 'session' || i.tpo !== '30' || i.style !== 'letters' || i.valueArea !== 70 || i.ib !== true)
      failures.push(`defaults: ${JSON.stringify(i)}`);

    await view('5m', TWO_SESSIONS);
    await sameAsRuntime('session-30m-letters', 'session', 30, 2);
    report.legend = (await page.locator('.ind-legend').first().innerText()).replace(/\s+/g, ' ').trim();
    await chartStill('session-letters-5m');

    await view('30m', TWO_SESSIONS);
    await chartStill('session-letters-30m');

    await page.getByRole('button', { name: /^TPO.*: menu$/ }).first().click();
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    await page.getByRole('dialog').first().waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(dir, `${tag}-settings.png`) });
    await pick('Draw as', 'Blocks');
    await pick('TPO size', '15 min');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(dir, `${tag}-settings-blocks-15.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1_500);
    const after = (await tool('layout.get', { layoutId: 'default' })) as typeof layout;
    const inputs = after.output?.charts?.['chart-1']?.layers?.find((l) => l.kind === 'market_profile')?.params.inputs;
    report.edited = inputs ?? null;
    if (inputs?.style !== 'blocks' || inputs.tpo !== '15') failures.push(`settings did not stick: ${JSON.stringify(inputs)}`);
    await sameAsRuntime('session-15m-blocks', 'session', 15, 2);
    await chartStill('session-blocks-15m-30m');

    const id = (await tool('chart.get_state', tile)) as { output?: { chart: { layers: { id: string; kind: string }[] } } };
    const layerId = id.output?.chart.layers.find((l) => l.kind === 'market_profile')?.id;
    await tool('chart.update_layer', { ...tile, layerId, params: { inputs: { period: 'week', length: 2, style: 'letters', tpo: '30' } } });
    await view('1h', TWO_WEEKS);
    await sameAsRuntime('week-30m-letters', 'week', 30, 2);
    await chartStill('week-letters-1h');
  }
  save('report', { ...report, failures });
  console.log(JSON.stringify({ ...report, failures, stills: dir }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
