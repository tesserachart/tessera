import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClientClosed,
  EndpointUnavailable,
  NotConnected,
  RemoteError,
  RequestTimeout,
  type ClientEvent,
  type ConnectionStatus,
  type RuntimeClient,
  type SequenceGap,
  type SubscriptionSignal,
  type TopicOptions,
  waitingToRetry,
} from '../src/index.ts';
import {
  elapse,
  failed,
  failure,
  HandlerError,
  helloResult,
  inbox,
  opened,
  reaching,
  settled,
  waitFor,
  withClient,
  withWireClient,
  type MockRpcServer,
} from './mock-server.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const follow = (client: RuntimeClient, topic: string, params: unknown, options?: TopicOptions) => {
  const got: SubscriptionSignal[] = [];
  const stop = client.subscribe(
    topic,
    params,
    (e) => {
      got.push(e);
    },
    options,
  );
  const data = () => got.flatMap((e) => (e._tag === 'Event' ? [e.data] : []));
  const seqs = () => got.flatMap((e) => (e._tag === 'Event' ? [e.meta.seq] : []));
  const gaps = () => got.flatMap((e) => (e._tag === 'Gap' ? [e.gap] : []));
  const count = (tag: SubscriptionSignal['_tag']) => got.filter((e) => e._tag === tag).length;
  return { got, stop, data, seqs, gaps, count };
};

const clientEvents = (client: RuntimeClient) => {
  const got: ClientEvent[] = [];
  client.onEvent((e) => {
    got.push(e);
  });
  return got;
};

describe('RuntimeClient requests', () => {
  it('performs session.hello on connect and exposes the server info', () =>
    withClient(
      async (client, server) => {
        await opened(client);
        const snap = client.state.getSnapshot();
        expect(snap.server).toMatchObject({ environment: 'paper', serverVersion: '0.0.0-test' });
        expect(snap.everConnected).toBe(true);
        expect(snap.endpoint).toBe(server.url);
        expect(server.requests('session.hello')[0]?.params).toEqual({
          client: { name: 'test', version: '1.2.3', platform: 'browser' },
          protocolVersion: 1,
          token: server.token,
          pulse: true,
        });
      },
      () => ({ hello: { client: { name: 'test', version: '1.2.3', platform: 'browser' }, protocolVersion: 1 } }),
    ));

  it('round-trips a request and correlates concurrent responses by id', () =>
    withClient(async (client, server) => {
      server.handlers.set('echo.a', (p) => ({ a: p }));
      server.handlers.set('echo.b', (p) => ({ b: p }));
      await opened(client);
      const [a, b] = await Promise.all([client.request('echo.a', 1), client.request('echo.b', 2)]);
      expect(a).toEqual({ a: 1 });
      expect(b).toEqual({ b: 2 });
    }));

  it('fails with RemoteError carrying the JSON-RPC code and data', () =>
    withClient(async (client, server) => {
      server.handlers.set('boom', () => {
        throw new HandlerError(-32602, 'bad params', { field: 'tf' });
      });
      await opened(client);
      const error = await failure(client.request('boom', {}));
      expect(error).toBeInstanceOf(RemoteError);
      expect(error).toMatchObject({ _tag: 'RemoteError', code: -32602, data: { field: 'tf' }, method: 'boom' });
    }));

  it('times requests out one by one and goes on serving', () =>
    withClient(async (client, server) => {
      await opened(client);
      server.respond = false;
      const error = await failed(client.request('slow', {}, { timeoutMs: 50 }));
      expect(error).toMatchObject({ _tag: 'RequestTimeout', method: 'slow', timeoutMs: 50 });
      server.respond = true;
      server.handlers.set('fast', () => 'ok');
      expect(await client.request('fast')).toBe('ok');
    }));

  it('queues requests made before the connection opens, after session.hello', () =>
    withClient(async (client, server) => {
      server.handlers.set('early', () => 'served');
      expect(client.state.getSnapshot().status).not.toBe('open');
      expect(await client.request('early')).toBe('served');
      expect(server.last.received.map((r) => r.method)).toEqual(['session.hello', 'early']);
    }));

  it('sends a request that must not wait at once, or refuses it as not connected; it never goes after a reconnect', () => {
    let reachable = true;
    return withClient(
      async (client, server) => {
        server.handlers.set('orders.now', () => 'placed');
        await opened(client);
        reachable = false;
        server.dropAll();
        await waitFor(() => client.state.getSnapshot().status === 'reconnecting');
        const whileDown = failure(client.request('orders.now', {}, { queue: false }));
        reachable = true;
        await waitFor(() => server.connections.length === 2 && client.state.getSnapshot().status === 'open');
        const refused = await whileDown;
        expect(refused).toBeInstanceOf(NotConnected);
        expect(refused).toMatchObject({ _tag: 'NotConnected', method: 'orders.now' });
        expect(server.requests('orders.now')).toEqual([]);
        expect(await client.request('orders.now', {}, { queue: false })).toBe('placed');
        expect(server.requests('orders.now')).toHaveLength(1);
      },
      (server) => ({
        endpoint: () =>
          reachable
            ? Promise.resolve({ url: server.url, credential: { token: server.token } })
            : Promise.reject(new EndpointUnavailable({ message: 'runtime unreachable', code: null })),
      }),
    );
  });

  it('keeps a timed-out request when onLate is set, so the late answer is seen', () =>
    withClient(async (client, server) => {
      await opened(client);
      server.respond = false;
      let late: unknown;
      const timedOut = failure(
        client.request(
          'hang',
          {},
          {
            timeoutMs: 40,
            onLate: (value) => {
              late = value;
            },
          },
        ),
      );
      const sent = await waitFor(() => server.requests('hang')[0]);
      expect(await settled(timedOut)).toMatchObject({ _tag: 'RequestTimeout', method: 'hang' });
      server.last.send({ jsonrpc: '2.0', id: sent.id, result: 'late' });
      await waitFor(() => late === 'late');
    }));

  it('forgets a timed-out request: its late answer is ignored and the client goes on', () =>
    withClient(async (client, server) => {
      await opened(client);
      server.respond = false;
      const timedOut = failure(client.request('hang', {}, { timeoutMs: 50 }));
      const sent = await waitFor(() => server.requests('hang')[0]);
      expect(await settled(timedOut)).toMatchObject({ _tag: 'RequestTimeout', method: 'hang' });
      server.respond = true;
      server.last.send({ jsonrpc: '2.0', id: sent.id, result: 'late' });
      server.handlers.set('fast', () => 'ok');
      expect(await client.request('fast')).toBe('ok');
    }));
});

