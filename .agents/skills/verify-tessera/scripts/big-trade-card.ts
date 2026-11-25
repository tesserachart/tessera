#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/big-trade-card', uiDir, tag = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const newYork = (hour: number, minute: number) => Date.UTC(2026, 9, 2, hour + 4, minute) * 1e6;
const TO = newYork(14, 40);
const VIEWS = [
  { name: 'in', from: newYork(14, 22), window: { width: 1600, height: 1000 } },
  { name: 'mid', from: newYork(14, 0), window: { width: 1600, height: 1000 } },
  { name: 'out', from: newYork(12, 40), window: { width: 1600, height: 1000 } },
  { name: 'narrow', from: newYork(14, 22), window: { width: 760, height: 620 } },
  { name: 'tiny', from: newYork(14, 0), window: { width: 480, height: 560 } },
] as const;

interface Disc {
  x: number;
  y: number;
  r: number;
}

interface Check {
  view: string;
  edge: string;
  bubble: Disc;
  tip: { x: number; y: number; w: number; h: number } | null;
  chart: { x: number; y: number; w: number; h: number };
  lines: number;
  wrapped: number;
  clipped: number;
  insideChart: boolean;
  coversBubble: boolean;
  ok: boolean;
}

const data = mkdtempSync(join(tmpdir(), 'tessera-big-trade-card-'));
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
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_TEST_TRADES: 'replay', TESSERA_NO_RITHMIC: '1' } },
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

async function tool(name: string, input: unknown): Promise<unknown> {
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
    client: { name: 'big-trade-card', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

function discs(withBubbles: Buffer, without: Buffer): Disc[] {
  const a = PNG.sync.read(withBubbles);
  const b = PNG.sync.read(without);
  const { width, height } = a;
  const on = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const d =
      Math.abs(a.data[i * 4]! - b.data[i * 4]!) +
      Math.abs(a.data[i * 4 + 1]! - b.data[i * 4 + 1]!) +
      Math.abs(a.data[i * 4 + 2]! - b.data[i * 4 + 2]!);
    on[i] = d > 24 ? 1 : 0;
  }
  const found: Disc[] = [];
  const stack: number[] = [];
  for (let start = 0; start < on.length; start++) {
    if (!on[start]) continue;
    on[start] = 0;
    stack.push(start);
    let [x0, y0, x1, y1, n] = [width, height, 0, 0, 0];
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      n++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= on.length || !on[j]) continue;
        if (Math.abs((j % width) - x) > 1) continue;
        on[j] = 0;
        stack.push(j);
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const round = n / (w * h) >= 0.55 && Math.max(w, h) <= 1.5 * Math.min(w, h);
    if (n >= 16 && w <= 64 && h <= 64 && round)
      found.push({ x: (x0 + x1 + 1) / 2, y: (y0 + y1 + 1) / 2, r: Math.max(w, h) / 2 });
  }
  return found;
}

function covers(tip: { x: number; y: number; w: number; h: number }, b: Disc): boolean {
  const cx = Math.max(tip.x, Math.min(tip.x + tip.w, b.x));
  const cy = Math.max(tip.y, Math.min(tip.y + tip.h, b.y));
  return Math.hypot(b.x - cx, b.y - cy) < b.r - 1;
}

