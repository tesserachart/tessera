#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/themes', uiDir, label = 'pr', binArg] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'tessera-themes-'));
const bin = binArg ?? resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
);
const ready = await new Promise<{ port: number; ticket: string; token: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; ticket?: string; token?: string } = {};
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    try {
      Object.assign(seen, JSON.parse(line) as object);
    } catch {
      return;
    }
    if (seen.port && seen.ticket && seen.token) done({ port: seen.port, ticket: seen.ticket, token: seen.token });
  });
});
const origin = `http://127.0.0.1:${String(ready.port)}`;
const rpc = await RuntimeRpc.open({ origin, token: ready.token, ticket: ready.ticket });

const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await rpc.tool<{ accounts: { account: { environment: string } }[] }>('portfolio.get_accounts', {});
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  throw new Error('refused: not the sim runtime');
}

const TESSERA_DARK = ['rgb(5, 8, 11)', 'rgb(11, 17, 22)', 'rgb(13, 19, 25)', 'rgb(27, 39, 48)', 'rgb(232, 238, 243)'];

function leftovers(old: readonly string[]): { where: string; prop: string; value: string }[] {
  const out: { where: string; prop: string; value: string }[] = [];
  const props = ['background-color', 'color', 'border-top-color', 'border-left-color', 'outline-color'] as const;
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    for (const prop of props) {
      if (prop.startsWith('border') && Number.parseFloat(cs.getPropertyValue(prop.replace('color', 'width'))) === 0)
        continue;
      if (prop === 'outline-color' && cs.outlineStyle === 'none') continue;
      const value = cs.getPropertyValue(prop);
      if (old.includes(value)) {
        const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
        out.push({ where: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`, prop, value });
      }
    }
  }
  return out.slice(0, 40);
}

async function chartGround(page: Page): Promise<string> {
  const box = await page.getByRole('region', { name: 'NQ Z6 5m' }).boundingBox();
  if (!box) return 'no chart';
  const png = PNG.sync.read(await page.screenshot({ clip: box, scale: 'css' }));
  const seen = new Map<string, number>();
  for (let y = 40; y < png.height - 40; y += 7)
    for (let x = 20; x < png.width - 80; x += 7) {
      const i = (y * png.width + x) * 4;
      const hex = `#${[png.data[i]!, png.data[i + 1]!, png.data[i + 2]!].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      seen.set(hex, (seen.get(hex) ?? 0) + 1);
    }
  return [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'no pixels';
}

const report: Record<string, unknown> = { label };
const settle = (page: Page, ms = 900) => page.waitForTimeout(ms);
async function shot(page: Page, step: string, audit: boolean): Promise<void> {
  await page.mouse.move(1200, 992);
  await settle(page);
  await page.screenshot({ path: join(dir, `${label}-${step}.png`) });
  if (audit) report[step] = await page.evaluate(leftovers, TESSERA_DARK);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
try {
  await page.goto(`${origin}/#ticket=${ready.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'NQ Z6 5m' }).waitFor({ timeout: 60_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  await ticket.getByRole('button', { name: 'Buy market', exact: true }).waitFor({ timeout: 60_000 });
  const bracket = ticket.getByRole('switch', { name: 'Bracket' });
  if ((await bracket.getAttribute('aria-checked')) !== 'true') await bracket.click();
  await page.getByLabel('Stop distance').fill('40');
  await page.getByLabel('Stop distance').press('Tab');
  await page.getByLabel('Target distance').fill('60');
  await page.getByLabel('Target distance').press('Tab');
  await ticket.getByRole('button', { name: 'Buy market', exact: true }).click();
  await settle(page, 3_000);
  const themed = label !== 'main';
  const set = (value: unknown) => rpc.tool('settings.set', { key: 'appearance.theme', value });
  const views: [string, unknown][] = themed
    ? [
        ['tessera', { preset: 'tessera' }],
        ['tessera-light', { preset: 'tessera-light' }],
        ['solarized-dark', { preset: 'solarized-dark' }],
        ['solarized-light', { preset: 'solarized-light' }],
        ['night-owl', { preset: 'night-owl' }],
        ['nord', { preset: 'nord' }],
        ['gruvbox-dark', { preset: 'gruvbox-dark' }],
        ['gruvbox-light', { preset: 'gruvbox-light' }],
      ]
    : [['tessera', null]];
  if (themed) {
    await set({ preset: 'solarized-light' });
    await set({ surfaces: { ground: '#fbf7ee', panel: '#f1ebdc' }, accents: { teal: '#2a5d8f' } });
    const saved = await rpc.tool<{ id: string }>('appearance.save_theme', { name: 'Day Desk' });
    report.saved = saved.id;
    views.push(['saved-day-desk', { saved: 'Day Desk' }]);
  }
  for (const [name, value] of views) {
    if (value) await set(value);
    const light = name.includes('light') || name.startsWith('saved');
    await shot(page, `${name}-desk`, themed && name !== 'tessera');
    if (!['tessera', 'tessera-light', 'solarized-light', 'night-owl', 'saved-day-desk'].includes(name)) continue;
    await page.getByRole('button', { name: /^Tessera menu/ }).click();
    await shot(page, `${name}-menu`, themed && name !== 'tessera');
    await page.keyboard.press('Escape');
    await rpc.tool('ui.show_area', { area: 'settings', item: themed ? 'appearance' : 'chart' });
    await shot(page, `${name}-settings`, themed && name !== 'tessera');
    await rpc.tool('ui.show_area', { area: 'journal' });
    await shot(page, `${name}-journal`, themed && name !== 'tessera');
    await rpc.tool('ui.show_area', { area: 'desk' });
    report[`${name}-mode`] = await page.evaluate(() => document.documentElement.dataset.mode ?? null);
    if (light) report[`${name}-scheme`] = await page.evaluate(() => getComputedStyle(document.body).colorScheme);
  }
  if (themed) {
    report.theme = await rpc.tool('appearance.get_theme', {});
    await set({ preset: 'tessera' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await rpc.tool('ui.show_area', { area: 'settings', item: 'appearance' });
    await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'System' }).click();
    const follow: Record<string, unknown> = {};
    for (const os of ['dark', 'light', 'dark', 'light'] as const) {
      const step = `system-${os}-${String(Object.keys(follow).length + 1)}`;
      await page.emulateMedia({ colorScheme: os });
      await rpc.tool('ui.show_area', { area: 'settings', item: 'appearance' });
      await shot(page, `${step}-settings`, false);
      await rpc.tool('ui.show_area', { area: 'desk' });
      await shot(page, `${step}-desk`, false);
      const shown = await rpc.tool<{ preset: string; mode: string }>('appearance.get_theme', {});
      follow[step] = {
        page: await page.evaluate(() => ({
          mode: document.documentElement.dataset.mode ?? null,
          ink: document.documentElement.style.getPropertyValue('--color-ink'),
        })),
        chartGround: await chartGround(page),
        runtime: { preset: shown.preset, mode: shown.mode },
      };
    }
    follow.scheme = (
      await rpc.tool<{ settings: Record<string, { value: unknown }> }>('settings.get', { keys: ['appearance.scheme'] })
    ).settings['appearance.scheme']?.value;
    report.follow = follow;
  }
  writeFileSync(join(dir, `${label}-report.json`), JSON.stringify(report, null, 2));
} finally {
  rpc.close();
  await browser.close();
  runtime.kill();
  rmSync(data, { recursive: true, force: true });
}
