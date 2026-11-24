#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/share', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: share.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

function firstJsonLine<T>(child: ChildProcess, has: (v: Record<string, unknown>) => boolean): Promise<T> {
  return new Promise((done, fail) => {
    child.once('exit', (code) => fail(new Error(`exited (${String(code)}) before it was ready`)));
    const seen: Record<string, unknown> = {};
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        Object.assign(seen, JSON.parse(line) as object);
      } catch {
        return;
      }
      if (has(seen)) done(seen as T);
    });
  });
}

const cloud = spawn(
  'bun',
  [
    '--tsconfig-override=apps/cloud/tsconfig.json',
    join(repo, '.agents/skills/verify-tessera/scripts/share-cloud.ts'),
  ],
  { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] },
);
const { cloud: cloudUrl, tester } = await firstJsonLine<{ cloud: string; tester: string }>(
  cloud,
  (v) => typeof v.cloud === 'string',
);

const data = mkdtempSync(join(tmpdir(), 'tessera-share-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir || join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TESSERA_NO_RITHMIC: '1', TESSERA_TEST_ACCOUNTS: '1', TESSERA_CLOUD_URL: cloudUrl },
  },
);
const ready = await firstJsonLine<{ port: number; token: string }>(
  runtime,
  (v) => typeof v.port === 'number' && typeof v.token === 'string',
);
const origin = `http://127.0.0.1:${String(ready.port)}`;

const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`);
await new Promise((done, fail) => {
  ws.onopen = done;
  ws.onerror = fail;
});
const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
  if (m.id !== undefined) waiting.get(m.id)?.(m);
};
let rpcId = 0;
const call = (method: string, params: unknown) =>
  new Promise<{ result?: unknown; error?: { message: string } }>((done) => {
    waiting.set(++rpcId, done);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }));
  });
await call('session.hello', {
  client: { name: 'share-proof', version: '0', platform: 'node' },
  protocolVersion: 1,
  token: ready.token,
});
async function tool<T>(name: string, input: unknown): Promise<T> {
  const answer = await call('tools.invoke', { name, input });
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  const result = answer.result as { ok: boolean; output: T; error: { message: string } | null };
  if (!result.ok) throw new Error(`${name}: ${result.error?.message ?? 'refused'}`);
  return result.output;
}

const { dataSource } = await tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await tool<{ accounts: { account: { id: string; environment: string; displayName: string } }[] }>(
  'portfolio.get_accounts',
  {},
);
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  console.error('refused: not the sim runtime');
  process.exit(1);
}

const failures: string[] = [];
const expectThat = (ok: boolean, line: string) => {
  console.info(`${ok ? 'ok' : 'FAIL'}: ${line}`);
  if (!ok) failures.push(line);
};
const save = (name: string, value: unknown) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function approved(input: Record<string, unknown>, name = 'orders.submit'): Promise<string> {
  const answer = await call('tools.invoke', { name, input });
  const result = answer.result as {
    status: string;
    approval: { approvalId: string; previewHash: string } | null;
    error?: { message: string } | null;
  };
  if (result.status !== 'pending_approval' || !result.approval) return result.error?.message ?? result.status;
  const resolved = await call('approvals.resolve', { ...result.approval, decision: 'approve' });
  if (resolved.error) throw new Error(`approvals.resolve: ${resolved.error.message}`);
  return 'approved';
}

async function tradeOnPaper() {
  const quote = await tool<{ last: number | null; bid: number | null }>('market.get_quote', { instrument: 'NQ' });
  const last = quote.last ?? quote.bid ?? 0;
  const tick = (p: number) => Math.round(p * 4) / 4;
  const order = { accountId: 'paper-main', instrument: 'NQ', side: 'buy', qty: 2 };
  await approved({
    ...order,
    orderType: 'market',
    bracket: { stopLoss: tick(last - 60), takeProfit: tick(last + 80) },
  });
  await approved({ ...order, qty: 1, orderType: 'limit', limitPrice: tick(last - 140) });
  const { positions } = await tool<{ positions: { instrument: string; qty: number }[] }>('portfolio.get_positions', {
    accountId: 'paper-main',
  });
  save('positions', positions);
  return positions.some((p) => p.qty !== 0);
}

async function signIn() {
  const { url } = await tool<{ url: string }>('account.sign_in', {});
  const landed = await fetch(url, { redirect: 'follow' });
  expectThat(landed.ok, `the sign-in round trip lands on the runtime's page (${String(landed.status)})`);
  for (let i = 0; i < 40; i++) {
    const s = await tool<{ phase: string; access: string | null; entitlements: string[] }>('account.status', {
      check: true,
    });
    if (s.phase === 'signed_in' && s.access === 'full') return s;
    await sleep(250);
  }
  throw new Error('the sim runtime did not sign in to the stand-in Cloud');
}

