import {
  LATE_ORDER,
  createRuntimeClient,
  type RuntimeClient,
  type ToolName,
  type WebSocketLike,
} from '@tessera/protocol';
import { vi } from 'vitest';
import type { ToolInput, ToolOutput } from '../../src/app/tools.ts';
import { provideTestServices, standInBridge } from './runtime.tsx';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export class Refusal {
  constructor(readonly message: string) {}
}

type Answer<N extends ToolName> = (input: ToolInput<N>) => ToolOutput<N> | Refusal | 'no answer';
type Answers = { readonly [N in ToolName]?: Answer<N> };

interface Frame {
  readonly id: number;
  readonly method: string;
  readonly params?: { name?: string; input?: unknown; topic?: string };
}

class LinkSocket implements WebSocketLike {
  readyState = CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(private readonly receive: (socket: LinkSocket, frame: Frame) => void) {}

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('the socket is not open');
    this.receive(this, JSON.parse(data) as Frame);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }

  open(): void {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this.onopen?.({});
  }

  answer(id: number, result: unknown): void {
    if (this.readyState === OPEN) this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  }

  fail(id: number, error: { code: number; message: string }): void {
    if (this.readyState === OPEN) this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, error }) });
  }

  event(topic: string, seq: number, data: unknown): void {
    this.notify('event', { topic, seq, data });
  }

  notify(method: string, params: unknown): void {
    if (this.readyState === OPEN) this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method, params }) });
  }
}

export interface RuntimeLink {
  readonly client: RuntimeClient;
  invoked(tool: ToolName): unknown[];
  received(method: string): unknown[];
  hold(): void;
  release(): void;
  lagBehind(): void;
  catchUp(): void;
  open(): Promise<void>;
  cut(): Promise<void>;
  restore(): Promise<void>;
  publish(topic: string, data: unknown): Promise<void>;
  pulse(ms: number): void;
}

const HELLO = {
  serverVersion: '0.0.0-test',
  protocolVersion: 1,
  connectionId: 'c-1',
  environment: 'paper',
  serverTime: 0,
  defaultLayoutId: 'default',
  capabilities: { methods: [], topics: [], toolCount: 0, market: [], intel: [], mcp: false, agents: false },
};

async function until(done: () => boolean, what: string): Promise<void> {
  await vi.waitFor(() => {
    if (!done()) throw new Error(`still waiting until ${what}`);
  });
}

function pastDeadline(params: unknown): boolean {
  if (!params || typeof params !== 'object' || !('deadline' in params)) return false;
  const deadline = (params as { deadline?: unknown }).deadline;
  return typeof deadline === 'number' && Date.now() * 1_000_000 >= deadline;
}

function lateResult() {
  return {
    ok: false,
    status: 'error',
    callId: 'late',
    durationMs: 0,
    output: null,
    approval: null,
    deduped: false,
    error: {
      code: 'rejected',
      message: LATE_ORDER,
      details: { code: 'late', sent: false, outcome: 'late' },
      retryable: false,
    },
  };
}

