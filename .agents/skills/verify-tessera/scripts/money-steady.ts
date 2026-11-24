#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/money-steady', contract] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: money-steady.ts <port> [evidence dir] [contract, such as MNQ Z6]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const SAMPLES = 80;
const EVERY_MS = 150;
const SHOTS = 6;
const ROWS = ['Open P/L', 'Today'] as const;
const STEADY_PX = 0.5;
const CENTS = /\.\d\d$/;

interface Positions {
  positions: { qty: number }[];
}
interface Cell {
  text: string;
  right: number;
  units: number;
}
type Sample = Record<(typeof ROWS)[number], Cell | null>;

const info = await readRuntimeInfo(`http://127.0.0.1:${port}`);
const rpc = await RuntimeRpc.open(info);
const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await rpc.tool<{ accounts: { account: { environment: string } }[] }>(
  'portfolio.get_accounts',
  {},
);
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  console.error('refused: not the sim runtime');
  process.exit(1);
}
const held = async () =>
  (await rpc.tool<Positions>('portfolio.get_positions', { accountId: 'paper-main' })).positions
    .map((p) => String(p.qty))
    .join(',') || 'flat';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const failures: string[] = [];
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(100))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};

const readCells = () =>
  page.evaluate((rows) => {
    const cell = (label: string) => {
      const row = [...document.querySelectorAll('.tk-readout .t-readout-row')].find(
        (r) => r.querySelector('dt')?.textContent?.trim() === label,
      );
      const v = row?.querySelector('dd > .v');
      const node = v?.firstChild;
      if (!v || !node || node.nodeType !== Node.TEXT_NODE) return null;
      const text = node.textContent ?? '';
      const dot = text.indexOf('.');
      const at = dot > 0 ? dot - 1 : text.search(/\d(?!.*\d)/);
      const range = document.createRange();
      range.setStart(node, Math.max(0, at));
      range.setEnd(node, Math.max(0, at) + 1);
      return { text, right: v.getBoundingClientRect().right, units: range.getBoundingClientRect().left };
    };
    return Object.fromEntries(rows.map((r) => [r, cell(r)]));
  }, ROWS as unknown as string[]) as Promise<Sample>;

const spread = (xs: readonly number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
const summary: Record<string, unknown> = {};
const samples: Sample[] = [];

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  await until(() => ticket.getByRole('button', { name: 'Buy market', exact: true }).isEnabled(), 180_000, 'ready');
  if (contract) {
    await ticket.getByRole('combobox').first().click();
    await page.getByRole('option', { name: contract, exact: true }).click();
  }
  await ticket.getByRole('switch', { name: 'Bracket' }).click();
  await page.getByLabel('Stop distance').fill('400');
  await page.getByLabel('Stop distance').press('Tab');
  await page.getByLabel('Target distance').fill('800');
  await page.getByLabel('Target distance').press('Tab');
  await ticket.getByRole('button', { name: 'Buy market', exact: true }).click();
  await until(async () => (await held()) === '1', 10_000, 'long 1');
  await until(async () => (await readCells())['Open P/L']?.text.match(/\d/) !== null, 10_000, 'an open P/L');
  await page.waitForTimeout(3_000);

  const readout = page.locator('.tk-readout');
  const shotAt = new Set(Array.from({ length: SHOTS }, (_, i) => Math.round((i * (SAMPLES - 1)) / (SHOTS - 1))));
  for (let i = 0; i < SAMPLES; i++) {
    samples.push(await readCells());
    if (shotAt.has(i)) await readout.screenshot({ path: join(dir, `readout-${String(i).padStart(2, '0')}.png`) });
    await page.waitForTimeout(EVERY_MS);
  }
  await page.screenshot({ path: join(dir, 'desk.png') });

  for (const row of ROWS) {
    const cells = samples.map((s) => s[row]).filter((c): c is Cell => c !== null);
    const texts = cells.map((c) => c.text);
    const lengths = [...new Set(texts.map((t) => t.length))];
    const sameLength = cells.filter((c) => c.text.length === cells[0]?.text.length);
    summary[row] = {
      samples: cells.length,
      distinct: new Set(texts).size,
      changes: texts.filter((t, i) => i > 0 && t !== texts[i - 1]).length,
      first: texts[0],
      last: texts[texts.length - 1],
      lengths,
      withoutCents: texts.filter((t) => !CENTS.test(t)).length,
      rightEdgeSpreadPx: Math.round(spread(cells.map((c) => c.right)) * 100) / 100,
      unitsDigitSpreadPx: Math.round(spread(cells.map((c) => c.units)) * 100) / 100,
      unitsDigitSpreadSameLengthPx: Math.round(spread(sameLength.map((c) => c.units)) * 100) / 100,
    };
    const s = summary[row] as { withoutCents: number; rightEdgeSpreadPx: number; unitsDigitSpreadSameLengthPx: number };
    if (s.withoutCents > 0) failures.push(`${row}: ${String(s.withoutCents)} samples without two decimals`);
    if (s.rightEdgeSpreadPx > STEADY_PX) failures.push(`${row}: right edge moved ${String(s.rightEdgeSpreadPx)} px`);
    if (s.unitsDigitSpreadSameLengthPx > STEADY_PX)
      failures.push(`${row}: units digit moved ${String(s.unitsDigitSpreadSameLengthPx)} px at one length`);
  }
  if (!ROWS.some((r) => ((summary[r] as { changes: number } | undefined)?.changes ?? 0) > 0))
    failures.push('no value changed while sampling: the market did not tick');
  await ticket.getByRole('button', { name: 'Flat', exact: true }).click();
  await until(async () => (await held()) === 'flat', 10_000, 'flat');
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  await page.screenshot({ path: join(dir, 'failed.png') }).catch(() => undefined);
} finally {
  writeFileSync(join(dir, 'money-steady.json'), JSON.stringify({ summary, samples, failures }, null, 1));
  await browser.close();
  rpc.close();
}
console.info(JSON.stringify(summary, null, 1));
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