describe('RuntimeClient session', () => {
  const endpointWith = (server: { url: string }, credential: { token: string } | { ticket: string } | null) => {
    const told: unknown[] = [];
    return {
      told,
      endpoint: () =>
        Promise.resolve({
          url: server.url,
          credential,
          session: {
            kept: (k: unknown) => told.push({ kept: k }),
            refused: (p: unknown) => told.push({ refused: p }),
          },
        }),
    };
  };

  it('sends the token in session.hello, never in the URL, and keeps the ticket out of the state', async () => {
    let told: unknown[] = [];
    await withClient(
      async (client, server) => {
        await opened(client);
        expect(server.upgrades).toEqual(['/ws']);
        expect(server.requests('session.hello')[0]?.params).toMatchObject({ token: server.token });
        expect(told).toEqual([{ kept: { reloadTicket: 'tst_1', token: undefined } }]);
        const state = JSON.stringify(client.state.getSnapshot());
        expect(state).not.toContain(server.token);
        expect(state).not.toContain('tst_');
      },
      (server) => {
        const e = endpointWith(server, { token: server.token });
        told = e.told;
        return { endpoint: e.endpoint };
      },
    );
  });

  it('comes in with a ticket, and hands the token it brings to the session only', async () => {
    let told: unknown[] = [];
    await withClient(
      async (client, server) => {
        server.tickets.add('tst_left');
        await opened(client);
        expect(server.requests('session.hello')[0]?.params).toMatchObject({ ticket: 'tst_left' });
        expect(told).toEqual([{ kept: { reloadTicket: 'tst_1', token: server.token } }]);
        expect(JSON.stringify(client.state.getSnapshot())).not.toContain(server.token);
      },
      (server) => {
        const e = endpointWith(server, { ticket: 'tst_left' });
        told = e.told;
        return { endpoint: e.endpoint };
      },
    );
  });

  it('reports a refused credential as the session problem, to the state and the session', async () => {
    for (const [credential, problem] of [
      [{ token: 'tss_from-an-earlier-start' }, 'session_expired'],
      [null, 'session_missing'],
      [{ ticket: 'tst_taken' }, 'session_missing'],
    ] as const) {
      let told: unknown[] = [];
      await withClient(
        async (client, server) => {
          await waitFor(() => client.state.getSnapshot().lastErrorCode, 2_000, problem);
          expect(client.state.getSnapshot().lastErrorCode).toBe(problem);
          expect(told[0]).toEqual({ refused: problem });
          expect(server.rejected).toBeGreaterThan(0);
          expect(client.state.getSnapshot().everConnected).toBe(false);
        },
        (server) => {
          const e = endpointWith(server, credential);
          told = e.told;
          return { endpoint: e.endpoint };
        },
      );
    }
  });
});

