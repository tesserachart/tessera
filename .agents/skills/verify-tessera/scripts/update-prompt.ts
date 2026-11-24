#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/update-prompt', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: update-prompt.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const OFFERED = {
  version: '0.3.0-alpha.2',
  notes:
    'Footprint cells keep their size while you zoom. The DOM ladder recentres on the last price with one key. ' +
    'Alerts on a drawn line fire on the bar close you pick. The journal imports Tradovate fills with their fees. ' +
    'Settings › App shows where updates stand.',
};
const NEWER = {
  version: '0.3.0-alpha.3',
  notes:
    'The update card follows a newer build while it is already showing. Regaining focus checks again. ' +
    'Footprints keep their cells while you zoom.',
};

const data = mkdtempSync(join(tmpdir(), 'tessera-update-prompt-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir || join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
);
const ready = await new Promise<{ port: number; token: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; token?: string } = {};
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    try {
      Object.assign(seen, JSON.parse(line) as object);
    } catch {
      return;
    }
    if (seen.port && seen.token) done({ port: seen.port, token: seen.token });
  });
});
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
  client: { name: 'update-prompt', version: '0', platform: 'node' },
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

async function submit(input: Record<string, unknown>): Promise<void> {
  const answer = await call('tools.invoke', { name: 'orders.submit', input });
  const result = answer.result as { status: string; approval: { approvalId: string; previewHash: string } | null };
  if (result.status !== 'pending_approval' || !result.approval) throw new Error(`orders.submit: ${result.status}`);
  const resolved = await call('approvals.resolve', { ...result.approval, decision: 'approve' });
  if (resolved.error) throw new Error(`approvals.resolve: ${resolved.error.message}`);
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

interface FakeShell {
  update: typeof OFFERED | null;
  checkTakes: number;
  checkFails: boolean;
  downloadStep: number;
  calls: string[];
  emit: (payload: unknown) => void;
}

const KEPT_OFFER = 'standInShell.update';

function standInShell({ port, token }: { port: number; token: string }) {
  const callbacks = new Map<number, (data: unknown) => void>();
  const listeners = new Map<string, number[]>();
  let nextId = 1;
  const kept = localStorage.getItem('standInShell.update');
  const shell: FakeShell = {
    update: kept ? (JSON.parse(kept) as FakeShell['update']) : null,
    checkTakes: 0,
    checkFails: false,
    downloadStep: 150,
    calls: [],
    emit: (payload) => {
      for (const id of listeners.get('tessera://update') ?? [])
        callbacks.get(id)?.({ event: 'tessera://update', id, payload });
    },
  };
  const download = async () => {
    const version = shell.update?.version ?? '';
    const total = 48 << 20;
    for (let done = 0; done <= total; done += total / 40) {
      shell.emit({ kind: 'downloading', version, downloaded: done, total });
      await new Promise((r) => setTimeout(r, shell.downloadStep));
    }
    return null;
  };
  Object.assign(window, {
    isTauri: true,
    __standInShell: shell,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => callbacks.delete(id) },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: (cb: ((data: unknown) => void) | undefined, once = false) => {
        const id = nextId++;
        callbacks.set(id, (data) => {
          if (once) callbacks.delete(id);
          cb?.(data);
        });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (cmd: string, args: { event?: string; handler?: number }) => {
        if (cmd.startsWith('update_')) shell.calls.push(cmd);
        switch (cmd) {
          case 'plugin:event|listen':
            listeners.set(args.event!, [...(listeners.get(args.event!) ?? []), args.handler!]);
            return args.handler;
          case 'plugin:event|unlisten':
            return null;
          case 'runtime_connection':
            return { port, token };
          case 'update_check':
            await new Promise((r) => setTimeout(r, shell.checkTakes));
            if (shell.checkFails) throw new Error('the update endpoint did not answer');
            return shell.update;
          case 'update_download':
            return download();
          case 'update_install':
            return new Promise(() => undefined);
          default:
            return null;
        }
      },
    },
  });
}

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript(standInShell, ready);
let page: Page = await context.newPage();
const failures: string[] = [];
const expectThat = (ok: boolean, line: string) => {
  console.info(`${ok ? 'ok' : 'FAIL'}: ${line}`);
  if (!ok) failures.push(line);
};
const shot = (name: string) => page.screenshot({ path: join(dir, `${scene}-${name}.png`) });
const railShot = (name: string) => page.locator('.ar-rail').screenshot({ path: join(dir, `${scene}-${name}.png`) });
const railFoot = (name: string) =>
  page.locator('.ar-rail-foot').screenshot({ path: join(dir, `${scene}-${name}.png`) });
