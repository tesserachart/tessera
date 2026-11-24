#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/rithmic-reconnecting', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: rithmic-reconnecting.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const ui = uiDir || join(repo, 'apps/desktop/dist');
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const SECOND_TRY = 'Connection lost. Reconnecting, 2nd try.';
const RAW_ON_SCREEN = /attempt \d|\[\d+\]|\bcode \d+/i;

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
  const data = mkdtempSync(join(tmpdir(), 'tessera-rithmic-reconnecting-'));
  const child = spawn(bin, ['serve', '--port', '0', '--ui-dir', ui, '--data-dir', data, '--launch-tickets'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TESSERA_TEST_RITHMIC: 'dropped' },
  });
  const ready = await new Promise<{ port: number; ticket: string }>((done, fail) => {
    child.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
    const seen: { port?: number; ticket?: string } = {};
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

const browser = await chromium.launch();
const runtime = await launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await page.goto(`http://127.0.0.1:${String(runtime.port)}/#ticket=${runtime.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll('.t-splash').length === 0, null, { timeout: 60_000 });

  await page.getByRole('button', { name: /^Settings/ }).first().click();
  await page.getByRole('button', { name: 'Connections', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add connection' }).first().click();
  await page.getByRole('menuitem', { name: /^Rithmic/ }).click();
  const form = page.getByRole('region', { name: 'Add a Rithmic login' });
  await form.getByRole('button', { name: 'Firm' }).click();
  await page.getByRole('option', { name: 'Tessera Test' }).click();
  await form.getByRole('combobox', { name: 'Gateway' }).filter({ hasText: 'Chicago Area' }).waitFor();
  await form.getByLabel('User').fill('trader');
  await form.getByLabel('Password').fill('demo');
  await form.getByRole('button', { name: /^Test and save/ }).click();

  const bar = page.getByRole('navigation', { name: 'Connection status' });
  const login = bar.getByRole('button', { name: /^Tessera Test · Rithmic: / });
  await login.waitFor({ timeout: 60_000 });
  const row = page.getByRole('region', { name: 'Your connections' }).getByRole('group', { name: /^Tessera Test/ });
  await row.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1_500);

  const statusName = (await login.getAttribute('aria-label')) ?? (await login.innerText());
  const rowWords = (await row.innerText()).replace(/\s+/g, ' ').trim();
  console.info(`status bar: ${statusName}`);
  console.info(`row: ${rowWords}`);
  writeFileSync(join(dir, `${scene}-words.txt`), `status bar: ${statusName}\nrow: ${rowWords}\n`);
  await page.screenshot({ path: join(dir, `${scene}-connections.png`) });
  await login.hover();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, `${scene}-status-bar.png`) });

  if (scene === 'pr') {
    expectThat(rowWords.includes(SECOND_TRY), `the row reads "${SECOND_TRY}"`);
    expectThat(!RAW_ON_SCREEN.test(rowWords), 'the row shows no raw attempt count or code');
  }
} finally {
  await stop(runtime);
  await browser.close();
}

if (failures.length > 0) {
  console.error(`${String(failures.length)} failed`);
  process.exit(1);
}
