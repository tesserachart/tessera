#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/cvd-timeframes', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;

type Answer = { ok: unknown } | { refused: string };

interface Sim {
  origin: string;
  ticket: string;
  tool(tool: string, input: unknown): Promise<Answer>;
  stop(): void;
}

async function startSim(label: string, env: Record<string, string>): Promise<Sim> {
  const data = mkdtempSync(join(tmpdir(), `tessera-cvd-${label}-`));
  const runtime: ChildProcess = spawn(
    bin,
    ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
    { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TESSERA_NO_RITHMIC: '1', ...env } },
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
  async function tool(tool: string, input: unknown): Promise<Answer> {
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
      client: { name: 'cvd-timeframes', version: '0', platform: 'node' },
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
  return {
    origin,
    ticket: ready.ticket,
    tool,
    stop: () => {
      runtime.kill('SIGTERM');
      rmSync(data, { recursive: true, force: true });
    },
  };
}

const NS_PER_MINUTE = 60_000_000_000;
const FROZEN_AT_NS = Date.parse('2026-10-02T14:42:30-04:00') * 1_000_000;
const FROZEN_SETTLED_NS = Math.floor(FROZEN_AT_NS / NS_PER_MINUTE) * NS_PER_MINUTE - 2 * NS_PER_MINUTE;
const BUSY_STARTS_SECOND = 30;
const INTERVALS = [
  { tf: '1m', minutes: 1 },
  { tf: '5m', minutes: 5 },
  { tf: '15m', minutes: 15 },
  { tf: '1h', minutes: 60 },
];
const tile = { layoutId: 'default', tileId: 'chart-1' };
const report: Record<string, unknown> = { build: name };
const failures: string[] = [];

function step(label: string, answer: Answer): Answer {
  report[label] = answer;
  if ('refused' in answer) failures.push(`${label} refused: ${answer.refused}`);
  return answer;
}

function cvd(tf: string, to?: number) {
  return { indicator: 'delta', inputs: {}, instrument: 'NQ', tf, limit: 20, ...(to === undefined ? {} : { to }) };
}

async function shootPane(sim: Sim, page: Page, scene: string, tf: string): Promise<void> {
  step(`${scene} chart.set_timeframe ${tf}`, await sim.tool('chart.set_timeframe', { ...tile, tf }));
  const region = page.getByRole('region', { name: new RegExp(`^NQ \\S+ ${tf}$`) }).first();
  await region.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(12_000);
  step(`${scene} chart.set_viewport ${tf}`, await sim.tool('chart.set_viewport', { ...tile, lastBars: 60 }));
  await page.waitForTimeout(4_000);
  await region.screenshot({ path: join(dir, `${name}-${scene}-${tf}.png`) });
  const legend = await page.locator('[data-layer]').allInnerTexts();
  report[`${scene} legend ${tf}`] = legend;
  const rows = legend.filter((t) => /CVD|Δ/.test(t));
  if (rows.length === 0) failures.push(`${scene} ${tf}: no CVD row in the legend`);
  for (const row of rows) {
    if (/stopped|after to/i.test(row)) failures.push(`${scene} ${tf}: the CVD legend says ${JSON.stringify(row)}`);
    else if (!/\d/.test(row)) failures.push(`${scene} ${tf}: the CVD legend has no value: ${JSON.stringify(row)}`);
  }
}

async function openDesk(sim: Sim): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${sim.origin}/#ticket=${sim.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  step('chart.set_symbol', await sim.tool('chart.set_symbol', { ...tile, instrument: 'NQ' }));
  step('chart.add_layer', await sim.tool('chart.add_layer', { ...tile, kind: 'delta' }));
  return page;
}

async function frozen(): Promise<void> {
  const sim = await startSim('frozen', {});
  try {
    const page = await openDesk(sim);
    for (const { tf, minutes } of INTERVALS) {
      await shootPane(sim, page, 'frozen', tf);
      const span = minutes * NS_PER_MINUTE;
      const lastSettled = Math.floor((FROZEN_SETTLED_NS - 1) / span) * span;
      const computed = step(
        `frozen indicators.compute delta ${tf} to the last settled bar`,
        await sim.tool('indicators.compute', cvd(tf, lastSettled)),
      );
      if ('ok' in computed) {
        const time = (computed.ok as { time?: number[] }).time ?? [];
        if (time.at(-1) !== lastSettled)
          failures.push(`frozen ${tf}: the last CVD bar is ${String(time.at(-1))}, not ${String(lastSettled)}`);
      }
    }
    await page.close();
  } finally {
    sim.stop();
  }
}

async function moving(): Promise<void> {
  const started = Date.now();
  const sim = await startSim('moving', { TESSERA_TEST_MARKET: 'busy' });
  try {
    for (const { tf } of INTERVALS) {
      step(`moving indicators.compute delta ${tf} before the minute turns`, await sim.tool('indicators.compute', cvd(tf)));
    }
    const pastTheMinute = (60 - BUSY_STARTS_SECOND + 8) * 1000 - (Date.now() - started);
    if (pastTheMinute < 0) failures.push('moving: the minute turned before every CVD was read once');
    await new Promise((done) => setTimeout(done, Math.max(0, pastTheMinute)));
    step(
      'moving market.get_candles 1m after the minute turns',
      await sim.tool('market.get_candles', { instrument: 'NQ', tf: '1m', limit: 30 }),
    );
    await new Promise((done) => setTimeout(done, 2_000));
    for (const { tf } of INTERVALS) {
      step(`moving indicators.compute delta ${tf} after the minute turns`, await sim.tool('indicators.compute', cvd(tf)));
    }
    const page = await openDesk(sim);
    await shootPane(sim, page, 'moving', '5m');
    await page.close();
  } finally {
    sim.stop();
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
try {
  await moving();
  await frozen();
  report['failures'] = failures;
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stills and ${name}-report.json in ${dir}`);
  console.log(
    failures.length === 0
      ? `ok: NQ CVD draws and reads on ${INTERVALS.map((i) => i.tf).join(', ')}, frozen and past a minute's turn`
      : failures.join('\n'),
  );
} finally {
  await browser.close();
}
process.exitCode = failures.length === 0 ? 0 : 1;
