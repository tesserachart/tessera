#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/runtime-gone'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: runtime-gone.ts <port> [evidence dir]');
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
let link: 'up' | 'gone' | 'silent' = 'up';
const routes = new Set<WebSocketRoute>();
await page.routeWebSocket(/\/ws$/, (ws) => {
  if (link === 'gone') {
    void ws.close({ code: 4000, reason: 'unreachable' });
    return;
  }
  const server = ws.connectToServer();
  routes.add(ws);
  ws.onMessage((frame) => {
    if (link === 'silent' && String(frame).includes('"orders.submit"')) return;
    server.send(frame);
  });
  ws.onClose(() => routes.delete(ws));
  server.onClose(() => void ws.close());
});

const failures: string[] = [];
const report = (line: string) => console.info(line);
const shot = (name: string) =>
  page.screenshot({ path: join(dir, name), timeout: 120_000 }).catch(() => report(`(no screenshot ${name})`));
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(250))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};
const pageSays = (pattern: RegExp, timeoutMs: number) =>
  page.waitForFunction((source) => new RegExp(source).test(document.body.innerText), pattern.source, {
    timeout: timeoutMs,
  });

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  const buy = ticket.getByRole('button', { name: 'Buy market', exact: true });
  await until(() => buy.isEnabled({ timeout: 1_000 }), 180_000, 'Buy market is on');
  report('connected: Buy market is on');
  await shot('1-connected.png');

  const before = await orderIds();
  link = 'gone';
  for (const ws of [...routes]) await ws.close({ code: 4000, reason: 'unreachable' });
  await pageSays(/dropped\.\s*Reconnecting/, 120_000);
  const off = await buy.isDisabled();
  const note = (await ticket.getByRole('note').allInnerTexts()).join(' ');
  report(`runtime gone: Buy market is ${off ? 'off' : 'on'}; the ticket's note: "${note}"`);
  if (!off) failures.push('Buy market stays on while the runtime is gone');
  await shot('2-runtime-gone.png');
  await buy.click({ force: true, timeout: 30_000 });
  report('runtime gone: clicked Buy market');
  await page.waitForTimeout(2_000);
  link = 'up';
  await shot('3-clicked-while-gone.png');
  await until(() => buy.isEnabled({ timeout: 1_000 }), 120_000, 'Buy market is on again');
  await page.waitForTimeout(3_000);
  const late = await newOrders(before);
  report(`back: ${late.length === 0 ? 'no order' : late.join(', ')} reached the runtime from the click while it was gone`);
  if (late.length > 0) failures.push(`the click while the runtime was gone sent ${late.join(', ')} once it was back`);
  await shot('4-back.png');

  const quiet = await orderIds();
  link = 'silent';
  await buy.click({ timeout: 30_000 });
  report('silent runtime: clicked Buy market, the runtime never answers');
  const notice = page.getByRole('alert').filter({ hasText: /\S/ }).first();
  await notice.waitFor({ timeout: 120_000 });
  const said = (await notice.innerText()).replace(/\s+/g, ' ').trim();
  report(`silent runtime: the notice reads "${said}"`);
  if (/tools\.invoke|\d+ms/i.test(said)) failures.push(`the notice shows developer text: "${said}"`);
  await shot('5-no-answer.png');
  link = 'up';
  if ((await newOrders(quiet)).length > 0) failures.push('the swallowed order reached the runtime');

  const now = await orderIds();
  await until(() => buy.isEnabled({ timeout: 1_000 }), 120_000, 'Buy market is on after the silent order');
  await buy.click({ timeout: 30_000 });
  await until(async () => (await newOrders(now)).some((o) => o === 'buy market filled'), 30_000, 'the buy fills');
  report(`connected: Buy market sent ${(await newOrders(now)).join(', ')}`);
  await shot('6-sent-now.png');
  await ticket.getByRole('button', { name: 'Flat', exact: true }).click({ timeout: 30_000 });
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  await shot('failed.png');
} finally {
  await browser.close();
  rpc.close();
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
