#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/popout-refusal'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: popout-refusal.ts <port> [evidence dir]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

interface Positions {
  positions: { qty: string | number; avgPrice: string | number }[];
}

const info = await readRuntimeInfo(`http://127.0.0.1:${port}`);
const rpc = await RuntimeRpc.open(info);
const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await rpc.tool<{ accounts: { account: { environment: string } }[] }>('portfolio.get_accounts', {});
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  console.error('refused: not the sim runtime');
  process.exit(1);
}

const held = async () =>
  (await rpc.tool<Positions>('portfolio.get_positions', { accountId: 'paper-main' })).positions.map(
    (p) => `${String(p.qty)} @ ${String(p.avgPrice)}`,
  );

function pidOnPort(listen: string): number {
  const found = execFileSync('ss', ['-lptn', `sport = :${listen}`], { encoding: 'utf8' }).match(/pid=(\d+)/);
  if (!found) throw new Error(`no process listening on ${listen}`);
  return Number(found[1]);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const main = await context.newPage();
const failures: string[] = [];
const report = (line: string) => console.info(line);
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(dir, name), timeout: 120_000 }).catch(() => report(`(no screenshot ${name})`));
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await main.waitForTimeout(250))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};
const footer = async (page: Page, name: string) =>
  (
    await page
      .getByRole('contentinfo', { name })
      .innerText({ timeout: 1_000 })
      .catch(() => '')
  )
    .replace(/\s+/g, ' ')
    .trim();
let pid: number | null = null;

try {
  await main.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const mainTicket = main.getByRole('region', { name: /^Ticket: NQ/ });
  await until(
    () => mainTicket.getByRole('button', { name: 'Buy market', exact: true }).isEnabled({ timeout: 1_000 }),
    180_000,
    'the main window trades NQ',
  );
  await main.keyboard.press('Control+k');
  await main.keyboard.type('Pop out the chart');
  const opened = context.waitForEvent('page', { timeout: 30_000 });
  await main.keyboard.press('Enter');
  const pop = await opened;
  report(`pop-out: ${new URL(pop.url()).searchParams.get('window') ?? pop.url()}`);
  await pop.getByRole('button', { name: 'Trade', exact: true }).click({ timeout: 60_000 });
  const ticket = pop.getByRole('region', { name: /^Ticket: NQ/ });
  const buy = ticket.getByRole('button', { name: 'Buy market', exact: true });
  await until(() => buy.isEnabled({ timeout: 1_000 }), 60_000, 'the pop-out ticket is on');
  await buy.click({ timeout: 30_000 });
  await until(async () => (await held()).length === 1, 30_000, 'the pop-out’s paper long is open');
  report(`live: long ${(await held()).join(', ')} from the pop-out`);

  pid = pidOnPort(port);
  process.kill(pid, 'SIGUSR1');
  report('outage: the mock market is down (SIGUSR1)');
  await until(
    async () => /No live prices/.test(await pop.locator('body').innerText()),
    30_000,
    'the pop-out says No live prices',
  );

  await ticket.getByRole('button', { name: 'Sell market', exact: true }).click({ timeout: 30_000 });
  await pop.waitForTimeout(2_000);
  report(`outage: Sell market in the pop-out; pop-out notices "${await footer(pop, 'Notices')}"`);
  await ticket.getByRole('button', { name: 'Flat', exact: true }).click({ timeout: 30_000 });
  await pop.waitForTimeout(2_000);
  const popSays = await footer(pop, 'Notices');
  const mainSays = await footer(main, 'Status and notices');
  report(`outage: Flat in the pop-out; position ${(await held()).join(', ') || 'flat'}`);
  report(`outage: pop-out notices "${popSays}"`);
  report(`outage: main window notices "${mainSays}"`);
  await shot(pop, '1-popout-refused.png');
  await shot(main, '1-main-window.png');
  if (!/No live price for NQZ6 since \d\d:\d\d/.test(popSays))
    failures.push(`the pop-out does not show Paper's refusal: "${popSays}"`);
  if (/No live price for NQZ6/.test(mainSays))
    failures.push(`the main window shows the pop-out's refusal too: "${mainSays}"`);
  const retry = pop.getByRole('contentinfo', { name: 'Notices' }).getByRole('button', { name: 'Retry', exact: true });
  if (!(await retry.isVisible({ timeout: 1_000 }).catch(() => false)))
    failures.push('the pop-out shows no Retry for Flat');

  process.kill(pid, 'SIGUSR2');
  report('back: the mock market is up (SIGUSR2)');
  await until(
    async () => !/No live prices/.test(await pop.locator('body').innerText()),
    30_000,
    'the pop-out drops No live prices',
  );
  if (await retry.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await retry.click({ timeout: 30_000 });
    await until(async () => (await held()).length === 0, 30_000, 'Retry in the pop-out flattens the long');
    report(`back: Retry in the pop-out; position ${(await held()).join(', ') || 'flat'}`);
    report(`back: pop-out notices "${await footer(pop, 'Notices')}"`);
  }
  await pop.waitForTimeout(1_000);
  await shot(pop, '2-popout-retried.png');
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  for (const [i, page] of context.pages().entries()) await shot(page, `failed-${String(i)}.png`);
} finally {
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGUSR2');
    } catch {}
  }
  await browser.close();
  rpc.close();
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
