#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/runtime-hung'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: runtime-hung.ts <port> [evidence dir]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

interface Orders {
  orders: { id: string; status: string; request: { side: string; orderType: string } }[];
}

const info = await readRuntimeInfo(`http://127.0.0.1:${port}`);
const rpc = await RuntimeRpc.open(info);
const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await rpc.tool<{ accounts: { account: { environment: string } }[] }>(
  'portfolio.get_accounts',
  {},
);
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  console.error('refused: not the sim runtime');
  process.exit(1);
}

const orderIds = async () =>
  new Set((await rpc.tool<Orders>('portfolio.get_orders', { accountId: 'paper-main' })).orders.map((o) => o.id));
const newOrders = async (before: Set<string>) =>
  (await rpc.tool<Orders>('portfolio.get_orders', { accountId: 'paper-main' })).orders
    .filter((o) => !before.has(o.id))
    .map((o) => `${o.request.side} ${o.request.orderType} ${o.status}`);

function pidOnPort(listen: string): number {
  const fromSs = (): number | null => {
    try {
      const out = execFileSync('ss', ['-lptn', `sport = :${listen}`], { encoding: 'utf8' });
      const found = out.match(/pid=(\d+)/);
      return found ? Number(found[1]) : null;
    } catch {
      return null;
    }
  };
  const fromFuser = (): number | null => {
    try {
      const out = execFileSync('fuser', [`${listen}/tcp`], { encoding: 'utf8' });
      const id = out.trim().split(/\s+/).at(-1);
      return id ? Number(id) : null;
    } catch {
      return null;
    }
  };
  const pid = fromSs() ?? fromFuser();
  if (pid === null || Number.isNaN(pid)) throw new Error(`no process listening on ${listen}`);
  return pid;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const failures: string[] = [];
const report = (line: string) => console.info(line);
const shot = (name: string) =>
  page.screenshot({ path: join(dir, name), timeout: 120_000 }).catch(() => report(`(no screenshot ${name})`));
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(250))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  const buy = ticket.getByRole('button', { name: 'Buy market', exact: true });
  await until(() => buy.isEnabled({ timeout: 1_000 }), 180_000, 'Buy market is on');
  report('connected: Buy market is on');
  await shot('1-connected.png');

  const before = await orderIds();
  const pid = pidOnPort(port);
  report(`hung: SIGSTOP ${String(pid)}`);
  process.kill(pid, 'SIGSTOP');
  await buy.click({ timeout: 30_000 });
  report('hung: clicked Buy market');
  const notice = page.getByRole('alert').filter({ hasText: /\S/ }).first();
  await notice.waitFor({ timeout: 40_000 });
  const unknown = (await notice.innerText()).replace(/\s+/g, ' ').trim();
  report(`hung: the notice reads "${unknown}"`);
  if (!/No answer from the runtime/i.test(unknown)) failures.push(`during the hang the ticket said "${unknown}"`);
  if (/tools\.invoke|\d+ms/i.test(unknown)) failures.push(`the notice shows developer text: "${unknown}"`);
  await shot('2-hung-unknown.png');

  const off = await buy.isDisabled();
  report(`hung: Buy market is ${off ? 'off' : 'on'} after no answer`);
  if (!off) failures.push('Buy market re-armed while the first click was still unresolved');
  await buy.click({ force: true, timeout: 30_000 });
  report('hung: clicked Buy market again');
  await shot('3-hung-second-click.png');

  process.kill(pid, 'SIGCONT');
  report('awake: SIGCONT');
  await page.waitForTimeout(2_000);
  const said = (await notice.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const late = await newOrders(before);
  report(`awake: the notice reads "${said}"; orders: ${late.length === 0 ? 'none' : late.join(', ')}`);
  if (late.length > 0) failures.push(`the hung click sent ${late.join(', ')} once the runtime woke`);
  if (!/Not sent|Too late/i.test(said) && late.length === 0) {
    const body = await page.locator('body').innerText();
    if (!/Not sent|Too late/i.test(body)) failures.push(`after wake the ticket did not say the order was late: "${said}"`);
  }
  await shot('4-awake-late.png');

  await until(() => buy.isEnabled({ timeout: 1_000 }), 30_000, 'Buy market is on after the late refuse');
  const now = await orderIds();
  await buy.click({ timeout: 30_000 });
  await until(async () => (await newOrders(now)).some((o) => o === 'buy market filled'), 30_000, 'the buy fills');
  report(`connected: Buy market sent ${(await newOrders(now)).join(', ')}`);
  await shot('5-sent-now.png');
  await ticket.getByRole('button', { name: 'Flat', exact: true }).click({ timeout: 30_000 });
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  await shot('failed.png');
  try {
    process.kill(pidOnPort(port), 'SIGCONT');
  } catch {}
} finally {
  await browser.close();
  rpc.close();
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
