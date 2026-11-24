#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Locator, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/tick-gaps', uiDir, build = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SATURDAY = '2026-10-03T12:00:00-04:00';
const newYork = (day: number, hour: number, minute = 0) =>
  Date.UTC(2026, day > 20 ? 8 : 9, day, hour + 4, minute) * 1e6;
const at = (day: number, hour: number, minute = 0) =>
  `2026-${day > 20 ? '09' : '10'}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-04:00`;
const STORED = [
  [at(30, 18), at(1, 17)],
  [at(1, 18), at(2, 10, 0)],
  [at(2, 10, 3), at(2, 17)],
]
  .map(([from, to]) => `${from}/${to}`)
  .join(',');
const VIEW = { from: newYork(2, 9, 40), to: newYork(2, 10, 25) };
const HOLD_MS = 6_000;
const SETTLE_MS = 12_000;
const FLOW_TOOLS = new Set(['market.get_footprint', 'market.get_volume_profile', 'market.get_big_trades']);

interface Ready {
  port: number;
  token: string;
  ticket: string;
}

async function start(env: Record<string, string>): Promise<{ ready: Ready; stop: () => void }> {
  const data = mkdtempSync(join(tmpdir(), 'tessera-tick-gaps-'));
  const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
  const runtime = spawn(
    bin,
    ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        TESSERA_TEST_TRADES: 'replay',
        TESSERA_TEST_NOW: SATURDAY,
        TESSERA_TEST_STORED: STORED,
        TESSERA_NO_RITHMIC: '1',
        ...env,
      },
    },
  );
  const ready = await new Promise<Ready>((done, fail) => {
    runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
    const seen: Partial<Ready> = {};
    createInterface({ input: runtime.stdout }).on('line', (line) => {
      try {
        Object.assign(seen, JSON.parse(line) as object);
      } catch {
        return;
      }
      if (seen.port && seen.token && seen.ticket) done(seen as Ready);
    });
  });
  return {
    ready,
    stop: () => {
      runtime.kill('SIGTERM');
      rmSync(data, { recursive: true, force: true });
    },
  };
}

async function tool(ready: Ready, name: string, input: unknown): Promise<unknown> {
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
    client: { name: 'tick-gaps', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

function settledOf(result: unknown): boolean {
  const r = result as { filling?: boolean; output?: { filling?: boolean } } | null;
  return (r?.filling ?? r?.output?.filling) === false;
}

async function scene(name: 'replayed' | 'refused'): Promise<void> {
  const { ready, stop } = await start(name === 'refused' ? { TESSERA_TEST_REPLAY: 'refuse' } : {});
  const gate = { holding: false, held: [] as string[] };
  let toPage: ((m: string) => void) | null = null;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    const page: Page = await context.newPage();
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      const tools = new Map<number, string>();
      toPage = (m) => ws.send(m);
      ws.onMessage((m) => {
        try {
          const sent = JSON.parse(String(m)) as { id?: number; method?: string; params?: { name?: string } };
          if (sent.method === 'tools.invoke' && sent.id !== undefined && sent.params?.name)
            tools.set(sent.id, sent.params.name);
        } catch {
          server.send(m);
          return;
        }
        server.send(m);
      });
      server.onMessage((m) => {
        try {
          const answer = JSON.parse(String(m)) as { id?: number; result?: unknown };
          const tool = answer.id === undefined ? undefined : tools.get(answer.id);
          if (gate.holding && tool && FLOW_TOOLS.has(tool) && settledOf(answer.result)) {
            gate.held.push(String(m));
            return;
          }
        } catch {
          ws.send(m);
          return;
        }
        ws.send(m);
      });
    });
    const tile = { layoutId: 'default', tileId: 'chart-1' };
    const still = (chart: Locator, shot: string) => chart.screenshot({ path: join(dir, `${build}-${name}-${shot}.png`) });
    const save = (file: string, value: unknown) =>
      writeFileSync(join(dir, `${build}-${name}-${file}.json`), `${JSON.stringify(value, null, 2)}\n`);

    await page.goto(`http://127.0.0.1:${String(ready.port)}/#ticket=${ready.ticket}`);
    await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
    await page.getByRole('toolbar', { name: 'Chart' }).first().getByRole('button', { name: 'Maximise' }).click();
    await tool(ready, 'chart.set_timeframe', { ...tile, tf: '1m' });
    const chart = page.getByRole('region', { name: 'NQ Z6 1m' });
    await chart.waitFor();
    const loading = chart.getByRole('status', { name: 'Loading bars' });
    await loading.waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined);
    await loading.waitFor({ state: 'detached', timeout: 60_000 });
    await tool(ready, 'chart.set_viewport', { ...tile, ...VIEW });
    await page.waitForTimeout(2_000);

    gate.holding = name === 'replayed';
    for (const kind of ['footprint', 'volume_profile', 'big_trades'])
      await tool(ready, 'chart.add_layer', { ...tile, kind });
    await tool(ready, 'chart.set_viewport', { ...tile, ...VIEW });
    if (gate.holding) {
      await page.waitForTimeout(HOLD_MS);
      await still(chart, 'filling');
      console.log(`${name}: held ${String(gate.held.length)} settled answers`);
      gate.holding = false;
      for (const m of gate.held.splice(0)) toPage?.(m);
    }
    await page.waitForTimeout(SETTLE_MS);
    await tool(ready, 'chart.set_viewport', { ...tile, ...VIEW });
    await page.waitForTimeout(2_000);
    await still(chart, 'settled');
    const box = await chart.boundingBox();
    if (box)
      await page.screenshot({
        path: join(dir, `${build}-${name}-axis.png`),
        clip: { x: box.x, y: box.y + box.height - 160, width: box.width, height: 160 },
      });
    save(
      'footprint',
      await tool(ready, 'market.get_footprint', {
        instrument: 'NQZ6.CME',
        tf: '1m',
        from: VIEW.from,
        to: VIEW.to,
        limit: 100,
      }),
    );
  } finally {
    await browser.close();
    stop();
  }
}

await scene('replayed');
await scene('refused');
console.log(`stills in ${dir}`);
