#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/busy-position'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: busy-position.ts <port> [evidence dir]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

const HOLD_S = 30;
const OPEN_FPS_SHARE = 0.75;
const PAGE_LAG_MS = 2_000;

interface Positions {
  positions: { qty: number }[];
}
interface Orders {
  orders: { status: string }[];
}

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
const working = async () =>
  (await rpc.tool<Orders>('portfolio.get_orders', { accountId: 'paper-main' })).orders.filter(
    (o) => !['filled', 'cancelled', 'rejected', 'expired'].includes(o.status),
  ).length;

const fps = (page: Page, ms: number) =>
  page.evaluate(
    (ms) =>
      new Promise<number>((done) => {
        let frames = 0;
        const start = performance.now();
        const step = () => {
          frames += 1;
          const spent = performance.now() - start;
          if (spent < ms) requestAnimationFrame(step);
          else done((frames / spent) * 1000);
        };
        requestAnimationFrame(step);
      }),
    ms,
  );
const behind = (page: Page) =>
  page.evaluate(() => (document.body.innerText.match(/\d+\s*(?:s|min) behind/g) ?? []).join(' | '));
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const failures: string[] = [];
const evidence: Record<string, unknown> = {};
const report = (line: string) => console.info(line);
const shot = (name: string) =>
  page.screenshot({ path: join(dir, name), timeout: 120_000 }).catch(() => report(`(no screenshot ${name})`));
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(100))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};

const cdp = await page.context().newCDPSession(page);
const idleShare = async (ms: number) => {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await page.waitForTimeout(ms);
  const { profile } = await cdp.send('Profiler.stop');
  const idle = new Set(profile.nodes.filter((n) => n.callFrame.functionName === '(idle)').map((n) => n.id));
  let all = 0;
  let spare = 0;
  (profile.samples ?? []).forEach((id, i) => {
    const dt = profile.timeDeltas?.[i] ?? 0;
    all += dt;
    if (idle.has(id)) spare += dt;
  });
  return all === 0 ? 0 : Math.round((spare / all) * 1000) / 10;
};
const sample = async (seconds: number) => {
  const rows: { fps: number; behind: string }[] = [];
  for (const end = Date.now() + seconds * 1000; Date.now() < end; )
    rows.push({ fps: Math.round(await fps(page, 2_000)), behind: await behind(page) });
  return rows;
};

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  const pagePosition = async () =>
    ((await ticket.innerText()).replace(/\s+/g, ' ').match(/Position (.*?) Open P\/L/)?.[1] ?? '').trim();
  await until(() => ticket.getByRole('button', { name: 'Buy market', exact: true }).isEnabled(), 180_000, 'ready');
  await page.waitForTimeout(10_000);

  const flat = await sample(10);
  const flatIdle = await idleShare(10_000);
  evidence.flat = { fps: flat.map((r) => r.fps), idlePercent: flatIdle };
  report(`flat: ${flat.map((r) => r.fps).join(' ')} fps, ${String(flatIdle)}% idle`);

  await ticket.getByRole('switch', { name: 'Bracket' }).click();
  await page.getByLabel('Stop distance').fill('400');
  await page.getByLabel('Stop distance').press('Tab');
  await page.getByLabel('Target distance').fill('800');
  await page.getByLabel('Target distance').press('Tab');
  await ticket.getByRole('button', { name: 'Buy market', exact: true }).click();
  await until(async () => (await held()) === '1' && (await working()) === 2, 10_000, 'long 1 with a stop and a target');
  report('open: long 1 NQ with a stop and a target');

  const open = await sample(HOLD_S);
  const openIdle = await idleShare(10_000);
  open.push(...(await sample(6)));
  evidence.open = { fps: open.map((r) => r.fps), idlePercent: openIdle, behind: open.map((r) => r.behind) };
  report(`open: ${open.map((r) => r.fps).join(' ')} fps, ${String(openIdle)}% idle`);
  await shot('1-open.png');
  const lagged = open.find((r) => r.behind !== '');
  if (lagged) failures.push(`with the position open the page said "${lagged.behind}"`);
  if (median(open.map((r) => r.fps)) < OPEN_FPS_SHARE * median(flat.map((r) => r.fps)))
    failures.push(`open runs at ${String(median(open.map((r) => r.fps)))} fps against ${String(median(flat.map((r) => r.fps)))} flat`);

  const timed = async (button: string, runtimeDone: (qty: string) => boolean, pageDone: (words: string) => boolean) => {
    const start = Date.now();
    await ticket.getByRole('button', { name: button, exact: true }).click({ timeout: 120_000 });
    const clicked = Date.now() - start;
    let runtime: number | null = null;
    let shown: number | null = null;
    while (Date.now() - start < 120_000 && (runtime === null || shown === null)) {
      if (runtime === null && runtimeDone(await held())) runtime = Date.now() - start;
      if (shown === null && pageDone(await pagePosition())) shown = Date.now() - start;
      await page.waitForTimeout(50);
    }
    return { clicked, runtime, shown };
  };
  const late = (what: string, t: { runtime: number | null; shown: number | null }) => {
    if (t.runtime === null) failures.push(`${what} never reached the runtime`);
    else if (t.shown === null || t.shown - t.runtime > PAGE_LAG_MS)
      failures.push(`${what} showed on the page ${t.shown === null ? 'never' : `${String(t.shown - t.runtime)} ms after the runtime`}`);
  };

  const reverse = await timed('Reverse', (qty) => qty === '-1', (words) => /(^|\s)[−-]1 @/.test(words));
  evidence.reverse = reverse;
  report(`reverse: clicked ${String(reverse.clicked)} ms, runtime ${String(reverse.runtime)} ms, page ${String(reverse.shown)} ms`);
  late('Reverse', reverse);
  await shot('2-reversed.png');

  const flatten = await timed('Flat', (qty) => qty === 'flat', (words) => /(^|\s)Flat$/.test(words));
  evidence.flatten = flatten;
  report(`flat: clicked ${String(flatten.clicked)} ms, runtime ${String(flatten.runtime)} ms, page ${String(flatten.shown)} ms`);
  late('Flat', flatten);
  await shot('3-flat.png');
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  await shot('failed.png');
} finally {
  writeFileSync(join(dir, 'busy-position.json'), JSON.stringify({ ...evidence, failures }, null, 1));
  await browser.close();
  rpc.close();
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
