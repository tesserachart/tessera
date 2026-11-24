import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveRuntimeBinary, RUNTIME, TEST_RUNTIME, type RuntimeTarget } from '../apps/desktop/dev/runtime-bin.ts';

const repo = resolve(import.meta.dirname, '..');
const READY_MS = 60_000;
const ANSWER_MS = 15_000;
const EXIT_MS = 15_000;
const CONTRACTS = 1;
const LOGIN_ENV = ['TESSERA_RITHMIC_CREDENTIALS', 'TESSERA_RITHMIC_DIRECTORY'];

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

function expect(ok: boolean, message: string): asserts ok {
  if (!ok) fail(message);
}

function passed(message: string): void {
  console.info(`smoke: ✓ ${message}`);
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { subscriptionId?: string; seq?: number; data?: unknown };
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  ok: boolean;
  status: string;
  output: unknown;
  error: { code: string; message: string } | null;
}

interface Account {
  account: { id: string; displayName: string; environment: string };
}

interface Order {
  id: string;
  status: string;
  environment: string;
  avgFillPrice: number | null;
  request: { instrument: string; qty: number };
}

type Event = NonNullable<RpcMessage['params']>;

class Rpc {
  readonly #ws: WebSocket;
  readonly #answers = new Map<number, (msg: RpcMessage) => void>();
  readonly #events: Event[] = [];
  readonly #listeners = new Set<() => void>();
  #next = 1;
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as RpcMessage;
      if (msg.method === 'event' && msg.params) {
        this.#events.push(msg.params);
        for (const listener of this.#listeners) listener();
      } else if (msg.id !== undefined) {
        this.#answers.get(msg.id)?.(msg);
        this.#answers.delete(msg.id);
      }
    });
    ws.addEventListener('close', () => {
      this.#closed = true;
      for (const listener of this.#listeners) listener();
    });
  }

  static async open(port: number, token: string): Promise<Rpc> {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await within(
      new Promise<void>((done, reject) => {
        ws.addEventListener('open', () => done(), { once: true });
        ws.addEventListener('error', () => reject(new SmokeFailure(`no WebSocket on 127.0.0.1:${String(port)}/ws`)), {
          once: true,
        });
      }),
      ANSWER_MS,
      'the WebSocket did not open',
    );
    const rpc = new Rpc(ws);
    await rpc.call('session.hello', {
      client: { name: 'tessera-release-smoke', version: '0', platform: 'node' },
      protocolVersion: 1,
      token,
    });
    return rpc;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    expect(!this.#closed, `${method}: the runtime closed the connection`);
    const id = this.#next++;
    const answer = new Promise<RpcMessage>((done) => this.#answers.set(id, done));
    this.#ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    const msg = await within(answer, ANSWER_MS, `${method} got no answer`);
    if (msg.error) fail(`${method}: ${msg.error.message} (${String(msg.error.code)})`);
    return msg.result as T;
  }

  async tool<T>(name: string, input: unknown, extra: Record<string, unknown> = {}): Promise<T> {
    const result = await this.call<ToolResult>('tools.invoke', { name, input, ...extra });
    if (!result.ok || result.status !== 'ok') {
      fail(`${name}: ${result.error ? `${result.error.code}: ${result.error.message}` : result.status}`);
    }
    return result.output as T;
  }

  async subscribe(topic: string, params: unknown): Promise<string> {
    return (await this.call<{ subscriptionId: string }>('subscribe', { topic, params })).subscriptionId;
  }

  event(subscription: string, what: string, matches: (data: unknown) => boolean): Promise<Event> {
    const take = () => {
      const at = this.#events.findIndex((e) => e.subscriptionId === subscription && matches(e.data));
      return at < 0 ? null : this.#events.splice(at, 1)[0]!;
    };
    let listener = () => {};
    const found = new Promise<Event>((done, reject) => {
      listener = () => {
        const event = take();
        if (event) done(event);
        else if (this.#closed) reject(new SmokeFailure(`${what}: the runtime closed the connection`));
      };
      this.#listeners.add(listener);
      listener();
    });
    return within(found, ANSWER_MS, `${what} never arrived`).finally(() => this.#listeners.delete(listener));
  }

  close(): void {
    this.#ws.close();
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmokeFailure(`${what} within ${String(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Ready {
  port: number;
  token: string;
  version: string;
}

class Runtime {
  readonly label: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #dir: string;
  readonly #stderr: string[] = [];
  readonly #exit: Promise<number | string>;
  readonly ready: Promise<Ready>;

  constructor(label: string, bin: string) {
    this.label = label;
    this.#dir = mkdtempSync(join(tmpdir(), 'tessera-smoke-'));
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !LOGIN_ENV.includes(key))),
      TESSERA_CLOUD_URL: '',
      TESSERA_NO_RITHMIC: '1',
      TESSERA_SECRET_STORE: 'file',
      XDG_CONFIG_HOME: join(this.#dir, 'config'),
    };
    this.#child = spawn(bin, ['serve', '--port', '0', '--data-dir', join(this.#dir, 'data')], { env });
    createInterface({ input: this.#child.stderr }).on('line', (line) => {
      this.#stderr.push(line);
      if (this.#stderr.length > 40) this.#stderr.shift();
    });
    this.#exit = new Promise((done) => {
      this.#child.on('exit', (code, signal) => done(signal ?? code ?? 'unknown'));
      this.#child.on('error', (err) => done(err.message));
    });
    const lines = createInterface({ input: this.#child.stdout });
    const ready = new Promise<Ready>((done, reject) => {
      lines.once('line', (line) => {
        try {
          done(JSON.parse(line) as Ready & { event: string });
        } catch {
          reject(new SmokeFailure(`the first line on stdout is not JSON: ${line}`));
        }
      });
      void this.#exit.then((status) => reject(new SmokeFailure(`it exited (${String(status)}) before its ready line`)));
    });
    this.ready = within(ready, READY_MS, 'no ready line').then((r) => {
      const line = r as Ready & { event?: string };
      expect(line.event === 'ready', `the first line is not the ready line: ${JSON.stringify({ event: line.event })}`);
      expect(Number.isInteger(line.port) && line.port > 0, 'the ready line has no port');
      expect(/^tss_[0-9a-f]{64}$/.test(line.token), 'the ready line carries no session token');
      expect(typeof line.version === 'string' && line.version !== '', 'the ready line has no version');
      return { port: line.port, token: line.token, version: line.version };
    });
  }

  async stop(): Promise<void> {
    this.#child.stdin.end();
    const status = await within(this.#exit, EXIT_MS, 'it did not exit once its stdin closed');
    expect(status === 0, `it exited with ${String(status)}, not 0`);
    const panics = this.#log().filter((line) => line.includes('panicked'));
    expect(panics.length === 0, `its log records a panic:\n${panics.join('\n')}`);
  }

  #log(): string[] {
    const path = join(this.#dir, 'data', 'logs', 'runtime.log');
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  }

  report(): void {
    console.error(`smoke: ${this.label} stderr, last lines:\n${this.#stderr.join('\n') || '(none)'}`);
    console.error(`smoke: ${this.label} runtime.log, last lines:\n${this.#log().slice(-40).join('\n') || '(none)'}`);
  }

  dispose(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
    rmSync(this.#dir, { recursive: true, force: true });
  }
}

async function paperAccounts(rpc: Rpc): Promise<Account[]> {
  const { accounts } = await rpc.tool<{ accounts: Account[] }>('portfolio.get_accounts', {});
  const others = accounts.filter((a) => a.account.environment !== 'paper');
  expect(
    others.length === 0,
    `a fresh install lists accounts that are not paper: ${others.map((a) => `${a.account.displayName} (${a.account.environment})`).join(', ')}`,
  );
  expect(accounts.length > 0, 'a fresh install lists no paper account');
  return accounts;
}

async function bootShipped(runtime: Runtime): Promise<void> {
  const ready = await runtime.ready;
  passed(`${runtime.label} ${ready.version} is ready on 127.0.0.1:${String(ready.port)}`);
  const health = await within(
    fetch(`http://127.0.0.1:${String(ready.port)}/healthz`),
    ANSWER_MS,
    'GET /healthz got no answer',
  );
  expect(health.ok, `GET /healthz answered ${String(health.status)}`);
  const rpc = await Rpc.open(ready.port, ready.token);
  passed('the session token opens a connection');
  const accounts = await paperAccounts(rpc);
  passed(`a fresh install lists ${accounts.map((a) => a.account.displayName).join(', ')}, all paper`);
  rpc.close();
  await runtime.stop();
  passed('it exits 0 once its stdin closes, with no panic in its log');
}

async function roundTrip(runtime: Runtime): Promise<void> {
  const ready = await runtime.ready;
  passed(`${runtime.label} is ready on the mock market`);
  const rpc = await Rpc.open(ready.port, ready.token);
  const accounts = await paperAccounts(rpc);
  const paper = accounts[0]!.account;
  const positions = await rpc.subscribe('positions', { accountId: paper.id });
  const fills = await rpc.subscribe('fills', { accountId: paper.id });

  const { order } = await rpc.tool<{ order: Order }>(
    'orders.submit',
    { accountId: paper.id, instrument: 'NQ', side: 'buy', qty: CONTRACTS, orderType: 'market' },
    { idempotencyKey: `release-smoke-${String(Date.now())}`, surface: { armed: true, holdConfirmed: false } },
  );
  expect(order.environment === 'paper', `the order went to ${order.environment}, not paper`);
  expect(order.status === 'filled', `the market buy is ${order.status}, not filled`);
  await rpc.event(fills, 'the entry fill', (d) => (d as { fill?: { orderId?: string } }).fill?.orderId === order.id);
  await rpc.event(positions, `a +${String(CONTRACTS)} position`, (d) => positionQty(d) === CONTRACTS);
  passed(
    `bought ${String(CONTRACTS)} ${order.request.instrument} on ${paper.displayName} at ${String(order.avgFillPrice)}`,
  );

  const flat = await rpc.tool<{ flat: boolean }>('orders.flatten', { accountId: paper.id });
  expect(flat.flat, 'orders.flatten did not leave the account flat');
  await rpc.event(positions, 'the flat position', (d) => positionQty(d) === 0);
  const open = await rpc.tool<{ positions: unknown[] }>('portfolio.get_positions', { accountId: paper.id });
  expect(open.positions.length === 0, `${String(open.positions.length)} positions are still open after flatten`);
  const done = await rpc.tool<{ fills: unknown[] }>('portfolio.get_fills', { accountId: paper.id });
  expect(done.fills.length === 2, `${String(done.fills.length)} fills, not the entry and the exit`);
  passed(`flattened ${paper.displayName}: no position, two fills`);

  rpc.close();
  await runtime.stop();
  passed('it exits 0 once its stdin closes, with no panic in its log');
}

function positionQty(data: unknown): number | undefined {
  return (data as { position?: { qty?: number } }).position?.qty;
}

function binary(target: RuntimeTarget): string {
  const release = process.argv.includes('--release');
  const { path, source } = resolveRuntimeBinary(repo, { target, release, quiet: true });
  console.info(
    `smoke: ${target.bin}: ${path}${source === 'cargo' ? '' : ` (${source === 'env' ? target.binEnv : 'prebuilt'})`}`,
  );
  return path;
}

async function run(label: string, bin: string, check: (runtime: Runtime) => Promise<void>): Promise<boolean> {
  const runtime = new Runtime(label, bin);
  try {
    await check(runtime);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`smoke: ✗ ${label}: ${message}`);
    if (process.env.GITHUB_ACTIONS) console.info(`::error title=Release smoke test::${label}: ${message}`);
    runtime.report();
    return false;
  } finally {
    runtime.dispose();
  }
}

const shipped = binary(RUNTIME);
const test = binary(TEST_RUNTIME);
const ok = (await run(RUNTIME.bin, shipped, bootShipped)) && (await run(TEST_RUNTIME.bin, test, roundTrip));
if (!ok) {
  console.error('smoke: FAILED. Do not publish this build (docs/release-smoke-test.md).');
  process.exit(1);
}
console.info('smoke: passed');
