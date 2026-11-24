#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/new-chart-popped'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: new-chart-popped.ts <port> [evidence dir]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const info = await readRuntimeInfo(`http://127.0.0.1:${port}`);
const rpc = await RuntimeRpc.open(info);
const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await rpc.tool<{ accounts: { account: { environment: string } }[] }>('portfolio.get_accounts', {});
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  console.error('refused: not the sim runtime');
  process.exit(1);
}

interface Layout {
  charts: Record<string, { instrument: string }>;
}
const stored = async () => {
  const layout = await rpc.tool<Layout>('layout.get', { layoutId: 'default' });
  return Object.values(layout.charts)
    .map((c) => c.instrument)
    .sort();
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const main = await context.newPage();
const report = (line: string) => console.info(line);
const chartTabs = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.dock-tab')].map((t) => t.textContent).filter((t) => t.includes(' · ')),
  );
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await main.waitForTimeout(250))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};
const group = (tab: string) => main.locator('.dv-groupview', { has: main.locator('.dock-tab', { hasText: tab }) });
let failed = false;

try {
  await main.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  await until(async () => (await chartTabs(main)).length === 2, 180_000, 'the desk shows NQ and ES');
  report(`desk: ${(await chartTabs(main)).join(', ')}`);
  await main.locator('.dock-tab', { hasText: 'ES Z6' }).click();
  await group('ES Z6').getByRole('button', { name: /^Close Chart/ }).click();
  await until(async () => (await chartTabs(main)).length === 1, 30_000, 'ES is off the desk');
  await main.locator('.dock-tab', { hasText: 'NQ Z6' }).click();
  const opened = context.waitForEvent('page', { timeout: 30_000 });
  await group('NQ Z6').getByRole('button', { name: 'Pop out', exact: true }).click();
  const pop = await opened;
  await until(async () => (await chartTabs(main)).length === 0, 30_000, 'NQ leaves the desk for its window');
  report(`popped: ${new URL(pop.url()).searchParams.get('window') ?? pop.url()}; desk charts none`);

  await main.bringToFront();
  await main.locator('main[aria-label="Workspace"]').click({ position: { x: 5, y: 5 } });
  await main.keyboard.press('Control+t');
  const search = main.locator('input[aria-label="Search symbols for a new chart tab"]');
  await search.waitFor({ timeout: 10_000 });
  report('Ctrl+T: the main window shows "Search symbols for a new chart tab"');
  await main.screenshot({ path: join(dir, '1-search-on-the-desk.png') });
  await search.fill('ES');
  await until(
    () => main.locator('[role=option]', { hasText: /^ES/ }).first().isVisible({ timeout: 500 }),
    30_000,
    'ES among the symbols',
  );
  await main.keyboard.press('Enter');
  await until(async () => (await chartTabs(main)).length === 1, 30_000, 'the new chart on the desk');
  await main.waitForTimeout(1_500);
  await main.screenshot({ path: join(dir, '2-new-chart-on-the-desk.png') });
  await pop.screenshot({ path: join(dir, '2-popped-chart.png') });
  report(`desk: ${(await chartTabs(main)).join(', ')}; pop-out: ${(await chartTabs(pop)).join(', ')}`);
  const charts = await stored();
  report(`layout.get: charts ${charts.join(', ')}`);
  if (charts.join() !== 'ESZ6.CME,NQZ6.CME') {
    failed = true;
    console.error(`FAILED: the workspace holds ${charts.join(', ')}, not ES on the desk and NQ in its window`);
  }
} catch (error) {
  failed = true;
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  await main.screenshot({ path: join(dir, 'failure.png') }).catch(() => undefined);
} finally {
  await browser.close();
  rpc.close();
}
process.exitCode = failed ? 1 : 0;
