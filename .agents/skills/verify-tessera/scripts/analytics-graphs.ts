#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/analytics-graphs', label = 'pr', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SETTLE_MS = 1_500;
const TRADES = 72;
const FIRST_DAY = Date.UTC(2026, 6, 6, 13, 35);
const DAY_MS = 86_400_000;
const TICK = 0.25;

const data = mkdtempSync(join(tmpdir(), 'tessera-analytics-graphs-'));
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
    client: { name: 'analytics-graphs', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  const result = answer.result as { output?: T; error?: unknown } | undefined;
  if (answer.error || result?.error) throw new Error(`${name}: ${JSON.stringify(answer.error ?? result?.error)}`);
  return result!.output as T;
}

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weekday(i: number): number {
  let t = FIRST_DAY;
  for (let n = 0; n < i; ) {
    t += DAY_MS;
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return t;
}

async function seedJournal(): Promise<number> {
  const rand = seeded(597);
  const setups = await Promise.all(
    ['Opening drive', 'VWAP fade'].map((name) => tool<{ id: string }>('journal.save_setup', { name })),
  );
  let logged = 0;
  for (let i = 0; i < TRADES; i++) {
    const nq = rand() < 0.65;
    const day = weekday(Math.floor(i * 0.88));
    const entry = day + Math.floor(rand() * 4 * 60) * 60_000;
    const hold = (2 + Math.floor(rand() * 40)) * 60_000;
    const price = nq ? 20_400 + Math.floor(rand() * 400) : 5_560 + Math.floor(rand() * 40);
    const win = rand() < 0.55;
    const ticks = Math.round((win ? 8 + rand() * 40 : -(6 + rand() * 28)) * (nq ? 1 : 0.5));
    const long = rand() < 0.6;
    const exit = price + (long ? ticks : -ticks) * TICK;
    await tool('journal.log_trade', {
      account: 'Paper',
      symbol: nq ? 'NQU6' : 'ESU6',
      side: long ? 'buy' : 'sell',
      qty: 1 + Math.floor(rand() * 2),
      entryPrice: price,
      entryTime: new Date(entry).toISOString(),
      exitPrice: exit,
      exitTime: new Date(entry + hold).toISOString(),
      fees: 4.5,
      stopPrice: price - (long ? 1 : -1) * (nq ? 24 : 12) * TICK,
      setupId: setups[i % 3 === 0 ? 1 : 0]!.id,
    });
    logged++;
  }
  return logged;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
await page.emulateMedia({ colorScheme: 'dark' });
const report: Record<string, unknown> = { label };

const shot = async (name: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${label}-${name}.png`) });
};
const area = (name: string) =>
  page.getByRole('navigation', { name: 'Areas' }).getByRole('button', { name, exact: true }).click();
const journal = () => page.getByRole('region', { name: 'Journal', exact: true });
const section = async (name: string) => {
  await area('Journal');
  await journal().getByRole('radio', { name, exact: true }).or(journal().getByRole('button', { name, exact: true })).first().click();
  await page.waitForTimeout(SETTLE_MS);
};
const reportTab = async (name: string) => {
  await journal().getByRole('radio', { name, exact: true }).or(journal().getByRole('button', { name, exact: true })).first().click();
  await page.waitForTimeout(SETTLE_MS);
};

async function hoverAt(target: Locator, fx: number, fy = 0.5): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(300);
}

async function tipText(): Promise<string | null> {
  const tip = page.locator('.gr-tip, .jr-tip, .rs-equity-read').first();
  return (await tip.count()) ? ((await tip.textContent()) ?? null) : null;
}

async function setTheme(preset: string): Promise<void> {
  await tool('settings.set', { key: 'appearance.theme', value: { preset } });
  await page.waitForTimeout(SETTLE_MS);
}

async function runStudy(): Promise<void> {
  const study = await tool<{ id: string }>('research.save_study', {
    name: 'NQ EMA 9/21 trend',
    hypothesis: 'On 5-minute bars the 9 EMA against the 21 EMA keeps the side of the morning trend.',
    data: { instrument: 'NQ', tf: '5m', rthOnly: true },
    strategy: { kind: 'rules', rule: { rule: 'ema_cross', fast: 9, slow: 21, sides: 'both' } },
    placeboRuns: 20,
  });
  await tool('research.run_study', { id: study.id });
}

async function openRun(): Promise<void> {
  await area('Research');
  await page.getByRole('region', { name: 'Research' }).waitFor();
  await page.waitForTimeout(SETTLE_MS);
  await page.getByRole('button', { name: /NQ EMA 9\/21 trend/ }).first().click();
  await page.waitForTimeout(SETTLE_MS);
}

async function stills(theme: string): Promise<void> {
  await section('Dashboard');
  await shot(`${theme}-dashboard`);
  await hoverAt(journal(), 0.5, 0.6);
  await page.mouse.wheel(0, 1600);
  await shot(`${theme}-dashboard-lower`);
  await section('Analytics');
  for (const tab of ['Overview', 'Time', 'Risk', 'Symbols', 'Behaviour']) {
    await reportTab(tab);
    await shot(`${theme}-analytics-${tab.toLowerCase()}`);
  }
  await section('Playbooks');
  await shot(`${theme}-playbooks`);
  await openRun();
  await shot(`${theme}-research-run`);
}

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  report.logged = await seedJournal();
  await runStudy();

  await stills('dark');

  await section('Analytics');
  await reportTab('Risk');
  const equity = journal().getByRole('img', { name: /^Equity curve over/ }).first();
  await hoverAt(equity, 0.6, 0.4);
  report.journalEquityTip = await tipText();
  await shot('dark-hover-equity');
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
  report.pickedTrade = await page.getByRole('complementary', { name: 'The trade' }).count();
  await shot('dark-picked-trade');

  await section('Analytics');
  await reportTab('Risk');
  const bars = journal().getByRole('img', { name: 'Bars by bucket' }).first();
  await hoverAt(bars, 0.3, 0.5);
  report.bucketTip = await tipText();
  report.fadedBars = await page.locator('.gr-bar.is-faint, .jr-bar.is-small').count();
  await shot('dark-hover-bars');

  await reportTab('Symbols');
  const legend = journal().locator('.gr-legend.is-row button, .jk-legend.is-row button').first();
  await legend.click();
  await page.waitForTimeout(400);
  report.isolated = await page.locator('.gr-series.is-dim, .jk-mline.is-dim').count();
  await shot('dark-legend-isolated');

  await openRun();
  const curve = page.getByRole('img', { name: /^Equity curve, / }).first();
  await hoverAt(curve, 0.7, 0.5);
  report.researchTip = await tipText();
  report.laterShaded = await page.getByText(/later sessions shaded/).count();
  report.researchAxisLabels = await page
    .locator('.rs-equity text')
    .allTextContents()
    .then((t) => t.filter((s) => s.trim()).slice(0, 16));
  await shot('dark-hover-research');
  await page.mouse.move(5, 5);

  await setTheme('tessera-light');
  await stills('light');
} finally {
  writeFileSync(join(dir, `${label}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  runtime.kill('SIGTERM');
  await new Promise((r) => runtime.once('exit', r));
  rmSync(data, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
