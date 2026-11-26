#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type BrowserContext, type Page } from 'playwright';
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

const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const dataDirs: string[] = [];
const runtimes: ChildProcess[] = [];

interface Runtime {
  origin: string;
  ready: { port: number; token: string };
  tool: <T>(name: string, input: unknown) => Promise<T>;
  call: (method: string, params: unknown) => Promise<{ result?: unknown; error?: { message: string } }>;
  close: () => void;
}

async function startRuntime(name: string): Promise<Runtime> {
  const data = mkdtempSync(join(tmpdir(), `tessera-share-${name}-`));
  dataDirs.push(data);
  const child = spawn(
    bin,
    ['serve', '--port', '0', '--ui-dir', uiDir || join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, TESSERA_NO_RITHMIC: '1', TESSERA_TEST_ACCOUNTS: '1', TESSERA_CLOUD_URL: cloudUrl },
    },
  );
  runtimes.push(child);
  const ready = await firstJsonLine<{ port: number; token: string }>(
    child,
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
  async function tool<T>(toolName: string, input: unknown): Promise<T> {
    const answer = await call('tools.invoke', { name: toolName, input });
    if (answer.error) throw new Error(`${toolName}: ${answer.error.message}`);
    const result = answer.result as { ok: boolean; output: T; error: { message: string } | null };
    if (!result.ok) throw new Error(`${toolName}: ${result.error?.message ?? 'refused'}`);
    return result.output;
  }
  const { dataSource } = await tool<{ dataSource: string }>('connections.list', {});
  const { accounts } = await tool<{ accounts: { account: { environment: string } }[] }>('portfolio.get_accounts', {});
  if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
    console.error('refused: not the sim runtime');
    process.exit(1);
  }
  return { origin, ready, tool, call, close: () => ws.close() };
}

const a = await startRuntime('a');
const { tool } = a;
const { accounts } = await tool<{ accounts: { account: { id: string; environment: string; displayName: string } }[] }>(
  'portfolio.get_accounts',
  {},
);
const accountIds = accounts.map((x) => x.account.id);

