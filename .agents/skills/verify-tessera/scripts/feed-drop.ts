#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/feed-drop'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: feed-drop.ts <port> [evidence dir]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
let link: 'up' | 'gone' = 'up';
const routes = new Set<WebSocketRoute>();
await page.routeWebSocket(/\/ws$/, (ws) => {
  if (link === 'gone') {
    void ws.close({ code: 4000, reason: 'unreachable' });
    return;
  }
  const server = ws.connectToServer();
  routes.add(ws);
  ws.onMessage((frame) => server.send(frame));
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
const bodyText = async () => (await page.innerText('body')).replace(/\s+/g, ' ');

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  const buy = ticket.getByRole('button', { name: 'Buy market', exact: true });
  await until(() => buy.isEnabled({ timeout: 1_000 }), 180_000, 'Buy market is on');
  report('connected: Buy market is on');

  const menu = page.getByRole('button', { name: /^Tessera menu:/ });
  await menu.click();
  await page.getByRole('menuitem', { name: 'New from preset' }).click();
  await page.getByRole('menuitem', { name: /Scalp/ }).click();
  await until(() => page.getByRole('region', { name: /DOM/ }).isVisible().catch(() => false), 60_000, 'Scalp DOM');
  await shot('1-scalp-live.png');

  await page.getByRole('button', { name: 'Buy market', exact: true }).click({ timeout: 30_000 });
  await until(async () => {
    const { positions } = await rpc.tool<{ positions: { qty: number }[] }>('portfolio.get_positions', {
      accountId: 'paper-main',
    });
    return positions.some((p) => p.qty !== 0);
  }, 30_000, 'paper long is open');
  report('connected: paper long is open');
  await shot('2-scalp-long.png');

  link = 'gone';
  for (const ws of [...routes]) await ws.close({ code: 4000, reason: 'unreachable' });
  await pageSays(/dropped\.\s*Reconnecting|Runtime\s+dropped/, 120_000);
  await page.waitForTimeout(1_500);
  await shot('3-status-drop.png');
  const annun = page.locator('.t-annun').first();
  const box = await annun.boundingBox();
  if (box) await page.screenshot({ path: join(dir, '3b-status-bar.png'), clip: box });
  const src = ((await annun.locator('.src').textContent()) ?? '').trim();
  const fact = ((await annun.locator('.t-annun-message').textContent()) ?? '').trim();
  const exposure = ((await annun.locator('.ex').textContent()) ?? '').trim();
  const line = ((await annun.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  report(`status: src="${src}" fact="${fact}" exposure="${exposure}" line="${line}"`);

  await shot('4-dom-footprint-drop.png');
  const dom = page.getByRole('region', { name: /DOM/ }).first();
  const domBox = await dom.boundingBox();
  if (domBox) await page.screenshot({ path: join(dir, '4b-dom.png'), clip: domBox });

  const pal = page.getByRole('dialog', { name: 'Command palette' });
  const openPal = async (query: string, shotName: string) => {
    await page.keyboard.press('Control+k');
    await pal.waitFor({ timeout: 15_000 });
    await pal.getByRole('combobox').fill(query);
    await page.waitForTimeout(800);
    await shot(shotName);
    const box = await pal.boundingBox();
    if (box) await page.screenshot({ path: join(dir, shotName.replace('.png', '-clip.png')), clip: box });
    return ((await pal.textContent()) ?? '').replace(/\s+/g, ' ');
  };

  const connectionsPal = await openPal('Connections', '5-palette-connections.png');
  const connectionsHighlighted = await pal.getByRole('option', { name: /^Connections$/, selected: true }).count();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_200);
  await shot('6-connections-settings.png');
  const settingsOpen = (await page.getByRole('heading', { name: 'Settings' }).count()) > 0;
  const connectionsList = (await page.getByRole('region', { name: 'Your connections' }).count()) > 0;
  const commandNamedTiles =
    (await page.getByRole('region', { name: /^Connections · / }).count()) +
    (await page.getByRole('region', { name: /^Ticket: Connections/ }).count());
  if (/ForcedLogout|os error|tools\.invoke/i.test(connectionsPal))
    failures.push(`palette shows developer text: "${connectionsPal}"`);
  if (connectionsHighlighted === 0 && !/Enter\s+run/i.test(connectionsPal))
    failures.push('palette did not highlight Connections with Enter run');
  if (!settingsOpen || !connectionsList)
    failures.push('Connections plus Enter did not open Settings › Connections');
  if (commandNamedTiles > 0) failures.push('a tile or ticket was labelled Connections');

  await page.locator('[data-area="desk"]').click();
  await until(() => page.getByRole('region', { name: /DOM/ }).isVisible().catch(() => false), 30_000, 'back on desk');

  const unknownPal = await openPal('ZZQX', '7-palette-unknown.png');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await shot('8-unknown-after-enter.png');
  if (!/Search could not reach the feed/i.test(unknownPal))
    failures.push(`unknown text did not say search could not reach the feed: "${unknownPal}"`);
  if ((await page.getByRole('region', { name: /ZZQX/ }).count()) > 0)
    failures.push('unknown text became a chart or ticket instrument');
  if (await pal.isVisible()) await page.keyboard.press('Escape');

  const palText = await openPal('ES', '9-palette-es.png');
  const deskEs = await pal.getByRole('option', { name: /(?:^|\s)ES(?:\s|$)/ }).count();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_200);
  await shot('10-es-after-enter.png');
  const esDom = page.getByRole('region', { name: /^ES\b.*DOM/ }).first();
  const esTape = page.getByRole('region', { name: /^ES\b.*(T&S|time)/i }).first();
  const esTicket = page.getByRole('region', { name: /^Ticket: ES/ }).first();
  if (await esDom.isVisible().catch(() => false)) {
    const box = await esDom.boundingBox();
    if (box) await page.screenshot({ path: join(dir, '10b-es-dom.png'), clip: box });
  }
  const leftover = /20,?64\d/;
  const esDomText = (await esDom.innerText().catch(() => '')) || '';
  const esTapeText = (await esTape.innerText().catch(() => '')) || '';
  const esTicketText = (await esTicket.innerText().catch(() => '')) || '';
  if (leftover.test(esDomText)) failures.push('ES DOM still shows NQ prices');
  if (leftover.test(esTapeText)) failures.push('ES T&S still shows NQ prints');
  if (leftover.test(esTicketText)) failures.push('ES ticket still shows NQ prices');

  link = 'up';
  await until(async () => {
    const buyOn = await page.getByRole('button', { name: 'Buy market', exact: true }).isEnabled().catch(() => false);
    const dropped = /dropped/.test(await bodyText());
    return buyOn || !dropped;
  }, 120_000, 'runtime link is back');
  await page.locator('[data-area="desk"]').click();
  await until(async () => (await page.getByRole('region', { name: /^ES\b/ }).count()) > 0, 30_000, 'desk shows ES after reconnect');
  await page.waitForTimeout(1_000);
  await shot('11-reconnected-es.png');
  if ((await page.getByRole('region', { name: /^ES\b/ }).count()) === 0)
    failures.push('after reconnect the ES switch is not visible');

  if (src !== 'Runtime') failures.push(`status source is "${src}"`);
  if (!/dropped/.test(fact)) failures.push(`status fact is "${fact}"`);
  if (/Long/.test(fact)) failures.push(`status splices the position into the fact: "${fact}"`);
  if (exposure && !/Long 1 NQ/.test(exposure)) failures.push(`status exposure is "${exposure}"`);
  if (/Runtime\s+Long/.test(line)) failures.push(`status splices the position: "${line}"`);
  if (/os error|tools\.invoke|ForcedLogout|20000ms/i.test(line)) failures.push(`status shows developer text: "${line}"`);
  const seen = await bodyText();
  if (/1792594048|\d{5,}s/.test(seen)) failures.push('DOM or legend shows a garbage elapsed time');
  if (/tools\.invoke|20000ms|os error 111/i.test(seen)) failures.push('a panel shows a raw error code');
  if (/ForcedLogout|os error|tools\.invoke/i.test(palText)) failures.push(`palette shows developer text: "${palText}"`);
  if (deskEs === 0) failures.push('palette has no desk symbol for ES');
  if ((await page.getByRole('region', { name: /^ES\b/ }).count()) === 0)
    failures.push('Enter after ES did not chart ES');
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
