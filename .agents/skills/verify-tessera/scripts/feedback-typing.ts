#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type CDPSession, type Locator } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/feedback-typing', uiDir, scene = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG_TASK_MS = 50;

const data = mkdtempSync(join(tmpdir(), 'tessera-feedback-typing-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir || join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_NO_RITHMIC: '1', TESSERA_TEST_MARKET: 'busy' } },
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

async function tool<T = unknown>(name: string, input: unknown): Promise<T> {
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
    client: { name: 'feedback-typing', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  const result = answer.result as { ok?: boolean; output?: unknown; error?: { message: string } };
  if (result.ok === false) throw new Error(`${name}: ${result.error?.message ?? 'refused'}`);
  return (result.output ?? result) as T;
}

function outboxFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.split(/[\\/]/).includes('outbox') && f.endsWith('.json'))
    .map((f) => join(root, f));
}

function sentPicture(root: string): { type: string; bytes: Buffer } | null {
  for (const file of outboxFiles(root)) {
    const found = JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))).match(/"screenshot":\{"type":"([^"]+)","data":"([^"]+)"/);
    if (found) return { type: found[1]!, bytes: Buffer.from(found[2]!, 'base64') };
  }
  return null;
}

interface Slow {
  name: string;
  at: number;
  duration: number;
}

