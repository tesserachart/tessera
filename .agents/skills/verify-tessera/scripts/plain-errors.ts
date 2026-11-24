#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page, type WebSocketRoute } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/plain-errors', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: plain-errors.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const ui = uiDir || join(repo, 'apps/desktop/dist');
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;

const REFUSAL = 'request rejected: [13] permission denied';
const RAW_ON_SCREEN = /\[\d+\]|\bcode \d+|request rejected|permission denied/i;

const failures: string[] = [];
const expectThat = (ok: boolean, line: string) => {
  console.info(`${ok ? 'ok' : 'FAIL'}: ${line}`);
  if (!ok) failures.push(line);
};

interface Runtime {
  port: number;
  ticket: string;
  child: ChildProcess;
  data: string;
}

async function launch(): Promise<Runtime> {
  const data = mkdtempSync(join(tmpdir(), 'tessera-plain-errors-'));
  const child = spawn(bin, ['serve', '--port', '0', '--ui-dir', ui, '--data-dir', data, '--launch-tickets'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const ready = await new Promise<{ port: number; ticket: string }>((done, fail) => {
    child.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
    const seen: { port?: number; token?: string; ticket?: string } = {};
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        Object.assign(seen, JSON.parse(line) as object);
      } catch {
        return;
      }
      if (seen.port && seen.ticket) done({ port: seen.port, ticket: seen.ticket });
    });
  });
  return { ...ready, child, data };
}

async function stop(runtime: Runtime) {
  const exited = new Promise((done) => runtime.child.once('exit', done));
  runtime.child.kill('SIGTERM');
  await exited;
  rmSync(runtime.data, { recursive: true, force: true });
}

function refusingBars(ws: WebSocketRoute) {
  const server = ws.connectToServer();
  const candles = new Set<number>();
  ws.onMessage((m) => {
    const sent = JSON.parse(String(m)) as { id?: number; method?: string; params?: { name?: string } };
    if (sent.method === 'tools.invoke' && sent.params?.name === 'market.get_candles' && sent.id !== undefined)
      candles.add(sent.id);
    server.send(m);
  });
  server.onMessage((m) => {
    const answer = JSON.parse(String(m)) as { id?: number; result?: Record<string, unknown> };
    if (answer.id !== undefined && candles.has(answer.id) && answer.result) {
      const error = { code: 'unsupported', message: REFUSAL, retryable: false, details: null };
      ws.send(JSON.stringify({ ...answer, result: { ...answer.result, ok: false, status: 'error', output: null, error } }));
      return;
    }
    ws.send(m);
  });
}

const browser = await chromium.launch();
const opened = async (r: Runtime, route?: (ws: WebSocketRoute) => void): Promise<Page> => {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  if (route) await page.routeWebSocket(/\/ws/, route);
  await page.goto(`http://127.0.0.1:${String(r.port)}/#ticket=${r.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll('.t-splash').length === 0, null, { timeout: 60_000 });
  return page;
};

try {
  const bars = await launch();
  try {
    const page = await opened(bars, refusingBars);
    const status = page.locator('.chart-status:not(.is-loading)').first();
    await status.waitFor({ timeout: 60_000 });
    const words = (await status.innerText()).trim();
    console.info(`chart: ${words}`);
    writeFileSync(join(dir, `${scene}-chart.txt`), words);
    await page.screenshot({ path: join(dir, `${scene}-chart.png`) });
    if (scene === 'pr') {
      expectThat(/did not load/.test(words), 'the chart says it did not load');
      expectThat(!RAW_ON_SCREEN.test(words), 'the chart shows no provider code');
      expectThat(/Ask your broker about access/.test(words), 'the chart says what to do');
    }
  } finally {
    await stop(bars);
  }

  const login = await launch();
  try {
    const page = await opened(login);
    await page.getByRole('button', { name: /^Settings/ }).first().click();
    await page.getByRole('button', { name: 'Connections', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add connection' }).first().click();
    await page.getByRole('menuitem', { name: /^Rithmic/ }).click();
    const form = page.getByRole('region', { name: 'Add a Rithmic login' });
    await form.getByRole('button', { name: 'Firm' }).click();
    await page.getByRole('option', { name: 'Tessera Test' }).click();
    await form.getByRole('combobox', { name: 'Gateway' }).filter({ hasText: 'Chicago Area' }).waitFor();
    await form.getByLabel('User').fill('trader');
    await form.getByLabel('Password').fill('wrong');
    await form.getByRole('button', { name: /^Test and save/ }).click();
    const said = form.getByRole('status').filter({ hasText: /Nothing saved/ });
    await said.waitFor({ timeout: 60_000 });
    const words = (await said.innerText()).trim();
    console.info(`login: ${words}`);
    writeFileSync(join(dir, `${scene}-login.txt`), words);
    await page.screenshot({ path: join(dir, `${scene}-login.png`) });
    if (scene === 'pr') {
      expectThat(!RAW_ON_SCREEN.test(words), 'the refused login shows no provider code');
      expectThat(/Check the user name and password/.test(words), 'the refused login says what to check');
    }
  } finally {
    await stop(login);
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`${String(failures.length)} failed`);
  process.exit(1);
}
