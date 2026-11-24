#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/trading-lock', uiDir, build = 'pr'] = process.argv.slice(2);
if (build !== 'pr' && build !== 'main') throw new Error(`build is pr or main, not ${build}`);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const ZONE = 'America/New_York';
const ACCOUNT = 'paper-main';

const data = mkdtempSync(join(tmpdir(), 'tessera-trading-lock-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;

interface Served {
  process: ChildProcess;
  origin: string;
  token: string;
  ticket: string;
}

async function serve(): Promise<Served> {
  const child = spawn(
    bin,
    ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
    { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TZ: ZONE, TESSERA_NO_RITHMIC: '1' } },
  );
  const ready = await new Promise<{ port: number; token: string; ticket: string }>((done, fail) => {
    child.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
    const seen: { port?: number; token?: string; ticket?: string } = {};
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        Object.assign(seen, JSON.parse(line) as object);
      } catch {
        return;
      }
      if (seen.port && seen.token && seen.ticket) done({ port: seen.port, token: seen.token, ticket: seen.ticket });
    });
  });
  return { process: child, origin: `http://127.0.0.1:${String(ready.port)}`, token: ready.token, ticket: ready.ticket };
}

async function tool(at: Served, name: string, input: unknown): Promise<{ result?: unknown; error?: unknown }> {
  const ws = new WebSocket(`${at.origin.replace(/^http/, 'ws')}/ws`);
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown };
    if (m.id !== undefined) waiting.get(m.id)?.(m);
  };
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: unknown }>((done) => {
      waiting.set(++id, done);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  await call('session.hello', {
    client: { name: 'trading-lock', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: at.token,
  });
  const answer = await call('tools.invoke', { name, input });
  ws.close();
  return answer;
}

const save = (name: string, value: unknown) =>
  writeFileSync(join(dir, `${build}-${name}.json`), `${JSON.stringify(value, null, 2)}\n`);

async function open(page: Page, at: Served) {
  await page.goto(`${at.origin}/#ticket=${at.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Account: Paper,/ }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
}

const ticket = (page: Page) => page.locator('section.tk').first();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  timezoneId: ZONE,
});
const page = await context.newPage();
let at = await serve();
try {
  const zoned = await tool(at, 'settings.set', { key: 'display.timeZone', value: ZONE });
  if (zoned.error) throw new Error(`display.timeZone: ${JSON.stringify(zoned.error)}`);
  await open(page, at);
  await ticket(page).screenshot({ path: join(dir, `${build}-ticket.png`) });
  await page.getByRole('button', { name: /^Account: Paper,/ }).click();
  const lockItem = page.getByRole('menuitem', { name: /^Lock trading/ });
  const accountsItem = page.getByRole('menuitem', { name: /^Accounts & connections/ });
  await accountsItem.waitFor();
  await page.waitForTimeout(400);
  if (build === 'main') {
    await page.screenshot({ path: join(dir, 'main-menu.png') });
    console.log(`main stills in ${dir}`);
  } else {
    await lockItem.hover();
    const fifteen = page.getByRole('menuitem', { name: /^15 min/ });
    await fifteen.waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(dir, 'pr-menu.png') });
    await fifteen.click();
    const chip = page.getByRole('button', { name: /^Account: Paper, Locked until 14:57$/ });
    await chip.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await ticket(page).screenshot({ path: join(dir, 'pr-locked-ticket.png') });
    const line = (await ticket(page).locator('.tk-line.is-locked').textContent()) ?? '';
    const buy = page.getByRole('button', { name: /^Buy market/ }).first();
    const refused = await tool(at, 'orders.preview', {
      accountId: ACCOUNT,
      instrument: 'NQZ6.CME',
      side: 'buy',
      qty: 1,
      orderType: 'market',
    });
    save('lock', await tool(at, 'risk.get_lock', { accountId: ACCOUNT, instrument: 'NQZ6.CME' }));
    save('refused', refused);
    save('orders', await tool(at, 'portfolio.get_orders', { accountId: ACCOUNT }));
    console.log(`ticket line: ${line}`);
    console.log(`Buy market disabled: ${String(await buy.isDisabled())}`);
    const checks = (refused.result as { output?: { checks?: unknown[] } } | undefined)?.output?.checks ?? [];
    console.log(`orders.preview checks: ${JSON.stringify(checks)}`);

    at.process.kill('SIGTERM');
    await new Promise((done) => at.process.once('exit', done));
    at = await serve();
    await open(page, at);
    await chip.waitFor({ timeout: 15_000 });
    await ticket(page).screenshot({ path: join(dir, 'pr-after-restart-ticket.png') });
    save('lock-after-restart', await tool(at, 'risk.get_lock', { accountId: ACCOUNT }));
    console.log(`after a restart: ${(await chip.getAttribute('aria-label')) ?? ''}`);
    console.log(`pr stills in ${dir}`);
  }
} finally {
  await browser.close();
  at.process.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
