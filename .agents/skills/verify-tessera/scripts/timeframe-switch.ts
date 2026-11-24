#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/timeframe-switch', label = 'this', uiDir, candlesOut] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const CONNECTION_ROUND_TRIP_MS = 2_000;
const SETTLE_BEFORE_SWITCH_MS = 8_000;
const WATCH_MS = 4_000;
const FIXTURE_READS = [
  { tf: '1m', limit: 600 },
  { tf: '5m', limit: 120 },
  { tf: '15m', limit: 40 },
] as const;

const data = mkdtempSync(join(tmpdir(), 'tessera-tf-switch-'));
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
    client: { name: 'timeframe-switch', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return (answer.result as { output?: unknown }).output ?? answer.result;
}

async function writeCandles(path: string, instrument: string): Promise<void> {
  const reads: Record<string, unknown> = {};
  for (const r of FIXTURE_READS) reads[r.tf] = await tool('market.get_candles', { instrument, tf: r.tf, limit: r.limit });
  writeFileSync(path, `${JSON.stringify({ instrument, reads })}\n`);
  console.log(`candles of ${instrument} in ${path}`);
}

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  recordVideo: { dir: join(dir, 'video'), size: { width: 1600, height: 1000 } },
});
const page: Page = await context.newPage();
const videoStart = Date.now();
await page.routeWebSocket(/\/ws/, (ws) => {
  const server = ws.connectToServer();
  const throughConnection = new Set<number>();
  ws.onMessage((m) => {
    try {
      const sent = JSON.parse(String(m)) as {
        id?: number;
        method?: string;
        params?: { name?: string; input?: { cachedOnly?: boolean } };
      };
      if (
        sent.method === 'tools.invoke' &&
        sent.id !== undefined &&
        sent.params?.name === 'market.get_candles' &&
        !sent.params.input?.cachedOnly
      )
        throughConnection.add(sent.id);
    } catch {
      server.send(m);
      return;
    }
    server.send(m);
  });
  server.onMessage((m) => {
    let id: number | undefined;
    try {
      id = (JSON.parse(String(m)) as { id?: number }).id;
    } catch {
      id = undefined;
    }
    if (id !== undefined && throughConnection.delete(id)) {
      setTimeout(() => ws.send(m), CONNECTION_ROUND_TRIP_MS);
      return;
    }
    ws.send(m);
  });
});

async function watchFrames(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { tfFrames: { t: number; loading: boolean }[] };
    w.tfFrames = [];
    const start = performance.now();
    const tick = () => {
      w.tfFrames.push({
        t: Math.round(performance.now() - start),
        loading: [...document.querySelectorAll('[role=status][aria-label="Loading bars"]')].some((el) => {
          const r = el.getBoundingClientRect();
          const head = document.querySelector('[role=region][aria-label^="NQ Z6 "]')?.getBoundingClientRect();
          return !!head && r.width > 0 && r.left < head.right && r.right > head.left;
        }),
      });
      if (performance.now() - start < 4_500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function switchTo(tf: string): Promise<void> {
  const chart = page.getByRole('region', { name: /^NQ Z6 / });
  const box = await chart.boundingBox();
  const buttons = page.getByRole('group', { name: 'Timeframe' }).getByRole('button', { name: tf, exact: true });
  let button = buttons.first();
  for (const b of await buttons.all()) {
    const at = await b.boundingBox();
    if (box && at && at.x >= box.x && at.x < box.x + box.width) button = b;
  }
  await watchFrames();
  await button.click();
  const clicked = Date.now();
  console.log(`${label} 1m→${tf}: clicked ${((clicked - videoStart) / 1000).toFixed(2)} s into ${label}.webm`);
  await page.getByRole('region', { name: `NQ Z6 ${tf}` }).waitFor({ timeout: 5_000 });
  await page.waitForTimeout(Math.max(0, WATCH_MS - (Date.now() - clicked)));
  const frames = await page.evaluate(
    () => (window as unknown as { tfFrames: { t: number; loading: boolean }[] }).tfFrames,
  );
  const loadingFrames = frames.filter((f) => f.loading);
  console.log(
    `${label} 1m→${tf}: ${String(frames.length)} frames watched, "Loading bars" in ${String(loadingFrames.length)}` +
      (loadingFrames.length ? ` (${String(loadingFrames[0]!.t)}–${String(loadingFrames.at(-1)!.t)} ms)` : ''),
  );
}

try {
  const layout = (await tool('layout.get', { layoutId: 'default' })) as {
    tiles?: { id?: string; chart?: { instrument?: string } }[];
  };
  const instrument = JSON.stringify(layout).match(/"instrument":"([^"]+)"/)?.[1] ?? 'NQ';
  if (candlesOut) await writeCandles(resolve(candlesOut), instrument);
  await tool('chart.set_timeframe', { layoutId: 'default', tileId: 'chart-1', tf: '1m' });
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const one = page.getByRole('region', { name: 'NQ Z6 1m' });
  await one.waitFor();
  await page.getByRole('status', { name: 'Loading bars' }).first().waitFor({ state: 'detached', timeout: 60_000 });
  await page.waitForTimeout(SETTLE_BEFORE_SWITCH_MS);
  await page.screenshot({ path: join(dir, `${label}-1m.png`) });
  await switchTo('5m');
  await switchTo('15m');
} finally {
  await context.close();
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
  const videos = readdirSync(join(dir, 'video')).filter((f) => f.endsWith('.webm'));
  if (videos[0]) renameSync(join(dir, 'video', videos[0]), join(dir, `${label}.webm`));
  rmSync(join(dir, 'video'), { recursive: true, force: true });
  console.log(`stills and ${label}.webm in ${dir}`);
}
