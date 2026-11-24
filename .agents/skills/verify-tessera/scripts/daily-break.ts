#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/daily-break', uiDir, scene = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const THURSDAY_BREAK = '2026-11-05T17:05:00-05:00';
const LOGIN = { system: 'Tessera Test', gateway: 'Chicago Area', user: 'trader', password: 'demo' };
const SETTLE_MS = 120_000;
const HALT = /Daily halt · opens 18:00 ET/;
const ALARM = /Reconnect|No data for|Filling the gap|dropped|permission denied|request rejected|\[\d+\]/i;

const failures: string[] = [];
const expectThat = (ok: boolean, line: string) => {
  console.info(`${ok ? 'ok' : 'FAIL'}: ${line}`);
  if (!ok) failures.push(line);
};

const data = mkdtempSync(join(tmpdir(), 'tessera-daily-break-'));
const bin = process.env.TESSERA_TEST_RUNTIME_BIN ?? resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TESSERA_TEST_MARKET: 'rithmic', TESSERA_TEST_NOW: THURSDAY_BREAK },
  },
);
const ready = await new Promise<{ port: number; ticket: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; token?: string; ticket?: string } = {};
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    try {
      Object.assign(seen, JSON.parse(line) as object);
    } catch {
      return;
    }
    if (seen.port && seen.token && seen.ticket) done({ port: seen.port, ticket: seen.ticket });
  });
});
const origin = `http://127.0.0.1:${String(ready.port)}`;

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
const page: Page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const failed: string[] = [];
const statusSeen = new Set<string>();
page.on('websocket', (ws) =>
  ws.on('framereceived', (f) => {
    const text = String(f.payload);
    for (const m of text.matchAll(/"error":\{"code":"(\w+)","details":[^,]*,"message":"([^"]{0,200})/g))
      if (m[1] !== 'not_found') failed.push(`${m[1]}: ${m[2]}`);
  }),
);
const report: Record<string, unknown> = { scene, clock: THURSDAY_BREAK };

try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  const login = page.getByRole('dialog', { name: 'Connect your Rithmic login' });
  await login.waitFor({ timeout: 120_000 });
  await login.getByRole('button', { name: 'Firm' }).click();
  await page.getByRole('option', { name: LOGIN.system }).click();
  await login.getByRole('combobox', { name: 'Gateway' }).filter({ hasText: LOGIN.gateway }).waitFor();
  await login.getByLabel('User', { exact: true }).fill(LOGIN.user);
  await login.getByLabel('Password', { exact: true }).fill(LOGIN.password);
  await login.getByRole('button', { name: 'Connect' }).click();
  const offer = page.getByRole('dialog', { name: 'Your market data stays on this computer' });
  await offer.waitFor({ timeout: 60_000 }).catch(() => undefined);
  await offer
    .getByRole('button', { name: 'Not now' })
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Tessera menu/ }).click();
  await page.getByRole('menuitem', { name: 'New from preset' }).click();
  await page.getByRole('menuitem', { name: /^Scalp 1m order flow/ }).click();
  await page
    .getByRole('button', { name: 'Don’t save' })
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  await page.locator('[data-layer]').first().waitFor({ timeout: 60_000 });

  const footer = page.locator('footer.t-shell-footer');
  for (const end = Date.now() + SETTLE_MS; Date.now() < end; await page.waitForTimeout(1_000)) {
    const said = (await footer.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (said) statusSeen.add(said);
  }
  await page.mouse.move(800, 980);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: join(dir, `${scene}-desk.png`) });

  const statusLine = await page.getByRole('status', { name: 'Status' }).allInnerTexts();
  const legend = await page.locator('[data-layer]').allInnerTexts();
  const chartNote = await page.locator('.chart-tools:visible [role="status"]').allInnerTexts();
  const body = await page.innerText('body');
  Object.assign(report, { statusLine, statusSeen: [...statusSeen], legend, chartNote, failed });

  expectThat(
    statusLine.some((t) => HALT.test(t)),
    `the status bar says the daily halt and when it reopens: ${JSON.stringify(statusLine)}`,
  );
  expectThat(
    [...statusSeen].every((t) => !ALARM.test(t)),
    `the status bar never said the feed was lost over ${String(SETTLE_MS / 1000)} s: ${JSON.stringify([...statusSeen])}`,
  );
  expectThat(!ALARM.test(body), 'nothing on the desk says reconnecting or shows a raw code');
  expectThat(
    legend.some((t) => /CVD/i.test(t)) && legend.every((t) => !/stopped|no tick history|denied|rejected/i.test(t)),
    `CVD and the other studies show no error: ${JSON.stringify(legend)}`,
  );
  expectThat(failed.length === 0, `no read failed: ${JSON.stringify(failed.slice(0, 5))}`);
} finally {
  writeFileSync(join(dir, `${scene}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
console.info(`stills in ${dir}`);
if (failures.length > 0 && scene === 'pr') process.exit(1);
