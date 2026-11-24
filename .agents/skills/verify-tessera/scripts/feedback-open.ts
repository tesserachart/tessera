#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/feedback-open', uiDir, scene = 'pr', roundsArg = '5'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: feedback-open.ts [evidence dir] [ui dir] [pr|main] [rounds]');
  process.exit(2);
}
const rounds = Number(roundsArg);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstJsonLine<T>(child: ChildProcess, has: (v: Record<string, unknown>) => boolean): Promise<T> {
  return new Promise((done, fail) => {
    child.once('exit', (code) => fail(new Error(`exited (${String(code)}) before it was ready`)));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        const v = JSON.parse(line) as Record<string, unknown>;
        if (has(v)) done(v as T);
      } catch {
        return;
      }
    });
  });
}

const data = mkdtempSync(join(tmpdir(), 'tessera-feedback-open-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir || join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
);
const ready = await firstJsonLine<{ port: number; token: string }>(
  runtime,
  (v) => typeof v.port === 'number' && typeof v.token === 'string',
);
const origin = `http://127.0.0.1:${String(ready.port)}`;

interface Opening {
  painted: number;
  visible: number;
  settled: number;
  longestFrame: number;
  pictured: number | null;
  gathered: number | null;
}

function timeOpening(): Promise<Opening> {
  return new Promise((done) => {
    const frames: number[] = [];
    const start = performance.now();
    let painted = -1;
    let visible = -1;
    let settled = -1;
    let pictured: number | null = null;
    let gathered: number | null = null;
    const sheet = () => document.querySelector('[role="dialog"].fb-sheet');
    const tick = (at: number) => {
      frames.push(at);
      const s = sheet();
      if (painted < 0 && s && s.querySelector('textarea')) painted = at - start;
      const opacity = s ? Number(getComputedStyle(s).opacity) : 0;
      if (visible < 0 && opacity > 0.1) visible = at - start;
      if (settled < 0 && opacity > 0.999 && s?.getAnimations().length === 0) settled = at - start;
      if (pictured === null && s?.textContent?.includes('This window,')) pictured = at - start;
      if (gathered === null && s?.querySelector('[data-feedback-item="orders"]')) gathered = at - start;
      if (at - start < 9_000) requestAnimationFrame(tick);
      else {
        let longest = 0;
        for (let i = 1; i < frames.length; i++) longest = Math.max(longest, frames[i]! - frames[i - 1]!);
        done({ painted, visible, settled, longestFrame: Math.max(longest, (frames[0] ?? start) - start), pictured, gathered });
      }
    };
    requestAnimationFrame(tick);
    document.querySelector<HTMLElement>('[data-feedback-entry]')!.click();
  });
}

function standInShell({ port, token }: { port: number; token: string }) {
  let nextId = 1;
  Object.assign(window, {
    isTauri: true,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => nextId++,
      unregisterCallback: () => undefined,
      invoke: async (cmd: string, args: { handler?: number }) => {
        switch (cmd) {
          case 'plugin:event|listen':
            return args.handler;
          case 'runtime_connection':
            return { port, token };
          default:
            return null;
        }
      },
    },
  });
}

const browser = await chromium.launch({ headless: true });
const results: Opening[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await context.addInitScript(standInShell, ready);
  const page = await context.newPage();
  await page.goto(origin);
  const workspace = page.getByRole('main', { name: 'Workspace' });
  for (let i = 0; i < 120; i++) {
    const accept = page.getByRole('button', { name: /^(Accept|Continue)$/ });
    if (await accept.isVisible().catch(() => false)) await accept.click();
    else if (await workspace.isVisible().catch(() => false)) break;
    await sleep(500);
  }
  await workspace.waitFor({ timeout: 30_000 });
  await sleep(4_000);
  await page.screenshot({ path: join(dir, `${scene}-desk.png`) });
  for (let i = 0; i < rounds; i++) {
    const opening = await page.evaluate(timeOpening);
    results.push(opening);
    console.info(
      `open ${String(i + 1)}: painted ${opening.painted.toFixed(0)} ms, visible ${opening.visible.toFixed(0)} ms, settled ${opening.settled.toFixed(0)} ms, longest frame ${opening.longestFrame.toFixed(0)} ms, picture ${String(opening.pictured?.toFixed(0))} ms, details ${String(opening.gathered?.toFixed(0))} ms`,
    );
    await page.keyboard.press('Escape');
    await sleep(1_500);
  }

  const cdp = await context.newCDPSession(page);
  const frames: { at: number; data: string }[] = [];
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    frames.push({ at: (f.metadata.timestamp ?? 0) * 1000, data: f.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 });
  await sleep(1_000);
  const clickedAt = await page.evaluate(() => {
    const at = performance.timeOrigin + performance.now();
    document.querySelector<HTMLElement>('[data-feedback-entry]')!.click();
    return at;
  });
  await sleep(7_000);
  await cdp.send('Page.stopScreencast');
  console.info(`frames after the click: ${frames.map((f) => (f.at - clickedAt).toFixed(0)).filter((d) => Number(d) > -50 && Number(d) < 1500).join(" ")}`);
  const shownAt = (ms: number) => frames.filter((f) => f.at <= clickedAt + ms).at(-1);
  for (const ms of [100, 150, 300, 1_000, 7_000]) {
    const frame = shownAt(ms);
    if (frame) writeFileSync(join(dir, `${scene}-at-${String(ms)}ms.png`), Buffer.from(frame.data, 'base64'));
  }
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
const median = (pick: (o: Opening) => number) => results.map(pick).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? -1;
const medians = { painted: median((o) => o.painted), visible: median((o) => o.visible), settled: median((o) => o.settled) };
writeFileSync(join(dir, `${scene}-openings.json`), JSON.stringify({ medians, results }, null, 2));
console.info(
  `median: in the page ${medians.painted.toFixed(0)} ms, visible ${medians.visible.toFixed(0)} ms, fully in ${medians.settled.toFixed(0)} ms (evidence in ${dir})`,
);