export function runtimeLink(
  answers: Answers,
  options: { requestTimeoutMs?: number; resolve?: (params: unknown) => Refusal | undefined } = {},
): RuntimeLink {
  let reachable = true;
  let holding = false;
  let lagging = false;
  const unread: (() => void)[] = [];
  let current: LinkSocket | null = null;
  let subscriptions = 0;
  const calls: { tool: string; input: unknown }[] = [];
  const frames: Frame[] = [];
  const parked: { socket: LinkSocket; frame: Frame }[] = [];
  let seq = 0;

  type Reply = Pick<LinkSocket, 'answer' | 'fail'>;

  const readLater = (socket: LinkSocket): Reply => ({
    answer: (id, result) => unread.push(() => socket.answer(id, result)),
    fail: (id, error) => unread.push(() => socket.fail(id, error)),
  });

  const refuseResolve = (socket: Reply, frame: Frame): boolean => {
    const refused = options.resolve?.(frame.params);
    if (refused) socket.fail(frame.id, { code: -32602, message: refused.message });
    return refused !== undefined;
  };

  const dispatch = (socket: Reply, frame: Frame) => {
    switch (frame.method) {
      case 'session.hello':
        socket.answer(frame.id, HELLO);
        return;
      case 'subscribe':
        socket.answer(frame.id, { subscriptionId: `s${String(++subscriptions)}`, topic: frame.params?.topic });
        return;
      case 'unsubscribe':
        socket.answer(frame.id, { removed: true });
        return;
      case 'tools.list':
        socket.answer(frame.id, []);
        return;
      case 'approvals.resolve':
        if (pastDeadline(frame.params)) {
          socket.fail(frame.id, { code: -32602, message: LATE_ORDER });
          return;
        }
        if (refuseResolve(socket, frame)) return;
        socket.answer(frame.id, {
          approval: { status: 'approved' },
          result: {
            ok: true,
            status: 'ok',
            callId: 'approved',
            durationMs: 0,
            output: null,
            approval: null,
            deduped: false,
            error: null,
          },
          replacement: null,
        });
        return;
      case 'tools.invoke': {
        const tool = frame.params?.name ?? '';
        calls.push({ tool, input: frame.params?.input });
        if (pastDeadline(frame.params)) {
          socket.answer(frame.id, lateResult());
          return;
        }
        const answer = (answers as Record<string, ((input: unknown) => unknown) | undefined>)[tool];
        const output = answer ? answer(frame.params?.input) : 'no answer';
        if (output === 'no answer') return;
        const refused = output instanceof Refusal;
        socket.answer(frame.id, {
          ok: !refused,
          status: refused ? 'error' : 'ok',
          callId: `call-${String(calls.length)}`,
          durationMs: 0,
          output: refused ? null : output,
          approval: null,
          deduped: false,
          error: refused ? { code: 'rejected', message: output.message, details: null, retryable: false } : null,
        });
        return;
      }
    }
  };

  const receive = (socket: LinkSocket, frame: Frame) => {
    frames.push(frame);
    if (holding && (frame.method === 'tools.invoke' || frame.method === 'approvals.resolve')) {
      parked.push({ socket, frame });
      return;
    }
    const answered = frame.method === 'tools.invoke' || frame.method === 'approvals.resolve';
    dispatch(lagging && answered ? readLater(socket) : socket, frame);
  };

  const client = createRuntimeClient({
    endpoint: () => Promise.resolve({ url: 'ws://runtime.test/ws', credential: { token: 'test-token' } }),
    createSocket: () => {
      const socket = new LinkSocket(receive);
      current = socket;
      setTimeout(() => (reachable ? socket.open() : socket.close(1006, 'unreachable')), 0);
      return socket;
    },
    backoff: { initialDelayMs: 10, maxDelayMs: 20, factor: 2, jitter: 0 },
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    connectTimeoutMs: 1_000,
  });
  provideTestServices({ client, host: standInBridge({}) });
  const status = () => client.state.getSnapshot().status;

  return {
    client,
    invoked: (tool) => calls.filter((c) => c.tool === tool).map((c) => c.input),
    received: (method) => frames.filter((f) => f.method === method).map((f) => f.params),
    hold: () => {
      holding = true;
    },
    lagBehind: () => {
      lagging = true;
    },
    catchUp: () => {
      lagging = false;
      for (const read of unread.splice(0)) read();
    },
    release: () => {
      holding = false;
      for (const item of parked.splice(0)) dispatch(item.socket, item.frame);
    },
    open: () => until(() => status() === 'open', 'the runtime is connected'),
    cut: async () => {
      reachable = false;
      current?.close(1006, 'runtime gone');
      await until(() => status() === 'reconnecting', 'the runtime has dropped');
    },
    restore: async () => {
      reachable = true;
      await until(() => status() === 'open', 'the runtime is back');
    },
    pulse: (ms) => current?.notify('session.pulse', { ms, everyMs: 1_000 }),
    publish: async (topic, data) => {
      const asked = () => frames.some((f) => f.method === 'subscribe' && f.params?.topic === topic);
      await until(asked, `the page subscribes to ${topic}`);
      current?.event(topic, ++seq, data);
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}
