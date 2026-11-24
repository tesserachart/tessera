#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type WebSocketRoute } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/study-warm', uiDir, name = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-study-warm-'));
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

type Answer = { ok: unknown } | { refused: string };

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
    client: { name: 'study-warm', version: '0', platform: 'node' },
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

interface Frame {
  method?: string;
  id?: number;
  params?: { topic?: string; params?: { indicator?: string; instrument?: string; tf?: string } };
}

const cvdSubscribes: { socket: number; at: string; ask: unknown }[] = [];
const cvdSubIds = new Set<string>();
let unsubscribes = 0;
let socket = 0;
let stage = 'open';
const routes = new Set<WebSocketRoute>();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  recordVideo: { dir, size: { width: 1600, height: 1000 } },
});
const page = await context.newPage();
await page.routeWebSocket(/\/ws$/, (ws) => {
  const server = ws.connectToServer();
  const mine = ++socket;
  routes.add(ws);
  const serverIds = new Map<number, string>();
  ws.onMessage((raw) => {
    for (const m of [JSON.parse(String(raw)) as Frame | Frame[]].flat()) {
      if (m.method === 'subscribe' && m.params?.topic === 'indicators.series' && m.params.params?.indicator === 'delta') {
        cvdSubscribes.push({ socket: mine, at: stage, ask: m.params.params });
        if (m.id !== undefined) serverIds.set(m.id, 'cvd');
      }
      if (m.method === 'unsubscribe') {
        const id = (m.params as { subscriptionId?: string } | undefined)?.subscriptionId;
        if (id && cvdSubIds.has(`${String(mine)}:${id}`)) unsubscribes++;
      }
    }
    server.send(raw);
  });
  server.onMessage((raw) => {
    for (const m of [JSON.parse(String(raw)) as { id?: number; result?: { subscriptionId?: string } }].flat()) {
      if (m.id !== undefined && serverIds.get(m.id) === 'cvd' && m.result?.subscriptionId) {
        cvdSubIds.add(`${String(mine)}:${m.result.subscriptionId}`);
      }
    }
    ws.send(raw);
  });
  ws.onClose(() => routes.delete(ws));
  server.onClose(() => void ws.close());
});

const failures: string[] = [];
const report: Record<string, unknown> = { build: name };
const step = (label: string, answer: Answer) => {
  report[label] = answer;
  if ('refused' in answer) failures.push(`${label} refused: ${answer.refused}`);
  return answer;
};

const legends: { at: string; text: string }[] = [];
let watching = true;
const watchLegend = async () => {
  while (watching) {
    const texts = await page
      .locator('[data-layer]')
      .allInnerTexts()
      .catch(() => []);
    for (const text of texts.filter((t) => /CVD/.test(t))) legends.push({ at: stage, text: text.replace(/\s+/g, ' ') });
    await page.waitForTimeout(100).catch(() => undefined);
  }
};

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const one = { layoutId: 'default', tileId: 'chart-1' };
  const two = { layoutId: 'default', tileId: 'chart-2' };
  step('chart-1 NQ', await tool('chart.set_symbol', { ...one, instrument: 'NQ' }));
  step('chart-1 1m', await tool('chart.set_timeframe', { ...one, tf: '1m' }));
  step('chart-2 ES 5m', await tool('chart.set_timeframe', { ...two, tf: '5m' }));
  step('chart-1 CVD', await tool('chart.add_layer', { ...one, kind: 'delta' }));
  await page.waitForTimeout(15_000);
  await page.screenshot({ path: join(dir, `${name}-1-cvd.png`) });
  const legendWatch = watchLegend();

  stage = 'tab switch';
  step('show journal', await tool('ui.show_area', { area: 'journal' }));
  await page.waitForTimeout(3_000);
  step('show desk', await tool('ui.show_area', { area: 'desk' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}-2-tab-back.png`) });
  await page.waitForTimeout(4_000);

  stage = 'reconnect';
  const before = socket;
  for (const ws of [...routes]) await ws.close({ code: 1012, reason: 'cut' });
  for (const end = Date.now() + 30_000; socket === before && Date.now() < end; ) await page.waitForTimeout(100);
  if (socket === before) failures.push('the page did not reconnect');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}-3-reconnected.png`) });
  await page.waitForTimeout(6_000);

  stage = 'second chart';
  step('chart-2 NQ', await tool('chart.set_symbol', { ...two, instrument: 'NQ' }));
  step('chart-2 1m', await tool('chart.set_timeframe', { ...two, tf: '1m' }));
  step('chart-2 CVD', await tool('chart.add_layer', { ...two, kind: 'delta' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}-4-second-chart.png`) });
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: join(dir, `${name}-5-end.png`) });
  watching = false;
  await legendWatch;

  const blank = legends.filter((l) => !/CVD\s*[-−+]?\d/.test(l.text));
  report['CVD subscriptions'] = cvdSubscribes;
  report['CVD subscriptions let go'] = unsubscribes;
  report['CVD legends without a value'] = blank;
  report['CVD legend samples'] = legends.length;
  const opened = cvdSubscribes.filter((s) => s.socket === 1).length;
  const carried = cvdSubscribes.filter((s) => s.socket > 1).length;
  console.log(`CVD subscribed on the first socket: ${String(opened)}`);
  console.log(`CVD subscribed after the reconnect (the client carrying its subscriptions over): ${String(carried)}`);
  console.log(`CVD subscriptions let go: ${String(unsubscribes)}`);
  console.log(`CVD legend samples: ${String(legends.length)}, without a value: ${String(blank.length)}`);
  if (opened !== 1) failures.push(`CVD was subscribed ${String(opened)} times before the reconnect`);
  if (carried !== 1) failures.push(`the reconnect subscribed CVD ${String(carried)} times`);
  if (unsubscribes !== 0) failures.push(`CVD was let go ${String(unsubscribes)} times`);
  if (blank.length > 0) failures.push(`the CVD legend lost its value ${String(blank.length)} times`);
  report['failures'] = failures;
  writeFileSync(join(dir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stills, video and ${name}-report.json in ${dir}`);
  console.log(failures.length === 0 ? 'ok: one CVD computation, never blank' : failures.join('\n'));
} finally {
  watching = false;
  await context.close();
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
process.exitCode = failures.length === 0 ? 0 : 1;
