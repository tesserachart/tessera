#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type Locator } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/right-click'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: right-click-drop.ts <port> [evidence dir]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

interface Orders {
  orders: {
    id: string;
    role: string;
    status: string;
    request: { side: string; orderType: string; stopPrice: number | null; limitPrice: number | null };
  }[];
}

const info = await readRuntimeInfo(`http://127.0.0.1:${port}`);
const rpc = await RuntimeRpc.open(info);
const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await rpc.tool<{ accounts: { account: { environment: string } }[] }>('portfolio.get_accounts', {});
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  console.error('refused: not the sim runtime');
  process.exit(1);
}

function dataDirOn(listen: string): string {
  const ss = execFileSync('ss', ['-lptn', `sport = :${listen}`], { encoding: 'utf8' });
  const pid = ss.match(/pid=(\d+)/)?.[1];
  if (!pid) throw new Error(`no process listening on ${listen}`);
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const at = args.indexOf('--data-dir');
  if (at < 0 || !args[at + 1]) throw new Error(`the runtime on ${listen} names no --data-dir`);
  return args[at + 1]!;
}
const db = new DatabaseSync(join(dataDirOn(port), 'tessera.db'), { readOnly: true });
const calls = (tool: string) =>
  (db.prepare('SELECT count(*) AS n FROM tool_calls WHERE tool = ?').get(tool) as { n: number }).n;
const orders = async () => (await rpc.tool<Orders>('portfolio.get_orders', { accountId: 'paper-main' })).orders;
const stopPrice = async () =>
  (await orders()).find((o) => o.role === 'stop_loss' && o.status === 'working')?.request.stopPrice ?? null;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const failures: string[] = [];
