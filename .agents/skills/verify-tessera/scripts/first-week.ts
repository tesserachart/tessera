#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page, type WebSocketRoute } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/first-week', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: first-week.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const ui = uiDir || join(repo, 'apps/desktop/dist');
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const data = mkdtempSync(join(tmpdir(), 'tessera-first-week-'));

const OFFER = 'Your market data stays on this computer';
const LOGIN = { system: 'Tessera Test', gateway: 'Chicago Area', user: 'trader', password: 'demo' };
const DONE_WITHIN_MS = 20 * 60_000;

const failures: string[] = [];
const expectThat = (ok: boolean, line: string) => {
  console.info(`${ok ? 'ok' : 'FAIL'}: ${line}`);
  if (!ok) failures.push(line);
};
const save = (name: string, value: unknown) =>
  writeFileSync(join(dir, `${scene}-${name}.json`), JSON.stringify(value, null, 2));
const started = Date.now();
const mark = (line: string) => console.info(`${((Date.now() - started) / 1000).toFixed(1)}s ${line}`);

interface Runtime {
  port: number;
  ticket: string;
  child: ChildProcess;
  tool: <T>(name: string, input: unknown) => Promise<T>;
  close: () => void;
}

async function launch(): Promise<Runtime> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (scene === 'pr') env.TESSERA_TEST_MARKET = 'rithmic';
  const child = spawn(bin, ['serve', '--port', '0', '--ui-dir', ui, '--data-dir', data, '--launch-tickets'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });
  const ready = await new Promise<{ port: number; token: string; ticket: string }>((done, fail) => {
    child.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
    const seen: { port?: number; token?: string; ticket?: string } = {};
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        Object.assign(seen, JSON.parse(line) as object);
      } catch {
        return;
      }
      if (seen.port && seen.token && seen.ticket) done({ port: seen.port, token: seen.token, ticket: seen.ticket });
    });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${String(ready.port)}/ws`);
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
    client: { name: 'first-week', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  return {
    port: ready.port,
    ticket: ready.ticket,
    child,
    async tool<T>(name: string, input: unknown): Promise<T> {
      const answer = await call('tools.invoke', { name, input });
      if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
      const result = answer.result as { ok: boolean; output: T; error: { message: string } | null };
      if (!result.ok) throw new Error(`${name}: ${result.error?.message ?? 'refused'}`);
      return result.output;
    },
    close: () => ws.close(),
  };
}

async function stop(runtime: Runtime) {
  runtime.close();
  const exited = new Promise((done) => runtime.child.once('exit', done));
  runtime.child.kill('SIGTERM');
  await exited;
}

function asFreshInstall(ws: WebSocketRoute) {
  const server = ws.connectToServer();
  const candles = new Set<number>();
  const hidden = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value
        .filter((v) => {
          const o = v as { kind?: unknown; id?: unknown; providerId?: unknown } | null;
          return !(o && o.kind === 'market_data' && (o.id === 'mock' || o.providerId === 'mock'));
        })
        .map(hidden);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hidden(v)]));
    return value;
  };
  ws.onMessage((m) => {
    const sent = JSON.parse(String(m)) as { id?: number; method?: string; params?: { name?: string } };
    if (sent.method === 'tools.invoke' && sent.params?.name === 'market.get_candles' && sent.id !== undefined)
      candles.add(sent.id);
    server.send(m);
  });
  server.onMessage((m) => {
    const answer = JSON.parse(String(m)) as { id?: number; result?: Record<string, unknown> };
    if (answer.id !== undefined && candles.has(answer.id) && answer.result) {
      const error = { code: 'not_found', message: 'unknown instrument NQZ6.CME', retryable: false, details: null };
      ws.send(JSON.stringify({ ...answer, result: { ...answer.result, ok: false, status: 'error', output: null, error } }));
      return;
    }
    ws.send(JSON.stringify(hidden(answer)));
  });
}

interface Estimate {
  request: { instrument: string; from: string; to: string; scope: string };
  id: string;
  contract: string;
  days: number;
  saved: number;
  outOfReach: number;
  size: { bytes: number; prints: number; measuredPrints: number } | null;
  seconds: number | null;
}
interface Pull {
  id: string;
  state: string;
  request: Estimate['request'];
  progress: { days: number; saved: number; alreadySaved: number; noTrades: number; failed: number; waiting: number };
}
interface Saved {
  contracts: { instrument: string; bytes: number; days: number; prints: number }[];
}

const pullsOf = async (runtime: Runtime) => (await runtime.tool<{ pulls: Pull[] }>('market.list_pulls', { limit: 1000 })).pulls;
const daysSaved = (pulls: Pull[]) => pulls.reduce((n, p) => n + p.progress.saved + p.progress.alreadySaved, 0);
const bytesOf = (saved: Saved) => saved.contracts.reduce((n, c) => n + c.bytes, 0);

let runtime = await launch();
const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
const page: Page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
if (scene === 'main') await page.routeWebSocket(/\/ws/, asFreshInstall);
const shot = (name: string) => page.screenshot({ path: join(dir, `${scene}-${name}.png`) });
const open = (r: Runtime) => page.goto(`http://127.0.0.1:${String(r.port)}/#ticket=${r.ticket}`);
const settle = (ms = 1_200) => page.waitForTimeout(ms);

