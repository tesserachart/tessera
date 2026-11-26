#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, webkit, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/feedback-picture', uiDir, scene = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const READY_WITHIN_MS = 2_000;
const UNSUPPORTED = 'gpt-6-astra';

const data = mkdtempSync(join(tmpdir(), 'tessera-feedback-picture-'));
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
    client: { name: 'feedback-picture', version: '0', platform: 'node' },
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

function sentPicture(root: string): Buffer | null {
  for (const f of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!f.split(/[\\/]/).includes('outbox') || !f.endsWith('.json')) continue;
    const found = readFileSync(join(root, f), 'utf8').match(/"screenshot":\{"type":"image\/png","data":"([^"]+)"/);
    if (found) return Buffer.from(found[1]!, 'base64');
  }
  return null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Compared {
  inkTruth: number;
  inkPicture: number;
  meanDiff: number;
  truth: string;
  picture: string;
}

function compare(args: { truth: string; picture: string; box: Box; scale: number }): Promise<Compared> {
  const load = (b64: string) =>
    new Promise<HTMLImageElement>((done, fail) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = fail;
      img.src = `data:image/png;base64,${b64}`;
    });
  const crop = (img: HTMLImageElement) => {
    const c = document.createElement('canvas');
    c.width = Math.round(args.box.w * args.scale);
    c.height = Math.round(args.box.h * args.scale);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const sx = img.naturalWidth / window.innerWidth;
    ctx.drawImage(img, args.box.x * sx, args.box.y * sx, args.box.w * sx, args.box.h * sx, 0, 0, c.width, c.height);
    return { c, px: ctx.getImageData(0, 0, c.width, c.height).data };
  };
  const ink = (px: Uint8ClampedArray) => {
    const counts = new Map<number, number>();
    for (let i = 0; i < px.length; i += 4) {
      const key = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const bg = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    const [r, g, b] = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255];
    let inked = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i]! - r) + Math.abs(px[i + 1]! - g) + Math.abs(px[i + 2]! - b) > 60) inked++;
    }
    return inked / (px.length / 4);
  };
  return Promise.all([load(args.truth), load(args.picture)]).then(([t, p]) => {
    const a = crop(t);
    const b = crop(p);
    let diff = 0;
    for (let i = 0; i < a.px.length; i += 4) {
      diff += Math.abs(a.px[i]! - b.px[i]!) + Math.abs(a.px[i + 1]! - b.px[i + 1]!) + Math.abs(a.px[i + 2]! - b.px[i + 2]!);
    }
    return {
      inkTruth: ink(a.px),
      inkPicture: ink(b.px),
      meanDiff: diff / (a.px.length / 4) / 3,
      truth: a.c.toDataURL('image/png').split(',')[1]!,
      picture: b.c.toDataURL('image/png').split(',')[1]!,
    };
  });
}

async function chartBoxes(page: Page): Promise<Box[]> {
  return page.$$eval('.tessera-chart', (els) =>
    els
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 50 && r.height > 50)
      .map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })),
  );
}

