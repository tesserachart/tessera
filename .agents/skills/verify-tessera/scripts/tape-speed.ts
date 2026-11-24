#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/tape-speed', uiDir, tag = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-tape-speed-'));
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
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_TEST_MARKET: 'busy', TESSERA_NO_RITHMIC: '1' } },
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
    client: { name: 'tape-speed', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: ready.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  return answer.result;
}

interface Flow {
  frames: number;
  p95FrameMs: number;
  worstFrameMs: number;
  newRowsPerSecond: number;
  smallestSize: number | null;
}

async function watch(page: Page, ms: number): Promise<Flow> {
  return page.evaluate(async (span) => {
    const rows = () => document.querySelector('.tape-tile .t-tape-rows');
    const sizes = () =>
      [...(rows()?.querySelectorAll<HTMLElement>('.r[data-pos]') ?? [])]
        .filter((r) => r.style.display !== 'none')
        .map((r) => Number((r.querySelector('.sz')?.textContent ?? '').replace(/,/g, '')))
        .filter((n) => Number.isFinite(n) && n > 0);
    const deltas: number[] = [];
    let tops = 0;
    let top = '';
    let smallest = Infinity;
    const start = performance.now();
    let last = start;
    await new Promise<void>((done) => {
      const tick = (now: number) => {
        deltas.push(now - last);
        last = now;
        const first = rows()?.querySelector<HTMLElement>('.r[data-pos="0"]')?.textContent ?? '';
        if (first !== top) {
          tops++;
          top = first;
        }
        for (const s of sizes()) smallest = Math.min(smallest, s);
        if (now - start < span) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    const sorted = [...deltas].sort((a, b) => a - b);
    return {
      frames: deltas.length,
      p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 10) / 10,
      worstFrameMs: Math.round(sorted.at(-1)! * 10) / 10,
      newRowsPerSecond: Math.round((tops / span) * 10_000) / 10,
      smallestSize: Number.isFinite(smallest) ? smallest : null,
    };
  }, ms);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const report: Record<string, unknown> = { tag };

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await tool('workspace.open_tile', { kind: 'tape', instrument: 'NQZ6.CME' });
  const tape = page.locator('.tape-tile').first();
  await tape.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(8_000);
  await page.mouse.move(2, 2);
  report.liveEverySize = await watch(page, 5_000);

  const openSettings = async () => {
    const box = await tape.boundingBox();
    const more = page.getByRole('button', { name: /: more$/ });
    for (let i = 0; i < (await more.count()); i++) {
      const b = await more.nth(i).boundingBox();
      if (box && b && b.x >= box.x && b.x <= box.x + box.width && Math.abs(b.y - box.y) < 80) {
        await more.nth(i).click();
        break;
      }
    }
    const item = page.getByRole('menuitem', { name: /^Settings…/ });
    report[`menu-${String(Object.keys(report).length)}`] = await item.textContent();
    await item.click();
    await page.locator('.tile-settings').first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
  };
  await openSettings();
  await page.screenshot({ path: join(dir, `${tag}-settings.png`) });

  const minSize = page.getByRole('textbox', { name: 'Min size' });
  if (await minSize.count()) {
    await minSize.fill('20');
    await page.getByRole('group', { name: 'Tape speed' }).getByRole('button', { name: 'Slow' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(dir, `${tag}-settings-set.png`) });
    await page.keyboard.press('Escape');
    await page.mouse.move(2, 2);
    await page.waitForTimeout(3_000);
    report.slowAtLeast20 = await watch(page, 6_000);
    await tape.screenshot({ path: join(dir, `${tag}-tape-slow-20.png`) });
    report.layout = await tool('layout.get', {});
    await page.reload();
    await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
    await tape.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(4_000);
    await openSettings();
    await page.screenshot({ path: join(dir, `${tag}-settings-after-reload.png`) });
    report.afterReload = {
      minSize: await minSize.inputValue(),
      speed: await page
        .getByRole('group', { name: 'Tape speed' })
        .getByRole('button', { pressed: true })
        .textContent(),
    };
  } else {
    await page.keyboard.press('Escape');
    await tape.screenshot({ path: join(dir, `${tag}-tape-live.png`) });
  }
  writeFileSync(join(dir, `${tag}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, layout: undefined }, null, 2));
  console.log(`stills in ${dir}`);
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