function standInShell({ port, token }: { port: number; token: string }) {
  let nextId = 1;
  Object.assign(window, {
    isTauri: true,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => nextId++,
      unregisterCallback: () => undefined,
      invoke: async (cmd: string, args: { handler?: number }) => {
        switch (cmd) {
          case 'plugin:event|listen':
            return args.handler;
          case 'runtime_connection':
            return { port, token };
          default:
            return null;
        }
      },
    },
  });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await context.addInitScript(standInShell, ready);
const page: Page = await context.newPage();
const shot = (name: string, on: Page = page) => on.screenshot({ path: join(dir, `${scene}-${name}.png`) });

async function arrive() {
  await page.goto(origin);
  const workspace = page.getByRole('main', { name: 'Workspace' });
  const splash = page.locator('.t-sh-splash[role="dialog"]');
  let clear = 0;
  for (let i = 0; i < 240 && clear < 6; i++) {
    const accept = page.getByRole('button', { name: /^(Accept|Continue)$/ });
    if (await accept.isVisible().catch(() => false)) {
      await accept.click();
      clear = 0;
    } else if ((await workspace.isVisible()) && !(await splash.isVisible().catch(() => false))) clear += 1;
    else clear = 0;
    await sleep(500);
  }
  await workspace.waitFor({ timeout: 10_000 });
  await sleep(3_000);
}

async function chartMenu() {
  await page.getByRole('button', { name: 'Chart: more' }).filter({ visible: true }).first().click();
  await page.getByRole('menu').first().waitFor();
}

async function settingsApp() {
  await page.keyboard.press('Control+Comma');
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'App', exact: true }).click();
  await sleep(1_000);
}

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

async function openSignedOut(url: string, name: string, device: typeof DESKTOP | typeof PHONE = DESKTOP) {
  const outside = await browser.newContext(device);
  const visitor = await outside.newPage();
  const response = await visitor.goto(url);
  await sleep(500);
  await visitor.screenshot({ path: join(dir, `${scene}-${name}.png`), fullPage: true });
  const text = await visitor.content();
  const sideways = await visitor.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await outside.close();
  return { status: response?.status() ?? 0, headers: response?.headers() ?? {}, text, sideways };
}

