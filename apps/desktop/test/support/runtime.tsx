import { QueryClientProvider } from '@tanstack/react-query';
import { HostError, type Bridge } from '@tessera/bridge';
import {
  ClientClosed,
  RemoteError,
  type ConnectionState,
  type EventMeta,
  type ReadableStore,
  type RuntimeClient,
  type ToolDescriptor,
  type ToolName,
} from '@tessera/protocol';
import { useState, type ReactNode } from 'react';
import { ClockContext, type RuntimeClock } from '../../src/app/clock.ts';
import { queryClient } from '../../src/app/queries.ts';
import { provideServices, type AppServices } from '../../src/app/services.ts';
import { setTools, type ToolInput, type ToolOutput } from '../../src/app/tools.ts';

export const CONNECTED: ConnectionState = {
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

export interface FakeClient {
  request?(method: string, params?: any, options?: { timeoutMs?: number }): Promise<unknown>;
  subscribe?(
    topic: string,
    params: any,
    handler: (data: any, meta: EventMeta) => void,
    options?: { replay?: boolean },
  ): () => void;
  state?: ReadableStore<ConnectionState>;
  behind?: ReadableStore<number>;
}

function standInClient(fake: FakeClient): RuntimeClient {
  const remote = (method: string) => (err: unknown) => {
    const e = err as { code?: unknown; message?: unknown; data?: unknown } | null;
    throw typeof e?.code === 'number'
      ? new RemoteError({ method, code: e.code, message: String(e.message), data: e.data ?? null })
      : new ClientClosed({ method });
  };
  return {
    state: fake.state ?? { getSnapshot: () => CONNECTED, subscribe: () => () => undefined },
    behind: fake.behind ?? { getSnapshot: () => 0, subscribe: () => () => undefined },
    request: (method, params, options) =>
      (fake.request
        ? fake.request(method, params, options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        : new Promise<unknown>(() => undefined)
      ).then((answer) => {
        if (method !== 'tools.invoke' || !answer || typeof answer !== 'object') return answer;
        const a = answer as { ok?: boolean; error?: Record<string, unknown> | null };
        return {
          status: a.ok === false ? 'error' : 'ok',
          callId: 'test-call',
          durationMs: 0,
          output: null,
          approval: null,
          deduped: false,
          ...answer,
          error: a.error ? { code: 'rejected', details: null, retryable: false, ...a.error } : null,
        };
      }, remote(method)),
    subscribe: (topic, params, sink, options) =>
      fake.subscribe
        ? fake.subscribe(
            topic,
            params,
            (data, meta) => {
              sink({ _tag: 'Event', data, meta });
            },
            options?.replay === undefined ? {} : { replay: options.replay },
          )
        : () => undefined,
    onEvent: () => () => undefined,
    retryNow: () => undefined,
    close: () => undefined,
  };
}

export type FakeBridge = Partial<Bridge>;

export function standInBridge(fake: FakeBridge): Bridge {
  const refused = (operation: string) => () =>
    Promise.reject(new HostError({ operation, reason: new Error(`the test bridge has no ${operation}`) }));
  return {
    kind: 'browser',
    window: null,
    updates: null,
    runtimeConnection: refused('runtimeConnection'),
    openWindow: refused('openWindow'),
    onWindowClosed: () => () => undefined,
    windowBounds: () => Promise.resolve(null),
    thisWindowBounds: () => Promise.resolve(null),
    closeWindow: () => Promise.resolve(),
    screens: () => Promise.resolve(null),
    notify: refused('notify'),
    openExternal: refused('openExternal'),
    saveFile: refused('saveFile'),
    pickFile: refused('pickFile'),
    setWindowTitle: refused('setWindowTitle'),
    guardClose: () => () => undefined,
    ...fake,
  };
}

const NO_BRIDGE: FakeBridge = {};

let provided: { client: FakeClient; bridge: FakeBridge } | null = null;

export function setTestServices(client: FakeClient, bridge: FakeBridge = NO_BRIDGE): void {
  if (provided?.client === client && provided.bridge === bridge) return;
  provided = { client, bridge };
  provideServices(testServices(client, bridge));
}

export function provideTestServices(services: AppServices): void {
  provided = null;
  provideServices(services);
}

export function answeringClient(answers: {
  readonly [N in ToolName]?: (input: ToolInput<N>) => ToolOutput<N> | Promise<ToolOutput<N>>;
}) {
  const calls: { name: string; input: unknown }[] = [];
  const client: FakeClient = {
    request: (method: string, params: { name?: string; input?: unknown } | undefined) => {
      if (method !== 'tools.invoke' || !params?.name) return new Promise(() => undefined);
      calls.push({ name: params.name, input: params.input });
      const answer = (answers as Record<string, ((input: unknown) => unknown) | undefined>)[params.name];
      return answer
        ? Promise.resolve(answer(params.input)).then((output) => ({ ok: true, status: 'ok', output }))
        : new Promise(() => undefined);
    },
  };
  return { client, calls };
}

type TopicHandler = (data: unknown, meta: EventMeta) => void;

export interface TopicFeed {
  readonly subscribe: NonNullable<FakeClient['subscribe']>;
  push(topic: string, data: unknown): void;
}

export function topicFeed(sent: { readonly [topic: string]: readonly unknown[] } = {}): TopicFeed {
  const handlers = new Map<string, Set<TopicHandler>>();
  const history = new Map(Object.entries(sent).map(([topic, list]) => [topic, [...list]]));
  let seq = 0;
  const send = (topic: string, handler: TopicHandler, data: unknown) => {
    seq += 1;
    handler(data, { topic, seq, subscriptionId: null });
  };
  return {
    subscribe: (topic, _params, handler) => {
      const listening = handlers.get(topic) ?? new Set<TopicHandler>();
      handlers.set(topic, listening);
      listening.add(handler);
      for (const data of history.get(topic) ?? []) send(topic, handler, data);
      return () => {
        listening.delete(handler);
      };
    },
    push: (topic, data) => {
      history.set(topic, [...(history.get(topic) ?? []), data]);
      for (const handler of [...(handlers.get(topic) ?? [])]) send(topic, handler, data);
    },
  };
}

export const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function seedTools(names: readonly string[]): void {
  setTools(new Map(names.map((n) => [n, { name: n } as ToolDescriptor])));
}

function testServices(client: FakeClient, bridge: FakeBridge = {}): AppServices {
  return { client: standInClient(client), host: standInBridge(bridge) };
}

export function TestRuntime({
  client,
  bridge = NO_BRIDGE,
  clock,
  children,
}: {
  client: FakeClient;
  bridge?: FakeBridge;
  clock?: RuntimeClock;
  children: ReactNode;
}) {
  useState(() => {
    setTestServices(client, bridge);
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ClockContext.Provider value={clock ?? null}>{children}</ClockContext.Provider>
    </QueryClientProvider>
  );
}
