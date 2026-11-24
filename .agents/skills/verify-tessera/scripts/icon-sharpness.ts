#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/icon-sharpness', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: icon-sharpness.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const ui = uiDir || join(repo, 'apps/desktop/dist');
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const AREAS = ['Desk', 'Markets', 'Analyst', 'Indicators', 'Research', 'Journal', 'Trade copier', 'Settings'];

interface Runtime {
  port: number;
  tickets: string[];
  child: ChildProcess;
  data: string;
}

async function launch(): Promise<Runtime> {
  const data = mkdtempSync(join(tmpdir(), 'tessera-icon-sharpness-'));
  const child = spawn(bin, ['serve', '--port', '0', '--ui-dir', ui, '--data-dir', data, '--launch-tickets'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const tickets: string[] = [];
  const port = await new Promise<number>((done, fail) => {
    child.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
    let seenPort = 0;
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: { port?: number; ticket?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      if (msg.port) seenPort = msg.port;
      if (msg.ticket) tickets.push(msg.ticket);
      if (seenPort && tickets.length) done(seenPort);
    });
  });
  return { port, tickets, child, data };
}

const soft: string[] = [];
const runtime = await launch();
const browser = await chromium.launch();
try {
  for (const scale of [1, 2]) {
    const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    while (!runtime.tickets.length) await new Promise((wait) => setTimeout(wait, 100));
    await page.goto(`http://127.0.0.1:${String(runtime.port)}/#ticket=${runtime.tickets.shift()!}`);
    await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll('.t-splash').length === 0, null, { timeout: 60_000 });
    for (const area of AREAS) {
      await page.getByRole('navigation', { name: 'Areas' }).getByRole('button', { name: area, exact: true }).click();
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: join(dir, `${scene}-${area.replace(/ /g, '-').toLowerCase()}-${String(scale)}x.png`) });
      if (scale !== 1 || scene !== 'pr') continue;
      const found = await page.evaluate(() =>
        [...document.querySelectorAll<SVGSVGElement>('svg.t-icon')].flatMap((svg) => {
          const box = svg.getBoundingClientRect();
          if (!box.width) return [];
          const size = getComputedStyle(svg).getPropertyValue('--icon').trim();
          const vector = svg.querySelector('.t-icon-vec');
          const stroke = vector ? getComputedStyle(vector).display !== 'none' : true;
          const off = `${String(box.width)}px` !== size || `${String(box.height)}px` !== size;
          return stroke || off ? [`${svg.dataset.icon ?? '?'} ${String(box.width)}×${String(box.height)} --icon ${size}`] : [];
        }),
      );
      soft.push(...found.map((f) => `${area}: ${f}`));
    }
    await context.close();
  }
} finally {
  await browser.close();
  const exited = new Promise((done) => runtime.child.once('exit', done));
  runtime.child.kill('SIGTERM');
  await exited;
  rmSync(runtime.data, { recursive: true, force: true });
}

writeFileSync(join(dir, `${scene}-soft.txt`), soft.join('\n'));
for (const line of soft) console.info(`FAIL: ${line} draws the soft stroke at 1x`);
console.info(soft.length ? `${String(soft.length)} icons soft at 1x` : 'ok: every icon draws its pixel cut at 1x');
process.exit(soft.length ? 1 : 0);
