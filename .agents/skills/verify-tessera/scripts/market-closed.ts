#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/market-closed', uiDir, scene = 'pr'] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SUNDAY_NOON = '2026-10-04T12:00:00-04:00';
const FRIDAY_CLOSE = Date.parse('2026-10-02T17:00:00-04:00');
const LOGIN = { system: 'Tessera Test', gateway: 'Chicago Area', user: 'trader', password: 'demo' };
const SETTLE_MS = 90_000;
const CLOSED = /^Closed · opens 18:00 ET$/;

const failures: string[] = [];
const expectThat = (ok: boolean, line: string) => {
  console.info(`${ok ? 'ok' : 'FAIL'}: ${line}`);
  if (!ok) failures.push(line);
};

const data = mkdtempSync(join(tmpdir(), 'tessera-market-closed-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TESSERA_TEST_MARKET: 'rithmic', TESSERA_TEST_NOW: SUNDAY_NOON },
  },
);
const ready = await new Promise<{ port: number; token: string; ticket: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; token?: string; ticket?: string } = {};
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    try {
      Object.assign(seen, JSON.parse(line) as object);
    } catch {
      return;
    }
    if (seen.port && seen.token && seen.ticket) done({ port: seen.port, token: seen.token, ticket: seen.ticket });
  });
});
const origin = `http://127.0.0.1:${String(ready.port)}`;

const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
const page: Page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const failed: string[] = [];
page.on('websocket', (ws) =>
  ws.on('framereceived', (f) => {
    const text = String(f.payload);
    for (const m of text.matchAll(/"error":\{"code":"(\w+)","details":[^,]*,"message":"([^"]{0,200})/g))
      if (m[1] !== 'not_found') failed.push(`${m[1]}: ${m[2]}`);
  }),
);
const report: Record<string, unknown> = { scene, clock: SUNDAY_NOON };

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
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.move(800, 980);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: join(dir, `${scene}-desk.png`) });

  const legend = await page.locator('[data-layer]').allInnerTexts();
  const chartNote = await page.locator('.chart-tools:visible [role="status"]').allInnerTexts();
  const ladderStrip = await page.locator('.t-ladder-strip:visible').allInnerTexts();
  const tapeTimes = await page.locator('.t-tape-rows .r:visible .t').allInnerTexts();
  Object.assign(report, { legend, chartNote, ladderStrip, tapeTimes: tapeTimes.slice(0, 5), failed });

  expectThat(chartNote.some((t) => CLOSED.test(t.trim())), `the chart says when the market opens: ${String(chartNote)}`);
  expectThat(ladderStrip.some((t) => CLOSED.test(t.trim())), `the DOM says it too: ${String(ladderStrip)}`);
  expectThat(tapeTimes.length > 0, `the T&S shows the last session's prints: ${String(tapeTimes.slice(0, 3))}`);
  expectThat(
    legend.every((t) => !/stopped|no tick history/.test(t)),
    `no study says it stopped or has no history: ${JSON.stringify(legend)}`,
  );
  expectThat(failed.length === 0, `no read failed: ${JSON.stringify(failed.slice(0, 5))}`);
  report.lastPrintBeforeClose = FRIDAY_CLOSE;
} finally {
  writeFileSync(join(dir, `${scene}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  runtime.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
console.info(`stills in ${dir}`);
if (failures.length > 0 && scene === 'pr') process.exit(1);