const report = (line: string) => console.info(line);
const expectThat = (ok: boolean, what: string) => {
  report(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const shot = (name: string) =>
  page.screenshot({ path: join(dir, name), timeout: 120_000 }).catch(() => report(`(no screenshot ${name})`));
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(250))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};
const labelOf = async (l: Locator) => ((await l.count()) > 0 ? await l.first().getAttribute('aria-label') : null);
const centre = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
};

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  const buy = ticket.getByRole('button', { name: 'Buy market', exact: true });
  await until(() => buy.isEnabled({ timeout: 1_000 }), 180_000, 'Buy market is on');
  report(`connected: ${await ticket.getAttribute('aria-label')} on Paper`);
  await ticket.getByRole('switch', { name: 'Bracket' }).click();
  await until(
    async () => (await ticket.getByRole('switch', { name: 'Bracket' }).getAttribute('aria-checked')) === 'true',
    10_000,
    'the ticket’s bracket is on',
  );
  const positions = async () =>
    (await rpc.tool<{ positions: unknown[] }>('portfolio.get_positions', { accountId: 'paper-main' })).positions.length;
  const working = async () => (await orders()).filter((o) => o.status === 'working').length;
  const clearDesk = async () => {
    if ((await positions()) > 0) {
      await ticket.getByRole('button', { name: 'Flat', exact: true }).click({ timeout: 30_000 });
      await until(async () => (await positions()) === 0, 30_000, 'the account is flat');
    }
    if ((await working()) > 0) {
      await ticket.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 30_000 });
      await until(async () => (await working()) === 0, 30_000, 'no order is working');
    }
  };
  await clearDesk();

  const nq = page.getByLabel('Orders on the chart').first();
  const plot = await centre(nq);
  const chartMenu = page.getByRole('menu', { name: 'Chart menu' });
  const hint = nq.locator('.ct-hint');
  const at = { x: plot.box.x + plot.box.width * 0.35, y: plot.box.y + plot.box.height * 0.68 };

  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForTimeout(500);
  expectThat(await chartMenu.isVisible(), 'nothing in hand: a right-click on the chart opens the chart menu');
  await shot('1-menu-with-nothing-in-hand.png');
  await page.keyboard.press('Escape');
  await until(async () => !(await chartMenu.isVisible()), 10_000, 'the chart menu closes');

  const submitsBefore = calls('orders.submit');
  await ticket.getByRole('button', { name: 'Buy limit', exact: true }).click();
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await until(() => hint.isVisible(), 10_000, 'the placement hint shows');
  const ghost = nq.locator('.ct-tag.is-moving');
  report(`placing: hint "${(await hint.innerText()).replace(/\s+/g, ' ')}", order in hand "${await labelOf(ghost)}"`);
  await shot('2-placing-buy-limit.png');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForTimeout(500);
  const placingMenu = await chartMenu.isVisible();
  const placingHint = await hint.isVisible();
  const placingGhost = await ghost.count();
  await shot('3-placing-right-clicked.png');
  expectThat(!placingMenu, 'placing: the right-click opens no menu');
  expectThat(!placingHint && placingGhost === 0, 'placing: the right-click drops the Buy limit in hand');
  if (placingMenu) await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(2_500);
  const placed = calls('orders.submit') - submitsBefore;
  await shot('4-placing-then-left-click.png');
  expectThat(placed === 0, `placing: a left click after the right-click sends nothing (orders.submit +${placed})`);
  if (await hint.isVisible()) await page.keyboard.press('Escape');
  await clearDesk();

  await buy.click();
  const stop = nq.locator('[data-part="stop"].ct-tag');
  await until(async () => /^SL 20,631\.50/.test((await labelOf(stop)) ?? ''), 30_000, 'the stop tag shows');
  report(`position: ${await labelOf(nq.locator('[data-part="entry"].ct-tag'))}, stop ${await labelOf(stop)}`);

  const modifiesBefore = calls('orders.modify');
  const grip = await centre(stop);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, grip.y - 10, { steps: 5 });
  await page.waitForTimeout(300);
  report(`dragging: the stop reads "${await labelOf(stop)}"`);
  await shot('5-dragging-stop.png');
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(500);
  const dragMenu = await chartMenu.isVisible();
  const dropped = await labelOf(stop);
  await shot('6-dragging-right-pressed.png');
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  await page.waitForTimeout(2_500);
  const moved = calls('orders.modify') - modifiesBefore;
  const after = await stopPrice();
  await shot('7-dragging-released.png');
  expectThat(!dragMenu, 'dragging: the right press opens no menu');
  expectThat(/^SL 20,631\.50/.test(dropped ?? ''), `dragging: the right press puts the stop back ("${dropped}")`);
  expectThat(
    moved === 0 && after === 20631.5,
    `dragging: letting go sends nothing (orders.modify +${moved}, stop ${after})`,
  );
  if (await chartMenu.isVisible()) await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const controlBefore = calls('orders.modify');
  const again = await centre(stop);
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  await page.mouse.move(again.x, again.y + 10, { steps: 5 });
  await page.mouse.up();
  await until(async () => calls('orders.modify') > controlBefore, 15_000, 'the control drag sends its move');
  await page.waitForTimeout(1_500);
  report(
    `control: a drag let go without a right press sends orders.modify +${calls('orders.modify') - controlBefore}, stop ${await stopPrice()}`,
  );
  await shot('8-control-drag.png');

  await clearDesk();

  await page.getByRole('button', { name: /^Tessera menu:/ }).click();
  await page.getByRole('menuitem', { name: 'New from preset' }).click();
  await page.getByRole('menuitem', { name: /Scalp/ }).click();
  const dom = page.getByLabel('NQ Z6 depth of market');
  await until(() => dom.isVisible(), 60_000, 'the Scalp DOM shows');
  const ladder = dom.locator('.t-ladder');
  const ladderMenu = page.getByRole('menu', { name: 'Ladder menu' });
  const strip = dom.locator('.t-ladder-strip');
  const row = (price: string) =>
    ladder.locator('.r', { has: page.locator('.c.p', { hasText: new RegExp(`^${price.replace(/[.,]/g, '\\$&')}`) }) });
  const bid = (price: string) => row(price).locator('.c.bid');
  await until(async () => (await bid('20,639.00').count()) === 1, 30_000, 'the ladder shows 20,639.00');
  const stripText = async () => ((await strip.count()) > 0 ? (await strip.innerText()).replace(/\s+/g, ' ') : '');

  const pressBefore = calls('orders.submit');
  const cell = await centre(bid('20,639.00'));
  await page.mouse.move(cell.x, cell.y);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await shot('9-dom-pressing-bid.png');
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(500);
  const pressMenu = await ladderMenu.isVisible();
  await shot('10-dom-pressing-right.png');
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  await page.waitForTimeout(2_500);
  const pressSent = calls('orders.submit') - pressBefore;
  expectThat(!pressMenu, 'DOM press: the right press opens no menu');
  expectThat(pressSent === 0, `DOM press: letting go sends nothing (orders.submit +${pressSent})`);
  if (await ladderMenu.isVisible()) await page.keyboard.press('Escape');
  await clearDesk();

  await page.mouse.click(cell.x, cell.y);
  await until(async () => (await working()) > 0, 30_000, 'the DOM click rests a Buy limit at 20,639.00');
  const entryTag = row('20,639.00').locator('.c.bid [data-tag]');
  await until(async () => (await entryTag.count()) > 0, 15_000, 'the ladder shows the Buy limit at 20,639.00');
  const entryPrice = async () =>
    (await orders()).find((o) => o.role === 'entry' && o.status === 'working')?.request.limitPrice ?? null;
  report(`DOM: Buy limit resting at ${await entryPrice()}`);
  const dragBefore = calls('orders.modify');
  const tag = await centre(entryTag);
  const rowH = (await row('20,639.00').boundingBox())!.height;
  await page.mouse.move(tag.x, tag.y);
  await page.mouse.down();
  await page.mouse.move(tag.x, tag.y + rowH * 3, { steps: 6 });
  await page.waitForTimeout(300);
  await shot('11-dom-dragging-entry.png');
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(500);
  const dragMenu2 = await ladderMenu.isVisible();
  await shot('12-dom-dragging-right.png');
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  await page.waitForTimeout(2_500);
  const domMoved = calls('orders.modify') - dragBefore;
  const domEntry = await entryPrice();
  expectThat(!dragMenu2, 'DOM drag: the right press opens no menu');
  expectThat(
    domMoved === 0 && domEntry === 20639,
    `DOM drag: letting go sends nothing (orders.modify +${domMoved}, entry ${domEntry})`,
  );
  if (await ladderMenu.isVisible()) await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const domControl = calls('orders.modify');
  const tag2 = await centre(ladder.locator('.c.bid [data-tag]').first());
  await page.mouse.move(tag2.x, tag2.y);
  await page.mouse.down();
  await page.mouse.move(tag2.x, tag2.y + rowH * 3, { steps: 6 });
  await page.mouse.up();
  await until(async () => calls('orders.modify') > domControl, 15_000, 'the control DOM drag sends its move');
  await page.waitForTimeout(1_500);
  report(
    `control: a DOM drag let go without a right press sends orders.modify +${calls('orders.modify') - domControl}, entry ${await entryPrice()}`,
  );
  await clearDesk();

  const risk = ticket.getByRole('switch', { name: /Risk/ });
  await risk.click();
  await until(async () => (await risk.getAttribute('aria-checked')) === 'true', 10_000, 'risk sizing is on');
  const placeBefore = calls('orders.submit');
  const entryCell = await centre(bid('20,640.50'));
  await page.mouse.click(entryCell.x, entryCell.y);
  await until(async () => /stop/i.test(await stripText()), 10_000, 'the DOM asks for the stop');
  report(`DOM placing: the strip reads "${await stripText()}"`);
  await shot('13-dom-placing-stop.png');
  const stopCell = await centre(bid('20,639.50'));
  await page.mouse.move(stopCell.x, stopCell.y, { steps: 4 });
  await page.waitForTimeout(300);
  await page.mouse.click(stopCell.x, stopCell.y, { button: 'right' });
  await page.waitForTimeout(500);
  const placeMenu = await ladderMenu.isVisible();
  const placeMenuText = placeMenu ? (await ladderMenu.innerText()).replace(/\s+/g, ' ') : '';
  const afterStrip = await stripText();
  await shot('14-dom-placing-right-clicked.png');
  expectThat(
    !placeMenu,
    `DOM placing: the right-click opens no menu${placeMenu ? ` (it offers "${placeMenuText}")` : ''}`,
  );
  expectThat(!/stop/i.test(afterStrip), `DOM placing: the right-click drops the placement (strip "${afterStrip}")`);
  if (placeMenu) await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (/stop/i.test(await stripText())) await page.keyboard.press('Escape');
  const placeSent = calls('orders.submit') - placeBefore;
  expectThat(placeSent === 0, `DOM placing: nothing sent (orders.submit +${placeSent})`);
  await risk.click();
  await clearDesk();
  report('flat, nothing working');
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  await shot('failed.png');
} finally {
  await browser.close();
  rpc.close();
  db.close();
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
