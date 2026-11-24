#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import pixelmatch from 'pixelmatch';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';
import { baseStyles, mergeProbes, probe, readStyles, stylesReport, type Probe, type Styles } from './parity-styles.ts';
import { areas, type Screen } from './parity-screens/screen.ts';

const VIEWPORT = { width: 1600, height: 1000 };
const SIM_NOW = new Date('2026-10-02T18:42:00Z');
const STABLE_TRIES = 120;
const SETTLED_MS = 3_000;
const ROUNDS = 3;
const STABLE_GAP_MS = 400;
const SCREENS_DIR = join(import.meta.dirname, 'parity-screens');

async function screensBy(selection: string | undefined): Promise<Screen[]> {
  const files = readdirSync(SCREENS_DIR).filter((f) => f.endsWith('.ts') && f !== 'screen.ts');
  const byFile = new Map<string, Screen[]>();
  for (const file of files) {
    const mod = (await import(join(SCREENS_DIR, file))) as { screens: Screen[] };
    byFile.set(file.replace(/\.ts$/, ''), mod.screens);
  }
  const all = [...byFile.values()].flat();
  if (!selection) return all;
  return selection.split(',').flatMap((part) => {
    if (part.startsWith('@')) return byFile.get(part.slice(1)) ?? [];
    return all.filter((s) => s.name === part);
  });
}
interface Sim {
  origin: string;
  data: string;
  ticket: () => Promise<string>;
  stop: () => void;
}

async function startSim(uiDir: string): Promise<Sim> {
  const repo = resolve(import.meta.dirname, '../../../..');
  const data = mkdtempSync(join(tmpdir(), 'tessera-parity-'));
  const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
  const child: ChildProcess = spawn(
    bin,
    ['serve', '--port', '0', '--ui-dir', uiDir, '--data-dir', data, '--launch-tickets'],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const tickets: string[] = [];
  const waiting: ((t: string) => void)[] = [];
  const origin = await new Promise<string>((done, fail) => {
    child.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
    if (!child.stdout) return fail(new Error('no runtime stdout'));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: { event?: string; port?: number; ticket?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      if (msg.event === 'ready' && msg.port) done(`http://127.0.0.1:${String(msg.port)}`);
      if (msg.event === 'launch' && msg.ticket) {
        const next = waiting.shift();
        if (next) next(msg.ticket);
        else tickets.push(msg.ticket);
      }
    });
  });
  return {
    origin,
    data,
    ticket: () => {
      const t = tickets.shift();
      return t ? Promise.resolve(t) : new Promise((done) => waiting.push(done));
    },
    stop: () => {
      child.kill('SIGTERM');
      rmSync(data, { recursive: true, force: true });
    },
  };
}

async function pinLiveText(page: Page, dataDir: string, live: RegExp | undefined): Promise<void> {
  await page.evaluate(
    ({ dataDir, live }) => {
      const pattern = live ? new RegExp(live) : null;
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        const text = node.textContent ?? '';
        if (text.includes(dataDir)) node.textContent = text.replace(dataDir, '/data');
        else if (/127\.0\.0\.1:\d+/.test(text)) node.textContent = text.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:0');
        else if (pattern?.test(text.trim())) node.textContent = '';
      }
    },
    { dataDir, live: live?.source },
  );
}

function splashShown(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#boot, i[role="img"][aria-label="Tessera"]')).some((el) => {
      const style = getComputedStyle(el);
      return el.getClientRects().length > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    }),
  );
}

async function stableShot(shoot: () => Promise<Buffer>): Promise<{ png: Buffer; stable: boolean }> {
  let last = await shoot();
  let since = Date.now();
  for (let i = 0; i < STABLE_TRIES; i++) {
    await new Promise((r) => setTimeout(r, STABLE_GAP_MS));
    const next = await shoot();
    if (!next.equals(last)) since = Date.now();
    else if (Date.now() - since >= SETTLED_MS) return { png: next, stable: true };
    last = next;
  }
  return { png: last, stable: false };
}

type Meet = (screen: string, own: Probe) => Promise<Probe>;

function pairing(): Meet {
  const waiting = new Map<string, { own: Probe; done: (merged: Probe) => void }>();
  return (screen, own) => {
    const other = waiting.get(screen);
    if (!other) return new Promise((done) => waiting.set(screen, { own, done }));
    waiting.delete(screen);
    const merged = mergeProbes(own, other.own);
    other.done(merged);
    return Promise.resolve(merged);
  };
}

async function capture(uiDir: string, out: string, screens: Screen[], meet: Meet): Promise<Record<string, boolean>> {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const stable: Record<string, boolean> = {};
  try {
    for (const screen of screens) {
      const sim = await startSim(resolve(uiDir));
      try {
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        const page = await context.newPage();
        await page.clock.setFixedTime(SIM_NOW);
        await page.addInitScript(() => sessionStorage.setItem('tessera.intro', 'played'));
        await page.goto(`${sim.origin}/#ticket=${encodeURIComponent(await sim.ticket())}`);
        await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 240_000 });
        await areas(page).waitFor();
        await page.waitForFunction(
          () => {
            const nav = document.querySelector('nav[aria-label="Areas"]');
            const box = nav?.getBoundingClientRect();
            if (!nav || !box || box.width === 0) return false;
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return hit !== null && nav.contains(hit);
          },
          undefined,
          { timeout: 240_000 },
        );
        await screen.open(page);
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(0, VIEWPORT.height - 1);
        const target = screen.target?.(page);
        const options = { animations: 'disabled' as const };
        const shot = await stableShot(async () => {
          if (await splashShown(page)) return Buffer.from(String(Math.random()));
          await pinLiveText(page, sim.data, screen.live);
          return target ? target.screenshot(options) : page.screenshot(options);
        });
        writeFileSync(join(out, `${screen.name}.png`), shot.png);
        const cdp = await context.newCDPSession(page);
        const base = await baseStyles(page, cdp);
        const merged = await meet(screen.name, await probe(page));
        writeFileSync(
          join(out, `${screen.name}.styles.json`),
          JSON.stringify(await readStyles(page, cdp, merged, base)),
        );
        stable[screen.name] = shot.stable;
        writeFileSync(join(out, `${screen.name}.settled.json`), JSON.stringify(shot.stable));
        console.info(`${screen.name}: ${shot.stable ? 'captured' : 'UNSTABLE (never settled)'}`);
        await context.close();
      } finally {
        sim.stop();
      }
    }
  } finally {
    await browser.close();
  }
  return stable;
}