const cardShot = (name: string) =>
  page.getByRole('region', { name: 'Update' }).screenshot({ path: join(dir, `${scene}-${name}.png`) });
const shellCalls = () => page.evaluate(() => (window as unknown as { __standInShell: FakeShell }).__standInShell.calls);
const offer = (update: typeof OFFERED | null = OFFERED) =>
  page.evaluate(
    ([u, key]) => {
      (window as unknown as { __standInShell: FakeShell }).__standInShell.update = u;
      localStorage.setItem(key, JSON.stringify(u));
    },
    [update, KEPT_OFFER] as const,
  );
const downloadSlowly = (step: number) =>
  page.evaluate((s) => {
    (window as unknown as { __standInShell: FakeShell }).__standInShell.downloadStep = s;
  }, step);
const checkWith = (takes: number, fails: boolean) =>
  page.evaluate(
    ([t, f]) => {
      const shell = (window as unknown as { __standInShell: FakeShell }).__standInShell;
      shell.checkTakes = t;
      shell.checkFails = f;
    },
    [takes, fails] as const,
  );
const menuCheck = () =>
  page.evaluate(() => (window as unknown as { __standInShell: FakeShell }).__standInShell.emit({ kind: 'check' }));
const focusCheck = () =>
  page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
const save = (name: string, value: unknown) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2));

async function openOrdersPositionsAndASession() {
  const quote = await tool<{ last: number | null; bid: number | null }>('market.get_quote', { instrument: 'NQ' });
  const last = quote.last ?? quote.bid ?? 0;
  const order = { accountId: 'paper-main', instrument: 'NQ', side: 'buy', qty: 1 };
  await submit({ ...order, orderType: 'market' });
  await submit({ ...order, orderType: 'limit', limitPrice: Math.round((last - 150) * 4) / 4 });
  await submit({ ...order, side: 'sell', orderType: 'limit', limitPrice: Math.round((last + 150) * 4) / 4 });
  await tool('settings.set', {
    key: 'agent.providers',
    value: {
      'claude-code': { enabled: true, binaryPath: join(repo, '.agents/skills/verify-tessera/scripts/stand-in-claude.mjs') },
    },
  });
  await tool('agent.list_providers', { recheck: true });
  const { session } = await tool<{ session: { id: string } }>('agent.start_session', {
    preset: 'Trader',
    provider: 'claude-code',
  });
  await tool('agent.send', { sessionId: session.id, text: 'Walk me through the opening range.' });
  for (const text of ['Then the overnight high.', 'Then the volume at the edges.', 'Then the close.'])
    await tool('agent.send', { sessionId: session.id, text, delivery: 'queue' });
}

async function openWindow() {
  await page.goto(origin);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(3_000);
}

