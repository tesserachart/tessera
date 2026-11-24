#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/empty-desk', uiDir, label = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-empty-desk-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
);
const ready = await new Promise<{ port: number; ticket: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; ticket?: string } = {};
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    try {
      Object.assign(seen, JSON.parse(line) as object);
    } catch {
      return;
    }
    if (seen.port && seen.ticket) done({ port: seen.port, ticket: seen.ticket });
  });
});
const origin = `http://127.0.0.1:${String(ready.port)}`;

interface Placement {
  header: { top: number; height: number; addPanel: boolean; band: boolean; matchesTrade: boolean } | null;
  invite: { dx: number; dy: number } | null;
}

function placement(): Placement {
  const invite = document.querySelector<HTMLElement>('section[aria-label="No chart open"]');
  const host = invite?.closest<HTMLElement>('.dv-groupview, .dv-watermark-container');
  const row = host?.querySelector<HTMLElement>('.dv-tabs-and-actions-container');
  const trade = document.querySelector('.dock-tab[data-kind="trade"]')?.closest('.dv-tabs-and-actions-container');
  const rowBox = row?.getBoundingClientRect();
  const tradeBox = trade?.getBoundingClientRect();
  const hostBox = host?.getBoundingClientRect();
  const bodyTop = rowBox?.bottom ?? hostBox?.top ?? 0;
  const parts = invite ? [...invite.children].map((c) => c.getBoundingClientRect()) : [];
  const middle = (a: number, b: number) => (a + b) / 2;
  return {
    header:
      row && rowBox
        ? {
            top: Math.round(rowBox.top),
            height: Math.round(rowBox.height),
            addPanel: row.querySelector('[aria-label="Add a panel here"]') !== null,
            band: row.hasAttribute('data-band'),
            matchesTrade: !tradeBox || (tradeBox.top === rowBox.top && tradeBox.height === rowBox.height),
          }
        : null,
    invite:
      hostBox && parts.length
        ? {
            dx: Math.round(
              middle(Math.min(...parts.map((r) => r.left)), Math.max(...parts.map((r) => r.right))) -
                middle(hostBox.left, hostBox.right),
            ),
            dy: Math.round(
              middle(Math.min(...parts.map((r) => r.top)), Math.max(...parts.map((r) => r.bottom))) -
                middle(bodyTop, hostBox.bottom),
            ),
          }
        : null,
  };
}

const report: Record<string, unknown> = { label };
async function shot(page: Page, step: string): Promise<void> {
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(dir, `${label}-${step}.png`) });
  report[step] = await page.evaluate(placement);
}

async function closeAll(page: Page, kind: string | null): Promise<void> {
  const tabs = page.locator(kind ? `.dock-tab[data-kind="${kind}"]` : '.dock-tab');
  while ((await tabs.count()) > 0) {
    const first = tabs.first();
    await first.click();
    const row = page.locator('.dv-tabs-and-actions-container', { has: first });
    await row.getByRole('button', { name: /^Close / }).last().click();
    await page.waitForTimeout(300);
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2_000);

  await closeAll(page, 'chart');
  await page.getByRole('heading', { name: 'No chart open' }).waitFor({ timeout: 10_000 });
  await shot(page, '1-no-chart');

  await page.reload();
  await page.getByRole('heading', { name: 'No chart open' }).waitFor({ timeout: 60_000 });
  await shot(page, '2-reloaded');

  await closeAll(page, null);
  await page.getByRole('heading', { name: 'No chart open' }).waitFor({ timeout: 10_000 });
  await shot(page, '3-bare-desk');

  await page.locator('.dv-watermark-container').getByRole('button', { name: 'Add a panel here' }).click();
  await page.getByRole('menuitem', { name: /^Journal/ }).click();
  await page.locator('.dock-tab[data-kind="journal"]').waitFor({ timeout: 10_000 });
  await shot(page, '4-added-from-header');
  report.addedFromHeader = await page.locator('.dock-tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
} finally {
  writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
