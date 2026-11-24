#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Page, type WebSocketRoute } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/refused-history', uiDir, scene = 'pr'] = process.argv.slice(2);
if (scene !== 'pr' && scene !== 'main') {
  console.error('usage: refused-history.ts [evidence dir] [ui dir] [pr|main]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const ui = uiDir || join(repo, 'apps/desktop/dist');
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;

const REFUSAL = 'request rejected: [13] permission denied';
const RAW_ON_SCREEN = /\[\d+\]|\bcode \d+|request rejected|permission denied/i;
const EDGE_WORDS = 'Older history isn’t available on this login';
const WATCH_MS = 15_000;

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
  const data = mkdtempSync(join(tmpdir(), 'tessera-refused-history-'));
  const child = spawn(bin, ['serve', '--port', '0', '--ui-dir', ui, '--data-dir', data, '--launch-tickets'], {
    stdio: ['pipe', 'pipe', 'inherit'],
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

interface CandlesAsk {
  instrument?: string;
  tf?: string;
  to?: number;
  cachedOnly?: boolean;
}

interface Refusals {
  snapshots: Record<string, number>;
  older: Record<string, number>;
}

const refusals = (): Refusals => ({ snapshots: {}, older: {} });
const total = (asks: Record<string, number>) => Object.values(asks).reduce((n, k) => n + k, 0);
const once = (asks: Record<string, number>) => total(asks) > 0 && Object.values(asks).every((n) => n === 1);

function refusing(which: (ask: CandlesAsk) => boolean, seen: Refusals) {
  return (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    const refused = new Set<number>();
    ws.onMessage((m) => {
      const sent = JSON.parse(String(m)) as {
        id?: number;
        method?: string;
        params?: { name?: string; input?: CandlesAsk };
      };
      const ask = sent.params?.input;
      if (sent.method === 'tools.invoke' && sent.params?.name === 'market.get_candles' && sent.id !== undefined && ask) {
        if (which(ask)) {
          refused.add(sent.id);
          const chart = `${ask.instrument ?? '?'} ${ask.tf ?? '?'}`;
          const asks = ask.to === undefined ? seen.snapshots : seen.older;
          asks[chart] = (asks[chart] ?? 0) + 1;
        }
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const answer = JSON.parse(String(m)) as { id?: number; result?: Record<string, unknown> };
      if (answer.id !== undefined && refused.has(answer.id) && answer.result) {
        const error = { code: 'unavailable', message: REFUSAL, retryable: false, details: null };
        ws.send(JSON.stringify({ ...answer, result: { ...answer.result, ok: false, status: 'error', output: null, error } }));
        return;
      }
      ws.send(m);
    });
  };
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

const canvasOf = (page: Page) => page.locator('.chart-tile[data-active] .chart-canvas, .chart-tile .chart-canvas').first();

async function drawn(page: Page) {
  await page.waitForFunction(
    () => !document.querySelector('.chart-status.is-loading') && /\d bars/.test(document.querySelector('.layer-strip .meta')?.textContent ?? ''),
    null,
    { timeout: 60_000 },
  );
}

async function panBack(page: Page, until: () => boolean, drags = 30) {
  const box = await canvasOf(page).boundingBox();
  if (!box) throw new Error('no chart on screen');
  const y = box.y + box.height * 0.45;
  for (let i = 0; i < drags && !until(); i++) {
    await page.mouse.move(box.x + box.width * 0.15, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
}

async function panForward(page: Page) {
  const box = await canvasOf(page).boundingBox();
  if (!box) throw new Error('no chart on screen');
  const y = box.y + box.height * 0.45;
  await page.mouse.move(box.x + box.width * 0.75, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, y, { steps: 6 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.width + 200, box.y + box.height + 40);
  await page.waitForTimeout(300);
}

const centred = async (page: Page) => {
  const status = page.locator('.chart-status:not(.is-loading)');
  return (await status.count()) > 0 ? (await status.first().innerText()).trim() : '';
};

try {
  const runtime = await launch();
  try {
    const page = await opened(runtime);
    await drawn(page);
    const seen = refusals();
    await page.routeWebSocket(/\/ws/, refusing((ask) => !ask.cachedOnly, seen));
    await page.reload();
    await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => !document.querySelector('.chart-status.is-loading'), null, { timeout: 60_000 });
    await page.waitForTimeout(1_000);
    await panBack(page, () => false, 12);
    await page.waitForTimeout(WATCH_MS);
    const words = await centred(page);
    console.info(`reopened, every read refused: centred ${JSON.stringify(words)}; asks refused ${JSON.stringify(seen)}`);
    await page.screenshot({ path: join(dir, `${scene}-reopened.png`) });
    writeFileSync(join(dir, `${scene}-reopened.json`), JSON.stringify({ centred: words, ...seen }, null, 2));
    if (scene === 'pr') {
      expectThat(words === '', 'a chart that drew its kept bars shows no centred error');
      expectThat(once(seen.snapshots), 'each chart asked the refused read once and not again');
      const edge = await page.evaluate(() => document.body.innerText);
      expectThat(!RAW_ON_SCREEN.test(edge), 'no provider code anywhere on screen');
    }
    await page.context().close();
  } finally {
    await stop(runtime);
  }

  const paging = await launch();
  try {
    const seen = refusals();
    const page = await opened(paging, refusing((ask) => ask.to !== undefined && !ask.cachedOnly, seen));
    await drawn(page);
    await panBack(page, () => total(seen.older) > 0);
    await page.waitForTimeout(1_000);
    await panBack(page, () => false, 4);
    await panForward(page);
    await page.screenshot({ path: join(dir, `${scene}-older-refused.png`) });
    const after = total(seen.older);
    await page.waitForTimeout(WATCH_MS);
    await panBack(page, () => false, 4);
    const words = await centred(page);
    console.info(`older history refused: centred ${JSON.stringify(words)}; older asks refused ${String(after)} then ${JSON.stringify(seen.older)}`);
    writeFileSync(join(dir, `${scene}-older-refused.json`), JSON.stringify({ centred: words, ...seen }, null, 2));
    if (scene === 'pr') {
      expectThat(after >= 1, 'paging back asked the feed for older history');
      expectThat(words === '', 'no centred error over the chart');
      expectThat(once(seen.older), 'the refused older history is not asked again');
    }
    await page.context().close();
  } finally {
    await stop(paging);
  }

  const cold = await launch();
  try {
    const seen = refusals();
    const page = await opened(cold, refusing((ask) => !ask.cachedOnly, seen));
    const status = page.locator('.chart-status:not(.is-loading)').first();
    await status.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(WATCH_MS);
    const words = (await status.innerText()).trim();
    console.info(`first load refused: centred ${JSON.stringify(words)}; asks refused ${JSON.stringify(seen.snapshots)}`);
    await page.screenshot({ path: join(dir, `${scene}-first-load-refused.png`) });
    writeFileSync(join(dir, `${scene}-first-load-refused.json`), JSON.stringify({ centred: words, ...seen }, null, 2));
    if (scene === 'pr') {
      expectThat(/did not load/.test(words), 'a chart with nothing to show still says it did not load');
      expectThat(/Ask your broker about access/.test(words), 'and says what to do in plain words');
      expectThat(!RAW_ON_SCREEN.test(words), 'with no provider code');
      expectThat(once(seen.snapshots), 'and does not ask the refused read again');
    }
  } finally {
    await stop(cold);
  }
} finally {
  await browser.close();
}

console.info(`evidence: ${dir} (look for "${EDGE_WORDS}" at the chart's left edge in ${scene}-older-refused.png)`);
if (failures.length > 0) {
  console.error(`${String(failures.length)} failed`);
  process.exit(1);
}
