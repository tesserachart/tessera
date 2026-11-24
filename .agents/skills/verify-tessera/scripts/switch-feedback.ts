#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/switch-feedback', label = 'this', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const CONNECTION_ROUND_TRIP_MS = 2_000;
const SETTLE_BEFORE_SWITCH_MS = 8_000;
const WATCH_MS = 5_000;
const STILL_AFTER_CLICK_MS = 500;
const TILE = { layoutId: 'default', tileId: 'chart-1' };

const data = mkdtempSync(join(tmpdir(), 'tessera-switch-feedback-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_NO_RITHMIC: '1', TESSERA_TEST_MARKET: 'busy' } },
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
    client: { name: 'switch-feedback', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return (answer.result as { output?: unknown }).output ?? answer.result;
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

interface Frame {
  t: number;
  pressed: string | null;
  skeleton: boolean;
}

async function switchTo(from: string, to: string): Promise<{ firstFrame: Frame | null; frames: Frame[] }> {
  const chart = page.getByRole('region', { name: `NQ Z6 ${from}` });
  const box = await chart.boundingBox();
  const buttons = page.getByRole('group', { name: 'Timeframe' }).getByRole('button', { name: to, exact: true });
  let button = buttons.first();
  for (const b of await buttons.all()) {
    const at = await b.boundingBox();
    if (box && at && at.x >= box.x && at.x < box.x + box.width) button = b;
  }
  const at = await button.boundingBox();
  if (!at || !box) throw new Error(`no ${to} button on the NQ chart`);
  await page.evaluate(
    ({ left, right }) => {
      const w = window as unknown as { switchFrames: Frame[]; switchClick: number | null };
      w.switchFrames = [];
      w.switchClick = null;
      const inTile = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left < right && r.right > left;
      };
      addEventListener('click', (e) => (w.switchClick = e.timeStamp), { capture: true, once: true });
      const tick = () => {
        if (w.switchClick !== null) {
          const pressed = [...document.querySelectorAll('[role=group][aria-label="Timeframe"] [aria-pressed="true"]')]
            .filter(inTile)
            .map((el) => el.textContent)[0];
          const skeleton = [...document.querySelectorAll('[role=status][aria-label="Loading bars"]')].some(inTile);
          w.switchFrames.push({ t: Math.round(performance.now() - w.switchClick), pressed: pressed ?? null, skeleton });
        }
        if (w.switchFrames.length < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { left: box.x, right: box.x + box.width },
  );
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  const clicked = Date.now();
  console.log(`${label} ${from}→${to}: clicked ${((clicked - videoStart) / 1000).toFixed(2)} s into ${label}.webm`);
  await page.waitForTimeout(STILL_AFTER_CLICK_MS);
  await page.screenshot({ path: join(dir, `${label}-${from}-${to}-switching.png`) });
  await page.waitForTimeout(Math.max(0, WATCH_MS - (Date.now() - clicked)));
  const frames = await page.evaluate(() => (window as unknown as { switchFrames: Frame[] }).switchFrames);
  const firstFrame = frames[0] ?? null;
  const ack = frames.find((f) => f.pressed === to);
  const skel = frames.filter((f) => f.skeleton);
  const drawn = skel.length ? frames.find((f) => f.t > skel.at(-1)!.t) : null;
  console.log(
    `${label} ${from}→${to}: first frame after the click at ${String(firstFrame?.t)} ms shows ${String(firstFrame?.pressed)}` +
      `${firstFrame?.skeleton ? ' and the skeleton' : ', no skeleton'}; ${to} pressed from ${String(ack?.t)} ms; ` +
      (skel.length
        ? `skeleton ${String(skel[0]!.t)}–${String(skel.at(-1)!.t)} ms in ${String(skel.length)} frames, bars from ${String(drawn?.t)} ms`
        : 'no skeleton frame'),
  );
  writeFileSync(join(dir, `${label}-${from}-${to}.json`), `${JSON.stringify(frames)}\n`);
  return { firstFrame, frames };
}

try {
  await tool('chart.set_timeframe', { ...TILE, tf: '5m' });
  await tool('chart.add_layer', { ...TILE, kind: 'big_trades' });
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor();
  await page.getByRole('status', { name: 'Loading bars' }).first().waitFor({ state: 'detached', timeout: 60_000 });
  await page.waitForTimeout(SETTLE_BEFORE_SWITCH_MS);
  await page.screenshot({ path: join(dir, `${label}-5m.png`) });
  await switchTo('5m', '1D');
  await page.screenshot({ path: join(dir, `${label}-1D.png`) });
  await switchTo('1D', '15m');
  await switchTo('15m', '5m');
} finally {
  await context.close();
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
  const videos = readdirSync(join(dir, 'video')).filter((f) => f.endsWith('.webm'));
  if (videos[0]) renameSync(join(dir, 'video', videos[0]), join(dir, `${label}.webm`));
  rmSync(join(dir, 'video'), { recursive: true, force: true });
  console.log(`stills, frames and ${label}.webm in ${dir}`);
}
