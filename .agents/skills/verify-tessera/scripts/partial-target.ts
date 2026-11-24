#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/partial-target', attemptsArg = '12'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: partial-target.ts <port> [evidence dir] [attempts]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const ACCOUNT = 'paper-main';
const CONTRACT = 'NQ Z6';
const CONTRACTS = 2;
const STOP_TICKS = '400';
const TARGET_TICKS = '8';
const WATCH_MS = 120_000;

interface OrderEvent {
  orderId: string;
  parentId: string | null;
  role: string;
  kind: string;
  qty: number;
  filledQty: number;
  seq: number;
}
interface Attempt {
  entry: string;
  partial: boolean;
  lowest: number;
  events: string[];
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

const position = async () =>
  (await rpc.tool<{ positions: { qty: number }[] }>('portfolio.get_positions', { accountId: ACCOUNT })).positions[0]
    ?.qty ?? 0;
const entries = async () =>
  (await rpc.tool<{ orders: { id: string; role: string }[] }>('portfolio.get_orders', { accountId: ACCOUNT })).orders
    .filter((o) => o.role === 'entry')
    .map((o) => o.id);
const activity = async (entry: string) =>
  (await rpc.tool<{ rows: { event: OrderEvent }[] }>('journal.get_activity', { accountId: ACCOUNT, limit: 5_000 })).rows
    .map((r) => r.event)
    .filter((e) => e.orderId === entry || e.parentId === entry)
    .sort((a, b) => a.seq - b.seq);
const line = (e: OrderEvent) =>
  `${String(e.seq)} ${e.role} ${e.kind} qty ${String(e.qty)} filled ${String(e.filledQty)}`;

const stopFollows = (events: OrderEvent[]) => {
  const wrong: string[] = [];
  events.forEach((e, i) => {
    if (e.role !== 'take_profit' || e.kind !== 'part_filled') return;
    const next = events.slice(i + 1).find((n) => n.role === 'stop_loss');
    const left = e.qty - e.filledQty;
    if (next?.kind !== 'qty_changed' || next.qty - next.filledQty !== left)
      wrong.push(`after "${line(e)}" the stop went "${next ? line(next) : 'nowhere'}", not to ${String(left)} left`);
  });
  return wrong;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const failures: string[] = [];
const attempts: Attempt[] = [];
const report = (text: string) => console.info(text);
const shot = (name: string) =>
  page.screenshot({ path: join(dir, name), timeout: 120_000 }).catch(() => report(`(no screenshot ${name})`));
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(50))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  await until(() => ticket.getByRole('button', { name: 'Buy market', exact: true }).isEnabled(), 180_000, 'ready');
  await ticket.getByRole('combobox').first().click();
  await page.getByRole('option', { name: CONTRACT, exact: true }).click();
  const bracket = ticket.getByRole('switch', { name: 'Bracket' });
  if ((await bracket.getAttribute('aria-checked')) !== 'true') await bracket.click();
  await page.getByLabel('Stop distance').fill(STOP_TICKS);
  await page.getByLabel('Stop distance').press('Tab');
  await page.getByLabel('Target distance').fill(TARGET_TICKS);
  await page.getByLabel('Target distance').press('Tab');
  await ticket.getByRole('textbox', { name: 'Contracts' }).fill(String(CONTRACTS));
  await ticket.getByRole('textbox', { name: 'Contracts' }).press('Tab');

  for (let n = 1; n <= Number(attemptsArg) && !attempts.some((a) => a.partial); n += 1) {
    if ((await position()) !== 0) {
      await ticket.getByRole('button', { name: 'Flat', exact: true }).click();
      await until(async () => (await position()) === 0, 20_000, 'flat');
    }
    const before = new Set(await entries());
    await ticket.getByRole('button', { name: 'Buy market', exact: true }).click();
    let entry = '';
    await until(
      async () => {
        entry = (await entries()).find((id) => !before.has(id)) ?? '';
        return entry !== '';
      },
      10_000,
      'the entry reaches the runtime',
    );
    await shot(`attempt-${String(n)}-1-bracket.png`);
    let lowest = CONTRACTS;
    for (const start = Date.now(); Date.now() - start < WATCH_MS; await page.waitForTimeout(50)) {
      const qty = await position();
      lowest = Math.min(lowest, qty);
      if (qty === 0) break;
    }
    const events = await activity(entry);
    const attempt: Attempt = {
      entry,
      partial: events.some((e) => e.role === 'take_profit' && e.kind === 'part_filled'),
      lowest,
      events: events.map(line),
    };
    attempts.push(attempt);
    if (lowest < 0) failures.push(`attempt ${String(n)}: the position reversed to ${String(lowest)}`);
    report(`attempt ${String(n)}: ${attempt.partial ? 'the target filled in part' : 'no fill in part'}`);
    if (attempt.partial) {
      failures.push(...stopFollows(events).map((w) => `attempt ${String(n)}: ${w}`));
      for (const e of attempt.events) report(`  ${e}`);
      await page.waitForTimeout(1_000);
      await shot(`attempt-${String(n)}-2-flat.png`);
      writeFileSync(join(dir, 'target-in-part.txt'), `${attempt.events.join('\n')}\n`);
    }
  }
  if (!attempts.some((a) => a.partial)) failures.push(`no target filled in part in ${String(attempts.length)} attempts`);
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  await shot('failed.png');
} finally {
  writeFileSync(join(dir, 'partial-target.json'), JSON.stringify({ attempts, failures }, null, 1));
  await browser.close();
  rpc.close();
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