function watchMainThread(threshold: number) {
  const w = window as unknown as { __slow: Slow[]; __shots: number; __seen: Set<string> };
  w.__slow = [];
  w.__shots = 0;
  w.__seen = new Set();
  const saw = (img: HTMLImageElement) => {
    const key = `${String(img.src.length)}:${img.src.slice(-64)}`;
    if (w.__seen.has(key)) return;
    w.__seen.add(key);
    w.__shots++;
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__slow.push({ name: 'longtask', at: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: false });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__slow.push({ name: `event:${e.name}`, at: e.startTime, duration: e.duration });
  }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  new MutationObserver((records) => {
    for (const r of records) {
      const nodes = r.type === 'attributes' ? [r.target] : [...r.addedNodes];
      for (const n of nodes) {
        if (n instanceof HTMLImageElement && n.classList.contains('fb-shot')) saw(n);
        if (n instanceof Element) n.querySelectorAll<HTMLImageElement>('img.fb-shot').forEach(saw);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  return threshold;
}

const now = (p: { evaluate: (f: () => number) => Promise<number> }) => p.evaluate(() => performance.now());

interface Window_ {
  from: number;
  to: number;
}

interface Phase {
  name: string;
  window: Window_;
  longTasks: Slow[];
  slowEvents: Slow[];
  longestTask: number;
  longestEvent: number;
  pictures: number;
}

const browser = await chromium.launch({ headless: true });
const phases: Phase[] = [];
const failures: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  const workspace = page.getByRole('main', { name: 'Workspace' });
  for (let i = 0; i < 120; i++) {
    const accept = page.getByRole('button', { name: /^(Accept|Continue)$/ });
    if (await accept.isVisible().catch(() => false)) await accept.click();
    else if (await workspace.isVisible().catch(() => false)) break;
    await sleep(500);
  }
  await workspace.waitFor({ timeout: 60_000 });

  await tool('settings.set', {
    key: 'agent.providers',
    value: {
      'claude-code': { enabled: true, binaryPath: join(repo, '.agents/skills/verify-tessera/scripts/stand-in-claude.mjs') },
    },
  });
  await tool('agent.list_providers', { recheck: true });

  interface Listed {
    tiles: { kind: string; tileId: string; title: string; visible: boolean }[];
  }
  const shown = async () => (await tool<Listed>('workspace.list_tiles', {})).tiles.filter((t) => t.visible);
  const ensure = async (has: (t: Listed['tiles'][number]) => boolean, input: unknown) => {
    for (let i = 0; i < 6; i++) {
      const tile = (await shown()).find(has);
      if (tile) return tile;
      await tool('workspace.open_tile', input);
      await sleep(1_500);
    }
    throw new Error(`could not open ${JSON.stringify(input)}`);
  };
  await tool('chart.set_symbol', { layoutId: 'default', tileId: 'chart-1', instrument: 'ES' });
  await ensure((t) => t.kind === 'chart' && t.title.startsWith('NQ'), { kind: 'chart', instrument: 'NQ' });
  await ensure((t) => t.kind === 'dom', { kind: 'dom', instrument: 'ES' });
  await ensure((t) => t.kind === 'tape', { kind: 'tape', instrument: 'ES' });
  const charts = (await shown()).filter((t) => t.kind === 'chart');
  for (const chart of charts) {
    await tool('chart.set_timeframe', { layoutId: 'default', tileId: chart.tileId, tf: '1m' });
    await tool('chart.add_layer', { layoutId: 'default', tileId: chart.tileId, kind: 'footprint' });
  }
  await sleep(15_000);
  const kinds = (await shown()).map((t) => t.kind);
  const states = await Promise.all(charts.map((c) => tool('chart.get_state', { layoutId: 'default', tileId: c.tileId })));
  writeFileSync(join(dir, `${scene}-charts.json`), JSON.stringify(states, null, 2));
  const footprints = states.map((state) => JSON.stringify(state).includes('"footprint"'));
  if (!kinds.includes('dom') || !kinds.includes('tape') || footprints.filter(Boolean).length < 2) {
    throw new Error(`the busy desk is incomplete: ${kinds.join(', ')}`);
  }
  const tiles = await tool('workspace.list_tiles', {});
  writeFileSync(join(dir, `${scene}-tiles.json`), JSON.stringify(tiles, null, 2));
  await page.screenshot({ path: join(dir, `${scene}-desk.png`) });

  await page.evaluate(watchMainThread, LONG_TASK_MS);
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

  const sheet = page.getByRole('dialog', { name: 'Send feedback' });
  const phase = async (name: string, run: () => Promise<void>) => {
    await cdp.send('Profiler.start');
    const before = await page.evaluate(() => (window as unknown as { __shots: number }).__shots);
    const from = await now(page);
    await run();
    const to = await now(page);
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(join(dir, `${scene}-${name}.cpuprofile`), JSON.stringify(profile));
    const all = await page.evaluate(() => (window as unknown as { __slow: Slow[] }).__slow);
    const after = await page.evaluate(() => (window as unknown as { __shots: number }).__shots);
    const inside = all.filter((s) => s.at >= from && s.at <= to);
    const longTasks = inside.filter((s) => s.name === 'longtask');
    const slowEvents = inside.filter((s) => s.name !== 'longtask');
    const p: Phase = {
      name,
      window: { from, to },
      longTasks,
      slowEvents,
      longestTask: Math.max(0, ...longTasks.map((s) => s.duration)),
      longestEvent: Math.max(0, ...slowEvents.map((s) => s.duration)),
      pictures: after - before,
    };
    phases.push(p);
    console.info(
      `${name}: ${String(longTasks.length)} long tasks (longest ${p.longestTask.toFixed(0)} ms), ` +
        `${String(slowEvents.length)} input events over 16 ms (longest ${p.longestEvent.toFixed(0)} ms), ` +
        `${String(p.pictures)} picture renders, over ${(to - from).toFixed(0)} ms`,
    );
  };
  const typeInto = async (field: Locator, text: string) => {
    await field.click();
    await page.keyboard.type(text, { delay: 40 });
  };

  await phase('open-and-type', async () => {
    await page.locator('[data-feedback-entry]').click();
    await typeInto(
      sheet.getByRole('textbox', { name: 'Your note' }),
      'The stop line jumped back after I dragged it on the NQ chart, twice in a row.',
    );
    await page.waitForFunction(() => document.querySelector('[data-feedback-item="screenshot"] img.fb-shot') !== null, null, {
      polling: 500,
      timeout: 120_000,
    });
  });

  await sheet.getByRole('button', { name: /Write it up for me/ }).click();
  const title = sheet.getByRole('textbox', { name: 'Title' });
  await title.waitFor({ timeout: 60_000 });
  await sleep(1_000);

  await phase('type-title-and-steps', async () => {
    await title.fill('');
    await typeInto(title, 'Stop line jumps back after a drag on NQ');
    const steps = sheet.getByRole('textbox', { name: 'Steps, one a line' });
    await steps.fill('');
    await typeInto(steps, 'Open NQ 1m\nPlace a stop\nDrag it up two ticks\nLet go\nWatch it snap back to where it was before\nTry again with a limit order instead\nSame thing happens');
  });

  await page.screenshot({ path: join(dir, `${scene}-written.png`) });
  const pictured = await sheet.getByText(/This window, \d+×\d+/).count();
  if (pictured !== 1) failures.push('the picture line is not shown');
  const shot = sheet.locator('img.fb-shot');
  if ((await shot.count()) !== 1) failures.push('the picture is not shown');
  else {
    const size = await shot.evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, h: img.naturalHeight }));
    if (size.w < 100 || size.h < 100) failures.push(`the picture is ${String(size.w)}×${String(size.h)}`);
    console.info(`picture shown at ${String(size.w)}×${String(size.h)}: ${await sheet.getByText(/This window, \d+×\d+/).innerText()}`);
  }
  await sheet.getByRole('button', { name: /^Send/ }).click();
  await sheet.locator('[data-feedback-sent]').waitFor({ timeout: 60_000 });
  const sent = sentPicture(data);
  if (!sent) failures.push('the sent report has no picture');
  else {
    const png = sent.type === 'image/png';
    writeFileSync(join(dir, `${scene}-sent.${png ? 'png' : 'jpg'}`), sent.bytes);
    const dims = png ? `${String(sent.bytes.readUInt32BE(16))}×${String(sent.bytes.readUInt32BE(20))}` : 'jpeg';
    console.info(`sent picture: ${sent.type} ${dims}, ${String(Math.round(sent.bytes.length / 1024))} KB`);
  }
  const typing = phases.find((p) => p.name === 'type-title-and-steps')!;
  if (typing.longestTask > LONG_TASK_MS) failures.push(`typing the title and steps had a ${typing.longestTask.toFixed(0)} ms task`);
  if (typing.pictures > 0) failures.push('the picture was taken again while typing');
  const opening = phases.find((p) => p.name === 'open-and-type')!;
  if (opening.longestTask > LONG_TASK_MS) failures.push(`opening and typing the note had a ${opening.longestTask.toFixed(0)} ms task`);
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
writeFileSync(join(dir, `${scene}-phases.json`), JSON.stringify({ phases, failures }, null, 2));
console.info(failures.length === 0 ? `ok: no task over ${String(LONG_TASK_MS)} ms (evidence in ${dir})` : failures.join('\n'));
process.exitCode = failures.length === 0 ? 0 : 1;