async function shown(page: Page): Promise<boolean> {
  return page
    .locator('.chart-bubble-tip[data-open="true"]')
    .waitFor({ timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
}

async function readTip(page: Page) {
  return page.evaluate(() => {
    const tip = document.querySelector<HTMLElement>('.chart-bubble-tip[data-open="true"]');
    if (!tip) return null;
    const r = tip.getBoundingClientRect();
    const host = tip.parentElement!.getBoundingClientRect();
    const lines = [...tip.querySelectorAll<HTMLElement>('.bt-card-head, .bt-card-detail, .bt-card-rows > *')];
    const lineHeight = (el: HTMLElement) => parseFloat(getComputedStyle(el).lineHeight) || el.offsetHeight;
    const clipped = [tip, ...tip.querySelectorAll<HTMLElement>('*')].filter(
      (el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== 'inline',
    ).length;
    return {
      tip: { x: r.x - host.x, y: r.y - host.y, w: r.width, h: r.height },
      lines: lines.length,
      wrapped: lines.filter((el) => el.getBoundingClientRect().height > lineHeight(el) * 1.5).length,
      clipped,
    };
  });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: VIEWS[0].window, deviceScaleFactor: 2 });
const page = await context.newPage();
const checks: Check[] = [];

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const tile = { layoutId: 'default', tileId: 'chart-1' };
  await tool('chart.set_timeframe', { ...tile, tf: '1m' });
  const chart: Locator = page.getByRole('region', { name: 'NQ Z6 1m' });
  await chart.waitFor();
  await chart.getByRole('status', { name: 'Loading bars' }).waitFor({ state: 'detached', timeout: 60_000 });
  await tool('chart.add_layer', { ...tile, kind: 'footprint' });
  await tool('chart.add_layer', { ...tile, kind: 'big_trades' });
  await tool('chart.update_layer', {
    ...tile,
    layerId: 'big_trades-1',
    params: { inputs: { size: 'auto', tier: 'low', showSize: true } },
  });
  const settled = async (from: number) => {
    for (let waited = 0; waited < 180; waited++) {
      const read = (await tool('market.get_big_trades', { instrument: 'NQZ6.CME', from, to: TO })) as {
        output?: { filling?: boolean; rule?: { cuts?: unknown } };
      };
      if (read.output?.filling === false && read.output.rule?.cuts != null) return page.waitForTimeout(4_000);
      await page.waitForTimeout(1_000);
    }
    throw new Error('the big trades never settled');
  };
  await chart.getByRole('button', { name: 'Maximise' }).click();
  await page.waitForTimeout(1_000);
  const chartBox = async () => {
    const boxes = await page.locator('.chart-trade:has(.chart-bubble-tip)').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    return boxes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  };
  for (const view of VIEWS) {
    await tool('chart.set_viewport', { ...tile, from: view.from, to: TO });
    await settled(view.from);
    await page.waitForTimeout(15_000);
  }
  for (const view of VIEWS) {
    await page.setViewportSize(view.window);
    await tool('chart.set_viewport', { ...tile, from: view.from, to: TO });
    await settled(view.from);
    await page.mouse.move(1, 1);
    await page.waitForTimeout(600);
    const box = await chartBox();
    const shot = () => page.screenshot({ clip: box, scale: 'css' });
    const withBubbles = await shot();
    await tool('chart.update_layer', { ...tile, layerId: 'big_trades-1', visible: false });
    await page.waitForTimeout(800);
    const without = await shot();
    await tool('chart.update_layer', { ...tile, layerId: 'big_trades-1', visible: true });
    await page.waitForTimeout(800);
    const found = discs(withBubbles, without);
    if (found.length === 0) throw new Error(`no bubbles in view ${view.name}`);
    const pick = (edge: string, score: (d: Disc) => number) => ({
      edge,
      d: found.reduce((a, b) => (score(b) > score(a) ? b : a)),
    });
    const picks = [
      pick('right', (d) => d.x),
      pick('left', (d) => -d.x),
      pick('top', (d) => -d.y),
      pick('bottom', (d) => d.y),
      pick('top-right', (d) => d.x - d.y),
      pick('biggest', (d) => d.r),
    ];
    for (const { edge, d } of picks) {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(500);
      await page.mouse.move(box.x + d.x, box.y + d.y);
      const read = (await shown(page)) ? await readTip(page) : null;
      const chartBox = { x: 0, y: 0, w: box.width, h: box.height };
      const tip = read?.tip ?? null;
      const insideChart =
        !!tip && tip.x >= 0 && tip.y >= 0 && tip.x + tip.w <= box.width && tip.y + tip.h <= box.height;
      const coversBubble = !!tip && covers(tip, d);
      const check: Check = {
        view: view.name,
        edge,
        bubble: d,
        tip,
        chart: chartBox,
        lines: read?.lines ?? 0,
        wrapped: read?.wrapped ?? 0,
        clipped: read?.clipped ?? 0,
        insideChart,
        coversBubble,
        ok: !!tip && insideChart && !coversBubble && (read?.clipped ?? 1) === 0,
      };
      checks.push(check);
      await page.screenshot({ path: join(dir, `${tag}-${view.name}-${edge}.png`), clip: box });
      console.log(
        `${check.ok ? 'ok  ' : 'FAIL'} ${view.name.padEnd(6)} ${edge.padEnd(9)} bubble ${d.x.toFixed(0)},${d.y.toFixed(0)} r${d.r.toFixed(1)}  ` +
          (tip
            ? `card ${tip.w.toFixed(0)}x${tip.h.toFixed(0)} at ${tip.x.toFixed(0)},${tip.y.toFixed(0)}  lines ${String(check.lines)} wrapped ${String(check.wrapped)} clipped ${String(check.clipped)} inside ${String(insideChart)} covers ${String(coversBubble)}`
            : 'no card'),
      );
    }
  }
  writeFileSync(join(dir, `${tag}-checks.json`), JSON.stringify(checks, null, 2));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`${String(checks.length - failed)}/${String(checks.length)} ok; stills in ${dir}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
