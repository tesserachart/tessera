import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createRuntimeClient,
  type ConnectionState,
  type RuntimeClient,
  type RuntimeClientConfig,
  type WebSocketLike,
} from '../src/index.ts';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export interface ServerSocket {
  send(text: string): void;
  close(): void;
  terminate(): void;
  onMessage(listener: (text: string) => void): void;
}

class MemoryLink implements WebSocketLike {
  readyState = CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private heard: (text: string) => void = () => undefined;

  readonly server: ServerSocket = {
    send: (text) => {
      if (this.readyState === OPEN) queueMicrotask(() => this.onmessage?.({ data: text }));
    },
    close: () => {
      this.end(1005, '');
    },
    terminate: () => {
      this.end(1006, '');
    },
    onMessage: (listener) => {
      this.heard = listener;
    },
  };

  send(data: string): void {
    if (this.readyState === CONNECTING) throw new Error('the socket is still connecting');
    if (this.readyState === OPEN) queueMicrotask(() => this.heard(data));
  }

  close(code = 1000, reason = ''): void {
    this.end(code, reason);
  }

  open(): void {
    this.readyState = OPEN;
    this.onopen?.({});
  }

  private end(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

function wireSocket(socket: WebSocket): ServerSocket {
  return {
    send: (text) => {
      socket.send(text);
    },
    close: () => {
      socket.close();
    },
    terminate: () => {
      socket.terminate();
    },
    onMessage: (listener) => {
      socket.on('message', (raw) => {
        if (!Buffer.isBuffer(raw)) throw new TypeError('expected a text frame as a Buffer');
        listener(raw.toString('utf8'));
      });
    },
  };
}

export interface MockConnection {
  socket: ServerSocket;
  received: { id: number; method: string; params: unknown }[];
  push(topic: string, seq: number, data: unknown, subscriptionId?: string): void;
  send(frame: unknown): void;
}

export type Handler = (params: unknown, conn: MockConnection) => unknown;

export function helloResult(overrides: Record<string, unknown> = {}) {
  return {
    serverVersion: '0.0.0-test',
    protocolVersion: 1,
    connectionId: 'c-1',
    environment: 'paper',
    serverTime: Date.UTC(2026, 9, 2, 18, 42, 30) * 1e6,
    defaultLayoutId: 'default',
    capabilities: { methods: [], topics: [], toolCount: 0, market: [], intel: [], mcp: false, agents: false },
    ...overrides,
  };
}

export class HandlerError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const MEMORY_URL = 'ws://mock.test/ws';

export class MockRpcServer {
  readonly connections: MockConnection[] = [];
  readonly handlers = new Map<string, Handler>();
  respond = true;
  rejected = 0;
  readonly upgrades: string[] = [];
  readonly tickets = new Set<string>();
  private subCounter = 0;

  get url(): string {
    return MEMORY_URL;
  }

  constructor(readonly token = 'secret-token') {
    this.handlers.set('session.hello', () => helloResult());
    this.handlers.set('subscribe', (p) => ({
      subscriptionId: `s${String(++this.subCounter)}`,
      topic: (p as { topic: string }).topic,
    }));
    this.handlers.set('unsubscribe', () => ({ removed: true }));
  }

  readonly createSocket = (url: string): WebSocketLike => {
    const link = new MemoryLink();
    const { pathname, search } = new URL(url);
    this.upgrades.push(`${pathname}${search}`);
    queueMicrotask(() => {
      if (link.readyState !== CONNECTING) return;
      this.onConnection(link.server);
      link.open();
    });
    return link;
  };

  get last(): MockConnection {
    const c = this.connections.at(-1);
    if (!c) throw new Error('no connection yet');
    return c;
  }

  requests(method: string): { id: number; method: string; params: unknown }[] {
    return this.connections.flatMap((c) => c.received.filter((r) => r.method === method));
  }

  dropAll(): void {
    for (const c of this.connections) c.socket.terminate();
  }

  close(): Promise<void> {
    this.dropAll();
    return Promise.resolve();
  }

  protected onConnection(socket: ServerSocket): void {
    const conn: MockConnection = {
      socket,
      received: [],
      push: (topic, seq, data, subscriptionId) => {
        const params: Record<string, unknown> = { topic, seq, data };
        if (subscriptionId !== undefined) params.subscriptionId = subscriptionId;
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params }));
      },
      send: (frame) => {
        socket.send(JSON.stringify(frame));
      },
    };
    this.connections.push(conn);
    let proven = false;
    socket.onMessage((text) => {
      const msg = JSON.parse(text) as { id: number; method: string; params?: unknown };
      conn.received.push({ id: msg.id, method: msg.method, params: msg.params });
      if (!proven) {
        const p = (msg.params ?? {}) as { token?: string; ticket?: string };
        const byTicket = p.token === undefined && p.ticket !== undefined && this.tickets.delete(p.ticket);
        if (msg.method !== 'session.hello' || (p.token !== this.token && !byTicket)) {
          this.rejected++;
          const credential = msg.method === 'session.hello' && p.token !== undefined ? 'invalid' : 'missing';
          conn.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32001, message: 'unauthorized', data: { credential } },
          });
          socket.close();
          return;
        }
        let answer: Record<string, unknown>;
        try {
          answer = this.handlers.get('session.hello')?.(msg.params, conn) as Record<string, unknown>;
        } catch (err) {
          const { code, message, data } = err instanceof HandlerError ? err : new HandlerError(-32603, String(err));
          conn.send({ jsonrpc: '2.0', id: msg.id, error: { code, message, data } });
          socket.close();
          return;
        }
        proven = true;
        const reloadTicket = `tst_${String(this.connections.length)}`;
        this.tickets.add(reloadTicket);
        const result = byTicket ? { ...answer, reloadTicket, token: this.token } : { ...answer, reloadTicket };
        conn.send({ jsonrpc: '2.0', id: msg.id, result });
        return;
      }
      if (!this.respond && msg.method !== 'session.hello') return;
      const handler = this.handlers.get(msg.method);
      if (!handler) {
        conn.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
        return;
      }
      try {
        const result = handler(msg.params, conn);
        conn.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
      } catch (err) {
        if (err instanceof HandlerError) {
          conn.send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code, message: err.message, data: err.data } });
        } else {
          conn.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err) } });
        }
      }
    });
  }
}