async function hoverFor(target: ReturnType<Page['getByText']>, name: string) {
  if ((await target.count()) === 0) return false;
  await target.first().hover();
  await page.getByRole('tooltip').first().waitFor({ timeout: 5_000 }).catch(() => undefined);
  await settle(400);
  await shot(name);
  await page.mouse.move(800, 40);
  return true;
}

const rail = (name: RegExp) => page.getByRole('navigation', { name: 'Areas' }).getByRole('button', { name }).first();

async function openData() {
  if (!(await page.getByRole('button', { name: 'Data', exact: true }).isVisible())) {
    await page.getByRole('button', { name: /^Settings/ }).first().click();
  }
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.getByText('The last week', { exact: true }).first().scrollIntoViewIfNeeded();
  await settle(1_500);
}

async function closeSettings() {
  await rail(/^Desk/).click();
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 30_000 });
}

try {
  await open(runtime);
  const login = page.getByRole('dialog', { name: 'Connect your Rithmic login' });
  await login.waitFor({ timeout: 120_000 });
  const fresh = await runtime.tool<{ connections: { kind: string }[] }>('connections.list', {});
  if (scene === 'pr')
    expectThat(!fresh.connections.some((c) => c.kind === 'market_data'), 'a fresh install has no market-data connection');
  await settle(2_500);
  await shot('1-login');
  mark('login step');
  await login.getByRole('button', { name: 'Firm' }).click();
  await page.getByRole('option', { name: LOGIN.system }).click();
  await login.getByRole('combobox', { name: 'Gateway' }).filter({ hasText: LOGIN.gateway }).waitFor();
  await login.getByLabel('User', { exact: true }).fill(LOGIN.user);
  await login.getByLabel('Password', { exact: true }).fill(LOGIN.password);
  await login.getByRole('button', { name: 'Connect' }).click();

  if (scene === 'main') {
    await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 60_000 });
    await settle(3_000);
    await shot('2-after-connect');
    expectThat((await page.getByText(OFFER).count()) === 0, 'main offers no history after the login');
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await page.getByRole('region', { name: 'Pull a date range' }).scrollIntoViewIfNeeded();
    await settle(1_500);
    await shot('3-settings-data');
  } else {
    const offer = page.getByRole('dialog', { name: OFFER });
    await offer.waitFor({ timeout: 60_000 });
    const lede = (await offer.locator('.ob-lede').textContent()) ?? '';
    expectThat(lede.includes('Tessera Test'), `the offer names the connection: ${lede}`);
    await offer.getByRole('checkbox').first().waitFor({ timeout: 60_000 });
    const unknownShot = await hoverFor(offer.getByText(/not known yet/i), '2-offer-unknown');
    mark(unknownShot ? 'an unknown estimate, with its reason' : 'the estimate was known before the first look');
    await shot('2-offer');
    mark('offer shown');

    const deskName = (
      (await offer
        .getByRole('checkbox', { checked: true })
        .first()
        .evaluate((b) => b.closest('label')?.querySelector('.nm')?.textContent)) ?? ''
    ).trim();
    const nqBox = offer.getByRole('checkbox', { name: /^NQ Z6/ });
    if (!(await nqBox.isChecked())) await nqBox.check({ force: true });
    const total = offer.getByRole('status').filter({ hasText: /^About .* and .*\. It runs in the background/ });
    await total.waitFor({ timeout: 120_000 });
    await settle(600);
    const said = (await total.textContent()) ?? '';
    await shot('3-offer-measured');
    mark(`offer measured: ${said}`);
    const rows = await offer.getByRole('checkbox').evaluateAll((boxes) =>
      boxes.map((b) => ({
        name: (b.closest('label')?.querySelector('.nm')?.textContent ?? '').trim(),
        checked: (b as HTMLInputElement).checked,
        disabled: (b as HTMLInputElement).disabled,
      })),
    );
    save('offer-rows', rows);
    const picked = rows.filter((r) => r.checked).map((r) => r.name);
    expectThat(picked.length > 0, `the desk's markets are picked: ${picked.join(', ')}`);
    const estimates = await Promise.all(
      ['NQ', 'ES'].map((instrument) => runtime.tool<Estimate>('market.estimate_pull', { instrument })),
    );
    save('estimates-before', estimates);
    expectThat(
      estimates.every((e) => e.size !== null && e.seconds !== null),
      'the runtime measured each estimate from saved prints and the connection’s pace',
    );
    const bytesBefore = bytesOf(await runtime.tool<Saved>('market.saved_trades', {}));

    await offer.getByRole('button', { name: 'Download', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 30_000 });
    const downloadAt = Date.now();
    const status = page.getByRole('button', { name: /^Downloading history/ });
    await status.waitFor({ timeout: 30_000 });
    await settle(800);
    await shot('4-downloading');
    await status.hover();
    await page.getByRole('tooltip').first().waitFor({ timeout: 5_000 }).catch(() => undefined);
    await settle(400);
    await shot('4-downloading-detail');
    await page.mouse.move(800, 40);
    mark(`downloading: ${(await status.getAttribute('aria-label')) ?? ''}`);
    const started = await pullsOf(runtime);
    save('pulls-started', started);
    const asked = new Set(started.map((p) => JSON.stringify(p.request)));
    const pickedEstimates = estimates.filter((e) => picked.some((p) => p.replace(/\s+/g, '') === e.contract.split('.')[0]));
    expectThat(
      started.length === picked.length && pickedEstimates.every((e) => asked.has(JSON.stringify(e.request))),
      `Download started the estimated request of each picked market: ${[...asked].join(', ')}`,
    );

    const timeframes = () => page.getByRole('group', { name: 'Timeframe' }).filter({ visible: true }).first();
    await timeframes().getByRole('button', { name: '15m', exact: true }).click();
    await page.getByRole('region', { name: `${deskName} 15m` }).first().waitFor({ timeout: 30_000 });
    await settle(2_000);
    await shot('5-charting-while-downloading');
    expectThat(await status.isVisible(), 'the download keeps running while the chart changes timeframe');

    await openData();
    await shot('6-settings-data-running');
    await closeSettings();

    const total0 = started.reduce((n, p) => n + p.progress.days, 0);
    while (daysSaved(await pullsOf(runtime)) < 2) await settle(250);
    const beforeRestart = await pullsOf(runtime);
    save('pulls-before-restart', beforeRestart);
    expectThat(
      daysSaved(beforeRestart) < total0,
      `the restart lands mid-way: ${String(daysSaved(beforeRestart))} of ${String(total0)} days`,
    );
    const firstRunMs = Date.now() - downloadAt;
    await stop(runtime);
    mark('runtime stopped mid-download');

    runtime = await launch();
    const resumedAt = Date.now();
    await open(runtime);
    await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
    const relogin = await runtime
      .tool('connections.add_rithmic', LOGIN)
      .catch(() => runtime.tool('connections.replace_rithmic', LOGIN));
    save('relogin', relogin);
    await page.getByRole('button', { name: /^Downloading history/ }).waitFor({ timeout: 60_000 });
    if (await page.getByRole('button', { name: 'Data', exact: true }).isVisible()) await closeSettings();
    await page.getByRole('group', { name: 'Timeframe' }).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    await settle(4_000);
    await shot('7-resumed');
    mark('resumed after the restart');
    const resumed = await pullsOf(runtime);
    expectThat(
      resumed.length === started.length && resumed.every((p) => started.some((s) => s.id === p.id)),
      'the same pulls resume by themselves',
    );

    let end = await pullsOf(runtime);
    while (end.some((p) => p.state === 'running') && Date.now() - resumedAt < DONE_WITHIN_MS) {
      await settle(1_000);
      end = await pullsOf(runtime);
    }
    const secondRunMs = Date.now() - resumedAt;
    save('pulls-done', end);
    expectThat(end.every((p) => p.state === 'done' && p.progress.failed === 0), 'every pull ends done, none failed');
    await page.getByRole('button', { name: /^Downloading history/ }).waitFor({ state: 'detached', timeout: 30_000 });
    await settle(1_500);
    await shot('8-done');
    expectThat((await page.getByRole('button', { name: /^History/ }).count()) === 0, 'the status bar item leaves');

    const after = await Promise.all(
      ['NQ', 'ES'].map((instrument) => runtime.tool<Estimate>('market.estimate_pull', { instrument })),
    );
    save('estimates-after', after);
    expectThat(
      after.every((e) => e.saved === e.days - e.outOfReach && e.size?.bytes === 0),
      'the estimate after the download says every day is saved',
    );
    const coverage = await Promise.all(
      after.map((e) =>
        runtime.tool<{ days: number; printsSaved: number; barsMissing: unknown[] }>('market.data_coverage', {
          instrument: e.request.instrument,
          from: e.request.from,
          to: e.request.to,
          scope: 'session',
        }),
      ),
    );
    save('coverage', coverage);
    expectThat(
      coverage.every((c) => c.printsSaved === c.days && c.barsMissing.length === 0),
      'every day of the week has its prints and its minutes saved',
    );
    const bytesAfter = bytesOf(await runtime.tool<Saved>('market.saved_trades', {}));
    const estimatedBytes = estimates.reduce((n, e) => n + (e.size?.bytes ?? 0), 0);
    const estimatedSeconds = estimates.reduce((n, e) => n + (e.seconds ?? 0), 0);
    const compared = {
      estimatedBytes,
      savedBytes: bytesAfter - bytesBefore,
      estimatedSeconds,
      downloadSeconds: Math.round((firstRunMs + secondRunMs) / 1000),
    };
    save('estimate-vs-actual', compared);
    mark(`estimate vs actual: ${JSON.stringify(compared)}`);

    await openData();
    await shot('9-settings-data-done');
    await closeSettings();

    await timeframes().getByRole('button', { name: '1h', exact: true }).click();
    await page.getByRole('region', { name: `${deskName} 1h` }).first().waitFor({ timeout: 30_000 });
    await settle(6_000);
    await shot('10-week-1h');
    try {
      await page.getByRole('button', { name: 'Chart: more' }).filter({ visible: true }).first().click();
      await page.getByRole('menuitem', { name: 'Chart type' }).hover();
      await page.getByRole('menuitem', { name: /Footprint/ }).first().click();
      await page.keyboard.press('Escape');
      await settle(6_000);
      await shot('10-week-footprint');
    } catch (e) {
      expectThat(false, `footprint over the week: ${String(e)}`);
      await page.keyboard.press('Escape');
    }

    const days = await runtime.tool<{ contracts: { instrument: string; days: { tradeDate: string }[] }[] }>(
      'market.list_replay_days',
      {},
    );
    save('replay-days', days);
    try {
      await page.getByRole('button', { name: 'Chart: more' }).filter({ visible: true }).first().click();
      await page.getByRole('menuitem', { name: 'Replay a saved day…' }).click();
      const pick = page.getByRole('dialog', { name: 'Replay a saved day' });
      await pick.waitFor({ timeout: 30_000 });
      await pick.getByRole('list', { name: 'Saved days' }).getByRole('button').first().waitFor({ timeout: 30_000 });
      await settle(800);
      await shot('11-replay-days');
      await pick.getByRole('list', { name: 'Saved days' }).getByRole('button').nth(2).click();
      const bar = page.getByRole('toolbar', { name: 'Replay' });
      await bar.waitFor({ timeout: 30_000 });
      await bar.getByRole('textbox', { name: 'Jump to a time' }).fill('11:00');
      await page.keyboard.press('Enter');
      await settle(6_000);
      await shot('12-replay');
    } catch (e) {
      expectThat(false, `replay from the chart menu: ${String(e)}`);
    }
    const replays = await runtime.tool<{ replays: { instrument: string }[] }>('market.get_replays', {});
    save('replays', replays);
    expectThat(replays.replays.length === 1, 'a pulled day replays from disk');
  }
} finally {
  await browser.close();
  await stop(runtime).catch(() => undefined);
  rmSync(data, { recursive: true, force: true });
}
console.info(failures.length === 0 ? 'all ok' : `${String(failures.length)} failed`);
process.exit(failures.length === 0 ? 0 : 1);
