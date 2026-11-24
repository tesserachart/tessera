#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/sounds', roundsArg = '3'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !/^\d+$/.test(roundsArg)) {
  console.error('usage: sounds-survive.ts <port> [evidence dir] [rounds]');
  process.exit(2);
}
const rounds = Number(roundsArg);
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

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

type Mishap = 'close' | 'suspend' | 'stall';

interface SoundStats {
  made: number;
  open: number;
  clips: number;
  clipsEnded: number;
  tones: number;
  tonesEnded: number;
  gestureListeners: number;
}

interface SoundProbe {
  stats: () => SoundStats;
  mishap: (m: Mishap) => Promise<void>;
}

function countSounds(): void {
  const Real = window.AudioContext;
  const realState = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state')!.get!;
  const made: AudioContext[] = [];
  const tally = { clips: 0, clipsEnded: 0, tones: 0, tonesEnded: 0 };
  const listening = new Set<string>();
  let listenerId = 0;
  const ids = new WeakMap<object, number>();
  const key = (type: string, fn: unknown) => {
    if (typeof fn !== 'function' && (typeof fn !== 'object' || fn === null)) return null;
    if (!ids.has(fn)) ids.set(fn, ++listenerId);
    return `${type}#${String(ids.get(fn))}`;
  };
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean) => {
    const k = type === 'pointerdown' || type === 'keydown' ? key(type, fn) : null;
    if (k) listening.add(k);
    add(type, fn, opts);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean) => {
    const k = type === 'pointerdown' || type === 'keydown' ? key(type, fn) : null;
    if (k) listening.delete(k);
    remove(type, fn, opts);
  }) as typeof window.removeEventListener;
  const counted = <T extends AudioScheduledSourceNode>(node: T, started: 'clips' | 'tones'): T => {
    const start = node.start.bind(node);
    node.start = (when?: number) => {
      tally[started]++;
      node.addEventListener('ended', () => tally[started === 'clips' ? 'clipsEnded' : 'tonesEnded']++);
      start(when);
    };
    return node;
  };
  class Counted extends Real {
    constructor(options?: AudioContextOptions) {
      super(options);
      made.push(this);
    }
    override createBufferSource(): AudioBufferSourceNode {
      return counted(super.createBufferSource(), 'clips');
    }
    override createOscillator(): OscillatorNode {
      return counted(super.createOscillator(), 'tones');
    }
  }
  window.AudioContext = Counted;
  const open = () => made.filter((c) => realState.call(c) !== 'closed');
  const probe: SoundProbe = {
    stats: () => ({ made: made.length, open: open().length, ...tally, gestureListeners: listening.size }),
    mishap: async (m) => {
      const c = open().at(-1);
      if (!c) return;
      if (m === 'close') await c.close();
      else await c.suspend();
      if (m === 'stall') Object.defineProperty(c, 'state', { get: () => 'running', configurable: true });
    },
  };
  (window as unknown as { soundProbe: SoundProbe }).soundProbe = probe;
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(countSounds);
const failures: string[] = [];
const report = (line: string) => console.info(line);
const expectThat = (ok: boolean, what: string) => {
  report(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const stats = () => page.evaluate(() => (window as unknown as { soundProbe: SoundProbe }).soundProbe.stats());
const mishap = (m: Mishap) =>
  page.evaluate((x) => (window as unknown as { soundProbe: SoundProbe }).soundProbe.mishap(x), m);
const heard = async (what: string, act: () => Promise<void>) => {
  const before = (await stats()).clipsEnded;
  await act();
  const end = Date.now() + 6_000;
  while (Date.now() < end && (await stats()).clipsEnded <= before) await page.waitForTimeout(100);
  const n = (await stats()).clipsEnded - before;
  expectThat(n >= 1, `${what}: the voice line played to its end (${String(n)} line${n === 1 ? '' : 's'})`);
  await page.waitForTimeout(2_500);
};
const positions = async () =>
  (await rpc.tool<{ positions: unknown[] }>('portfolio.get_positions', { accountId: 'paper-main' })).positions.length;
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(250))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};
const log: { step: string; stats: SoundStats }[] = [];
const note = async (step: string) => {
  const s = await stats();
  log.push({ step, stats: s });
  report(
    `     ${step}: contexts made ${String(s.made)}, open ${String(s.open)}; lines started ${String(s.clips)}, ended ${String(s.clipsEnded)}; tones started ${String(s.tones)}, ended ${String(s.tonesEnded)}; gesture listeners ${String(s.gestureListeners)}`,
  );
};

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const ticket = page.getByRole('region', { name: /^Ticket: / });
  const buy = ticket.getByRole('button', { name: 'Buy market', exact: true });
  const flat = ticket.getByRole('button', { name: 'Flat', exact: true });
  await until(() => buy.isEnabled({ timeout: 1_000 }), 180_000, 'Buy market is on');
  if ((await positions()) > 0) {
    await flat.click();
    await until(async () => (await positions()) === 0, 30_000, 'the account is flat');
  }
  await page.waitForTimeout(2_000);
  await note('connected');
  const trade = async (label: string) => {
    await heard(`${label}: Buy market fills`, () => buy.click());
    await heard(`${label}: Flat closes the position`, () => flat.click());
    await until(async () => (await positions()) === 0, 30_000, 'the account is flat');
  };
  await trade('before any mishap');
  await note('after the first trade');
  const mishaps: Mishap[] = ['suspend', 'stall', 'close'];
  for (let round = 1; round <= rounds; round++)
    for (const m of mishaps) {
      await mishap(m);
      await page.waitForTimeout(3_000);
      await trade(`round ${String(round)}, after ${m}`);
      await note(`round ${String(round)}, after ${m}`);
    }
  const end = await stats();
  expectThat(end.open === 1, `one audio context open at the end (${String(end.open)})`);
  expectThat(
    end.made <= 1 + rounds * mishaps.length,
    `at most one context per mishap (${String(end.made)} made for ${String(rounds * mishaps.length)} mishaps)`,
  );
  await page.screenshot({ path: join(dir, 'end.png') }).catch(() => report('(no screenshot)'));
} catch (err) {
  failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
} finally {
  writeFileSync(join(dir, 'sounds.json'), `${JSON.stringify({ failures, log }, null, 2)}\n`);
  await browser.close();
  rpc.close();
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.info(failures.length === 0 ? `ok: evidence in ${dir}` : `failed: evidence in ${dir}`);
process.exit(failures.length === 0 ? 0 : 1);
