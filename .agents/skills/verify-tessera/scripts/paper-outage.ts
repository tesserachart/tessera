#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/paper-outage'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: paper-outage.ts <port> [evidence dir]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

interface Orders {
  orders: {
    id: string;
    status: string;
    reason?: string | null;
    avgFillPrice?: string | number | null;
    request: { side: string; orderType: string };
  }[];
}
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
const orderIds = async () =>
  new Set((await rpc.tool<Orders>('portfolio.get_orders', { accountId: 'paper-main' })).orders.map((o) => o.id));
const newOrders = async (before: Set<string>) =>
  (await rpc.tool<Orders>('portfolio.get_orders', { accountId: 'paper-main' })).orders
    .filter((o) => !before.has(o.id))
    .map(
      (o) =>
        `${o.request.side} ${o.request.orderType} ${o.status}${o.avgFillPrice ? ` at ${String(o.avgFillPrice)}` : ''}`,
    );

function pidOnPort(listen: string): number {
  const out = execFileSync('ss', ['-lptn', `sport = :${listen}`], { encoding: 'utf8' });
  const found = out.match(/pid=(\d+)/);
  if (!found) throw new Error(`no process listening on ${listen}`);
  return Number(found[1]);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const failures: string[] = [];
const report = (line: string) => console.info(line);
const shot = (name: string) =>
  page.screenshot({ path: join(dir, name), timeout: 120_000 }).catch(() => report(`(no screenshot ${name})`));
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(250))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};
const pageSays = async (pattern: RegExp) => pattern.test(await page.locator('body').innerText());
const statusLine = async () =>
  (
    await page
      .getByRole('contentinfo', { name: 'Status and notices' })
      .innerText()
      .catch(() => '')
  )
    .replace(/\s+/g, ' ')
    .trim();
let pid: number | null = null;

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  const buy = ticket.getByRole('button', { name: 'Buy market', exact: true });
  const sell = ticket.getByRole('button', { name: 'Sell market', exact: true });
  await until(() => buy.isEnabled({ timeout: 1_000 }), 180_000, 'Buy market is on');
  await buy.click({ timeout: 30_000 });
  await until(async () => (await held()).length === 1, 30_000, 'the paper long is open');
  report(`live: long ${(await held()).join(', ')}`);
  await page.waitForTimeout(1_000);
  await shot('1-long.png');

  pid = pidOnPort(port);
  process.kill(pid, 'SIGUSR1');
  const dropped = Date.now();
  report('outage: the mock market is down (SIGUSR1)');
  await until(() => pageSays(/No live prices/), 30_000, 'the ticket says No live prices');

  const before = await orderIds();
  const into = ((Date.now() - dropped) / 1000).toFixed(1);
  await sell.click({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const notices = await statusLine();
  const sent = await newOrders(before);
  const after = await held();
  report(`outage: Sell market ${into} s into the outage`);
  report(
    `outage: orders ${sent.length === 0 ? 'none' : sent.join(', ')}; position ${after.length === 0 ? 'flat' : after.join(', ')}`,
  );
  report(`outage: status line "${notices}"`);
  await shot('2-sell-during-outage.png');
  if (after.length === 0) failures.push(`Sell market filled ${into} s into the outage: ${sent.join(', ')}`);
  if (!/Not sent · Paper · No live price for NQZ6 since \d\d:\d\d/.test(notices))
    failures.push(`the status line does not give the plain refusal: "${notices}"`);

  if (after.length === 1) {
    const beforeFlat = await orderIds();
    const flatInto = ((Date.now() - dropped) / 1000).toFixed(1);
    await ticket.getByRole('button', { name: 'Flat', exact: true }).click({ timeout: 30_000 });
    await page.waitForTimeout(2_000);
    const flatNotices = await statusLine();
    const flatSent = await newOrders(beforeFlat);
    const afterFlat = await held();
    report(`outage: Flat ${flatInto} s into the outage`);
    report(
      `outage: orders ${flatSent.length === 0 ? 'none' : flatSent.join(', ')}; position ${afterFlat.length === 0 ? 'flat' : afterFlat.join(', ')}`,
    );
    report(`outage: status line "${flatNotices}"`);
    await shot('2b-flat-during-outage.png');
    if (afterFlat.length === 0) failures.push(`Flat filled during the outage: ${flatSent.join(', ')}`);
    if (!/Not flat: No live price for NQZ6 since \d\d:\d\d/.test(flatNotices))
      failures.push(`the status line does not say Flat was refused: "${flatNotices}"`);
  }

  process.kill(pid, 'SIGUSR2');
  report('back: the mock market is up (SIGUSR2)');
  await until(async () => !(await pageSays(/No live prices/)), 30_000, 'the ticket drops No live prices');
  if ((await held()).length === 1) {
    const now = await orderIds();
    await sell.click({ timeout: 30_000 });
    await until(async () => (await held()).length === 0, 30_000, 'the close fills once prices are back');
    report(`back: Sell market sent ${(await newOrders(now)).join(', ')}`);
  }
  await page.waitForTimeout(1_000);
  await shot('3-back.png');
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  await shot('failed.png');
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
