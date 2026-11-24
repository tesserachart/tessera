#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const [out = '.e2e/artifacts/verify/voice-lines', uiDir] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'tessera-voice-lines-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;

interface Served {
  process: ChildProcess;
  origin: string;
  token: string;
  ticket: string;
}

async function serve(): Promise<Served> {
  const child = spawn(
    bin,
    ['serve', '--port', '0', '--ui-dir', uiDir ?? join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
    { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TESSERA_NO_RITHMIC: '1' } },
  );
  const ready = await new Promise<{ port: number; token: string; ticket: string }>((done, fail) => {
    child.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
    const seen: { port?: number; token?: string; ticket?: string } = {};
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        Object.assign(seen, JSON.parse(line) as object);
      } catch {
        return;
      }
      if (seen.port && seen.token && seen.ticket) done({ port: seen.port, token: seen.token, ticket: seen.ticket });
    });
  });
  return { process: child, origin: `http://127.0.0.1:${String(ready.port)}`, token: ready.token, ticket: ready.ticket };
}

interface Invoked {
  ok?: boolean;
  status?: string;
  output?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

const TICKET_SEND = { armed: true, holdConfirmed: false };

async function connect(
  at: Served,
): Promise<{ tool: (name: string, input: unknown) => Promise<Invoked>; send: (input: unknown) => Promise<Invoked>; close: () => void }> {
  const ws = new WebSocket(`${at.origin.replace(/^http/, 'ws')}/ws`);
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown };
    if (m.id !== undefined) waiting.get(m.id)?.(m);
  };
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: unknown }>((done) => {
      waiting.set(++id, done);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  await call('session.hello', {
    client: { name: 'voice-lines', version: '0', platform: 'node' },
    protocolVersion: 1,
    token: at.token,
  });
  return {
    tool: async (name, input) => (await call('tools.invoke', { name, input })).result as Invoked,
    send: async (input) =>
      (await call('tools.invoke', { name: 'orders.submit', input, surface: TICKET_SEND })).result as Invoked,
    close: () => ws.close(),
  };
}

interface Played {
  line: string;
  ended: boolean;
}

function tagClips(): void {
  const urlOf = new WeakMap<object, string>();
  const played: Played[] = [];
  const arrayBuffer = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = async function (this: Response) {
    const buf = await arrayBuffer.call(this);
    urlOf.set(buf, this.url);
    return buf;
  };
  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = async function (this: BaseAudioContext, bytes: ArrayBuffer) {
    const url = urlOf.get(bytes);
    const audio = await decode.call(this, bytes);
    if (url) urlOf.set(audio, url);
    return audio;
  } as typeof decode;
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: number[]) {
    const url = this.buffer ? urlOf.get(this.buffer) : undefined;
    const file = url ? (url.split('/').pop() ?? '') : '';
    const entry: Played = { line: file.replace(/-[^-]+\.mp3$/, ''), ended: false };
    played.push(entry);
    this.addEventListener('ended', () => (entry.ended = true));
    start.apply(this, args);
  };
  (window as unknown as { voiceProbe: () => Played[] }).voiceProbe = () => played.map((p) => ({ ...p }));
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(tagClips);
const at = await serve();
const rpc = await connect(at);
const failures: string[] = [];
const steps: { step: string; heard: string[]; runtime?: unknown }[] = [];
const heardNow = async () =>
  (await page.evaluate(() => (window as unknown as { voiceProbe: () => Played[] }).voiceProbe())).map((p) => p.line);

async function hears(step: string, expected: string, act: () => Promise<unknown>): Promise<void> {
  const before = (await heardNow()).length;
  const runtime = await act();
  const end = Date.now() + 6_000;
  let heard: string[] = [];
  while (Date.now() < end) {
    heard = (await heardNow()).slice(before);
    if (heard.includes(expected)) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(2_500);
  heard = (await heardNow()).slice(before);
  steps.push({ step, heard, runtime });
  const ok = heard.includes(expected);
  console.info(`${ok ? 'ok  ' : 'FAIL'} ${step}: heard ${heard.length ? heard.join(', ') : 'nothing'} (wanted ${expected})`);
  if (!ok) failures.push(step);
}

try {
  const accounts = (await rpc.tool('portfolio.get_accounts', {})).output as {
    accounts: { account: { id: string; displayName: string; environment: string } }[];
  };
  const connections = (await rpc.tool('connections.list', {})).output as { dataSource: string };
  if (connections.dataSource !== 'mock' || accounts.accounts.some((a) => a.account.environment !== 'paper'))
    throw new Error('refused: not the sim runtime');
  const paper = accounts.accounts.find((a) => a.account.displayName === 'Paper')!.account.id;
  const paper2 = accounts.accounts.find((a) => a.account.displayName === 'Paper 2')!.account.id;

  await page.goto(`${at.origin}/#ticket=${at.ticket}`);
  await page.getByRole('main', { name: 'Workspace' }).waitFor({ timeout: 60_000 });
  const chip = page.getByRole('button', { name: /^Account: Paper,/ });
  await chip.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3_000);

  await hears('the trader locks Paper for 15 min from the chip', 'account_locked', async () => {
    await chip.click();
    await page.getByRole('menuitem', { name: /^Lock trading/ }).hover();
    await page.getByRole('menuitem', { name: /^15 min/ }).click();
    await page.getByRole('button', { name: /^Account: Paper, Locked until/ }).waitFor({ timeout: 15_000 });
    return (await rpc.tool('risk.get_lock', { accountId: paper, instrument: 'NQZ6.CME' })).output;
  });
  await page.screenshot({ path: join(dir, 'locked.png') });

  await hears('an order sent to the locked Paper is refused before the broker', 'order_rejected', () =>
    rpc.send({ accountId: paper, instrument: 'NQZ6.CME', side: 'buy', qty: 1, orderType: 'market' }),
  );

  await hears('Paper 2 buys at market', 'market_filled', () =>
    rpc.send({ accountId: paper2, instrument: 'NQZ6.CME', side: 'buy', qty: 1, orderType: 'market' }),
  );
  await hears('a $1 daily loss limit on Paper 2, already lost', 'loss_limit', async () => {
    const set = await rpc.tool('settings.set', {
      key: 'risk.limits',
      value: { every: {}, accounts: { [paper2]: { dailyLossLimit: 1 } } },
    });
    await page.waitForTimeout(1_500);
    return { set, accounts: (await rpc.tool('portfolio.get_accounts', {})).output };
  });
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  console.error(err);
} finally {
  writeFileSync(join(dir, 'voice-lines.json'), `${JSON.stringify({ failures, steps }, null, 2)}\n`);
  rpc.close();
  await browser.close();
  at.process.kill();
  rmSync(data, { recursive: true, force: true });
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