export class WireRpcServer extends MockRpcServer {
  private wss!: WebSocketServer;
  private port = 0;

  async listen(): Promise<this> {
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: '/ws',
      verifyClient: (info, cb) => {
        this.upgrades.push(info.req.url ?? '');
        cb(true);
      },
    });
    this.wss.on('connection', (socket) => {
      this.onConnection(wireSocket(socket));
    });
    await once(this.wss, 'listening');
    this.port = (this.wss.address() as AddressInfo).port;
    return this;
  }

  override get url(): string {
    return `ws://127.0.0.1:${String(this.port)}/ws`;
  }

  override async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

const STEP_MS = 5;

export const elapse = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

export async function waitFor<T>(predicate: () => T, budgetMs = 2_000, label = 'condition'): Promise<NonNullable<T>> {
  for (let waited = 0; ; waited += STEP_MS) {
    const v = predicate();
    if (v) return v;
    if (waited >= budgetMs) throw new Error(`${label} still false after ${String(budgetMs)} virtual ms`);
    await elapse(STEP_MS);
  }
}

export async function settled<A>(promise: Promise<A>, budgetMs = 5_000): Promise<A> {
  let done = false;
  const watch = (): void => {
    done = true;
  };
  promise.then(watch, watch);
  for (let waited = 0; !done; waited += STEP_MS) {
    if (waited >= budgetMs) throw new Error(`still pending after ${String(budgetMs)} virtual ms`);
    await elapse(STEP_MS);
  }
  return promise;
}

export async function opened(client: RuntimeClient): Promise<RuntimeClient> {
  await waitFor(() => client.state.getSnapshot().status === 'open', 2_000, 'open');
  return client;
}

export function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value: unknown) => {
      throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );
}

export const failed = (promise: Promise<unknown>): Promise<unknown> => settled(failure(promise));

const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;

const clientFor = (server: MockRpcServer, config: Partial<RuntimeClientConfig>): RuntimeClient =>
  createRuntimeClient({
    endpoint: () => Promise.resolve({ url: server.url, credential: { token: server.token } }),
    backoff: { initialDelayMs: 10, maxDelayMs: 40, factor: 2, jitter: 0 },
    requestTimeoutMs: 1_000,
    connectTimeoutMs: 1_000,
    ...config,
  });

export async function withClient<A>(
  body: (client: RuntimeClient, server: MockRpcServer) => Promise<A>,
  config: (server: MockRpcServer) => Partial<RuntimeClientConfig> = () => ({}),
): Promise<A> {
  vi.useFakeTimers({ toFake: [...FAKED] });
  const server = new MockRpcServer();
  const client = clientFor(server, { createSocket: server.createSocket, ...config(server) });
  try {
    return await body(client, server);
  } finally {
    client.close();
    vi.useRealTimers();
  }
}

export async function withWireClient<A>(
  body: (client: RuntimeClient, server: WireRpcServer) => Promise<A>,
  config: (server: WireRpcServer) => Partial<RuntimeClientConfig> = () => ({}),
): Promise<A> {
  const server = await new WireRpcServer().listen();
  const client = clientFor(server, config(server));
  try {
    return await body(client, server);
  } finally {
    client.close();
    await server.close();
  }
}

export function inbox<A>() {
  const items: A[] = [];
  const waiters: (() => void)[] = [];
  return {
    put(item: A): void {
      items.push(item);
      for (const wake of waiters.splice(0)) wake();
    },
    async next(match: (item: A) => boolean): Promise<A> {
      for (;;) {
        const hit = items.find(match);
        if (hit !== undefined) return hit;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

export function reaching(client: RuntimeClient, match: (state: ConnectionState) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      if (!match(client.state.getSnapshot())) return false;
      resolve();
      return true;
    };
    if (check()) return;
    const stop = client.state.subscribe(() => {
      if (check()) stop();
    });
  });
}
