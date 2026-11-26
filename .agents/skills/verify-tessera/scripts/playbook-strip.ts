#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/playbook-strip', uiDir, label = 'pr', binArg] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-strip-'));
const bin = binArg ?? resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
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
const rpc = await RuntimeRpc.open({ origin, token: ready.token, ticket: ready.ticket });

const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await rpc.tool<{ accounts: { account: { environment: string } }[] }>('portfolio.get_accounts', {});
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  throw new Error('refused: not the sim runtime');
}

interface Leg {
  points: number;
  qty: number;
  fees: number;
}

async function seedSetup(name: string, hour: number, legs: readonly Leg[]): Promise<string> {
  const setup = await rpc.tool<{ id: string }>('journal.save_setup', { name });
  for (const [i, leg] of legs.entries()) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const entryPrice = 24000 + i * 7;
    await rpc.tool('journal.log_trade', {
      account: 'Strip check',
      symbol: 'NQZ6',
      side: 'buy',
      qty: leg.qty,
      entryPrice,
      entryTime: `2026-09-${day}T${String(hour)}:00:00Z`,
      exitPrice: entryPrice + leg.points,
      exitTime: `2026-09-${day}T${String(hour)}:30:00Z`,
      fees: leg.fees,
      stopPrice: entryPrice - 40,
      setupId: setup.id,
    });
  }
  return setup.id;
}

const issue = [
  ...Array.from({ length: 19 }, (_, i) => ({ points: i % 2 ? 10.5 : 10.25, qty: 1, fees: 2.4 })),
  ...Array.from({ length: 5 }, () => ({ points: -8.75, qty: 1, fees: 4 })),
];
const big = [
  ...Array.from({ length: 3 }, () => ({ points: -49, qty: 10, fees: 8.67 })),
  ...Array.from({ length: 12 }, () => ({ points: 62, qty: 10, fees: 8.67 })),
];
const setups = {
  'issue-values': { id: await seedSetup('VWAP fade', 14, issue), name: 'VWAP fade' },
  'six-figures': { id: await seedSetup('Opening drive', 16, big), name: 'Opening drive' },
};

interface Overlap {
  width: number;
  cell: string;
  part: string;
  over: number;
}

async function overlaps(page: Page, width: number): Promise<Overlap[]> {
  return page.evaluate((w) => {
    const found: { width: number; cell: string; part: string; over: number }[] = [];
    for (const cell of document.querySelectorAll<HTMLElement>('.jr-strip .jr-cell')) {
      const box = cell.getBoundingClientRect();
      const cs = getComputedStyle(cell);
      const left = box.left + Number.parseFloat(cs.paddingLeft);
      const right = box.right - Number.parseFloat(cs.paddingRight);
      for (const part of cell.querySelectorAll<HTMLElement>(':scope > .v, :scope > .l')) {
        const range = document.createRange();
        range.selectNodeContents(part);
        const text = range.getBoundingClientRect();
        const over = Math.max(left - text.left, text.right - right);
        if (over > 0.5)
          found.push({ width: w, cell: cell.textContent ?? '', part: part.className, over: Math.round(over) });
      }
    }
    return found;
  }, width);
}

async function expectName(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (want) => document.querySelector<HTMLInputElement>('input[aria-label="Setup name"]')?.value === want,
    name,
    { timeout: 30_000 },
  );
}

const browser = await chromium.launch();
const report: Record<string, unknown> = { label };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1_500);
  for (const [theme, preset] of [
    ['tessera', 'tessera'],
    ['tessera-light', 'tessera-light'],
  ] as const) {
    await rpc.tool('settings.set', { key: 'appearance.theme', value: { preset } });
    for (const [values, { id: setupId, name }] of Object.entries(setups)) {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await rpc.tool('ui.show_area', {
        area: 'journal',
        journal: { section: 'playbooks', setupId, range: 'all', account: 'all' },
      });
      await expectName(page, name);
      await page.locator('.jr-strip .jr-cell').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(800);
      const found: Overlap[] = [];
      for (let width = 1600; width >= 800; width -= 20) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(40);
        found.push(...(await overlaps(page, width)));
      }
      report[`${theme}-${values}`] = found;
      for (const width of [1600, 1100]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(300);
        const book = await page.locator('.jr-book-page').first().boundingBox();
        const strip = await page.locator('.jr-strip').first().boundingBox();
        if (!book || !strip) throw new Error('the strip is not on screen');
        await page.screenshot({
          path: join(dir, `${label}-${theme}-${values}-${String(width)}.png`),
          clip: { x: book.x, y: book.y, width: book.width, height: strip.y + strip.height - book.y + 16 },
        });
      }
    }
  }
  writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
  for (const [k, v] of Object.entries(report)) if (Array.isArray(v)) console.info(`${label} ${k}: ${String(v.length)}`);
} finally {
  rpc.close();
  await browser.close();
  runtime.kill();
  rmSync(data, { recursive: true, force: true });
}
