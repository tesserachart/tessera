#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/feedback', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: feedback.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const githubDir = join(dir, 'github');
rmSync(githubDir, { recursive: true, force: true });

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

function startCloud(port = 0): { child: ChildProcess; ready: Promise<{ cloud: string }> } {
  const child = spawn(
    'bun',
    [
      '--tsconfig-override=apps/cloud/tsconfig.json',
      join(repo, '.agents/skills/verify-tessera/scripts/feedback-cloud.ts'),
      dir,
      String(port),
    ],
    { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return { child, ready: firstJsonLine<{ cloud: string }>(child, (v) => typeof v.cloud === 'string') };
}

let cloud = scene === 'pr' ? startCloud() : null;
const cloudUrl = cloud ? (await cloud.ready).cloud : null;

const data = mkdtempSync(join(tmpdir(), 'tessera-feedback-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir || join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      TESSERA_NO_RITHMIC: '1',
      ...(cloudUrl ? { TESSERA_TEST_ACCOUNTS: '1', TESSERA_CLOUD_URL: cloudUrl } : {}),
    },
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
  client: { name: 'feedback-proof', version: '0', platform: 'node' },
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
async function approved(input: Record<string, unknown>, name = 'orders.submit'): Promise<string> {
  const answer = await call('tools.invoke', { name, input });
  const result = answer.result as {
    status: string;
    output?: { order?: { id: string } };
    approval: { approvalId: string; previewHash: string } | null;
    error?: { message: string } | null;
  };
  if (result.status !== 'pending_approval' || !result.approval) return result.error?.message ?? result.status;
  const resolved = await call('approvals.resolve', { ...result.approval, decision: 'approve' });
  if (resolved.error) throw new Error(`approvals.resolve: ${resolved.error.message}`);
  return 'approved';
}

const { dataSource } = await tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await tool<{ accounts: { account: { id: string; environment: string } }[] }>(
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

async function signIn() {
  const { url } = await tool<{ url: string }>('account.sign_in', {});
  const landed = await fetch(url, { redirect: 'follow' });
  expectThat(landed.ok, `the sign-in round trip lands on the runtime's page (${String(landed.status)})`);
  for (let i = 0; i < 40; i++) {
    const s = await tool<{ phase: string; access: string | null }>('account.status', { check: true });
    if (s.phase === 'signed_in' && s.access === 'full') return s;
    await sleep(250);
  }
  throw new Error('the sim runtime did not sign in to the stand-in Cloud');
}

async function tradeOnPaper() {
  const quote = await tool<{ last: number | null; bid: number | null }>('market.get_quote', { instrument: 'NQ' });
  const last = quote.last ?? quote.bid ?? 0;
  const tick = (p: number) => Math.round(p * 4) / 4;
  const order = { accountId: 'paper-main', instrument: 'NQ', side: 'buy', qty: 1 };
  await approved({
    ...order,
    orderType: 'market',
    bracket: { stopLoss: tick(last - 40), takeProfit: tick(last + 60) },
  });
  await approved({ ...order, orderType: 'limit', limitPrice: tick(last - 120) });
  const { orders } = await tool<
    { orders: { id: string; status: string; request: { orderType: string; side: string } }[] }
  >(
    'portfolio.get_orders',
    { accountId: 'paper-main' },
  );
  const limit = orders.find(
    (o) => o.request.orderType === 'limit' && o.request.side === 'buy' && o.status === 'working',
  );
  if (limit) await approved({ accountId: 'paper-main', orderId: limit.id }, 'orders.cancel');
  const refused = await approved({ ...order, qty: 400, orderType: 'market' });
  console.info(`the oversized order: ${refused}`);
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
const shot = (name: string) => page.screenshot({ path: join(dir, `${scene}-${name}.png`) });
const sheet = () => page.getByRole('dialog', { name: 'Send feedback' });
const issues = () =>
  existsSync(githubDir)
    ? readdirSync(githubDir)
        .filter((f) => /^issue-\d+\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(githubDir, f), 'utf8')) as { number: number; title: string; body: string; labels: string[] })
    : [];

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

async function writeReport(text: string) {
  await page.keyboard.press('Control+Shift+Slash');
  await sheet().waitFor();
  await sheet().getByText('Order and protect events').waitFor({ timeout: 20_000 });
  await sheet().getByRole('textbox', { name: 'Your note' }).fill(text);
  await sheet().getByText(/This window, \d+×\d+/).waitFor({ timeout: 30_000 });
}

try {
  if (scene === 'pr') {
    const who = await signIn();
    save('account', who);
    await tool('settings.set', {
      key: 'agent.providers',
      value: {
        'claude-code': { enabled: true, binaryPath: join(repo, '.agents/skills/verify-tessera/scripts/stand-in-claude.mjs') },
      },
    });
    await tool('agent.list_providers', { recheck: true });
  }
  await tradeOnPaper();
  if (scene === 'pr') {
    const locked = await approved({ accountId: 'paper-main', span: { kind: 'minutes', minutes: 60 } }, 'risk.lock_account');
    console.info(`the Paper lock: ${locked}`);
  }
  await arrive();
  await shot('desk');
  await page.getByRole('button', { name: /^Tessera menu/ }).click();
  await sleep(500);
  await shot('app-menu');
  await page.keyboard.press('Escape');
  await sleep(1_000);

  if (scene === 'main') {
    await page.keyboard.press('Control+Comma');
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'App' }).click();
    await page.getByRole('region', { name: 'Report a problem' }).scrollIntoViewIfNeeded();
    await sleep(800);
    await shot('settings-report');
  }

  if (scene === 'pr') {
    const entry = page.locator('[data-feedback-entry]');
    expectThat(await entry.isVisible(), 'the rail shows Feedback');

    await writeReport('The stop line jumped back after I dragged it on the NQ chart.');
    await sleep(800);
    await shot('dialog');
    const context = await tool<{ items: { key: string; value: string; detail: string | null }[]; writer: unknown }>(
      'feedback.context',
      { app: { version: '0', commit: null, shell: 'desktop' }, instrument: 'NQZ6.CME', timeframe: '5m', accountId: 'paper-main' },
    );
    save('context', context);
    const text = (await sheet().innerText()).replace(/\s+/g, ' ');
    expectThat(text.includes('Account kind') && text.includes('Paper'), 'the context names the account kind, Paper');
    expectThat(!text.includes('paper-main'), 'the account id is not shown');
    expectThat(
      text.includes('Trading lock') && text.includes('Locked by the trader: entries refused until'),
      'the context names the trading lock, its cause and its end',
    );
    expectThat(context.writer !== null, 'the stand-in agent is connected, so the write-up is offered');

    await sheet().getByRole('button', { name: /Write it up for me/ }).click();
    const title = sheet().getByRole('textbox', { name: 'Title' });
    await title.waitFor({ timeout: 60_000 });
    await sleep(500);
    await shot('written-up');
    expectThat((await title.inputValue()).startsWith('Stand-in write-up:'), `the write-up fills the title (${await title.inputValue()})`);
    expectThat(issues().length === 0, 'writing it up sent nothing');
    await title.fill('Stop line jumps back after a drag on NQ');

    await sheet().locator('[data-feedback-item="orders"] summary').click();
    await sleep(300);
    await shot('events');
    await sheet().getByRole('button', { name: /^Send/ }).click();
    await sheet().locator('[data-feedback-sent]').waitFor({ timeout: 60_000 });
    await sleep(300);
    await shot('got-it');
    const gotIt = (await sheet().innerText()).replace(/\s+/g, ' ');
    const id = /fb-[a-z0-9]{12}/.exec(gotIt)?.[0] ?? '';
    expectThat(gotIt.includes('Got it.') && id !== '', `the got-it names the report (${gotIt})`);
    const filed = issues();
    save('issues-after-send', filed);
    const issue = filed.find((i) => i.body.includes(id));
    expectThat(issue !== undefined, `an issue carries ${id}`);
    expectThat(issue?.labels.includes('feedback') === true, `it is labelled feedback (${String(issue?.labels)})`);
    expectThat(issue?.title === 'Bug: Stop line jumps back after a drag on NQ', `its title (${String(issue?.title)})`);
    expectThat(issue?.body.includes('orders.submit') === true, 'it carries the order events');
    expectThat(issue?.body.includes('Stand-in write-up') === false && issue?.body.includes('agent') === true, 'it says the reporter’s agent wrote it up');
    const png = readdirSync(githubDir).find((f) => f.startsWith(`feedback_${id}_screenshot`));
    const bytes = png ? readFileSync(join(githubDir, png)) : Buffer.alloc(0);
    expectThat(bytes.subarray(1, 4).toString() === 'PNG' && bytes.length > 10_000, `the screenshot is attached (${String(bytes.length)} bytes)`);
    expectThat(!issue?.body.includes('paper-main') && !issue?.body.includes('tester@example.test'), 'no account id or email in the issue');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+Comma');
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'App' }).click();
    const reportRegion = page.getByRole('region', { name: 'Report a problem' });
    await reportRegion.scrollIntoViewIfNeeded();
    expectThat((await reportRegion.getByRole('textbox').count()) === 0, 'Settings › App › Report a problem has no PostHog form');
    await reportRegion.getByRole('button', { name: /^Send feedback…/ }).click();
    await sheet().getByText('Order and protect events').waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot('settings-report');
    expectThat(await sheet().isVisible(), 'Settings › App › Report a problem opens the feedback sheet');
    await page.keyboard.press('Escape');
    await sleep(500);
    await page.keyboard.press('Control+Comma');
    await sleep(500);

    cloud!.child.kill('SIGTERM');
    await sleep(1_000);
    await writeReport('Idea: a one-key flatten for every account at once.');
    await sheet().getByRole('button', { name: 'Idea' }).click();
    await sheet().getByRole('button', { name: /^Send/ }).click();
    await sheet().locator('[data-feedback-sent="queued"]').waitFor({ timeout: 60_000 });
    await sleep(300);
    await shot('queued');
    const queued = await tool<{ queued: { id: string; attempts: number }[] }>('feedback.outbox', {});
    save('outbox-offline', queued);
    expectThat(queued.queued.length === 1, `offline, one report waits (${String(queued.queued.length)})`);
    await page.keyboard.press('Escape');

    cloud = startCloud(Number(new URL(cloudUrl!).port));
    await cloud.ready;
    let left = queued.queued.length;
    for (let i = 0; i < 120 && left > 0; i++) {
      await sleep(1_000);
      left = (await tool<{ queued: unknown[] }>('feedback.outbox', {})).queued.length;
    }
    expectThat(left === 0, 'once Cloud is back the queued report goes by itself');
    const waited = queued.queued[0]?.id ?? '';
    expectThat(issues().some((i) => i.body.includes(waited) && i.labels.includes('feedback')), `the queued ${waited} landed as a labelled issue`);
    save('issues-after-retry', issues());
  }
} finally {
  await browser.close();
  ws.close();
  runtime.kill('SIGTERM');
  cloud?.child.kill('SIGTERM');
}
writeFileSync(join(dir, `${scene}-result.json`), JSON.stringify({ failures }, null, 2));
if (failures.length > 0) {
  console.error(`${String(failures.length)} check(s) failed`);
  process.exit(1);
}
console.info(`ok: evidence in ${dir}`);
