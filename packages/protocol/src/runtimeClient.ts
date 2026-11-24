import { z } from 'zod';
import { computeBackoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.ts';
import { PROTOCOL_VERSION, RPC_ERROR_CODES } from './maps.ts';
import {
  ClientClosed,
  ConnectionLost,
  ContractError,
  NotConnected,
  RemoteError,
  RequestTimeout,
  type RequestError,
} from './runtimeErrors.ts';
import * as S from './schemas.gen.ts';
import { createStore, type ReadableStore } from './store.ts';
import type { EventEnvelope, HelloParams, HelloResult } from './gen/index.ts';

export type SessionCredential = { readonly token: string } | { readonly ticket: string };

export interface SessionKeep {
  readonly reloadTicket: string;
  readonly token?: string | undefined;
}

export type SessionProblem = 'session_expired' | 'session_missing';

export interface SessionListener {
  readonly kept: (keep: SessionKeep) => void;
  readonly refused: (problem: SessionProblem) => void;
}

export interface RpcEndpoint {
  url: string;
  credential?: SessionCredential | null;
  session?: SessionListener | undefined;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionState {
  status: ConnectionStatus;
  attempt: number;
  everConnected: boolean;
  server: HelloResult | null;
  lastError: string | null;
  lastErrorCode: string | null;
  nextRetryAt: number | null;
  connectedAt: number | null;
  endpoint: string | null;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type GapDetection = 'per-subscription' | 'off';

export interface EventMeta {
  topic: string;
  seq: number;
  subscriptionId: string | null;
}

export interface SequenceGap {
  topic: string;
  subscriptionId: string | null;
  expected: number;
  received: number;
}

export type InboundEvent = Omit<EventEnvelope, 'subscriptionId'> & { subscriptionId?: string };

export type ClientEvent =
  | { type: 'gap'; gap: SequenceGap }
  | { type: 'event'; envelope: InboundEvent }
  | { type: 'reconnected'; server: HelloResult };

export interface RuntimeClientConfig {
  readonly endpoint: () => Promise<RpcEndpoint>;
  readonly hello?: HelloParams | undefined;
  readonly gapDetection?: GapDetection | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly backoff?: Partial<BackoffOptions> | undefined;
  readonly subscribeRetry?: Partial<BackoffOptions> | undefined;
  readonly createSocket?: ((url: string) => WebSocketLike) | undefined;
  readonly random?: (() => number) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface CallOptions {
  readonly timeoutMs?: number | undefined;
  readonly queue?: boolean | undefined;
  readonly onLate?: ((value: unknown, error: RequestError | null) => void) | undefined;
}

export interface TopicOptions {
  readonly gapDetection?: GapDetection | undefined;
  readonly replay?: boolean | undefined;
}

export type SubscriptionEvent<A = unknown> =
  | { readonly _tag: 'Active'; readonly subscriptionId: string }
  | { readonly _tag: 'Event'; readonly data: A; readonly meta: EventMeta }
  | { readonly _tag: 'Gap'; readonly gap: SequenceGap }
  | { readonly _tag: 'Resubscribed'; readonly subscriptionId: string }
  | { readonly _tag: 'Refused'; readonly error: RemoteError };

export type SubscriptionSignal = SubscriptionEvent | { readonly _tag: 'Closed'; readonly error: ClientClosed };

export interface RuntimeClient {
  readonly state: ReadableStore<ConnectionState>;
  readonly behind: ReadableStore<number>;
  readonly request: (method: string, params?: unknown, options?: CallOptions) => Promise<unknown>;
  readonly subscribe: (
    topic: string,
    params: unknown,
    sink: (signal: SubscriptionSignal) => void,
    options?: TopicOptions,
  ) => () => void;
  readonly onEvent: (listener: (e: ClientEvent) => void) => () => void;
  readonly retryNow: () => void;
  readonly close: () => void;
}

function sessionProblem(err: unknown): SessionProblem | null {
  const remote = err instanceof Error && err.cause instanceof RemoteError ? err.cause : err;
  if (!(remote instanceof RemoteError) || remote.code !== RPC_ERROR_CODES.unauthorized) return null;
  const credential = isObject(remote.data) ? remote.data.credential : undefined;
  return credential === 'invalid' ? 'session_expired' : 'session_missing';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function defaultSocket(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('no global WebSocket; pass createSocket');
  return new Ctor(url);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export const SUBSCRIBE_RETRY: BackoffOptions = { initialDelayMs: 500, maxDelayMs: 5_000, factor: 2, jitter: 0.3 };
const ORPHAN_BUFFER_LIMIT = 1_000;
const WS_OPEN = 1;
const SNAPSHOT_SEQ = 0;
const BEHIND_STEP_MS = 1_000;

interface PulseClock {
  readonly everyMs: number;
  readonly timer: ReturnType<typeof setInterval>;
  base: number;
  lag: number;
  heardAt: number;
  readMs: number;
  tickedAt: number;
  quietMs: number;
}

interface LateAnswer {
  readonly due: () => boolean;
  readonly expire: () => void;
}

interface Pending {
  readonly id: number;
  readonly method: string;
  readonly frame: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: RequestError) => void;
}

type SubState = 'pending' | 'active' | 'error' | 'closed';

interface SubRecord {
  readonly localId: number;
  readonly topic: string;
  readonly params: unknown;
  readonly options: TopicOptions;
  readonly sink: (signal: SubscriptionSignal) => void;
  serverId: string | null;
  state: SubState;
  acks: number;
  refusals: number;
  askAgain: ReturnType<typeof setTimeout> | null;
}

interface Connection {
  readonly ws: WebSocketLike;
  readonly opened: Promise<void>;
  readonly lost: Promise<string>;
  readonly markOpened: () => void;
  readonly markLost: (reason: string) => void;
  done: boolean;
}

function within<A>(promise: Promise<A>, ms: number, reason: string): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(reason));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function decodeOrThrow<A>(schema: z.ZodType<A>, source: string, value: unknown): A {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ContractError({ source, message: z.prettifyError(result.error) });
}

export function createRuntimeClient(config: RuntimeClientConfig): RuntimeClient {
  const warn = (message: string) => {
    console.warn(`[rpc] ${message}`);
  };

  const hello: HelloParams = {
    ...(config.hello ?? { client: { name: 'tessera-ui' }, protocolVersion: PROTOCOL_VERSION }),
    pulse: true,
  };
  const backoff: BackoffOptions = { ...DEFAULT_BACKOFF, ...config.backoff };
  const subscribeRetry: BackoffOptions = { ...SUBSCRIBE_RETRY, ...config.subscribeRetry };
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const gapDetection = config.gapDetection ?? 'per-subscription';
  const createSocket = config.createSocket ?? defaultSocket;
  const random = config.random ?? Math.random;
  const now = config.now ?? (() => performance.now());

  const store = createStore<ConnectionState>({
    status: 'idle',
    attempt: 0,
    everConnected: false,
    server: null,
    lastError: null,
    lastErrorCode: null,
    nextRetryAt: null,
    connectedAt: null,
    endpoint: null,
  });

  let closed = false;
  let socket: WebSocketLike | null = null;
  let established: Connection | null = null;
  let current: Connection | null = null;
  let nextId = 1;
  let nextLocalSubId = 1;
  const pending = new Map<number, Pending>();
  const queue: Pending[] = [];
  const subs = new Map<number, SubRecord>();
  const byServerId = new Map<string, SubRecord>();
  const lastSeq = new Map<string, number>();
  let orphanEvents: InboundEvent[] = [];
  let subscribesInFlight = 0;
  const listeners = new Set<(e: ClientEvent) => void>();
  let retry: (() => void) | null = null;
  const behind = createStore<number>(0);
  let pulse: PulseClock | null = null;
  let anchor: number | null = null;
  const lateAnswers = new Set<LateAnswer>();

  const expireLateAnswers = () => {
    for (const late of [...lateAnswers]) {
      if (!late.due()) continue;
      lateAnswers.delete(late);
      late.expire();
    }
  };

  const showBehind = () => {
    const p = pulse;
    const ms = p ? Math.max(p.lag, now() - p.heardAt - p.everyMs) : 0;
    behind.set(ms < BEHIND_STEP_MS ? 0 : Math.floor(ms / BEHIND_STEP_MS) * BEHIND_STEP_MS);
  };

  const tick = () => {
    const p = pulse;
    if (p) {
      const at = now();
      p.quietMs += Math.min(Math.max(0, at - p.tickedAt), p.everyMs);
      p.tickedAt = at;
    }
    showBehind();
    expireLateAnswers();
  };

  const overdue = (clock: PulseClock | null, askedAtMs: number, timeoutMs: number) =>
    clock === null || pulse !== clock || clock.readMs >= askedAtMs + timeoutMs || clock.quietMs > timeoutMs + clock.lag;

  const stopPulse = () => {
    if (pulse) clearInterval(pulse.timer);
    pulse = null;
    showBehind();
  };

  const onPulse = (params: unknown) => {
    if (!isObject(params) || typeof params.ms !== 'number' || typeof params.everyMs !== 'number') return;
    const at = now();
    const gap = at - params.ms;
    if (pulse?.everyMs === params.everyMs) {
      pulse.base = Math.min(pulse.base, gap);
      pulse.lag = gap - pulse.base;
      pulse.heardAt = at;
      pulse.readMs = Math.max(pulse.readMs, params.ms);
    } else {
      stopPulse();
      const base = Math.min(anchor ?? gap, gap);
      pulse = {
        everyMs: params.everyMs,
        timer: setInterval(tick, params.everyMs),
        base,
        lag: gap - base,
        heardAt: at,
        readMs: params.ms,
        tickedAt: at,
        quietMs: 0,
      };
    }
    tick();
  };

  const safeCall = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      warn(`listener threw: ${errorMessage(err)}`);
    }
  };

  const isOpen = () => store.getSnapshot().status === 'open' && socket?.readyState === WS_OPEN;

  const emit = (e: ClientEvent) => {
    for (const l of [...listeners]) safeCall(() => l(e));
  };

  const transmit = (ws: WebSocketLike, p: Pending) => {
    pending.set(p.id, p);
    try {
      ws.send(p.frame);
    } catch (err) {
      pending.delete(p.id);
      p.reject(new ConnectionLost({ method: p.method, reason: errorMessage(err) }));
    }
  };

  const forget = (p: Pending) => {
    pending.delete(p.id);
    const i = queue.indexOf(p);
    if (i >= 0) queue.splice(i, 1);
  };

  const flushQueue = () => {
    const ws = socket;
    if (!ws) return;
    for (const p of queue.splice(0, queue.length)) transmit(ws, p);
  };

  const send = (
    method: string,
    params: unknown,
    timeoutMs: number | null,
    sendWhen: 'session-open' | 'socket-open',
    options?: CallOptions,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) {
        reject(new ClientClosed({ method }));
        return;
      }
      const id = nextId++;
      const frame = JSON.stringify(
        params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params },
      );
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let late: LateAnswer | null = null;
      if (timeoutMs !== null) {
        const clock = pulse;
        const askedAtMs = clock ? now() - clock.base : 0;
        const answer: LateAnswer = {
          due: () => overdue(clock, askedAtMs, timeoutMs),
          expire: () => {
            if (settled) return;
            settled = true;
            if (!options?.onLate) forget(p);
            reject(new RequestTimeout({ method, timeoutMs }));
          },
        };
        late = answer;
        timer = setTimeout(() => {
          if (answer.due()) answer.expire();
          else if (!settled) lateAnswers.add(answer);
        }, timeoutMs);
      }
      const settle = () => {
        settled = true;
        clearTimeout(timer);
        if (late) lateAnswers.delete(late);
      };
      const p: Pending = {
        id,
        method,
        frame,
        resolve: (value) => {
          if (settled) {
            options?.onLate?.(value, null);
            return;
          }
          settle();
          resolve(value);
        },
        reject: (error) => {
          if (settled) {
            options?.onLate?.(undefined, error);
            return;
          }
          settle();
          reject(error);
        },
      };
      const ws = socket;
      if (ws && (sendWhen === 'socket-open' ? ws.readyState === WS_OPEN : isOpen())) transmit(ws, p);
      else if (options?.queue === false) p.reject(new NotConnected({ method }));
      else queue.push(p);
    });

  const request = (method: string, params?: unknown, options?: CallOptions) =>
    send(method, params, options?.timeoutMs ?? requestTimeoutMs, 'session-open', options);

  const acceptSeq = (key: string, env: InboundEvent, recs: readonly SubRecord[]): boolean => {
    if (env.seq === SNAPSHOT_SEQ) {
      lastSeq.delete(key);
      return true;
    }
    const last = lastSeq.get(key);
    if (last !== undefined) {
      if (env.seq <= last) return false;
      const mode = recs[0]?.options.gapDetection ?? gapDetection;
      if (mode === 'per-subscription' && env.seq > last + 1) {
        const gap: SequenceGap = {
          topic: env.topic,
          subscriptionId: env.subscriptionId ?? null,
          expected: last + 1,
          received: env.seq,
        };
        emit({ type: 'gap', gap });
        for (const rec of recs) safeCall(() => rec.sink({ _tag: 'Gap', gap }));
      }
    }
    lastSeq.set(key, env.seq);
    return true;
  };

  const deliver = (rec: SubRecord, env: InboundEvent) => {
    if (rec.state === 'closed') return;
    const meta: EventMeta = { topic: env.topic, seq: env.seq, subscriptionId: env.subscriptionId ?? null };
    safeCall(() => rec.sink({ _tag: 'Event', data: env.data, meta }));
  };

  const handleEvent = (params: unknown) => {
    if (!isObject(params) || typeof params.topic !== 'string' || typeof params.seq !== 'number') {
      warn('malformed event');
      return;
    }
    const env = params as unknown as InboundEvent;
    emit({ type: 'event', envelope: env });

    if (typeof env.subscriptionId === 'string') {
      const rec = byServerId.get(env.subscriptionId);
      if (!rec) {
        if (subscribesInFlight > 0 && orphanEvents.length < ORPHAN_BUFFER_LIMIT) orphanEvents.push(env);
        return;
      }
      if (acceptSeq(`sub:${env.subscriptionId}`, env, [rec])) deliver(rec, env);
      return;
    }

    const recs = [...subs.values()].filter((r) => r.topic === env.topic && r.state !== 'closed');
    if (recs.length === 0) return;
    if (acceptSeq(`topic:${env.topic}`, env, recs)) {
      for (const rec of recs) deliver(rec, env);
    }
  };

  const handleMessage = (msg: unknown) => {
    if (!isObject(msg) || msg.jsonrpc !== '2.0') return;
    if (pulse) {
      const at = now();
      pulse.heardAt = at;
      pulse.tickedAt = at;
      pulse.quietMs = 0;
    }
    if (typeof msg.method === 'string') {
      if (msg.method === 'event' && msg.id === undefined) {
        handleEvent(msg.params);
      } else if (msg.method === 'session.pulse' && msg.id === undefined) {
        onPulse(msg.params);
      } else if (typeof msg.id === 'number' || typeof msg.id === 'string') {
        socket?.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}` },
          }),
        );
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if ('error' in msg && isObject(msg.error)) {
      const e = msg.error;
      p.reject(
        new RemoteError({
          method: p.method,
          code: typeof e.code === 'number' ? e.code : 0,
          message: typeof e.message === 'string' ? e.message : 'error',
          data: e.data,
        }),
      );
    } else {
      p.resolve(msg.result);
    }
  };

  const handleFrame = (raw: unknown) => {
    if (typeof raw !== 'string') {
      warn('ignoring non-text frame');
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      warn('ignoring malformed frame');
      return;
    }
    if (Array.isArray(msg)) for (const m of msg) handleMessage(m);
    else handleMessage(msg);
  };

  const drainOrphans = (serverId: string, rec: SubRecord) => {
    if (orphanEvents.length === 0) return;
    const mine = orphanEvents.filter((e) => e.subscriptionId === serverId);
    if (mine.length === 0) return;
    orphanEvents = orphanEvents.filter((e) => e.subscriptionId !== serverId);
    mine.sort((a, b) => a.seq - b.seq);
    for (const env of mine) {
      if (acceptSeq(`sub:${serverId}`, env, [rec])) deliver(rec, env);
    }
  };

  const unsubscribeOnRuntime = (serverId: string) => {
    if (!established) return;
    request('unsubscribe', { subscriptionId: serverId }).catch(() => undefined);
  };

  const onSubscribed = (rec: SubRecord, subscriptionId: string) => {
    if (rec.state === 'closed') {
      unsubscribeOnRuntime(subscriptionId);
      return;
    }
    rec.serverId = subscriptionId;
    rec.state = 'active';
    rec.acks++;
    rec.refusals = 0;
    byServerId.set(subscriptionId, rec);
    safeCall(() =>
      rec.sink(rec.acks === 1 ? { _tag: 'Active', subscriptionId } : { _tag: 'Resubscribed', subscriptionId }),
    );
    drainOrphans(subscriptionId, rec);
  };

  const onSubscribeFailed = (rec: SubRecord, err: unknown) => {
    if (err instanceof ConnectionLost || err instanceof ClientClosed) return;
    if (rec.state === 'closed') return;
    rec.state = 'error';
    const refusal =
      err instanceof RemoteError
        ? err
        : new RemoteError({ method: 'subscribe', code: 0, message: errorMessage(err), data: null });
    safeCall(() => rec.sink({ _tag: 'Refused', error: refusal }));
    if (refusal.code === RPC_ERROR_CODES.unavailable) askAgainLater(rec);
  };

  const askAgainLater = (rec: SubRecord) => {
    rec.refusals++;
    stopAskingAgain(rec);
    rec.askAgain = setTimeout(
      () => {
        rec.askAgain = null;
        if (rec.state === 'error') sendSubscribe(rec);
      },
      computeBackoffDelay(rec.refusals, subscribeRetry, random),
    );
  };

  const stopAskingAgain = (rec: SubRecord) => {
    if (rec.askAgain === null) return;
    clearTimeout(rec.askAgain);
    rec.askAgain = null;
  };

  const sendSubscribe = (rec: SubRecord) => {
    const conn = established;
    if (!conn) return;
    rec.state = 'pending';
    rec.serverId = null;
    subscribesInFlight++;
    const params =
      rec.options.replay === undefined
        ? { topic: rec.topic, params: rec.params }
        : { topic: rec.topic, params: rec.params, replay: rec.options.replay };
    send('subscribe', params, null, 'session-open')
      .then((res) => decodeOrThrow(S.SubscribeResult, 'subscribe', res))
      .then(
        (res) => {
          if (conn.done) return;
          subscribesInFlight = Math.max(0, subscribesInFlight - 1);
          onSubscribed(rec, res.subscriptionId);
        },
        (err: unknown) => {
          if (conn.done) return;
          subscribesInFlight = Math.max(0, subscribesInFlight - 1);
          onSubscribeFailed(rec, err);
        },
      );
  };

  const unsubscribeRecord = (rec: SubRecord) => {
    if (rec.state === 'closed') return;
    const serverId = rec.serverId;
    rec.state = 'closed';
    stopAskingAgain(rec);
    subs.delete(rec.localId);
    if (serverId) {
      byServerId.delete(serverId);
      lastSeq.delete(`sub:${serverId}`);
      if (isOpen()) unsubscribeOnRuntime(serverId);
    }
  };

  const subscribe = (
    topic: string,
    params: unknown,
    sink: (signal: SubscriptionSignal) => void,
    options: TopicOptions = {},
  ): (() => void) => {
    if (closed) {
      sink({ _tag: 'Closed', error: new ClientClosed({ method: 'subscribe' }) });
      return () => undefined;
    }
    const rec: SubRecord = {
      localId: nextLocalSubId++,
      topic,
      params,
      options,
      sink,
      serverId: null,
      state: 'pending',
      acks: 0,
      refusals: 0,
      askAgain: null,
    };
    subs.set(rec.localId, rec);
    if (isOpen()) sendSubscribe(rec);
    return () => {
      unsubscribeRecord(rec);
    };
  };

  const lose = (conn: Connection, reason: string) => {
    if (conn.done) return;
    conn.done = true;
    const ws = conn.ws;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    if (socket === ws) socket = null;
    if (established === conn) established = null;
    for (const p of [...pending.values()]) {
      p.reject(closed ? new ClientClosed({ method: p.method }) : new ConnectionLost({ method: p.method, reason }));
    }
    pending.clear();
    for (const rec of subs.values()) {
      if (rec.state !== 'closed') {
        stopAskingAgain(rec);
        rec.state = 'pending';
        rec.serverId = null;
      }
    }
    byServerId.clear();
    lastSeq.clear();
    orphanEvents = [];
    subscribesInFlight = 0;
    stopPulse();
    conn.markLost(reason);
  };

  const release = (conn: Connection, reason: string) => {
    const wasUp = !conn.done;
    lose(conn, reason);
    if (!wasUp) return;
    try {
      conn.ws.close(closed ? 1000 : 4000, reason);
    } catch {}
  };

  const openSocket = (url: string): Connection => {
    let markOpened: () => void = () => undefined;
    let markLost: (reason: string) => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    const lost = new Promise<string>((resolve) => {
      markLost = resolve;
    });
    const conn: Connection = { ws: createSocket(url), opened, lost, markOpened, markLost, done: false };
    socket = conn.ws;
    conn.ws.onopen = () => {
      conn.markOpened();
    };
    conn.ws.onmessage = (ev) => {
      handleFrame(ev.data);
    };
    conn.ws.onerror = () => {
      // A close event always follows.
    };
    conn.ws.onclose = (ev) => {
      lose(conn, ev.reason ? `${String(ev.code)} ${ev.reason}` : `code ${String(ev.code)}`);
    };
    return conn;
  };

  const handshake = async (conn: Connection, credential: SessionCredential | null): Promise<HelloResult> => {
    const lostFirst = conn.lost.then((reason) => {
      throw new Error(reason);
    });
    await Promise.race([conn.opened, lostFirst]);
    let result: unknown;
    try {
      const params = credential ? { ...hello, ...credential } : hello;
      result = await Promise.race([send('session.hello', params, connectTimeoutMs, 'socket-open'), lostFirst]);
      const answer = decodeOrThrow(S.HelloResult, 'session.hello', result);
      anchor = answer.pulseMs === undefined ? null : now() - answer.pulseMs;
      return answer;
    } catch (err) {
      if (conn.done) throw err;
      throw new Error(`handshake failed: ${errorMessage(err)}`, { cause: err });
    }
  };

  const connectOnce = async (): Promise<{ reason: string; code: string | null }> => {
    const prior = store.getSnapshot();
    store.set({
      ...prior,
      status: prior.everConnected || prior.attempt > 0 ? 'reconnecting' : 'connecting',
      nextRetryAt: null,
    });

    let endpoint: RpcEndpoint;
    try {
      endpoint = await config.endpoint();
    } catch (err) {
      const code = isObject(err) && typeof err.code === 'string' ? err.code : null;
      return { reason: `endpoint unavailable: ${errorMessage(err)}`, code };
    }
    if (closed) return { reason: 'client closed', code: null };
    store.update((s) => ({ ...s, endpoint: endpoint.url }));

    let conn: Connection;
    try {
      conn = openSocket(endpoint.url);
    } catch (err) {
      return { reason: `socket error: ${errorMessage(err)}`, code: null };
    }
    current = conn;

    let server: HelloResult;
    try {
      const { reloadTicket, token, ...rest } = await within(
        handshake(conn, endpoint.credential ?? null),
        connectTimeoutMs,
        'connect timeout',
      );
      if (reloadTicket !== undefined) endpoint.session?.kept({ reloadTicket, token });
      server = rest;
    } catch (err) {
      const reason = errorMessage(err);
      if (reason === 'connect timeout') warn('connect timeout');
      release(conn, reason);
      const problem = sessionProblem(err);
      if (problem) endpoint.session?.refused(problem);
      return { reason, code: problem };
    }
    if (conn.done) return { reason: await conn.lost, code: null };

    const wasConnected = store.getSnapshot().everConnected;
    store.update((s) => ({
      ...s,
      status: 'open',
      attempt: 0,
      everConnected: true,
      server,
      lastError: null,
      lastErrorCode: null,
      nextRetryAt: null,
      connectedAt: Date.now(),
    }));
    established = conn;
    flushQueue();
    for (const rec of subs.values()) {
      if (rec.state !== 'closed') sendSubscribe(rec);
    }
    if (wasConnected) emit({ type: 'reconnected', server });
    return { reason: await conn.lost, code: null };
  };

  const backOff = (reason: string, code: string | null) =>
    new Promise<void>((resolve) => {
      const attempt = store.getSnapshot().attempt + 1;
      const delay = computeBackoffDelay(attempt, backoff, random);
      store.update((s) => ({
        ...s,
        status: 'reconnecting',
        attempt,
        lastError: reason,
        lastErrorCode: code,
        nextRetryAt: Date.now() + delay,
        connectedAt: null,
      }));
      const timer = setTimeout(wake, delay);
      function wake() {
        clearTimeout(timer);
        retry = null;
        resolve();
      }
      retry = wake;
    });

  /** TypeScript's narrowing cannot see an await change `closed`. */
  const isClosed = () => closed;

  const run = async () => {
    while (!isClosed()) {
      const ended = await connectOnce();
      if (current) release(current, isClosed() ? 'client closed' : 'connection ended');
      current = null;
      if (isClosed()) return;
      await backOff(ended.reason, ended.code);
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    const conn = current;
    if (conn) release(conn, 'client closed');
    const ws = socket;
    socket = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close(1000, 'client closed');
    }
    for (const p of [...pending.values(), ...queue]) p.reject(new ClientClosed({ method: p.method }));
    pending.clear();
    queue.length = 0;
    const ended = [...subs.values()];
    for (const rec of ended) {
      rec.state = 'closed';
      stopAskingAgain(rec);
    }
    subs.clear();
    for (const rec of ended)
      safeCall(() => rec.sink({ _tag: 'Closed', error: new ClientClosed({ method: 'subscribe' }) }));
    byServerId.clear();
    listeners.clear();
    stopPulse();
    store.update((s) => ({ ...s, status: 'closed', nextRetryAt: null, connectedAt: null }));
    retry?.();
  };

  const retryNow = () => {
    if (closed || socket || store.getSnapshot().status !== 'reconnecting' || !retry) return;
    retry();
  };

  const onEvent = (listener: (e: ClientEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  void run();

  return {
    state: { getSnapshot: () => store.getSnapshot(), subscribe: (l) => store.subscribe(l) },
    behind: { getSnapshot: () => behind.getSnapshot(), subscribe: (l) => behind.subscribe(l) },
    request,
    subscribe,
    onEvent,
    retryNow,
    close,
  };
}
