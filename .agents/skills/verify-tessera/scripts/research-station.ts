#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/research-station', label = 'pr', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const full = label !== 'main';

const SETTLE_MS = 2_500;
const CHAT = 'Opening range research';

const data = mkdtempSync(join(tmpdir(), 'tessera-research-station-'));
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

async function tool<T = unknown>(name: string, input: unknown): Promise<T> {
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
    client: { name: 'research-station', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  const result = answer.result as { output?: T; error?: unknown } | undefined;
  if (answer.error || result?.error) throw new Error(`${name}: ${JSON.stringify(answer.error ?? result?.error)}`);
  return result!.output as T;
}

function save(name: string, value: unknown): void {
  writeFileSync(join(dir, `${label}-${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

type Study = { id: string; name: string; lastVerdict: string | null };
type Run = { runId: string; studyId: string; at: number; archivedAt: number | null; origin: unknown };
type Trade = { entryTime: number; exitTime: number };

async function until<T>(what: string, read: () => Promise<T | null>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got !== null) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = {};
const shot = async (name: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${label}-${name}.png`) });
};
const area = (name: string) =>
  page.getByRole('navigation', { name: 'Areas' }).getByRole('button', { name, exact: true }).click();

async function settle(p: Page): Promise<void> {
  await p
    .getByRole('status', { name: 'Loading bars' })
    .first()
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await p.waitForTimeout(SETTLE_MS);
}

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });

  const standIn = join(repo, '.agents/skills/verify-tessera/scripts/stand-in-claude.mjs');
  await tool('settings.set', {
    key: 'agent.providers',
    value: { 'claude-code': { enabled: true, binaryPath: standIn } },
  });
  await tool('agent.list_providers', { recheck: true });
  const started = await tool<{ session: { id: string } }>('agent.start_session', {
    preset: 'Trader',
    provider: 'claude-code',
    mode: 'auto_modify',
    title: CHAT,
  });
  const sessionId = started.session.id;
  await tool('agent.send', { sessionId, text: 'Research: NQ morning breakout' });
  const fromChat = await until('the chat’s run', async () => {
    const { studies } = await tool<{ studies: Study[] }>('research.list_studies', {});
    return studies.find((s) => s.name === 'NQ morning breakout' && s.lastVerdict) ?? null;
  });
  report.chatStudy = fromChat;

  const mine = await tool<Study>('research.save_study', {
    name: 'NQ EMA 9/21 trend',
    hypothesis: 'On 5-minute bars the 9 EMA against the 21 EMA keeps the side of the morning trend.',
    data: { instrument: 'NQ', tf: '5m', rthOnly: true },
    strategy: { kind: 'rules', rule: { rule: 'ema_cross', fast: 9, slow: 21, sides: 'both' } },
    placeboRuns: 20,
  });
  await tool('research.run_study', { id: mine.id });
  await tool('research.save_study', {
    name: 'ES gap fade',
    hypothesis: 'Small opening gaps fill before the first hour ends.',
    data: { instrument: 'ES', tf: '5m', rthOnly: true },
    strategy: { kind: 'rules', rule: { rule: 'rsi_reversion', length: 14, lower: 30, upper: 70, holdBars: 12, sides: 'both' } },
  });

  await area('Research');
  await page.getByRole('region', { name: 'Research' }).waitFor();
  await page.waitForTimeout(SETTLE_MS);
  await page.getByRole('button', { name: /NQ morning breakout/ }).first().click();
  await page.waitForTimeout(SETTLE_MS);
  await shot('1-run');

  await page.getByRole('button', { name: /^Trades · / }).first().click();
  await page.waitForTimeout(SETTLE_MS);
  await shot('2-trades');

  if (full) {
    const runs = (await tool<{ runs: Run[] }>('research.list_runs', {})).runs;
    save('list-runs-before', runs);
    const chatRun = runs.find((r) => r.studyId === fromChat.id)!;
    const fullRun = await tool<{ evaluation: { cases: { trades: Trade[] }[] } }>('research.get_run', {
      runId: chatRun.runId,
    });
    const trades = fullRun.evaluation.cases[0]!.trades;
    const n = trades.length;
    const trade = trades[n - 1]!;

    await page.getByRole('button', { name: `Show trade ${String(n)} on the chart` }).click();
    await page.getByRole('group', { name: 'Research trade' }).waitFor({ timeout: 30_000 });
    await settle(page);
    await shot('3-trade-on-chart');
    const chart = await tool<{ chart: { instrument: string; timeframe: string; viewport: { from: number; to: number } | null } }>(
      'chart.get_state',
      { layoutId: 'default', tileId: 'chart-1' },
    );
    save('chart-state', chart);
    const vp = chart.chart.viewport;
    report.tradeOnChart = {
      instrument: chart.chart.instrument,
      timeframe: chart.chart.timeframe,
      tradeInView: !!vp && vp.from <= trade.entryTime && trade.exitTime <= vp.to,
      entry: new Date(trade.entryTime / 1e6).toISOString(),
      exit: new Date(trade.exitTime / 1e6).toISOString(),
      shown: vp ? [new Date(vp.from / 1e6).toISOString(), new Date(vp.to / 1e6).toISOString()] : null,
    };

    await page.getByRole('group', { name: 'Research trade' }).getByRole('button', { name: new RegExp(`^Trade ${String(n)} · `) }).click();
    await page.getByRole('region', { name: 'Research' }).waitFor();
    await page.waitForTimeout(SETTLE_MS);
    await shot('4-back-to-trade');
    report.backSelected = await page.locator('.rs-tlist tr[data-selected] td').first().textContent();

    await page.getByRole('button', { name: CHAT, exact: true }).click();
    await page.waitForTimeout(SETTLE_MS);
    await shot('5-chat');
    report.chatShown = await page.getByText(/I registered "NQ morning breakout"/).count();

    await area('Research');
    await page.waitForTimeout(SETTLE_MS);
    await page.getByRole('button', { name: /NQ EMA 9\/21 trend/ }).first().click();
    await page.waitForTimeout(SETTLE_MS);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page.waitForTimeout(SETTLE_MS);
    await page.getByRole('button', { name: /^Archived/ }).click();
    await page.waitForTimeout(SETTLE_MS);
    await shot('6-archived');
    report.archived = (await tool<{ runs: Run[] }>('research.list_runs', {})).runs.filter((r) => r.archivedAt).length;

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Delete' }).waitFor();
    await shot('7-delete-confirm');
    await page.getByRole('alertdialog', { name: 'Delete' }).getByRole('button', { name: 'Delete' }).click();
    await page.waitForTimeout(SETTLE_MS);
    const after = (await tool<{ runs: Run[] }>('research.list_runs', {})).runs;
    save('list-runs-after', after);
    report.runsAfterDelete = after.length;
    report.studyKept = (await tool<{ studies: Study[] }>('research.list_studies', {})).studies.some(
      (s) => s.id === mine.id,
    );

    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search runs' }).fill('opening range');
    await page.waitForTimeout(SETTLE_MS);
    await shot('8-search');
  }
  save('report', report);
  console.info(JSON.stringify(report, null, 2));
} catch (e) {
  await shot('stuck').catch(() => undefined);
  save('report', { ...report, error: String(e) });
  throw e;
} finally {
  await browser.close();
  runtime.kill();
  rmSync(data, { recursive: true, force: true });
}