describe('RuntimeClient connection lifecycle', () => {
  it('reconnects with backoff after a drop and reports state transitions', () =>
    withClient(async (client, server) => {
      const statuses: ConnectionStatus[] = [client.state.getSnapshot().status];
      client.state.subscribe(() => {
        const s = client.state.getSnapshot().status;
        if (statuses.at(-1) !== s) statuses.push(s);
      });
      await opened(client);
      server.dropAll();
      await waitFor(() => server.connections.length === 2 && client.state.getSnapshot().status === 'open');
      expect(statuses.filter((s) => s !== 'idle')).toEqual(['connecting', 'open', 'reconnecting', 'open']);
      expect(client.state.getSnapshot().attempt).toBe(0);
    }));

  it('keeps retrying while the endpoint refuses, growing the delay, then recovers', () => {
    let refuse = 3;
    let resolves = 0;
    return withClient(
      async (client, server) => {
        const delays: number[] = [];
        client.state.subscribe(() => {
          const s = client.state.getSnapshot();
          if (s.status === 'reconnecting' && s.nextRetryAt && s.lastError) {
            const d = s.nextRetryAt - Date.now();
            if (delays.length < s.attempt) delays.push(d);
          }
        });
        await opened(client);
        expect(server.rejected).toBeGreaterThanOrEqual(3);
        expect(resolves).toBe(4);
        expect(delays).toHaveLength(3);
        expect(delays).toEqual([10, 20, 40]);
      },
      (server) => ({
        endpoint: async () => {
          resolves++;
          if (refuse > 0) {
            refuse--;
            return { url: server.url, credential: { token: 'wrong' } };
          }
          return { url: server.url, credential: { token: server.token } };
        },
      }),
    );
  });

  it('treats a failing endpoint as a failed attempt', () => {
    let calls = 0;
    return withClient(
      async (client) => {
        await waitFor(() => client.state.getSnapshot().lastError?.includes('runtime.json 404'));
        await opened(client);
      },
      (server) => ({
        endpoint: async () => {
          if (++calls === 1) throw new EndpointUnavailable({ message: 'runtime.json 404', code: null });
          return { url: server.url, credential: { token: server.token } };
        },
      }),
    );
  });

  it('records the code of an endpoint failure and clears it once connected', () => {
    let calls = 0;
    const codes: (string | null)[] = [];
    return withClient(
      async (client) => {
        client.state.subscribe(() => {
          const s = client.state.getSnapshot();
          if (s.status === 'reconnecting' && s.nextRetryAt !== null) codes.push(s.lastErrorCode);
        });
        await opened(client);
        expect(codes[0]).toBe('session_expired');
        expect(codes.at(-1)).toBeNull();
        expect(client.state.getSnapshot().lastErrorCode).toBeNull();
      },
      (server) => ({
        endpoint: async () => {
          calls++;
          if (calls === 1) throw new EndpointUnavailable({ message: 'session ended', code: 'session_expired' });
          if (calls === 2) throw new EndpointUnavailable({ message: 'plain failure', code: null });
          return { url: server.url, credential: { token: server.token } };
        },
      }),
    );
  });

  it('retryNow skips the remaining backoff', () =>
    withClient(
      async (client, server) => {
        await opened(client);
        server.dropAll();
        await waitFor(() => client.state.getSnapshot().status === 'reconnecting');
        client.retryNow();
        await opened(client);
      },
      () => ({ backoff: { initialDelayMs: 60_000, maxDelayMs: 60_000, factor: 1, jitter: 0 } }),
    ));

  it('offers Retry now only while waiting between attempts, and a press the moment it is offered retries', () =>
    withClient(
      async (client, server) => {
        await opened(client);
        const offered: boolean[] = [];
        client.state.subscribe(() => {
          const s = client.state.getSnapshot();
          if (s.status !== 'reconnecting') return;
          offered.push(waitingToRetry(s));
          if (waitingToRetry(s)) client.retryNow();
        });
        server.dropAll();
        await waitFor(() => offered.length > 0);
        await opened(client);
        expect(offered).toContain(true);
        expect(waitingToRetry({ status: 'reconnecting', nextRetryAt: null })).toBe(false);
      },
      () => ({ backoff: { initialDelayMs: 60_000, maxDelayMs: 60_000, factor: 1, jitter: 0 } }),
    ));

  it('fails the attempt when hello is refused', () =>
    withClient(async (client, server) => {
      let refuseHello = true;
      server.handlers.set('session.hello', () => {
        if (refuseHello) {
          refuseHello = false;
          throw new HandlerError(-32001, 'unauthorized');
        }
        return helloResult();
      });
      await waitFor(() => client.state.getSnapshot().lastError?.includes('unauthorized'));
      await opened(client);
      expect(server.connections).toHaveLength(2);
    }));

  it('fails every request with ClientClosed once closed', () =>
    withClient(async (client) => {
      await opened(client);
      client.close();
      const error = await failure(client.request('after'));
      expect(error).toBeInstanceOf(ClientClosed);
      expect(error).toMatchObject({ _tag: 'ClientClosed', method: 'after' });
      expect(client.state.getSnapshot().status).toBe('closed');
    }));
});