function diff(before: string, after: string, out: string, names: string[]): boolean {
  mkdirSync(out, { recursive: true });
  let same = true;
  for (const name of names) {
    const a = PNG.sync.read(readFileSync(join(before, `${name}.png`)));
    const b = PNG.sync.read(readFileSync(join(after, `${name}.png`)));
    if (a.width !== b.width || a.height !== b.height) {
      console.info(`${name}: SIZE ${String(a.width)}x${String(a.height)} vs ${String(b.width)}x${String(b.height)}`);
      same = false;
      continue;
    }
    const delta = new PNG({ width: a.width, height: a.height });
    const changed = pixelmatch(a.data, b.data, delta.data, a.width, a.height, { threshold: 0 });
    if (changed > 0) writeFileSync(join(out, `${name}.png`), PNG.sync.write(delta));
    console.info(`${name}: ${changed === 0 ? 'same' : `${String(changed)} pixels differ`}`);
    if (changed > 0) same = false;
  }
  return same;
}

function diffStyles(before: string, after: string, out: string, names: string[]): boolean {
  let same = true;
  for (const name of names) {
    const a = JSON.parse(readFileSync(join(before, `${name}.styles.json`), 'utf8')) as Styles;
    const b = JSON.parse(readFileSync(join(after, `${name}.styles.json`), 'utf8')) as Styles;
    const report = stylesReport(a, b);
    const forcedCount = Object.keys(a.forced).length;
    if (report.length > 0) writeFileSync(join(out, `${name}.styles.txt`), report.join('\n'));
    console.info(
      `${name}: ${report.length === 0 ? `styles same (${String(Object.keys(a.base).length)} boxes, ${String(forcedCount)} forced states)` : `${String(report.length)} style differences (diff/${name}.styles.txt)`}`,
    );
    if (report.length > 0) same = false;
  }
  return same;
}

const args = process.argv.slice(2);
const resume = args.includes('--resume');
const [beforeUi, afterUi, outArg = '.e2e/artifacts/verify/parity', onlyArg] = args.filter((a) => a !== '--resume');
if (!beforeUi || !afterUi) {
  console.error('usage: parity.ts [--resume] <before ui dir> <after ui dir> [out dir] [screen|@screens-file,…]');
  process.exit(2);
}
const out = resolve(outArg);
const screens = await screensBy(onlyArg);
if (screens.length === 0) {
  console.error(`no screens match ${onlyArg ?? ''}`);
  process.exit(2);
}
const sides = ['before', 'after'].map((side) => join(out, side));
const settled = (dir: string, name: string) => {
  const file = join(dir, `${name}.settled.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as boolean) : null;
};
const done = (name: string) => sides.every((dir) => settled(dir, name) !== null);
const looksDifferent = (name: string) => {
  if (sides.some((dir) => settled(dir, name) !== true)) return true;
  const [a, b] = sides.map((dir) => PNG.sync.read(readFileSync(join(dir, `${name}.png`))));
  if (!a || !b || a.width !== b.width || a.height !== b.height) return true;
  return pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0 }) > 0;
};
let todo = resume ? screens.filter((s) => !done(s.name)) : screens;
if (resume) console.info(`resuming: ${String(screens.length - todo.length)} screens already captured`);
for (let round = 1; ; round++) {
  if (todo.length > 0) {
    const meet = pairing();
    await Promise.all([
      capture(beforeUi, join(out, 'before'), todo, meet),
      capture(afterUi, join(out, 'after'), todo, meet),
    ]);
  }
  const failing = screens.filter((s) => looksDifferent(s.name));
  if (failing.length === 0 || round >= ROUNDS) break;
  console.info(`round ${String(round)}: capturing again ${failing.map((s) => s.name).join(', ')}`);
  for (const screen of failing) {
    for (const dir of sides) rmSync(join(dir, `${screen.name}.settled.json`), { force: true });
  }
  todo = failing;
}
const names = screens.map((s) => s.name);
const unstable = names.filter((n) => sides.some((dir) => settled(dir, n) !== true));
const samePixels = diff(join(out, 'before'), join(out, 'after'), join(out, 'diff'), names);
const sameStyles = diffStyles(join(out, 'before'), join(out, 'after'), join(out, 'diff'), names);
if (unstable.length > 0) console.info(`inconclusive: ${unstable.join(', ')} never settled`);
const verified = samePixels && sameStyles && unstable.length === 0;
console.info(verified ? 'VERIFIED: every screen is pixel-identical and every element computes the same styles' : 'NOT VERIFIED');
process.exit(verified ? 0 : 1);
