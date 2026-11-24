#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/delta-renko', label = 'pr', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SETTLE_MS = 2_500;
const PICKS = [
  { name: /300 delta/, interval: '300Δ', bars: { kind: 'delta', size: 300 } },
  { name: /10 ticks renko/, interval: '10Rk', bars: { kind: 'renko', size: 10 } },
] as const;

const data = mkdtempSync(join(tmpdir(), 'tessera-delta-renko-'));
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

async function tool(name: string, input: unknown): Promise<{ output?: unknown; error?: unknown }> {
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
    client: { name: 'delta-renko', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) return { error: answer.error };
  return answer.result as { output?: unknown; error?: unknown };
}

function save(name: string, value: unknown): void {
  writeFileSync(join(dir, `${label}-${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

type Row = [number, number, number, number, number, number, number];

function check(kind: string, size: number, rows: Row[], open: boolean): string {
  const closed = open ? rows.slice(0, -1) : rows;
  if (kind === 'renko') {
    const tick = 0.25;
    const bodies = new Set(closed.map((r) => Math.abs(r[4] - r[1]) / tick));
    const ordered = rows.every((r, i) => i === 0 || r[0] > rows[i - 1]![0]);
    const empty = closed.filter((r) => r[5] === 0).length;
    const wicked = closed.filter((r) => r[2] !== Math.max(r[1], r[4]) || r[3] !== Math.min(r[1], r[4])).length;
    return `${String(rows.length)} bricks; finished bodies in ticks ${[...bodies].join(',')}; finished with wicks ${String(wicked)}; times strictly rising ${String(ordered)}; ${String(empty)} jumped bricks with no volume`;
  }
  if (kind === 'delta') {
    const deltas = closed.map((r) => Math.abs(2 * r[6] - r[5]));
    const under = deltas.filter((d) => d < size).length;
    return `${String(rows.length)} bars; closed bars under ${String(size)} net delta: ${String(under)} (session ends, or prints with no side); min |delta| ${String(Math.min(...deltas))}`;
  }
  return `${String(rows.length)} bars`;
}

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=2'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page: Page = await context.newPage();

function nqChart(): Locator {
  return page.getByRole('region', { name: /^NQ Z6 / });
}

async function insideChart(candidates: Locator): Promise<Locator> {
  const box = await nqChart().boundingBox();
  for (const c of await candidates.all()) {
    const at = await c.boundingBox();
    if (box && at && at.x >= box.x && at.x < box.x + box.width && at.y >= box.y - 60) return c;
  }
  return candidates.first();
}

async function openMenu(): Promise<void> {
  await (await insideChart(page.getByRole('button', { name: 'All intervals' }))).click();
  await page.getByRole('menu').first().waitFor();
}

async function shownOn(interval: string): Promise<void> {
  await page.getByRole('region', { name: `NQ Z6 ${interval}` }).waitFor({ timeout: 20_000 });
  await page
    .getByRole('status', { name: 'Loading bars' })
    .first()
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

try {
  const report: Record<string, string> = {};
  for (const bars of [
    { kind: 'tick', size: 500 },
    { kind: 'range', size: 10 },
    { kind: 'volume', size: 1000 },
    ...PICKS.map((p) => p.bars),
  ]) {
    const r = await tool('market.get_print_bars', { instrument: 'NQ', bars });
    save(`print-bars-${bars.kind}-${String(bars.size)}`, r);
    const o = r.output as { candles?: Row[]; lastBarOpen?: boolean } | undefined;
    report[`market.get_print_bars ${bars.kind} ${String(bars.size)}`] = r.error
      ? `refused: ${JSON.stringify(r.error)}`
      : check(bars.kind, bars.size, o?.candles ?? [], o?.lastBarOpen ?? false);
  }

  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await shownOn('5m');
  await openMenu();
  const menu = page.getByRole('menu').first();
  await menu.evaluate((m) => (m.scrollTop = m.scrollHeight));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${label}-menu.png`) });
  await page.keyboard.press('Escape');

  for (const p of PICKS) {
    await openMenu();
    const item = page.getByRole('menuitemradio', { name: p.name });
    if ((await item.count()) === 0) {
      report[`menu ${p.interval}`] = 'not in the menu';
      await page.keyboard.press('Escape');
      continue;
    }
    await item.click();
    await shownOn(p.interval);
    await page.screenshot({ path: join(dir, `${label}-chart-${p.bars.kind}.png`) });
    const box = await nqChart().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
      for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -240);
      await page.waitForTimeout(600);
      await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.5);
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(dir, `${label}-chart-${p.bars.kind}-hover.png`) });
    }
    const layout = await tool('layout.get', { layoutId: 'default' });
    save(`layout-${p.bars.kind}`, layout);
    const charts = JSON.stringify(layout.output ?? layout);
    report[`menu ${p.interval}`] = charts.includes(`"kind":"${p.bars.kind}"`)
      ? `chart on ${p.interval}, layout printBars ${p.bars.kind}`
      : 'layout does not name it';
  }
  save('report', report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  runtime.kill();
  rmSync(data, { recursive: true, force: true });
}