const engine = process.env.VERIFY_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ headless: true });
const failures: string[] = [];
const report: Record<string, unknown> = { scene, engine: engine.name() };
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

  const standIn = (name: string) => join(repo, '.agents/skills/verify-tessera/scripts', name);
  await tool('settings.set', {
    key: 'agent.providers',
    value: {
      codex: { enabled: true, binaryPath: standIn('stand-in-codex.mjs'), args: ['--unsupported-model', UNSUPPORTED] },
      'claude-code': { enabled: true, binaryPath: standIn('stand-in-claude.mjs') },
    },
  });
  const providers = await tool<{ providers: { id: string; status: string; models: { id: string }[] }[] }>(
    'agent.list_providers',
    { recheck: true },
  );
  report.providers = providers.providers.map((p) => ({ id: p.id, status: p.status, first: p.models[0]?.id }));
  const started = await tool<{ session: { id: string } }>('agent.start_session', {
    preset: 'Trader',
    provider: 'claude-code',
    title: 'Feedback proof: my analyst runs on Claude',
  });
  await tool('agent.send', { sessionId: started.session.id, text: 'How is NQ doing?' });

  interface Listed {
    tiles: { kind: string; tileId: string; title: string; visible: boolean }[];
  }
  const shown = async () => (await tool<Listed>('workspace.list_tiles', {})).tiles.filter((t) => t.visible);
  const ensure = async (has: (t: Listed['tiles'][number]) => boolean, input: unknown) => {
    for (let i = 0; i < 6; i++) {
      if ((await shown()).some(has)) return;
      await tool('workspace.open_tile', input);
      await sleep(1_500);
    }
    throw new Error(`could not open ${JSON.stringify(input)}`);
  };
  await tool('chart.set_symbol', { layoutId: 'default', tileId: 'chart-1', instrument: 'ES' });
  await ensure((t) => t.kind === 'chart' && t.title.startsWith('NQ'), { kind: 'chart', instrument: 'NQ' });
  await ensure((t) => t.kind === 'dom', { kind: 'dom', instrument: 'ES' });
  await ensure((t) => t.kind === 'tape', { kind: 'tape', instrument: 'ES' });
  for (const chart of (await shown()).filter((t) => t.kind === 'chart')) {
    await tool('chart.set_timeframe', { layoutId: 'default', tileId: chart.tileId, tf: '1m' });
  }
  await sleep(15_000);

  const boxes = await chartBoxes(page);
  if (boxes.length < 2) failures.push(`${String(boxes.length)} charts on the desk`);
  const truth = await page.screenshot();
  writeFileSync(join(dir, `${scene}-window.png`), truth);

  const sheet = page.getByRole('dialog', { name: 'Send feedback' });
  const clickedAt = await page.evaluate(() => performance.now());
  await page.locator('[data-feedback-entry]').click();
  await page.waitForFunction(() => document.querySelector('[data-feedback-item="screenshot"] img.fb-shot') !== null, null, {
    polling: 'raf',
    timeout: 180_000,
  });
  const readyMs = (await page.evaluate(() => performance.now())) - clickedAt;
  report.pictureReadyMs = Math.round(readyMs);
  console.info(`picture ready ${readyMs.toFixed(0)} ms after the click`);
  if (readyMs > READY_WITHIN_MS) failures.push(`the picture took ${readyMs.toFixed(0)} ms`);
  await page.screenshot({ path: join(dir, `${scene}-sheet.png`) });

  await sheet.getByRole('textbox', { name: 'Your note' }).fill('The stop line jumped back after I dragged it on NQ.');
  if (scene === 'pr') {
    const writeUp = sheet.getByRole('button', { name: /Write it up for me/ });
    report.writeUpButton = await writeUp.getAttribute('aria-label').then(async (l) => l ?? (await writeUp.innerText()));
    report.writer = (await tool<{ writer: { provider: string; name: string } | null }>('feedback.context', {})).writer;
    await writeUp.click();
    await sheet.getByRole('textbox', { name: 'Title' }).waitFor({ timeout: 60_000 });
    report.writtenBy = await sheet.locator('[data-feedback-writeup] .fb-note').innerText();
    console.info(`write-up: ${String(report.writtenBy)}`);
    if (!String(report.writtenBy).startsWith('Claude Code')) failures.push(`written up by: ${String(report.writtenBy)}`);
    await page.screenshot({ path: join(dir, `${scene}-written-up.png`) });
  }

  await sheet.getByRole('button', { name: /^Send/ }).click();
  await sheet.locator('[data-feedback-sent]').waitFor({ timeout: 60_000 });
  const sent = sentPicture(data);
  if (!sent) throw new Error('the sent report has no PNG picture');
  writeFileSync(join(dir, `${scene}-sent.png`), sent);

  const charts = [];
  for (const [i, box] of boxes.entries()) {
    const c = await page.evaluate(compare, { truth: truth.toString('base64'), picture: sent.toString('base64'), box, scale: 1 });
    writeFileSync(join(dir, `${scene}-chart-${String(i + 1)}-window.png`), Buffer.from(c.truth, 'base64'));
    writeFileSync(join(dir, `${scene}-chart-${String(i + 1)}-picture.png`), Buffer.from(c.picture, 'base64'));
    const row = { box, inkWindow: c.inkTruth, inkPicture: c.inkPicture, meanDiff: c.meanDiff };
    charts.push(row);
    console.info(
      `chart ${String(i + 1)}: ${(c.inkPicture * 100).toFixed(1)}% drawn in the picture, ` +
        `${(c.inkTruth * 100).toFixed(1)}% on screen, mean difference ${c.meanDiff.toFixed(1)}/255`,
    );
    if (c.inkTruth < 0.02) failures.push(`chart ${String(i + 1)} draws nothing on screen`);
    if (c.inkPicture < c.inkTruth * 0.6) failures.push(`chart ${String(i + 1)} is missing its bars in the picture`);
  }
  report.charts = charts;
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
report.failures = failures;
writeFileSync(join(dir, `${scene}-report.json`), JSON.stringify(report, null, 2));
console.info(failures.length === 0 ? `ok (evidence in ${dir})` : failures.join('\n'));
process.exitCode = failures.length === 0 ? 0 : 1;
