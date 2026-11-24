#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { tileWindowSearch } from '../../../../packages/bridge/src/types.ts';
import { headerProblems } from '../../../../e2e/agent/support/headers.ts';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/panel-headers', uiDir, label = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-panel-headers-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
);
const ready = await new Promise<{ port: number; ticket: string; token: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; ticket?: string; token?: string } = {};
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    try {
      Object.assign(seen, JSON.parse(line) as object);
    } catch {
      return;
    }
    if (seen.port && seen.ticket && seen.token) done({ port: seen.port, ticket: seen.ticket, token: seen.token });
  });
});
const origin = `http://127.0.0.1:${String(ready.port)}`;

const report: Record<string, unknown> = { label };
const settle = (page: Page, ms = 900) => page.waitForTimeout(ms);
async function shot(page: Page, step: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(dir, `${label}-${step}.png`) });
  report[step] = await page.evaluate(headerProblems);
}

async function drag(page: Page, from: string, to: { x: number; y: number }, how: 'drop' | 'cancel'): Promise<void> {
  const src = await page.locator(from).first().boundingBox();
  if (!src) throw new Error(`no ${from}`);
  await page.mouse.move(src.x + 24, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 40, src.y + src.height / 2 + 6, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (how === 'cancel') await page.keyboard.press('Escape');
  await page.mouse.up();
}

const tab = (kind: string) => `.dock-tab[data-kind="${kind}"]`;
const rowOf = (page: Page, kind: string) => page.locator('.dv-tabs-and-actions-container', { has: page.locator(tab(kind)) }).first();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 60_000 });
  await settle(page, 3_000);
  await shot(page, '1-docked');

  await rowOf(page, 'trade').getByRole('button', { name: 'Add a panel here' }).click();
  await page.getByRole('menuitem', { name: /^Indicators/ }).click();
  await shot(page, '2-indicators-open');

  const es = await rowOf(page, 'chart').boundingBox();
  await drag(page, tab('indicators'), { x: (es?.x ?? 0) + 300, y: (es?.y ?? 0) + 20 }, 'cancel');
  await shot(page, '3-drag-cancelled');

  const trade = await rowOf(page, 'trade').locator(tab('trade')).boundingBox();
  await drag(page, tab('indicators'), { x: (trade?.x ?? 0) + 16, y: (trade?.y ?? 0) + 18 }, 'drop');
  await shot(page, '4-dragged-before-trade');
  report.rightColumn = await rowOf(page, 'trade').locator('.dock-tab').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-kind')),
  );

  const chartTabs = await page.locator(tab('chart')).first().boundingBox();
  await drag(page, tab('indicators'), { x: (chartTabs?.x ?? 0) + (chartTabs?.width ?? 0) - 6, y: (chartTabs?.y ?? 0) + 18 }, 'drop');
  await shot(page, '5-dragged-into-chart');
  report.chartColumn = await rowOf(page, 'indicators').locator('.dock-tab').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-kind')),
  );

  for (const title of ['Journal', 'Alerts', 'Analyst']) {
    await rowOf(page, 'trade').getByRole('button', { name: 'Add a panel here' }).click();
    await page.getByRole('menuitem', { name: new RegExp(`^${title}`) }).click();
    await settle(page, 400);
  }
  await shot(page, '6-many-tabs');

  for (const width of [1100, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await shot(page, `7-narrow-${String(width)}`);
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await settle(page);

  const layoutId = 'default';
  const win = await context.newPage();
  await win.setViewportSize({ width: 900, height: 600 });
  await win.goto(
    `${origin}/${tileWindowSearch({ kind: 'trade', id: `pop-${layoutId}-trade`, title: 'Trade', params: { layoutId, panelId: 'trade' } })}#ticket=${ready.ticket}`,
  );
  await win.getByRole('button', { name: /^Account: Paper,/ }).waitFor({ timeout: 30_000 });
  await shot(win, '8-popped-out');
  for (const width of [420, 300]) {
    await win.setViewportSize({ width, height: 600 });
    await shot(win, `9-popped-out-${String(width)}`);
  }
  await win.close();

  writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