const failures: string[] = [];
const expectThat = (ok: boolean, line: string) => {
  console.info(`${ok ? 'ok' : 'FAIL'}: ${line}`);
  if (!ok) failures.push(line);
};
const save = (name: string, value: unknown) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, read: () => Promise<T | null>, tries = 120): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const got = await read().catch(() => null);
    if (got !== null) return got;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function approved(input: Record<string, unknown>, name = 'orders.submit'): Promise<string> {
  const answer = await a.call('tools.invoke', { name, input });
  const result = answer.result as {
    status: string;
    approval: { approvalId: string; previewHash: string } | null;
    error?: { message: string } | null;
  };
  if (result.status !== 'pending_approval' || !result.approval) return result.error?.message ?? result.status;
  const resolved = await a.call('approvals.resolve', { ...result.approval, decision: 'approve' });
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

async function signIn(runtime: Runtime = a) {
  const { url } = await runtime.tool<{ url: string }>('account.sign_in', {});
  const landed = await fetch(url, { redirect: 'follow' });
  expectThat(landed.ok, `the sign-in round trip lands on the runtime's page (${String(landed.status)})`);
  for (let i = 0; i < 40; i++) {
    const s = await runtime.tool<{ phase: string; access: string | null; entitlements: string[] }>('account.status', {
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

async function desk(runtime: Runtime): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: runtime.origin });
  await context.addInitScript(standInShell, runtime.ready);
  return { context, page: await context.newPage() };
}

const { page } = await desk(a);
const shot = (name: string, on: Page = page) => on.screenshot({ path: join(dir, `${scene}-${name}.png`) });

async function arrive(on: Page, origin: string) {
  await on.goto(origin);
  const workspace = on.getByRole('main', { name: 'Workspace' });
  const splash = on.locator('.t-sh-splash[role="dialog"]');
  let clear = 0;
  for (let i = 0; i < 240 && clear < 6; i++) {
    const accept = on.getByRole('button', { name: /^(Accept|Continue)$/ });
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

interface Listed {
  available: boolean;
  shares: { id: string; url: string; kind: string; title: string }[];
}

async function createLink(dialogName: string, before: () => Promise<void> = async () => undefined) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.waitFor();
  const create = dialog.getByRole('button', { name: 'Create link' });
  await create.waitFor({ timeout: 60_000 });
  await before();
  const listedBefore = (await tool<Listed>('share.list', {})).shares.length;
  expectThat(!(await dialog.getByRole('textbox', { name: 'Link' }).isVisible()), `${dialogName}: no link before Create link`);
  await create.click();
  const link = dialog.getByRole('textbox', { name: 'Link' });
  await link.waitFor({ timeout: 60_000 });
  const url = await link.inputValue();
  expectThat(/\/s\/[0-9A-Za-z]{12}$/.test(url) && url.startsWith(`${cloudUrl}/s/`), `${dialogName}: the link is short (${url})`);
  const listedAfter = (await tool<Listed>('share.list', {})).shares.length;
  expectThat(listedAfter === listedBefore + 1, `${dialogName}: share.list holds one more link`);
  return { dialog, url };
}

async function pageIsClean(url: string, name: string, extra: readonly string[] = []) {
  const opened = await openSignedOut(url, name);
  expectThat(opened.status === 200, `${name}: opens signed out (${String(opened.status)})`);
  expectThat(opened.text.includes('/assets/wordmark.svg'), `${name}: carries the Tessera mark`);
  expectThat(/>Try Tessera</.test(opened.text), `${name}: links to Try Tessera`);
  expectThat(opened.headers['x-robots-tag'] === 'noindex, nofollow, noarchive', `${name}: asks not to be indexed`);
  expectThat(opened.headers['cache-control'] === 'no-store', `${name}: is not cached`);
  for (const secret of [tester, 'Paper Tester', 'Sign out', ...accountIds, ...extra]) {
    expectThat(!opened.text.includes(secret), `${name}: holds no ${secret}`);
  }
  const phone = await openSignedOut(url, `${name}-phone`, PHONE);
  expectThat(phone.status === 200 && !phone.sideways, `${name}: fits a phone without sideways scroll`);
  return opened.text;
}

async function openLinkFromPalette(on: Page, url: string) {
  await on.keyboard.press('Control+K');
  const palette = on.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor();
  await on.keyboard.type('Open a shared link');
  await sleep(400);
  await on.keyboard.press('Enter');
  const ask = on.getByRole('dialog', { name: 'Open a shared link' });
  await ask.waitFor();
  await ask.getByRole('textbox', { name: 'Link' }).fill(url);
  await ask.getByRole('button', { name: 'Open' }).click();
}

async function pasteLink(on: Page, url: string) {
  await on.evaluate((text) => navigator.clipboard.writeText(text), url);
  await on.getByRole('main', { name: 'Workspace' }).click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await on.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await on.keyboard.press('Control+V');
}

const STAND_IN = join(repo, '.agents/skills/verify-tessera/scripts/stand-in-claude.mjs');
const CODE = `export const indicator = { title: 'Proof EMA', placement: 'overlay', inputs: { length: 21 }, plots: ['ema'] };

export function compute(bars, inputs) {
  return { ema: ta.ema(bars.close, inputs.length) };
}
`;
async function menusOnMain() {
  const created = await tool<{ custom: { id: string } | null }>('indicators.create_custom', { code: CODE });
  await tool('chart.add_layer', {
    layoutId: 'default',
    tileId: 'chart-1',
    kind: 'custom',
    params: { indicator: created.custom?.id ?? '' },
  });
  const legend = page.getByRole('button', { name: /^Proof EMA.*: menu$/ }).filter({ visible: true }).first();
  await legend.waitFor({ timeout: 30_000 });
  await legend.click();
  await shot('legend-menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Tessera menu/ }).click();
  await shot('tessera-menu');
  await page.keyboard.press('Escape');
  await tool('settings.set', { key: 'agent.providers', value: { 'claude-code': { enabled: true, binaryPath: STAND_IN } } });
  await tool('agent.start_session', { preset: 'Trader', provider: 'claude-code', mode: 'auto_modify', title: 'Share proof: my NQ trade' });
  await page.keyboard.press('Control+J');
  await page.getByRole('button', { name: /^Session: / }).filter({ visible: true }).first().click();
  await sleep(500);
  await shot('session-menu');
  await page.keyboard.press('Escape');
  await settingsApp();
  await shot('settings-app');
}

const links: Record<string, string> = {};
let other: Runtime | null = null;

try {
  const who = await signIn();
  save('account', who);
  expectThat(who.entitlements.includes('share'), `the stand-in Cloud offers sharing (${who.entitlements.join(', ')})`);
  expectThat(await tradeOnPaper(), 'Paper holds a bracketed NQ position and a working limit');
  await arrive(page, a.origin);
  await page
    .locator('[data-trading-state] .ct-tag, [data-trading-state] [role="button"]')
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  await chartMenu();
  await shot('chart-menu');
  const offered = await page.getByRole('menuitem', { name: 'Share chart…' }).isVisible();

  if (scene === 'main') {
    await page.keyboard.press('Escape');
    await menusOnMain();
  } else {
    expectThat(offered, 'the chart menu offers Share chart…');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+S');
    const chartDialog = page.getByRole('dialog', { name: 'Share chart' });
    expectThat(
      await chartDialog.waitFor({ timeout: 10_000 }).then(
        () => true,
        () => false,
      ),
      '⌘⇧S opens Share chart on the active chart',
    );
    const chart = await createLink('Share chart', async () => {
      await sleep(500);
      await shot('share-ready');
      await chartDialog.getByRole('button', { name: 'Copy picture' }).click();
      await chartDialog.getByRole('button', { name: 'Copied' }).waitFor({ timeout: 20_000 });
      const copied = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const item = items[0];
        if (!item?.types.includes('image/png')) return null;
        const bytes = new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
        return Array.from(bytes);
      });
      expectThat(copied !== null && copied.length > 1000, 'Copy picture puts a PNG on the clipboard');
      if (copied) writeFileSync(join(dir, 'copied-picture.png'), Uint8Array.from(copied));
    });
    links.chart = chart.url;
    await sleep(500);
    await shot('shared-dialog');
    const chartPage = await pageIsClean(chart.url, 'shared-page');
    expectThat(chartPage.includes(`src="${chart.url}/image"`), 'the chart page shows the picture');
    const image = await fetch(`${chart.url}/image`);
    const bytes = new Uint8Array(await image.arrayBuffer());
    writeFileSync(join(dir, 'shared-image.png'), bytes);
    expectThat(image.ok && bytes.length > 1000, `the picture opens signed out (${String(bytes.length)} bytes)`);
    await chart.dialog.getByRole('button', { name: 'Done' }).click();
    await chart.dialog.waitFor({ state: 'detached' });

    await tool('settings.set', { key: 'agent.providers', value: { 'claude-code': { enabled: true, binaryPath: STAND_IN } } });
    await tool('agent.list_providers', { recheck: true });
    const title = 'Share proof: my NQ trade';
    const started = await tool<{ session: { id: string } }>('agent.start_session', {
      preset: 'Trader',
      provider: 'claude-code',
      mode: 'auto_modify',
      title,
    });
    const sessionId = started.session.id;
    await tool('agent.send', { sessionId, text: 'Share proof: how is my NQ trade doing?' });
    const said = await until('the stand-in answer', async () => {
      const t = await tool<{ entries: { kind?: string; text?: string }[] }>('agent.get_transcript', { sessionId });
      const { sessions } = await tool<{ sessions: { id: string; status: string }[] }>('agent.list_sessions', {});
      const idle = sessions.find((s) => s.id === sessionId)?.status === 'idle';
      const answer = JSON.stringify(t);
      return idle && answer.includes('open P&L') ? answer : null;
    });
    save('conversation-transcript', JSON.parse(said));
    const amount = /[+-]\$\d[\d,]*\.\d\d/.exec(said)?.[0] ?? '$';
    expectThat(said.includes('paper-main') && amount !== '$', `the stored answer names the account and ${amount}`);

    await page.keyboard.press('Control+J');
    const sessionButton = page.getByRole('button', { name: /^Session: / }).filter({ visible: true }).first();
    await sessionButton.waitFor({ timeout: 20_000 });
    if (!((await sessionButton.getAttribute('aria-label')) ?? '').includes(title)) {
      await sessionButton.click();
      await page.getByRole('menuitem', { name: new RegExp(title) }).first().click();
      await sleep(1_000);
    }
    await page.getByRole('button', { name: `Session: ${title}` }).filter({ visible: true }).first().click();
    await shot('session-menu');
    await page.getByRole('menuitem', { name: 'Share conversation…' }).click();
    const convoDialog = page.getByRole('dialog', { name: 'Share conversation' });
    const shown = convoDialog.getByRole('region', { name: 'The conversation as it is shared' });
    const convo = await createLink('Share conversation', async () => {
      await shown.waitFor({ timeout: 30_000 });
      await shown.getByText(/Stand-in answer/).first().waitFor({ timeout: 30_000 });
      const hidden = (await shown.textContent()) ?? '';
      expectThat(!hidden.includes('paper-main') && !hidden.includes(amount), 'the preview hides the account and the P/L');
      expectThat(!/\b2 contracts\b/.test(hidden), 'the preview hides the position size');
      await sleep(400);
      await shot('share-conversation');
      await convoDialog.getByRole('switch', { name: 'Show P/L' }).click();
      await shown.getByText(amount).first().waitFor({ timeout: 30_000 });
      const withPnl = (await shown.textContent()) ?? '';
      expectThat(!withPnl.includes('paper-main') && !/\b2 contracts\b/.test(withPnl), 'Show P/L keeps the account and size hidden');
      await shot('share-conversation-pnl');
      await convoDialog.getByRole('switch', { name: 'Show P/L' }).click();
      await until('the amount hidden again', async () => (((await shown.textContent()) ?? '').includes(amount) ? null : true));
    });
    links.conversation = convo.url;
    await shot('shared-conversation-dialog');
    const convoPage = await pageIsClean(convo.url, 'shared-conversation', [amount, '2 contracts']);
    expectThat(convoPage.includes('Stand-in answer for the demo'), 'the conversation page shows the answer');
    expectThat(convoPage.includes('Worked for'), 'the conversation page folds the steps');
    await convo.dialog.getByRole('button', { name: 'Done' }).click();
    await convo.dialog.waitFor({ state: 'detached' });
    await page.keyboard.press('Control+J');

    const created = await tool<{ custom: { id: string } | null }>('indicators.create_custom', {
      code: CODE,
      note: 'share proof',
    });
    const customId = created.custom?.id ?? '';
    await tool('chart.add_layer', { layoutId: 'default', tileId: 'chart-1', kind: 'custom', params: { indicator: customId } });
    const legend = page.getByRole('button', { name: /^Proof EMA.*: menu$/ }).filter({ visible: true }).first();
    await legend.waitFor({ timeout: 30_000 });
    await legend.click();
    await shot('legend-menu');
    await page.getByRole('menuitem', { name: 'Share…' }).click();
    const indicator = await createLink('Share indicator', async () => {
      await sleep(400);
      await shot('share-indicator');
    });
    links.indicator = indicator.url;
    await indicator.dialog.getByRole('button', { name: 'Done' }).click();
    const indicatorPage = await pageIsClean(indicator.url, 'shared-indicator');
    expectThat(indicatorPage.includes('Proof EMA') && indicatorPage.includes('ta.ema'), 'the indicator page shows its name and code');
    const setup = await fetch(`${indicator.url}/setup`);
    expectThat(setup.ok, `the setup JSON opens signed out (${String(setup.status)})`);
    save('shared-indicator-setup', await setup.json());

    await tool('chart.save_template', { layoutId: 'default', tileId: 'chart-1', name: 'Proof template' });
    const { templates } = await tool<{ templates: { id: string; name: string }[] }>('chart.list_templates', {});
    const template = templates.find((t) => t.name === 'Proof template');
    const templateLink = await tool<{ url: string }>('share.setup', { kind: 'template', id: template?.id ?? '' });
    links.template = templateLink.url;
    await pageIsClean(templateLink.url, 'shared-template');

    await page.getByRole('button', { name: /^Tessera menu/ }).click();
    await shot('tessera-menu');
    await page.getByRole('menuitem', { name: 'Share…' }).click();
    const workspace = await createLink('Share workspace', async () => {
      await sleep(400);
      await shot('share-workspace');
    });
    links.layout = workspace.url;
    await workspace.dialog.getByRole('button', { name: 'Done' }).click();
    await pageIsClean(workspace.url, 'shared-workspace');
    const sharedLayout = await (await fetch(`${workspace.url}/setup`)).text();
        const layoutSetup = JSON.parse(sharedLayout) as { setup: Record<string, unknown> };
    save('shared-workspace-setup', layoutSetup);
    expectThat(
      !('trade' in layoutSetup.setup) && !accountIds.some((id) => sharedLayout.includes(id)),
      'the shared workspace carries no ticket and no account',
    );

    const second = await tool<{ layoutId: string }>('workspace.create', { name: 'Second desk', instrument: 'ES', show: true });
    const keep = page
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ hasText: 'Save changes to' })
      .getByRole('button', { name: 'Save', exact: true });
    if (await keep.waitFor({ timeout: 5_000 }).then(() => true, () => false)) await keep.click();
    await page.getByRole('region', { name: /^ES Z6/ }).first().waitFor({ timeout: 30_000 });
    await sleep(2_000);
    await openLinkFromPalette(page, indicator.url);
    const offer = page.getByRole('dialog', { name: 'Shared indicator' });
    await offer.waitFor({ timeout: 30_000 });
    expectThat(await offer.getByText('Brings its own code').isVisible(), 'the offer says the indicator brings its own code');
    await shot('open-shared-indicator');
    await offer.getByRole('button', { name: 'Add to my charts' }).click();
    await offer.waitFor({ state: 'detached', timeout: 30_000 });
    const secondLayout = await tool<{ charts: Record<string, { layers: { kind: string; params: { indicator?: string } }[] }> }>(
      'layout.get',
      { layoutId: second.layoutId },
    );
    save('second-workspace-layout', secondLayout);
    const onSecond = Object.values(secondLayout.charts).some((c) => c.layers.some((l) => l.kind === 'custom'));
    expectThat(onSecond, 'the indicator link adds the indicator to another workspace');
    await sleep(1_500);
    await shot('second-workspace-with-indicator');

    other = await startRuntime('b');
    const b = other;
    await signIn(b);
    const { page: pageB } = await desk(b);
    await arrive(pageB, b.origin);
    await pasteLink(pageB, indicator.url);
    const offerB = pageB.getByRole('dialog', { name: 'Shared indicator' });
    await offerB.waitFor({ timeout: 30_000 });
    await offerB.getByRole('button', { name: 'Add to my charts' }).click();
    await offerB.waitFor({ state: 'detached', timeout: 30_000 });
    const listB = await b.tool<{ custom: { id: string; spec: { title: string } }[] }>('indicators.list', {});
    const arrived = listB.custom.find((c) => c.spec.title === 'Proof EMA');
    expectThat(arrived !== undefined, 'a pasted link brings the custom indicator into another Tessera');
    const detail = arrived ? await b.tool<{ code: string }>('indicators.get', { id: arrived.id }) : null;
    expectThat(detail?.code === CODE, 'its code arrives unchanged');
    const layoutB = await b.tool<{ charts: Record<string, { layers: { kind: string }[] }> }>('layout.get', {});
    expectThat(
      Object.values(layoutB.charts).some((c) => c.layers.some((l) => l.kind === 'custom')),
      'the other Tessera shows it on its chart',
    );
    await sleep(2_000);
    await shot('other-tessera-indicator', pageB);

    await openLinkFromPalette(pageB, templateLink.url);
    const templateOffer = pageB.getByRole('dialog', { name: 'Shared template' });
    await templateOffer.waitFor({ timeout: 30_000 });
    await shot('open-shared-template', pageB);
    await templateOffer.getByRole('button', { name: 'Use this template' }).click();
    await templateOffer.waitFor({ state: 'detached', timeout: 30_000 });
    const templatesB = await b.tool<{ templates: { name: string }[] }>('chart.list_templates', {});
    expectThat(templatesB.templates.some((t) => t.name === 'Proof template'), 'the template link saves the template there');

    await openLinkFromPalette(pageB, workspace.url);
    const workspaceOffer = pageB.getByRole('dialog', { name: 'Shared workspace' });
    await workspaceOffer.waitFor({ timeout: 30_000 });
    await workspaceOffer.getByRole('button', { name: 'Use this workspace' }).click();
    await workspaceOffer.waitFor({ state: 'detached', timeout: 30_000 });
    const layoutsB = await b.tool<{ layouts: { id: string; name: string }[]; activeId: string }>('layout.list', {});
    save('other-tessera-layouts', layoutsB);
    expectThat(layoutsB.layouts.length >= 2, 'the workspace link adds a workspace there');
    const added = await b.tool<{ trade: unknown }>('layout.get', { layoutId: layoutsB.activeId });
    expectThat(added.trade === null || added.trade === undefined, 'the added workspace has no ticket account');
    await sleep(2_000);
    await shot('other-tessera-workspace', pageB);

    await settingsApp();
    const shares = page.getByRole('region', { name: 'Shares' });
    await shares.scrollIntoViewIfNeeded();
    await shares.getByText('Proof EMA').first().waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot('settings-shares');
    const listed = await tool<Listed>('share.list', {});
    save('share-list', listed);
    expectThat(
      ['chart', 'conversation', 'indicator', 'template', 'layout'].every((k) => listed.shares.some((s) => s.kind === k)),
      'share.list holds one link of every kind',
    );
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Delete this link?' }));
    for (let left = listed.shares.length; left > 0; left--) {
      await shares.getByRole('button', { name: 'Delete' }).first().click();
      await confirm.first().waitFor();
      if (left === listed.shares.length) await shot('settings-delete-confirm');
      await confirm.first().getByRole('button', { name: 'Delete link' }).click();
      await until('a link gone', async () =>
        (await tool<Listed>('share.list', {})).shares.length === left - 1 ? true : null,
      );
      await confirm.first().waitFor({ state: 'detached' });
    }
    await shares.getByText('Nothing shared yet').waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot('settings-shares-empty');
    save('share-list-after-delete', await tool('share.list', {}));

    for (const [kind, url] of Object.entries(links)) {
      expectThat((await fetch(url)).status === 404, `the deleted ${kind} link no longer opens`);
    }
    expectThat((await fetch(`${links.chart}/image`)).status === 404, 'the deleted picture no longer opens');
    for (const kind of ['indicator', 'template', 'layout']) {
      expectThat((await fetch(`${links[kind]}/setup`)).status === 404, `the deleted ${kind} settings no longer open`);
    }
    await openSignedOut(links.conversation!, 'deleted-link');
    await openLinkFromPalette(pageB, indicator.url);
    const deadOffer = pageB.getByRole('dialog', { name: /^(Open a shared link|Shared indicator)$/ });
    const saysGone = await deadOffer
      .first()
      .getByText(/doesn’t work/)
      .waitFor({ timeout: 30_000 })
      .then(
        () => true,
        () => false,
      );
    await shot('other-tessera-deleted-link', pageB);
    expectThat(saysGone, 'a deleted indicator link says it doesn’t work in Tessera');
  }
} catch (error) {
  failures.push(String(error));
  console.error(error);
  await shot('failure').catch(() => undefined);
} finally {
  await browser.close();
  a.close();
  other?.close();
  for (const r of runtimes) r.kill();
  cloud.kill();
  for (const d of dataDirs) rmSync(d, { recursive: true, force: true });
}

console.info(failures.length === 0 ? `share proof: all ok (${dir})` : `share proof: ${String(failures.length)} failed`);
process.exit(failures.length === 0 ? 0 : 1);