describe('RuntimeClient subscriptions', () => {
  it('delivers events while followed and unsubscribes when stopped', () =>
    withClient(async (client, server) => {
      await opened(client);
      const bars = follow(client, 'market.bars', { instrument: 'QQQ', tf: '5m' });
      await waitFor(() => server.requests('subscribe').length === 1);
      expect(server.requests('subscribe')[0]?.params).toEqual({
        topic: 'market.bars',
        params: { instrument: 'QQQ', tf: '5m' },
      });
      await waitFor(() => bars.count('Active') === 1);
      server.last.push('market.bars', 1, { instrument: 'QQQ', tf: '5m', bar: [1, 2, 3, 1, 2, 10] }, 's1');
      await waitFor(() => bars.data().length === 1);
      expect(bars.got[0]).toEqual({ _tag: 'Active', subscriptionId: 's1' });
      bars.stop();
      await waitFor(() => server.requests('unsubscribe').length === 1);
      expect(server.requests('unsubscribe')[0]?.params).toEqual({ subscriptionId: 's1' });
    }));

  it('routes by subscriptionId when two subscriptions share a topic', () =>
    withClient(async (client, server) => {
      await opened(client);
      const a = follow(client, 'market.bars', { instrument: 'QQQ', tf: '5m' });
      await waitFor(() => a.count('Active') === 1);
      const b = follow(client, 'market.bars', { instrument: 'NQZ6.CME', tf: '1m' });
      await waitFor(() => b.count('Active') === 1);
      server.last.push('market.bars', 1, 'qqq', 's1');
      server.last.push('market.bars', 1, 'nq', 's2');
      await waitFor(() => a.data().length === 1 && b.data().length === 1);
      expect(a.data()).toEqual(['qqq']);
      expect(b.data()).toEqual(['nq']);
    }));

  it('falls back to topic routing when events carry no subscriptionId', () =>
    withClient(async (client, server) => {
      await opened(client);
      const health = follow(client, 'health', {});
      await waitFor(() => health.count('Active') === 1);
      server.last.push('health', 1, { providers: [] });
      await waitFor(() => health.data().length === 1);
    }));

  it('keeps events that arrive before the subscribe acknowledgement', () =>
    withClient(async (client, server) => {
      server.handlers.set('subscribe', (_p, conn) => {
        conn.push('market.quotes', 1, { last: 487.85 }, 'early-1');
        return { subscriptionId: 'early-1', topic: 'market.quotes' };
      });
      await opened(client);
      const quotes = follow(client, 'market.quotes', { instruments: ['QQQ'] });
      await waitFor(() => quotes.data().length === 1);
      expect(quotes.data()[0]).toEqual({ last: 487.85 });
      expect(quotes.got.map((e) => e._tag)).toEqual(['Active', 'Event']);
    }));

  it('drops what an ended subscription still sends, so a new one keeps its first events however often the chart switches', () =>
    withClient(async (client, server) => {
      let subscribed = 0;
      server.handlers.set('subscribe', (_p, conn) => {
        subscribed++;
        const id = `q${String(subscribed)}`;
        if (subscribed > 1) conn.push('market.quotes', 1, { last: subscribed }, id);
        return { subscriptionId: id, topic: 'market.quotes' };
      });
      server.handlers.set('unsubscribe', (p, conn) => {
        const { subscriptionId } = p as { subscriptionId: string };
        for (let seq = 1; seq <= 600; seq++) conn.push('market.quotes', seq, { last: 0 }, subscriptionId);
        return { removed: true };
      });
      await opened(client);
      let shown = follow(client, 'market.quotes', { instruments: ['QQQ'] });
      await waitFor(() => shown.count('Active') === 1);
      for (let turn = 2; turn <= 4; turn++) {
        shown.stop();
        shown = follow(client, 'market.quotes', { instruments: [`Q${String(turn)}`] });
        await waitFor(() => shown.count('Active') === 1);
        expect(shown.data()).toEqual([{ last: turn }]);
      }
    }));

  it('reports a seq gap before the event that revealed it, and drops duplicates', () =>
    withClient(async (client, server) => {
      await opened(client);
      const events = clientEvents(client);
      const bars = follow(client, 'market.bars', { instrument: 'QQQ', tf: '5m' });
      await waitFor(() => bars.count('Active') === 1);
      for (const s of [1, 2, 2, 5, 4, 6]) server.last.push('market.bars', s, {}, 's1');
      await waitFor(() => bars.seqs().length === 4);
      expect(bars.seqs()).toEqual([1, 2, 5, 6]);
      const gap: SequenceGap = { topic: 'market.bars', subscriptionId: 's1', expected: 3, received: 5 };
      expect(bars.gaps()).toEqual([gap]);
      expect(bars.got.map((e) => (e._tag === 'Event' ? e.meta.seq : e._tag))).toEqual(['Active', 1, 2, 'Gap', 5, 6]);
      expect(events.flatMap((e) => (e.type === 'gap' ? [e.gap] : []))).toEqual([gap]);
    }));

  it('treats seq 0 as a snapshot that restarts numbering', () =>
    withClient(async (client, server) => {
      await opened(client);
      const health = follow(client, 'health', {});
      await waitFor(() => health.count('Active') === 1);
      for (const s of [0, 0, 41, 42]) server.last.push('health', s, {}, 's1');
      await waitFor(() => health.seqs().length === 4);
      expect(health.seqs()).toEqual([0, 0, 41, 42]);
      expect(health.gaps()).toEqual([]);
    }));

  it("gapDetection 'off' tolerates jumps (topic-family numbering) but still drops duplicates", () =>
    withClient(
      async (client, server) => {
        await opened(client);
        const bars = follow(client, 'market.bars', { instrument: 'QQQ', tf: '5m' });
        await waitFor(() => bars.count('Active') === 1);
        const strict = follow(client, 'approvals', {}, { gapDetection: 'per-subscription' });
        await waitFor(() => strict.count('Active') === 1);
        for (const s of [3, 9, 9, 7, 15]) server.last.push('market.bars', s, {}, 's1');
        for (const s of [1, 3]) server.last.push('approvals', s, {}, 's2');
        await waitFor(() => bars.seqs().length === 3 && strict.gaps().length === 1);
        expect(bars.seqs()).toEqual([3, 9, 15]);
        expect(bars.gaps()).toEqual([]);
        expect(strict.gaps()[0]).toMatchObject({ expected: 2, received: 3 });
      },
      () => ({ gapDetection: 'off' }),
    ));

  it('passes the replay flag through subscribe', () =>
    withClient(async (client, server) => {
      await opened(client);
      follow(client, 'tool.calls', {}, { replay: false });
      await waitFor(() => server.requests('subscribe').length === 1);
      expect(server.requests('subscribe')[0]?.params).toEqual({ topic: 'tool.calls', params: {}, replay: false });
    }));

  it('resubscribes after a reconnect, says so once, and restarts seq tracking', () =>
    withClient(async (client, server) => {
      await opened(client);
      const events = clientEvents(client);
      const bars = follow(client, 'market.bars', { instrument: 'QQQ', tf: '5m' });
      await waitFor(() => bars.count('Active') === 1);
      server.last.push('market.bars', 7, 'before', 's1');
      await waitFor(() => bars.data().length === 1);

      server.dropAll();
      await waitFor(() => server.connections.length === 2 && bars.count('Resubscribed') === 1);
      const resub = server.connections[1]!.received.filter((r) => r.method === 'subscribe');
      expect(resub).toHaveLength(1);
      expect(resub[0]?.params).toEqual({ topic: 'market.bars', params: { instrument: 'QQQ', tf: '5m' } });
      server.last.push('market.bars', 1, 'after', 's2');
      await waitFor(() => bars.data().length === 2);
      expect(bars.data()).toEqual(['before', 'after']);
      expect(bars.gaps()).toEqual([]);
      expect(bars.count('Active')).toBe(1);
      expect(events.filter((e) => e.type === 'reconnected')).toHaveLength(1);
    }));

  it('sends a subscription made before the connection opens after the handshake', () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return withClient(
      async (client, server) => {
        follow(client, 'health', {});
        await elapse(20);
        expect(server.connections).toHaveLength(0);
        release();
        await waitFor(() => server.requests('subscribe').length === 1);
        expect(server.last.received.map((r) => r.method)).toEqual(['session.hello', 'subscribe']);
      },
      (server) => ({
        endpoint: async () => {
          await gate;
          return { url: server.url, credential: { token: server.token } };
        },
      }),
    );
  });

  it('a subscription stopped before its acknowledgement is unsubscribed once acknowledged', () =>
    withClient(async (client, server) => {
      await opened(client);
      server.respond = false;
      const health = follow(client, 'health', {});
      const sub = await waitFor(() => server.requests('subscribe')[0]);
      health.stop();
      server.respond = true;
      server.last.send({ jsonrpc: '2.0', id: sub.id, result: { subscriptionId: 'late', topic: 'health' } });
      await waitFor(() => server.requests('unsubscribe').length === 1);
      expect(server.requests('unsubscribe')[0]?.params).toEqual({ subscriptionId: 'late' });
      expect(health.got).toEqual([]);
    }));

  it('ends its subscriptions with ClientClosed once closed', () =>
    withClient(async (client, server) => {
      await opened(client);
      const health = follow(client, 'health', {});
      await waitFor(() => server.requests('subscribe').length === 1);
      client.close();
      expect(health.got.at(-1)).toMatchObject({ _tag: 'Closed', error: { _tag: 'ClientClosed' } });
      expect(health.count('Closed')).toBe(1);
      const late = follow(client, 'health', {});
      expect(late.got).toEqual([{ _tag: 'Closed', error: expect.any(ClientClosed) }]);
    }));

  it('a consumer that throws takes nothing from the others', () =>
    withClient(async (client, server) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await opened(client);
      let thrown = 0;
      client.subscribe('health', {}, (e) => {
        if (e._tag === 'Event') {
          thrown++;
          throw new Error('consumer bug');
        }
      });
      const health = follow(client, 'health', {});
      await waitFor(() => server.requests('subscribe').length === 2 && health.count('Active') === 1);
      server.last.push('health', 1, 'x');
      await waitFor(() => health.data().length === 1);
      server.last.push('health', 2, 'y');
      await waitFor(() => health.data().length === 2);
      expect(health.data()).toEqual(['x', 'y']);
      expect(thrown).toBe(2);
      expect(warn).toHaveBeenCalledWith('[rpc] listener threw: consumer bug');
    }));
  it('waits for a subscribe however late its answer comes, then delivers its events', () =>
    withClient(async (client, server) => {
      await opened(client);
      server.respond = false;
      const quotes = follow(client, 'market.quotes', {});
      const sent = await waitFor(() => server.requests('subscribe')[0]);
      await elapse(1_200);
      server.last.send({ jsonrpc: '2.0', id: sent.id, result: { subscriptionId: 'late', topic: 'market.quotes' } });
      server.last.push('market.quotes', 0, { bid: 1 }, 'late');
      await waitFor(() => quotes.data().length === 1, 2_000, 'the late subscription’s first event');
      expect(quotes.count('Active')).toBe(1);
      expect(quotes.count('Refused')).toBe(0);
    }));

  it('asks again for a subscription the runtime cannot serve yet, and follows it once a connection serves it', () =>
    withClient(
      async (client, server) => {
        let served = false;
        server.handlers.set('subscribe', () => {
          if (!served) throw new HandlerError(-32015, 'unavailable: no market-data connection is configured');
          return { subscriptionId: 'q1', topic: 'market.quotes' };
        });
        await opened(client);
        const quotes = follow(client, 'market.quotes', { instruments: ['MGC'] });
        await waitFor(() => server.requests('subscribe').length >= 2, 2_000, 'a second ask');
        expect(quotes.count('Refused')).toBeGreaterThanOrEqual(1);
        expect(quotes.count('Active')).toBe(0);
        served = true;
        await waitFor(() => quotes.count('Active') === 1, 2_000, 'the subscription once served');
        server.last.push('market.quotes', 0, { bid: 3904.3, ask: 3904.4 }, 'q1');
        await waitFor(() => quotes.data().length === 1);
        expect(quotes.data()).toEqual([{ bid: 3904.3, ask: 3904.4 }]);
        const asked = server.requests('subscribe').length;
        await elapse(100);
        expect(server.requests('subscribe')).toHaveLength(asked);
      },
      () => ({ subscribeRetry: { initialDelayMs: 10, maxDelayMs: 20, jitter: 0 } }),
    ));

  it('takes any other refusal as final, and stops asking once a refused subscription is stopped', () =>
    withClient(
      async (client, server) => {
        server.handlers.set('subscribe', (p) => {
          const { topic } = p as { topic: string };
          if (topic === 'market.bars') throw new HandlerError(-32602, 'unknown instrument ZZZ');
          throw new HandlerError(-32015, 'unavailable: no market-data connection is configured');
        });
        await opened(client);
        const bars = follow(client, 'market.bars', { instrument: 'ZZZ', tf: '1m' });
        const quotes = follow(client, 'market.quotes', { instruments: ['MGC'] });
        await waitFor(() => quotes.count('Refused') >= 2, 2_000, 'a refused second ask');
        quotes.stop();
        await elapse(20);
        const asked = server.requests('subscribe').length;
        await elapse(100);
        expect(server.requests('subscribe')).toHaveLength(asked);
        expect(bars.count('Refused')).toBe(1);
        expect(
          server.requests('subscribe').filter((r) => (r.params as { topic: string }).topic === 'market.bars'),
        ).toHaveLength(1);
      },
      () => ({ subscribeRetry: { initialDelayMs: 10, maxDelayMs: 20, jitter: 0 } }),
    ));
});