async function railCheck() {
  const item = page.locator('button[data-update-entry]');
  const words = async () => ({
    shown: (await item.innerText()).trim(),
    name: (await item.getAttribute('aria-label')) ?? '',
  });
  const foot = await page.locator('.ar-rail-foot button').evaluateAll((buttons) =>
    buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''),
  );
  expectThat(
    foot.indexOf('Check for updates') >= 0 && foot.indexOf('Check for updates') + 1 === foot.indexOf('Feedback'),
    `the rail's foot reads ${foot.join(' · ')}`,
  );
  const sizes = await page.locator('.ar-rail-foot button').evaluateAll((buttons) =>
    buttons.slice(0, 3).map((b) => `${String(b.getBoundingClientRect().width)}x${String(b.getBoundingClientRect().height)}`),
  );
  expectThat(new Set(sizes).size === 1, `Updates, Feedback and Settings share one size (${sizes.join(', ')})`);
  await railShot('rail-rest');
  await railFoot('rail-rest-foot');

  await offer(null);
  await checkWith(2_000, false);
  await item.click();
  await page.waitForTimeout(300);
  await railFoot('rail-checking');
  const checking = await words();
  expectThat(checking.shown === 'Checking…', `while checking it reads ${checking.shown}`);
  await page.locator('button[data-update-entry="up_to_date"]').waitFor({ timeout: 10_000 });
  await railFoot('rail-up-to-date');
  const upToDate = await words();
  expectThat(upToDate.shown === 'Up to date', `a check that finds nothing reads ${upToDate.shown}`);
  expectThat((await page.getByRole('dialog').count()) === 0, 'up to date: no dialog opens');
  expectThat((await page.getByRole('region', { name: 'Update' }).count()) === 0, 'up to date: no card shows');
  await page.locator('button[data-update-entry="rest"]').waitFor({ timeout: 10_000 });
  expectThat((await words()).name === 'Check for updates', 'Up to date settles back to Check for updates');

  await checkWith(300, true);
  await item.click();
  await page.locator('button[data-update-entry="failed"]').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await railFoot('rail-failed');
  await shot('rail-failed-window');
  const failed = await words();
  expectThat(
    failed.shown === 'Try again' && failed.name === 'Couldn’t check for updates. Try again',
    `a failed check reads ${failed.shown} (${failed.name})`,
  );

  await checkWith(300, false);
  await offer();
  await item.click();
  const card = page.getByRole('region', { name: 'Update' });
  await page.getByText(`Tessera ${OFFERED.version} is available`).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await shot('rail-prompt');
  await railShot('rail-prompt-rail');
  await cardShot('rail-prompt-card');
  expectThat(await card.isVisible(), 'Try again finds the build and opens the update card');
  expectThat((await page.getByRole('dialog').count()) === 0, 'the found build waits in the card, not a dialog');

  await card.getByRole('button', { name: 'Update', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Update to Tessera ${OFFERED.version}` });
  await dialog.waitFor();
  await page.waitForTimeout(600);
  await shot('rail-confirm');
  const text = (await dialog.innerText()).replace(/\s+/g, ' ');
  expectThat(text.includes('Tessera will restart to install it.'), `the rail's build still asks first (${text})`);
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await dialog.waitFor({ state: 'detached' });
  const calls = await shellCalls();
  expectThat(
    calls.length === 3 && calls.every((c) => c === 'update_check'),
    `the rail only ever checks (${calls.join(',')})`,
  );
}

const entry = () => page.locator('button[data-update-entry]');
const entryState = () => entry().getAttribute('data-update-entry');
const barFraction = () =>
  page
    .locator('button[data-update-entry] .t-rail-progress > span')
    .evaluate((bar) => Number(/scaleX\(([\d.]+)\)/.exec((bar as HTMLElement).style.transform)?.[1] ?? 'NaN'))
    .catch(() => null);
const percentShown = async () => {
  const words = (await page.getByRole('status').filter({ hasText: 'Downloading' }).innerText()).trim();
  return Number(/(\d+)%/.exec(words)?.[1] ?? 'NaN');
};

async function startDownloadAndClickOff() {
  await offer();
  await downloadSlowly(450);
  await menuCheck();
  await page.getByText(`Tessera ${OFFERED.version} is available`).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Update to Tessera ${OFFERED.version}` });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Restart and update' }).click();
  await dialog.getByText(/Downloading/).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2_500);
  await shot('bg-dialog-downloading');
  await page.mouse.click(900, 120);
  await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_200);
  return dialog;
}

async function backgroundDownload() {
  const dialog = await startDownloadAndClickOff();
  expectThat((await dialog.count()) === 0, 'a click outside hides the downloading window');
  expectThat((await entryState()) === 'downloading', `the rail carries the download (${String(await entryState())})`);
  const first = await barFraction();
  await railFoot('bg-rail-downloading');
  await railShot('bg-rail-downloading-rail');
  await shot('bg-window-downloading');
  await page.waitForTimeout(2_500);
  const later = await barFraction();
  expectThat(
    first !== null && later !== null && later > first,
    `the bar under the icon keeps moving while hidden (${String(first)} → ${String(later)})`,
  );
  const name = (await entry().getAttribute('aria-label')) ?? '';
  expectThat(
    new RegExp(`^Downloading ${OFFERED.version.replace(/\./g, '\\.')} · \\d+%$`).test(name),
    `the rail item names the version and percent (${name})`,
  );

  await entry().click();
  await dialog.waitFor();
  const reopened = await percentShown();
  await page.waitForTimeout(300);
  await shot('bg-reopened');
  expectThat(
    later !== null && reopened >= Math.floor(later * 100),
    `reopening shows the same download, not a reset (${String(reopened)}% after ${String(later)})`,
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  expectThat((await entryState()) === 'downloading', 'Escape hides it and the download keeps going');

  await page.locator('button[data-update-entry="ready"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(400);
  await railFoot('bg-rail-ready');
  expectThat((await dialog.count()) === 0, 'a download that finishes while hidden waits as ready, out of the way');
  expectThat(
    (await shellCalls()).join(',') === 'update_check,update_download',
    `finishing while hidden never installs (${(await shellCalls()).join(',')})`,
  );

  await page.reload();
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 120_000 });
  await page.locator('button[data-update-entry="downloading"]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1_500);
  await railFoot('bg-relaunch-downloading');
  expectThat(
    (await shellCalls()).join(',') === 'update_check,update_download',
    `a relaunch picks the kept download up: it checks the build is still offered, then downloads (${(await shellCalls()).join(',')})`,
  );
  await page.locator('button[data-update-entry="ready"]').waitFor({ timeout: 60_000 });
  expectThat((await page.getByRole('dialog').count()) === 0, 'after a relaunch it waits as ready, without a window');

  await entry().click();
  await dialog.waitFor();
  await page.waitForTimeout(500);
  await shot('bg-ready-window');
  const text = (await dialog.innerText()).replace(/\s+/g, ' ');
  expectThat(
    text.includes('Tessera will restart to install it.') && text.includes('Restart and update'),
    `reopening the ready build offers the restart (${text})`,
  );
  await dialog.getByRole('button', { name: 'Restart and update' }).click();
  await dialog.getByText(/Installing/).waitFor({ timeout: 10_000 });
  expectThat(
    (await shellCalls()).join(',') === 'update_check,update_download,update_install',
    `only the explicit restart installs (${(await shellCalls()).join(',')})`,
  );
}

try {
  if (scene === 'main') {
    await openWindow();
    await railShot('rail-rest');
    await railFoot('rail-rest-foot');
    await shot('window');
    await startDownloadAndClickOff();
    await railFoot('bg-rail-downloading');
    await railShot('bg-rail-downloading-rail');
    await shot('bg-window-downloading');
  } else {
    await openWindow();
    await backgroundDownload();
    await page.evaluate((key) => localStorage.removeItem(key), KEPT_OFFER);
    await page.close();
    page = await context.newPage();
    await openWindow();
    await railCheck();
    await page.close();
    page = await context.newPage();
    await openWindow();
    await offer();
    await menuCheck();
    const firstPrompt = page.getByText(`Tessera ${OFFERED.version} is available`);
    await firstPrompt.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await shot('prompt');
    await cardShot('prompt-card');
    expectThat(
      (await shellCalls()).join(',') === 'update_check',
      `the menu's check only checks (${(await shellCalls()).join(',')})`,
    );
    expectThat(
      (await page.getByRole('dialog').count()) === 0,
      'the prompt is not a modal: no dialog is open',
    );

    await offer(NEWER);
    await focusCheck();
    const prompt = page.getByText(`Tessera ${NEWER.version} is available`);
    await prompt.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await shot('prompt-newer');
    await cardShot('prompt-newer-card');
    expectThat(!(await firstPrompt.isVisible()), 'the focus re-check replaces the older card');
    expectThat(
      (await shellCalls()).join(',') === 'update_check,update_check',
      `focus checks again without downloading (${(await shellCalls()).join(',')})`,
    );

    await page.getByRole('button', { name: 'Update', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Update to Tessera ${NEWER.version}` });
    await dialog.waitFor();
    await page.waitForTimeout(600);
    await shot('confirm-clear');
    const clearText = (await dialog.innerText()).replace(/\s+/g, ' ');
    expectThat(clearText.includes('Tessera will restart to install it.'), `clear: says it restarts (${clearText})`);
    expectThat(!clearText.includes('working order'), 'clear: lists nothing open');
    expectThat((await focused()) === 'Restart and update', `clear: focus on ${await focused()}`);
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await dialog.waitFor({ state: 'detached' });
    expectThat(await prompt.isVisible(), 'Not now keeps the quiet prompt');

    await openOrdersPositionsAndASession();
    const sessionRunning = async () =>
      (await tool<{ sessions: { status: string }[] }>('agent.list_sessions', {})).sessions.some(
        (s) => s.status === 'running',
      );
    for (let i = 0; i < 40 && !(await sessionRunning()); i++) await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await dialog.waitFor();
    await page.waitForTimeout(800);
    await shot('confirm-warnings');
    const warnText = (await dialog.innerText()).replace(/\s+/g, ' ');
    const orders = await tool<{ orders: { status: string }[] }>('portfolio.get_orders', { accountId: 'paper-main' });
    const positions = await tool<{ positions: { qty: unknown }[] }>('portfolio.get_positions', {
      accountId: 'paper-main',
    });
    const sessions = await tool<{ sessions: { id: string; status: string }[] }>('agent.list_sessions', {});
    save('orders', orders);
    save('positions', positions);
    save('sessions', sessions);
    const working = orders.orders.filter((o) => o.status === 'working').length;
    const open = positions.positions.filter((p) => Number(p.qty) !== 0).length;
    expectThat(working === 2 && open === 1, `the runtime holds ${String(working)} working and ${String(open)} open`);
    expectThat(
      warnText.includes(`You have ${String(working)} working orders and ${String(open)} open position.`),
      `warnings: counts match the runtime (${warnText})`,
    );
    expectThat(warnText.includes('They stay at your broker'), 'warnings: say orders stay at the broker');
    expectThat(warnText.includes('1 analyst session is in progress'), 'warnings: name the running session');
    expectThat((await focused()) === 'Not now', `warnings: focus on ${await focused()}`);

    await dialog.getByRole('button', { name: 'Restart and update' }).click();
    await page.waitForTimeout(2_500);
    await shot('downloading');
    await dialog.getByText(/Installing/).waitFor({ timeout: 30_000 });
    await shot('installing');
    expectThat(
      (await shellCalls()).join(',') === 'update_check,update_check,update_download,update_install',
      `download and install only after the confirmation (${(await shellCalls()).join(',')})`,
    );
  }
} finally {
  writeFileSync(join(dir, `${scene}-failures.txt`), failures.join('\n'));
  ws.close();
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
console.info(failures.length ? `${String(failures.length)} failed` : `all held; stills in ${dir}`);
process.exit(failures.length ? 1 : 0);