try {
  const who = await signIn();
  save('account', who);
  expectThat(who.entitlements.includes('share'), `the stand-in Cloud offers sharing (${who.entitlements.join(', ')})`);
  expectThat(await tradeOnPaper(), 'Paper holds a bracketed NQ position and a working limit');
  await arrive();
  await page.locator('[data-trading-state] .ct-tag, [data-trading-state] [role="button"]').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await chartMenu();
  await shot('chart-menu');
  const offered = await page.getByRole('menuitem', { name: 'Share chart…' }).isVisible();

  if (scene === 'main') {
    expectThat(!offered, 'main has no Share chart… in the chart menu');
    await page.keyboard.press('Escape');
    await settingsApp();
    await shot('settings-app');
  } else {
    expectThat(offered, 'the chart menu offers Share chart…');
    await page.getByRole('menuitem', { name: 'Share chart…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share chart' });
    await dialog.waitFor();
    const create = dialog.getByRole('button', { name: 'Create link' });
    await create.waitFor({ timeout: 60_000 });
    await sleep(500);
    await shot('share-ready');
    expectThat(!(await dialog.getByRole('textbox', { name: 'Link' }).isVisible()), 'no link before Create link');
    const before = await tool<{ shares: unknown[] }>('share.list', {});
    expectThat(before.shares.length === 0, 'nothing is shared before Create link');
    await create.click();
    const link = dialog.getByRole('textbox', { name: 'Link' });
    await link.waitFor({ timeout: 60_000 });
    const url = await link.inputValue();
    await sleep(500);
    await shot('shared-dialog');
    expectThat(await dialog.getByRole('button', { name: 'Done' }).isVisible(), 'the shared dialog ends on Done');
    expectThat(url.startsWith(`${cloudUrl}/s/`) && /\/s\/[0-9A-Za-z]{12}$/.test(url), `the link is short: ${url}`);

    const listed = await tool<{ available: boolean; shares: { id: string; url: string; title: string }[] }>(
      'share.list',
      {},
    );
    save('share-list', listed);
    expectThat(listed.shares.length === 1 && listed.shares[0]!.url === url, 'share.list holds the one link');
    const title = listed.shares[0]?.title ?? '';

    const opened = await openSignedOut(url, 'shared-page');
    expectThat(opened.status === 200, `the link opens signed out (${String(opened.status)})`);
    expectThat(opened.text.includes('/assets/wordmark.svg'), 'the page carries the Tessera mark');
    expectThat(opened.text.includes(title), `the page names the chart (${title})`);
    for (const secret of [tester, 'Paper Tester', 'Sign out', ...accounts.map((a) => a.account.id)]) {
      expectThat(!opened.text.includes(secret), `the page holds no ${secret}`);
    }
    expectThat(opened.headers['x-robots-tag'] === 'noindex, nofollow, noarchive', 'the page asks not to be indexed');
    expectThat(opened.headers['cache-control'] === 'no-store', 'the page is not cached');
    const image = await fetch(`${url}/image`);
    const bytes = new Uint8Array(await image.arrayBuffer());
    writeFileSync(join(dir, 'shared-image.png'), bytes);
    expectThat(image.ok && bytes.length > 1000, `the picture opens signed out (${String(bytes.length)} bytes)`);
    const phone = await openSignedOut(url, 'shared-page-phone', PHONE);
    expectThat(phone.status === 200 && !phone.sideways, 'the page fits a phone without sideways scroll');

    await dialog.getByRole('button', { name: 'Done' }).click();
    await dialog.waitFor({ state: 'detached' });
    await settingsApp();
    const shares = page.getByRole('region', { name: 'Shares' });
    await shares.scrollIntoViewIfNeeded();
    await shares.getByText(title).waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot('settings-shares');
    await shares.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Delete this link?' }));
    await confirm.first().waitFor();
    await shot('settings-delete-confirm');
    await confirm.first().getByRole('button', { name: 'Delete link' }).click();
    await shares.getByText('Nothing shared yet').waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot('settings-shares-empty');

    const gone = await openSignedOut(url, 'deleted-link');
    expectThat(gone.status === 404, `the deleted link no longer opens (${String(gone.status)})`);
    expectThat((await fetch(`${url}/image`)).status === 404, 'the deleted picture no longer opens');
    save('share-list-after-delete', await tool('share.list', {}));
  }
} catch (error) {
  failures.push(String(error));
  console.error(error);
  await shot('failure').catch(() => undefined);
} finally {
  await browser.close();
  ws.close();
  runtime.kill();
  cloud.kill();
  rmSync(data, { recursive: true, force: true });
}

console.info(failures.length === 0 ? `share proof: all ok (${dir})` : `share proof: ${String(failures.length)} failed`);
process.exit(failures.length === 0 ? 0 : 1);
