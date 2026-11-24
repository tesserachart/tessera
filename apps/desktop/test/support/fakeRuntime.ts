import {
  ConnectionLost,
  RemoteError,
  RequestTimeout,
  type ConnectionState,
  type RuntimeClient,
  type SubscriptionSignal,
  type ToolErrorCode,
  type ToolName,
  type TopicOptions,
} from '@tessera/protocol';
import type { ToolInput, ToolOutput } from '../../src/app/tools.ts';
import { provideTestServices, standInBridge, type FakeBridge } from './runtime.tsx';

const CONNECTED: ConnectionState = {
  status: 'open',
  attempt: 0,
  everConnected: true,
  server: null,
  lastError: null,
  lastErrorCode: null,
  nextRetryAt: null,
  connectedAt: 1,
  endpoint: null,
};

export interface FakeSubscription {
  readonly topic: string;
  readonly params: unknown;
  readonly options: TopicOptions;
  readonly open: boolean;
  active(): void;
  event(data: unknown, seq?: number): void;
  gap(): void;
  resubscribed(): void;
  refuse(message: string, code?: number): void;
}

interface FakeCall {
  readonly method: string;
  readonly tool: string | null;
  readonly input: unknown;
  readonly settled: boolean;
  ok(output: unknown): void;
  fail(code: ToolErrorCode, message: string, more?: { retryable?: boolean; details?: unknown }): void;
  deny(message: string): void;
  lost(): void;
  timedOut(): void;
  answer(result: unknown): void;
}

export interface FakeRuntime {
  readonly service: RuntimeClient;
  readonly subscriptions: readonly FakeSubscription[];
  readonly calls: readonly FakeCall[];
  sub(topic: string): FakeSubscription;
  toolCalls(tool: string): FakeCall[];
  pending(tool: string): FakeCall;
}

type Answers = { readonly [N in ToolName]?: (input: ToolInput<N>) => ToolOutput<N> };

export function fakeRuntime(options: { answers?: Answers; bridge?: FakeBridge } = {}): FakeRuntime {
  const subscriptions: FakeSubscription[] = [];
  const calls: FakeCall[] = [];

  const subscribe = (
    topic: string,
    params: unknown,
    sink: (signal: SubscriptionSignal) => void,
    topicOptions: TopicOptions = {},
  ) => {
    let seq = 0;
    let open = true;
    const offer = (e: SubscriptionSignal) => {
      if (open) sink(e);
    };
    const sub: FakeSubscription = {
      topic,
      params,
      options: topicOptions,
      get open() {
        return open;
      },
      active: () => offer({ _tag: 'Active', subscriptionId: `sub-${String(subscriptions.length)}` }),
      event: (data, at) => {
        seq = at ?? seq + 1;
        offer({ _tag: 'Event', data, meta: { topic, seq, subscriptionId: null } });
      },
      gap: () => offer({ _tag: 'Gap', gap: { topic, subscriptionId: null, expected: seq + 1, received: seq + 2 } }),
      resubscribed: () => offer({ _tag: 'Resubscribed', subscriptionId: 'sub-again' }),
      refuse: (message, code = -32602) =>
        offer({ _tag: 'Refused', error: new RemoteError({ method: 'subscribe', code, message, data: null }) }),
    };
    subscriptions.push(sub);
    return () => {
      open = false;
    };
  };

  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const invoke = method === 'tools.invoke' ? (params as { name: string; input: unknown }) : null;
      let settled = false;
      const settle = (settleWith: () => void) => {
        if (settled) return;
        settled = true;
        settleWith();
      };
      const result = (status: string, output: unknown, error: unknown) =>
        settle(() => {
          resolve({
            ok: status === 'ok',
            status,
            callId: `call-${String(calls.length)}`,
            durationMs: 0,
            output,
            error,
            approval: null,
            deduped: false,
          });
        });
      const call: FakeCall = {
        method,
        tool: invoke?.name ?? null,
        input: invoke ? invoke.input : params,
        get settled() {
          return settled;
        },
        ok: (output) => result('ok', output, null),
        fail: (code, message, more = {}) =>
          result('error', null, { code, message, details: more.details ?? null, retryable: more.retryable ?? false }),
        deny: (message) =>
          result('denied', null, { code: 'permission_denied', message, details: null, retryable: false }),
        lost: () =>
          settle(() => {
            reject(new ConnectionLost({ method, reason: 'the test dropped it' }));
          }),
        timedOut: () =>
          settle(() => {
            reject(new RequestTimeout({ method, timeoutMs: 20_000 }));
          }),
        answer: (value) =>
          settle(() => {
            resolve(value);
          }),
      };
      calls.push(call);
      const answers = (options.answers ?? {}) as Record<string, ((input: unknown) => unknown) | undefined>;
      const answer = invoke && answers[invoke.name];
      if (answer) call.ok(answer(invoke.input));
    });

  const service: RuntimeClient = {
    state: { getSnapshot: () => CONNECTED, subscribe: () => () => undefined },
    behind: { getSnapshot: () => 0, subscribe: () => () => undefined },
    request,
    subscribe,
    onEvent: () => () => undefined,
    retryNow: () => undefined,
    close: () => undefined,
  };
  provideTestServices({ client: service, host: standInBridge(options.bridge ?? {}) });

  return {
    service,
    subscriptions,
    calls,
    sub: (topic) => {
      const found = subscriptions.findLast((s) => s.topic === topic && s.open);
      if (!found) throw new Error(`no open subscription to ${topic}`);
      return found;
    },
    toolCalls: (tool) => calls.filter((c) => c.tool === tool),
    pending: (tool) => {
      const found = calls.findLast((c) => c.tool === tool && !c.settled);
      if (!found) throw new Error(`no call of ${tool} waiting`);
      return found;
    },
  };
}