describe('RuntimeClient pulse', () => {
  const clocked = () => {
    const clock = { now: 0 };
    return { clock, config: () => ({ now: () => clock.now }) };
  };
  const pulse = async (server: MockRpcServer, ms: number, everyMs: number) => {
    server.last.send({ jsonrpc: '2.0', method: 'session.pulse', params: { ms, everyMs } });
    await elapse(25);
  };

  it('reads nothing behind before a pulse, nor while the pulses keep time', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      expect(client.behind.getSnapshot()).toBe(0);
      await pulse(server, 5_000, 1_000);
      clock.now = 1_000;
      await pulse(server, 6_000, 1_000);
      clock.now = 1_900;
      await pulse(server, 7_000, 1_000);
      expect(client.behind.getSnapshot()).toBe(0);
    }, config);
  });

  it('says how far its events trail the runtime when a pulse arrives late, in whole seconds', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      await pulse(server, 5_000, 1_000);
      clock.now = 13_400;
      await pulse(server, 6_000, 1_000);
      expect(client.behind.getSnapshot()).toBe(12_000);
      clock.now = 13_500;
      await pulse(server, 18_500, 1_000);
      expect(client.behind.getSnapshot()).toBe(0);
    }, config);
  });

  it('reads the silence of a runtime that sends nothing as falling behind', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      await pulse(server, 0, 20);
      clock.now = 3_020;
      await waitFor(() => client.behind.getSnapshot() === 3_000, 2_000, '3 s of silence');
    }, config);
  });

  it('waits past its timeout for an answer queued behind the events the page has yet to read', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      await pulse(server, 5_000, 1_000);
      server.respond = false;
      const answer = client.request('market.get_candles', {}, { timeoutMs: 100 });
      const sent = await waitFor(() => server.requests('market.get_candles')[0]);
      await elapse(250);
      clock.now = 2_000;
      await pulse(server, 5_050, 1_000);
      server.last.send({ jsonrpc: '2.0', id: sent.id, result: { bars: 3 } });
      await expect(answer).resolves.toEqual({ bars: 3 });
    }, config);
  });

  it('waits past its timeout while other frames keep coming, however far apart its pulses are', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      await pulse(server, 5_000, 1_000);
      server.respond = false;
      const answer = client.request('market.get_candles', {}, { timeoutMs: 300 });
      const sent = await waitFor(() => server.requests('market.get_candles')[0]);
      for (let n = 1; n <= 20; n += 1) {
        clock.now += 250;
        server.last.push('market.quotes', n, { bid: n });
        await elapse(20);
      }
      server.last.send({ jsonrpc: '2.0', id: sent.id, result: { bars: 3 } });
      await expect(answer).resolves.toEqual({ bars: 3 });
    }, config);
  });

  it('counts how far behind it already was at its first pulse, from the hello answer', () => {
    const { clock, config } = clocked();
    return withClient(
      async (client, server) => {
        await opened(client);
        clock.now = 61_000;
        await pulse(server, 1_000, 1_000);
        expect(client.behind.getSnapshot()).toBe(60_000);
      },
      (server) => {
        server.handlers.set('session.hello', () => helloResult({ pulseMs: 0 }));
        return config();
      },
    );
  });

  it('on a page already behind, waits for an answer the page has yet to read rather than giving up before it', () => {
    const { clock, config } = clocked();
    return withClient(
      async (client, server) => {
        await opened(client);
        clock.now = 61_000;
        await pulse(server, 1_000, 1_000);
        server.respond = false;
        const answer = client.request('market.get_candles', {}, { timeoutMs: 300 });
        const sent = await waitFor(() => server.requests('market.get_candles')[0]);
        for (let ms = 2_000; ms <= 5_000; ms += 1_000) {
          clock.now += 200;
          await pulse(server, ms, 1_000);
        }
        await elapse(400);
        server.last.send({ jsonrpc: '2.0', id: sent.id, result: { bars: 3 } });
        await expect(answer).resolves.toEqual({ bars: 3 });
      },
      (server) => {
        server.handlers.set('session.hello', () => helloResult({ pulseMs: 0 }));
        return config();
      },
    );
  });

  it('still times out once the page has read past its deadline and no answer came', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      await pulse(server, 5_000, 1_000);
      server.respond = false;
      const outcome = client.request('market.get_candles', {}, { timeoutMs: 100 }).then(
        () => 'answered',
        (e: unknown) => e,
      );
      await elapse(250);
      clock.now = 200;
      await pulse(server, 5_200, 1_000);
      expect(await outcome).toBeInstanceOf(RequestTimeout);
    }, config);
  });

  it('times out on the clock once the runtime falls silent', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      await pulse(server, 0, 20);
      server.respond = false;
      const outcome = client.request('market.get_candles', {}, { timeoutMs: 100 }).then(
        () => 'answered',
        (e: unknown) => e,
      );
      for (let n = 0; n < 15; n += 1) {
        clock.now += 20;
        await elapse(25);
      }
      expect(await outcome).toBeInstanceOf(RequestTimeout);
    }, config);
  });

  it('on a page behind, waits out its lag before it takes a quiet spell for silence', () => {
    const { clock, config } = clocked();
    return withClient(
      async (client, server) => {
        await opened(client);
        clock.now = 600;
        await pulse(server, 0, 20);
        server.respond = false;
        let outcome: unknown = 'waiting';
        void client.request('market.get_candles', {}, { timeoutMs: 100 }).then(
          () => (outcome = 'answered'),
          (e: unknown) => (outcome = e),
        );
        for (let n = 0; n < 15; n += 1) {
          clock.now += 20;
          await elapse(25);
        }
        expect(outcome).toBe('waiting');
        for (let n = 0; n < 30; n += 1) {
          clock.now += 20;
          await elapse(25);
        }
        expect(outcome).toBeInstanceOf(RequestTimeout);
      },
      (server) => {
        server.handlers.set('session.hello', () => helloResult({ pulseMs: 0 }));
        return config();
      },
    );
  });

  it('does not take a stall of its own for silence, and reads the answer waiting behind it', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      await pulse(server, 0, 20);
      server.respond = false;
      const answer = client.request('market.get_candles', {}, { timeoutMs: 100 });
      const sent = await waitFor(() => server.requests('market.get_candles')[0]);
      clock.now = 30_000;
      await elapse(150);
      server.last.send({ jsonrpc: '2.0', id: sent.id, result: { bars: 3 } });
      await expect(answer).resolves.toEqual({ bars: 3 });
    }, config);
  });

  it('forgets how far behind it was once the connection drops: the dropped link says it', () => {
    const { clock, config } = clocked();
    return withClient(async (client, server) => {
      await opened(client);
      await pulse(server, 5_000, 1_000);
      clock.now = 9_000;
      await pulse(server, 11_000, 1_000);
      expect(client.behind.getSnapshot()).toBe(3_000);
      server.dropAll();
      await waitFor(() => server.connections.length === 2 && client.state.getSnapshot().status === 'open');
      expect(client.behind.getSnapshot()).toBe(0);
    }, config);
  });
});

describe('RuntimeClient over a real WebSocket', () => {
  it('says hello, answers a request, delivers a pushed event and resubscribes after the server drops the link', () =>
    withWireClient(async (client, server) => {
      server.handlers.set('echo', (p) => ({ echoed: p }));
      await reaching(client, (s) => s.status === 'open');
      expect(server.upgrades).toEqual(['/ws']);
      expect(await client.request('echo', 1)).toEqual({ echoed: 1 });

      const health = inbox<SubscriptionSignal>();
      client.subscribe('health', {}, health.put);
      await health.next((e) => e._tag === 'Active');
      server.last.push('health', 1, { providers: [] }, 's1');
      expect(await health.next((e) => e._tag === 'Event')).toMatchObject({ data: { providers: [] } });

      server.dropAll();
      await health.next((e) => e._tag === 'Resubscribed');
      expect(server.connections).toHaveLength(2);
      expect(server.requests('subscribe')).toHaveLength(2);
    }));
});
